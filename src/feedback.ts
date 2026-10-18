import type { Page, Locator } from 'playwright';
import type { Config } from './config.js';
import { atomicJson, readJson, normalize, journal } from './store.js';

export async function solveFeedback(page: Page, root: Locator, cfg: Config): Promise<boolean> {
  const id = await root.getAttribute('data-test-id') ?? '';
  if (!/^quiz-feedback-[a-f0-9-]+$/.test(id)) throw new Error('Не определён ID опроса');
  const file = `.local/feedback/${id}.json`;
  for (let step = 0; step < 20; step++) {
    if (await root.evaluate(el => el.classList.contains('quiz_answered'))) {
      await atomicJson(file, { phase: 'complete', at: new Date().toISOString() }); return true;
    }
    const title = normalize(await root.locator('.quiz__title').innerText());
    const labels = root.locator('label.quiz__option');
    const options = (await labels.allTextContents()).map(normalize);
    const pending = { id, title, options, policy: cfg.feedbackPolicy };
    const prior = await readJson<{ phase: string; title?: string } | null>(file, null);
    if (prior?.phase === 'requested' && prior.title === title) {
      await atomicJson('.local/pending-feedback.json', { ...pending, reason: 'Результат предыдущей отправки пока не выяснен' }); return false;
    }
    if (cfg.feedbackPolicy !== 'neutral' || await root.locator('textarea, input[type="text"], [contenteditable="true"]').count()) {
      await atomicJson('.local/pending-feedback.json', { ...pending, reason: 'Личный опрос или свободный отзыв требует разбора' }); return false;
    }
    const neutral = options.map((option, index) => ({ option, index })).filter(item => /затрудняюсь|трудно сказать|пока не знаю|нейтраль|средне|нормально|в целом/i.test(item.option));
    if (neutral.length !== 1) {
      await atomicJson('.local/pending-feedback.json', { ...pending, reason: 'Нет однозначного нейтрального варианта' }); return false;
    }
    const choice = neutral[0];
    await labels.nth(choice.index).click();
    if (!await labels.nth(choice.index).locator('input[type="radio"]').isChecked()) throw new Error('Выбор опроса не подтверждён');
    await atomicJson(file, { phase: 'requested', title, answer: choice.option });
    await root.locator('.quiz__move-on').click();
    try {
      await root.page().waitForFunction(({ id, title }) => {
        const root = document.querySelector(`[data-test-id="${id}"]`);
        const next = root?.querySelector('.quiz__title')?.textContent?.normalize('NFKC').replace(/\s+/g, ' ').trim();
        return root?.classList.contains('quiz_answered') || (!!next && next !== title);
      }, { id, title }, { timeout: 120000 });
    } catch { return false; }
    await journal('feedback-step', { id, title, answer: choice.option });
    await page.waitForTimeout(700);
  }
  return false;
}
