#!/usr/bin/env python3
"""Regression test for the static handler's private-path deny list.

Run: python tools/server-path-test.py

Context: the list used to match "/build/" anywhere in a path, which also
matched /game-builds/<game>/Build/*, so every Unity WebGL build on the hosted
site 404'd its loader, framework, wasm and data files and never booted. The
rule now anchors root directories. This test loads just the deny list out of
serve-chalk.py (via ast, so the rest of the module never runs) and checks both
halves of that: secrets stay refused, game builds stay served.
"""

import ast
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "server" / "serve-chalk.py"

WANTED_ASSIGNMENTS = {"_PRIVATE_ANYWHERE", "_PRIVATE_ROOT_DIRS"}
WANTED_FUNCTIONS = {"denied_local_path"}


def load_deny_list():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    keep = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            names = {t.id for t in node.targets if isinstance(t, ast.Name)}
            if names & WANTED_ASSIGNMENTS:
                keep.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in WANTED_FUNCTIONS:
            keep.append(node)
    missing = WANTED_ASSIGNMENTS | WANTED_FUNCTIONS
    found = set()
    for node in keep:
        if isinstance(node, ast.Assign):
            found |= {t.id for t in node.targets if isinstance(t, ast.Name)}
        else:
            found.add(node.name)
    if missing - found:
        raise SystemExit("serve-chalk.py no longer defines: %s" % sorted(missing - found))
    namespace = {}
    exec(compile(ast.Module(body=keep, type_ignores=[]), str(SOURCE), "exec"), namespace)
    return namespace["denied_local_path"]


DENIED = [
    "/build/chalkle-single.html",
    "/build",
    "/server/serve-chalk.py",
    "/server",
    "/.git/config",
    "/assets/.git/config",
    "/.env",
    "/server/.env",
    "/.freebuff/settings.json",
    "/bitcord-backend/app.py",
    "/bitcord-backend",
]

ALLOWED = [
    # Every Unity WebGL build: the loader, framework, wasm and data files all
    # live under Build/, and all of them were 404ing.
    "/game-builds/how_to_fish/index.html",
    "/game-builds/how_to_fish/Build/WebGL.loader.js",
    "/game-builds/how_to_fish/Build/WebGL.framework.js",
    "/game-builds/how_to_fish/Build/WebGL.wasm",
    "/game-builds/how_to_fish/Build/WebGL.data",
    "/game-builds/how_to_fish/Build/WebGL.data.part3",
    "/game-builds/amongus/Build/UnityLoader.js",
    "/game-builds/azahar/Build/azahar.wasm",
    "/mac/build/index.html",
    "/assets/build/notes.txt",
    "/server-status/index.html",
]


def main():
    denied = load_deny_list()
    failures = []
    for path in DENIED:
        if not denied(path):
            failures.append("should be denied: %s" % path)
    for path in ALLOWED:
        if denied(path):
            failures.append("should be served: %s" % path)
    # The over-broad form must not come back anywhere in the file.
    source = SOURCE.read_text(encoding="utf-8")
    for bad in ('"/build/" in low', '"/server/" in low'):
        if bad in source:
            failures.append("over-broad deny rule is back: %s" % bad)
    for line in failures:
        print("FAIL  " + line)
    if failures:
        print("%d path check(s) failed" % len(failures))
        sys.exit(1)
    print("all %d server path checks pass (%d denied, %d served)"
          % (len(DENIED) + len(ALLOWED), len(DENIED), len(ALLOWED)))


if __name__ == "__main__":
    main()
