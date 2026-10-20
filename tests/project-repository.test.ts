import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureManualRepository } from '../src/project-repository.js';

const project = { destination: 'Other-Student/to-do', review: 'teacher' as const };
const absent = Object.assign(new Error('Not Found'), { stdout: 'HTTP/2.0 404 Not Found\r\n' });

test('Новый аккаунт создаёт отсутствующий учебный репозиторий и приводит только новую ветку к main', async () => {
  const calls: string[][] = [];
  await ensureManualRepository(project, 'Other-Student', async args => {
    calls.push(args);
    if (calls.length === 1) throw absent;
    return { stdout: args.includes('--jq') ? (calls.length === 3 ? 'student/default\n' : 'main\n') : '' };
  });
  assert.equal(calls.filter(args => args[0] === 'repo' && args[1] === 'create').length, 1);
  assert.deepEqual(calls[1], ['repo', 'create', project.destination, '--public', '--add-readme']);
  assert.deepEqual(calls[3], ['api', 'repos/Other-Student/to-do/branches/student%2Fdefault/rename', '--method', 'POST', '-f', 'new_name=main', '--silent']);
});

test('Существующие и платформенные репозитории не создаются и не переименовываются', async () => {
  const calls: string[][] = [];
  const gh = async (args: string[]) => { calls.push(args); return { stdout: 'HTTP/2.0 200 OK\r\n' }; };
  await ensureManualRepository(project, 'other-student', gh);
  assert.equal(calls.length, 1);
  calls.length = 0;
  await ensureManualRepository({ ...project, review: 'platform' }, 'Other-Student', gh);
  assert.equal(calls.length, 0);
  await assert.rejects(() => ensureManualRepository(project, 'Alexey-UI', gh), /принадлежать аккаунту/);
  assert.equal(calls.length, 0);
});

test('Сетевая ошибка или отказ в доступе не вызывают создание, неопределённое создание не повторяется', async () => {
  for (const error of [new Error('connection reset'), Object.assign(new Error('Forbidden'), { stdout: 'HTTP/2.0 403 Forbidden\r\n' })]) {
    let count = 0;
    await assert.rejects(() => ensureManualRepository(project, 'Other-Student', async () => { count++; throw error; }), value => value === error);
    assert.equal(count, 1);
  }
  const calls: string[][] = []; const lost = new Error('response lost');
  await assert.rejects(() => ensureManualRepository(project, 'Other-Student', async args => {
    calls.push(args);
    if (calls.length === 1) throw absent;
    throw lost;
  }), value => value === lost);
  assert.equal(calls.filter(args => args[0] === 'repo').length, 1);
  const writes: string[][] = [];
  await ensureManualRepository(project, 'Other-Student', async args => { writes.push(args); return { stdout: '' }; });
  assert.equal(writes.length, 1, 'После потери ответа существующий репозиторий только читается');
});
