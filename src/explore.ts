import { createInterface } from 'node:readline';
import { openBrowser, START_URL, snapshot, settle, allowedUrl, safeUrl, navigate } from './browser.js';

// A local terminal bridge for inspecting the authenticated UI without remote debugging ports.
export async function explore(): Promise<void> {
  const context = await openBrowser(!process.argv.includes('--headed'));
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
    console.log('Браузер готов. JSON: {"action":"snapshot"}, {"action":"click","role":"button","name":"..."}, {"action":"goto","url":"..."}, {"action":"close"}');
    for await (const line of terminal) {
      if (!line.trim()) continue;
      try {
        const action = JSON.parse(line);
        if (action.action === 'close') break;
        if (action.action === 'network') { console.log(JSON.stringify(network)); continue; }
        if (action.action === 'check-candidate' || action.action === 'solve-task') {
          const { solveTrainer, readTrainer } = await import(`./trainer.js?inspect=${Date.now()}`) as typeof import('./trainer.js');
          const result = await solveTrainer(page, action.action === 'check-candidate');
          console.log(JSON.stringify({ trainer: result, url: safeUrl(page.url()) }));
          if (new URL(page.url()).pathname.startsWith('/trainer/')) {
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
          await page.getByLabel(action.label, { exact: true }).fill(action.value);
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
}
