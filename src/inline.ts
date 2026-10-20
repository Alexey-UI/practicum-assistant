import type { Frame, Page } from 'playwright';
import { atomicJson, journal, normalize, readJson } from './store.js';
import { contentHash, canReplaceTrainerFile } from './trainer.js';
import { lessonId, safeUrl } from './browser.js';

interface MirrorElement extends HTMLElement { CodeMirror?: { getValue(): string } }
export interface InlineTask {
  id: string; lessonId: string; url: string; instructions: string; instructionsHash: string;
  previousInstructionsHash?: string;
  files: Array<{ name: string; content: string; hash: string }>;
}
export interface InlineSolution {
  id: string; lessonId: string; url: string; instructionsHash: string;
  files: Array<{ name: string; initialHash: string; content: string }>;
  verifiedAt?: string; evidence?: { selector: string; message: string };
}
interface InlineState {
  phase: 'requested' | 'correct' | 'wrong'; solutionHash: string; requestedAt: string;
  files?: Array<{ name: string; initialHash: string; contentHash: string }>;
  verifiedAt?: string;
  detectedResult?: { outcome: 'correct' | 'wrong'; message: string; observedAt: string; selector: string };
}

async function loadSolution(task: InlineTask, candidate: boolean): Promise<InlineSolution | null> {
  const solution = await readJson<InlineSolution | null>(`${candidate ? '.local/inline-solutions' : 'data/inline'}/${task.id}.json`, null);
  if (!solution) return null;
  if (solution.id !== task.id || solution.lessonId !== task.lessonId || solution.url !== task.url || solution.instructionsHash !== task.instructionsHash || !solution.files.length || (!candidate && (!solution.verifiedAt || !solution.evidence?.message))) throw new Error('Эталон встроенного задания изменился или не подтверждён');
  return solution;
}

export async function sandboxFrame(page: Page, index: number): Promise<Frame> {
  const embeds = page.locator('.theory-viewer iframe');
  if (!Number.isInteger(index) || index < 0 || index >= await embeds.count()) throw new Error('Неверный номер встроенного примера');
  const source = new URL(await embeds.nth(index).getAttribute('src') ?? '', page.url());
  if (source.origin !== 'https://sandbox.practicum-team.ru' || !source.pathname.startsWith('/tasks/')) throw new Error('Ожидался учебный sandbox Практикума');
  const frame = await (await embeds.nth(index).elementHandle())?.contentFrame();
  if (!frame) throw new Error('Встроенный пример ещё не загрузился');
  if (frame.url() === 'about:blank') await frame.waitForURL(url => url.origin === source.origin && url.pathname.startsWith('/tasks/'), { waitUntil: 'commit', timeout: 120000 });
  const url = new URL(frame.url());
  if (url.origin !== 'https://sandbox.practicum-team.ru' || !url.pathname.startsWith('/tasks/')) throw new Error('Ожидался учебный sandbox Практикума');
  return frame;
}

export async function gradedSandboxIndices(page: Page): Promise<number[]> {
  const embeds = page.locator('.theory-viewer iframe');
  const indices: number[] = [];
  for (let index = 0; index < await embeds.count(); index++) {
    const embed = embeds.nth(index);
    if (!await embed.isVisible()) continue;
    const source = new URL(await embed.getAttribute('src') ?? '', page.url());
    if (source.origin !== 'https://sandbox.practicum-team.ru' || !source.pathname.startsWith('/tasks/')) continue;
    const frame = await sandboxFrame(page, index);
    await frame.locator('.CodeMirror').waitFor({ state: 'visible', timeout: 120000 });
    const check = frame.getByRole('button', { name: 'Проверить', exact: true });
    if (await check.count() === 1 && await check.isVisible()) indices.push(index);
    else if (!await frame.getByText('Проверка не требуется', { exact: true }).isVisible()) throw new Error(`Неизвестный тип встроенного примера: ${safeUrl(frame.url())}`);
  }
  return indices;
}

