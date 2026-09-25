import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'dist');
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else files.push(target);
  }
}

await walk(root);
const htmlFiles = files.filter((file) => file.endsWith('.html'));
const missing = [];
const originalDependencies = [];

for (const file of htmlFiles) {
  const source = await readFile(file, 'utf8');
  const html = source.replace(/<!--[\s\S]*?-->/g, '');
  for (const match of html.matchAll(/https?:\\?\/\\?\/(?:www\.)?elmballoon\.com/gi)) {
    originalDependencies.push(`${path.relative(root, file)}:${html.slice(0, match.index).split('\n').length}`);
  }
  const values = [];
  for (const match of html.matchAll(/(?:href|src|data-src|data-full-res)\s*=\s*["']([^"']+)["']/gi)) values.push(match[1]);
  for (const match of html.matchAll(/srcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const candidate of match[1].split(',')) values.push(candidate.trim().split(/\s+/)[0]);
  }
  for (const value of values) {
    if (!value || /^(?:https?:|\/\/|data:|mailto:|tel:|javascript:|#)/i.test(value)) continue;
    const clean = decodeURIComponent(value.split(/[?#]/)[0]);
    if (!clean) continue;
    let target = path.resolve(path.dirname(file), clean);
    try {
      const info = await stat(target);
      if (info.isDirectory()) target = path.join(target, 'index.html');
      await stat(target);
    } catch {
      missing.push(`${path.relative(root, file)} -> ${value}`);
    }
  }
}

console.log(`HTML pages: ${htmlFiles.length}`);
console.log(`Original-site dependencies: ${originalDependencies.length}`);
console.log(`Missing local targets: ${missing.length}`);
if (originalDependencies.length) console.log(originalDependencies.slice(0, 30).join('\n'));
if (missing.length) console.log(missing.slice(0, 60).join('\n'));
if (originalDependencies.length || missing.length) process.exitCode = 1;
