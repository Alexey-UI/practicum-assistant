import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { solveTrainer, readTrainer, contentHash } from '../src/trainer.js';
import { atomicJson, readJson } from '../src/store.js';

let browser: Browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });
const taskId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const lesson = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const css = '.card__link {display:block;width:150px;margin:80px;color:black;background:white} .card__link:hover {color:white;background:rgb(95,13,238)} .card__link:active {transform:translateY(2px)}';
const checks = [{ selector: '.card__link', hover: { color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(95, 13, 238)' }, active: { transform: 'matrix(1, 0, 0, 1, 0, 2)' } }];

async function fixture(page: Page, self: boolean): Promise<void> {
  await page.route('https://practicum.yandex.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: route.request().url().includes('/learn/') ? '<h1>Следующий урок</h1>' : `<textarea aria-label="Содержимое редактора"></textarea><div class="task-description__markdown">${self ? 'В этом задании не будет проверок результата. Придумайте hover и active.' : 'Задание с автоматической проверкой.'}</div><div class="files-tree"><span>style.css</span></div><button aria-label="Обновить" onclick="document.body.dataset.refreshes=String(Number(document.body.dataset.refreshes||0)+1)">Обновить</button><button data-test-id="check-task-button" onclick="window.finishedCheck?.();document.body.dataset.checks=String(Number(document.body.dataset.checks||0)+1);document.querySelector('[data-test-id=next-task-button]').style.display='block';setTimeout(()=>document.querySelector('[data-test-id=next-task-button]').disabled=false,150)">Проверить</button><button style="display:none" disabled data-test-id="next-task-button" onclick="location.href='/learn/test/lessons/cccccccc-cccc-cccc-cccc-cccccccccccc/'">Далее</button><iframe class="trainer-result__content" width="800" height="400" src="https://feynman.praktikum.yandex.net/staticfiles/frame.html"></iframe><script>window.monaco={editor:{getModels:()=>[{uri:{path:'/styles/style.css'},getLanguageId:()=> 'css',getValue:()=> ${JSON.stringify(css)}}]}}</script>` }));
  await page.route('https://feynman.praktikum.yandex.net/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<style>${css}</style><a class="card__link" href="https://example.invalid/leave">Ссылка</a>` }));
  await page.goto(`https://practicum.yandex.ru/trainer/test/lesson/${lesson}/task/${taskId}/`);
  const task = await readTrainer(page);
  await atomicJson(`.local/task-solutions/${taskId}.json`, { taskId, lessonId: lesson, instructions: task.instructions, contextHash: task.contextHash, verification: 'self', practiceChecks: checks, files: [{ name: 'style.css', initialHash: contentHash(css), content: css }] });
}

for (const mode of ['fresh', 'resume']) test(`Самостоятельное упражнение ${mode}: проверка состояний, отдельный учёт и одна отправка без перехода по ссылке`, async () => {
  const page = await browser.newPage(); const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-practice-')); let navigations = 0; let finishes = 0;
  try {
    process.chdir(dir);
    await page.route('https://example.invalid/**', route => { navigations++; return route.abort(); });
    await page.exposeFunction('finishedCheck', () => { finishes++; });
    await fixture(page, true);
    if (mode === 'resume') {
      const candidate = await readJson<{ files: Array<{name:string;initialHash:string;content:string}> }>(`.local/task-solutions/${taskId}.json`, {files:[]});
      await atomicJson(`.local/practices/${taskId}.json`, {phase:'requested',solutionHash:contentHash(JSON.stringify({files:candidate.files,checks})),files:candidate.files.map(file=>({name:file.name,initialHash:file.initialHash,contentHash:contentHash(file.content)})),updatedAt:new Date().toISOString()});
      await page.locator('[data-test-id="check-task-button"]').click();
    }
    assert.equal(await solveTrainer(page, true), 'finished');
    assert.equal(finishes, 1);
    assert.equal(navigations, 0);
    assert.equal(await readJson(`data/trainers/${taskId}.json`, null), null);
    const saved = await readJson<{ verification: string } | null>(`data/practice/${taskId}.json`, null);
    assert.equal(saved?.verification, 'self');
    assert.equal((await readJson<{ phase: string }>(`.local/practices/${taskId}.json`, {phase:''})).phase, 'self-checked');
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Самопроверкой нельзя заменить обычное проверяемое задание', async () => {
  const page = await browser.newPage(); const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-practice-guard-'));
  try {
    process.chdir(dir); await fixture(page, false);
    await assert.rejects(solveTrainer(page, true), /только для явно непроверяемого/);
    assert.equal(await page.locator('body').getAttribute('data-checks'), null);
    assert.equal(await readJson(`data/practice/${taskId}.json`, null), null);
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Неверные стили самостоятельного упражнения не разрешают завершение и публикацию', async () => {
  const page = await browser.newPage(); const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-practice-styles-'));
  try {
    process.chdir(dir); await fixture(page, true);
    const file = `.local/task-solutions/${taskId}.json`;
    const candidate = await readJson<Record<string, unknown>>(file, {});
    await atomicJson(file, {...candidate, practiceChecks:[{selector:'.card__link',hover:{color:'rgb(0, 0, 0)'}}]});
    await assert.rejects(solveTrainer(page, true), /Стили hover/);
    assert.equal(await page.locator('body').getAttribute('data-checks'), null);
    assert.equal(await readJson(`data/practice/${taskId}.json`, null), null);
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});
