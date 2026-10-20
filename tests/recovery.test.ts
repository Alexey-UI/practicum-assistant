import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnexpectedBrowserClosure, withBrowserRecovery } from '../src/recovery.js';

test('После закрытия браузера повторяется обход, но число восстановлений ограничено', async () => {
  let calls = 0; const retries: number[] = [];
  await withBrowserRecovery(async () => { if (++calls === 1) throw new UnexpectedBrowserClosure('https://practicum.yandex.ru/learn/', new Error('closed')); }, async (_, attempt) => { retries.push(attempt); });
  assert.equal(calls, 2); assert.deepEqual(retries, [1]);
  calls = 0; retries.length = 0;
  await assert.rejects(withBrowserRecovery(async () => { calls++; throw new UnexpectedBrowserClosure(undefined, new Error('closed')); }, async (_, attempt) => { retries.push(attempt); }), UnexpectedBrowserClosure);
  assert.equal(calls, 3); assert.deepEqual(retries, [1, 2]);
});

test('Ошибка проверки и штатная остановка не перезапускают браузер', async () => {
  let calls = 0; let retries = 0;
  const error = new Error('Проверка не подтверждена');
  await assert.rejects(withBrowserRecovery(async () => { calls++; throw error; }, async () => { retries++; }), received => received === error);
  assert.equal(calls, 1); assert.equal(retries, 0);
  calls = 0;
  await withBrowserRecovery(async () => { calls++; }, async () => { retries++; });
  assert.equal(calls, 1); assert.equal(retries, 0);
});
