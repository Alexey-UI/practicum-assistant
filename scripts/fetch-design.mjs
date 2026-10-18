import { readFile, mkdir, writeFile } from 'node:fs/promises';
const info = JSON.parse(await readFile('.local/figma-oembed.json', 'utf8'));
const url = new URL(info.thumbnail_url);
if (url.protocol !== 'https:' || url.hostname !== 'api-cdn.figma.com') throw new Error('Unexpected image host');
const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
if (!response.ok) throw new Error(`Figma image HTTP ${response.status}`);
await mkdir('artifacts/design', { recursive: true });
await writeFile('artifacts/design/figma.png', Buffer.from(await response.arrayBuffer()));
console.log('Saved artifacts/design/figma.png');
