import type { Page, Frame } from 'playwright';
import { advanceTrainer, canReplaceTrainerFile, contentHash, readTrainer, writeEditor, type TrainerSolution } from './trainer.js';
import { atomicJson, journal, normalize, readJson } from './store.js';

interface PracticeState {
  phase: 'edited' | 'requested' | 'self-checked'; solutionHash: string; updatedAt: string;
  files: Array<{ name: string; initialHash: string; contentHash: string }>;
}

export function isSelfPractice(instructions: string): boolean {
  return /в этом задании не будет проверок результата/i.test(normalize(instructions));
}

export async function verifyPractice(page: Page, checks: NonNullable<TrainerSolution['practiceChecks']>): Promise<void> {
  if (!checks?.length || checks.length > 8) throw new Error('Для самостоятельного упражнения нужны проверки интерфейса');
  const allowed = new Set(['color', 'backgroundColor', 'transform', 'textDecorationLine', 'outlineColor', 'outlineWidth', 'borderColor']);
  for (const check of checks) {
    if (!check.selector?.trim() || !Object.keys(check.hover ?? {}).length || [check.hover, check.active ?? {}].some(styles => Object.entries(styles).some(([key, value]) => !allowed.has(key) || typeof value !== 'string'))) throw new Error('Неверная проверка состояний самостоятельного упражнения');
    let frame: Frame | undefined;
    const deadline = Date.now() + 120000;
    while (!frame && Date.now() < deadline) {
      for (const candidate of await practiceFrames(page)) if (await candidate.locator(check.selector).count() === 1) { frame = candidate; break; }
      if (!frame) await page.waitForTimeout(250);
    }
    if (!frame) throw new Error('Не найден элемент самостоятельного упражнения в предпросмотре');
    const target = frame.locator(check.selector);
    const matches = (styles: Record<string, string>) => target.evaluate((el, expected) => {
      const actual = getComputedStyle(el);
      return Object.entries(expected).every(([key, value]) => actual[key as keyof CSSStyleDeclaration] === value);
    }, styles);
    await target.hover();
    let matched = false;
    for (let step = 0; step < 50; step++) { if (await matches(check.hover)) { matched = true; break; } await page.waitForTimeout(100); }
    if (!matched) throw new Error('Стили hover не соответствуют самостоятельному решению');
    if (check.active) {
      const box = await target.boundingBox(); const viewport = page.viewportSize();
      if (!box || !viewport) throw new Error('Не определена область для безопасного отпускания мыши');
      const release = [{x:1,y:1},{x:viewport.width-1,y:1},{x:1,y:viewport.height-1},{x:viewport.width-1,y:viewport.height-1}].find(point => point.x < box.x || point.x > box.x+box.width || point.y < box.y || point.y > box.y+box.height);
      if (!release) throw new Error('Нельзя проверить active без перехода по ссылке');
      await page.mouse.down();
      try {
        matched = false;
        for (let step = 0; step < 50; step++) { if (await matches(check.active)) { matched = true; break; } await page.waitForTimeout(100); }
        if (!matched) throw new Error('Стили active не соответствуют самостоятельному решению');
      } finally { await page.mouse.move(release.x, release.y); await page.mouse.up(); }
    }
  }
}

