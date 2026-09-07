"""Replace our seed thumbnails with Noah's-Calculus-Tutor artwork for every
game title that exists in BOTH catalogs (user: "theirs is better").

- Parses Noah's games.js (title -> images/<n>.jpg)
- Copies the matched images into assets/games/noah/ (self-hosted, not hotlinked)
- Patches src/games.js line-by-line (strictly line-preserving)
- Skips titles the user pinned to explicit art earlier
"""
import io, json, os, re, shutil, sys

NOAH = r"C:/Users/zeqrY/Downloads/Noahs-Calculus-Tutor-master/Noahs-Calculus-Tutor-master"
DRY = "--apply" not in sys.argv

SKIP = {
    "basket bros", "basketball stars", "the binding of isaac", "binding of isaac",
}

def norm(t):
    t = t.lower()
    for a, b in (("\u00e9", "e"), ("\u00e8", "e"), ("\u00fc", "u"), ("\u00f6", "o")):
        t = t.replace(a, b)
    return re.sub(r"[^a-z0-9]", "", t)

# ---- parse Noah's games.js ----
src = io.open(os.path.join(NOAH, "games.js"), encoding="utf-8").read()
noah_map = {}   # normalized title -> absolute image path
objs = re.findall(r"\{[^{}]*\}", src)
for ob in objs:
    mt = re.search(r'title:\s*"((?:[^"\\]|\\.)*)"', ob)
    mi = re.search(r'image:\s*"([^"]+)"', ob)
    if not (mt and mi):
        continue
    title = mt.group(1)
    m = re.search(r"/images/(\d+)\.(jpg|png|webp|jpeg)", mi.group(1))
    if not m:
        continue
    img = os.path.join(NOAH, "images", f"{m.group(1)}.{m.group(2)}")
    if os.path.exists(img):
        noah_map[norm(title)] = img
print(f"Noah catalog: {len(noah_map)} games with local images")

# ---- our seeds ----
s = io.open("src/games.js", encoding="utf-8").read()
lines = s.split("\n")
out, patched, skipped_skip, no_match = [], 0, 0, 0
seen_titles = {}
for idx, ln in enumerate(lines):
    mt = re.search(r'title:\s*"((?:[^"\\]|\\.)*)"', ln)
    mh = re.search(r'thumb:\s*"([^"]+)"', ln)
    if mt and mh and "title:" in ln and "thumb:" in ln:
        title = mt.group(1)
        nt = norm(title)
        if nt in SKIP:
            skipped_skip += 1
            out.append(ln)
            continue
        if nt in noah_map:
            src_img = noah_map[nt]
            dest = os.path.join("assets", "games", "noah", f"{nt}.jpg")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if not DRY:
                if not os.path.exists(dest):
                    shutil.copyfile(src_img, dest)
                newthumb = f'/{dest.replace(os.sep, "/")}'
                lines[idx] = re.sub(r'thumb:\s*"[^"]*"', f'thumb: "{newthumb}"', ln, count=1)
                patched += 1
                seen_titles.setdefault(title, newthumb)
                out.append(lines[idx])
                continue
            else:
                patched += 1
                out.append(ln)
                continue
    out.append(ln)

print(f"matchable shared titles in our seeds: {patched}")
if DRY:
    print("DRY RUN — rerun with --apply to write")
    sys.exit(0)

io.open("src/games.js", "w", encoding="utf-8", newline="").write("\n".join(lines))
print(f"APPLIED: {patched} thumbnails -> /assets/games/noah/<title>.jpg")
print("examples:")
for t, p in list(seen_titles.items())[:25]:
    print("   ", t, "->", p)
