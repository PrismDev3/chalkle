#!/usr/bin/env python3
"""Port games into game-builds/ for self-hosting.

Walks GitHub's rendered tree pages (no API, so no rate limits) and downloads
every file via raw.githubusercontent.com into game-builds/<name>/, preserving
the tree. The game then runs 100% from our own server.

Usage:
    python tools/port-games.py basketbros  genizy/assets  basketbros-io
    python tools/port-games.py mobcontrol  bubbls/youtube-playables  mob-control-html5
"""

import html
import os
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "game-builds")
RAW = "https://raw.githubusercontent.com"
GH = "https://github.com"
UA = {"User-Agent": "Mozilla/5.0 (chalkle-port)"}
SKIP = {"cdn-cgi", ".git", "node_modules"}


def fetch(url, binary=False):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read() if binary else r.read().decode("utf-8", errors="replace")


def default_branch(repo):
    try:
        body = fetch(f"{GH}/{repo}")
        m = re.search(r'"defaultBranch":"([^"]+)"', body)
        if m:
            return m.group(1)
    except Exception:
        pass
    return "main"


def list_tree(repo, branch, path):
    """Return {name: is_dir} parsed from a GitHub tree page.

    Matches the row anchors (href="/<user>/<repo>/(blob|tree)/<branch>/<path>/<name>")
    for exactly one path level under <path>. Anchors with deeper paths (nested
    dir rows that GitHub renders as a flat list, e.g. data/chunks) are ignored
    here and picked up when we recurse into their parent.
    """
    url = f"{GH}/{repo}/tree/{branch}/{path}"
    try:
        body = fetch(url)
    except Exception as e:
        print(f"  !! tree {path}: {e}")
        return {}
    out = {}
    marker = f"{repo}/(?:blob|tree)/{branch}/{re.escape(path)}/"
    pat = re.compile(r'href="(/' + marker + r'([^"#?]+))"')
    for href, raw in pat.findall(body):
        name = html.unescape(raw)
        if name in SKIP or not name or "/" in name:
            continue
        out[name] = "/tree/" in href
    return out


def walk(repo, branch, path, dest, depth=0, max_depth=8):
    if depth > max_depth:
        return
    entries = list_tree(repo, branch, path)
    if not entries:
        print(f"  !! empty listing for {path}")
        return
    for name, is_dir in entries.items():
        if is_dir:
            walk(repo, branch, f"{path}/{name}", os.path.join(dest, name), depth + 1, max_depth)
        else:
            target = os.path.join(dest, name)
            if os.path.exists(target) and os.path.getsize(target) > 0:
                print(f"  have {name}")
                continue
            raw = f"{RAW}/{repo}/{branch}/{path}/{urllib.parse.quote(name)}"
            print(f"  get {name}")
            try:
                data = fetch(raw, binary=True)
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
    name, repo, path = sys.argv[1], sys.argv[2], sys.argv[3]
    dest = os.path.join(OUT, name)
    os.makedirs(dest, exist_ok=True)
    branch = default_branch(repo)
    print(f"Porting {repo}/{path} (branch {branch}) -> game-builds/{name}")
    walk(repo, branch, path, dest)


if __name__ == "__main__":
    main()
