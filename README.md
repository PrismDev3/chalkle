# Chalkle

A fast, flat, dark game launcher: games, cloud gaming, music, YouTube, Live TV,
AI chat, sites, apps/tools and proxies. No framework, no sign-in, no fake
content.

## Features

- 14 tabs: Home, Games, Cloud, Music, Apps/Tools, Proxies, Sites, AI, Docs,
  Partners, Board, Live TV, YouTube, Settings
- Launcher: every game/site/app opens as a plain new tab; explicitly proxied
  items route through a configured proxy, and when a popup is blocked the item
  falls back to the in-app frame overlay on this page
- Tab cloak: disguise the whole tab as Google / Classroom / Docs / Drive /
  Canvas / Clever / Khan / IXL; with no cloak the tab keeps the IXL look so it
  matches the link preview everywhere
- Panic key: press ` 3x fast (or Ctrl+Shift+`) to instantly jump to Google
  Classroom
- Music: full player with queue, shuffle, repeat, lyrics, speed/pitch,
  equalizer, favorites; streams resolved through the relay
- YouTube search + player and Live TV (HLS sports channels) through the relay
- AI chat against the site's own relay (model list, streaming replies, file
  attachments, saved conversations)
- Board / Partners / Docs with in-app admin editing (code-gated)
- Search everywhere (Ctrl/Cmd+K), genre/category chips, sort, favorites,
  recents, Editor's Picks, "New this week" ribbons
- Shared launch counts: every game shows how many times it has been played,
  and "Most played" / "Trending this week" / the Home shelf rank on those
  totals (local clicks stay the fallback when the relay is unreachable)
- Home web search with a search-engine picker (DuckDuckGo Lite by default);
  a URL, bare host, LAN address or localhost opens directly, anything else
  searches on the chosen engine
- Performance overlay (Settings > Display, Alt+P, or `?perf=1`): live fps,
  main-thread load and JS heap with flat sparkline charts
- Chromebook / low-power pass: every script defers (36 parallel downloads,
  nothing blocks first paint), grid cards skip layout and paint off-screen
  via `content-visibility`, small-memory Chromebooks and phones get
  animations off and the boot intro skipped by default (Settings > Motion
  still wins), and the Games grid starts at 240 cards instead of 480 on
  those devices
- Playtime: the in-app player times each sitting and writes it to this device.
  Cards show "2h 10m played", there is a "Longest played (you)" sort, the
  Continue shelf and the Home stat line use the same numbers, and Settings >
  Display has the total plus a Reset. A hidden tab accrues nothing and one
  sitting stops counting at four hours, so a parked game is not a played one
- Game pop-up guard: local builds run same-origin, so the player patches the
  frame's own `window.open` and the cloaked about:blank window drops
  `allow-popups`. One toast on the first block, off switch in Settings >
  Behavior
- Lenient text matching in the Games/Apps filter and the search dropdown:
  queries are folded to letters and digits, so "geometrydash" finds Geometry
  Dash, "amongus" finds Among Us and "fnaf2" finds FNAF 2; "gd" finds a title
  by its initials. Acronym matching replaced a looser subsequence pass that
  answered "gta5" with Minecraft builds
- Ad-layer check: Settings > Advanced reports whether an ad blocker is
  running, once per session as a dismissible toast, never a modal
- Boot intro (skippable, motion-safe), themes, wallpapers, cursors, reduce
  motion

## Run

```
python server/serve-chalk.py
```

Then open http://127.0.0.1:4173. The relay on the same port backs the YouTube,
music, AI, Live TV and cloud features; static mirrors (GitHub Pages) route
those calls to `chalkle.lootline.xyz` instead (see `src/runtime-config.js`).

## Keeping the site alive

`scripts/start-chalkle.bat` (launched hidden by the Startup-folder VBS) is the
keeper: every 20s it checks the origin server, the music/cloud/chat/esm
backends and the Cloudflare tunnel, and starts whatever died. The server
check refuses to start a second python when the port answers non-200 (that
means it is running, just erroring) - the old version piled up duplicate
processes and filled the log with "down, starting" every cycle. If the site
returns Cloudflare 1033, the origin or the tunnel died: check
`keeper.log`, `chalkle-server-err.log` and `chalkle-named-tunnel-err.log`.

## Playtest / audit workflow

- `node scripts/audit.mjs` - static checks: duplicate ids, JS-to-HTML id wiring,
  script assets, hidden/display conflicts, game library integrity, nav wiring
