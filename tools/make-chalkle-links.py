#!/usr/bin/env python3
"""make-chalkle-links.py

Regenerates the three Chalkle jsDelivr link lists the Docs tab fetches:

  chalkle-links.txt          -> https://cdn.jsdelivr.net/...
  chalkle-links-fastly.txt   -> https://fastly.jsdelivr.net/...
  chalkle-links-gcore.txt    -> https://gcore.jsdelivr.net/...

Each list is one URL per line pointing at a file in the PrismDev3/chalkle-auto
repo. All three are generated from the same repo file list, so they can never
drift apart. Run this whenever chalkle-auto gains files:

  python tools/make-chalkle-links.py
"""
import json
import sys
import urllib.request
from pathlib import Path

REPO = "PrismDev3/chalkle-auto"
BRANCH = "main"
EDGES = {
    "chalkle-links.txt": "cdn",
    "chalkle-links-fastly.txt": "fastly",
    "chalkle-links-gcore.txt": "gcore",
}
ROOT = Path(__file__).resolve().parent.parent


def repo_files():
    url = f"https://api.github.com/repos/{REPO}/git/trees/{BRANCH}?recursive=1"
    with urllib.request.urlopen(url, timeout=30) as r:
        tree = json.load(r).get("tree", [])
    return sorted(
        x["path"]
        for x in tree
        if x["type"] == "blob"
        and x["path"].endswith(".svg")
        and x["path"].startswith("learn-")
    )


def main():
    files = repo_files()
    if not files:
        print("ERROR: no learn-*.svg files found in repo", file=sys.stderr)
        return 1
    print(f"{len(files)} files in {REPO}")
    for name, edge in EDGES.items():
        lines = "\n".join(
            f"https://{edge}.jsdelivr.net/gh/{REPO}@{BRANCH}/{f}" for f in files
        ) + "\n"
        (ROOT / name).write_text(lines, encoding="utf-8")
        print(f"wrote {name} ({len(files)} links)")
    return 0


if __name__ == "__main__":
    sys.exit(main())