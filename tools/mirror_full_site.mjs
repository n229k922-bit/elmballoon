import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const distRoot = path.join(projectRoot, 'dist');
const origin = 'https://elmballoon.com';
const githubOrigin = 'https://n229k922-bit.github.io/elmballoon';
const seeds = [
  '/about/', '/category/news/', '/item/', '/balloon/', '/ibrex/', '/faq/', '/contact/'
];
const pageQueue = seeds.map((pathname) => new URL(pathname, origin));
const seenPages = new Set();
const pageSources = new Map();
const assetUrls = new Set();
const allowedPage = /^\/(?:about|balloon|ibrex|faq|contact|item(?:\/|$)|item_category(?:\/|$)|category\/news(?:\/|$)|20\d{2}\/\d{2}\/\d{2}\/post-[^/]+\/)/;
const assetExtension = /\.(?:css|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot)(?:$|\?)/i;

function normalizedUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (url.origin === origin) url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function isPage(url) {
  return url.origin === origin && allowedPage.test(url.pathname) && !assetExtension.test(url.pathname);
}

function pageOutput(url) {
  const clean = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
  return path.join(distRoot, clean, 'index.html');
}

function assetOutput(url) {
  return path.join(distRoot, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
}

function localReference(fromFile, targetFile, directory = false) {
  let relative = path.relative(path.dirname(fromFile), targetFile).split(path.sep).join('/');
  if (!relative.startsWith('.')) relative = './' + relative;
  if (directory) relative = relative.replace(/index\.html$/, '');
  return relative;
}

function collectLinks(html, base) {
  const values = [];
  for (const match of html.matchAll(/(?:href|src|data-src|data-full-res)\s*=\s*["']([^"']+)["']/gi)) values.push(match[1]);
  for (const match of html.matchAll(/srcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const candidate of match[1].split(',')) values.push(candidate.trim().split(/\s+/)[0]);
  }
  for (const match of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) values.push(match[1]);
  for (const value of values) {
    if (/^(?:data:|mailto:|tel:|javascript:|#)/i.test(value)) continue;
    const url = normalizedUrl(value, base);
    if (!url) continue;
    if (isPage(url) && !seenPages.has(url.pathname)) pageQueue.push(url);
    if (url.origin === origin && assetExtension.test(url.pathname)) assetUrls.add(url.href);
  }
}

const homeOutput = path.join(distRoot, 'index.html');
const currentHome = await readFile(homeOutput, 'utf8');
collectLinks(currentHome, new URL('/', origin));

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'elm-balloon-github-mirror/2.0' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

while (pageQueue.length) {
  const url = pageQueue.shift();
  if (seenPages.has(url.pathname) || !isPage(url)) continue;
  seenPages.add(url.pathname);
  try {
    const html = await fetchText(url);
    pageSources.set(url.pathname, { url, html });
    collectLinks(html, url);
    console.log(`page ${url.pathname}`);
  } catch (error) {
    console.warn(`skip page ${error.message}`);
  }
  if (seenPages.size > 300) throw new Error('Page safety limit exceeded');
}

const downloadedAssets = new Set();
const pendingAssets = [...assetUrls];
while (pendingAssets.length) {
  const href = pendingAssets.shift();
  const url = new URL(href);
  if (downloadedAssets.has(url.pathname)) continue;
  downloadedAssets.add(url.pathname);
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'elm-balloon-github-mirror/2.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const destination = assetOutput(url);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    if (/\.css$/i.test(url.pathname)) {
      const css = new TextDecoder().decode(bytes);
      for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
        const nested = normalizedUrl(match[1], url);
        if (nested?.origin === origin && assetExtension.test(nested.pathname) && !downloadedAssets.has(nested.pathname)) pendingAssets.push(nested.href);
      }
    }
  } catch (error) {
    console.warn(`skip asset ${url.pathname}: ${error.message}`);
  }
  if (downloadedAssets.size > 2000) throw new Error('Asset safety limit exceeded');
}

