import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pages = [
  { source: 'https://elmballoon.com/category/news/', output: 'dist/category/news/index.html', prefix: '../../' },
  { source: 'https://elmballoon.com/about/', output: 'dist/about/index.html', prefix: '../' },
  { source: 'https://elmballoon.com/item/', output: 'dist/item/index.html', prefix: '../' },
  { source: 'https://elmballoon.com/balloon/', output: 'dist/balloon/index.html', prefix: '../' },
  { source: 'https://elmballoon.com/ibrex/', output: 'dist/ibrex/index.html', prefix: '../' },
  { source: 'https://elmballoon.com/faq/', output: 'dist/faq/index.html', prefix: '../' },
  { source: 'https://elmballoon.com/contact/', output: 'dist/contact/index.html', prefix: '../' },
];

const internalRoutes = new Map([
  ['https://elmballoon.com/', ''],
  ['https://elmballoon.com/category/news/', 'category/news/'],
  ['https://elmballoon.com/about/', 'about/'],
  ['https://elmballoon.com/item/', 'item/'],
  ['https://elmballoon.com/balloon/', 'balloon/'],
  ['https://elmballoon.com/ibrex/', 'ibrex/'],
  ['https://elmballoon.com/faq/', 'faq/'],
  ['https://elmballoon.com/contact/', 'contact/'],
]);

function rewriteKnownLinks(html, prefix) {
  let result = html;
  for (const [source, route] of internalRoutes) {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(["'])${escaped}(?:/)?\\1`, 'g'), `$1${prefix}${route}$1`);
    result = result.replace(new RegExp(`(["'])https://(?:www\\.)?elmballoon\\.com/+${escapedRoute}(?:/)?\\1`, 'g'), `$1${prefix}${route}$1`);
  }
  return result.replace('</head>', '  <meta name="elm-mirror-source" content="https://elmballoon.com/">\n</head>');
}

for (const page of pages) {
  const response = await fetch(page.source, { headers: { 'User-Agent': 'elm-balloon-site-mirror/1.0' } });
  if (!response.ok) throw new Error(`${page.source}: HTTP ${response.status}`);
  const html = rewriteKnownLinks(await response.text(), page.prefix);
  const destination = path.join(root, page.output);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, html, 'utf8');
  console.log(`mirrored ${page.source} -> ${page.output}`);
}

const homePath = path.join(root, 'dist/index.html');
const home = await readFile(homePath, 'utf8');
await writeFile(homePath, rewriteKnownLinks(home, './').replace(
  /\s*<meta name="elm-mirror-source" content="https:\/\/elmballoon\.com\/">\n(?=<\/head>)/,
  '\n'
), 'utf8');
console.log('rewrote top-page navigation to local mirrored pages');