async function selectFile(frame: Frame, name: string): Promise<void> {
  const tabs = frame.locator('.tabs .tab').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
  if (await tabs.count() !== 1) throw new Error(`Вкладка ${name} отсутствует или неоднозначна`);
  const selected = () => tabs.evaluate(tab => (tab as HTMLElement).style.zIndex === '1');
  if (await selected()) return;
  // Target the filename rather than the padding around a wide tab.
  // Offscreen sandbox frames may stop receiving animation callbacks in Chrome.
  // Poll the actual selected tab independently of repaint scheduling.
  try {
    const deadline = Date.now() + 30000;
    let nextClick = 0;
    while (!await selected()) {
      if (Date.now() >= deadline) throw new Error(`Редактор не переключился на файл ${name}`);
      if (Date.now() >= nextClick) {
        await frame.locator('.tabs').getByText(name, { exact: true }).click();
        nextClick = Date.now() + 2000;
      }
      await frame.page().waitForTimeout(100);
    }
  } catch (error) {
    await atomicJson('.local/inline-tab-failure.json', { file: name, url: safeUrl(frame.url()), tabs: await frame.locator('.tabs .tab').evaluateAll(items => items.map(item => item.outerHTML)) });
    throw error;
  }
}

async function code(frame: Frame): Promise<string> {
  return frame.locator('.CodeMirror').evaluate(el => {
    const mirror = (el as MirrorElement).CodeMirror;
    if (!mirror) throw new Error('CodeMirror недоступен для чтения');
    return mirror.getValue();
  });
}

export async function readInline(page: Page, index: number, onlyNames?: string[]): Promise<InlineTask> {
  const frame = await sandboxFrame(page, index);
  await frame.locator('.CodeMirror').waitFor({ state: 'visible', timeout: 120000 });
  const allNames = (await frame.locator('.tabs .tab').allTextContents()).map(name => name.trim());
  if (!allNames.length || new Set(allNames).size !== allNames.length || onlyNames?.some(name => !allNames.includes(name))) throw new Error('Не удалось однозначно прочитать вкладки встроенного редактора');
  const names = onlyNames ?? allNames;
  const instructions = await page.locator('.theory-viewer iframe').nth(index).evaluate(iframe => {
    const parts: string[] = [];
    const previous: string[] = [];
    let current: Node | null = iframe.closest('.iframe-wrapper') ?? iframe;
    const boundary = iframe.closest('.theory-viewer');
    while (current && current !== boundary && parts.join('').length < 16000) {
      let node = current.previousSibling;
      while (node) {
        if (node instanceof Element && (node.matches('iframe') || node.querySelector('iframe'))) return { clean: parts.join(' '), previous: previous.join(' ') };
        previous.unshift(node.textContent ?? '');
        const copy = node.cloneNode(true);
        if (copy instanceof Element) {
          copy.querySelectorAll('.chat__message-author').forEach(author => author.remove());
          parts.unshift(copy.matches('.chat__message-author') ? '' : copy.textContent ?? '');
        } else parts.unshift(copy.textContent ?? '');
        node = node.previousSibling;
      }
      current = current.parentNode;
    }
    return { clean: parts.join(' '), previous: previous.join(' ') };
  });
  if (!normalize(instructions.clean)) throw new Error('Не найдено условие встроенного упражнения');
  const files: InlineTask['files'] = [];
  for (const name of names) {
    await selectFile(frame, name);
    const content = await code(frame);
    files.push({ name, content, hash: contentHash(content) });
  }
  await selectFile(frame, names[0]);
  const url = safeUrl(frame.url());
  const ownerLesson = lessonId(page.url());
  if (!ownerLesson) throw new Error('Не определён урок встроенного примера');
  const task = { id: contentHash(url), lessonId: ownerLesson, url, instructions: normalize(instructions.clean), instructionsHash: contentHash(normalize(instructions.clean)), previousInstructionsHash: contentHash(normalize(instructions.previous)), files };
  if (!onlyNames) await atomicJson('.local/pending-inline.json', task);
  return task;
}

export async function applyInline(page: Page, index: number, candidate = true): Promise<InlineTask> {
  const task = await readInline(page, index);
  const solution = await loadSolution(task, candidate);
  if (!solution) throw new Error('Нужен кандидат для текущего встроенного задания');
  const state = await readJson<InlineState | null>(`.local/inline/${task.id}.json`, null);
  if (state?.phase === 'requested') throw new Error('Перед редактированием нужно выяснить результат предыдущей проверки');
  const previousFiles = candidate && state?.phase === 'wrong' ? state.files ?? [] : [];
  if (previousFiles.some(previous => !solution.files.some(file => file.name === previous.name && file.initialHash === previous.initialHash))) throw new Error('Сохраните исходные хеши и все файлы предыдущей попытки');
  const frame = await sandboxFrame(page, index);
  for (const file of solution.files) {
    const existing = task.files.find(item => item.name === file.name);
    if (!existing || !canReplaceTrainerFile(existing.hash, file, previousFiles.find(previous => previous.name === file.name))) throw new Error(`Исходный файл ${file.name} изменился: требуется разбор`);
  }
  for (const file of solution.files) {
    if (task.files.find(item => item.name === file.name)!.hash === contentHash(file.content)) continue;
    await selectFile(frame, file.name);
    const editor = frame.locator('.CodeMirror textarea');
    if (await editor.count() !== 1) throw new Error('Не найден однозначный ввод CodeMirror');
    await editor.focus();
    await editor.press('ControlOrMeta+A');
    await page.keyboard.insertText(file.content);
    if (await code(frame) !== file.content) throw new Error('Код во встроенном редакторе не совпал с кандидатом');
  }
  return task;
}

