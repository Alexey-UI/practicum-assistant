import { openBrowser, START_URL, snapshot, navigate } from './browser.js';
import { createInterface } from 'node:readline/promises';

const command = process.argv[2] ?? 'help';
async function main(): Promise<void> {
  if (command === 'help') {
    console.log('Команды: login, inspect, explore, run, projects, status'); return;
  }
  if (command === 'login' || command === 'inspect') {
    const context = await openBrowser(command !== 'login' && !process.argv.includes('--headed'));
    try {
      const page = context.pages()[0] ?? await context.newPage();
      await navigate(page, START_URL);
      if (command === 'login') {
        console.log('Войди в Практикум в открытом Chrome. Затем нажми Enter здесь. Сессия останется только в .local/browser.');
        const terminal = createInterface({ input: process.stdin, output: process.stdout });
        try { await terminal.question('После входа нажми Enter: '); } finally { terminal.close(); }
        await navigate(page, START_URL);
        await page.getByRole('heading', { name: 'Программа курса', exact: true }).waitFor({ timeout: 180000 });
      }
      console.log(`Снимок интерфейса: ${await snapshot(page, command)}`);
    } finally { await context.close(); }
    return;
  }
  if (command === 'run') {
    const { run } = await import('./runner.js'); await run(); return;
  }
  if (command === 'explore') {
    const { explore } = await import('./explore.js'); await explore(); return;
  }
  if (command === 'projects') {
    const { projectCommand } = await import('./projects.js'); await projectCommand(process.argv.slice(3)); return;
  }
  if (command === 'status') {
    const { status } = await import('./status.js'); await status(); return;
  }
  throw new Error(`Неизвестная команда: ${command}`);
}
main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
