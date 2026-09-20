#!/usr/bin/env python3
"""Add locally hosted games that the catalog never listed.

ugs/ holds 2,200+ playable HTML builds, and the catalog only references part
of them. This tool walks the folder, throws out everything that is already
listed (or is a duplicate, a stub or a wrapper), and writes the survivors to
src/ugs-games.js in the same shape as src/games2.js so app.js picks them up.

Every survivor also gets a cover tile under assets/games/tiles/, rendered
from the game's own title: flat fill, no gradient, so a new entry never shows
the generic controller placeholder. Delete a tile and rerun to regenerate it.

Run from the repo root:

    python tools/add-ugs-games.py            # write the catalog + tiles
    python tools/add-ugs-games.py --dry-run  # report only, change nothing
"""
import glob
import hashlib
import html
import os
import re
import sys
import unicodedata
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = [
    "src/games.js", "src/games2.js", "src/noah-games.js",
    "src/community-games.js", "src/webports.js", "src/cloudgames.js",
]
# Only these two hold the library grid, so only these two get tile backfill.
GRID_FILES = ["src/games.js", "src/games2.js"]
OUT = "src/ugs-games.js"
TILE_DIR = "assets/games/tiles"

# One catalog entry per line: { title: "...", url: "...", ... }
ENTRY_LINE = re.compile(r'^(\s*\{\s*title:\s*"([^"]*)",\s*url:\s*"([^"]*)")')
TILE_FIELD = re.compile(r'\bthumb\s*:')

# Wrappers and cloaked copies of games that are already in the catalog. The
# cl* files are re-hosts under ugs/ of games listed from other folders, so
# listing them again would put the same game in the grid twice.
SKIP_BASENAME_PREFIX = ("cl",)
SKIP_TITLES = {
    "game", "homework", "duck", "clai", "cs", "w1", "w2", "w3", "3d", "3d2",
    "mydrivegoogledrive", "unbl0ckedz0nemediaplayer", "pagettitle",
    "granny3returntheschool",
}
# Page titles that are not games at all, matched against the normalized title.
SKIP_CONTAINS = ("epstein", "femboy", "mediaplayer", "googledrive")

# Builds whose <title> is a placeholder ("Game", "ok") but whose file name is
# the real thing. Keyed by lowercased file stem with punctuation removed.
STEM_TITLES = {
    "baldisbasics": "Baldi's Basics",
    "baldi2": "Baldi's Basics 2",
    "baldisdecompile": "Baldi's Basics Decompile",
    "bendy": "Bendy and the Ink Machine",
    "bartblast": "Bart Blast",
    "basketrandom": "Basket Random",
    "baseballbros": "Baseball Bros",
    "bladeball": "Blade Ball",
    "bloodmoney": "Blood Money",
    "crazycattle": "Crazy Cattle 3D",
    "cuphead": "Cuphead",
    "flyinggorilla": "Flying Gorilla",
    "goosegame": "Untitled Goose Game",
    "kindergarten": "Kindergarten",
    "lethalape": "Lethal Ape",
    "plagueinc": "Plague Inc.",
    "ragdoll": "Ragdoll",
    "raldiscrackhouse": "Raldi's Crackhouse",
    "rocketgoal": "Rocket Goal",
    "slowroads": "Slow Roads",
    "soccerrandom": "Soccer Random",
    "spacewaves": "Space Waves",
    "survivalrace": "Survival Race",
    "whosyourdaddy": "Who's Your Daddy",
}

