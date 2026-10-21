import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { courseInScope, throughCourse, untilCourseArgument } from '../src/course-scope.js';
import { status } from '../src/status.js';
import { loadConfig } from '../src/config.js';
import { atomicJson, readJson } from '../src/store.js';

test('Граница модуля включительна, учитывает порядок каталога и однозначность названия', () => {
  const rows = ['Введение', 'Вёрстка. Семантика', 'Вёрстка. Семантика', 'Вёрстка. Адаптивность', 'JavaScript'].map((course, index) => ({ course, index }));
  const before = JSON.stringify(rows);
  assert.deepEqual(throughCourse(rows, '  СЕМАНТИКА  '), rows.slice(0, 3));
  assert.deepEqual(throughCourse(rows, 'Введение'), rows.slice(0, 1));
  assert.deepEqual(throughCourse(rows, 'JavaScript'), rows);
  assert.equal(throughCourse(rows), rows);
  assert.throws(() => throughCourse(rows, 'Вёрстка'), /Неоднозначный/);
  assert.throws(() => throughCourse(rows, 'Нет такого модуля'), /не найден/);
  assert.throws(() => throughCourse(rows, ' '), /название/);
  assert.equal(JSON.stringify(rows), before, 'Граница не обрезает сохранённый каталог');
  const exact = [{ course: 'JavaScript' }, { course: 'Продолжение JavaScript' }];
  assert.deepEqual(throughCourse(exact, 'JavaScript'), exact.slice(0, 1));
});

test('Параметр конечного модуля требует значение и исключает конфликтующие фильтры', () => {
  assert.equal(untilCourseArgument(['--until-course', 'Адаптивность']), 'Адаптивность');
  assert.equal(untilCourseArgument(['--until-course=Адаптивность']), 'Адаптивность');
  assert.equal(untilCourseArgument([]), undefined);
  for (const args of [
    ['--until-course'], ['--until-course='], ['--until-course', '--research'], ['--until-course', ' '],
    ['--until-course', 'Введение', '--until-course', 'JavaScript'],
    ['--course', 'Введение', '--until-course', 'JavaScript'],
    ['--url', 'https://practicum.yandex.ru/', '--until-course', 'JavaScript'],
    ['--course=Введение', '--until-course=JavaScript'],
    ['--until-course=Введение', '--until-course', 'JavaScript'],
  ]) assert.throws(() => untilCourseArgument(args), /until-course/);
});

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
