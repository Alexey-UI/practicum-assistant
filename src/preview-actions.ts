import type { Locator, Page } from 'playwright';
import { isTrainerTaskUrl } from './browser.js';
import { practiceFrames } from './practice.js';
import { atomicJson, journal } from './store.js';

export type PreviewAction =
  | { action: 'fill'; selector: string; value: string }
  | { action: 'click'; selector: string; expectAlert?: string };

export async function runPreviewActions(page: Page, taskId: string, actions: PreviewAction[]): Promise<void> {
  const currentTask = () => isTrainerTaskUrl(page.url()) && new URL(page.url()).pathname.match(/\/task\/([^/]+)\//)?.[1] === taskId;
  if (!/^[a-f0-9-]+$/.test(taskId) || !currentTask() || !Array.isArray(actions) || actions.length < 1 || actions.length > 12) throw new Error('Неверный сценарий учебного предпросмотра');
  for (const action of actions) {
    if (!action.selector?.trim() || action.selector.length > 300 || !['fill', 'click'].includes(action.action)) throw new Error('Неверное действие учебного предпросмотра');
    if (action.action === 'fill' && (typeof action.value !== 'string' || action.value.length > 2000)) throw new Error('Неверный ввод учебного предпросмотра');
    if (action.action === 'click' && action.expectAlert !== undefined && (typeof action.expectAlert !== 'string' || !action.expectAlert || action.expectAlert.length > 500)) throw new Error('Неверное ожидаемое сообщение');
  }
  const alerts: string[] = [];
  const expected = actions.flatMap(action => action.action === 'click' && action.expectAlert ? [action.expectAlert] : []);
  const observe = (dialog: import('playwright').Dialog) => {
    if (currentTask() && dialog.type() === 'alert' && expected.includes(dialog.message())) alerts.push(dialog.message());
  };
  const target = async (selector: string): Promise<Locator> => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const matches: Locator[] = [];
      for (const frame of await practiceFrames(page)) {
        if (new URL(frame.url()).hostname !== 'feynman.praktikum.yandex.net') continue;
        const element = frame.locator(selector);
        const count = await element.count();
        if (count > 1) throw new Error('Неоднозначный элемент учебного предпросмотра');
        if (count === 1 && await element.isVisible()) matches.push(element);
      }
      if (matches.length > 1) throw new Error('Элемент встречается в нескольких фреймах');
      if (matches.length === 1) return matches[0];
      await page.waitForTimeout(250);
    }
    throw new Error('Элемент учебного предпросмотра не появился');
  };
  page.on('dialog', observe);
  try {
    const refresh = page.getByRole('button', { name: 'Обновить', exact: true });
    if (await refresh.count() !== 1) throw new Error('Нет однозначной кнопки обновления предпросмотра');
    const before = await practiceFrames(page);
    const oldDocument = before.find(frame => frame.parentFrame() === before[0]);
    const oldBody = await oldDocument?.locator('body').elementHandle();
    try {
      await refresh.click();
      const deadline = Date.now() + 120000;
      while (true) {
        const frames = await practiceFrames(page);
        const previewDocument = frames.find(frame => frame.parentFrame() === frames[0]);
        const replaced = !oldBody || !await oldBody.evaluate(element => element.isConnected).catch(() => false);
        if (replaced && previewDocument && new URL(previewDocument.url()).hostname === 'feynman.praktikum.yandex.net' && await previewDocument.evaluate(() => {
          const base = document.querySelector<HTMLBaseElement>('base[href]');
          return document.readyState === 'complete' && !!base && new URL(base.href).origin === 'https://feynman.praktikum.yandex.net';
        }).catch(() => false)) break;
        if (Date.now() >= deadline) throw new Error('Обновлённый учебный предпросмотр не загрузился');
        await page.waitForTimeout(100);
      }
    } finally { await oldBody?.dispose().catch(() => {}); }
    for (const action of actions) {
      if (!currentTask()) throw new Error('Задание изменилось во время учебного сценария');
      const element = await target(action.selector);
      if (action.action === 'fill') await element.fill(action.value);
      else {
        const start = alerts.length;
        await element.click({ noWaitAfter: true });
        if (action.expectAlert) {
          const deadline = Date.now() + 15000;
          while (!alerts.slice(start).includes(action.expectAlert)) {
            if (Date.now() >= deadline) throw new Error('Ожидаемый учебный alert не появился');
            await page.waitForTimeout(100);
          }
        }
      }
    }
    await atomicJson(`.local/preview-checks/${taskId}.json`, { taskId, steps: actions.length, alerts, verifiedAt: new Date().toISOString() });
    await journal('trainer-preview-verified', { taskId, steps: actions.length, alerts: alerts.length });
  } finally { page.off('dialog', observe); }
}
