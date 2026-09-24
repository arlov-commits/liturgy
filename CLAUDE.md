# CLAUDE.md — liturgy booklet app

## What this is
A browser app that turns plain-text liturgy files (English / Chinese / pinyin) into printable
quarter-letter booklet pages (4.25 × 5.5 in), bound by a glue (perfect-bind) machine.
It will be used by a **non-technical editor**. Every feature must be usable without knowing code.

## Two repos
- **`liturgy` (this repo, public):** app code only.
- **`liturgy-text` (private):** the actual liturgy text (BTTS translation — never copy it into
  this public repo, not even as test fixtures). For development, clone it next to this repo:
  `../liturgy-text/`. Layout there: `text/*.txt` (one file per section), `books/*.txt`
  (a booklet = a list of section files in order), `tools/` (the Excel converter).

## Non-negotiable rule: use existing libraries, don't hand-roll
The owner was burned by a hand-built editor (bold toggling nested `<b><b>` instead of unbolding).
Before writing any non-trivial feature, look for a maintained open-source library and use it.
Current choices:

| Job | Use | Notes |
|---|---|---|
| Pagination / on-screen page preview | **Paged.js** (vendored, `vendor/paged.min.js`) | Chosen over Vivliostyle in Phase 2 (see below). Needs the small var-filling shim in `index.html` because it can't read `var()` inside `@page`. |
| Pinyin under characters | native `<ruby>` + `ruby-position: under` | never position pinyin manually |
| Final print | Chrome's own print (Chrome 131+ supports `@page :left/:right` margin boxes and `var()`) | |
| Text editing | **CodeMirror 6** (vendored, `vendor/codemirror.min.js`) | never `contenteditable`. Bundle built from `tools/vendor/codemirror.mjs` by `npm run vendor` — add any new CodeMirror import there. |
| Pinyin checking (later) | **pinyin-pro** | suggestions only — liturgical readings (nā mó, 土 dù, 般若 bō rě) are deliberate |
| Letter-sheet imposition (later) | try **Bookbinder JS** "Perfectbound" first; else **pdf-lib** | |
| Fonts | **Fontsource** packages, self-hosted in `fonts/` | |

Our own code should stay small glue: `js/parse.js` (text → HTML), `js/source.js` (where the text is read from),
`js/editor.js` (the editor page), `js/texttab.js` / `js/settings.js` (its two tabs) and wiring.
The Text tab's colouring repeats `parse.js`'s line rules — keep them in step with FORMAT.md.

## Pages
- `index.html` — the editor: top bar, panels, and the pages in a frame. The frame re-renders hidden and swaps in
  when ready (no blank flash); scroll position is kept.
- `preview.html` — the pages themselves (Paged.js). Inside the editor it takes the book from `window.parent.Editor`
  so unsaved edits show; opened on its own it reads the text itself (used by `tools/render-test.mjs`).
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
- Excel page breaks are kept in the text only as `// ---` comments — the new page size flows
  differently. Real breaks are `---`.
- Paged.js quirks (handled in `preview.html`): it drops `@media screen` rules from the sheets it paginates
  (screen-only looks go in preview.html's own `<style>`), it paginates the whole page if given no content,
  and it can leave an invisible copy of a moved block in a page's overflow (`removeOverflow()`).
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
```
Always look at rendered pages (PDF → PNG) before claiming a layout change works.

## Working style
One item at a time, one commit per item. Brief, plain-language summaries.

## Roadmap
1. ✅ Text format + converter (2 sections: Amitabha Sutra, Rebirth Mantra)
2. ⏳ Renderer: pick engine ✅ (Paged.js); outside page numbers ✅, binding margin ✅, Chinese-closer-to-pinyin knob ✅; "fit on one page" marker ✅ (`[one page]`…`[/one page]`); TOC with automatic page numbers; automatic cross-references ✅ (`[page of <section>]`)
3. Editor ✅: CodeMirror text tab + pinyin checks, settings tab, live preview, click-to-edit, save to the private repo via GitHub key; "open local folder" (File System Access API) as backup
4. Booklets: `books/*.txt` lists → separate booklets with their own page numbers (picker ✅, edit the list ✅, new booklet / new section ✅)
5. Print: letter sheets, 4-up, duplex, cut-and-stack order; PWA shell
6. Convert the remaining 33 sheets
