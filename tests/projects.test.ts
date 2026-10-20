import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectDestination, projectCheckArgs, projectLessonUrl } from '../src/projects.js';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('Проекты другого пользователя публикуются в его аккаунт, источник эталонов не меняется', () => {
  assert.equal(projectDestination('Alexey-UI/mesto-ad', 'Other-Student'), 'Other-Student/mesto-ad');
  assert.equal(projectDestination('Alexey-UI/mesto-ad'), 'Alexey-UI/mesto-ad');
  for (const owner of ['../Alexey-UI', 'x/y', '', '-invalid', 'user.git/hijack']) assert.throws(() => projectDestination('Alexey-UI/mesto-ad', owner));
});

test('Урок сдачи берётся из каталога текущего аккаунта по ID; чужие сайты и неоднозначность исключаются', () => {
  const template = 'https://practicum.yandex.ru/learn/ap-frontend-st/courses/course/sprints/1/topics/topic/lessons/same/';
  const actual = template.replace('/sprints/1/', '/sprints/9876/');
  assert.equal(projectLessonUrl(template, [{url:actual}]), actual);
  assert.equal(projectLessonUrl(template, [{url:actual}, {url:actual}]), actual);
  assert.equal(projectLessonUrl(template, [{url:'https://example.org/lessons/same/'}]), template);
  assert.throws(() => projectLessonUrl(template, [{url:template}, {url:actual}]), /неоднозначный/);
});

test('Кеш проверки проекта использует временную папку текущей ОС', () => {
  assert.deepEqual(projectCheckArgs(['ci', '--cache', '/private/tmp/practicum-npm-cache', '--ignore-scripts']), ['ci', '--cache', path.join(tmpdir(), 'practicum-npm-cache'), '--ignore-scripts']);
  assert.deepEqual(projectCheckArgs(['run', 'build']), ['run', 'build']);
});
