# check_glyphs.py
# Lists every character in the liturgy text files that none of the bundled fonts
# (fonts/files + fonts/extra) can draw. Run after editing text or changing fonts.
# Version 0.1
#
# Usage: python tools/check_glyphs.py ../liturgy-text/text
# Needs: pip install fonttools brotli

import glob
import os
import sys
import unicodedata

from fontTools.ttLib import TTFont

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    text_dir = sys.argv[1]
    have = set()
    for f in glob.glob(os.path.join(APP, "fonts", "**", "*.woff2"), recursive=True):
        have |= set(TTFont(f).getBestCmap())
    print(f"[..] bundled fonts cover {len(have)} characters")
    where = {}
    for path in sorted(glob.glob(os.path.join(text_dir, "*.txt"))):
        for n, line in enumerate(open(path, encoding="utf-8"), 1):
            if line.startswith("//"):
                continue
            for ch in line.rstrip("\n"):
                cp = ord(ch)
                if cp > 0x20 and cp not in have and not unicodedata.category(ch).startswith("Z"):
                    where.setdefault(ch, f"{os.path.basename(path)}:{n}")
    for ch, loc in sorted(where.items()):
        print(f"[!!] {ch}  U+{ord(ch):04X}  {unicodedata.name(ch, '?')}  first seen {loc}")
    print(f"[done] {len(where)} character(s) with no bundled font")


if __name__ == "__main__":
    main()
