import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Page } from 'playwright';
import { snapshot, safeUrl } from './browser.js';
import { checkCompletion } from './catalog.js';
import { projectCommand, type Project } from './projects.js';
import { atomicJson, journal, readJson } from './store.js';
import { scrollLesson } from './scroll.js';

const exec = promisify(execFile);
interface Submission { commit: string; phase: 'requested' | 'accepted' | 'complete'; lessonUrl: string; updatedAt?: string }

export async function prepareManualProject(project: Project): Promise<void> {
  if (project.review !== 'teacher' && project.review !== 'self') throw new Error('Проект требует приёмки платформой');
  await projectCommand(['prepare', project.id]);
  await projectCommand(['verify', project.id]);
  await projectCommand(['publish', project.id]);
  const published = await readJson<{ destinationCommit: string } | null>(`.local/projects/${project.id}.published.json`, null);
  if (!published) throw new Error('Нет подтверждения публикации проекта');
  const draft = `.local/hand-ins/${project.id}.json`;
  await atomicJson(draft, {
    project: project.id, phase: project.review === 'self' ? 'self-checked' : 'draft', lessonUrl: project.lessonUrl,
    repository: `https://github.com/${project.destination}`, commit: published.destinationCommit,
    instructions: 'Сверить требования сдачи на странице курса. Личные сведения заполняет пользователь. Документы, формы и сообщения преподавателю автоматически не отправляются.',
    updatedAt: new Date().toISOString(),
  });
  await journal('project-manual-draft', { id: project.id, draft });
  console.log(project.review === 'self' ? `Самопроверка работы завершена: ${draft}. Внешняя приёмка не засчитана.` : `Работа опубликована; сдача преподавателю оставлена локальным черновиком: ${draft}. Приёмка не засчитана.`);
}

async function accepted(page: Page): Promise<boolean> {
  return page.getByText('Задание принято — отличная работа!', { exact: true }).isVisible();
}

async function reviewTab(page: Page): Promise<void> {
  const tab = page.getByRole('tab', { name: 'Ревью', exact: true });
  if (await tab.isVisible()) await tab.click();
  await page.getByText('Github настроен', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 180000 });
}

async function waitCI(page: Page, project: Project, commit: string): Promise<void> {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const { stdout } = await exec('gh', ['run', 'list', '--repo', project.destination, '--commit', commit, '--limit', '20', '--json', 'status,conclusion,headSha'], { timeout: 90000 });
    const runs = JSON.parse(stdout) as Array<{ status: string; conclusion: string; headSha: string }>;
    const current = runs.filter(run => run.headSha === commit);
    if (current.some(run => run.status === 'completed' && run.conclusion !== 'success')) throw new Error('Официальная проверка GitHub не прошла. Нужен разбор журнала.');
    if (current.length && current.every(run => run.status === 'completed' && run.conclusion === 'success')) return;
    console.log('Жду официальные тесты GitHub…');
    await page.waitForTimeout(15000);
  }
  throw new Error('Официальные тесты не завершились за 10 минут; отправка отложена.');
}

export async function submitProject(page: Page, project: Project): Promise<boolean> {
  if (project.review === 'teacher' || project.review === 'self') throw new Error('У проекта нет автоматической приёмки');
  const file = `.local/submissions/${project.id}.json`;
  let pending = await readJson<Submission | null>(file, null);
  const pathname = new URL(project.lessonUrl).pathname;
  const solved = page.locator(`.sidebar__lesson_status_solved[href="${pathname}"]`);
  if (await solved.count()) {
    await atomicJson(file, { ...pending, commit: pending?.commit ?? '', phase: 'complete', lessonUrl: project.lessonUrl, updatedAt: new Date().toISOString() });
    return true;
  }

  // Check the existing result before preparing files or attempting another submission.
  await reviewTab(page);
  if (!await accepted(page) && !pending) {
    await page.getByRole('tab', { name: 'Задание', exact: true }).click();
    await projectCommand(['prepare', project.id]);
    await projectCommand(['verify', project.id]);
    await projectCommand(['publish', project.id]);
    const published = await readJson<{ destinationCommit: string } | null>(`.local/projects/${project.id}.published.json`, null);
    if (!published) throw new Error('Нет подтверждения публикации проекта');
    await waitCI(page, project, published.destinationCommit);
    await scrollLesson(page);
    const readiness = page.locator('form.quiz:has(.quiz-form-choice_display-logic_quiz)');
    if (await readiness.count() === 1 && !await readiness.evaluate(el => el.classList.contains('quiz_answered'))) {
      const yes = readiness.locator('label').filter({ has: page.getByText('Да', { exact: true }) });
      await yes.click();
      await readiness.getByRole('button', { name: 'Узнать ответ', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('form.quiz:has(.quiz-form-choice_display-logic_quiz)')?.classList.contains('quiz_answered'), undefined, { timeout: 120000 });
    }
    pending = { commit: published.destinationCommit, phase: 'requested', lessonUrl: project.lessonUrl, updatedAt: new Date().toISOString() };
    // Write intent first. After a lost response, a restart only inspects the existing check.
    await atomicJson(file, pending);
    await journal('project-submit-requested', { id: project.id, commit: published.destinationCommit });
    await page.getByRole('button', { name: 'Проверить задание', exact: true }).click();
    await reviewTab(page);
  }

  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    if (await accepted(page)) {
      const state: Submission = { ...pending, commit: pending?.commit ?? '', phase: 'accepted', lessonUrl: project.lessonUrl, updatedAt: new Date().toISOString() };
      await atomicJson(file, state);
      await journal('project-accepted', { id: project.id, url: safeUrl(page.url()) });
      const forward = page.getByRole('button', { name: 'Вперёд', exact: true });
      if (await forward.isVisible() && await forward.isEnabled()) {
        const before = page.url();
        await forward.click();
        await page.waitForURL(url => url.href !== before, { waitUntil: 'commit', timeout: 180000 });
      }
      if (await checkCompletion(page, project.lessonUrl)) {
        await atomicJson(file, { ...state, phase: 'complete', updatedAt: new Date().toISOString() });
        return true;
      }
      console.log(`Работа принята, но галочка урока пока не подтверждена: ${await snapshot(page, 'project-accepted')}`);
      return false;
    }
    console.log('Жду результат проверки Практикума…');
    await page.waitForTimeout(5000);
  }
  console.log(`Состояние отправки сохранено; повторной отправки не было: ${await snapshot(page, 'project-pending')}`);
  return false;
}
