import type { Locator, Page } from 'playwright';
import { createHash } from 'node:crypto';
import { atomicJson, journal, normalize, readJson } from './store.js';

export interface TextQuestion { id: string; prompt: string; promptHash: string }
interface TextAnswer { id: string; promptHash: string; answer: string; verifiedAt: string; evidence: string }
export async function readTextQuestion(root: Locator): Promise<TextQuestion> {
  const id = await root.getAttribute('data-test-id') ?? '';
  if (!/^quiz-text-[a-f0-9-]+$/.test(id)) throw new Error('Не определён ID текстового задания');
  const prompt = normalize(await root.locator('.quiz__content').first().innerText());
  if (!prompt) throw new Error('Не найден текст задания');
  return { id, prompt, promptHash: createHash('sha256').update(prompt).digest('hex') };
}
export async function textQuestionCorrect(root: Locator): Promise<boolean> {
  return await root.evaluate(el => el.classList.contains('quiz_answered')) &&
    await root.locator('.quiz__content-block_status_success').count() === 1;
}
export async function captureTextAnswer(root: Locator): Promise<boolean> {
  if (!await textQuestionCorrect(root)) return false;
  const question = await readTextQuestion(root);
  const answer = (await root.locator('.quiz__content-block_status_success').innerText()).trim();
  if (!answer) throw new Error('Пустой ответ не может быть подтверждён');
  const file = `data/text-questions/${question.id}.json`;
  const old = await readJson<TextAnswer | null>(file, null);
  if (old?.promptHash !== question.promptHash || old?.answer !== answer || !old.verifiedAt) {
    await atomicJson(file, { id: question.id, promptHash: question.promptHash, answer, verifiedAt: new Date().toISOString(), evidence: '.quiz_answered .quiz__content-block_status_success' } satisfies TextAnswer);
  }
  await atomicJson(`.local/text-questions/${question.id}.json`, { phase: 'correct', promptHash: question.promptHash, answer });
  return true;
}
export async function solveTextQuestion(page: Page, root: Locator): Promise<boolean> {
  if (await captureTextAnswer(root)) return true;
  const question = await readTextQuestion(root);
  const stateFile = `.local/text-questions/${question.id}.json`;
  const prior = await readJson<{ phase: string; promptHash?: string; answer: string } | null>(stateFile, null);
  const pending = async (reason: string): Promise<false> => {
    await atomicJson('.local/pending-text-question.json', { ...question, url: new URL(page.url()).pathname, reason }); return false;
  };
  if (await root.evaluate(el => el.classList.contains('quiz_answered'))) return pending('Задание завершено без положительного маркера: нужен разбор результата');
  if (prior?.phase !== 'requested') {
    const saved = await readJson<TextAnswer | null>(`data/text-questions/${question.id}.json`, null);
    const choices = await readJson<Record<string, { promptHash: string; answer: string }>>('.local/text-decisions.json', {});
    const decision = saved ?? choices[question.id];
    if (!decision) return pending('Нужен ответ на новое текстовое задание');
    if (decision.promptHash !== question.promptHash || !decision.answer?.trim() || (saved && (!saved.verifiedAt || !saved.evidence))) throw new Error('Текстовое решение изменилось или не подтверждено');
    const input = root.locator('textarea.quiz__input-control');
    if (await input.count() !== 1) throw new Error('Поле текстового задания не найдено или неоднозначно');
    const current = await input.inputValue();
    if (current && current !== decision.answer) return pending('В поле уже есть другой ответ; он сохранён без перезаписи');
    await input.fill(decision.answer);
    if (await input.inputValue() !== decision.answer) throw new Error('Ввод текстового ответа не подтверждён');
    const submit = root.getByRole('button', { name: 'Узнать ответ', exact: true });
    await submit.waitFor({ state: 'visible' });
    if (!await submit.isEnabled()) return pending('Кнопка проверки недоступна');
    await atomicJson(stateFile, { phase: 'requested', promptHash: question.promptHash, answer: decision.answer });
    await submit.click();
  } else if (prior.promptHash !== question.promptHash) throw new Error('Нужно выяснить результат предыдущей отправки изменённого текстового задания');
  try {
    await page.waitForFunction(id => document.querySelector(`[data-test-id="${id}"]`)?.classList.contains('quiz_answered'), question.id, { timeout: 120000 });
  } catch { return pending('Результат отправки неизвестен; повторной отправки не было'); }
  if (!await captureTextAnswer(root)) return pending('Положительный результат не подтверждён');
  await journal('text-question-correct', { id: question.id });
  return true;
}
