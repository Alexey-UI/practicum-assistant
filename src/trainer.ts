import type { Page } from 'playwright';
import { createHash } from 'node:crypto';
import { atomicJson, journal, readJson, normalize } from './store.js';
import { safeUrl, lessonId, settle, isTrainerTaskUrl } from './browser.js';

export interface EditorFile { path: string; language: string; content: string; hash: string }
interface MonacoModel { uri: { path: string }; getLanguageId(): string; getValue(): string }
interface MonacoWindow extends Window { monaco?: { editor: {
  getModels(): MonacoModel[];
  getEditors(): Array<{ hasTextFocus(): boolean; trigger(source: string, action: string, args: unknown): void }>;
} } }
export const contentHash = (content: string) => createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');

export async function selectEditorFile(page: Page, name: string): Promise<void> {
  const treeFile = page.locator('.files-tree').getByText(name, { exact: true }).filter({ visible: true });
  const tabText = page.getByText(name, { exact: true }).and(page.locator('article.tab__text'));
  const file = await treeFile.count() ? treeFile : page.locator('section.tab').filter({ has: tabText, visible: true });
  if (await file.count() !== 1) throw new Error(`Файл ${name} не найден или неоднозначен в дереве редактора`);
  await file.click();
}

export async function readTrainer(page: Page): Promise<{ taskId: string; url: string; instructions: string; images: Array<{ url: string; alt: string }>; contextHash: string; files: EditorFile[] }> {
  await page.getByRole('textbox', { name: 'Содержимое редактора', exact: true }).waitFor({ state: 'visible', timeout: 180000 });
  await page.locator('.task-description__markdown').filter({ hasText: /\S/, visible: true }).waitFor({ timeout: 180000 });
  const files = await page.evaluate(() => {
    const editor = (window as MonacoWindow).monaco?.editor;
    if (!editor) throw new Error('Monaco API недоступен для чтения исходного кода');
    return editor.getModels().map(model => ({ path: model.uri.path, language: model.getLanguageId(), content: model.getValue() }));
  });
  const taskId = new URL(page.url()).pathname.match(/\/task\/([^/]+)\//)?.[1];
  if (!taskId) throw new Error('Не определён ID задания тренажёра');
  const images = await page.locator('.task-description__markdown img').evaluateAll(elements => elements.map(el => ({ url: (el as HTMLImageElement).src, alt: el.getAttribute('alt') ?? '' })));
  const contextHash = contentHash(JSON.stringify(images.map(image => {
    const url = new URL(image.url); return { url: `${url.origin}${url.pathname}`, alt: image.alt };
  })));
  const result = { taskId, url: safeUrl(page.url()), instructions: await page.locator('.task-description__markdown').innerText(), images, contextHash, files: files.map(file => ({ ...file, hash: contentHash(file.content) })) };
  await atomicJson('.local/pending-task.json', result);
  return result;
}

export async function trainerOutcome(page: Page): Promise<'correct' | 'wrong' | 'unknown'> {
  const check = page.locator('[data-test-id="check-task-button"]');
  if (await check.count() && await check.evaluate(el => el.classList.contains('prisma-button2_progress'))) return 'unknown';
  const messages = page.locator('.trainer-footer__message.notification:not(.draggable-notification__manikin)').filter({ visible: true });
  for (let i = 0; i < await messages.count(); i++) {
    const classes = await messages.nth(i).getAttribute('class') ?? '';
    if (classes.split(/\s+/).includes('notification_type_error')) return 'wrong';
    if (classes.split(/\s+/).includes('notification_type_success')) return 'correct';
  }
  return 'unknown';
}

export interface TrainerSolution {
  taskId: string;
  lessonId: string;
  instructions?: string;
  instructionsHash?: string;
  contextHash?: string;
  files: Array<{ name: string; initialHash: string; content: string }>;
  verifiedAt: string;
  evidence: { selector: string; message: string };
}
interface AttemptFile { name: string; initialHash: string; contentHash: string }
interface TaskState { phase: 'requested' | 'accepted' | 'wrong'; solutionHash: string; updatedAt: string; files?: AttemptFile[] }

export function canReplaceTrainerFile(currentHash: string, file: TrainerSolution['files'][number], previous?: AttemptFile): boolean {
  return [file.initialHash, contentHash(file.content)].includes(currentHash) ||
    !!previous && previous.initialHash === file.initialHash && previous.contentHash === currentHash;
}

// A task is advanced only after real checker feedback or a previously accepted
// submission whose Next button is still available. Uncertain requests are observed.
export async function solveTrainer(page: Page, candidate = false): Promise<'advanced' | 'finished' | 'pending'> {
  const close = page.locator('.theory-panel__modal-close');
  if (await close.isVisible()) await close.click();
  const task = await readTrainer(page);
  if (!/^[a-f0-9-]+$/.test(task.taskId)) throw new Error('Некорректный ID задания');
  const solution = await readJson<TrainerSolution | null>(`${candidate ? '.local/task-solutions' : 'data/trainers'}/${task.taskId}.json`, null);
  if (!solution) return 'pending';
  if (solution.taskId !== task.taskId || solution.lessonId !== lessonId(task.url) || (!candidate && (!solution.verifiedAt || !solution.evidence?.message.trim())) || !solution.files.length) {
    throw new Error('Решение тренажёра не подтверждено или относится к другому заданию');
  }
  if (solution.instructions && normalize(solution.instructions) !== normalize(task.instructions)) throw new Error('Текст задания изменился: требуется повторный разбор');
  if (solution.instructionsHash && solution.instructionsHash !== contentHash(normalize(task.instructions))) throw new Error('Условие задания изменилось: требуется повторный разбор');
  if (solution.contextHash && solution.contextHash !== task.contextHash) throw new Error('Иллюстрации задания изменились: требуется повторный разбор');
  const solutionHash = contentHash(JSON.stringify(solution.files));
  const stateFile = `.local/trainers/${task.taskId}.json`;
  const state = await readJson<TaskState | null>(stateFile, null);
  const attemptFiles = solution.files.map(file => ({ name: file.name, initialHash: file.initialHash, contentHash: contentHash(file.content) }));
  const next = page.locator('[data-test-id="next-task-button"]');
  let outcome = await trainerOutcome(page);
  const accepted = state?.phase === 'accepted' && state.solutionHash === solutionHash && await next.isVisible() && await next.isEnabled();
  if (candidate && !accepted) outcome = 'unknown';
  if (!accepted && outcome !== 'correct') {
    if (state?.phase === 'wrong' && state.solutionHash === solutionHash) return 'pending';
    if (state?.phase === 'requested') {
      if (state.solutionHash !== solutionHash) throw new Error('Сначала нужно выяснить результат предыдущей отправки тренажёра');
    } else {
      const previousFiles = candidate && state?.phase === 'wrong' ? state.files ?? [] : [];
      if (previousFiles.some(previous => !solution.files.some(file => file.name === previous.name && file.initialHash === previous.initialHash))) {
        throw new Error('Повторное решение должно сохранять исходные хеши и включать все ранее изменённые файлы');
      }
      // Compare each initial file before changing anything. Unknown edits are
      // preserved in pending-task.json for investigation instead of overwritten.
      for (const file of solution.files) {
        await selectEditorFile(page, file.name);
        const matches = (await readTrainer(page)).files.filter(item => item.path.split('/').pop() === file.name);
        const current = matches.length === 1 ? matches[0] : undefined;
        if (!current || !canReplaceTrainerFile(current.hash, file, previousFiles.find(previous => previous.name === file.name))) {
          throw new Error(`Исходный файл ${file.name} изменён: нужен разбор перед применением эталона`);
        }
      }
      for (const file of solution.files) {
        const existing = task.files.filter(item => item.path.split('/').pop() === file.name);
        if (existing.length !== 1 || existing[0].hash !== contentHash(file.content)) await writeEditor(page, file.name, file.content);
      }
      const oldMessage = page.locator('.trainer-footer__message:not(.draggable-notification__manikin) .notification__close').filter({ visible: true });
      if (await oldMessage.count() === 1) await oldMessage.click();
      await atomicJson(stateFile, { phase: 'requested', solutionHash, files: attemptFiles, updatedAt: new Date().toISOString() } satisfies TaskState);
      await journal('trainer-check-requested', { taskId: task.taskId, solutionHash });
      await page.locator('[data-test-id="check-task-button"]').click();
    }
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      outcome = await trainerOutcome(page);
      if (outcome !== 'unknown') break;
      await page.waitForTimeout(1500);
    }
    if (outcome === 'unknown') return 'pending';
    if (outcome === 'wrong') {
      await atomicJson(stateFile, { phase: 'wrong', solutionHash, files: attemptFiles, updatedAt: new Date().toISOString() } satisfies TaskState);
      const feedback = await page.locator('.trainer-footer__message:not(.draggable-notification__manikin) .notification__content').filter({ visible: true }).allTextContents();
      await atomicJson('.local/trainer-review.json', { taskId: task.taskId, outcome, feedback });
      await journal('trainer-check-wrong', { taskId: task.taskId, feedback });
      return 'pending';
    }
  }
  await atomicJson(stateFile, { phase: 'accepted', solutionHash, files: attemptFiles, updatedAt: new Date().toISOString() } satisfies TaskState);
  if (candidate) {
    const evidence = await page.locator('.trainer-footer__message.notification_type_success:not(.draggable-notification__manikin) .notification__content').filter({ visible: true }).first().innerText();
    const { instructions: _instructions, ...portable } = solution;
    await atomicJson(`data/trainers/${task.taskId}.json`, { ...portable, instructionsHash: contentHash(normalize(task.instructions)), contextHash: task.contextHash, verifiedAt: new Date().toISOString(), evidence: { selector: '.trainer-footer__message.notification_type_success', message: evidence } });
  }
  await journal('trainer-accepted', { taskId: task.taskId, url: task.url });
  await next.waitFor({ state: 'visible', timeout: 30000 });
  const before = page.url();
  await next.click();
  await page.waitForURL(url => url.href !== before, { waitUntil: 'commit', timeout: 180000 });
  await settle(page);
  if (isTrainerTaskUrl(page.url())) {
    await page.waitForFunction(previous => {
      const nextText = document.querySelector('.task-description__markdown')?.textContent?.normalize('NFKC').replace(/\s+/g, ' ').trim();
      return !!nextText && nextText !== previous;
    }, normalize(task.instructions), { timeout: 180000 });
  }
  return isTrainerTaskUrl(page.url()) && lessonId(page.url()) === solution.lessonId ? 'advanced' : 'finished';
}

