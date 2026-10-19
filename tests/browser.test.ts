import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { readLessons, observedSolved, saveObservedSolved } from '../src/catalog.js';
import { exactButton, questionFrom, quizOutcome } from '../src/quiz.js';
import { DEFAULTS } from '../src/config.js';
import { scrollLesson } from '../src/scroll.js';
import { trainerOutcome } from '../src/trainer.js';
import { solveFeedback } from '../src/feedback.js';
import { solveQuiz } from '../src/quiz.js';
import { Answers, atomicJson, questionKey } from '../src/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let browser: Browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });
test('Каталог отличает галочку solved от доступного урока и фильтрует чужие ссылки', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<a class="course-navigation-lesson course-navigation-lesson_status_solved" href="https://practicum.yandex.ru/learn/1"><h3>1. Готово</h3></a>
      <a class="course-navigation-lesson" href="https://practicum.yandex.ru/learn/2"><h3>2. Ещё нет</h3></a>
      <span class="course-navigation-lesson course-navigation-lesson_status_disabled" to="/learn/locked"><h3>3. Недоступно</h3></span>
      <a class="course-navigation-lesson" href="https://other.example/learn/3"><h3>Внешний сайт</h3></a>`);
    const lessons = await readLessons(page, 'Модуль', 'Проектная работа');
    assert.equal(lessons.length, 3);
    assert.equal(lessons[0].solved, true);
    assert.equal(lessons[1].solved, false);
    assert.equal(lessons[2].locked, true);
    assert.equal(lessons[2].url, 'https://practicum.yandex.ru/learn/locked');
    assert.ok(lessons.every(l => l.project));
  } finally { await page.close(); }
});
test('Неоднозначные кнопки останавливают действие; скрытые и disabled исключаются', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button hidden>Дальше</button><button disabled>Дальше</button><button>Дальше</button>');
    assert.ok(await exactButton(page, ['Дальше']));
    await page.setContent('<button>Дальше</button><button>Дальше</button>');
    await assert.rejects(exactButton(page, ['Дальше']));
  } finally { await page.close(); }
});
test('Вопрос и варианты читаются из связанных подписей без зависимости от порядка', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<form><legend>Что такое HTML?</legend><label><input type="radio" name="a">Разметка</label><label><input type="radio" name="a">Стили</label></form>');
    assert.deepEqual(await questionFrom(page.locator('form')), { prompt: 'Что такое HTML?', options: ['Разметка', 'Стили'], multiple: false });
  } finally { await page.close(); }
});
test('Ответ оценивается по маркерам Практикума; текст обратной связи не меняет варианты', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<form class="quiz quiz_answered"><div class="quiz__content">Что такое HTML?</div>
      <div class="quiz-form-choice__option quiz-form-choice__option_checked quiz-form-choice__option_should-be-checked"><label><input type="radio" name="a" checked><span class="visually-hidden">Правильный ответ</span><div class="quiz-form-choice__option-content">Разметка</div></label></div>
      <div class="quiz-form-choice__option"><label><input type="radio" name="a"><div class="quiz-form-choice__option-content">Стили</div></label></div></form>`);
    const form = page.locator('form');
    assert.equal(await quizOutcome(form, DEFAULTS), 'correct');
    assert.deepEqual((await questionFrom(form)).options, ['Разметка', 'Стили']);
    await page.locator('.quiz-form-choice__option').first().evaluate(el => el.classList.remove('quiz-form-choice__option_checked'));
    assert.equal(await quizOutcome(form, DEFAULTS), 'wrong');
    await form.evaluate(el => el.classList.remove('quiz_answered'));
    assert.equal(await quizOutcome(form, DEFAULTS), 'unknown');
  } finally { await page.close(); }
});
test('Урок проматывается во внутреннем контейнере, включая догруженный фрагмент', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  try {
    await page.setContent(`<main style="height: 400px; overflow-y: auto"><div class="theory-viewer" style="min-height: 1800px">Текст урока</div></main>
      <script>document.querySelector('main').addEventListener('scroll', function () {
        if (this.scrollTop > 500 && !this.dataset.loaded) { this.dataset.loaded = 'true'; document.querySelector('.theory-viewer').style.minHeight = '2600px'; }
      });</script>`);
    const result = await scrollLesson(page, { delayMs: 15, maxSteps: 30 });
    assert.ok(result.steps > 5);
    assert.equal(await page.locator('main').evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop), 0);
    assert.equal(await page.locator('main').getAttribute('data-loaded'), 'true');
    assert.equal(await page.evaluate(() => window.scrollY), 0);
  } finally { await page.close(); }
});
test('Тренажёр оценивается по статусу проверки, даже если текст успеха описывает проблему', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<button data-test-id="check-task-button">Проверить</button>
      <div class="trainer-footer__message notification notification_type_success">А вот с main явные проблемы.</div>`);
    assert.equal(await trainerOutcome(page), 'correct');
    await page.locator('button').evaluate(el => el.classList.add('prisma-button2_progress'));
    assert.equal(await trainerOutcome(page), 'unknown');
    await page.locator('button').evaluate(el => el.classList.remove('prisma-button2_progress'));
    await page.locator('.notification').evaluate(el => el.classList.add('draggable-notification__manikin'));
    assert.equal(await trainerOutcome(page), 'unknown');
    await page.locator('.notification').evaluate(el => { el.classList.remove('draggable-notification__manikin', 'notification_type_success'); el.classList.add('notification_type_error'); });
    assert.equal(await trainerOutcome(page), 'wrong');
  } finally { await page.close(); }
});
test('Сопоставление считается принятым только после проверки всех строк', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<section class="quiz quiz_answered"><section class="quiz-form-matching">
      <div class="quiz-form-matching__prompt quiz-form-matching__prompt_correct">ul</div>
      <div class="quiz-form-matching__prompt">ol</div></section></section>`);
    const root = page.locator('.quiz');
    assert.equal(await quizOutcome(root, DEFAULTS), 'wrong');
    await page.locator('.quiz-form-matching__prompt').last().evaluate(el => el.classList.add('quiz-form-matching__prompt_correct'));
    assert.equal(await quizOutcome(root, DEFAULTS), 'correct');
    await root.evaluate(el => el.classList.remove('quiz_answered'));
    assert.equal(await quizOutcome(root, DEFAULTS), 'unknown');
  } finally { await page.close(); }
});
test('Ожидающий ответ вопроса наблюдается после перезапуска без повторной отправки', async () => {
  const page = await browser.newPage();
  const original = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'practicum-quiz-'));
  try {
    process.chdir(dir);
    await page.setContent(`<form><legend>Что такое HTML?</legend>
      <label><input type="radio" name="a" checked>Разметка</label><label><input type="radio" name="a">Стили</label>
      <button type="button" onclick="document.body.dataset.clicks = '1'">Проверить</button></form>`);
    const question = await questionFrom(page.locator('form'));
    const key = questionKey(question);
    await atomicJson('.local/decisions.json', { [key]: ['Разметка'] });
    await atomicJson(`.local/questions/${key}.json`, { phase: 'requested', answers: ['Разметка'] });
    await page.evaluate(() => setTimeout(() => {
      const result = document.createElement('p'); result.dataset.testid = 'quiz-success'; result.textContent = 'Верно'; document.querySelector('form')!.append(result);
    }, 100));
    assert.equal(await solveQuiz(page, page.locator('form'), DEFAULTS), true);
    assert.equal(await page.locator('body').getAttribute('data-clicks'), null);
    assert.deepEqual(await new Answers().get(question), ['Разметка']);
  } finally {
    process.chdir(original);
    await page.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('Опрос получает нейтральный ответ по настройке, свободный отзыв остаётся пустым', async () => {
  const page = await browser.newPage();
  const original = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'practicum-feedback-'));
  try {
    process.chdir(dir);
    const html = `<section class="quiz quiz_type_feedback" data-test-id="quiz-feedback-abcdef">
      <h2 class="quiz__title">Как дела?</h2><label class="quiz__option"><input type="radio" name="mood">Отлично!</label>
      <label class="quiz__option"><input type="radio" name="mood">В целом нормально</label>
      <button class="quiz__move-on" onclick="this.parentElement.classList.add('quiz_answered')">Далее</button></section>`;
    await page.setContent(html);
    assert.equal(await solveFeedback(page, page.locator('.quiz'), DEFAULTS), false);
    assert.equal(await page.locator('input:checked').count(), 0);
    assert.equal(await solveFeedback(page, page.locator('.quiz'), { ...DEFAULTS, feedbackPolicy: 'neutral' }), true);
    assert.equal(await page.locator('input').last().isChecked(), true);
    await page.setContent(html.replace('quiz-feedback-abcdef', 'quiz-feedback-fedcba').replace('</h2>', '</h2><textarea></textarea>'));
    assert.equal(await solveFeedback(page, page.locator('.quiz'), { ...DEFAULTS, feedbackPolicy: 'neutral' }), false);
    assert.equal(await page.locator('textarea').inputValue(), '');
    assert.equal(await page.locator('input:checked').count(), 0);
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Возобновление обновляет каталог только по настоящим галочкам текущего интерфейса', async () => {
  const page = await browser.newPage();
  const dir = await mkdtemp(path.join(tmpdir(), 'practicum-progress-'));
  try {
    const file = path.join(dir, 'catalog.json');
    const done = 'https://practicum.yandex.ru/learn/done';
    const pending = 'https://practicum.yandex.ru/learn/pending';
    await atomicJson(file, [{ url: done, solved: false }, { url: pending, solved: false }]);
    await page.setContent(`<a class="sidebar__lesson sidebar__lesson_status_solved" href="/learn/done"></a>
      <a class="sidebar__lesson" href="/learn/pending"></a>
      <a class="sidebar__lesson sidebar__lesson_status_solved" href="https://other.example/learn/external"></a>`);
    const observed = await observedSolved(page);
    assert.deepEqual([...observed], [done]);
    await saveObservedSolved(observed, file);
    const { readFile } = await import('node:fs/promises');
    const rows = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(rows[0].solved, true);
    assert.ok(rows[0].observedAt);
    assert.equal(rows[1].solved, false);
  } finally { await page.close(); await rm(dir, { recursive: true, force: true }); }
});
