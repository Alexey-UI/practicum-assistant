import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { atomicJson, readJson } from './store.js';

const exec = promisify(execFile);
export interface Project {
  id: string;
  title: string;
  lessonUrl: string;
  source: string;
  sourcePath: string;
  destination: string;
  commit: string;
  pages?: boolean;
  review?: 'platform' | 'teacher' | 'self';
  deploy?: 'gh-pages';
  removeFiles?: string[];
  verification?: 'local' | 'mock-api';
  checks: Array<{ program: 'npm' | 'node'; args: string[] }>;
}
interface Manifest { version: 1; projects: Project[] }
const FILE = 'solutions/projects.json';
const REPO = /^Alexey-UI\/[a-zA-Z0-9_.-]+$/;

export function safeRelative(file: string): boolean {
  return !!file && !path.isAbsolute(file) && !file.includes('\\') && file.split('/').every(part =>
    part !== '' && part !== '.' && part !== '..' && !['.git', '.github', '.local', 'node_modules'].includes(part) && !part.startsWith('.env'));
}
interface Prepared { commit: string; destination: string; files: Record<string, string>; removed?: string[]; verifiedAt?: string }
const targetDirectory = (project: Project) => path.resolve('workspaces', project.id);
const recordFile = (project: Project) => `.local/projects/${project.id}.json`;
async function digest(file: string): Promise<string> { return createHash('sha256').update(await readFile(file)).digest('hex'); }

export async function loadProjects(): Promise<Project[]> {
  const manifest = await readJson<Manifest>(FILE, { version: 1, projects: [] });
  if (manifest.version !== 1 || !Array.isArray(manifest.projects)) throw new Error('Неверный формат манифеста проектов');
  const ids = new Set();
  for (const item of manifest.projects) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.id) || ids.has(item.id)) throw new Error('Некорректный или повторный id проекта');
    ids.add(item.id);
    if (!REPO.test(item.source) || !REPO.test(item.destination) || !/^[a-f0-9]{40}$/.test(item.commit)) throw new Error('Нужны репозитории Alexey-UI и полный SHA проверенного коммита');
    if (item.pages !== undefined && typeof item.pages !== 'boolean') throw new Error('Некорректная настройка GitHub Pages');
    if (item.review !== undefined && !['platform', 'teacher', 'self'].includes(item.review)) throw new Error('Некорректный способ приёмки проекта');
    if (item.deploy !== undefined && (item.deploy !== 'gh-pages' || !item.pages)) throw new Error('Деплой gh-pages требует pages: true');
    if (item.verification !== undefined && !['local', 'mock-api'].includes(item.verification)) throw new Error('Некорректный вид проверки эталона');
    if (item.removeFiles !== undefined && (!Array.isArray(item.removeFiles) || !item.removeFiles.every(safeRelative) || new Set(item.removeFiles).size !== item.removeFiles.length)) throw new Error('Некорректные пути удаления в эталоне');
    if (!safeRelative(item.sourcePath)) throw new Error('Некорректная папка эталона');
    if (!Array.isArray(item.checks) || item.checks.length === 0) throw new Error('Для эталона нужны команды проверки');
    for (const check of item.checks) {
      if (!['npm', 'node'].includes(check.program) || !Array.isArray(check.args) || !check.args.every(x => typeof x === 'string')) throw new Error('Некорректная команда проверки');
    }
  }
  return manifest.projects;
}

async function clone(repo: string, dir: string): Promise<void> {
  await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(dir) !== dir) throw new Error('Workspace не должен находиться за символической ссылкой');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await exec('gh', ['repo', 'clone', repo, dir], { timeout: 180000 });
  }
  const { stdout: remote } = await exec('git', ['remote', 'get-url', 'origin'], { cwd: dir });
  if (![ `https://github.com/${repo}.git`, `https://github.com/${repo}`, `git@github.com:${repo}.git` ].includes(remote.trim())) throw new Error('Origin workspace не совпадает с репозиторием проекта');
}

