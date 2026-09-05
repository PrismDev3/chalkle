# Chalkle Site Reference

A literal, end-to-end description of the Chalkle site: what it looks like, how it
runs, what every route and view does, and how it stays reachable on school
networks. This is a description of the code as it exists today, not a plan.
Line numbers and counts were verified against the source on 2026-09-05.

---

## 1. What the site is

Chalkle is a single-page game launcher and media hub:

- **No framework, no build step for the dev site.** Plain HTML + JavaScript
  modules (IIFEs), one big CSS file, one Python static server.
- **No accounts, no sign-in.** Everything personal lives in the browser's
  localStorage on the device.
- **14 views** reached from the sidebar: Home, Games, Cloud, Music, Apps/Tools,
  Proxies, Sites, AI, Docs, Partners, Board, Live TV, YouTube, Settings.
  Bookmarklets is a 15th tab shown via the "More" menu.
- **One backend**: `server/serve-chalk.py` is both the static file server and
  the relay that backs music, YouTube, AI, Live TV, cloud gaming, and the
  built-in proxy. Static mirrors (GitHub Pages, jsDelivr) point their API calls
  at `https://chalkle.lootline.xyz` instead (see `src/runtime-config.js`).

---

## 2. How it looks

### 2.1 Design tokens (from README + styles.css)

| Token | Value | Used for |
| --- | --- | --- |
| Base | `#14161a` near-black charcoal | page background |
| Panels | `#1d2026` dark slate | cards, surfaces |
| Accent | `#34a853` Google green | active states, hovers, live counts |
| Wordmark | Boogaloo bubble letters in Google colors | the only brand moment |
| Headings | Space Grotesk | titles |
| Body | system fonts | everything else |
| Fills | flat only | no gradients, no glow, no shadows |

Each sidebar tab also has its own accent color (see 2.4). The music tab
redesign and the per-tab identity pass kept this palette; music uses
pink/magenta (`#e60073`), cloud uses sky blue (`#5fbeff`), and so on.

### 2.2 Boot sequence (what a visitor sees first)

1. **Page head** serves the IXL shell: title, description, favicon, and a full
   rendered IXL landing page (`#ixl-cover`) so crawlers and link previews see a
   K-12 learning site. A tiny inline script removes the cover before real
   visitors paint it.
2. **Blocked cloak**: a full-screen "blocked by your school" overlay
   (`assets/cloak-blocked.webp`, the exact filter screenshot) covers the page.
   One click or Enter/Space fades it out and fires `chalkle-cloak-dismissed`.
3. **Boot intro** (`src/intro.js`): a 2.4 s game-station boot ("insert
   cartridge: chalkle-1.0", progress bar, skippable, respects
   `prefers-reduced-motion`). Plays once per session, then lands on Home.
4. **Home view**: hero with the bubble wordmark, kicker ("No sign-in. Just
   play."), headline, trust note, action buttons (Browse games / Open Music /
   Tools), a "Quick launch" row of category cards, a "Your shelf" surface with
   live game/site/tool counts, and the featured Minecraft banner below the hero.

### 2.3 Chrome (topbar + sidebar)

- **Topbar**: wordmark left, center search box (Ctrl/Cmd+K focuses it) with a
  live results dropdown covering games, sites, tools, and music, then a local
  clock and an "X online now" viewer pill on the right. The pill pings
  `/_active` and skips pinging while the tab is hidden.
- **Sidebar**: nav buttons for every view, a "More" overflow menu for the
  long tail (Proxies, AI, Docs, Partners, Board, Live TV, YouTube,
  Bookmarklets), and a bottom block with Settings. The sidebar collapses on
  small screens into a drawer.

### 2.4 Per-tab colors

Every view gets one accent color used in its sidebar entry, its heading
letters, and its backdrop so nothing borrows another tab's look:

