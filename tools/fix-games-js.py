#!/usr/bin/env python3
"""Fix src/games.js after the ugs merge:
1. Reverse remaining thumb:"data:image/jpeg;base64,..." URIs back to
   /assets/games/<file> paths by matching decoded bytes against
   _smallthumbs/assets/games/ (the build inlines those as data URIs).
2. Fix the broken array seam: the merge appended new entries after the last
   original entry (no trailing comma), which broke JS syntax.
"""
import base64
import hashlib
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAMES_JS = os.path.join(ROOT, "src", "games.js")
SMALL = os.path.join(ROOT, "_smallthumbs", "assets", "games")

# 1. index _smallthumbs/assets/games by md5 of file bytes
by_md5 = {}
if os.path.isdir(SMALL):
    for fn in os.listdir(SMALL):
        p = os.path.join(SMALL, fn)
        if not os.path.isfile(p):
            continue
        try:
            by_md5[hashlib.md5(open(p, "rb").read()).hexdigest()] = fn
        except Exception:
            pass
print("indexed smallthumbs files:", len(by_md5))

src = open(GAMES_JS, encoding="utf-8").read()
lines = src.split("\n")

fixed_thumb = 0
fixed_seam = 0
out = []
prev = None
for i, ln in enumerate(lines):
    new_ln = ln
    # reverse data-URI jpeg thumbs (no-space thumb:" form)
    m = re.search(r'(thumb:")(data:image/jpeg;base64,[A-Za-z0-9+/=]+)(")', ln)
    if m:
        try:
            raw = base64.b64decode(m.group(2).split(",", 1)[1])
            h = hashlib.md5(raw).hexdigest()
            if h in by_md5:
                new_ln = ln[: m.start(1)] + 'thumb: "/assets/games/%s"' % by_md5[h] + ln[m.end(3):]
                fixed_thumb += 1
        except Exception:
            pass
    out.append(new_ln)
    prev = new_ln

# 2. fix the seam: find the line that ends with ` }` (no comma) immediately
#    followed by a blank line and then `{ title:` — the last pre-merge entry.
fixed_lines = out
for i in range(len(fixed_lines) - 2):
    a = fixed_lines[i].rstrip()
    b = fixed_lines[i + 1].strip()
    c = fixed_lines[i + 2].strip()
    if a.endswith(" }") and b == "" and c.startswith('{ title: "'):
        # the merge's added entries always have category + data-uri svg thumbs;
        # the pre-merge last entry is Froggie's Arcade
        if "Froggie" in a:
            fixed_lines[i] = a + ","
            fixed_seam += 1
            print("seam fixed at line", i + 1)

open(GAMES_JS, "w", encoding="utf-8", newline="").write("\n".join(fixed_lines))
print("reversed thumbs:", fixed_thumb)
print("seam fixes:", fixed_seam)