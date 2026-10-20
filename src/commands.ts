import { stat } from 'node:fs/promises';
import path from 'node:path';

interface Runtime { execPath: string; npmExecPath?: string }

/** Launch npm's JavaScript entry point, including on Windows where npm.cmd is not executable. */
export async function projectCheckCommand(program: 'npm' | 'node', args: string[], runtime: Runtime = {
  execPath: process.execPath, npmExecPath: process.env.npm_execpath,
}): Promise<{ program: string; args: string[] }> {
  if (program === 'node') return { program: runtime.execPath, args: [...args] };
  const candidates = [
    runtime.npmExecPath,
    path.join(path.dirname(runtime.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(runtime.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate) || path.basename(candidate) !== 'npm-cli.js') continue;
    try {
      if ((await stat(candidate)).isFile()) return { program: runtime.execPath, args: [candidate, ...args] };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new Error('Не найден npm-cli.js. Установите Node.js вместе с npm и запускайте программу через npm start или npm run projects.');
}
