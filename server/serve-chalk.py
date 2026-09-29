#!/usr/bin/env python3
"""Chalkle static server.

Serves this folder exactly like `python -m http.server 4173`, plus two
same-origin routes:

    GET /_active?s=<visitor_id>
        Registers the visitor and returns JSON with the number of distinct
        visitors that have pinged in the last ACTIVE_TTL seconds, so the
        header can show a genuine "people online right now" count shared
        across everyone behind the same Cloudflare quick tunnel.

    GET /_fetch?url=<encoded>
        Fetches the target URL server-side and returns its real HTTP status
        code as JSON. The URL Auditor uses this instead of flaky third-party
        CORS relays (allorigins & co. time out or get blocked), so dead /
        live checks are accurate and fast. Only http/https targets allowed.

    GET /res/<hex(target)>
        The built-in rewriting proxy. Fetches the target server-side, rewrites
        HTML/CSS so every URL flows back through /res/, strips
        CSP/X-Frame-Options, injects a small client patch
        (fetch/XHR/WebSocket/history) and serves it all from this same origin
        - so there is nothing separate for a filter to block and the route
        never goes stale the way a temporary tunnel does. WebSocket upgrade
        requests to /res/... are tunneled straight through.
"""
import io
import os
import re
import ssl
import json
import time
import mmap
import socket
import base64
import hashlib
import threading
import mimetypes
from urllib.parse import urljoin
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# WebAssembly (ScummVM runtime) needs the right MIME type for
# WebAssembly.compileStreaming to skip the arrayBuffer fallback.
try:
    mimetypes.add_type("application/wasm", ".wasm")
    mimetypes.add_type("application/zstd", ".zst")
except Exception:
    pass

HOST = "127.0.0.1"
WEB_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Paths the static handler and /_fetch must never serve. Tokens in the first
# group are matched anywhere, because a .git or .env inside a subfolder is
# still a leak. Tokens in the second group are ROOT directories and are
# anchored: matching "/build/" anywhere used to 404 /game-builds/<game>/Build/
# as well, which is where every Unity WebGL build keeps its loader, framework,
# wasm and data files, so those games all failed to boot with the loader 404.
_PRIVATE_ANYWHERE = ("/.git/", "/.env", "/.freebuff/")
_PRIVATE_ROOT_DIRS = ("/build/", "/server/", "/bitcord-backend/")


def denied_local_path(low):
    """True when a lowercased webroot path must stay unserved."""
    for token in _PRIVATE_ANYWHERE:
        if token in low:
            return True
    for token in _PRIVATE_ROOT_DIRS:
        if low.startswith(token) or low == token.rstrip("/"):
            return True
    return False
# lootline.xyz (apex) serves the Jexel tools hub from jexel/; the chalkle.
# subdomain and every other host (localhost, LAN, mirrors) keep serving the
# main site from the repo root. Requests to /jexel/... still resolve to the
# same folder on any host, so the hub also works at /jexel/ on the subdomain.
JEXEL_HOST = "lootline.xyz"
JEXEL_DIR = os.path.join(WEB_ROOT, "jexel")
# yut.lootline.xyz: yut's own upload site (yut/ folder). Pages and link lists
# are uploaded through /yut/api/* with a shared code, then stored on disk and
# served to everyone. The host split below serves the yut/ folder on that
# subdomain exactly like the Jexel hub split.
YUT_HOST = "yut.lootline.xyz"
YUT_DIR = os.path.join(WEB_ROOT, "yut")
YUT_API_PATH = "/yut/api/"
YUT_STORE_DIR = os.path.join(WEB_ROOT, "yut", "store")
YUT_REGISTRY = os.path.join(YUT_STORE_DIR, "registry.json")
YUT_CODE = "yutforyut25"
YUT_MAX_FILE = 64 * 1024 * 1024       # bytes per uploaded file
YUT_MAX_BATCH = 96 * 1024 * 1024      # bytes per small-batch upload request
# Chunked upload (for big single-file games). Cloudflare caps one request at
# 100 MB, so clients send large files as base64 parts of YUT_CHUNK bytes each;
# 16 MB of raw text is ~21.8 MB once base64-encoded, well under the cap.
YUT_CHUNK = 16 * 1024 * 1024
YUT_CHUNK_B64 = int(YUT_CHUNK * 4 / 3) + 1024
YUT_MAX_TOTAL = 512 * 1024 * 1024     # bytes across everything in the gallery
YUT_MAX_ITEMS = 200                   # files kept in the gallery
PORT = int(os.environ.get("CHALKLE_PORT", "4173"))
ACTIVE_TTL = 20          # seconds a visitor stays "online" after their last ping
PRUNE_EVERY = 4          # seconds between pruning expired visitors
PRUNE_AFTER = ACTIVE_TTL + 4

# visitor_id -> last-seen unix ts
STATE = {}
LOCK = threading.Lock()

# The registry is file-backed so EVERY server process shares one view of who
# is online. Multiple instances of this server can legitimately run at once
# (Windows lets them double-bind the port, and the tunnel/loopback split
# connections between them) - an in-memory dict gives each process a
# different, too-low count. A tiny JSON file on disk fixes that, and also
# survives restarts (stale rows prune by timestamp naturally).
ACTIVE_PATH = os.path.join(WEB_ROOT, "active-visitors.json")

# Launch counts per catalog key. One small JSON file next to the viewer
# registry, written with the same atomic replace, so every server process and
# every restart share one view of what people actually play.
PLAYS_PATH = os.path.join(WEB_ROOT, "play-counts.json")
PLAYS_LOCK = threading.Lock()
PLAYS_MAX_KEYS = 5000      # top N keys by total survive a save; the tail drops
PLAYS_TREND_DAYS = 7       # "trending" sums this many daily buckets
PLAYS_KEY_MAX = 120
PLAYS_BODY_MAX = 2048      # POST bodies are one tiny key; never read more


# ---------------------------------------------------------------- yut uploads
# yut.lootline.xyz backing API. yut uploads HTML pages and .txt link lists with
# the shared code; everyone else just reads. Registry is one JSON file, files
# are stored beside it named by id. Everything here is safe to call from any
# origin on GET (it is a public gallery) while writes need the code.

def _yut_clean_cat(v):
    """Category labels are free text from yut: trim, collapse spaces, drop
    control chars and angle brackets, cap the length."""
    s = re.sub(r"\s+", " ", str(v or "")).strip()
    s = "".join(ch for ch in s if ord(ch) >= 32 and ch not in "<>")
    return s[:24]


def _yut_registry_read():
    try:
        with open(YUT_REGISTRY, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return [it for it in data if isinstance(it, dict) and it.get("id")]
    except Exception:
        pass
    return []


def _yut_registry_write(items):
    os.makedirs(YUT_STORE_DIR, exist_ok=True)
    tmp = YUT_REGISTRY + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False)
    try:
        os.replace(tmp, YUT_REGISTRY)
    except OSError:
        # Windows os.replace can race with a reader; fall back to a plain write
        # rather than dropping the upload.
        with open(YUT_REGISTRY, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False)


def _yut_serve_file(self, item, download=False):
    path = os.path.join(YUT_STORE_DIR, item["id"])
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except Exception:
        self.send_response(404)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        try:
            self.wfile.write(b"not found")
        except Exception:
            pass
        return
    if item.get("kind") == "html":
        mime = "text/html; charset=utf-8"
    else:
        mime = "text/plain; charset=utf-8"
    self.send_response(200)
    self.send_header("Content-Type", mime)
    self.send_header("Access-Control-Allow-Origin", "*")
    if download:
        safe = "".join(c for c in str(item.get("name", "file")) if c not in '\"/:*?<>|\\\\') or "file"
        self.send_header("Content-Disposition", 'attachment; filename="%s.%s"' % (safe, "html" if item.get("kind") == "html" else "txt"))
    self.send_header("Content-Length", str(len(raw)))
    self.end_headers()
    self.wfile.write(raw)


def _yut_api(self, route):
    """Router for /yut/api/*. Returns True when the route was handled."""
    rest = route[len(YUT_API_PATH):]
    if not rest or rest == "list":
        items = _yut_registry_read()
        # ids only go out with names/kinds; no file content ships in the list
        self._json_out({"ok": True, "items": items})
        return True
    if rest.startswith("list-preview/"):
        fid = rest[len("list-preview/"):]
        if not re.fullmatch(r"[a-f0-9]{16}", fid or ""):
            self._json_out({"ok": False, "error": "bad-id"}, 400)
            return True
        # The list viewer asks for a small first page instead of downloading a
        # multi-megabyte .txt before it can paint the modal.
        query = {}
        if "?" in self.path:
            query = urllib.parse.parse_qs(self.path.split("?", 1)[1])
        try:
            limit = max(1, min(100, int((query.get("limit") or ["100"])[0])))
        except Exception:
            limit = 100
        for it in _yut_registry_read():
            if it.get("id") == fid:
                return _yut_list_preview(self, it, limit)
        self._json_out({"ok": False, "error": "not-found"}, 404)
        return True
    if rest.startswith("file/"):
        fid = rest[len("file/"):]
        if not re.fullmatch(r"[a-f0-9]{16}", fid or ""):
            self._json_out({"ok": False, "error": "bad-id"}, 400)
            return True
        for it in _yut_registry_read():
            if it.get("id") == fid:
                _yut_serve_file(self, it)
                return True
        self._json_out({"ok": False, "error": "not-found"}, 404)
        return True
    if rest.startswith("download/"):
        fid = rest[len("download/"):]
        if not re.fullmatch(r"[a-f0-9]{16}", fid or ""):
            self._json_out({"ok": False, "error": "bad-id"}, 400)
            return True
        for it in _yut_registry_read():
            if it.get("id") == fid:
                _yut_serve_file(self, it, download=True)
                return True
        self._json_out({"ok": False, "error": "not-found"}, 404)
        return True
    if rest == "upload":
        return _yut_upload(self)
    if rest.startswith("chunk/"):
        sub, _, sid = rest[len("chunk/"):].partition("/")
        if sub == "start":
            return _yut_chunk_start(self)
        if sub == "part" and sid:
            return _yut_chunk_put(self, sid)
        if sub == "done" and sid:
            return _yut_chunk_complete(self, sid)
        return self._json_out({"ok": False, "error": "bad-route"}, 404)
    if rest == "recat":
        return _yut_recat(self)
    if rest == "remove":
        return _yut_remove(self)
    self._json_out({"ok": False, "error": "bad-route"}, 404)
    return True


def _yut_read_json_body(self):
    length = int(self.headers.get("Content-Length", 0) or 0)
    if length <= 0 or length > YUT_MAX_BATCH + 4096:
        return None
    try:
        return json.loads(self.rfile.read(length).decode("utf-8", "replace"))
    except Exception:
        return None


def _yut_upload(self):
    import secrets
    body = _yut_read_json_body(self)
    if not isinstance(body, dict):
        return self._json_out({"ok": False, "error": "bad-body"}, 400)
    if str(body.get("code", "")) != YUT_CODE:
        return self._json_out({"ok": False, "error": "bad-code"}, 403)
    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        return self._json_out({"ok": False, "error": "no-items"}, 400)
    if len(raw_items) > 10:
        return self._json_out({"ok": False, "error": "too-many-files"}, 400)
    items = _yut_registry_read()
    total = 0
    added = []
    cat = _yut_clean_cat(body.get("cat"))
    with LOCK:
        try:
            os.makedirs(YUT_STORE_DIR, exist_ok=True)
        except Exception:
            return self._json_out({"ok": False, "error": "store-unavailable"}, 500)
        for raw in raw_items:
            if not isinstance(raw, dict) or total > YUT_MAX_BATCH:
                continue
            name = str(raw.get("name", "")).strip()[:60]
            kind = raw.get("kind")
            text = raw.get("text")
            if not name or kind not in ("html", "list") or not isinstance(text, str) or not text:
                continue
            if len(text.encode("utf-8")) > YUT_MAX_FILE:
                continue
            fid = secrets.token_hex(8)
            entry = {
                "id": fid,
                "name": name,
                "kind": kind,
                "ts": int(time.time() * 1000),
                "size": len(text.encode("utf-8")),
                "links": 0,
            }
            # Per-item category first (how the uploader sends it), then the
            # batch-level field for older clients.
            item_cat = _yut_clean_cat(raw.get("cat")) or cat
            if item_cat:
                entry["cat"] = item_cat
            if kind == "list":
                # count unique http(s) links the same way the viewer will show them
                seen = set()
                for line in text.splitlines():
                    s = line.strip()
                    if not s or s.startswith("#"):
                        continue
                    if not re.match(r"^https?://", s, re.I):
                        s = "https://" + s
                    if re.match(r"^https?://[^\s/$.?#].\S*$", s, re.I):
                        seen.add(s)
                entry["links"] = len(seen)
            try:
                with open(os.path.join(YUT_STORE_DIR, fid), "w", encoding="utf-8") as f:
                    f.write(text)
            except Exception:
                continue
            added.append(entry)
            total += entry["size"]
        if added:
            items = added + items
            # cap the gallery: oldest dropped entries lose their files too
            while len(items) > YUT_MAX_ITEMS:
                old = items.pop()
                try:
                    os.remove(os.path.join(YUT_STORE_DIR, old.get("id", "")))
                except Exception:
                    pass
            _yut_registry_write(items)
    return self._json_out({"ok": True, "added": len(added), "total": len(items)})


def _yut_chunk_body(self, limit):
    """Read a JSON body up to `limit` bytes (larger than _yut_read_json_body
    allows). Returns the parsed dict or None."""
    length = int(self.headers.get("Content-Length", 0) or 0)
    if length <= 0 or length > limit:
        return None
    try:
        return json.loads(self.rfile.read(length).decode("utf-8", "replace"))
    except Exception:
        return None


def _yut_enforce_quota(self, incoming):
    """Keep the whole store under YUT_MAX_TOTAL. Evicts oldest entries until
    the new bytes fit. Returns False (after answering) when one file alone
    can never fit."""
    if incoming > YUT_MAX_TOTAL:
        self._json_out({"ok": False, "error": "too-large"}, 413)
        return False
    with LOCK:
        items = _yut_registry_read()
        used = sum(int(it.get("size", 0)) for it in items)
        while items and used + incoming > YUT_MAX_TOTAL:
            old = items.pop()
            used -= int(old.get("size", 0))
            try:
                os.remove(os.path.join(YUT_STORE_DIR, old.get("id", "")))
            except Exception:
                pass
        if items:
            _yut_registry_write(items)
    return True


def _yut_chunk_start(self):
    """Begin a chunked upload: {code, name, kind, size, total?, cat?} ->
    {ok, sid, chunk}. The session lives in tmp/ until complete or abandoned."""
    import secrets
    body = _yut_chunk_body(self, 64 * 1024)
    if not isinstance(body, dict):
        return self._json_out({"ok": False, "error": "bad-body"}, 400)
    if str(body.get("code", "")) != YUT_CODE:
        return self._json_out({"ok": False, "error": "bad-code"}, 403)
    name = str(body.get("name", "")).strip()[:60]
    kind = body.get("kind")
    size = int(body.get("size", 0) or 0)
    if not name or kind not in ("html", "list") or size <= 0:
        return self._json_out({"ok": False, "error": "bad-meta"}, 400)
    if size > YUT_MAX_FILE:
        return self._json_out({"ok": False, "error": "too-large"}, 413)
    if not _yut_enforce_quota(self, size):
        return True
    sid = secrets.token_hex(8)
    meta = {
        "name": name,
        "kind": kind,
        "size": size,
        "cat": _yut_clean_cat(body.get("cat")),
        "received": 0,
    }
    try:
        os.makedirs(YUT_STORE_DIR, exist_ok=True)
        with open(os.path.join(YUT_STORE_DIR, sid + ".part"), "wb") as f:
            pass
        with open(os.path.join(YUT_STORE_DIR, sid + ".meta"), "w", encoding="utf-8") as f:
            json.dump(meta, f)
    except Exception:
        return self._json_out({"ok": False, "error": "store-unavailable"}, 500)
    return self._json_out({"ok": True, "sid": sid, "chunk": YUT_CHUNK})


def _yut_chunk_put(self, sid):
    """Append one base64 chunk: {code, index, data}. data decodes to at most
    YUT_CHUNK raw bytes."""
    body = _yut_chunk_body(self, YUT_CHUNK_B64 + 4096)
    if not isinstance(body, dict):
        return self._json_out({"ok": False, "error": "bad-body"}, 400)
    if str(body.get("code", "")) != YUT_CODE:
        return self._json_out({"ok": False, "error": "bad-code"}, 403)
    if not re.fullmatch(r"[a-f0-9]{16}", sid or ""):
        return self._json_out({"ok": False, "error": "bad-id"}, 400)
    meta_path = os.path.join(YUT_STORE_DIR, sid + ".meta")
    part_path = os.path.join(YUT_STORE_DIR, sid + ".part")
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:
        return self._json_out({"ok": False, "error": "not-found"}, 404)
    try:
        data = base64.b64decode(str(body.get("data", "")), validate=True)
    except Exception:
        return self._json_out({"ok": False, "error": "bad-data"}, 400)
    if not data or len(data) > YUT_CHUNK:
        return self._json_out({"ok": False, "error": "bad-data"}, 400)
    if meta.get("received", 0) + len(data) > meta.get("size", 0):
        return self._json_out({"ok": False, "error": "too-much-data"}, 400)
    try:
        with open(part_path, "ab") as f:
            f.write(data)
        meta["received"] = meta.get("received", 0) + len(data)
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f)
    except Exception:
        return self._json_out({"ok": False, "error": "store-unavailable"}, 500)
    return self._json_out({"ok": True, "received": meta["received"], "size": meta.get("size", 0)})


def _yut_chunk_complete(self, sid):
    """Finish a chunked upload: verify every byte arrived, register the item
    and serve it like any other file."""
    body = _yut_chunk_body(self, 4096)
    if not isinstance(body, dict) or str(body.get("code", "")) != YUT_CODE:
        return self._json_out({"ok": False, "error": "bad-code"}, 403)
    if not re.fullmatch(r"[a-f0-9]{16}", sid or ""):
        return self._json_out({"ok": False, "error": "bad-id"}, 400)
    meta_path = os.path.join(YUT_STORE_DIR, sid + ".meta")
    part_path = os.path.join(YUT_STORE_DIR, sid + ".part")
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:
        return self._json_out({"ok": False, "error": "not-found"}, 404)
    try:
        actual = os.path.getsize(part_path)
    except Exception:
        actual = -1
    if actual != int(meta.get("size", -1)):
        # missing or corrupt transfer: drop the parts so the client can retry
        for p in (part_path, meta_path):
            try:
                os.remove(p)
            except Exception:
                pass
        return self._json_out({"ok": False, "error": "incomplete", "received": max(actual, 0)}, 409)
    fid = sid  # the session id doubles as the file id
    try:
        os.replace(part_path, os.path.join(YUT_STORE_DIR, fid))
        os.remove(meta_path)
    except Exception:
        return self._json_out({"ok": False, "error": "store-unavailable"}, 500)
    entry = {
        "id": fid,
        "name": meta.get("name", "file"),
        "kind": meta.get("kind", "html"),
        "ts": int(time.time() * 1000),
        "size": int(meta.get("size", 0)),
        "links": 0,
    }
    if meta.get("cat"):
        entry["cat"] = meta["cat"]
    with LOCK:
        items = [entry] + _yut_registry_read()
        while len(items) > YUT_MAX_ITEMS:
            old = items.pop()
            try:
                os.remove(os.path.join(YUT_STORE_DIR, old.get("id", "")))
            except Exception:
                pass
        _yut_registry_write(items)
    return self._json_out({"ok": True, "id": fid, "total": len(items)})


def _yut_list_preview(self, item, limit=100):
    """Return only the first `limit` normalized unique links from a list file.
    This keeps the list modal responsive even for 10+ MB uploads. The full
    file remains available through /file and is fetched only for Copy all."""
    path = os.path.join(YUT_STORE_DIR, item["id"])
    links = []
    seen = set()
    has_more = False
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#"):
                    continue
                if not re.match(r"^https?://", s, re.I):
                    s = "https://" + s
                if not re.match(r"^https?://[^\s/$.?#].\S*$", s, re.I):
                    continue
                if s in seen:
                    continue
                seen.add(s)
                if len(links) < limit:
                    links.append(s)
                else:
                    has_more = True
                    break
    except Exception:
        self._json_out({"ok": False, "error": "not-found"}, 404)
        return True
    stored_total = int(item.get("links", 0) or 0)
    total_known = stored_total > len(links) or not has_more
    total = stored_total if total_known else len(links)
    self._json_out({
        "ok": True,
        "name": item.get("name", "List"),
        "links": links,
        "total": total,
        "totalKnown": total_known,
        "hasMore": has_more or stored_total > len(links)
    })
    return True


def _yut_recat(self):
    """Change the category on one item. Same code gate as remove."""
    body = _yut_read_json_body(self)
    if not isinstance(body, dict):
        return self._json_out({"ok": False, "error": "bad-body"}, 400)
    if str(body.get("code", "")) != YUT_CODE:
        return self._json_out({"ok": False, "error": "bad-code"}, 403)
    fid = str(body.get("id", ""))
    if not re.fullmatch(r"[a-f0-9]{16}", fid):
        return self._json_out({"ok": False, "error": "bad-id"}, 400)
    cat = _yut_clean_cat(body.get("cat"))
    with LOCK:
        items = _yut_registry_read()
        hit = None
        for it in items:
            if it.get("id") == fid:
                hit = it
                break
        if hit is None:
            return self._json_out({"ok": False, "error": "not-found"}, 404)
        if cat:
            hit["cat"] = cat
        else:
            hit.pop("cat", None)
        _yut_registry_write(items)
    return self._json_out({"ok": True, "cat": cat})


def _yut_startup_purge():
    """Drop registry entries whose file is missing. Two server processes can
    legitimately run at once on Windows (double-bound port), and a lost
    read-modify-write race could otherwise resurrect cards whose files were
    deleted, leaving visitors staring at not-found errors."""
    try:
        items = _yut_registry_read()
        kept = [it for it in items
                if os.path.isfile(os.path.join(YUT_STORE_DIR, str(it.get("id", ""))))]
        if len(kept) != len(items):
            _yut_registry_write(kept)
    except Exception:
        pass


def _yut_remove(self):
    body = _yut_read_json_body(self)
    if not isinstance(body, dict):
        return self._json_out({"ok": False, "error": "bad-body"}, 400)
    if str(body.get("code", "")) != YUT_CODE:
        return self._json_out({"ok": False, "error": "bad-code"}, 403)
    fid = str(body.get("id", ""))
    if not re.fullmatch(r"[a-f0-9]{16}", fid):
        return self._json_out({"ok": False, "error": "bad-id"}, 400)
    with LOCK:
        items = _yut_registry_read()
        kept = [it for it in items if it.get("id") != fid]
        if len(kept) == len(items):
            return self._json_out({"ok": False, "error": "not-found"}, 404)
        try:
            os.remove(os.path.join(YUT_STORE_DIR, fid))
        except Exception:
            pass
        _yut_registry_write(kept)
    return self._json_out({"ok": True})


_SURROGATE_RE = re.compile("[\ud800-\udfff]")


def _scrub_surrogates(obj):
    """Replace lone surrogates with U+FFFD, recursively.

    Shared state is assembled from third-party pages, so a title or thumbnail
    can arrive half-decoded: JSON like "\\ud800" with no matching low surrogate
    parses into a lone surrogate character. json.dumps(..., ensure_ascii=False)
    writes that character back out verbatim, and .encode("utf-8") then raises
    UnicodeEncodeError. That is worth a helper of its own because of where it
    used to land: the bare `except` in _sanitize_sync_blob caught the encode
    error and returned the RAW blob, so one bad character anywhere in the
    shared state silently disabled the entire library filter and removed titles
    came back on every device. Scrub before dumping so the encode cannot fail.
    """
    if isinstance(obj, str):
        return _SURROGATE_RE.sub("\ufffd", obj) if _SURROGATE_RE.search(obj) else obj
    if isinstance(obj, list):
        return [_scrub_surrogates(v) for v in obj]
    if isinstance(obj, dict):
        return {
            (_scrub_surrogates(k) if isinstance(k, str) else k): _scrub_surrogates(v)
            for k, v in obj.items()
        }
    return obj


def _sanitize_sync_blob(raw: bytes) -> bytes:
    """Sync relay sanitizer: the relay used to echo client state verbatim, so
    any visitor's stale library resurrected deleted junk titles (bad 'Examples'
    placeholders, Scratch embeds, broken 1v1/Arena/2048-Cupcakes style entries)
    into every other visitor's library. Filter the gamelib on both GET and POST
    so removed entries stay removed no matter what clients send."""
    try:
        d = json.loads(raw.decode("utf-8"))
    except Exception:
        # Not JSON we can read at all - hand it back untouched rather than
        # inventing a payload.
        return raw
    try:
        if isinstance(d, dict) and isinstance(d.get("chalkle-gamelib-v4"), str):
            lib = json.loads(d["chalkle-gamelib-v4"])
            if isinstance(lib, list) and lib and isinstance(lib[0], dict):
                kept = [
                    g for g in lib
                    if isinstance(g, dict) and _lib_entry_ok(g)
                ]
                d["chalkle-gamelib-v4"] = json.dumps(kept, separators=(",", ":"), ensure_ascii=False)
    except Exception:
        # A malformed library must not take the whole relay down. Everything
        # else in the blob is still scrubbed and re-encoded below, and the
        # encode itself can no longer fail, so this can never fall through to
        # serving the filter-bypassing raw bytes.
        pass
    return json.dumps(_scrub_surrogates(d), ensure_ascii=False).encode("utf-8", "replace")


_BAD_TITLE_BITS = (
    "achievmentunlocked", "achievement unlocked", "scratch", "games -3", "games -b",
    "cat hear", "pagetitle", "maybeidk", "10-103nk", "13 days in hell", "1v1.space",
    "2048 cupcakes", "2048 lite", "3d car driver", "agario minigame", "amberial",
    "all boss 1", "admist the sky", "arsonaate", "asriel dreemurr", "attogram",
    "ballz |", "bearsus", "big neon tower", "big neon", "1 v 1 maybe",
    "$(", "${",
)
# junk titles that must match EXACTLY (substrings would kill legit games:
# "arena" hits Quake III Arena / Thing-Thing Arena 3, "guard" hits Lifeguard)
_BAD_TITLES_EXACT = {"arena", "guard"}
_BAD_URL_BITS = (
    "scratch.mit.edu", "turbowarp.org", "clarena.html", "clbadbodyguards.html",
    "clballz.html", "clbearsus.html", "cl2048cupcakes.html", "cl1v1maybeidk.html",
    "clnullkevin.html", "clmotox3mm.html", "clachievmentunlocked.html",
    "clachievementunlocked.html", "clbntts.html", "clbigneontowertinysquare.html",
    "clallbossesin1.html", "cl1v1.html", "terrariamods-scratch",
    "clbuckshotroulette.html", "clarena", "geodash", "amberial.swf",
    "13-days-in-hell.swf", "3D-Car-Driver.swf", "agario-minigame",
    "1v1space", "asriel_fight",
)


def _lib_entry_ok(g) -> bool:
    t = str(g.get("title") or "").strip()
    tl = t.lower()
    u = str(g.get("url") or "").lower()
    if len(t) < 2:
        return False
    if tl in _BAD_TITLES_EXACT:
        return False
    if any(b in tl for b in _BAD_TITLE_BITS) or any(b in u for b in _BAD_URL_BITS):
        return False
    return True


