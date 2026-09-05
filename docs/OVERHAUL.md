# Chalkle Overhaul — audit + roadmap

Status of every item from the overhaul wishlist, checked against the live code
on 2026-09-03. Legend:

- **DONE** — shipped (quick-win pass, or the later feature batches).
- **ALREADY** — exists in the product already (the wishlist was partly stale).
- **P1 / P2 / P3** — queued work, roughly by impact ÷ effort. P1 = biggest
  win for the smallest, safest change.

---

## Core UX / navigation

| # | Item | Status | Notes / plan |
|---|------|--------|--------------|
| 1 | Arctic/Cherri duplicate-looking cards | DONE | The 10 Arctic URLs are byte-identical loader files (same md5), so real per-instance captures are impossible. Shipped: "Arctic Mirror 1–10" labels + numbered badge thumbnails (arctic-1.jpg…), Cherri likewise; per-device saved libraries migrated by URL prefix. GNMath/Cloudmoon/Zaka share the same look and can get the same badge treatment on request. |
| 2 | Truncated titles | DONE | Card titles now wrap to 2 lines (CSS line-clamp); full title + URL tooltip already existed. Check row-based views still look right in Chrome/Edge + Safari. |
| 3 | Sidebar bottom dead space | P3 | Redesign. Ideas: persist mini music player there, or a compact "quick stats" widget. Larger layout decision. |
| 4 | "More" (All tabs) mystery bucket | P1 | It already promotes via the Home "All tabs" menu. Top-level slots exist for every destination in the sidebar; consider reordering sidebar by usage once real analytics exist. Low urgency. |
| 5 | Breadcrumbs / back-to-category | P3 | Single-page tabs make this mostly moot; worth adding only if deep filter states become shareable. |
| 6 | Search autocomplete/recent | ALREADY | Ctrl+K + live results dropdown exists and works (renders results as you type). Enhancement: show recent + suggested on empty focus. |
| 7 | Card sizing consistency | P2 | Standardize via aspect-ratio on .card-thumb across Games/Sites/Cloud; visual pass only. |

## Home page

| # | Item | Status | Plan |
|---|------|--------|------|
| 8 | "Continue playing" clipping | DONE | Row has scroll-snap + arrows; right edge now gets a gradient fade while more cards are reachable, lifting when the strip hits the end. |
| 9 | Stat cards clickable | DONE | The 4 metric cards are buttons → jump to Games/Sites/Apps. |
| 10 | "0 saved" first impression | DONE | Saved metric is hidden until the user has favourites. |
| 11 | Hero trust blurb | DONE | "No accounts. No downloads. Nothing tracked…" under the tagline. |

## Games / Cloud

| # | Item | Status | Plan |
|---|------|--------|------|
| 12 | Editor's Picks / Staff Favorites | DONE | Curated 8-card shelf on Home + top of Games; edit PICK_TITLES in app.js. |
| 13 | "0 clicks" embarrassment | DONE | Click counter hidden until a card has ≥1 click. |
| 14 | Cloud broken thumb placeholder | P1 | Give .thumb-letter fallback real art (gradient + glyph) instead of a bare letter; also fetch real favicons as a second fallback for cloud titles. |
| 15 | Genre multi-select | P2 | Extend the existing single-tap filter chips to AND-stacking; needs a small state refactor of renderGrids. |
| 16 | Sort by newest/rating | P2 | Sort select already exists on Sites and Docs ("Newest"); add same control + rating sort to Games using existing popularity/count data. |
| 17 | Cloud latency/server load | P3 | Requires the Stratus relay to expose per-stream stats; backend work, not a UI tweak. |

## Sites

