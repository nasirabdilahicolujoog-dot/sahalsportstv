import { readFile, writeFile, stat } from 'node:fs/promises';
import { Script } from 'node:vm';

const target = 'C:/Users/Dep1/.qoder/app/chat-session-visualizations/c490eb49-9dc5-4143-9ad2-674b878b05f3/visualizations/sahal-sports-preview.html';
const assetDirectory = 'C:/xampp/htdocs/sahalsportstv/assets';
const names = ['brand_mark', 'brand_lockup', 'featured_match', 'splash_art', 'trophy', 'zaad', 'edahab'];
const assets = {};
for (const name of names) {
  const bytes = await readFile(`${assetDirectory}/${name}.png`);
  if (bytes.subarray(1, 4).toString() !== 'PNG') throw new Error(`Invalid PNG: ${name}`);
  assets[name] = `data:image/png;base64,${bytes.toString('base64')}`;
}
let fragment = await readFile(target, 'utf8');
if (!/const assets = \{[\s\S]*?\};/.test(fragment)) throw new Error('Missing asset block');
fragment = fragment.replace(/const assets = \{[\s\S]*?\};/, `const assets = ${JSON.stringify(assets)};`);
if (Buffer.byteLength(fragment) >= 1_000_000) throw new Error('Preview exceeds 1 MB');
if (/<(?:!doctype|html|head|body)(?:\s|>)/i.test(fragment)) throw new Error('Expected HTML fragment');
if (/\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage)\b/.test(fragment)) throw new Error('Offline-only preview required');
const script = fragment.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error('Missing inline script');
new Script(script, { filename: 'sahal-sports-preview.inline.js' });
await writeFile(target, fragment, 'utf8');
console.log(JSON.stringify({ path: target, bytes: (await stat(target)).size, embeddedAssets: names.length, scriptSyntax: 'valid' }, null, 2));
