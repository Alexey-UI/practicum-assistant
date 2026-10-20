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

for (const strict of [false, true]) test(`Неизвестное упражнение: ${strict ? 'явная остановка' : 'пропуск, отчёт и возобновление после галочки чтения'}`, { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'practicum-runner-gaps-'));
  const original = process.cwd(); const argv = process.argv; const exitCode = process.exitCode;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const lesson = 'https://practicum.yandex.ru/learn/test/lessons/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/';
  const following = 'https://practicum.yandex.ru/learn/test/lessons/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/';
  const destination = 'https://practicum.yandex.ru/learn/test/lessons/cccccccc-cccc-cccc-cccc-cccccccccccc/';
  const sandbox = 'https://sandbox.practicum-team.ru/tasks/test-unresolved/pre/';
  const requests: string[] = []; let checks = 0;
  const makeContext = async () => {
    const context = await browser.newContext();
    await context.route('**/*', route => {
      const url = route.request().url(); requests.push(url);
      if (url === sandbox) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div class="tabs"><div class="tab" style="z-index:1">index.html</div></div>
        <div class="CodeMirror"><textarea>initial</textarea></div><button>Проверить</button><script>
        const input=document.querySelector('textarea');document.querySelector('.CodeMirror').CodeMirror={getValue:()=>input.value};
        document.querySelector('button').onclick=()=>{fetch('/record-check');if(input.value==='fixed')document.body.insertAdjacentHTML('beforeend','<div class="result"><svg class="icon-status-success"></svg><md-content>Принято</md-content></div>')};</script>` });
      if (url.endsWith('/record-check')) { checks++; return route.fulfill({ body: 'ok' }); }
      const markers = `<a class="sidebar__lesson sidebar__lesson_status_solved" href="${new URL(lesson).pathname}">Прочитано</a><a class="sidebar__lesson sidebar__lesson_status_solved" href="${new URL(following).pathname}">Прочитано</a>`;
      if (url === lesson) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<h1>Первый урок</h1><a class="sidebar__lesson sidebar__lesson_status_solved" href="${new URL(lesson).pathname}">Прочитано</a><main class="theory-viewer"><p>Исправьте пример.</p><div class="iframe-wrapper"><iframe src="${sandbox}" style="width:700px;height:300px"></iframe></div></main><button data-test-id="next-lesson-control-button" onclick="location.href='${following}'">К следующему уроку</button>` });
      if (url === following) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<h1>Второй урок</h1>${markers}<main class="theory-viewer"><p>Теория</p></main><button data-test-id="next-lesson-control-button" onclick="location.href='${destination}'">К следующему уроку</button>` });
      if (url === destination) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<h1>Конец</h1>${markers}` });
      return route.abort();
    });
    return context;
  };
  try {
    process.chdir(dir); process.argv = ['node', 'cli.ts', 'run', '--use-catalog', ...(strict ? ['--stop-on-pending'] : [])];
    await atomicJson('.local/catalog-index.json', { complete: true });
    await atomicJson('.local/catalog.json', [
      { url: lesson, title: 'Новая теория', course: 'Основной', topic: '', solved: false, project: false },
      { url: following, title: 'Следующая теория', course: 'Основной', topic: '', solved: false, project: false },
    ]);
    await run(makeContext);
    const report = await readJson<any>('.local/run-report.json', null);
    assert.equal(report.outcome, strict ? 'stopped' : 'completed');
    assert.equal(report.hasGaps, true);
    assert.equal(report.lessons[0].disposition, 'deferred');
    assert.equal(requests.includes(following), !strict, 'Обычный запуск продолжает обход, строгий останавливается');
    assert.equal(checks, 0, 'Незнакомое решение не отправляется');
    assert.equal((await readJson<any>('.local/completed.json', {}))[lesson], undefined);
    assert.ok((await readJson<any>('.local/unresolved-lessons.json', {}))[lesson]);
    assert.match(await readFile('.local/run-report.md', 'utf8'), /Встроенное упражнение неизвестно/);
    assert.equal(process.exitCode, strict ? 2 : exitCode);
    if (strict) return;

    // The platform now lists the first lesson as read. Its unresolved exercise must still be visited.
    const task = await readJson<any>('.local/pending-inline.json', null);
    await atomicJson(`data/inline/${task.id}.json`, { id: task.id, lessonId: task.lessonId, url: task.url, instructionsHash: task.instructionsHash,
      files: [{ name: 'index.html', initialHash: task.files[0].hash, content: 'fixed' }], verifiedAt: new Date().toISOString(), evidence: { selector: '.result .icon-status-success', message: 'Проверенный эталон' } });
    const before = requests.filter(url => url === lesson).length;
    await run(makeContext);
    assert.ok(requests.filter(url => url === lesson).length > before);
    assert.equal(checks, 1);
    assert.equal((await readJson<any>('.local/unresolved-lessons.json', {}))[lesson], undefined);
    const finalReport = await readJson<any>('.local/run-report.json', null);
    assert.equal(finalReport.lessons[0].disposition, 'verified');
  } finally {
    await browser.close(); process.chdir(original); process.argv = argv; process.exitCode = exitCode;
    await rm(dir, { recursive: true, force: true });
  }
});
