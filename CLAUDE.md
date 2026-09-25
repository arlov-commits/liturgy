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
- **The editor never writes `text/`** — that's the original (baseline). Edits are a parallel edition in
  `edits/<name>.txt` (only for chapters that differ; chapters made in the editor live only there). A chapter reads
  as its edition when there is one (`source.js loadChapter`); "Original" in the Chapters tab puts the original back,
  and saving then deletes the edition file. A booklet's table of contents (`[contents]` in its list) is edited in the
  text like a chapter and kept in `books/contents/<booklet>.txt` (none = the automatic default, `source.js loadContents`).
  Its entries are written out (`[contents]` … `[/contents]`, one `title [page of chapter]` line each — every chapter, even
  `[toc: -]` ones; `//` in front leaves one out and it stays out) and kept in step with
  the chapters by `editor.js updateContents` (quietly, not an Undo step); the editor shows each reference's page (from
  `preview.html pageMap`) and warns about `[page 12 of …]` numbers typed by hand (lint action back to automatic).

## Non-negotiable rule: use existing libraries, don't hand-roll
The owner was burned by a hand-built editor (bold toggling nested `<b><b>` instead of unbolding).
Before writing any non-trivial feature, look for a maintained open-source library and use it.
Current choices:

| Job | Use | Notes |
|---|---|---|
| Pagination / on-screen page preview | **Paged.js** (vendored, `vendor/paged.min.js`) | Chosen over Vivliostyle in Phase 2 (see below). Needs the small var-filling shim in `index.html` because it can't read `var()` inside `@page`. |
| Pinyin under characters | native `<ruby>` + `ruby-position: under` | never position pinyin manually |
| Final print | Chrome's print of the Paged.js preview: **Print…** = letter sheets, 4 pages a side (`preview.html printSheets`); the Print panel also has “just the pages” for checking | Printing the plain page without Paged.js paginates differently (39 vs 41 pages) — always print from the preview. |
| Text editing | **CodeMirror 6** (vendored, `vendor/codemirror.min.js`) | never `contenteditable`. Bundle built from `tools/vendor/codemirror.mjs` by `npm run vendor` — add any new CodeMirror import there. |
| Changed-line dots | **@codemirror/merge** `Chunk` (in the CodeMirror bundle) | `texttab.js diffField`: the editor text vs. the same chapters as originally (`loadDoc` builds both); click a dot → that line (or group of added/removed lines) back to the original, a hollow “ghost” dot redoes it. No dots in chapters made in the editor (`marked`). |
| Pinyin checking | **pinyin-pro** (vendored, loaded only when “Suggest pinyin readings” is ticked) | suggestions only (blue dotted, opt-in) — liturgical readings (nā mó, 土 dù, 般若 bō rě) are deliberate. `toneSandhi: false` so 一/不 aren't flagged. |
| Format and binding (Settings) | one nested choice (`settings.js formatControl`): `--format` letter (8.5 × 11, pages in order) / folio (letter folded in half, 5.5 × 8.5) / quarto (letter cut in quarters, 4.25 × 5.5); `--binding` perfect or signatures (quarto signatures: coming soon); `--signature-sheets` | `impose.js mode()` reads it (also the older single `--binding: in-order/signatures`), `plan()` gives pages printed, letter sheets and signatures (shown under the choice and in the Print panel; one signature → staple, several → sew and glue). Picking a format sets the page size. |
| Folded sheets (folio) | our own `impose.js signatures()`, following **bookbinder-js** (MPL-2.0; read, not copied) | letter sheets landscape, 2 pages a side, flip on short edge; perfect bound = signatures of one sheet; `signaturePlan`: at most 8 sheets (32 pages) per signature, split evenly (sizes differ by ≤ 1 sheet), blanks at the end; one signature > 32 pages is warned about. |
| Letter-sheet imposition | none needed: the Paged.js pages are copied into a 2 × 2 letter-sheet grid and printed with `@page { size: letter }` | Order in `js/impose.js`, per sheet of 8 pages: front 2 3 / 6 7, back 4 1 / 8 5 (duplex, flip on long edge); cut in four, stack in page order. Each copy gets `counter-reset: page n−1` so page numbers stay right. (Replaced the earlier save-PDF-then-upload step with pdf-lib.) |
| Fonts | **Fontsource** packages, self-hosted in `fonts/` | English choices (Settings): Lora, Gentium Book Plus, Crimson Pro, Alegreya, Libre Baskerville, Merriweather, Noto Serif, Source Serif 4, Noto Sans, Source Sans 3 — Latin + Latin Extended, 400/600 + italics. Rejected at the tone-mark check: EB Garamond (bold À), Spectral (ǖǘǚǜ), Cormorant Garamond (carons). |
| Remembering a picked folder | **idb-keyval** (vendored) | stores the folder handle in IndexedDB |
| Resizable panels | **Split.js** (vendored, `vendor/split.min.js`) | drag bars between contents list, panel and pages; sizes kept in localStorage; not on narrow screens |

