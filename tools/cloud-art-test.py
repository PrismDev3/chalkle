#!/usr/bin/env python3
"""Chalkle cloud box-art test: the /api/cloud-art/* resolver in serve-chalk.py.

Run: python tools/cloud-art-test.py

Cloud tiles used to show a blank letter placeholder whenever a catalog
record's own img/cover URLs died, with no way to recover. These checks pin
the replacement pipeline: SteamGridDB -> IGDB -> Steam store search, with a
persistent cache, ordered fallbacks, structured failures for later patching,
and a fast no-key path. Everything runs against stubs - no upstream API is
ever contacted, so the suite is fast and network-free.
"""
import importlib.util
import io
import itertools
import json
import os
import shutil
import sys
import tempfile
import time

_case_n = itertools.count(1)

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


def load_module():
    spec = importlib.util.spec_from_file_location("chalk_srv_art", SERVER)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class FakeSelf:
    def __init__(self, path="/api/cloud-art/lookup?title=x"):
        self.path = path
        self.status = None
        self.headers = {}
        self.wfile = io.BytesIO()

    def send_response(self, code):
        self.status = code

    def send_header(self, k, v):
        self.headers[k] = v

    def end_headers(self):
        pass


def make_test_cls(base_cls, tmp):
    """A subclass of _CloudRelay with the cache pointed at a FRESH temp dir
    (each test needs its own disk store: the on-disk cache deliberately
    survives a restart, so sharing one dir would leak answers across tests)
    and the upstream fetchers stubbed per-test."""
    d = os.path.join(tmp, "case" + str(next(_case_n)))
    os.makedirs(d, exist_ok=True)

    class Art(base_cls):
        ART_DIR = d
        ART_FILE = os.path.join(d, "art.json")
        ART_FAILS = os.path.join(d, "failed.json")
        ART_LOG = os.path.join(d, "failed.log")
        _ART_STORE_CACHE = None
    Art._art_from_sgdb = classmethod(lambda cls, title: "")
    Art._art_from_igdb = classmethod(lambda cls, title: "")
    Art._art_from_steam = classmethod(lambda cls, title: "")
    return Art


