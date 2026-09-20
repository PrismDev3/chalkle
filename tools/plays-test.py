#!/usr/bin/env python3
"""Regression test for the /api/plays launch counter.

Run: python tools/plays-test.py

The plays store is what makes "Most played" and the Home trending shelf mean
anything, so its rules are pinned here: one launch counts once, the trend is a
rolling window of day buckets, a junk key cannot reach the file, and the store
trims itself instead of growing without limit.

The helpers are pulled out of serve-chalk.py with ast (so the rest of the
server never starts) and pointed at a temp file, which keeps this test able to
run anywhere without touching the real play-counts.json.
"""

import ast
import json
import os
import pathlib
import re
import sys
import tempfile
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "server" / "serve-chalk.py"

WANTED_FUNCTIONS = {
    "_plays_today",
    "_plays_clean_key",
    "_plays_load",
    "_plays_save",
    "_plays_trending",
    "_plays_payload",
    "_plays_report",
}
WANTED_ASSIGNMENTS = {
    "PLAYS_LOCK",
    "PLAYS_MAX_KEYS",
    "PLAYS_TREND_DAYS",
    "PLAYS_KEY_MAX",
}


def load_plays_namespace(plays_path):
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    keep = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            names = {t.id for t in node.targets if isinstance(t, ast.Name)}
            if names & WANTED_ASSIGNMENTS:
                keep.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in WANTED_FUNCTIONS:
            keep.append(node)
    found = set()
    for node in keep:
        if isinstance(node, ast.Assign):
            found |= {t.id for t in node.targets if isinstance(t, ast.Name)}
        else:
            found.add(node.name)
    missing = (WANTED_ASSIGNMENTS | WANTED_FUNCTIONS) - found
    if missing:
        raise SystemExit("serve-chalk.py no longer defines: %s" % sorted(missing))
    namespace = {"os": os, "json": json, "re": re, "time": time, "threading": threading}
    exec(compile(ast.Module(body=keep, type_ignores=[]), str(SOURCE), "exec"), namespace)
    namespace["PLAYS_PATH"] = plays_path
    return namespace


def main():
    failures = []
    source = SOURCE.read_text(encoding="utf-8")

    # Route wiring: GET + POST exist and the state-change guard covers POST,
    # so a cross-site page cannot inflate the counts with a no-preflight POST.
    if 'if route == "/api/plays":\n            return self._plays_get()' not in source:
        failures.append("GET /api/plays route is missing")
    if 'if route == "/api/plays":\n            return self._plays_post()' not in source:
        failures.append("POST /api/plays route is missing")
    guarded = re.search(r"STATE_POSTS = \((.*?)\)", source, re.S)
    if not guarded or '"/api/plays"' not in guarded.group(1):
        failures.append("/api/plays is not in the STATE_POSTS same-origin guard")
    for line in source.splitlines():
        if "low.endswith(\"/play-counts.json\")" in line:
            break
    else:
        failures.append("play-counts.json is not refused by the static deny list")

    with tempfile.TemporaryDirectory() as tmp:
        plays_file = os.path.join(tmp, "play-counts.json")
        ns = load_plays_namespace(plays_file)
        report = ns["_plays_report"]
        payload = ns["_plays_payload"]
        load = ns["_plays_load"]
        save = ns["_plays_save"]
        clean = ns["_plays_clean_key"]

        # 1. an empty store answers with empty maps, never an error.
        empty = payload()
        if not empty.get("ok") or empty.get("plays") != {} or empty.get("trending") != {}:
            failures.append("an empty store should return ok with empty maps")

        # 2. launches count, twice means two.
        first = report("chalkle/games/doom")
        second = report("chalkle/games/doom")
        if not first.get("ok") or first.get("count") != 1:
            failures.append("the first launch of a key should count 1")
        if second.get("count") != 2:
            failures.append("the second launch of a key should count 2")
        if second.get("trending") != 2:
            failures.append("a fresh key should trend at its own count")

        # 3. totals and the trend are separate views of the same store.
        snap = payload()
        if snap["plays"].get("chalkle/games/doom") != 2:
            failures.append("totals should carry the running count")
        if snap["trending"].get("chalkle/games/doom") != 2:
            failures.append("trending should carry the week's count")
        if snap.get("days") != ns["PLAYS_TREND_DAYS"]:
            failures.append("the payload should report its trend window")

        # 4. junk keys are dropped, not stored.
        for bad in ("", "   ", None, 42):
            res = report(bad)
            if res.get("ok"):
                failures.append("a blank key should be refused, got %r" % (bad,))
        # Control characters never reach the key; surrounding space is trimmed.
        cleaned = clean("bad\u0000key\n\t ")
        if cleaned != "badkey":
            failures.append("key sanitizing left %r" % cleaned)
        report("bad\u0000key")
        if "badkey" not in load()["total"]:
            failures.append("a sanitized key should be stored under its clean form")

        # 5. long keys are capped, so one huge POST cannot bloat the file.
        report("x" * 5000)
        stored = load()["total"]
        longest = max(len(k) for k in stored)
        if longest > ns["PLAYS_KEY_MAX"]:
            failures.append("a stored key is longer than PLAYS_KEY_MAX")

        # 6. the day buckets trim to the window on save.
        state = {"v": 1, "total": {"a": 1}, "days": {}}
        for day in range(1, 13):
            state["days"]["2026-09-%02d" % day] = {"a": day}
        save(state)
        reloaded = load()
        if len(reloaded["days"]) != ns["PLAYS_TREND_DAYS"]:
            failures.append("day buckets should trim to %d, kept %d"
                            % (ns["PLAYS_TREND_DAYS"], len(reloaded["days"])))
        if "2026-09-12" not in reloaded["days"] or "2026-09-01" in reloaded["days"]:
            failures.append("trimming should keep the newest buckets")

        # 7. a malformed file is ignored instead of breaking the grid.
        pathlib.Path(plays_file).write_text("{\"total\": [1,2,3], \"days\": 7}",
                                            encoding="utf-8")
        recovered = load()
        if recovered["total"] != {} or recovered["days"] != {}:
            failures.append("a malformed store should normalize to empty")
        pathlib.Path(plays_file).write_text("not json at all", encoding="utf-8")
        if load()["total"] != {}:
            failures.append("unparseable JSON should normalize to empty")

        # 8. the file on disk is a dict with the documented shape.
        report("shape-check")
        raw = json.loads(pathlib.Path(plays_file).read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or not isinstance(raw.get("total"), dict):
            failures.append("the stored file should be {total, days}")
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", ns["_plays_today"]()):
            failures.append("_plays_today should be an ISO date")

    for line in failures:
        print("FAIL  " + line)
    if failures:
        print("%d plays check(s) failed" % len(failures))
        sys.exit(1)
    print("all plays checks pass")


if __name__ == "__main__":
    main()
