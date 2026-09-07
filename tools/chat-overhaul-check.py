"""Post-overhaul checks: script syntax, no leftover corruption."""
import io
import re
import subprocess
import sys
import tempfile
import os

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
s = io.open("chat.html", encoding="utf-8").read()

# 1. every inline <script> block must parse
blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", s, re.S)
print("inline script blocks:", len(blocks))
fails = 0
for i, b in enumerate(blocks):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
        f.write(b)
        path = f.name
    r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    if r.returncode != 0:
        fails += 1
        print(f"BLOCK {i} SYNTAX FAIL:\n{r.stderr[:500]}")
    os.unlink(path)
print("syntax:", "OK" if fails == 0 else f"{fails} FAIL")

# 2. no leftover corruption
bad = []
if re.search(r"\\u00b7", s):
    bad.append("literal backslash-u00b7 remains")
if re.search(r"\.textContent\s*=[^;]*?<img", s):
    bad.append("textContent still contains <img>")
if re.search(r'placeholder="<img', s):
    bad.append("placeholder still corrupted")
print("corruption:", "; ".join(bad) if bad else "clean")

# 3. dock pieces present
for tok in ("id=\"phone-dock\"", "function phoneDockGo", "function phoneDockSync", "body.dock-on #phone-dock", 'data-dock="rooms"'):
    print(("present: " if tok in s else "MISSING: ") + tok)
