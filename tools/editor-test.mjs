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
for (const p of ['edits', 'books/contents', 'books/settings', 'settings.css', 'booklets.txt', 'FEEDBACK.md']) rmSync(path.join(repo, p), { recursive: true, force: true });
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
  // folded signatures: split evenly (at most 8 sheets each, sizes differ by one at most); folding and nesting the
  // sheets of a signature gives the pages in order (the back of each page is the next one)
  const { signaturePlan, signatures } = require('../js/impose.js');
  let sigOk = true;
  for (let n = 1; n <= 140; n++) {
    const plan = signaturePlan(n, 'auto'), sheetsN = Math.ceil(n / 4);
    sigOk = sigOk && plan.reduce((a, b) => a + b, 0) === sheetsN && Math.max(...plan) <= 8 && Math.max(...plan) - Math.min(...plan) <= 1 && plan.length === Math.ceil(sheetsN / 8);
    // read each signature: sheet k outside → spread order: front right (recto), back left (verso) … then inner halves
    const got = [];
    let base = 0;
    for (const [sig, count] of plan.entries()) {
      const sh = signatures(n, 'auto').filter((x) => x.signature === sig);
      const order = [...sh.flatMap((x) => [x.front[1], x.back[0]]), ...sh.slice().reverse().flatMap((x) => [x.back[1], x.front[0]])];
      got.push(...order.map((p, i) => p || base + i + 1));
      base += count * 4;
    }
    sigOk = sigOk && got.every((p, i) => p === i + 1);
  }
  check(sigOk && signaturePlan(134, 'auto').join() === '7,7,7,7,6' && signaturePlan(40, 'all').join() === '10',
    'signatures: split evenly (at most 32 pages each), pages in order once folded and nested');
}

