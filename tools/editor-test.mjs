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
// start from a known state, whatever is in the text repo now: a two-chapter test booklet, the app's default settings,
// no edited chapters, no tables of contents or booklet order
for (const p of ['edits', 'books/contents', 'settings.css', 'booklets.txt']) rmSync(path.join(repo, p), { recursive: true, force: true });
writeFileSync(path.join(repo, 'books', 'test.txt'), '// Test booklet (made by editor-test)\n03-amitabha-sutra.txt\n04-rebirth-mantra.txt\n');
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
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
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
// autosave off for these checks (each one saves when it means to); it is checked on its own below
await ctx.addInitScript(() => localStorage.setItem('liturgy.autosave', '0'));
const page = await ctx.newPage();
page.on('pageerror', (e) => check(false, 'no script errors', e.message));
const status = () => page.textContent('#status');
const settled = () => page.waitForFunction(() => { const s = document.querySelector('#status').textContent; return !/Updating|Loading|Saving/.test(s) && s.length > 0; }, null, { timeout: 60000 });
const saveDone = () => page.waitForFunction(() => /^(Saved|Not saved|Downloaded)/.test(document.querySelector('#status').textContent), null, { timeout: 30000 });
const afterEdit = async () => { await page.waitForTimeout(1200); await settled(); };
const openSettings = () => page.click('#settings-btn');
const closeSettings = () => page.click('#settings-close');
// the preview frame on show (the other one lays out the next version, hidden)
const shownPreview = async () => { const els = await page.$$('#preview iframe:not(.loading)'); return els.length ? els[0].contentFrame() : preview(); };
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

  // letter sheets: each copied page keeps its page number in the outside corner (right-hand pages: right)
  const sides = await (await shownPreview()).evaluate(() => {
    buildSheets(); document.documentElement.classList.add('print-sheets');
    const out = [...document.querySelectorAll('#sheets .slot .pagedjs_page')].map((p) => {
      const n = [...p.querySelectorAll('.pagedjs_margin-bottom > .hasContent, .pagedjs_margin-top > .hasContent')][0];
      if (!n) return 'ok';
      const pr = p.getBoundingClientRect(), r = n.querySelector('.pagedjs_margin-content').getBoundingClientRect();
      const right = r.left + r.width / 2 > pr.left + pr.width / 2;
      return right === p.classList.contains('pagedjs_right_page') ? 'ok' : 'wrong';
    });
    document.documentElement.classList.remove('print-sheets'); document.getElementById('sheets').remove();
    return out;
  });
  check(sides.length > 4 && sides.every((x) => x === 'ok'), 'letter sheets: page numbers in the outside corner (right-hand pages on the right)', sides.join(' '));

  // the contents list and the panel can be dragged wider
  const widths = () => page.evaluate(() => ['#toc-nav', '#panel'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().width)));
  const [navW, panelW] = await widths();
  for (const [k, dx] of [[0, 80], [1, 120]]) {
    const g = await page.locator('#app > .gutter').nth(k).boundingBox();
    await page.mouse.move(g.x + 3, g.y + 200); await page.mouse.down(); await page.mouse.move(g.x + 3 + dx, g.y + 200, { steps: 5 }); await page.mouse.up();
  }
  const [navW2, panelW2] = await widths();
  check(Math.abs(navW2 - navW - 80) < 4 && Math.abs(panelW2 - (panelW - 80 + 120)) < 4, 'contents list and panel can be dragged wider', `${navW}→${navW2}, ${panelW}→${panelW2}`);

  await openSettings();
  await page.fill('#set--english-size', '12'); await afterEdit();
  const bigger = +((await status()).match(/(\d+) pages/) || [])[1];
  check(bigger > pages, 'settings: bigger English makes more pages', `${pages} → ${bigger}`);
  // the preview frames are reused between layouts: a settings change must still apply every time
  await page.fill('#set--english-size', '8.2'); await afterEdit();
  const back = +((await status()).match(/(\d+) pages/) || [])[1];
  await page.fill('#set--english-size', '12'); await afterEdit();
  const again = +((await status()).match(/(\d+) pages/) || [])[1];
  check(back === pages && again === bigger, 'settings apply on every redraw (reused preview frames)', `${back}, ${again}`);
  await closeSettings();
  check(!(await page.isVisible('#settings')), 'settings drawer closes');
  await page.click('#print-more');
  check(await page.isVisible('#print-menu #print-pages') && await page.isVisible('#print-menu #print-sheets'), 'Print ▾ menu: letter sheets, just the pages, instructions');
  await page.keyboard.press('Escape');
  const first = await page.evaluate(() => Editor.state.docMap[0].name);
  const heads = await page.evaluate(() => [Editor.state.docMap.length, document.querySelectorAll('.cm-chapter-head').length, Editor.state.book.sections.filter((s) => !s.virtual).length]);
  check(heads[0] > 1 && heads[0] === heads[2] && heads[1] > 0, 'the text holds the whole booklet, a title bar per chapter', heads.join());
  // changed lines get a dot; clicking it puts the original back (a hollow dot stays: click it to have the change again)
  const textOf = (n) => page.evaluate((n) => Editor.state.text.view.state.doc.line(n).text, n);
  const dots = () => page.evaluate(() => [...document.querySelectorAll('.cm-changes .cm-dot:not(.cm-dot-spacer)')].map((d) => d.className.replace('cm-dot cm-dot-', '')).join());
  const lineN = await page.evaluate(() => Editor.state.docMap[0].first + 2);
  const was = await textOf(lineN);
  await page.evaluate((n) => { const v = Editor.state.text.view; v.dispatch({ selection: { anchor: v.state.doc.line(n).to } }); v.focus(); }, lineN);
  await page.keyboard.type(' extra');
  await page.waitForTimeout(100);
  const d1 = await dots();
  await page.locator('.cm-changes .cm-dot-changed').first().click();
  const [d2, t2] = [await dots(), await textOf(lineN)];
  await page.locator('.cm-changes .cm-dot-ghost').first().click();
  const [d3, t3] = [await dots(), await textOf(lineN)];
  check(d1 === 'changed' && d2 === 'ghost' && t2 === was && d3 === 'changed' && t3 === was + ' extra', 'changed line: dot; click → original (hollow dot stays); click again → change back', [d1, d2, d3].join(' / '));
  // Undo / Redo in the top bar, with the list of steps
  await page.click('#undo-more');
  const steps = await page.evaluate(() => [...document.querySelectorAll('#undo-menu .item')].map((b) => b.textContent));
  await page.locator('#undo-menu .item').nth(2).click();
  const t4 = await textOf(lineN);
  await page.click('#redo');
  const t5 = await textOf(lineN);
  await page.click('#undo');
  check(steps.length === 3 && /Your change again/.test(steps[0]) && /Back to the original/.test(steps[1]) && /Typing “extra”/.test(steps[2]) && t4 === was && t5 === was + ' extra' && await dots() === '',
    'Undo ▾ lists the steps (pick one to undo up to it); Redo; Undo', steps.join(' | '));
  // extra blank lines: space in the pages
  await page.evaluate(() => { const v = Editor.state.text.view, d = v.state.doc, m = Editor.state.docMap[0];
    for (let i = m.first + 1; i < m.last; i++) if (!d.line(i).text.trim() && /^[A-Za-z]/.test(d.line(i - 1).text)) { v.dispatch({ changes: { from: d.line(i).from, insert: '\n\n' } }); return; } });
  await afterEdit();
  const blanks = await (await shownPreview()).evaluate(() => document.querySelectorAll('.pagedjs_page .blank-line').length);
  await page.click('#undo'); await afterEdit();
  check(blanks === 2, 'three blank lines in a row: a block break and two empty lines in the pages', `${blanks} empty lines`);
  // Keep together / Border groups are shaded in the text, a shade darker when one is inside another
  await page.evaluate(() => { const v = Editor.state.text.view, d = v.state.doc, f = Editor.state.docMap[0].first; v.dispatch({ selection: { anchor: d.line(f + 12).from, head: d.line(f + 22).to }, scrollIntoView: true }); });
  await page.click('#keep-together');
  await page.evaluate(() => { const v = Editor.state.text.view, d = v.state.doc, f = Editor.state.docMap[0].first; v.dispatch({ selection: { anchor: d.line(f + 16).from, head: d.line(f + 18).to } }); });
  await page.click('#add-border');
  const shades = await page.evaluate(() => [...document.querySelectorAll('.cm-line')].map((l) => +((l.className.match(/cm-group-(\d)/) || [0, 0])[1])));
  await page.click('#undo'); await page.click('#undo');
  check(shades.filter((d) => d === 1).length >= 5 && shades.filter((d) => d === 2).length === 5 && await dots() === '', 'Keep together / Border groups shaded in the text, darker when nested', shades.join(''));
  // pasting: plain text at the cursor; over a selection running into the next chapter (the title bars stay, the text
  // goes where the selection started); copying leaves the title bars out
  const docNow = () => page.evaluate(() => Editor.state.text.view.state.doc.toString());
  const chapterNames = () => page.evaluate(() => Editor.state.docMap.map((m) => m.name).join());
  const before = await docNow(), headsBefore = await chapterNames();
  const selectLines = (a, b) => page.evaluate(([a, b]) => { const v = Editor.state.text.view, d = v.state.doc; v.dispatch({ selection: { anchor: d.line(a).from, head: d.line(b).to } }); v.focus(); }, [a, b]);
  const [h2, f1] = await page.evaluate(() => [Editor.state.docMap[1].head, Editor.state.docMap[0].first]);
  await selectLines(f1 + 1, f1 + 1); await page.keyboard.press('Control+c');
  const copied1 = await page.evaluate(() => navigator.clipboard.readText());
  await page.evaluate((n) => { const v = Editor.state.text.view; v.dispatch({ selection: { anchor: v.state.doc.line(n).to } }); v.focus(); }, f1 + 3);
  await page.keyboard.press('Control+v');
  const pasted = await textOf(f1 + 3);
  await selectLines(h2 - 2, h2 + 2); await page.keyboard.press('Control+c');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  await page.evaluate(() => navigator.clipboard.writeText('PASTED ACROSS'));
  await page.keyboard.press('Control+v');
  const across = [await chapterNames(), (await docNow()).includes('PASTED ACROSS'), await page.evaluate(() => { const d = Editor.state.text.view.state.doc, m = Editor.state.docMap[0]; return d.sliceString(d.line(m.first).from, d.line(m.last).to); })];
  await page.keyboard.press('Control+a'); await page.evaluate(() => navigator.clipboard.writeText('EVERYTHING'));
  await page.keyboard.press('Control+v');
  const all = [await chapterNames(), await page.evaluate(() => { const d = Editor.state.text.view.state.doc, m = Editor.state.docMap[0]; return d.line(m.first).text; })];
  await page.click('#undo'); await page.click('#undo'); await page.click('#undo');
  check(pasted.endsWith(copied1) && across[0] === headsBefore && across[1] && across[2].endsWith('PASTED ACROSS') && !copied.includes('\u2063') &&
    all[0] === headsBefore && all[1] === 'EVERYTHING' && await docNow() === before,
    'paste: at the cursor, over a selection across chapters, over Select All (title bars stay); copy leaves title bars out; undo');
  // pinyin lined up under the characters in the text (off until switched on in Settings): each syllable centred under its character
  const offAtFirst = await page.locator('.cm-col').count();
  await openSettings(); await page.check('#align-pinyin'); await closeSettings();
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
  check(offAtFirst === 0 && align[0] > 0 && align[1] < 1.5, 'text editor: pinyin lined up under the characters when switched on', `${align[0]} columns, off by ${align[1].toFixed(2)}px at most`);
  await openSettings(); await page.uncheck('#align-pinyin'); await closeSettings();
  check(await page.locator('.cm-col').count() === 0, '…and off again');
  // contents list: a chapter link jumps to its text and is marked as the place you're at
  const navCount = await page.locator('#toc-nav a.nav-l0').count();
  await page.locator('#toc-nav a.nav-l0').nth(1).click(); await page.waitForTimeout(300);
  const nav = await page.evaluate(() => { const v = Editor.state.text.view, n = v.state.doc.lineAt(v.state.selection.main.head).number;
    const here = document.querySelector('#toc-nav a.here'); return [n, Editor.state.docMap[1].first, here && here.textContent, Editor.state.docMap[1].name.replace(/\.txt$/, '')]; });
  check(navCount === heads[0] && nav[0] === nav[1] && nav[2] === nav[3], 'contents list: chapter file names; jumps to a chapter and marks it', nav.join(' | '));
  // (pages still being laid out: a spinner shows until the chapter is there, then it jumps)
  await (await shownPreview()).waitForFunction(() => document.getElementById('jumping').hidden, null, { timeout: 30000 });
  const pageTop = await (await shownPreview()).evaluate((f) => { const s = [...document.querySelectorAll('.pagedjs_page [data-file]')].find((x) => x.dataset.file === f);
    const top = Math.round(s.closest('.pagedjs_page').getBoundingClientRect().top), atEnd = scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
    return Math.abs(top) < 5 || (atEnd && top > 0 && top < innerHeight) ? 'ok' : `top at ${top}px`; }, nav[3] + '.txt');
  check(pageTop === 'ok', '…and shows the page it starts on at the top of the pages', pageTop);
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

  const shown = await shownPreview();
  const target = await shown.evaluate(() => { const b = document.querySelectorAll('.pagedjs_page')[2].querySelector('[data-line]'); b.scrollIntoView(); return b.dataset.line; });
  await shown.click(`.pagedjs_page:nth-child(3) [data-line="${target}"]`);
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

  // table of contents: in the text like a chapter, editable, saved with the booklet; its entry in the contents list shows its page
  // a chapter made in the editor: no dots (nothing to compare with)
  const onNew = (d) => (d.type() === 'prompt' ? d.accept('Brand new') : d.accept());
  page.on('dialog', onNew);
  await page.click('#tabs button[data-tab="book"]'); await page.click('#tab-book .new-chapter'); await afterEdit();
  page.off('dialog', onNew);
  await page.evaluate(() => { const v = Editor.state.text.view, m = Editor.state.docMap.find((x) => x.name === 'brand-new.txt'); v.dispatch({ changes: { from: v.state.doc.line(m.last).to, insert: '\nTyped in the new chapter' } }); Editor.state.text.goto(m.first, false); });
  await page.waitForTimeout(200);
  check(await dots() === '', 'a new chapter: no changed-line dots', await dots());
  await page.click('#tabs button[data-tab="book"]');
  await page.locator('#chapters li', { hasText: 'BRAND NEW' }).locator('button', { hasText: 'Remove' }).click(); await afterEdit();
  await page.click('#add-contents'); await afterEdit();
  const tocDoc = await page.evaluate(() => Editor.state.docMap[0].name);
  await page.evaluate(() => { const v = Editor.state.text.view, m = Editor.state.docMap[0]; v.dispatch({ changes: { from: v.state.doc.line(m.first).from, insert: '# OUR CONTENTS\n' } }); });
  await afterEdit();
  const tocShown = await (await shownPreview()).evaluate(() => document.querySelector('.pagedjs_page')?.textContent.includes('OUR CONTENTS'));
  await page.keyboard.press('Control+s'); await saveDone();
  const tocFile = path.join(repo, 'books', 'contents', 'test-booklet.txt');
  check(tocDoc === '[contents]' && tocShown && existsSync(tocFile) && readFileSync(tocFile, 'utf8').startsWith('# OUR CONTENTS') && readFileSync(path.join(repo, 'books', 'test-booklet.txt'), 'utf8').includes('[contents]'),
    'table of contents: shown and edited in the text, saved with the booklet');
  // autosave: switched on in the Save ▾ menu, it saves a few seconds after the last change
  await page.click('#save-more'); await page.check('#autosave'); await page.keyboard.press('Escape');
  await page.evaluate(() => { const v = Editor.state.text.view, m = Editor.state.docMap[0]; v.dispatch({ changes: { from: v.state.doc.line(m.first).from, insert: '> autosaved note\n' } }); });
  await page.waitForFunction(() => document.querySelector('#save').textContent === 'Saved', null, { timeout: 15000 }).catch(() => {});
  check(readFileSync(tocFile, 'utf8').startsWith('> autosaved note') && await page.textContent('#save-more') === 'auto ▾', 'autosave: saves by itself a few seconds after a change');
  await page.click('#save-more'); await page.uncheck('#autosave'); await page.keyboard.press('Escape');
  await (await shownPreview()).evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.locator('#toc-nav a.nav-l0').first().click(); await page.waitForTimeout(300);
  const tocTop = await (await shownPreview()).evaluate(() => Math.round(document.querySelector('.pagedjs_page').getBoundingClientRect().top));
  check(Math.abs(tocTop) < 5, '…and its entry in the contents list shows its page', `top at ${tocTop}px`);

  // Edit booklets: reorder, rename (the open one: it opens under its new name), delete (after a confirmation)
  const bookDialogs = (d) => (d.type() === 'prompt' ? d.accept('Renamed booklet') : d.accept());
  page.on('dialog', bookDialogs);
  await page.selectOption('#book', '@edit');
  await page.waitForSelector('#books-dialog[open] #books-list li');
  const booksBefore = await page.$$eval('#books-list li .title', (l) => l.map((x) => x.textContent));
  await page.locator('#books-list li').last().locator('button[title="Move up"]').click();
  await page.waitForFunction((n) => document.querySelectorAll('#books-list li').length === n && !document.querySelector('#books-list button:disabled:not([title="Move up"]):not([title="Move down"])'), booksBefore.length);
  const order = readFileSync(path.join(repo, 'booklets.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('//'));
  await page.locator('#books-list li', { hasText: '(open now)' }).locator('button', { hasText: 'Rename' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('#books-list li .title')].some((t) => t.textContent.startsWith('renamed-booklet')));
  const other = booksBefore.find((n) => !n.includes('(open now)') && n !== 'renamed-booklet');
  await page.locator('#books-list li', { hasText: other }).locator('button', { hasText: 'Delete' }).click();
  await page.waitForFunction((o) => ![...document.querySelectorAll('#books-list li .title')].some((t) => t.textContent === o), other);
  await Promise.all([page.waitForNavigation(), page.click('#books-dialog button:has-text("Close")')]); await settled();
  page.off('dialog', bookDialogs);
  const booksDir = readdirSync(path.join(repo, 'books'));
  check(order.length === booksBefore.length && order[order.length - 2] === booksBefore[booksBefore.length - 1].replace(' (open now)', '') &&
    booksDir.includes('renamed-booklet.txt') && !booksDir.includes('test-booklet.txt') && existsSync(path.join(repo, 'books', 'contents', 'renamed-booklet.txt')) &&
    !booksDir.includes(other + '.txt') && new URL(page.url()).searchParams.get('book') === 'renamed-booklet' && /\d+ pages/.test(await status()),
    'Edit booklets: reorder, rename (with its table of contents), delete', `${order.join(',')} | ${booksDir.join(',')}`);

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
