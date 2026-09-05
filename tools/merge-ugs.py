#!/usr/bin/env python3
"""Merge the UGS HTML game wrappers into src/games.js.

- Swaps matched games (external + gn URLs) to local /ugs/<file> wrappers so
  they load from our origin instead of blocked hosts.
- Adds games we don't have yet, with cleaned titles, guessed categories and
  generated SVG data-URI thumbs (same style as the MC_T_/P_T_ constants).
- game-builds entries are kept as-is: they are already fully self-hosted,
  which is the most unblocked state possible.

Usage: python tools/merge-ugs.py
"""

import base64
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAMES_JS = os.path.join(ROOT, "src", "games.js")
UGS_DIR = os.path.join(ROOT, "ugs")
PLAN = "/tmp/merge-final.json"  # swaps/adds from the survey step

# ---------------------------------------------------------------------------
# title cleaning + filename decoding
# ---------------------------------------------------------------------------

def clean_title(t):
    t = re.sub(r"^Unity WebGL Player\s*[|:]\s*", "", t.strip())
    t = re.sub(r"^Unity\s*$", "", t, flags=re.I)
    t = re.sub(r"\s*-\s*(?:GNHUSTGames|Play Online|Unblocked.*|Unblocked)$", "", t, flags=re.I)
    t = re.sub(r"\s*\|\s*(?:Seraph|Fandom|Wiki)\s*$", "", t, flags=re.I)
    t = re.sub(r"\s*\([^)]*\)\s*$", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    # junk titles: these say nothing about the game
    junk = re.compile(
        r"^(really cool flash|google|google\.com|game :?d|html index|flash|play|"
        r"new tab|untitled|my app|index|loading|just a moment|about blank)$",
        re.I,
    )
    if junk.match(t) or len(t) < 2:
        return ""
    return t

KNOWN = {
    "lol": "LOL", "fnf": "FNF", "gba": "GBA", "gbc": "GBC", "nes": "NES",
    "snes": "SNES", "n64": "N64", "3d": "3D", "2d": "2D", "rpg": "RPG",
    "pvp": "PVP", "io": "IO", "idle": "Idle", "vs": "vs", "osu": "OSU",
    "gta": "GTA", "cod": "COD", "ff": "FF", "mario": "Mario", "sonic": "Sonic",
    "zelda": "Zelda", "doom": "Doom", "quake": "Quake", "minecraft": "Minecraft",
    "the": "The", "of": "of", "and": "and", "in": "in", "on": "on", "a": "A",
    "bob": "Bob", "papas": "Papa's", "sans": "Sans", "undertale": "Undertale",
    "friday": "Friday", "night": "Night", "funkin": "Funkin",
    # common run-on parts worth splitting
    "run": "Run", "runner": "Runner", "dash": "Dash", "jump": "Jump",
    "parkour": "Parkour", "slope": "Slope", "geometry": "Geometry",
    "tennis": "Tennis", "soccer": "Soccer", "football": "Football",
    "basket": "Basket", "baseball": "Baseball", "golf": "Golf", "bowl": "Bowl",
    "hockey": "Hockey", "volley": "Volley", "race": "Race", "racing": "Racing",
    "car": "Car", "kart": "Kart", "moto": "Moto", "bike": "Bike", "drift": "Drift",
    "tower": "Tower", "defense": "Defense", "strategy": "Strategy", "war": "War",
    "army": "Army", "siege": "Siege", "battle": "Battle", "royale": "Royale",
    "fight": "Fight", "fighter": "Fighter", "combat": "Combat", "boxing": "Boxing",
    "smash": "Smash", "brawl": "Brawl", "arena": "Arena", "duel": "Duel",
    "puzzle": "Puzzle", "match": "Match", "merge": "Merge", "2048": "2048",
    "logic": "Logic", "word": "Word", "sudoku": "Sudoku", "connect": "Connect",
    "idle": "Idle", "clicker": "Clicker", "tycoon": "Tycoon", "sim": "Sim",
    "city": "City", "life": "Life", "planet": "Planet", "sandbox": "Sandbox",
    "builder": "Builder", "craft": "Craft", "world": "World", "adventure": "Adventure",
    "quest": "Quest", "dungeon": "Dungeon", "story": "Story", "zombie": "Zombie",
    "horror": "Horror", "fnaf": "FNAF", "five": "Five", "nights": "Nights",
    "granny": "Granny", "scary": "Scary", "backrooms": "Backrooms",
    "survive": "Survive", "survival": "Survival", "shoot": "Shoot", "shooter": "Shooter",
    "gun": "Gun", "fps": "FPS", "bullet": "Bullet", "sniper": "Sniper",
    "space": "Space", "alien": "Alien", "invader": "Invader", "galaxy": "Galaxy",
    "angry": "Angry", "birds": "Birds", "slither": "Slither", "snake": "Snake",
    "flappy": "Flappy", "bird": "Bird", "cube": "Cube", "cube2": "Cube 2",
    "retro": "Retro", "arcade": "Arcade", "classic": "Classic", "remaster": "Remaster",
    "turbo": "Turbo", "drift": "Drift", "offroad": "Offroad", "rally": "Rally",
    "ultimate": "Ultimate", "legends": "Legends", "chronicles": "Chronicles",
    "kart": "Kart", "grand": "Grand", "prix": "Prix", "super": "Super",
}

# common lowercase word fragments to segment glued names: acecombat -> Ace Combat
SEG_WORDS = [
    "ace", "combat", "alien", "hominid", "another", "world", "advance", "wars",
    "achievement", "unlocked", "animal", "crossing", "wild", "banjo", "kazooie",
    "tooie", "basket", "slam", "dunk", "bob", "robber", "bomber", "backyard",
    "baseball", "football", "soccer", "ben", "protector", "omniverse", "ultimate",
    "big", "tower", "tiny", "square", "bit", "block", "craft", "parkour", "shooter",
    "bloody", "tournament", "bottle", "flip", "bouncy", "motors", "brain", "rot",
    "bullet", "battle", "burger", "cake", "capybara", "cat", "mario", "cave",
    "chicken", "gun", "classroom", "clicker", "club", "cookie", "crossy", "road",
    "cubefield", "cyber", "sensation", "dead", "cells", "death", "dice", "dino",
    "dogeminer", "doge", "miner", "donald", "duck", "life", "doodle", "jump",
    "drag", "racing", "drift", "hunters", "merge", "dunk", "earth", "escape",
    "road", "truck", "fireboy", "watergirl", "five", "nights", "freddy", "friday",
    "funkin", "fruit", "ninja", "garden", "gnome", "geometry", "dash", "golf",
    "goofy", "goose", "grand", "theft", "auto", "granny", "gym", "stack", "gta",
    "happy", "wheels", "helicopter", "hell", "hobo", "hole", "human", "fall",
    "icy", "tower", "idle", "impossible", "indestructo", "tank", "jetpack", "joyride",
    "jump", "king", "knight", "learn", "fly", "little", "runmo", "madalin",
    "stunt", "cars", "mario", "kart", "master", "chef", "metro", "surfer", "minibattles",
    "monkey", "mart", "motorbike", "moto", "x3m", "nba", "ninja", "paper", "io",
    "parking", "fury", "pet", "clicker", "piano", "tiles", "piano", "plane", "flying",
    "plants", "zombies", "pokemon", "poly", "branch", "pool", "puzzle", "raccoon",
    "retro", "bowl", "rocket", "league", "run", "roller", "ball", "sandwich",
    "stack", "santa", "run", "shell", "shock", "ski", "slope", "smash", "karts",
    "snake", "soccer", "spin", "stab", "steal", "stickman", "strange", "tower",
    "subway", "surfers", "tank", "trouble", "tap", "tiles", "temple", "run",
    "tennis", "the", "battle", "thumb", "fighter", "tomb", "tower", "defense",
    "traffic", "turbo", "racer", "ultimate", "flappy", "bird", "volley", "random",
    "wheelie", "bike", "world", "cup", "wrestling", "zombie", "caliber", "contract",
    "skibidi", "toilet", "squid", "game", "quiz", "candy", "crush", "stacky",
    "castlevania", "chrono", "trigger", "chips", "challenge", "cannon", "fodder",
    "bushido", "blade", "akuma", "no", "rgaiden", "arceus", "legend", "captain",
    "lang", "cod", "defiance", "dbz", "attacks", "saiyans", "cellar", "door",
    "another", "hoysurvival", "agario", "lite", "apotris", "archery", "tour",
    "bomberman", "bully", "basketball", "battlefield", "bayonetta", "beatbox",
    "bendy", "ink", "machine", "bloxorz", "bounce", "bread", "bricks", "breaker",
    "bubble", "shooter", "bullet", "force", "burger", "frights", "bush", "cactuar",
    "cake", "mania", "call", "duty", "camper", "clicker", "candycrush", "carrion",
    "carve", "castle", "bloodline", "circle", "moon", "cave", "story", "chambers",
    "chicken", "invaders", "chip", "chopper", "chuck", "city", "builder", "clash",
    "cliffs", "diver", "club", "codename", "coloring", "combat", "combo", "run",
    "cook", "burger", "counter", "strike", "cowboy", "crab", "crash", "bandicoot",
    "crazy", "cars", "crewmate", "crimson", "cross", "crush", "cube", "surf",
    "cuphead", "custom", "grove", "cut", "rope", "cycle", "dancing", "lines",
    "dave", "diver", "day", "survivor", "deepest", "delve", "deltarune", "demon",
    "hunter", "destiny", "devil", "among", "us", "dicey", "dungeons", "dig",
    "dino", "disc", "dive", "dock", "dominoes", "donut", "doodle", "god",
    "doors", "double", "downwell", "dr", "robotnik", "dragons", "dog", "simulator",
    "drift", "boss", "drop", "dungeon", "keeper", "dunk", "shot", "dynamite",
    "earthbound", "edgardo", "egg", "inc", "elasto", "mania", "electro", "dancer",
    "elemental", "war", "endless", "truck", "energy", "chains", "epic", "battle",
    "fantasy", "escape", "mansion", "eternal", "castle", "evil", "cow", "exam",
    "exo", "explosion", "fairy", "falling", "fruit", "farmer", "fast", "fingers",
    "fetch", "fighting", "fantasy", "final", "fantasy", "fishing", "flappy",
    "flaming", "zombie", "flashpoint", "flip", "runners", "flood", "fly", "orca",
    "fortress", "fossil", "hunter", "friday", "night", "funkin", "frogger",
    "frost", "biter", "fullscreen", "mario", "fusion", "galaga", "galactic",
    "gallery", "gambling", "gang", "beasts", "garage", "garten", "banban",
    "ghost", "hunter", "gigabyte", "gimkit", "gladiators", "glitch", "godzilla",
    "golden", "axe", "goofy", "hoops", "goose", "goosebumps", "gorilla", "tag",
    "grandmaster", "gravity", "portal", "great", "sword", "guitar", "hero",
    "gunblood", "gungeon", "hack", "slash", "halloween", "happy", "hills",
    "harvest", "moon", "haunted", "hellish", "quartz", "hex", "highway", "racer",
    "hill", "climb", "hollow", "knight", "home", "sweet", "homes", "honey", "comb",
    "hotline", "miami", "hungry", "shark", "hyper", "casual", "ice", "cream",
    "idlebreakout", "impulse", "incredibox", "india", "game", "infinite", "craft",
    "insect", "invaders", "iron", "snout", "island", "builder", "jacksmith",
    "jet", "pack", "joyride", "juggle", "jump", "king", "kart", "kids", "racing",
    "killer", "konami", "kung", "fu", "la", "multiplica", "lava", "legend",
    "legendary", "dice", "lemonade", "stand", "level", "devil", "life", "island",
    "lights", "out", "link", "little", "alchemy", "lobotomy", "corporation",
    "lonely", "moon", "look", "your", "body", "love", "letter", "ludo", "king",
    "lumber", "jack", "machine", "gun", "mad", "city", "magic", "pen", "magnetic",
    "man", "town", "mansion", "marble", "blast", "marine", "empire", "mario",
    "party", "matchington", "mansion", "matthew", "mcdonald", "meatboy", "mech",
    "arena", "medieval", "merge", "masters", "meteor", "shower", "metro", "surfer",
    "mike", "tyson", "millionaire", "mind", "reader", "mine", "crawler", "miner",
    "mini", "motorways", "minesweeper", "mob", "control", "modern", "tanks",
    "mole", "hunt", "monopoly", "monster", "truck", "moto", "cross", "motor",
    "bike", "mountain", "bike", "mouse", "trap", "mummy", "museum", "music",
    "racer", "my", "friend", "pedro", "naruto", "basket", "naval", "combat",
    "neon", "racer", "nest", "never", "grave", "nfs", "nightmare", "foxy",
    "ninja", "fruit", "nuclear", "nuke", "number", "munchers", "octopus", "garden",
    "off", "road", "olofmeister", "one", "armed", "cookie", "onion", "opentycoon",
    "orbito", "origins", "outlast", "outpost", "owlboy", "pac", "man", "paddle",
    "parking", "passive", "pokemon", "papa", "paradise", "parasite", "city",
    "penguin", "diner", "penny", "trouble", "pepper", "petals", "phase", "phigros",
    "pickle", "pigeon", "pilot", "pinball", "pink", "tower", "pixel", "gun",
    "planet", "clicker", "plasma", "burst", "platform", "racing", "plumber",
    "pocket", "tanks", "poly", "battle", "pony", "pool", "blitz", "pop", "tropical",
    "portal", "potion", "punch", "power", "puppet", "master", "pure", "puzzle",
    "quest", "raccoon", "retro", "bowl", "radiator", "ragdoll", "ragnarok",
    "rainbow", "rage", "rampage", "random", "legend", "rapidfire", "recoil", "realm",
    "royale", "red", "ball", "reflex", "dodgeball", "rescue", "retro", "drive",
    "revenge", "io", "riddle", "school", "right", "road", "blocks", "robber",
    "rocket", "royale", "rooftop", "snipers", "room", "escape", "ropes", "royale",
    "rubik", "cube", "run", "marathon", "russian", "roulette", "sabotage", "samurai",
    "sausage", "flip", "schoolboy", "runaway", "scrap", "metal", "sea", "of",
    "thieves", "secret", "of", "mana", "shadow", "fight", "shell", "shock", "shredder",
    "shuffle", "shrek", "shuttle", "sicko", "silver", "surfer", "siren", "head",
    "skeleton", "skibidi", "sky", "carnival", "skybound", "slam", "dunk", "slenderman",
    "slime", "rancher", "sling", "drift", "small", "planes", "smash", "karts",
    "snake", "vs", "snow", "rider", "soccer", "physics", "sokoban", "solitaire",
    "spacebar", "clicker", "spelunky", "spider", "fighter", "spiral", "rollercoaster",
    "splix", "sploder", "stacky", "dash", "stair", "race", "stampede", "standoff",
    "stardew", "valley", "stick", "war", "strike", "subway", "surfers", "sugar",
    "rush", "superhot", "supermario", "surviv", "io", "swingo", "sword", "souls",
    "tabs", "tactics", "tamagotchi", "tank", "warfare", "tap", "titans", "teacher",
    "terror", "the", "isle", "three", "cheers", "throwback", "thumper", "tiger",
    "time", "shooter", "tiny", "tanks", "titanic", "toilet", "tower", "defense",
    "town", "scaper", "toxic", "toy", "tank", "trap", "adventure", "trials", "fusion",
    "tricky", "trip", "trouble", "turbo", "dismount", "turtle", "twins", "ultra",
    "uphill", "rush", "urban", "jungle", "vampire", "survivor", "venge", "io",
    "vex", "viper", "virtual", "soccer", "visionary", "void", "walker", "volley",
    "battle", "wacky", "run", "warship", "craft", "watermelon", "game", "web", "glue",
    "webretro", "whack", "your", "boss", "whiteout", "wild", "west", "windy", "woods",
    "winter", "clash", "wobbly", "life", "wolfenstein", "wordle", "worlds", "hardest",
    "wrestling", "revolution", "xenon", "riders", "yahtzee", "yandere", "simulator",
    "yeti", "hunt", "yume", "nikki", "zero", "point", "zombie", "canyon", "zoom",
]

# Build a much larger segmentation dictionary from the site's own game
# titles + the UGS source titles, so real game names (Castlevania, Bomberman,
# Battlezone ...) split correctly instead of falling back to single letters.
_SEG_EXTRA = set()
if os.path.isfile(GAMES_JS):
    _seg_src = open(GAMES_JS, encoding="utf-8", errors="replace").read()
    for _t in re.findall(r'title:\s*"([^"]+)"', _seg_src):
        for _w in re.findall(r"[a-z']{3,}", _t.lower()):
            _SEG_EXTRA.add(_w.strip("'"))
if os.path.isdir(UGS_DIR):
    for _f in os.listdir(UGS_DIR):
        if not _f.endswith(".html"):
            continue
        try:
            _head = open(os.path.join(UGS_DIR, _f), encoding="utf-8", errors="replace").read(4000)
        except Exception:
            continue
        _t = re.search(r"<title[^>]*>([^<]+)</title>", _head, re.I | re.S)
        if _t:
            for _w in re.findall(r"[a-z']{3,}", _t.group(1).lower()):
                _SEG_EXTRA.add(_w.strip("'"))
# drop glue words that are really two words run together in the source (rare)
SEG_WORDS = sorted(set(SEG_WORDS) | {w for w in _SEG_EXTRA if len(w) >= 3 and len(w) <= 14}, key=len, reverse=True)


def _segment(glued):
    """Split a glued lowercase word into known fragments using DP.

    Maximizes the number of known-word parts (so "advancewars" splits into
    "advance wars" even when "advancewars" itself is a dict token) and leaves
    single letters for characters no dictionary word can cover.
    """
    n = len(glued)
    # dp[i] = (known_word_count, parts) for glued[i:]
    memo = {}
    def solve(i):
        if i >= n:
            return (0, [])
        if i in memo:
            return memo[i]
        best = None
        for w in SEG_WORDS:
            if glued.startswith(w, i):
                cnt, rest = solve(i + len(w))
                cand = (1 + cnt, [w] + rest)
                if best is None or cand[0] > best[0] or (
                    cand[0] == best[0] and len(cand[1]) < len(best[1])
                ):
                    best = cand
        # fallback: single char
        cnt, rest = solve(i + 1)
        cand = (cnt, [glued[i]] + rest)
        if best is None or cand[0] > best[0] or (
            cand[0] == best[0] and len(cand[1]) < len(best[1])
        ):
            best = cand
        memo[i] = best
        return best
    return solve(0)[1]


def decode_name(fname):
    """Turn a UGS filename (cl1on1tennis.html) into a clean title."""
    s = fname[:-5] if fname.endswith(".html") else fname
    s = re.sub(r"^cl", "", s, flags=re.I)
    # separate digits glued to words: 1on1 -> 1 on 1, 60secondssantarun
    s = re.sub(r"(?<=\d)(?=[a-z])", " ", s, flags=re.I)
    s = re.sub(r"(?<=[a-z])(?=\d)", " ", s, flags=re.I)
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s, flags=re.I)
    words = [w for w in s.split() if w]
    if not words:
        return ""
    out = []
    for w in words:
        wl = w.lower()
        if wl in KNOWN:
            out.append(KNOWN[wl])
        elif w.isdigit():
            out.append(w)
        elif len(wl) > 5 and wl not in {"aaindex"}:
            # segment glued lowercase runs (acecombat -> Ace Combat)
            parts = _segment(wl)
            # only trust segmentation when it found real words (>=2 letters)
            long_parts = [p for p in parts if len(p) > 1]
            if len(long_parts) > 1:
                cap = []
                for p in parts:
                    if len(p) <= 1:
                        continue
                    cap.append(KNOWN[p] if p in KNOWN else (p.upper() if len(p) <= 3 else p[0].upper() + p[1:]))
                out.append(" ".join(cap))
            else:
                out.append(w[0].upper() + w[1:])
        else:
            out.append(w[0].upper() + w[1:])
    return " ".join(out)

