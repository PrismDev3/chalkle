#!/usr/bin/env python3
"""Scan a ScummVM game data folder and write the manifest.json the
ScummVM player (assets/scummvm/index.html) reads to load the files.

Usage:
    python tools/make-scummvm-manifest.py assets/scummvm/games/backyard-baseball

The game folder should contain the data files from your own copy of the
game (see assets/scummvm/games/<slug>/README.md). The manifest lists every
file with its size so the player can show download progress.
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def main():
    if len(sys.argv) != 2:
        print("usage: python tools/make-scummvm-manifest.py <game-folder>")
        sys.exit(1)
    folder = sys.argv[1]
    if not os.path.isdir(folder):
        print("not a folder:", folder)
        sys.exit(1)

    files = []
    total = 0
    for root, dirs, names in os.walk(folder):
        dirs.sort()
        for name in sorted(names):
            if name == "manifest.json" or name.startswith("."):
                continue
            fp = os.path.join(root, name)
            rel = os.path.relpath(fp, folder).replace(os.sep, "/")
            size = os.path.getsize(fp)
            files.append({"path": rel, "size": size})
            total += size

    if not files:
        print("no data files found in", folder)
        print("copy the game's data files here first, then re-run")
        sys.exit(1)

    manifest = {"files": files}
    out = os.path.join(folder, "manifest.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1)
    print(f"wrote {out}")
    print(f"{len(files)} files, {total / (1024 * 1024):.1f} MB")


if __name__ == "__main__":
    main()