#!/usr/bin/env python3
"""Regression test for the TMDB dead-token memo in the relay's TMDB proxy.

Run: python tools/tmdb-token-test.py

Why this exists: the vendored TMDB bearer token is dead, so api.themoviedb.org
answered 401 to every read the Movies tab made and the keyless Cinemeta
fallback then rebuilt the same JSON. That made each read pay two upstream
calls, one of them always doomed. The proxy now remembers the header the
upstream refused and answers from the fallback directly afterwards.

The rule that keeps this safe is pinned here: only the exact header value the
upstream rejected is remembered. A caller's own pasted key is a different
string, so it is still tried, and a case-different or differently prefixed
header is still tried too. An empty token is never treated as refused, so a
caller with no header of its own always probes once with the built-in default.

The decision functions are pulled out of serve-chalk.py with ast, so the test
runs without starting the server. The last two checks are source checks: they
pin the wiring in _tmdb_proxy, since a memo nothing consults would silently
bring the wasted call back.
"""

import ast
import pathlib
import re
import sys
import os

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "server" / "serve-chalk.py"
MOVIES = ROOT / "movies.html"
MIRROR_MOVIES = ROOT / "deploy-static" / "movies.html"
WANTED_FUNCTIONS = {"_tmdb_token_dead"}
WANTED_ASSIGNMENTS = {"_TMDB_DEAD_TOKENS", "_TMDB_BEARER"}


def load_namespace():
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
    missing = (WANTED_FUNCTIONS | WANTED_ASSIGNMENTS) - found
    if missing:
        raise SystemExit("serve-chalk.py no longer defines: %s" % sorted(missing))
    ns = {"os": os}
    exec(compile(ast.Module(body=keep, type_ignores=[]), str(SOURCE), "exec"), ns)
    return ns


def _method_body(source, name):
    """The text of one method, from its def line to the next def at the same
    indent. Used for the ordering checks below."""
    start = source.index("def " + name + "(self")
    rest = source[start:]
    nxt = rest.find("\n    def ")
    return rest if nxt < 0 else rest[:nxt]


def main():
    ns = load_namespace()
    dead = ns["_tmdb_token_dead"]
    registry = ns["_TMDB_DEAD_TOKENS"]
    bearer = ns["_TMDB_BEARER"]
    default_header = "Bearer " + bearer
    failures = []
    run = [0]

    def expect(cond, why):
        run[0] += 1
        if not cond:
            failures.append(why)

    # Nothing is remembered until a response proves the token is refused.
    expect(not dead(default_header),
           "the built-in token starts out remembered as refused")
    expect(not registry, "the refusal registry is not empty at import time")

    registry.add(default_header)

    cases = [
        ("", False, "an empty token is never skipped"),
        (None, False, "None is never skipped"),
        (default_header, True, "the exact refused header is skipped"),
        ("Bearer " + bearer[:-1] + "X", False, "a token one character off is still tried"),
        (default_header.lower(), False, "a case-different header is compared exactly"),
        ("Bearer " + default_header, False, "a double Bearer prefix is not the refused header"),
        (default_header + " ", False, "the memo compares exactly, it does not trim"),
        ("Bearer user-pasted-key", False, "a caller's own key is still tried"),
    ]
    for token, want, why in cases:
        expect(bool(dead(token)) == want,
               "%s: expected %s for %r" % (why, "skip" if want else "try", token))

    # Sticky: the memo only grows, so a later read cannot re-arm the wasted call.
    expect(dead(default_header), "a remembered header stopped being remembered")

    # The app's own header has to be the very string the server remembers,
    # otherwise the client's calls never take the skip path.
    for path in (MOVIES, MIRROR_MOVIES):
        expect(path.is_file(), "%s is missing" % path.name)
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"^const TMDB_AUTH = '([^']*)';", text, re.M)
        expect(bool(m), "%s no longer defines TMDB_AUTH" % path.name)
        if m:
            expect(m.group(1) == default_header,
                   "%s ships a TMDB_AUTH that differs from the server token, so "
                   "its calls are still tried upstream" % path.name)

    # Wiring: the proxy consults the memo before it builds the upstream call,
    # and only a 401 or 403 adds to it.
    source = SOURCE.read_text(encoding="utf-8")
    proxy = _method_body(source, "_tmdb_proxy")
    guard = proxy.find("_tmdb_token_dead(auth)")
    request = proxy.find("urllib.request.Request(")
    expect(guard >= 0, "_tmdb_proxy never consults the dead-token memo")
    expect(guard >= 0 and request >= 0 and guard < request,
           "_tmdb_proxy builds the upstream call before the memo check")
    expect("except urllib.error.HTTPError" in proxy,
           "_tmdb_proxy no longer reads the upstream status")
    adds = [m.start() for m in re.finditer(re.escape("_TMDB_DEAD_TOKENS.add("), source)]
    expect(len(adds) == 1,
           "expected exactly one place that remembers a refusal, found %d" % len(adds))
    add_in_proxy = proxy.find("_TMDB_DEAD_TOKENS.add(")
    branch_in_proxy = proxy.find("if code in (401, 403):")
    expect(add_in_proxy >= 0 and branch_in_proxy >= 0 and branch_in_proxy < add_in_proxy,
           "the refusal is remembered inside _tmdb_proxy, but not in its 401 and "
           "403 branch")

    for line in failures:
        print("FAIL  " + line)
    if failures:
        print("%d tmdb token check(s) failed" % len(failures))
        sys.exit(1)
    print("all %d tmdb token checks pass" % run[0])


if __name__ == "__main__":
    main()
