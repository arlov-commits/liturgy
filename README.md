# Liturgy booklet app

Turns plain-text liturgy files (English, Chinese, pinyin) into printable quarter-letter booklet
pages. The text itself lives in a separate private repository; this repo holds only the app.

- `FORMAT.md` — how the text files are written
- `css/settings.css` — every look-and-feel setting (margins, fonts, sizes, spacing)
- `index.html` — the editor (prototype). Online it asks once for a GitHub key that can read the private text repository.
- `preview.html` — just the pages

Status: prototype. See `CLAUDE.md` for the roadmap.

Fonts: Noto Serif TC, Lora, Gentium Book Plus — SIL Open Font License (see `fonts/`).
Paged.js — MIT (see `vendor/`).