async function assertPrepared(project: Project): Promise<Prepared> {
  const saved = await readJson<Prepared | null>(recordFile(project), null);
  if (!saved || saved.commit !== project.commit || saved.destination !== project.destination) throw new Error('Сначала выполни prepare для текущего эталона');
  for (const [file, hash] of Object.entries(saved.files)) {
    if (!safeRelative(file) || await digest(path.join(targetDirectory(project), file)) !== hash) throw new Error('Файлы изменились после prepare: сначала пересмотри изменения');
  }
  if (JSON.stringify(saved.removed ?? []) !== JSON.stringify(project.removeFiles ?? [])) throw new Error('Список удалений изменился: нужен новый prepare');
  for (const file of saved.removed ?? []) {
    try { await lstat(path.join(targetDirectory(project), file)); throw new Error('Удалённый файл появился снова'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return saved;
}

async function prepare(project: Project): Promise<void> {
  const reference = path.resolve('.local/references', project.id);
  await clone(project.source, reference);
  const { stdout: dirtyRef } = await exec('git', ['status', '--porcelain'], { cwd: reference });
  if (dirtyRef.trim()) throw new Error('В копии эталона есть локальные изменения');
  await exec('git', ['fetch', 'origin', project.commit], { cwd: reference, timeout: 180000 });
  await exec('git', ['switch', '--detach', project.commit], { cwd: reference });
  const target = targetDirectory(project);
  await clone(project.destination, target);
  const { stdout: branch } = await exec('git', ['branch', '--show-current'], { cwd: target });
  if (branch.trim() !== 'main') throw new Error('Для prepare требуется ветка main; другие ветки не изменяются');
  const { stdout: dirty } = await exec('git', ['status', '--porcelain'], { cwd: target });
  if (dirty.trim()) throw new Error('В проекте есть незакоммиченные изменения. Сначала сохрани их.');
  const { stdout } = await exec('git', ['ls-files', '-z', '--', project.sourcePath], { cwd: reference });
  const files: Record<string, string> = {};
  for (const tracked of stdout.split('\0').filter(Boolean)) {
    const relative = path.posix.relative(project.sourcePath, tracked);
    if (!safeRelative(relative)) throw new Error('Эталон содержит запрещённый путь');
    const source = path.join(reference, tracked);
    if ((await lstat(source)).isSymbolicLink() || await realpath(source) !== source) throw new Error('Символические ссылки в эталоне не поддерживаются');
    const output = path.join(target, relative);
    await mkdir(path.dirname(output), { recursive: true });
    if (await realpath(path.dirname(output)) !== path.dirname(output)) throw new Error('Символическая ссылка в папке назначения');
    try { if ((await lstat(output)).isSymbolicLink()) throw new Error('Символическая ссылка вместо файла'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await copyFile(source, output);
    files[relative] = await digest(output);
  }
  if (!files['index.html'] || !files['README.md']) throw new Error('В эталоне должны быть index.html и README.md');
  for (const file of project.removeFiles ?? []) {
    if (file in files) throw new Error('Файл одновременно добавляется и удаляется');
    const full = path.join(target, file);
    try {
      const info = await lstat(full);
      if (!info.isFile() || info.isSymbolicLink() || await realpath(full) !== full) throw new Error('Удалять можно только обычный файл внутри workspace');
      await exec('git', ['ls-files', '--error-unmatch', '--', file], { cwd: target });
      await unlink(full);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await atomicJson(recordFile(project), { commit: project.commit, destination: project.destination, files, removed: project.removeFiles ?? [] });
  console.log(`Подготовлено: ${target}; служебные файлы Git и GitHub Actions сохранены.`);
}

// Official API: https://docs.github.com/en/rest/pages/pages#create-a-github-pages-site
async function ensurePages(project: Project): Promise<void> {
  if (!project.pages) return;
  const branch = project.deploy === 'gh-pages' ? 'gh-pages' : 'main';
  const endpoint = `repos/${project.destination}/pages`;
  let site: { source?: { branch: string; path: string }; html_url: string };
  try {
    const { stdout } = await exec('gh', ['api', endpoint], { timeout: 90000 });
    site = JSON.parse(stdout);
  } catch (error) {
    if (!/HTTP 404/.test((error as { stderr?: string }).stderr ?? '')) throw error;
    // A lost response is resolved by the GET on the next run, not a blind POST retry.
    const { stdout } = await exec('gh', ['api', '--method', 'POST', endpoint, '-f', 'build_type=legacy', '-f', `source[branch]=${branch}`, '-f', 'source[path]=/'], { timeout: 90000 });
    site = JSON.parse(stdout);
  }
  if (site.source?.branch !== branch || site.source.path !== '/') throw new Error(`Настройки GitHub Pages отличаются от ${branch}:/; нужен разбор перед изменением`);
  const expected = `https://alexey-ui.github.io/${project.destination.split('/')[1]}/`;
  if (site.html_url?.toLowerCase() !== expected.toLowerCase()) throw new Error('Адрес сайта GitHub Pages отличается от ожидаемого');
  console.log(`GitHub Pages настроен: ${site.html_url}`);
}

async function publish(project: Project): Promise<void> {
  const saved = await assertPrepared(project);
  if (!saved.verifiedAt) throw new Error('Сначала выполни verify');
  const cwd = targetDirectory(project);
  const removed = new Set(saved.removed ?? []);
  const { stdout: branch } = await exec('git', ['branch', '--show-current'], { cwd });
  if (branch.trim() !== 'main') throw new Error('Поддерживается только ветка main');
  for (const args of [['diff', '--name-only', '-z'], ['diff', '--cached', '--name-only', '-z'], ['ls-files', '--others', '--exclude-standard', '-z']]) {
    const { stdout } = await exec('git', args, { cwd });
    if (stdout.split('\0').filter(Boolean).some(file => !(file in saved.files) && !removed.has(file))) throw new Error('Найдены изменения за пределами эталона');
  }
  const { stdout: tracked } = await exec('git', ['ls-files', '-z'], { cwd });
  const trackedFiles = tracked.split('\0').filter(Boolean);
  if (trackedFiles.some(file => !(file in saved.files) && !removed.has(file) && !file.startsWith('.github/'))) throw new Error('В репозитории есть дополнительные файлы вне эталона: требуется разбор перед публикацией');
  await exec('git', ['add', '--', ...Object.keys(saved.files), ...trackedFiles.filter(file => removed.has(file))], { cwd });
  const { stdout: staged } = await exec('git', ['diff', '--cached', '--name-only'], { cwd });
  const { stdout: identity } = await exec('gh', ['api', 'user', '--jq', '{login: .login, id: .id}']);
  const user = JSON.parse(identity);
  if (user.login !== 'Alexey-UI' || !Number.isInteger(user.id)) throw new Error('GitHub CLI авторизован другим аккаунтом');
  const email = `${user.id}+${user.login}@users.noreply.github.com`;
  if (staged.trim()) {
    await exec('git', ['-c', `user.name=${user.login}`, '-c', `user.email=${email}`, 'commit', '-m', `Apply verified reference: ${project.id}`], { cwd });
  }
  const { stdout: visibility } = await exec('gh', ['api', `repos/${project.destination}`, '--jq', '.private']);
  if (visibility.trim() === 'true') await exec('gh', ['repo', 'edit', project.destination, '--visibility', 'public', '--accept-visibility-change-consequences'], { timeout: 180000 });
  else if (visibility.trim() !== 'false') throw new Error('Не удалось проверить публичность репозитория');
  await exec('git', ['push', 'origin', 'main'], { cwd, timeout: 180000 });
  if (project.deploy === 'gh-pages') {
    await exec('npm', ['run', 'deploy'], { cwd, timeout: 180000, env: { ...process.env, GIT_AUTHOR_NAME: user.login, GIT_COMMITTER_NAME: user.login, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } });
  }
  await ensurePages(project);
  const { stdout: sha } = await exec('git', ['rev-parse', 'HEAD'], { cwd });
  await atomicJson(`.local/projects/${project.id}.published.json`, { ...saved, destinationCommit: sha.trim(), publishedAt: new Date().toISOString() });
  console.log(`Опубликовано: https://github.com/${project.destination}/commit/${sha.trim()}`);
}

export async function projectCommand(args: string[]): Promise<void> {
  const projects = await loadProjects();
  if (!args.length || args[0] === 'list') {
    console.log(projects.length ? projects.map(p => `${p.id}: ${p.title}`).join('\n') : 'Проверенных эталонов пока нет. Сначала изучаем требования проектных работ в курсе.'); return;
  }
  const project = projects.find(p => p.id === args[1]);
  if (!project) throw new Error('Неизвестный id проекта');
  if (args[0] === 'draft') {
    const { prepareManualProject } = await import('./submission.js');
    await prepareManualProject(project); return;
  }
  if (args[0] === 'prepare') {
    await prepare(project); return;
  }
  if (args[0] === 'publish') { await publish(project); return; }
  if (args[0] !== 'verify') throw new Error('Команды проектов: list, prepare <id>, verify <id>, publish <id>, draft <id>');
  const saved = await assertPrepared(project);
  const dir = targetDirectory(project);
  const results = [];
  for (const check of project.checks) {
    console.log(`Проверка ${check.program} ${check.args.join(' ')}`);
    // Manifest commands are reviewed code, run without shell string interpolation.
    await exec(check.program, check.args, { cwd: dir, timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
    results.push(check);
  }
  await atomicJson(recordFile(project), { ...saved, checks: results, verifiedAt: new Date().toISOString() });
  console.log(`Проверки прошли: ${project.title}`);
}