RENAME = {
    "fnaelastbreath": "FNAE Last Breath",
    "fnfbfdi26": "FNF BFDI 2.6",
    "fnftails": "Tails Gets Trolled",
    "fnfourple": "Ourple Guy",
    "fnflullaby": "FNF Lullaby",
    "indiantruckdriving unbl0ckedz0ne": "Indian Truck Driving",
    "eaglercraftx 1.8 wasm-gc": "EaglercraftX 1.8 (WASM)",
    "eaglercraft 1.12 wasm-gc": "Eaglercraft 1.12 (WASM)",
    "eaglercraftx 1.12 wasm-gc": "EaglercraftX 1.12 (WASM)",
    "eaglercraftx 1.11.2": "EaglercraftX 1.11.2",
    "eaglercraftx 1.8": "EaglercraftX 1.8.8",
    "eaglercraftl 1.9": "EaglercraftL 1.9",
    "eaglercraft local": "Nebula Client",
    "eaglercraft launcher indev offline": "Eaglercraft Indev",
    "eaglercraft launcher alpha 1.2.6 offline": "Eaglercraft Alpha 1.2.6",
    "eaglercraft launcher beta 1.3 offline": "Eaglercraft Beta 1.3",
    "gdwave3d": "Geometry Dash Wave 3D",
    "gdwave2": "Geometry Dash Wave 2",
    "growagarden": "Grow a Garden",
    "sab2player": "Slap Battles 2 Player",
    "crunchyxp": "Crunchy XP",
    "nitroclash": "Nitro Clash",
    "grannyonline": "Granny Online",
    "wheresbaldi": "Where's Baldi",
    "gtamods": "GTA Mods",
    "dashio": "Dash.io",
    "bendy clicker — enhanced": "Bendy Clicker",
    "infinite craft": "Infinite Craft",
    "wrestle bros play now on the official site": "Wrestle Bros",
    "dinosaur game chrome": "Dinosaur Game",
    "dogeminer 2 unblocked - gnhusgames": "Dogeminer 2",
}

# Category rules, first match wins. Names match the ones already used across
# the data files so the genre chips stay consistent.
CATEGORY_RULES = [
    (r"eaglercraft|minecraft|pi ?client|nit ?client|coder ?craft|fuchsia|nebula|craft", "Minecraft"),
    (r"geometry dash|rhythm", "Rhythm"),
    (r"granny|baldi|horror|fnaf|five nights|buckshot", "Horror"),
    (r"clicker|idle|grow a garden|dogeminer", "Idle"),
    (r"race|racing|kart|road|subway|pursuit|surf", "Racing"),
    (r"tower defense|defen[cs]e", "Tower Defense"),
    (r"wrestle|brawl|slap|football|baseball|basket|soccer|sport|golf", "Sports"),
    (r"shooter|frag|aim|sniper", "Action"),
    (r"puzzle|2048|word|sudoku|solitaire", "Puzzle"),
    (r"survival|adventure|rpg|dungeon", "RPG"),
    (r"sim|tycoon|farm|city", "Simulation"),
    (r"multiplayer|2 ?player|io$", "Multiplayer"),
]

# Flat accents from the app's own palette. No gradients anywhere.
PALETTE = [
    (0x5B, 0x93, 0xFF), (0xF5, 0xB3, 0x01), (0x4C, 0xC5, 0x6F),
    (0xE2, 0x6B, 0x6B), (0x9B, 0x8C, 0xF5), (0x3F, 0xB6, 0xBE),
    (0xE0, 0x8A, 0x3C), (0xB0, 0x7A, 0xD6), (0x6F, 0xA8, 0x3C),
    (0xD4, 0x6E, 0x9E),
]

