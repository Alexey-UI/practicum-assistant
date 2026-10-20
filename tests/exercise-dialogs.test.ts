import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { handleExerciseDialogs } from '../src/exercise-dialogs.js';

test('Известный учебный prompt выходит из цикла, ответы не переносятся в другие задания и сообщения', { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    handleExerciseDialogs(context);
    const page = await context.newPage();
    await page.route('https://practicum.yandex.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<button>Запустить</button>' }));
    const task = 'https://practicum.yandex.ru/trainer/test/lesson/90f0ed41-1495-444e-984c-fc485fa2efdd/task/3692dd15-8f22-4205-b110-dfa69877bad8/';
    await page.goto(task);
    assert.deepEqual(await page.evaluate(() => {
      let password: string | null = null;
      let calls = 0;
      while (password === null && calls < 3) { calls++; password = prompt('Введите пароль:'); }
      return { password, calls };
    }), { password: 'учебный пример', calls: 1 });
    assert.equal(await page.evaluate(() => prompt('Другой запрос')), null);
    await page.goto(task.replace('3692dd15-8f22-4205-b110-dfa69877bad8', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
    assert.equal(await page.evaluate(() => prompt('Введите пароль:')), null);
    await page.goto(task.replace('90f0ed41-1495-444e-984c-fc485fa2efdd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'));
    assert.equal(await page.evaluate(() => prompt('Введите пароль:')), null);
    await page.goto('https://practicum.yandex.ru/profile/ap-frontend-st/');
    assert.equal(await page.evaluate(() => prompt('Введите пароль:')), null);
    assert.equal(await page.evaluate(() => confirm('Введите пароль:')), false);
    await context.close();
  } finally { await browser.close(); }
});
