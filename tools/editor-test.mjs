// editor-test.mjs — end-to-end checks of the editor in headless Chromium, against a stand-in for GitHub's API
// backed by a temporary copy of ../liturgy-text (never committed; the copy is deleted afterwards).
// Usage: node tools/editor-test.mjs          (CHROMIUM=<path> to use another Chromium)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { layout } = require('../js/impose.js');

const app = path.resolve('.');
const tmp = mkdtempSync(path.join(tmpdir(), 'liturgy-test-'));
const repo = path.join(tmp, 'repo');                  // the fake GitHub repo
cpSync(path.resolve('../liturgy-text'), repo, { recursive: true, filter: (p) => !p.includes('/.git') });
mkdirSync(path.join(tmp, 'site'));
symlinkSync(app, path.join(tmp, 'site', 'liturgy'));   // like github.io: no liturgy-text next to the app

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  — ' + detail : ''}`); if (!ok) failed++; };

// layout(): cut-and-stack order puts the pages back in order
{
  let ok = true;
  for (const n of [1, 2, 7, 8, 9, 41, 64, 101]) {
    const sheets = layout(n), order = [];
    for (let q = 0; q < 4; q++) for (const sh of sheets) order.push(sh.front[q], sh.back[[1, 0, 3, 2][q]]);
    const pages = order.filter(Boolean);
    ok = ok && pages.length === n && pages.every((p, i) => p === i + 1);
  }
  check(ok, 'letter sheets: cut-and-stack gives pages 1…N in order');
}

const servers = [spawn('python3', ['-m', 'http.server', '8791', '-d', path.join(tmp, 'site')], { stdio: 'ignore' })];
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const sha = (b) => createHash('sha1').update(b).digest('hex');
const rawSeen = new Set();
await ctx.route('https://api.github.com/**', async (route) => {
  const req = route.request(), auth = req.headers().authorization || '', url = new URL(req.url());
  const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  const json = (status, body) => route.fulfill({ status, headers, body: JSON.stringify(body) });
  if (auth === 'Bearer bad') return json(401, {});
  const m = url.pathname.match(/^\/repos\/arlov-commits\/liturgy-text(?:\/contents\/?(.*))?$/);
  if (!m) return json(404, {});
  if (m[1] === undefined) return json(200, { name: 'liturgy-text' });
  const rel = decodeURIComponent(m[1]), file = path.join(repo, rel);
  if (req.method() === 'PUT') {
    if (auth === 'Bearer readonly') return json(403, {});
    const body = JSON.parse(req.postData());
    const cur = existsSync(file) ? sha(readFileSync(file)) : undefined;
    if (cur && body.sha !== cur) return json(409, {});
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(body.content, 'base64'));
    return json(200, { content: { sha: sha(readFileSync(file)) } });
  }
  if (!existsSync(file)) return json(404, {});
  // 'rawcache' key: the first read of each file answers with the plain file, like a stale browser cache did
  if (auth === 'Bearer rawcache' && !statSync(file).isDirectory() && !rawSeen.has(rel)) {
    rawSeen.add(rel);
    return route.fulfill({ status: 200, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' }, body: readFileSync(file) });
  }
  if (statSync(file).isDirectory()) return json(200, readdirSync(file).map((name) => ({ name, type: 'file' })));
  const buf = readFileSync(file);
  return json(200, { sha: sha(buf), content: buf.toString('base64'), encoding: 'base64' });
});
const page = await ctx.newPage();
page.on('pageerror', (e) => check(false, 'no script errors', e.message));
const status = () => page.textContent('#status');
const settled = () => page.waitForFunction(() => { const s = document.querySelector('#status').textContent; return !/Updating|Loading|Saving/.test(s) && s.length > 0; }, null, { timeout: 60000 });
const saveDone = () => page.waitForFunction(() => /^(Saved|Not saved|Downloaded)/.test(document.querySelector('#status').textContent), null, { timeout: 30000 });
const afterEdit = async () => { await page.waitForTimeout(1200); await settled(); };
const preview = () => page.frames().find((f) => f.url().includes('preview.html'));
const edit = (fn) => page.evaluate((fn) => { const v = Editor.state.text.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: new Function('t', fn)(v.state.doc.toString()) } }); }, fn);

