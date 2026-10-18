import { chromium } from 'playwright';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { HtmlValidate } from 'html-validate';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(process.argv[2] ?? 'workspaces/slozhno-sosredotochitsya-ad');
// Theme buttons retain the supplied starter markup, including their implicit type.
const validator = new HtmlValidate({ extends: ['html-validate:recommended'], rules: { 'doctype-style': 'off', 'void-style': 'off', 'no-implicit-button-type': 'off' } });
const markup = await validator.validateString(await readFile(path.join(root, 'index.html'), 'utf8'));
assert.equal(markup.valid, true, JSON.stringify(markup.results.map(result => result.messages)));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const artifacts = fileURLToPath(new URL('../artifacts/focus-local/', import.meta.url));
  await mkdir(artifacts, { recursive: true });
  for (const width of [375, 600, 768, 900, 1024, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 668 : 768 });
    await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `Overflow at ${width}`);
    const header = await page.locator('.header').boundingBox();
    assert.equal(header?.height, width < 768 ? 668 : 768);
    if (width === 768) {
      const content = await page.locator('.section__content').first().boundingBox();
      assert.ok(content && Math.abs(content.width - 472) < 1, 'Tablet article width matches design');
    }
    await page.locator('.gallery').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.gallery img')].every(img => img.complete && img.naturalWidth > 0));
    const sunset = await page.locator('.gallery__image_sunset').boundingBox();
    const ice = await page.locator('.gallery__image_ice-cream').boundingBox();
    const books = await page.locator('.gallery__image_books').boundingBox();
    assert.ok(sunset && ice && books);
    if (width >= 768) {
      assert.ok(Math.abs(sunset.y - ice.y) < 1);
      assert.ok(Math.abs(books.y + books.height - ice.y - ice.height) < 1);
      assert.ok(Math.abs(sunset.width / sunset.height - 2.5) < .01);
    } else assert.ok(ice.y >= sunset.y + sunset.height);
    await page.screenshot({ path: path.join(artifacts, `${width}.png`), fullPage: true });
  }
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const [name, dark] of [['День', false], ['Неон', true], ['Авто', colorScheme === 'dark']] as const) {
      const button = page.getByRole('button', { name, exact: true });
      if (await button.isEnabled()) await button.click();
      assert.equal(await button.isDisabled(), true);
      assert.equal(await page.locator('.page').evaluate(el => getComputedStyle(el).backgroundColor), dark ? 'rgb(0, 0, 40)' : 'rgb(255, 241, 247)');
      assert.equal(await page.locator('.header__rec').isVisible(), dark);
      await page.reload();
      assert.equal(await button.isDisabled(), true, 'Theme persists after reload');
    }
  }
  await page.getByRole('button', { name: 'День', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Неон', exact: true }).evaluate(el => el.matches(':focus-visible')), true);
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('button', { name: 'Неон', exact: true }).isDisabled(), true);
  await page.locator('.text-link').first().focus();
  assert.equal(await page.locator('.text-link').first().evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
  assert.deepEqual(errors, []);
  console.log('Проверены 6 ширин, галерея, отсутствие горизонтального скролла, 6 сочетаний тем, сохранение выбора и клавиатура.');
} finally { await browser.close(); }
