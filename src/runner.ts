import { openBrowser, navigate, snapshot, settle, safeUrl, lessonId, isTrainerTaskUrl, lessonUrl as canonicalLesson, waitLessonReady } from './browser.js';
import { catalog, checkCompletion, observedSolved, saveObservedSolved, type Lesson } from './catalog.js';
import { loadConfig } from './config.js';
import { captureChoiceAnswer, exactButton, quizOutcome, solveQuiz } from './quiz.js';
import { scrollLesson } from './scroll.js';
import { loadProjects } from './projects.js';
import { prepareManualProject, submitProject } from './submission.js';
import { solveTrainer, captureTrainerHint } from './trainer.js';
import { gradedSandboxIndices, solveInline } from './inline.js';
import { captureMatching, solveMatching } from './matching.js';
import { solveTextQuestion, captureTextAnswer } from './text-quiz.js';
import { solveFeedback } from './feedback.js';
import type { BrowserContext, Page, Locator } from 'playwright';
import type { Config } from './config.js';
import { atomicJson, journal, lockRun, readJson } from './store.js';
import { UnexpectedBrowserClosure, withBrowserRecovery } from './recovery.js';
import { setTimeout as delay } from 'node:timers/promises';

function pause(message: string): void { console.log(message); process.exitCode = 2; }

async function waitReadyOrDefer(page: Page, lesson: Lesson): Promise<boolean> {
  try { await waitLessonReady(page); return true; }
  catch (error) {
    if (page.isClosed()) throw error;
    const artifacts = await snapshot(page, 'lesson-unavailable');
    const failures = await readJson<Record<string, unknown>>('.local/unavailable-lessons.json', {});
    failures[canonicalLesson(lesson.url)] = { title: lesson.title, failedUrl: safeUrl(page.url()), artifacts, observedAt: new Date().toISOString() };
    await atomicJson('.local/unavailable-lessons.json', failures);
    await journal('lesson-unavailable', { url: canonicalLesson(lesson.url), failedUrl: safeUrl(page.url()), artifacts });
    console.log(`Урок не загрузился после повторных чтений, прохождение не засчитано: ${artifacts}`);
    return false;
  }
}

async function inlineStep(page: Page, research: boolean): Promise<boolean> {
  for (const index of await gradedSandboxIndices(page)) {
    if (await solveInline(page, index)) continue;
    if (!research) return false;
    const pending = await readJson<{ id: string }>('.local/pending-inline.json', { id: '' });
    if (!/^[a-f0-9]{64}$/.test(pending.id)) return false;
    const file = `.local/inline-solutions/${pending.id}.json`;
    console.log(`Исследование встроенного упражнения: .local/pending-inline.json. Ожидаю решение: ${file}`);
    let attempted = '';
    let solved = false;
    const deadline = Date.now() + 1800000;
    while (Date.now() < deadline) {
      const candidate = await readJson<unknown>(file, null);
      const signature = JSON.stringify(candidate);
      if (candidate && signature !== attempted) {
        attempted = signature;
        if (await solveInline(page, index, true)) { solved = true; break; }
        console.log(`Встроенная проверка требует разбора: ${await snapshot(page, 'inline-review')}`);
      }
      await page.waitForTimeout(2000);
    }
    if (!solved) return false;
  }
  return true;
}

