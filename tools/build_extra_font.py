# build_extra_font.py
# Builds the "Liturgy Extra" fallback font family in fonts/extra/:
#   1. rare Chinese characters (from the full Noto Serif CJK TC) that the Fontsource
#      Noto Serif TC web font leaves out, split into ~1000-character chunks so a browser
#      only downloads the chunks a page actually uses;
#   2. ornament/symbol blocks (☸ ✦ ❁ ༺ ⊹ 𓆝 …) from free Noto symbol fonts;
#   3. CJK Extension B (U+20000–2A6DF, e.g. 𤙖) from Jigmo2 (CC0, https://kamichikoichi.github.io/jigmo/),
#      also in ~1000-character chunks.
# Writes fonts/extra/extra.css with one @font-face per file (unicode-range = exact coverage).
# Version 0.3  (Ext-B from Jigmo2)
#
# Usage: python tools/build_extra_font.py <noto-serif-cjk-regular.ttc> <fontsource node_modules/@fontsource dir> [Jigmo2.ttf]
#        python tools/build_extra_font.py --extb-only <Jigmo2.ttf>    (redo just the Ext-B part)
# Needs: pip install fonttools brotli

import glob
import os
import subprocess
import sys

from fontTools.ttLib import TTFont

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(APP, "fonts", "extra")
FAMILY = "Liturgy Extra"
CHUNK = 1000

# (fontsource package, unicode blocks to take from it)
SYMBOL_SOURCES = [
    ("noto-sans-symbols-2", [(0x2190, 0x21FF), (0x2200, 0x22FF), (0x25A0, 0x25FF), (0x2600, 0x26FF), (0x2700, 0x27BF), (0x2B00, 0x2BFF)]),
    ("noto-sans-symbols", [(0x2600, 0x26FF), (0x2700, 0x27BF)]),
    ("noto-sans-math", [(0x2200, 0x22FF), (0x2A00, 0x2AFF)]),
    ("noto-serif-tibetan", [(0x0F00, 0x0F3F)]),
    ("noto-sans-egyptian-hieroglyphs", [(0x13000, 0x1342F)]),
    ("noto-serif", [(0x02B0, 0x02FF), (0x2070, 0x209F)]),      # modifier letters, super/subscripts (˖ ˳ ₊)
    ("lxgw-wenkai-tc", [(0x02B0, 0x02FF), (0x2070, 0x209F)]),  # modifier letters, super/subscripts (˳ ₊)
]


def ranges(cps):
    cps = sorted(cps)
    out, start, prev = [], cps[0], cps[0]
    for c in cps[1:]:
        if c != prev + 1:
            out.append((start, prev))
            start = c
        prev = c
    out.append((start, prev))
    return ",".join(f"U+{a:X}" if a == b else f"U+{a:X}-{b:X}" for a, b in out)


def subset(src, cps, dst, font_number=None):
    uni = os.path.join(OUT, "_unicodes.txt")
    with open(uni, "w") as f:
        f.write(",".join(f"U+{c:04X}" for c in sorted(cps)))
    cmd = ["pyftsubset", src, f"--unicodes-file={uni}", "--flavor=woff2", f"--output-file={dst}",
           "--layout-features=*", "--no-hinting", "--notdef-outline"]
    if font_number is not None:
        cmd.append(f"--font-number={font_number}")
    subprocess.run(cmd, check=True, capture_output=True)
    os.remove(uni)
    return set(TTFont(dst).getBestCmap()) & set(cps)


EXTB_START, EXTB_END = "/* Ext-B (Jigmo2) begin */", "/* Ext-B (Jigmo2) end */"


def build_extb(jigmo):
    """CJK Extension B from Jigmo2, in chunks. Returns [(file, codepoints, source)]."""
    for old in glob.glob(os.path.join(OUT, "extb-*.woff2")):
        os.remove(old)
    font = TTFont(jigmo)
    cps = sorted(c for c in font.getBestCmap() if 0x20000 <= c <= 0x2A6DF)
    print(f"[..] {len(cps)} Ext-B characters -> chunks of {CHUNK}")
    faces = []
    for i in range(0, len(cps), CHUNK):
        name = f"extb-{i // CHUNK:02d}.woff2"
        got = subset(jigmo, cps[i:i + CHUNK], os.path.join(OUT, name))
        faces.append((name, got, "Jigmo2 (CC0)"))
    print(f"[ok] {len(faces)} Ext-B files")
    return faces