export async function requestInlineCheck(page: Page, index: number, candidate = true): Promise<void> {
  const task = await readInline(page, index);
  const solution = await loadSolution(task, candidate);
  if (!solution || solution.files.some(file => task.files.find(item => item.name === file.name)?.hash !== contentHash(file.content))) throw new Error('Перед проверкой код должен совпадать с кандидатом текущего задания');
  const file = `.local/inline/${task.id}.json`;
  const state = await readJson<{ phase: string } | null>(file, null);
  if (state?.phase === 'requested') throw new Error('Результат предыдущей проверки встроенного примера пока неизвестен');
  const frame = await sandboxFrame(page, index);
  const button = frame.getByRole('button', { name: 'Проверить', exact: true });
  if (await button.count() !== 1) throw new Error('Нет однозначной кнопки проверки встроенного примера');
  const close = frame.locator('.result button').filter({ visible: true });
  if (await close.count() === 1) await close.click();
  await atomicJson(file, { phase: 'requested', solutionHash: contentHash(JSON.stringify(solution.files)), files: solution.files.map(item => ({ name: item.name, initialHash: item.initialHash, contentHash: contentHash(item.content) })), requestedAt: new Date().toISOString() } satisfies InlineState);
  await journal('inline-check-requested', { id: task.id, url: task.url });
  await button.click();
}

export async function inlineOutcome(frame: Frame): Promise<'correct' | 'wrong' | 'unknown'> {
  const results = frame.locator('.result').filter({ visible: true });
  if (await results.count() !== 1) return 'unknown';
  if (await results.locator('.icon-status-success').count() === 1) return 'correct';
  if (await results.locator(':scope > i svg path').evaluateAll(paths => paths.some(path => path.getAttribute('fill')?.toLowerCase() === '#ff3b30'))) return 'wrong';
  // Only a completed result with an explicit other status icon is negative.
  const statuses = await results.locator('svg').evaluateAll(icons => icons.map(icon => icon.getAttribute('class') ?? ''));
  return statuses.some(status => /(?:^|\s)icon-status-(?!success)[\w-]+(?:\s|$)/.test(status)) ? 'wrong' : 'unknown';
}

export async function observeInline(page: Page, index: number, candidate = true): Promise<'correct' | 'wrong' | 'unknown'> {
  const currentFrame = await sandboxFrame(page, index);
  const id = contentHash(safeUrl(currentFrame.url()));
  const stored = await readJson<InlineSolution | null>(`${candidate ? '.local/inline-solutions' : 'data/inline'}/${id}.json`, null);
  if (!stored) return 'unknown';
  const task = await readInline(page, index, stored.files.map(file => file.name));
  const solution = await loadSolution(task, candidate);
  if (!solution) return 'unknown';
  const file = `.local/inline/${task.id}.json`;
  const state = await readJson<InlineState | null>(file, null);
  if (!state || state.solutionHash !== contentHash(JSON.stringify(solution.files)) || solution.files.some(item => task.files.find(current => current.name === item.name)?.hash !== contentHash(item.content))) return 'unknown';
  const frame = await sandboxFrame(page, index);
  const live = await inlineOutcome(frame);
  const outcome = live === 'unknown' ? state.detectedResult?.outcome ?? 'unknown' : live;
  if (outcome === 'unknown') return outcome;
  const message = live === 'unknown' ? state.detectedResult!.message : await frame.locator('.result md-content').innerText();
  const verifiedAt = new Date().toISOString();
  await atomicJson(file, { ...state, phase: outcome, ...(outcome === 'correct' ? { verifiedAt } : {}) });
  await journal('inline-result', { id: task.id, outcome, message });
  if (outcome === 'correct' && candidate) await atomicJson(`data/inline/${task.id}.json`, { ...solution, verifiedAt, evidence: { selector: live === 'unknown' ? state.detectedResult!.selector : '.result .icon-status-success', message } });
  if (outcome === 'wrong') await atomicJson('.local/inline-review.json', { id: task.id, message });
  return outcome;
}

