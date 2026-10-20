import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPreviewActions } from '../src/preview-actions.js';
import { handleExerciseDialogs } from '../src/exercise-dialogs.js';
import { readJson } from '../src/store.js';

test('Учебный сценарий ждёт новый предпросмотр, вводит данные через UI и наблюдает настоящий alert до проверки', { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-preview-actions-'));
  const taskId = '3a5b0f10-b1ee-441f-b402-14e994aecde9';
  try {
    process.chdir(dir);
    const context = await browser.newContext(); handleExerciseDialogs(context);
    const page = await context.newPage();
    await page.route('https://practicum.yandex.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<button aria-label="Обновить" onclick="document.body.dataset.refreshes=String(Number(document.body.dataset.refreshes||0)+1);document.querySelector('iframe').contentWindow.postMessage('refresh','https://feynman.praktikum.yandex.net')">Обновить</button><button onclick="document.body.dataset.checks='1'">Проверить</button><iframe class="trainer-result__content" src="https://feynman.praktikum.yandex.net/staticfiles/frame.html"></iframe>` }));
    await page.route('https://feynman.praktikum.yandex.net/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('invalid-image')) return route.fulfill({ status: 404, body: '' });
      if (url.pathname === '/staticfiles/frame.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<iframe id="result" src="https://feynman.praktikum.yandex.net/static/old/index.html"></iframe><script>onmessage=()=>document.querySelector('iframe').src='https://feynman.praktikum.yandex.net/static/new/index.html?time='+Date.now()</script>` });
      if (url.pathname.includes('/new/')) await new Promise(resolve => setTimeout(resolve, 200));
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<head><base href="https://feynman.praktikum.yandex.net/static/example/"></head><body><input class="artist"><input class="title"><input class="duplicate"><input class="duplicate"><button class="add" onclick="document.querySelector('.songs').insertAdjacentHTML('beforeend',document.querySelector('.artist').value)">Добавить</button><div class="songs"></div></body>` });
    });
    await page.goto(`https://practicum.yandex.ru/trainer/test/lesson/20395e6a-48a9-458e-9511-6078d05b488d/task/${taskId}/`);
    await runPreviewActions(page, taskId, [
      { action: 'fill', selector: '.artist', value: `<img src="invalid-image" onerror="alert('учебная проверка')">` },
      { action: 'fill', selector: '.title', value: 'Тест' },
      { action: 'click', selector: '.add', expectAlert: 'учебная проверка' },
    ]);
    const saved = await readJson<{ steps: number; alerts: string[] } | null>(`.local/preview-checks/${taskId}.json`, null);
    assert.deepEqual(saved && { steps: saved.steps, alerts: saved.alerts }, { steps: 3, alerts: ['учебная проверка'] });
    assert.equal(await page.locator('body').getAttribute('data-checks'), null);
    await assert.rejects(runPreviewActions(page, taskId, [{ action: 'fill', selector: '.duplicate', value: 'x' }]), /Неоднозначный/);
    await assert.rejects(runPreviewActions(page, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', [{ action: 'click', selector: '.add' }]), /Неверный сценарий/);
    assert.equal(await page.locator('body').getAttribute('data-refreshes'), '2');
    assert.equal(await page.locator('body').getAttribute('data-checks'), null);
    await context.close();
  } finally { process.chdir(original); await browser.close(); await rm(dir, { recursive: true, force: true }); }
});
