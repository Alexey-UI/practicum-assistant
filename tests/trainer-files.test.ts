import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyTrainerFiles, contentHash, readTrainer } from '../src/trainer.js';
import { atomicJson, readJson } from '../src/store.js';

const taskId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const lesson = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const url = `https://practicum.yandex.ru/trainer/test/lesson/${lesson}/task/${taskId}/`;
const fixture = `
<div class="task-description__markdown">Вынесите константу в новый файл data.js.</div>
<div class="files-tree"><div class="files-tree__body" style="min-height:80px"></div></div>
<div hidden class="context-menu-default_visible"><div class="context-menu-default__item">Новый файл</div></div>
<textarea aria-label="Содержимое редактора"></textarea>
<button data-test-id="check-task-button" onclick="document.body.dataset.checks='1'">Проверить</button>
<script>
const files = new Map([['index.js', 'const original = true;\\n']]);
let active = 'index.js';
const tree = document.querySelector('.files-tree__body');
const menu = document.querySelector('.context-menu-default_visible');
const editor = document.querySelector('textarea');
function draw() {
  tree.replaceChildren();
  for (const name of files.keys()) {
    const node = document.createElement('span'); node.className='files-tree__node-name-container'; node.textContent=name;
    node.onclick=()=>{ active=name; editor.value=files.get(name); }; tree.append(node);
  }
}
tree.oncontextmenu=e=>{e.preventDefault();menu.hidden=false;};
menu.firstElementChild.onclick=()=>{
  menu.hidden=true;
  const input=document.createElement('input');input.className='files-tree__node-name-input';tree.append(input);
  input.onkeydown=e=>{if(e.key==='Enter') { const name=input.value; files.set(name,''); document.body.dataset.creates=String(Number(document.body.dataset.creates||0)+1); active=name;draw(); }};
};
window.monaco={editor:{getModels:()=>[...files].map(([name])=>({uri:{path:'/'+name},getLanguageId:()=> 'javascript',getValue:()=>files.get(name)})),getEditors:()=>[{hasTextFocus:()=>document.activeElement===editor,trigger:(_source,_action,args)=>{files.set(active,args.text);editor.value=args.text;}}]}};
draw();
</script>`;

test('Новый файл создаётся штатным меню, восстанавливается без повторного создания и сохраняет чужие правки', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage(); const original = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'practicum-new-file-'));
  try {
    process.chdir(dir);
    await page.route('https://practicum.yandex.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
    await page.goto(url);
    const task = await readTrainer(page);
    const files = [
      { name: 'data.js', create: true as const, initialHash: contentHash(''), content: 'export const value = 7;\n' },
      { name: 'index.js', initialHash: task.files[0].hash, content: "import { value } from './data.js';\n" },
    ];
    // Preflight blocks all changes if even a later source was edited elsewhere.
    await assert.rejects(() => applyTrainerFiles(page, task, [files[0], { ...files[1], initialHash: contentHash('different') }]), /Исходный файл/);
    assert.equal(await page.locator('body').getAttribute('data-creates'), null);
    await applyTrainerFiles(page, task, files);
    const created = await readTrainer(page);
    assert.equal(created.files.find(file => file.path === '/data.js')?.content, files[0].content);
    assert.equal(created.files.find(file => file.path === '/index.js')?.content, files[1].content);
    assert.equal(await page.locator('body').getAttribute('data-creates'), '1');
    assert.equal(await page.locator('body').getAttribute('data-checks'), null);
    const receipt = await readJson<{ phase: string }>(`.local/trainer-files/${taskId}/data.js.json`, { phase: '' });
    assert.equal(receipt.phase, 'created');
    await applyTrainerFiles(page, created, files);
    assert.equal(await page.locator('body').getAttribute('data-creates'), '1');
    await page.getByRole('textbox', { name: 'Содержимое редактора' }).fill('чужая правка');
    // Model represents a genuine outside edit, not another candidate.
    await page.evaluate(() => (window as unknown as { monaco: { editor: { getEditors(): Array<{trigger(a:string,b:string,c:{text:string}):void}> } } }).monaco.editor.getEditors()[0].trigger('keyboard', 'paste', { text: 'чужая правка' }));
    await assert.rejects(() => applyTrainerFiles(page, created, files), /Исходный файл/);
    assert.equal((await readTrainer(page)).files.find(file => file.path === '/index.js')?.content, 'чужая правка');
    await page.goto(url.replace(taskId, 'cccccccc-cccc-cccc-cccc-cccccccccccc'));
    await assert.rejects(() => applyTrainerFiles(page, task, files), /другому заданию/);
  } finally { process.chdir(original); await browser.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Новый файл не заменяет существующий без квитанции, не повторяет неопределённое создание и запрещает пути', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage(); const original = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'practicum-new-file-guards-'));
  try {
    process.chdir(dir);
    await page.route('https://practicum.yandex.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
    await page.goto(url);
    const task = await readTrainer(page);
    const file = { name: 'data.js', create: true as const, initialHash: contentHash(''), content: 'export const value = 7;\n' };
    await assert.rejects(() => applyTrainerFiles(page, task, [{ ...file, name: '../data.js' }]), /безопасное имя/);
    await assert.rejects(() => applyTrainerFiles(page, task, [{ ...file, name: 'index.js' }]), /без подтверждения/);
    const receiptPath = `.local/trainer-files/${taskId}/data.js.json`;
    await atomicJson(receiptPath, { taskId, lessonId: lesson, instructionsHash: contentHash(task.instructions), contextHash: task.contextHash, name: file.name, phase: 'requested' });
    await assert.rejects(() => applyTrainerFiles(page, task, [file]), /ещё не подтверждён/);
    assert.equal(await page.locator('body').getAttribute('data-creates'), null);
    assert.equal(await page.locator('body').getAttribute('data-checks'), null);
  } finally { process.chdir(original); await browser.close(); await rm(dir, { recursive: true, force: true }); }
});