def main():
    m = load_module()
    CR = m._CloudRelay
    tmp = tempfile.mkdtemp(prefix="chalkle-art-test-")
    try:
        # ---- 1. normalization: one title, one key, every spelling ----
        pairs = [
            ("Assassin's Creed: Odyssey", "assassins creed odyssey"),
            ("MARVEL'S Spider-Man Remastered", "marvels spider man remastered"),
            ("God of War: Ragnar\u00f6k", "god of war ragnarok"),
            ("DRAGON BALL: Sparking! ZERO", "dragon ball sparking zero"),
        ]
        for a, b in pairs:
            check("normalization folds " + a + " == " + b,
                  CR._art_norm(a) == CR._art_norm(b),
                  CR._art_norm(a))

        # ---- 2. pipeline priority: sgdb > igdb > steam ----
        Art = make_test_cls(CR, tmp)
        Art._art_from_sgdb = classmethod(lambda cls, t: "http://sgdb/" + t)
        Art._art_from_igdb = classmethod(lambda cls, t: "http://igdb/" + t)
        Art._art_from_steam = classmethod(lambda cls, t: "http://steam/" + t)
        url, source, err = Art._art_resolve("Priority Game")
        check("steamgriddb wins when it has the art",
              source == "sgdb" and "sgdb" in url, source)

        Art2 = make_test_cls(CR, tmp)
        Art2._art_from_igdb = classmethod(lambda cls, t: "http://igdb/" + t)
        Art2._art_from_steam = classmethod(lambda cls, t: "http://steam/" + t)
        url, source, err = Art2._art_resolve("Priority Game")
        check("igdb is the second fallback", source == "igdb", source)

        Art3 = make_test_cls(CR, tmp)
        Art3._art_from_steam = classmethod(
            lambda cls, t: "https://cdn.cloudflare.steamstatic.com/steam/apps/1551360/header.jpg")
        url, source, err = Art3._art_resolve("Priority Game")
        check("steam store search is the last fallback", source == "steam", source)

        # ---- 3. caching: second resolve never re-asks upstream ----
        calls = {"n": 0}

        def counting_steam(cls, t):
            calls["n"] += 1
            return "https://cdn.cloudflare.steamstatic.com/steam/apps/1/header.jpg"
        Art4 = make_test_cls(CR, tmp)
        Art4._art_from_steam = classmethod(counting_steam)
        Art4._art_resolve("Cached Game")
        Art4._art_resolve("Cached Game")
        check("a resolved title is served from the cache", calls["n"] == 1,
              "upstream calls: " + str(calls["n"]))

        # ---- 4. failures: recorded, structured, and retried after the TTL ----
        Art5 = make_test_cls(CR, tmp)
        url, source, err = Art5._art_resolve("No Such Game 999")
        check("a total miss returns no url", url == "" and source == "")
        check("a total miss carries a structured reason",
              bool(err) and "sgdb" in err and "steam" in err, (err or "")[:60])
        check("the failure was recorded in the store",
              "no such game 999" in Art5._art_store()["failed"])
        check("the failure was appended to the human log",
              os.path.exists(Art5.ART_LOG) and "No Such Game 999" in io.open(Art5.ART_LOG, encoding="utf-8").read())
        # Age the negative entry past the TTL and it must retry.
        store = Art5._art_store()
        store["failed"]["no such game 999"]["ts"] = time.time() - Art5.ART_NEG_TTL - 10
        calls2 = {"n": 0}

        def counting_steam2(cls, t):
            calls2["n"] += 1
            return ""
        Art5._art_from_steam = classmethod(counting_steam2)
        Art5._art_resolve("No Such Game 999")
        check("expired negatives are retried, not kept forever", calls2["n"] == 1)

        # ---- 5. the HTTP shape of /api/cloud-art/lookup ----
        Art6 = make_test_cls(CR, tmp)
        Art6._art_from_steam = classmethod(
            lambda cls, t: "https://cdn.cloudflare.steamstatic.com/steam/apps/2322010/header.jpg" if "ragnarok" in (t or "").lower() else "")

        def fake_handler(art_cls, path):
            # _cloud_art_get is an instance method; hand it a fake self whose
            # _art_resolve/_cloud_json delegate back to the test class.
            fs = FakeSelf(path)
            fs._art_resolve = lambda title: art_cls._art_resolve(title)
            fs._cloud_json = lambda obj, code=200: art_cls._cloud_json(fs, obj, code)
            return fs

        fs = fake_handler(Art6, "/api/cloud-art/lookup?title=God%20of%20War%20Ragnarok")
        Art6._cloud_art_get(fs)
        body = json.loads(fs.wfile.getvalue().decode())
        check("a hit answers ok with url and source",
              fs.status == 200 and body.get("ok") and body.get("url", "").startswith("https://")
              and body.get("source") == "steam", json.dumps(body)[:80])
        check("a hit carries a long browser cache",
              "max-age=" + str(int(CR.ART_TTL)) in fs.headers.get("Cache-Control", ""),
              fs.headers.get("Cache-Control"))

        fs2 = fake_handler(Art6, "/api/cloud-art/lookup?title=Zzqqx%20Blorbo%20999")
        Art6._cloud_art_get(fs2)
        body2 = json.loads(fs2.wfile.getvalue().decode())
        check("a miss answers no-art without crashing",
              fs2.status == 200 and not body2.get("ok") and body2.get("error") == "no-art",
              json.dumps(body2)[:80])
        check("a miss carries a short browser cache",
              "max-age=3600" in fs2.headers.get("Cache-Control", ""),
              fs2.headers.get("Cache-Control"))

        fs3 = fake_handler(Art6, "/api/cloud-art/lookup")
        Art6._cloud_art_get(fs3)
        check("a request without a title is refused", fs3.status == 400, str(fs3.status))

        # ---- 6. the steam matcher itself (store search payload, no network) ----
        payload = {"total": 2, "items": [
            {"type": "app", "name": "Fling to the Finish", "id": 1054430},
            {"type": "app", "name": "Something Else", "id": 999},
        ]}
        Art7 = make_test_cls(CR, tmp)
        Art7._art_http_json = staticmethod(lambda url, headers, timeout: payload)
        # Un-shadow: put the REAL matcher back on the subclass (class dicts
        # are read-only mappings, so rebind the underlying function).
        Art7._art_from_steam = classmethod(CR.__dict__["_art_from_steam"].__func__)
        got = Art7._art_from_steam("Fling to the Finish")
        check("steam store search matches an exact title",
              "1054430" in got, got)
        got = Art7._art_from_steam("Fling to Finish")   # catalog typo, no "the"
        check("stop-word variants still match", "1054430" in got, got)
        Art7b = make_test_cls(CR, tmp)
        Art7b._art_http_json = staticmethod(lambda url, headers, timeout: {"items": []})
        Art7b._art_from_steam = classmethod(CR.__dict__["_art_from_steam"].__func__)
        check("an empty result stays empty", Art7b._art_from_steam("Whatever") == "")

        # ---- 7. the client renders a skeleton, not a blank placeholder ----
        client = io.open(os.path.join(ROOT, "src", "cloud.js"), encoding="utf-8").read()
        check("the client asks the resolver lazily",
              "/api/cloud-art/lookup" in client and "data-art-title" in client)
        check("the client shows a skeleton while resolving",
              "thumb-skeleton" in client and "thumb-loading" in client)
        check("known misses stop asking but keep the letter tile",
              "ART_MEM[key] = url" in client.replace("\r\n", "\n"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if fail_n:
        print(str(fail_n) + " check(s) FAILED, " + str(pass_n) + " passed")
        sys.exit(1)
    print("all cloud art checks pass")
    sys.exit(0)


if __name__ == "__main__":
    main()
