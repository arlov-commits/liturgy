# Liturgy booklet app

Turns plain-text liturgy files (English, Chinese, pinyin) into printable booklets on letter paper — full pages,
folio (folded) or quarto (cut in quarters), glued or in signatures. The text itself lives in a separate private
repository; this repo holds only the app.

- `FORMAT.md` — how the text files are written
- `css/settings.css` — every look-and-feel setting (page, margins, fonts, sizes, spacing, format and binding)
- `index.html` — the editor. Online it asks once for a GitHub key that can read and save the private text repository
  (or works from a folder on the computer, in Chrome/Edge).
- `preview.html` — just the pages
- `tools/editor-test.mjs` — end-to-end checks of the editor (see `CLAUDE.md`, “Dev loop”)

See `CLAUDE.md` for how it is built and the roadmap.

Fonts: Noto Serif TC, Lora, Gentium Book Plus and the other English fonts — SIL Open Font License (see `fonts/`);
the rare-character font “Liturgy Extra” — see `fonts/extra/LICENSE.txt`.
Paged.js — MIT; CodeMirror — MIT; Split.js — MIT; idb-keyval — Apache-2.0; pinyin-pro — MIT (see `vendor/`).
