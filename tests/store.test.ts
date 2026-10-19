import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Answers, questionKey, type Question, atomicJson } from '../src/store.js';
import { candidates } from '../src/quiz.js';
import { allowedUrl, safeUrl, isTrainerTaskUrl } from '../src/browser.js';

const question: Question = { prompt: 'Что означает HTML?', options: ['Язык разметки', 'Язык стилей'], multiple: false };
test('Теория под /trainer/ отличается от адреса задания редактора', () => {
  assert.equal(isTrainerTaskUrl('https://practicum.yandex.ru/trainer/ap-frontend-st/lesson/72225c3c-ce29-4f79-8f4b-197eef4f083b/'), false);
  assert.equal(isTrainerTaskUrl('https://practicum.yandex.ru/trainer/ap-frontend-st/lesson/37699621-08a0-48e5-99d5-699ed5943f8a/task/b18558b0-0ecd-48e7-acb8-d0b31762eb99/'), true);
  assert.equal(isTrainerTaskUrl('https://practicum.yandex.ru/learn/ap-frontend-st/lessons/example/'), false);
  assert.equal(isTrainerTaskUrl('https://other.example/trainer/program/lesson/id/task/id/'), false);
});
test('Ответ сохраняется по тексту и находится при перестановке вариантов', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'practicum-test-'));
  try {
    const answers = new Answers(path.join(dir, 'answers.json'));
    await answers.confirm(question, ['Язык разметки'], 'Интерфейс показал статус correct');
    assert.deepEqual(await answers.get({ ...question, options: [...question.options].reverse() }), ['Язык разметки']);
    assert.equal(await answers.get({ ...question, prompt: 'Что означает CSS?' }), undefined);
    assert.notEqual(questionKey(question), questionKey({ ...question, options: ['Другая формулировка', 'Язык стилей'] }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Нельзя сохранить ответ без подтверждения либо отсутствующий вариант', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'practicum-test-'));
  try {
    const answers = new Answers(path.join(dir, 'answers.json'));
    await assert.rejects(answers.confirm(question, ['Язык разметки'], ''));
    await assert.rejects(answers.confirm(question, ['Произвольный ответ'], 'correct'));
    await assert.rejects(answers.confirm(question, question.options, 'correct'));
    assert.equal(await answers.get(question), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Проверенный ответ доступен из переносимой базы без локальной истории', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'practicum-bundle-'));
  try {
    const file = path.join(dir, 'bundle.json');
    await atomicJson(file, { [questionKey(question)]: { answers: ['Язык разметки'], evidence: 'correct', confirmedAt: '2026-10-18T00:00:00Z' } });
    const answers = new Answers(path.join(dir, 'empty.json'), file);
    assert.deepEqual(await answers.get({ ...question, options: [...question.options].reverse() }), ['Язык разметки']);
    assert.equal(await answers.get({ ...question, prompt: 'Другой вопрос' }), undefined);
    await atomicJson(file, { [questionKey(question)]: { answers: ['Язык разметки'], evidence: '', confirmedAt: '2026-10-18T00:00:00Z' } });
    await assert.rejects(answers.get(question));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Перебор ограничен даже для вопросов с большим количеством флажков', () => {
  const q = { ...question, multiple: true, options: Array.from({ length: 40 }, (_, i) => `Вариант ${i}`) };
  assert.equal(candidates(q, 16).length, 16);
  const small = candidates({ ...q, options: ['A', 'B', 'C'] }, 16);
  assert.equal(small.length, 7);
  assert.ok(small.some(v => v.join(',') === 'A,B,C'));
});
test('Навигация ограничена доменом курса, в журнал URL не попадают query и hash', () => {
  assert.ok(allowedUrl('https://practicum.yandex.ru/learn/test/'));
  for (const url of ['https://practicum.yandex.ru.evil.test/', 'http://practicum.yandex.ru/', 'javascript:alert(1)', 'invalid']) assert.equal(allowedUrl(url), false);
  assert.equal(safeUrl('https://practicum.yandex.ru/learn/?token=secret#secret'), 'https://practicum.yandex.ru/learn/');
});
