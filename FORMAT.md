# Liturgy text format — v0.3 (draft)

Pages break by themselves: there are no manual page breaks (an old `---` line is ignored and flagged).

Each section of the liturgy is one plain-text file (UTF-8), e.g. `text/03-amitabha-sutra.txt`.
The files hold **words only**. Fonts, sizes, spacing, margins and page numbers live in the
stylesheet, never in these files.

## Booklets

A booklet is a list in `books/<name>.txt`: the chapter file names, in order, one per line
(`//` lines are comments). In the editor it's the Booklet tab (add, reorder, remove chapters). A chapter
(one `text/*.txt` file) can be in several booklets; its name in lists is its `[toc: …]` or first title.

## Blocks

A **blank line** separates blocks. A normal block is:

```
IN THE JETA GROVE, IN THE GARDEN OF THE
BENEFACTOR OF ORPHANS AND THE SOLITARY,
祇樹給孤獨園。
qí shù jǐ gū dú yuán
```

- **English**: any lines with no Chinese in them. Line breaks are kept exactly as typed.
- **Chinese line**: the characters as printed, including punctuation ( , 。 『 』 › ).
- **Pinyin line**: directly under the Chinese line — one syllable per character, separated by
  spaces. Punctuation gets no syllable. A quote mark may be stuck to a syllable (`«rǔ`, `jīng»`).
  The app lines each syllable up under its character automatically.
- A block may contain several Chinese + pinyin pairs (a long sentence wrapped onto two lines).
- **`x3`** alone on a line = repeat mark (recite three times).

## Markers at the start of a line

| Marker | Meaning |
|---|---|
| `# ` | title line (centered, larger) |
| `## ` | small heading (centered, smaller Chinese) |
| `> ` | small note line — leader instructions ("The Leader says:"), Sanskrit equivalents, "Proceed to…" |
| `[keep together]` … `[/keep together]` | keep the lines between on one page (each marker on its own line; the editor's **Keep together** button adds them). If they don't fit a page even shrunk (not below the “fit smallest” setting), they run over pages: an even number of pages starts on a left-hand page so the pages face each other; an odd number may start on either side. A blank page is added where needed — just before, or at the end of the chapter before (setting “blank page”). |
| `[border]` … `[/border]` | a box around the lines between (the editor's **Border** button adds the markers). Line thickness, style, colour, padding, rounded corners and spacing are in Settings → Borders. Kept on one page unless taller than a page. Spans may be put inside one another (e.g. a border inside a keep together) but must be closed in reverse order. |
| `[blank page]` | a page left empty on purpose (e.g. at the start of the book) |
| `//` | comment — never printed |

## Page references

`[page of <section>]` anywhere in an English or title line prints the page that section starts on, e.g.
`~~~ Proceed to Meng Shan Offering (Page [page of 05-meng-shan-offering]) ~~~`. The section is named by its
file name without `.txt` (as in the editor's Section list) and must be in the same booklet — otherwise it
prints `?` and is flagged.

## Table of contents

- `[contents]` on its own line prints a table of contents there: one line per section of the booklet
  (except the section it's in), with the page each starts on — filled in automatically.
- A section is listed under its first `#` title. To list it under another name, put `[toc: Name]` on a line
  of its own anywhere in the section; `[toc: -]` leaves the section out.

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
- The workbook uses the ASCII comma `,` inside Chinese lines; the renderer could show it as `，`.
