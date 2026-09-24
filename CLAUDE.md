# CLAUDE.md — liturgy booklet app

## What this is
A browser app that turns plain-text liturgy files (English / Chinese / pinyin) into printable
quarter-letter booklet pages (4.25 × 5.5 in), bound by a glue (perfect-bind) machine.
It will be used by a **non-technical editor**. Every feature must be usable without knowing code.

## Two repos
- **`liturgy` (this repo, public):** app code only.
- **`liturgy-text` (private):** the actual liturgy text (BTTS translation — never copy it into
  this public repo, not even as test fixtures). For development, clone it next to this repo:
  `../liturgy-text/`. Layout there: `text/*.txt` (one file per liturgical section — Excel tabs were
  merged; `// ====== from Excel …` comments mark the old tab boundaries), `books/*.txt`
  (a booklet = a list of section files in order), `tools/` (the Excel converter).

## Non-negotiable rule: use existing libraries, don't hand-roll
The owner was burned by a hand-built editor (bold toggling nested `<b><b>` instead of unbolding).
Before writing any non-trivial feature, look for a maintained open-source library and use it.
Current choices:

| Job | Use | Notes |
|---|---|---|
| Pagination / on-screen page preview | **Paged.js** (vendored, `vendor/paged.min.js`) | Chosen over Vivliostyle in Phase 2 (see below). Needs the small var-filling shim in `index.html` because it can't read `var()` inside `@page`. |
| Pinyin under characters | native `<ruby>` + `ruby-position: under` | never position pinyin manually |
| Final print | Chrome's print of the Paged.js preview: **Print…** = letter sheets, 4 pages a side (`preview.html printSheets`); Print tab → “just the pages” for checking | Printing the plain page without Paged.js paginates differently (39 vs 41 pages) — always print from the preview. |
| Text editing | **CodeMirror 6** (vendored, `vendor/codemirror.min.js`) | never `contenteditable`. Bundle built from `tools/vendor/codemirror.mjs` by `npm run vendor` — add any new CodeMirror import there. |
| Pinyin checking | **pinyin-pro** (vendored, loaded only when “Suggest pinyin readings” is ticked) | suggestions only (blue dotted, opt-in) — liturgical readings (nā mó, 土 dù, 般若 bō rě) are deliberate. `toneSandhi: false` so 一/不 aren't flagged. |
| Letter-sheet imposition | none needed: the Paged.js pages are copied into a 2 × 2 letter-sheet grid and printed with `@page { size: letter }` | Order in `js/impose.js`, per sheet of 8 pages: front 2 3 / 6 7, back 4 1 / 8 5 (duplex, flip on long edge); cut in four, stack in page order. Each copy gets `counter-reset: page n−1` so page numbers stay right. (Replaced the earlier save-PDF-then-upload step with pdf-lib.) |
| Fonts | **Fontsource** packages, self-hosted in `fonts/` | English choices (Settings): Lora, Gentium Book Plus, Crimson Pro, Alegreya, Libre Baskerville, Merriweather, Noto Serif, Source Serif 4, Noto Sans, Source Sans 3 — Latin + Latin Extended, 400/600 + italics. Rejected at the tone-mark check: EB Garamond (bold À), Spectral (ǖǘǚǜ), Cormorant Garamond (carons). |
| Remembering a picked folder | **idb-keyval** (vendored) | stores the folder handle in IndexedDB |

Our own code should stay small glue: `js/parse.js` (text → HTML), `js/source.js` (where the text is read from),
`js/editor.js` (the editor page, incl. the Booklet tab), `js/texttab.js` / `js/settings.js` (Text and Settings tabs) and wiring.
In the UI a section file is a **chapter**; a booklet is built by adding existing chapters (shared between booklets) or new ones.
The Text tab's colouring repeats `parse.js`'s line rules — keep them in step with FORMAT.md.

## Pages
- `index.html` — the editor: top bar, panels, and the pages in a frame. **Two** preview frames take turns: the next
  version is laid out in the hidden one (`preview.html rerender()`, fonts stay loaded between layouts) and swapped
  in as soon as the pages in view are done (`pagesInView` / `previewEarly`); the rest keeps coming below. A newer
  edit stops an unfinished layout (`stopLayout`). Scroll position is kept. Edits re-render after 250 ms, settings 150 ms.
  Measured: an edit shows in ~0.5 s (41-page booklet), ~1–2 s (135 pages); a full layout is ~35 ms a page.
- `preview.html` — the pages themselves (Paged.js). Inside the editor it takes the book from `window.parent.Editor`
  so unsaved edits show; opened on its own it reads the text itself (used by `tools/render-test.mjs`).
- `sw.js` + `manifest.webmanifest` — installable app. The service worker shows app files from its cache and
  refreshes them in the background, so after a deploy the first visit shows the previous version and the next
  one the new. It never caches the text (GitHub API) and isn't registered on localhost.
- Printing = printing the preview frame (Print button), so the printed pages are exactly the previewed pages.

## Formatting lives in CSS, not in the text
- `css/settings.css` — the list of knobs and their defaults: named variables with plain-English comments
  (margins, sizes, fonts, spacing). The Settings tab builds its controls from this file (group headers
  `/* ---- Name ---- */`, a trailing `/* hint */` per line), so add new knobs here, never hard-code.
- `settings.css` **in liturgy-text** — the editor's saved changes (only the values that differ), loaded after
  the app's defaults. Saving goes to the text repo so one key (Contents: read and write, that repo only) covers everything.
