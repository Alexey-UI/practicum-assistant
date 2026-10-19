import type { Locator, Page } from 'playwright';
import type { Config } from './config.js';
import { Answers, atomicJson, normalize, questionKey, readJson, type Question, journal } from './store.js';

export function candidates(q: Question, limit: number): string[][] {
  if (!q.multiple) return q.options.slice(0, limit).map(x => [x]);
  // Bounded enumeration; never generate 2^N combinations in memory.
  const result: string[][] = [];
  function visit(start: number, size: number, prefix: string[]) {
    if (result.length >= limit) return;
    if (prefix.length === size) { result.push(prefix); return; }
    for (let i = start; i < q.options.length && result.length < limit; i++) visit(i + 1, size, [...prefix, q.options[i]]);
  }
  for (let size = 1; size <= q.options.length && result.length < limit; size++) visit(0, size, []);
  return result;
}

export async function exactButton(scope: Page | Locator, names: string[]): Promise<Locator | undefined> {
  const found: Locator[] = [];
  for (const name of names) {
    const buttons = scope.getByRole('button', { name, exact: true });
    for (let i = 0; i < await buttons.count(); i++) if (await buttons.nth(i).isVisible() && await buttons.nth(i).isEnabled()) found.push(buttons.nth(i));
  }
  if (found.length > 1) throw new Error('Несколько подходящих кнопок: нужен точный контекст');
  return found[0];
}

export async function questionFrom(root: Locator): Promise<Question> {
  const choices = root.getByRole('radio').or(root.getByRole('checkbox'));
  const options: string[] = [];
  let multiple = false;
  for (let i = 0; i < await choices.count(); i++) {
    const choice = choices.nth(i);
    const info = await choice.evaluate(el => ({
      text: el.closest('label')?.querySelector('.quiz-form-choice__option-content')?.textContent || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ') ||
        (el as HTMLInputElement).labels?.[0]?.textContent || el.closest('label')?.textContent || el.textContent || '',
      multiple: el.getAttribute('role') === 'checkbox' || (el as HTMLInputElement).type === 'checkbox',
    }));
    options.push(normalize(info.text)); multiple ||= info.multiple;
  }
  if (!options.length || options.some(x => !x) || new Set(options).size !== options.length) throw new Error('Не удалось однозначно прочитать варианты вопроса');
  // The prompt is extracted separately so that option order does not change its identity.
  const promptElement = root.locator('[data-question-prompt], .quiz__question, .quiz__content, legend').first();
  const prompt = await promptElement.textContent().catch(() => null);
  if (!prompt) throw new Error('Не найден текст вопроса: требуется настройка селектора');
  const media = await promptElement.locator('img').evaluateAll(images => images.map(image => {
    const src = image.getAttribute('src') ?? '';
    try { const url = new URL(src, location.href); return `${url.origin}${url.pathname}:${image.getAttribute('alt') ?? ''}`; }
    catch { return image.getAttribute('alt') ?? ''; }
  }));
  return { prompt: normalize(prompt), options, multiple, ...(media.length ? { context: media } : {}) };
}

export async function quizOutcome(root: Locator, cfg: Config): Promise<'correct' | 'wrong' | 'unknown'> {
  const observed = await root.evaluate(el => {
    if (!el.classList.contains('quiz_answered')) return 'unknown';
    if (el.classList.contains('quiz_type_feedback')) return 'correct';
    if (el.classList.contains('quiz_type_text')) return el.querySelector('.quiz__content-block_status_success') ? 'correct' : 'unknown';
    const rows = [...el.querySelectorAll('.quiz-form-matching__prompt')];
    if (rows.length) return rows.every(row => row.classList.contains('quiz-form-matching__prompt_correct')) ? 'correct' : 'wrong';
    const options = [...el.querySelectorAll('.quiz-form-choice__option')];
    if (!options.some(option => option.classList.contains('quiz-form-choice__option_should-be-checked'))) return 'unknown';
    return options.every(option => option.classList.contains('quiz-form-choice__option_checked') === option.classList.contains('quiz-form-choice__option_should-be-checked')) ? 'correct' : 'wrong';
  });
  if (observed !== 'unknown') return observed;
  if (await root.locator(cfg.successSelector).first().isVisible()) return 'correct';
  if (await root.locator(cfg.failureSelector).first().isVisible()) return 'wrong';
  return 'unknown';
}

