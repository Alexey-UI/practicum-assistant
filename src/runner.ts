import { openBrowser, navigate, snapshot, settle, safeUrl, lessonId, lessonUrl as canonicalLesson } from './browser.js';
import { catalog, checkCompletion, type Lesson } from './catalog.js';
import { loadConfig } from './config.js';
import { exactButton, quizOutcome, solveQuiz } from './quiz.js';
import { scrollLesson } from './scroll.js';
import { loadProjects } from './projects.js';
import { submitProject } from './submission.js';
import { solveTrainer } from './trainer.js';
import { captureMatching, solveMatching } from './matching.js';
import { solveFeedback } from './feedback.js';
import type { BrowserContext, Page, Locator } from 'playwright';
import type { Config } from './config.js';
import { atomicJson, journal, lockRun, readJson } from './store.js';

function pause(message: string): void { console.log(message); process.exitCode = 2; }

async function trainerStep(page: Page, research: boolean): Promise<'advanced' | 'finished' | 'pending'> {
  const result = await solveTrainer(page);
  if (result !== 'pending' || !research) return result;
  const pending = await readJson<{ taskId: string } | null>('.local/pending-task.json', null);
  if (!pending || !/^[a-f0-9-]+$/.test(pending.taskId)) return 'pending';
  const candidateFile = `.local/task-solutions/${pending.taskId}.json`;
  console.log(`Исследование тренажёра: .local/pending-task.json. Ожидаю решение: ${candidateFile}`);
  let attempted = '';
  const deadline = Date.now() + 1800000;
  while (Date.now() < deadline) {
    const candidate = await readJson<unknown>(candidateFile, null);
    const signature = JSON.stringify(candidate);
    if (candidate && signature !== attempted) {
      attempted = signature;
      const checked = await solveTrainer(page, true);
      if (checked !== 'pending') return checked;
      console.log(`Результат требует разбора: ${await snapshot(page, 'trainer-review')}`);
    }
    await page.waitForTimeout(2000);
  }
  return 'pending';
}

