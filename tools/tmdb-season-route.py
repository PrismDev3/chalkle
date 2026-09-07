"""Add /tv/{id}/season/{n} fallback support to the Cinemeta bridge in serve-chalk.py."""
import io
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
P = "server/serve-chalk.py"
s = io.open(P, encoding="utf-8").read()

old = """        elif re.match(r"^(movie|tv)/", path_tail):
            mtype = "movie" if path_tail.startswith("movie/") else "tv"
            ident = path_tail.split("/", 1)[1].split("?")[0].split("/")[0]"""
new = """        elif re.match(r"^tv/.+/season/\\d+$", path_tail):
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
            ident = path_tail.split("/", 1)[1].split("?")[0].split("/")[0]"""
assert old in s
s = s.replace(old, new, 1)

io.open(P, "w", encoding="utf-8", newline="").write(s)
import ast
ast.parse(s)
print("season route added + parses OK")
