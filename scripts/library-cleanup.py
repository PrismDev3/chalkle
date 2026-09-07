"""Chalkle library cleanup + thumbnail upgrade (v2, line-preserving).

Phase A: removals
  - seeds (src/games.js): junk entries still present
  - snapshot (sync.json -> chalkle-gamelib-v4): full junk list
  - Scratch-hosted games in both (scratch.mit.edu / turbowarp URLs, "(Scratch)" titles)
Phase B: thumbnails (STRICTLY line-preserving: every input line is either
  patched in place or kept verbatim - the file is never rebuilt from a subset)
  - SVG-placeholder entries with local real/ art -> retarget locally
  - SVG-placeholder entries without art -> verified CrazyGames search-API match,
    downloaded into assets/games/cg/ (exact normalized title match, lev<=2 fallback
    for len>8; anything else is SKIPPED, never guessed)
  - snapshot SVG entries patched from the same title->thumb map
"""
import json, re, io, os, sys, time, urllib.request, urllib.parse, difflib

DRY = "--apply" not in sys.argv
CG_API = "https://api.crazygames.com/v3/en_US/search?q={}&count=5"
CG_IMG = "https://imgs.crazygames.com/"
CACHE = {}
CACHE_FILE = "tmp-cg-thumb-cache.json"
if os.path.exists(CACHE_FILE):
    CACHE = json.load(io.open(CACHE_FILE, encoding="utf-8"))

def save_cache():
    json.dump(CACHE, io.open(CACHE_FILE, "w", encoding="utf-8"))

def norm(t):
    t = t.lower()
    t = t.replace("\u00e9", "e").replace("\u00e8", "e").replace("\u00fc", "u")
    return re.sub(r"[^a-z0-9]", "", t)

