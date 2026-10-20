import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { atomicJson, readJson } from './store.js';
import { loadConfig } from './config.js';

const exec = promisify(execFile);
const source = 'Alexey-UI/practicum-frontend-solutions';

export async function setup(): Promise<void> {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Требуется Node.js 22.18 или новее');
  await exec('git', ['--version']);
  await exec('gh', ['--version']);
  let login: string;
  try { login = (await exec('gh', ['api', 'user', '--jq', '.login'], { timeout: 90000 })).stdout.trim(); }
  catch { throw new Error('Сначала войдите в свой GitHub: gh auth login. Затем повторите npm run setup.'); }
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login)) throw new Error('Не удалось определить GitHub-аккаунт');
  const cfg = await loadConfig();
  if (cfg.githubOwner && cfg.githubOwner.toLowerCase() !== login.toLowerCase()) throw new Error('Настроенный githubOwner отличается от аккаунта gh. Сверьте practicum.config.json.');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  await browser.close();
  const dir = path.resolve('solutions');
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(dir) !== dir) throw new Error('solutions должна быть обычной папкой проекта');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await exec('gh', ['repo', 'clone', source, dir], { timeout: 180000 });
  }
  const remote = (await exec('git', ['remote', 'get-url', 'origin'], { cwd: dir })).stdout.trim();
  if (![`https://github.com/${source}`, `https://github.com/${source}.git`, `git@github.com:${source}.git`].includes(remote)) throw new Error('solutions ссылается на другой источник; существующие файлы сохранены');
  const manifest = await readJson<{ version: number; projects: unknown[] } | null>('solutions/projects.json', null);
  if (manifest?.version !== 1 || !manifest.projects?.length) throw new Error('В solutions нет манифеста эталонов');
  const custom = await readJson<Record<string, unknown>>('practicum.config.json', {});
  await atomicJson('practicum.config.json', { feedbackPolicy: 'neutral', ...custom, githubOwner: login });
  console.log(`Готово: Chrome, Git, gh и библиотека эталонов доступны. Аккаунт GitHub: ${login}.`);
  console.log('Далее: npm run login, затем npm start. Вход в Практикум выполняется вручную в отдельном профиле Chrome.');
}
