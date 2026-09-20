"""Regression test for the sync relay's gamelib sanitizer.

Why this exists: _sanitize_sync_blob() used to end in

    return json.dumps(d, ensure_ascii=False).encode("utf-8")

wrapped in a bare `except Exception: return raw`. Shared state is assembled
from third-party pages, so a title carrying a half-decoded character parses as
a lone surrogate; json.dumps wrote it back verbatim and .encode() raised
UnicodeEncodeError. The bare except caught that and returned the RAW blob, so
one bad character anywhere in the sync state silently disabled the entire
library filter - deleted titles came back on every fresh visit and no error was
ever logged. Nothing here needs a running server: the module is exec'd from
source because importing serve-chalk.py starts the HTTP listener.

Run:  python tools/check-sync-sanitizer.py
"""
import ast
import io
import json
import os
import re
import sys

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server", "serve-chalk.py")
WANT_FUNCS = {"_lib_entry_ok", "_sanitize_sync_blob", "_scrub_surrogates"}
WANT_CONSTS = {"_BAD_TITLE_BITS", "_BAD_URL_BITS", "_BAD_TITLES_EXACT", "_SURROGATE_RE"}

failures = []


def check(label, ok, detail=""):
    print("  %-4s %s%s" % ("PASS" if ok else "FAIL", label, ("  <- " + detail) if detail and not ok else ""))
    if not ok:
        failures.append(label)


def load_sanitizer():
    """Pull just the sanitizer's defs/constants out of serve-chalk.py."""
    source = io.open(SRC, encoding="utf-8").read()
    lines = source.splitlines(True)
    tree = ast.parse(source)
    chunks = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in WANT_FUNCS:
            chunks.append("".join(lines[node.lineno - 1:node.end_lineno]))
        elif isinstance(node, ast.Assign):
            names = {t.id for t in node.targets if isinstance(t, ast.Name)}
            if names & WANT_CONSTS:
                chunks.append("".join(lines[node.lineno - 1:node.end_lineno]))
    ns = {"re": re, "json": json}
    exec("\n".join(chunks), ns)
    missing = sorted((WANT_FUNCS | WANT_CONSTS) - set(ns))
    if missing:
        raise SystemExit("serve-chalk.py no longer defines: %s" % ", ".join(missing))
    return ns


def main():
    ns = load_sanitizer()
    sanitize = ns["_sanitize_sync_blob"]
    ok_entry = ns["_lib_entry_ok"]

    print("sanitizer predicate")
    # Blocked by title, case-insensitively.
    check("blocks Amberial by title", not ok_entry({"title": "Amberial", "url": "/ugs/clamberial.html"}))
    check("blocks 3D Car Driver by title", not ok_entry({"title": "3D Car Driver", "url": "/x.swf"}))
    # Blocked by URL even under an innocent title.
    check("blocks a scratch.mit.edu url", not ok_entry({"title": "CS Surf", "url": "https://scratch.mit.edu/projects/1/embed"}))
    check("blocks a turbowarp url", not ok_entry({"title": "Fortnite Z", "url": "https://turbowarp.org/1/embed"}))
    # Exact-match junk must not take real games with it.
    check("keeps Quake III Arena", ok_entry({"title": "Quake III Arena", "url": "/ugs/clquake3.html"}))
    check("keeps Lifeguard", ok_entry({"title": "Lifeguard", "url": "/ugs/cllifeguard.html"}))
    check("keeps a normal game", ok_entry({"title": "Slope", "url": "/ugs/clslope.html"}))
    check("drops a one-character title", not ok_entry({"title": "x", "url": "/ugs/x.html"}))

    print("blob sanitizing")
    legit = {"title": "Slope", "url": "/ugs/clslope.html", "thumb": "", "category": "arcade"}
    junk_title = {"title": "Amberial", "url": "https://chalkle.lootline.xyz/game-builds/flash/swf/amberial.swf"}
    junk_url = {"title": "Fortnite Z", "url": "https://turbowarp.org/404950182/embed"}
    payload = {
        "chalkle-gamelib-v4": json.dumps([legit, junk_title, junk_url]),
        "chalkle-theme-preset": "midnight",
    }
    raw = json.dumps(payload).encode("utf-8")

    out = sanitize(raw)
    check("sanitizer changes the blob", out != raw)
    decoded = json.loads(out.decode("utf-8"))
    lib = json.loads(decoded["chalkle-gamelib-v4"])
    titles = [g["title"] for g in lib]
    check("drops the blocked entries", titles == ["Slope"], "kept %r" % titles)
    check("keeps unrelated keys", decoded.get("chalkle-theme-preset") == "midnight")

    print("lone surrogates (the bug that hid all of the above)")
    # A title that parsed from '\ud800' with no matching low surrogate.
    surro = dict(legit)
    surro["title"] = "Slope\ud800"
    blast = {
        "chalkle-gamelib-v4": json.dumps([surro, junk_title]),
        "chalkle-board": "hi \udfff there",
    }
    blast_raw = json.dumps(blast, ensure_ascii=True).encode("utf-8")
    check("payload really carries a lone surrogate", b"\\ud800" in blast_raw)
    try:
        json.dumps(json.loads(blast_raw.decode("utf-8")), ensure_ascii=False).encode("utf-8")
        check("the old encode path raises (bug still reproducible)", False,
              "it did not raise - this test no longer proves anything")
    except UnicodeEncodeError:
        check("the old encode path raises (bug still reproducible)", True)

    out2 = sanitize(blast_raw)
    check("surrogate blob is rewritten", out2 != blast_raw)
    check("blocked title is gone from the raw bytes", b"Amberial" not in out2)
    try:
        text = out2.decode("utf-8")
    except UnicodeDecodeError as e:
        text = ""
        check("output is valid utf-8", False, str(e))
    else:
        check("output is valid utf-8", True)
    if text:
        check("no lone surrogates survive", not ns["_SURROGATE_RE"].search(text))
        kept2 = [g["title"] for g in json.loads(json.loads(text)["chalkle-gamelib-v4"])]
        check("blocked entry still dropped despite the bad character",
              kept2 == ["Slope\ufffd"], "kept %r" % kept2)

    print("unparseable input")
    check("non-JSON passes through untouched", sanitize(b"not json at all") == b"not json at all")

    print("")
    if failures:
        print("SYNC SANITIZER: FAIL (%d) - %s" % (len(failures), ", ".join(failures)))
        return 1
    print("SYNC SANITIZER: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