def http_get(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def cg_lookup(title):
    """Return (url, cgslug) for a verified CrazyGames match, else None."""
    key = title.lower().strip()
    if key in CACHE:
        return CACHE[key]
    q = urllib.parse.quote(key)
    out = None
    try:
        data = json.loads(http_get(CG_API.format(q)).decode("utf-8", "replace"))
        results = (data.get("result") or [])[:5]
        nt = norm(title)
        best = None
        for r in results:
            name = r.get("name") or ""
            nn = norm(name)
            if not nn:
                continue
            dist = difflib.SequenceMatcher(None, nt, nn).ratio()
            if nn == nt or (len(nt) > 8 and dist >= 0.93):
                if best is None or dist > best[0]:
                    best = (dist, r)
        if best:
            r = best[1]
            cover = r.get("cover") or (r.get("covers") or {}).get("16x9")
            if isinstance(cover, str) and cover:
                out = {"url": CG_IMG + cover, "slug": r.get("slug"), "name": r.get("name")}
    except Exception as e:
        out = {"error": str(e)[:80]}
    CACHE[key] = out
    return out

def dl_art(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 6000:
        return True
    try:
        sep = "&" if "?" in url else "?"
        b = http_get(url + sep + "metadata=none&quality=90&width=800&height=420&fit=crop")
        if len(b) < 6000 or (b[:3] not in (b"\xff\xd8\xff",) and b[:4] not in (b"RIFF",) and not b[:5].startswith(b"<?xml") and b[:4] != b"<svg"):
            return False
        io.open(dest, "wb").write(b)
        return True
    except Exception:
        return False

def slug_from_url(u):
    m = re.search(r"/ugs/([A-Za-z0-9_!() .'\-\[\]]+?)\.html", u)
    return m.group(1) if m else None

def local_real_art(slug):
    for ext in (".webp", ".jpg", ".png"):
        p = f"assets/games/real/{slug}{ext}"
        if os.path.exists(p):
            return p
    return None

# ---------------------------------------------------------------- Phase A
REMOVAL_URLS = {  # exact seed URLs to delete
    "/ugs/clarena.html", "/ugs/clbadbodyguards.html", "/ugs/clachievmentunlocked.html",
    "https://terrariamods-scratch.github.io/TerrariaStamped/embed/",
    "/ugs/clbuckshotroulette.html", "/ugs/clballz.html",
    "/ugs/clbearsus.html", "/ugs/cl2048cupcakes.html", "/ugs/cl1v1maybeidk.html",
    "/ugs/clnullkevin.html", "/ugs/clmotox3mm.html", "/ugs/clbntts.html",
    "/ugs/clallbossesin1.html", "/ugs/cl1v1.html",
    "/game-builds/flash/swf/amberial.swf", "/game-builds/flash/swf/13-days-in-hell.swf",
    "/game-builds/flash/swf/3D-Car-Driver.swf", "/game-builds/radon/html/agario-minigame/index.html",
    "/game-builds/three/1v1space/index.html", "/game-builds/asriel_fight/index.html",
}
# exact (lowercased) seed titles to delete regardless of URL
REMOVAL_TITLES = {
    "games -3", "games -b", "cat hear cake 3", "page title", "${pagetitle}",
    "maybeidk", "1 v 1 maybeidk", "10-103nk", "arsonaate", "admist the sky",
    "all boss 1", "2048 lite", "attogram", "ballz", "big neon tower vs tiny square",
    "big neon tower tiny square", "achievement unlocked", "1v1", "1v1.space",
}
def is_scratch(title, url):
    u = (url or "").lower()
    t = (title or "").lower()
    if "scratch.mit.edu" in u or "turbowarp.org" in u:
        return True
    if "(scratch)" in t or t.endswith(" scratch") or " scratch " in t:
        return True
    if "terrariamods-scratch" in u:
        return True
    return False

# ---- seeds (line-based; every line is kept unless it IS a removed entry) ----
seeds = io.open("src/games.js", encoding="utf-8").read()
lines = seeds.split("\n")
seed_lines, removed_seeds = [], []
for ln in lines:
    if "title:" in ln and "url:" in ln and "thumb:" in ln:
        m = re.search(r'url:\s*"([^"]+)"', ln)
        mt = re.search(r'title:\s*"((?:[^"\\]|\\.)*)"', ln)
        url = m.group(1) if m else ""
        title = mt.group(1) if mt else ""
        if url in REMOVAL_URLS or title.strip().lower() in REMOVAL_TITLES or "attogram" in title.lower() or is_scratch(title, url):
            removed_seeds.append((title, url))
            continue
    seed_lines.append(ln)
print(f"seeds: removing {len(removed_seeds)} of {len(lines)} lines")
for t, u in removed_seeds:
    print("   DEL:", t, "->", u)

# ---- snapshot (tolerant: the key may legitimately be absent) ----
snap = json.load(io.open("sync.json", encoding="utf-8"))
lib = None
if isinstance(snap.get("chalkle-gamelib-v4"), str):
    lib = json.loads(snap["chalkle-gamelib-v4"])
if lib is None:
    print("snapshot: no chalkle-gamelib-v4 on disk - clients rebuild from clean seeds (skipping snapshot phase)")
    keep, removed_snap = [], []
else:
    SNAP_DEL_TITLES = {
    "asriel dreemurr fight", "achievement unlocked", "big neon tower tiny square",
    "big neon tower vs tiny square", "amberial", "13 days in hell", "3d car driver",
    "agario minigame", "1v1.space", "1 v 1 maybeidk", "2048 cupcakes",
        "achievmentunlocked", "all boss 1", "arena", "guard", "ballz | unblocked on ccported",
        "bearsus", "${pagetitle}", "10-103nk",
    }
    keep, removed_snap = [], []
    for g in lib:
        t = (g.get("title") or "").strip()
        u = str(g.get("url") or "")
        if t.lower() in SNAP_DEL_TITLES or is_scratch(t, u):
            removed_snap.append((t, u))
            continue
        keep.append(g)
    print(f"snapshot: {len(lib)} -> {len(keep)} (removing {len(removed_snap)})")
    for t, u in removed_snap:
        print("   DEL:", t, "->", u[:70])

# ---------------------------------------------------------------- Phase B (line-preserving)
title_map = {}   # normalized title -> new thumb path
cg_dir = "assets/games/cg"
os.makedirs(cg_dir, exist_ok=True)
fixed_local, fixed_cg, kept_svg = 0, 0, 0
out_lines = []
for ln in seed_lines:
    if "thumb:" not in ln or 'thumb: "data:image/svg' not in ln:
        out_lines.append(ln)
        continue
    mu = re.search(r'url:\s*"([^"]+)"', ln)
    mt = re.search(r'title:\s*"((?:[^"\\]|\\.)*)"', ln)
    title = mt.group(1) if mt else ""
    url = mu.group(1) if mu else ""
    slug = slug_from_url(url)
    art = local_real_art(slug) if slug else None
    if art:
        out_lines.append(re.sub(r'thumb:\s*"data:image/svg[^"]*"', f'thumb: "/{art.replace(os.sep, "/")}"', ln, count=1))
        title_map[norm(title)] = "/" + art.replace(os.sep, "/")
        fixed_local += 1
        continue
    hit = cg_lookup(title)
    if hit and hit.get("url"):
        dest = os.path.join(cg_dir, f"{hit['slug']}.jpg")
        if dl_art(hit["url"], dest):
            path = f"/assets/games/cg/{hit['slug']}.jpg"
            out_lines.append(re.sub(r'thumb:\s*"data:image/svg[^"]*"', f'thumb: "{path}"', ln, count=1))
            title_map[norm(title)] = path
            fixed_cg += 1
            print(f"   CG: {title} -> {hit['name']}")
            time.sleep(0.1)
            continue
    out_lines.append(ln)
    kept_svg += 1
    time.sleep(0.1)
seeds_new = "\n".join(out_lines)
print(f"thumbnails: {fixed_local} local art, {fixed_cg} CrazyGames art, {kept_svg} kept as fallback")
print(f"line count: {len(lines)} -> {len(out_lines)} (must match removals only: {len(removed_seeds)})")
assert len(out_lines) == len(lines) - len(removed_seeds), "LINE COUNT MISMATCH - aborting"
for t, u in []:
    pass

# snapshot SVG patches via title map
snap_patched = 0
for g in keep:
    th = str(g.get("thumb") or "")
    if th.startswith("data:image/svg"):
        newt = title_map.get(norm(g.get("title") or ""))
        if newt:
            g["thumb"] = newt
            snap_patched += 1
print(f"snapshot thumbnails patched from map: {snap_patched}")

save_cache()

if DRY:
    print("\nDRY RUN — rerun with --apply to write changes")
    sys.exit(0)

io.open("src/games.js", "w", encoding="utf-8", newline="\n").write(seeds_new)
if lib is not None:
    snap["chalkle-gamelib-v4"] = json.dumps(keep, separators=(",", ":"), ensure_ascii=False)
json.dump(snap, io.open("sync.json", "w", encoding="utf-8"), ensure_ascii=False)
print("\nAPPLIED: src/games.js + sync.json written")
