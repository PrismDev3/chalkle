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
- Boot intro (skippable, motion-safe), themes, wallpapers, cursors, reduce
  motion

## Run

```
python server/serve-chalk.py
```

Then open http://127.0.0.1:4173. The relay on the same port backs the YouTube,
music, AI, Live TV and cloud features; static mirrors (GitHub Pages) route
those calls to `chalkle.lootline.xyz` instead (see `src/runtime-config.js`).

## Playtest / audit workflow

- `node scripts/audit.mjs` - static checks: duplicate ids, JS-to-HTML id wiring,
  script assets, hidden/display conflicts, nav wiring
- `python tools/checker.py` - copy/style gate: dashes, AI vocab, gradients
- `node scripts/build-single-chalkle.mjs` (+ `--cdn`) - regenerate the two
  single-file builds after any source change
- Bump the `?v=` cache version in `index.html` (and rebuild) every release

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

- Base: near-black charcoal `#14161a`
- Panels: dark slate `#1d2026`
- Accent: Google green `#34a853`, active states, hovers, live counts only (with blue/yellow/red for sections and stats)
- Wordmark: Boogaloo bubble letters in Google colors (the only brand moment)
- Headings: Space Grotesk. UI: system fonts.
- Flat fills only. No gradients, no glow, no shadows.
- Settings persist to localStorage: reduce motion, card size, sidebar state,
  cloak, tab cloak choice.

## Files

- `server/serve-chalk.py` static server + relay (YouTube, music, AI, Live TV, cloud,
  /uv/ proxy) - the single backend for the whole site
- `index.html` shell: top bar with search, sidebar nav, main views, overlays
- `src/styles.css` all styling, responsive sidebar and drawer
- `src/app.js` rendering, search, nav, cloak, admin panel, proxy list, recents
- `src/launcher.js` new-tab launcher with proxy routing and in-app frame fallback
- `src/music.js` / `src/youtube.js` / `src/livetv.js` / `src/ai.js` view modules (relay-backed)
- `src/games.js` / `sites.js` / `src/apps.js` / `webports.js` / `src/cloudgames.js` data
- `src/runtime-config.js` mirror/static-mode API root resolution
- `scripts/build-single-chalkle.mjs` single-file build (local + CDN variants)
- `tools/checker.py` + `scripts/audit.mjs` quality gates
