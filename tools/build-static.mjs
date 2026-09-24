// build-static.mjs — builds one HTML file (linking ../css, ../fonts) from a booklet list,
// for engines that don't run the app's JavaScript (e.g. Vivliostyle CLI, CI PDF builds).
// Usage: node tools/build-static.mjs <liturgy-text folder> <book name> <out.html>
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { parse } = require('../js/parse.js');
const [textDir, book = 'test', out = 'book.html'] = process.argv.slice(2);
const list = readFileSync(path.join(textDir, 'books', book + '.txt'), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('//'));
const body = list.map((f) => parse(readFileSync(path.join(textDir, 'text', f), 'utf8'), f)).join('\n');
const rel = path.relative(path.dirname(path.resolve(out)), process.cwd()).replace(/\\/g, '/') || '.';
writeFileSync(out, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${book}</title>
<link rel="stylesheet" href="${rel}/fonts/fonts.css"><link rel="stylesheet" href="${rel}/css/settings.css"><link rel="stylesheet" href="${rel}/css/book.css">
</head><body>${body}</body></html>`);
console.log(`[ok] ${list.length} section(s) -> ${out}`);
