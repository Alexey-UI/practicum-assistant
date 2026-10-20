import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Page } from 'playwright';
import { snapshot, safeUrl } from './browser.js';
import { checkCompletion } from './catalog.js';
import { projectCommand, type Project } from './projects.js';
import { atomicJson, journal, readJson } from './store.js';
import { scrollLesson } from './scroll.js';
import { closingReferenceVerified, knownClosingCheckerFailure, type PublishedProject } from './ci.js';
import { hasProjectAcceptance, PROJECT_ACCEPTED_MESSAGE, type Submission } from './project-acceptance.js';

const exec = promisify(execFile);

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
    verification: project.verification ?? 'local', requiresLiveApiCheck: project.verification === 'mock-api',
    instructions: 'Сверить требования сдачи на странице курса. Личные сведения заполняет пользователь. Документы, формы и сообщения преподавателю автоматически не отправляются.',
    updatedAt: new Date().toISOString(),
  });
  await journal('project-manual-draft', { id: project.id, draft });
  console.log(project.review === 'self' ? `Самопроверка работы завершена: ${draft}. Внешняя приёмка не засчитана.` : `Работа опубликована; сдача преподавателю оставлена локальным черновиком: ${draft}. Приёмка не засчитана.`);
}

async function accepted(page: Page): Promise<boolean> {
  return page.getByRole('tabpanel', { name: 'Ревью', exact: true }).getByText(PROJECT_ACCEPTED_MESSAGE, { exact: true }).isVisible();
}

async function reviewTab(page: Page): Promise<void> {
  const tab = page.getByRole('tab', { name: 'Ревью', exact: true });
  if (await tab.isVisible()) await tab.click();
  await page.getByText('Github настроен', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 180000 });
}

export async function waitCI(page: Page, project: Project, commit: string): Promise<void> {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const { stdout } = await exec('gh', ['run', 'list', '--repo', project.destination, '--commit', commit, '--limit', '20', '--json', 'status,conclusion,headSha,databaseId,workflowName,url'], { timeout: 90000 });
    const runs = JSON.parse(stdout) as Array<{ status: string; conclusion: string; headSha: string; databaseId: number; workflowName: string; url: string }>;
    const current = runs.filter(run => run.headSha === commit);
    if (current.some(run => run.status === 'completed' && run.conclusion !== 'success')) {
      if (current.some(run => run.status !== 'completed')) {
        console.log('Жду оставшиеся проверки GitHub перед разбором сбоя…');
        await page.waitForTimeout(15000);
        continue;
      }
      // Never treat a failed Action as a pass. Only the reproduced upstream
      // incompatibility may proceed to the independent Practicum UI checker.
      const failed = current.filter(run => run.conclusion !== 'success');
      const published = await readJson<PublishedProject | null>(`.local/projects/${project.id}.published.json`, null);
      if (current.every(run => run.status === 'completed') && failed.length === 1
        && failed[0].conclusion === 'failure' && failed[0].workflowName === 'Tests'
        && closingReferenceVerified(project, commit, published)) {
        const run = failed[0];
        const api = async (endpoint: string) => (await exec('gh', ['api', endpoint, '--jq', '.sha'], { timeout: 90000 })).stdout.trim();
        const [workflow, tests, dependencies, result] = await Promise.all([
          api(`repos/${project.destination}/contents/.github/workflows/tests.yml?ref=${commit}`),
          api('repos/Yandex-Practicum/tests-verstka-hometask-4-fd/contents/src/tests.js?ref=ad'),
          api('repos/Yandex-Practicum/lib-verstka-tests-public/contents/package.json?ref=main'),
          exec('gh', ['run', 'view', String(run.databaseId), '--repo', project.destination, '--log-failed'], { timeout: 90000, maxBuffer: 4 * 1024 * 1024 }),
        ]);
        if (knownClosingCheckerFailure(result.stdout, { workflow, tests, dependencies })) {
          const report = `.local/ci-issues/${project.id}.json`;
          await atomicJson(report, { phase: 'failed-known-checker-incompatibility', repository: project.destination, commit, run: run.url, versions: { workflow, tests, dependencies }, observedAt: new Date().toISOString(), explanation: 'docs/official-checker-compatibility.md' });
          await journal('project-ci-checker-incompatibility', { id: project.id, commit, url: run.url, report });
          console.log(`GitHub-проверка не прошла из-за известной несовместимости тестов: ${run.url}. Отчёт: ${report}. Локальные проверки пройдены; дальше проверку выполняет Практикум.`);
          return;
        }
      }
      throw new Error('Официальная проверка GitHub не прошла. Нужен разбор журнала.');
    }
    if (current.length && current.every(run => run.status === 'completed' && run.conclusion === 'success')) return;
    console.log('Жду официальные тесты GitHub…');
    await page.waitForTimeout(15000);
  }
  throw new Error('Официальные тесты не завершились за 10 минут; отправка отложена.');
}

export async function submitProject(page: Page, project: Project, commands: typeof projectCommand = projectCommand): Promise<boolean> {
  if (project.review === 'teacher' || project.review === 'self') throw new Error('У проекта нет автоматической приёмки');
  const file = `.local/submissions/${project.id}.json`;
  let pending = await readJson<Submission | null>(file, null);
  const pathname = new URL(project.lessonUrl).pathname;
  const solved = page.locator(`.sidebar__lesson_status_solved[href="${pathname}"]`);
  if (await solved.count() && hasProjectAcceptance(pending, project.lessonUrl)) {
    await atomicJson(file, { ...pending, phase: 'complete', updatedAt: new Date().toISOString() });
    return true;
  }

  // Check the existing result before preparing files or attempting another submission.
  await reviewTab(page);
  if (!await accepted(page) && !pending) {
    await page.getByRole('tab', { name: 'Задание', exact: true }).click();
    await commands(['prepare', project.id]);
    await commands(['verify', project.id]);
    await commands(['publish', project.id]);
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
      const state: Submission = { ...pending, commit: pending?.commit ?? '', phase: 'accepted', lessonUrl: project.lessonUrl, updatedAt: new Date().toISOString(),
        acceptanceEvidence: { message: PROJECT_ACCEPTED_MESSAGE, observedAt: new Date().toISOString(), source: 'visible-review-tab' } };
      await atomicJson(file, state);
      await journal('project-accepted', { id: project.id, url: safeUrl(page.url()) });
      if (await solved.count()) {
        await atomicJson(file, { ...state, phase: 'complete', updatedAt: new Date().toISOString() });
        return true;
      }
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
