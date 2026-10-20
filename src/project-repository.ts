import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { Project } from './projects.js';

const exec = promisify(execFile);
type GitHub = (args: string[]) => Promise<{ stdout: string }>;
const github: GitHub = args => exec('gh', args, { timeout: 180000 });
const isAbsent = (error: unknown) => typeof (error as { stdout?: unknown })?.stdout === 'string'
  && /^HTTP\/[\d.]+ 404(?:\s|$)/m.test((error as { stdout: string }).stdout);

/** Platform repositories must keep the scaffold created by Practicum. */
export async function ensureManualRepository(project: Pick<Project, 'destination' | 'review'>, login: string, gh: GitHub = github): Promise<void> {
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-zA-Z0-9_.-]+$/i.test(project.destination)
    || project.destination.split('/')[0].toLowerCase() !== login.toLowerCase()) throw new Error('Новый репозиторий должен принадлежать аккаунту gh');
  if (project.review !== 'teacher' && project.review !== 'self') return;
  const endpoint = `repos/${project.destination}`;
  try {
    await gh(['api', endpoint, '--silent', '--include']);
    return;
  } catch (error) {
    // Authentication failures, rate limits and network errors are not absence.
    if (!isAbsent(error)) throw error;
  }
  // This is the only create request. After a lost response the next run reads
  // the repository first; a failed creation is never retried in this call.
  await gh(['repo', 'create', project.destination, '--public', '--add-readme']);
  const branch = (await gh(['api', endpoint, '--jq', '.default_branch'])).stdout.trim();
  if (!branch) throw new Error('Не удалось определить ветку нового репозитория');
  if (branch !== 'main') {
    // Rename only the repository just created here, never an existing project.
    await gh(['api', `${endpoint}/branches/${encodeURIComponent(branch)}/rename`, '--method', 'POST', '-f', 'new_name=main', '--silent']);
  }
  // GitHub documents branch renames as asynchronous. Poll reads, never rename again.
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await gh(['api', endpoint, '--jq', '.default_branch'])).stdout.trim() === 'main') {
      try { await gh(['api', `${endpoint}/branches/main`, '--silent']); return; }
      catch (error) { if (!isAbsent(error)) throw error; }
    }
    await delay(2000);
  }
  throw new Error('Ветка нового репозитория main ещё не готова; состояние можно проверить на GitHub');
}
