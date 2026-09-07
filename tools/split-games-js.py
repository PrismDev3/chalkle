"""Split src/games.js under jsDelivr's 20MB per-file cap.

jsDelivr serves gh files up to 20MB; games.js grew to ~23MB (inline data-URI
thumbnails) and started returning 403 text/plain, which browsers block as a
MIME mismatch - killing the game library + icons on CDN mirrors.

Split: src/games.js keeps its helpers + the first half of the
window.ChalkGames array; src/games2.js pushes the second half onto the SAME
array via push.apply (identity + order preserved; app.js reads it after both
scripts load). Idempotent-ish: refuses to run twice on an already-split file.
"""
import io
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

P1 = "src/games.js"
P2 = "src/games2.js"
LIMIT = 11_500_000  # target max chunk bytes (headroom under the 20MB cap)

s = io.open(P1, encoding="utf-8", errors="surrogateescape").read()
if "window.ChalkGames.push.apply" in s:
    print("already split; nothing to do")
    sys.exit(0)

start = s.find("window.ChalkGames = [")
assert start != -1, "ChalkGames array start not found"
open_br = s.find("[", start)
# array runs to the last '];' in the file
close = s.rfind("];")
assert close > open_br, "ChalkGames array end not found"
body = s[open_br + 1 : close]

pre, post = s[: open_br + 1], s[close:]

# split at an entry boundary (each entry starts with a line beginning '{ title:')
bounds = [m.start() for m in re.finditer(r"(?m)^\s*\{", body)]
assert bounds, "no entries found"
half = len(body) // 2
split = min(bounds, key=lambda b: abs(b - half))
# also make sure part1 total stays under limit; walk earlier boundaries if not
while split > 0 and len(pre) + split > LIMIT:
    earlier = [b for b in bounds if b < split]
    if not earlier:
        break
    split = earlier[-1]

p1_new = pre + body[:split] + post
p2_new = (
    "/* ChalkGames part 2 - auto-split from src/games.js to stay under\n"
    "   jsDelivr's 20MB per-file limit (larger files 403 as text/plain and\n"
    "   browsers block them as a MIME mismatch, which kills the library and\n"
    "   thumbnails on CDN mirrors). push.apply keeps the SAME array object\n"
    "   and entry order; load after games.js, before app.js. */\n"
    "if (!window.ChalkGames) window.ChalkGames = [];\n"
    "window.ChalkGames.push.apply(window.ChalkGames, [" + body[split:] + "]);\n"
)

io.open(P1, "w", encoding="utf-8", errors="surrogateescape", newline="").write(p1_new)
io.open(P2, "w", encoding="utf-8", newline="").write(p2_new)
print(f"part1 {len(p1_new):,}B  part2 {len(p2_new):,}B  split at entry offset {split:,}/{len(body):,}")