FONT_CANDIDATES = [
    "C:/Windows/Fonts/seguibl.ttf", "C:/Windows/Fonts/arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]


def slug(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def norm_title(text):
    s = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    s = s.replace(".io", " ").replace(".dev", " ")
    for word in ("unblocked", "unbl0ckedz0ne", "official site", "play now", "offline",
                 "free online", "download", "launcher", "release", "gnhusgames",
                 "enhanced", "chrome", "wasm-gc", "wasm"):
        s = s.replace(word, " ")
    return re.sub(r"[^a-z0-9]+", "", s)


def tokens(text):
    return set(re.findall(r"[a-z0-9]+", unicodedata.normalize("NFKD", text)
                          .encode("ascii", "ignore").decode().lower()))


def catalog_titles():
    titles = []
    for rel in CATALOG:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            continue
        text = open(path, encoding="utf-8", errors="replace").read()
        titles += [m.group(1).strip() for m in re.finditer(r'title:\s*"([^"]+)"', text)]
    return titles


def catalog_paths():
    refs = set()
    for rel in CATALOG:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            continue
        text = open(path, encoding="utf-8", errors="replace").read()
        for m in re.finditer(r'\b(?:url|html|play|embed|src)\s*:\s*"([^"]+)"', text):
            refs.add(m.group(1).split("?")[0].lstrip("/"))
    return refs


def scan_roots():
    """Every folder that holds a locally playable build."""
    # game-builds/ is left out on purpose: those folders are standalone apps
    # (a browser, a chat client, a phone mock) already surfaced as their own
    # tabs, not games for the library.
    paths = sorted(glob.glob(os.path.join(ROOT, "ugs", "*.html")))
    paths += sorted(glob.glob(os.path.join(ROOT, "gn", "*.html")))
    return paths


def read_title(path):
    raw = open(path, "rb").read(240000).decode("utf-8", "replace")
    m = re.search(r"<title[^>]*>(.*?)</title>", raw, re.S | re.I)
    title = html.unescape(re.sub(r"\s+", " ", m.group(1)).strip()) if m else ""
    # Strip emoji and odd symbol runs that game pages like to put in titles.
    title = re.sub(r"[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F]", "", title).strip()
    # Portals tack their own name onto the page title.
    title = re.sub(r"\s*[|\u2013\u2014-]\s*(?:unbl0?cked?z0ne|unblocked|gnhustgames|free online games?)\s*$", "", title, flags=re.I).strip()
    title = clean_title(title)
    # Many builds are re-hosts of a game someone else packaged: the real name
    # sits in the <base href> folder they were served from, and <title> is just
    # the author's build number or the engine's banner line. Prefer the folder
    # name when it is there, fall back to the page title.
    if usable_title(title):
        return title, raw
    for derive in (title_from_markup, title_from_swf):
        derived = derive(raw)
        if derived and usable_title(derived):
            return derived, raw
    return title, raw


# Banner lines that name the tool, the portal or the engine instead of a game.
NOT_A_TITLE = re.compile(
    r"wrapper|template|playables|playable\b|dosbox|emulatorjs|xash|browser|discord|"
    r"yukios|gust|iphone|webgl|unity web player|roulette|^web$|^main$|^game\b|"
    r"^coolgames$|^hype$|^about:blank$|group chat|^google\.com$|^youtube$|"
    r"unblocked$|^play now$|embeds?$|atari embeds", re.I)

# Engine banners that wrap the real name behind a pipe or a colon. Almost
# every Unity web build ships as "Unity WebGL Player | <game>", which used to
# make the whole title unusable even though the game name was right there.
TITLE_BANNER = re.compile(
    r"^(?:unity\s+(?:webgl|web\s*player|player)|play\s+now|play|game|games|"
    r"my\s+game|html5\s+game|flash\s+game|dos\s+game)\s*[|:\-]\s*", re.I)

# Pipeless portal wrappers, the mirror of the suffix strip in read_title.
TITLE_SUFFIX = re.compile(
    r"\s*[|:\-]\s*(?:unbl0?cked?z0ne|unblocked|gnhustgames|gnhusgames|"
    r"free online games?|play online|html5 games?)\s*$", re.I)


def clean_title(title):
    """Peel an engine banner or a portal pipe off a page title.

    "Unity WebGL Player | Slope Plus" is Slope Plus. "Pou | Gnhusgames" is
    Pou. Segments that still read as boilerplate are thrown out and the
    longest surviving one wins, which keeps the game name over the site name.
    """
    title = TITLE_BANNER.sub("", title.strip()).strip()
    title = TITLE_SUFFIX.sub("", title).strip()
    if "|" in title:
        parts = [part.strip() for part in title.split("|") if part.strip()]
        good = [part for part in parts if usable_title(part)]
        if good:
            title = max(good, key=len)
    return title

# Smallest build worth listing. Below this it is a redirect page, not a game.
MIN_BUILD_BYTES = 3 * 1024


def usable_title(title):
    """A title worth showing: words, not a build number or an engine banner."""
    if not title or len(title) < 3:
        return False
    # Three letters is the floor real names need: Pou, OvO, CS2. Anything
    # shorter is a build tag ("a", "v2") or an error page.
    if len(re.sub(r"[^A-Za-z]", "", title)) < 3:
        return False
    if NOT_A_TITLE.search(title):
        return False
    core = re.sub(r"[^A-Za-z]", "", title)
    return not re.match(r"^(?:f|a|fix|fixf|temp|win)?$", core.lower())


ACRONYMS = {
    "fnf": "FNF", "fnaf": "FNAF", "fnae": "FNAE", "bfdi": "BFDI", "gta": "GTA",
    "io": "io", "3d": "3D", "2d": "2D", "fps": "FPS", "rpg": "RPG", "os": "OS",
    "cs": "CS", "mc": "MC", "tmnt": "TMNT", "mlp": "MLP", "dbz": "DBZ",
}


def joke_title(title):
    """A single 20 letter word is a troll page title, not a game name."""
    return len(title.split()) == 1 and len(title) > 20


def prettify_filename(stem):
    """Turn a run-together filename into something readable.

    fnfmario -> FNF Mario, bloodmoney2 -> Blood Money 2, ourple -> Ourple.
    Returns (title, improved): improved is False when the name came through
    untouched, which means the file was never given a real name and the entry
    should be skipped rather than listed as a lowercase blob.
    """
    text = stem.replace("-", " ").replace("_", " ")
    marked = text != stem
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", text)
    text = re.sub(r"(?<=[A-Za-z])(?=\d)", " ", text)
    text = re.sub(r"(?<=\d)(?=[A-Za-z])", " ", text)
    words = []
    for word in text.split():
        low = word.lower()
        if low in ACRONYMS:
            words.append(ACRONYMS[low])
            continue
        # A known acronym glued to the front of a word: fnfmario -> FNF Mario.
        glued = False
        for key in sorted(ACRONYMS, key=len, reverse=True):
            if len(key) >= 3 and low.startswith(key) and len(low) > len(key) + 2:
                rest = word[len(key):]
                words.append(ACRONYMS[key])
                words.append(rest[:1].upper() + rest[1:])
                glued = True
                break
        if not glued:
            words.append(word)
    title = " ".join(words).strip()
    title = title[:1].upper() + title[1:] if title else title
    improved = marked or stem != stem.lower() or any(c.isdigit() for c in stem) or any(w in ACRONYMS.values() for w in words)
    if any(len(w) > 14 for w in title.split()):
        improved = False
    return title, improved


def title_from_markup(raw):
    """Pull a game name out of a wrapper's base href or frame source."""
    NOISE = {"about:blank", "web", "main", "index", "gh", "refs", "heads", "artifacts"}
    candidates = []
    for pattern in (r'<base[^>]+href="([^"]+)"', r'<iframe[^>]+src="([^"]+)"'):
        m = re.search(pattern, raw, re.I)
        if m:
            candidates.append(m.group(1))
    for raw_url in candidates:
        if "google.com/macros" in raw_url or raw_url.startswith("about:"):
            continue
        path = urllib.parse.unquote(raw_url).rstrip("/")
        parts = [p for p in path.split("/")
                 if p and p.lower() not in NOISE and not re.match(r"^[0-9a-f]{12,}$", p)]
        if not parts:
            continue
        name = re.sub(r"@.*$", "", parts[-1])
        if "." in name and not name.lower().endswith(".html"):
            name = name.split(".")[0]
        name = re.sub(r"\.html?$", "", name, flags=re.I)
        name = re.sub(r"[-_]+", " ", name).strip()
        # Repo folders add noise around the real name: "slow-roads-main".
        name = re.sub(r"\s+(?:main|master|src|dist|build|latest|official)$", "", name, flags=re.I)
        name = re.sub(r"\s+v?\d+(?:[.\d]*)$", "", name).strip()
        # One long run-together token is a repo slug, not a title ("Wbwwb").
        if len(name.split()) < 2:
            continue
        if len(re.sub(r"[^A-Za-z]", "", name)) < 3:
            continue
        small = {"of", "the", "a", "an", "and", "n", "in", "to", "for"}
        words = [w if w.lower() in small else w[:1].upper() + w[1:].lower() for w in name.split()]
        return " ".join(words)
    return ""


# Ruffle wrappers ship no <title> at all: the only name in the file is the
# SWF url. Both halves of that url can carry it - the file name
# (this_is_the_only_level.swf) and the repo it lives in, which is often the
# only readable one (playlettee/super-smash-flash/ssf1.swf).
SWF_SRC = re.compile(r'"([^"\s]+\.swf(?:\?[^"\s]*)?)"', re.I)

# Path segments that are structure, a revision, or a host: never a game name.
SWF_NOISE = {
    "gh", "raw", "cdn", "assets", "asset", "dist", "build", "src", "files",
    "file", "game", "games", "html5", "flash", "swf", "js", "main", "master",
    "static", "public", "upload", "uploads", "storage", "v1", "v2", "index",
}


def _name_score(name):
    """How much a slug looks like a game title rather than a build tag."""
    letters = len(re.sub(r"[^A-Za-z]", "", name))
    if letters < 4 or name[:1].isdigit():
        return 0
    score = letters
    if len(name.split()) >= 2:
        score += 12
    if re.search(r"\d\s+\d", name):
        score -= 6
    if len(name.split()) == 1 and letters < 6:
        score -= 8
    return max(score, 0)


def title_from_swf(raw):
    """Turn an embedded Flash url into a readable game title."""
    best, best_score = "", 0
    for match in SWF_SRC.finditer(raw):
        path = urllib.parse.unquote(match.group(1)).split("?")[0]
        parts = [p for p in path.split("/") if p]
        if parts and parts[0] == "gh":
            parts = parts[1:]
        # The first surviving segment is the account name, never the game.
        candidates = parts[1:] if len(parts) > 1 else parts
        for part in candidates:
            if part.lower() in SWF_NOISE:
                continue
            if re.fullmatch(r"[0-9a-f]{12,}", part):
                continue
            if re.fullmatch(r"v?\d+(?:\.\d+)*", part):
                continue
            slug = part.split("@")[0]
            if not slug.lower().endswith(".swf"):
                # Account and repo segments name whoever packed the file, not
                # the game (click-jogos, some-repo, shadow-dev-labs). Only the
                # Flash file itself is trusted.
                continue
            slug = re.sub(r"\.swf$", "", slug, flags=re.I)
            slug = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", slug)
            slug = re.sub(r"[-_+]+", " ", slug)
            slug = re.sub(r"\s*\b(?:v|ver|build|final|fixed?|copy)\s*\d+(?:\.\d+)*$", "", slug, flags=re.I)
            slug = re.sub(r"\s+", " ", slug).strip()
            if not slug or NOT_A_TITLE.search(slug):
                continue
            score = _name_score(slug)
            if score > best_score:
                best, best_score = slug, score
    if not best:
        return ""
    small = {"of", "the", "a", "an", "and", "in", "to", "for", "is", "on", "my"}
    words = [w if w.lower() in small else ACRONYMS.get(w.lower(), w[:1].upper() + w[1:])
             for w in best.split()]
    title = " ".join(words)
    return title[:1].upper() + title[1:] if title else title


def guess_category(title):
    low = title.lower()
    for pattern, name in CATEGORY_RULES:
        if re.search(pattern, low):
            return name
    return "Arcade"


def pick_color(title):
    digest = hashlib.md5(title.encode("utf-8")).hexdigest()
    return PALETTE[int(digest[:4], 16) % len(PALETTE)]


def load_font(size):
    from PIL import ImageFont
    for candidate in FONT_CANDIDATES:
        if os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, size)
            except Exception:
                continue
    return ImageFont.load_default()


def write_tile(title, category, out_path):
    """A flat cover: dark field, accent rule, big initials, the title, the genre."""
    from PIL import Image, ImageDraw
    accent = pick_color(title)
    width, height = 320, 200
    img = Image.new("RGB", (width, height), (18, 16, 13))
    draw = ImageDraw.Draw(img)

    # Flat accent panel behind the initials.
    draw.rectangle([0, 0, width, 6], fill=accent)
    initials = "".join(w[0] for w in re.findall(r"[A-Za-z0-9]+", title)[:2]).upper() or "?"
    draw.text((18, 16), initials, font=load_font(56), fill=accent)

    words = title.split()
    lines, line = [], ""
    font_small = load_font(19)
    for word in words:
        probe = (line + " " + word).strip()
        if draw.textlength(probe, font=font_small) > width - 36 and line:
            lines.append(line)
            line = word
        else:
            line = probe
    if line:
        lines.append(line)
    y = height - 22 - len(lines[:2]) * 22
    for text in lines[:2]:
        draw.text((18, y), text, font=font_small, fill=(236, 233, 225))
        y += 22

    draw.text((18, height - 20), category.upper(), font=load_font(13), fill=(120, 114, 104))

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    img.save(out_path, "JPEG", quality=82, optimize=True)


def scan():
    refs = catalog_paths()
    known = [norm_title(t) for t in catalog_titles()]
    known_tokens = [tokens(t) for t in catalog_titles()]

    def already_known(title):
        n = norm_title(title)
        if not n:
            return True
        if any(n == k for k in known if k):
            return True
        # Token overlap catches "Granny 3 Return the School" against "Granny 3".
        mine = tokens(title)
        for other in known_tokens:
            if not mine or not other:
                continue
            overlap = len(mine & other) / max(1, min(len(mine), len(other)))
            if overlap >= 0.75:
                return True
        return False

    kept, dropped = [], []
    for path in scan_roots():
        rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
        if rel in refs:
            continue
        if os.path.getsize(path) < MIN_BUILD_BYTES:
            dropped.append((rel, "stub"))
            continue
        base = os.path.basename(rel)[:-5].lower()
        # game-builds/<name>/index.html carries the game name in the folder.
        if base == "index" and rel.startswith("game-builds/"):
            base = rel.split("/")[1].lower()
        if base.startswith(SKIP_BASENAME_PREFIX):
            dropped.append((rel, "cloaked duplicate"))
            continue
        title, raw = read_title(path)
        if raw.lower().count("<script") == 0:
            dropped.append((rel, "no script"))
            continue
        stem = os.path.basename(rel)[:-5]
        stem_key = re.sub(r"[^a-z0-9]", "", stem.lower())
        if not usable_title(title) or joke_title(title):
            # The file name beats a placeholder or a troll page title.
            title = STEM_TITLES.get(stem_key) or RENAME.get(stem_key) or ""
        if not usable_title(title):
            title, improved = prettify_filename(stem)
            if not improved:
                dropped.append((rel, "no usable name"))
                continue
        if title.strip().lower() in RENAME:
            title = RENAME[title.strip().lower()]
        if not usable_title(title):
            dropped.append((rel, "no usable name"))
            continue
        if joke_title(title):
            dropped.append((rel, "no usable name"))
            continue
        low = title.strip().lower()
        if low in RENAME:
            title = RENAME[low]
        key = title.strip().lower()
        norm = norm_title(title)
        if key in SKIP_TITLES or norm in SKIP_TITLES or any(w in norm for w in SKIP_CONTAINS):
            dropped.append((rel, "not a game"))
            continue
        if already_known(title):
            dropped.append((rel, "already listed"))
            continue
        kept.append({"title": title.strip(), "file": rel, "size": os.path.getsize(path)})

    # Same game reachable from two files: keep the bigger build.
    best = {}
    for row in kept:
        key = norm_title(row["title"])
        if key not in best or row["size"] > best[key]["size"]:
            best[key] = row
    return sorted(best.values(), key=lambda r: (-r["size"], r["title"].lower())), dropped


def emit(rows):
    lines = [
        "/* Local game builds under ugs/ that the catalog never listed, plus a",
        "   generated cover tile for each one. Produced by",
        "   tools/add-ugs-games.py - rerun that after adding new builds to ugs/",
        "   instead of editing this file by hand. Loaded after games.js and",
        "   games2.js, before app.js, so push.apply keeps one array and order. */",
        "if (!window.ChalkGames) window.ChalkGames = [];",
        "window.ChalkGames.push.apply(window.ChalkGames, [",
    ]
    for row in rows:
        category = guess_category(row["title"])
        thumb = "/%s/%s.jpg" % (TILE_DIR, slug(row["title"]))
        desc = "%s build you can play right here in the browser." % category
        lines.append(
            '  { title: "%s", url: "/%s", category: "%s", desc: "%s", thumb: "%s" },'
            % (row["title"].replace('"', "'"), row["file"], category, desc, thumb)
        )
    lines.append("]);")
    lines.append("")
    return "\n".join(lines)


def missing_thumbs():
    """Catalog entries in the grid that carry no artwork at all.

    Returns (path, title, url) for every entry whose line has no thumb field
    and whose url points at a build that is actually on disk, so the tile we
    render is guaranteed to sit next to something playable.
    """
    found = []
    for rel in GRID_FILES:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                m = ENTRY_LINE.match(line)
                if not m or TILE_FIELD.search(line):
                    continue
                title, url = m.group(2).strip(), m.group(3)
                if not title or "://" in url:
                    continue
                if not os.path.exists(os.path.join(ROOT, url.split("?")[0].lstrip("/"))):
                    continue
                found.append((rel, title, url))
    return found


def backfill_thumbs():
    """Write a cover tile for each art-less entry and point the entry at it.

    The edit is line-local: only the url field of a matched entry gains a
    thumb next to it, so nothing else in an 11MB data file moves.
    """
    rows = missing_thumbs()
    if not rows:
        return 0
    by_file = {}
    for rel, title, url in rows:
        by_file.setdefault(rel, []).append((title, url))

    for rel, items in by_file.items():
        for title, _url in items:
            write_tile(title, guess_category(title),
                       os.path.join(ROOT, TILE_DIR, slug(title) + ".jpg"))
        path = os.path.join(ROOT, rel)
        with open(path, encoding="utf-8", errors="replace") as handle:
            text = handle.read()
        wanted = {url for _t, url in items}
        out = []
        for line in text.split("\n"):
            m = ENTRY_LINE.match(line)
            if m and not TILE_FIELD.search(line) and m.group(3) in wanted:
                title = m.group(2).strip()
                thumb = '/%s/%s.jpg' % (TILE_DIR, slug(title))
                needle = 'url: "%s"' % m.group(3)
                line = line.replace(
                    needle, needle + ', thumb: "%s"' % thumb, 1)
            out.append(line)
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write("\n".join(out))
    return len(rows)


def main():
    dry = "--dry-run" in sys.argv
    if "--thumbs" in sys.argv:
        rows = missing_thumbs()
        print("entries with no artwork: %d" % len(rows))
        for rel, title, url in rows:
            print("  %-18s %-42s %s" % (rel, title[:42], url))
        if dry:
            print("dry run: nothing written")
            return
        print("wrote %d tiles and pointed %d entries at them"
              % (backfill_thumbs(), len(rows)))
        return
    rows, dropped = scan()
    reasons = {}
    for _, why in dropped:
        reasons[why] = reasons.get(why, 0) + 1

    print("new games: %d" % len(rows))
    for why, count in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print("  skipped %-20s %d" % (why, count))
    if "--why" in sys.argv:
        wanted = sys.argv[sys.argv.index("--why") + 1] if len(sys.argv) > sys.argv.index("--why") + 1 else ""
        for rel, why in dropped:
            if why == wanted:
                print("    dropped %s" % rel)
        return
    for row in rows:
        print("  %7d KB  %-46s %s" % (row["size"] // 1024, row["title"][:46], row["file"]))

    if dry:
        print("dry run: nothing written")
        return

    for row in rows:
        write_tile(row["title"], guess_category(row["title"]),
                   os.path.join(ROOT, TILE_DIR, slug(row["title"]) + ".jpg"))
    out_path = os.path.join(ROOT, OUT)
    with open(out_path, "w", encoding="utf-8", newline="") as handle:
        handle.write(emit(rows))
    print("wrote %s and %d tiles in %s/" % (OUT, len(rows), TILE_DIR))


if __name__ == "__main__":
    main()
