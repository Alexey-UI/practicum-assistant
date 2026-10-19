import type { Page } from 'playwright';
import { allowedUrl, START_URL, navigate, settle, lessonUrl as canonicalLesson } from './browser.js';
import { atomicJson, normalize, readJson } from './store.js';

export interface Lesson { course: string; topic: string; title: string; url: string; solved: boolean; project: boolean; locked?: boolean; observedAt?: string }
const LESSONS = '.course-navigation-lesson';
const TOPICS = '.course-navigation-topic';

export async function readLessons(page: Page, course: string, topic: string): Promise<Lesson[]> {
  const rows = await page.locator(LESSONS).evaluateAll(elements => elements.map(el => ({
    title: el.querySelector('h3')?.textContent ?? el.textContent ?? '',
    url: el.getAttribute('href') ?? el.getAttribute('to') ?? '',
    solved: el.classList.contains('course-navigation-lesson_status_solved'),
    locked: el.classList.contains('course-navigation-lesson_status_disabled'),
  })));
  return rows.filter(row => row.url).map(row => ({ ...row, url: new URL(row.url, START_URL).href })).filter(row => allowedUrl(row.url)).map(row => ({ ...row, title: normalize(row.title), course, topic, project: /проектн|проект:|проект «|финальн.*проект/i.test(`${topic} ${row.title}`) }));
}

export async function catalog(page: Page, courseFilter?: string, outputFile = '.local/catalog.json', resume = false): Promise<Lesson[]> {
  await navigate(page, START_URL);
  await page.getByRole('heading', { name: 'Программа курса', exact: true }).waitFor({ timeout: 120000 });
  const courseCards = page.locator('main button').filter({ has: page.locator('h2') });
  const courses = await courseCards.locator('h2').allTextContents();
  let lessons: Lesson[] = [];
  const selected = courses.filter(c => !courseFilter || c.includes(courseFilter));
  if (!selected.length) throw new Error('Модули по указанному фильтру не найдены');
  let surveyed: string[] = [];
  if (resume) {
    const prior = await readJson<{ courses: string[]; surveyed: string[] } | null>('.local/catalog-index.json', null);
    if (!prior || JSON.stringify(prior.courses) !== JSON.stringify(selected)) throw new Error('Для возобновления нужен каталог тех же модулей');
    surveyed = prior.surveyed;
    lessons = (await readJson<Lesson[]>(outputFile, [])).filter(lesson => surveyed.includes(lesson.course));
  }
  await atomicJson('.local/catalog-index.json', { courses: selected, surveyed, complete: false });
  for (const course of selected) {
    if (surveyed.includes(course)) continue;
    const card = page.locator('main button').filter({ has: page.getByRole('heading', { name: course, exact: true }) });
    await card.click();
    await page.locator(TOPICS).or(page.locator(LESSONS)).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 180000 });
    // A one-topic module opens its lessons directly (for example Introduction).
    if (await page.locator(LESSONS).first().isVisible()) {
      const topicHeading = page.locator('.modal-content h1').filter({ visible: true });
      const topic = await topicHeading.count() ? await topicHeading.last().innerText() : course;
      lessons.push(...await readLessons(page, normalize(course), normalize(topic)));
      await atomicJson(outputFile, lessons);
      console.log(`${course} / ${normalize(topic)}: ${lessons.length} уроков в каталоге`);
    } else {
    const titles = await page.locator(`${TOPICS} h3`).allTextContents();
    for (const topic of titles) {
      // Use observed DOM text rather than accessible-name whitespace around the index span.
      const items = page.locator(TOPICS);
      let index = -1;
      for (let i = 0; i < await items.count(); i++) if ((await items.nth(i).locator('h3').textContent()) === topic) { index = i; break; }
      if (index < 0) throw new Error(`Не найдена тема ${topic}`);
      const item = items.nth(index);
      if (await item.evaluate(el => el.classList.contains('course-navigation-item_status_locked') || el.classList.contains('course-navigation-item_status_disabled'))) continue;
      await item.locator('h3').click();
      await page.locator(LESSONS).first().waitFor({ state: 'visible', timeout: 120000 });
      await settle(page);
      lessons.push(...await readLessons(page, normalize(course), normalize(topic)));
      await atomicJson(outputFile, lessons);
      console.log(`${course} / ${normalize(topic)}: ${lessons.length} уроков в каталоге`);
      await page.getByText('Курс', { exact: true }).filter({ visible: true }).click();
      await page.locator(TOPICS).first().waitFor({ state: 'visible' });
    }
    }
    await page.locator('.modal-content__close').click();
    await page.locator('.modal-content__close').waitFor({ state: 'hidden' });
    surveyed.push(course);
    await atomicJson('.local/catalog-index.json', { courses: selected, surveyed, complete: surveyed.length === selected.length, updatedAt: new Date().toISOString() });
  }
  return lessons;
}

export async function checkCompletion(page: Page, lessonUrl: string): Promise<boolean> {
  lessonUrl = canonicalLesson(lessonUrl);
  const pathname = new URL(lessonUrl).pathname;
  const sidebarRow = page.locator(`.sidebar__lesson[href="${pathname}"]`);
  if (await sidebarRow.count() === 1) {
    try {
      await page.waitForFunction(path => document.querySelector(`.sidebar__lesson[href="${path}"]`)?.classList.contains('sidebar__lesson_status_solved'), pathname, { timeout: 30000 });
      return true;
    } catch { return false; }
  }
  await navigate(page, lessonUrl);
  await page.locator('.sidebar__lesson').first().waitFor({ state: 'attached', timeout: 180000 });
  if (await sidebarRow.count() === 1) return sidebarRow.evaluate(el => el.classList.contains('sidebar__lesson_status_solved'));
  const menu = page.getByRole('button', { name: 'Выбрать тему', exact: true });
  if (!await menu.isVisible()) return false;
  await menu.click();
  try {
    const matching = page.locator(`${LESSONS}[href="${pathname}"]`);
    await matching.waitFor({ state: 'visible', timeout: 30000 });
    return await matching.evaluate(el => el.classList.contains('course-navigation-lesson_status_solved'));
  } finally {
    if (await page.locator('.modal-content__close').isVisible()) await page.locator('.modal-content__close').click();
  }
}

// Refresh only from real solved markers on the loaded platform page.
// Local completion history is deliberately not used to skip a lesson.
export async function observedSolved(page: Page): Promise<Set<string>> {
  const hrefs = await page.locator('.sidebar__lesson.sidebar__lesson_status_solved[href]').evaluateAll(rows => rows.map(row => row.getAttribute('href')!));
  return new Set(hrefs.map(href => new URL(href, START_URL).href).filter(allowedUrl).map(canonicalLesson));
}

export async function saveObservedSolved(urls: Set<string>, file = '.local/catalog.json'): Promise<void> {
  const rows = await readJson<Lesson[]>(file, []);
  let changed = false;
  for (const row of rows) {
    if (urls.has(canonicalLesson(row.url)) && !row.solved) {
      row.solved = true; row.observedAt = new Date().toISOString(); changed = true;
    }
  }
  if (changed) await atomicJson(file, rows);
}
