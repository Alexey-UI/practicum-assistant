import type { Page } from 'playwright';

export interface ScrollOptions { delayMs?: number; maxSteps?: number }

/** Scroll the lesson's own container, including content added by lazy loading. */
export async function scrollLesson(page: Page, options: ScrollOptions = {}): Promise<{ steps: number; end: number }> {
  const delay = options.delayMs ?? 650;
  const maxSteps = options.maxSteps ?? 300;
  let stable = 0;
  let previousHeight = -1;
  for (let steps = 1; steps <= maxSteps; steps++) {
    const position = await page.evaluate(() => {
      const anchor = document.querySelector('.theory-viewer') ?? document.querySelector('.theory-page') ?? document.querySelector('main') ?? document.body;
      let element: Element | null = anchor;
      let container = document.scrollingElement ?? document.documentElement;
      while (element) {
        if (/(auto|scroll)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 2 && element.clientHeight > 100) { container = element; break; }
        element = element.parentElement;
      }
      const viewport = container.clientHeight;
      container.scrollBy({ top: Math.max(200, Math.round(viewport * 0.75)), behavior: 'instant' });
      return { top: container.scrollTop, height: container.scrollHeight, viewport };
    });
    const atEnd = position.top + position.viewport >= position.height - 3;
    stable = atEnd && position.height === previousHeight ? stable + 1 : 0;
    previousHeight = position.height;
    if (stable >= 2) return { steps, end: position.top };
    await page.waitForTimeout(delay);
  }
  throw new Error('Урок продолжает расти при прокрутке или достигнут лимит шагов');
}
