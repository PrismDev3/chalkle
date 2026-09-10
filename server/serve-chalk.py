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


def _sanitize_sync_blob(raw: bytes) -> bytes:
    """Sync relay sanitizer: the relay used to echo client state verbatim, so
    any visitor's stale library resurrected deleted junk titles (bad 'Examples'
    placeholders, Scratch embeds, broken 1v1/Arena/2048-Cupcakes style entries)
    into every other visitor's library. Filter the gamelib on both GET and POST
    so removed entries stay removed no matter what clients send."""
    try:
        d = json.loads(raw.decode("utf-8"))
        if isinstance(d, dict) and isinstance(d.get("chalkle-gamelib-v4"), str):
            lib = json.loads(d["chalkle-gamelib-v4"])
            if isinstance(lib, list) and lib and isinstance(lib[0], dict):
                kept = [
                    g for g in lib
                    if isinstance(g, dict) and _lib_entry_ok(g)
                ]
                d["chalkle-gamelib-v4"] = json.dumps(kept, separators=(",", ":"), ensure_ascii=False)
        return json.dumps(d, ensure_ascii=False).encode("utf-8")
    except Exception:
        return raw


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


def _active_touch(sid):
    """Mark a visitor online in the shared registry."""
    now = time.time()
    with LOCK:
        STATE[sid] = now
        disk = _active_load()
        disk[sid] = now
        for k in [k for k, ts in disk.items() if now - ts > PRUNE_AFTER]:
            disk.pop(k, None)
        _active_save(disk)


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
        # Basic hardening: never sniff content types, and don't leak the
        # referrer to mirror sites the launcher opens.
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
        path = self.translate_path(route)
        if os.path.isdir(path):
            candidate = os.path.join(path, "index.html")
            if os.path.isfile(candidate):
                path = candidate
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
        if route == "/_active":
            return self._active()
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
            return self._uv_route(route[len(_UV_PFX):])
        if route == "/cloud/health":
            return self._cloud_health()
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
        return super().do_GET()

    def do_HEAD(self):
        # Mirror the taiko api shim mapping so HEAD probes (curl -I, health
        # checks) see the same 200 JSON the GET path serves.
        route = self.path.split("?", 1)[0]
        if route.startswith("/taiko/api/"):
            self.path = route + ".json" + self.path[len(route):]
        return super().do_HEAD()

    def do_POST(self):
        route = self.path.split("?", 1)[0]
        if route == "/_sync":
            return self._sync_post()
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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
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
                            data = json.dumps(incoming, ensure_ascii=False).encode("utf-8")
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
        req = urllib.request.Request(
            target,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ChalkleMovies/1.0",
                "Accept": "application/json",
                "Authorization": (self.headers.get("Authorization") or "").strip() or ("Bearer " + _TMDB_BEARER),
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
        disk; absolute http(s) URLs are fetched server-side. This lets the Ruffle
        SWF wrapper hand raw bytes to Ruffle with zero cross-origin requests which
        works from an opaque (blob:null) about:blank tab."""
        import base64
        from urllib.parse import parse_qs, unquote, urlparse
        q = parse_qs(urlparse(self.path).query)
        target = unquote((q.get("url") or [""])[0].strip())
        out = {"ok": False, "code": 0, "error": "bad-url"}
        if target.startswith("/"):
            rel = target.lstrip("/")
            p = os.path.normpath(os.path.join(WEB_ROOT, rel))
            if not p.startswith(WEB_ROOT) or not os.path.isfile(p):
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
        elif target.lower().startswith(("http://", "https://")):
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
        except Exception:
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
            is_js = ("javascript" in ctype or ctype == "module"
                     or ctype.endswith("ecmascript")
                     or target.lower().endswith((".js", ".mjs")))
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
                self._uv_send(200, "text/javascript", text.encode("utf-8", "replace"), extra,
                              cache="public, max-age=300")
                return
            else:
                return self._uv_stream_resp(probe, prefix=prefix,
                                            cacheable=_uv_cacheable(ctype, target))
        if is_html or is_css or is_svg:
            raw = probe.read(40 * 1024 * 1024 + 1)
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
            self._uv_send(code, ctype, raw, extra,
                          cache="public, max-age=300" if (is_css or is_svg) else "no-store, max-age=0")
            return

    def _uv_stream_resp(self, resp, prefix=b"", cacheable=0):
        """Stream an already-open upstream response through to the client.
        prefix carries bytes already read off the response (the MIME probe)
        so a binary asset is never fetched twice. cacheable>0 gives the
        browser a public cache lifetime for deterministic static assets."""
        try:
            ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
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
            f = open(safe, "rb")
        except Exception as e:
            return self._uv_error(500, type(e).__name__)
        try:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store, max-age=0")
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
        if sid:
            _active_touch(sid)
        body = json.dumps({"active": _active_count(), "ttl": ACTIVE_TTL}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


FETCH_TIMEOUT = 9       # seconds before a target is considered unreachable

# TMDB read-only bearer token used by the JS Movies tab proxy. This is the
# project's own token (from the vendored MILKBOX app) - never user credentials.
_TMDB_BEARER = os.environ.get("TMDB_BEARER") or (
    "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI5NDc2MWZmMmViNWRiYTM4MDJlZDJlNGJkOTE0ZGZlOCIsIm5iZiI6MTc3NzU2MDc0My45NzMsInN1YiI6IjY5ZjM2Y2E3ZDZhZjA3Yjg2Zjg0MzA3MSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.pNYedccUMayuOtMmH_vMWVVYjfAal3r2V1WWv433u4g"
)
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
        "genre_ids": [],
        "popularity": m.get("popularity") or 0,
    }
    if mtype == "movie":
        row["title"] = m.get("name")
    else:
        row["name"] = m.get("name")
    return row


def _cinemeta_detail(m, mtype, want_id):
    """Cinemeta meta -> TMDB detail shape."""
    genres = [{"id": i + 1, "name": g} for i, g in enumerate(m.get("genres") or [])]
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
                        rows = _cinemeta_rows("/catalog/%s/top.json" % ("series" if mtype == "tv" else "movie"), mtype)
                        results = {"page": page, "results": rows, "total_pages": 1, "total_results": len(rows)}
                else:
                    rows = _cinemeta_rows("/catalog/%s/top.json" % ("series" if mtype == "tv" else "movie"), mtype)
                    results = {"page": page, "results": rows, "total_pages": 1, "total_results": len(rows)}
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
                ctype = "series" if mtype == "tv" else "movie"
                m = (_cinemeta_get("/meta/%s/%s.json" % (ctype, imdb)).get("meta") or {})
                if m.get("id"):
                    results = _cinemeta_detail(m, mtype, int(ident) if ident.isdigit() else ident)
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


def _http_get(url):
    """Return (raw_bytes_or_None, mime_str, code, error_or_None)."""
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
            data = resp.read()
            ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
            return data, ctype or "application/octet-stream", resp.getcode(), None
    except urllib.error.HTTPError as e:
        return None, "", e.code, None
    except Exception as e:
        return None, "", 0, type(e).__name__



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

# Injected into every proxied page, right after <head>, so it runs before any
# site script. It reroutes the runtime requests that static rewriting can't
# see: fetch / XHR / WebSocket calls with absolute or root-relative URLs, and
# history / location navigations, all through the same /res/ route.
_UV_PATCH_JS = (
    "<script>"
    "(function(){"
    "\"use strict\";"
    "try{"
    "var TARGET=window.__UV_TARGET__||'';var P='/res/';"
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
    "if(o)lo[m]=function(u){try{if(typeof u==='string')u=wrap(u);}catch(e){}"
    "return o.call(lo,u);};});"
    "var h=window.history;"
    "['pushState','replaceState'].forEach(function(m){var o=h[m];"
    "if(o)h[m]=function(st,t,u){try{if(typeof u==='string')u=wrap(u);}catch(e){}"
    "return o.call(h,st,t,u);};});"
    "}catch(e){}"
    "var osa=Element.prototype.setAttribute;"
    "if(osa){Element.prototype.setAttribute=function(n,v){"
    "if(/^(src|href|action|poster|data-src|data-href|data-url|data-original|xlink:href)$/i.test(String(n))"
    "&&typeof v==='string'){try{v=wrap(v);}catch(e){}}"
    "return osa.call(this,n,v);};}"
    "[['HTMLScriptElement','src'],['HTMLImageElement','src'],['HTMLVideoElement','src'],['HTMLAudioElement','src'],['HTMLSourceElement','src'],['HTMLIFrameElement','src'],['HTMLTrackElement','src'],['HTMLLinkElement','href']].forEach(function(pair){"
    "var C=window[pair[0]];if(!C)return;var pr=C.prototype,d=Object.getOwnPropertyDescriptor(pr,pair[1]);"
    "if(!d||!d.set)return;"
    "try{Object.defineProperty(pr,pair[1],{configurable:true,enumerable:d.enumerable||true,"
    "get:function(){return d.get?d.get.call(this):this.getAttribute(pair[1]);},"
    "set:function(v){try{if(typeof v==='string')v=wrap(v);}catch(e){}d.set.call(this,v);}});}catch(e){}"
    "});"
    "}catch(e){}"
    "})();"
    "</script>"
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
_UV_POOL_IDLE_TTL = 20.0      # seconds before an idle conn is discarded


class _UVPoolConn:
    __slots__ = ("conn", "key", "idle_at")

    def __init__(self, conn, key):
        self.conn = conn
        self.key = key
        self.idle_at = time.time()


def _uv_pool_key(scheme, host, port):
    return scheme + "|" + host + "|" + str(port)


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


def _uv_open(url, post_body=None):
    """Fetch a proxied target with pooled keep-alive connections. Returns the
    urllib-style response object (read/close/headers/getcode) after following
    redirects, or raises urllib.error.HTTPError / URLError."""
    import http.client
    import urllib.error
    import urllib.request
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
        key = _uv_pool_key(scheme, host, port)
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
                        conn = http.client.HTTPSConnection(host, port, timeout=FETCH_TIMEOUT)
                    else:
                        conn = http.client.HTTPConnection(host, port, timeout=FETCH_TIMEOUT)
                    pooled = _UVPoolConn(conn, key)
                req_headers = dict(headers)
                if data is not None:
                    req_headers["Content-Type"] = "application/x-www-form-urlencoded"
                pooled.conn.request(("POST" if data is not None else "GET"), path,
                                    body=data, headers=req_headers)
                resp = pooled.conn.getresponse()
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
        v = v.replace("&amp;", "&").replace("&#38;", "&").replace("&AMP;", "&")
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
    inject = base + "<script>window.__UV_TARGET__=" + json.dumps(target) + ";</script>" + _UV_PATCH_JS
    m = re.search(r"<head\b[^>]*>", html, re.I)
    if m:
        return html[:m.end()] + inject + html[m.end():]
    m = re.search(r"<html\b[^>]*>", html, re.I)
    if m:
        return html[:m.end()] + inject + html[m.end():]
    return inject + html


def main():
    threading.Thread(target=_pruner, daemon=True).start()
    threading.Thread(target=_wp_warm_all, daemon=True).start()
    # SimpleHTTPRequestHandler.__init__ ignores class-level `directory` and
    # falls back to os.getcwd(), so launching from server/ would 404 every
    # static file. Pin the webroot explicitly (functools.partial passes the
    # keyword through the handler call the server module makes).
    import functools
    handler = functools.partial(Handler, directory=WEB_ROOT)
    httpd = ThreadingHTTPServer((HOST, PORT), handler)
    print(f"Chalkle server on http://{HOST}:{PORT}  (/_active viewers, /_fetch proxy)")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
