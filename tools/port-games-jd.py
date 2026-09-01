#!/usr/bin/env python3
"""Port games from jsDelivr into game-builds/ for self-hosting.

jsDelivr serves an HTML directory listing at
https://cdn.jsdelivr.net/gh/<user>/<repo>@<ref>/<dir>/
We walk those listings (and the /<dir>/flat/ trick for inner dirs) and
download every file with correct MIME types, so the game runs fully from our
own server. No GitHub API, so no rate limits.

Usage:
    python tools/port-games-jd.py basketbattle bubbls/youtube-playables@main basket-battle
"""

import html
import os
import re
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "game-builds")
BASE = "https://cdn.jsdelivr.net/gh"
UA = {"User-Agent": "Mozilla/5.0 (chalkle-port)"}


def fetch(url, binary=False):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read() if binary else r.read().decode("utf-8", errors="replace")


def list_dir(url):
    """Return {name: (is_dir, href)} from a jsDelivr HTML listing."""
    try:
        body = fetch(url)
    except Exception as e:
        print(f"  !! listing {url}: {e}")
        return {}
    out = {}
    # jsDelivr listing rows: <a href="...">name</a> <td ...>size</td>
    for m in re.finditer(r'<a href="([^"]+)"[^>]*>\s*([^<]+?)\s*</a>', body):
        href, name = m.group(1), html.unescape(m.group(2)).strip()
        if name in (".", "..") or not name:
            continue
        if "/" in name or name.endswith("/"):
            out[name.rstrip("/")] = (True, href)
        else:
            out[name] = (False, href)
    return out


def walk(folder_url, dest, depth=0, max_depth=6):
    if depth > max_depth:
        return
    entries = list_dir(folder_url)
    for name, (is_dir, href) in entries.items():
        if is_dir:
            walk(folder_url.rstrip("/") + "/" + name + "/", os.path.join(dest, name), depth + 1, max_depth)
        else:
            # jsDelivr lists nested dirs under /<dir>/flat/... for large trees;
            # a plain relative href resolves inside the listing either way.
            file_url = href if href.startswith("http") else folder_url.rstrip("/") + "/" + name
            target = os.path.join(dest, name)
            if os.path.exists(target) and os.path.getsize(target) > 0:
                print(f"  have {name}")
                continue
            print(f"  get {name}")
            try:
                data = fetch(file_url, binary=True)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "wb") as f:
                    f.write(data)
            except Exception as e:
                print(f"  !! {name}: {e}")
            time.sleep(0.1)


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    name, repo_ref, path = sys.argv[1], sys.argv[2], sys.argv[3]
    dest = os.path.join(OUT, name)
    os.makedirs(dest, exist_ok=True)
    url = f"{BASE}/{repo_ref}/{path}/".replace("//", "/") if False else f"{BASE}/{repo_ref}/{path}/"
    print(f"Porting {repo_ref}/{path} -> game-builds/{name}")
    walk(url, dest)


if __name__ == "__main__":
    main()
