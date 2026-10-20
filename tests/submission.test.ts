import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { submitProject } from '../src/submission.js';
import { hasProjectAcceptance, PROJECT_ACCEPTED_MESSAGE, type Submission } from '../src/project-acceptance.js';
import { atomicJson, readJson } from '../src/store.js';
import { status } from '../src/status.js';
import type { Project } from '../src/projects.js';

let browser: Browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });
const project: Project = { id: 'example', title: 'Проект', destination: 'Student/example', source: 'Alexey-UI/practicum-frontend-solutions', sourcePath: 'projects/example', commit: '1'.repeat(40), checks: [{ program: 'node', args: [] }],
  lessonUrl: 'https://practicum.yandex.ru/learn/ap-frontend-st/courses/course/lessons/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/' };
const file = `.local/submissions/${project.id}.json`;
async function fixture(page: Page, accepted: boolean): Promise<void> {
  await page.route('https://practicum.yandex.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<a class="sidebar__lesson_status_solved" href="${new URL(project.lessonUrl).pathname}">Прочитано</a>
    <div role="tablist"><button role="tab">Задание</button><button role="tab" onclick="document.body.dataset.reviewOpens=String(Number(document.body.dataset.reviewOpens||0)+1)">Ревью</button></div>
    <div role="tabpanel" aria-label="Ревью"><p>Github настроен</p>${accepted ? `<p>${PROJECT_ACCEPTED_MESSAGE}</p>` : ''}</div>` }));
  await page.goto(project.lessonUrl);
}
test('Галочка урока сдачи без приёмки не создаёт квитанцию complete и не пропускает подготовку работы', async () => {
  const page = await browser.newPage(); const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-project-reading-'));
  try {
    process.chdir(dir); await fixture(page, false);
    const prepare = new Error('Preparation reached');
    await assert.rejects(() => submitProject(page, project, async args => { assert.deepEqual(args, ['prepare', 'example']); throw prepare; }), error => error === prepare);
    assert.equal(await readJson(file, null), null);
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});
test('Видимая приёмка во вкладке ревью разрешает завершение старой отправки без повторной публикации', async () => {
  const page = await browser.newPage(); const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-project-accepted-'));
  try {
    process.chdir(dir); await fixture(page, true);
    await atomicJson(file, { phase: 'requested', commit: '2'.repeat(40), lessonUrl: project.lessonUrl });
    const commands = async () => { throw new Error('No new publication'); };
    assert.equal(await submitProject(page, project, commands), true);
    const saved = await readJson<Submission | null>(file, null);
    assert.equal(saved?.phase, 'complete'); assert.equal(saved?.commit, '2'.repeat(40));
    assert.equal(hasProjectAcceptance(saved, project.lessonUrl), true);
    assert.equal(await submitProject(page, project, commands), true);
    assert.equal(await page.locator('body').getAttribute('data-review-opens'), '1');
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});
test('Отчёт считает только подтверждённую приёмку проекта, отдельно от галочки и прежней квитанции complete', async () => {
  const original = process.cwd(); const log = console.log; const dir = await mkdtemp(path.join(tmpdir(), 'practicum-project-status-'));
  try {
    process.chdir(dir); console.log = () => {};
    await atomicJson('solutions/projects.json', { version: 1, projects: [project] });
    await atomicJson('.local/catalog.json', [{ url: project.lessonUrl, course: 'Основной', solved: true }]);
    await status(); assert.equal((await readJson<Record<string, number>>('.local/status.json', {})).acceptedProjects, 0);
    const state: Submission = { phase: 'complete', commit: '2'.repeat(40), lessonUrl: project.lessonUrl };
    await atomicJson(file, state);
    await status(); assert.equal((await readJson<Record<string, number>>('.local/status.json', {})).acceptedProjects, 0);
    state.acceptanceEvidence = { message: PROJECT_ACCEPTED_MESSAGE, observedAt: new Date().toISOString(), source: 'visible-review-tab' };
    assert.equal(hasProjectAcceptance({ ...state, phase: 'requested' }, project.lessonUrl), false);
    assert.equal(hasProjectAcceptance(state, project.lessonUrl.replace('aaaaaaaa-', 'bbbbbbbb-')), false);
    await atomicJson(file, state);
    await status(); assert.equal((await readJson<Record<string, number>>('.local/status.json', {})).acceptedProjects, 1);
  } finally { process.chdir(original); console.log = log; await rm(dir, { recursive: true, force: true }); }
});