- `css/book.css` — layout rules that read those variables.
- `FORMAT.md` — the text-file format. `js/parse.js` must match it exactly; update both together.

## Why Paged.js, not Vivliostyle (compared Sep 2026, test booklet = 41 pages)
- Speed: Paged.js lays out the booklet in ~0.7 s after fonts load; Vivliostyle took ~5 s. Live preview in the editor needs speed.
- Keep-together: Paged.js keeps a `break-inside: avoid` block (the Rebirth Mantra) whole; Vivliostyle split it across two pages.
- Screen preview: Paged.js shows every page in a scrolling grid; Vivliostyle shows one page at a time, and
  showing them all means overriding its internal viewer CSS (its zoom trick fights a wrapping grid).
- License: Paged.js is MIT; Vivliostyle is AGPL-3.0.
- Downside: Paged.js releases are slow (0.4.3 is still the latest stable). If it stalls on something we need,
  Vivliostyle is the fallback — it read our `var()`s natively and paginated nearly the same.

## Known gotchas
- **Font vetting:** Fontsource's Tinos and Noto Serif TC draw ō ū ā with a *detached* macron.
  Pinyin uses Gentium Book Plus (SIL) — verified correct for all tone marks incl. ǖ ǘ ǚ ǜ.
  Any new pinyin/English font must pass the tone-mark render check before adoption.
- No manual page breaks: pages break by themselves. `[keep together]` spans are planned in `preview.html`
  (`planKeeps`: one page, shrunk if needed, else a spread; even page counts start on a left page via
  `break-before: left`, which makes Paged.js add a blank page). `editor.js improveLayout()` re-runs the layout
  hidden (≤4 passes) when a span took more pages than measured, or to move the blank page to the chapter end
  (setting `--blank-page: chapter-end`, done by starting that chapter on the other side).
- Paged.js quirks (handled in `preview.html`): its task queue waits a screen frame before each page (and stops in a
  background tab) — `chunker.q.tick` is replaced with a MessageChannel; it drops `@media screen` rules from the sheets it paginates
  (screen-only looks go in preview.html's own `<style>`), it paginates the whole page if given no content,
  and it can leave an invisible copy of a moved block in a page's overflow (`removeOverflow()`).
- **Missing glyphs:** every font list in `book.css` ends with **"Liturgy Extra"** (`fonts/extra/`,
  built by `tools/build_extra_font.py`, licence in `fonts/extra/LICENSE.txt`): ~17,000 rare Chinese
  characters from the full Noto Serif CJK TC (Fontsource's Noto Serif TC omits e.g. 嚩 跢 鋄 㝹) in
  lazy-loaded chunks, all of CJK Ext-B (e.g. 𤙖) from Jigmo2 (CC0), plus ornaments (☸ ✦ ❁ ༺ ⊹ 𓆝 ˖ …). So font settings are bare names (`"Lora"`, no
  generic `serif` — that would win before the fallback). Run `python3 tools/check_glyphs.py ../liturgy-text/text`
  after any text or font change — it must report 0. Renders in a dev
  container can hide gaps if it has system CJK fonts; trust `check_glyphs.py`, not the render.
- Page 1 is a right-hand page: binding margin on the left for odd pages, right for even.

## Dev loop
```
npm install                                  # playwright, esbuild, CodeMirror sources (dev only)
npm run vendor                               # rebuild vendor/codemirror.min.js
python3 -m http.server -d ..                 # then open /liturgy/index.html?book=test  (preview only: preview.html)
                                             # (no ../liturgy-text folder, e.g. on github.io → asks for a GitHub key
                                             #  and reads the private repo; ?repo=owner/name to point elsewhere)
node tools/render-test.mjs native out        # PDF via Chrome print (CHROMIUM=<path> to use another Chromium)
node tools/render-test.mjs paged out         # PDF via Paged.js preview
node tools/editor-test.mjs                   # end-to-end editor checks against a fake GitHub (temp copy of ../liturgy-text)
python3 tools/check_glyphs.py ../liturgy-text/text   # must report 0
```
Booklets: `books/test.txt` (2 sections), `books/full.txt` (all 15 sections).
Run `tools/editor-test.mjs` before pushing editor changes.
Always look at rendered pages (PDF → PNG) before claiming a layout change works.

## Working style
One item at a time, one commit per item. Brief, plain-language summaries.

## Roadmap
1. ✅ Text format + converter — whole workbook converted and verified; one file per liturgical section (15), not per Excel tab
2. ✅ Renderer: pick engine ✅ (Paged.js); outside page numbers ✅, binding margin ✅, Chinese-closer-to-pinyin knob ✅; "keep together" ✅ (`[keep together]`…, one page or facing pages, blank pages placed by setting); TOC with automatic page numbers ✅ (`[contents]`, `[toc: …]`); automatic cross-references ✅ (`[page of <section>]`)
3. Editor ✅: CodeMirror text tab + pinyin checks, settings tab, live preview, click-to-edit, save to the private repo via GitHub key; "use a folder on this computer" ✅ (File System Access API, Chrome/Edge);
4. Booklets: `books/*.txt` lists → separate booklets with their own page numbers (picker ✅, Booklet tab: add existing chapters / reorder / remove ✅, new booklet / new chapter ✅)
5. Print: letter sheets, 4-up, duplex ✅ (Print… prints them directly; per-sheet order 2 3 / 6 7 — 4 1 / 8 5); PWA shell ✅
6. ✅ Convert the remaining sheets (done with the converter in liturgy-text/tools)
7. ✅ Bundle an Ext-B font for 𤙖 (Jigmo2)