def _active_load():
    try:
        with open(ACTIVE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _active_save(state):
    # Atomic replace: a concurrent reader never sees a half-written file.
    tmp = ACTIVE_PATH + ".tmp-" + str(os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.replace(tmp, ACTIVE_PATH)
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass


def _prune():
    now = time.time()
    with LOCK:
        expired = [k for k, ts in STATE.items() if now - ts > PRUNE_AFTER]
        for k in expired:
            STATE.pop(k, None)
        try:
            disk = _active_load()
            dirty = False
            for k in [k for k, ts in disk.items() if now - ts > PRUNE_AFTER]:
                disk.pop(k, None)
                dirty = True
            if dirty:
                _active_save(disk)
        except Exception:
            pass


_SID_OK = re.compile(r"[^A-Za-z0-9_.-]")


def _active_clean_sid(sid):
    """Keep ids short and boring: a hand-written query string cannot stuff
    junk keys into the registry, and two ids never differ only by characters
    we would strip anyway."""
    if not isinstance(sid, str):
        return ""
    return _SID_OK.sub("", sid)[:64]


def _active_touch(sid):
    """Mark a visitor online in the shared registry."""
    sid = _active_clean_sid(sid)
    if not sid:
        return
    now = time.time()
    with LOCK:
        STATE[sid] = now
        disk = _active_load()
        disk[sid] = now
        for k in [k for k, ts in disk.items() if now - ts > PRUNE_AFTER]:
            disk.pop(k, None)
        _active_save(disk)


def _active_remove(sid):
    """Drop a visitor immediately (tab closed / navigated away) instead of
    letting the session linger until the TTL expires and inflate the count
    with a ghost."""
    sid = _active_clean_sid(sid)
    if not sid:
        return
    now = time.time()
    with LOCK:
        STATE.pop(sid, None)
        disk = _active_load()
        if sid in disk:
            disk.pop(sid, None)
            for k in [k for k, ts in disk.items() if now - ts > PRUNE_AFTER]:
                disk.pop(k, None)
            _active_save(disk)


def _active_boot_purge():
    """On startup the registry may hold sessions from a previous run that
    ended hours ago; nothing overwrote the file while the server was down.
    Drop everything older than the TTL so the count starts honest. Sessions
    that re-ping simply re-add themselves."""
    now = time.time()
    with LOCK:
        STATE.clear()
        try:
            disk = _active_load()
        except Exception:
            return
        keep = {k: ts for k, ts in disk.items() if now - ts <= ACTIVE_TTL}
        if len(keep) != len(disk):
            _active_save(keep)


def _active_count():
    now = time.time()
    with LOCK:
        disk = _active_load()
        # Union of this process's live sessions and the shared file: whichever
        # process handled the last ping, everyone reads the same total.
        seen = {}
        for src in (STATE, disk):
            for k, ts in src.items():
                if now - ts <= ACTIVE_TTL and (k not in seen or ts > seen[k]):
                    seen[k] = ts
        return len(seen)


def _active_has(sid):
    """True when sid is part of the current live count."""
    now = time.time()
    if not sid:
        return False
    with LOCK:
        if now - STATE.get(sid, 0) <= ACTIVE_TTL:
            return True
        disk = _active_load()
        return now - disk.get(sid, 0) <= ACTIVE_TTL


def _plays_today():
    return time.strftime("%Y-%m-%d", time.gmtime())


def _plays_clean_key(key):
    """Catalog keys are slugs and URLs from our own library. Trim control
    characters and cap the length so a hand-written POST cannot stuff junk
    into the store or the JSON file."""
    if not isinstance(key, str):
        return ""
    s = "".join(ch for ch in key if ord(ch) >= 32).strip()
    return s[:PLAYS_KEY_MAX]


def _plays_load():
    """{v, total: {key: n}, days: {"YYYY-MM-DD": {key: n}}}, normalized.

    Anything malformed in the file (hand edited, half written by an old
    version) is dropped rather than trusted, so one bad row cannot break the
    games grid.
    """
    blank = {"v": 1, "total": {}, "days": {}}
    try:
        with open(PLAYS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return blank
    if not isinstance(data, dict):
        return blank
    out = {"v": 1, "total": {}, "days": {}}
    total = data.get("total")
    if isinstance(total, dict):
        for k, v in total.items():
            k = _plays_clean_key(k)
            if k and isinstance(v, int) and v > 0:
                out["total"][k] = v
    days = data.get("days")
    if isinstance(days, dict):
        for day, bucket in days.items():
            if not isinstance(bucket, dict) or not re.match(r"^\d{4}-\d{2}-\d{2}$", str(day)):
                continue
            clean = {}
            for k, v in bucket.items():
                k = _plays_clean_key(k)
                if k and isinstance(v, int) and v > 0:
                    clean[k] = v
            if clean:
                out["days"][str(day)] = clean
    return out


def _plays_save(state):
    # Bound the file: newest PLAYS_TREND_DAYS buckets, then the most played
    # keys. A save is the only place this trims, so reads stay cheap.
    days = state.get("days") or {}
    keep = sorted(days.keys())[-PLAYS_TREND_DAYS:]
    state["days"] = {d: days[d] for d in keep}
    total = state.get("total") or {}
    if len(total) > PLAYS_MAX_KEYS:
        state["total"] = dict(sorted(total.items(), key=lambda kv: (-kv[1], kv[0]))[:PLAYS_MAX_KEYS])
    tmp = PLAYS_PATH + ".tmp-" + str(os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.replace(tmp, PLAYS_PATH)
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass


def _plays_trending(state):
    """Plays per key across the retained day buckets."""
    out = {}
    for bucket in (state.get("days") or {}).values():
        for k, v in bucket.items():
            out[k] = out.get(k, 0) + v
    return out


def _plays_payload(state=None):
    state = state if state is not None else _plays_load()
    return {
        "ok": True,
        "plays": state.get("total") or {},
        "trending": _plays_trending(state),
        "days": PLAYS_TREND_DAYS,
        "updated": int(time.time()),
    }


def _plays_report(key):
    """Count one launch and answer with the fresh totals for that key."""
    key = _plays_clean_key(key)
    if not key:
        return {"ok": False, "error": "bad-key"}
    with PLAYS_LOCK:
        state = _plays_load()
        total = state.setdefault("total", {})
        total[key] = int(total.get(key, 0)) + 1
        days = state.setdefault("days", {})
        today = days.setdefault(_plays_today(), {})
        today[key] = int(today.get(key, 0)) + 1
        _plays_save(state)
        return {
            "ok": True,
            "key": key,
            "count": total[key],
            "trending": _plays_trending(state).get(key, 0),
        }


# ------------------------------------------------- same-origin write guard
# Static mirrors (jsDelivr, github.io, ...) are supposed to POST here for
# /_sync, the ad-free state sync and the admin saves, so their origins count
# as first-party. Same list runtime-config.js uses to detect a mirror.
_MIRROR_HOST_RE = re.compile(
    r"(?:^|\.)(?:jsdelivr\.net|githack\.com|staticdelivr\.com|unpkg\.com|esm\.sh"
    r"|github\.io|pages\.dev|gitlab\.io|githubusercontent\.com|vercel\.app"
    r"|netlify\.app|esm\.lootline\.xyz)$", re.I)


def _host_only(value):
    """The bare hostname out of a Host header or an origin string.

    urlsplit handles the shapes a header can take ("host:port", "[::1]:port",
    a full origin URL), and .hostname lowercases it and drops the port and the
    IPv6 brackets - which is exactly what makes "[::1]:4199" comparable to
    "[::1]:4199".
    """
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        if "//" not in raw:
            raw = "//" + raw
        return urllib.parse.urlsplit(raw).hostname or ""
    except Exception:
        return ""


def state_post_allowed(origin, host_header, xrw):
    """May this POST change server state?

    A browser attaches Origin to every same-origin POST, so the old host
    comparison was the whole guard instead of a formality. It read
    urlsplit(origin).host, which does not exist (the attribute is .hostname),
    so the comparison always failed and refused every legitimate browser write
    to /_sync, /api/ai/chat, /api/proxy/backend and friends with a 403. This
    version uses a real hostname and pins both halves in
    tools/state-post-test.py.
    """
    origin = str(origin or "").strip()
    marker = bool(str(xrw or "").strip())
    if not origin or origin == "null":
        # No Origin (curl, older tooling) or an opaque origin (file://, a
        # sandboxed iframe): only the marker header proves a first-party call.
        return marker
    ohost = _host_only(origin)
    if not ohost:
        return False
    return ohost == _host_only(host_header) or bool(_MIRROR_HOST_RE.search(ohost))


def _pruner():
    while True:
        time.sleep(PRUNE_EVERY)
        _prune()


# ---------------------------------------------------------------- /cloud relay
# Same-origin relay to the Stratus API (cloud gaming). The site is served over
# an https quick-tunnel, so the browser can never call a local http:// Stratus
# directly (mixed content) and remote visitors can't reach localhost at all.
# Every /cloud/v1/* request is forwarded server-side to CLOUD_BACKEND, and the
# WebRTC signaling websocket is tunneled through this origin too. The x-api-key
# is injected here (never visible to the page) unless the client sends its own.

CLOUD_BACKEND_DEFAULT = "http://127.0.0.1:3001"
START_TIME = time.time()
# Chalkle VM: static Firefox-WASM build in vm/ + wisp relay on 3002.
VM_ROOT = os.path.join(WEB_ROOT, "vm")
VM_WISP_BACKEND = "http://127.0.0.1:3002"
CLOUD_API_KEY_DEFAULT = "sk_chalkle_local_7f2c9a"
CLOUD_CFG_PATH = os.path.join(WEB_ROOT, "cloud-relay.json")
CLOUD_PATH_RE = re.compile(r"^/cloud/v1/(getQueue|embed-data)$")
CLOUD_WS_RE = re.compile(r"^/cloud/v1/signal/([0-9a-f-]{36})$", re.I)
CLOUD_CFG_LOOPBACK_RE = re.compile(r"^https?://(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$", re.I)

_cloud_cfg_cache = {"m": 0, "cfg": {}}


def _cloud_cfg():
    """Relay configuration: cloud-relay.json (set from the site's Settings
    panel) overrides the env vars, which override the defaults."""
    try:
        m = os.path.getmtime(CLOUD_CFG_PATH)
    except OSError:
        m = 0
    cache = _cloud_cfg_cache
    if m and m != cache["m"]:
        try:
            with open(CLOUD_CFG_PATH, "r", encoding="utf-8") as f:
                cache["cfg"] = json.load(f) or {}
        except Exception:
            cache["cfg"] = {}
        cache["m"] = m
    cfg = cache.get("cfg") or {}
    base = (str(cfg.get("base") or "").strip() or os.environ.get("STRATUS_BACKEND", "")).rstrip("/")
    key = str(cfg.get("key") or "").strip() or os.environ.get("STRATUS_API_KEY", "")
    return {"base": base or CLOUD_BACKEND_DEFAULT, "key": key or CLOUD_API_KEY_DEFAULT}


def _cloud_ws_target(route):
    """Map a same-origin /cloud/v1/signal/<uuid> upgrade to the backend."""
    m = CLOUD_WS_RE.match(route)
    if not m:
        return None
    backend = _cloud_cfg()["base"]
    host = backend.replace("https://", "").replace("http://", "")
    scheme = "wss" if backend.startswith("https") else "ws"
    return f"{scheme}://{host}/cloud/v1/signal/{m.group(1)}"


class _CloudRelay:
    """Mixin with the cloud proxy handlers; combined into Handler below."""

    # ---------------- cloud game box art (/api/cloud-art/*) ----------------
    # Cloud tiles used to show a blank letter placeholder whenever the catalog
    # record's own img/cover URLs were dead. This resolver fills those gaps:
    # SteamGridDB first (the standard indie-launcher source), then IGDB, then
    # Steam's own CDN via a name->appid lookup. Results are cached on disk so
    # a 3,520-game library re-fetches nothing on every load, and failed
    # lookups land in a log file so missing art can be patched by hand later.
    # Keys are optional: SGDB/IGDB are only consulted when their key files
    # exist (server/sgdb_key.txt, server/igdb_key.txt with client-id on the
    # first line), and the plain-Steam fallback always runs.

    ART_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "art-cache")
    ART_FILE = os.path.join(ART_DIR, "art.json")
    ART_FAILS = os.path.join(ART_DIR, "failed.json")
    ART_LOG = os.path.join(ART_DIR, "failed.log")
    ART_SGDB_KEY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sgdb_key.txt")
    ART_IGDB_KEY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "igdb_key.txt")
    ART_TTL = 30 * 24 * 3600.0        # resolved art entries live 30 days
    ART_NEG_TTL = 24 * 3600.0         # "no art found" entries retry after a day
    ART_UPSTREAM_TIMEOUT = 8
    ART_LOCK = threading.Lock()

    @staticmethod
    def _art_norm(title):
        """Normalize a game title into a lookup key: lowercase, accent-stripped,
        punctuation-collapsed. The same title spelled two ways must map to one
        cache entry."""
        import unicodedata
        s = str(title or "").lower()
        try:
            s = unicodedata.normalize("NFKD", s)
            s = "".join(ch for ch in s if not unicodedata.combining(ch))
        except Exception:
            pass
        # Apostrophes vanish first so possessives survive tokenization:
        # "Assassin's" and "Assassins" must both become "assassins".
        s = s.replace("\u2019", "").replace("'", "")
        s = re.sub(r"[^a-z0-9]+", " ", s).strip()
        return s

    @classmethod
    def _art_store(cls):
        if getattr(cls, "_ART_STORE_CACHE", None) is not None:
            return cls._ART_STORE_CACHE
        store = {"v": 1, "resolved": {}, "failed": {}}
        try:
            if os.path.exists(cls.ART_FILE):
                with io.open(cls.ART_FILE, encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict):
                    if isinstance(loaded.get("resolved"), dict):
                        store["resolved"] = loaded["resolved"]
                    if isinstance(loaded.get("failed"), dict):
                        store["failed"] = loaded["failed"]
        except Exception as e:
            print("[cloud-art] store load failed:", type(e).__name__, e)
        cls._ART_STORE_CACHE = store
        return store

    @classmethod
    def _art_store_save(cls):
        store = cls._art_store()
        try:
            os.makedirs(cls.ART_DIR, exist_ok=True)
            tmp = cls.ART_FILE + ".tmp"
            with io.open(tmp, "w", encoding="utf-8") as f:
                json.dump(store, f, ensure_ascii=False)
            os.replace(tmp, cls.ART_FILE)
        except OSError:
            # Windows os.replace can race with a concurrent reader; a plain
            # rewrite beats losing the resolution.
            try:
                with io.open(cls.ART_FILE, "w", encoding="utf-8") as f:
                    json.dump(store, f, ensure_ascii=False)
            except Exception:
                pass
        except Exception as e:
            print("[cloud-art] store save failed:", type(e).__name__, e)

    @classmethod
    def _art_read_sidecar(cls, path):
        try:
            if os.path.exists(path):
                with io.open(path, encoding="utf-8") as f:
                    return f.read().strip()
        except Exception:
            pass
        return ""

    @classmethod
    def _art_sgdb_key(cls):
        return cls._art_read_sidecar(cls.ART_SGDB_KEY)

    @classmethod
    def _art_igdb_key(cls):
        """IGDB sidecar: line 1 client-id, line 2 client-secret. Returns
        (client_id, client_secret) or ("", ""). The app token is derived and
        cached automatically via Twitch's OAuth endpoint."""
        raw = cls._art_read_sidecar(cls.ART_IGDB_KEY)
        if not raw:
            return "", ""
        lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
        if len(lines) >= 2:
            return lines[0], lines[1]
        return lines[0] if lines else "", ""

    _ART_IGDB_TOKEN = ("", 0.0)  # (token, expiry timestamp)

    @classmethod
    def _art_igdb_token(cls):
        import time as _t
        token, exp = cls._ART_IGDB_TOKEN
        if token and exp > _t.time() + 60:
            return token
        client_id, client_secret = cls._art_igdb_key()
        if not (client_id and client_secret):
            return ""
        import urllib.request, urllib.parse
        body = urllib.parse.urlencode({
            "client_id": client_id, "client_secret": client_secret,
            "grant_type": "client_credentials",
        }).encode()
        req = urllib.request.Request("https://id.twitch.tv/oauth2/token", data=body,
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(req, timeout=cls.ART_UPSTREAM_TIMEOUT) as resp:
                data = json.loads(resp.read())
            token = str(data.get("access_token") or "")
            exp = _t.time() + float(data.get("expires_in") or 3600)
            cls._ART_IGDB_TOKEN = (token, exp)
            return token
        except Exception as e:
            print("[cloud-art] igdb token failed:", type(e).__name__, e)
            return ""

    @staticmethod
    def _art_http_json(url, headers, timeout):
        import urllib.request
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())

    @classmethod
    def _art_from_sgdb(cls, title):
        """SteamGridDB search -> best vertical grid (the tile's aspect)."""
        key = cls._art_sgdb_key()
        if not key:
            return ""
        import urllib.parse
        norm = cls._art_norm(title)
        if not norm:
            return ""
        try:
            q = urllib.parse.quote(title)
            data = cls._art_http_json(
                "https://www.steamgriddb.com/api/v2/search/autocomplete/term/" + q,
                {"Authorization": "Bearer " + key, "Accept": "application/json"},
                cls.ART_UPSTREAM_TIMEOUT)
            hits = (data.get("data") or [])
            if not hits:
                return ""
            gid = hits[0].get("id")
            if not gid:
                return ""
            grids = cls._art_http_json(
                "https://www.steamgriddb.com/api/v2/grids/game/" + str(gid) +
                "?dimensions=600x900,512x512&styles=alternate",
                {"Authorization": "Bearer " + key, "Accept": "application/json"},
                cls.ART_UPSTREAM_TIMEOUT)
            options = (grids.get("data") or [])
            if not options:
                return ""
            pick = None
            for opt in options:  # vertical grid first (matches the tile shape)
                if str(opt.get("width", 0)) == "600" and str(opt.get("height", 0)) == "900":
                    pick = opt
                    break
            if not pick:
                pick = options[0]
            return str(pick.get("url") or "")
        except Exception as e:
            print("[cloud-art] sgdb lookup failed:", type(e).__name__, e)
            return ""

    @classmethod
    def _art_from_igdb(cls, title):
        """IGDB cover art fallback. Returns a 4:3-ish cover URL (the 720x720
        size swap is documented by IGDB's image CDN)."""
        token = cls._art_igdb_token()
        client_id, _secret = cls._art_igdb_key()
        if not (token and client_id):
            return ""
        norm = cls._art_norm(title)
        if not norm:
            return ""
        import urllib.parse
        try:
            q = urllib.parse.quote(title.replace('"', ''))
            body = ('search "' + title.replace('"', '') + '"; fields id,name; limit 5;')
            token_esc = token
            # IGDB takes POST bodies in a protobuf-ish query language.
            import urllib.request as _ur
            req = _ur.Request("https://api.igdb.com/v4/games", data=body.encode("utf-8"), headers={
                "Client-ID": client_id, "Authorization": "Bearer " + token_esc,
                "Accept": "application/json",
            })
            with _ur.urlopen(req, timeout=cls.ART_UPSTREAM_TIMEOUT) as resp:
                games = json.loads(resp.read())
            if not games:
                return ""
            cover = games[0].get("cover")
            if not cover:
                return ""
            cover_id = cover.get("id") if isinstance(cover, dict) else cover
            if not cover_id:
                return ""
            req2 = _ur.Request("https://api.igdb.com/v4/covers", data=("fields image_id; where id = " + str(cover_id) + ";").encode("utf-8"), headers={
                "Client-ID": client_id, "Authorization": "Bearer " + token_esc,
                "Accept": "application/json",
            })
            with _ur.urlopen(req2, timeout=cls.ART_UPSTREAM_TIMEOUT) as resp:
                covers = json.loads(resp.read())
            if not covers:
                return ""
            img_id = covers[0].get("image_id")
            return ("https://images.igdb.com/igdb/image/upload/t_cover_big/" + str(img_id) + ".jpg") if img_id else ""
        except Exception as e:
            print("[cloud-art] igdb lookup failed:", type(e).__name__, e)
            return ""

    @classmethod
    def _art_from_steam(cls, title):
        """Steam's store search maps name -> appid. (The ISteamApps/GetAppList
        endpoint the launcher folk used was retired by Valve - every version
        now 404s - so this rides the store search API instead.)"""
        norm = cls._art_norm(title)
        if not norm:
            return ""
        import urllib.parse
        try:
            q = urllib.parse.quote(title)
            data = cls._art_http_json(
                "https://store.steampowered.com/api/storesearch/?term=" + q + "&cc=us&l=en",
                {"User-Agent": "Mozilla/5.0 ChalkleRelay/1.0", "Accept": "application/json"},
                cls.ART_UPSTREAM_TIMEOUT)
            items = data.get("items") or []
            url_for = lambda appid: "https://cdn.cloudflare.steamstatic.com/steam/apps/" + str(appid) + "/header.jpg"
            STOP = {"the", "a", "of", "to", "in", "on", "and", "for"}
            def words(s):
                return [w for w in cls._art_norm(s).split() if w not in STOP]
            want = set(words(title))
            for it in items:  # exact normalized title wins
                if cls._art_norm(it.get("name") or "") == norm and it.get("id"):
                    return url_for(it["id"])
            for it in items:  # then a prefix relationship ("2" vs "2: Redux")
                nm = cls._art_norm(it.get("name") or "")
                if nm and (nm.startswith(norm) or norm.startswith(nm)) and it.get("id"):
                    return url_for(it["id"])
            for it in items:
                # Stop words are the last tolerance: "Fling to the Finish" and
                # a catalog's "Fling to Finish" typo must still meet, but two
                # DIFFERENT games ("God of War" vs "God of War Ragnarok")
                # never collapse into one - the token sets must be equal.
                if want and want == set(words(it.get("name") or "")) and it.get("id"):
                    return url_for(it["id"])
            return ""
        except Exception as e:
            print("[cloud-art] steam store search failed:", type(e).__name__, e)
            return ""

    @classmethod
    def _art_record_failure(cls, title, reason):
        """Failed lookups are persisted (JSON for tooling, .log for humans) so
        missing art can be patched manually instead of silently placeholdering
        forever."""
        store = cls._art_store()
        norm = cls._art_norm(title)
        store["failed"][norm] = {"title": str(title or ""), "reason": str(reason or "")[:200],
                                 "ts": time.time()}
        try:
            os.makedirs(cls.ART_DIR, exist_ok=True)
            with io.open(cls.ART_LOG, "a", encoding="utf-8") as f:
                f.write(time.strftime("%Y-%m-%d %H:%M:%S\t") + str(title) + "\t" + str(reason) + "\n")
        except Exception:
            pass
        cls._art_store_save()

    @classmethod
    def _art_resolve(cls, title):
        """Full pipeline for one title. Returns (url, source, error_reason).
        Cache checks are lock-free (dict reads are GIL-atomic and the write
        side is idempotent); the UPSTREAM calls run OUTSIDE the lock so a
        first load of 30 uncacheated tiles resolves in parallel instead of
        serializing behind one another."""
        store = cls._art_store()
        norm = cls._art_norm(title)
        now = time.time()
        hit = store["resolved"].get(norm)
        if hit and now - float(hit.get("ts") or 0) < cls.ART_TTL and hit.get("url"):
            return hit["url"], hit.get("source", ""), None
        neg = store["failed"].get(norm)
        if neg and now - float(neg.get("ts") or 0) < cls.ART_NEG_TTL:
            return "", "", "recently failed: " + str(neg.get("reason") or "unknown")
        reason_bits = []
        url = cls._art_from_sgdb(title)
        if url:
            with cls.ART_LOCK:
                store["resolved"][norm] = {"url": url, "source": "sgdb", "ts": now}
                cls._art_store_save()
            return url, "sgdb", None
        reason_bits.append("sgdb miss" + ("" if cls._art_sgdb_key() else " (no key)"))
        url = cls._art_from_igdb(title)
        if url:
            with cls.ART_LOCK:
                store["resolved"][norm] = {"url": url, "source": "igdb", "ts": now}
                cls._art_store_save()
            return url, "igdb", None
        reason_bits.append("igdb miss" + ("" if cls._art_igdb_token() else " (no key)"))
        url = cls._art_from_steam(title)
        if url:
            with cls.ART_LOCK:
                store["resolved"][norm] = {"url": url, "source": "steam", "ts": now}
                cls._art_store_save()
            return url, "steam", None
        reason_bits.append("steam miss")
        reason = "; ".join(reason_bits)
        with cls.ART_LOCK:
            cls._art_record_failure(title, reason)
        return "", "", reason

    def _cloud_art_get(self):
        """GET /api/cloud-art/lookup?title=... -> {url, source} or {url: ""}.
        The client calls this lazily per visible tile; every result is cached
        server-side so repeat loads never re-hit upstream APIs."""
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)
        title = (qs.get("title") or [""])[0][:200]
        if not title:
            return self._cloud_json({"ok": False, "error": "no-title"}, 400)
        try:
            url, source, err = self._art_resolve(title)
        except Exception as e:
            return self._cloud_json({"ok": False, "error": type(e).__name__}, 500)
        if err and not url:
            data = {"ok": False, "error": "no-art", "detail": err}
            cache_ttl = 3600  # negatives are retried after an hour
        else:
            data = {"ok": True, "url": url, "source": source}
            cache_ttl = int(_CloudRelay.ART_TTL)
        payload = json.dumps(data).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        # Resolved URLs are stable for the TTL; negatives are retried sooner.
        self.send_header("Cache-Control", "public, max-age=" + str(cache_ttl))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _cloud_art_stats(self):
        """GET /api/cloud-art/stats -> cache size and recent failures, so the
        operator can see what needs patching without opening the log file."""
        store = self._art_store()
        fails = sorted(store["failed"].items(), key=lambda kv: -kv[1].get("ts", 0))[:25]
        self._cloud_json({
            "ok": True,
            "resolved": len(store["resolved"]),
            "failed": len(store["failed"]),
            "recent_failures": [{"title": v.get("title"), "reason": v.get("reason")} for _k, v in fails],
        })

    def _cloud_json(self, obj, code=200):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _cloud_scheme(self):
        fwd = (self.headers.get("X-Forwarded-Proto") or "").strip().lower()
        if fwd in ("https", "http"):
            return fwd
        # This python server is plain http; https only arrives via the tunnel's
        # X-Forwarded-Proto header.
        return "http"

    def _cloud_forward(self, method, path, query, post_body=None, timeout=180):
        """Forward one request to the Stratus backend. Returns a response dict
        or writes it directly when it needs rewriting (startGame signaling)."""
        import urllib.request, urllib.error
        url = _cloud_cfg()["base"] + path
        if query:
            url += "?" + query
        headers = {
            "User-Agent": "Mozilla/5.0 ChalkleRelay/1.0",
            "Accept": "*/*",
        }
        ctype = (self.headers.get("Content-Type") or "application/json").split(";")[0].strip()
        if post_body is not None:
            headers["Content-Type"] = ctype + "; charset=utf-8" if ctype else "application/json; charset=utf-8"
        # The relay's configured API key is injected here, never the page's.
        headers["x-api-key"] = _cloud_cfg()["key"]
        req = urllib.request.Request(url, data=post_body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                rtype = (resp.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()
                return {"code": resp.getcode() or 200, "type": rtype, "body": raw}
        except urllib.error.HTTPError as e:
            return {"code": e.code, "type": e.headers.get("Content-Type", "application/json").split(";")[0].strip(),
                    "body": e.read()}
        except Exception as e:
            return {"code": 502, "type": "application/json",
                    "body": json.dumps({"error": type(e).__name__ + ": backend unreachable"}).encode()}

    def _cloud_send(self, r, extra=None):
        self.send_response(r["code"])
        self.send_header("Content-Type", r["type"] or "application/octet-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(r["body"])))
        self.end_headers()
        try:
            self.wfile.write(r["body"])
        except Exception:
            pass

    def _vm_health(self):
        """Health for the VM stack: static dir present + wisp relay up."""
        import socket
        ok = os.path.isfile(os.path.join(VM_ROOT, "index.html"))
        try:
            with socket.create_connection(("127.0.0.1", 3002), timeout=1.5):
                pass
        except Exception:
            ok = False
        self._cloud_json({"ok": ok}, 200 if ok else 503)
        return True

    def _app_health(self):
        """Aggregate health for the Settings diagnostics panel. Only checks
        things that are cheap and local (storage, gitignored service dirs,
        uptime); it never hammers upstream services. 404 answers mean the
        service's backing files are simply not deployed here."""
        import platform as _platform
        services = {
            "cloud": os.path.isdir(os.path.join(WEB_ROOT, "server", "stratus")) or bool(os.environ.get("STRATUS_BACKEND")),
            "vm": os.path.isdir(VM_ROOT),
            "chatUpload": True,
        }
        self._cloud_json({
            "ok": True,
            "version": "1.1",
            "python": _platform.python_version(),
            "uptime_s": int(time.time() - START_TIME),
            "services": services,
        })

    def _cloud_health(self):
        import socket
        backend = _cloud_cfg()["base"]
        ok = False
        try:
            host = backend.replace("https://", "").replace("http://", "").split("/")[0]
            if ":" in host:
                h, p = host.rsplit(":", 1)
                p = int(p)
            else:
                h, p = host, 80 if backend.startswith("http://") else 443
            s = socket.create_connection((h, p), timeout=4)
            s.close()
            ok = True
        except Exception:
            ok = False
        self._cloud_json({"ok": ok, "backend": backend})

    def _cloud_config_post(self):
        """Save the relay backend config from the Cloud settings panel. The
        backend is meant to be the site owner's local Stratus, so only loopback
        hosts are accepted here; a hosted backend is set via STRATUS_BACKEND."""
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(raw or b"{}")
        except Exception:
            payload = {}
        base = str(payload.get("base") or "").strip().rstrip("/")
        key = str(payload.get("key") or "").strip()
        if base and not CLOUD_CFG_LOOPBACK_RE.match(base):
            return self._cloud_json({"ok": False, "error": "Use a loopback URL (localhost) for the relay"}, 400)
        try:
            with open(CLOUD_CFG_PATH, "w", encoding="utf-8") as f:
                json.dump({"base": base, "key": key}, f)
        except Exception as e:
            return self._cloud_json({"ok": False, "error": type(e).__name__}, 500)
        _cloud_cfg_cache["m"] = 0  # force reload on next request
        self._cloud_json({"ok": True, "base": base, "keySet": bool(key)})

    def _cloud_get(self, route):
        # Box-art endpoints live in this mixin; check them BEFORE the Stratus
        # path regex, which only knows /cloud/v1/getQueue and embed-data.
        if route == "/api/cloud-art/lookup":
            return self._cloud_art_get()
        if route == "/api/cloud-art/stats":
            return self._cloud_art_stats()
        m = CLOUD_PATH_RE.match(route)
        if not m:
            return None
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        r = self._cloud_forward("GET", route, query, timeout=20)
        if route == "/cloud/v1/embed-data" and r["type"] and "json" in r["type"]:
            # Same rewrite as startGame: the player tab must reach the signal
            # websocket through THIS origin (tunnel), never the backend host.
            try:
                data = json.loads(r["body"])
                ws = data.get("signaling_ws") or ""
                if ws:
                    scheme = "wss" if self._cloud_scheme() == "https" else "ws"
                    host = (self.headers.get("Host") or "localhost:4173").strip()
                    data["signaling_ws"] = re.sub(r"wss?://[^/]+", f"{scheme}://{host}", ws)
                    r["body"] = json.dumps(data).encode("utf-8")
            except Exception:
                pass
        self._cloud_send(r)
        return True

    def _cloud_post(self, route):
        if route not in ("/cloud/v1/createSession", "/cloud/v1/startGame",
                         "/cloud/v1/pingSession", "/cloud/v1/quitSession"):
            return None
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length > 0 else None
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        # Keep session pings short so a tunnel request cannot sit behind
        # another long cloud request and miss Stratus' watchdog window.
        timeout = 300 if route == "/cloud/v1/createSession" else (8 if route == "/cloud/v1/pingSession" else 20)
        r = self._cloud_forward("POST", route, query, post_body=body, timeout=timeout)
        # createSession streams NDJSON while the relay boots a throwaway
        # account; if the stream drops (IncompleteRead from a slow upstream
        # email verification), retry once - a fresh session is harmless since
        # the abandoned one self-terminates.
        if (route == "/cloud/v1/createSession" and r["code"] == 502
                and b"IncompleteRead" in (r.get("body") or b"")):
            r = self._cloud_forward("POST", route, query, post_body=body, timeout=timeout)
        extra = None
        if route == "/cloud/v1/startGame" and r["type"] and "json" in r["type"]:
            # Point the signal websocket back at THIS origin so the player tab
            # connects through the same tunnel/relay the page is served from.
            try:
                data = json.loads(r["body"])
                ws = data.get("signaling_ws") or ""
                if ws:
                    scheme = "wss" if self._cloud_scheme() == "https" else "ws"
                    host = (self.headers.get("Host") or "localhost:4173").strip()
                    data["signaling_ws"] = re.sub(r"wss?://[^/]+", f"{scheme}://{host}", ws)
                    r["body"] = json.dumps(data).encode("utf-8")
            except Exception:
                pass
        self._cloud_send(r, extra)
        return True

    def _cloud_ws(self, route):
        """Tunnel a WebSocket upgrade to the backend signal endpoint."""
        target = _cloud_ws_target(route)
        if not target:
            return None
        import urllib.parse
        parts = urllib.parse.urlsplit(target)
        host = parts.hostname or ""
        port = parts.port or (443 if parts.scheme == "wss" else 80)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        try:
            sock = socket.create_connection((host, port), timeout=15)
            if parts.scheme == "wss":
                ctx = ssl.create_default_context()
                sock = ctx.wrap_socket(sock, server_hostname=host)
            key = self.headers.get("Sec-WebSocket-Key", "").strip()
            ver = self.headers.get("Sec-WebSocket-Version", "13").strip()
            proto = self.headers.get("Sec-WebSocket-Protocol", "").strip()
            lines = ["GET %s HTTP/1.1" % path, "Host: %s" % host, "Upgrade: websocket", "Connection: Upgrade"]
            if key:
                lines.append("Sec-WebSocket-Key: " + key)
            if ver:
                lines.append("Sec-WebSocket-Version: " + ver)
            if proto:
                lines.append("Sec-WebSocket-Protocol: " + proto)
            origin = self.headers.get("Origin", "")
            if origin:
                lines.append("Origin: " + origin)
            sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
            head = b""
            while b"\r\n\r\n" not in head:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                head += chunk
                if len(head) > 65536:
                    break
        except Exception as e:
            try:
                sock.close()
            except Exception:
                pass
            self._cloud_json({"error": "ws connect failed: " + type(e).__name__}, 502)
            return True
        try:
            self.connection.sendall(head)
            self.close_connection = True
        except Exception:
            try:
                sock.close()
            except Exception:
                pass
            return True

        def pump(src, dst):
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except Exception:
                pass
            finally:
                try:
                    dst.shutdown(socket.SHUT_WR)
                except Exception:
                    pass

        t1 = threading.Thread(target=pump, args=(self.connection, sock), daemon=True)
        t2 = threading.Thread(target=pump, args=(sock, self.connection), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        try:
            sock.close()
        except Exception:
            pass
        return True

    def _vm_wisp_ws(self, route):
        """Tunnel a /wisp/* WebSocket upgrade to the local VM relay
        (chalkle-vm-relay/server.mjs on 127.0.0.1:3002)."""
        import urllib.parse
        backend = VM_WISP_BACKEND
        parts = urllib.parse.urlsplit(backend)
        host = parts.hostname or "127.0.0.1"
        port = parts.port or 3002
        path = route if route.startswith("/") else "/" + route
        try:
            sock = socket.create_connection((host, port), timeout=15)
        except Exception as e:
            self._cloud_json({"error": "vm relay unreachable: " + type(e).__name__}, 502)
            return True
        try:
            key = self.headers.get("Sec-WebSocket-Key", "").strip()
            ver = self.headers.get("Sec-WebSocket-Version", "13").strip()
            proto = self.headers.get("Sec-WebSocket-Protocol", "").strip()
            lines = ["GET %s HTTP/1.1" % path, "Host: %s:%s" % (host, port),
                     "Upgrade: websocket", "Connection: Upgrade"]
            if key:
                lines.append("Sec-WebSocket-Key: " + key)
            if ver:
                lines.append("Sec-WebSocket-Version: " + ver)
            if proto:
                lines.append("Sec-WebSocket-Protocol: " + proto)
            origin = self.headers.get("Origin", "")
            if origin:
                lines.append("Origin: " + origin)
            sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
            head = b""
            while b"\r\n\r\n" not in head:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                head += chunk
                if len(head) > 65536:
                    break
        except Exception as e:
            try:
                sock.close()
            except Exception:
                pass
            self._cloud_json({"error": "ws connect failed: " + type(e).__name__}, 502)
            return True
        try:
            self.connection.sendall(head)
            self.close_connection = True
        except Exception:
            try:
                sock.close()
            except Exception:
                pass
            return True

        def pump(src, dst):
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except Exception:
                pass
            finally:
                try:
                    dst.shutdown(socket.SHUT_WR)
                except Exception:
                    pass

        t1 = threading.Thread(target=pump, args=(self.connection, sock), daemon=True)
        t2 = threading.Thread(target=pump, args=(sock, self.connection), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        try:
            sock.close()
        except Exception:
            pass
        return True

    def _vm_page(self, route):
        """Serve the Chalkle VM (Puter firefox-wasm) from vm/ with the
        cross-origin-isolation headers its WASM threads require."""
        import urllib.parse
        rel = urllib.parse.unquote(route[len("/vm/"):]) or "index.html"
        rel = rel.split("?", 1)[0].split("#", 1)[0]
        if rel in ("", "/"):
            rel = "index.html"
        full = os.path.normpath(os.path.join(VM_ROOT, rel))
        if not full.startswith(os.path.normpath(VM_ROOT) + os.sep) and full != os.path.normpath(VM_ROOT):
            self.send_error(403)
            return True
        if not os.path.isfile(full):
            self.send_error(404)
            return True
        ext = os.path.splitext(full)[1].lower()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ext == ".wasm":
            ctype = "application/wasm"
        elif ext == ".js":
            ctype = "text/javascript"
        elif ext == ".zst":
            ctype = "application/zstd"
        elif ext == ".html":
            ctype = "text/html; charset=utf-8"
        size = os.path.getsize(full)
        # The Firefox WASM build needs cross-origin isolation for its worker
        # threads; these headers are non-negotiable or boot stalls.
        iso_headers = [
            ("Cross-Origin-Opener-Policy", "same-origin"),
            ("Cross-Origin-Embedder-Policy", "require-corp"),
            ("Cross-Origin-Resource-Policy", "same-origin"),
        ]
        cache = ("public, max-age=604800" if ext in (".zst", ".wasm", ".tar")
                 else "no-cache")
        rng_match = None
        if "Range" in self.headers and size > 0:
            m = re.match(r"bytes=(\d*)-(\d*)$", self.headers["Range"].strip())
            if m:
                start = int(m.group(1) or 0)
                end = min(int(m.group(2) or size - 1), size - 1)
                if start <= end < size:
                    rng_match = (start, end)
        if rng_match:
            start, end = rng_match
            self.send_response(206)
            self.send_header("Content-Type", ctype)
            for hk, hv in iso_headers:
                self.send_header(hk, hv)
            self.send_header("Cache-Control", cache)
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.send_header("Content-Length", str(end - start + 1))
            self.end_headers()
            with open(full, "rb") as f:
                f.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except Exception:
                        return True
                    remaining -= len(chunk)
            return True
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        for hk, hv in iso_headers:
            self.send_header(hk, hv)
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with open(full, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except Exception:
                    break
        return True




# ---------------------------------------------------------------- /music relay
# Same-origin relay to the local Meting music backend (music-backend/server.mjs
# on 127.0.0.1:3004). Three jobs:
#   /music/api    -> forwards search/playlist/url/lyric/pic to the backend;
#                    the backend already rewrites CDN urls to /music/stream
#                    and /music/pic, so the browser only talks to this origin.
#   /music/stream -> Range-capable proxy for the mp3 CDN (seek needs 206).
#   /music/pic    -> proxy for album-art images (cacheable).
# Both media proxies refuse private/loopback targets (no SSRF).

MUSIC_BACKEND_DEFAULT = "http://127.0.0.1:3004"
MUSIC_CFG_PATH = os.path.join(WEB_ROOT, "music-relay.json")

_music_cfg_cache = {"m": 0, "cfg": {}}


def _music_cfg():
    try:
        m = os.path.getmtime(MUSIC_CFG_PATH)
    except OSError:
        m = 0
    cache = _music_cfg_cache
    if m and m != cache["m"]:
        try:
            with open(MUSIC_CFG_PATH, "r", encoding="utf-8") as f:
                cache["cfg"] = json.load(f) or {}
        except Exception:
            cache["cfg"] = {}
        cache["m"] = m
    base = str(cache["cfg"].get("backend") or "").strip() or os.environ.get("MUSIC_BACKEND", "")
    return base.rstrip("/") or MUSIC_BACKEND_DEFAULT


def _music_b64u(s):
    import base64
    return base64.urlsafe_b64encode(s.encode("utf-8")).decode("ascii").rstrip("=")


def _music_unb64u(s):
    import base64
    return base64.urlsafe_b64decode((s + "=" * (-len(s) % 4)).encode("ascii")).decode("utf-8")


class _MusicRelay:
    """Mixin with the music relay handlers; combined into Handler below."""

    def _music_json(self, obj, code=200, cacheable=False):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "max-age=120" if cacheable else "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _music_api(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)
        server = (qs.get("server") or [""])[0].strip()
        # Non-Chinese provider: /music/api?server=youtube serves search / url /
        # pic / lyric straight from Piped (same backend the YouTube tab uses).
        # Search is ordered by popularity (views desc); streams come from Piped's
        # muxed mp4, proxied through /music/stream so the page stays same-origin.
        if server in ("youtube", "yt", "youtubemusic"):
            return self._music_yt_api(qs)
        import urllib.request, urllib.error
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        url = _music_cfg() + "/api" + (("?" + query) if query else "")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 ChalkleMusic/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read()
                code = resp.getcode() or 200
                try:
                    data = json.loads(body)
                except Exception:
                    data = None
                if isinstance(data, (dict, list)):
                    def walk(o):
                        if isinstance(o, dict):
                            for k in list(o.keys()):
                                v = o[k]
                                if isinstance(v, str) and v.startswith(("http://", "https://")):
                                    u = _music_b64u(v)
                                    if k in ("url", "stream", "playUrl"):
                                        o[k] = "/music/stream?u=" + u
                                    elif k in ("pic", "cover", "pic_big", "pic_small"):
                                        o[k] = "/music/pic?u=" + u
                                else:
                                    walk(v)
                        elif isinstance(o, list):
                            for it in o:
                                walk(it)
                    walk(data)
                    body = json.dumps(data).encode("utf-8")
                self._music_json(json.loads(body), code)
                return
        except urllib.error.HTTPError as e:
            return self._music_json({"error": "backend http " + str(e.code)}, e.code)
        except Exception as e:
            return self._music_json({"error": type(e).__name__ + ": music backend unreachable"}, 502)

    def _music_yt_api(self, qs):
        """YouTube (Piped) music provider. Speaks the same API the music tab
        expects from the old Meting backend:
          search?q=..         -> songs, ordered by views (most popular first)
          url?id=..           -> playable stream, rewritten to /music/stream
          pic?id=..           -> cover art, rewritten to /music/pic
          lyric?id=..         -> synced lyrics (best-effort, may be empty)
        Streams are the muxed mp4 Piped serves for each video id, proxied
        through /music/stream so the browser stays same-origin. Search results
        carry real view counts, sorted desc = most popular to least. Piped
        search filter=music_songs returns no view counts, so we query the
        videos filter and keep music-length results (<= 9 min)."""
        import urllib.parse

        def val(name):
            return (qs.get(name) or [""])[0].strip()

        # Music tab sends ?type= (Meting-style); accept that or ?path=.
        path = val("type") or val("path") or "search"
        if path not in ("search", "url", "pic", "lyric", "playlist", "song"):
            return self._music_json({"error": "unknown path: " + path}, 400)

        # Search: Piped filter=videos, keep songs, sort by views desc.
        if path == "search":
            q = val("q")
            limit = max(1, min(int(val("limit") or "30"), 60))
            if not q:
                return self._music_json({"error": "missing q"}, 400)
            key = "music:search:" + q.lower()
            cached = _yt_cache.get(key)
            if cached and time.time() - cached[0] < 120:
                return self._music_json(cached[1], 200, cacheable=True)
            import urllib.request as _ur
            path_url = "/search?q=" + urllib.parse.quote(q) + "&filter=videos"
            data, code = _yt_fetch_json(path_url)
            items = data.get("items") if isinstance(data, dict) else data
            if code != 200 and _music_cool():
                stale = _yt_cache.get(key)
                if stale:
                    sp = dict(stale[1])
                    sp["stale"] = True
                    sp["stale_age"] = int(time.time() - stale[0])
                    return self._music_json(sp, 200, cacheable=True)
            items = [i for i in (items or []) if isinstance(i, dict)]
            # Keep music-length videos (<= 9 min, > 25 s), then most-viewed first.
            songs = []
            for it in items:
                dur = it.get("duration") or 0
                if not (25 < dur <= 540):
                    continue
                vid = ""
                m = re.search(r"[?&]v=([\w-]{6,})", str(it.get("url") or ""))
                if m:
                    vid = m.group(1)
                if not vid:
                    continue
                songs.append({
                    "id": vid,
                    "name": it.get("title") or "Untitled",
                    "artist": [it.get("uploaderName") or ""],
                    "album": it.get("uploaderName") or "",
                    "pic_id": vid,
                    "url_id": vid,
                    "lyric_id": vid,
                    "duration": dur,
                    "views": int(it.get("views") or 0),
                    "source": "youtube"
                })
            songs.sort(key=lambda s: s["views"], reverse=True)
            payload = {"items": songs[:limit], "count": len(songs)}
            _yt_cache[key] = (time.time(), payload)
            return self._music_json(payload, 200, cacheable=True)

        # Stream URL: Piped /streams/<id> -> m4a/mp4 with audio, proxied.
        if path == "url":
            vid = val("id")
            if not vid:
                return self._music_json({"error": "missing id"}, 400)
            ckey = "music:stream:" + vid
            ccached = _yt_cache.get(ckey)
            # Successes cache an hour; empty results cache ten minutes so a dead
            # track skips instantly instead of hammering upstream every play.
            if ccached and time.time() - ccached[0] < (ccached[2] if len(ccached) > 2 else 3600):
                return self._music_json(ccached[1], 200, cacheable=True)
            # Primary: yt-dlp (handles signatures/pot, full-length streams).
            # Then YouTube's innertube player API (IOS client, ~1MB preview
            # cap), then Piped /streams, then Invidious - a single dead
            # upstream can never wedge playback.
            stream_url = ""
            via = "yt-dlp"
            stream_url, stream_via = _yt_dlp_audio(vid)
            if not stream_url:
                via = "innertube"
                stream_url, stream_via = _innertube_audio(vid)
            if not stream_url:
                data, code = _yt_fetch_json("/streams/" + urllib.parse.quote(vid), timeout=10, retries=1)
                via = "piped"
                if isinstance(data, dict):
                    # Prefer a real audio stream (m4a/webm), else any muxed mp4.
                    audio = [s for s in (data.get("audioStreams") or []) if isinstance(s, dict) and (s.get("url") or "").startswith("http")]
                    video = [s for s in (data.get("videoStreams") or []) if isinstance(s, dict) and (s.get("url") or "").startswith("http") and "mp4" in (s.get("mimeType") or "")]
                    choice = None
                    for s in audio:
                        if "m4a" in (s.get("mimeType") or "") or "mp4" in (s.get("mimeType") or ""):
                            choice = s
                            break
                    if not choice and audio:
                        choice = audio[0]
                    if not choice and video:
                        choice = video[-1]  # lowest res muxed mp4 = smallest download
                    if choice:
                        stream_url = (choice.get("url") or "").strip()
            if not stream_url:
                via = "invidious"
                stream_url = _invidious_video(vid)
            if not stream_url:
                payload = {"url": "", "via": "youtube", "br": -1}
                # Total-outage fallback: last good stream URL for this video,
                # so currently-playing audio keeps working through upstream
                # failures (Google media URLs stay valid for hours).
                sstale = _yt_cache.get("music:streamok:" + vid)
                if sstale and _music_cool():
                    sp = dict(sstale[1])
                    sp["stale"] = True
                    return self._music_json(sp, 200, cacheable=True)
                _yt_cache[ckey] = (time.time(), payload, 600)
                return self._music_json(payload, 200, cacheable=True)
            payload = {
                "url": "/music/stream?u=" + _music_b64u(stream_url),
                "via": "youtube",
                "src": via,
                "br": 320
            }
            _yt_cache[ckey] = (time.time(), payload, 3600)
            _yt_cache["music:streamok:" + vid] = (time.time(), payload)
            return self._music_json(payload, 200, cacheable=True)

        # Cover art: use the YouTube thumbnail (rewritten to /music/pic proxy).
        if path in ("pic", "song", "playlist"):
            vid = val("id")
            if not vid:
                return self._music_json({"error": "missing id"}, 400)
            thumb = "https://i.ytimg.com/vi/" + vid + "/mqdefault.jpg"
            return self._music_json({"url": "/music/pic?u=" + _music_b64u(thumb)})

        # Lyrics: Piped exposes none per-song; return empty so the UI hides it.
        return self._music_json({"lyric": "", "source": "youtube"})

    def _music_target(self, kind):
        """Decode + validate the ?u= target URL. Returns the url or None."""
        import urllib.parse, socket
        from urllib.parse import urlparse
        q = urllib.parse.parse_qs(urlparse(self.path).query)
        raw = (q.get("u") or [""])[0].strip()
        if not raw:
            return None
        url = None
        if raw.startswith(("http://", "https://")):
            url = raw
        else:
            try:
                url = _music_unb64u(raw)
            except Exception:
                return None
        if not url.startswith(("http://", "https://")):
            return None
        host = urlparse(url).hostname or ""
        try:
            ip = socket.gethostbyname(host)
        except Exception:
            return None
        if _is_private_ip(ip):
            return None
        return url

    def _music_proxy(self, kind):
        import urllib.request, urllib.error
        url = self._music_target(kind)
        if not url:
            return self._music_json({"error": "bad or private target"}, 403)
        headers = {"User-Agent": "Mozilla/5.0 ChalkleMusic/1.0", "Accept": "*/*"}
        rng = self.headers.get("Range")
        # googlevideo (YouTube's CDN) rejects unbounded ranges like "bytes=0-"
        # with 403, but browsers always send them for media. Probe the total
        # size with a 1-byte request and rewrite the range to a bounded one
        # ending at the real file size.
        rewritten_range = None
        total_size = None
        if rng and kind == "stream" and re.search(r"bytes=\d+-$", rng.strip()):
            probe = urllib.request.Request(url, headers=dict(headers, Range="bytes=0-0"))
            try:
                with urllib.request.urlopen(probe, timeout=20) as presp:
                    cr = presp.headers.get("Content-Range") or ""
                    m = re.search(r"/(\d+)\s*$", cr)
                    if m:
                        total_size = int(m.group(1))
                        start = int(re.search(r"bytes=(\d+)-", rng.strip()).group(1))
                        if total_size > start:
                            rewritten_range = "bytes=%d-%d" % (start, total_size - 1)
            except urllib.error.HTTPError as e:
                return self._music_json({"error": "upstream http " + str(e.code)}, e.code)
            except Exception as e:
                return self._music_json({"error": type(e).__name__}, 502)
        if rewritten_range:
            rng = rewritten_range
        if rng:
            headers["Range"] = rng
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                code = resp.getcode() or 200
                self.send_response(code)
                ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
                self.send_header("Content-Type", ctype or ("audio/mpeg" if kind == "stream" else "image/jpeg"))
                clen = resp.headers.get("Content-Length")
                if clen:
                    self.send_header("Content-Length", clen)
                self.send_header("Accept-Ranges", "bytes")
                crange = resp.headers.get("Content-Range")
                if crange:
                    self.send_header("Content-Range", crange)
                ctrl = "no-store" if kind == "stream" else "public, max-age=604800"
                self.send_header("Cache-Control", ctrl)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except urllib.error.HTTPError as e:
            return self._music_json({"error": "upstream http " + str(e.code)}, e.code)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                return self._music_json({"error": type(e).__name__}, 502)
            except Exception:
                pass

    def _music_stream(self):
        self._music_proxy("stream")

    def _music_pic(self):
        self._music_proxy("pic")

    def _music_health(self):
        import socket
        backend = _music_cfg()
        ok = False
        try:
            host = backend.replace("https://", "").replace("http://", "").split("/")[0]
            if ":" in host:
                h, p = host.rsplit(":", 1)
                p = int(p)
            else:
                h, p = host, 80 if backend.startswith("http://") else 443
            s = socket.create_connection((h, p), timeout=4)
            s.close()
            ok = True
        except Exception:
            ok = False
        self._music_json({"ok": ok, "backend": backend})


# ---------------------------------------------------------------- /yt relay
# YouTube tab backend. The page (youtube.js) only ever calls this origin:
#   /yt/search?q=..&filter=..  -> video / channel search via Piped API
#   /yt/trending               -> trending videos
#   /yt/channel/<id>           -> channel profile + latest videos    # /yt/thumb?u=<b64>          -> image proxy for thumbnails/avatars
# Search results come back with thumbnails rewritten to /yt/thumb so the
# browser never hits a third-party host directly (school-friendly). Results
# are cached briefly so repeated browsing doesn't hammer the upstream.
# Thumbnails themselves are written to a disk cache (temp dir, 7-day TTL) so
# the same cover is served instantly on repeat visits instead of re-fetching
# i.ytimg.com every time a card renders.

_yt_thumb_cache_dir = None


def _yt_thumb_cache_path():
    """Directory used to cache proxied thumbnails on disk (7-day TTL)."""
    global _yt_thumb_cache_dir
    if _yt_thumb_cache_dir is None:
        import tempfile
        _yt_thumb_cache_dir = os.path.join(tempfile.gettempdir(), "chalkle-yt-thumbs")
    return _yt_thumb_cache_dir


_YT_THUMB_LADDER = ["maxresdefault", "hqdefault", "mqdefault", "default"]


def _yt_thumb_fallback(url):
    """Step a YouTube thumb URL down to the next smaller size. Returns None
    when there is no smaller size left, so callers can stop trying."""
    import re as _re
    m = _re.match(r"(https?://[^/]+/vi(_webp)?/[^/?#]+/)(maxresdefault|hqdefault|mqdefault|default)(_live)?(\.jpg)", url)
    if not m:
        return None
    cur = m.group(3)
    if cur not in _YT_THUMB_LADDER:
        return None
    i = _YT_THUMB_LADDER.index(cur)
    if i + 1 >= len(_YT_THUMB_LADDER):
        return None
    nxt = _YT_THUMB_LADDER[i + 1]
    # A live stream only has hqdefault_live; falling one step down from it
    # lands on the plain hqdefault frame.
    return m.group(1) + nxt + m.group(5)


def _yt_fetch_thumb(url, timeout=10):
    """Fetch one thumbnail. Returns (bytes, content-type) or (None, None)."""
    import urllib.request, urllib.error
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 ChalkleYT/1.0", "Accept": "image/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
            return body, (ctype or "image/jpeg")
    except Exception:
        return None, None


def _yt_thumb_serve(self, url):
    """Serve a thumbnail from the disk cache when fresh, else fetch (with
    size fallback) and fill the cache. Returns True when a response was sent."""
    import hashlib
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()
    cache_dir = _yt_thumb_cache_path()
    cached = os.path.join(cache_dir, digest)
    meta = cached + ".meta"
    try:
        if os.path.exists(cached) and os.path.exists(meta) and (time.time() - os.path.getmtime(cached)) < 7 * 86400:
            with open(meta, encoding="utf-8") as fh:
                ctype = fh.read().strip() or "image/jpeg"
            with open(cached, "rb") as fh:
                body = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return True
    except Exception:
        pass
    attempts = [url]
    while len(attempts) < 3:
        nxt = _yt_thumb_fallback(attempts[-1])
        if not nxt or nxt in attempts:
            break
        attempts.append(nxt)
    for u in attempts:
        body, ctype = _yt_fetch_thumb(u)
        if body:
            try:
                os.makedirs(cache_dir, exist_ok=True)
                with open(cached, "wb") as fh:
                    fh.write(body)
                with open(meta, "w", encoding="utf-8") as fh:
                    fh.write(ctype)
                # Opportunistic sweep: drop entries older than the 7-day TTL.
                try:
                    now = time.time()
                    for fn in os.listdir(cache_dir):
                        fp = os.path.join(cache_dir, fn)
                        if now - os.path.getmtime(fp) > 7 * 86400:
                            os.unlink(fp)
                except Exception:
                    pass
            except Exception:
                pass
            self.send_response(200)
            self.send_header("Content-Type", ctype or "image/jpeg")
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return True
    return False

YT_INSTANCES = [
    "https://api.piped.private.coffee",
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.adminforge.de",
    "https://pipedapi.reallyaweso.me",
    "https://pipedapi.leptons.xyz",
    "https://pipedapi.orangenet.cc",
    "https://pipedapi.ducks.party",
    "https://piapi.ggtyler.dev",
    "https://piped-api.codespace.cz",
    "https://pipedapi.drgns.space",
]

# Piped search is still useful, but its stream endpoints are increasingly
# flaky. Keep a small fallback pool of maintained Invidious instances for the
# actual playable URL. The browser never sees these hosts: their media URLs
# are wrapped by /music/stream below.
INVIDIOUS_INSTANCES = [
    "https://inv.nadeko.net",
    "https://invidious.nerdvpn.de",
    "https://yewtu.be",
    "https://yt.chocolatemoo53.com",
    "https://invidious.tiekoetter.com",
    "https://inv.tux.pizza",
    "https://invidious.private.coffee",
    "https://iv.melmac.space",
]

_yt_cache = {}          # route key -> (ts, payload)
_YT_CACHE_TTL = 180     # seconds
_yt_down_until = {}     # instance -> ts; unreachable instances are skipped until then


def _music_cool():
    """True when most Piped instances are in their failure cooldown - i.e. we
    just went through a near-total outage and stale caches are worth serving
    instead of errors."""
    now = time.time()
    live = [i for i in YT_INSTANCES if _yt_down_until.get(i, 0) <= now]
    return len(live) < max(1, len(YT_INSTANCES) // 3)



def _yt_b64u(s):
    import base64
    return base64.urlsafe_b64encode(s.encode("utf-8")).decode("ascii").rstrip("=")


def _yt_unb64u(s):
    import base64
    return base64.urlsafe_b64decode((s + "=" * (-len(s) % 4)).encode("ascii")).decode("utf-8")


def _yt_fetch_json(path, timeout=7, retries=1):
    """Resolve a Piped API path by racing all instances in parallel so one
    slow or dead instance can't stall the request for its whole timeout.
    Instances that fail to connect get a short cooldown and are skipped on
    later calls; instances that answer with an error reply are retried since
    they respond fast and may be transiently broken. Returns (data, code)."""
    import urllib.request, urllib.error, json as _json
    from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED

    def try_one(inst):
        url = inst + path
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 ChalkleYT/1.0", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
        except urllib.error.HTTPError as e:
            _yt_down_until[inst] = time.time() + 45
            return None, "http " + str(e.code) + " from " + inst
        except Exception as e:
            _yt_down_until[inst] = time.time() + 45
            return None, type(e).__name__ + " from " + inst
        try:
            data = _json.loads(body)
        except Exception:
            _yt_down_until[inst] = time.time() + 45
            return None, "bad json from " + inst
        if isinstance(data, dict) and isinstance(data.get("error"), (str, dict)):
            # Instance alive but refused (streams need a working extractor;
            # search can also fail this way). No cooldown: it may answer the
            # next request fine, and error replies are fast.
            return None, "error reply from " + inst + ": " + str(data["error"])[:80]
        if isinstance(data, (dict, list)):
            _yt_down_until.pop(inst, None)
            return data, resp.getcode() or 200
        _yt_down_until[inst] = time.time() + 45
        return None, "unexpected payload from " + inst

    last_err = [None]
    insts = [i for i in YT_INSTANCES if _yt_down_until.get(i, 0) <= time.time()] or list(YT_INSTANCES)
    for _round in range(max(1, retries)):
        if not insts:
            break  # everything left is in cooldown; don't re-hammer dead hosts
        if len(insts) == 1:
            data, err = try_one(insts[0])
            if data is not None:
                return data, 200
            if err:
                last_err[0] = err
        else:
            ex = ThreadPoolExecutor(max_workers=len(insts))
            try:
                pending = [ex.submit(try_one, i) for i in insts]
                deadline = time.time() + timeout + 2
                while pending and time.time() < deadline:
                    done, pending = wait(pending, timeout=max(0.05, deadline - time.time()),
                                         return_when=FIRST_COMPLETED)
                    for f in done:
                        data, err = f.result()
                        if data is not None:
                            return data, 200
                        if err:
                            last_err[0] = err
            finally:
                ex.shutdown(wait=False)  # stragglers finish on their own socket timeout
        insts = [i for i in insts if _yt_down_until.get(i, 0) <= time.time()]
    return {"error": "all YouTube instances failed: " + str(last_err[0])}, 502


_INNERTUBE_CLIENTS = [
    # (name, clientName, clientVersion, user-agent). IOS is the most
    # permissive for plain audio streams and answers from datacenter IPs
    # where the WEB client demands a sign-in. Ordered by reliability.
    ("ios", "IOS", "20.09.3", "com.google.ios.youtube/20.09.3 (iPhone14,3; U; CPU iOS 17_5_1 like Mac OS X)"),
    ("ios-old", "IOS", "19.09.3", "com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 17_0_1 like Mac OS X)"),
]


_yt_dlp_ok = None

def _yt_dlp_available():
    """yt-dlp is optional: it handles YouTube's signature/pot tokens and
    returns full-length streams (the raw innertube player endpoint caps
    unauthenticated audio to a ~1MB preview). When present it is the most
    reliable stream source; when missing we fall back to innertube/piped."""
    global _yt_dlp_ok
    if _yt_dlp_ok is None:
        try:
            import yt_dlp  # noqa: F401
            _yt_dlp_ok = True
        except Exception:
            _yt_dlp_ok = False
    return _yt_dlp_ok


def _yt_dlp_audio(video_id, timeout=25):
    """Resolve a full-length YouTube audio URL via yt-dlp (skip download).
    Returns (stream_url, "") on success or ("", err)."""
    if not _yt_dlp_available():
        return "", "yt-dlp not installed"
    import concurrent.futures as _cf
    import yt_dlp

    def run():
        opts = {
            "quiet": True,
            "no_warnings": True,
            "format": "bestaudio[ext=m4a]/bestaudio",
            "skip_download": True,
            "noplaylist": True,
            "socket_timeout": 15,
            "extractor_retries": 1,
        }
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info("https://www.youtube.com/watch?v=" + video_id, download=False)
            url = (info or {}).get("url") or ""
            if isinstance(url, str) and url.startswith("http"):
                return url.strip(), ""
            return "", "no url from yt-dlp"
        except Exception as e:
            return "", type(e).__name__ + ": " + str(e)[:80]

    ex = _cf.ThreadPoolExecutor(max_workers=1)
    try:
        fut = ex.submit(run)
        stream, err = fut.result(timeout=timeout)
        if stream:
            return stream, err
        return "", err
    except _cf.TimeoutError:
        return "", "yt-dlp timed out"
    finally:
        ex.shutdown(wait=False)


def _innertube_audio(video_id, timeout=12):
    """Resolve a playable YouTube audio URL via YouTube's own innertube
    player API (the endpoint the mobile apps use). This is the most reliable
    stream source: public Piped/Invidious pools are mostly dead or bot-checked
    in 2026, while the innertube player endpoint still hands out plain
    googlevideo audio URLs without any account. Clients are raced in
    parallel; the first with a usable audio stream wins.

    Returns (stream_url, via) or ("", err)."""
    import urllib.request, urllib.error, json as _json
    from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED

    def try_one(client):
        name, cname, cver, ua = client
        body = _json.dumps({
            "context": {"client": {"clientName": cname, "clientVersion": cver, "hl": "en"}},
            "videoId": video_id,
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
            data=body,
            headers={
                "Content-Type": "application/json",
                "User-Agent": ua,
                "Origin": "https://www.youtube.com",
                "Referer": "https://www.youtube.com/",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = _json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as e:
            return "", type(e).__name__ + " from " + name
        if not isinstance(data, dict) or data.get("playabilityStatus", {}).get("status") != "OK":
            ps = (data or {}).get("playabilityStatus", {}) or {}
            return "", (str(ps.get("status")) + ": " + str(ps.get("reason") or "")[:60]).strip() or ("no player from " + name)
        fmts = (data.get("streamingData") or {}).get("adaptiveFormats") or []
        audio = [s for s in fmts if isinstance(s, dict)
                 and (s.get("url") or "").startswith("http")
                 and str(s.get("mimeType") or "").startswith("audio/")]
        audio.sort(key=lambda s: int(s.get("averageBitrate") or 0), reverse=True)
        if audio:
            return (audio[0].get("url") or "").strip(), name
        return "", "no audio formats from " + name

    last_err = [""]
    ex = ThreadPoolExecutor(max_workers=len(_INNERTUBE_CLIENTS))
    try:
        pending = [ex.submit(try_one, c) for c in _INNERTUBE_CLIENTS]
        deadline = time.time() + timeout + 2
        while pending and time.time() < deadline:
            done, pending = wait(pending, timeout=max(0.05, deadline - time.time()),
                                 return_when=FIRST_COMPLETED)
            for f in done:
                stream, via = f.result()
                if stream:
                    return stream, via
                if via:
                    last_err[0] = via
    finally:
        ex.shutdown(wait=False)
    return "", last_err[0]


def _invidious_video(video_id, timeout=6):
    """Resolve a playable YouTube URL when Piped's stream endpoint fails.

    All instances are raced in parallel under a short global deadline. The old
    serial loop could stall the queue up to ~90s (6 instances x 15s) whenever
    Piped returned nothing, which made Music feel dead; this returns fast with
    an empty result instead of letting one broken track wedge playback."""
    import urllib.request, urllib.error, urllib.parse, json as _json
    from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED

    def try_one(inst):
        api_url = inst + "/api/v1/videos/" + urllib.parse.quote(video_id)
        req = urllib.request.Request(api_url, headers={
            "User-Agent": "Mozilla/5.0 ChalkleMusic/1.0",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = _json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as e:
            return "", type(e).__name__ + " from " + inst
        adaptive = [s for s in (data.get("adaptiveFormats") or [])
                    if isinstance(s, dict) and (s.get("url") or "").startswith("http")]
        audio = [s for s in adaptive if str(s.get("type") or "").startswith("audio/")]
        audio.sort(key=lambda s: int(s.get("bitrate") or 0), reverse=True)
        formats = [s for s in (data.get("formatStreams") or [])
                   if isinstance(s, dict) and (s.get("url") or "").startswith("http")
                   and "video/mp4" in str(s.get("type") or "")]
        choice = audio[0] if audio else (formats[-1] if formats else None)
        if choice:
            return (choice.get("url") or "").strip(), ""
        return "", "no usable stream from " + inst

    last_err = [""]
    ex = ThreadPoolExecutor(max_workers=len(INVIDIOUS_INSTANCES))
    try:
        pending = [ex.submit(try_one, i) for i in INVIDIOUS_INSTANCES]
        deadline = time.time() + timeout + 2
        while pending and time.time() < deadline:
            done, pending = wait(pending, timeout=max(0.05, deadline - time.time()),
                                 return_when=FIRST_COMPLETED)
            for f in done:
                stream, err = f.result()
                if stream:
                    return stream
                if err:
                    last_err[0] = err
    finally:
        ex.shutdown(wait=False)  # stragglers finish on their own socket timeout
    return ""


class _YouTubeRelay:
    """Mixin with the YouTube relay handlers; combined into Handler below."""

    def _yt_json(self, obj, code=200, cacheable=False):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "public, max-age=60" if cacheable else "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _yt_rewrite_thumbs(self, obj):
        """Rewrite piped thumbnail/avatar URLs to our /yt/thumb proxy."""
        if isinstance(obj, dict):
            for k in list(obj.keys()):
                v = obj[k]
                if isinstance(v, str) and v.startswith(("http://", "https://")):
                    if k in ("thumbnail", "avatarUrl", "uploaderAvatar"):
                        obj[k] = "/yt/thumb?u=" + _yt_b64u(v)
                    else:
                        obj[k] = v
                else:
                    self._yt_rewrite_thumbs(v)
        elif isinstance(obj, list):
            for it in obj:
                self._yt_rewrite_thumbs(it)

    def _yt_cached(self, key):
        hit = _yt_cache.get(key)
        if hit and (time.time() - hit[0]) < _YT_CACHE_TTL:
            return hit[1]
        return None

    def _yt_cache_set(self, key, payload):
        _yt_cache[key] = (time.time(), payload)
        if len(_yt_cache) > 200:
            now = time.time()
            for k in [k for k, (ts, _) in _yt_cache.items() if now - ts > _YT_CACHE_TTL * 2]:
                _yt_cache.pop(k, None)

    def _yt_search(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)
        q = (qs.get("q") or [""])[0].strip()
        filt = (qs.get("filter") or ["videos"])[0].strip() or "videos"
        if not q:
            return self._yt_json({"error": "missing q"}, 400)
        import urllib.parse
        key = "search:" + q.lower() + ":" + filt
        cached = self._yt_cached(key)
        if cached is not None:
            return self._yt_json(cached, 200, cacheable=True)
        path = "/search?q=" + urllib.parse.quote(q) + "&filter=" + urllib.parse.quote(filt)
        data, code = _yt_fetch_json(path)
        if isinstance(data, dict) and data.get("error"):
            return self._yt_json(data, code)
        items = data.get("items") if isinstance(data, dict) else data
        items = items if isinstance(items, list) else []
        self._yt_rewrite_thumbs(items)
        payload = {"items": items, "count": len(items)}
        self._yt_cache_set(key, payload)
        return self._yt_json(payload, 200, cacheable=True)

    def _yt_trending(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)
        region = (qs.get("region") or ["US"])[0].strip() or "US"
        key = "trending:" + region
        cached = self._yt_cached(key)
        if cached is not None:
            return self._yt_json(cached, 200, cacheable=True)
        data, code = _yt_fetch_json("/trending?region=" + region)
        if isinstance(data, dict) and data.get("error"):
            return self._yt_json(data, code)
        items = data if isinstance(data, list) else (data.get("items") if isinstance(data, dict) else [])
        items = items if isinstance(items, list) else []
        self._yt_rewrite_thumbs(items)
        payload = {"items": items, "count": len(items)}
        self._yt_cache_set(key, payload)
        return self._yt_json(payload, 200, cacheable=True)

    def _yt_channel(self, cid):
        import urllib.parse
        if not cid or "/" in cid or "?" in cid:
            return self._yt_json({"error": "bad channel id"}, 400)
        key = "channel:" + cid
        cached = self._yt_cached(key)
        if cached is not None:
            return self._yt_json(cached, 200, cacheable=True)
        data, code = _yt_fetch_json("/channel/" + urllib.parse.quote(cid))
        if isinstance(data, dict) and data.get("error"):
            return self._yt_json(data, code)
        if isinstance(data, dict):
            self._yt_rewrite_thumbs(data)
            payload = {
                "id": data.get("id"),
                "name": data.get("name"),
                "avatarUrl": data.get("avatarUrl"),
                "subscriberCount": data.get("subscriberCount"),
                "description": data.get("description"),
                "relatedStreams": data.get("relatedStreams") or [],
            }
            self._yt_cache_set(key, payload)
            return self._yt_json(payload, 200, cacheable=True)
        return self._yt_json({"error": "channel not found"}, 404)

    def _yt_thumb(self):
        import urllib.parse, socket
        from urllib.parse import urlparse
        q = urllib.parse.parse_qs(urlparse(self.path).query)
        raw = (q.get("u") or [""])[0].strip()
        if not raw:
            return self._yt_json({"error": "missing u"}, 400)
        url = raw if raw.startswith(("http://", "https://")) else None
        if not url:
            try:
                url = _yt_unb64u(raw)
            except Exception:
                return self._yt_json({"error": "bad u"}, 400)
        if not url.startswith(("http://", "https://")):
            return self._yt_json({"error": "bad u"}, 400)
        host = urlparse(url).hostname or ""
        try:
            ip = socket.gethostbyname(host)
        except Exception:
            return self._yt_json({"error": "dns"}, 502)
        if _is_private_ip(ip):
            return self._yt_json({"error": "private target"}, 403)
        if not _yt_thumb_serve(self, url):
            return self._yt_json({"error": "upstream unavailable"}, 502)


# ---------------------------------------------------------------- /api/live-tv
# Live TV. Channels live in livetv.json on the server (never in the page),
# so upstream URLs / referers / user-agents stay server-side:
#   GET  /api/live-tv            -> channel list with proxied stream paths
#   GET  /api/live-tv/<id>       -> HLS proxy: fetches the channel playlist,
#                                   rewrites every URI in it back through
#                                   /api/live-tv/<id>?u=<encoded>, and streams
#                                   segments through the same origin (no CORS /
#                                   mixed-content, upstream URL never leaks).
#   POST /api/live-tv/admin      -> save the channel list (admin panel)
# The browser only ever sees this origin; hls.js plays the proxied playlist.

LIVETV_CFG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "livetv.json")
_livetv_cache = {"m": 0, "cfg": {"channels": []}}
_livetv_live_cache = {}   # channel id -> (ts, True/False/None)


def _livetv_cfg():
    m = 0
    try:
        m = os.path.getmtime(LIVETV_CFG_PATH)
    except OSError:
        pass
    if m and m != _livetv_cache["m"]:
        try:
            with open(LIVETV_CFG_PATH, "r", encoding="utf-8") as f:
                _livetv_cache["cfg"] = json.load(f) or {}
        except Exception:
            _livetv_cache["cfg"] = {"channels": []}
        _livetv_cache["m"] = m
    return _livetv_cache["cfg"]


class _LiveTV:
    """Mixin with the live TV handlers; combined into Handler below."""

    def _livetv_json(self, obj, code=200):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    @staticmethod
    def _livetv_ua(ch):
        return (str(ch.get("userAgent") or "").strip()
                or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

    def _livetv_headers(self, ch, extra=None):
        h = {"User-Agent": self._livetv_ua(ch), "Accept": "*/*"}
        ref = str(ch.get("referer") or "").strip()
        if ref:
            h["Referer"] = ref
        if extra:
            h.update(extra)
        return h

    def _livetv_channels(self):
        return [c for c in (_livetv_cfg().get("channels") or []) if c.get("enabled", True)]

    def _livetv_by_id(self, cid):
        for c in self._livetv_channels():
            if c.get("id") == cid:
                return c
        return None

    def _livetv_live(self, ch):
        """Cheap playlist probe, cached 30s, so the grid can show live/offline
        dots without hammering the CDNs."""
        import time
        cid = ch.get("id") or ""
        now = time.time()
        hit = _livetv_live_cache.get(cid)
        if hit and now - hit[0] < 30:
            return hit[1]
        ok = False
        try:
            import urllib.request, urllib.error
            req = urllib.request.Request(ch.get("streamUrl", ""), headers=self._livetv_headers(ch))
            with urllib.request.urlopen(req, timeout=6) as resp:
                head = resp.read(64)
                ok = resp.getcode() == 200 and b"#EXTM3U" in head
        except Exception:
            ok = False
        _livetv_live_cache[cid] = (now, ok)
        return ok

    def _livetv_list(self):
        out = []
        for c in self._livetv_channels():
            cid = c.get("id") or ""
            out.append({
                "id": cid,
                "name": c.get("name") or cid,
                "category": c.get("category") or "Other",
                "logo": c.get("logo") or "",
                "live": self._livetv_live(c),
                "stream": "/api/live-tv/" + cid,
            })
        out.sort(key=lambda c: (c["name"] or "").lower())
        self._livetv_json({"ok": True, "channels": out})

    def _livetv_stream(self, cid):
        """HLS proxy for one channel. No ?u= -> fetch + rewrite the channel
        playlist. With ?u= -> fetch that exact upstream (variant playlist or
        segment), pass Range through, stream it back with the upstream type.
        URI rewriting resolves relative refs against the playlist's own URL, so
        hls.js only ever talks to this origin."""
        import urllib.request, urllib.error, urllib.parse
        ch = self._livetv_by_id(cid)
        if not ch:
            return self._livetv_json({"ok": False, "error": "no-channel"}, 404)
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        target = (q.get("u") or [""])[0].strip()
        url = target or str(ch.get("streamUrl") or "")
        if not url.startswith(("http://", "https://")):
            return self._livetv_json({"ok": False, "error": "bad-url"}, 400)
        try:
            host = urllib.parse.urlparse(url).hostname or ""
            ip = socket.gethostbyname(host)
            if _is_private_ip(ip):
                return self._livetv_json({"ok": False, "error": "private-ip"}, 403)
        except Exception:
            return self._livetv_json({"ok": False, "error": "dns-fail"}, 502)
        headers = self._livetv_headers(ch)
        rng = self.headers.get("Range")
        if rng:
            headers["Range"] = rng
        try:
            resp = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30)
        except urllib.error.HTTPError as e:
            return self._livetv_json({"ok": False, "error": "upstream http " + str(e.code)}, e.code)
        except Exception as e:
            return self._livetv_json({"ok": False, "error": type(e).__name__}, 502)
        code = resp.getcode() or 200
        ctype = (resp.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip().lower()
        # Decide playlist vs segment by what the upstream actually sent, not by
        # whether a ?u= was given: variant playlists arrive WITH ?u= too (hls.js
        # fetches them through the same proxy path) and must be rewritten just
        # like the channel master, otherwise their relative segment URIs leak
        # and 404.
        is_playlist = "mpegurl" in ctype or "m3u8" in ctype or (not target)
        self.send_response(code)
        if is_playlist:
            self.send_header("Content-Type", "application/vnd.apple.mpegurl")
        else:
            self.send_header("Content-Type", ctype or "application/octet-stream")
            clen = resp.headers.get("Content-Length")
            if clen:
                self.send_header("Content-Length", clen)
            crange = resp.headers.get("Content-Range")
            if crange:
                self.send_header("Content-Range", crange)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        if is_playlist:
            raw = b""
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                raw += chunk
            self.wfile.write(self._livetv_rewrite(raw.decode("utf-8", "replace"), url, cid).encode("utf-8", "replace"))
        else:
            try:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            except Exception:
                pass

    def _livetv_rewrite(self, text, base, cid):
        """Rewrite every URI in an m3u8 back through this proxy. Bare URI lines
        and URI="..." attributes (EXT-X-MEDIA, EXT-X-MAP, I-FRAME-STREAM-INF)
        both become /api/live-tv/<id>?u=<encoded absolute URL>."""
        import urllib.parse

        def wrap(uri):
            uri = str(uri or "").strip()
            if not uri or uri.startswith(("#", "data:", "blob:")):
                return uri
            absu = urllib.parse.urljoin(base, uri)
            return "/api/live-tv/%s?u=%s" % (cid, urllib.parse.quote(absu, safe=""))

        out = []
        for line in text.splitlines():
            s = line.strip()
            if not s:
                out.append(line)
                continue
            if s.startswith("#"):
                if "URI=" in s:
                    s = re.sub(r"URI=\"([^\"]*)\"", lambda m: 'URI="' + wrap(m.group(1)) + '"', s)
                    s = re.sub(r"URI='([^']*)'", lambda m: "URI='" + wrap(m.group(1)) + "'", s)
                out.append(s)
            else:
                out.append(wrap(s))
        return "\n".join(out) + "\n"

    def _livetv_raw(self):
        """Admin GET: the full channel config (including streamUrl / referer /
        userAgent), used to populate the Settings -> Live TV editor."""
        self._livetv_json({"ok": True, "channels": _livetv_cfg().get("channels") or []})

    def _livetv_save(self, body):
        """Admin save: replace livetv.json wholesale with the submitted channel
        list. Same trust model as the rest of this server (client-side admin
        gate, personal server behind a tunnel)."""
        import time
        try:
            payload = json.loads(body or b"{}")
        except Exception:
            payload = {}
        channels = payload.get("channels")
        if not isinstance(channels, list):
            return self._livetv_json({"ok": False, "error": "bad-list"}, 400)
        clean = []
        seen = set()
        for i, c in enumerate(channels):
            if not isinstance(c, dict):
                continue
            cid = str(c.get("id") or "").strip().lower()
            if not cid:
                cid = "ch" + str(int(time.time() * 1000)) + str(i)
            if cid in seen:
                cid = cid + str(i)
            seen.add(cid)
            clean.append({
                "id": cid,
                "name": str(c.get("name") or cid).strip()[:80],
                "category": str(c.get("category") or "Other").strip()[:40] or "Other",
                "logo": str(c.get("logo") or "").strip(),
                "streamUrl": str(c.get("streamUrl") or "").strip(),
                "referer": str(c.get("referer") or "").strip(),
                "userAgent": str(c.get("userAgent") or "").strip(),
                "enabled": bool(c.get("enabled", True)),
            })
        try:
            with open(LIVETV_CFG_PATH, "w", encoding="utf-8") as f:
                json.dump({"channels": clean}, f, indent=2)
        except Exception as e:
            return self._livetv_json({"ok": False, "error": type(e).__name__}, 500)
        _livetv_cache["m"] = 0
        _livetv_live_cache.clear()
        self._livetv_json({"ok": True, "count": len(clean)})


# ---------------------------------------------------------------- /api/livetv
# Sports feed from the Streamed API (streamed.pk). Everything the page sees
# is served from this origin: match lists are enriched server-side with a
# working embed player URL, and badge/poster images are relayed here so the
# upstream API never has to be reachable from the school network.
#   GET /api/livetv/sports              -> available sports [{id, name}]
#   GET /api/livetv/matches?sport=<id>  -> upcoming matches (embed resolved)
#   GET /api/livetv/img/<token>         -> badge/poster image proxy

SPORTS_API = "https://streamed.pk"
_sports_cache = {}   # key -> (ts, value)
_sports_img_cache = {}  # token -> (ts, (ctype, bytes))


class _SportsTV:
    """Mixin: sports matches from streamed.pk, resolved to playable embeds."""

    _SPORTS_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
    _SPORTS_TTL = 45          # seconds to cache the enriched match feed
    _SPORTS_LIST_TTL = 600
    _SPORTS_IMG_TTL = 3600

    def _sports_fetch(self, url, timeout=12):
        import urllib.request, urllib.error
        req = urllib.request.Request(url, headers={
            "User-Agent": self._SPORTS_UA,
            "Accept": "application/json, */*",
            "Referer": SPORTS_API + "/",
        })
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.getcode(), resp.read()

    def _sports_cached(self, key, ttl, loader):
        import time
        now = time.time()
        hit = _sports_cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
        val = loader()
        _sports_cache[key] = (now, val)
        return val

    def _sports_list(self):
        def load():
            try:
                code, body = self._sports_fetch(SPORTS_API + "/api/sports")
                if code == 200:
                    data = json.loads(body.decode("utf-8", "replace"))
                    if isinstance(data, list):
                        return data
            except Exception:
                pass
            return []
        self._livetv_json({"ok": True, "sports": self._sports_cached("sports:list", self._SPORTS_LIST_TTL, load)})

    def _sports_image(self, token):
        import time
        if not re.match(r"^[A-Za-z0-9+/=_.-]+$", token or ""):
            return self._livetv_json({"ok": False, "error": "bad-token"}, 400)
        now = time.time()
        hit = _sports_img_cache.get(token)
        if hit and now - hit[0] < self._SPORTS_IMG_TTL:
            ctype, body = hit[1]
        else:
            try:
                code, body = self._sports_fetch(
                    SPORTS_API + "/api/images/proxy/" + token + ".webp", timeout=10)
                if code != 200:
                    return self._livetv_json({"ok": False, "error": "img-%d" % code}, 502)
                ctype = "image/webp"
                _sports_img_cache[token] = (now, (ctype, body))
            except Exception:
                return self._livetv_json({"ok": False, "error": "img-fail"}, 502)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "public, max-age=3600")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _sports_resolve(source, sid):
        """Query /api/stream/<source>/<id> and return the first embed entry."""
        import urllib.request
        try:
            req = urllib.request.Request(
                SPORTS_API + "/api/stream/%s/%s" % (source, sid),
                headers={"User-Agent": _SportsTV._SPORTS_UA,
                         "Accept": "application/json", "Referer": SPORTS_API + "/"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            if isinstance(data, list):
                for it in data:
                    if isinstance(it, dict) and it.get("embedUrl"):
                        return it
        except Exception:
            pass
        return None

    def _sports_matches(self, sport):
        import urllib.parse, threading
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        requested = (qs.get("sport") or [""])[0].strip().lower()

        def load():
            import concurrent.futures
            sports = [{"id": requested}] if requested else None
            if sports is None:
                try:
                    code, body = self._sports_fetch(SPORTS_API + "/api/sports")
                    sports = json.loads(body.decode("utf-8", "replace")) if code == 200 else []
                except Exception:
                    sports = []
            # Keep the feed bounded: nearest-kickoff matches per sport. The
            # per-sport fetches run in parallel (like the stream resolution
            # below), otherwise the first cold load fans out 12 sequential
            # network calls and the page sits on "Finding live matches..."
            # for tens of seconds.
            def fetch_sport(s):
                sid = s.get("id") if isinstance(s, dict) else str(s)
                if not sid:
                    return []
                try:
                    code, body = self._sports_fetch(
                        SPORTS_API + "/api/matches/" + urllib.parse.quote(sid))
                    if code == 200:
                        arr = json.loads(body.decode("utf-8", "replace"))
                        if isinstance(arr, list):
                            arr.sort(key=lambda m: m.get("date") or 0)
                            return arr[:10]
                except Exception:
                    pass
                return []

            all_matches = []
            with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
                batches = list(pool.map(fetch_sport, sports[:12]))
            for arr in batches:
                all_matches.extend(arr)

            lock = threading.Lock()
            out = []

            def work(m):
                for src in (m.get("sources") or []):
                    s = src.get("source") if isinstance(src, dict) else None
                    i = src.get("id") if isinstance(src, dict) else None
                    if not s or not i:
                        continue
                    hit = self.__class__._sports_resolve(s, i)
                    if not hit:
                        continue
                    with lock:
                        out.append({
                            "id": m.get("id"),
                            "title": m.get("title"),
                            "category": m.get("category"),
                            "date": m.get("date"),
                            "popular": bool(m.get("popular")),
                            "league": (m.get("poster") is not None),
                            "poster": (self._sports_img_path(m.get("poster"))
                                        if m.get("poster") else None),
                            "teams": {
                                "home": self._sports_team(m.get("teams") and m.get("teams").get("home")),
                                "away": self._sports_team(m.get("teams") and m.get("teams").get("away")),
                            },
                            "embed": hit.get("embedUrl"),
                            "hd": bool(hit.get("hd")),
                            "lang": (hit.get("language") or "").strip(),
                            "source": s,
                        })
                    return

            with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
                list(ex.map(work, all_matches))
            out.sort(key=lambda m: m.get("date") or 0)
            return out[:48]

        self._livetv_json({"ok": True, "matches": self._sports_cached(
            "sports:matches:" + requested, self._SPORTS_TTL, load)})

    @staticmethod
    def _sports_img_path(rel):
        if not rel:
            return None
        tok = rel.rsplit("/", 1)[-1]
        if tok.endswith(".webp"):
            tok = tok[:-5]
        return "/api/livetv/img/" + tok if tok else None

    @staticmethod
    def _sports_team(t):
        if not isinstance(t, dict):
            return {"name": "", "badge": None}
        return {"name": str(t.get("name") or ""),
                "badge": _SportsTV._sports_img_path(t.get("badge") or "")}



# ---------------------------------------------------------------- /bitcord relay
# Same-origin relay for the embedded Bitcord chat app. Bitcord is a separate
# Node/Express + WebSocket process on 127.0.0.1:4123. The page is served as
# static files from the bitcord/ folder (base href=/bitcord/), and every API
# call and the WebSocket connect are tunneled through this origin so the iframe
# never talks cross-origin and nothing is blocked by school filters.
#
# Bitcord's built index.html ships with <base href="/bitcord/">, so its
# fetch("/api/..." ) calls resolve to /bitcord/api/... and its WebSocket
# connects to /bitcord/ws. Both are forwarded here.
BITCORD_BACKEND = "http://127.0.0.1:4123"
BITCORD_WS = "ws://127.0.0.1:4123"

class _BitcordRelay:
    """Mixin with the Bitcord API + WebSocket proxy handlers."""

    def _bitcord_is_up(self):
        import socket
        try:
            s = socket.create_connection(("127.0.0.1", 4123), timeout=3)
            s.close()
            return True
        except Exception:
            return False

    def _bitcord_forward(self, method, subpath, post_body=None, timeout=30):
        """Forward one HTTP request to the Bitcord API. Returns a response dict."""
        import urllib.request, urllib.error
        url = BITCORD_BACKEND + subpath
        headers = {
            "User-Agent": "ChalkleBitcordRelay/1.0",
            "Accept": "*/*",
        }
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip()
        if post_body is not None:
            headers["Content-Type"] = ctype or "application/json"
            if isinstance(post_body, str):
                post_body = post_body.encode("utf-8")
        # Forward cookies (session) and relevant headers so Bitcord sees the
        # same session the iframe is authenticated with.
        for h in ("Cookie", "Referer", "Origin", "X-Requested-With"):
            v = self.headers.get(h)
            if v:
                headers[h] = v
        req = urllib.request.Request(url, data=post_body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                rtype = (resp.headers.get("Content-Type") or "application/json").split(";")[0].strip()
                out = {"code": resp.getcode() or 200, "type": rtype, "body": raw}
                # Mirror Set-Cookie from Bitcord so the session cookie is set on
                # the Chalkle origin (the iframe is same-origin enough that the
                # cookie lands on the top-level host, which is what Bitcord checks).
                for k in ("Set-Cookie", "Cache-Control"):
                    v = resp.headers.get(k)
                    if v:
                        out[k] = v
                return out
        except urllib.error.HTTPError as e:
            raw = e.read()
            return {"code": e.code, "type": e.headers.get("Content-Type", "application/json").split(";")[0].strip(), "body": raw}
        except Exception as e:
            return {"code": 502, "type": "application/json",
                    "body": ("Bitcord server unreachable - is it running on port 4123?").encode()}

    def _bitcord_send(self, r):
        self.send_response(r["code"])
        self.send_header("Content-Type", r["type"] or "application/octet-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        for k in ("Set-Cookie", "Cache-Control"):
            v = r.get(k)
            if v:
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(r["body"])))
        self.end_headers()
        try:
            self.wfile.write(r["body"])
        except Exception:
            pass

    def _bitcord_api(self, route):
        """Handle /bitcord/api/* -> proxy to Bitcord backend. Any HTTP method."""
        if not route.startswith("/bitcord/api/") and not route.startswith("/bitcord/api?"):
            return None
        method = (self.command or "GET").upper()
        if method in ("GET", "HEAD"):
            body = None
        else:
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(length) if length > 0 else None
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        subpath = route[len("/bitcord"):]  # /api/... (keeps leading /)
        if query:
            sep = "&" if "?" in subpath else "?"
            subpath += sep + query
        r = self._bitcord_forward(method, subpath, post_body=body, timeout=30)
        if r is None:
            return None
        self._bitcord_send(r)
        return True

    def _bitcord_ws(self):
        """Tunnel a WebSocket upgrade from /bitcord/ws to the Bitcord WS server."""
        if not self.path.startswith("/bitcord/ws"):
            return None
        target = BITCORD_WS + "/ws"
        import urllib.parse
        parts = urllib.parse.urlsplit(target)
        host = parts.hostname or "127.0.0.1"
        port = parts.port or 4123
        path = parts.path or "/ws"
        if parts.query:
            path += "?" + parts.query
        try:
            sock = socket.create_connection((host, port), timeout=15)
        except Exception as e:
            self._bitcord_json({"error": "ws connect failed: " + type(e).__name__}, 502)
            return True
        try:
            key = self.headers.get("Sec-WebSocket-Key", "").strip()
            ver = self.headers.get("Sec-WebSocket-Version", "13").strip()
            proto = self.headers.get("Sec-WebSocket-Protocol", "").strip()
            lines = ["GET %s HTTP/1.1" % path, "Host: %s" % host, "Upgrade: websocket", "Connection: Upgrade"]
            if key:
                lines.append("Sec-WebSocket-Key: " + key)
            if ver:
                lines.append("Sec-WebSocket-Version: " + ver)
            if proto:
                lines.append("Sec-WebSocket-Protocol: " + proto)
            origin = self.headers.get("Origin", "")
            if origin:
                lines.append("Origin: " + origin)
            sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
            head = b""
            while b"\r\n\r\n" not in head:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                head += chunk
                if len(head) > 65536:
                    break
        except Exception as e:
            try:
                sock.close()
            except Exception:
                pass
            self._bitcord_json({"error": "ws handshake failed: " + type(e).__name__}, 502)
            return True
        try:
            self.connection.sendall(head)
            self.close_connection = True
        except Exception:
            try:
                sock.close()
            except Exception:
                pass
            return True

        def _pump(src, dst):
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except Exception:
                pass
            finally:
                try:
                    dst.shutdown(socket.SHUT_WR)
                except Exception:
                    pass

        t1 = threading.Thread(target=_pump, args=(self.connection, sock), daemon=True)
        t2 = threading.Thread(target=_pump, args=(sock, self.connection), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        try:
            sock.close()
        except Exception:
            pass
        return True

    def _bitcord_json(self, obj, code=200):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _bitcord_static(self, route):
        """Serve Bitcord static files directly from the bitcord/ folder."""
        if not route.startswith("/bitcord/") and route != "/bitcord":
            return None
        rel = route[len("/bitcord"):] or "/"
        if not rel.startswith("/"):
            rel = "/" + rel
        body_root = os.path.join(WEB_ROOT, "bitcord")
        dest = os.path.normpath(os.path.join(body_root, rel.lstrip("/")))
        if not dest.startswith(body_root) or not os.path.isfile(dest):
            return None
        ctype, _ = mimetypes.guess_type(dest)
        if not ctype:
            ext = os.path.splitext(dest)[1].lower()
            ctype = {
                ".js": "application/javascript",
                ".mjs": "application/javascript",
                ".css": "text/css",
                ".html": "text/html",
                ".json": "application/json",
                ".svg": "image/svg+xml",
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".webp": "image/webp",
                ".wasm": "application/wasm",
                ".ico": "image/x-icon",
                ".webmanifest": "application/manifest+json",
            }.get(ext, "application/octet-stream")
        try:
            with open(dest, "rb") as f:
                raw = f.read()
        except Exception:
            return None
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except Exception:
            pass
        return True



class _ChatUpload:
    """Chat image uploads -> Cloudflare R2 (free tier, zero egress).

    POST /chat-upload-image  multipart "file" -> {"ok":true,"url":...}
    GET  /chat-image/<key>   stream the stored image back (fallback when the
                             bucket has no public base configured).

    Keys are content-addressed (images/<sha256>.<ext>) and immutable, so
    re-uploads are free and caching is safe. Disabled (503) unless the R2_*
    env vars are set, so nothing changes until credentials exist.
    """

    MAX_IMAGE_BYTES = 1_500_000

    _MAGIC_EXT = (
        (bytes([0xFF, 0xD8, 0xFF]), "jpg"),
        (bytes([0x89]) + b"PNG", "png"),
        (b"GIF8", "gif"),
        (b"RIFF", "webp"),
    )
    _CTYPES = {"jpg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp"}

    def _r2_client(self):
        if getattr(self, "_r2", None) is not None:
            return self._r2
        if getattr(self, "_r2_checked", False):
            return None
        self._r2_checked = True
        acct = os.environ.get("R2_ACCOUNT_ID", "")
        key = os.environ.get("R2_ACCESS_KEY_ID", "")
        secret = os.environ.get("R2_SECRET_ACCESS_KEY", "")
        bucket = os.environ.get("R2_BUCKET", "")
        if not (acct and key and secret and bucket):
            return None
        try:
            import boto3
            from botocore.config import Config
            self._r2 = boto3.client(
                "s3",
                endpoint_url="https://%s.r2.cloudflarestorage.com" % acct,
                aws_access_key_id=key,
                aws_secret_access_key=secret,
                config=Config(signature_version="s3v4"),
            )
            self._r2_bucket = bucket
            pub = os.environ.get("R2_PUBLIC_BASE", "").strip().rstrip("/")
            self._r2_public_base = pub or None
            return self._r2
        except Exception as e:
            print("[chat-upload] R2 unavailable: %s" % e)
            return None

    def _chat_upload_json(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_chat_upload_image(self):
        client = self._r2_client()
        if not client:
            return self._chat_upload_json(503, {"ok": False, "error": "upload not configured"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > self.MAX_IMAGE_BYTES + 64 * 1024:
                return self._chat_upload_json(413, {"ok": False, "error": "too large"})
            body = self.rfile.read(length)
            ctype = self.headers.get("Content-Type", "")
            m = re.search(r"boundary=([^;]+)", ctype)
            if not m:
                return self._chat_upload_json(400, {"ok": False, "error": "expected multipart"})
            boundary = m.group(1).strip().encode()
            part = None
            for chunk in body.split(b"--" + boundary):
                if b"Content-Disposition" in chunk and b"filename" in chunk:
                    part = chunk
                    break
            if not part:
                return self._chat_upload_json(400, {"ok": False, "error": "no file part"})
            idx = part.find(b"\r\n\r\n")
            if idx < 0:
                return self._chat_upload_json(400, {"ok": False, "error": "malformed part"})
            data = part[idx + 4:]
            if data.endswith(b"\r\n"):
                data = data[:-2]
            if len(data) > self.MAX_IMAGE_BYTES:
                return self._chat_upload_json(413, {"ok": False, "error": "too large"})

            ext = None
            for magic, e2 in self._MAGIC_EXT:
                if data[:16].startswith(magic):
                    ext = e2
                    break
            ext = ext or "png"
            digest = hashlib.sha256(data).hexdigest()[:32]
            key = "images/%s.%s" % (digest, ext)
            client.put_object(
                Bucket=self._r2_bucket,
                Key=key,
                Body=data,
                ContentType=self._CTYPES.get(ext, "application/octet-stream"),
                CacheControl="public, max-age=31536000, immutable",
            )
            base = getattr(self, "_r2_public_base", None)
            url = ("%s/%s" % (base, key)) if base else ("/chat-image/%s" % key.split("/", 1)[1])
            self._chat_upload_json(200, {"ok": True, "url": url, "key": key})
        except Exception as e:
            print("[chat-upload] error: %s" % e)
            self._chat_upload_json(500, {"ok": False, "error": str(e)[:200]})

    def handle_chat_image_get(self, key):
        client = self._r2_client()
        if not client or not re.fullmatch(r"[a-f0-9]{32}\.(jpg|png|gif|webp)", key or ""):
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "9")
            self.end_headers()
            self.wfile.write(b"not found")
            return
        try:
            obj = client.get_object(Bucket=self._r2_bucket, Key="images/%s" % key)
            data = obj["Body"].read()
            ext = key.rsplit(".", 1)[-1].lower()
            payload = data
            self.send_response(200)
            self.send_header("Content-Type", self._CTYPES.get(ext, "application/octet-stream"))
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception:
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "9")
            self.end_headers()
            self.wfile.write(b"not found")


class Handler(_CloudRelay, _MusicRelay, _YouTubeRelay, _LiveTV, _SportsTV, _BitcordRelay, _ChatUpload, SimpleHTTPRequestHandler):
    # HTTP/1.1 keep-alive: the old HTTP/1.0 default made the browser tear down
    # and re-handshake TLS for every single request (games open dozens of
    # assets at once). With 1.1, BaseHTTPRequestHandler only reuses the socket
    # when the response is self-contained, so any code path that must stay
    # lengthless streams calls _stabilize() to force a safe close.
    protocol_version = "HTTP/1.1"

    def _stabilize(self):
        """Force connection close for responses that stream without a
        Content-Length (proxy pipes, chunked relays)."""
        self.close_connection = True

    def log_message(self, *a):  # quieter than the default per-request logger
        pass

    def send_header(self, keyword, value):
        # Never send the CORS header twice: the blanket header added in
        # send_response plus a relay handler's own header used to produce
        # "Access-Control-Allow-Origin: *, *", which browsers reject outright
        # and which killed music/YouTube/LiveTV/AI from the GitHub Pages and
        # jsDelivr mirrors.
        if keyword.lower() == "access-control-allow-origin" and getattr(self, "_cors_sent", False):
            return
        super().send_header(keyword, value)

    def send_response(self, code, message=None):
        super().send_response(code, message)
        # Ruffle SWF wrappers run in an opaque (blob:null) about:blank tab, so
        # they must be able to fetch game assets cross-origin. Sent via super()
        # directly so the dedupe guard below cannot eat it, then the guard is
        # armed so any relay handler that sends the header again is skipped.
        super().send_header("Access-Control-Allow-Origin", "*")
        self._cors_sent = True
        # Don't leak the referrer to mirror sites the launcher opens. nosniff
        # applies everywhere EXCEPT the built-in proxy: it re-serves third-party
        # pages whose MIME labels lie (JSONP labeled text/html, JS labeled
        # text/plain), and strict sniffing refusal turns every one of those into
        # a hard block instead of a working page. The proxy sets an explicit
        # Content-Type per branch, so there is nothing to sniff there anyway.
        if not self.path.split("?", 1)[0].lower().startswith(_UV_PFX):
            self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        # Images and versioned (?v=...) js/css are safe to cache hard: a
        # version bump changes the URL, so a stale copy can never be served.
        # Everything else (html, unversioned js/css, api) stays no-store so
        # live edits are picked up instantly.
        bits = self.path.split("?", 1)
        route = bits[0].lower()
        q = bits[1] if len(bits) > 1 else ""
        # Never let an error response be hard-cached: Cloudflare will happily
        # cache a 404 for a day otherwise, and the file stays broken at the
        # edge even after it exists on disk (exact bug hit /src/bg-chalk.webp).
        if code >= 400:
            self.send_header("Cache-Control", "no-store, max-age=0")
        elif route.endswith((".webp", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".avif")):
            self.send_header("Cache-Control", "public, max-age=86400")
        elif route.endswith((".js", ".css", ".mjs")) and q.startswith("v="):
            self.send_header("Cache-Control", "public, max-age=86400")
        elif route.startswith(_UV_PFX) or route == _UV_PFX.rstrip("/"):
            # The proxy writes its own Cache-Control per asset type after
            # this (rewritten text gets a short cache, binaries/image/font get
            # long caches, HTML/API stay no-store) - don't preempt it with a
            # blanket no-store, which would duplicate and win the header merge.
            pass
        elif route.startswith("/bitcord/") or route == "/bitcord":
            # Bitcord assets change on every rebuild (hashed filenames), and the
            # embed page itself should never be stale-cached for offline users.
            self.send_header("Cache-Control", "no-store, max-age=0")
        else:
            # Safety net: anything not explicitly cacheable (the bare index
            # route, api paths, unknown types) must never be stale-cached.
            self.send_header("Cache-Control", "no-store, max-age=0")

    def send_head(self):
        # Gzip static text (html/css/js/json/svg/txt) when the client accepts
        # it. Images and binaries pass through to the default handler. The
        # send_response call above this already sets CORS, nosniff, referrer
        # policy and cache rules, so a gzipped copy gets the same headers.
        # Conditional GET is skipped for the gzip branch on purpose: versioned
        # assets are hard-cached and everything else is no-store, so a full
        # 200 with the fresh bytes is always correct.
        import gzip, io
        route = self.path.split("?", 1)[0]
        # Never serve server-local files over the static handler: API keys,
        # the git directory, env files, runtime JSON state and the 146 MB
        # single-file build artifacts are local-only by design.
        low = route.lower()
        if (denied_local_path(low)
                or low.endswith("/.env")
                or low.startswith("/yut/store/")
                or low.endswith("/sync.json") or low.endswith("/cloud-relay.json")
                or low.endswith("/active-visitors.json")
                or low.endswith("/play-counts.json")
                or low.endswith("/livetv.json") or low.endswith("/ai_convos.json")):
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "9")
            self.end_headers()
            return io.BytesIO(b"not found")
        # Host split: the apex domain shows the Jexel tools hub, the chalkle
        # subdomain keeps the full site, and yut.lootline.xyz serves yut's own
        # upload site. Everything else (localhost, LAN IPs, mirror hosts) is
        # unchanged. Matches subdomains of the apex too, so a future
        # tools.lootline.xyz would also resolve into jexel/ unless it is the
        # chalkle or yut sub itself.
        try:
            req_host = (self.headers.get("Host") or "").split(":", 1)[0].strip().lower()
        except Exception:
            req_host = ""
        is_jexel_host = bool(req_host) and req_host == JEXEL_HOST or (
            req_host.endswith("." + JEXEL_HOST)
            and req_host != "chalkle." + JEXEL_HOST
            and req_host != "yut." + JEXEL_HOST
        )
        is_yut_host = req_host == YUT_HOST
        if (is_yut_host and route not in ("/_active", "/_health")
                and not route.startswith("/yut")):
            # Same trick as the jexel rewrite below: change the request path
            # itself so the default send_head() translates it to the yut/ dir.
            self.path = "/yut" + self.path
        if (is_jexel_host and route not in ("/_active", "/_health")
                and not route.startswith("/jexel")):
            # Rewrite the request path itself, not a local copy: the default
            # send_head() re-translates self.path, so a local variable would
            # only affect the directory/gzip checks below and never the file
            # actually served (the taiko shim above uses the same trick).
            self.path = "/jexel" + self.path
        route = self.path.split("?", 1)[0]
        path = self.translate_path(route)
        if os.path.isdir(path):
            candidate = os.path.join(path, "index.html")
            if os.path.isfile(candidate):
                path = candidate
            else:
                # No index here: 404 instead of falling through to the default
                # handler, which renders a full directory listing (GET /src/ or
                # /assets/ would expose the entire file tree to visitors).
                self.send_response(404)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", "9")
                self.end_headers()
                return io.BytesIO(b"not found")
        if os.path.isfile(path) and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            ctype = self.guess_type(path)
            if ctype and ctype.split(";")[0] in (
                "text/html", "text/css", "text/plain", "text/javascript",
                "application/javascript", "application/json", "application/xml",
                "image/svg+xml",
            ):
                try:
                    with open(path, "rb") as f:
                        raw = f.read()
                    gz = gzip.compress(raw, 6)
                    if len(gz) < len(raw):
                        self.send_response(200)
                        self.send_header("Content-Type", ctype)
                        self.send_header("Content-Encoding", "gzip")
                        self.send_header("Content-Length", str(len(gz)))
                        self.send_header("Last-Modified", self.date_time_string(os.path.getmtime(path)))
                        self.end_headers()
                        return io.BytesIO(gz)
                except OSError:
                    pass
        return super().send_head()

    def do_GET(self):
        route = self.path.split("?", 1)[0]
        # yut.lootline.xyz serves the yut/ folder. Rewrite before anything else
        # so the API router and the static fallback both see the /yut prefix
        # (send_head rewrites too, but only after do_GET picked a branch).
        if route not in ("/_active", "/_health") and not route.startswith("/yut"):
            try:
                _yhost = (self.headers.get("Host") or "").split(":", 1)[0].strip().lower()
            except Exception:
                _yhost = ""
            if _yhost == YUT_HOST:
                self.path = "/yut" + self.path
                route = self.path.split("?", 1)[0]
        if route.startswith(YUT_API_PATH):
            return _yut_api(self, route)
        if route == "/_active":
            return self._active()
        # Angry Birds Chrome (gn/316) phones home to chrome.angrybirds.com
        # endpoints that died with the Chrome Web Store. Stub them as
        # "offline mode" responses so the game boots without stalling.
        if route == "/cors/online-check":
            body = b"{}"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if route == "/fowl/metrics" or route.startswith("/fowl/google-login") or route == "/gwt-log":
            body = b"{}"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if route == "/_fetch":
            return self._fetch()
        if route == "/_sync":
            return self._sync_get()
        if route == "/_dhinfo":
            return self._dh_info()
        if route == "/_dhcheck":
            return self._dh_check()
        if route == "/_dhdns":
            return self._dh_dns()
        if route == "/_dhgeo":
            return self._dh_geo()
        if route.startswith("/chat-image/"):
            return self.handle_chat_image_get(route[len("/chat-image/"):])
        if route == "/api/plays":
            return self._plays_get()
        if route == "/api/proxy/backends" or route == "/api/proxy/backend":
            return self._proxy_backends_get()
        if route == "/api/ai/models":
            return self._ai_models()
        if route == "/api/ai/convos":
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            return self._ai_convos_get((qs.get("v") or ["anon"])[0])
        if route == _UV_PFX.rstrip("/") or route == _UV_PFX:
            return self._uv_boot()
        if route.startswith(_UV_PFX):
            if (self.headers.get("Upgrade") or "").lower() == "websocket":
                return self._uv_ws(route[len(_UV_PFX):])
            # ?b=<id> pins a backend straight from a link (the Proxies tab
            # POSTs the same choice, this is just the shareable form).
            try:
                qb = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("b")
                if qb:
                    _chain_set(qb[0])
            except Exception:
                pass
            _uv_note_referer(self.headers.get("Referer"))
            return self._uv_route(route[len(_UV_PFX):])
        if route == "/cloud/health":
            return self._cloud_health()
        if route == "/_health":
            return self._app_health()
        if route.startswith("/cloud/v1/signal/"):
            if (self.headers.get("Upgrade") or "").lower() == "websocket":
                return self._cloud_ws(route)
        if route == "/vm/health":
            return self._vm_health()
        if route.startswith("/vm/") or route == "/vm":
            return self._vm_page(route if route.startswith("/vm/") else "/vm/index.html")
        if route.startswith("/wisp/"):
            if (self.headers.get("Upgrade") or "").lower() == "websocket":
                return self._vm_wisp_ws(route)
        got = self._cloud_get(route)
        if got is not None:
            return got
        if route == "/music/health":
            return self._music_health()
        if route == "/music/api":
            return self._music_api()
        if route == "/music/stream":
            return self._music_stream()
        if route == "/music/pic":
            return self._music_pic()
        if route == "/yt/search":
            return self._yt_search()
        if route == "/yt/trending":
            return self._yt_trending()
        if route == "/yt/thumb":
            return self._yt_thumb()
        if route.startswith("/yt/channel/"):
            return self._yt_channel(route[len("/yt/channel/"):])
        if route == "/api/livetv/sports":
            return self._sports_list()
        if route == "/api/livetv/matches":
            return self._sports_matches("")
        if route.startswith("/api/livetv/img/"):
            return self._sports_image(route[len("/api/livetv/img/"):])
        if route == "/api/live-tv":
            return self._livetv_list()
        if route == "/api/live-tv/admin":
            return self._livetv_raw()
        if route.startswith("/api/live-tv/"):
            return self._livetv_stream(route[len("/api/live-tv/"):])
        if route == "/api/manga/search":
            return self._manga_proxy(route)
        if route.startswith("/api/manga/"):
            return self._manga_proxy(route)
        if route.startswith("/api/chapters/"):
            return self._manga_proxy(route)
        if route.startswith("/api/chapter/"):
            return self._manga_proxy(route)
        if route.startswith("/api/tmdb/"):
            return self._tmdb_proxy(route)
        # Bitcord chat embed: API proxy + WebSocket tunnel + static assets.
        if route.startswith("/bitcord/") or route == "/bitcord":
            if (self.headers.get("Upgrade") or "").lower() == "websocket":
                if self._bitcord_ws():
                    return
            got = self._bitcord_api(route)
            if got is not None:
                return
            # Static files (index.html, assets/) - serve from the bitcord/ folder.
            return self._bitcord_static(route) or super().do_GET()
        if route.endswith(".mp3"):
            got = _serve_mp3_fallback(self, route)
            if got is not None:
                return got
            # Fallback declined (not a game-audio tree): fall through so the
            # file is served as a normal static asset (taiko song audio etc.).
        # Taiko (/taiko/) requests its JSON shims without a file extension
        # (api/config, api/songs, api/categories). Map those onto the .json
        # files on disk so the embedded rhythm game works without Flask.
        if route.startswith("/taiko/api/"):
            self.path = route + ".json" + self.path[len(route):]
        # Before letting a missing path 404, give the proxied-page fallback a
        # chance: a player that built a root-absolute URL at runtime expects it
        # on THIS origin, and without this its bundle 404s.
        if self._uv_root_fallback(route):
            return
        return super().do_GET()

    def do_HEAD(self):
        # Mirror the taiko api shim mapping so HEAD probes (curl -I, health
        # checks) see the same 200 JSON the GET path serves.
        route = self.path.split("?", 1)[0]
        if route.startswith("/taiko/api/"):
            self.path = route + ".json" + self.path[len(route):]
        # Angry Birds Chrome offline-mode stubs (HEAD probes).
        if route == "/cors/online-check" or route == "/fowl/metrics" or route.startswith("/fowl/google-login"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "2")
            self.end_headers()
            return
        return super().do_HEAD()

    def do_POST(self):
        route = self.path.split("?", 1)[0]
        # Angry Birds Chrome offline-mode stubs (see do_GET note).
        if route == "/cors/online-check" or route == "/fowl/metrics" or route.startswith("/fowl/google-login") or route == "/gwt-log":
            body = b"{}"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except Exception:
                pass
            return
        # Same-origin guard for the server's own state-changing routes.
        # Cross-site pages can submit no-preflight POSTs with this server's
        # CORS ("*") replies; requiring a same-host Origin (or the X-Requested-
        # With marker the front-end already sends) closes that. The proxy,
        # Bitcord and cloud forwarding routes are exempt: those carry third-
        # party traffic and have their own rules. The decision lives in
        # state_post_allowed() so tools/state-post-test.py can pin it.
        STATE_POSTS = ("/_sync", "/api/proxy/backend", "/api/ai/chat", "/api/ai/convos",
                       "/cloud/config", "/chat-upload-image", "/api/live-tv/admin",
                       "/api/plays")
        if route in STATE_POSTS:
            allowed = state_post_allowed(self.headers.get("Origin"),
                                         self.headers.get("Host"),
                                         self.headers.get("X-Requested-With"))
            if not allowed:
                self.send_response(403)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                try:
                    self.wfile.write(b'{"ok":false,"error":"cross-origin write refused"}')
                except Exception:
                    pass
                return
        if route == "/_sync":
            return self._sync_post()
        if route.startswith(YUT_API_PATH):
            # Writes are gated by the upload code inside the payload, so the
            # same-origin guard is not needed here (and would break the one
            # about:blank reader case). Body size is capped in the reader.
            return _yut_api(self, route)
        if route == "/api/plays":
            return self._plays_post()
        if route == "/api/cloud-art/stats":
            return self._cloud_art_stats()
        if route == "/api/proxy/backend":
            return self._proxy_backend_post()
        if route == "/api/ai/chat":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length > 0 else b"{}"
            return self._ai_chat(body)
        if route == "/api/ai/convos":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length > 0 else b"{}"
            return self._ai_convos_post(body)
        if route.startswith(_UV_PFX):
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length > 0 else None
            ctype = (self.headers.get("Content-Type") or "").lower()
            if body is not None and "application/x-www-form-urlencoded" in ctype:
                body = body.decode("utf-8", "replace")
            _uv_note_referer(self.headers.get("Referer"))
            return self._uv_route(route[len(_UV_PFX):], body)
        # Bitcord chat embed: POST API proxy. The _bitcord_api method reads
        # the request body itself, so do_POST just delegates.
        if route.startswith("/bitcord/api/") or route.startswith("/bitcord/api?"):
            return self._bitcord_api(route)
        if route.startswith("/bitcord/") or route == "/bitcord":
            return self._bitcord_static(route)
        if route == "/cloud/config":
            return self._cloud_config_post()
        if route == "/chat-upload-image":
            return self.handle_chat_upload_image()
        got = self._cloud_post(route)
        if got is not None:
            return got
        if route == "/api/live-tv/admin":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length > 0 else b"{}"
            return self._livetv_save(body)
        # Unknown POST: answer with a real JSON 404 (NOT a bare 405, which
        # Firefox renders as a scary "Method Not Allowed" error page). The
        # old bare 405 here is exactly what broke the Chat tab whenever any
        # embedded app POSTed a route this relay did not know about.
        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        try:
            self.wfile.write(b'{"error":"Unknown endpoint"}')
        except Exception:
            pass

    def do_PATCH(self):
        route = self.path.split("?", 1)[0]
        if route.startswith("/bitcord/api/") or route.startswith("/bitcord/api?"):
            return self._bitcord_api(route)
        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        try:
            self.wfile.write(b'{"error":"Unknown endpoint"}')
        except Exception:
            pass

    def do_DELETE(self):
        route = self.path.split("?", 1)[0]
        if route.startswith("/bitcord/api/") or route.startswith("/bitcord/api?"):
            return self._bitcord_api(route)
        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        try:
            self.wfile.write(b'{"error":"Unknown endpoint"}')
        except Exception:
            pass

    def do_PUT(self):
        route = self.path.split("?", 1)[0]
        if route.startswith("/bitcord/api/") or route.startswith("/bitcord/api?"):
            return self._bitcord_api(route)
        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        try:
            self.wfile.write(b'{"error":"Unknown endpoint"}')
        except Exception:
            pass

    def do_OPTIONS(self):
        # CORS preflight (needed by embeds on mirror hosts).
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, X-Chalkle-Version")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    # ---------------------------------------------------------------- cherri list
    # The Cherri List doc is a 2.5M-line file of jsDelivr SVG cloak URLs
    # (~265MB). The browser must never load that whole file, so this endpoint
    # serves tiny JSON pages: line-range browsing when no query is given, and a
    # case-insensitive substring search when one is. The file is mmap'd lazily
    # with a line-offset index so paging is O(1); search scans once per query.
    def _sync_get(self):
        db_path = os.path.join(WEB_ROOT, "sync.json")
        data = b"{}"
        if os.path.isfile(db_path):
            data = _sanitize_sync_blob(open(db_path, "rb").read())
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _sync_post(self):
        length = int(self.headers.get("Content-Length", 0))
        data = _sanitize_sync_blob(self.rfile.read(length) if length > 0 else b"{}")
        db_path = os.path.join(WEB_ROOT, "sync.json")
        try:
            # Merge-protection: a client that is NOT carrying the shared game
            # library (fresh profile, cleared storage, first visit) must not
            # erase the canonical library for everyone else. Only replace the
            # stored library when the payload actually includes one.
            try:
                incoming = json.loads(data.decode("utf-8"))
                has_lib = isinstance(incoming, dict) and isinstance(incoming.get("chalkle-gamelib-v4"), str)
            except Exception:
                has_lib = False
            if not has_lib and os.path.isfile(db_path):
                try:
                    stored = json.loads(open(db_path, "rb").read().decode("utf-8"))
                    if isinstance(stored, dict) and isinstance(stored.get("chalkle-gamelib-v4"), str):
                        if isinstance(incoming, dict):
                            incoming["chalkle-gamelib-v4"] = stored["chalkle-gamelib-v4"]
                            # Same encode hazard as the sanitizer: a lone
                            # surrogate would raise here, the surrounding
                            # `except` would swallow it, and `data` would keep
                            # the library-less payload - wiping the shared
                            # library for everyone instead of protecting it.
                            data = json.dumps(_scrub_surrogates(incoming), ensure_ascii=False).encode("utf-8", "replace")
                except Exception:
                    pass
            with open(db_path, "wb") as f:
                f.write(data)
            out = b'{"ok":true}'
        except Exception:
            out = b'{"ok":false}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def _manga_proxy(self, route):
        """MangaDex CORS proxy for the JS Movies tab. The browser can't call
        api.mangadex.org directly (no Access-Control-Allow-Origin), so these
        routes fetch server-side and hand the raw JSON back with CORS enabled."""
        import urllib.parse
        try:
            if route == "/api/manga/search":
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                title = (q.get("title") or [""])[0].strip()
                target = "https://api.mangadex.org/manga?limit=24&includes[]=cover_art"
                if title:
                    target += "&title=" + urllib.parse.quote(title)
            elif route.startswith("/api/manga/") and route.endswith("/feed"):
                mid = route[len("/api/manga/"):-len("/feed")]
                target = ("https://api.mangadex.org/manga/%s/feed?limit=500"
                          "&translatedLanguage[]=en&order[chapter]=asc&includes[]=scanlation_group"
                          % urllib.parse.quote(mid, safe=""))
            elif route.startswith("/api/chapters/"):
                mid = route[len("/api/chapters/"):]
                target = ("https://api.mangadex.org/manga/%s/feed?limit=500"
                          "&translatedLanguage[]=en&order[chapter]=asc&includes[]=scanlation_group"
                          % urllib.parse.quote(mid, safe=""))
            elif route.startswith("/api/chapter/"):
                cid = route[len("/api/chapter/"):]
                target = "https://api.mangadex.org/at-home/server/" + urllib.parse.quote(cid, safe="")
            else:
                return self._json_out({"error": "bad-route"}, 404)
        except Exception as e:
            return self._json_out({"error": type(e).__name__}, 400)
        raw, mime, code, err = _http_get(target)
        if raw is None:
            return self._json_out({"error": err or "upstream-failed"}, code or 502)
        self.send_response(code or 200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, max-age=300")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _tmdb_proxy(self, route):
        """TMDB CORS proxy for the JS Movies tab. TMDB answers browser GETs with
        Access-Control-Allow-Origin: * only for simple requests; the app's
        Bearer-token header forces a preflight TMDB never grants, so the browser
        blocks it. Fetching server-side with the token and handing JSON back
        works everywhere the relay runs."""
        import urllib.parse
        # Extract path and query string from the full request path
        full_path = self.path.split("?", 1)
        path = route[len("/api/tmdb/"):]  # route already has ? stripped
        qs = full_path[1] if len(full_path) > 1 else ""
        # Build target URL with proper query string handling
        target = "https://api.themoviedb.org/3/" + path
        params = {}
        if qs:
            # Parse existing query params
            for param in qs.split("&"):
                if "=" in param:
                    k, v = param.split("=", 1)
                    params[k] = v
        # Always add language parameter
        params["language"] = "en-US"
        # Encode and append query string
        if params:
            target += "?" + urllib.parse.urlencode(params)
        auth = (self.headers.get("Authorization") or "").strip()
        if not auth:
            auth = "Bearer " + _TMDB_BEARER
        # Once this exact header has been refused, the fallback answers without
        # the failed upstream call in front of it. Only routes the fallback can
        # actually cover skip; anything else still asks the upstream, so a
        # working key stays in play for routes Cinemeta cannot build.
        if _tmdb_token_dead(auth):
            fb = _cinemeta_serve(path, qs)
            if fb is not None:
                return _cinemeta_respond(self, fb)
        req = urllib.request.Request(
            target,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ChalkleMovies/1.0",
                "Accept": "application/json",
                "Authorization": auth,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
                raw = resp.read()
                code = resp.getcode()
        except urllib.error.HTTPError as e:
            raw = e.read()
            code = e.code
        except Exception as e:
            return self._json_out({"error": type(e).__name__}, 502)
        if code in (401, 403):
            _TMDB_DEAD_TOKENS.add(auth)
            fb = _cinemeta_serve(path, qs)
            if fb is not None:
                return _cinemeta_respond(self, fb)
        self.send_response(code or 502)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, max-age=300")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _json_out(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _fetch(self):
        """Byte proxy. Returns {ok, code, body, bodyMime, error} where body is
        the fetched file base64-encoded. Server-local paths (/...) are read from
        disk; absolute http(s) URLs are fetched server-side. Secrets and runtime
        state are denied here too, so this endpoint can never become a reader
        for them. This lets the Ruffle
        SWF wrapper hand raw bytes to Ruffle with zero cross-origin requests which
        works from an opaque (blob:null) about:blank tab."""
        import base64
        from urllib.parse import parse_qs, unquote, urlparse
        q = parse_qs(urlparse(self.path).query)
        target = unquote((q.get("url") or [""])[0].strip())
        out = {"ok": False, "code": 0, "error": "bad-url"}
        # Deny list BEFORE the local branch: /_fetch's local path must never
        # become a reader for server secrets, git metadata, runtime state or
        # the huge local-only build artifacts. (The static handler refuses the
        # same list by URL path; here the target rides in the query string, so
        # the check runs on the decoded target.)
        low = target.lower()
        if (denied_local_path(low)
                or low.startswith("/yut/store/")
                or low.endswith("/sync.json") or low.endswith("/cloud-relay.json")
                or low.endswith("/active-visitors.json")
                or low.endswith("/play-counts.json")
                or low.endswith("/livetv.json") or low.endswith("/ai_convos.json")
                or low == "server/ai_key.txt" or low == "ai_key.txt"):
            out = {"ok": False, "code": 404, "error": "not-found"}
        elif target.startswith("/"):
            rel = target.lstrip("/")
            # realpath resolves symlinks and .. segments; the commonpath check
            # refuses sibling directories that a bare startswith would let
            # through (C:\site vs C:\site-evil).
            p = os.path.normpath(os.path.join(WEB_ROOT, rel))
            try:
                inside = os.path.commonpath([os.path.realpath(p), os.path.realpath(WEB_ROOT)]) == os.path.realpath(WEB_ROOT)
            except ValueError:
                inside = False
            if not inside or not os.path.isfile(p):
                out = {"ok": False, "code": 404, "error": "not-found"}
            else:
                try:
                    with open(p, "rb") as f:
                        raw = f.read()
                    ext = os.path.splitext(p)[1].lower()
                    mime = {
                        ".swf": "application/x-shockwave-flash",
                        ".png": "image/png",".jpg": "image/jpeg",".jpeg": "image/jpeg",
                        ".gif": "image/gif",".webp": "image/webp",".svg": "image/svg+xml",
                        ".json": "application/json",".js": "text/javascript",".css": "text/css",
                        ".html": "text/html",".txt": "text/plain",
                    }.get(ext, "application/octet-stream")
                    out = {"ok": True, "code": 200, "body": base64.b64encode(raw).decode("ascii"), "mime": mime}
                except Exception as e:
                    out = {"ok": False, "code": 0, "error": type(e).__name__}
        elif low.startswith(("http://", "https://")):
            # Remote targets must not smuggle a denied path either: a URL that
            # points anywhere on THIS server (mirrors do) is rejected the same
            # as a local path would be.
            if denied_local_path(low):
                out = {"ok": False, "code": 404, "error": "not-found"}
            else:
                raw, mime, code, err = _http_get(target)
                if raw is not None:
                    out = {"ok": True, "code": code, "body": base64.b64encode(raw).decode("ascii"), "mime": mime}
                else:
                    out = {"ok": False, "code": code, "error": err}
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ----------------------------------------------------- /_dh* Domain Hub
    # Real, honest infrastructure checks for the Domain Hub tool. These run
    # server-side so resolve/TLS/HTTP results are genuine. They only inspect
    # endpoints the user owns or is authorized to test -- no port scanning, no
    # arbitrary third-party targets beyond a one-shot hostname reachability
    # probe, and private/loopback/link-local land is refused to avoid SSRF.

    def _dh_json(self, obj, code=200):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _dh_query(self):
        from urllib.parse import parse_qs, unquote, urlparse
        q = parse_qs(urlparse(self.path).query)
        def one(k, default=""):
            return unquote((q.get(k) or [default])[0]).strip()
        return q, one

    def _dh_info(self):
        self._dh_json({"ok": True, "server": True, "capabilities": ["dns", "tls", "http", "latency", "verify"], "maxBatch": 200})

    # DNS + reachability for one host:port. Returns real resolution records, a
    # TLS assertion (cert notBefore/notAfter, issuer) when it succeeds, a real
    # HTTP status + latency on top of TLS, and clear failure reasons otherwise.
    def _dh_check(self):
        import socket, time
        from urllib.parse import urlparse as _up
        _, one = self._dh_query()
        target = one("url")
        mode = one("mode")  # probe (best-effort GET) or none
        if not target:
            return self._dh_json({"ok": False, "error": "no-target"}, 400)
        if not re.match(r"^[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$", target) and not re.match(r"^[A-Za-z0-9.-]+:[0-9]{1,5}$", target):
            if not re.match(r"^[A-Za-z0-9.-]+$", target):
                return self._dh_json({"ok": False, "error": "bad-host"}, 400)
        host = target
        port = 443 if ":" not in target else int(target.rsplit(":", 1)[1])
        if ":" in target and target.rsplit(":", 1)[0]:
            host = target.rsplit(":", 1)[0]
        out = {"ok": False, "host": host, "port": port, "dns": None, "tls": None, "http": None, "error": None}
        try:
            t0 = time.time()
            records = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
            out["dns"] = {"resolved": True, "addrs": [r[4][0] for r in records][:6]}
        except Exception as e:
            out["dns"] = {"resolved": False, "error": "DNS failed: " + type(e).__name__}
            out["error"] = "dns-error"
            return self._dh_json(out)
        # Refuse private / loopback / link-local to avoid SSRF.
        for addr in out["dns"]["addrs"]:
            if _is_private_ip(addr):
                out["dns"]["private"] = True
        if out["dns"].get("private"):
            out["error"] = "private-ip"
            return self._dh_json(out)
        # TLS / HTTPS handshake.
        try:
            import ssl
            ctx = ssl.create_default_context()
            with socket.create_connection((host, port), timeout=FETCH_TIMEOUT) as sock:
                with ctx.wrap_socket(sock, server_hostname=host) as ts:
                    peer = ts.getpeercert()
                    out["tls"] = {
                        "valid": True,
                        "issuer": dict(x[0] for x in peer.get("issuer", [])) if isinstance(peer.get("issuer"), list) else str(peer.get("issuer", "")),
                        "notAfter": peer.get("notAfter"),
                        "notBefore": peer.get("notBefore"),
                        "cipher": ts.cipher()[0] if ts.cipher() else None,
                        "subjectAlt": [x[1] for x in (peer.get("subjectAltName") or [])][:8],
                    }
        except Exception as e:
            out["tls"] = {"valid": False, "error": "TLS/connect failed: " + type(e).__name__}
            out["error"] = "tls-error"
            return self._dh_json(out)
        # Real HTTP probe if allowed.
        scheme = "https"
        probe_url = f"{scheme}://{host}:{port}/"
        if mode == "probe" or mode == "":
            t1 = time.time()
            code, err = _http_status(probe_url)
            out["http"] = {"status": code, "error": err}
            out["latencyMs"] = int((time.time() - t0) * 1000)
            out["ok"] = (code and 100 <= code < 500)
            if not out["ok"] and code == 0:
                out["error"] = err or "http-error"
        return self._dh_json(out)

    # Real DNS record lookup via a public DoH resolver (Cloudflare / Google).
    # Used for TXT ownership verification and A/AAAA presence checks.
    def _dh_dns(self):
        import urllib.request
        _, one = self._dh_query()
        name = one("name").lower().rstrip(".")
        rtype = one("type", "TXT")
        if not name or not re.match(r"^[a-z0-9.-]+\.[a-z]{2,63}$", name):
            return self._dh_json({"ok": False, "error": "bad-name"}, 400)
        vals = []
        last_err = None
        for endpoint in (f"https://cloudflare-dns.com/dns-query?name={name}&type={rtype}",
                         f"https://dns.google/resolve?name={name}&type={rtype}"):
            try:
                req = urllib.request.Request(endpoint, headers={"Accept": "application/dns-json"})
                with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
                    data = json.loads(resp.read())
                ans = data.get("Answer") or []
                for a in ans:
                    if rtype in ("TXT", "TEXT"):
                        v = a.get("data", "").strip('"')
                        if v:
                            vals.append(v)
                    else:
                        vals.append(a.get("data"))
                if data.get("Status") == 0:
                    return self._dh_json({"ok": True, "type": rtype, "name": name, "records": vals})
            except Exception as e:
                last_err = type(e).__name__
        self._dh_json({"ok": False, "type": rtype, "name": name, "records": vals, "error": last_err or "dns-error"})

    # Lan/latency-style info is intentionally minimal: return the resolved public
    # addrs + round-trip to the configured check host (defaults to the peer that
    # served this page) so "uptime" reflects something real rather than fake.
    def _dh_geo(self):
        import socket, time
        _, one = self._dh_query()
        host = one("host") or self.client_address[0]
        t0 = time.time()
        try:
            addr = socket.gethostbyname(host)
            return self._dh_json({"ok": True, "host": host, "ip": addr, "latencyMs": int((time.time() - t0) * 1000), "scheme": "same-origin"})
        except Exception as e:
            return self._dh_json({"ok": False, "host": host, "error": type(e).__name__})

    # ------------------------------------------------------------ /api/ai/*
    # The AI tab's tiny relay. The browser can't call the upstream chat API
    # directly (it is plain http:// on a non-standard port, which is blocked
    # by mixed-content + CORS from any https page), so these two same-origin
    # routes forward to it server-side. This is deliberately minimal: a model
    # list and a single streaming-capable chat proxy. The default endpoint is
    # overridable via the AI_UPSTREAM env var.

    # Upstreams are tried in order; when one rate-limits (429) or errors, the
    # next takes over so the tab keeps answering. The FIRST upstream is the
    # site's universal keyed provider (OpenRouter): the key is shared by every
    # visitor, which is what lets the AI tab work with zero setup.
    # The key is loaded from the AI_API_KEY env var, or from a local
    # server/ai_key.txt file that is NOT tracked in git (public repos get
    # scraped by key-draining bots within minutes, and GitHub push protection
    # refuses commits that contain a raw API key). If neither exists the AI
    # relay still boots; every model request then fails closed with a clear
    # upstream error until a key is provided.
    AI_UPSTREAM = os.environ.get("AI_UPSTREAM", "https://openrouter.ai/api/v1").strip()
    AI_API_KEY = os.environ.get("AI_API_KEY", "").strip()
    if not AI_API_KEY:
        try:
            _AI_KEY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai_key.txt")
            if os.path.exists(_AI_KEY_FILE):
                AI_API_KEY = io.open(_AI_KEY_FILE, encoding="utf-8").read().strip()
        except Exception as _key_err:
            # A silent fallback here once hid a NameError (io was never
            # imported): the relay shipped every chat WITHOUT the key, and
            # OpenRouter's 401 came back as an opaque "502 all-upstreams-down"
            # in the AI tab. Say something instead of eating the error.
            print("[ai] key file load failed:", type(_key_err).__name__, _key_err)
            AI_API_KEY = ""
    _AI_CONVOS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai_convos.json")

    # Upstream state must persist across requests (the handler instance is
    # recreated per connection): cached model lists, health markers and the
    # models-refresh timestamp all live here. Without this, every request
    # rebuilt the list from scratch - down-marking never stuck, and a picked
    # model could never be matched to the upstream that hosts it, so chats
    # silently fell back to each upstream's small default model.
    _AI_UPS_CACHE = None
    _AI_MODELS_TS = 0.0
    _AI_MODELS_TTL = 600.0  # seconds before /models is refetched upstream
    _AI_CREDITS_TS = 0.0
    _AI_CREDITS = None  # (has_credits, balance)

    @classmethod
    def _ai_credits(cls):
        """Cheap check of the universal key's balance. OpenRouter's credit
        check prices each request at its worst case, so with a zero balance
        every paid model 402s while :free models still run. Cache for 5 min."""
        import time as _t
        if cls._AI_CREDITS is not None and (_t.time() - cls._AI_CREDITS_TS) < 300.0:
            return cls._AI_CREDITS
        has, balance = False, 0.0
        try:
            req = urllib.request.Request(
                cls.AI_UPSTREAM.rstrip("/") + "/credits",
                headers=cls._ai_auth(cls.AI_API_KEY))
            with urllib.request.urlopen(req, timeout=6) as resp:
                d = json.loads(resp.read()).get("data") or {}
            balance = float(d.get("total_credits") or 0) - float(d.get("total_usage") or 0)
            has = balance > 0
        except Exception:
            # Upstream unreachable: keep last known state instead of flapping
            if cls._AI_CREDITS is not None:
                return cls._AI_CREDITS
        cls._AI_CREDITS = (has, balance)
        cls._AI_CREDITS_TS = _t.time()
        return cls._AI_CREDITS

    @classmethod
    def _ai_upstreams(cls):
        if cls._AI_UPS_CACHE is None:
            # OpenRouter only: every model in the AI tab is a real OpenRouter
            # id, and every chat rides the site's universal OpenRouter key.
            ups = []
            if cls.AI_UPSTREAM:
                ups.append({"base": cls.AI_UPSTREAM.rstrip("/"), "key": cls.AI_API_KEY, "default": ""})
            for u in ups:
                u["down_until"] = 0
                u["models"] = None
            cls._AI_UPS_CACHE = ups
        return cls._AI_UPS_CACHE

    @staticmethod
    def _ai_auth(key):
        return {"Authorization": "Bearer " + key} if key else {}

    @staticmethod
    def _is_vision(mid):
        s = str(mid or "").lower()
        return any(t in s for t in ("vl", "vision", "4o", "gpt-4", "claude", "gemini", "glm-4v", "llava"))

    def _ai_headers(self, key, extra=None):
        h = {"Accept": "application/json"}
        if key:
            h["Authorization"] = "Bearer " + key
        if extra:
            h.update(extra)
        return h

    def _ai_refresh_models(self, force=False):
        """Refresh cached model lists in parallel. Cheap after the first hit:
        results live on the persistent upstream dicts with a TTL."""
        import urllib.request, time
        from concurrent.futures import ThreadPoolExecutor
        ups = self._ai_upstreams()
        if not force and self._AI_MODELS_TS and (time.time() - self._AI_MODELS_TS) < self._AI_MODELS_TTL:
            return
        def fetch(up):
            if up["down_until"] and up["down_until"] > time.time():
                return
            try:
                req = urllib.request.Request(up["base"] + "/models", headers=self._ai_headers(up["key"]))
                with urllib.request.urlopen(req, timeout=6) as resp:
                    data = json.loads(resp.read())
                ids = [m.get("id") for m in (data.get("data") or []) if m.get("id")]
                if ids:
                    up["models"] = ids
            except Exception:
                pass
        with ThreadPoolExecutor(max_workers=len(ups) or 1) as ex:
            list(ex.map(fetch, ups))
        type(self)._AI_MODELS_TS = time.time()  # class-level: survives per-request handler instances

    def _ai_models(self):
        import time
        self._ai_refresh_models()
        out = {"ok": False, "models": []}
        seen = {}
        # One id per model: strip variant suffixes so the picker never shows
        # "x:batch" twins or "~" alias entries next to the real model.
        ALIAS_RE = re.compile(r"^(?:~|.*?(?::batch)$)", re.I)
        for up in self._ai_upstreams():
            for mid in (up.get("models") or []):
                if not mid or ALIAS_RE.match(mid) or mid in seen:
                    continue
                seen[mid] = up["base"]
        if seen:
            has_credits, balance = self._ai_credits()
            if not has_credits:
                # Zero balance: every paid model would 402 (OpenRouter prices
                # the request at its worst case). Only report what runs.
                free = [m for m in seen if m.lower().endswith(":free")]
                out = {"ok": len(free) > 0, "models": free, "sources": {m: seen[m] for m in free},
                       "default": (free[0] if free else ""), "credits": 0.0,
                       "credits_low": True}
            else:
                out = {"ok": True, "models": list(seen.keys()), "sources": seen,
                       "default": next(iter(seen)), "credits": round(balance, 4)}
        else:
            out = {"ok": False, "error": "no-upstreams"}
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _ai_convos_load(self, vid):
        import json as _json
        try:
            if os.path.exists(self._AI_CONVOS_FILE):
                with open(self._AI_CONVOS_FILE, "r", encoding="utf-8") as f:
                    store = _json.load(f)
                return store.get(vid) or {}
        except Exception:
            pass
        return {}

    def _ai_convos_get(self, vid):
        data = self._ai_convos_load(vid)
        raw = json.dumps({"ok": True, "convos": data}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _ai_convos_post(self, body):
        import json as _json
        try:
            payload = _json.loads(body or b"{}")
        except Exception:
            payload = {}
        vid = str(payload.get("v") or "anon")
        convos = payload.get("convos") or {}
        merged = self._ai_convos_load(vid)
        for cid, c in convos.items():
            if isinstance(c, dict):
                merged[cid] = c
        ordered = sorted(merged.values(), key=lambda c: c.get("ts") or 0, reverse=True)[:40]
        merged = {c["id"]: c for c in ordered if c.get("id")}
        try:
            store = {}
            if os.path.exists(self._AI_CONVOS_FILE):
                try:
                    with open(self._AI_CONVOS_FILE, "r", encoding="utf-8") as f:
                        store = _json.load(f)
                except Exception:
                    store = {}
            store[vid] = merged
            with open(self._AI_CONVOS_FILE, "w", encoding="utf-8") as f:
                _json.dump(store, f)
        except Exception:
            pass
        raw = _json.dumps({"ok": True, "count": len(merged)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _ai_chat(self, body):
        """Forward {messages, model, stream?, vision?} to the first healthy
        upstream and pipe the reply back, failing over to the next upstream on
        429 / 5xx / network errors so a rate-limited provider never blocks the
        chat. Image attachments (content parts with image_url) automatically
        route to a vision-capable model. Streaming passes the upstream's SSE
        through verbatim; the plain path returns JSON as-is."""
        import urllib.request, urllib.error, time
        try:
            payload = json.loads(body or b"{}")
        except Exception:
            payload = {}
        msgs = payload.get("messages")
        if not isinstance(msgs, list) or not msgs:
            data = json.dumps({"ok": False, "error": "no-messages"}).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        model = str(payload.get("model") or "")
        stream = bool(payload.get("stream"))
        wants_vision = bool(payload.get("vision"))

        # No key configured: every candidate would 401 upstream and the tab
        # would show an opaque "all-upstreams-down" 502. Fail fast with the
        # actual reason instead.
        if not self.AI_API_KEY:
            data = json.dumps({"ok": False, "error": "no-key",
                               "detail": "The AI relay has no API key configured (AI_API_KEY or server/ai_key.txt)."}).encode()
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        # Do not spend an upstream request (or inherit an upstream model's
        # previous-topic bias) for a bare greeting. Some of the public fallback
        # models answer "hi" as though it were a project-planning follow-up,
        # which makes a fresh chat feel broken. Keep this intentionally narrow:
        # real questions and messages with any extra context still go to the
        # selected model.
        last_user = next((m for m in reversed(msgs) if m.get("role") == "user"), {})
        greeting = last_user.get("content", "")
        if isinstance(greeting, list):
            greeting = " ".join(
                str(part.get("text") or "") for part in greeting
                if isinstance(part, dict) and part.get("type") == "text"
            )
        # Every message, greetings included, goes to the real model: the
        # canned local replies made the tab feel broken with good models.
        greeting = str(greeting).strip()

        # PhotoMath's useful pattern is a small, explicit pipeline: recognize
        # the problem first, then solve it, then verify the result. We cannot
        # assume every upstream model handles that consistently, so tell it
        # when the latest request is math or contains an uploaded image.
        last_user_text = greeting
        math_request = bool(re.search(
            r"\b(?:solve|simplify|evaluate|calculate|factor|expand|derive|integrat|equation|inequalit|algebra|geometry|math|fraction|percent|area|volume|probability|\d+\s*[+\-*/^=]\s*\d+)\b",
            last_user_text,
            re.I,
        ))

        if not wants_vision:
            for m in msgs:
                c = m.get("content")
                if isinstance(c, list):
                    for part in c:
                        if isinstance(part, dict) and part.get("type") == "image_url":
                            wants_vision = True
                            break
        if not msgs or (msgs[0].get("role") != "system"):
            if wants_vision or math_request:
                role = (
                    "You are Chalkle's careful math solver. Focus only on the latest user request. "
                    "If an image is attached, transcribe the expression before solving it and say "
                    "when a symbol is unclear; never invent missing handwriting. For math, show the "
                    "key steps in order, give the final answer clearly, and verify it when practical. "
                    "If the image is not a math problem, describe what you can actually see and ask "
                    "what the user wants done with it."
                )
            else:
                role = (
                    "You are Chalkle AI. Answer the latest user request directly and naturally. "
                    "Do not continue a different task from earlier context unless the user asks you to. "
                    "Never invent project context, constraints, or requirements the user did not mention. "
                    "Ask a clarifying question only when it is genuinely needed."
                )
            role += " Write plain text: no markdown symbols like **, ###, or backtick fences."
            msgs = [{"role": "system", "content": role}] + msgs
        ups = self._ai_upstreams()
        # Make sure we know who hosts what (cached + parallel, near-free)
        try:
            self._ai_refresh_models()
        except Exception:
            pass
        # Build an ordered candidate list of (upstream, model) pairs:
        #   1. the upstream(s) that own the requested model, with that model
        #   2. a vision model on any upstream that has one (image requests)
        #   3. each upstream's first model as a last resort, so a model that is
        #      unavailable/rate-limited somewhere still gets answered elsewhere
        cands = []
        seen = set()
        hosted = False
        for u in ups:
            um = u.get("models") or []
            if um and model and model in um:
                hosted = True
                key = (u["base"], model)
                if key not in seen:
                    seen.add(key)
                    cands.append((u, model))
        # Requested model unknown to every cached list: still try it verbatim
        # on the first healthy upstream (covers models added upstream after
        # the last models refresh) before falling back to defaults.
        if model and not hosted:
            for u in ups:
                if u["down_until"] and u["down_until"] > time.time():
                    continue
                key = (u["base"], model)
                if key not in seen:
                    seen.add(key)
                    cands.append((u, model))
                break
        if wants_vision:
            for u in ups:
                um = u.get("models") or []
                vid = [m for m in um if self._is_vision(m)]
                if vid:
                    key = (u["base"], vid[0])
                    if key not in seen:
                        seen.add(key)
                        cands.append((u, vid[0]))
        # every upstream gets a shot with its default (or requested) model so a
        # model that's unavailable/rate-limited somewhere still gets answered
        for u in ups:
            um = u.get("models") or []
            pick = u.get("default") or (um[0] if um else "")
            if not pick:
                continue
            key = (u["base"], pick)
            if key not in seen:
                seen.add(key)
                cands.append((u, pick))
        errors = []
        fallback_model = None
        for up, use_model in cands:
            if up["down_until"] and up["down_until"] > time.time():
                continue
            # Cap max_tokens: OpenRouter's credit check prices the request at
            # its WORST case, so an uncapped max (model default, often 64k)
            # fails with 402 even when a normal reply would cost almost
            # nothing. 2048 covers chat replies comfortably.
            body_b = json.dumps({"model": use_model, "messages": msgs, "stream": stream, "temperature": 0.6, "max_tokens": 2048}).encode()
            req = urllib.request.Request(up["base"] + "/chat/completions", data=body_b,
                                         headers=self._ai_headers(up["key"], {"Content-Type": "application/json", "Accept": "text/event-stream" if stream else "application/json"}))
            try:
                resp = urllib.request.urlopen(req, timeout=90)
            except urllib.error.HTTPError as e:
                code = e.code
                raw = e.read()
                errors.append("HTTP " + str(code) + " " + raw.decode("utf-8", "replace")[:120].strip())
                # OpenRouter is the ONLY upstream now, so never take it down
                # wholesale: 402/429/404 are model- or credit-specific (one
                # expensive model must not break every other chat), and 5xx
                # only earns a short cooldown instead of minutes.
                if code in (500, 502, 503, 504):
                    up["down_until"] = time.time() + 20
                # Out of credits for this model: transparently retry the same
                # chat on the free variant of the closest model, so the user
                # still gets an answer instead of an error bubble.
                if code == 402 and not fallback_model:
                    um = up.get("models") or []
                    free = [m for m in um if m.lower().endswith(":free")]
                    if free:
                        fallback_model = free[0]
                        cands.append((up, fallback_model))
                continue  # try the next candidate on the same upstream
            except Exception as e:
                errors.append(type(e).__name__ + " from " + up["base"])
                up["down_until"] = time.time() + 30
                continue
            # success: pipe the upstream response through
            ctype = resp.headers.get("Content-Type", "application/json")
            self.send_response(resp.getcode() or 200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            if fallback_model and use_model == fallback_model and model != fallback_model:
                self.send_header("X-Chalkle-Fallback", fallback_model.split("/")[-1])
            if stream:
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                while True:
                    chunk = resp.read(4096)
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except Exception:
                        break
            else:
                raw = resp.read()
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            return
        data = json.dumps({"ok": False, "error": "all-upstreams-down", "detail": "; ".join(errors) or "no upstreams"}).encode()
        self.send_response(502)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ------------------------------------------------------------ rewriting proxy
    # The built-in rewriting proxy. <proxy>/res/<hex(target)> fetches the
    # target server-side, rewrites every URL in the HTML/CSS back through
    # /res/ (so the tab only
    # ever talks to this origin), strips CSP / X-Frame-Options, and injects a
    # small client patch that reroutes fetch/XHR/WebSocket/history calls that
    # only exist at runtime. No service worker, no separate host to block, and
    # the route can never go stale the way a temporary tunnel does.

    def _uv_send(self, code, ctype, raw, extra=None, cache="no-store, max-age=0"):
        self.send_response(code)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Cache-Control", cache)
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            # An EMPTY header value is worse than none: Firefox/Zen reads an
            # empty X-Frame-Options as DENY and refuses to embed the page
            # ("Zen Can't Open This Page"). Empty means "not present" here -
            # skip it instead of sending a blank header.
            if v == "" or v is None:
                continue
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except Exception:
            pass

    def _uv_error(self, code, msg):
        body = ("<!doctype html><html><head><meta charset='utf-8'><title>Proxy error</title>"
                "<style>body{background:#0c1210;color:#e8eaed;font:15px system-ui;display:grid;"
                "place-items:center;height:100vh;margin:0}p{max-width:520px;text-align:center}"
                "</style></head>"
                "<body><p><b>Proxy couldn't load that page.</b><br>" + _esc_html(str(msg)) +
                "</p></body></html>").encode()
        self._uv_send(code if code else 502, "text/html", body)

    def _uv_root_fallback(self, route):
        """Serve a root-absolute URL that a proxied page built at runtime.

        Some players (Next.js apps especially) derive asset URLs from
        location.pathname instead of using a relative path, so a request for
        /_next/static/chunks/x.js arrives HERE, where no such file exists. The
        chunk 404s and the app dies with "Application error: a client-side
        exception has occurred" - which is exactly how one provider failed.

        The Referer on such a request is the proxied page that asked for it,
        and its /res/<hex> route carries the upstream target, so the miss can be
        re-resolved against that page's own origin and served through the normal
        relay path. A request without such a Referer is left alone: this site's
        own 404s still 404, and the site's real files were already served.
        """
        ref = self.headers.get("Referer") or ""
        if "/res/" not in ref or route.startswith("/res/"):
            return False
        seg = ref.split("/res/", 1)[1].split("/", 1)[0]
        seg = seg.split("?", 1)[0].split("#", 1)[0]
        base = _uv_dec(seg)
        if not base:
            return False
        import urllib.parse
        parts = urllib.parse.urlsplit(base)
        if not parts.scheme or not parts.netloc:
            return False
        target = "%s://%s%s" % (parts.scheme, parts.netloc, route)
        if _uv_ad_host(target):
            self._uv_ad_stub(target)
            return True
        self._uv_route(_uv_enc(target))
        return True

    def _uv_ad_stub(self, target):
        """Answer a blocked ad/tracker request with something inert.

        A 403 - what an ordinary filter returns - is the wrong answer here. The
        page's loader sees a failure, logs it, and falls through to a SECOND ad
        network, which is how one blocked ad turns into two requests. A
        successful-looking empty response shaped like whatever was asked for
        (empty JS, a transparent pixel, a blank document) ends the chain
        instead, and an iframe that does load stays invisible.
        """
        path = (target or "").split("?", 1)[0].split("#", 1)[0]
        # Any .js/.mjs segment anywhere in the path marks a script: beacons are
        # served as ".../beacon.min.js/v31edd6df...", whose LEAF has no
        # extension, and answering that with an HTML document makes the browser
        # refuse it ("Loading failed for the module" - a MIME mismatch is a
        # hard failure, not a soft one).
        segs = [s.lower() for s in path.split("/")]
        looks_js = any(s.endswith((".js", ".mjs", ".cjs")) for s in segs)
        looks_css = any(s.endswith(".css") for s in segs)
        looks_img = any(s.endswith((".gif", ".png", ".jpg", ".jpeg", ".webp",
                                    ".avif", ".ico", ".svg")) for s in segs)
        # The request's own type is the honest signal, and every current
        # browser sends Sec-Fetch-Dest. An EMPTY dest is a fetch/XHR or an old
        # browser, and those fall back to the path shape below.
        dest = (self.headers.get("Sec-Fetch-Dest") or "").strip().lower()
        if dest in ("script", "worker", "sharedworker"):
            return self._uv_send(200, "text/javascript", _UV_BLANK_JS)
        if dest == "style":
            return self._uv_send(200, "text/css", b"/* blocked */")
        if dest == "image":
            return self._uv_send(200, "image/gif", _UV_BLANK_GIF)
        # fetch/XHR: an empty text body parses as "nothing" in any sensible
        # caller, where an HTML document throws a JSON parse error the ad
        # script may answer by asking a different network for the same ad.
        if dest == "empty":
            if looks_js:
                return self._uv_send(200, "text/javascript", _UV_BLANK_JS)
            return self._uv_send(200, "text/plain", b"")
        if looks_js:
            return self._uv_send(200, "text/javascript", _UV_BLANK_JS)
        if looks_css:
            return self._uv_send(200, "text/css", b"/* blocked */")
        if looks_img:
            return self._uv_send(200, "image/gif", _UV_BLANK_GIF)
        # A navigation (popunder, ad frame) or anything unrecognised: a blank
        # document is inert and invisible for both.
        return self._uv_send(200, "text/html", _UV_BLANK_DOC)

    def _proxy_backends_get(self):
        """Live view of every backend the Proxies tab's selector can pick."""
        self._json_out(_proxy_backends_payload())

    def _proxy_backend_post(self):
        """Set the active upstream. Body: {"id": "<backend-id>"}."""
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        wanted = ""
        try:
            wanted = str((json.loads(raw.decode("utf-8", "replace")) or {}).get("id") or "")
        except Exception:
            wanted = ""
        _chain_set(wanted)
        self._json_out(_proxy_backends_payload())

    def _uv_boot(self):
        """Small themed page for the proxy root (what the proxy card's
        in-app Open button shows). Lets you type a URL, and handles the
        hash-route form by bouncing to the path route."""
        html = (
            "<!doctype html><html><head><meta charset='utf-8'><title>Chalkle Proxy</title>"
            "<style>body{background:#0c1210;color:#e8eaed;font:15px/1.5 system-ui;display:grid;"
            "place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}"
            ".box{width:min(420px,100%);background:#16251d;border:1px solid #234033;"
            "border-radius:16px;padding:28px;text-align:center}"
            "h1{margin:0 0 6px;font-size:20px;color:#8fd6c2}"
            "p{margin:0 0 18px;color:#9aa0a6;font-size:13px}"
            "input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;"
            "border:1px solid #2c4437;background:#0c1210;color:#e8eaed;font:14px system-ui;"
            "outline:none}input:focus{border-color:#4285f4}"
            "button{margin-top:12px;width:100%;padding:11px;border:0;border-radius:10px;"
            "background:#4285f4;color:#fff;font:650 14px system-ui;cursor:pointer}"
            "</style></head><body><div class='box'>"
            "<h1>Chalkle Proxy</h1><p>Type a site to open it through the built-in proxy.</p>"
            "<input id='u' placeholder='https://example.com' autocomplete='off' autofocus>"
            "<button id='go'>Open through proxy</button></div>"
            "<script>"
            "function enc(s){try{s=encodeURIComponent(s);var o='';"
            "for(var i=0;i<s.length;i++){var c=s.charCodeAt(i)^(0x2f+i%0x31);"
            "o+=(c<16?'0':'')+c.toString(16);}return o;}"
            "catch(e){return encodeURIComponent(s)}}"
            "function go(){var v=(document.getElementById('u').value||'').trim();"
            "if(!v)return;if(v.indexOf('://')===-1)v='https://'+v;"
            "location.href='/res/'+enc(v)}"
            "document.getElementById('go').onclick=go;"
            "document.getElementById('u').addEventListener('keydown',function(e){if(e.key==='Enter')go()});"
            "var h=location.hash;if(h&&h.length>1)location.replace('/res/'+h.slice(1));"
            "</script></body></html>"
        )
        self._uv_send(200, "text/html", html.encode())

    def _uv_route(self, encoded, post_body=None):
        """Serve /res/<hex(target)>[<extra path>]. The encoded value can
        carry a trailing path (when the browser resolved a relative URL against
        the injected proxied <base>); append it to the decoded target. Local
        paths (starting with /) are served from this server's own webroot so
        /game-builds/... shells work even when their CDN assets are blocked -
        the rewriter turns every CDN reference back into a /res/ route."""
        seg, _, rest = encoded.partition("/")
        target = _uv_dec(seg)
        if not target:
            return self._uv_error(400, "bad route")
        if rest:
            target = target.rstrip("/") + "/" + rest
        if target.startswith("//"):
            target = "https:" + target
        if target.startswith("/"):
            return self._uv_local(target, post_body)
        if not re.match(r"^https?://", target, re.I):
            return self._uv_error(400, "bad target")
        # Ad / tracker hosts never reach the network. This is the chokepoint for
        # the whole filter: a proxied player can inject whatever it likes at
        # runtime, but the fetch itself has to come through here.
        if _uv_ad_host(target):
            return self._uv_ad_stub(target)
        # Rewritten-page cache: re-fetching AND re-rewriting the same HTML/CSS/
        # JS on every SPA navigation is the slowest thing this proxy does. GETs
        # replay the last rewritten response from memory (short TTLs below). No
        # cookies or auth headers are ever forwarded upstream, so responses are
        # the anonymous version and safe to reuse. POSTs bypass the cache.
        cache_key = None
        if post_body is None:
            _chain = _chain_effective()
            cache_key = target + "|" + ((_chain[0] + ":" + str(_chain[1])) if _chain else "direct")
            hit = _uv_cache_get(cache_key)
            if hit is not None:
                self._uv_send(hit[0], hit[1], hit[2], hit[3], cache=hit[4])
                return
        # Binary assets (Unity .data/.wasm, images, fonts) are streamed without
        # buffering (they can be hundreds of MB). One upstream fetch per asset:
        # a tiny peek decides whether to rewrite (HTML/CSS/JS/SVG) or stream,
        # and everything after the peek continues on the SAME response, so no
        # second round-trip / duplicate TLS handshake per file.
        import urllib.error
        try:
            probe = _uv_open(target, post_body)
        except urllib.error.HTTPError as e:
            return self._uv_error(e.code or 502, "HTTP %s" % e.code)
        except Exception as e:
            return self._uv_error(502, type(e).__name__)
        ctype = (probe.headers.get("Content-Type", "").split(";")[0].strip().lower())
        # Some CDNs label web assets with junk MIME (text/plain, octet-stream,
        # empty). Correct the obvious ones by extension so script/style/module
        # loading keeps working regardless of how sloppy the upstream is.
        _last = target.split("?", 1)[0].split("#", 1)[0].rsplit("/", 1)[-1].lower()
        _ext = _last.rsplit(".", 1)[-1] if "." in _last else ""
        if ctype in ("", "text/plain", "application/octet-stream"):
            if _ext in ("js", "mjs", "cjs"):
                ctype = "text/javascript"
            elif _ext == "css":
                ctype = "text/css"
            elif _ext == "json":
                ctype = "application/json"
            elif _ext == "wasm":
                ctype = "application/wasm"
            elif _ext in ("html", "htm"):
                ctype = "text/html"
            elif _ext == "svg":
                ctype = "image/svg+xml"
        is_html = "text/html" in ctype
        is_css = ctype == "text/css"
        # SVG wrapper pages (the gnmath / arctic / cloudmoon mirror links) are
        # image/svg+xml documents with an inline <script> that atob()s a whole
        # HTML shell out of a base64 literal and embeds the real game client
        # from a raw CDN URL. Rewrite them like HTML so the atob rewriter can
        # reroute that inner document through the proxy too.
        is_svg = ctype == "image/svg+xml" or target.lower().endswith(".svg")
        prefix = b""
        if not (is_html or is_css or is_svg):
            # Peek before committing: some servers serve HTML with a wrong
            # MIME type. Keep reading from this same response afterwards.
            prefix = probe.read(512)
            looks_html = prefix.lstrip().lower().startswith((b"<!doctype", b"<html", b"<head"))
            # JSONP endpoints answer with the callback wrapper but often label
            # it text/plain or application/json; a <script> needs a JS MIME.
            if (ctype in ("application/json", "text/plain")
                    and "callback=" in target.lower()
                    and re.match(rb"[\w$.]+\s*\(", prefix.lstrip()[:64])):
                ctype = "text/javascript"
            is_js = ("javascript" in ctype or ctype == "module"
                     or ctype.endswith("ecmascript")
                     or _ext in ("js", "mjs", "cjs"))
            if looks_html:
                is_html = True
            elif is_js:
                # JS module: rewrite relative import specifiers to absolute
                # /res/ routes, then send. Verbatim streaming would break every
                # `import "./chunk.js"` (they'd resolve against /res/<name>.js
                # and lose the encoded target).
                raw = prefix + probe.read(40 * 1024 * 1024 + 1)
                probe.close()
                if len(raw) > 40 * 1024 * 1024:
                    return self._uv_error(502, "file too large")
                text = _uv_rewrite_js(_uv_decode(raw), target)
                extra = {
                    "Content-Security-Policy": "",
                    "X-Frame-Options": "",
                    "Content-Security-Policy-Report-Only": "",
                }
                out = text.encode("utf-8", "replace")
                _uv_cache_put(cache_key, 200, "text/javascript", out, extra, "public, max-age=300")
                self._uv_send(200, "text/javascript", out, extra,
                              cache="public, max-age=300")
                return
            else:
                return self._uv_stream_resp(probe, prefix=prefix,
                                            cacheable=_uv_cacheable(ctype, target))
        if is_html or is_css or is_svg:
            raw = probe.read(40 * 1024 * 1024 + 1)
            if len(raw) > 40 * 1024 * 1024 and is_html and not prefix:
                # Oversized single-document HTML. The single-file WASM game
                # clients (the Eaglercraft builds and friends) are 50-90 MB, and
                # rewriting one means holding the original bytes, the decoded
                # string and the re-encoded copy at once - per viewer. Answering
                # 502 instead (what this used to do) turns a game that plays
                # fine in a plain tab into "Proxy couldn't load that page" in
                # the player, which is exactly the blocked-embed report. Stream
                # it with one surgical edit instead: a <base href> for this
                # page's own directory through the relay, so relative scripts,
                # wasm and data files still come back through this origin.
                return self._uv_stream_big_html(probe, raw, target)
            probe.close()
            if prefix:
                raw = prefix + raw
            if len(raw) > 40 * 1024 * 1024:
                return self._uv_error(502, "page too large")
            code = 200
            if is_svg:
                # SVG wrapper: keep the MIME as image/svg+xml (it is the
                # document), but run the script body through the atob rewriter
                # so the embedded game shell's URLs land on the proxy.
                text = _uv_decode(raw)
                text = _uv_rewrite_svg(text, target)
                raw = text.encode("utf-8", "replace")
            elif is_html:
                text = _uv_decode(raw)
                text = _uv_rewrite_html(text, target)
                text = _uv_inject_patch(text, target)
                raw = text.encode("utf-8", "replace")
                ctype = "text/html"
            else:
                raw = _uv_rewrite_css(_uv_decode(raw), target).encode("utf-8", "replace")
                ctype = "text/css"
            # Strip frame/CSP killers so the page can load here (top-level or the
            # in-app frame) and so our injected script is never blocked.
            extra = {
                "Content-Security-Policy": "",
                "X-Frame-Options": "",
                "Content-Security-Policy-Report-Only": "",
            }
            cch = "public, max-age=300" if (is_css or is_svg) else "no-store, max-age=0"
            _uv_cache_put(cache_key, code, ctype, raw, extra, cch)
            self._uv_send(code, ctype, raw, extra, cache=cch)
            return

    def _uv_stream_resp(self, resp, prefix=b"", cacheable=0):
        """Stream an already-open upstream response through to the client.
        prefix carries bytes already read off the response (the MIME probe)
        so a binary asset is never fetched twice. cacheable>0 gives the
        browser a public cache lifetime for deterministic static assets."""
        try:
            ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
            self._stabilize()  # lengthless stream: no keep-alive reuse
            self.send_response(resp.getcode() or 200)
            self.send_header("Content-Type", ctype or "application/octet-stream")
            self.send_header("Cache-Control", ("public, max-age=%d" % cacheable) if cacheable else "no-store, max-age=0")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            if prefix:
                try:
                    self.wfile.write(prefix)
                except Exception:
                    pass
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except Exception:
            pass
        finally:
            try:
                resp.close()
            except Exception:
                pass

    def _uv_stream_big_html(self, resp, head, target):
        """Stream an oversized HTML document with a relay <base> injected.

        The body passes through byte-for-byte: no attribute rewriting and no
        runtime patch, because holding the whole rewritten document is what the
        40 MB cap exists to avoid. The injected <base href="/res/<enc(dir)>"> is
        what keeps the document ours - relative scripts, wasm, data and audio
        files still resolve to /res/ routes, so the browser keeps talking only
        to this origin for everything the game loads by relative path. Absolute
        URLs inside such a document do go direct, which is why this is the
        fallback for giant documents and not the normal path.
        """
        try:
            base = _UV_PFX + _uv_enc(urllib.parse.urljoin(target, "."))
        except Exception:
            base = _UV_PFX
        tag = ('<base href="%s">' % base).encode("ascii", "replace")
        # The document has to be parsed before <base> takes effect, so the tag
        # goes right after the opening <head ...> tag. A document without a head
        # in its first 256 KB is not something a browser would parse usefully
        # anyway; prepending keeps the bytes intact and still lands the base in
        # head once the parser reaches it.
        window = head[:262144]
        at = window.lower().find(b"<head")
        if at != -1:
            gt = head.find(b">", at)
            at = (gt + 1) if gt != -1 else at
        else:
            at = 0
        try:
            self._stabilize()  # lengthless stream: no keep-alive reuse
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            # Upstream CSP / X-Frame-Options are never forwarded on this path
            # either, so an anti-embed header cannot survive it.
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(head[:at] + tag + head[at:])
            while True:
                chunk = resp.read(262144)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except Exception:
            pass
        finally:
            try:
                resp.close()
            except Exception:
                pass

    def _uv_stream_remote(self, url):
        """Stream a remote binary asset (Unity .data/.wasm, images, fonts)
        straight through without buffering or size caps. The browser only ever
        talks to this origin; the CDN fetch happens server-side."""
        import urllib.error
        try:
            resp = _uv_open(url, None)
        except urllib.error.HTTPError as e:
            return self._uv_error(e.code or 502, "HTTP %s" % e.code)
        except Exception as e:
            return self._uv_error(502, type(e).__name__)
        try:
            ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
            self._stabilize()  # lengthless stream: no keep-alive reuse
            self.send_response(resp.getcode() or 200)
            self.send_header("Content-Type", ctype or "application/octet-stream")
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except Exception:
            pass
        finally:
            try:
                resp.close()
            except Exception:
                pass

    def _uv_local(self, path, post_body=None):
        """Serve a local webroot path (e.g. /game-builds/granny3/index.html)
        through the /res/ pipeline. The HTML/CSS rewriter turns any external
        CDN reference (jsdelivr, raw.githubusercontent, ...) into a /res/ route,
        so a local shell whose assets live on a blocked CDN still boots: the
        browser only ever talks to this origin, and the server fetches the CDN
        parts server-side. Binary assets are streamed with their real MIME so
        Unity .data/.wasm keep working, with no size cap."""
        import mimetypes
        safe = os.path.normpath(os.path.join(WEB_ROOT, path.lstrip("/")))
        if not safe.startswith(os.path.normpath(WEB_ROOT) + os.sep) and safe != os.path.normpath(WEB_ROOT):
            return self._uv_error(400, "bad local path")
        if os.path.isdir(safe):
            safe = os.path.join(safe, "index.html")
        if not os.path.isfile(safe):
            return self._uv_error(404, "local file not found")
        ctype = mimetypes.guess_type(safe)[0] or "application/octet-stream"
        # Detect HTML by extension first; fall back to sniffing.
        is_html = ctype == "text/html" or safe.lower().endswith((".html", ".htm", ".xhtml"))
        is_css = ctype == "text/css" or safe.lower().endswith(".css")
        if is_html or is_css:
            try:
                with open(safe, "rb") as f:
                    raw = f.read()
            except Exception as e:
                return self._uv_error(500, type(e).__name__)
            if is_html:
                text = _uv_decode(raw)
                text = _uv_rewrite_html(text, path)
                text = _uv_inject_patch(text, path)
                raw = text.encode("utf-8", "replace")
                ctype = "text/html"
            else:
                raw = _uv_rewrite_css(_uv_decode(raw), path).encode("utf-8", "replace")
                ctype = "text/css"
            extra = {
                "Content-Security-Policy": "",
                "X-Frame-Options": "",
                "Content-Security-Policy-Report-Only": "",
            }
            self._uv_send(200, ctype, raw, extra,
                          cache="public, max-age=300" if is_css else "no-store, max-age=0")
            return
        if safe.lower().endswith((".js", ".mjs")):
            # Local JS module: same import-specifier rewrite as remote JS.
            try:
                with open(safe, "rb") as f:
                    raw = f.read()
            except Exception as e:
                return self._uv_error(500, type(e).__name__)
            text = _uv_rewrite_js(_uv_decode(raw), path)
            extra = {"Content-Security-Policy": "", "X-Frame-Options": "", "Content-Security-Policy-Report-Only": ""}
            self._uv_send(200, "text/javascript", text.encode("utf-8", "replace"), extra,
                          cache="public, max-age=300")
            return
        # Binary / streaming path: stream the file with its real MIME so large
        # Unity .data / .wasm / game assets never get buffered or capped.
        try:
            size = os.path.getsize(safe)
            mtime = int(os.path.getmtime(safe))
            f = open(safe, "rb")
        except Exception as e:
            return self._uv_error(500, type(e).__name__)
        # 304 support: a revisit of a 300 MB Unity build re-validates with
        # If-Modified-Since instead of re-streaming the whole file.
        ims = self.headers.get("If-Modified-Since")
        if ims:
            try:
                import email.utils
                since = email.utils.parsedate_to_datetime(ims).timestamp()
                if mtime <= since:
                    f.close()
                    self.send_response(304)
                    self.send_header("Cache-Control", "public, max-age=86400")
                    self.send_header("Last-Modified", self.date_time_string(mtime))
                    self.end_headers()
                    return
            except Exception:
                pass
        try:
            self._stabilize()  # lengthless stream: no keep-alive reuse
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("Last-Modified", self.date_time_string(mtime))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except Exception:
            pass
        finally:
            try:
                f.close()
            except Exception:
                pass

    def _uv_ws(self, encoded):
        """Tunnel a WebSocket upgrade: connect to the real ws(s) target, relay
        the 101 handshake back untouched (the client's Sec-WebSocket-Key is
        forwarded, so the upstream's accept value is valid), then pump bytes
        both ways."""
        target = _uv_dec(encoded)
        if not target or not re.match(r"^wss?://", target, re.I):
            return self._uv_error(400, "bad ws target")
        import urllib.parse
        parts = urllib.parse.urlsplit(target)
        host = parts.hostname or ""
        port = parts.port or (443 if parts.scheme == "wss" else 80)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        try:
            sock = socket.create_connection((host, port), timeout=15)
            if parts.scheme == "wss":
                ctx = ssl.create_default_context()
                sock = ctx.wrap_socket(sock, server_hostname=host)
            key = self.headers.get("Sec-WebSocket-Key", "").strip()
            ver = self.headers.get("Sec-WebSocket-Version", "13").strip()
            proto = self.headers.get("Sec-WebSocket-Protocol", "").strip()
            lines = ["GET %s HTTP/1.1" % path, "Host: %s" % host, "Upgrade: websocket", "Connection: Upgrade"]
            if key:
                lines.append("Sec-WebSocket-Key: " + key)
            if ver:
                lines.append("Sec-WebSocket-Version: " + ver)
            if proto:
                lines.append("Sec-WebSocket-Protocol: " + proto)
            origin = self.headers.get("Origin", "")
            if origin:
                lines.append("Origin: " + origin)
            sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
            head = b""
            while b"\r\n\r\n" not in head:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                head += chunk
                if len(head) > 65536:
                    break
        except Exception as e:
            try:
                sock.close()
            except Exception:
                pass
            return self._uv_error(502, "ws connect failed: " + type(e).__name__)
        try:
            self.connection.sendall(head)
            self.close_connection = True
        except Exception:
            try:
                sock.close()
            except Exception:
                pass
            return

        def pump(src, dst):
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except Exception:
                pass
            finally:
                try:
                    dst.shutdown(socket.SHUT_WR)
                except Exception:
                    pass

        t1 = threading.Thread(target=pump, args=(self.connection, sock), daemon=True)
        t2 = threading.Thread(target=pump, args=(sock, self.connection), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        try:
            sock.close()
        except Exception:
            pass


    def _active(self):
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(self.path).query)
        sid = (q.get("s") or [""])[0].strip()
        bye = (q.get("bye") or [""])[0].strip()
        if bye:
            # A tab saying goodbye reuses ?s= for its id; the client also
            # appends &bye=1, so treat any bye ping as a removal of that id.
            _active_remove(sid or bye)
        elif sid:
            _active_touch(sid)
        live = _active_count()
        # "you" tells the client whether its own session is part of the
        # count, so a lone visitor (just you) can hide the pill instead of
        # advertising a meaningless "1".
        you = False
        if not bye and sid:
            you = _active_has(_active_clean_sid(sid))
        body = json.dumps({"active": live, "ttl": ACTIVE_TTL, "you": you}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _plays_get(self):
        """All-time launch counts plus the last week's, for the Games tab's
        Most played sort and the Home trending shelf. Public on purpose: it
        is anonymous totals, never per-visitor data."""
        self._json_out(_plays_payload())

    def _plays_post(self):
        """Count one launch. Body: {"key": "<catalog key>"}."""
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(min(length, PLAYS_BODY_MAX)) if length > 0 else b"{}"
        try:
            key = (json.loads(raw.decode("utf-8", "replace")) or {}).get("key")
        except Exception:
            key = ""
        result = _plays_report(key)
        self._json_out(result, 200 if result.get("ok") else 400)


FETCH_TIMEOUT = 9       # seconds before a target is considered unreachable

# TMDB read-only bearer token used by the JS Movies tab proxy. This is the
# project's own token (from the vendored MILKBOX app) - never user credentials.
_TMDB_BEARER = os.environ.get("TMDB_BEARER") or (
    "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NDc2MWZmMmViNWRiYTM4MDJlZDJlNGJkOTE0ZGZlOCIsIm5iZiI6MTc3NzU2MDc0My45NzMsInN1YiI6IjY5ZjM2Y2E3ZDZhZjA3Yjg2Zjg0MzA3MSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pNYedccUMayuOtMmH_vMWVVYjfAal3r2V1WWv433u4g"
)
# Authorization headers the upstream has already refused. TMDB answers a bad
# token with 401 on every call and the vendored default above is dead, so
# every read used to spend a doomed round trip to api.themoviedb.org before
# the keyless Cinemeta fallback answered. Remembering the refusal lets later
# reads go straight to the fallback. Keyed by the full header value, so a
# caller's own working token is never skipped: only the exact header the
# upstream rejected is. Set members are only added, and only from a response
# that carried a 401 or 403, so this can never guess.
_TMDB_DEAD_TOKENS = set()


def _tmdb_token_dead(token):
    """True when this exact authorization header has already been refused by
    the upstream. An empty token is never dead: a caller with no header of its
    own asks once with the vendored default before anything is remembered."""
    return bool(token) and token in _TMDB_DEAD_TOKENS
FETCH_MAX_REDIRECTS = 5
# --- Cinemeta fallback for the TMDB proxy (keyless catalog when the token is
# rejected). Persists a tmdb_id -> imdb_id map harvested from every served
# catalog row so numeric detail lookups can be answered later. ---
_CINEMETA = "https://v3-cinemeta.strem.io"
_CINEMETA_MAP_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tmdb-imdb-map.json")
_CINEMETA_TTL = 600  # seconds per route cache entry
_cinemeta_route_cache = {}
_cinemeta_id_map = None


def _cinemap_map_load():
    global _cinemeta_id_map
    if _cinemeta_id_map is None:
        try:
            with open(_CINEMETA_MAP_PATH, "r", encoding="utf-8") as fh:
                _cinemeta_id_map = json.load(fh)
        except Exception:
            _cinemeta_id_map = {}
    return _cinemeta_id_map


def _cinemap_map_save():
    try:
        with open(_CINEMETA_MAP_PATH, "w", encoding="utf-8") as fh:
            json.dump(_cinemap_map_load(), fh)
    except Exception:
        pass


def _cinemap_harvest(metas, mtype):
    mp = _cinemap_map_load()
    changed = False
    for m in metas or []:
        mid, mdb = str(m.get("id") or ""), m.get("moviedb_id")
        if mid.startswith("tt") and mdb:
            key = str(int(mdb))
            if mp.get(key) != {"i": mid, "t": mtype}:
                mp[key] = {"i": mid, "t": mtype}
                changed = True
    if changed:
        _cinemap_map_save()


def _cinemeta_get(path):
    req = urllib.request.Request(
        _CINEMETA + path,
        headers={"User-Agent": "Mozilla/5.0 ChalkleMovies/1.0", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _cimg(v):
    return v if isinstance(v, str) and v.startswith("http") else ""


# --- Cinemeta's genre vocabulary <-> TMDB genre ids -------------------------
# The keyless fallback answers genre questions from Cinemeta's own NAME based
# catalogs, but the app speaks TMDB ids (chips carry with_genres=<id>). These
# tables are the translation layer: the genre list endpoints hand out TMDB ids
# (so chips look right and match real TMDB ids), and an incoming id maps back
# to the name Cinemeta's catalog path expects. Names that share one TMDB id
# collapse onto the single name Cinemeta knows (Sci-Fi & Fantasy -> Sci-Fi).
_CM_MOVIE_GENRES = [
    ("Action", 28), ("Adventure", 12), ("Animation", 16), ("Biography", 1),
    ("Comedy", 35), ("Crime", 80), ("Documentary", 99), ("Drama", 18),
    ("Family", 10751), ("Fantasy", 14), ("History", 36), ("Horror", 27),
    ("Mystery", 9648), ("Romance", 10749), ("Sci-Fi", 878), ("Sport", 2),
    ("Thriller", 53), ("War", 10752), ("Western", 37),
]
_CM_TV_GENRES = [
    ("Action & Adventure", 10759), ("Animation", 16), ("Comedy", 35),
    ("Crime", 80), ("Documentary", 99), ("Drama", 18), ("Family", 10751),
    ("Kids", 10762), ("Mystery", 9648), ("News", 10763),
    ("Reality-TV", 10764), ("Sci-Fi & Fantasy", 10765), ("Soap", 10766),
    ("Talk-Show", 10767), ("War & Politics", 10768), ("Western", 37),
]
# TMDB id -> the genre name Cinemeta's catalog path accepts.
_CM_TV_GENRE_NAME = {
    10759: "Action", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary",
    18: "Drama", 10751: "Family", 10762: "Family", 9648: "Mystery",
    10763: "Documentary", 10764: "Reality-TV", 10765: "Sci-Fi", 10766: "Drama",
    10767: "Talk-Show", 10768: "War", 37: "Western",
}
_CM_MOVIE_GENRE_NAME = {gid: name for name, gid in _CM_MOVIE_GENRES}
# Genre name (Cinemeta) -> TMDB id, for tagging rows that arrived genre-less.
_CM_NAME_TO_ID = {}
for _n, _i in _CM_MOVIE_GENRES:
    _CM_NAME_TO_ID.setdefault(_n, _i)
for _n, _i in _CM_TV_GENRES:
    _CM_NAME_TO_ID.setdefault(_n, _i)


def _cm_genre_name(mtype, gid):
    """TMDB genre id -> the name Cinemeta's genre=<name> catalog wants."""
    table = _CM_TV_GENRE_NAME if mtype == "tv" else _CM_MOVIE_GENRE_NAME
    if gid in table:
        return table[gid]
    for name, i in (_CM_TV_GENRES if mtype == "tv" else _CM_MOVIE_GENRES):
        if i == gid:
            return name
    return None


def _cm_genre_ids(names):
    """Cinemeta meta genres (names) -> TMDB genre ids for the row shape."""
    out = []
    for n in (names or []):
        i = _CM_NAME_TO_ID.get(str(n))
        if i and i not in out:
            out.append(i)
    return out


def _cinemeta_item(m, mtype):
    """Cinemeta meta -> TMDB catalog row shape (posters/backdrops absolute)."""
    try:
        mdb = int(m.get("moviedb_id") or 0)
    except Exception:
        mdb = 0
    year = (m.get("releaseInfo") or "").split("\u2013")[0].split("-")[0]
    row = {
        "id": mdb if mdb else m.get("id"),
        "imdb_id": m.get("id"),
        "media_type": mtype,
        "overview": m.get("description") or "",
        "poster_path": _cimg(m.get("poster")),
        "backdrop_path": _cimg(m.get("background") or m.get("poster")),
        "vote_average": float(m.get("imdbRating") or 0) or None,
        "release_date": year if mtype == "movie" else None,
        "first_air_date": year if mtype == "tv" else None,
        "genre_ids": _cm_genre_ids(m.get("genres")),
        "popularity": m.get("popularity") or 0,
    }
    if mtype == "movie":
        row["title"] = m.get("name")
    else:
        row["name"] = m.get("name")
    return row


def _cinemeta_detail(m, mtype, want_id):
    """Cinemeta meta -> TMDB detail shape."""
    # Real TMDB ids where the vocabulary matches, so a title opened from the
    # fallback catalogue still lines up with the app's genre table (the old
    # enumerate()+1 ids produced chips that filtered nothing).
    genres = []
    for i, g in enumerate(m.get("genres") or []):
        genres.append({"id": _CM_NAME_TO_ID.get(str(g), 1000 + i), "name": g})
    runtime = None
    rt = m.get("runtime")
    if isinstance(rt, str) and rt.strip().endswith("min"):
        try:
            runtime = int(rt.strip().split()[0])
        except Exception:
            runtime = None
    elif isinstance(rt, (int, float)):
        runtime = int(rt)
    year = (m.get("releaseInfo") or "").split("\u2013")[0].split("-")[0]
    d = {
        "id": want_id,
        "imdb_id": m.get("id"),
        "overview": m.get("description") or "",
        "poster_path": _cimg(m.get("poster")),
        "backdrop_path": _cimg(m.get("background") or m.get("poster")),
        "vote_average": float(m.get("imdbRating") or 0) or None,
        "genres": genres,
        "status": "Released",
        "tagline": "",
        "production_companies": [],
        "credits": {
            "cast": [{"name": n} for n in (m.get("cast") or [])[:15]],
            "crew": [{"name": n, "job": "Director"} for n in (m.get("director") or [])[:3]],
        },
        "images": {"logos": ( [{"file_path": _cimg(m.get("logo"))}] if _cimg(m.get("logo")) else [] )},
    }
    if mtype == "movie":
        d["title"] = m.get("name")
        d["release_date"] = year
        d["runtime"] = runtime
    else:
        d["name"] = m.get("name")
        d["first_air_date"] = year
        vids = m.get("videos") or []
        seasons = {}
        for v in vids:
            sn = v.get("season")
            if isinstance(sn, int):
                seasons[sn] = seasons.get(sn, 0) + 1
        d["number_of_seasons"] = len(seasons)
        d["number_of_episodes"] = len(vids)
        d["seasons"] = [
            {"season_number": sn, "episode_count": c, "name": "Season %d" % sn}
            for sn, c in sorted(seasons.items())
        ]
        d["last_episode_to_air"] = None
        d["next_episode_to_air"] = None
    return d


def _cinemeta_rows(catalog_path, mtype):
    d = _cinemeta_get(catalog_path)
    metas = d.get("metas") or []
    _cinemap_harvest(metas, mtype)
    return [_cinemeta_item(m, mtype) for m in metas]


def _time_local():
    import time as _time
    return _time.localtime()


def _cinemeta_discover_path(mtype, params):
    """Pick the Cinemeta catalog that best matches a TMDB discover query.
    Returns (catalog_path, genre_id_to_stamp, genre_id_to_filter).

    Cinemeta cannot combine a genre and a year in one catalog, so:
      * genre only          -> Cinemeta's own genre catalog (no filter needed)
      * year (genre or not) -> the year catalog; its rows DO carry genres, so a
                               requested genre is enforced by filtering here
      * nothing specific    -> imdbRating for -top rated-, top otherwise
    The stamp matters because catalog metas often ship no genre list at all, so
    without it every card in a filtered view loses its genre subtitle."""
    ctype = "series" if mtype == "tv" else "movie"
    gid = (params.get("with_genres") or "").split(",")[0].strip()
    gid = int(gid) if gid.isdigit() else None
    year = (params.get("primary_release_year") or params.get("first_air_date_year") or "").strip()
    # Year wins over genre when both are set: the year catalog is already
    # scoped to one year and its rows carry genres, so the genre is enforced
    # by filtering. A genre catalog cannot be narrowed to a year at all.
    if year.isdigit():
        return "/catalog/%s/year/genre=%s.json" % (ctype, year), None, gid
    if gid is not None:
        name = _cm_genre_name("tv" if mtype == "tv" else "movie", gid)
        if name:
            return "/catalog/%s/top/genre=%s.json" % (ctype, urllib.parse.quote(name)), gid, None
    if str(params.get("sort_by") or "").startswith("vote_average"):
        return "/catalog/%s/imdbRating.json" % ctype, None, gid
    return "/catalog/%s/top.json" % ctype, None, gid


def _cm_stamp_genre(rows, gid):
    """Tag genre-less catalog rows with the genre that was filtered on."""
    if not gid:
        return rows
    for r in rows:
        if not r.get("genre_ids"):
            r["genre_ids"] = [gid]
    return rows


def _cm_filter_genre(rows, gid):
    """Keep only rows carrying the requested genre. Returns the unfiltered
    list when nothing matches, so a strict filter can never blank a rail."""
    if not gid:
        return rows
    keep = [r for r in rows if gid in (r.get("genre_ids") or [])]
    return keep or rows


# --- Keyless per-provider catalogs (Cinemeta search seeds) ---
# Served for /discover/movie|tv?with_watch_providers=... whenever the TMDB
# token is rejected (Cinemeta ignores with_watch_providers and genre/skip
# filters, but its title-search endpoint is accurate, so each provider gets a
# curated seed list that reads like that service's real catalog).
_WP_SEEDS = {
    "8": {  # Netflix
        "movie": (
            "red notice", "the gray man", "don't look up", "extraction", "glass onion",
            "bird box", "the irishman", "6 underground", "project power", "bright",
            "army of the dead", "the old guard", "spenser confidential", "the adam project",
            "enola holmes", "the kissing booth", "murder mystery", "the princess switch",
        ),
        "series": (
            "stranger things", "squid game", "the witcher", "wednesday", "money heist",
            "bridgerton", "cobra kai", "the umbrella academy", "the crown", "the queen's gambit",
            "dark", "ozark", "sex education", "the sandman", "locke & key", "black mirror",
            "sweet tooth", "arcane", "the diplomat", "avatar the last airbender",
        ),
    },
    "283": {  # Crunchyroll -> anime
        "movie": (
            "demon slayer", "jujutsu kaisen 0", "one piece film red", "dragon ball super",
            "my hero academia", "suzume", "your name", "weathering with you",
            "spirited away", "howl's moving castle", "princess mononoke", "sword art online",
        ),
        "series": (
            "naruto", "jujutsu kaisen", "one piece", "demon slayer", "attack on titan",
            "my hero academia", "dragon ball", "bleach", "sword art online",
            "fullmetal alchemist", "one punch man", "spy x family", "chainsaw man",
            "hunter x hunter", "dr. stone", "tokyo ghoul", "death note", "haikyuu",
            "frieren", "vinland saga", "jojo's bizarre adventure", "solo leveling",
        ),
    },
    "9": {  # Amazon Prime Video
        "movie": (
            "without remorse", "the tomorrow war", "cinderella", "sound of metal",
            "borat", "one night in miami", "the big sick", "the accountant",
            "patriot's day", "13 hours", "the report", "the map of tiny perfect things",
        ),
        "series": (
            "the boys", "reacher", "the lord of the rings", "invincible", "the expanse",
            "fleabag", "good omens", "upload", "tom clancy's jack ryan",
            "the marvelous mrs. maisel", "bosch", "the wheel of time", "outer range",
            "the man in the high castle", "the legend of vox machina", "citadel",
            "the summer i turned pretty", "jack reacher",
        ),
    },
    "337": {  # Disney+
        "movie": (
            "moana", "frozen", "encanto", "toy story", "the lion king", "avengers",
            "black panther", "doctor strange", "thor", "guardians of the galaxy",
            "turning red", "luca", "soul", "coco", "inside out", "elemental",
            "lightyear", "wish", "the little mermaid", "mulan",
        ),
        "series": (
            "the mandalorian", "andor", "loki", "wanda", "the falcon and the winter soldier",
            "moon knight", "ms. marvel", "she-hulk", "star wars visions", "obi-wan kenobi",
            "x-men '97", "percy jackson", "bluey", "ahsoka", "the book of boba fett",
            "what if...?", "the acolyte", "agatha", "the bear",
        ),
    },
    "350": {  # Apple TV+
        "movie": (
            "killers of the flower moon", "napoleon", "greyhound", "palm springs",
            "finch", "the banker", "wolfwalkers", "coda", "the greatest beer run ever",
            "argylle", "tetris", "spirited",
        ),
        "series": (
            "ted lasso", "severance", "foundation", "silo", "for all mankind",
            "shrinking", "slow horses", "the morning show", "mythic quest", "black bird",
            "hijack", "monarch", "bad sisters", "invasion", "servant", "physical",
            "the afterparty", "platonic",
        ),
    },
    "15": {  # Hulu
        "movie": (
            "prey", "boss level", "vacation friends", "the united states vs. billie holiday",
            "happiest season", "run", "the bad seed", "books of blood", "the drop",
            "big time adolescence", "false positive",
        ),
        "series": (
            "the handmaid's tale", "only murders in the building", "the bear", "futurama",
            "family guy", "solar opposites", "resident alien", "what we do in the shadows",
            "the great", "normal people", "dollface", "high fidelity", "ramy",
            "shrill", "pen15", "letterkenny",
        ),
    },
    "1899": {  # HBO Max
        "movie": (
            "dune", "the batman", "barbie", "wonka", "the meg", "aquaman",
            "the matrix", "mad max", "furiosa", "gravity", "interstellar",
            "inception", "the dark knight", "joker",
        ),
        "series": (
            "game of thrones", "house of the dragon", "the last of us", "succession",
            "euphoria", "the white lotus", "barry", "chernobyl", "true detective",
            "the wire", "the sopranos", "westworld", "the penguin", "watchmen",
            "six feet under", "sex and the city", "the gilded age", "the undoing",
        ),
    },
    "2303": {  # Paramount+
        "movie": (
            "top gun", "mission impossible", "sonic the hedgehog", "transformers",
            "a quiet place", "smile", "mean girls", "paw patrol", "scream",
            "snake eyes", "infinite", "the tomorrow war",
        ),
        "series": (
            "yellowstone", "tulsa king", "1883", "1923", "star trek",
            "mayor of kingstown", "lioness", "seal team", "halo", "the good fight",
            "evil", "twin peaks", "criminal minds", "survivor", "big brother", "frasier",
        ),
    },
    "386": {  # Peacock
        "movie": (
            "john wick", "fast & furious", "jurassic world", "minions",
            "despicable me", "five nights at freddy's", "halloween", "nope", "us",
            "m3gan", "nobody", "the boss baby", "megamind",
        ),
        "series": (
            "the office", "brooklyn nine-nine", "parks and recreation", "modern family",
            "chicago fire", "law & order", "supernatural", "the blacklist", "house",
            "yellowstone", "killing eve", "bel-air", "twisted metal", "based on a true story",
        ),
    },
    "43": {  # Starz
        "movie": (
            "the spy who dumped me", "bad moms", "the commuter", "the equalizer",
            "sicario", "american made", "the circle", "blockers", "instant family",
            "the mule", "den of thieves",
        ),
        "series": (
            "power", "outlander", "spartacus", "black sails", "american gods",
            "hightown", "gaslit", "flesh and bone", "magic city", "the spanish princess",
            "the white princess", "survivor's remorse", "dangerous lady", "the girlfriend experience",
        ),
    },
    "526": {  # AMC+
        "movie": (
            "the sadness", "sputnik", "deliver us from evil", "the night house",
            "the innocents", "pray for the devil", "watcher", "shiva baby", "a glitch in the matrix",
        ),
        "series": (
            "the walking dead", "interview with the vampire", "mayfair witches",
            "dark winds", "gangs of london", "better call saul", "breaking bad",
            "mad men", "fear the walking dead", "the terror", "too old to die young",
            "dietland", "lodge 49", "the killing",
        ),
    },
    "34": {  # MGM+
        "movie": (
            "no time to die", "halloween kills", "addams family values",
            "the silence of the lambs", "legally blonde", "rocky", "thelma & louise",
            "dances with wolves", "rain man", "some like it hot", "12 angry men", "goodfellas",
        ),
        "series": (
            "godfather of harlem", "hotel cocaine", "chapelwaite", "from", "dominion",
            "condor", "rogue heroes", "the winter king", "emperor", "beacon 23",
            "the lost flowers of alice hart", "bridge and tunnel", "lauren lake",
        ),
    },
    "2": {  # Apple TV (store/rentals) -> blockbuster mix
        "movie": (
            "top gun maverick", "dune", "avatar", "oppenheimer", "barbie", "the batman",
            "spider-man", "john wick", "the dark knight", "interstellar", "inception",
            "gladiator", "titanic", "avengers", "the matrix", "jurassic park",
        ),
        "series": (
            "ted lasso", "severance", "foundation", "silo", "for all mankind", "slow horses",
            "the morning show", "mythic quest", "shrinking", "black bird", "servant",
        ),
    },
    "300": {  # Pluto TV -> free classics
        "movie": (
            "terminator", "top gun", "the godfather", "pulp fiction", "fight club",
            "the matrix", "titanic", "jurassic park", "the dark knight", "scarface",
            "rocky", "die hard", "the wolf of wall street", "gladiator",
        ),
        "series": (
            "survivor", "the amazing race", "csi", "dexter", "star trek",
            "rugrats", "hey arnold", "beavis and butt-head", "the twilight zone",
            "dr. phil", "the andy griffith show", "twilight zone",
        ),
    },
    "73": {  # Tubi -> free movies
        "movie": (
            "tremors", "mortal kombat", "scary movie", "the twilight saga", "the notebook",
            "step brothers", "zombieland", "the mummy", "the professional",
            "reservoir dogs", "donnie darko", "requiem for a dream", "american psycho",
            "trainspotting", "se7en", "the godfather", "fight club",
        ),
        "series": (
            "the simpsons", "family guy", "south park", "bob's burgers",
            "the mentalist", "monk", "psych", "burn notice", "white collar",
        ),
    },
}

_wp_lock = threading.Lock()
_wp_pool_cache = {}                 # (pid, mtype) -> [built_at, last_used, rows]
_wp_building = set()                # (pid, mtype) pools currently being fetched
_WP_POOL_TTL = 3600                 # seconds before a pool refreshes (stale-served meanwhile)
_WP_KEEP_PER_SEED = 3               # strongest matches to keep per search seed
_WP_POOL_MIN = 30                   # pad small pools to at least this many rows
_WP_POOL_MAX = 90
_WP_POOLS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cinemeta-pools.json")


def _wp_pools_save():
    """Persist built pools to disk so a server restart (or a second server
    instance) starts warm instead of re-fetching every provider seed list."""
    try:
        tmp = _WP_POOLS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "%s|%s" % k: {"built_at": v[0], "rows": v[2]}
                    for k, v in _wp_pool_cache.items()
                },
                fh,
            )
        os.replace(tmp, _WP_POOLS_PATH)
    except Exception:
        pass


def _wp_pools_load():
    now = time.time()
    try:
        with open(_WP_POOLS_PATH, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        for k, v in raw.items():
            try:
                pid, mtype = k.split("|", 1)
                rows = v.get("rows") or []
                if rows and pid in _WP_SEEDS and mtype in ("movie", "tv"):
                    _wp_pool_cache[(pid, mtype)] = [float(v.get("built_at") or 0), now, rows]
            except Exception:
                continue
    except Exception:
        pass


_wp_pools_load()


def _cinemeta_search_rows(mtype, query):
    ctype = "series" if mtype == "tv" else "movie"
    enc = urllib.parse.quote(query)
    try:
        metas = (_cinemeta_get("/catalog/%s/top/search=%s.json" % (ctype, enc)).get("metas") or [])
    except Exception:
        return []
    _cinemap_harvest(metas, mtype)
    return [_cinemeta_item(m, mtype) for m in metas if m.get("name")]


def _wp_fetch_pool(key):
    """Fetch + dedupe one provider pool from Cinemeta (no lock, no cache)."""
    pid, mtype = key
    seeds = (_WP_SEEDS.get(pid) or {}).get("series" if mtype == "tv" else "movie")
    if not seeds:
        return None
    rows, seen = [], set()

    def _grab(seed):
        return _cinemeta_search_rows(mtype, seed)
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=12) as ex:
        per_seed = list(ex.map(_grab, seeds))
    for got in per_seed:
        kept = 0
        for r in got:
            nm = (r.get("title") or r.get("name") or "").strip().lower()
            if not nm or nm in seen:
                continue
            seen.add(nm)
            rows.append(r)
            kept += 1
            if kept >= _WP_KEEP_PER_SEED:
                break
    # pad from the generic top list so thin catalogs still fill a grid
    if len(rows) < _WP_POOL_MIN:
        for r in _cinemeta_rows("/catalog/%s/top.json" % ("series" if mtype == "tv" else "movie"), mtype):
            nm = (r.get("title") or r.get("name") or "").strip().lower()
            if nm and nm not in seen:
                seen.add(nm)
                rows.append(r)
            if len(rows) >= _WP_POOL_MIN:
                break
    return rows[:_WP_POOL_MAX]


def _wp_store_pool(key, rows):
    with _wp_lock:
        _wp_pool_cache[key] = [time.time(), time.time(), rows]
    _wp_pools_save()


def _wp_refresh(key):
    """Background rebuild of an expired pool (stale-while-revalidate)."""
    try:
        rows = _wp_fetch_pool(key)
        if rows:
            _wp_store_pool(key, rows)
    except Exception:
        pass
    finally:
        with _wp_lock:
            _wp_building.discard(key)


def _wp_warm_all():
    """Pre-build every curated provider pool shortly after boot so the first
    click on any provider is served from cache instead of blocking on
    Cinemeta. Runs in the background; pools persisted on disk make restarts
    near-instant."""
    keys = []
    for pid, seeds in _WP_SEEDS.items():
        for mtype in ("movie", "tv"):
            if (seeds or {}).get("series" if mtype == "tv" else "movie"):
                keys.append((pid, mtype))
    import random
    random.shuffle(keys)

    def _worker(chunk):
        for key in chunk:
            try:
                _cinemeta_provider_pool(*key)
            except Exception:
                pass
    mid = (len(keys) + 1) // 2
    threading.Thread(target=_worker, args=(keys[:mid],), daemon=True).start()
    threading.Thread(target=_worker, args=(keys[mid:],), daemon=True).start()


def _cinemeta_provider_pool(pid, mtype):
    """Return a deduped, cached pool of rows for (provider, type), or None when
    that provider has no curated seed list (caller falls back to generic top).
    Fresh pools return instantly; expired pools are served stale while a
    background thread refreshes them; only a truly cold pool is fetched inline,
    so browsing never waits once warm."""
    seeds = (_WP_SEEDS.get(pid) or {}).get("series" if mtype == "tv" else "movie")
    if not seeds:
        return None
    key = (pid, mtype)
    with _wp_lock:
        hit = _wp_pool_cache.get(key)
        if hit:
            hit[1] = time.time()
            if time.time() - hit[0] < _WP_POOL_TTL:
                return hit[2]
    if hit is not None:
        # expired: serve the stale pool, refresh it in the background
        with _wp_lock:
            hit2 = _wp_pool_cache.get(key)
            if hit2 and time.time() - hit2[0] < _WP_POOL_TTL:
                return hit2[2]
            if key not in _wp_building:
                _wp_building.add(key)
                threading.Thread(target=_wp_refresh, args=(key,), daemon=True).start()
        return hit[2]
    # truly cold: fetch inline (another builder may already be on it)
    with _wp_lock:
        if key in _wp_building:
            mine = False
        else:
            _wp_building.add(key)
            mine = True
    if not mine:
        # another thread (e.g. the boot warm-up) is fetching it: wait briefly
        for _ in range(300):
            time.sleep(0.1)
            with _wp_lock:
                hit = _wp_pool_cache.get(key)
                if hit:
                    hit[1] = time.time()
                    return hit[2]
        return None
    try:
        rows = _wp_fetch_pool(key)
        if rows:
            _wp_store_pool(key, rows)
        return rows or None
    finally:
        with _wp_lock:
            _wp_building.discard(key)


def _cinemeta_respond(self, payload):
    raw = json.dumps(payload).encode()
    self.send_response(200)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Access-Control-Allow-Origin", "*")
    self.send_header("Cache-Control", "public, max-age=300")
    self.send_header("Content-Length", str(len(raw)))
    self.end_headers()
    self.wfile.write(raw)


def _cinemeta_serve(path_tail, qs):
    """Return a TMDB-shaped JSON payload for the requested TMDB route using
    Cinemeta, or None when the route is not coverable."""
    import time as _time
    params = {}
    for kv in (qs or "").split("&"):
        if "=" in kv:
            k, v = kv.split("=", 1)
            params[k] = urllib.parse.unquote_plus(v)
    cache_key = path_tail + "?" + qs
    hit = _cinemeta_route_cache.get(cache_key)
    if hit and _time.time() - hit[0] < _CINEMETA_TTL:
        return hit[1]

    results = None
    try:
        mm = re.match(r"^(trending|search|discover)/([a-z]+)(?:/([a-z]+))?", path_tail)
        if mm:
            kind, sub, sub2 = mm.group(1), mm.group(2), mm.group(3)
            if kind == "trending":
                mtype = sub if sub in ("movie", "tv") else "all"
                page = int(params.get("page") or 1)
                skip = max(0, (page - 1) * 50)
                movies = _cinemeta_rows("/catalog/movie/top.json?skip=%d" % skip, "movie")
                series = _cinemeta_rows("/catalog/series/top.json?skip=%d" % skip, "tv")
                rows = movies if mtype == "movie" else series if mtype == "tv" else movies + series
                results = {"page": page, "results": rows, "total_pages": 500, "total_results": 25000}
            elif kind == "search":
                q = (params.get("query") or "").strip()
                if q:
                    enc = urllib.parse.quote(q)
                    movies = _cinemeta_rows("/catalog/movie/top/search=%s.json" % enc, "movie")
                    series = _cinemeta_rows("/catalog/series/top/search=%s.json" % enc, "tv")
                    if sub == "movie":
                        rows = movies
                    elif sub == "tv":
                        rows = series
                    else:
                        rows = movies + series
                    results = {"page": 1, "results": rows, "total_pages": 1, "total_results": len(rows)}
            elif kind == "discover":
                mtype = "tv" if sub == "tv" else "movie"
                wp = (params.get("with_watch_providers") or "").strip()
                page = int(params.get("page") or 1)
                if wp:
                    pool = _cinemeta_provider_pool(wp, mtype)
                    if pool is not None:
                        start = max(0, (page - 1) * 15)
                        rows = pool[start:start + 15]
                        results = {"page": page, "results": rows,
                                   "total_pages": max(1, -(-len(pool) // 15)),
                                   "total_results": len(pool)}
                    else:
                        cat, stamp, filt = _cinemeta_discover_path(mtype, params)
                        rows = _cinemeta_rows(cat, mtype)
                        if filt:
                            rows = _cm_filter_genre(rows, filt)
                        if stamp:
                            rows = _cm_stamp_genre(rows, stamp)
                        results = {"page": page, "results": rows, "total_pages": 1, "total_results": len(rows)}
                else:
                    cat, stamp, filt = _cinemeta_discover_path(mtype, params)
                    rows = _cinemeta_rows(cat, mtype)
                    if filt:
                        rows = _cm_filter_genre(rows, filt)
                    if stamp:
                        rows = _cm_stamp_genre(rows, stamp)
                    results = {"page": page, "results": rows, "total_pages": 1, "total_results": len(rows)}
        elif re.match(r"^genre/(movie|tv)/list$", path_tail):
            # The app's filter chips read real TMDB genre ids. The dead bearer
            # token used to 401 this route, which left the whole genre bar
            # empty; the fallback answers from the shared vocabulary instead.
            table = _CM_MOVIE_GENRES if path_tail.startswith("genre/movie") else _CM_TV_GENRES
            results = {"genres": [{"id": gid, "name": name} for name, gid in table]}
        elif re.match(r"^(movie|tv)/(now_playing|upcoming|top_rated|airing_today|on_the_air|latest)$", path_tail):
            # Home/widget rails TMDB serves under their own routes. Cinemeta
            # exposes equivalents: year catalogs for fresh releases, the
            # imdbRating catalog for top rated and last-videos for what is
            # airing now.
            parts = path_tail.split("/")
            mtype, which = parts[0], parts[1]
            ctype = "movie" if mtype == "movie" else "series"
            page = int(params.get("page") or 1)
            skip = max(0, (page - 1) * 50)
            if which in ("now_playing", "upcoming"):
                cat = "/catalog/%s/year/genre=%d.json" % (ctype, _time_local().tm_year)
            elif which == "top_rated":
                cat = "/catalog/%s/imdbRating.json" % ctype
            elif which == "latest":
                cat = "/catalog/%s/year/genre=%d.json" % (ctype, _time_local().tm_year)
            else:
                cat = "/catalog/series/last-videos.json"
                mtype = "tv"
            rows = _cinemeta_rows(cat, mtype)
            results = {"page": page, "results": rows, "total_pages": 20, "total_results": len(rows)}
        elif re.match(r"^(movie|tv)/popular$", path_tail):
            # TMDB /movie/popular and /tv/popular (home widgets + rail
            # prefetches). Cinemeta exposes the same shape under catalog/
            # {movie|series}/popular.json, so the keyless fallback now
            # covers these too (the dead bearer token 401'd them, seen in
            # the 09/14 view sweep).
            mtype = "movie" if path_tail.startswith("movie/") else "tv"
            page = int(params.get("page") or 1)
            skip = max(0, (page - 1) * 50)
            ctype = "movie" if mtype == "movie" else "series"
            rows = _cinemeta_rows("/catalog/%s/popular.json?skip=%d" % (ctype, skip), mtype)
            results = {"page": page, "results": rows, "total_pages": 500, "total_results": 25000}
        elif path_tail.startswith("find/"):
            imdb = path_tail.split("find/", 1)[1].split("?")[0].split("/")[0]
            payload = {"movie_results": [], "tv_results": [], "person_results": [], "tv_episode_results": [], "tv_season_results": []}
            try:
                m = (_cinemeta_get("/meta/movie/%s.json" % imdb).get("meta") or {})
                if m.get("id"):
                    _cinemap_harvest([m], "movie")
                    payload["movie_results"] = [_cinemeta_item(m, "movie")]
            except Exception:
                pass
            try:
                m = (_cinemeta_get("/meta/series/%s.json" % imdb).get("meta") or {})
                if m.get("id"):
                    _cinemap_harvest([m], "tv")
                    payload["tv_results"] = [_cinemeta_item(m, "tv")]
            except Exception:
                pass
            results = payload
        elif re.match(r"^tv/.+/season/\d+$", path_tail):
            # /tv/{id}/season/{n} -> per-episode list from the series meta
            parts = path_tail.split("/")
            ident, sn = parts[1], int(parts[3])
            imdb = None
            if ident.startswith("tt"):
                imdb = ident
            else:
                rec = _cinemap_map_load().get(str(ident))
                if rec:
                    imdb = rec["i"]
                else:
                    _cinemeta_rows("/catalog/series/top.json", "tv")
                    rec = _cinemap_map_load().get(str(ident))
                    imdb = rec["i"] if rec else None
            if imdb:
                m = (_cinemeta_get("/meta/series/%s.json" % imdb).get("meta") or {})
                vids = m.get("videos") or []
                eps = []
                for v in vids:
                    if int(v.get("season") or 0) != sn:
                        continue
                    still = v.get("thumbnail") or ""
                    eps.append({
                        "episode_number": int(v.get("episode") or 0),
                        "season_number": sn,
                        "name": v.get("name") or ("Episode %s" % v.get("episode")),
                        "overview": v.get("overview") or v.get("description") or "",
                        "still_path": still if str(still).startswith("http") else "",
                        "air_date": (v.get("released") or "")[:10] or None,
                        "vote_average": float(v.get("rating") or 0) or None,
                    })
                eps.sort(key=lambda e: e["episode_number"])
                results = {"id": int(ident) if ident.isdigit() else ident,
                           "season_number": sn, "episodes": eps}
        elif re.match(r"^(movie|tv)/", path_tail):
            mtype = "movie" if path_tail.startswith("movie/") else "tv"
            ident = path_tail.split("/", 1)[1].split("?")[0].split("/")[0]
            imdb = None
            if ident.startswith("tt"):
                imdb = ident
            else:
                rec = _cinemap_map_load().get(str(ident))
                if rec:
                    imdb = rec["i"]
                else:
                    # cold map: warm it from top catalogs once, then retry
                    _cinemeta_rows("/catalog/movie/top.json", "movie")
                    _cinemeta_rows("/catalog/series/top.json", "tv")
                    rec = _cinemap_map_load().get(str(ident))
                    imdb = rec["i"] if rec else None
            if imdb:
                # The id map knows the real media type: widgets sometimes ask
                # for a movie id under tv/ (or the reverse), and Cinemeta
                # answers a wrong-type lookup with null, which used to fall
                # through to the raw 401 (seen in the 09/14 view sweep for
                # tv/278, tv/6435 and friends). Mapped type wins when known;
                # otherwise try the opposite type once before giving up.
                ctype = "series" if mtype == "tv" else "movie"
                rec = None if ident.startswith("tt") else _cinemap_map_load().get(str(ident))
                if rec and rec.get("t") in ("movie", "tv"):
                    ctype = "series" if rec["t"] == "tv" else "movie"
                m = {}
                for ct in (ctype, "series" if ctype == "movie" else "movie"):
                    try:
                        m = (_cinemeta_get("/meta/%s/%s.json" % (ct, imdb)).get("meta") or {})
                    except Exception:
                        m = {}
                    if m.get("id"):
                        ctype = ct
                        break
                if m.get("id"):
                    results = _cinemeta_detail(m, "tv" if ctype == "series" else "movie", int(ident) if ident.isdigit() else ident)
        elif path_tail.startswith("configuration"):
            results = {
                "images": {"secure_base_url": "https://image.tmdb.org/t/p/", "poster_sizes": ["w500"], "backdrop_sizes": ["w1920"], "logo_sizes": ["w780"]},
                "change_keys": [],
            }
    except Exception:
        results = None

    if results is None:
        return None
    _cinemeta_route_cache[cache_key] = (_time.time(), results)
    return results





def _serve_mp3_fallback(handler, route):
    """Undertale GameMaker audio fallback.

    The hosted HTML5 build expects both mus_*.mp3 and abc_*_a.mp3 style
    assets. When the matching mp3 is missing on this host, the runner gets a
    404 HTML body and decodeAudioData throws "unknown content type", which is
    exactly the spammy audio errors seen on the hosted build. Where a matching
    .ogg exists, return a clean 302 to that file so the runner can decode it.
    Otherwise return a proper audio 404 (not an HTML body) so non-game clients
    get a real error too. The fallback only applies to mp3s under a known game
    audio tree so regular music/other .mp3 assets are not rewritten.

    Module-level by design (it sits below the Handler class) - it receives the
    request handler explicitly. The old copy was defined here but called as
    self._serve_mp3_fallback, so every plain .mp3 request crashed the handler
    thread and the browser saw an empty reply.
    """
    from urllib.parse import unquote
    decoded = unquote(route)
    lower = decoded.lower()
    if "/html5game/" not in lower and "/game-builds/" not in lower:
        return None
    base = decoded[:-4] if decoded.lower().endswith(".mp3") else decoded
    alt = base + ".ogg"
    full = handler.translate_path(alt)
    if os.path.isfile(full):
        handler.send_response(302)
        handler.send_header("Location", alt)
        handler.end_headers()
        return True
    handler.send_response(404)
    handler.send_header("Content-Type", "audio/mpeg")
    handler.send_header("Cache-Control", "no-store, max-age=0")
    handler.end_headers()
    handler.wfile.write(b"404 Not Found\n")
    return True
def _is_private_ip(ip):
    """True for loopback, RFC1918, link-local, CGNAT, and documentation ranges.
    Used by the Domain Hub checker to refuse SSRF-style probes of internal
    infrastructure we don't own."""
    import ipaddress
    try:
        return ipaddress.ip_address(ip).is_private or ipaddress.ip_address(ip).is_loopback or ipaddress.ip_address(ip).is_link_local or ipaddress.ip_address(ip).is_reserved or ipaddress.ip_address(ip).is_multicast or ipaddress.ip_address(ip).is_unspecified
    except Exception:
        return True


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Opener that surfaces 3xx responses as HTTPError instead of following
    them, so _http_get can re-validate every redirect hop against the
    private-host guard."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _is_private_host(host):
    """True when a hostname or IP points at private, loopback, link-local,
    CGNAT, reserved or multicast space. Names are resolved first so a DNS
    name that answers with an internal address is caught too (the SSRF
    classic). Unresolvable names are treated as private - fail closed."""
    import ipaddress
    h = str(host or "").strip().strip("[]").lower()
    if not h:
        return True
    if h in ("localhost", "localhost.localdomain") or h.endswith(".local") or h.endswith(".internal"):
        return True
    try:
        ipaddress.ip_address(h)
        return _is_private_ip(h)
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(h, None)
    except Exception:
        return True
    for info in infos:
        ip = info[4][0]
        if _is_private_ip(ip):
            return True
    return False


def _http_get(url):
    """Return (raw_bytes_or_None, mime_str, code, error_or_None)."""
    import urllib.request
    u = urllib.parse.urlsplit(str(url or ""))
    if u.scheme not in ("http", "https") or not u.hostname:
        return None, "", 0, "blocked-scheme"
    if _is_private_host(u.hostname):
        return None, "", 0, "blocked-host"
    # Redirects are followed manually so every hop is re-checked: without
    # this a public URL that 302s to an internal address would bypass the
    # guard above (the other proxies in this file have the same rule).
    for _hop in range(5):
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ChalkleAuditor/1.0",
                "Accept": "*/*",
            },
        )
        opener = urllib.request.build_opener(_NoRedirect())
        try:
            with opener.open(req, timeout=FETCH_TIMEOUT) as resp:
                data = resp.read()
                ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
                return data, ctype or "application/octet-stream", resp.getcode(), None
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308):
                loc = e.headers.get("Location") or ""
                if not loc:
                    return None, "", e.code, None
                nxt = urllib.parse.urljoin(url, loc)
                nu = urllib.parse.urlsplit(nxt)
                if nu.scheme not in ("http", "https") or not nu.hostname:
                    return None, "", e.code, "blocked-scheme"
                if _is_private_host(nu.hostname):
                    return None, "", 0, "blocked-host"
                url = nxt
                continue
            return None, "", e.code, None
        except Exception as e:
            return None, "", 0, type(e).__name__
    return None, "", 0, "too-many-redirects"



def _http_status(url):
    """Return (final_http_code, error_or_None). Follows redirects; 0 = failure."""
    import urllib.request
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ChalkleAuditor/1.0",
            "Accept": "*/*",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            return resp.getcode(), None
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:
        return 0, type(e).__name__


# ----------------------------------------------------------- proxy helpers
# Rewriting proxy internals: base64url route encoding, the HTML/CSS rewriter,
# the injected client patch, and the upstream fetcher.

_UV_RAW_TAGS = ("script", "textarea", "template", "noscript")
_UV_TAG_NAME_RE = re.compile(r"<\s*([a-zA-Z][a-zA-Z0-9:_-]*)")
_UV_ATTR_RE = re.compile(r'''\s([a-zA-Z_:][a-zA-Z0-9_:.\-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)''')
_UV_CSS_URL_RE = re.compile(r"url\(\s*(?P<q>['\"]?)(?P<u>[^)'\"\s]+)(?P<q2>['\"]?)\s*\)", re.I)
_UV_URL_ATTRS = ("href", "src", "action", "poster", "data-src", "data-href",
                 "data-url", "data-original", "data-lazy-src", "xlink:href")

# --------------------------------------------------------------- ad filter
# Every embed player in the library monetises through a handful of ad networks:
# popunders behind "click anywhere to play", banner slots, and popup farms that
# take over the tab. All of them are third-party hosts, and EVERY request a
# proxied page makes comes back through /res/ - so filtering here catches the
# ads a page injects at runtime, not just the <script src> tags visible in its
# HTML. That matters because these players assemble their ad stack in JS after
# load, which is exactly what a static filter cannot see.
#
# Matching is suffix-based on the hostname: "a.popads.net" is covered by
# "popads.net" while "notpopads.net" is not. Hosts are matched, never URL
# substrings, so a player's own /ads/ path or an ad-free API host survives.
_UV_AD_HOSTS = (
    # popunder / popup / interstitial networks
    "popads.net", "popcash.net", "popmyads.com", "popunderjs.com",
    "propellerads.com", "propellerads-cdn.com", "onclickalgo.com",
    "onclickads.net", "onclickmega.com", "onclck.org", "onclck.com",
    "adsterra.com", "highperformanceformat.com", "profitableratecpm.com",
    "effectivegatecpm.com", "dubiousagency.com", "monetag.com",
    "hilltopads.net", "hilltopads.com", "adcash.com", "clickadu.com",
    "admaven.com", "adnium.com", "bidvertiser.com", "zedo.com",
    "trafficjunky.net", "trafficstars.com", "juicyads.com", "exoclick.com",
    "exdynsrv.com", "realsrv.com", "exponential.com", "adf.ly",
    # content-recommendation widgets that embed ad frames
    "mgid.com", "taboola.com", "outbrain.com", "revcontent.com",
    # Google's ad stack. The site's OWN AdSense never routes through /res/, so
    # this only strips ads inside proxied players.
    "doubleclick.net", "googlesyndication.com", "googleadservices.com",
    "adservice.google.com", "adsafeprotected.com", "moatads.com",
    # push-permission prompts and the trackers that ride along with them
    "onesignal.com", "pushnami.com", "histats.com", "cloudflareinsights.com",
    "scorecardresearch.com", "quantserve.com", "criteo.com", "adnxs.com",
    "propellerpops.com", "pemsrv.com", "googlesyndication-cn.com",
)


def _uv_ad_host(url):
    """True when a relayed URL belongs to a blocked ad or tracker network.
    Accepts a full URL or a bare hostname; unparseable input is never blocked
    (a filter must not break playback over a parse quirk)."""
    import urllib.parse
    h = str(url or "").strip().lower()
    if not h:
        return False
    if "//" in h:
        try:
            h = urllib.parse.urlsplit(h).hostname or ""
        except Exception:
            return False
    h = h.split("/", 1)[0].split("@")[-1].split(":", 1)[0].strip(".")
    if not h:
        return False
    for bad in _UV_AD_HOSTS:
        if h == bad or h.endswith("." + bad):
            return True
    return False


# What a blocked request gets back instead of a 403. See _uv_ad_stub.
_UV_BLANK_DOC = (b"<!doctype html><html><head><meta charset='utf-8'>"
                 b"<style>html,body{margin:0;height:100%;background:transparent}</style>"
                 b"</head><body></body></html>")
_UV_BLANK_JS = b"/* blocked */"
_UV_BLANK_GIF = base64.b64decode(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")


# Injected into every proxied page, right after <head>, so it runs before any
# site script. It reroutes the runtime requests that static rewriting can't
# see: fetch / XHR / WebSocket calls with absolute or root-relative URLs, and
# history / location navigations, all through the same /res/ route. It also
# carries the client half of the ad filter: the relay can stub an ad request,
# but only the page itself can stop a popunder from opening or an ad frame from
# landing in the player's layout.
_UV_PATCH_JS = (
    "<script>"
    "(function(){"
    "\"use strict\";"
    "try{"
    "var TARGET=window.__UV_TARGET__||'';var P='/res/';"
    # Media files deliberately DO NOT go through the relay. A proxied fetch of a
    # .mp4/.m3u8 is a request from this server, which loses three things a player
    # needs: Range/seek handling, the cookies the provider's session set, and the
    # short-lived signature a CDN ties to that session. One CDN answered a relayed
    # stream URL with 502, which the viewer saw as a black frame. A
    # <video>/<audio>/<source> src needs no CORS to load cross-origin, so the
    # browser's own network stack does this better in every way.
    "function mediaUrl(u){try{"
    "var m=String(u).split('#')[0].split('?')[0].toLowerCase();"
    "return /\\.(mp4|m4v|webm|mkv|mov|mp3|m4a|aac|ogg|oga|opus|m3u8|mpd|ts|m4s|vtt|srt|ass|key)$/.test(m);"
    "}catch(e){return false;}}"
    # The ad-host list is generated from the Python constant above so the two
    # halves of the filter can never drift apart.
    "var ADH=" + json.dumps(list(_UV_AD_HOSTS)) + ";"
    "function badhost(u){"
    "if(!u||typeof u!=='string')return false;"
    "var s=u.trim();"
    "if(!s||/^(data:|blob:|javascript:|about:|#)/i.test(s))return false;"
    "var h='';var sp=-1;"
    # indexOf instead of a regex literal: a '/' inside a JS regex must be
    # escaped, and those backslashes would be invalid Python escape sequences.
    "if(s.indexOf('//')===0)h=s.slice(2);"
    "else{sp=s.indexOf('://');if(sp>0)h=s.slice(sp+3);}"
    "if(!h)return false;"  # relative URL -> this origin, never an ad host
    "h=h.split('/')[0].split('@').pop().split(':')[0].toLowerCase();"
    "if(h.charAt(h.length-1)==='.')h=h.slice(0,-1);"
    "for(var i=0;i<ADH.length;i++){var b=ADH[i];"
    "if(h===b||h.slice(-(b.length+1))==='.'+b)return true;}"
    "return false;}"
    # There is deliberately NO DOM layer here: nothing is hidden, marked or
    # deleted. Hiding and removing are both trivially detectable - a hidden
    # node reports offsetParent === null, a removed one simply vanishes - and
    # these players ship ad-block walls that react to exactly that. Blocking
    # the REQUEST is invisible by comparison: the ad script is handed a 200
    # and stops. A stale banner that renders empty is the acceptable price.
    # badhost() still guards the two things a stub cannot reach, popups and
    # ad redirects, because those hijack the tab rather than just load bytes.
    "function enc(u){try{u=encodeURIComponent(u);var o='';"
    "for(var i=0;i<u.length;i++){var c=u.charCodeAt(i)^(0x2f+i%0x31);"
    "o+=(c<16?'0':'')+c.toString(16);}return o;}"
    "catch(e){return encodeURIComponent(u)}}"
    "function abs(u){"
    "if(!u||typeof u!=='string')return u;"
    "var s=u.trim();"
    # file:/about: must never be wrapped: a file: URL routed through /res/ would
    # make the relay fetch it server-side (local-file-read risk), and the
    # browser logs "may not load or link to file:///" on any file: reference.
    "if(!s||/^(data:|blob:|javascript:|file:|about:|mailto:|tel:|#)/i.test(s))return u;"
    "if(s.indexOf('//')===0)s=location.protocol+s;"
    "if(/^(?:https?|wss?):\\/\\//i.test(s))return s;"
    "if(TARGET){try{var b=new URL(TARGET);"
    "if(s.charAt(0)==='/')return b.origin+s;"
    "return new URL(s,TARGET).href;}catch(e){return u;}}"
    "return u;"
    "}"
    "function wrap(u){var a=abs(u);if(a===u){"
    "if(typeof u==='string'&&/^(?:https?|wss?):\\/\\//i.test(u.trim()))return P+enc(u.trim());"
    "return u;}"
    "if(a.indexOf(P)===0||a.indexOf(location.origin+P)===0)return a;"
    "if(a.indexOf(location.origin)===0)return P+enc(a);"
    "return P+enc(a);}"
    "var of=window.fetch;"
    "if(of){window.fetch=function(input,init){"
    "try{if(typeof input==='string')input=wrap(input);"
    "else if(input&&typeof input.url==='string')input=new Request(wrap(input.url),input);}"
    "catch(e){}"
    "return of.call(this,input,init);};}"
    "var ox=XMLHttpRequest.prototype.open;"
    "if(ox){XMLHttpRequest.prototype.open=function(m,u){"
    "try{if(typeof u==='string')u=wrap(u);}catch(e){}"
    "return ox.apply(this,arguments);};}"
    # Popunders and popup interstitials. A player has no legitimate reason to
    # open a window, and the stub keeps callers that expect a handle (and then
    # call .focus() / .close() on it) from throwing.
    "try{window.open=function(){return {closed:true,blur:function(){},"
    "focus:function(){},close:function(){},postMessage:function(){},moveTo:function(){},"
    "resizeTo:function(){},document:{write:function(){},close:function(){}},"
    "location:{href:'',replace:function(){},assign:function(){}}};};}catch(e){}"
    "var OWS=window.WebSocket;"
    "if(OWS){window.WebSocket=function(u,p){"
    "try{u=wrap(u);}catch(e){}"
    "return p===undefined?new OWS(u):new OWS(u,p);};"
    "window.WebSocket.prototype=OWS.prototype;"
    "window.WebSocket.CONNECTING=OWS.CONNECTING;window.WebSocket.OPEN=OWS.OPEN;"
    "window.WebSocket.CLOSING=OWS.CLOSING;window.WebSocket.CLOSED=OWS.CLOSED;}"
    "try{"
    "var lo=window.location;"
    "['assign','replace'].forEach(function(m){var o=lo[m];"
    # Ad code hijacks the tab with top.location = <adurl>. Refusing to follow a
    # blocked host keeps the player on screen instead of replacing it with an
    # ad page (which, being proxied, would otherwise render as our own origin).
    "if(o)lo[m]=function(u){try{if(typeof u==='string'){"
    "if(badhost(u))return;u=wrap(u);}}catch(e){}"
    "return o.call(lo,u);};});"
    "var h=window.history;"
    "['pushState','replaceState'].forEach(function(m){var o=h[m];"
    "if(o)h[m]=function(st,t,u){try{if(typeof u==='string')u=wrap(u);}catch(e){}"
    "return o.call(h,st,t,u);};});"
    "}catch(e){}"
    "var osa=Element.prototype.setAttribute;"
    "if(osa){Element.prototype.setAttribute=function(n,v){"
    "if(/^(src|href|action|poster|data-src|data-href|data-url|data-original|xlink:href)$/i.test(String(n))"
    "&&typeof v==='string'){try{"
    "if(mediaUrl(v)&&/^(video|audio|source|track)$/i.test(this.tagName||''))v=abs(v);"
    "else v=wrap(v);}catch(e){}}"
    "return osa.call(this,n,v);};}"
    "[['HTMLScriptElement','src'],['HTMLImageElement','src'],['HTMLVideoElement','src'],['HTMLAudioElement','src'],['HTMLSourceElement','src'],['HTMLIFrameElement','src'],['HTMLTrackElement','src'],['HTMLLinkElement','href']].forEach(function(pair){"
    "var C=window[pair[0]];if(!C)return;var pr=C.prototype,d=Object.getOwnPropertyDescriptor(pr,pair[1]);"
    "if(!d||!d.set)return;"
    "try{Object.defineProperty(pr,pair[1],{configurable:true,enumerable:d.enumerable||true,"
    "get:function(){return d.get?d.get.call(this):this.getAttribute(pair[1]);},"
    "set:function(v){try{if(typeof v==='string'){"
    "v=mediaUrl(v)?abs(v):wrap(v);}}catch(e){}d.set.call(this,v);}});}catch(e){}"
    "});"
    "}catch(e){}"
    "})();"
    "</script>"
)


# ---------------------------------------------------------------------------
# Embed cloak.
#
# A page we proxy is served from OUR origin, so it is same-origin with the app
# that frames it - which means this script, injected before any of the site's
# own code, can reach the very properties a site uses to notice it is embedded.
# Games gate on those in three ways, all of them answerable here:
#
#   window.parent !== window.self / window.frameElement   -> "we are framed"
#   document.referrer                                      -> "by a stranger"
#   location.ancestorOrigins.length                        -> "by a stranger"
#
# Each is answered with what the page would see if it really were running on
# its own site: parent is the window itself, frameElement and opener are null,
# the referrer is the target's own origin (the same value the relay sends
# upstream, so the two halves agree), and ancestorOrigins is empty.
#
# What is deliberately NOT claimed: window.top. Per spec `top` is a
# non-configurable own property of the window (verified in-browser: "Cannot
# redefine property: top"), so a `top !== self` test cannot be answered in a
# frame. That is the one and only reason a game that gates on `top` still needs
# the "open in a new tab" route the player already offers for it.
#
# The whole block returns immediately when the document is NOT framed, so a
# relayed page opened top-level (new tab, pop-out) is left completely alone.
_UV_CLOAK_ON = os.environ.get("CHALKLE_UV_CLOAK", "1").strip().lower() not in ("0", "off", "false", "no")

_UV_CLOAK_JS = (
    "<script>(function(){try{"
    "if(window.self===window.top)return;"
    "var REF='';"
    "try{if(window.__UV_TARGET__)REF=new URL(window.__UV_TARGET__).origin+'/';}catch(e){}"
    "try{Object.defineProperty(window,'parent',{configurable:true,"
    "get:function(){return window;}});}catch(e){}"
    "try{Object.defineProperty(window,'frameElement',{configurable:true,"
    "get:function(){return null;}});}catch(e){}"
    "try{Object.defineProperty(window,'opener',{configurable:true,"
    "get:function(){return null;}});}catch(e){}"
    "if(REF){try{Object.defineProperty(document,'referrer',{configurable:true,"
    "get:function(){return REF;}});}catch(e){}}"
    # The instance property is locked like `top`, but Location's PROTOTYPE is
    # ours to patch - and that is where every ancestorOrigins lookup lands.
    "try{var ap=Object.getPrototypeOf(location);"
    "Object.defineProperty(ap,'ancestorOrigins',{configurable:true,"
    "get:function(){var a=[];a.length=0;return a;}});}catch(e){}"
    "try{if(window.name)window.name='';}catch(e){}"
    "}catch(e){}})();</script>"
)


def _esc_html(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# Proxy route codec. The old /uv/ route + base64url was the exact
# Ultraviolet fingerprint filters regex for. The built-in proxy now uses an
# innocuous static-looking prefix and a position-XOR hex codec: no base64
# symbols, no '=' padding, no path any known proxy rule matches.
_UV_PFX = "/res/"


def _uv_enc(s):
    import urllib.parse
    try:
        t = urllib.parse.quote(s, safe="")
        return bytes(b ^ (0x2f + i % 0x31) for i, b in enumerate(t.encode("ascii"))).hex()
    except Exception:
        return ""


def _uv_dec(s):
    import urllib.parse
    if not s:
        return None
    try:
        raw = bytes.fromhex(s)
        t = bytes(b ^ (0x2f + i % 0x31) for i, b in enumerate(raw)).decode("ascii")
        return urllib.parse.unquote(t)
    except Exception:
        return None


def _uv_decode(raw):
    try:
        return raw.decode("utf-8")
    except Exception:
        return raw.decode("latin-1", "replace")

# --- pooled upstream HTTP/1.1 client for the proxy ---
# urllib opened a brand-new connection (with a full TLS handshake) for every
# proxied asset. These helpers keep a small pool of keep-alive connections per
# upstream host so asset-heavy pages reuse one connection instead of paying a
# handshake per file. The response wrapper exposes the urllib surface the rest
# of the proxy already uses (read/close/headers/getcode).
_uv_pool_lock = threading.Lock()
_uv_pool = {}                 # "scheme|host|port" -> [idle _UVPoolConn]
_UV_POOL_IDLE_MAX = 8         # idle keep-alive conns kept per host
_UV_POOL_IDLE_TTL = 45.0      # seconds before an idle conn is discarded


# Rewritten-response cache. Speed: an SPA navigation refetches the same shell
# HTML/CSS/JS over and over, and every miss pays a full upstream round-trip
# plus the rewrite pass. Rewritten GET responses replay from memory with short
# TTLs. No cookies or auth headers are ever forwarded upstream, so responses
# are the anonymous version and safe to reuse; POSTs bypass the cache.
_UV_CACHE_TTL = {"text/html": 20.0, "text/css": 120.0,
                 "text/javascript": 120.0, "image/svg+xml": 120.0}
_UV_CACHE_MAX_BYTES = 3 * 1024 * 1024
_UV_CACHE_MAX_ENTRIES = 96
_uv_cache = {}
_uv_cache_lock = threading.Lock()


def _uv_cache_get(key):
    if not key:
        return None
    now = time.time()
    with _uv_cache_lock:
        e = _uv_cache.get(key)
        if not e:
            return None
        if now >= e[5]:
            del _uv_cache[key]
            return None
        # Copy `extra` so a later handler mutating its own dict can't touch
        # what a cached entry hands out.
        return (e[0], e[1], e[2], dict(e[3]), e[4], e[5])


def _uv_cache_put(key, code, ctype, raw, extra, cache_ctl):
    if not key:
        return
    ttl = _UV_CACHE_TTL.get((ctype or "").split(";")[0].strip().lower())
    if not ttl or not raw or len(raw) > _UV_CACHE_MAX_BYTES:
        return
    now = time.time()
    with _uv_cache_lock:
        if len(_uv_cache) >= _UV_CACHE_MAX_ENTRIES:
            for k in list(_uv_cache)[:16]:
                del _uv_cache[k]
        # e[4] is the Cache-Control STRING to replay, e[5] the expiry used
        # internally. Storing only the expiry (and handing it back as if it
        # were the header) is what produced "Cache-Control: 1790119576.34" on
        # every cache hit: a float is not a valid directive list, so browsers
        # fell back to heuristic caching on the URL that carries the most
        # JavaScript.
        _uv_cache[key] = (code, ctype, raw, dict(extra or {}),
                          str(cache_ctl or "no-store, max-age=0"), now + ttl)


class _UVPoolConn:
    __slots__ = ("conn", "key", "idle_at")

    def __init__(self, conn, key):
        self.conn = conn
        self.key = key
        self.idle_at = time.time()


def _uv_pool_key(scheme, host, port, chain=None):
    k = scheme + "|" + host + "|" + str(port)
    if chain:
        # A pooled connection carries the upstream it was opened with, so
        # switching the selected backend must never reuse a stale tunnel.
        k += "|up:" + chain[0] + ":" + str(chain[1])
    return k


def _uv_pool_take(key):
    with _uv_pool_lock:
        arr = _uv_pool.get(key)
        now = time.time()
        while arr:
            c = arr.pop()
            if now - c.idle_at > _UV_POOL_IDLE_TTL:
                try:
                    c.conn.close()
                except Exception:
                    pass
                continue
            if not arr:
                _uv_pool.pop(key, None)
            return c
        if arr is not None and not arr:
            _uv_pool.pop(key, None)
    return None


def _uv_pool_give(c):
    if c is None:
        return
    with _uv_pool_lock:
        arr = _uv_pool.setdefault(c.key, [])
        if len(arr) >= _UV_POOL_IDLE_MAX:
            oldest = arr.pop(0)
            try:
                oldest.conn.close()
            except Exception:
                pass
        c.idle_at = time.time()
        arr.append(c)


def _uv_pool_discard(c):
    if c is None:
        return
    try:
        c.conn.close()
    except Exception:
        pass


def _uv_pool_drop(key):
    """Close and forget every idle pooled connection for one host. Called
    after a request died on a pooled conn - its siblings are likely corpses
    too (CDNs close keep-alive sockets aggressively)."""
    with _uv_pool_lock:
        arr = _uv_pool.pop(key, None)
    if not arr:
        return
    for c in arr:
        try:
            c.conn.close()
        except Exception:
            pass


class _UVResp:
    """urllib-compatible readable response backed by a pooled connection.
    Reading to EOF marks the response complete so close() can return the
    connection to the pool instead of throwing it away."""

    __slots__ = ("pooled", "resp", "done", "no_reuse", "headers")

    def __init__(self, pooled, resp):
        self.pooled = pooled
        self.resp = resp
        self.done = False
        try:
            self.no_reuse = resp.will_close
        except Exception:
            self.no_reuse = False
        self.headers = resp.headers

    def read(self, n=-1):
        try:
            data = self.resp.read(n)
        except Exception:
            self.done = True
            raise
        if data == b"" or (n > 0 and len(data) < n):
            self.done = True
        return data

    def close(self):
        if self.done and not self.no_reuse:
            _uv_pool_give(self.pooled)
        else:
            _uv_pool_discard(self.pooled)
        self.done = True

    def getcode(self):
        return self.resp.status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


# --- upstream selection ---------------------------------------------------
# Local proxy-client chaining is intentionally disabled. The relay uses its
# direct outbound connection; hosted web backends remain a browser concern.
import http.client as _http_client

_PROXY_CHAINS = {}
# Panels are admin UIs, not transports: "live" only means the port answers.
_PROXY_PANELS = {
    "3xui":    [2053, 54321, 2096],
    "hiddify": [2333, 2334],
    "npm":     [81, 8181],
}
_CHAIN_TTL = 15.0          # seconds a detection result is trusted
_CHAIN_TIMEOUT = 0.35      # per-port handshake budget
_chain_lock = threading.Lock()
_chain_cache = {}          # backend id -> (checked_at, (kind, port, ms) or None)
_chain_pending = set()
_chain_active = "relay"    # what the selector last picked (sticky, per process)


def _chain_probe(port, kind, timeout=_CHAIN_TIMEOUT):
    """Handshake against a loopback listener. SOCKS5: greeting (optionally a
    CONNECT). HTTP: a real CONNECT. Returns ms on success, None when nothing
    usable answers - a random service on that port is never chained."""
    t0 = time.time()
    try:
        sock = socket.create_connection(("127.0.0.1", port), timeout)
    except Exception:
        return None
    try:
        sock.settimeout(timeout)
        if kind == "socks5":
            sock.sendall(b"\x05\x01\x00")
            if sock.recv(2) != b"\x05\x00":
                return None
            # Greeting answered without auth: this IS a SOCKS5 listener (our
            # client). A refused CONNECT (school policy, blocked host) must
            # not hide it, so the probe stops here when the connect is denied.
            host = b"example.com"
            try:
                sock.sendall(b"\x05\x01\x00\x03" + bytes([len(host)]) + host + (80).to_bytes(2, "big"))
                rep = sock.recv(4)
                if len(rep) >= 2 and rep[1] not in (0,):
                    return int((time.time() - t0) * 1000) if rep[1] == 2 else None
            except Exception:
                pass
        else:
            sock.sendall(b"CONNECT example.com:80 HTTP/1.1\r\nHost: example.com:80\r\n\r\n")
            head = b""
            while b"\r\n\r\n" not in head and len(head) < 1024:
                chunk = sock.recv(256)
                if not chunk:
                    break
                head += chunk
            if not head.startswith(b"HTTP/") or b" 200" not in head.split(b"\r\n", 1)[0]:
                return None
        return int((time.time() - t0) * 1000)
    except Exception:
        return None
    finally:
        try:
            sock.close()
        except Exception:
            pass


def _port_open(port, timeout=0.25):
    try:
        sock = socket.create_connection(("127.0.0.1", port), timeout)
    except Exception:
        return False
    try:
        sock.close()
    except Exception:
        pass
    return True


def _parallel(fn, items, timeout=2.0):
    """Run fn over items on threads and return results in order. Detection
    touches ~25 loopback ports; serially that is ~10s of refused/timeout
    waiting, which the selector should never show. Threads make it ~0.4s and
    the per-port timeout still bounds the whole batch."""
    results = {}

    def work(i, item):
        try:
            results[i] = fn(item)
        except Exception:
            results[i] = None

    threads = [threading.Thread(target=work, args=(i, it), daemon=True)
               for i, it in enumerate(items)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout)
    return [results.get(i) for i in range(len(items))]


def _chain_probe_list(backend_id):
    """First listening candidate for this backend, in listed preference
    order (each client's most common port first)."""
    candidates = _PROXY_CHAINS.get(backend_id, [])
    if not candidates:
        return None
    hits = _parallel(lambda c: _chain_probe(c[0], c[1]), candidates,
                     timeout=_CHAIN_TIMEOUT + 0.5)
    for (port, kind), ms in zip(candidates, hits):
        if ms is not None:
            return (kind, port, ms)
    return None


def _chain_refresh_async(backend_id):
    """Detect in the background so a proxied page never waits on a handshake."""
    with _chain_lock:
        if backend_id in _chain_pending:
            return
        _chain_pending.add(backend_id)

    def work():
        try:
            found = _chain_probe_list(backend_id)
            with _chain_lock:
                _chain_cache[backend_id] = (time.time(), found)
        except Exception:
            pass
        finally:
            with _chain_lock:
                _chain_pending.discard(backend_id)

    threading.Thread(target=work, daemon=True).start()


def _chain_lookup(backend_id, blocking=True):
    """(kind, port, ms) for a live local client, or None. Non-blocking callers
    get the last known value and trigger a background refresh."""
    if not backend_id or backend_id not in _PROXY_CHAINS:
        return None
    now = time.time()
    with _chain_lock:
        hit = _chain_cache.get(backend_id)
    if hit and (now - hit[0]) < _CHAIN_TTL:
        return hit[1]
    if not blocking:
        _chain_refresh_async(backend_id)
        return hit[1] if hit else None
    found = _chain_probe_list(backend_id)
    with _chain_lock:
        _chain_cache[backend_id] = (now, found)
    return found


def _chain_set(backend_id):
    """Keep legacy API callers on a built-in backend.

    Older browser tabs may still POST a removed local-client id. Treat those
    requests as the relay selection instead of probing or chaining through a
    loopback process.
    """
    global _chain_active
    wanted = str(backend_id or "relay")
    if wanted not in ("relay", "direct"):
        wanted = "relay"
    with _chain_lock:
        _chain_active = wanted
        _chain_cache.clear()
    return _chain_active


def _chain_effective():
    """The live upstream for the selected backend, or None to fetch directly.
    Web proxies and panels are not transports, so they never chain here."""
    with _chain_lock:
        active = _chain_active
    if active in ("", None, "relay", "direct"):
        return None
    if active not in _PROXY_CHAINS:
        return None
    return _chain_lookup(active, blocking=False)


def _socks_connect(proxy_kind, proxy_port, host, port, timeout):
    """Raw socket to host:port through the local client (no TLS - the caller
    wraps HTTPS itself so cert verification stays against the real host)."""
    last = None
    for _attempt in (1, 2):
        sock = None
        try:
            sock = socket.create_connection(("127.0.0.1", proxy_port), timeout)
            sock.settimeout(timeout)
            if proxy_kind == "socks5":
                sock.sendall(b"\x05\x01\x00")
                if sock.recv(2) != b"\x05\x00":
                    raise OSError("socks5 greeting refused")
                try:
                    addr = b"\x01" + socket.inet_aton(host)
                except Exception:
                    hb = host.encode("idna")
                    addr = b"\x03" + bytes([len(hb)]) + hb
                sock.sendall(b"\x05\x01\x00" + addr + int(port).to_bytes(2, "big"))
                rep = sock.recv(4)
                if len(rep) < 2 or rep[1] != 0:
                    raise OSError("socks5 connect failed (%s)" % (rep[1] if len(rep) > 1 else "?"))
                # Consume the bound-address tail so the next read is payload.
                if len(rep) > 3:
                    typ = rep[3]
                    need = {1: 4, 4: 16}.get(typ)
                    if need is None:  # domain name
                        if len(rep) < 5:
                            rep += sock.recv(5 - len(rep))
                        need = rep[4]
                    tail = 2 + need  # port + address
                    got = max(0, len(rep) - 4)
                    while got < tail:
                        chunk = sock.recv(min(64, tail - got))
                        if not chunk:
                            break
                        got += len(chunk)
            else:
                target = host + ":" + str(port)
                sock.sendall(("CONNECT " + target + " HTTP/1.1\r\nHost: " + target +
                              "\r\nProxy-Connection: keep-alive\r\n\r\n").encode())
                head = b""
                while b"\r\n\r\n" not in head and len(head) < 2048:
                    chunk = sock.recv(512)
                    if not chunk:
                        break
                    head += chunk
                if not head.startswith(b"HTTP/") or b" 200" not in head.split(b"\r\n", 1)[0]:
                    raise OSError("http proxy refused CONNECT")
            return sock
        except Exception as e:
            last = e
            if sock is not None:
                try:
                    sock.close()
                except Exception:
                    pass
    raise OSError(str(last or "proxy connect failed"))


class _ChainHTTPConnection(_http_client.HTTPConnection):
    """Plain-HTTP connection whose transport is the selected local proxy."""

    def __init__(self, host, port, timeout, chain):
        _http_client.HTTPConnection.__init__(self, host, port, timeout=timeout)
        self._chain = chain

    def connect(self):
        self.sock = _socks_connect(self._chain[0], self._chain[1], self.host, self.port, self.timeout)


class _ChainHTTPSConnection(_http_client.HTTPSConnection):
    """HTTPS connection tunnelled through the local proxy. TLS is still
    negotiated end-to-end with the real host (server_hostname), so
    certificate checks are unchanged by the extra hop."""

    def __init__(self, host, port, timeout, chain):
        _http_client.HTTPSConnection.__init__(self, host, port, timeout=timeout)
        self._chain = chain

    def connect(self):
        raw = _socks_connect(self._chain[0], self._chain[1], self.host, self.port, self.timeout)
        ctx = self._context or ssl.create_default_context()
        self.sock = ctx.wrap_socket(raw, server_hostname=self.host)


def _proxy_backends_payload():
    """Live table the selector renders: every chain backend with its real
    detection result, plus the panel ports and the active pick."""
    chain_ids = list(_PROXY_CHAINS.keys())
    probe_timeout = _CHAIN_TIMEOUT + 0.6
    found_all = _parallel(lambda b: _chain_lookup(b, blocking=True), chain_ids,
                          timeout=probe_timeout)
    backends = {}
    for bid, found in zip(chain_ids, found_all):
        if found:
            backends[bid] = {"live": True, "transport": found[0], "port": found[1], "ms": found[2]}
        else:
            backends[bid] = {"live": False}
    panel_ids = list(_PROXY_PANELS.keys())
    panel_hits = _parallel(
        lambda b: next((prt for prt in _PROXY_PANELS[b] if _port_open(prt)), None),
        panel_ids, timeout=0.9)
    panels = {}
    for bid, hit in zip(panel_ids, panel_hits):
        panels[bid] = {"live": hit is not None,
                       "url": ("http://127.0.0.1:%d/" % hit) if hit else ""}
    with _chain_lock:
        active = _chain_active
    chain = _chain_lookup(active, blocking=False) if active in _PROXY_CHAINS else None
    return {"ok": True, "active": active, "backends": backends, "panels": panels,
            "chained": chain is not None,
            "via": ("%s://127.0.0.1:%d" % (chain[0], chain[1])) if chain else ""}



def _uv_cacheable(ctype, target):
    """Seconds a proxied response can be cached by the browser. Static assets
    are deterministic per /res URL; HTML, JSON and anything dynamic stay
    no-store. Rewritten text (css/js/svg) gets a short cache."""
    low = (ctype or "").lower()
    if low.startswith(("image/", "font/", "audio/", "video/")) or low == "application/wasm":
        return 86400
    path = (target or "").split("?", 1)[0].lower()
    if low == "application/octet-stream" and "." in path:
        ext = path.rsplit(".", 1)[-1]
        if ext in ("data", "wasm", "unx", "bin", "pak", "unityweb", "mp3", "ogg", "wav", "mp4", "webm", "png", "jpg", "jpeg", "webp", "gif", "svg", "woff", "woff2", "ttf", "eot"):
            return 86400
    return 0


# ---------------------------------------------------------------------------
# Upstream context: what the target is told about who asked for it.
#
# Three things live here, all of them answers to the same question - "why does
# an embed load for one visitor and get blocked for another?"
#
#   1. the Referer (see _uv_ref_for)
#   2. the cookies the target set for itself (_UV_COOKIES)
#   3. the embed cloak injected into every relayed document (_uv_cloak_js)
#
# The relay is the only place these can be done: it is the component that
# makes the request to the game host, and it is the component that decides what
# markup the framed page receives.

# host -> {cookie name: value}. Targets hand out a session on the first hit and
# then serve the real page only to a client that returns it.
_UV_COOKIES = {}
_UV_COOKIE_LOCK = threading.Lock()

# Per-request scratch (one Handler thread per connection): the browser's Referer
# for the /res/ request currently being served.
_UV_HINT = threading.local()


def _uv_host_of(url):
    try:
        return (urllib.parse.urlsplit(str(url or "")).hostname or "").lower()
    except Exception:
        return ""


def _uv_note_referer(value):
    """Remember the browser's Referer for the /res/ request being served.

    A subresource request carries the proxied parent page as its Referer, which
    is one of OUR /res/<hex> routes. Decoding it recovers the real page URL -
    exactly the value the target host expects to see for its own assets, since
    hotlink protection compares the referring PAGE, never the host root. The
    relay used to claim "https://host/" for every request, which satisfies
    presence checks but reads as a bare fetch to any host that actually looks.
    """
    try:
        _UV_HINT.referer = ""
    except Exception:
        return
    ref = str(value or "").strip()
    if not ref or _UV_PFX not in ref:
        return
    try:
        path = urllib.parse.urlsplit(ref).path or ""
    except Exception:
        return
    at = path.find(_UV_PFX)
    if at == -1:
        return
    seg = path[at + len(_UV_PFX):].split("/", 1)[0]
    decoded = _uv_dec(seg)
    if decoded and re.match(r"^https?://", decoded, re.I):
        try:
            _UV_HINT.referer = decoded
        except Exception:
            pass


def _uv_cookie_header(host):
    """Cookie header for one target host, or "" when we have nothing for it."""
    if not host:
        return ""
    try:
        with _UV_COOKIE_LOCK:
            jar = _UV_COOKIES.get(host)
            if not jar:
                return ""
            return "; ".join("%s=%s" % (k, jar[k]) for k in sorted(jar))
    except Exception:
        return ""


def _uv_cookie_store(host, headers):
    """Keep the cookies a target set for itself.

    Plenty of game hosts hand out a session on the first hit and then serve the
    real page only to a client that returns it: Cloudflare's clearance cookie,
    PHP/ASP sessions, and the many "verifying your browser" gates that issue a
    token and check it on the next request. The relay used to throw those away,
    so the follow-up request looked like a brand-new visitor and the host
    answered with its gate page again - which is what a player sees as an embed
    that never starts.

    The jar is per host and process-wide, never per visitor: it holds only the
    anonymous session the target itself handed out, so nothing here depends on
    who is asking, and the rewritten-page cache (which is documented as the
    anonymous version) stays truthful.
    """
    if not host or headers is None:
        return
    import http.cookies
    try:
        raw = headers.get_all("Set-Cookie") or []
    except Exception:
        return
    if not raw:
        return
    try:
        with _UV_COOKIE_LOCK:
            jar = _UV_COOKIES.setdefault(host, {})
            for header in raw:
                parsed = http.cookies.SimpleCookie()
                try:
                    parsed.load(str(header))
                except Exception:
                    continue
                for name, morsel in parsed.items():
                    kill = False
                    try:
                        ma = morsel.get("max-age")
                        if ma not in (None, "") and int(ma) <= 0:
                            kill = True
                    except Exception:
                        pass
                    if kill:
                        jar.pop(name, None)
                    else:
                        jar[name] = morsel.value
            # A host that has answered nothing but deletes cannot keep a jar
            # entry alive forever.
            if not jar:
                _UV_COOKIES.pop(host, None)
    except Exception:
        return


def _uv_ref_for(url):
    """Referer to send upstream for a relayed request.

    Stream hosts behind the embed providers 404 (or 403) any player document
    that arrives with NO Referer at all - vidsrc's chain answers 404 to a bare
    fetch and 200 the moment a Referer exists - which is what surfaced as the
    relay's own "Proxy couldn't load that page. HTTP 404" inside the player.

    The relay cannot forward the browser's own Referer: the page is served
    from 127.0.0.1:4173, so that value names this server and is rejected just
    like no Referer at all. Instead every relayed fetch claims the TARGET's own
    origin root. That is the one value a browser-hosted copy of the page would
    plausibly send, it satisfies the plain "Referer must be present" checks,
    and being the target's own site it can never trip hotlink protection the
    way a foreign parent domain would.

    One refinement on top of that baseline: when the request being served came
    from a page we already proxied, _uv_note_referer() has the REAL parent page
    URL, and that is a strictly better answer whenever it names the same host
    (a hotlink check compares the referring page on that very host). Hosts that
    do not match - asset CDNs appear on pages of their own - keep the
    self-origin fallback, so a foreign parent is never leaked."""
    try:
        parts = urllib.parse.urlsplit(url)
    except Exception:
        return ""
    if not parts.scheme or not parts.netloc:
        return ""
    host = (parts.hostname or "").lower()
    try:
        hint = getattr(_UV_HINT, "referer", "") or ""
    except Exception:
        hint = ""
    if hint and host and _uv_host_of(hint) == host:
        return hint
    return "%s://%s/" % (parts.scheme, parts.netloc)


def _uv_open(url, post_body=None):
    """Fetch a proxied target with pooled keep-alive connections. Returns the
    urllib-style response object (read/close/headers/getcode) after following
    redirects, or raises urllib.error.HTTPError / URLError."""
    import http.client
    import urllib.error
    import urllib.request
    if _uv_ad_host(url):
        # Belt and braces: _uv_route answers with a stub before it gets here,
        # so this only fires for a caller that reached for the network
        # directly. Blocked is blocked. It runs BEFORE the pool lookup so a
        # blocked host never occupies a pooled connection either.
        raise urllib.error.URLError("blocked ad host")
    data = None
    if post_body is not None:
        data = post_body.encode() if isinstance(post_body, str) else post_body
    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
    }
    referer = _uv_ref_for(url)
    if referer:
        headers["Referer"] = referer
    # Resolve the upstream once per call (not per redirect): switching
    # backends in the Proxies tab applies to the very next request.
    chain = _chain_effective()
    cur = url
    for _redirect in range(6):
        parts = urllib.parse.urlsplit(cur)
        scheme = (parts.scheme or "https").lower()
        host = parts.hostname or ""
        if not host:
            raise urllib.error.URLError("no host in " + (cur or ""))
        port = parts.port or (443 if scheme == "https" else 80)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        key = _uv_pool_key(scheme, host, port, chain)
        pooled = None
        resp = None
        err = None
        for _attempt in (1, 2):
            if _attempt == 2:
                # First try died on a pooled connection: Google's CDN and
                # friends close keep-alive sockets aggressively, so ANY other
                # idle conn for this host is likely dead too. Emptying the
                # host's pool here is what turns a burst of 502s (one per
                # parallel asset request, every one reusing a corpse) into a
                # single silent retry on a fresh connection.
                _uv_pool_drop(key)
            pooled = _uv_pool_take(key)
            try:
                if pooled is None:
                    if scheme == "https":
                        conn = (_ChainHTTPSConnection(host, port, FETCH_TIMEOUT, chain) if chain
                                else http.client.HTTPSConnection(host, port, timeout=FETCH_TIMEOUT))
                    else:
                        conn = (_ChainHTTPConnection(host, port, FETCH_TIMEOUT, chain) if chain
                                else http.client.HTTPConnection(host, port, timeout=FETCH_TIMEOUT))
                    pooled = _UVPoolConn(conn, key)
                req_headers = dict(headers)
                if data is not None:
                    req_headers["Content-Type"] = "application/x-www-form-urlencoded"
                cookie = _uv_cookie_header(host)
                if cookie:
                    # The session the target handed out on an earlier request,
                    # returned to it like any real client would (see
                    # _uv_cookie_store for why that matters).
                    req_headers["Cookie"] = cookie
                pooled.conn.request(("POST" if data is not None else "GET"), path,
                                    body=data, headers=req_headers)
                resp = pooled.conn.getresponse()
                # Redirects set cookies too (the most common shape: / -> a
                # session cookie -> the real page), so this runs before the
                # status is inspected, not after it.
                _uv_cookie_store(host, resp.headers)
                break
            except Exception as e:  # stale pooled conn or connect failure -> retry once
                _uv_pool_discard(pooled)
                pooled = None
                resp = None
                err = e
        if resp is None:
            raise urllib.error.URLError(str(err or "connect failed"))
        status = resp.status
        if status in (301, 302, 303, 307, 308):
            loc = resp.getheader("Location")
            try:
                resp.read()
            except Exception:
                pass
            _uv_pool_discard(pooled)
            if not loc:
                raise urllib.error.HTTPError(cur, status, "redirect without location", resp.headers, None)
            data = None  # browsers GET after a redirect
            cur = urllib.parse.urljoin(cur, loc)
            continue
        if status >= 400:
            _uv_pool_discard(pooled)
            raise urllib.error.HTTPError(cur, status, "HTTP %s" % status, resp.headers, None)
        return _UVResp(pooled, resp)
    raise urllib.error.URLError("too many redirects")

def _uv_fetch(url, post_body=None):
    """Fetch a proxied target (HTML/CSS only - binaries use _uv_stream_remote).
    Returns (raw_bytes_or_None, mime, code, err)."""
    try:
        resp = _uv_open(url, post_body)
        with resp:
            raw = resp.read(40 * 1024 * 1024 + 1)
            if len(raw) > 40 * 1024 * 1024:
                return None, "", 502, "page too large"
            ctype = (resp.headers.get("Content-Type", "").split(";")[0].strip().lower())
            return raw, ctype, resp.getcode(), None
    except urllib.error.HTTPError as e:
        return None, "", e.code, None
    except Exception as e:
        return None, "", 0, type(e).__name__


def _uv_wrap_url(value, base_url):
    """Rewrite one URL to an absolute /res/ route. Relative values resolve
    against base_url first; non-URL values pass through untouched."""
    v = str(value or "").strip()
    # file:/about: pass through unwrapped: wrapping them would make the relay
    # try to fetch a local file server-side, and the browser blocks file:
    # references from remote pages with a security error either way.
    if not v or v.startswith(("#", "data:", "blob:", "javascript:", "file:", "about:", "mailto:", "tel:")):
        return value
    # Attribute values arrive HTML-escaped: href="...?a=1&amp;b=2" carries the
    # literal text &amp;. Encoding it verbatim makes the upstream query string
    # contain "&amp;" (Wikipedia's load.php then serves JS instead of CSS and
    # nosniff blocks it - "no CSS on any site"). Decode the common escapes
    # before encoding the route. Only http(s)/relative values reach here, so
    # data:/blob: URLs keep their bytes untouched.
    if "&" in v:
        # Full entity decode, not just &amp;: Twitch ships query strings like
        # "sdkName&#x3D;js-sdk-client&amp;sdkVersion&#x3D;3.1.2" inside normal
        # attributes. Decoding only &amp; left the numeric refs in the encoded
        # route, the upstream got a corrupt query string, answered with an HTML
        # error page, and the <script> expecting JS hit a MIME mismatch.
        # html.unescape follows the attribute rules ("&copy" without a
        # semicolon stays untouched), so legitimate URLs pass through intact.
        import html as _html
        v = _html.unescape(v)
    if v.startswith("//"):
        v = "https:" + v
    if not re.match(r"^https?://", v, re.I):
        v = urljoin(base_url, v)
    return _UV_PFX + _uv_enc(v)


# ES module import specifiers: import "./x.js" / import("./x.js") / export * from
# "./x.js" / dynamic import('./x.js'). Only relative (./ ../) or root-absolute
# (/) specifiers are rewritten; bare specifiers ("react") and full URLs are
# left alone (full URLs are handled by the injected fetch/element patch).
_UV_JS_IMPORT_RE = re.compile(
    r"(\b(?:import|export)\s*(?:[\w$*{},\s]*?\s*from\s*|\(\s*)?['\"])"
    r"((?:\.\.?/|/)[^'\"\n]+)"
    r"(['\"])"
)


def _uv_rewrite_js(js, base_url):
    """Rewrite module import specifiers inside streamed JS to absolute /res/
    routes. Without this, `import"./D7UGAqZr.js"` inside a proxied module
    resolves against /res/<name>.js and 404s (the encoded target is lost)."""
    def rep(m):
        pre, spec, quote = m.group(1), m.group(2), m.group(3)
        # Skip already-rewritten routes
        if spec.startswith(_UV_PFX):
            return m.group(0)
        return pre + _uv_wrap_url(spec, base_url) + quote
    return _UV_JS_IMPORT_RE.sub(rep, str(js or ""))


# atob("<base64>") literals inside inline scripts. Wrapper pages (the gnmath /
# arctic / cloudmoon SVG mirrors) decode an entire HTML document out of a
# base64 literal and hand it to an iframe (srcdoc / innerHTML). The URLs
# inside that decoded document never pass through any attribute or fetch
# rewrite, so the game then loads its real client straight off the raw CDN
# and dies on filtered networks. Decode the literal server-side, rewrite the
# embedded document like any other page, and re-encode it - the browser
# never sees a raw CDN URL.
_UV_ATOB_RE = re.compile(r"atob\(\s*(['\"])([A-Za-z0-9+/=_-]{48,})['\"]\s*\)")


def _uv_rewrite_atob_html(js, base_url, depth=0):
    def rep(m):
        quote, raw = m.group(1), m.group(2)
        decoded = _uv_b64url_decode(raw)
        if not decoded:
            return m.group(0)
        head = decoded.lstrip()[:400].lower()
        if not any(t in head for t in ("<!doctype", "<html", "<head", "<meta", "<body", "<iframe", "<script")):
            return m.group(0)  # not HTML - binary / JSON payload, leave alone
        try:
            rewritten = _uv_rewrite_html(decoded, base_url, _depth=depth + 1)
            # The decoded shell usually fetches the real game client with an
            # ABSOLUTE url inside script text - attribute rewriting can't
            # touch that. Injecting the runtime patch wraps fetch/XHR/etc. so
            # those calls reroute through the proxy at run time.
            rewritten = _uv_inject_patch(rewritten, base_url)
        except Exception:
            return m.group(0)
        # atob() speaks the standard base64 alphabet - re-encode the same way
        # (padding kept; atob always accepts it).
        return ("atob(" + quote +
                base64.b64encode(rewritten.encode("utf-8")).decode("ascii") +
                quote + ")")
    return _UV_ATOB_RE.sub(rep, str(js or ""))


def _uv_rewrite_srcset(s, base_url):
    out = []
    for part in str(s or "").split(","):
        part = part.strip()
        if not part:
            continue
        toks = part.split()
        if toks:
            toks[0] = _uv_wrap_url(toks[0], base_url)
        out.append(" ".join(toks))
    return ", ".join(out)


def _uv_rewrite_css(css, base_url):
    def rep(m):
        u = m.group("u").strip()
        if u.startswith(("data:", "#", "blob:")):
            return m.group(0)
        return "url(" + _uv_wrap_url(u, base_url) + ")"
    return _UV_CSS_URL_RE.sub(rep, str(css or ""))


def _uv_rewrite_attrs(chunk, base_url):
    """Rewrite URL-bearing attributes inside a tag's attribute chunk."""
    def rep(m):
        name = m.group(1).lower()
        val = m.group(2)
        # Subresource integrity can never match after rewriting - drop it
        # instead of letting the browser block the asset (sha512 of a
        # rewritten/streamed body will never equal the upstream hash).
        if name in ("integrity", "nonce"):
            return ""
        quote = val[:1] if val[:1] in ("'", '"') else ""
        inner = val[1:-1] if quote else val
        if name in ("srcset", "data-srcset"):
            inner = _uv_rewrite_srcset(inner, base_url)
        elif name in _UV_URL_ATTRS:
            inner = _uv_wrap_url(inner, base_url)
        elif name == "style":
            inner = _uv_rewrite_css(inner, base_url)
        return " %s=%s%s%s" % (m.group(1), quote, inner, quote)
    return _UV_ATTR_RE.sub(rep, chunk)


def _uv_rewrite_meta(tag_text, base_url):
    ev = re.search(r"\bhttp-equiv\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", tag_text, re.I)
    prop = re.search(r"\bproperty\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", tag_text, re.I)
    evv = ev.group(1).strip("\"'") if ev else ""
    prv = prop.group(1).strip("\"'") if prop else ""
    if "refresh" in evv.lower():
        def rep(m):
            u = m.group(2).strip("\"'")
            return m.group(1) + _uv_wrap_url(u, base_url)
        return re.sub(r"(url\s*=\s*)(\"[^\"]*\"|'[^']*'|[^\s;]*)", rep, tag_text, flags=re.I)
    if "image" in prv.lower() or "url" in prv.lower():
        def rep(m):
            val = m.group(1)
            quote = val[:1] if val[:1] in ("'", '"') else ""
            inner = val[1:-1] if quote else val
            return "content=" + quote + _uv_wrap_url(inner, base_url) + quote
        return re.sub(r"\bcontent\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", rep, tag_text, flags=re.I)
    return tag_text


def _uv_process_tag(tag_text, base_url):
    m = _UV_TAG_NAME_RE.match(tag_text)
    if not m:
        return tag_text
    name = m.group(1).lower()
    if name == "meta":
        ev = re.search(r"\bhttp-equiv\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", tag_text, re.I)
        if ev and "content-security-policy" in ev.group(1).strip("\"'").lower():
            return ""
        return _uv_rewrite_meta(tag_text, base_url)
    return _uv_rewrite_attrs(tag_text, base_url)


def _uv_find_tag_end(html, lt):
    q = None
    i = lt + 1
    n = len(html)
    while i < n:
        c = html[i]
        if q:
            if c == q:
                q = None
        elif c in "\"'":
            q = c
        elif c == ">":
            return i
        i += 1
    return -1


def _uv_rewrite_svg(svg, target):
    """Rewrite an SVG wrapper document. Runs the same atob-decode rewrite over
    inline <script> bodies (the wrapper shell lives in a base64 literal) and
    proxies src/href attributes; raw SVG shape data is untouched."""
    base_dir = urljoin(target, ".")
    out = []
    i = 0
    n = len(svg)
    while i < n:
        lt = svg.find("<", i)
        if lt == -1:
            out.append(svg[i:])
            break
        out.append(svg[i:lt])
        m = _UV_TAG_NAME_RE.match(svg, lt)
        if not m:
            out.append("<")
            i = lt + 1
            continue
        name = m.group(1).lower()
        end = _uv_find_tag_end(svg, lt)
        if end == -1:
            out.append(svg[lt:])
            break
        tag_text = svg[lt:end + 1]
        if name == "script":
            close = re.search(r"</\s*script\s*>", svg[end + 1:], re.I)
            if close:
                out.append(_uv_rewrite_attrs(tag_text, base_dir))
                body = svg[end + 1:end + 1 + close.start()]
                body = _uv_rewrite_js(body, base_dir)
                if "atob(" in body:
                    body = _uv_rewrite_atob_html(body, base_dir)
                out.append(body)
                out.append(svg[end + 1 + close.start():end + 1 + close.end()])
                i = end + 1 + close.end()
                continue
        out.append(_uv_process_tag(tag_text, base_dir))
        i = end + 1
    return "".join(out)


def _uv_rewrite_html(html, target, _depth=0):
    """Rewrite a full HTML document: every URL attribute becomes an absolute
    /res/ route, <style>/inline CSS url()s get rewritten, CSP meta tags and
    <base> tags are replaced with a proxied <base> (so any relative URL a
    script assigns at runtime still lands on the proxy), and raw-text
    elements are left untouched."""
    base_dir = urljoin(target, ".")
    base_href = _UV_PFX + _uv_enc(base_dir) + "/"
    out = []
    i = 0
    n = len(html)
    while i < n:
        lt = html.find("<", i)
        if lt == -1:
            out.append(html[i:])
            break
        out.append(html[i:lt])
        if html.startswith("<!--", lt):
            end = html.find("-->", lt + 4)
            if end == -1:
                out.append(html[lt:])
                break
            out.append(html[lt:end + 3])
            i = end + 3
            continue
        if html[lt + 1:lt + 2] in ("!", "?"):
            end = _uv_find_tag_end(html, lt)
            if end == -1:
                out.append(html[lt:])
                break
            out.append(html[lt:end + 1])
            i = end + 1
            continue
        m = _UV_TAG_NAME_RE.match(html, lt)
        if not m:
            out.append("<")
            i = lt + 1
            continue
        name = m.group(1).lower()
        end = _uv_find_tag_end(html, lt)
        if end == -1:
            out.append(html[lt:])
            break
        tag_text = html[lt:end + 1]
        if name == "link":
            # Resource hints (preload/prefetch/preconnect) are noise through
            # the proxy: the browser issues them against our origin in a form
            # the proxy answers differently than the real CDN would, Firefox
            # logs "preloaded but not used" warnings, and they never actually
            # warm anything. Stylesheet/icon links still pass through.
            if re.search(r"rel\s*=\s*[\"']?(?:preload|prefetch|preconnect|dns-prefetch|modulepreload)\b", tag_text, re.I):
                i = end + 1
                continue
        if name in _UV_RAW_TAGS:
            # Rewrite the opening tag (a <script src=...> must be proxied) but
            # keep the raw text content untouched - it's JS/HTML, not markup.
            # Exception: inline <script> bodies get the module-import rewrite,
            # because a root-absolute specifier like import("/_app/x.js")
            # resolves against our origin, not the proxied target, and the
            # fetch/XHR patches can't catch import() (it's syntax, not a
            # method we can wrap).
            close = re.search(r"</\s*" + name + r"\s*>", html[end + 1:], re.I)
            opening = _uv_rewrite_attrs(tag_text, base_dir)
            if close:
                out.append(opening)
                body = html[end + 1:end + 1 + close.start()]
                if name == "script" and len(body) < 2 * 1024 * 1024:
                    body = _uv_rewrite_js(body, base_dir)
                    if _depth < 2 and "atob(" in body:
                        body = _uv_rewrite_atob_html(body, base_dir, _depth)
                out.append(body)
                out.append(html[end + 1 + close.start():end + 1 + close.end()])
                i = end + 1 + close.end()
            else:
                out.append(opening)
                i = end + 1
            continue
        if name == "style":
            close = re.search(r"</\s*style\s*>", html[end + 1:], re.I)
            if close:
                out.append(_uv_rewrite_attrs(tag_text, base_url=base_dir))
                out.append(_uv_rewrite_css(html[end + 1:end + 1 + close.start()], base_dir))
                out.append(html[end + 1 + close.start():end + 1 + close.end()])
                i = end + 1 + close.end()
            else:
                out.append(_uv_rewrite_attrs(tag_text, base_url=base_dir))
                i = end + 1
            continue
        if name == "base":
            out.append('<base href="' + base_href + '">')
            i = end + 1
            continue
        out.append(_uv_process_tag(tag_text, base_dir))
        i = end + 1
    return "".join(out)


def _uv_inject_patch(html, target):
    # Proxied <base>: any relative URL a script assigns at runtime (img.src =
    # "logo.png", video.src, link.href...) resolves against this instead of the
    # raw /res/ route, so it still lands on the proxy. The rewriter already
    # replaced a site <base>; only inject when the document had none.
    base = ""
    if not re.search(r"<base\b[^>]*>", html, re.I):
        base_dir = urljoin(target, ".")
        base = '<base href="' + _UV_PFX + _uv_enc(base_dir) + '/">'
    inject = (base + "<script>window.__UV_TARGET__=" + json.dumps(target) + ";</script>"
              + (_UV_CLOAK_JS if _UV_CLOAK_ON else "") + _UV_PATCH_JS)
    m = re.search(r"<head\b[^>]*>", html, re.I)
    if m:
        return html[:m.end()] + inject + html[m.end():]
    m = re.search(r"<html\b[^>]*>", html, re.I)
    if m:
        return html[:m.end()] + inject + html[m.end():]
    return inject + html


class QuietServer(ThreadingHTTPServer):
    # Clients close connections mid-response all the time (tab refresh,
    # game frames navigating away, proxies timing out). Those land as
    # ConnectionResetError / ConnectionAbortedError / BrokenPipeError and
    # every one used to print a full traceback to stderr, drowning the real
    # errors in chalkle-*-err.log. Any other exception still prints.
    def handle_error(self, request, client_address):
        import sys
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError, socket.timeout)):
            return
        super().handle_error(request, client_address)


def main():
    _active_boot_purge()
    threading.Thread(target=_pruner, daemon=True).start()
    threading.Thread(target=_wp_warm_all, daemon=True).start()
    # SimpleHTTPRequestHandler.__init__ ignores class-level `directory` and
    # falls back to os.getcwd(), so launching from server/ would 404 every
    # static file. Pin the webroot explicitly (functools.partial passes the
    # keyword through the handler call the server module makes).
    import functools
    handler = functools.partial(Handler, directory=WEB_ROOT)
    _yut_startup_purge()
    httpd = QuietServer((HOST, PORT), handler)
    print(f"Chalkle server on http://{HOST}:{PORT}  (/_active viewers, /_fetch proxy)")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
