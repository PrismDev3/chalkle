#!/usr/bin/env python3
"""
Fix SVG thumbnail placeholders in src/games.js.

For each game entry whose `thumb` is a `data:image/svg+xml,...` placeholder,
derive candidate real filenames from the entry's `url` slug (e.g.
/ugs/clachievmentunlocked.html -> clachievmentunlocked.webp / .jpg) and pick
the first one that actually exists under assets/games/real.

Write a manifest (build/svg-thumb-manifest.json) so you can review the mapping
before applying it. Run with:  python scripts/fix-svg-thumbs.py
"""

import re
import os
import json
import html as _html

SRC = "src/games.js"
REAL_DIR = "assets/games/real"
OUT = "build/svg-thumb-manifest.json"

NAVY = "#151B22"
ACCENT = "#00FF7E"
BAR = "#1B2A3A"


def slug_candidates(url: str):
    """Return ordered candidate real filenames derived from a game url."""
    base = url.rstrip("/").split("/")[-1]          # clachievmentunlocked.html
    name = re.sub(r"\.html.*$", "", base)          # clachievmentunlocked
    out = []
    for ext in (".webp", ".jpg", ".jpeg", ".png"):
        out.append(f"{name}{ext}")
        out.append(f"{name}{ext.lower()}")
    # also try variants with/without 'cl' prefix already covered by above;
    # keep simple.
    return out


def main():
    # real files present on disk (lower-cased set for matching)
    real_files = {}
    if os.path.isdir(REAL_DIR):
        for fn in os.listdir(REAL_DIR):
            low = fn.lower()
            if low.endswith((".webp", ".jpg", ".jpeg", ".png")):
                # prefer webp > jpg > png tie-break by extension order below
                real_files[low] = fn

    with open(SRC, encoding="utf-8") as f:
        src = f.read()

    manifest = []
    for idx, line in enumerate(src.splitlines(), 1):
        if "data:image/svg+xml" not in line or "thumb:" not in line:
            continue
        tm = re.search(r'title:\s*(["\'])([^"\']+)\1', line)
        title = tm.group(2) if tm else ""
        um = re.search(r'url:\s*(["\'])([^"\']+)\1', line)
        url = um.group(2) if um else ""
        # find best matching real file
        chosen = None
        chosen_orig = None
        for c in slug_candidates(url):
            orig = real_files.get(c.lower())
            if orig:
                chosen = c
                chosen_orig = orig
                break
        # when no on-disk file exists, synthesize an SVG badge that still looks
        # like a real thumb (navy bg, accent border, title text + PLAY tag) but
        # is reference-free so the CDN never 404s on it. This keeps the grid
        # visually consistent instead of leaving broken image icons.
        synthetic = None
        if not chosen:
            synthetic = make_svg_badge(title)
        manifest.append({
            "line": idx,
            "title": title,
            "url": url,
            "matched_file": chosen,     # local path if on disk, else None
            "matched_file_orig": chosen_orig,
            "synthetic_svg": synthetic,  # SVG badge data URI if no file
        })

    os.makedirs("build", exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    total = len(manifest)
    with_file = sum(1 for m in manifest if m["matched_file"])
    synthetic = sum(1 for m in manifest if m.get("synthetic_svg"))
    print(f"SVG thumb entries: {total}")
    print(f"matched to a real file on disk: {with_file}")
    print(f"synthetic SVG badge (no file): {synthetic}")
    print(f"manifest -> {OUT}")

    return manifest


def apply_manifest():
    """Read the manifest and rewrite SVG thumb values in src/games.js in place."""
    manifest_path = OUT
    if not os.path.exists(manifest_path):
        print(f"manifest not found at {manifest_path}; regenerate first")
        return

    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)

    with open(SRC, encoding="utf-8") as f:
        lines = f.read().splitlines(True)

    changed = 0
    errors = []
    for entry in manifest:
        lineno = entry["line"]
        if lineno < 1 or lineno > len(lines):
            errors.append(f"bad line {lineno}")
            continue
        line = lines[lineno - 1]
        new_thumb = None
        if entry.get("matched_file"):
            new_thumb = f'"/assets/games/real/{entry["matched_file_orig"]}"'
        elif entry.get("synthetic_svg"):
            new_thumb = f'"{entry["synthetic_svg"]}"'
        if new_thumb is None:
            continue
        # Replace the existing thumb value (quoted, possibly very long SVG).
        before = line
        line = replace_thumb_value(line, new_thumb)
        if line == before:
            errors.append(f"L{lineno}: no thumb value replaced (title={entry['title']!r})")
            continue
        lines[lineno - 1] = line
        changed += 1

    with open(SRC, "w", encoding="utf-8") as f:
        f.writelines(lines)

    print(f"thumb values replaced: {changed}")
    if errors:
        print(f"errors: {len(errors)}")
        for e in errors[:20]:
            print(" ", e)


