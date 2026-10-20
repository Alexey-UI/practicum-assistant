import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { courseInScope } from '../src/course-scope.js';
import { status } from '../src/status.js';
import { loadConfig } from '../src/config.js';
import { atomicJson, readJson } from '../src/store.js';

test('Исключение дополнительных модулей меняет объём отчёта, сохраняя их прогресс и решения', async () => {
  const original = process.cwd(); const log = console.log;
  const dir = await mkdtemp(path.join(tmpdir(), 'practicum-course-scope-'));
  try {
    process.chdir(dir); console.log = () => {};
    const rows = [
      { course: 'Основы JavaScript', url: 'https://practicum.yandex.ru/learn/ap-frontend-st/lessons/core-1/', solved: true },
      { course: 'Основы JavaScript', url: 'https://practicum.yandex.ru/learn/ap-frontend-st/lessons/core-2/', solved: false },
      { course: 'Дополнительный модуль. «Реакт». Начало', url: 'https://practicum.yandex.ru/learn/ap-frontend-st/lessons/react-1/', solved: true },
    ];
    await atomicJson('.local/catalog.json', rows);
    await atomicJson('data/trainers/retained-react.json', { evidence: 'Сохранённое принятое решение' });
    await atomicJson('.local/inline/unknown.json', { phase: 'requested' });
    await atomicJson('.local/inline/accepted.json', { phase: 'correct' });
    await atomicJson('.local/inline/rejected.json', { phase: 'wrong' });
    const before = await readFile('.local/catalog.json', 'utf8');
    const cfg = await loadConfig();
    assert.equal(cfg.includeAdditionalModules, false);
    assert.deepEqual(rows.filter(row => courseInScope(row.course, cfg.includeAdditionalModules)).map(row => row.url), rows.slice(0, 2).map(row => row.url));
    await status();
    let result = await readJson<Record<string, number>>('.local/status.json', {});
    assert.equal(result.lessons, 2); assert.equal(result.solved, 1);
    assert.equal(result.catalogLessons, 3); assert.equal(result.excludedLessons, 1); assert.equal(result.excludedSolved, 1);
    assert.equal(result.pendingInlineChecks, 1); assert.equal(result.pendingTrainerChecks, 0);
    assert.deepEqual(await readJson('.local/inline/unknown.json', null), { phase: 'requested' });
    assert.equal(await readFile('.local/catalog.json', 'utf8'), before);
    assert.ok(await readJson('data/trainers/retained-react.json', null));
    await atomicJson('practicum.config.json', { includeAdditionalModules: true });
    await status();
    result = await readJson<Record<string, number>>('.local/status.json', {});
    assert.equal(result.lessons, 3); assert.equal(result.solved, 2); assert.equal(result.excludedLessons, 0);
    await atomicJson('practicum.config.json', { includeAdditionalModules: 'true' });
    await assert.rejects(loadConfig, /includeAdditionalModules/);
  } finally { process.chdir(original); console.log = log; await rm(dir, { recursive: true, force: true }); }
});