// note lines: "> " centred, ">> " on the right
{
  const { parse } = require('../js/parse.js');
  const html = parse('> centred\n>> on the right\n', 'x.txt');
  check(html.includes('<p class="en note">centred</p>') && html.includes('<p class="en note right">on the right</p>'), 'note lines: > centred, >> on the right');
  // a Chinese line without pinyin: the marker or comment line under it stays what it is (not taken as its pinyin)
  const { check: problemsOf } = require('../js/parse.js');
  const kept = problemsOf('[keep together]\n大學\n[/keep together]\n'), commented = parse('大學\n// note\ndà xué\n', 'x.txt');
  check(kept.length === 1 && /No pinyin/.test(kept[0].message) && !/never closed/.test(JSON.stringify(kept)) && !commented.includes('<rt>//</rt>'),
    'a Chinese line with no pinyin under it: a [/keep together] or // line there is not read as its pinyin', JSON.stringify(kept));
  // "# " and "## " are titles; "###" or "#word" are plain text (as the editor colours them)
  const heads = parse('#hashtag\n\n### three\n\n# Title\n\n## Small\n', 'x.txt');
  check(heads.includes('<p class="en">#hashtag</p>') && heads.includes('<p class="en">### three</p>') && /class="block title[^"]*"[^>]*><p class="en">Title</.test(heads) && heads.includes('class="block subtitle"'),
    '# and ## lines are titles; ### and #word stay plain text');
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
// (and every section in it open)
const openSettings = async () => { await page.click('#settings-btn'); await page.evaluate(() => document.querySelectorAll('#settings details').forEach((d) => (d.open = true))); };
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

  // feedback: notes about the app, saved to FEEDBACK.md with the text
  await page.click('#feedback-btn'); await page.click('#feedback-new');
  await page.keyboard.type('The zoom buttons are great.');
  await page.keyboard.press('Control+s'); await saveDone();
  const fb = existsSync(path.join(repo, 'FEEDBACK.md')) ? readFileSync(path.join(repo, 'FEEDBACK.md'), 'utf8') : '';
  await page.click('#feedback-panel .drawer-close');
  check(/^# Feedback/.test(fb) && /\n## \d{4}-\d\d-\d\d — test\n\nThe zoom buttons are great\./.test(fb), 'Feedback panel: a dated entry, saved to FEEDBACK.md', JSON.stringify(fb.slice(0, 120)));

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
  // …and each page on the sheets looks like the page itself, only scaled: the same margins, relative to its width
  const sameLook = await (await shownPreview()).evaluate(() => {
    const look = (p) => { const r = p.getBoundingClientRect(), a = p.querySelector('.pagedjs_area').getBoundingClientRect();
      return [a.left - r.left, r.right - a.right, a.top - r.top, r.bottom - a.bottom, r.height].map((v) => v / r.width); };
    const own = new Map([...document.querySelectorAll('.pagedjs_pages > .pagedjs_page')].map((p) => [p.dataset.pageNumber, look(p)]));
    buildSheets(); document.documentElement.classList.add('print-sheets');
    const off = [...document.querySelectorAll('#sheets .slot .pagedjs_page')].filter((p) => own.has(p.dataset.pageNumber))
      .map((p) => Math.max(...look(p).map((v, i) => Math.abs(v - own.get(p.dataset.pageNumber)[i]))));
    document.documentElement.classList.remove('print-sheets'); document.getElementById('sheets').remove();
    return [off.length, Math.max(...off)];
  });
  check(sameLook[0] > 4 && sameLook[1] < 0.005, 'print layout: every page has the same margins as on its own (only scaled)', `${sameLook[0]} pages, largest difference ${sameLook[1].toFixed(4)} of the width`);

  // a # title further down a chapter starts a new page (default); "straight after the text before" lets it run on
  const titleTops = async () => (await shownPreview()).evaluate(() => [...document.querySelectorAll('.pagedjs_page')].filter((p) => p.querySelector('.pagedjs_page_content .title-break')).length);
  await page.evaluate(() => { const v = Editor.state.text.view, d = v.state.doc, f = Editor.state.docMap[0].first;
    for (let i = f + 30; i < f + 200; i++) if (!d.line(i - 1).text.trim() && /^[A-Z]/.test(d.line(i).text)) { v.dispatch({ changes: { from: d.line(i).from, insert: '# A TITLE PARTWAY\n\n' } }); return; } });
  await afterEdit();
  const pagesBreaking = +((await status()).match(/(\d+) pages/) || [])[1];
  const breaksOn = await titleTops();
  // (first on its page, and marked by Paged.js to break before it)
  const titleFirst = () => shownPreview().then((f) => f.evaluate(() => [...document.querySelectorAll('.pagedjs_page_content .title-break')].every((b) =>
    b.closest('.pagedjs_page_content').querySelector('.block') === b && b.dataset.breakBefore === 'page')));
  const firstOnPage = await titleFirst();
  await openSettings(); await page.selectOption('#set--title-start', 'auto'); await closeSettings(); await afterEdit();
  const firstRunOn = await titleFirst();
  await openSettings(); await page.selectOption('#set--title-start', 'page'); await closeSettings(); await afterEdit();
  await page.click('#undo'); await afterEdit();
  check(breaksOn > 0 && firstOnPage && !firstRunOn, '# titles start a new page (setting: or run on)', `${breaksOn} title page(s) of ${pagesBreaking}; first on page: ${firstOnPage} / run on: ${firstRunOn}`);

  // views: single pages (fitted to the pane's width), side by side, print layout (the letter sheets, labelled);
  // zoom by hand, and back to fitting; the layout (page count) never changes
  const fitted = await page.textContent('#zoom-reset');
  await page.click('#zoom-in'); await page.click('#zoom-in');
  const zoomedBy = await page.textContent('#zoom-reset');
  await page.evaluate(() => Editor.refresh()); await afterEdit();
  const zoomPages = +((await status()).match(/(\d+) pages/) || [])[1];
  await page.click('#zoom-reset'); await page.waitForTimeout(300);
  const refit = await page.textContent('#zoom-reset');
  const width = (v) => page.evaluate(async (v) => { document.querySelector(`#views button[data-view=${v}]`).click(); await new Promise((r) => setTimeout(r, 400));
    const f = document.querySelector('#preview iframe:not(.loading)'); return [f.contentWindow.contentWidth(), document.querySelector('#zoom-reset').textContent]; }, v);
  const [single, spread] = [await width('single'), await width('spread')];
  await width('sheets');
  const sheetsView = await (await shownPreview()).evaluate(() => [document.querySelectorAll('#sheets .sheet').length, getComputedStyle(document.getElementById('book')).visibility, document.querySelector('#sheets .sheet-label')?.textContent]);
  // dragging the pages scrolls them
  await page.click('#zoom-in'); await page.click('#zoom-in'); await page.click('#zoom-in');
  const pv = await shownPreview(), scroll0 = await pv.evaluate(() => [scrollX, scrollY]);
  const mid = await page.$eval('#preview', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await page.mouse.move(mid[0], mid[1]); await page.mouse.down(); await page.mouse.move(mid[0] - 120, mid[1] - 160, { steps: 6 }); await page.mouse.up();
  const scroll1 = await pv.evaluate(() => [scrollX, scrollY]);
  await width('single');
  check(scroll1[0] > scroll0[0] && scroll1[1] > scroll0[1], 'dragging the pages scrolls them', `${scroll0} → ${scroll1}`);
  check(fitted === refit && zoomedBy !== fitted && zoomPages === pages && spread[0] > 1.8 * single[0] && parseInt(spread[1]) < parseInt(single[1]) &&
    sheetsView[0] === Math.ceil(pages / 8) * 2 && sheetsView[1] === 'hidden' && /^Sheet 1 · front/.test(sheetsView[2]),
    'views: single pages and side by side fitted to the pane, print layout shows the labelled sheets; zoom by hand and back to fit', `${single[1]} / ${spread[1]} / ${sheetsView[0]} sheets`);

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
  await page.fill('#set--english-size', '24'); await afterEdit();
  const bigger = +((await status()).match(/(\d+) pages/) || [])[1];
  check(bigger > pages, 'settings: bigger English makes more pages', `${pages} → ${bigger}`);
  // the preview frames are reused between layouts: a settings change must still apply every time
  await page.fill('#set--english-size', '16.4'); await afterEdit();
  const back = +((await status()).match(/(\d+) pages/) || [])[1];
  await page.fill('#set--english-size', '24'); await afterEdit();
  const again = +((await status()).match(/(\d+) pages/) || [])[1];
  check(back === pages && again === bigger, 'settings apply on every redraw (reused preview frames)', `${back}, ${again}`);
  await closeSettings();
  check(!(await page.isVisible('#settings')), 'settings drawer closes');
  await page.click('#print');
  const edge = await page.evaluate(() => [document.querySelector('#print-panel').getBoundingClientRect().right, document.querySelector('#panel').getBoundingClientRect().right].map(Math.round));
  check(await page.isVisible('#print-panel #print-pages') && await page.isVisible('#print-panel #print-sheets') && !(await page.isVisible('#settings')) && Math.abs(edge[0] - edge[1]) < 3,
    'Print panel: letter sheets, just the pages, instructions; reaches the text panel\'s edge', edge.join(' / '));
  await page.keyboard.press('Escape');
  // Settings → Format and binding: a nested choice; each format sets the page size; under it the three numbers
  // (pages printed, sheets, signatures) and in the Print panel the matching steps
  const metrics = () => page.textContent('#binding-metrics');
  await openSettings();
  const formats = await page.$$eval('.format-choice input[name=format]', (l) => l.map((x) => x.value + (x.checked ? '*' : '')).join());
  const quartoSoon = await page.isDisabled('.format-choice input[name=binding][value=signatures]');
  await page.check('.format-choice input[name=format][value=folio]'); await afterEdit();
  const folioPerfect = [await page.inputValue('#set--page-width'), await metrics()];
  await page.check('.format-choice input[name=binding][value=signatures]'); await page.selectOption('#set--signature-sheets', 'all'); await afterEdit();
  const oneSig = await metrics();
  const size = await page.inputValue('#set--english-size');
  await page.fill('#set--english-size', '40'); await afterEdit();   // (more pages: one signature gets too thick)
  const thick = [await metrics(), await status()];
  await page.fill('#set--english-size', size); await afterEdit();
  await page.selectOption('#set--signature-sheets', '2'); await afterEdit();
  const autoSig = await metrics();
  await page.selectOption('#set--signature-sheets', 'auto'); await afterEdit();
  await closeSettings(); await page.click('#print');
  const folded = [await page.isVisible('#print-folded'), await page.isVisible('#folded-signature-steps'), await page.isVisible('#folded-perfect-steps'), await page.isVisible('#print-perfect')];
  await page.keyboard.press('Escape');
  await openSettings(); await page.check('.format-choice input[name=format][value=letter]'); await afterEdit();
  const letter = [await page.inputValue('#set--page-width'), await page.isVisible('.format-choice input[name=binding]')];
  await closeSettings(); await page.click('#print');
  const letterPrint = [await page.isVisible('#print-inorder'), await page.textContent('#print-sheets')];
  await page.keyboard.press('Escape');
  await openSettings(); await page.check('.format-choice input[name=format][value=quarto]'); await closeSettings(); await afterEdit();
  const backToQuarto = [+((await status()).match(/(\d+) pages/) || [])[1], await page.evaluate(() => JSON.stringify(Editor.state.settings.changes))];
  check(formats === 'letter,folio,quarto*' && quartoSoon && folioPerfect[0] === '8.5' && /Pages printed: \d+/.test(folioPerfect[1]) && /Cut in half: \d+ pieces/.test(folioPerfect[1]) &&
    /Signatures: 1 — can be stapled/.test(oneSig) && /too thick/.test(thick[0]) && /too thick/.test(thick[1]) && /Signatures: [2-9] — .*sew and glue/.test(autoSig) &&
    folded.join() === 'true,true,false,false' && letter[0] === '8.5' && !letter[1] && letterPrint[0] && letterPrint[1] === 'Print on letter paper…' &&
    !/--format|--binding|--page-width/.test(backToQuarto[1]),
    'Format and binding: nested choice (the page size stays); pages printed, sheets and signatures shown (staple vs sew); print steps follow',
    `${folioPerfect[1]} | ${oneSig} | ${autoSig}`);
  const first = await page.evaluate(() => Editor.state.docMap[0].name);
  const heads = await page.evaluate(() => [Editor.state.docMap.length, document.querySelectorAll('.cm-chapter-head').length, Editor.state.book.sections.filter((s) => !s.virtual).length]);
  check(heads[0] > 1 && heads[0] === heads[2] && heads[1] > 0, 'the text holds the whole booklet, a title bar per chapter', heads.join());
  // below a title bar, ↓ goes one line at a time and a click lands on the line under the mouse (the bar's spacing
  // used to be margins CodeMirror couldn't see: ↓ skipped every other line); a long status message doesn't make the
  // top bar taller (that moved the text under the mouse)
  {
    const start = await page.evaluate(() => { const v = Editor.state.text.view, n = Editor.state.docMap[1].first;
      v.dispatch({ selection: { anchor: v.state.doc.line(n).from }, effects: CM.EditorView.scrollIntoView(v.state.doc.line(n).from, { y: 'start' }) }); v.focus(); return n; });
    await page.waitForTimeout(100);
    const lineAt = () => page.evaluate(() => { const v = Editor.state.text.view; return v.state.doc.lineAt(v.state.selection.main.head).number; });
    const steps = [];
    for (let i = 0, prev = start; i < 12; i++) { await page.keyboard.press('ArrowDown'); const n = await lineAt(); steps.push(n - prev); prev = n; }
    // a line further down whose end leaves room for the click inside the editor
    const at = await page.evaluate((n) => { const v = Editor.state.text.view, right = v.scrollDOM.getBoundingClientRect().right;
      for (;; n++) { const l = v.state.doc.line(n), c = v.coordsAtPos(l.to); if (l.text && c.right + 60 < right) return { x: c.right + 30, y: (c.top + c.bottom) / 2, to: l.to }; } }, start + 6);
    const barH = await page.evaluate(() => document.querySelector('#bar').offsetHeight);
    const barLong = await page.evaluate(() => { const s = document.querySelector('#status'), was = s.textContent; s.textContent = 'a long message '.repeat(30);
      const h = document.querySelector('#bar').offsetHeight; s.textContent = was; return h; });
    await page.mouse.click(at.x, at.y);
    const head = await page.evaluate(() => Editor.state.text.view.state.selection.main.head);
    check(steps.every((d) => d === 0 || d === 1) && steps.filter((d) => d === 1).length >= 8 && head === at.to && barLong === barH,
      '↓ goes one line at a time below a chapter title bar; a click past a line\'s end puts the cursor at its end; the top bar keeps its height',
      `${steps.join(',')} | ${head} vs ${at.to} | bar ${barH} → ${barLong}`);
  }
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
  const shades = await page.evaluate(() => [...document.querySelectorAll('.cm-line.cm-group')].map((l) => [(l.className.match(/cm-group-(keep|border|both)/) || [])[1], l.dataset.depth, getComputedStyle(l).backgroundColor]));
  // and a border on its own
  await page.evaluate(() => { const v = Editor.state.text.view, d = v.state.doc, f = Editor.state.docMap[0].first; v.dispatch({ selection: { anchor: d.line(f + 40).from, head: d.line(f + 42).to }, scrollIntoView: true }); });
  await page.click('#add-border'); await page.waitForTimeout(200);
  const alone = await page.evaluate(() => [...document.querySelectorAll('.cm-line.cm-group-border')].map((l) => getComputedStyle(l).backgroundColor));
  await page.click('#undo'); await page.click('#undo'); await page.click('#undo');
  const keepBg = shades.find((x) => x[0] === 'keep'), bothBg = shades.find((x) => x[0] === 'both');
  check(shades.filter((x) => x[0] === 'keep').length >= 5 && shades.filter((x) => x[0] === 'both' && x[1] === '2').length === 5 && alone.length === 5 &&
    new Set([keepBg[2], bothBg[2], alone[0]]).size === 3 && await dots() === '',
    'Keep together (amber) and Border (blue) groups shaded differently in the text; overlap blended and darker', `${keepBg[2]} | ${alone[0]} | ${bothBg[2]}`);
  // span tags come in pairs: Backspace at the end of [/border] takes out both tags (not the lines between); one Undo
  // puts both back; typing next to a tag goes on a line of its own
  {
    const f = await page.evaluate(() => Editor.state.docMap[0].first);
    const body = await page.evaluate((f) => { const d = Editor.state.text.view.state.doc; return [f + 12, f + 13, f + 14].map((n) => d.line(n).text).join('\n'); }, f);
    await page.evaluate((f) => { const v = Editor.state.text.view, d = v.state.doc; v.dispatch({ selection: { anchor: d.line(f + 12).from, head: d.line(f + 14).to }, scrollIntoView: true }); }, f);
    await page.click('#add-border');
    const wrapped = await page.evaluate(() => Editor.state.text.view.state.doc.toString());
    await page.evaluate((f) => { const v = Editor.state.text.view; v.dispatch({ selection: { anchor: v.state.doc.line(f + 16).to } }); v.focus(); }, f);
    const marked = await page.$$eval('.cm-tag-pair', (l) => l.map((x) => x.textContent).join());
    await page.keyboard.press('Backspace');
    const after = await page.evaluate(() => Editor.state.text.view.state.doc.toString());
    await page.keyboard.press('Control+z');
    const undone = await page.evaluate(() => Editor.state.text.view.state.doc.toString());
    await page.evaluate((f) => { const v = Editor.state.text.view; v.dispatch({ selection: { anchor: v.state.doc.line(f + 12).to } }); v.focus(); }, f);
    await page.keyboard.type('Hi');
    const typed = await page.evaluate((f) => { const d = Editor.state.text.view.state.doc; return [d.line(f + 12).text, d.line(f + 13).text]; }, f);
    await page.click('#undo'); await page.click('#undo');
    check(marked === '[border],[/border]' && !after.includes('[border]') && after.includes(body) && undone === wrapped && typed.join('|') === '[border]|Hi' && await dots() === '',
      'span tags: Backspace takes out the pair (lines between stay), Undo puts both back, typing beside a tag gets its own line; the pair is marked', `${marked} | ${typed.join('|')}`);
  }
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
    const here = document.querySelector('#toc-nav a.here .label'); return [n, Editor.state.docMap[1].first, here && here.textContent, Editor.state.docMap[1].name.replace(/\.txt$/, '')]; });
  check(navCount === heads[0] && nav[0] === nav[1] && nav[2] === nav[3], 'contents list: chapter file names; jumps to a chapter and marks it', nav.join(' | '));
  // (pages still being laid out: a spinner shows until the chapter is there, then it jumps)
  await (await shownPreview()).waitForFunction(() => document.getElementById('jumping').hidden, null, { timeout: 30000 });
  const pageTop = await (await shownPreview()).evaluate((f) => { const s = [...document.querySelectorAll('.pagedjs_page [data-file]')].find((x) => x.dataset.file === f);
    const top = Math.round(s.closest('.pagedjs_page').getBoundingClientRect().top), atEnd = scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
    return Math.abs(top) < 5 || (atEnd && top > 0 && top < innerHeight) ? 'ok' : `top at ${top}px`; }, nav[3] + '.txt');
  check(pageTop === 'ok', '…and shows the page it starts on at the top of the pages', pageTop);
  // a chapter can be renamed in the contents list (kept in the booklet's list; the chapter file keeps its name)
  page.once('dialog', (d) => d.accept('My short name'));
  await page.locator('#toc-nav a.nav-l0').nth(0).hover(); await page.locator('#toc-nav a.nav-l0').nth(0).locator('.rename').click();
  await page.evaluate(() => Editor.state.text.goto(1, false)); await page.waitForTimeout(150);
  const renamed = [await page.locator('#toc-nav a.nav-l0 .label').nth(0).textContent(), await page.evaluate(() => Editor.state.contents.text), await page.textContent('.cm-chapter-head[data-name="03-amitabha-sutra.txt"] .t')];
  page.once('dialog', (d) => d.accept(''));
  await page.locator('#toc-nav a.nav-l0').nth(0).dblclick();
  const unnamed = await page.evaluate(() => Editor.state.contents.text);
  check(renamed[0] === 'My short name' && /03-amitabha-sutra\.txt = My short name/.test(renamed[1]) && renamed[2] === 'My short name' && !/=/.test(unnamed),
    'contents list: rename a chapter for this booklet (and back)', renamed[0]);
  await edit("return '// test edit\\n' + t");
  const busyNow = await page.isVisible('#busy');
  await afterEdit();
  check(busyNow && !(await page.isVisible('#busy')), 'a spinner shows under the pages until a change is in');
  check((await page.textContent('#save')).includes('2 files'), 'unsaved changes are counted', await page.textContent('#save'));
  const printX = await page.evaluate(() => Math.round(document.querySelector('#print').getBoundingClientRect().left));
  await page.keyboard.press('Control+s'); await saveDone();
  check(await page.evaluate(() => Math.round(document.querySelector('#print').getBoundingClientRect().left)) === printX, 'the top-bar buttons stay put when the Save label changes');
  check((await status()).startsWith('Saved') && readFileSync(path.join(repo, 'edits', first), 'utf8').startsWith('// test edit') && !readFileSync(path.join(repo, 'text', first), 'utf8').startsWith('// test edit') &&
    readFileSync(path.join(repo, 'books', 'settings', 'test.css'), 'utf8').includes('--english-size: 24pt') && !existsSync(path.join(repo, 'settings.css')), 'Ctrl+S saves text (as an edition — the original untouched) and settings');

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

  // settings are the booklet's own: the new booklet starts from the defaults; copy them from another booklet (after a warning)
  const ownBefore = await page.evaluate(() => JSON.stringify(Editor.state.settings.changes));
  page.once('dialog', (d) => d.accept());
  await openSettings(); await page.selectOption('#copy-from', 'test'); await closeSettings(); await afterEdit();
  const copiedSize = await page.evaluate(() => Editor.state.settings.changes['--english-size']);
  await page.keyboard.press('Control+s'); await saveDone();
  check(ownBefore === '{}' && copiedSize === '24pt' && readFileSync(path.join(repo, 'books', 'settings', 'test-booklet.css'), 'utf8').includes('--english-size: 24pt'),
    'settings per booklet: a new booklet has its own; copy all settings from another booklet', `${ownBefore} → ${copiedSize}`);
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
  // …its entries are written out in the text: one line per chapter, "title [page of chapter]", with the page shown
  const tocText = () => page.evaluate(() => { const d = Editor.state.text.view.state.doc, m = Editor.state.docMap[0]; return d.sliceString(d.line(m.first).from, d.line(m.last).to); });
  const firstRef = (await tocText()).match(/\[page of ([^\]]+)\]/);
  await page.click('#tabs button[data-tab="text"]');
  await page.evaluate(() => Editor.state.text.goto(Editor.state.docMap[0].first, false)); await page.waitForTimeout(200);
  const chips = await page.$$eval('.cm-pagenum', (l) => l.map((x) => x.textContent));
  // a shorter title (an alias), then a page number typed by hand (warned), then back to the automatic one with a click
  await page.evaluate(() => { const v = Editor.state.text.view, d = v.state.doc, m = Editor.state.docMap[0];
    for (let i = m.first; i <= m.last; i++) { const t = d.line(i).text; if (/\[page of/.test(t)) { v.dispatch({ changes: { from: d.line(i).from, to: d.line(i).from + t.indexOf('[page'), insert: 'SHORT NAME ' } }); return; } } });
  await afterEdit();
  const aliasShown = await (await shownPreview()).evaluate(() => [...document.querySelectorAll('.toc-entry .toc-title')].map((t) => t.textContent));
  // (the reference is one chip: typing into it or deleting it alone doesn't happen; a click sets a number)
  await page.click('#tabs button[data-tab="text"]');
  await page.evaluate(() => Editor.state.text.goto(Editor.state.docMap[0].first, false)); await page.waitForTimeout(200);
  const beforeTry = await tocText();
  await page.evaluate(() => { const v = Editor.state.text.view, d = v.state.doc, m = Editor.state.docMap[0];
    for (let i = m.first; i <= m.last; i++) if (/\[page of/.test(d.line(i).text)) { v.dispatch({ selection: { anchor: d.line(i).to } }); v.focus(); return; } });
  await page.keyboard.press('Backspace');
  const refusedKept = (await tocText()) === beforeTry && /stay/.test(await status());
  page.once('dialog', (d) => d.accept('99'));
  await page.locator('.cm-pagenum').first().click();
  await afterEdit(); await page.waitForTimeout(700);
  const fixedShown = await (await shownPreview()).evaluate(() => document.querySelector('.toc-entry .toc-page').textContent);
  await page.evaluate(() => Editor.state.text.goto(Editor.state.docMap[0].first, false)); await page.waitForTimeout(200);
  const warned = await page.locator('.cm-lint-marker-warning').count();
  const handChip = await page.textContent('.cm-pagenum.fixed');
  page.once('dialog', (d) => d.accept(''));
  await page.click('.cm-pagenum.fixed'); await afterEdit();
  const tocBack = await tocText();
  check(firstRef && refusedKept && /\[\/contents\]/.test(await tocText()) && chips.length >= 2 && chips.every((c) => / · p\. \d+$/.test(c)) && aliasShown[0] === 'SHORT NAME' &&
    fixedShown === '99' && warned > 0 && /set by hand/.test(handChip) && /SHORT NAME \[page of /.test(tocBack) && !/page 99/.test(tocBack),
    'table of contents written out in the text: rename an entry; a page number typed by hand is warned; one click back to the automatic number',
    `${chips.join(',')} | ${aliasShown[0]} | ${fixedShown} | ${handChip}`);
  // every chapter gets a line (even one marked [toc: -]); "//" in front leaves one out, and it stays out as chapters are added
  await page.evaluate(() => { const v = Editor.state.text.view, d = v.state.doc, m = Editor.state.docMap[0];
    for (let i = m.last; i >= m.first; i--) { const t = d.line(i).text; if (/\[page of/.test(t)) { v.dispatch({ changes: { from: d.line(i).from, insert: '// ' } }); return; } } });
  await afterEdit();
  const rowsBefore = await (await shownPreview()).evaluate(() => document.querySelectorAll('.pagedjs_page .toc-entry').length);
  await page.click('#tabs button[data-tab="book"]');
  await page.selectOption('#add-chapter', '11-3-three-refuges.txt'); await page.click('#add-chapter-btn'); await afterEdit();
  await page.click('#tabs button[data-tab="text"]');
  const tocAfter = await tocText();
  const rowsAfter = await (await shownPreview()).evaluate(() => [...document.querySelectorAll('.pagedjs_page .toc-entry .toc-title')].map((t) => t.textContent));
  check(/^\/\/ .*\[page of /m.test(tocAfter) && /THREE REFUGES \[page of 11-3-three-refuges\]/.test(tocAfter) && rowsAfter.length === rowsBefore + 1 && rowsAfter.includes('THE THREE REFUGES'),
    'table of contents: a chapter added gets its line (even one marked [toc: -]); a line with // stays out', `${rowsBefore} → ${rowsAfter.join(' | ')}`);
  await page.click('#tabs button[data-tab="book"]');
  await page.locator('#chapters li', { hasText: 'THREE REFUGES' }).locator('button', { hasText: 'Remove' }).click(); await afterEdit();
  // every # title gets a line (under its chapter's), pointing at the title itself
  await page.selectOption('#add-chapter', '10-meal-offering.txt'); await page.click('#add-chapter-btn'); await afterEdit();
  await page.click('#tabs button[data-tab="text"]');
  const mealToc = await tocText();
  const mealPages = await (await shownPreview()).evaluate(() => {
    const row = [...document.querySelectorAll('.pagedjs_page .toc-entry')].find((r) => r.textContent.includes('PRAISE AND MANTRA'));
    const target = row && document.querySelector(row.querySelector('a.toc-page').getAttribute('href'));
    return [!!row, !!target && target.dataset.title, target && +target.closest('.pagedjs_page').dataset.pageNumber, document.querySelectorAll('.pagedjs_page .toc-entry .pageref-missing').length];
  });
  check(/^THE MEAL OFFERING BEFORE THE BUDDHAS \[page of 10-meal-offering\]$/m.test(mealToc) && /^  PRAISE AND MANTRA \[page of 10-meal-offering \/ PRAISE AND MANTRA\]$/m.test(mealToc) &&
    mealPages[0] && mealPages[1] === 'PRAISE AND MANTRA' && mealPages[2] === await page.evaluate(() => Editor.state.pageMap['10-meal-offering / PRAISE AND MANTRA']) && mealPages[3] === 0,
    'table of contents: every # title gets a line, pointing at the title\'s page', JSON.stringify(mealPages));
  await page.click('#tabs button[data-tab="book"]');
  await page.locator('#chapters li', { hasText: 'MEAL OFFERING' }).first().locator('button', { hasText: 'Remove' }).click(); await afterEdit();
  await page.click('#tabs button[data-tab="text"]');
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
