import type { Page } from 'playwright';
import { allowedUrl, lessonId, safeUrl } from './browser.js';

const limitedPages = new WeakSet<Page>();
export const isCourseLimited = (page: Page): boolean => limitedPages.has(page);

/** Block the request before the next module can receive a reading tick. */
export async function courseBoundary(page: Page, urls: string[]): Promise<{ blockedUrl?: string }> {
  const allowed = new Set(urls.map(lessonId).filter(Boolean));
  const state: { blockedUrl?: string } = {};
  limitedPages.add(page);
  // Client-side routing has no document request. Stop immediately if an
  // unexpected History API transition escapes the selected lesson IDs.
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame() || !allowedUrl(frame.url())) return;
    const id = lessonId(frame.url());
    if (!id || allowed.has(id)) return;
    state.blockedUrl = safeUrl(frame.url());
    void page.close().catch(() => {});
  });
  await page.route('**/*', async route => {
    const request = route.request();
    const id = lessonId(request.url());
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame() || !allowedUrl(request.url()) || !id || allowed.has(id)) {
      await route.fallback(); return;
    }
    state.blockedUrl = safeUrl(request.url());
    await route.abort('blockedbyclient');
    // Closing cancels the current action and any result waits immediately.
    // The runner handles this intentional boundary separately from crashes.
    await page.close();
  });
  return state;
}
