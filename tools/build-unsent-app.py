#!/usr/bin/env python3
"""Build unsent.html, the offline Unsent Project archive app.

Sources (all in unsent-src/, see its README.md for how they were captured):
  shell.html   markup lifted from the site's own server-rendered page
  app.js       archive logic ported from the site's client bundle
  posts.json   post snapshot from tools/fetch-unsent-archive.py
  assets/      the site's stylesheet, card template, logos and icon

Assets are fetched from the live site into unsent-src/assets/ the first time
(they are small; the README lists the exact URLs). Run:

    python tools/build-unsent-app.py [--check]

Writes unsent.html at the repo root and copies it to deploy-static/. --check
only reports whether the committed output is current.
"""

import base64
import hashlib
import json
import pathlib
import re
import shutil
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "unsent-src"
ASSETS = SRC / "assets"
SITE = "https://theunsentproject.com"

ASSET_URLS = {
    "site.css": SITE + "/_next/static/css/4a3915b2e66d70ce.css",
    "template.png": SITE + "/template.png",
    "tup-logo.jpg": SITE + "/tup-logo.jpg",
    "tup-typing.gif": SITE + "/tup-typing.gif",
    "favicon.ico": SITE + "/favicon.ico",
}

MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
}

OUT = ROOT / "unsent.html"
MIRROR = ROOT / "deploy-static" / "unsent.html"


def data_uri(name):
    blob = (ASSETS / name).read_bytes()
    mime = MIME[pathlib.Path(name).suffix.lower()]
    return "data:%s;base64,%s" % (mime, base64.b64encode(blob).decode("ascii"))


def ensure_assets():
    ASSETS.mkdir(parents=True, exist_ok=True)
    missing = [n for n in ASSET_URLS if not (ASSETS / n).exists()]
    for name in missing:
        url = ASSET_URLS[name]
        print("fetching %s" % url)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            (ASSETS / name).write_bytes(r.read())


def payload():
    """JSON for the post snapshot, one row per post, headers stripped."""
    rows = json.loads((SRC / "posts.json").read_text(encoding="utf-8"))
    slim = [[r[0], r[1], r[2], r[3], r[4]] for r in rows if r[2]]
    slim.sort(key=lambda r: r[0], reverse=True)
    return slim


def safe_js(blob):
    """JSON that is also safe inside a <script> block."""
    return (blob.replace("<", "\\u003c").replace(">", "\\u003e")
                .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))


def build():
    ensure_assets()
    shell = (SRC / "shell.html").read_text(encoding="utf-8")
    app = (SRC / "app.js").read_text(encoding="utf-8")
    css = (ASSETS / "site.css").read_text(encoding="utf-8")

    # The stylesheet still carries one background image hosted on the old
    # WordPress path. Nothing in this page matches that rule, but an external
    # URL in an offline app is a request waiting to happen, so drop it.
    stray = re.findall(r"url\((https?://[^)]+)\)", css)
    for url in stray:
        css = css.replace("url(%s)" % url, "none")

    # Tailwind emits its [hidden] rule in preflight, long before the .flex and
    # .block utilities, so an element with the attribute and a display utility
    # would still show. The offline build toggles panels with the attribute, so
    # make it win.
    css += ("\n/* Offline build additions */\n"
            "[hidden]{display:none!important}\n")

    rows = payload()
    blob = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    meta = json.dumps({
        "count": len(rows),
        "captured": max(r[4] for r in rows)[:10],
    }, separators=(",", ":"))

    html = shell
    html = html.replace("/*__TUP_CSS__*/", css)
    html = html.replace("/*__TUP_APP__*/", app)
    html = html.replace("__TUP_TPL__", data_uri("template.png"))
    html = html.replace("__TUP_LOGO__", data_uri("tup-logo.jpg"))
    html = html.replace("__TUP_GIF__", data_uri("tup-typing.gif"))
    html = html.replace("__TUP_ICON__", data_uri("favicon.ico"))
    html = html.replace("/*__TUP_DATA__*/[]", safe_js(blob))
    html = html.replace("/*__TUP_META__*/{}", meta)

    # Only the template tokens count: __TUP_POSTS__ / __TUP_META__ /
    # __TUP_TEMPLATE__ are window globals the app reads.
    leftovers = [p for p in ("__TUP_CSS__", "__TUP_APP__", "__TUP_TPL__",
                             "__TUP_LOGO__", "__TUP_GIF__", "__TUP_ICON__")
                 if p in html]
    if leftovers:
        raise SystemExit("unreplaced placeholders: %s" % leftovers)

    OUT.write_text(html, encoding="utf-8", newline="\n")
    MIRROR.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(OUT, MIRROR)

    print("posts: %d (captured %s), dropped %d stray url() in css"
          % (len(rows), meta and json.loads(meta)["captured"], len(stray)))
    print("wrote %s (%.0f kB) and %s" % (OUT.name, OUT.stat().st_size / 1024,
                                         MIRROR.relative_to(ROOT)))


def check():
    if not OUT.exists():
        raise SystemExit("unsent.html missing")
    before = OUT.read_bytes()
    build()
    after = OUT.read_bytes()
    if hashlib.sha256(before).hexdigest() != hashlib.sha256(after).hexdigest():
        raise SystemExit("unsent.html was stale, rebuilt it")
    print("unsent.html is current")


if __name__ == "__main__":
    if "--check" in sys.argv:
        check()
    else:
        build()