Our own code should stay small glue: `js/parse.js` (text → HTML), `js/source.js` (where the text is read from),
`js/editor.js` (the editor page, incl. the Chapters tab), `js/texttab.js` / `js/settings.js` (Text tab, Settings drawer) and wiring.
In the UI a section file is a **chapter**; a booklet is built by adding existing chapters (shared between booklets) or new ones.
The Text tab's colouring repeats `parse.js`'s line rules — keep them in step with FORMAT.md.
The Text tab is **one editor holding the whole booklet**: each chapter follows a header line (`LiturgyText.SEP`
+ file name, drawn as a title bar that can't be edited — a transaction filter (`guard`) reshapes any edit that would touch
one, e.g. a paste over a selection across chapters or after Select All: the text goes where it starts, the header lines
stay; copy/paste filters drop header lines); after each edit the text is
split back into chapters by those lines (`editor.js mapDoc`), so every chapter still saves to its own file.
Lines the editor reports are global; `docMap` (`{name, head, first, last}`) maps them to a chapter's own lines.
Left of the panel, `#toc-nav` lists the chapters by file name; a click shows the chapter's first page at the top of
the pages (`preview.html showChapter`; not laid out yet → a spinner until it is) and puts the cursor there. The place
you're at (cursor, or the pages scrolled by hand — `preview.html` reports it via `Editor.previewScrolled`) is marked.
Pinyin is lined up under the characters in the editor by a display-only layer (`texttab.js alignDecos`: each
character and its syllable become inline-block columns of equal, canvas-measured width; spaces in the pinyin line
take no room; punctuation gets an empty column), so both lines wrap at the same places. The text keeps single
spaces. Visible lines only (~1 ms a keystroke). Off by default; switch: Settings → The text editor (per browser).
Page references (`[page of …]`) show as one chip (`texttab.js pageDecos`, an atomic replace widget: `name · p. N`), so a
name can't be mistyped; a click sets a number by hand. In a written-out contents, `refGuard` keeps them: deleting whole
entry lines puts `//` in front instead, deleting just a chip is refused (status says why). `syncContents` never drops a
line except one whose chapter was just taken out of the booklet, and changes only the lines that differ.
Span tags are pairs (`texttab.js pairGuard`): deleting into `[border]`/`[keep together]`/`[contents]` or its closing tag removes
both tags (one Undo step), typing beside a tag goes on its own line; the pair at the cursor is outlined (`tagPairs`).
`[keep together]` spans are shaded amber in the editor, `[border]` spans blue, their midpoint where both apply; darker per nesting level (`texttab.js groupDecos`, lines in view only).
Undo/Redo in the top bar use CodeMirror's history; `texttab.js track()` keeps a description of each step in step with
it (`undoDepth`/`redoDepth`) for the ▾ lists; programmatic edits pass a `label` annotation. Adding, removing or
moving chapters rebuilds the editor, which starts a fresh history.
Autosave (Save ▾, on by default, per browser): `save(true)` 4 s after the last change, only where the source can save;
a failed save pauses it until the next change.
Zoom (magnifier buttons over the pages, per browser): the preview iframes are scaled from outside (`transform` + size ÷ zoom), so
Paged.js always lays out at 100% and zoom can't change page breaks; `preview.html pageAtTop/showPage` keep the place.
The pages swap in early only once the new layout reaches the place the current pages are scrolled to (`previewEarly`).