async function questionStep(page: Page, root: Locator, cfg: Config, research: boolean): Promise<boolean> {
  if (await root.evaluate(el => el.classList.contains('quiz_type_feedback'))) return solveFeedback(page, root, cfg);
  const matching = await root.locator('.quiz-form-matching').count() > 0;
  if (await (matching ? solveMatching(page, root, cfg) : solveQuiz(page, root, cfg))) return true;
  if (!research) return false;
  const pendingFile = matching ? '.local/pending-matching.json' : '.local/pending-question.json';
  const decisionsFile = matching ? '.local/matching-decisions.json' : '.local/decisions.json';
  const pending = await readJson<{ key?: string; quizId?: string } | null>(pendingFile, null);
  if (!pending) return false;
  const key = pending.key ?? pending.quizId!;
  console.log(`Исследование вопроса: ${pendingFile}. Ожидаю ответ в ${decisionsFile}: ${key}`);
  let attempted = '';
  const deadline = Date.now() + 1800000;
  while (Date.now() < deadline) {
    const decisions = await readJson<Record<string, unknown>>(decisionsFile, {});
    const decision = decisions[key];
    const signature = JSON.stringify(decision);
    if (decision && signature !== attempted) {
      attempted = signature;
      if (await (matching ? solveMatching(page, root, cfg) : solveQuiz(page, root, { ...cfg, retryableLessons: [...cfg.retryableLessons, new URL(page.url()).pathname] }))) return true;
      console.log(`Ответ требует разбора: ${await snapshot(page, 'question-review')}`);
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

export async function run(): Promise<void> {
  const cfg = await loadConfig();
  const unlock = await lockRun();
  let context: BrowserContext | undefined;
  let activePage: Page | undefined;
  try {
    context = await openBrowser(!process.argv.includes('--headed'));
    const page = context.pages()[0] ?? await context.newPage();
    activePage = page;
    const args = process.argv.slice(3);
    const urlFlag = args.indexOf('--url');
    const courseFlag = args.indexOf('--course');
    const course = courseFlag >= 0 ? args[courseFlag + 1] : undefined;
    const onlyProjects = args.includes('--projects-first');
    const research = args.includes('--research');
    let lessons: Lesson[];
    if (urlFlag >= 0) {
      lessons = [{ url: args[urlFlag + 1], title: 'Урок по ссылке', course: '', topic: '', solved: false, project: false }];
    } else if (args.includes('--use-catalog')) {
      const index = await readJson<{ complete: boolean } | null>('.local/catalog-index.json', null);
      if (!index?.complete) throw new Error('Для --use-catalog сначала нужен завершённый сбор каталога');
      lessons = await readJson<Lesson[]>('.local/catalog.json', []);
      if (course) lessons = lessons.filter(lesson => lesson.course.includes(course));
      if (onlyProjects) lessons = lessons.filter(lesson => lesson.project);
      if (!lessons.length) throw new Error('В сохранённом каталоге нет подходящих уроков');
    } else {
      lessons = await catalog(page, course, '.local/catalog.json', args.includes('--resume-catalog'));
      if (onlyProjects) lessons = lessons.filter(lesson => lesson.project);
    }
    if (args.includes('--catalog-only')) { console.log('Каталог сохранён в .local/catalog.json'); return; }
    const verified = await readJson<Record<string, string>>('.local/completed.json', {});
    for (const lesson of lessons) {
      if (lesson.locked) { await journal('lesson-locked', { url: lesson.url, title: lesson.title }); continue; }
      // Catalog is authoritative; local history alone never makes a lesson solved.
      if (lesson.solved) continue;
      console.log(`Открываю: ${lesson.title}`);
      await navigate(page, lesson.url);
      const titleNode = page.locator('h1').filter({ hasText: /\S/, visible: true });
      const taskTab = page.getByRole('tab', { name: 'Задание', exact: true });
      const editor = page.getByRole('textbox', { name: 'Содержимое редактора', exact: true });
      await titleNode.or(taskTab).or(editor).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 180000 });
      await journal('lesson-open', { url: safeUrl(page.url()), title: lesson.title });
      const heading = await titleNode.count() ? await titleNode.first().innerText() : await page.title();
      if (/сдача проектной работы/i.test(heading) || await taskTab.isVisible()) {
        const project = (await loadProjects()).find(project => new URL(project.lessonUrl).pathname === new URL(page.url()).pathname);
        if (project) {
          if (await submitProject(page, project)) {
            verified[safeUrl(lesson.url)] = new Date().toISOString();
            await atomicJson('.local/completed.json', verified);
            await journal('lesson-completed', { url: safeUrl(lesson.url), project: project.id });
            continue;
          }
          process.exitCode = 2; return;
        }
        const artifacts = await snapshot(page, 'project');
        await atomicJson('.local/pending-project.json', { ...lesson, artifacts });
        pause(`Проектная работа требует проверенного эталона. Задание: ${artifacts}`);
        return;
      }
      let completed = false;
      for (let step = 0; step < cfg.maxSteps; step++) {
        if (new URL(page.url()).pathname.startsWith('/trainer/')) {
          const result = await trainerStep(page, research);
          if (result === 'pending') {
            pause(`Нужен разбор задания тренажёра. ${await snapshot(page, 'trainer')}`); return;
          }
          if (result === 'advanced') continue;
          if (await checkCompletion(page, lesson.url)) {
            verified[canonicalLesson(lesson.url)] = new Date().toISOString();
            await atomicJson('.local/completed.json', verified);
            await journal('lesson-completed', { url: canonicalLesson(lesson.url), trainer: true });
            completed = true; break;
          }
          pause(`Задания решены, но галочка урока не подтверждена. ${await snapshot(page, 'trainer-unconfirmed')}`); return;
        }
        const scroll = await scrollLesson(page);
        await journal('lesson-scroll', { url: safeUrl(page.url()), ...scroll });
        const roots = page.locator(cfg.questionSelector).filter({ visible: true });
        let answeredQuestion = false;
        for (let i = 0; i < await roots.count(); i++) {
          const root = roots.nth(i);
          if (await quizOutcome(root, cfg) === 'correct') {
            if (await root.locator('.quiz-form-matching').count()) await captureMatching(root, cfg);
            continue;
          }
          if (!await questionStep(page, root, cfg, research)) {
            pause(`Нужен разбор вопроса. ${await snapshot(page, 'question')}`); return;
          }
          answeredQuestion = true; break;
        }
        if (answeredQuestion) continue;
        await atomicJson(`.local/lessons/${lessonId(lesson.url) ?? 'unknown'}.json`, {
          url: safeUrl(lesson.url), title: lesson.title, text: await page.locator('body').innerText(),
          links: await page.locator('.theory-viewer a[href]').evaluateAll(links => links.map(el => ({ text: el.textContent, url: (el as HTMLAnchorElement).href }))),
          images: await page.locator('.theory-viewer img[src]').evaluateAll(images => images.map(el => ({ alt: el.getAttribute('alt'), url: (el as HTMLImageElement).src }))),
        });
        const nextControl = page.locator('[data-test-id="next-lesson-control-button"]').filter({ visible: true });
        const next = await nextControl.count() === 1 && await nextControl.isEnabled() ? nextControl : await exactButton(page, cfg.nextButtons);
        if (next) {
          const previous = page.url();
          const nextLabel = await next.innerText();
          await next.click();
          await page.waitForURL(url => url.href !== previous, { waitUntil: 'commit', timeout: 180000 });
          await settle(page);
          if (/перейти к заданию|к следующему заданию|следующее задание/i.test(nextLabel) && lessonId(page.url()) === lessonId(lesson.url)) {
            await journal('task-open', { url: safeUrl(page.url()) });
            continue;
          }
          // Check the observed lesson status after the transition; URL change is not success.
          if (await checkCompletion(page, lesson.url)) {
            verified[canonicalLesson(lesson.url)] = new Date().toISOString();
            await atomicJson('.local/completed.json', verified);
            await journal('lesson-completed', { url: canonicalLesson(lesson.url) });
            completed = true; break;
          }
          pause(`Переход выполнен, но галочка не подтверждена. ${await snapshot(page, 'unconfirmed')}`); return;
        }
        const expanders = page.locator('.content-expander:not(.content-expander_expanded) .content-expander__button').filter({ visible: true });
        const continuation = await expanders.count() ? expanders.first() : await exactButton(page, cfg.continueButtons);
        if (!continuation) {
          pause(`Нужен новый обработчик интерфейса. ${await snapshot(page, 'unknown')}`); return;
        }
        const before = await page.locator('body').innerText();
        const actionId = await continuation.getAttribute('data-test-id');
        await continuation.click();
        try {
          await page.waitForFunction(({ old, id }) => document.body.innerText !== old || !!(id && document.querySelector(`[data-test-id="${CSS.escape(id)}"]`)?.parentElement?.classList.contains('content-expander_expanded')), { old: before, id: actionId }, { timeout: 120000 });
        } catch {
          pause(`Результат нажатия не подтверждён. ${await snapshot(page, 'unchanged')}`); return;
        }
        await settle(page);
      }
      if (!completed) throw new Error('Достигнут лимит шагов урока');
    }
    console.log('Обход выбранных уроков завершён.');
  } catch (error) {
    if (activePage && !activePage.isClosed()) {
      try { console.log(`Диагностика ошибки: ${await snapshot(activePage, 'error')}`); } catch { /* Preserve the original error. */ }
    }
    throw error;
  } finally {
    try { await context?.close(); } finally { await unlock(); }
  }
}
