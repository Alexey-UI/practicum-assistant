import { rename, writeFile } from 'node:fs/promises';
import type { Lesson } from './catalog.js';
import { lessonUrl, safeUrl } from './browser.js';
import { atomicJson, readJson } from './store.js';

export type Disposition = 'not-visited' | 'in-progress' | 'already-solved' | 'verified' | 'audited' | 'deferred' | 'unavailable' | 'locked' | 'manual';
interface Entry { url: string; title: string; course: string; disposition: Disposition; reason?: string; artifacts?: string; observedUrl?: string }
export interface UnresolvedLesson { reason: string; observedAt: string; artifacts: string; observedUrl: string }
const labels: Record<Disposition, string> = {
  'not-visited': 'Не обработано', 'in-progress': 'Обработка прервана или ещё идёт', 'already-solved': 'Ранее отмечено платформой', verified: 'Завершение подтверждено',
  audited: 'Встроенные упражнения проверены', deferred: 'Требует разбора', unavailable: 'Не загрузилось', locked: 'Закрыто платформой', manual: 'Черновик сдачи',
};
const plain = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]<>]/g, '\\$&');

/** A traversal report is separate from platform completion and exercise receipts. */
export class RunReport {
  private startedAt = new Date().toISOString();
  private entries: Entry[];
  constructor(lessons: Lesson[]) {
    this.entries = lessons.map(({ url, title, course }) => ({ url: lessonUrl(url), title, course, disposition: 'not-visited' }));
  }
  async begin(lesson: Lesson): Promise<void> {
    const url = lessonUrl(lesson.url);
    const unresolved = await readJson<Record<string, UnresolvedLesson>>('.local/unresolved-lessons.json', {});
    unresolved[url] ??= { reason: 'Завершение открытого урока ещё не подтверждено', artifacts: '', observedUrl: safeUrl(lesson.url), observedAt: new Date().toISOString() };
    await atomicJson('.local/unresolved-lessons.json', unresolved);
    await this.record(lesson, 'in-progress');
  }
  async record(lesson: Lesson, disposition: Disposition, details: Partial<Pick<Entry, 'reason' | 'artifacts' | 'observedUrl'>> = {}): Promise<void> {
    const url = lessonUrl(lesson.url);
    const entry = this.entries.find(item => item.url === url);
    if (!entry) throw new Error('Урок отсутствует в отчёте текущего обхода');
    Object.assign(entry, { disposition, reason: undefined, artifacts: undefined, observedUrl: undefined, ...details });
    if (disposition === 'verified') {
      const unresolved = await readJson<Record<string, UnresolvedLesson>>('.local/unresolved-lessons.json', {});
      delete unresolved[url];
      await atomicJson('.local/unresolved-lessons.json', unresolved);
    }
    await this.save('running');
  }
  async defer(lesson: Lesson, reason: string, artifacts: string, observedUrl: string): Promise<void> {
    const unresolved = await readJson<Record<string, UnresolvedLesson>>('.local/unresolved-lessons.json', {});
    unresolved[lessonUrl(lesson.url)] = { reason, artifacts, observedUrl: safeUrl(observedUrl), observedAt: new Date().toISOString() };
    await atomicJson('.local/unresolved-lessons.json', unresolved);
    await this.record(lesson, 'deferred', { reason, artifacts, observedUrl: safeUrl(observedUrl) });
  }
  async save(outcome: 'running' | 'completed' | 'stopped' | 'failed'): Promise<void> {
    const counts = Object.fromEntries(Object.keys(labels).map(key => [key, this.entries.filter(entry => entry.disposition === key).length]));
    const gaps = this.entries.filter(entry => ['not-visited', 'in-progress', 'deferred', 'unavailable', 'locked', 'manual'].includes(entry.disposition));
    const report = { version: 1, startedAt: this.startedAt, updatedAt: new Date().toISOString(), outcome, hasGaps: gaps.length > 0, counts, lessons: this.entries };
    await atomicJson('.local/run-report.json', report);
    const text = ['# Отчёт последнего запуска', '', `Состояние обхода: ${outcome}.`,
      'Отчёт описывает действия программы. Отметка чтения, приёмка упражнения и ревью проекта — разные результаты.', '',
      ...Object.entries(counts).filter(([, count]) => count).map(([key, count]) => `- ${labels[key as Disposition]}: ${count}`), '',
      '## Требуют внимания', '', ...(gaps.length ? gaps.map(entry => `- ${labels[entry.disposition]}: [${plain(entry.title)}](${entry.url})${entry.reason ? ` — ${plain(entry.reason)}` : ''}${entry.observedUrl && entry.observedUrl !== entry.url ? ` ([страница задания](${entry.observedUrl}))` : ''}`) : ['Пропусков в этом обходе нет. Ранее отмеченные уроки повторно не проверялись.']), '',
      'Подробности всех уроков: `.local/run-report.json`. Диагностика и сессия остаются на этом компьютере.', ''].join('\n');
    await writeFile('.local/run-report.md.tmp', text, { mode: 0o600 });
    await rename('.local/run-report.md.tmp', '.local/run-report.md');
  }
}
