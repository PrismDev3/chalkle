"""Patch server/serve-chalk.py: when the TMDB bearer token is rejected
(401/403), answer catalog/search/detail routes from Stremio's keyless
Cinemeta API, converted to TMDB response shapes the Movies tab expects.

Also: allow overriding the token via TMDB_BEARER env var.
"""
import io
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
P = "server/serve-chalk.py"
s = io.open(P, encoding="utf-8").read()

# ---------- 1) env-overridable token ----------
old_tok = '_TMDB_BEARER = (\n    "eyJhbGciOiJIUzI1NiJ9.'
assert old_tok in s
s = s.replace(old_tok, '_TMDB_BEARER = os.environ.get("TMDB_BEARER") or (\n    "eyJhbGciOiJIUzI1NiJ9.', 1)

# os import check
if not re.search(r"^import os$", s, re.M):
    s = s.replace("import json", "import json\nimport os", 1)

# ---------- 2) fallback module-level bits ----------
anchor = "FETCH_MAX_REDIRECTS = 5"
assert anchor in s
GLUE = '''
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
    year = (m.get("releaseInfo") or "").split("\\u2013")[0].split("-")[0]
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
    year = (m.get("releaseInfo") or "").split("\\u2013")[0].split("-")[0]
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
                rows = _cinemeta_rows("/catalog/%s/top.json" % ("series" if mtype == "tv" else "movie"), mtype)
                results = {"page": 1, "results": rows, "total_pages": 1, "total_results": len(rows)}
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

'''
s = s.replace(anchor, anchor + GLUE, 1)

# ---------- 3) hook the fallback into _tmdb_proxy ----------
old_hook = """        except urllib.error.HTTPError as e:
            raw = e.read()
            code = e.code
        except Exception as e:
            return self._json_out({"error": type(e).__name__}, 502)
        self.send_response(code or 502)"""
new_hook = """        except urllib.error.HTTPError as e:
            raw = e.read()
            code = e.code
        except Exception as e:
            return self._json_out({"error": type(e).__name__}, 502)
        if code in (401, 403):
            fb = _cinemeta_serve(path, qs)
            if fb is not None:
                return self._cinemeta_respond(fb)
        self.send_response(code or 502)"""
assert old_hook in s
s = s.replace(old_hook, new_hook, 1)

# _cinemeta_respond/_cinemeta_serve are module-level functions taking self
s = s.replace("return self._cinemeta_respond(fb)", "return _cinemeta_respond(self, fb)", 1)

io.open(P, "w", encoding="utf-8", newline="").write(s)
import ast
ast.parse(s)
print("patched + parses OK,", len(s), "bytes")