function rewriteHtml(source, currentUrl, output) {
  let rewritten = source.replace(/((?:href|src|data-src|data-full-res)\s*=\s*["'])([^"']+)(["'])/gi, (whole, before, value, after) => {
    if (/^(?:data:|mailto:|tel:|javascript:|#)/i.test(value)) return whole;
    const target = normalizedUrl(value, currentUrl);
    if (!target || target.origin !== origin) return whole;
    if (isPage(target) && pageSources.has(target.pathname)) return before + localReference(output, pageOutput(target), true) + (target.search || '') + after;
    if (assetExtension.test(target.pathname) && downloadedAssets.has(target.pathname)) return before + localReference(output, assetOutput(target)) + (target.search || '') + after;
    if (target.pathname === '/') return before + localReference(output, path.join(distRoot, 'index.html'), true) + after;
    return whole;
  });
  rewritten = rewritten.replace(/(srcset\s*=\s*["'])([^"']+)(["'])/gi, (whole, before, value, after) => {
    const candidates = value.split(',').map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const target = normalizedUrl(parts[0], currentUrl);
      if (target?.origin === origin && downloadedAssets.has(target.pathname)) {
        parts[0] = localReference(output, assetOutput(target)) + (target.search || '');
      }
      return parts.join(' ');
    });
    return before + candidates.join(', ') + after;
  });
  const localizedInlineAssets = rewritten.replace(/https:\/\/(?:www\.)?elmballoon\.com\/+[^"'\s)<]+/gi, (value) => {
    const target = normalizedUrl(value.replace(/&amp;/g, '&'), currentUrl);
    if (!target) return value;
    if (assetExtension.test(target.pathname) && downloadedAssets.has(target.pathname)) return localReference(output, assetOutput(target)) + (target.search || '');
    if (isPage(target) && pageSources.has(target.pathname)) return localReference(output, pageOutput(target), true) + (target.search || '');
    return value;
  });
  const githubPage = `${githubOrigin}${currentUrl.pathname}`;
  const localTheme = localReference(output, path.join(distRoot, 'wp/wp-content/themes/elmballoon3/'));
  let sanitized = localizedInlineAssets
    .replace(/https:\/\/(?:www\.)?elmballoon\.com\/?/gi, githubOrigin + '/')
    .replace(/https:\\?\/\\?\/(?:www\.)?elmballoon\.com\\?\/?/gi, githubOrigin.replaceAll('/', '\\/') + '\\/')
    .replace(/(<meta\s+property=["']og:url["']\s+content=["'])[^"']*(["'])/i, `$1${githubPage}$2`)
    .replace(/(<link\s+rel=["']canonical["']\s+href=["'])[^"']*(["'])/i, `$1${githubPage}$2`)
    .replace(/(<body\b[^>]*\bdata-tmpdir=["'])[^"']*(["'])/i, `$1${localTheme}$2`)
    .replace(/<script type="text\/javascript">\s*var sbiajaxurl[\s\S]*?<\/script>/gi, '')
    .replace(/<script id=['"]contact-form-7-js-extra['"]>[\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]+id=['"]contact-form-7-js['"][^>]*><\/script>/gi, '')
    .replace(/<script id=['"]cf7msm-js-extra['"]>[\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]+id=['"]cf7msm-js['"][^>]*><\/script>/gi, '')
    .replace(/<!--\[if\s+lt\s+IE[\s\S]*?<!\[endif\]-->/gi, '')
    .replace(/<link rel=["']icon["'] type=["'][^"']*["']/i, '<link rel="icon" type="image/x-icon"');
  return sanitized.includes('name="elm-github-mirror"')
    ? sanitized
    : sanitized.replace('</head>', '  <meta name="elm-github-mirror" content="independent-static-copy">\n</head>');
}

for (const { url, html } of pageSources.values()) {
  const output = pageOutput(url);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, rewriteHtml(html, url, output), 'utf8');
}

await writeFile(homeOutput, rewriteHtml(currentHome, new URL('/', origin), homeOutput), 'utf8');

console.log(`complete: ${pageSources.size} pages, ${downloadedAssets.size} assets`);
