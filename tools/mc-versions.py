#!/usr/bin/env python3
"""Import Minecraft version builds into Chalkle.

Copies every .html from the version-main folder into mc/, derives a clean
title + slug per build, renders a 400x225 thumbnail (flat era-colored
backdrop, grass block, version text in the Minecraft pixel font), and emits
the games.js entries (written to tools/mc-games-snippet.js, or inserted into
src/games.js with --apply).
"""
import os
import re
import sys
import shutil

SRC = r"C:\Users\zeqrY\Downloads\version-main\version-main"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MC_DIR = os.path.join(REPO, "mc")
THUMB_DIR = os.path.join(REPO, "assets", "games")
FONT = os.path.join(REPO, "tools", "mc-font", "PressStart2P.ttf")
GAMES_JS = os.path.join(REPO, "src", "games.js")

W = 400
H = 225

ERAS = {
    "classic": "#3a3f44",
    "rd": "#55504a",
    "alpha": "#7a5c3d",
    "beta": "#a9803a",
    "modern": "#35692a",
    "client": "#235d9e",
    "misc": "#172626",
}
GRASS = "#7ac65a"
GRASS_2 = "#5da844"
DIRT = "#8a6a3c"
DIRT_2 = "#6b4f2a"
EDGE = "#2a2417"

CLIENT_HINTS = [
    "client", "wurst", "tuff", "kone", "prism", "precision", "huzzium",
    "novix", "myven", "eclipse", "mega", "n0va", "water", "pixel", "aero",
    "eb client", "wispcraft", "eagly", "injector", "minicraft", "mc4k",
]


def slugify(stem):
    s = re.sub(r"[^a-z0-9._-]+", "-", stem.lower())
    return s.strip(".-")


