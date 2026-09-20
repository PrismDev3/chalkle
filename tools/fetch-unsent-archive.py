#!/usr/bin/env python3
"""Snapshot a slice of The Unsent Project archive into JSON.

The site's own API (https://app-api.theunsentproject.com/postsonly) pages 45
posts at a time and CORS-locks responses to theunsentproject.com, so the local
single-file app (unsent.html) carries a snapshot instead of calling it live.
This script refreshes that snapshot.

Usage:  python tools/fetch-unsent-archive.py <mode> [outfile]
        mode = head   first 120 pages, the recent end of the archive (fast-ish)
               extra  one page per color plus a few deep seeks (slow: the API
                      does an unindexed OFFSET scan, ~10s per page past the
                      first few)
        Runs merge into the output file, so head then extra builds one set.

Writes [["id", "name", "message", "color", "createdAt", 0|1], ...] to outfile
(default tmp-unsent/posts.json). Only public post fields are kept; the API's
moderator fields and report flags are dropped.
"""

import concurrent.futures as cf
import json
import os
import sys
import time
import urllib.parse
import urllib.request

API = "https://app-api.theunsentproject.com/postsonly"
PAGE = 45      # fixed server-side page size
TOTAL = 770125  # /postscount at capture time, used to spread the sample

COLORS = [
    "white", "light-grey", "grey", "black", "light-orange", "yellow", "tan",
    "brown", "blue-grey", "turquoise", "pale-blue", "light-blue", "purple",
    "light-purple", "dull-purple", "pale-purple", "maroon", "red", "orange",
    "tangerine", "army-green", "dark-green", "green", "light-green", "blue",
    "dark-blue", "wine", "dark-purple", "pale-pink", "light-pink", "pink",
    "peach",
]


def fetch(params, timeout, tries=3):
    url = API + "?" + "&".join(
        "%s=%s" % (k, urllib.parse.quote(str(v)))
        for k, v in params.items() if v not in (None, ""))
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json",
                "Origin": "https://theunsentproject.com",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8")).get("posts") or []
        except Exception as exc:                                    # noqa: BLE001
            if attempt == tries - 1:
                print("  ! skip=%s color=%s -> %s" % (params.get("skip"),
                                                      params.get("color") or "-", exc),
                      file=sys.stderr, flush=True)
            else:
                time.sleep(2.0 * (attempt + 1))
    return []


def plan(mode):
    """(skip, color, newest, timeout) jobs for the requested pass."""
    if mode == "head":
        return [(i * PAGE, "", i < 6, 30) for i in range(120)]
    if mode == "extra":
        jobs = [(i * 45, c, False, 30) for i, c in enumerate(COLORS)]
        # Deep seeks sample the far end of the archive. The API scans its
        # OFFSET, so these take 15-40s each; give them room and few tries.
        jobs += [(s, "", False, 60) for s in
                 (60000, 120000, 200000, 300000, 420000, 550000, 690000, 760000)]
        return jobs
    raise SystemExit("mode must be head or extra")


def load(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            return {r[0]: r for r in json.load(fh)}
    except Exception:                                               # noqa: BLE001
        return {}


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    mode = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "tmp-unsent/posts.json"
    rows = load(out)
    before = len(rows)
    jobs = plan(mode)
    done = 0
    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(fetch, {"skip": s, "color": c} if c else {"skip": s}, to):
                (s, c, new) for s, c, new, to in jobs}
        for fut in cf.as_completed(futs):
            _skip, _color, newest = futs[fut]
            done += 1
            for p in fut.result():
                pid = p.get("id")
                msg = (p.get("message") or "").strip()
                if not pid or not msg:
                    continue
                old = rows.get(pid)
                if old and not newest:
                    continue
                rows[pid] = [pid, (p.get("name") or "").strip(), msg,
                             p.get("color") or "black",
                             (p.get("createdAt") or "")[:19], 1 if newest else 0]
            if done % 20 == 0:
                print("  %s: %d/%d pages, %d posts" % (mode, done, len(jobs), len(rows)),
                      flush=True)

    ordered = sorted(rows.values(), key=lambda r: r[0], reverse=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(ordered, fh, ensure_ascii=False, separators=(",", ":"))
    colors = {}
    for r in ordered:
        colors[r[3]] = colors.get(r[3], 0) + 1
    size = os.path.getsize(out) / 1024
    print("%s: %d posts (+%d), %d colors, %.0f kB -> %s"
          % (mode, len(ordered), len(ordered) - before, len(colors), size, out))
    missing = [c for c in COLORS if c not in colors]
    if missing:
        print("  no posts yet for: %s" % ", ".join(missing))


if __name__ == "__main__":
    main()
