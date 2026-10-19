import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { HtmlValidate } from 'html-validate';
import { serveProject } from './project-server.js';

const root = path.resolve(process.argv[2] ?? 'workspaces/zakrivayuschiy-teg-ad');
const markup = await new HtmlValidate({ extends: ['html-validate:recommended'], rules: { 'void-style': 'off', 'doctype-style': 'off', 'svg-focusable': 'off' } }).validateString(await readFile(path.join(root, 'index.html'), 'utf8'));
assert.equal(markup.valid, true, JSON.stringify(markup.results.map(result => result.messages)));
const server = await serveProject(root);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  const artifacts = fileURLToPath(new URL('../artifacts/closing-local/', import.meta.url));
  await mkdir(artifacts, { recursive: true });
  for (const width of [320, 375, 600, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(server.url);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `Overflow at ${width}`);
    assert.equal(await page.locator('.card').count(), 8);
    assert.equal(await page.locator('.like-icon').count(), 8);
    if ([375, 1440].includes(width)) await page.screenshot({ path: path.join(artifacts, `header-${width}.png`) });
    const images = page.locator('.card__image');
    for (let index = 0; index < await images.count(); index++) {
      await images.nth(index).scrollIntoViewIfNeeded();
      await images.nth(index).evaluate(image => (image as HTMLImageElement).decode());
    }
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.card__image')].every(image => image.complete && image.naturalWidth > 0));
    const filters = await page.locator('.card__image').evaluateAll(images => images.map(image => getComputedStyle(image).filter));
    assert.equal(new Set(filters.filter(filter => filter !== 'none')).size, 7);
    assert.ok(filters.some(filter => filter.split(')').length > 3));
    await page.screenshot({ path: path.join(artifacts, `${width}.png`), fullPage: true });
    const beforeDialog = navigations;
    await page.getByRole('button', { name: 'Сохранить на память', exact: true }).click();
    assert.equal(await page.locator('dialog').evaluate(el => el.matches(':modal')), true);
    assert.equal(await page.getByRole('button', { name: 'OK', exact: true }).evaluate(el => el === document.activeElement), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    await page.getByRole('button', { name: 'OK', exact: true }).click();
    assert.equal(await page.locator('dialog').isVisible(), false);
    assert.equal(navigations, beforeDialog, 'Opening and closing the dialog must not reload the page');
  }
  const like = page.locator('.card__like-button').first();
  await like.click();
  await page.waitForFunction(() => document.querySelector('.card__like-button')?.textContent?.trim() === 'Unlike');
  assert.equal(await page.locator('.like-icon.is-liked').count(), 1);
  assert.equal(await page.locator('.like-icon .contour').first().evaluate(el => getComputedStyle(el).fill), 'rgb(255, 0, 0)');
  await page.locator('.card__icon-button').first().click();
  await page.waitForFunction(() => document.querySelector('.card__like-button')?.textContent?.trim() === 'Like');
  assert.equal(await page.locator('.like-icon.is-liked').count(), 0);
  await page.locator('.card__icon-button').first().focus();
  await page.keyboard.press('Tab');
  assert.equal(await like.evaluate(el => el.matches(':focus-visible')), true);
  const save = page.getByRole('button', { name: 'Сохранить на память', exact: true });
  await save.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog').isVisible(), false);
  assert.equal(await save.evaluate(el => el === document.activeElement), true);
  assert.deepEqual(errors, []);
  console.log('Проверены HTML, 8 карточек и фильтры, 6 ширин без переполнения, лайки, клавиатура, модальное окно и возврат фокуса.');
} finally { await browser.close(); await server.close(); }
