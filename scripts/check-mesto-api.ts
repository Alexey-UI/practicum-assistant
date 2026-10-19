import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serveProject } from './project-server.js';

const root = path.resolve(process.argv[2] ?? 'workspaces/mesto-ad');
const server = await serveProject(path.join(root, 'dist'));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const photo = await readFile(path.join(root, 'src/images/avatar.jpg'));
  const me = { _id: 'user-own', name: 'Анна-Мария', about: 'Путешественник', avatar: 'https://example.test/avatar.jpg', cohort: 'test-group' };
  const other = { ...me, _id: 'user-other', name: 'Другой автор' };
  let cards = [
    { _id: 'card-own', name: 'Родной город', link: 'https://example.test/city.jpg', owner: me, likes: [other], createdAt: '2026-10-18T12:00:00.000Z' },
    { _id: 'card-other', name: 'Чужая карточка', link: 'https://example.test/lake.jpg', owner: other, likes: [me], createdAt: '2026-10-17T12:00:00.000Z' },
  ];
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  let failNext = '';
  let gatedPath = '';
  let release: (() => void) | undefined;
  await page.route('https://mesto.nomoreparties.co/**', async route => {
    const request = route.request();
    const endpoint = new URL(request.url()).pathname.replace('/v1/test-group', '');
    const method = request.method();
    requests.push({ path: endpoint, method, body: request.postDataJSON() });
    assert.equal(request.headers()['authorization'], 'test-only-fixture');
    if (new URL(request.url()).pathname.startsWith('/v1/denied-group/')) {
      await route.fulfill({ status: 401, json: { message: 'Invalid credentials' } }); return;
    }
    if (endpoint === gatedPath) await new Promise<void>(resolve => { release = resolve; });
    if (failNext === `${method} ${endpoint}`) {
      failNext = '';
      await route.fulfill({ status: 503, json: { message: 'Unavailable' } }); return;
    }
    let result: unknown;
    if (endpoint === '/users/me' && method === 'GET') result = me;
    else if (endpoint === '/users/me' && method === 'PATCH') { Object.assign(me, request.postDataJSON()); result = me; }
    else if (endpoint === '/users/me/avatar' && method === 'PATCH') { Object.assign(me, request.postDataJSON()); result = me; }
    else if (endpoint === '/cards' && method === 'GET') result = cards;
    else if (endpoint === '/cards' && method === 'POST') {
      result = { _id: 'card-new', ...request.postDataJSON(), owner: me, likes: [], createdAt: '2026-10-19T12:00:00.000Z' };
      cards.unshift(result as typeof cards[number]);
    } else if (endpoint.startsWith('/cards/likes/')) {
      const card = cards.find(card => card._id === endpoint.split('/').at(-1))!;
      card.likes = method === 'PUT' ? [...card.likes, me] : card.likes.filter(user => user._id !== me._id);
      result = card;
    } else if (endpoint.startsWith('/cards/') && method === 'DELETE') {
      cards = cards.filter(card => card._id !== endpoint.split('/').at(-1)); result = { message: 'Пост удалён' };
    } else throw new Error(`Unexpected endpoint: ${method} ${endpoint}`);
    await route.fulfill({ json: result });
  });
  await page.route('https://example.test/**', route => route.fulfill({ contentType: 'image/jpeg', body: photo }));
  await page.goto(server.url);
  const connection = page.locator('.connection-dialog');
  await connection.waitFor({ state: 'visible' });
  assert.equal(requests.length, 0, 'An empty connection must never send requests');
  assert.equal(await page.locator('.profile__title').textContent(), '');
  assert.equal(await page.locator('.profile__image').getAttribute('style'), null);
  await connection.locator('[name=cohort]').fill('test-group');
  await connection.locator('[name=token]').fill('test-only-fixture');
  await connection.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await connection.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.card').count(), 2);
  assert.equal(await page.locator('.profile__title').textContent(), me.name);
  const own = page.locator('.card').filter({ has: page.locator('.card__title', { hasText: 'Родной город' }) });
  const foreign = page.locator('.card').filter({ has: page.locator('.card__title', { hasText: 'Чужая карточка' }) });
  assert.equal(await own.locator('.card__control-button_type_delete').count(), 1);
  assert.equal(await foreign.locator('.card__control-button_type_delete').count(), 0);
  assert.equal(await foreign.locator('.card__like-button_is-active').count(), 1);
  await page.getByRole('button', { name: 'Подключение', exact: true }).click();
  await connection.locator('[name=cohort]').fill('denied-group');
  await connection.locator('[name=token]').fill('test-only-fixture');
  await connection.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector('.connection-error')?.textContent);
  assert.equal(await page.locator('.profile__title').textContent(), 'Анна-Мария');
  await page.keyboard.press('Escape');
  await connection.waitFor({ state: 'hidden' });
  // Subsequent updates must still use the previous successfully connected group.
  const edit = page.locator('.popup_type_edit');
  await page.getByRole('button', { name: 'Редактировать профиль', exact: true }).click();
  const profileSubmit = edit.locator('button[type=submit]');
  assert.equal(await profileSubmit.isDisabled(), true);
  await edit.locator('#user-name').fill('Новое имя');
  gatedPath = '/users/me';
  await profileSubmit.click();
  await page.waitForFunction(() => document.querySelector('.popup_type_edit button[type=submit]')?.textContent === 'Сохранение…');
  assert.equal(await profileSubmit.isDisabled(), true);
  assert.equal(await edit.locator('#user-name').isDisabled(), true);
  assert.equal(await page.locator('.profile__title').textContent(), 'Анна-Мария');
  while (!release) await page.waitForTimeout(10);
  gatedPath = ''; release(); release = undefined;
  await edit.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.profile__title').textContent(), 'Новое имя');
  assert.equal(requests.filter(request => request.method === 'PATCH' && request.path === '/users/me').length, 1);
  await page.getByRole('button', { name: 'Редактировать профиль', exact: true }).click();
  await edit.locator('#user-name').fill('Несохранённое имя');
  failNext = 'PATCH /users/me';
  await profileSubmit.click();
  await page.waitForFunction(() => !!document.querySelector('.popup_type_edit .popup__request-error')?.textContent);
  assert.equal(await page.locator('.profile__title').textContent(), 'Новое имя');
  assert.equal(await edit.locator('#user-name').inputValue(), 'Несохранённое имя');
  assert.equal((await profileSubmit.innerText()).trim(), 'Сохранить');
  assert.equal(await profileSubmit.isEnabled(), true);
  await page.keyboard.press('Escape');
  await edit.waitFor({ state: 'hidden' });
  const cardPopup = page.locator('.popup_type_new-card');
  await page.getByRole('button', { name: 'Добавить карточку', exact: true }).click();
  await cardPopup.locator('#place-name').fill('Новое место');
  await cardPopup.locator('#place-link').fill('https://example.test/new.jpg');
  await cardPopup.locator('button[type=submit]').click();
  await cardPopup.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.card').count(), 3);
  assert.equal(await page.locator('.card__title').first().textContent(), 'Новое место');
  const first = page.locator('.card').first();
  failNext = 'PUT /cards/likes/card-new';
  await first.getByRole('button', { name: 'Нравится', exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector('.request-status')?.textContent);
  assert.equal(await first.locator('.card__like-count').textContent(), '0');
  assert.equal(await first.locator('.card__like-button_is-active').count(), 0);
  await first.getByRole('button', { name: 'Нравится', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.card__like-count')?.textContent === '1');
  assert.equal(await first.locator('.card__like-button_is-active').count(), 1);
  await first.getByRole('button', { name: 'Нравится', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.card__like-count')?.textContent === '0');
  await first.getByRole('button', { name: 'Информация о карточке', exact: true }).click();
  const info = page.locator('.popup_type_info');
  await info.waitFor({ state: 'visible' });
  assert.match(await info.innerText(), /Новое место/);
  assert.match(await info.innerText(), /19 октября 2026/);
  assert.ok(requests.filter(request => request.path === '/cards' && request.method === 'GET').length >= 2, 'Card statistics must refresh data from API');
  await page.keyboard.press('Escape');
  await info.waitFor({ state: 'hidden' });
  failNext = 'DELETE /cards/card-new';
  await first.getByRole('button', { name: 'Удалить карточку', exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector('.request-status')?.textContent);
  assert.equal(await page.locator('.card').count(), 3);
  await first.getByRole('button', { name: 'Удалить карточку', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 2);
  await page.locator('.profile__image').click();
  const avatar = page.locator('.popup_type_edit-avatar');
  await avatar.locator('#user-avatar').fill('https://example.test/updated.jpg');
  await avatar.locator('button[type=submit]').click();
  await avatar.waitFor({ state: 'hidden' });
  assert.match(await page.locator('.profile__image').getAttribute('style') ?? '', /updated.jpg/);
  await page.reload();
  await page.locator('.card').nth(1).waitFor();
  assert.equal(await connection.isVisible(), false);
  assert.equal(await page.locator('.profile__title').textContent(), 'Новое имя');
  assert.equal(await page.locator('.card').count(), 2);
  assert.deepEqual(errors, []);
  const artifacts = fileURLToPath(new URL('../artifacts/mesto-api-local/', import.meta.url));
  await mkdir(artifacts, { recursive: true });
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    assert.equal(await page.locator('.connection-button').evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)');
    await page.screenshot({ path: path.join(artifacts, `${width}.png`), fullPage: true, animations: 'disabled' });
  }
  console.log('Mesto API (имитация): подключение без встроенного токена, загрузка пользователя и карточек, ожидание ответа, ошибки без потери ввода, лайки/счётчики, удаление только своих карточек, аватар, актуальная статистика, перезагрузка и 3 ширины проверены. Реальный сервер не проверялся.');
} finally { await browser.close(); await server.close(); }
