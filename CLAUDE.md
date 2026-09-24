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
| Pagination / on-screen page preview | **Vivliostyle** (`@vivliostyle/core`) or **Paged.js** (vendored, `vendor/paged.min.js`) | Both tested — identical output. Vivliostyle reads `var()` inside `@page` natively and is actively maintained; Paged.js needs the var-filling shim in `index.html`. Pick one in Phase 2 and delete the other. |
| Pinyin under characters | native `<ruby>` + `ruby-position: under` | never position pinyin manually |
| Final print | Chrome's own print (Chrome 131+ supports `@page :left/:right` margin boxes and `var()`) | |
| Text editing | **CodeMirror 6** | never `contenteditable` |
| Pinyin checking (later) | **pinyin-pro** | suggestions only — liturgical readings (nā mó, 土 dù, 般若 bō rě) are deliberate |
| Letter-sheet imposition (later) | try **Bookbinder JS** "Perfectbound" first; else **pdf-lib** | |
| Fonts | **Fontsource** packages, self-hosted in `fonts/` | |

Our own code should stay small glue: `js/parse.js` (text → HTML) and wiring.

## Formatting lives in CSS, not in the text
- `css/settings.css` — the only file the editor should need for looks: named variables with
  plain-English comments (margins, sizes, fonts, spacing). Add new knobs here, never hard-code.
- `css/book.css` — layout rules that read those variables.
- `FORMAT.md` — the text-file format. `js/parse.js` must match it exactly; update both together.

## Known gotchas
- **Font vetting:** Fontsource's Tinos and Noto Serif TC draw ō ū ā with a *detached* macron.
  Pinyin uses Gentium Book Plus (SIL) — verified correct for all tone marks incl. ǖ ǘ ǚ ǜ.
  Any new pinyin/English font must pass the tone-mark render check before adoption.
- Excel page breaks are kept in the text only as `// ---` comments — the new page size flows
  differently. Real breaks are `---`.
- Page 1 is a right-hand page: binding margin on the left for odd pages, right for even.

## Dev loop
```
npm install                                  # playwright + vivliostyle cli (dev only)
python3 -m http.server -d ..                 # then open /liturgy/index.html?book=test
node tools/render-test.mjs native out        # PDF via Chrome print
node tools/render-test.mjs paged out         # PDF via Paged.js preview
node tools/build-static.mjs ../liturgy-text test _book.html && npx vivliostyle build _book.html -o out/viv.pdf
```
Always look at rendered pages (PDF → PNG) before claiming a layout change works.

## Working style
One item at a time, one commit per item. Brief, plain-language summaries.

## Roadmap
1. ✅ Text format + converter (2 sections: Amitabha Sutra, Rebirth Mantra)
2. ⏳ Renderer: pick engine; outside page numbers ✅, binding margin ✅, Chinese-closer-to-pinyin knob ✅; "fit this block on one page" marker; TOC with automatic page numbers; automatic cross-references (replace "(Page 91)")
3. Editor: CodeMirror (text) + settings tab + live preview; save to private repo via GitHub token (entered once); "open local folder" (File System Access API) as backup
4. Booklets: `books/*.txt` lists → separate booklets with their own page numbers
5. Print: letter sheets, 4-up, duplex, cut-and-stack order; PWA shell
6. Convert the remaining 33 sheets
