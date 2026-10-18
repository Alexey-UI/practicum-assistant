import { chromium } from 'playwright';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(process.argv[2] ?? 'workspaces/posmotri-v-okno-ad');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://v-content.practicum-team.ru/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/videos') {
      const noResults = url.searchParams.has('filters[city][$containsi]');
      const offset = url.searchParams.get('pagination[page]') === '2' ? 5 : 0;
      const results = noResults ? [] : Array.from({ length: 5 }, (_, index) => ({
        id: offset + index + 1, city: index === 0 ? 'Очень длинное название города для проверки переполнения' : `Город ${offset + index + 1}`,
        description: 'Длинное описание городского окна, которое должно занимать не больше двух строк в карточке.',
        video: { url: `/video-${offset + index + 1}.mp4` }, poster: { url: '/poster.svg' }, thumbnail: { url: '/poster.svg' },
      }));
      await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ results, pagination: { page: offset ? 2 : 1, pageCount: 2 } }) });
    } else if (url.pathname.endsWith('.svg')) {
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="711" height="386"><rect width="711" height="386" fill="#40605a"/><path d="M0 270H711" stroke="#b6baa0" stroke-width="65"/></svg>' });
    } else await route.fulfill({ status: 204 });
  });
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.content__card-link').nth(4).waitFor();
  // The API and media readiness are simulated; application handlers are original.
  await page.waitForFunction(() => !!document.querySelector('video')?.oncanplaythrough);
  await page.locator('video').dispatchEvent('canplaythrough');
  await page.locator('.preloader').first().waitFor({ state: 'hidden', timeout: 10000 });
  const videoBox = await page.locator('.result__video-container').boundingBox();
  assert.ok(videoBox && videoBox.width === 711 && videoBox.height === 386);
  assert.equal((await page.locator('.content__list-container').boundingBox())?.height, 298);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1200);
  assert.equal(await page.locator('.content__video-card-description').first().evaluate(el => el.getBoundingClientRect().height <= 33), true);
  assert.equal(await page.locator('.content__video-card-title').first().evaluate(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis'), true);
  await page.locator('.search-form__label').filter({ has: page.locator('input[value="morning"]') }).click();
  assert.equal(await page.locator('input[value="morning"]').isChecked(), true);
  assert.equal(await page.locator('.search-form__pseudo-checkbox').first().evaluate(el => getComputedStyle(el, '::after').opacity), '1');
  await page.locator('.search-form__textfield').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('input[value="morning"]').evaluate(el => el.matches(':focus-visible')), true);
  await page.locator('.content__card-link').nth(1).click();
  assert.equal(await page.locator('.content__card-link_current').getAttribute('id'), '2');
  assert.match(await page.locator('video').getAttribute('src') ?? '', /video-2\.mp4$/);
  await page.waitForFunction(() => !!document.querySelector('video')?.oncanplaythrough);
  await page.locator('video').dispatchEvent('canplaythrough');
  await page.getByRole('button', { name: 'Показать еще', exact: true }).click();
  await page.locator('.content__card-link').nth(9).waitFor();
  const artifacts = fileURLToPath(new URL('../artifacts/window/', import.meta.url));
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'page.png'), fullPage: true });
  await page.locator('.search-form__textfield').fill('Нет такого города');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await page.locator('.error__title').filter({ hasText: 'Нет подходящих видео' }).waitFor();
  assert.deepEqual(await page.locator('.error').boundingBox(), await page.locator('.result__video-container').boundingBox());
  assert.deepEqual(errors, []);
  console.log('Проверены размеры, переполнение, выбор видео, чекбоксы, клавиатура, пагинация и состояние ошибки.');
} finally { await browser.close(); }