def clean_stem(stem):
    # Underscore inside a version (1.0.1_01, 0.0.12a_3) stays; underscore
    # between words or a word and a version (Beta_1.7.3, Eaglercraft_1.12.2,
    # Tuff_Client, 20100214_JS) is a space.
    s = re.sub(r"(?<=[A-Za-z]{2})_(?=[A-Za-z\d])", " ", stem)
    s = re.sub(r"(?<=\d)_(?=[A-Za-z])", " ", s)
    s = re.sub(r"[-]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return pretty(s)


def pretty(s):
    """Title-case plain words, keep version-ish tokens as-is, honor a few
    known brand names, and keep WASM/JS/GC markers uppercase."""
    OVERRIDES = {
        "wurstx": "WurstX", "eaglymc": "EaglyMC", "mc4k": "mc4k",
        "minicraft": "Minicraft", "injector": "Injector", "novix": "Novix",
        "wasm": "WASM", "js": "JS", "gc": "GC", "n0va": "N0VA",
    }
    words = []
    for w in s.split(" "):
        low = w.lower()
        if low in OVERRIDES:
            words.append(OVERRIDES[low])
        elif re.match(r"^[A-Za-z]{2,}$", w):
            words.append(w[:1].upper() + w[1:].lower())
        else:
            words.append(w)
    return " ".join(words)


def classify(clean):
    low = clean.lower()
    if low.startswith("classic"):
        return "classic", "MINECRAFT CLASSIC"
    if low.startswith("rd"):
        return "rd", "MINECRAFT RD"
    if low.startswith("alpha"):
        return "alpha", "MINECRAFT ALPHA"
    if low.startswith("beta") or low.startswith("b1") or "pre-release" in low:
        return "beta", "MINECRAFT BETA"
    if low.startswith("indev") or low.startswith("infdev"):
        return "alpha", "MINECRAFT INDEV"
    for hint in CLIENT_HINTS:
        if hint in low:
            return "client", "MINECRAFT CLIENT"
    if low.startswith("eaglercraft") or low.startswith("eagler") or re.match(r"^\d", low):
        return "modern", "EAGLERCRAFT"
    return "misc", "MINECRAFT"


def version_token(clean):
    low = clean.lower()
    if low.startswith("rd "):
        return clean
    m = re.search(r"\d[\d]*(?:\.\d+)*(?:[._-]?[a-z]+\d*)*", low)
    if m:
        tok = m.group(0)
        if len(tok) >= 2:
            return tok
    return clean


def build_title(clean, era):
    low = clean.lower()
    if era == "client" or low.startswith("eagly") or low in (
        "Minicraft", "mc4k", "injector", "WurstX", "Aero Client JS",
    ):
        return clean
    if low.startswith("minecraft"):
        return clean
    return "Minecraft " + clean


def main():
    apply = "--apply" in sys.argv
    files = sorted(f for f in os.listdir(SRC) if f.lower().endswith(".html"))
    print(f"{len(files)} html builds found")

    existing = set()
    with open(GAMES_JS, encoding="utf-8") as fh:
        existing = set(re.findall(r'title:\s*"([^"]+)"', fh.read()))

    os.makedirs(MC_DIR, exist_ok=True)
    os.makedirs(THUMB_DIR, exist_ok=True)

    from PIL import Image, ImageDraw, ImageFont

    entries = []
    used_slugs = {}
    used_titles = {}
    for f in files:
        stem = f[:-5]
        slug = slugify(stem)
        if slug in used_slugs:
            slug = slug + "-" + str(used_slugs[slug] + 1)
        used_slugs[slug] = used_slugs.get(slug, 0) + 1

        clean = clean_stem(stem)
        era, label = classify(clean)
        title = build_title(clean, era)
        if title in existing or title in used_titles:
            title += " (Offline)"
        used_titles[title] = True

        # ---- copy ----
        dst = os.path.join(MC_DIR, slug + ".html")
        if not (os.path.exists(dst) and os.path.getsize(dst) == os.path.getsize(os.path.join(SRC, f))):
            print(f"copy {f} ({os.path.getsize(os.path.join(SRC, f))//1024//1024}MB)")
            shutil.copy2(os.path.join(SRC, f), dst)

        # ---- thumb ----
        tok = version_token(clean)
        tok_disp = tok.replace("_", ".")
        label_disp = label
        low = clean.lower()
        if "wasm" in low:
            label_disp += " - WASM"
        elif "gc" in low:
            label_disp += " - GC"
        elif "js" in low or "javas" in low:
            label_disp += " - JS"

        img = Image.new("RGB", (W, H), ERAS[era])
        d = ImageDraw.Draw(img)
        # grass block
        bx, by, bs = 200, 66, 96
        x0, y0 = bx - bs // 2, by - bs // 2
        top = bs * 0.42
        d.rectangle([x0, y0, x0 + bs - 1, y0 + top], fill=GRASS)
        d.rectangle([x0, y0 + top, x0 + bs - 1, y0 + bs - 1], fill=DIRT)
        d.line([x0, y0 + top, x0 + bs - 1, y0 + top], fill=GRASS_2, width=3)
        d.line([x0 + bs // 2, y0, x0 + bs // 2, y0 + top], fill=GRASS_2, width=2)
        d.line([x0, y0 + top, x0, y0 + bs - 1], fill=DIRT_2, width=2)
        d.line([x0 + bs - 1, y0 + top, x0 + bs - 1, y0 + bs - 1], fill=DIRT_2, width=2)
        d.rectangle([x0, y0, x0 + bs - 1, y0 + bs - 1], outline=EDGE, width=3)

        f_label = ImageFont.truetype(FONT, 18)
        f_ver = ImageFont.truetype(FONT, 46)
        # autofit version text
        while f_ver.size > 14 and d.textlength(tok_disp, font=f_ver) > W - 56:
            f_ver = ImageFont.truetype(FONT, f_ver.size - 2)
        def center_text(y, text, font, fill, stroke=0):
            tw = d.textlength(text, font=font)
            x = (W - tw) / 2
            d.text((x, y), text, font=font, fill=fill,
                   stroke_width=stroke, stroke_fill=(0, 0, 0))
        center_text(128, label_disp, f_label, (235, 235, 235))
        center_text(156, tok_disp, f_ver, (255, 255, 255), stroke=6)
        d.rectangle([12, 12, W - 13, H - 13], outline=EDGE, width=4)

        thumb = os.path.join(THUMB_DIR, "mc-" + slug + ".png")
        img.save(thumb)

        entries.append({
            "title": title,
            "url": "/mc/" + slug + ".html",
            "thumb": "/assets/games/mc-" + slug + ".png",
            "category": "Minecraft",
        })

    lines = []
    for e in entries:
        lines.append(
            '  { title: "' + e["title"] + '", url: "' + e["url"] +
            '", thumb: "' + e["thumb"] + '", category: "' + e["category"] + '" },'
        )
    block = "  /* Minecraft versions - imported offline builds. */\n" + "\n".join(lines) + "\n"

    snip = os.path.join(REPO, "tools", "mc-games-snippet.js")
    with open(snip, "w", encoding="utf-8") as fh:
        fh.write(block)
    print(f"snippet written: {len(entries)} entries -> {snip}")

    if apply:
        with open(GAMES_JS, encoding="utf-8") as fh:
            text = fh.read()
        idx = text.rstrip().rfind("];")
        cut = text.rstrip()
        if idx == -1:
            print("FAIL: could not find array end in games.js")
            sys.exit(1)
        text = cut[:idx] + block + cut[idx:]
        with open(GAMES_JS, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text + "\n")
        print("applied to", GAMES_JS)
    else:
        print("dry run - pass --apply to insert into games.js")


if __name__ == "__main__":
    main()