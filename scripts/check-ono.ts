import { chromium } from 'playwright';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(process.argv[2] ?? 'workspaces/ono-tebe-nado-ad');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, deviceScaleFactor: 1 });
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('requestfailed', request => failures.push(new URL(request.url()).pathname));
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('html').getAttribute('lang'), 'ru');
  assert.equal(await page.locator('h1').count(), 1);
  assert.equal(await page.locator('main > section').count(), 3);
  assert.equal(await page.locator('header nav').count(), 1);
  assert.equal(await page.locator('footer nav').count(), 1);
  assert.deepEqual(await page.locator('link[rel=stylesheet]').evaluateAll(links => links.map(el => el.getAttribute('href'))), ['./fonts/fonts.css', './styles/global.css', './styles/style.css']);
  assert.equal(await page.locator('img').evaluateAll(imgs => imgs.every(img => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0 && img.hasAttribute('alt'))), true);
  assert.equal(await page.locator('[style]').count(), 0);
  const geometry = await page.locator('header, .cover, .lots, .lots__card-list-item, .about, footer').evaluateAll(elements => elements.map(el => {
    const { x, y, width, height } = el.getBoundingClientRect();
    return { class: el.className, x, y, width, height };
  }));
  for (const width of [1100, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Горизонтальная прокрутка при ${width}px`);
  }
  await page.setViewportSize({ width: 1100, height: 1000 });
  const first = await page.locator('.lots__card-list-item').first().boundingBox();
  const otherCards = await page.locator('.lots__card-list-item').all();
  for (const card of otherCards) {
    const box = await card.boundingBox();
    assert.ok(box && first && Math.abs(box.y - first.y) < 1, 'Карточки должны быть в одном ряду');
    assert.ok(box && box.height >= 596, 'Высота карточки меньше макета');
  }
  await page.locator('.lots__card-list').evaluate(list => list.appendChild(list.children[0].cloneNode(true)));
  const fourth = await page.locator('.lots__card-list-item').nth(3).boundingBox();
  assert.ok(first && fourth && fourth.y > first.y + first.height, 'Четвёртая карточка должна переноситься');
  await page.locator('.lots__card-list-item').nth(3).evaluate(el => el.remove());
  assert.deepEqual(failures, [], 'Ресурсы или скрипты загрузились с ошибкой');
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes('https://github.com/Alexey-UI/ono-tebe-nado-ad'));
  const artifacts = fileURLToPath(new URL('../artifacts/ono/', import.meta.url));
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'page.png'), fullPage: true });
  console.log(JSON.stringify({ status: 'passed', geometry }, null, 2));
} finally { await browser.close(); }
