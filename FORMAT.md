# Liturgy text format — v0.1 (draft)

Each section of the liturgy is one plain-text file (UTF-8), e.g. `text/03-amitabha-sutra.txt`.
The files hold **words only**. Fonts, sizes, spacing, margins and page numbers live in the
stylesheet, never in these files.

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
| `---` | page break |
| `//` | comment — never printed |

## Mantra lines (romanization beside the Chinese)

```
Na Mo A Mi Duo Po Ye | 南無阿彌多婆夜
Suo Po He | 娑婆訶 | x3
```

## Checks the app will make

- Number of pinyin syllables ≠ number of Chinese characters → the line is flagged, not printed misaligned.
- `_` in a pinyin line = syllable missing (the converter uses it when the workbook had a gap).

## Open points (to settle while building the renderer)

- A "fit" marker to shrink a block so it stays on one page.
- Hard-coded page references such as "(Page 91)" should become automatic.
- The workbook uses the ASCII comma `,` inside Chinese lines; the renderer could show it as `，`.
