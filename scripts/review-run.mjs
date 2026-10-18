import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
const id = process.argv[2];
if (!/^\d+$/.test(id ?? '')) throw new Error('Нужен числовой ID запуска');
let stdout = '';
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    ({ stdout } = await promisify(execFile)('gh', ['run', 'view', id, '--repo', 'Alexey-UI/ono-tebe-nado-ad', '--log-failed'], { timeout: 180000, maxBuffer: 8 * 1024 * 1024 }));
    break;
  } catch {
    if (attempt === 2) { console.error('Не удалось получить журнал GitHub за 3 попытки.'); process.exit(1); }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
const clean = stdout
  .replace(/\b(?:gh[pousr]_[\w]+|y[01]_[\w-]+|AQAD-[\w-]+|t1\.[\w.-]+)\b/g, '[redacted]')
  .replace(/(?:Bearer|Api-Key)\s+\S+/gi, '[redacted]')
  .replace(/(https?:\/\/[^\s?]+)\?\S+/g, '$1?[redacted]');
await mkdir('.local', { recursive: true, mode: 0o700 });
await writeFile(`.local/action-${id}.log`, clean, { mode: 0o600 });
const relevant = clean.split('\n').filter(line => /error|fail|expected|received|passed|snapshot|report|artifact|https:\/\//i.test(line));
console.log((relevant.length ? relevant.slice(-90) : clean.split('\n').slice(-60)).join('\n'));
