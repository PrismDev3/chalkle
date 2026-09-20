#!/usr/bin/env python3
"""Auto clicker panel gate. Run: python tools/clicker-test.py

Pins the two things the panel depends on:
  1. The matcher: every catalog game whose title or URL carries "clicker"
     must arm the panel, and a sample of non-clicker games must not. The
     expectation set is derived from the catalog files themselves, so a new
     clicker entry is covered the moment it lands.
  2. The engine wiring in src/gameplayer.js: the matcher is actually called
     when a game opens, events fire into the frame, the hotkey toggles, the
     Settings switch re-applies live, and the panel is torn down on close.

The matcher logic is re-implemented here in a few lines (case-insensitive
substring) rather than imported: gameplayer.js is a browser IIFE, and the
point is to catch drift between the catalog and the shipped behavior, not
to unit-test the exact function object.
"""
import json
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


def load_titles(path):
    """Pull the human titles out of a catalog file: they are plain "..." rows."""
    text = (ROOT / path).read_text(encoding="utf-8", errors="replace")
    return set(re.findall(r'title:\s*"([^"]+)"', text))


def load_urls(path):
    text = (ROOT / path).read_text(encoding="utf-8", errors="replace")
    found = set(re.findall(r'url:\s*"([^"]+)"', text))
    found |= set(re.findall(r'html:\s*"([^"]*clicker[^"]*)"', text, re.I))
    return found


def matches(title, url):
    t = (title or "").lower()
    u = (url or "").lower()
    return "clicker" in t or "clicker" in u


# ---------- 1. matcher against the real catalog ----------
catalog = {}
for f in ("src/games.js", "src/games2.js", "src/ugs-games.js", "src/cloudgames.js"):
    p = ROOT / f
    if p.exists():
        catalog[f] = (load_titles(f), load_urls(f))

expect_yes, expect_no = [], []
for f, (titles, urls) in catalog.items():
    for t in titles:
        (expect_yes if matches(t, "") else expect_no).append((f, t))
    for u in urls:
        if matches("", u):
            expect_yes.append((f, u))

check("catalog has clicker games to arm", len(expect_yes) >= 10,
      f"only {len(expect_yes)} matched")
check("matcher arms every clicker title/url",
      all(matches(t, u) for _, t in expect_yes for u in (t,)))

# Spot-check the negative space with real non-clicker entries.
sample_no = [t for _, t in expect_no][:6]
check("non-clicker titles stay unarmed",
      all(not matches(t, "") for t in sample_no), json.dumps(sample_no))

# Names that must keep matching even without spaces or separators.
tricky = ["ClickerHeroes", "italian-brainrot-clicker", "Cookie Clicker", "Spacebar Clicker"]
check("matcher handles glued and hyphenated names",
      all(matches(t, "") for t in tricky))

# ---------- 2. engine wiring in the shipped player ----------
gp = (ROOT / "src/gameplayer.js").read_text(encoding="utf-8", errors="replace")

wiring = [
    ("matcher runs when a game opens", "looksLikeClicker(current.title, current.url)"),
    ("matcher also checks the original URL",
     'looksLikeClicker("", current.originalUrl || "")'),
    ("panel is armed on frame load", "syncAc();"),
    ("mouse beats synthesize a full click sequence",
     'mouseEv(w, "click"'),
    ("pointer events fire too", "PointerEvent"),
    ("spacebar mode synthesizes key events", "KeyboardEvent"),
    ("games reading keyCode still see 32",
     'Object.defineProperty(e, "keyCode"'),
    # Aim regression: clicks must target the game's named clickable, not the
    # geometric center. Cookie Clicker keeps a stats canvas dead center that
    # ignores clicks; centered beats counted on the readout but never scored.
    ("aim finds named clickable elements", "acFindTarget(doc, w)"),
    ("aim matcher covers cookie/click/button/main ids",
     '[id*="cookie" i]'),
    ("aim matcher covers class hints too",
     '[class*="click" i]'),
    ("hidden or non-hit-testable targets are skipped", 'st.pointerEvents === "none"'),
    ("target is re-found when the frame navigates", "acInvalidateTarget();"),
    ("aim re-scans periodically for UI swaps", "ac.beatCount % 50 === 0"),
    ("center fallback still exists for canvas-only games",
     "doc.elementFromPoint(x, y) || doc.body || doc.documentElement"),
    # Manual target pick: the auto-aim only ever hits ONE element, but clickers
    # need more (cookie AND the upgrade store). "Pick target" lets a click
    # inside the game choose the element the engine hits, re-resolved by path
    # after a reload, cleared on navigation.
    ("pick-target button exists in the panel", 'gp-ac-pick'),
    ("pick arms a one-shot listener in the frame", "acArmPick()"),
    ("picked target re-resolves by CSS path after reload",
     "doc.querySelector(p.path)"),
    ("picked target wins over the auto-aim", "acTarget.picked"),
    ("frame navigation clears a stale pick", "acInvalidateTarget();"),
    # Hotkey regression: while the game iframe holds keyboard focus, a
    # parent-document keydown never fires, so F6 died the moment you played.
    ("hotkey also listens inside the game frame", "guardAcHotkey()"),
    ("frame hotkey listener attaches once per frame", "__chalkleAcHooked"),
    ("hotkey toggles without leaving the game", 'pressed === ac.hotkey'),
    ("hotkey capture ignores form fields", 'tag === "INPUT"'),
    ("settings switch applies live", "applyClickerPolicy"),
    ("switch pref key", 'chalkle-clicker-panel'),
    ("state is remembered across sessions", "chalkle-clicker"),
    ("timing jitter exists", "Math.random()"),
    ("close tears the panel down", "acStop()"),
    # BlurAutoClicker parity: rate units, mouse button choice, duty cycle.
    ("rate unit dropdown exists", 'gp-ac-unit'),
    ("per-minute rates convert to seconds", 'ac.cps / 60'),
    ("per-hour rates convert to seconds", 'ac.cps / 3600'),
    ("unit choice feeds the scheduler", "acRatePerSecond()"),
    ("burst ceiling is 500 per second", 'Math.max(2, Math.round(1000 / acRatePerSecond()))'),
    ("left button chip", 'data-btn="left"'),
    ("middle button chip", 'data-btn="middle"'),
    ("right button chip", 'data-btn="right"'),
    ("middle button carries button=1", "middle: { num: 1, down: 4 }"),
    ("right button carries button=2", "right:  { num: 2, down: 2 }"),
    ("events carry a real buttons bitmask", 'Object.defineProperty(e, "buttons"'),
    ("duty cycle slider exists", 'gp-ac-duty'),
    ("release is delayed by the duty share", 'Math.round((delay || 100) * ac.duty / 100)'),
    ("duty applies to spacebar holds too", 'fireSpace(delay)'),
    ("rate readout rescales to the unit", 'ac.beats.length * (ac.unit === "m" ? 60'),
]
for name, needle in wiring:
    check(name, needle in gp, needle)

app = (ROOT / "src/app.js").read_text(encoding="utf-8", errors="replace")
check("settings row is wired in app.js", "opt-clicker-panel" in app)

html = (ROOT / "index.html").read_text(encoding="utf-8", errors="replace")
check("settings row exists in the page", "opt-clicker-panel" in html)
check("panel styles ship", ".gp-ac {" in (ROOT / "src/styles.css").read_text(encoding="utf-8", errors="replace"))

print()
if fails:
    print(f"CLICKER: {len(fails)} failure(s): " + ", ".join(fails))
    sys.exit(1)
print("CLICKER: all checks passed")
