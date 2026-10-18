import type { Page, Locator } from 'playwright';
import type { Config } from './config.js';
import { quizOutcome, exactButton } from './quiz.js';
import { atomicJson, normalize, readJson, journal } from './store.js';

interface MatchingAnswer { quizId: string; prompt: string; pairs: Record<string, string>; verifiedAt?: string; evidence?: string }

async function identity(root: Locator): Promise<{ quizId: string; prompt: string; rows: string[] }> {
  const quizId = await root.getAttribute('data-test-id') ?? '';
  if (!/^quiz-choice-[a-f0-9-]+$/.test(quizId)) throw new Error('Не определён ID сопоставления');
  const prompt = normalize(await root.locator('.quiz__content').innerText());
  const rows = (await root.locator('.quiz-form-matching__prompt-content').allTextContents()).map(normalize);
  if (!rows.length || rows.some(row => !row) || new Set(rows).size !== rows.length) throw new Error('Неоднозначные подписи строк сопоставления');
  return { quizId, prompt, rows };
}

export async function captureMatching(root: Locator, cfg: Config): Promise<void> {
  if (await quizOutcome(root, cfg) !== 'correct') throw new Error('Сопоставление ещё не принято');
  const current = await identity(root);
  const rows = root.locator('.quiz-form-matching__prompt');
  const pairs: Record<string, string> = {};
  for (let i = 0; i < current.rows.length; i++) {
    pairs[current.rows[i]] = normalize(await rows.nth(i).locator('.quiz-form-matching__answer .markdown').innerText());
    if (!pairs[current.rows[i]]) throw new Error('Не прочитан принятый ответ сопоставления');
  }
  const existing = await readJson<MatchingAnswer | null>(`data/matching/${current.quizId}.json`, null);
  if (existing?.verifiedAt && existing.evidence && existing.prompt === current.prompt && Object.keys(existing.pairs).length === current.rows.length && current.rows.every(row => existing.pairs[row] === pairs[row])) return;
  await atomicJson(`data/matching/${current.quizId}.json`, { quizId: current.quizId, prompt: current.prompt, pairs, verifiedAt: new Date().toISOString(), evidence: 'quiz_answered: all quiz-form-matching__prompt_correct' } satisfies MatchingAnswer);
}

export async function solveMatching(page: Page, root: Locator, cfg: Config): Promise<boolean> {
  if (await quizOutcome(root, cfg) === 'correct') { await captureMatching(root, cfg); return true; }
  const current = await identity(root);
  const saved = await readJson<MatchingAnswer | null>(`data/matching/${current.quizId}.json`, null);
  const decisions = await readJson<Record<string, Record<string, string>>>('.local/matching-decisions.json', {});
  const pairs = saved?.pairs ?? decisions[current.quizId];
  if (saved && (!saved.verifiedAt || !saved.evidence || saved.prompt !== current.prompt || saved.quizId !== current.quizId)) throw new Error('Сопоставление в базе не подтверждено или вопрос изменён');
  if (!pairs) {
    const toggle = root.locator('.rich-select__toggle-wrapper').first();
    await toggle.click();
    await page.getByRole('option').first().waitFor();
    const options = (await page.getByRole('option').allTextContents()).map(normalize);
    await page.keyboard.press('Escape');
    await atomicJson('.local/pending-matching.json', { ...current, options });
    return false;
  }
  if (Object.keys(pairs).length !== current.rows.length || current.rows.some(row => !pairs[row])) throw new Error('Строки сопоставления изменились');
  const requestFile = `.local/matching/${current.quizId}.json`;
  const prior = await readJson<{ phase: string } | null>(requestFile, null);
  if (prior?.phase !== 'requested') {
    if (await quizOutcome(root, cfg) === 'wrong') {
      if (saved) return false;
      const retry = await exactButton(root, ['Начать заново']);
      if (!retry) return false;
      await retry.click();
    }
    const rows = root.locator('.quiz-form-matching__prompt');
    for (let i = 0; i < current.rows.length; i++) {
      const row = rows.nth(i);
      const value = normalize(pairs[current.rows[i]]);
      await row.locator('.rich-select__toggle-wrapper').click();
      const option = page.getByRole('option', { name: value, exact: true });
      if (await option.count() !== 1) throw new Error('Ответ сопоставления отсутствует или неоднозначен');
      await option.click();
      if (normalize(await row.locator('.rich-select__toggle').innerText()) !== value) throw new Error('Выбор сопоставления не подтверждён');
    }
    await atomicJson(requestFile, { phase: 'requested', pairs });
    await root.locator('.quiz__submit').click();
  }
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const result = await quizOutcome(root, cfg);
    if (result !== 'unknown') {
      await atomicJson(requestFile, { phase: result, pairs });
      await journal('matching-result', { quizId: current.quizId, result });
      if (result === 'correct') { await captureMatching(root, cfg); return true; }
      return false;
    }
    await page.waitForTimeout(500);
  }
  return false;
}
