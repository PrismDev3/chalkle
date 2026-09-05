#!/usr/bin/env python3
"""Second-pass swaps for ugs matches the survey missed (e.g. FNAF 1-4)."""
import re

src = open("src/games.js", encoding="utf-8").read()

SWAPS = [
    ("FNAF 1", "clFNAF.html"),
    ("FNAF 2", "clFNAF2.html"),
    ("FNAF 3", "clFNAF3.html"),
    ("FNAF 4", "clFNAF4.html"),
    ("FNAF World", "clfnafworld.html"),
    ("FNAF: Pizza Simulator", "clfnafps.html"),
    ("FNAF: Sister Location", "clfnafsl.html"),
    ("Friday Night Funkin", "clfridaynightfunkin.html"),
    ("Gun Mayhem", "clgunmayhem.html"),
    ("Moto X3M Spooky", "clmotox3mspookyland.html"),
    ("Burrito Bison: Launcha Libre", "clburritobisonlaunchalibre.html"),
    ("Pac-Man Superfast", "clpacmansuperfast.html"),
    ("Madalin Stunt Cars Multiplayer", "clmadalinstuntcarsmultiplayerfixed.html"),
]

changed = 0
for title, ugs_file in SWAPS:
    # match the whole entry line for this title
    pat = re.compile(
        r'(\{ title: "%s"[^}]*?url:\s*")[^"]*(")' % re.escape(title.replace('"', '\\"'))
    )
    m = pat.search(src)
    if not m:
        print("NOT FOUND:", title)
        continue
    # skip if already swapped or game-builds
    if '/ugs/%s' % ugs_file in m.group(0) or '/game-builds/' in m.group(0):
        print("SKIP (already local):", title)
        continue
    src = pat.sub(lambda mm: mm.group(1) + "/ugs/%s" % ugs_file + mm.group(2), src, count=1)
    changed += 1
    print("SWAPPED:", title, "->", ugs_file)

open("src/games.js", "w", encoding="utf-8", newline="").write(src)
print("total swapped:", changed)