async function trainerStep(page: Page, research: boolean): Promise<'advanced' | 'finished' | 'pending'> {
  const result = await solveTrainer(page);
  if (result !== 'pending' || !research) return result;
  const pending = await readJson<{ taskId: string } | null>('.local/pending-task.json', null);
  if (!pending || !/^[a-f0-9-]+$/.test(pending.taskId)) return 'pending';
  await captureTrainerHint(page, pending.taskId);
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
  const text = await root.evaluate(el => el.classList.contains('quiz_type_text'));
  const solve = () => text ? solveTextQuestion(page, root) : matching ? solveMatching(page, root, cfg) : solveQuiz(page, root, cfg);
  if (await solve()) return true;
  if (!research) return false;
  const pendingFile = text ? '.local/pending-text-question.json' : matching ? '.local/pending-matching.json' : '.local/pending-question.json';
  const decisionsFile = text ? '.local/text-decisions.json' : matching ? '.local/matching-decisions.json' : '.local/decisions.json';
  const pending = await readJson<{ key?: string; quizId?: string; id?: string } | null>(pendingFile, null);
  if (!pending) return false;
  const key = pending.key ?? pending.quizId ?? pending.id!;
  console.log(`Снимок вопроса: ${await snapshot(page, 'pending-question')}`);
  console.log(`Исследование вопроса: ${pendingFile}. Ожидаю ответ в ${decisionsFile}: ${key}`);
  let attempted = '';
  const deadline = Date.now() + 1800000;
  while (Date.now() < deadline) {
    const decisions = await readJson<Record<string, unknown>>(decisionsFile, {});
    const decision = decisions[key];
    const signature = JSON.stringify(decision);
    if (decision && signature !== attempted) {
      attempted = signature;
      if (await (text ? solveTextQuestion(page, root) : matching ? solveMatching(page, root, cfg) : solveQuiz(page, root, { ...cfg, retryableLessons: [...cfg.retryableLessons, new URL(page.url()).pathname] }))) return true;
      console.log(`Ответ требует разбора: ${await snapshot(page, 'question-review')}`);
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

export async function run(): Promise<void> {
  await withBrowserRecovery(runAttempt, async (error, attempt) => {
    await journal('browser-restart', { attempt, url: error.url });
    console.log(`Браузер неожиданно закрылся. Возобновляю обход из сохранённого состояния (${attempt}/2): ${error.url ?? 'адрес ещё не определён'}`);
    await delay(1000);
  });
}

async function runAttempt(): Promise<void> {
  const cfg = await loadConfig();
  const unlock = await lockRun();
  let context: BrowserContext | undefined;
  let activePage: Page | undefined;
  let crashed = false;
  let stopping = false;
  const stop = () => { stopping = true; void context?.close().catch(() => {}); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    context = await openBrowser(!process.argv.includes('--headed'), { signalsManagedByCaller: true });
    if (stopping) return;
    const page = context.pages()[0] ?? await context.newPage();
    activePage = page;
    page.on('crash', () => { crashed = true; });
    const args = process.argv.slice(3);
    const urlFlag = args.indexOf('--url');
    const courseFlag = args.indexOf('--course');
    const course = courseFlag >= 0 ? args[courseFlag + 1] : undefined;
    const onlyProjects = args.includes('--projects-first');
    const research = args.includes('--research');
    const auditInline = args.includes('--audit-inline');
    const projects = await loadProjects();
    const skippedProjects = args.flatMap((arg, index) => arg === '--skip-project' ? [args[index + 1]] : []);
    if (skippedProjects.some(id => !projects.some(project => project.id === id))) throw new Error('Для --skip-project нужен известный ID проекта');
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
    const unavailable = args.includes('--skip-unavailable') ? await readJson<Record<string, unknown>>('.local/unavailable-lessons.json', {}) : {};
    for (const lesson of lessons) {
      if (unavailable[canonicalLesson(lesson.url)]) { console.log(`Временно недоступный урок отложен: ${lesson.title}`); continue; }
      const skipped = projects.find(project => skippedProjects.includes(project.id) && canonicalLesson(project.lessonUrl) === canonicalLesson(lesson.url));
      if (skipped) {
        console.log(`Проект временно отложен: ${skipped.title}. Прохождение не засчитано.`);
        await journal('project-deferred', { id: skipped.id, url: lesson.url });
        continue;
      }
      if (lesson.locked) { await journal('lesson-locked', { url: lesson.url, title: lesson.title }); continue; }
      // Catalog is authoritative; local history alone never makes a lesson solved.
      if (lesson.solved && !auditInline) continue;
      if (auditInline && !lesson.solved && urlFlag < 0) continue;
      console.log(`Открываю: ${lesson.title}`);
      await navigate(page, lesson.url);
      const titleNode = page.locator('h1').filter({ hasText: /\S/, visible: true });
      const taskTab = page.getByRole('tab', { name: 'Задание', exact: true });
      const editor = page.getByRole('textbox', { name: 'Содержимое редактора', exact: true });
      if (!await waitReadyOrDefer(page, lesson)) continue;
      await journal('lesson-open', { url: safeUrl(page.url()), title: lesson.title });
      const observed = await observedSolved(page);
      await saveObservedSolved(observed);
      for (const row of lessons) if (observed.has(canonicalLesson(row.url))) row.solved = true;
      if (auditInline) {
        await scrollLesson(page);
        if (!await inlineStep(page, research)) { pause(`Нужен разбор встроенного упражнения. ${await snapshot(page, 'inline-pending')}`); return; }
        const exercises = await gradedSandboxIndices(page);
        await atomicJson(`.local/inline-audits/${lessonId(lesson.url)}.json`, { url: canonicalLesson(lesson.url), checkedAt: new Date().toISOString(), exercises: exercises.length });
        await journal('inline-lesson-audited', { url: canonicalLesson(lesson.url), exercises: exercises.length });
        continue;
      }
      if (observed.has(canonicalLesson(lesson.url))) {
        const project = projects.find(project => (!project.review || project.review === 'platform') && canonicalLesson(project.lessonUrl) === canonicalLesson(lesson.url));
        if (project) await submitProject(page, project);
        await journal('lesson-already-solved', { url: canonicalLesson(lesson.url) });
        continue;
      }

      const heading = await titleNode.count() ? await titleNode.first().innerText() : await page.title();
      const knownProject = projects.find(project => canonicalLesson(project.lessonUrl) === canonicalLesson(lesson.url));
      if (knownProject?.review === 'self') await prepareManualProject(knownProject);
      if (knownProject?.review !== 'self' && (knownProject || /сдача (?:итогового проекта|проектной работы)/i.test(heading) || await taskTab.isVisible())) {
        const project = (await loadProjects()).find(project => new URL(project.lessonUrl).pathname === new URL(page.url()).pathname);
        if (project) {
          if (project.review === 'teacher') {
            await prepareManualProject(project);
            continue;
          }
          if (await submitProject(page, project)) {
            verified[safeUrl(lesson.url)] = new Date().toISOString();
            await atomicJson('.local/completed.json', verified);
            await saveObservedSolved(new Set([canonicalLesson(lesson.url)]));
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
      let deferred = false;
      for (let step = 0; step < cfg.maxSteps; step++) {
        if (isTrainerTaskUrl(page.url())) {
          if (!await waitReadyOrDefer(page, lesson)) { deferred = true; break; }
          const result = await trainerStep(page, research);
          if (result === 'pending') {
            pause(`Нужен разбор задания тренажёра. ${await snapshot(page, 'trainer')}`); return;
          }
          if (result === 'advanced') continue;
          if (await checkCompletion(page, lesson.url)) {
            verified[canonicalLesson(lesson.url)] = new Date().toISOString();
            await atomicJson('.local/completed.json', verified);
            await saveObservedSolved(new Set([canonicalLesson(lesson.url)]));
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
            await captureChoiceAnswer(root, cfg);
            if (await root.locator('.quiz-form-matching').count()) await captureMatching(root, cfg);
            if (await root.evaluate(el => el.classList.contains('quiz_type_text'))) await captureTextAnswer(root);
            continue;
          }
          if (!await questionStep(page, root, cfg, research)) {
            if (cfg.feedbackPolicy === 'neutral' && await root.evaluate(el => el.classList.contains('quiz_type_feedback'))) {
              const artifacts = await snapshot(page, 'feedback-deferred');
              const pending = await readJson<Record<string, unknown>>('.local/deferred-lessons.json', {});
              pending[canonicalLesson(lesson.url)] = { reason: 'Опрос требует свободного отзыва или не имеет однозначного нейтрального ответа', artifacts, observedAt: new Date().toISOString() };
              await atomicJson('.local/deferred-lessons.json', pending);
              await journal('feedback-deferred', { url: canonicalLesson(lesson.url), artifacts });
              console.log(`Опрос оставлен незавершённым, остальные уроки продолжатся: ${artifacts}`);
              deferred = true; break;
            }
            pause(`Нужен разбор вопроса. ${await snapshot(page, 'question')}`); return;
          }
          answeredQuestion = true; break;
        }
        if (deferred) break;
        if (answeredQuestion) continue;
        if (!await inlineStep(page, research)) { pause(`Нужен разбор встроенного упражнения. ${await snapshot(page, 'inline-pending')}`); return; }
        await atomicJson(`.local/lessons/${lessonId(lesson.url) ?? 'unknown'}.json`, {
          url: safeUrl(lesson.url), title: lesson.title, text: await page.locator('body').innerText(),
          links: await page.locator('.theory-viewer a[href]').evaluateAll(links => links.map(el => ({ text: el.textContent, url: (el as HTMLAnchorElement).href }))),
          images: await page.locator('.theory-viewer img[src]').evaluateAll(images => images.map(el => ({ alt: el.getAttribute('alt'), url: (el as HTMLImageElement).src }))),
          embeds: await page.locator('.theory-viewer iframe[src]').evaluateAll(frames => frames.map(frame => (frame as HTMLIFrameElement).src)),
        });
        const nextControl = page.locator('[data-test-id="next-lesson-control-button"]').filter({ visible: true });
        const next = await nextControl.count() === 1 && await nextControl.isEnabled() ? nextControl : await exactButton(page, cfg.nextButtons);
        if (next) {
          const previous = page.url();
          await next.click();
          await page.waitForURL(url => url.href !== previous, { waitUntil: 'commit', timeout: 180000 });
          await journal('lesson-navigation-observed', { from: safeUrl(previous), url: safeUrl(page.url()) });
          const destination = lessons.find(row => lessonId(row.url) === lessonId(page.url())) ?? lesson;
          if (!await waitReadyOrDefer(page, destination)) { deferred = true; break; }
          await settle(page);
          await journal('lesson-transition', { from: safeUrl(previous), url: safeUrl(page.url()) });
          if (lessonId(page.url()) === lessonId(lesson.url)) {
            await journal('task-open', { url: safeUrl(page.url()) });
            continue;
          }
          // Check the observed lesson status after the transition; URL change is not success.
          if (await checkCompletion(page, lesson.url)) {
            verified[canonicalLesson(lesson.url)] = new Date().toISOString();
            await atomicJson('.local/completed.json', verified);
            await saveObservedSolved(new Set([canonicalLesson(lesson.url)]));
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
      if (!completed && !deferred) throw new Error('Достигнут лимит шагов урока');
    }
    console.log('Обход выбранных уроков завершён.');
  } catch (error) {
    if (stopping) { console.log('Проходчик остановлен; состояние сохранено.'); return; }
    if (context && (crashed || activePage?.isClosed() || context.browser()?.isConnected() === false)) {
      throw new UnexpectedBrowserClosure(activePage ? safeUrl(activePage.url()) : undefined, error);
    }
    if (activePage && !activePage.isClosed()) {
      try { console.log(`Диагностика ошибки: ${await snapshot(activePage, 'error')}`); } catch { /* Preserve the original error. */ }
    }
    throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try { await context?.close(); } finally { await unlock(); }
  }
}
