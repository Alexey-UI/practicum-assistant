import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, appendFile, open, rm } from 'node:fs/promises';
import path from 'node:path';

export function normalize(text: string): string { return text.normalize('NFKC').replace(/\s+/g, ' ').trim(); }
export interface Question { prompt: string; options: string[]; multiple: boolean; context?: string[] }
export function questionKey(q: Question): string {
  return createHash('sha256').update(JSON.stringify({
    prompt: normalize(q.prompt), multiple: q.multiple, context: q.context ?? [],
    options: q.options.map(normalize).sort(),
  })).digest('hex');
}
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}
export class Answers {
  private file: string;
  private bundled?: string;
  constructor(file?: string, bundled?: string) {
    this.file = file ?? path.resolve('.local/answers.json');
    this.bundled = bundled ?? (file ? undefined : path.resolve('data/answers.json'));
  }
  async get(q: Question): Promise<string[] | undefined> {
    type Entry = { answers: string[]; evidence: string; confirmedAt: string };
    const saved = await readJson<Record<string, Entry>>(this.file, {});
    const bundled = this.bundled ? await readJson<Record<string, Entry>>(this.bundled, {}) : {};
    const entry = saved[questionKey(q)] ?? bundled[questionKey(q)];
    if (!entry) return undefined;
    if (!entry.evidence?.trim() || !entry.confirmedAt || !entry.answers?.length || entry.answers.some(answer => !q.options.map(normalize).includes(normalize(answer))) || (!q.multiple && entry.answers.length !== 1)) throw new Error('В базе найден неподтверждённый или изменённый ответ');
    return entry.answers.map(normalize);
  }
  async confirm(q: Question, answers: string[], evidence: string): Promise<void> {
    if (!evidence.trim()) throw new Error('Нет подтверждения правильности ответа');
    const known = q.options.map(normalize);
    if (!answers.length || answers.some(a => !known.includes(normalize(a)))) throw new Error('Ответа нет в вариантах вопроса');
    if (!q.multiple && answers.length !== 1) throw new Error('Для одиночного выбора нужен один ответ');
    const saved = await readJson<Record<string, unknown>>(this.file, {});
    saved[questionKey(q)] = { question: q, answers: answers.map(normalize), evidence, confirmedAt: new Date().toISOString() };
    await atomicJson(this.file, saved);
  }
}

export async function exportAnswers(): Promise<void> {
  const local = await readJson<Record<string, { question: Question; answers: string[]; evidence: string; confirmedAt: string }>>('.local/answers.json', {});
  const bundled = await readJson<Record<string, unknown>>('data/answers.json', {});
  for (const [key, entry] of Object.entries(local)) {
    if (!entry.question || key !== questionKey(entry.question) || !entry.evidence?.trim() || !entry.confirmedAt || !entry.answers.length || entry.answers.some(answer => !entry.question.options.map(normalize).includes(normalize(answer))) || (!entry.question.multiple && entry.answers.length !== 1)) throw new Error('Нельзя экспортировать неподтверждённый ответ');
    // Bundle only hashes and accepted options, without lesson text or account URLs.
    bundled[key] = { answers: entry.answers, evidence: entry.evidence, confirmedAt: entry.confirmedAt };
  }
  await atomicJson('data/answers.json', bundled);
  console.log(`Экспортировано подтверждённых ответов: ${Object.keys(bundled).length}`);
}
export async function journal(event: string, details: Record<string, unknown> = {}): Promise<void> {
  await mkdir('.local', { recursive: true, mode: 0o700 });
  await appendFile('.local/events.jsonl', `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`, { mode: 0o600 });
}
export async function lockRun(): Promise<() => Promise<void>> {
  await mkdir('.local', { recursive: true, mode: 0o700 });
  const file = '.local/run.lock';
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Другой запуск уже работает либо остался .local/run.lock после аварии. Проверь процесс перед удалением файла.');
    throw error;
  }
  await handle.writeFile(String(process.pid));
  return async () => { await handle.close(); await rm(file); };
}