| View | Accent | View | Accent |
| --- | --- | --- | --- |
| Home | pink `#ff4d8d` | Docs | cyan `#26c6da` |
| Games | green `#34a853` | Partners | sand `#d8a368` |
| Cloud | sky blue `#5fbeff` | Board | orange `#fb8c00` |
| Music | pink `#e60073` | Live TV | mint `#4ab88c` |
| Apps/Tools | yellow `#fbbc05` | YouTube | red `#ff0033` |
| Proxies | teal `#12b5a5` | AI | violet `#b06bff` |
| Sites | blue `#4285f4` | Bookmarklets | lime `#b7e63f` |
| Settings | purple `#a970ff` | | |

Headings render as bubble letters in the tab's accent via
`TITLE_COLORS` in `src/app.js`.

### 2.5 The views

- **Home** (`index.html` ~line 476): hero, quick launch, shelf metrics,
  featured Minecraft banner (`#home-featured`), Editor's Picks.
- **Games** (~571): search + genre chips, sort, favorites, recents, "New this
  week" ribbons, card grid with 16:9 thumbnails (raster captures for local
  games via `src/real-shots.js`, letter tiles as fallback), live "playing"
  counts, launch chooser.
- **Cloud** (~638): Stratus cloud gaming catalog, sessions streamed through
  the relay (see 4.3), its own navy backdrop.
- **Music** (~749): Spotify-style home (greeting, recently played, hero,
  horizontal sections), search, and a persistent bottom player with queue,
  shuffle, repeat, seek, volume, favorites, lyrics, speed/pitch, equalizer.
- **Apps/Tools** (~836), **Proxies** (~848), **Sites** (~723): card grids,
  each launchable.
- **AI** (`#ai-view`, rendered by `src/ai.js`): chat with model list, streaming
  replies, file attachments, saved conversations (backed by `ai_convos.json`).
- **Docs / Partners / Board**: admin-editable in-app content, code-gated.
- **Live TV** (~669): HLS sports channels with match/posters via
  `/api/livetv/*`.
- **YouTube** (~694): search, trending, channel browsing, and a player that
  opens tracks through the relay.
- **Settings** (~981): appearance (colors, quick themes, wallpaper, cursor),
  display (reduce motion, card size, clock), behavior (cloak title, quick
  disguise grid), cloud config, advanced (saved proxies, backup export/import,
  reset, debug info), admin.

### 2.6 Settings and persistence

Everything personal is per-device, stored under `chalkle-*` keys in
localStorage: cloak choice, custom colors/wallpaper/cursor, card size, motion,
clock settings, favorites, recents, saved proxies, cloud relay config
(`cloud-relay.json`), boot-seen flag (sessionStorage). Export/Import in
Advanced backs it all up as JSON.

---

## 3. How it runs

### 3.1 The server

`server/serve-chalk.py` is a `ThreadingHTTPServer` on `127.0.0.1:4173`
(port is hardcoded; `HOST`/`PORT` at the top of the file). It serves the
repository folder as static files and adds the routes below. It also registers
the `application/wasm` MIME type for ScummVM builds.

### 3.2 Route table (all same-origin, so no CORS)

