#!/usr/bin/env python3
"""GameMaker canvas fit gate. Run: python tools/canvas-fit-test.py

Undertale (and the other GameMaker HTML5 ports under game-builds/ and ugs/)
ship a fixed-size canvas - 640x480 - and an index.html whose only scaling
rule lives in a ":-webkit-full-screen" pseudo-class no engine accepts. The
canvas therefore stayed a postage stamp in the corner of the player no matter
how large the frame was. The player now fits that canvas itself.

This gate pins the two things the fix depends on:
  1. The shipped player (src/gameplayer.js) really does the fit, on frame
     load AND on frame resize, and only for GameMaker documents.
  2. It fits by sizing the canvas ELEMENT, never by letterboxing inside it
     (object-fit: contain) - the runner derives its mouse mapping from
     canvas.clientWidth / canvas.width, so a letterboxed element puts every
     click out of step with the picture.

Part 2 of the runner's own code is re-checked here (the scaleX/scaleY read)
so a future "simplification" to CSS object-fit fails loudly.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ((" :: " + detail) if detail and not ok else ""))
    if not ok:
        fails.append(name)


gp = (ROOT / "src" / "gameplayer.js").read_text(encoding="utf-8", errors="replace")

# ---------- 1. wiring: the fit runs with the other frame guards ----------
wiring = [
    ("fit runs on every frame load", "guardFrameFit();"),
    ("fit runs inside the frame's load handler",
     re.search(r"function onFrameLoad\(\)\s*\{[^}]*guardFrameFit\(\);", gp, re.S) is not None),
    ("a resize re-fits the canvas", 'w.addEventListener("resize", function () { fitFrameCanvas(); })'),
    ("the resize hook attaches once per frame", "w.__chalkleFitHooked"),
    ("late GameMaker_Init is covered by follow-up passes", "setTimeout(fitFrameCanvas, 400)"),
    ("a second pass covers slow 16 MB runner loads", "setTimeout(fitFrameCanvas, 1500)"),
    ("the fit is reachable for tests and the console", "fitFrame: fitFrameCanvas"),
]
for name, needle in wiring:
    ok = needle if isinstance(needle, bool) else (needle in gp)
    check(name, ok, needle if isinstance(needle, str) else "onFrameLoad wiring missing")

# ---------- 2. GameMaker-only detection ----------
check("GameMaker docs are detected by their canvas", 'doc.querySelector("canvas#canvas")' in gp)
check("the GM runner wrapper is part of the signature", 'doc.querySelector("div.gm4html5_div_class")' in gp)
check("detection is the guard on every pass",
      re.search(r"function fitFrameCanvas\(\)\s*\{[^}]*isGameMakerDoc\(doc\)", gp, re.S) is not None)
check("non-GameMaker frames bail out before touching the DOM",
      re.search(r"!doc \|\| !doc\.body \|\| !isGameMakerDoc\(doc\)\) return false;", gp) is not None)

# ---------- 3. scaling math: uniform, aspect-preserving, element-sized ----------
check("native size comes from the canvas attributes, not our style",
      "var nw = Number(canvas.width) || 0;" in gp and "var nh = Number(canvas.height) || 0;" in gp)
check("one uniform scale preserves the aspect ratio",
      "var scale = Math.min(vw / nw, vh / nh);" in gp)
check("the canvas ELEMENT is sized to the scaled bitmap",
      'canvas.style.width = Math.max(1, Math.round(nw * scale)) + "px";' in gp and
      'canvas.style.height = Math.max(1, Math.round(nh * scale)) + "px";' in gp)
check("the frame viewport is what it fits into",
      "doc.documentElement.clientWidth || w.innerWidth" in gp and
      "doc.documentElement.clientHeight || w.innerHeight" in gp)
check("centering is injected once", 'var FIT_STYLE_ID = "chalkle-fit-style";' in gp)
check("the centered body stretches to the frame",
      "body{display:flex;align-items:center;justify-content:center}" in gp)

# The anti-pattern this fix exists to avoid: stretching or letterboxing the
# ELEMENT with CSS and letting the runner's clientWidth/width scaleX go wrong.
# The injected sheet may only lay out the page; every canvas dimension comes
# from the fit math above.
style_block = re.search(r"style\.textContent =(.*?);", gp, re.S)
css = style_block.group(1) if style_block else ""
check("the injected style lays out the page, never the canvas",
      "html,body{" in css and "canvas" not in css, css)
check("no object-fit letterboxing of the canvas", "object-fit" not in css)
check("canvas dimensions are never full-bleed percentages",
      'canvas.style.width = "100%"' not in gp and 'canvas.style.height = "100%"' not in gp)

# ---------- 4. the runner really maps mouse coords off the element box ----------
undertale = ROOT / "game-builds" / "undertale" / "index.html"
runner = ROOT / "game-builds" / "undertale" / "html5game"
if undertale.is_file():
    html = undertale.read_text(encoding="utf-8", errors="replace")
    check("the vendored Undertale build is the fixed-size canvas this fixes",
          'id="canvas"' in html and 'width="640"' in html and 'height="480"' in html, str(undertale))
    check("its only scaling rule is the dead webkit pseudo-class",
          ":-webkit-full-screen" in html)
    run = sorted(runner.glob("*.js"))
    if run:
        js = run[0].read_text(encoding="utf-8", errors="replace")
        check("the GM runner scales the mouse by clientWidth / canvas.width",
              "clientWidth/_an7.width" in js.replace(" ", ""), run[0].name)
    else:
        print("SKIP  runner JS not present (game-builds is machine-local)")
else:
    print("SKIP  game-builds/undertale not present (machine-local, gitignored)")

# ---------- 5. both shipped copies stay identical ----------
src_gp = (ROOT / "src" / "gameplayer.js").read_bytes()
dep_gp = (ROOT / "deploy-static" / "src" / "gameplayer.js").read_bytes()
check("deploy-static mirrors the source player", src_gp == dep_gp)
for page in ("index.html", "deploy-static/index.html"):
    body = (ROOT / page).read_text(encoding="utf-8", errors="replace")
    check("cache version bumped in " + page,
          re.search(r"gameplayer\.js\?v=20260929b", body) is not None)

print()
if fails:
    print(f"CANVAS-FIT: {len(fails)} failure(s): " + ", ".join(fails))
    sys.exit(1)
print("CANVAS-FIT: all checks passed")