## Pages
- `index.html` — the editor: top bar, panels, and the pages in a frame. **Two** preview frames take turns: the next
  version is laid out in the hidden one (`preview.html rerender()`, fonts stay loaded between layouts) and swapped
  in as soon as the pages in view are done (`pagesInView` / `previewEarly`); the rest keeps coming below. A newer
  edit stops an unfinished layout (`stopLayout`). Scroll position is kept. Edits re-render after 250 ms, settings 150 ms.
  Measured: an edit shows in ~0.5 s (41-page booklet), ~1–2 s (135 pages); a full layout is ~35 ms a page.
- `preview.html` — the pages themselves (Paged.js). Inside the editor it takes the book from `window.parent.Editor`
  so unsaved edits show; opened on its own it reads the text itself (used by `tools/render-test.mjs`).
- `sw.js` + `manifest.webmanifest` — installable app. The service worker takes app files from the network
  (`cache: "no-cache"`) and falls back to its cache only when offline. (It used to show the cache first and refresh in
  the background; with the browser's own 10-minute copies that could mix two versions after quick deploys, and the page
  stopped at "Loading…".) It never caches the text (GitHub API) and isn't registered on localhost. A startup error
  shows in the status line (inline script at the top of `index.html`).
- Printing = printing the preview frame (Print button), so the printed pages are exactly the previewed pages.

## Formatting lives in CSS, not in the text
- `css/settings.css` — the list of knobs and their defaults: named variables with plain-English comments
  (margins, sizes, fonts, spacing). The Settings drawer (top bar) builds its controls from this file (group headers
  `/* ---- Name ---- */`, a trailing `/* hint */` per line), so add new knobs here, never hard-code.
- `books/settings/<booklet>.css` **in liturgy-text** — each booklet's saved changes (only the values that differ), loaded
  after the app's defaults; a booklet without one starts from the shared `settings.css` there (`source.js loadSettings`).
  Settings → “Copy all settings from another booklet” replaces them (after a warning). Saving goes to the text repo so one key (Contents: read and write, that repo only) covers everything.
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
Booklets change as the editor uses the app (`../liturgy-text/books/`); `render-test.mjs` takes the booklet name as a third
argument. `editor-test.mjs` makes its own two-chapter `test` booklet (and drops saved settings/edits) in its temp copy.
Run `tools/editor-test.mjs` before pushing editor changes.
Always look at rendered pages (PDF → PNG) before claiming a layout change works.

## Working style
One item at a time, one commit per item. Brief, plain-language summaries.

## Roadmap
1. ✅ Text format + converter — whole workbook converted and verified; one file per liturgical section (15), not per Excel tab
2. ✅ Renderer: pick engine ✅ (Paged.js); outside page numbers ✅, binding margin ✅, Chinese-closer-to-pinyin knob ✅; "keep together" ✅ (`[keep together]`…, one page or facing pages, blank pages placed by setting); TOC with automatic page numbers ✅ (`[contents]`, `[toc: …]`); automatic cross-references ✅ (`[page of <section>]`)
3. Editor ✅: CodeMirror text tab + pinyin checks, settings tab, live preview, click-to-edit, save to the private repo via GitHub key; "use a folder on this computer" ✅ (File System Access API, Chrome/Edge);
4. Booklets: `books/*.txt` lists → separate booklets with their own page numbers (picker ✅, Chapters tab: add existing chapters / reorder / remove ✅, new booklet / new chapter ✅, Edit booklets…: rename / delete / order ✅ — order kept in `booklets.txt`)
5. Print: letter sheets, 4-up, duplex ✅ (Print… prints them directly; per-sheet order 2 3 / 6 7 — 4 1 / 8 5); PWA shell ✅
6. ✅ Convert the remaining sheets (done with the converter in liturgy-text/tools)
7. ✅ Bundle an Ext-B font for 𤙖 (Jigmo2)