| Route | What it does |
| --- | --- |
| `/_active?s=<visitor_id>` | Registers a visitor, returns the count of distinct visitors who pinged in the last 20 s (the "online now" pill) |
| `/_fetch?url=<encoded>` | Server-side fetch of a target URL, returns its real HTTP status. Backs the URL Auditor |
| `/_sync` (GET/POST) | Library sync for saved game libraries across devices |
| `/_dhinfo`, `/_dhcheck`, `/_dhdns`, `/_dhgeo` | Domain Hub lookups (info, reachability, DNS, geo) |
| `/_cherri` | Pixel/cherri endpoint |
| `/uv/` and `/uv/<base64url(target)>` | Built-in rewriting proxy (see 5.4). WebSocket upgrades are tunneled through |
| `/cloud/health`, `/cloud/config`, `/cloud/v1/*` | Stratus cloud gaming relay; injects the API key server-side, tunnels the signaling WebSocket |
| `/music/health`, `/music/api`, `/music/stream`, `/music/pic` | Music relay: search/url/lyric/pic to the backend, Range-capable stream proxy (seek needs 206), art proxy |
| `/yt/search`, `/yt/trending`, `/yt/thumb`, `/yt/channel/<id>` | YouTube search/trending/thumb/channel via Piped/Invidious, thumbnails rewritten to the same origin |
| `/api/ai/models`, `/api/ai/chat`, `/api/ai/convos` | AI model list, streaming chat, saved conversations |
| `/api/livetv/sports`, `/api/livetv/matches`, `/api/livetv/img/<token>`, `/api/live-tv`, `/api/live-tv/<id>`, `/api/live-tv/admin` | Sports channel lists, match data, posters, HLS stream proxy, admin raw/save |
| everything else | `SimpleHTTPRequestHandler` static files |

### 3.3 Music and YouTube stream resolution

- **Music**: `/music/api?server=youtube&path=search|url|pic|lyric` resolves
  tracks server-side and rewrites every media URL to `/music/stream?u=...` and
  `/music/pic?u=...`, so the page only ever talks to this origin. Stream URLs
  are byte-verified before playback. Failures are bounded: Piped calls are
  capped (~10 s, 1 retry), the Invidious fallback races instances in parallel
  under a deadline, and empty results are cached so a dead track skips
  instantly on replay. The client (`src/music.js`) keeps a per-track load
  token and a 20 s abort timer so a stalled track toasts and auto-advances
  instead of wedging the queue.
- **YouTube**: the same pattern through `/yt/*`, thumbnails proxied to
  `/yt/thumb` so hotlinks never leak.

### 3.4 Static mirrors and the relay fallback

`src/runtime-config.js` decides the API root:

- Served by the real backend: root is `""`, everything is same-origin.
- Static mirrors (GitHub Pages, jsDelivr, githack, unpkg, GitLab Pages, or
  `file://`): API calls go to `https://chalkle.lootline.xyz` (overridable via
  `<meta name="chalkle-api-root">` or `window.CHALKLE_API_ROOT`), so cloud,
  music, Live TV, AI, and the proxy still work on a mirror.
- A root-absolute asset fix rewrites leading-slash URLs for subpath mirrors.

### 3.5 The single-file build

`scripts/build-single-chalkle.mjs` concatenates every script into
`build/chalkle-single.html` and a CDN-safe `build/chalkle-single-cdn.html`
variant. It also:

- Embeds self-contained local games (`/ugs/`, `/gn/`, `/mc/`, `/game-builds/`
  HTML files up to 512 KB) as base64 data URIs into a
  `window.__SINGLE_GAMES__` map, plus the random-gaming and Arctic thumbnails.
  Verified: 1,020 games embedded; the file runs from a USB stick or any static
  host with zero external game links.
- Injects a client patch so embedded games' `/game-builds/` fetches resolve
  against the map.
- Root mirror copies (`chalkle-single.html`, `chalkle-single-cdn.html` at the
  repo root) are synced byte-identical for the GitHub/jsDelivr mirror links.

`src/launcher.js` resolves embedded URLs at launch time: if a game URL exists
in `__SINGLE_GAMES__`, it opens the data URI instead of a path that 404s on
static hosting.

### 3.6 Deployment targets

1. **Cloudflare tunnel / lootline.xyz**: `python server/serve-chalk.py` behind
   a tunnel; the full site including local `ugs/`/`gn/`/`mc/` game folders.
2. **GitHub Pages** (`.github/workflows/pages.yml`): pushes the tracked
   multi-file site on every push to main; gitignored game folders are not
   included, so the single-file build carries the games there.
3. **jsDelivr / GitHub mirror links**: point at the root single-file copies.
4. **Local / USB**: the single-file build opens from `file://`.

