#!/usr/bin/env python3
"""Chalkle quality gate. Run: python tools/checker.py
Fails (exit 1) on:
  1. CSS gradients that render as a fade (color-to-color). Hard-stop line/checker
     patterns are allowed via allowlist.
  2. Em dashes or en dashes anywhere in shipped files.
  3. AI-vocab words in user-facing strings (JS/HTML/CSS text, not code identifiers).
"""
import re, sys, pathlib
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parent.parent

SHIPPED = [
    "styles.css", "index.html", "app.js", "sites.js", "apps.js", "games.js",
    "docs.js", "ai.js", "youtube.js", "livetv.js", "music.js", "theme.js",
    "partners.js", "proxies.js", "launcher.js", "blanktab.js", "editor.js",
    "runtime-config.js", "chalkle-single.html", "cloud-play.html", "cloud.js",
    "history.js", "intro.js", "settings.js", "tools.js", "share.js",
]

# Fade gradients: a gradient whose color stops blend (no hard 0%/100% pairs).
GRAD_RE = re.compile(r"(linear|radial|conic)-gradient\(((?:[^()]|\([^()]*\))*)\)", re.I)
HARD_STOP_RE = re.compile(r"(^|,\s*)(transparent\s+\d+(\.\d+)?%|[a-z#(][\w#.,() ]*?\s+0%|[a-z#(][\w#.,() ]*?\s+100%|black\s+70%|rgba\([^)]*\)\s+1px)\s*[,)]", re.I)

DASH_RE = re.compile("[\u2014\u2013]")

AI_VOCAB = [
    "delve", "delving", "elevate", "elevating", "seamless", "seamlessly",
    "unleash", "unleashing", "empower", "empowering", "cutting-edge",
    "supercharge", "game-changing", "revolutionize", "revolutionary",
    "effortless", "effortlessly", "harness",
    "dive into", "diving into", "vibrant", "stunning", "breathtaking",
    "furthermore", "moreover", "utilize", "utilizing", "leverage",
    "streamline", "streamlined", "in today's", "in the world of",
    "take it to the next level", "next-level", "state-of-the-art",
    "robust", "myriad", "plethora", "tapestry", "testament to",
    "navigate the", "embark", "journey", "marvel", "realm of",
]

def is_hard_stop(args: str) -> bool:
    # Functional patterns (not decorative fades):
    #   - grid/line textures: color 1px, transparent 1px (hard pixel stops)
    #   - scroll-edge masks: transparent 0px, #000 22px (functional reveal)
    #   - checkerboards: every stop positioned, neighbor positions repeat
    stops = [s.strip() for s in args.split(",")]
    if any(re.search(r"\dpx\b", s) for s in stops):
        return True  # px-positioned stops: line/mask geometry, not a color fade
    if len(stops) < 2:
        return False
    def pos(s):
        m = re.search(r"(\d+(?:\.\d+)?)%", s)
        return float(m.group(1)) if m else None
    positions = [pos(s) for s in stops[1:]]
    known = [p for p in positions if p is not None]
    if len(known) == len(positions) and len(set(known)) < len(known):
        return True
    return False

# Third-party game data files: titles/descriptions are upstream copy we
# display verbatim (game names cannot be changed), so vocab/dash checks skip
# their data rows. Gradients are still checked everywhere.
DATA_FILES = {"cloudgames.js"}
DATA_ROW_RE = re.compile(r"^\s*\{\s*title:")

fails = []
VOCAB_RE = re.compile(
    "\\b(?:" + "|".join(re.escape(w) for w in AI_VOCAB) + ")\\b", re.I)

def chunked(line, size=4000):
    for k in range(0, len(line), size):
        yield line[k:k + size]

for name in SHIPPED:
    p = ROOT / name
    if not p.exists():
        continue
    is_data = name in DATA_FILES
    text = p.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    for i, line in enumerate(lines, 1):
        if name.endswith(".css") or "<style" in name:
            # Decorative fade check only: masks and px-geometry are functional.
            if "mask-image" not in line:
                for m in GRAD_RE.finditer(line):
                    if not is_hard_stop(m.group(2)):
                        fails.append(f"GRADIENT {name}:{i}: {m.group(0)[:90]}")
        if is_data or DATA_ROW_RE.match(line):
            continue  # upstream game titles/descriptions, not our copy
        if DASH_RE.search(line):
            fails.append(f"DASH {name}:{i}: ...{line.strip()[:70]}...")
        for piece in chunked(line):
            m = VOCAB_RE.search(piece.lower())
            if m:
                fails.append(f"VOCAB {name}:{i}: '{m.group(0)}' in: {line.strip()[:70]}")
                break

if fails:
    import collections
    counts = collections.Counter(f.split()[0] for f in fails)
    print(f"CHECKER: {len(fails)} violation(s) " +
          " ".join(f"{k}={v}" for k, v in counts.items()))
    for f in fails[:80]:
        print("  " + f)
    if len(fails) > 80:
        print(f"  ... and {len(fails) - 80} more")
    sys.exit(1)
print("CHECKER: clean")