# ---------------------------------------------------------------------------
# category guessing
# ---------------------------------------------------------------------------

def guess_category(title):
    t = title.lower()
    rules = [
        (r"fnf|friday night|funkin|beat|dance|guitar|piano|osu|rhythm", "Rhythm"),
        (r"mario|sonic|minecraft|doom|quake|zelda|metroid|pac|tetris|pokemon", "Retro"),
        (r"race|racing|car|kart|drift|moto|bike|wheels|turbo", "Racing"),
        (r"basket|soccer|football|tennis|golf|bowl|sport|hockey|baseball|volley", "Sports"),
        (r"zombie|horror|fnaf|five nights|granny|scary|backrooms|nightmare", "Horror"),
        (r"puzzle|match|2048|merge|logic|word|sudoku|connect|block", "Puzzle"),
        (r"defense|tower|strategy|war|army|siege", "Tower Defense"),
        (r"idle|clicker|tycoon|incremental", "Idle"),
        (r"sim|city|life|planet|evolution|manage", "Simulation"),
        (r"sandbox|builder|craft|world|universe", "Sandbox"),
        (r"rpg|adventure|quest|dungeon|story", "RPG"),
        (r"run|runner|jump|parkour|dash|slope|geometry", "Runner"),
        (r"fight|fighter|brawl|combat|smash|boxing|battle", "Action"),
        (r"survive|survival|shoot|gun|fps|bullet|sniper", "Action"),
        (r"io$|multi|online|among|fall guys", "Multiplayer"),
    ]
    for pat, cat in rules:
        if re.search(pat, t):
            return cat
    return "Arcade"