### 3.7 Release workflow and quality gates

- `node scripts/audit.mjs`: static checks (duplicate ids, JS-to-HTML id
  wiring, script assets, hidden/display conflicts, nav wiring).
- `python tools/checker.py`: copy/style gate (em dashes, AI vocab, gradients).
- `node --check` on every JS file, `python -m py_compile` on the server.
- Bump the `?v=` cache version in `index.html` and rebuild the single-file
  builds on every release.

---

## 4. The data

| Catalog | File | Count |
| --- | --- | --- |
| Games (Chud import) | `src/games.js` | ~2,530 entries |
| Community games | `src/community-games.js` | 6 |
| PC web ports (wasm.rip) | `src/webports.js` | 29 |
| Local game folders | `ugs/`, `gn/`, `mc/`, `game-builds/` | ~1,900 local HTMLs (gitignored, served from disk on the tunnel) |
| Real thumbnail captures | `assets/games/real/*.jpg` | 96, wired via `src/real-shots.js` manifest |
| Cloud gaming | Stratus catalog (via `tools/import-stratus.mjs`) | hundreds of streaming titles |
| Sites | `src/sites.js` | ~80 |
| Apps/Tools | `src/apps.js` | ~31 |
| Proxies | `src/proxies.js` seeds, saved per-device | 6 open-source proxy apps |

Thumbnails: raster captures replace generated SVG covers at seed time for
local games; games without art get a flat letter tile. All card images are
`loading="lazy" decoding="async"`.

---

## 5. How it stays reachable (the access mechanisms)

This section documents what the code actually does today. It is a
description, not a how-to for new evasion.

### 5.1 IXL shell for crawlers and previews

- The page `<head>` carries IXL metadata and the body renders a full IXL
  landing page inside `#ixl-cover`, removed by a synchronous script before a
  real visitor paints. Link previews (Discord, SMS, scanners) see a K-12
  learning site.
- With no tab cloak selected, the tab keeps the IXL title, so what a preview
  promised and what the tab shows always agree.

### 5.2 "Blocked by your school" cover

`#blocked-cloak` is a full-screen overlay using the exact filter-block
screenshot (`assets/cloak-blocked.webp`). It looks like a real block page; one
click dismisses it. A glance at the screen reads as "filtered", not "games".

### 5.3 Tab cloak (Settings > Quick disguise)

`ChalkleCloak` swaps the tab title and favicon to one of: Google, Classroom,
Google Docs, Drive, Canvas, Clever, Khan Academy, IXL, or None (which restores
the IXL look). Choice persists in localStorage. New tabs launched by the site
inherit the active cloak title.

### 5.4 The built-in `/uv/` proxy

`serve-chalk.py` ships a rewriting proxy at `/uv/<base64url(target)>`:

- Fetches the target server-side, rewrites HTML/CSS so every URL flows back
  through `/uv/`, strips CSP and `X-Frame-Options`, and injects a client patch
  for fetch/XHR/WebSocket/history.
- Everything comes from the same origin, so there is no separate domain for a
  filter to block, and the route never goes stale the way a temp tunnel does.
- `src/launcher.js` probes `/uv/` at boot (with retries, remembering success
  per session) and only advertises it when it really answers. On static
  mirrors it falls back to a configured proxy URL; dead stub URLs
  (`your-proxy` placeholders) are never used.

### 5.5 The launcher (how things open)

`src/launcher.js` decides how each item opens:

- **Local same-origin pages** (`/ugs/`, `/gn/`, `/mc/`, `/game-builds/`,
  blob/data) open top-level on this origin.
- **Unity WebGL builds** stay on a real origin because they resolve relative
  assets against the document base.
- **Everything external** opens in a fresh `about:blank` window: a system
  page, so screen-capture monitoring cannot see or flag the tab. The blank
  document carries the active cloak title/icon and a full-viewport
  no-referrer iframe.
