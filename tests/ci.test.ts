import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closingChecker, closingReferenceVerified, knownClosingCheckerFailure, type PublishedProject } from '../src/ci.js';
import type { Project } from '../src/projects.js';

test('Известный сбой CI распознаётся только при неизменных версиях и единственной ошибке модального теста', () => {
  const versions = {workflow: closingChecker.workflow, tests: closingChecker.tests, dependencies: closingChecker.dependencies};
  const log = `tests\tTests\t2026-10-19T06:26:06Z start testing\ntests\tTests\t2026-10-19T06:26:15Z -e \u001b[97m1. ${closingChecker.message}\u001b[0m\nТесты завершились с ошибкой`;
  assert.equal(knownClosingCheckerFailure(log, versions), true);
  assert.equal(knownClosingCheckerFailure(log.replaceAll('\u001b', '^['), versions), true);
  for (const name of ['workflow', 'tests', 'dependencies'] as const) assert.equal(knownClosingCheckerFailure(log, {...versions, [name]:'changed'}), false);
  assert.equal(knownClosingCheckerFailure(log + '\n2. Ошибка в коде проекта', versions), false);
  assert.equal(knownClosingCheckerFailure(log.replace('Сохранить на память', 'Другая кнопка'), versions), false);
  assert.equal(knownClosingCheckerFailure('TypeError: page.$x is not a function', versions), false);
});

test('Исключение CI ограничено точным эталоном, текущим SHA назначения и подтверждёнными локальными проверками', () => {
  const project: Project = {id:'zakrivayuschiy-teg-ad',title:'Закрывающий тег',lessonUrl:'',source:'Alexey-UI/practicum-frontend-solutions',sourcePath:'projects/zakrivayuschiy-teg-ad',destination:'Another-Student/zakrivayuschiy-teg-ad',commit:closingChecker.sourceCommit,checks:[{program:'node',args:['--import','tsx','../../scripts/check-closing.ts','.']}]};
  const commit = 'a'.repeat(40);
  const published: PublishedProject = {commit:project.commit,destination:project.destination,destinationCommit:commit,verifiedAt:'2026-10-20T00:00:00Z',checks:project.checks};
  assert.equal(closingReferenceVerified(project, commit, published), true);
  assert.equal(closingReferenceVerified(project, commit, null), false);
  assert.equal(closingReferenceVerified(project, 'b'.repeat(40), published), false);
  assert.equal(closingReferenceVerified({...project,commit:'b'.repeat(40)}, commit, published), false);
  assert.equal(closingReferenceVerified(project, commit, {...published,verifiedAt:undefined}), false);
  assert.equal(closingReferenceVerified(project, commit, {...published,checks:[]}), false);
  assert.equal(closingReferenceVerified(project, commit, {...published,destination:'Other/repo'}), false);
});
