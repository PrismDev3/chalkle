"""movies.html: accept absolute poster/backdrop URLs from the fallback catalog."""
import io
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
P = "movies.html"
s = io.open(P, encoding="utf-8").read()

anchor = "const TMDB_IMG = 'https://image.tmdb.org/t/p/';"
assert anchor in s
helper = anchor + """
// Accepts either a TMDB path fragment (/abc.jpg) or a full URL (the fallback
// catalog serves absolute metahub URLs) and returns a usable image URL.
function tmdbImg(p, size) { return !p ? '' : (/^https?:/i.test(p) ? p : tmdbImageBase + size + p); }"""
if "function tmdbImg(" not in s:
    s = s.replace(anchor, helper, 1)

n = 0
# list-comp rows: poster: r.poster_path ? `${tmdbImageBase}w500${r.poster_path}` : '',
old_poster = "r.poster_path ? `${tmdbImageBase}w500${r.poster_path}` : ''"
new_poster = "r.poster_path ? tmdbImg(r.poster_path, 'w500') : ''"
n += s.count(old_poster)
s = s.replace(old_poster, new_poster)

old_backdrop = "r.backdrop_path ? `${tmdbImageBase}w1920${r.backdrop_path}` : ''"
new_backdrop = "r.backdrop_path ? tmdbImg(r.backdrop_path, 'w1920') : ''"
n += s.count(old_backdrop)
s = s.replace(old_backdrop, new_backdrop)

old_dposter = "d.poster_path ? `${tmdbImageBase}w500${d.poster_path}` : ''"
new_dposter = "d.poster_path ? tmdbImg(d.poster_path, 'w500') : ''"
n += s.count(old_dposter)
s = s.replace(old_dposter, new_dposter)

old_dbackdrop = "d.backdrop_path ? `${tmdbImageBase}w1920${d.backdrop_path}` : ''"
new_dbackdrop = "d.backdrop_path ? tmdbImg(d.backdrop_path, 'w1920') : ''"
n += s.count(old_dbackdrop)
s = s.replace(old_dbackdrop, new_dbackdrop)

old_logo1 = "logo && logo.file_path ? `${tmdbImageBase}w780${logo.file_path}` : ''"
new_logo1 = "logo && logo.file_path ? tmdbImg(logo.file_path, 'w780') : ''"
n += s.count(old_logo1)
s = s.replace(old_logo1, new_logo1)

old_logo2 = "logo && logo.file_path && !m.logo) m.logo = `${tmdbImageBase}w780${logo.file_path}`;"
new_logo2 = "logo && logo.file_path && !m.logo) m.logo = tmdbImg(logo.file_path, 'w780');"
n += s.count(old_logo2)
s = s.replace(old_logo2, new_logo2)

old_logo3 = "if (logo && logo.file_path) item.logo = `${tmdbImageBase}w780${logo.file_path}`;"
new_logo3 = "if (logo && logo.file_path) item.logo = tmdbImg(logo.file_path, 'w780');"
n += s.count(old_logo3)
s = s.replace(old_logo3, new_logo3)

# season posters composed from poster_path elsewhere
old_ep_still = "ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}`"
n0 = s.count(old_ep_still)
s = s.replace(old_ep_still, "ep.still_path ? (String(ep.still_path).startsWith('http') ? ep.still_path : 'https://image.tmdb.org/t/p/w300' + ep.still_path)")

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("replacements applied:", n, "| still_path site:", n0)
print("tmdbImg present:", "function tmdbImg(" in s)