# ---------------------------------------------------------------------------
# thumb generation: 640x360 SVG card, flat colors + title (no CSS gradients)
# ---------------------------------------------------------------------------

def svg_thumb(title):
    import hashlib
    h = hashlib.md5(title.encode()).digest()
    bg = "#%02x%02x%02x" % (20 + h[0] % 40, 24 + h[1] % 44, 40 + h[2] % 60)
    accent = "#%02x%02x%02x" % (120 + h[3] % 90, 150 + h[4] % 60, 255 - h[5] % 70)
    # split title for two lines
    words = title.split()
    line1 = " ".join(words[: len(words) // 2]) if len(words) > 2 else title
    line2 = " ".join(words[len(words) // 2 :]) if len(words) > 2 else ""
    esc = (
        lambda s: s.replace("&", "%26").replace("#", "%23")
        .replace("'", "%27").replace('"', "%22")
        .replace("<", "%3C").replace(">", "%3E")
    )
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" '
        'viewBox="0 0 640 360">'
        '<rect width="640" height="360" fill="%(bg)s"/>'
        '<g stroke="rgba(255,255,255,0.06)" stroke-width="1">'
        '<path d="M0 180H640M160 0V360M320 0V360M480 0V360"/></g>'
        '<rect x="0" y="252" width="640" height="6" fill="%(accent)s" opacity="0.85"/>'
        '<text x="320" y="150" text-anchor="middle" font-family="Arial Black,'
        'sans-serif" font-size="40" font-weight="900" fill="#fff" '
        'paint-order="stroke fill" stroke="rgba(0,0,0,0.35)" stroke-width="4">'
        '%(line1)s</text>'
        '%(line2)s'
        '<text x="320" y="330" text-anchor="middle" font-family="Arial,'
        'sans-serif" font-size="20" font-weight="700" fill="%(accent)s" '
        'letter-spacing="4">PLAY</text>'
        "</svg>"
    ) % {
        "bg": bg,
        "accent": accent,
        "line1": esc(line1),
        "line2": (
            '<text x="320" y="200" text-anchor="middle" font-family="Arial Black,'
            'sans-serif" font-size="32" font-weight="900" fill="#fff" '
            'paint-order="stroke fill" stroke="rgba(0,0,0,0.35)" stroke-width="4">'
            + esc(line2)
            + "</text>"
        )
        if line2
        else "",
    }
    import urllib.parse
    return "data:image/svg+xml," + urllib.parse.quote(svg, safe="")

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    plan = json.load(open(PLAN, encoding="utf-8"))
    swaps = plan["swaps"]  # [file, our_title, rule]
    adds = plan["adds"]    # [file, source_title, 'title'|'file']

    # load our games
    src = open(GAMES_JS, encoding="utf-8").read()
    header = src[: src.index("window.ChalkGames = [") + len("window.ChalkGames = [")]
    tail = src[src.index("];") :]
    body = src[len(header) : src.index("];")]
    lines = body.split("\n")

    our_by_title = {}
    for ln in lines:
        m = re.search(r'title:\s*"([^"]+)"', ln)
        if m:
            our_by_title.setdefault(m.group(1), ln)

    out_lines = []
    swapped = []
    kept = []
    for ln in lines:
        m = re.search(r'title:\s*"([^"]+)"', ln)
        if not m:
            out_lines.append(ln)
            continue
        title = m.group(1)
        hit = next((s for s in swaps if s[1] == title), None)
        if not hit:
            out_lines.append(ln)
            continue
        ugs_file = hit[0]
        if not os.path.isfile(os.path.join(UGS_DIR, ugs_file)):
            out_lines.append(ln)
            continue
        # game-builds stay: already fully self-hosted (most unblocked)
        if '/game-builds/' in ln:
            kept.append((title, ugs_file))
            out_lines.append(ln)
            continue
        new_ln = re.sub(r'url:\s*"[^"]*"', 'url: "/ugs/%s"' % ugs_file, ln)
        # ensure category present
        if 'category:' not in new_ln:
            new_ln = new_ln.replace("},", ', category: "%s" },' % guess_category(title))
        out_lines.append(new_ln)
        swapped.append((title, ugs_file))

    # add new games (skip titles that already exist)
    existing = set(our_by_title.keys())
    seen = set(existing)
    added = []
    for f, stitle, kind in adds:
        title = clean_title(stitle) if kind == "title" else stitle
        if not title or title in seen:
            continue
        # skip titles that are pure numbers or single-letter junk
        if re.fullmatch(r"[0-9a-zA-Z]{1,2}", title) or re.fullmatch(r"[0-9]{1,3}", title):
            continue
        seen.add(title)
        # liveness guard: only add files whose first host is reachable
        if not os.path.isfile(os.path.join(UGS_DIR, f)):
            continue
        cat = guess_category(title)
        thumb = svg_thumb(title)
        line = '  { title: "%s", url: "/ugs/%s", category: "%s", thumb: "%s" },' % (
            title.replace('"', "\\\""),
            f,
            cat,
            thumb,
        )
        out_lines.append(line)
        added.append((title, f))

    new_body = "\n".join(out_lines).rstrip() + "\n\n"
    open(GAMES_JS, "w", encoding="utf-8", newline="").write(header + new_body + tail)

    print("swapped:", len(swapped))
    print("kept game-builds:", len(kept))
    print("added new:", len(added))
    with open(os.path.join(ROOT, "merge-report.json"), "w", encoding="utf-8") as fh:
        json.dump({"swapped": swapped, "kept": kept, "added": added}, fh, indent=0)

if __name__ == "__main__":
    main()