try {
  await page.goto('http://localhost:8791/liturgy/index.html'); await settled();
  check(await page.isVisible('#signin'), 'online without a key: asks for one');

  await page.fill('#signin input', 'bad'); await Promise.all([page.waitForNavigation(), page.click('#signin button')]); await settled();
  check((await page.textContent('#signin .why')).includes('did not accept'), 'wrong key: says so');

  await page.fill('#signin input', 'good'); await Promise.all([page.waitForNavigation(), page.click('#signin button')]); await settled();
  const pages = +((await status()).match(/(\d+) pages/) || [])[1];
  check(pages > 0 && !(await status()).includes('problem'), 'good key: booklet renders', await status());

  await page.click('#tabs button[data-tab="settings"]');
  await page.fill('#set--english-size', '12'); await afterEdit();
  const bigger = +((await status()).match(/(\d+) pages/) || [])[1];
  check(bigger > pages, 'settings: bigger English makes more pages', `${pages} → ${bigger}`);

  await page.click('#tabs button[data-tab="text"]');
  const first = await page.inputValue('#section');
  await edit("return '// test edit\\n' + t"); await afterEdit();
  check((await page.textContent('#save')).includes('2 files'), 'unsaved changes are counted', await page.textContent('#save'));
  await page.keyboard.press('Control+s'); await saveDone();
  check((await status()).startsWith('Saved') && readFileSync(path.join(repo, 'text', first), 'utf8').startsWith('// test edit') &&
    readFileSync(path.join(repo, 'settings.css'), 'utf8').includes('--english-size: 12pt'), 'Ctrl+S saves text and settings to the repo');

  const line = await page.evaluate(() => { const d = Editor.state.text.view.state.doc; for (let i = 1; i < d.lines; i++) if (/[一-鿿]/.test(d.line(i).text) && !/[一-鿿]/.test(d.line(i + 1).text) && d.line(i + 1).text.trim()) return i + 1; });
  await page.evaluate((n) => { const v = Editor.state.text.view; const l = v.state.doc.line(n); const cut = l.text.lastIndexOf(' '); v.dispatch({ changes: { from: l.from + cut, to: l.to } }); }, line);
  await afterEdit();
  check(await page.locator('.cm-lintRange-error').count() > 0 && (await status()).includes('problem'), 'pinyin count mismatch is flagged in text and pages');
  await page.keyboard.press('Control+z'); await afterEdit();

  const target = await preview().evaluate(() => { const b = document.querySelectorAll('.pagedjs_page')[2].querySelector('[data-line]'); b.scrollIntoView(); return b.dataset.line; });
  await preview().click(`.pagedjs_page:nth-child(3) [data-line="${target}"]`);
  const cursor = await page.evaluate(() => { const v = Editor.state.text.view; return v.state.doc.lineAt(v.state.selection.main.head).number; });
  check(String(cursor) === target, 'clicking a verse in the pages opens its line', `${target} → ${cursor}`);

  writeFileSync(path.join(repo, 'text', first), 'changed elsewhere\n');
  await edit("return t + '\\n'"); await afterEdit();
  await page.click('#save'); await saveDone();
  check((await status()).includes('someone else'), 'never overwrites a newer change on GitHub');

  await page.evaluate(() => localStorage.setItem('liturgy.githubKey', 'rawcache'));
  page.once('dialog', (d) => d.accept());
  await page.reload(); await settled();
  check(/\d+ pages/.test(await status()), 'plain-text answers from GitHub (stale cache) still load', await status());
  await edit("return '// after raw read\\n' + t"); await afterEdit();
  await page.click('#save'); await saveDone();
  check((await status()).startsWith('Saved') && readFileSync(path.join(repo, 'text', first), 'utf8').startsWith('// after raw read'),
    '…and still save (version looked up first)', await status());

  await page.evaluate(() => localStorage.setItem('liturgy.githubKey', 'readonly'));
  page.once('dialog', (d) => d.accept());
  await page.reload(); await settled();
  await edit("return t + '\\n'"); await afterEdit();
  await page.click('#save'); await saveDone();
  check((await status()).includes('can only read'), 'read-only key: explains how to fix it');
} finally {
  await browser.close();
  servers.forEach((s) => s.kill());
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