export async function writeEditor(page: Page, name: string, content: string): Promise<void> {
  const theoryClose = page.locator('.theory-panel__modal-close');
  if (await theoryClose.isVisible()) await theoryClose.click();
  await selectEditorFile(page, name);
  const editor = page.getByRole('textbox', { name: 'Содержимое редактора', exact: true }).filter({ visible: true }).first();
  // Monaco draws text above its textarea; focus it before sending real keyboard input.
  await editor.focus();
  await editor.press('ControlOrMeta+A');
  // Use the editor's paste command: typing a multiline string adds indentation.
  // This only edits source; the platform checker still runs through its UI.
  await page.evaluate(text => {
    const active = (window as MonacoWindow).monaco?.editor.getEditors().find(item => item.hasTextFocus());
    if (!active) throw new Error('Не найден активный редактор Monaco');
    active.trigger('keyboard', 'paste', { text, pasteOnNewLine: false, multicursorText: null });
  }, content);
  const files = await page.evaluate(() => (window as MonacoWindow).monaco?.editor.getModels().map(model => ({ path: model.uri.path, value: model.getValue() })) ?? []);
  const matches = files.filter(file => file.path.split('/').pop() === name);
  const match = matches.length === 1 ? matches[0] : undefined;
  if (!match || contentHash(match.value) !== contentHash(content)) throw new Error('Содержимое редактора после ввода не совпало с решением');
}
