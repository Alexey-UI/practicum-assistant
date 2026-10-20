import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectDestination } from '../src/projects.js';

test('Проекты другого пользователя публикуются в его аккаунт, источник эталонов не меняется', () => {
  assert.equal(projectDestination('Alexey-UI/mesto-ad', 'Other-Student'), 'Other-Student/mesto-ad');
  assert.equal(projectDestination('Alexey-UI/mesto-ad'), 'Alexey-UI/mesto-ad');
  for (const owner of ['../Alexey-UI', 'x/y', '', '-invalid', 'user.git/hijack']) assert.throws(() => projectDestination('Alexey-UI/mesto-ad', owner));
});