- `python tools/checker.py` - copy/style gate: dashes, AI vocab, gradients
- `node scripts/sweep-views.mjs` - headless pass over every view section found in
  index.html: console errors, page exceptions, local answers with status 400 or
  worse, and whether the tab actually switched. Exits 0 on a clean pass and 1 on
  any failing view, so it can sit in a gate chain, and it writes its transcript
  to `tmp/sweep-last.log` plus per view data to `tmp/sweep-last.json`
- `node tools/sw-test.js` - service worker routing: what it caches, what it
  passes through untouched, and the offline fallback
- `python tools/plays-test.py` - the /api/plays counter: counting, the rolling
  week, key sanitizing, the store's self-trimming and malformed-file recovery
- `python tools/state-post-test.py` - the same-origin guard on state-changing
  POSTs (same host and mirrors allowed, cross-site refused)
- `python tools/server-path-test.py` - the static handler's deny list: secrets
  and build artifacts stay refused, Unity `Build/` payloads stay served
- `python tools/tmdb-token-test.py` - the Movies proxy's refused-token memo: a
  route the keyless fallback covers is answered without the doomed upstream
  call once that exact header has been refused, a caller's own key is still
  tried, and the header `movies.html` ships still matches the server's
- `node tools/playtime-test.js` - playtime timing: it accrues only while the
  tab is visible, banks a sitting when you switch games, keeps one session
  across a reopen, drops sub-second deltas, never exceeds the four-hour
  segment cap, survives a corrupt store and prunes itself past 500 keys
- `python tools/clicker-test.py` - the auto clicker panel: the matcher arms
  every catalog game whose title or URL says clicker (and nothing else), and
  the shipped player still wires CPS presets, mouse and spacebar beats, the
  hotkey, the jitter slider, the live Settings switch and close-time teardown.
  Also pinned: rate units (/sec, /min, /hr with conversion), the 500/s burst
  ceiling, left/middle/right buttons carrying real `button` numbers and
  `buttons` bitmasks, and the duty cycle that holds the button down for a
  share of each beat on both mouse and spacebar
- `node scripts/build-single-chalkle.mjs` (+ `--cdn`) - regenerate the two
  single-file builds after any source change
- Bump the `?v=` cache version in `index.html` (and rebuild) every release

## Yut's upload site (yut.lootline.xyz)

yut/ holds a standalone page where yut uploads HTML pages and .txt link lists
with the shared code (yutforyut25). The same server hosts it at /yut/ and on
the yut.lootline.xyz subdomain (host split in serve-chalk.py, same trick as
the jexel/ hub). The API lives in serve-chalk.py: /yut/api/list, upload,
file/<id>, download/<id> and remove. Uploads are stored in yut/store/ on the
server disk and are gitignored; the store is never served as a static path.

deploy-static/yut/ mirrors the page so static mirrors show the gallery read
only (uploads need the relay server).

## Sections

| Section | Data file |
| --- | --- |
| Games | `webports.js` (wasm.rip ports) + `src/games.js` (Chud import) |
| Music | `src/music.js` (full player, relay-resolved streams) |
| Apps/Tools | `src/apps.js` |
| Proxies | `src/proxies.js` seeds, editable in-app, saved to localStorage |
| Cloud Gaming | `src/cloudgames.js` (Stratus catalog import) + `src/cloud.js` |

## Cloud gaming

Games stream from a Stratus API server. The browser only ever talks to this
site: serve-chalk.py relays `/cloud/v1/*` to the Stratus backend, injects the
API key, and tunnels the WebRTC signaling websocket, so there is no CORS,
mixed content, or key in the page.

Run the vendored Stratus API on this machine:

```
cd stratus-api
bun i
taskkill //F //IM node.exe 2>/dev/null; bun api.js
```

The Cloud settings panel points the relay at a loopback URL (default
`http://localhost:3001`) and stores it in `cloud-relay.json`. Regenerate the
catalog from a Stratus cloud.json:

```
node tools/import-stratus.mjs <path-to-cloud.json>
```

## Web ports

`webports.js` holds 29 full PC game ports from wasm.rip with cover art,
descriptions, and porter credits. All URLs were verified live.

## Games from Chud

`src/games.js` holds the working games (absolute URLs) imported from Chud's list.
Regenerate it anytime the source changes:

```
node tools/import-chud.mjs <path-to-chud-games.js>
```

## Local builds not in the catalog

`ugs/` and `gn/` hold the locally hosted builds. `src/ugs-games.js` lists the
ones the catalog never mentioned, each with a generated cover tile. Rerun the
scanner after adding builds instead of editing the list by hand:

```
python tools/add-ugs-games.py             # write the list + cover tiles
python tools/add-ugs-games.py --dry-run   # report only
python tools/add-ugs-games.py --why "no usable name"   # show what it skipped
```

## The offline Unsent Project app (`/unsent.html`)

