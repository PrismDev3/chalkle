#!/usr/bin/env python3
"""Regression test for the same-origin guard on state-changing POSTs.

Run: python tools/state-post-test.py

Why this exists: the guard read urlsplit(origin).host, and SplitResult has no
.host attribute (the name is .hostname), so the lookup raised, the host fell
back to an empty string, and the comparison could never match. Every real
browser POST to /_sync, /api/ai/chat, /api/ai/convos, /api/proxy/backend,
/cloud/config, /chat-upload-image, /api/live-tv/admin and /api/plays answered
403 - which is the "Failed to load resource: 403 (Forbidden)" line the console
has been showing. The guard still has to refuse cross-site writes, so both
halves are pinned here.

The decision function is pulled out of serve-chalk.py with ast so the test runs
without starting the server.
"""

import ast
import pathlib
import re
import sys
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "server" / "serve-chalk.py"
WANTED = {"state_post_allowed", "_host_only"}
WANTED_ASSIGNMENTS = {"_MIRROR_HOST_RE"}


def load_namespace():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    keep = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            names = {t.id for t in node.targets if isinstance(t, ast.Name)}
            if names & WANTED_ASSIGNMENTS:
                keep.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in WANTED:
            keep.append(node)
    found = set()
    for node in keep:
        if isinstance(node, ast.Assign):
            found |= {t.id for t in node.targets if isinstance(t, ast.Name)}
        else:
            found.add(node.name)
    missing = (WANTED | WANTED_ASSIGNMENTS) - found
    if missing:
        raise SystemExit("serve-chalk.py no longer defines: %s" % sorted(missing))
    # The module under test calls urllib.parse.urlsplit, so the package itself
    # goes in the namespace (importing the submodule here makes that valid).
    ns = {"re": re, "urllib": urllib}
    exec(compile(ast.Module(body=keep, type_ignores=[]), str(SOURCE), "exec"), ns)
    return ns


# (origin, host header, marker header, should be allowed, why)
CASES = [
    # The case that was broken: a browser on the real site posting to itself.
    ("https://chalkle.lootline.xyz", "chalkle.lootline.xyz", "", True, "same host, https"),
    ("http://127.0.0.1:4173", "127.0.0.1:4173", "", True, "same host and port"),
    ("http://localhost:4173", "localhost:4173", "", True, "localhost dev server"),
    ("https://chalkle.lootline.xyz", "chalkle.lootline.xyz:443", "", True, "host header carries a port"),
    ("http://[::1]:4173", "[::1]:4173", "", True, "IPv6 loopback"),
    # Static mirrors post to the relay on purpose.
    ("https://cdn.jsdelivr.net", "chalkle.lootline.xyz", "", True, "jsdelivr mirror"),
    ("https://someone.github.io", "chalkle.lootline.xyz", "", True, "github pages mirror"),
    ("https://chalkle.pages.dev", "chalkle.lootline.xyz", "", True, "pages.dev mirror"),
    # Opaque and missing origins need the front-end marker.
    ("null", "chalkle.lootline.xyz", "chalkle", True, "file:// page with the marker"),
    ("null", "chalkle.lootline.xyz", "", False, "file:// page without the marker"),
    ("", "chalkle.lootline.xyz", "chalkle", True, "no Origin, marker present"),
    ("", "chalkle.lootline.xyz", "", False, "no Origin, no marker"),
    # Cross-site writes stay refused.
    ("https://evil.example", "chalkle.lootline.xyz", "", False, "foreign origin"),
    ("https://evil.example", "chalkle.lootline.xyz", "chalkle", False, "foreign origin, even with the marker"),
    ("https://notgithub.io", "chalkle.lootline.xyz", "", False, "lookalike mirror domain"),
    ("https://jsdelivr.net.evil.example", "chalkle.lootline.xyz", "", False, "mirror name as a subdomain of another host"),
    ("https://chalkle.lootline.xyz.evil.example", "chalkle.lootline.xyz", "", False, "target host as a prefix of another host"),
]


def main():
    ns = load_namespace()
    allowed = ns["state_post_allowed"]
    failures = []
    for origin, host, marker, want, why in CASES:
        got = allowed(origin, host, marker)
        if bool(got) != want:
            failures.append("%s: expected %s for origin=%r host=%r marker=%r"
                            % (why, "allow" if want else "refuse", origin, host, marker))

    # The broken attribute must not come back.
    source = SOURCE.read_text(encoding="utf-8")
    if "urlsplit(origin).host " in source or "urlsplit(origin).host or" in source:
        failures.append("the .host attribute lookup is back (SplitResult has .hostname)")

    for line in failures:
        print("FAIL  " + line)
    if failures:
        print("%d state-post check(s) failed" % len(failures))
        sys.exit(1)
    print("all %d state-post checks pass" % len(CASES))


if __name__ == "__main__":
    main()