async function feedback(root: Locator, cfg: Config, page: Page): Promise<'correct' | 'wrong' | 'unknown'> {
  const until = Date.now() + 120000;
  while (Date.now() < until && !page.isClosed()) {
    const result = await quizOutcome(root, cfg);
    if (result !== 'unknown') return result;
    await page.waitForTimeout(500);
  }
  return 'unknown';
}

export async function solveQuiz(page: Page, root: Locator, cfg: Config): Promise<boolean> {
  if (await quizOutcome(root, cfg) === 'correct') return true;
  const question = await questionFrom(root);
  const key = questionKey(question);
  const answers = new Answers();
  const saved = await answers.get(question);
  const decisions = await readJson<Record<string, string[]>>('.local/decisions.json', {});
  const selected = saved ?? decisions[key];
  const canRetry = cfg.retryableLessons.includes(new URL(page.url()).pathname);
  const variants = selected ? [selected] : canRetry ? candidates(question, cfg.maxAttempts) : [];
  if (!variants.length) {
    await atomicJson('.local/pending-question.json', { key, url: new URL(page.url()).pathname, question });
    return false;
  }
  const requestFile = `.local/questions/${key}.json`;
  type Request = { phase: 'requested' | 'correct' | 'wrong'; answers: string[] };
  const prior = await readJson<Request | null>(requestFile, null);
  if (prior?.phase === 'requested') {
    const outcome = await feedback(root, cfg, page);
    if (outcome === 'unknown') return false;
    await atomicJson(requestFile, { ...prior, phase: outcome });
    if (outcome === 'correct') {
      await answers.confirm(question, prior.answers, 'Observed positive feedback after resuming pending submission'); return true;
    }
  }
  if (await quizOutcome(root, cfg) === 'wrong') {
    if (saved || !canRetry) return false;
    const retry = await exactButton(root, cfg.retryButtons);
    if (!retry) return false;
    await retry.click();
    await page.waitForTimeout(500);
  }
  for (let attempt = 0; attempt < variants.length; attempt++) {
    if (attempt > 0) {
      const retry = await exactButton(root, cfg.retryButtons);
      if (!retry) return false;
      await retry.click();
      await page.waitForTimeout(500);
    }
    const current = await questionFrom(root);
    if (questionKey(current) !== questionKey(question)) return false;
    const values = variants[attempt].map(normalize);
    if (!values.length || values.some(x => !question.options.includes(x))) throw new Error('Неверный вариант в базе ответов');
    const choices = root.getByRole('radio').or(root.getByRole('checkbox'));
    for (let i = 0; i < current.options.length; i++) {
      const choice = choices.nth(i);
      const needed = values.includes(current.options[i]);
      if ((current.multiple || needed) && await choice.isChecked() !== needed) {
        const label = choice.locator('xpath=ancestor::label[1]');
        if (await label.count()) await label.click();
        else await choice.setChecked(needed);
        if (await choice.isChecked() !== needed) throw new Error('Выбор ответа не подтверждён интерфейсом');
      }
    }
    const submit = await exactButton(root, cfg.submitButtons);
    if (!submit) return false;
    // Deliberately no automatic repeat: an HTTP response may be lost after acceptance.
    await atomicJson(requestFile, { phase: 'requested', answers: values } satisfies Request);
    await submit.click();
    const result = await feedback(root, cfg, page);
    if (result !== 'unknown') await atomicJson(requestFile, { phase: result, answers: values } satisfies Request);
    await journal('quiz-result', { key: questionKey(question), attempt: attempt + 1, result });
    if (result === 'correct') {
      const evidence = await root.evaluate(el => el.classList.contains('quiz_answered')) ? 'quiz_answered: selected options match should-be-checked markers' : cfg.successSelector;
      await answers.confirm(question, values, evidence); return true;
    }
    if (result === 'unknown' || saved) return false;
  }
  return false;
}