A single-file rebuild of theunsentproject.com, listed in the Apps/Tools tab.
`unsent-src/` holds its sources: the site's own stylesheet, card template,
logos and post snapshot, plus the shell markup and the app logic ported from
the captured bundle. `tools/build-unsent-app.py` inlines all of it into
`unsent.html` and mirrors it into `deploy-static/`:

```
python tools/fetch-unsent-archive.py head    # recent pages of the archive
python tools/fetch-unsent-archive.py extra   # one page per colour, deep seeks
python tools/build-unsent-app.py             # write unsent.html
python tools/build-unsent-app.py --check     # is the committed copy current?
```

The page makes no network requests at all (its API is CORS-locked to the
original origin, so the posts ship inside the file), which is why the checker
exempts the single `window.__TUP_POSTS__=` data line: that text is
user-submitted, not ours.

## Real game art

`tools/real-shots.js` boots a local build headless and saves a real in-game
frame to `assets/games/real/`. The library swaps its generated cover for that
capture at seed time. `tools/real-shots-index.py` rewrites the index app.js
reads, covering every capture on disk (JPEG and WebP alike):

```
python tools/real-shots-index.py
```

## Music

The Music tab streams full-length songs through the relay (netease-compatible
backend in `music-backend/`, YouTube fallback):

- Search, trending, favorites, and local-file uploads
- Streams resolved server-side, byte-verified before playback
- Queue with shuffle, repeat (off / all / one), seek, volume, live equalizer
- Favorites, volume, and modes persist per device

## Add real games

Each data file exposes a global array, e.g.:

```js
window.ChalkGames = [
  {
    title: "Example Game",
    url: "https://example.com/play",
    thumb: "images/example.png",
    playing: 18,
    isNew: true
  }
];
```

- `thumb`: optional, 16:9 image. Omit it and a flat letter tile renders instead.
- `playing`: optional live count. Omit it if you do not have real data. An empty stat stops clicks.
- `isNew`: optional, shows the "new this week" corner ribbon.

## Proxies

The Proxies tab ships seeded with Ultraviolet, Scramjet, Rammerhead, Nebula,
Interstellar and Womginx. Each needs a URL from a deployment you host; see
`PROXIES.md`. URLs are stored per-device in localStorage, never hardcoded into
the page.

## Design tokens

One system for every view (`:root` in `src/styles.css`, canonical names with
legacy aliases):

- Surfaces: warm near-black chalk (`--bg #0d0c0a`, `--bg-elevated`, `--surface`,
  `--surface-hover`, `--surface-active`)
- Borders: `--border`, `--border-soft`, `--border-strong` (1px, no glow)
- Text: `--text`, `--text-secondary`, `--text-muted`
- Accent: chalk green `--accent #4cc56f` + `--accent-soft` (one primary accent)
- Semantic: `--danger`, `--success`, `--warning`
- Section hues (`--blue`, `--magenta`, `--cloud`, ...) are identity-only:
  active nav bar, active chips, tiny icon tints. Never page backgrounds.
- Typography: Boogaloo wordmark only; Space Grotesk headings; system UI;
  mono for tiny retro accents (kbd, labels, notes)
- Flat fills only. No gradients, no glow, no per-page backgrounds.
- Settings persist to localStorage: reduce motion, card size, sidebar state,
  cloak, tab cloak choice.

## Files

- `server/serve-chalk.py` static server + relay (YouTube, music, AI, Live TV, cloud,
  /uv/ proxy) - the single backend for the whole site
- `index.html` shell: top bar with search, sidebar nav, main views, overlays
- `src/styles.css` all styling, responsive sidebar and drawer
- `src/app.js` rendering, search, nav, cloak, admin panel, proxy list, recents
- `src/launcher.js` new-tab launcher with proxy routing and in-app frame fallback
- `src/browser.js` in-app tabbed browser (ChalkleBrowser): tabs, back/forward, address bar, new-tab page, loading/error states, fullscreen
- `browser.html` standalone tabbed browser (Apps/Tools → Browser), routes every page through the built-in /uv/ proxy
- `src/music.js` / `src/youtube.js` / `src/livetv.js` / `src/ai.js` view modules (relay-backed)
- `src/games.js` / `sites.js` / `src/apps.js` / `webports.js` / `src/cloudgames.js` data
- `src/gamepad.js` controller navigation: d-pad cursor over the grids, A/B/LB/RB/Start
- `sw.js` service worker: offline shell, versioned asset cache, chunked game parts
- `src/runtime-config.js` mirror/static-mode API root resolution
- `scripts/build-single-chalkle.mjs` single-file build (local + CDN variants)
- `tools/checker.py` + `scripts/audit.mjs` + `tools/sw-test.js` quality gates
