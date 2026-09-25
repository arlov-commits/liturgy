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

// layout(): every piece (one quarter of a sheet) has an odd page with the next even page behind it, and the
// pieces stacked in page order give every page once; each front half is a facing pair (even | odd)
{
  const { BACK_OF } = require('../js/impose.js');
  let ok = true;
  for (const n of [1, 2, 7, 8, 9, 41, 64, 101]) {
    const sheets = layout(n), pieces = [];
    for (const sh of sheets) for (let q = 0; q < 4; q++) pieces.push([sh.front[q], sh.back[BACK_OF[q]]]);
    const pages = pieces.map((pc) => pc.filter(Boolean).sort((x, y) => x - y)).filter((pc) => pc.length).sort((x, y) => x[0] - y[0]).flat();
    ok = ok && pieces.every(([a, b]) => !a || !b || Math.abs(a - b) === 1 && Math.max(a, b) % 2 === 0)
      && pages.length === n && pages.every((p, i) => p === i + 1)
      && sheets.every((sh) => [[0, 1], [2, 3]].every(([l, r]) => !sh.front[l] || (sh.front[l] % 2 === 0 && (!sh.front[r] || sh.front[r] === sh.front[l] + 1))));
  }
  const s1 = layout(8)[0];
  check(ok && s1.front.join() === '2,3,6,7' && s1.back.join() === '4,1,8,5', 'letter sheets: front 2 3 / 6 7, back 4 1 / 8 5; pieces stack in page order');
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
  if (req.method() === 'DELETE') {
    const body = JSON.parse(req.postData());
    if (!existsSync(file)) return json(404, {});
    if (body.sha !== sha(readFileSync(file))) return json(409, {});
    rmSync(file);
    return json(200, {});
  }
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
  if (statSync(file).isDirectory()) return json(200, readdirSync(file).map((name) => ({ name, type: statSync(path.join(file, name)).isDirectory() ? 'dir' : 'file' })));
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
// changes the text of the first chapter in the editor (which holds the whole booklet)
const edit = (fn) => page.evaluate((fn) => {
  const v = Editor.state.text.view, m = Editor.state.docMap[0], d = v.state.doc;
  const from = d.line(m.first).from, to = d.line(m.last).to;
  v.dispatch({ changes: { from, to, insert: new Function('t', fn)(d.sliceString(from, to)) } });
}, fn);

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
  // the preview frames are reused between layouts: a settings change must still apply every time
  await page.fill('#set--english-size', '8.2'); await afterEdit();
  const back = +((await status()).match(/(\d+) pages/) || [])[1];
  await page.fill('#set--english-size', '12'); await afterEdit();
  const again = +((await status()).match(/(\d+) pages/) || [])[1];
  check(back === pages && again === bigger, 'settings apply on every redraw (reused preview frames)', `${back}, ${again}`);

  await page.click('#tabs button[data-tab="text"]');
  const first = await page.evaluate(() => Editor.state.docMap[0].name);
  const heads = await page.evaluate(() => [Editor.state.docMap.length, document.querySelectorAll('.cm-chapter-head').length, Editor.state.book.sections.filter((s) => !s.virtual).length]);
  check(heads[0] > 1 && heads[0] === heads[2] && heads[1] > 0, 'the text holds the whole booklet, a title bar per chapter', heads.join());
  // the header lines can't be edited away
  const before = await page.evaluate(() => Editor.state.text.view.state.doc.toString());
  await page.evaluate(() => { const v = Editor.state.text.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'gone' } }); });
  check(await page.evaluate((b) => Editor.state.text.view.state.doc.toString() === b, before), 'chapter title bars can\'t be deleted');
  // pinyin lined up under the characters in the text: each syllable centred under its character
  const align = await page.evaluate(() => {
    const mid = (e) => { const r = e.getBoundingClientRect(); return r.left + r.width / 2; };
    const lines = [...document.querySelectorAll('.cm-line')];
    for (let i = 0; i + 1 < lines.length; i++) {
      const chars = [...lines[i].querySelectorAll('.cm-col')].filter((e) => /[一-鿿]/.test(e.textContent));
      const syl = [...lines[i + 1].querySelectorAll('.cm-col')];
      if (chars.length && syl.length && !/[一-鿿]/.test(syl[0].textContent)) return [chars.length, Math.max(...syl.map((e, k) => Math.abs(mid(e) - mid(chars[k]))))];
    }
    return [0, 99];
  });
  check(align[0] > 0 && align[1] < 1.5, 'text editor: pinyin lined up under the characters', `${align[0]} columns, off by ${align[1].toFixed(2)}px at most`);
  await page.click('#tabs button[data-tab="settings"]'); await page.uncheck('#align-pinyin');
  const off = await page.locator('.cm-col').count();
  await page.check('#align-pinyin'); await page.click('#tabs button[data-tab="text"]');
  check(off === 0 && await page.locator('.cm-col').count() > 0, 'lining up can be switched off in Settings');
  // contents list: a chapter link jumps to its text and is marked as the place you're at
  const navCount = await page.locator('#toc-nav a.nav-l0').count();
  await page.locator('#toc-nav a.nav-l0').nth(1).click(); await page.waitForTimeout(300);
  const nav = await page.evaluate(() => { const v = Editor.state.text.view, n = v.state.doc.lineAt(v.state.selection.main.head).number;
    const here = document.querySelector('#toc-nav a.here'); return [n, Editor.state.docMap[1].first, here && here.textContent]; });
  check(navCount === heads[0] && nav[0] === nav[1] && nav[2], 'contents list: jumps to a chapter and marks it', nav.join(' | '));
  await edit("return '// test edit\\n' + t"); await afterEdit();
  check((await page.textContent('#save')).includes('2 files'), 'unsaved changes are counted', await page.textContent('#save'));
  await page.keyboard.press('Control+s'); await saveDone();
  check((await status()).startsWith('Saved') && readFileSync(path.join(repo, 'edits', first), 'utf8').startsWith('// test edit') && !readFileSync(path.join(repo, 'text', first), 'utf8').startsWith('// test edit') &&
    readFileSync(path.join(repo, 'settings.css'), 'utf8').includes('--english-size: 12pt'), 'Ctrl+S saves text (as an edition — the original untouched) and settings');

  const line = await page.evaluate(() => { const d = Editor.state.text.view.state.doc; for (let i = 1; i < d.lines; i++) if (/[一-鿿]/.test(d.line(i).text) && !/[一-鿿]/.test(d.line(i + 1).text) && d.line(i + 1).text.trim()) return i + 1; });
  await page.evaluate((n) => { const v = Editor.state.text.view; const l = v.state.doc.line(n); const cut = l.text.lastIndexOf(' '); v.dispatch({ changes: { from: l.from + cut, to: l.to } }); }, line);
  await afterEdit();
  await page.evaluate((n) => Editor.state.text.goto(n, false), line); await page.waitForTimeout(200);
  check(await page.locator('.cm-lintRange-error').count() > 0 && (await status()).includes('problem'), 'pinyin count mismatch is flagged in text and pages');
  await page.keyboard.press('Control+z'); await afterEdit();

  const target = await preview().evaluate(() => { const b = document.querySelectorAll('.pagedjs_page')[2].querySelector('[data-line]'); b.scrollIntoView(); return b.dataset.line; });
  await preview().click(`.pagedjs_page:nth-child(3) [data-line="${target}"]`);
  const cursor = await page.evaluate(() => { const v = Editor.state.text.view, n = v.state.doc.lineAt(v.state.selection.main.head).number;
    const m = [...Editor.state.docMap].reverse().find((x) => x.head <= n); return n - m.first + 1; });
  check(String(cursor) === target, 'clicking a verse in the pages opens its line', `${target} → ${cursor}`);

  // Revert to the original: the edition file goes, the original was never touched
  await page.click('#tabs button[data-tab="book"]');
  const tagged = await page.locator('#chapters li:has(.tag)').count();
  await page.click(`#chapters li:has(.tag) button:has-text("Original")`);
  await page.keyboard.press('Control+s'); await saveDone();
  check(tagged === 1 && (await status()).startsWith('Saved') && !existsSync(path.join(repo, 'edits', first)) && (await page.locator('#chapters li:has(.tag)').count()) === 0,
    'Original: puts the original text back and removes the edition file', `tagged ${tagged}`);
  await page.click('#tabs button[data-tab="text"]');
  await edit("return t + '\\n// one\\n'"); await afterEdit(); await page.keyboard.press('Control+s'); await saveDone();
  writeFileSync(path.join(repo, 'edits', first), 'changed elsewhere\n');
  await edit("return t + '\\n// two\\n'"); await afterEdit();
  await page.click('#save'); await saveDone();
  check((await status()).includes('someone else'), 'never overwrites a newer change on GitHub');

  await page.evaluate(() => localStorage.setItem('liturgy.githubKey', 'rawcache'));
  page.once('dialog', (d) => d.accept());
  await page.reload(); await settled();
  check(/\d+ pages/.test(await status()), 'plain-text answers from GitHub (stale cache) still load', await status());
  await edit("return '// after raw read\\n' + t"); await afterEdit();
  await page.click('#save'); await saveDone();
  check((await status()).startsWith('Saved') && readFileSync(path.join(repo, 'edits', first), 'utf8').startsWith('// after raw read'),
    '…and still save (version looked up first)', await status());

  // Booklet tab: a new blank booklet, built by adding existing chapters
  const onDialog = (d) => (d.type() === 'prompt' ? d.accept('Test booklet') : d.accept());
  page.on('dialog', onDialog);
  await Promise.all([page.waitForNavigation(), page.selectOption('#book', '@new')]); await settled();
  page.off('dialog', onDialog);
  await page.waitForFunction(() => document.querySelectorAll('#add-chapter option').length > 1);
  const libraryNames = await page.evaluate(() => [...document.querySelectorAll('#add-chapter option')].slice(1, 3).map((o) => o.value));
  for (const n of libraryNames) { await page.selectOption('#add-chapter', n); await page.click('#add-chapter-btn'); await page.waitForTimeout(300); }
  await page.click('#chapters li:nth-child(2) button[title="Move up"]'); await afterEdit();
  await page.keyboard.press('Control+s'); await saveDone();
  const list = readFileSync(path.join(repo, 'books', 'test-booklet.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('//'));
  check(list.join() === [...libraryNames].reverse().join() && (await status()).startsWith('Saved'),
    'new booklet: add existing chapters, reorder, save', list.join(' '));

  await page.evaluate(() => localStorage.setItem('liturgy.githubKey', 'readonly'));
  page.once('dialog', (d) => d.accept());
  await page.reload(); await settled();
  await edit("return t + '\\n// three\\n'"); await afterEdit();
  await page.click('#save'); await saveDone();
  check((await status()).includes('can only read'), 'read-only key: explains how to fix it');
} finally {
  await browser.close();
  servers.forEach((s) => s.kill());
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
