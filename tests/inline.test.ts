import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyInline, readInline, requestInlineCheck, observeInline, solveInline, sandboxFrame, type InlineSolution, isInlineDemonstration } from '../src/inline.js';
import { atomicJson, readJson } from '../src/store.js';

let browser: Browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(page: Page, success: boolean | 'retry'): Promise<void> {
  const positive = '<svg class="icon-status-success"></svg><md-content>Всё отлично!</md-content>';
  const negative = '<i><svg><path fill="#FF3B30"></path></svg></i><md-content>Исправьте код.</md-content><button onclick="this.parentElement.remove()">Закрыть</button>';
  const result = success === 'retry' ? `input.value === 'fixed' ? ${JSON.stringify(positive)} : ${JSON.stringify(negative)}` : JSON.stringify(positive);
  await page.route('https://practicum.yandex.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<main class="theory-viewer"><section><p>Исправьте язык документа.</p></section><section><div class="iframe-wrapper"><iframe src="https://sandbox.practicum-team.ru/tasks/test/pre/"></iframe></div></section></main>` }));
  await page.route('https://sandbox.practicum-team.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div class="tabs"><div class="tab" style="z-index:1">index.html</div></div><div class="CodeMirror"><textarea aria-label="Код">initial</textarea></div><div class="testsbox"><button>Проверить</button></div><script>
    const input = document.querySelector('textarea'); document.querySelector('.CodeMirror').CodeMirror={getValue:()=>input.value};
    input.oninput=()=>{document.querySelector('.testsbox button').disabled=false};
    document.querySelector('.testsbox button').onclick=function(){document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1);this.disabled=true;${success ? `const result=document.createElement('div');result.className='result';result.innerHTML=${result};document.body.append(result);` : ''}};
  </script>` }));
  await page.goto('https://practicum.yandex.ru/learn/test/lessons/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/');
}

test('Встроенное упражнение вводится через редактор и сохраняется только после успеха без повторной отправки', async () => {
  const page = await browser.newPage(); const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-inline-'));
  try {
    process.chdir(dir); await fixture(page, true);
    const task = await readInline(page, 0);
    assert.equal(task.instructions, 'Исправьте язык документа.');
    const solution = { id: task.id, lessonId: task.lessonId, url: task.url, instructionsHash: task.instructionsHash, files: [{ name: 'index.html', initialHash: task.files[0].hash, content: '<html lang="ru">\n</html>\n' }] };
    await atomicJson(`.local/inline-solutions/${task.id}.json`, solution);
    assert.equal(await solveInline(page, 0, true), true);
    const saved = await readJson<InlineSolution | null>(`data/inline/${task.id}.json`, null);
    assert.ok(saved?.evidence);
    assert.equal(saved.files[0].initialHash, task.files[0].hash);
    assert.equal(saved.evidence.selector, '.result .icon-status-success');
    assert.equal(await solveInline(page, 0), true);
    assert.equal(await (await sandboxFrame(page, 0)).locator('body').getAttribute('data-clicks'), '1');
    const state = await readJson<Record<string, unknown>>(`.local/inline/${task.id}.json`, {});
    assert.ok(state.detectedResult);
    await atomicJson(`.local/inline/${task.id}.json`, { ...state, phase: 'requested' });
    const frame = await sandboxFrame(page, 0);
    await frame.locator('.result').evaluate(el => el.remove());
    assert.equal(await observeInline(page, 0), 'correct');
    assert.equal(await frame.locator('body').getAttribute('data-clicks'), '1');
    await frame.getByRole('textbox').fill('Другая редакция');
    assert.equal(await observeInline(page, 0), 'unknown');
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Условие после демо внутри предыдущего блока читается без текста до демо', async () => {
  const page = await browser.newPage(); const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-inline-tail-'));
  try {
    process.chdir(dir); await fixture(page, false);
    await page.locator('.theory-viewer > section').first().evaluate(el => {
      el.innerHTML = '<p>Старое задание.</p><div><iframe></iframe></div><section><p><span class="chat__message-author">Пользователь</span>Задайте точку перспективы.</p></section>';
    });
    const task = await readInline(page, 1);
    assert.equal(task.instructions, 'Задайте точку перспективы.');
    assert.notEqual(task.instructionsHash, task.previousInstructionsHash);
    await page.locator('.chat__message-author').evaluate(el => { el.textContent = 'Другой пользователь'; });
    assert.equal((await readInline(page, 1)).instructionsHash, task.instructionsHash);
    await page.locator('.theory-viewer > section section p').evaluate(el => { el.append(' Новое требование.'); });
    assert.notEqual((await readInline(page, 1)).instructionsHash, task.instructionsHash);
    await page.locator('.theory-viewer > section').last().evaluate(el => { el.insertAdjacentHTML('beforebegin', '<p>Отдельное условие.</p>'); });
    assert.equal((await readInline(page, 1)).instructions, 'Отдельное условие.');
    assert.equal(await (await sandboxFrame(page, 1)).locator('body').getAttribute('data-clicks'), null);
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Пример для чтения не отправляется на проверку и распознаётся только в исходном контексте', async () => {
  const page = await browser.newPage(); const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-inline-demo-'));
  try {
    process.chdir(dir); await fixture(page, false);
    const task = await readInline(page, 0);
    await atomicJson(`data/inline-demos/${task.id}-${task.instructionsHash}.json`, {id:task.id,lessonId:task.lessonId,instructionsHash:task.instructionsHash,files:task.files.map(({name,hash})=>({name,hash})),reason:'Инструкция просит только прочитать готовый пример.',reviewedAt:new Date().toISOString()});
    assert.equal(await solveInline(page, 0), true);
    assert.equal(await (await sandboxFrame(page, 0)).locator('body').getAttribute('data-clicks'), null);
    assert.equal(await readJson(`data/inline/${task.id}.json`, null), null);
    assert.equal(await isInlineDemonstration({...task,lessonId:'another'}), false);
    assert.equal(await isInlineDemonstration({...task,instructionsHash:'another'}), false);
    assert.equal(await isInlineDemonstration({...task,files:task.files.map(file=>({...file,hash:'changed'}))}), false);
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Асинхронное переключение вкладок не смешивает исходники HTML и CSS', async () => {
  const page = await browser.newPage(); const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-inline-tabs-'));
  try {
    process.chdir(dir); await fixture(page, false);
    const frame = await sandboxFrame(page, 0);
    await frame.evaluate(() => {
      // Chrome can suspend repaint callbacks for sandbox frames outside view.
      window.requestAnimationFrame = () => 0;
      const tabs = document.querySelector('.tabs')!;
      tabs.innerHTML = '<div class="tab" style="z-index:1;width:500px"><span>index.html</span></div><div class="tab" style="width:500px"><span>style.css</span></div>';
      for (const tab of tabs.querySelectorAll<HTMLElement>('.tab')) tab.querySelector<HTMLElement>('span')!.onclick = () => setTimeout(() => {
        for (const other of tabs.querySelectorAll<HTMLElement>('.tab')) other.style.zIndex = '';
        tab.style.zIndex = '1';
        document.querySelector('textarea')!.value = tab.textContent === 'index.html' ? 'initial' : 'body { color: red; }';
      }, 50);
    });
    const task = await readInline(page, 0);
    assert.deepEqual(task.files.map(file => [file.name, file.content]), [['index.html', 'initial'], ['style.css', 'body { color: red; }']]);
    assert.notEqual(task.files[0].hash, task.files[1].hash);
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Имя участника диалога не меняет ключ условия, текст задания продолжает проверяться', async () => {
  const page = await browser.newPage(); const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-inline-names-'));
  try {
    process.chdir(dir); await fixture(page, false);
    await page.locator('.theory-viewer p').evaluate(el => { el.innerHTML = '<span class="chat__message-author">Один пользователь</span>Исправьте язык документа.'; });
    const first = await readInline(page, 0);
    await page.locator('.chat__message-author').evaluate(el => { el.textContent = 'Другой пользователь'; });
    const second = await readInline(page, 0);
    assert.equal(first.instructionsHash, second.instructionsHash);
    assert.notEqual(first.previousInstructionsHash, second.previousInstructionsHash);
    await page.locator('.theory-viewer p').evaluate(el => { el.append(' Новое требование.'); });
    assert.notEqual((await readInline(page, 0)).instructionsHash, second.instructionsHash);
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Отклонённое встроенное решение исправляется с исходным хешем, ошибочный вариант не попадает в библиотеку', async () => {
  const page = await browser.newPage(); const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-inline-retry-'));
  try {
    process.chdir(dir); await fixture(page, 'retry');
    const task = await readInline(page, 0);
    const solution = { id: task.id, lessonId: task.lessonId, url: task.url, instructionsHash: task.instructionsHash, files: [{ name: 'index.html', initialHash: task.files[0].hash, content: 'bad' }] };
    await atomicJson(`.local/inline-solutions/${task.id}.json`, solution);
    assert.equal(await solveInline(page, 0, true), false);
    assert.equal(await readJson(`data/inline/${task.id}.json`, null), null);
    solution.files[0].content = 'fixed';
    await atomicJson(`.local/inline-solutions/${task.id}.json`, solution);
    assert.equal(await solveInline(page, 0, true), true);
    const saved = await readJson<InlineSolution | null>(`data/inline/${task.id}.json`, null);
    assert.equal(saved?.files[0].initialHash, task.files[0].hash);
    assert.equal(await (await sandboxFrame(page, 0)).locator('body').getAttribute('data-clicks'), '2');
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Ожидающая проверка встроенного упражнения запрещает повтор и редактирование; чужие правки сохраняются', async () => {
  const page = await browser.newPage(); const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-inline-pending-'));
  try {
    process.chdir(dir); await fixture(page, false);
    const task = await readInline(page, 0);
    await atomicJson(`.local/inline-solutions/${task.id}.json`, { id: task.id, lessonId: task.lessonId, url: task.url, instructionsHash: task.instructionsHash, files: [{ name: 'index.html', initialHash: task.files[0].hash, content: 'fixed' }] });
    const frame = await sandboxFrame(page, 0); const input = frame.getByRole('textbox');
    await input.fill('Чужая правка');
    await assert.rejects(applyInline(page, 0), /Исходный файл/);
    assert.equal(await input.inputValue(), 'Чужая правка');
    await input.fill('initial'); await applyInline(page, 0); await requestInlineCheck(page, 0);
    assert.equal(await observeInline(page, 0), 'unknown');
    await assert.rejects(requestInlineCheck(page, 0), /предыдущей проверки/);
    await assert.rejects(applyInline(page, 0), /предыдущей проверки/);
    assert.equal(await frame.locator('body').getAttribute('data-clicks'), '1');
    assert.equal(await readJson(`data/inline/${task.id}.json`, null), null);
    await page.route('https://practicum.yandex.ru/not-a-sandbox/', route => route.fulfill({ contentType: 'text/html', body: '<p>Not a sandbox</p>' }));
    await page.locator('iframe').evaluate(el => el.setAttribute('src', 'https://practicum.yandex.ru/not-a-sandbox/'));
    await frame.waitForURL('https://practicum.yandex.ru/not-a-sandbox/', { waitUntil: 'commit' });
    await assert.rejects(sandboxFrame(page, 0), /sandbox Практикума/);
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});