export async function solvePractice(page: Page, task: Awaited<ReturnType<typeof readTrainer>>, solution: TrainerSolution, candidate: boolean): Promise<'advanced' | 'finished' | 'pending'> {
  if (!isSelfPractice(task.instructions) || solution.verification !== 'self' || !solution.practiceChecks?.length) throw new Error('Самопроверка разрешена только для явно непроверяемого задания');
  const file = `.local/practices/${task.taskId}.json`;
  const hash = contentHash(JSON.stringify({ files: solution.files, checks: solution.practiceChecks }));
  const state = await readJson<PracticeState | null>(file, null);
  if (state?.phase === 'requested' && state.solutionHash !== hash) throw new Error('Сначала нужно выяснить результат завершения самостоятельного шага');
  for (const item of solution.files) {
    const current = task.files.filter(current => current.path.split('/').pop() === item.name);
    if (current.length !== 1 || !canReplaceTrainerFile(current[0].hash, item, state?.files.find(previous => previous.name === item.name))) throw new Error('Исходник самостоятельного упражнения изменён');
  }
  if (state?.phase !== 'requested') {
    for (const item of solution.files) if (task.files.find(current => current.path.split('/').pop() === item.name)?.hash !== contentHash(item.content)) await writeEditor(page, item.name, item.content);
  }
  const files = solution.files.map(item => ({ name: item.name, initialHash: item.initialHash, contentHash: contentHash(item.content) }));
  if (state?.phase !== 'requested' && !(state?.phase === 'self-checked' && state.solutionHash === hash)) await atomicJson(file, { phase: 'edited', solutionHash: hash, files, updatedAt: new Date().toISOString() } satisfies PracticeState);
  const refresh = page.getByRole('button', { name: 'Обновить', exact: true });
  if (await refresh.count() !== 1) throw new Error('Нет однозначной кнопки обновления предпросмотра');
  await refresh.click();
  await page.waitForTimeout(700);
  await verifyPractice(page, solution.practiceChecks);
  const next = page.locator('[data-test-id="next-task-button"]');
  if (state?.phase !== 'requested' && !(state?.phase === 'self-checked' && state.solutionHash === hash) && !await next.isVisible()) {
    await atomicJson(file, { phase: 'requested', solutionHash: hash, files, updatedAt: new Date().toISOString() } satisfies PracticeState);
    await journal('practice-finish-requested', { taskId: task.taskId });
    await page.locator('[data-test-id="check-task-button"]').click();
  }
  try { await next.waitFor({ state: 'visible', timeout: 120000 }); }
  catch { return 'pending'; }
  const deadline = Date.now() + 120000;
  while (!await next.isEnabled()) { if (Date.now() >= deadline) return 'pending'; await page.waitForTimeout(250); }
  await atomicJson(file, { phase: 'self-checked', solutionHash: hash, files, updatedAt: new Date().toISOString() } satisfies PracticeState);
  if (candidate) {
    const { instructions: _instructions, ...portable } = solution;
    await atomicJson(`data/practice/${task.taskId}.json`, { ...portable, instructionsHash: contentHash(normalize(task.instructions)), contextHash: task.contextHash, verifiedAt: new Date().toISOString(), evidence: { selector: 'iframe.trainer-result__content', message: 'Указанные состояния интерфейса проверены в браузере; штатная кнопка Далее доступна. Автопроверки результата в задании нет.' } });
  }
  await journal('practice-self-checked', { taskId: task.taskId });
  return advanceTrainer(page, task.instructions, solution.lessonId);
}

export async function practiceFrames(page: Page): Promise<Frame[]> {
  const preview = page.locator('iframe.trainer-result__content');
  await preview.waitFor({ state: 'attached', timeout: 120000 });
  if (await preview.count() !== 1) throw new Error('Нет однозначного предпросмотра тренажёра');
  const source = new URL(await preview.getAttribute('src') ?? '', page.url());
  if (source.protocol !== 'https:' || source.hostname !== 'feynman.praktikum.yandex.net') throw new Error('Неизвестный источник предпросмотра');
  const frame = await (await preview.elementHandle())?.contentFrame();
  if (!frame) throw new Error('Предпросмотр ещё не загрузился');
  if (frame.url() === 'about:blank') await frame.waitForURL(url => url.hostname === source.hostname, { waitUntil: 'commit', timeout: 120000 });
  if (new URL(frame.url()).hostname !== source.hostname) throw new Error('Предпросмотр имеет другой источник');
  await frame.locator('body').waitFor({ state: 'attached', timeout: 120000 });
  const descendants = (root: Frame): Frame[] => [root, ...root.childFrames().flatMap(descendants)];
  return descendants(frame);
}

export async function inspectPractice(page: Page): Promise<unknown> {
  return {
    controls: await page.locator('[data-test-id="check-task-button"], [data-test-id="next-task-button"]').evaluateAll(elements => elements.map(el => ({ text: el.textContent, disabled: el.hasAttribute('disabled'), html: el.outerHTML }))),
    frames: await Promise.all((await practiceFrames(page)).map(async frame => ({ url: new URL(frame.url()).origin + new URL(frame.url()).pathname, text: (await frame.locator('body').innerText()).slice(0, 3000), links: await frame.locator('.card__link').evaluateAll(elements => elements.map(el => ({ hover: el.matches(':hover'), color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor, rules: [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules].map(rule => rule.cssText).filter(rule => rule.includes('.card__link')); } catch { return []; } }) }))) }))),
  };
}
