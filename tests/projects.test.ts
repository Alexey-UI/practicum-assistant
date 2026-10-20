import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectDestination, projectCheckArgs } from '../src/projects.js';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('Проекты другого пользователя публикуются в его аккаунт, источник эталонов не меняется', () => {
  assert.equal(projectDestination('Alexey-UI/mesto-ad', 'Other-Student'), 'Other-Student/mesto-ad');
  assert.equal(projectDestination('Alexey-UI/mesto-ad'), 'Alexey-UI/mesto-ad');
  for (const owner of ['../Alexey-UI', 'x/y', '', '-invalid', 'user.git/hijack']) assert.throws(() => projectDestination('Alexey-UI/mesto-ad', owner));
});

test('Кеш проверки проекта использует временную папку текущей ОС', () => {
  assert.deepEqual(projectCheckArgs(['ci', '--cache', '/private/tmp/practicum-npm-cache', '--ignore-scripts']), ['ci', '--cache', path.join(tmpdir(), 'practicum-npm-cache'), '--ignore-scripts']);
  assert.deepEqual(projectCheckArgs(['run', 'build']), ['run', 'build']);
});
