"""Second pass for SVG-placeholder entries the strict matcher skipped.
Loosened (still safe) matching: cleaned query, prefix match, higher fuzz for
long titles. Every accepted hit is still a CrazyGames catalog entry whose
name plausibly IS the game - no cross-title guessing."""
import json, re, io, os, sys, time, urllib.request, urllib.parse, difflib

DRY = "--apply" not in sys.argv
CACHE_FILE = "tmp-cg-thumb-cache.json"
CACHE = json.load(io.open(CACHE_FILE, encoding="utf-8")) if os.path.exists(CACHE_FILE) else {}

FILLER = {"good", "unblocked", "poki", "online", "free", "game", "games", "io", "2 good", "new"}
VERSIONY = re.compile(r"\b(v\d+(\.\d+)*)\b", re.I)

def norm(t):
    t = t.lower().replace("\u00e9", "e").replace("\u00e8", "e").replace("\u00fc", "u")
    return re.sub(r"[^a-z0-9]", "", t)

def clean_query(t):
    words = [w for w in re.split(r"\s+", t) if w.lower() not in FILLER]
    q = " ".join(words) if words else t
    q = VERSIONY.sub("", q).strip()
    return q

def http_get(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def cg_lookup2(title):
    key = "p2:" + title.lower().strip()
    if key in CACHE:
        return CACHE[key]
    out = None
    q = clean_query(title) or title
    nt = norm(title)
    try:
        data = json.loads(http_get("https://api.crazygames.com/v3/en_US/search?q=" + urllib.parse.quote(q) + "&count=6").decode("utf-8", "replace"))
        best = None
        for r in (data.get("result") or [])[:6]:
            nn = norm(r.get("name") or "")
            if not nn:
                continue
            dist = difflib.SequenceMatcher(None, nt, nn).ratio()
            ok = (
                nn == nt
                or (len(nt) >= 8 and (nn.startswith(nt) or nt.startswith(nn)))
                or (len(nt) >= 12 and dist >= 0.88)
            )
            if ok and (best is None or dist > best[0]):
                best = (dist, r)
        if best:
            r = best[1]
            cover = r.get("cover") or (r.get("covers") or {}).get("16x9")
            if isinstance(cover, str) and cover:
                out = {"url": "https://imgs.crazygames.com/" + cover, "slug": r.get("slug"), "name": r.get("name")}
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
        if len(b) < 6000 or b[:3] != b"\xff\xd8\xff":
            return False
        io.open(dest, "wb").write(b)
        return True
    except Exception:
        return False

s = io.open("src/games.js", encoding="utf-8").read()
objs = re.findall(r"\{[^{}]*\}", s)
cg_dir = "assets/games/cg"
os.makedirs(cg_dir, exist_ok=True)
fixed, skipped = 0, 0
for ob in objs:
    mh = re.search(r'thumb:\s*"(data:image/svg[^"]*)"', ob)
    mt = re.search(r'title:\s*"((?:[^"\\]|\\.)*)"', ob)
    if not (mh and mt):
        continue
    title = mt.group(1)
    hit = cg_lookup2(title)
    time.sleep(0.12)
    if hit and hit.get("url"):
        dest = os.path.join(cg_dir, f"{hit['slug']}.jpg")
        if dl_art(hit["url"], dest):
            path = f"/assets/games/cg/{hit['slug']}.jpg"
            ns = s.replace(f'thumb: "{mh.group(1)}"', f'thumb: "{path}"', 1) if f'thumb: "{mh.group(1)}"' in s else re.sub(r'thumb:\s*"data:image/svg[^"]*"', f'thumb: "{path}"', s, count=1)
            if ns != s:
                s = ns
                fixed += 1
                print(f"   CG2: {title} -> {hit['name']}")
                continue
    skipped += 1
print(f"pass2: fixed {fixed}, still skipped {skipped}")
io.open(CACHE_FILE, "w", encoding="utf-8").write(json.dumps(CACHE))
if DRY:
    print("DRY RUN — rerun with --apply to write")
    sys.exit(0)
io.open("src/games.js", "w", encoding="utf-8", newline="\n").write(s)
print("APPLIED")
