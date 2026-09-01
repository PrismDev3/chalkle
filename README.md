# Chalkle

A fast, flat, dark game launcher: games, music, apps/tools and proxies. No framework, no build step, no fake content.

## Features

- Bubble wordmark (Boogaloo) with Google colors, the one brand moment
- Card grid with hover play button and live counts
- Proxies tab with in-app frame or new-tab mode, saved per device
- Settings: reduce motion, card size, clear saved proxies
- Keyboard: Ctrl/Cmd+K to search, Alt+1..5 to jump sections, Space toggles music, Esc to close overlays
- Topbar search routes into music search on the Music tab
- Launcher: every game opens via a picker with Direct, About:blank, Blob, This tab, or Proxy
- Settings: ask-on-launch toggle, default open method, cloak tab title
- Apps/Tools: URL cloaker and a live HTML editor with syntax highlight, preview, open/download/copy/upload/reset
- Boot intro: game-station splash with letter build, boot log, progress bar, skippable and motion-safe

## Run

Open `index.html` in any browser. Works from a Chromebook with nothing installed.

## Playtest

Run `node audit.mjs` to statically verify every screen state: duplicate ids, JS-to-HTML id wiring, script assets, and hidden/display conflicts.

## Sections

| Section | Data file |
| --- | --- |
| Games | `webports.js` (wasm.rip ports) + `games.js` (Chud import) |
| Music | `music.js` (full player, live mirrors) |
| Apps/Tools | `apps.js` (create it) |
| Proxies | `proxies.js` seeds, editable in-app, saved to localStorage |
| Cloud Gaming | `cloudgames.js` (Stratus catalog import) + `cloud.js` |

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

`webports.js` holds 29 full PC game ports from wasm.rip with cover art, descriptions, and porter credits. All URLs were verified live. genizy/web-port's builds have no reachable host right now (jsDelivr blocked the account, no Pages, gn-math repo is dead), so they are not hardcoded in until a working host exists.

## Games from Chud

`games.js` holds the 327 working games (absolute URLs) imported from Chud's list. They render after the web ports on the Games tab. Regenerate it anytime the source changes:

```
node tools/import-chud.mjs <path-to-chud-games.js>
```

The rest of Chud's entries use relative files that are not in the Chud repo, so they are kept commented out at the bottom of `games.js` and stay out of the grid until the `games/` folder exists here.

## Music

The Music tab streams full-length songs from public mirrors, no server and no accounts:

- Search, trending, favorites, and local-file uploads
- Streams resolved through rotating Piped instances, byte-verified before playback, Invidious as fallback
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

The Proxies tab ships seeded with Ultraviolet, Scramjet, Rammerhead, Nebula, Interstellar and Womginx. Each needs a URL from a deployment you host; see `PROXIES.md`. URLs are stored per-device in localStorage, never hardcoded into the page.

## Design tokens

- Base: near-black charcoal `#14161a`
- Panels: dark slate `#1d2026`
- Accent: Google green `#34a853`, active states, hovers, live counts only (with blue/yellow/red for sections and stats)
- Wordmark: Boogaloo bubble letters in Google colors (the only brand moment)
- Headings: Space Grotesk. UI: system fonts.
- Flat fills only. No gradients, no glow, no shadows.
- Settings persist to localStorage: reduce motion, card size, sidebar state.

## Files

- `index.html` shell: top bar with search, sidebar nav, main views, proxy overlay
- `styles.css` all styling, responsive sidebar and drawer
- `app.js` rendering, search, nav, options, proxy list and overlay, HTML editor
- `launcher.js` direct / about:blank / blob / iframe / proxy opening
- `games.js` / `proxies.js` data
- `PROXIES.md` hosting guide