- **Popup blocked?** The item falls back to the in-app frame overlay on this
  page with a back button.

### 5.6 Panic key

Pressing `` ` `` three times quickly (or Ctrl+Shift+`) from anywhere, under
any cloak, instantly replaces the tab with Google Classroom.

### 5.7 Local games instead of external links

The catalog prefers local HTML games over third-party links: 1,900+ game files
live in `ugs/`/`gn/`/`mc/`/`game-builds/` and are served from this origin, and
the single-file build embeds 1,020 of them as data URIs so static mirrors and
the GitHub-hosted build have no external game links to block. High-confidence
external links in `games.js` have been swapped to local equivalents (Snow
Rider, Bullet Force, Riddle School, Celeste, and others). The James Edition /
Minecraft featured entry points at the local self-contained
`/mc/eaglercraft-26.2.html` client (75 MB, zero external refs) instead of a
dead tunnel.

### 5.8 Proxies tab

Seeded with Ultraviolet, Scramjet, Rammerhead, Nebula, Interstellar, and
Womginx. Each needs a URL from a deployment the user hosts (documented in
`docs/PROXIES.md`); URLs live in localStorage, never hardcoded. Items open in
a full-screen in-app frame or a new tab.

### 5.9 Mirrors and tunnels

The site runs on a Cloudflare quick tunnel (anycast edge), the registered
domain `lootline.xyz`, GitHub Pages, and jsDelivr mirrors simultaneously;
`runtime-config.js` keeps every copy functional by routing server-backed
calls to the relay.

### 5.10 Honest limits (why it still gets blocked sometimes)

- **Tunnel domain reputation**: free `trycloudflare.com` domains are shared
  infrastructure heavily used by malware, so some filters rate the domain
  "Malicious" or "Filter Avoidance" regardless of content. A registered domain
  that ages and accumulates traffic rates better.
- **Unrated/Uncategorized/New URL**: these entries mostly resolve with time
  and traffic, not code changes.
- **Content-based flags** (Games, Proxy & VPN, Anonymous proxies): filters
  that read the actual content will keep flagging a games/proxy portal no
  matter what the shell says.
- Known residual console noise: Cloudflare beacon CORS/integrity messages and
  ad-network 404s are external to this site's code.

---

## 6. File map

| Path | Role |
| --- | --- |
| `index.html` | Shell: head (IXL metadata, cloak, panic key), cover, topbar, sidebar, all view sections, overlays, script order |
| `src/styles.css` | All styling (~10k lines), responsive sidebar/drawer, per-tab identity |
| `src/app.js` | Boot, nav, search, rendering, cloak, recents/favorites, per-tab colors, admin, viewer pill |
| `src/launcher.js` | Open logic: direct / about:blank / frame / proxy / embedded |
| `src/theme.js` | Theme, wallpaper, cursor, motion |
| `src/music.js`, `src/youtube.js`, `src/livetv.js`, `src/ai.js`, `src/cloud.js`, `src/cloudgames.js` | View modules (relay-backed) |
| `src/games.js`, `src/community-games.js`, `src/real-shots.js`, `src/webports.js`, `src/sites.js`, `src/apps.js`, `src/proxies.js` | Data catalogs |
| `src/intro.js` | Boot intro |
| `src/sync.js` | Library sync |
| `src/editor.js`, `src/urlauditor.js`, `src/pixel.js`, `src/domainhub.js`, `src/bookmarklets.js`, `src/docs.js`, `src/partners.js` | Tools and admin panels |
| `src/runtime-config.js` | Mirror detection and API root |
| `server/serve-chalk.py` | Static server + every relay route |
| `scripts/build-single-chalkle.mjs` | Single-file builds |
| `scripts/audit.mjs`, `tools/checker.py` | Quality gates |
| `.github/workflows/pages.yml` | GitHub Pages deploy |
| `docs/` | PROXIES.md, TRIAGE.md, OVERHAUL.md, audits/ |