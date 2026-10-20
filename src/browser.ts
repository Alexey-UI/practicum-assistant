import { chromium, type BrowserContext, type Page } from 'playwright';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { handleExerciseDialogs } from './exercise-dialogs.js';

export const START_URL = 'https://practicum.yandex.ru/profile/ap-frontend-st/';
export const LOCAL = path.resolve('.local');

export async function openBrowser(headless = true, options: { signalsManagedByCaller?: boolean } = {}): Promise<BrowserContext> {
  await mkdir(LOCAL, { recursive: true, mode: 0o700 });
  await chmod(LOCAL, 0o700);
  const context = await chromium.launchPersistentContext(path.join(LOCAL, 'browser'), {
    channel: 'chrome', headless, viewport: { width: 1440, height: 1000 },
    acceptDownloads: false,
    ...(options.signalsManagedByCaller ? { handleSIGINT: false, handleSIGTERM: false } : {}),
  });
  context.setDefaultTimeout(30000);
  context.setDefaultNavigationTimeout(120000);
  handleExerciseDialogs(context);
  return context;
}

export function allowedUrl(raw: string): boolean {
  try { const url = new URL(raw); return url.protocol === 'https:' && url.hostname === 'practicum.yandex.ru'; }
  catch { return false; }
}

export async function settle(page: Page): Promise<void> {
  // Some course document requests stall before DOMContentLoaded, even when
  // the previous navigation has already committed. Wait for usable DOM instead.
  await page.locator('body').waitFor({ state: 'attached', timeout: 120000 });
  await page.waitForTimeout(900);
}

export async function navigate(page: Page, url: string): Promise<void> {
  if (!allowedUrl(url)) throw new Error('Переход за пределы practicum.yandex.ru запрещён');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 120000 });
      await settle(page); return;
    } catch (error) {
      if (page.isClosed() || attempt === 2) throw error;
      await page.waitForTimeout(2000 * (attempt + 1));
    }
  }
}

export function trainerTextTabs(page: Page) {
  return page.locator('section.tab').filter({
    has: page.locator('article.tab__text').filter({ hasText: /\.(?:html?|css|[cm]?js|jsx|tsx?|json|txt|md|svg)\s*$/i }),
    visible: true,
  });
}

/** Retry only document reads when an authenticated shell has no lesson content. */
export async function waitLessonReady(page: Page, attemptTimeoutMs = 60000): Promise<void> {
  const heading = page.locator('h1').filter({ hasText: /\S/, visible: true });
  const tab = page.getByRole('tab', { name: 'Задание', exact: true });
  const editor = page.getByRole('textbox', { name: 'Содержимое редактора', exact: true });
  const theoryText = page.locator('.theory-viewer .paragraph').filter({ hasText: /\S/, visible: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ready = isTrainerTaskUrl(page.url()) ? editor.or(trainerTextTabs(page)) : heading.or(tab).or(editor).or(theoryText);
      await ready.filter({ visible: true }).first().waitFor({ state: 'visible', timeout: attemptTimeoutMs });
      return;
    } catch (error) {
      if (page.isClosed() || attempt === 2) throw error;
      console.log(`Содержимое урока не загрузилось; повторяю загрузку страницы без отправки ответов: ${safeUrl(page.url())}`);
      await navigate(page, safeUrl(page.url()));
    }
  }
}

export async function snapshot(page: Page, label: string): Promise<string> {
  const dir = path.resolve('artifacts', `${Date.now()}-${label.replace(/[^a-z0-9-]/gi, '-')}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, 'page.txt'), await page.locator('body').innerText(), { mode: 0o600 });
  await writeFile(path.join(dir, 'aria.yml'), await page.locator('body').ariaSnapshot(), { mode: 0o600 });
  await writeFile(path.join(dir, 'location.txt'), safeUrl(page.url()), { mode: 0o600 });
  try { await page.screenshot({ path: path.join(dir, 'page.png'), fullPage: true, timeout: 15000 }); }
  catch { await writeFile(path.join(dir, 'screenshot-unavailable.txt'), 'Снимок экрана не получен за 15 секунд. Текст и ARIA сохранены.'); }
  return dir;
}

export function safeUrl(raw: string): string {
  const url = new URL(raw); return `${url.origin}${url.pathname}`;
}

export function lessonUrl(raw: string): string {
  const url = new URL(raw);
  const match = url.pathname.match(/^(.*\/lessons\/[^/]+\/)/);
  return `${url.origin}${match ? match[1] : url.pathname}`;
}

export function lessonId(raw: string): string | undefined {
  return new URL(raw).pathname.match(/\/(?:lessons|lesson)\/([^/]+)(?:\/|$)/)?.[1];
}

export function isTrainerTaskUrl(raw: string): boolean {
  if (!allowedUrl(raw)) return false;
  const pathname = new URL(raw).pathname;
  return pathname.startsWith('/trainer/') && /\/task\/[^/]+(?:\/|$)/.test(pathname);
}
