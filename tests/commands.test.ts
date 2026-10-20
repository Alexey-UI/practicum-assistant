import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectCheckCommand } from '../src/commands.js';

const exec = promisify(execFile);

test('Node и npm запускаются без оболочки: пробелы и метасимволы передаются буквально', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'practicum commands '));
  try {
    const cli = path.join(dir, 'npm-cli.js');
    await writeFile(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const args = ['arg with spaces', 'a&b', '$HOME', '`literal`', 'a"b', '%PATH%'];
    const command = await projectCheckCommand('npm', args, { execPath: process.execPath, npmExecPath: cli });
    assert.equal(command.program, process.execPath);
    const output = await exec(command.program, command.args);
    assert.deepEqual(JSON.parse(output.stdout), args);
    const node = await projectCheckCommand('node', [cli, ...args]);
    assert.equal(node.program, process.execPath);
    assert.deepEqual(JSON.parse((await exec(node.program, node.args)).stdout), args);
    assert.deepEqual(args, ['arg with spaces', 'a&b', '$HOME', '`literal`', 'a"b', '%PATH%']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('npm находится рядом с Node без npm_execpath, чужая команда из env не выполняется', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'practicum-npm-'));
  try {
    const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await mkdir(path.dirname(cli), { recursive: true }); await writeFile(cli, '');
    const command = await projectCheckCommand('npm', ['--version'], { execPath: path.join(dir, 'node.exe'), npmExecPath: path.join(dir, 'npm.cmd') });
    assert.deepEqual(command, { program: path.join(dir, 'node.exe'), args: [cli, '--version'] });
    await rm(cli);
    await assert.rejects(projectCheckCommand('npm', [], { execPath: path.join(dir, 'node.exe') }), /Не найден npm-cli/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Установленный npm действительно запускается выбранным Node', async () => {
  const command = await projectCheckCommand('npm', ['--version']);
  assert.match((await exec(command.program, command.args)).stdout.trim(), /^\d+\.\d+\.\d+$/);
});
