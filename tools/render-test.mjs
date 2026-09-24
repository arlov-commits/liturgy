// render-test.mjs — dev harness: serves ../ (both repos), renders the preview with
// a given engine in headless Chromium, and writes a PDF + page PNG montage.
// Usage: node tools/render-test.mjs <engine: native|paged> <outdir> [book]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const [engine = 'paged', out = 'out', book = 'test'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const srv = spawn('python3', ['-m', 'http.server', '8765', '-d', '..'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()));
await page.goto(`http://localhost:8765/liturgy/index.html?engine=${engine === 'native' ? 'none' : engine}&book=${book}`);
await page.waitForFunction(() => document.body.dataset.ready, null, { timeout: 120000 });
console.log('[..]', await page.textContent('#status'));
await page.pdf({ path: `${out}/${engine}.pdf`, preferCSSPageSize: true });
console.log(`[ok] ${out}/${engine}.pdf`);
await browser.close(); srv.kill();
