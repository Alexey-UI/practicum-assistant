import type { Page, Locator } from 'playwright';
import type { Config } from './config.js';
import { atomicJson, readJson, normalize, journal } from './store.js';

function feedbackState(root: Element): string {
  return ['.quiz__title', '.quiz__question-content', '.quiz__counter'].map(selector =>
    root.querySelector(selector)?.textContent?.normalize('NFKC').replace(/\s+/g, ' ').trim() ?? '',
  ).join('\n');
}

export async function solveFeedback(page: Page, root: Locator, cfg: Config): Promise<boolean> {
  const id = await root.getAttribute('data-test-id') ?? '';
  if (!/^quiz-feedback-[a-f0-9-]+$/.test(id)) throw new Error('Не определён ID опроса');
  const file = `.local/feedback/${id}.json`;
  for (let step = 0; step < 20; step++) {
    if (await root.evaluate(el => el.classList.contains('quiz_answered'))) {
      await atomicJson(file, { phase: 'complete', at: new Date().toISOString() }); return true;
    }
    const title = normalize(await root.locator('.quiz__title').innerText());
    const signature = await root.evaluate(feedbackState);
    const labels = root.locator('label.quiz__option');
    const options = (await labels.allTextContents()).map(normalize);
    const pending = { id, title, options, policy: cfg.feedbackPolicy };
    const prior = await readJson<{ phase: string; title?: string; signature?: string } | null>(file, null);
    if (prior?.phase === 'requested' && (prior.signature ? prior.signature === signature : prior.title === title)) {
      await atomicJson('.local/pending-feedback.json', { ...pending, reason: 'Результат предыдущей отправки пока не выяснен' }); return false;
    }
    if (cfg.feedbackPolicy !== 'neutral') {
      await atomicJson('.local/pending-feedback.json', { ...pending, reason: 'Личный опрос или свободный отзыв требует разбора' }); return false;
    }
    const isNeutral = (option: string) => /затрудняюсь|трудно сказать|пока не знаю|нейтраль|средне|нормально|в целом/i.test(option) || /^не знаю$/i.test(option);
    const matrix = root.locator('.likert-scale');
    let answer: string;
    if (await matrix.count() === 1) {
      const grades = matrix.locator('.likert-scale__grade-label');
      const candidates = (await grades.allTextContents()).map(normalize).map((option, index) => ({ option, index })).filter(item => isNeutral(item.option));
      if (candidates.length !== 1) {
        await atomicJson('.local/pending-feedback.json', { ...pending, reason: 'Нет однозначной нейтральной оценки таблицы' }); return false;
      }
      const grade = candidates[0];
      const gradeId = await grades.nth(grade.index).getAttribute('id');
      if (!gradeId || !/^[a-zA-Z0-9_-]+$/.test(gradeId)) throw new Error('Не определён ID нейтральной оценки');
      const rows = matrix.locator('.likert-scale__statement-row');
      if (!await rows.count()) throw new Error('В таблице опроса нет строк');
      for (let index = 0; index < await rows.count(); index++) {
        const label = rows.nth(index).locator(`label:has(input[aria-labelledby="${gradeId}"])`);
        if (await label.count() !== 1) throw new Error('Неоднозначная оценка строки опроса');
        await label.click();
        if (!await label.locator('input').isChecked()) throw new Error('Выбор строки опроса не подтверждён');
      }
      answer = grade.option;
    } else if (await root.locator('textarea, input[type="text"], [contenteditable="true"]').count()) {
      const fields = root.locator('textarea, input[type="text"], [contenteditable="true"]');
      const optionalBlank = await fields.evaluateAll(elements => elements.every(el =>
        !(el as HTMLInputElement).required && !el.hasAttribute('aria-required') &&
        ('value' in el ? !(el as HTMLInputElement).value : !el.textContent?.trim()),
      ));
      if (!optionalBlank || await root.locator('input[type="radio"], input[type="checkbox"]').count() || !await root.locator('.quiz__move-on').isEnabled()) {
        await atomicJson('.local/pending-feedback.json', { ...pending, reason: 'Обязательный или заполненный свободный отзыв требует разбора' }); return false;
      }
      answer = '(свободный отзыв оставлен пустым)';
    } else {
    const neutral = options.map((option, index) => ({ option, index })).filter(item => isNeutral(item.option));
    if (neutral.length !== 1) {
      await atomicJson('.local/pending-feedback.json', { ...pending, reason: 'Нет однозначного нейтрального варианта' }); return false;
    }
    const choice = neutral[0];
    await labels.nth(choice.index).click();
    if (!await labels.nth(choice.index).locator('input[type="radio"]').isChecked()) throw new Error('Выбор опроса не подтверждён');
    answer = choice.option;
    }
    if (!await root.locator('.quiz__move-on').isEnabled()) throw new Error('Кнопка продолжения опроса не активна');
    await atomicJson(file, { phase: 'requested', title, signature, answer });
    await root.locator('.quiz__move-on').click();
    try {
      const deadline = Date.now() + 120000;
      while (!await root.evaluate(el => el.classList.contains('quiz_answered')) && await root.evaluate(feedbackState) === signature) {
        if (Date.now() >= deadline) return false;
        await page.waitForTimeout(500);
      }
    } catch { return false; }
    await journal('feedback-step', { id, title, answer });
    await page.waitForTimeout(700);
  }
  return false;
}
