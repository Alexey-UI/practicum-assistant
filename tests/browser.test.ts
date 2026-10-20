import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { readLessons, observedSolved, saveObservedSolved } from '../src/catalog.js';
import { exactButton, questionFrom, quizOutcome } from '../src/quiz.js';
import { DEFAULTS } from '../src/config.js';
import { scrollLesson } from '../src/scroll.js';
import { trainerOutcome, selectEditorFile, solveTrainer, readTrainer, advanceTrainer, contentHash, canReplaceTrainerFile } from '../src/trainer.js';
import { readTextQuestion, solveTextQuestion, captureTextAnswer } from '../src/text-quiz.js';
import { solveFeedback } from '../src/feedback.js';
import { solveQuiz } from '../src/quiz.js';
import { Answers, atomicJson, questionKey, readJson } from '../src/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitLessonReady } from '../src/browser.js';

let browser: Browser;
test('Исправленная попытка тренажёра допускает только свои изменения и сохраняет исходный хеш', () => {
  const file = { name: 'fonts.css', initialHash: contentHash(''), content: 'font-weight: normal;' };
  const previous = { name: 'fonts.css', initialHash: contentHash(''), contentHash: contentHash('font-weight: 400;') };
  assert.equal(canReplaceTrainerFile(previous.contentHash, file, previous), true);
  assert.equal(canReplaceTrainerFile(contentHash('чужая правка'), file, previous), false);
  assert.equal(canReplaceTrainerFile(previous.contentHash, file), false);
  assert.equal(canReplaceTrainerFile(previous.contentHash, file, { ...previous, initialHash: contentHash('другой исходник') }), false);
});
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });
test('Пустой следующий шаг передаётся обработчику повторной загрузки без отправки ответа', { timeout: 10000 }, async () => {
  const page = await browser.newPage(); const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-empty-task-'));
  try {
    process.chdir(dir);
    await page.route('https://practicum.yandex.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: route.request().url().includes('/task/first/') ? '<div class="task-description__markdown">Первое</div><button data-test-id="next-task-button" onclick="location.href=\'/trainer/test/lesson/same/task/second/\'">Далее</button>' : '<main>Редактор ещё не загружен</main>' }));
    await page.goto('https://practicum.yandex.ru/trainer/test/lesson/same/task/first/');
    assert.equal(await advanceTrainer(page, 'Первое', 'same', 100), 'advanced');
    assert.ok(page.url().includes('/task/second/'));
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});
test('После последнего задания проходчик возвращается к теории без ожидания редактора следующего урока', { timeout: 10000 }, async () => {
  const page = await browser.newPage(); const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-next-theory-'));
  try {
    process.chdir(dir);
    await page.route('https://practicum.yandex.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: route.request().url().includes('/lesson/old/') ? '<div class="task-description__markdown">Текущее задание</div><button data-test-id="next-task-button" onclick="location.href=\'/trainer/test/lesson/new/task/first/\'">Далее</button>' : '<main>Новый редактор ещё не загружен</main>' }));
    await page.goto('https://practicum.yandex.ru/trainer/test/lesson/old/task/last/');
    assert.equal(await advanceTrainer(page, 'Текущее задание', 'old'), 'finished');
    assert.ok(page.url().includes('/lesson/new/'));
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});
test('Чтение тренажёра открывает исходный CSS, модель которого ещё не загружена', async () => {
  const page = await browser.newPage(); const original = process.cwd(); const dir = await mkdtemp(path.join(tmpdir(), 'practicum-unopened-'));
  try {
    process.chdir(dir);
    await page.route('https://practicum.yandex.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<textarea aria-label="Содержимое редактора"></textarea><div class="task-description__markdown">Задайте размер карточки.</div><div class="files-tree"><span class="files-tree__node-name-container" onclick="loadCss()">style.css</span></div><script>
      const models=[{uri:{path:'/index.html'},getLanguageId:()=> 'html',getValue:()=> '<main></main>'}];
      window.monaco={editor:{getModels:()=>models}};
      function loadCss(){models.push({uri:{path:'/styles/style.css'},getLanguageId:()=> 'css',getValue:()=> '.card {}'})};
    </script>` }));
    await page.goto('https://practicum.yandex.ru/trainer/test/lesson/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/task/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/');
    const task = await readTrainer(page);
    assert.equal(task.files.find(file => file.path.endsWith('style.css'))?.content, '.card {}');
    assert.equal((await readTrainer(page)).files.length, 2);
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});
test('Пустая оболочка урока перезагружается без нажатия проверки', async () => {
  const page = await browser.newPage(); let reads = 0; let checks = 0;
  try {
    await page.route('https://practicum.yandex.ru/**', route => {
      reads++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: reads === 1 ? '<main><h1>Теория в модальном окне</h1><button>Проверить</button></main>' : '<main><h1>Урок загружен</h1><textarea aria-label="Содержимое редактора"></textarea></main>' });
    });
    await page.exposeFunction('recordCheck', () => { checks++; });
    await page.goto('https://practicum.yandex.ru/trainer/test/lesson/example/task/example/');
    await page.locator('button').evaluate(el => el.addEventListener('click', () => (window as unknown as { recordCheck(): void }).recordCheck()));
    await waitLessonReady(page, 100);
    assert.equal(reads, 2);
    assert.equal(checks, 0);
    assert.equal(await page.locator('h1').innerText(), 'Урок загружен');
  } finally { await page.close(); }
});
test('Файл редактора выбирается в дереве и во вкладках с перекрывающей текст подсказкой', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div class="files-tree"><span onclick="document.body.dataset.file=this.textContent">script.js</span></div>');
    await selectEditorFile(page, 'script.js');
    assert.equal(await page.locator('body').getAttribute('data-file'), 'script.js');
    await page.setContent(`<style>.tab { position: relative; width: 200px; height: 50px; } .element-hint { position: absolute; inset: 0; }</style>
      <section class="tab" onclick="document.body.dataset.file='script.js'"><span class="element-hint"></span><article class="tab__text">script.js</article></section>
      <section class="tab" onclick="document.body.dataset.file='script.js.map'"><article class="tab__text">script.js.map</article></section>`);
    await selectEditorFile(page, 'script.js');
    assert.equal(await page.locator('body').getAttribute('data-file'), 'script.js');
    await assert.rejects(selectEditorFile(page, 'missing.js'));
  } finally { await page.close(); }
});
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
test('Изменённое условие тренажёра блокирует старое решение до редактирования кода', async () => {
  const page = await browser.newPage();
  const original = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'practicum-trainer-condition-'));
  const taskId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const lessonId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  try {
    process.chdir(dir);
    await atomicJson(`data/trainers/${taskId}.json`, {
      taskId, lessonId, instructionsHash: contentHash('Старое условие'),
      files: [{ name: 'script.js', initialHash: contentHash(''), content: 'console.log(1);' }],
      verifiedAt: '2026-10-19T00:00:00Z', evidence: { message: 'Принято' },
    });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<textarea aria-label="Содержимое редактора"></textarea>
      <div class="task-description__markdown">Новое условие</div>
      <script>window.monaco={editor:{getModels:()=>[{uri:{path:'/script.js'},getLanguageId:()=>'javascript',getValue:()=>''}]}}</script>` }));
    await page.goto(`https://practicum.yandex.ru/trainer/test/lesson/${lessonId}/task/${taskId}/`);
    await assert.rejects(solveTrainer(page), /Условие задания изменилось/);
    assert.equal(await page.getByRole('textbox').inputValue(), '');
    await atomicJson(`data/trainers/${taskId}.json`, {
      taskId, lessonId, instructionsHash: contentHash('Новое условие'),
      contextHash: contentHash(JSON.stringify([{ url: 'https://example.test/old.svg', alt: 'Схема' }])),
      files: [{ name: 'script.js', initialHash: contentHash(''), content: 'console.log(1);' }],
      verifiedAt: '2026-10-19T00:00:00Z', evidence: { message: 'Принято' },
    });
    await page.locator('.task-description__markdown').evaluate(el => {
      const image = document.createElement('img'); image.src = 'https://example.test/new.svg'; image.alt = 'Схема'; el.append(image);
    });
    await assert.rejects(solveTrainer(page), /Иллюстрации задания изменились/);
    assert.equal(await page.getByRole('textbox').inputValue(), '');
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
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
test('Радиовопрос допускает несколько правильных альтернатив, чекбоксы требуют полного набора', async () => {
  const page = await browser.newPage();
  const original = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'practicum-radio-'));
  try {
    process.chdir(dir);
    await page.setContent(`<form class="quiz quiz_answered"><legend>На что похож вызов функции?</legend>
      <div class="quiz-form-choice__option quiz-form-choice__option_should-be-checked"><label><input type="radio" checked disabled><div class="quiz-form-choice__option-content">Не знаю</div></label></div>
      <div class="quiz-form-choice__option quiz-form-choice__option_checked quiz-form-choice__option_should-be-checked"><label><input type="radio" checked disabled><div class="quiz-form-choice__option-content">console.log()</div></label></div>
      <div class="quiz-form-choice__option"><label><input type="radio" disabled><div class="quiz-form-choice__option-content">Неверный вариант</div></label></div>
      <button type="button" onclick="document.body.dataset.clicks='1'">Проверить</button></form>`);
    const root = page.locator('form');
    const question = await questionFrom(root);
    const file = `.local/questions/${questionKey(question)}.json`;
    await atomicJson(file, { phase: 'wrong', answers: ['console.log()'] });
    assert.equal(await solveQuiz(page, root, DEFAULTS), true);
    assert.deepEqual(await new Answers().get(question), ['console.log()']);
    assert.equal((await readJson<{ phase: string }>(file, { phase: '' })).phase, 'correct');
    assert.equal(await page.locator('body').getAttribute('data-clicks'), null);
    await root.locator('input').evaluateAll(inputs => inputs.forEach(input => (input as HTMLInputElement).type = 'checkbox'));
    assert.equal(await quizOutcome(root, DEFAULTS), 'wrong');
    await root.locator('input').evaluateAll(inputs => inputs.forEach(input => (input as HTMLInputElement).type = 'radio'));
    await root.locator('.quiz-form-choice__option').nth(1).evaluate(el => el.classList.remove('quiz-form-choice__option_checked'));
    await root.locator('.quiz-form-choice__option').nth(2).evaluate(el => el.classList.add('quiz-form-choice__option_checked'));
    assert.equal(await quizOutcome(root, DEFAULTS), 'wrong');
  } finally {
    process.chdir(original);
    await page.close();
    await rm(dir, { recursive: true, force: true });
  }
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

test('Табличный опрос с пустым заголовком выбирает нейтральную колонку и сохраняет пустой отзыв', async () => {
  const page = await browser.newPage();
  const original = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'practicum-matrix-feedback-'));
  try {
    process.chdir(dir);
    await page.setContent(`<section class="quiz quiz_type_feedback" data-test-id="quiz-feedback-aabbcc">
      <p class="quiz__title"></p><div class="quiz__question-content"><div class="likert-scale">
      <p id="yes" class="likert-scale__grade-label">Да</p><p id="neutral" class="likert-scale__grade-label">не знаю</p>
      ${['Теория', 'Практика'].map((text, index) => `<div class="likert-scale__statement-row">${text}
        <label><input type="radio" name="q${index}" aria-labelledby="yes"></label>
        <label><input type="radio" name="q${index}" aria-labelledby="neutral"></label></div>`).join('')}
      </div></div><button class="quiz__move-on">Далее</button><div class="quiz__counter">1 — 2</div></section>`);
    await page.locator('.quiz__move-on').evaluate(button => button.addEventListener('click', () => {
      document.body.dataset.neutral = String(document.querySelectorAll('input[aria-labelledby="neutral"]:checked').length);
      document.querySelector('.quiz__question-content')!.innerHTML = '<p>Отзыв по желанию</p><textarea></textarea>';
      document.querySelector('.quiz__counter')!.textContent = '2 — 2';
      (button as HTMLButtonElement).disabled = true;
      document.body.dataset.submitted = '1';
    }));
    assert.equal(await solveFeedback(page, page.locator('.quiz'), { ...DEFAULTS, feedbackPolicy: 'neutral' }), false);
    assert.equal(await page.locator('body').getAttribute('data-submitted'), '1');
    assert.equal(await page.locator('body').getAttribute('data-neutral'), '2');
    assert.equal(await page.locator('textarea').inputValue(), '');
    // Restart observes the new step and never submits a blocked blank review.
    assert.equal(await solveFeedback(page, page.locator('.quiz'), { ...DEFAULTS, feedbackPolicy: 'neutral' }), false);
    assert.equal(await page.locator('body').getAttribute('data-submitted'), '1');
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Текстовое задание сохраняется только после положительного маркера и не отправляется повторно', async () => {
  const page = await browser.newPage();
  const original = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'practicum-text-'));
  try {
    process.chdir(dir);
    const html = `<section class="quiz quiz_type_text" data-test-id="quiz-text-abcdef"><div class="quiz__content">Переведите #3fb в rgb с альфа-каналом 0.5</div>
      <textarea class="quiz__input-control"></textarea><button onclick="this.parentElement.classList.add('quiz_answered');const result=document.createElement('p');result.className='quiz__content-block_status_success';result.textContent=this.parentElement.querySelector('textarea').value;this.parentElement.append(result);this.remove();document.body.dataset.clicks='1'">Узнать ответ</button></section>`;
    await page.setContent(html);
    const root = page.locator('.quiz');
    assert.equal(await solveTextQuestion(page, root), false);
    assert.equal(await captureTextAnswer(root), false);
    const question = await readTextQuestion(root);
    await atomicJson('.local/text-decisions.json', { [question.id]: { promptHash: question.promptHash, answer: 'rgb(51 255 187 / 0.5)' } });
    assert.equal(await solveTextQuestion(page, root), true);
    assert.equal(await solveTextQuestion(page, root), true);
    assert.equal(await page.locator('body').getAttribute('data-clicks'), '1');
    assert.equal(await quizOutcome(root, DEFAULTS), 'correct');
    await page.locator('.quiz__content-block_status_success').evaluate(el => el.setAttribute('class', 'quiz__content-block'));
    assert.equal(await captureTextAnswer(root), false);
    assert.equal(await quizOutcome(root, DEFAULTS), 'unknown');
  } finally { process.chdir(original); await page.close(); await rm(dir, { recursive: true, force: true }); }
});
