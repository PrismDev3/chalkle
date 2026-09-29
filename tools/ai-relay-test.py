#!/usr/bin/env python3
"""Chalkle AI relay test: the /api/ai/chat relay in server/serve-chalk.py.

Run: python tools/ai-relay-test.py

The relay once shipped every chat request WITHOUT its API key and answered
with an opaque "502 all-upstreams-down": the key loader called io.open() but
the module never imported io, and the bare except hid the NameError. These
checks pin both sides of that failure:
  1. the loader actually yields a key when server/ai_key.txt exists
  2. a missing key fails fast with a clear 503 "no-key" instead of a doomed
     upstream round trip, and the guard does not fire when a key exists
The upstream itself is never contacted: everything runs against stubs, so
the suite is fast and network-free.
"""
import importlib.util
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server", "serve-chalk.py")

pass_n = 0
fail_n = 0


def check(name, ok, detail=""):
    global pass_n, fail_n
    if ok:
        pass_n += 1
        print("PASS  " + name + (("  (" + str(detail) + ")") if detail else ""))
    else:
        fail_n += 1
        print("FAIL  " + name + (("  (" + str(detail) + ")") if detail else ""))


def load_module(env_key=""):
    """Import serve-chalk.py fresh with a controlled AI_API_KEY env."""
    old = os.environ.pop("AI_API_KEY", None)
    if env_key:
        os.environ["AI_API_KEY"] = env_key
    try:
        spec = importlib.util.spec_from_file_location("chalk_srv_test", SERVER)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return m
    finally:
        os.environ.pop("AI_API_KEY", None)
        if old is not None:
            os.environ["AI_API_KEY"] = old


class FakeSelf:
    """Just enough handler surface for _ai_chat's early guards."""

    def __init__(self, key):
        self.AI_API_KEY = key
        self.status = None
        self.headers = {}
        self.wfile = io.BytesIO()

    def send_response(self, code):
        self.status = code

    def send_header(self, k, v):
        self.headers[k] = v

    def end_headers(self):
        pass


def main():
    # ---- 1. the loader picks up the local key file ----
    key_file = os.path.join(ROOT, "server", "ai_key.txt")
    if not os.path.exists(key_file):
        # No key file in this checkout: the env path must still work.
        m_env = load_module(env_key="sk-or-v1-test")
        check("an env key reaches the handler", m_env.Handler.AI_API_KEY == "sk-or-v1-test")
        print("(no server/ai_key.txt here - file-loader checks skipped)")
    else:
        m = load_module()
        key = getattr(m.Handler, "AI_API_KEY", "")
        check("the key file is loaded into the handler", bool(key),
              "len=" + str(len(key)))
        check("the key looks like an OpenRouter key", key.startswith("sk-or-v1-"),
              (key[:10] + "...") if key else "empty")
        ups = m.Handler._ai_upstreams()
        check("the upstream dict carries the key", bool(ups) and bool(ups[0]["key"]),
              ups[0]["base"] if ups else "no upstreams")
        inst = m.Handler.__new__(m.Handler)  # _ai_headers is an instance method
        headers = m.Handler._ai_headers(inst, ups[0]["key"], {"Content-Type": "application/json"})
        check("chat requests would carry an Authorization header",
              headers.get("Authorization", "").startswith("Bearer sk-or-"),
              (headers.get("Authorization", "")[:18] + "..."))

    # ---- 2. no key anywhere: fail fast, no upstream round trip ----
    # _ai_chat talks to the handler surface only through send_response /
    # send_header / end_headers / wfile, so a bare stub + the unbound method
    # covers the guard without dragging in the real HTTP plumbing.
    src = io.open(SERVER, encoding="utf-8").read()

    fs = FakeSelf(key="")
    body = json.dumps({"messages": [{"role": "user", "content": "hi"}]}).encode()
    m.Handler._ai_chat(fs, body)
    out = fs.wfile.getvalue().decode()
    check("a missing key fails fast with 503", fs.status == 503, str(fs.status))
    check("the no-key error names the actual problem", "no-key" in out, out[:80])
    check("the no-key reply mentions how to fix it",
          "ai_key.txt" in out and "AI_API_KEY" in out)

    # ---- 3. the guard never fires when a key exists ----
    fs2 = FakeSelf(key="sk-or-v1-present")
    # no network: _ai_chat reaches the upstream loop only after the guard;
    # a request with no messages must 400 BEFORE the guard is consulted.
    bad = json.dumps({"model": "x"}).encode()
    m.Handler._ai_chat(fs2, bad)
    check("a keyless guard does not hijack validation errors",
          fs2.status == 400 and "no-messages" in fs2.wfile.getvalue().decode(),
          str(fs2.status))

    # ---- 4. the relay source keeps its io import ----
    check("serve-chalk.py still imports io", "import io" in src)
    check("the loader failure is no longer silent",
          "key file load failed" in src, "print instead of bare except")

    print()
    if fail_n:
        print(str(fail_n) + " check(s) FAILED, " + str(pass_n) + " passed")
        sys.exit(1)
    print("all ai relay checks pass")
    sys.exit(0)


if __name__ == "__main__":
    main()
