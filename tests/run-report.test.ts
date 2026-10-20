import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunReport } from '../src/run-report.js';
import { readJson } from '../src/store.js';

test('Прерванный урок остаётся незавершённым; аудит примеров не подменяет завершение всего урока', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'practicum-report-'));
  const original = process.cwd();
  const lesson = { url: 'https://practicum.yandex.ru/learn/test/lessons/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/', title: 'Урок [1]\nс примером', course: 'Основной', topic: '', solved: false, project: false };
  try {
    process.chdir(dir);
    const report = new RunReport([lesson]);
    await report.begin(lesson);
    await report.save('stopped');
    assert.ok((await readJson<any>('.local/unresolved-lessons.json', {}))[lesson.url]);
    assert.equal((await readJson<any>('.local/run-report.json', null)).hasGaps, true);
    await report.defer(lesson, 'Результат неизвестен', 'artifacts/example', `${lesson.url}?token=private`);
    const markdown = await readFile('.local/run-report.md', 'utf8');
    assert.match(markdown, /Урок \\\[1\\\] с примером/);
    assert.doesNotMatch(markdown, /private|token=/);
    await report.record(lesson, 'audited');
    assert.ok((await readJson<any>('.local/unresolved-lessons.json', {}))[lesson.url]);
    await report.record(lesson, 'verified');
    await report.save('completed');
    assert.equal(Object.keys(await readJson<any>('.local/unresolved-lessons.json', {})).length, 0);
    assert.equal((await readJson<any>('.local/run-report.json', null)).hasGaps, false);
  } finally { process.chdir(original); await rm(dir, { recursive: true, force: true }); }
});
