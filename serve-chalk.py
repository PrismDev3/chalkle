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

    GET /uv/<base64url(target)>
        The built-in rewriting proxy (the "Scramjet" / "Ultraviolet" routes).
        Fetches the target server-side, rewrites HTML/CSS so every URL flows
        back through /uv/, strips CSP/X-Frame-Options, injects a small client
        patch (fetch/XHR/WebSocket/history) and serves it all from this same
        origin - so there is nothing separate for a filter to block and the
        route never goes stale the way a temporary tunnel does. WebSocket
        upgrade requests to /uv/... are tunneled straight through.
"""
import os
import re
import ssl
import json
import time
import mmap
import socket
import base64
import threading
from urllib.parse import urljoin
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
WEB_ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = 4173
ACTIVE_TTL = 20          # seconds a visitor stays "online" after their last ping
PRUNE_EVERY = 4          # seconds between pruning expired visitors
PRUNE_AFTER = ACTIVE_TTL + 4

# visitor_id -> last-seen unix ts
STATE = {}
LOCK = threading.Lock()


def _prune():
    now = time.time()
    with LOCK:
        expired = [k for k, ts in STATE.items() if now - ts > PRUNE_AFTER]
        for k in expired:
            STATE.pop(k, None)


def _active_count():
    _prune()
    now = time.time()
    with LOCK:
        return sum(1 for ts in STATE.values() if now - ts <= ACTIVE_TTL)


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
CLOUD_API_KEY_DEFAULT = "sk_chalkle_local_7f2c9a"
CLOUD_CFG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cloud-relay.json")
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
        timeout = 180 if route == "/cloud/v1/createSession" else (8 if route == "/cloud/v1/pingSession" else 20)
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
MUSIC_CFG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "music-relay.json")

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
            if ccached and time.time() - ccached[0] < 3600:
                return self._music_json(ccached[1], 200, cacheable=True)
            data, code = _yt_fetch_json("/streams/" + urllib.parse.quote(vid), timeout=20, retries=3)
            stream_url = ""
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
                return self._music_json({"url": "", "via": "youtube", "br": -1})
            payload = {
                "url": "/music/stream?u=" + _music_b64u(stream_url),
                "via": "youtube",
                "br": 320
            }
            _yt_cache[ckey] = (time.time(), payload)
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
#   /yt/channel/<id>           -> channel profile + latest videos
#   /yt/thumb?u=<b64>          -> image proxy for thumbnails/avatars
# Search results come back with thumbnails rewritten to /yt/thumb so the
# browser never hits a third-party host directly (school-friendly). Results
# are cached briefly so repeated browsing doesn't hammer the upstream.

YT_INSTANCES = [
    "https://api.piped.private.coffee",
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.adminforge.de",
    "https://pipedapi.reallyaweso.me",
]

_yt_cache = {}          # route key -> (ts, payload)
_YT_CACHE_TTL = 180     # seconds


def _yt_b64u(s):
    import base64
    return base64.urlsafe_b64encode(s.encode("utf-8")).decode("ascii").rstrip("=")


def _yt_unb64u(s):
    import base64
    return base64.urlsafe_b64decode((s + "=" * (-len(s) % 4)).encode("ascii")).decode("utf-8")


def _yt_fetch_json(path, timeout=12, retries=2):
    """Try each Piped instance until one returns JSON. Returns (data, code).
    Instances are flaky (streams especially), so do a couple of full rounds
    before giving up."""
    import urllib.request, urllib.error, json as _json
    last_err = None
    for _round in range(max(1, retries)):
        for inst in YT_INSTANCES:
            url = inst + path
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 ChalkleYT/1.0", "Accept": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    body = resp.read()
                    try:
                        data = _json.loads(body)
                    except Exception:
                        last_err = "bad json from " + inst
                        continue
                    if isinstance(data, dict) and isinstance(data.get("error"), (str, dict)):
                        # Instance alive but refused (streams need a working extractor;
                        # search can also fail this way). Skip to the next instance.
                        last_err = "error reply from " + inst + ": " + str(data["error"])[:80]
                        continue
                    if isinstance(data, (dict, list)):
                        return data, resp.getcode() or 200
                    last_err = "unexpected payload from " + inst
            except urllib.error.HTTPError as e:
                last_err = "http " + str(e.code) + " from " + inst
            except Exception as e:
                last_err = type(e).__name__ + " from " + inst
    return {"error": "all YouTube instances failed: " + str(last_err)}, 502


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
        import urllib.request, urllib.error
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 ChalkleYT/1.0", "Accept": "image/*"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
                self.send_response(resp.getcode() or 200)
                self.send_header("Content-Type", ctype or "image/jpeg")
                self.send_header("Cache-Control", "public, max-age=86400")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            return self._yt_json({"error": "upstream http " + str(e.code)}, e.code)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                return self._yt_json({"error": type(e).__name__}, 502)
            except Exception:
                pass


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



class Handler(_CloudRelay, _MusicRelay, _YouTubeRelay, _LiveTV, _SportsTV, SimpleHTTPRequestHandler):
    def log_message(self, *a):  # quieter than the default per-request logger
        pass

    def send_response(self, code, message=None):
        super().send_response(code, message)
        # Ruffle SWF wrappers run in an opaque (blob:null) about:blank tab, so
        # they must be able to fetch game assets cross-origin.
        self.send_header("Access-Control-Allow-Origin", "*")
        # The site is edited live and re-deployed constantly; browsers/CDNs
        # must NEVER heuristically cache the text assets or users keep seeing
        # stale versions (e.g. the old off-canvas sidebar CSS). No-store keeps
        # every load fresh; images can still be cached normally.
        route = self.path.split("?", 1)[0].lower()
        if route.endswith((".html", ".htm", ".css", ".js", ".json", ".svg", ".mjs")):
            self.send_header("Cache-Control", "no-store, max-age=0")

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
        if route == "/api/ai/models":
            return self._ai_models()
        if route == "/api/ai/convos":
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            return self._ai_convos_get((qs.get("v") or ["anon"])[0])
        if route == "/_cherri":
            return self._cherri()
        if route == "/uv" or route == "/uv/":
            return self._uv_boot()
        if route.startswith("/uv/"):
            if (self.headers.get("Upgrade") or "").lower() == "websocket":
                return self._uv_ws(route[len("/uv/"):])
            return self._uv_route(route[len("/uv/"):])
        if route == "/cloud/health":
            return self._cloud_health()
        if route.startswith("/cloud/v1/signal/"):
            if (self.headers.get("Upgrade") or "").lower() == "websocket":
                return self._cloud_ws(route)
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
        return super().do_GET()

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
        if route.startswith("/uv/"):
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length > 0 else None
            ctype = (self.headers.get("Content-Type") or "").lower()
            if body is not None and "application/x-www-form-urlencoded" in ctype:
                body = body.decode("utf-8", "replace")
            return self._uv_route(route[len("/uv/"):], body)
        if route == "/cloud/config":
            return self._cloud_config_post()
        got = self._cloud_post(route)
        if got is not None:
            return got
        if route == "/api/live-tv/admin":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length > 0 else b"{}"
            return self._livetv_save(body)
        self.send_response(405)
        self.end_headers()

    # ---------------------------------------------------------------- cherri list
    # The Cherri List doc is a 2.5M-line file of jsDelivr SVG cloak URLs
    # (~265MB). The browser must never load that whole file, so this endpoint
    # serves tiny JSON pages: line-range browsing when no query is given, and a
    # case-insensitive substring search when one is. The file is mmap'd lazily
    # with a line-offset index so paging is O(1); search scans once per query.
    CHERRI_PATH = os.path.join(WEB_ROOT, "cherri-list.txt")
    _cherri_mm = None        # mmap of the raw file
    _cherri_lower = None     # lazy lowercase copy of the raw bytes (search only)
    _cherri_offsets = None   # byte offset of each line start (array 'Q')
    _cherri_total = 0

    @classmethod
    def _cherri_index(cls):
        if cls._cherri_offsets is not None:
            return
        import array as _array
        if not os.path.isfile(cls.CHERRI_PATH):
            cls._cherri_offsets = _array.array("Q")
            return
        with open(cls.CHERRI_PATH, "rb") as f:
            mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        cls._cherri_mm = mm
        offs = _array.array("Q", [0])
        pos = 0
        n = len(mm)
        while True:
            nl = mm.find(b"\n", pos)
            if nl == -1:
                break
            offs.append(nl + 1)
            pos = nl + 1
        # One line-start offset per newline found, plus the implicit start of a
        # final line that has no trailing newline. Total lines = len(offs), minus
        # one when the file ends with a newline (no trailing empty line).
        cls._cherri_offsets = offs
        ends_nl = len(mm) > 0 and mm[-1:] == b"\n"
        cls._cherri_total = max(0, len(offs) - (1 if ends_nl else 0))

    def _cherri(self):
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(self.path).query)
        query = (q.get("q") or [""])[0].strip()
        try:
            offset = max(0, int((q.get("offset") or ["0"])[0]))
            limit = min(200, max(1, int((q.get("limit") or ["50"])[0])))
        except Exception:
            offset, limit = 0, 50
        Handler._cherri_index()
        mm = Handler._cherri_mm
        offs = Handler._cherri_offsets
        total = Handler._cherri_total
        results = []
        if mm is None or offs is None or len(offs) < 2:
            body = json.dumps({"ok": True, "total": 0, "results": []}).encode()
        else:
            if not query:
                # Line-range browse: O(1) via the offset index.
                for i in range(offset, min(offset + limit, total)):
                    s = offs[i]
                    e = offs[i + 1] if i + 1 < len(offs) else len(mm)
                    line = mm[s:e].strip()
                    if line:
                        results.append(line.decode("utf-8", "replace"))
                match_total = total
            else:
                # Case-insensitive substring search over the lazy lowercase copy.
                if Handler._cherri_lower is None:
                    Handler._cherri_lower = bytes(mm).lower()
                lower = Handler._cherri_lower
                needle = query.lower().encode()
                idx = [0]
                match_total = 0
                seen_line = -1
                skip = offset
                pos = 0
                while True:
                    hit = lower.find(needle, pos)
                    if hit == -1:
                        break
                    # map hit position -> line index
                    import bisect
                    li = bisect.bisect_right(offs, hit) - 1
                    if li < 0:
                        li = 0
                    if li != seen_line:
                        seen_line = li
                        match_total += 1
                        if skip > 0:
                            skip -= 1
                        elif len(results) < limit:
                            s = offs[li]
                            e = offs[li + 1] if li + 1 < len(offs) else len(mm)
                            line = mm[s:e].strip()
                            if line:
                                results.append(line.decode("utf-8", "replace"))
                    pos = hit + 1
            body = json.dumps({"ok": True, "total": total, "match_total": match_total, "results": results}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sync_get(self):
        db_path = os.path.join(WEB_ROOT, "sync.json")
        data = b"{}"
        if os.path.isfile(db_path):
            with open(db_path, "rb") as f:
                data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _sync_post(self):
        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length) if length > 0 else b"{}"
        db_path = os.path.join(WEB_ROOT, "sync.json")
        try:
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
    # next takes over so the tab keeps answering. Anonymous by default:
    #   OVHcloud AI Endpoints (no key, free tier, has vision models)
    #   LLM7.io               (no key, free tier)
    #   legacy gateway        (45.32.114.54 - shared, often rate-limited)
    # Set AI_UPSTREAM (+ optional AI_API_KEY) to slot a keyed provider
    # (OpenRouter / Gemini / etc.) in FIRST.
    AI_UPSTREAM = os.environ.get("AI_UPSTREAM", "").strip()
    AI_API_KEY = os.environ.get("AI_API_KEY", "").strip()
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

    @classmethod
    def _ai_upstreams(cls):
        if cls._AI_UPS_CACHE is None:
            ups = []
            if cls.AI_UPSTREAM:
                ups.append({"base": cls.AI_UPSTREAM.rstrip("/"), "key": cls.AI_API_KEY, "default": ""})
            ups.append({"base": "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", "key": "", "default": "Qwen3.5-397B-A17B"})
            ups.append({"base": "https://api.llm7.io/v1", "key": "", "default": "mistral-Nemo-Instruct-2407"})
            # Legacy gateway: answers, but its default model returns incoherent
            # text, so it gets NO default (skipped in the last-resort fallback
            # loop) - only used when the user explicitly picks one of its models.
            ups.append({"base": "http://45.32.114.54:8080/v1", "key": "", "default": ""})
            for u in ups:
                u["down_until"] = 0
                u["models"] = None
            cls._AI_UPS_CACHE = ups
        return cls._AI_UPS_CACHE

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
        for up in self._ai_upstreams():
            for mid in (up.get("models") or []):
                if mid not in seen:
                    seen[mid] = up["base"]
        if seen:
            out = {"ok": True, "models": list(seen.keys()), "sources": seen, "default": next(iter(seen))}
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
        if not wants_vision:
            for m in msgs:
                c = m.get("content")
                if isinstance(c, list):
                    for part in c:
                        if isinstance(part, dict) and part.get("type") == "image_url":
                            wants_vision = True
                            break
        if not msgs or (msgs[0].get("role") != "system"):
            msgs = [{"role": "system", "content": "You are a helpful assistant. Answer the user's question directly, correctly and concisely. No preambles, no vague clarifying questions - just give the answer. Write plain text: no markdown symbols like **, ###, or backtick fences."}] + msgs
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
        for up, use_model in cands:
            if up["down_until"] and up["down_until"] > time.time():
                continue
            body_b = json.dumps({"model": use_model, "messages": msgs, "stream": stream, "temperature": 0.6}).encode()
            req = urllib.request.Request(up["base"] + "/chat/completions", data=body_b,
                                         headers=self._ai_headers(up["key"], {"Content-Type": "application/json", "Accept": "text/event-stream" if stream else "application/json"}))
            try:
                resp = urllib.request.urlopen(req, timeout=90)
            except urllib.error.HTTPError as e:
                code = e.code
                raw = e.read()
                errors.append("HTTP " + str(code) + " " + raw.decode("utf-8", "replace")[:120].strip())
                if code in (429, 500, 502, 503, 504):
                    up["down_until"] = time.time() + 60
                elif code != 400:
                    up["down_until"] = time.time() + 300
                continue  # 400 (model unavailable) or 429 - try next candidate
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

    # ---------------------------------------------------------------- /uv proxy
    # The built-in rewriting proxy behind the "Scramjet" and "Ultraviolet"
    # routes. <proxy>/uv/<base64url(target)> fetches the target server-side,
    # rewrites every URL in the HTML/CSS back through /uv/ (so the tab only
    # ever talks to this origin), strips CSP / X-Frame-Options, and injects a
    # small client patch that reroutes fetch/XHR/WebSocket/history calls that
    # only exist at runtime. No service worker, no separate host to block, and
    # the route can never go stale the way a temporary tunnel does.

    def _uv_send(self, code, ctype, raw, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
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
        """Small themed page for the /uv/ proxy root (what the proxy card's
        in-app Open button shows). Lets you type a URL, and handles the
        hash-route form (#<base64url>) by bouncing to the path route."""
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
            "function enc(s){try{return btoa(unescape(encodeURIComponent(s)))"
            ".replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}"
            "catch(e){return encodeURIComponent(s)}}"
            "function go(){var v=(document.getElementById('u').value||'').trim();"
            "if(!v)return;if(v.indexOf('://')===-1)v='https://'+v;"
            "location.href='/uv/'+enc(v)}"
            "document.getElementById('go').onclick=go;"
            "document.getElementById('u').addEventListener('keydown',function(e){if(e.key==='Enter')go()});"
            "var h=location.hash;if(h&&h.length>1)location.replace('/uv/'+h.slice(1));"
            "</script></body></html>"
        )
        self._uv_send(200, "text/html", html.encode())

    def _uv_route(self, encoded, post_body=None):
        """Serve /uv/<base64url(target)>[<extra path>]. The encoded value can
        carry a trailing path (when the browser resolved a relative URL against
        the injected proxied <base>); append it to the decoded target. Local
        paths (starting with /) are served from this server's own webroot so
        /game-builds/... shells work even when their CDN assets are blocked -
        the rewriter turns every CDN reference back into a /uv/ route."""
        seg, _, rest = encoded.partition("/")
        target = _uv_b64url_decode(seg)
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
        # Binary assets (Unity .data/.wasm, images, fonts) must be streamed -
        # they can be hundreds of MB and buffering them would kill the server.
        # Probe the upstream Content-Type cheaply: HTML/CSS get rewritten, all
        # other MIME types stream straight through with the real type.
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
        if not (is_html or is_css):
            # Not HTML/CSS - stream. If the target is really HTML served with a
            # wrong MIME, sniff the first bytes before committing to a stream.
            head = probe.read(512)
            probe.close()
            if head.lstrip().lower().startswith((b"<!doctype", b"<html", b"<head")):
                is_html = True
                # Rewind isn't possible - re-open so the full body can be read.
                try:
                    probe = _uv_open(target, post_body)
                except Exception as e:
                    return self._uv_error(502, type(e).__name__)
            else:
                # Rewind isn't possible - re-open and stream the whole thing.
                try:
                    probe = _uv_open(target, post_body)
                except Exception as e:
                    return self._uv_error(502, type(e).__name__)
                ctype = (probe.headers.get("Content-Type", "").split(";")[0].strip().lower())
                if "text/html" in ctype:
                    is_html = True
                elif "javascript" in ctype or ctype == "module" or target.lower().endswith(".js") or target.lower().endswith(".mjs"):
                    # JS module: rewrite relative import specifiers to absolute
                    # /uv/ routes, then send. Verbatim streaming would break
                    # every `import"./chunk.js"` (they'd resolve against
                    # /uv/<name>.js and lose the encoded target).
                    raw = probe.read(40 * 1024 * 1024 + 1)
                    probe.close()
                    if len(raw) > 40 * 1024 * 1024:
                        return self._uv_error(502, "file too large")
                    text = _uv_rewrite_js(_uv_decode(raw), target)
                    extra = {
                        "Content-Security-Policy": "",
                        "X-Frame-Options": "",
                        "Content-Security-Policy-Report-Only": "",
                    }
                    self._uv_send(200, "text/javascript", text.encode("utf-8", "replace"), extra)
                    return
                else:
                    return self._uv_stream_resp(probe)
        if is_html or is_css:
            raw = probe.read(40 * 1024 * 1024 + 1)
            probe.close()
            if len(raw) > 40 * 1024 * 1024:
                return self._uv_error(502, "page too large")
            code = 200
            if is_html:
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
            self._uv_send(code, ctype, raw, extra)
            return
        return self._uv_stream_resp(probe)

    def _uv_stream_resp(self, resp):
        """Stream an already-open upstream response through to the client."""
        try:
            ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
            self.send_response(resp.getcode() or 200)
            self.send_header("Content-Type", ctype or "application/octet-stream")
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Security-Policy", "")
            self.send_header("X-Frame-Options", "")
            self.send_header("Content-Security-Policy-Report-Only", "")
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
            self.send_header("Content-Security-Policy", "")
            self.send_header("X-Frame-Options", "")
            self.send_header("Content-Security-Policy-Report-Only", "")
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
        through the /uv/ pipeline. The HTML/CSS rewriter turns any external
        CDN reference (jsdelivr, raw.githubusercontent, ...) into a /uv/ route,
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
            self._uv_send(200, ctype, raw, extra)
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
            self._uv_send(200, "text/javascript", text.encode("utf-8", "replace"), extra)
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
            self.send_header("Content-Security-Policy", "")
            self.send_header("X-Frame-Options", "")
            self.send_header("Content-Security-Policy-Report-Only", "")
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
        target = _uv_b64url_decode(encoded)
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
            with LOCK:
                STATE[sid] = time.time()
        body = json.dumps({"active": _active_count(), "ttl": ACTIVE_TTL}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


FETCH_TIMEOUT = 9       # seconds before a target is considered unreachable
FETCH_MAX_REDIRECTS = 5


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


# ---------------------------------------------------------------- /uv helpers
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
# history / location navigations, all through the same /uv/ route.
_UV_PATCH_JS = (
    "<script>"
    "(function(){"
    "\"use strict\";"
    "try{"
    "var TARGET=window.__UV_TARGET__||'';var P='/uv/';"
    "function enc(u){try{return btoa(unescape(encodeURIComponent(u)))"
    ".replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}"
    "catch(e){return encodeURIComponent(u)}}"
    "function abs(u){"
    "if(!u||typeof u!=='string')return u;"
    "var s=u.trim();"
    "if(!s||/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(s))return u;"
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


def _uv_b64url_encode(s):
    return base64.urlsafe_b64encode(s.encode("utf-8")).decode("ascii").rstrip("=")


def _uv_b64url_decode(s):
    s = (s or "").strip().replace("-", "+").replace("_", "/")
    s += "=" * (-len(s) % 4)
    try:
        return base64.b64decode(s).decode("utf-8", "replace")
    except Exception:
        return None


def _uv_decode(raw):
    try:
        return raw.decode("utf-8")
    except Exception:
        return raw.decode("latin-1", "replace")


def _uv_open(url, post_body=None):
    """Open a proxied target for reading. Returns the urllib response object
    (or raises). Kept separate so binary assets can be streamed instead of
    buffered - Unity .data/.wasm parts are frequently >100MB and must not be
    loaded into memory or capped."""
    import urllib.request
    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    data = None
    if post_body is not None:
        data = post_body.encode() if isinstance(post_body, str) else post_body
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers)
    return urllib.request.urlopen(req, timeout=FETCH_TIMEOUT)


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
    """Rewrite one URL to an absolute /uv/ route. Relative values resolve
    against base_url first; non-URL values pass through untouched."""
    v = str(value or "").strip()
    if not v or v.startswith(("#", "data:", "blob:", "javascript:", "mailto:", "tel:")):
        return value
    if v.startswith("//"):
        v = "https:" + v
    if not re.match(r"^https?://", v, re.I):
        v = urljoin(base_url, v)
    return "/uv/" + _uv_b64url_encode(v)


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
    """Rewrite module import specifiers inside streamed JS to absolute /uv/
    routes. Without this, `import"./D7UGAqZr.js"` inside a proxied module
    resolves against /uv/<name>.js and 404s (the encoded target is lost)."""
    def rep(m):
        pre, spec, quote = m.group(1), m.group(2), m.group(3)
        # Skip already-rewritten routes
        if spec.startswith("/uv/"):
            return m.group(0)
        return pre + _uv_wrap_url(spec, base_url) + quote
    return _UV_JS_IMPORT_RE.sub(rep, str(js or ""))


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


def _uv_rewrite_html(html, target):
    """Rewrite a full HTML document: every URL attribute becomes an absolute
    /uv/ route, <style>/inline CSS url()s get rewritten, CSP meta tags and
    <base> tags are replaced with a proxied <base> (so any relative URL a
    script assigns at runtime still lands on the proxy), and raw-text
    elements are left untouched."""
    base_dir = urljoin(target, ".")
    base_href = "/uv/" + _uv_b64url_encode(base_dir) + "/"
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
    # raw /uv/ route, so it still lands on the proxy. The rewriter already
    # replaced a site <base>; only inject when the document had none.
    base = ""
    if not re.search(r"<base\b[^>]*>", html, re.I):
        base_dir = urljoin(target, ".")
        base = '<base href="/uv/' + _uv_b64url_encode(base_dir) + '/">'
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
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.RequestHandlerClass.directory = WEB_ROOT
    print(f"Chalkle server on http://{HOST}:{PORT}  (/_active viewers, /_fetch proxy)")
    httpd.serve_forever()


if __name__ == "__main__":
    main()