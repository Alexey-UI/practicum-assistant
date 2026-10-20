import { createInterface } from 'node:readline';
import { openBrowser, START_URL, snapshot, settle, allowedUrl, safeUrl, navigate, isTrainerTaskUrl } from './browser.js';
import { lockRun } from './store.js';

// A local terminal bridge for inspecting the authenticated UI without remote debugging ports.
export async function explore(): Promise<void> {
  const unlock = await lockRun();
  let stopping = false;
  let context: Awaited<ReturnType<typeof openBrowser>> | undefined;
  const stop = () => { stopping = true; void context?.close().catch(() => {}); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
  context = await openBrowser(!process.argv.includes('--headed'));
  const page = context.pages()[0] ?? await context.newPage();
  const network: Array<{ url: string; status?: number; failure?: string }> = [];
  page.on('response', response => {
    if (['document', 'fetch', 'xhr', 'script'].includes(response.request().resourceType())) network.push({ url: safeUrl(response.url()), status: response.status() });
    if (network.length > 100) network.shift();
  });
  page.on('requestfailed', request => {
    network.push({ url: safeUrl(request.url()), failure: request.failure()?.errorText });
    if (network.length > 100) network.shift();
  });
  const terminal = createInterface({ input: process.stdin });
  try {
    const flag = process.argv.indexOf('--url');
    await navigate(page, flag >= 0 ? process.argv[flag + 1] : START_URL);
    if (process.stdin.destroyed || process.stdin.readableEnded) return;
    console.log('Браузер готов. JSON: {"action":"snapshot"}, {"action":"click","role":"button","name":"..."}, {"action":"goto","url":"..."}, {"action":"close"}');
    for await (const line of terminal) {
      if (!line.trim()) continue;
      try {
        const action = JSON.parse(line);
        if (action.action === 'close') break;
        if (action.action === 'inline') {
          const { inlineCommand } = await import(`./inline.js?inspect=${Date.now()}`) as typeof import('./inline.js');
          console.log(JSON.stringify(await inlineCommand(page, action))); continue;
        }
        if (action.action === 'inline-read' || action.action === 'inline-apply' || action.action === 'inline-check') {
          const { readInline, applyInline, requestInlineCheck } = await import(`./inline.js?inspect=${Date.now()}`) as typeof import('./inline.js');
          const index = action.index ?? 0;
          if (action.action === 'inline-check') {
            await requestInlineCheck(page, index); console.log('Проверка запрошена, результат ещё не подтверждён.'); continue;
          }
          const task = await (action.action === 'inline-read' ? readInline(page, index) : applyInline(page, index));
          console.log(JSON.stringify({ id: task.id, saved: '.local/pending-inline.json', files: task.files.map(file => ({ name: file.name, hash: file.hash })) })); continue;
        }
        if (action.action === 'frame-dom') {
          const index = action.index ?? 0;
          const embeds = page.locator('.theory-viewer iframe');
          if (!Number.isInteger(index) || index < 0 || index >= await embeds.count()) throw new Error('Неверный номер встроенного примера');
          const frame = await (await embeds.nth(index).elementHandle())?.contentFrame();
          if (!frame || new URL(frame.url()).origin !== 'https://sandbox.practicum-team.ru' || !new URL(frame.url()).pathname.startsWith('/tasks/')) throw new Error('Ожидался учебный sandbox Практикума');
          const { atomicJson } = await import('./store.js');
          const data = { url: safeUrl(frame.url()), text: await frame.locator('body').innerText(), html: await frame.locator('body').innerHTML(), aria: await frame.locator('body').ariaSnapshot() };
          await atomicJson('.local/inline-inspect.json', data);
          console.log(JSON.stringify({ saved: '.local/inline-inspect.json', url: data.url, html: await frame.locator(action.css ?? 'body').evaluateAll(elements => elements.map(el => el.outerHTML)) }).slice(0, 20000)); continue;
        }
        if (action.action === 'text-question') {
          const { solveTextQuestion } = await import(`./text-quiz.js?inspect=${Date.now()}`) as typeof import('./text-quiz.js');
          console.log(JSON.stringify({ solved: await solveTextQuestion(page, page.locator('.quiz_type_text')) })); continue;
        }
        if (action.action === 'network') { console.log(JSON.stringify(network)); continue; }
        if (action.action === 'check-candidate' || action.action === 'solve-task') {
          const { solveTrainer, readTrainer } = await import(`./trainer.js?inspect=${Date.now()}`) as typeof import('./trainer.js');
          const result = await solveTrainer(page, action.action === 'check-candidate');
          console.log(JSON.stringify({ trainer: result, url: safeUrl(page.url()) }));
          if (isTrainerTaskUrl(page.url())) {
            const task = await readTrainer(page);
            console.log(JSON.stringify({ taskId: task.taskId, files: task.files.map(file => ({ path: file.path, hash: file.hash })), saved: '.local/pending-task.json' }));
          }
          continue;
        }
        if (action.action === 'trainer') {
          const { readTrainer } = await import('./trainer.js');
          const task = await readTrainer(page);
          console.log(JSON.stringify({ taskId: task.taskId, files: task.files.map(file => ({ path: file.path, hash: file.hash })), saved: '.local/pending-task.json' })); continue;
        }
        if (action.action === 'apply-task') {
          const { readJson } = await import('./store.js');
          const { writeEditor } = await import('./trainer.js');
          const taskId = new URL(page.url()).pathname.match(/\/task\/([^/]+)\//)?.[1];
          if (!taskId || !/^[a-f0-9-]+$/.test(taskId)) throw new Error('Не определён ID текущего задания');
          const saved = await readJson<{ files: Array<{ name: string; content: string }> } | null>(`.local/task-solutions/${taskId}.json`, null);
          if (!saved) throw new Error('Решение задания не найдено');
          for (const file of saved.files) await writeEditor(page, file.name, file.content);
          console.log('Код введён через редактор. Проверка ещё не запускалась.'); continue;
        }
        if (action.action === 'status') {
          console.log(JSON.stringify({ url: safeUrl(page.url()), title: await page.title(), state: await page.evaluate(() => document.readyState) })); continue;
        }
        if (action.action === 'goto') {
          if (!allowedUrl(action.url)) throw new Error('Разрешён только practicum.yandex.ru');
          await navigate(page, action.url);
        } else if (action.action === 'click') {
          const target = action.css ? page.locator(action.css) : page.getByRole(action.role ?? 'button', { name: action.name, exact: true });
          const count = await target.count();
          if (count !== 1) throw new Error(`Найдено элементов: ${count}; нужен один точный селектор`);
          await target.click({ noWaitAfter: true });
        } else if (action.action === 'fill') {
          const field = action.css ? page.locator(action.css) : page.getByLabel(action.label, { exact: true });
          if (await field.count() !== 1) throw new Error('Поле ввода не найдено или неоднозначно');
          await field.fill(action.value);
        } else if (action.action === 'wait') {
          await page.locator(action.css ?? 'h1').filter({ hasText: /\S/, visible: true }).first().waitFor({ timeout: 180000 });
        } else if (action.action === 'scroll') {
          await page.mouse.wheel(0, Number(action.pixels) || 700);
        } else if (action.action === 'dom') {
          const data = await page.locator(action.css ?? 'body').evaluateAll(elements => elements.map(el => el.outerHTML));
          console.log(JSON.stringify(data).slice(0, 30000)); continue;
        } else if (action.action !== 'snapshot') throw new Error('Неизвестное действие');
        await settle(page);
        console.log(JSON.stringify({ url: safeUrl(page.url()), snapshot: await snapshot(page, 'explore') }));
      } catch (error) { console.error((error as Error).message); }
    }
  } finally { terminal.close(); await context.close(); }
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try { await context?.close(); } finally { await unlock(); }
  }
}