| # | Item | Status | Plan |
|---|------|--------|------|
| 18 | Arctic/Cherri duplicates | DONE | See #1 — labelled + numbered badge thumbs. |
| 19 | Real screenshots per instance | DONE | Arctic/Cherri live-captured + badged (Cherri hub backend currently renders blank, so it uses its last good capture). |
| 20 | Per-site uptime/status | P2 | Server-side HEAD checks through serve-chalk.py (browser can't cross-origin check); show a live dot per mirror. Pair with #21. |

## Proxies

| # | Item | Status | Plan |
|---|------|--------|------|
| 21 | Live health/latency | P2 | Same server-side checker as #20; badge "Ready" → real "up · 120ms". |
| 22 | Default proxy pinning | P2 | "Make default" per proxy row (localStorage); liveProxy() already prefers an explicit default before first-configured. |
| 23 | c0mrade attribution | P1 | Link the credit to a partner/contributor entry (Partners model already supports links). |

## Apps/Tools

| # | Item | Status | Plan |
|---|------|--------|------|
| 24 | PROXY badge meaning | DONE | All via-proxy apps share one mechanism (school-filter bypass), but the reasons differ: walled socials/streaming keep the orange pill; plain bypass targets (GitHub, Chess) get a blue pill with reason-specific tooltips. |
| 25 | Search/filter within Tools | P2 | Reuse the Games category-chip pattern on the Tools grid. |
| 26 | Emulator ROM disclaimer | DONE | Ruffle/N64/Azahar tiles each carry a note ("bring your own .swf"/".z64"/ROM). |

## Music

| # | Item | Status | Plan |
|---|------|--------|------|
| 27 | "real songs, netease" clarity | DONE | Meta now says "stream any song · built-in player" with an explanatory tooltip (backend is this site's relay, not netease CDN). |
| 28 | Queue / mini-player | ALREADY+ | Full player with queue, shuffle/repeat, lyrics, speed/pitch exists. Gap: it is not persistent across tabs → P2 sidebar mini-player. |
| 29 | Genre/mood browse + playlists | P3 | Charts exist; add curated playlists built from existing queue mechanics. |

## Live TV / YouTube

| # | Item | Status | Plan |
|---|------|--------|------|
| 30 | TV filter row wrapping | DONE | Single-line nowrap strip with hidden-scrollbar overflow scrolling. |
| 31 | Favourites / pinned channels | P2 | Reuse the existing favourites key/value store for channels. |
| 32 | YouTube vs Live TV positioning | DONE | YouTube meta: "search or play any video — on demand, not the Live TV feed"; Live TV fallback meta: "curated live channels". |

## AI

| # | Item | Status | Plan |
|---|------|--------|------|
| 33 | "107 models online" trust | DONE | Meta now shows "N models online · checked HH:MM" + tooltip explaining it's this site's relay. |
| 34 | System prompt / personas | P2 | Add per-conversation system-prompt box stored on the convo; enables shareable custom bots later. |
| 35 | Image-gen separated | P2 | Split model list by capability once the relay exposes capabilities. |

## Docs

| # | Item | Status | Plan |
|---|------|--------|------|
| 36 | List previews / tags | P2 | Show category + sample entries under each link-list card. |
| 37 | Search across docs | P2 | Global search already merges docs entries; add full-text list search. |
| 38 | Verification timestamps | P2 | Store "last checked OK" on each doc (relay can HEAD the first N links). |

## Board / Partners

| # | Item | Status | Plan |
|---|------|--------|------|
| 39 | Empty "Open spots" | DONE | Empty tiers render a styled Apply here button that opens the Discord invite. |
| 40 | Board bios/roles | P2 | Add role/description fields to the Board data. |
| 41 | Partners Live vs Coming soon | DONE | Grid now renders headed "Live partners" / "Coming soon" sections (full-row headers inside the shared grid). |

## Settings

| # | Item | Status | Plan |
|---|------|--------|------|
| 42 | Wallpaper validation/preview | DONE | Live preview already existed on typing. Apply now preloads the image and shows an inline error hint when it fails, success feedback when it loads; Undo clears it. |
| 43 | Cursor previews | P2 | Bigger hover preview panel. |
| 44 | "Make it yours" clarity | DONE | Tooltip added; it expands + scrolls to Appearance settings. |
| 45 | Settings export/import | ALREADY | Fully implemented in the Advanced panel: Export downloads every chalkle-* key; Import restores and reloads; Reset wipes. |

## Cross-cutting / growth

| # | Item | Status | Plan |
|---|------|--------|------|
| 46 | Onboarding flow | P3 | 3-step modal (Play → Watch → Chat). Only after P1 polish lands so first impressions are good. |
| 47 | Discord CTA | DONE | Join bar under the home hero links the real invite (discord.gg/Y8Zh2mE7Ke); dismissible for the session. |
| 48 | PWA manifest | P2 | Add manifest + icons + meta theme-color; serve-chalk.py already static — mostly asset + link-tag work. |
| 49 | Share / referral links | P2 | "Share" button on cards using navigator.share + copy-link with ?game=… deeplinks. |
| 50 | v1.0 "What's new" | DONE | Changelog lightbox openable from the sidebar version footer (pink dot until seen, keyed per release) and a Settings → About row. |

## Shipped so far
Quick-win pass: #2, #9, #10, #11, #13, #27, #33, #44 · P1 batch: #12, #26, #30,
#1/#18/#19, #39 · This pass: #8, #24, #32, #41, #42, #47, #50 · Already in product:
#6, #45 (and #28's player core, #41's data model).

## Suggested next batch (P2)
1. Server-side health checks (#20/#21) — a /api/health?target= endpoint in
   serve-chalk.py feeding live up/latency dots on proxy + mirror cards.
2. Board bios + roles (#40) — extend the member data with a role line per card.
3. Tools search/filter tabs (#25) — reuse the Games chip pattern on the 31-item grid.
4. Settings export/import UI is done (#45); next: PWA manifest + icons (#48) for
   installable homescreen, then share buttons (#49).