def face_css(faces):
    return [f"/* {src} */\n@font-face {{\n  font-family: '{FAMILY}';\n  font-display: swap;\n"
            f"  src: url(./{name}) format('woff2');\n  unicode-range: {ranges(cps)};\n}}" for name, cps, src in faces]


def extb_only(jigmo):
    """Rebuild only the Ext-B chunks and their part of extra.css."""
    css_path = os.path.join(OUT, "extra.css")
    css = open(css_path, encoding="utf-8").read()
    if EXTB_START in css:
        css = css[:css.index(EXTB_START)] + css[css.index(EXTB_END) + len(EXTB_END):].lstrip("\n")
    block = "\n".join([EXTB_START, *face_css(build_extb(jigmo)), EXTB_END])
    with open(css_path, "w", encoding="utf-8") as f:
        f.write(css.rstrip("\n") + "\n" + block + "\n")


def main():
    if sys.argv[1] == "--extb-only":
        return extb_only(sys.argv[2])
    ttc, fontsource = sys.argv[1], sys.argv[2]
    jigmo = sys.argv[3] if len(sys.argv) > 3 else None
    os.makedirs(OUT, exist_ok=True)
    for old in glob.glob(os.path.join(OUT, "*.woff2")):
        os.remove(old)
    faces = []

    # 1. rare Chinese characters
    have = set()
    for f in glob.glob(os.path.join(APP, "fonts", "files", "noto-serif-tc-*.woff2")):
        have |= set(TTFont(f).getBestCmap())
    full = TTFont(ttc, fontNumber=3)  # face 3 = Noto Serif CJK TC
    assert "TC" in full["name"].getDebugName(1), "face 3 is not the TC face"
    rare = sorted(c for c in set(full.getBestCmap()) - have
                  if 0x3400 <= c <= 0x4DBF or 0x4E00 <= c <= 0x9FFF or 0xF900 <= c <= 0xFAFF)
    print(f"[..] {len(rare)} rare Chinese characters -> chunks of {CHUNK}")
    for i in range(0, len(rare), CHUNK):
        name = f"rare-cjk-{i // CHUNK:02d}.woff2"
        got = subset(ttc, rare[i:i + CHUNK], os.path.join(OUT, name), font_number=3)
        faces.append((name, got, "Noto Serif CJK TC (SIL OFL)"))
        print(f"[ok] {name}  {len(got)} chars")

    # 2. symbols and ornaments
    taken = set()
    for pkg, blocks in SYMBOL_SOURCES:
        want = {c for a, b in blocks for c in range(a, b + 1)} - taken
        for i, src in enumerate(sorted(glob.glob(os.path.join(fontsource, pkg, "files", "*-400-normal.woff2")))):
            cps = want & set(TTFont(src).getBestCmap())
            if not cps:
                continue
            name = f"sym-{pkg}-{i}.woff2"
            got = subset(src, cps, os.path.join(OUT, name))
            taken |= got
            want -= got
            faces.append((name, got, f"{pkg} (SIL OFL, via Fontsource)"))
            print(f"[ok] {name}  {len(got)} chars")

    css = [f"/* {FAMILY}: fallback glyphs the main fonts lack. Generated by tools/build_extra_font.py */", *face_css(faces)]
    if jigmo:
        extb = build_extb(jigmo)
        faces += extb
        css += [EXTB_START, *face_css(extb), EXTB_END]
    with open(os.path.join(OUT, "extra.css"), "w", encoding="utf-8") as f:
        f.write("\n".join(css) + "\n")
    total = sum(os.path.getsize(os.path.join(OUT, n)) for n, _, _ in faces)
    print(f"[done] {len(faces)} files, {total // 1024} KB -> fonts/extra/extra.css")


if __name__ == "__main__":
    main()