export async function solveInline(page: Page, index: number, candidate = false): Promise<boolean> {
  const task = await readInline(page, index);
  const solution = await loadSolution(task, candidate);
  if (!solution) return false;
  const hash = contentHash(JSON.stringify(solution.files));
  const state = await readJson<InlineState | null>(`.local/inline/${task.id}.json`, null);
  if (state?.phase === 'requested' && state.solutionHash !== hash) throw new Error('Сначала выясните результат предыдущей проверки встроенного примера');
  if (state?.solutionHash === hash && state.phase === 'correct' && state.verifiedAt && solution.files.every(file => task.files.find(item => item.name === file.name)?.hash === contentHash(file.content))) return true;
  if (state?.phase === 'requested' && state.detectedResult) return await observeInline(page, index, candidate) === 'correct';
  if (state?.solutionHash === hash && state.phase === 'wrong') return false;
  if (state?.phase !== 'requested') {
    await applyInline(page, index, candidate);
    await requestInlineCheck(page, index, candidate);
  }
  const deadline = Date.now() + 120000;
  const frame = await sandboxFrame(page, index);
  while (Date.now() < deadline) {
    const outcome = await inlineOutcome(frame);
    if (outcome !== 'unknown') {
      const file = `.local/inline/${task.id}.json`;
      const pending = await readJson<InlineState | null>(file, null);
      if (!pending || pending.solutionHash !== hash) throw new Error('Состояние проверки изменилось');
      await atomicJson(file, { ...pending, detectedResult: { outcome, message: await frame.locator('.result md-content').innerText(), observedAt: new Date().toISOString(), selector: outcome === 'correct' ? '.result .icon-status-success' : '.result' } });
      return await observeInline(page, index, candidate) === 'correct';
    }
    await page.waitForTimeout(500);
  }
  return false;
}

export async function inlineCommand(page: Page, action: { command?: string; index?: number }): Promise<unknown> {
  const index = action.index ?? 0;
  if (action.command === 'normalize-context') {
    const task = await readInline(page, index);
    for (const directory of ['data/inline', '.local/inline-solutions']) {
      const file = `${directory}/${task.id}.json`;
      const solution = await readJson<InlineSolution | null>(file, null);
      if (!solution) continue;
      if (solution.id !== task.id || solution.lessonId !== task.lessonId || solution.url !== task.url || ![task.instructionsHash, task.previousInstructionsHash].includes(solution.instructionsHash) || solution.files.some(item => task.files.find(current => current.name === item.name)?.hash !== contentHash(item.content))) throw new Error('Нормализация допускается только при неизменном условии и коде ранее проверенного решения');
      const state = await readJson<InlineState | null>(`.local/inline/${task.id}.json`, null);
      if (state?.phase !== 'correct' || state.solutionHash !== contentHash(JSON.stringify(solution.files))) throw new Error('Нет подтверждённого результата текущего решения');
      await atomicJson(file, { ...solution, instructionsHash: task.instructionsHash });
    }
    return { id: task.id, normalized: true };
  }
  if (action.command === 'preview') {
    const frame = await sandboxFrame(page, index);
    const link = frame.locator('.runtime .toolbar a');
    if (await link.count() !== 1) throw new Error('Нет однозначной ссылки на предпросмотр');
    const [preview] = await Promise.all([page.waitForEvent('popup', { timeout: 30000 }), link.click()]);
    try {
      await preview.locator('body').waitFor({ state: 'attached', timeout: 30000 });
      await preview.waitForTimeout(1000);
      const result = { url: preview.url(), title: await preview.title(), links: await preview.locator('link[rel*="icon"]').evaluateAll(links => links.map(link => ({ rel: link.getAttribute('rel'), href: (link as HTMLLinkElement).href }))) };
      await atomicJson('.local/inline-preview.json', result);
      return { url: safeUrl(result.url), saved: '.local/inline-preview.json' };
    } finally { await preview.close(); }
  }
  if (action.command === 'observe') return { result: await observeInline(page, index) };
  if (action.command === 'solve') return { solved: await solveInline(page, index, true) };
  if (action.command === 'check') { await requestInlineCheck(page, index); return { result: 'requested' }; }
  const task = action.command === 'read' ? await readInline(page, index) : action.command === 'apply' ? await applyInline(page, index) : undefined;
  if (!task) throw new Error('Неизвестная команда встроенного редактора');
  return { id: task.id, saved: '.local/pending-inline.json', files: task.files.map(file => ({ name: file.name, hash: file.hash })) };
}
