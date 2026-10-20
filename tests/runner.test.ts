import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/runner.js';
import { atomicJson, readJson } from '../src/store.js';
import { readInline } from '../src/inline.js';

test('Галочка после открытия новой теории не пропускает её упражнение; прежние пройденные уроки сохраняются', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'practicum-runner-'));
  const original = process.cwd(); const argv = process.argv; const exitCode = process.exitCode;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const previous = 'https://practicum.yandex.ru/learn/test/lessons/cccccccc-cccc-cccc-cccc-cccccccccccc/';
  const lesson = 'https://practicum.yandex.ru/learn/test/lessons/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/';
  const next = 'https://practicum.yandex.ru/learn/test/lessons/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/';
  const sandbox = 'https://sandbox.practicum-team.ru/tasks/test-runner/pre/';
  const requests: string[] = [];
  try {
    process.chdir(dir); process.argv = ['node', 'cli.ts', 'run', '--use-catalog'];
    const context = await browser.newContext();
    await context.route('**/*', route => {
      const url = route.request().url(); requests.push(url);
      if (url === sandbox) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div class="tabs"><div class="tab" style="z-index:1">index.html</div></div>
        <div class="CodeMirror"><textarea>initial</textarea></div><button>Проверить</button><script>
        const input=document.querySelector('textarea');document.querySelector('.CodeMirror').CodeMirror={getValue:()=>input.value};
        document.querySelector('button').onclick=()=>{if(input.value!=='fixed')throw new Error('Wrong exercise code');document.body.insertAdjacentHTML('beforeend','<div class="result"><svg class="icon-status-success"></svg><md-content>Принято</md-content></div>')};</script>` });
      if (url === lesson) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<h1>Теория</h1><a class="sidebar__lesson sidebar__lesson_status_solved" href="${new URL(lesson).pathname}">Прочитано</a>
        <main class="theory-viewer"><p>Исправьте пример.</p><div class="iframe-wrapper"><iframe src="${sandbox}" style="width:700px;height:300px"></iframe></div></main>
        <button data-test-id="next-lesson-control-button" onclick="location.href='${next}'">К следующему уроку</button>` });
      if (url === next) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<h1>Следующий урок</h1><a class="sidebar__lesson sidebar__lesson_status_solved" href="${new URL(lesson).pathname}">Пройдено</a>` });
      return route.abort();
    });
    const page = await context.newPage(); await page.goto(lesson);
    const task = await readInline(page, 0);
    await atomicJson(`data/inline/${task.id}.json`, { id: task.id, lessonId: task.lessonId, url: task.url, instructionsHash: task.instructionsHash,
      files: [{ name: 'index.html', initialHash: task.files[0].hash, content: 'fixed' }], verifiedAt: new Date().toISOString(), evidence: { selector: '.result .icon-status-success', message: 'Ранее проверенный эталон' } });
    await atomicJson('.local/catalog-index.json', { complete: true });
    await atomicJson('.local/catalog.json', [
      { url: previous, title: 'Ранее пройденный', course: 'Основной', topic: '', solved: true, project: false },
      { url: lesson, title: 'Новая теория', course: 'Основной', topic: '', solved: false, project: false },
    ]);
    await run(async () => context);
    const state = await readJson<{ phase: string } | null>(`.local/inline/${task.id}.json`, null);
    assert.equal(state?.phase, 'correct', 'Реальная проверка упражнения обязательна даже после автоматической галочки чтения');
    const events = (await readFile('.local/events.jsonl', 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.filter(event => event.event === 'inline-check-requested').length, 1);
    assert.equal(events.filter(event => event.event === 'lesson-completed').length, 1);
    assert.equal(process.exitCode, exitCode);
    assert.equal(requests.includes(previous), false);
    assert.equal(requests.includes(next), true);
    const rows = await readJson<Array<{ solved: boolean }>>('.local/catalog.json', []);
    assert.equal(rows[0].solved, true);
  } finally {
    await browser.close(); process.chdir(original); process.argv = argv; process.exitCode = exitCode;
    await rm(dir, { recursive: true, force: true });
  }
});