def replace_thumb_value(line: str, new_val: str) -> str:
    """Replace the thumb value in a single games.js entry line.

    Pattern (robust to quote style and to the hugely long SVG value):
        thumb: "..."   or   thumb: '...'
    We match `thumb:` then optional whitespace then a quote char, then
    everything up to the next unescaped same quote char, and replace with
    new_val. The value is always the last key before the line's closing ` },`
    or ` }` so we anchor on the closing quote that precedes `,` or `}`.
    """
    m = re.search(r'(thumb:\s*)(["\'])(.*?)\2\s*,?\s*\}$', line)
    if not m:
        return line
    prefix = m.group(1)
    q = m.group(2)
    tail = line[m.end():]
    return f'{prefix}{q}{new_val}{q}{tail}' 


def make_svg_badge(title: str) -> str:
    """Reference-free SVG thumbnail badge for entries with no real image.

    Kept minimal and visually consistent with the rest of the grid so the CDN
    never 404s on a missing asset.
    """
    safe = re.sub(r"[^A-Za-z0-9 _\-\u0021$\\()]+", " ", title).strip()
    safe = safe or "PLAY"
    words = safe.split()
    line1 = ""
    line2 = ""
    for w in words:
        test = (line1 + " " + w).strip()
        if len(test) <= 16:
            line1 = test
        else:
            if not line2:
                line2 = w
            else:
                line2 += " " + w
    if not line1:
        line1 = safe
    text1 = _html.escape(line1)
    text2 = _html.escape(line2) if line2 else "PLAY"
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" '
        'viewBox="0 0 640 360">'
        '<defs>'
        '<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">'
        f'<stop offset="0" stop-color="{NAVY}"/>'
        f'<stop offset="1" stop-color="{BAR}"/>'
        '</linearGradient>'
        '</defs>'
        '<rect width="640" height="360" fill="url(#bg)"/>'
        '<g stroke="rgba(255,255,255,0.06)" stroke-width="1">'
        '<path d="M0 180H640M160 0V360M320 0V360M480 0V360"/>'
        '</g>'
        f'<rect x="0" y="252" width="640" height="6" fill="{ACCENT}" opacity="0.85"/>'
        f'<text x="320" y="150" text-anchor="middle" font-family="Arial Black,sans-serif" '
        'font-size="40" font-weight="900" fill="#ffffff" paint-order="stroke fill" '
        'stroke="rgba(0,0,0,0.35)" stroke-width="4">'
        f'{text1}'
        '</text>'
        f'<text x="320" y="330" text-anchor="middle" font-family="Arial,sans-serif" '
        'font-size="20" font-weight="700" fill="#00FF7E" letter-spacing="4">'
        f'{text2}'
        '</text>'
        '</svg>'
    )
    b64 = (_html.btoa(svg) if hasattr(_html, "btoa")
           else __import__("base64").b64encode(svg.encode()).decode())
    return f"data:image/svg+xml;base64,{b64}"


if __name__ == "__main__":
    import sys

    mode = sys.argv[1] if len(sys.argv) > 1 else "manifest"

    if mode == "apply":
        apply_manifest()
    else:
        main()

