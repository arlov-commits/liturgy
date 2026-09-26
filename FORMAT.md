# Liturgy text format — v0.3 (draft)

Pages break by themselves, and where you ask for it: `[new page]`, and a `#` title further down a chapter (a setting).
An old `---` line is ignored and flagged.

Each section of the liturgy is one plain-text file (UTF-8), e.g. `text/03-amitabha-sutra.txt`.
The files hold **words only**. Fonts, sizes, spacing, margins and page numbers live in the
stylesheet, never in these files.

## Booklets

A booklet is a list in `books/<name>.txt`: the chapter file names, in order, one per line
(`//` lines are comments; `name.txt = Some name` gives the chapter another name in this booklet's contents list — the ✎ in the editor's contents list does that). In the editor it's the Chapters tab (add, reorder, remove chapters). A chapter
(one `text/*.txt` file) can be in several booklets; its name in lists is its `[toc: …]` or first title.

## Blocks

A `#` title further down a chapter starts a new page (Settings → Page layout → “Title start”; not one right
under another title block). A `#` title line right under other lines (no blank line between) starts a new block there: the lines above keep
their own style and the title follows with no space above it. The editor marks it, in case a blank line was meant.

A **blank line** separates blocks; each further blank line in a row adds one line of empty space on the page
(two blank lines = a block break plus one empty line, and so on). A normal block is:

```
THE MORNING BELL RINGS
OVER THE QUIET HALL.
晨鐘響徹靜堂。
chén zhōng xiǎng chè jìng táng
```
(a made-up example: the liturgy text itself stays in the private text repository)

- **English**: any lines with no Chinese in them. Line breaks are kept exactly as typed.
- **Chinese line**: the characters as printed, including punctuation ( , 。 『 』 › ).
- (How a verse is *printed* — English first or last, pinyin under or over the characters — is the “verse order”
  setting, not the text: the text is always written English, Chinese, pinyin.)
- **Pinyin line**: directly under the Chinese line — one syllable per character, separated by
  spaces (a `//` comment or a `[…]` marker line there is not a pinyin line). Punctuation gets no syllable. A quote mark may be stuck to a syllable (`«rǔ`, `jīng»`).
  The app lines each syllable up under its character automatically.
- A block may contain several Chinese + pinyin pairs (a long sentence wrapped onto two lines).
- **`x3`** alone on a line = repeat mark (recite three times).

## Markers at the start of a line

| Marker | Meaning |
|---|---|
| `# ` | title line (centered, larger) — `#` then a space (`###` or `#word` is plain text) |
| `## ` | small heading (centered, smaller Chinese) |
| `> ` | small note line, centred — leader instructions ("The Leader says:"), Sanskrit equivalents, "Proceed to…" |
| `>> ` | the same small note line, on the right (e.g. a source or attribution under a verse) |
| `[keep together]` … `[/keep together]` | keep the lines between on one page (each marker on its own line; the editor's **Keep together** button adds them). If they don't fit a page even shrunk (not below the “fit smallest” setting), they run over pages: an even number of pages starts on a left-hand page so the pages face each other; an odd number may start on either side. A blank page is added where needed — just before, or at the end of the chapter before (setting “blank page”). |
| `[border]` … `[/border]` | a box around the lines between (the editor's **Border** button adds the markers). Line thickness, style, colour, padding, rounded corners and spacing are in Settings → Borders. Kept on one page unless taller than a page. Spans may be put inside one another — a border inside a keep together, or a keep together inside a longer keep together (the inner group stays on one page, or on facing pages if too long, within the longer span) — but must be closed in reverse order. |
| `[new page]` | start a new page here (the editor's **New page** button adds it) |
| `[blank page]` | a page left empty on purpose (e.g. at the start of the book) |
| `//` | comment — never printed |

## Page references

`[page of <section>]` anywhere in an English or title line prints the page that section starts on (the editor shows it
as one chip, `<section> · p. 9`; click it to type a number by hand); `[page of <section> / <part>]` the page of a `[toc: <part>]` in that
section; `[page 12 of <section>]` prints 12, a number typed by hand — the editor warns that it won't follow changes and
offers the automatic one back. For example:
`~~~ Proceed to Meng Shan Offering (Page [page of 06-meng-shan]) ~~~`. The section is named by its
file name without `.txt` (as under each chapter's title bar in the editor) and must be in the same booklet — otherwise it
prints `?` and is flagged.

## Table of contents

- In the editor, **Add table of contents** (Chapters tab) inserts a contents page (the line `[contents]` in the
  booklet list; its heading is the “contents title” setting). It shows in the text like a chapter, with its entries
  written out between `[contents]` and `[/contents]`, one line each:
  ```
  [contents]
  Amitabha Sutra [page of 03-amitabha-sutra]
    Incense Praise [page of 10-meal-offering / Incense Praise]
  [/contents]
  ```
  The text before the reference is what's printed — change it freely (e.g. a shorter name). Every chapter of the
  booklet gets a line (its `[toc: …]` name, else its first title), and each of its other `#` titles an indented line
  under it (`[page of <section> / <TITLE>]`, pointing at that title); to leave one out of this booklet's contents, put
  `//` in front of its line (it stays out). The editor keeps the lines in step with the booklet: a chapter added gets
  a line, a chapter taken out loses it, and a line whose text is still the chapter's own title follows it when the
  title changes. A line without a page reference prints as a small
  heading. The edited text is kept for that booklet in `books/contents/<booklet>.txt`; **Original** (Chapters tab)
  puts back the automatic one.
- `[contents]` alone (no `[/contents]`) prints the list made automatically.
- `[contents]` on its own line in a chapter prints a table of contents there: one line per section of the booklet
  (except the section it's in), with the page each starts on — filled in automatically.
- A chapter is listed under its first `#` title. To list it under another name, put `[toc: Name]` on a line
  of its own at the top of the chapter (before its first block); `[toc: -]` leaves the chapter out of the list made
  automatically (in a written-out table of contents, `//` in front of its line does that).
- `[toc: Name]` further down a chapter adds an extra entry for the block that follows it (e.g. the parts of the
  Meal Offering).

## Mantra lines (romanization beside the Chinese)

```
Na Mo A Mi Duo Po Ye | 南無阿彌多婆夜
Suo Po He | 娑婆訶 | x3
```

## Checks the app will make

- Number of pinyin syllables ≠ number of Chinese characters → the line is flagged, not printed misaligned.
- `_` in a pinyin line = syllable missing (the converter uses it when the workbook had a gap).

## Open points (to settle while building the renderer)

- Hard-coded page references such as "(Page 91)" should be replaced with `[page of …]` (by hand, once the
  referenced section is converted).
- ASCII punctuation inside a Chinese line (`,` `.` `!` `?` `:` `;`, as the workbook has it) is printed full-width (`，` `。` …).
