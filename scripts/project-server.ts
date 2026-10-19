import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function serveProject(root: string): Promise<{ url: string; close(): Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
  const server = createServer(async (request, response) => {
    try {
      const requested = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const file = path.resolve(root, `.${requested === '/' ? '/index.html' : requested}`);
      if (!file.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return; }
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Не определён адрес локальной проверки');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
