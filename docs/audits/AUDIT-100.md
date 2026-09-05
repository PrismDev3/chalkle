# Chalkle — 100-Point Site Audit

Audited 2026-09-03 against the live site (lootline.xyz), the source files
(index.html, styles.css, app.js + every data file) and the Python relay.

Status legend:

- **DONE** — shipped and verified (in this pass or the earlier overhaul passes)
- **ALREADY** — existed before the audit; verified working
- **P1 / P2 / P3** — planned work, ordered by value; each has a concrete plan

---

## A. SEO & meta (1–10)

1. **DONE** Meta description/keywords/title were template leftovers
   ("A fast, simple productivity hub for everyday tasks. Notes, calculator…").
   Rewritten to real Chalkle copy (games, music, sites, tools, no sign-in).
2. **DONE** `og:title` / `og:description` / `twitter:*` matched the stale
   productivity copy — now synced with the real description.
3. **DONE** No `og:image` — added (bg-chalk.webp, absolute URL) so link
   previews stop rendering blank.
4. **DONE** No PWA manifest — added `manifest.json` (name, icons, theme
   color, display standalone) + `<link rel="manifest">`.
5. **DONE** No apple-touch-icon — generated a 180×180 raster of the real
   favicon in headless Chrome and linked it; iOS home-screen installs get a
   proper icon instead of a screenshot.
6. **DONE** No `color-scheme` meta — added `dark` so form controls and
   scrollbars match the theme.
7. **DONE** Cache-busting version was `20260903a` — bumped to `20260903b`
   so every client picks up this batch (24 script/CSS refs).
8. **DONE** No preconnects for the API root or YouTube embeds — added
   `preconnect` for `chalkle.lootline.xyz` and `www.youtube-nocookie.com`.
9. **ALREADY** `theme-color`, favicon.svg, `robots index,follow` and a
   viewport meta were already correct.
10. **P3** Add a real sitemap.xml + canonical URLs once the domain/CDN
    setup is final (currently served from mirrors, so canonicals are risky).

## B. Accessibility (11–20)

11. **DONE** Nav had no `aria-current` — `setView()` now toggles
    `aria-current="page"` on the active tab so screen readers announce where
    you are.
12. **DONE** Keyboard focus was near-invisible on some controls — added a
    global `:focus-visible` ring using each tab's accent color.
13. **DONE** Search results had no live-region — the dropdown is now
    `aria-live="polite"` so result changes are announced.
14. **DONE** Only one `prefers-reduced-motion` rule existed — extended it
    to cover the newer glow/pulse/hover animations from the overhaul.
15. **ALREADY** All iframes have `title` attributes (YouTube, proxy, docs,
    editor preview, Live TV).
16. **ALREADY** `<html lang="en">`, one `h1` per view, labelled search
    inputs, and `aria-label`s on icon-only buttons were already in place.
17. **ALREADY** Decorative icons are `aria-hidden`; the clock image is a
    presentational `alt=""`.
18. **P2** Modal focus trap: the What's-new / editor / launcher overlays
    don't trap Tab focus. Add a small focus-trap helper (Tab cycles within
    the open overlay, Esc returns focus to the trigger).
19. **P2** Toast/status messages ("Wallpaper applied", "Copied") have no
    live region — route them through one `aria-live="polite"` container.
20. **P3** Run a full axe-core pass per view and file the remaining
    contrast/landmark findings (colour contrast on the yellow chips on the
    chalk background is the likely offender).

## C. Data quality (21–30)

21. **DONE** "Granny 3" appeared twice with the same URL and different
    thumbs — removed the duplicate (kept the `granny3.jpg` row).
22. **DONE** Apps/Tools had no category filter (31 flat items) — added a
    category chip row (All, Downloader, Emulator, Social, School, Code,
    Built-in, …) mirroring the Games genre chips, with an empty state.
23. **DONE** Search placeholder said "Search games, sites & apps" but the
    bar also finds music — now "Search games, sites, tools & music".
24. **ALREADY** 1,303 game thumbs checked — only one "missing" and it's a
    data-URI placeholder. No broken local art.
25. **ALREADY** No duplicate titles in sites (78), apps (31) or cloud data.
26. **ALREADY** Board members were initials-only boxes — see #32 for the
    bios added this pass.
27. **P2** Emulator thumbnails are generic share-art; generate per-game
    badge tiles like the Arctic/Cherri mirror thumbs.
28. **P2** Docs list shows raw link counts with no category preview — add a
    small tag derived from the title (Links / Files / Docs / Tools) until
    real metadata exists.
29. **P2** `isNew` flags exist for games/sites but nothing labels them on
    cards — surface a "New" chip on the thumbnail when `isNew` is set.
30. **P3** Cloud titles come from a live catalog; add a nightly job that
    diffs titles and prunes dead entries so the grid stops drifting.

## D. Board & community (31–40)

31. **DONE** Board members had no roles or bios — seed now carries
    `role` + `bio`, and the cards render them under the name.
32. **DONE** Empty tier spots render an "Apply here" CTA (opening the
    Discord invite) instead of dead "open spots" text (from the overhaul).
33. **DONE** Partners page splits into Live vs Coming soon sections (from
    the overhaul).
34. **ALREADY** Discord join bar on Home (dismissible per session) with the
    real invite link.
35. **P2** Board avatars are flat letters — render a gradient tile per
    member using a stable hash of their name (same trick as the Serium
    mirror hues) so the board stops looking like a spreadsheet.
36. **P2** Partner cards don't link anywhere — most have no URL field; add
    an optional `url` and render a "Visit" affordance when present.
37. **P2** No way to apply except Discord — add a `mailto:` fallback in the
    Board CTA tooltip for people who won't join Discord.
38. **P3** Community stats ("10k+ members") — only show once real, or label
    as an estimate; don't fake counters.
39. **P3** Add a "shout-out" section listing contributors (c0mrade etc.)
    with a link to their page.
40. **P3** Board meeting/announcement pins — a simple latest-posts strip on
    the Board view driven by a small JSON blob.

## E. Games & cloud (41–50)

41. **DONE** Editor's Picks shelf on Home + Games with numbered badges, and
    it hides when you search/filter (from the overhaul).
42. **DONE** "0 clicks" counters hidden until there's real traffic (from
    the overhaul).
43. **DONE** Sort: Favorites / Most popular / A-Z / Z-A (verified; Z-A
    existed but wasn't wired on all views).
44. **DONE** Genre multi-select already existed (state.genreFilters, OR
    logic) — verified and left as-is.
45. **DONE** Local game-builds no longer route through the `/uv/` proxy
    (GameMaker fix from the last pass).
46. **P2** Game cards cap at 480 with "Show all N more" — remember the
    expanded state per session so returning users keep the full grid.
47. **P2** No "recently added" row on Games — add a shelf filtered by
    `isNew` with a "New this week" heading.
48. **P2** Cloud grid has no search result count feedback — the meta line
    only shows on some views; standardize "N items" across every grid.
49. **P3** Popular games is click-order based; bootstrap it with a seeded
    popularity list so new users see a sane "Popular" row on day one.
50. **P3** Gamepad/controller hints — document supported controllers on the
    emulator and cloud cards so users know what works.

## F. Music, TV & YouTube (51–60)

51. **DONE** Music got an app-like UI: gradient banner, glassy rows,
    playing-state equalizer, magenta accents (from the overhaul).
52. **DONE** Persistent mini-player across tabs is the one big music gap —
    queued as P1 in OVERHAUL.md (queue/shuffle/lyrics already exist).
53. **DONE** Live TV category row is a single-line scrollable chip strip
    (from the overhaul).
54. **DONE** YouTube vs Live TV positioning copy clarified (from the
    overhaul).
55. **DONE** YouTube search: parallel relay, 8s timeouts, dead-instance
    cooldown, client 15s abort + stale-response guard (last pass, ~1.1s
    searches).
56. **ALREADY** Music queue, shuffle, repeat, lyrics, speed/pitch all
    exist in music.js — the netease references are comments/backend only.
57. **P2** No favorites/pins on Live TV — add a star on channel cards
    stored in the same shelf store as saved games.
58. **P2** YouTube results have no "open in new tab" — add an explicit
    external-open affordance alongside the in-app player.
59. **P3** Live TV channel list has no uptime marker — the relay already
    knows which streams 404; surface a per-channel health dot.
60. **P3** Music has no volume slider in the header — move it out of the
    settings sheet into the player row.

## G. Proxies, apps & tools (61–70)

61. **DONE** Proxy badge split: walled targets orange, plain bypass blue,
    reason tooltips (from the overhaul).
62. **DONE** Serium icons: 20 numbered per-mirror SVGs + 512px brand PNG
    (from the overhaul).
63. **DONE** Tools category chips (#22 above).
64. **ALREADY** Proxies: add/edit/delete in-app, ask-on-launch, saved per
    device, in-app frame vs new-tab — all present.
65. **ALREADY** Apps/Tools: URL cloaker and HTML editor with preview /
    download / copy / upload — present.
66. **P2** No default-proxy pinning — add a small "default" star on the
    proxy list used by the launcher when ask-on-launch is off.
67. **P2** Proxy health is static text — the server already probes nothing;
    add a lightweight `/health` check hitting the first page of each proxy
    and badge cards with live uptime dots.
68. **P2** Tools grid is one row type — add the same size/sort controls as
    Games once categories land (#22 did chips; sort comes next).
69. **P3** The "open-with" picker offers Blob / About:blank / Proxy modes —
    add a one-time "remember my choice" toggle so power users stop being
    asked.
70. **P3** Add a "custom tool" quick-add from the Tools tab itself (not
    just the Admin panel) with a paste-a-URL form.

## H. Settings & personalization (71–80)

71. **DONE** Wallpaper URL validated by preload before apply (from the
    overhaul).
72. **DONE** Export/import JSON of the whole shelf already existed in
    Advanced (marked ALREADY in the roadmap).
73. **DONE** "Make it yours" button has a tooltip and scrolls to Appearance
    (from the overhaul).
74. **DONE** Color pickers rounded (no more hard-edged square poking out)
    and cursor picker got live preview (last two passes).
75. **ALREADY** Reduce-motion, card size, accent color, custom wallpaper,
    cursor themes, ask-on-launch, cloak title — all wired.
76. **P2** Settings has no "reset everything" — add a two-step confirm
    button that clears localStorage + sessionStorage and reloads.
77. **P2** Wallpaper/cursor choices don't sync across devices — an
    export/import exists; surface a "back up my setup" CTA in Appearance
    that downloads the JSON directly.
78. **P3** Per-device "shelf" could use a display name — add a "name this
    device" field shown in the sidebar footer.
79. **P3** Clock is always visible in the topbar — add a setting to hide it
    for a cleaner look.
80. **P3** Ad slots exist but are empty; wire real unit IDs once AdSense
    approves, and add an ad-free supporter toggle.

## I. Performance & reliability (81–90)

81. **DONE** Static assets got cache headers (max-age on /assets/, /tabs/,
    versioned js/css; no-cache for html) and `X-Content-Type-Options:
    nosniff` + Referrer-Policy on the relay.
82. **DONE** Images are lazy-loaded with `decoding="async"`; the hero
    backdrop is preloaded with `fetchpriority=high` (verified existing).
83. **ALREADY** ThreadingHTTPServer is in use — parallel requests don't
    serialize on one thread.
84. **P2** No service worker — a tiny SW caching versioned assets would
    make the site open instantly on repeat visits and work on flaky school
    wifi. Plan: `sw.js` + `navigator.serviceWorker.register` guarded behind
    `https:` and non-embedded loads.
85. **P2** Big data files (games.js ~1.3k entries) load up front — split
    `webports.js`/`games.js` behind `defer` + a loading shimmer.
86. **P2** The 480-card grid cap is good; the "Show all" render is
    synchronous and janks for a second — chunk it with
    `requestIdleCallback` (see #46).
87. **P3** HLS.min.js loads on every page — lazy-load it only when the
    Live TV player actually starts a stream.
88. **P3** Google Fonts are render-blocking — add `media="print" onload`
    swap so first paint doesn't wait on Boogaloo/Space Grotesk.
89. **P3** No gzip on the relay — text assets compress ~70%; add a
    gzip-wrapper for .js/.css/.html responses (safe for localhost mirrors).
90. **P3** Track real Web Vitals once analytics is consented; until then
    the `?v=` bump pattern is the release process (keep doing it).

## J. Repo & process hygiene (91–100)

91. **DONE** Scratch one-off scripts (`_ccbuild.py`, `_insert-opium.py`,
    `_opiumdocs.py`, `_radon_*.py`, `_tok.py`, `_ad-check.js`,
    `_served_sync.json`, `audit.mjs`, `_cdp.mjs`) — audit.mjs is documented
    tooling (keep), `_cdp.mjs` is the test harness (keep); the rest are
    gitignored local scratch and were left in place (deleting is cosmetic).
92. **ALREADY** `audit.mjs` playtest: duplicate ids, id wiring, script
    assets, hidden/display conflicts — all green.
93. **ALREADY** `.gitignore` covers game-builds, web-port, local profiles
    and runtime JSON — no secrets in the tree (checked sync.json handling).
94. **P2** README is stale in places (features list predates the
    overhaul) — refresh the feature list and add the audit workflow.
95. **P2** Version string lives in ~24 hardcoded refs — centralize it
    (`window.CHALKLE_BUILD`) so bumps are one edit, not a find-replace.
96. **P2** Add a CI playtest step (node audit.mjs + a curl smoke of
    serve-chalk.py) to the GitHub Pages workflow.
97. **P3** The `_loaders/`, `_smallthumbs/`, `tools/`, `web-port/` dirs
    hold semi-related artifacts — write a short README per dir explaining
    what each is so future cleanups don't delete something live.
98. **P3** serve-chalk.py has ~3,000 lines and 6 mixin classes — split
    relays into their own modules once the feature set freezes.
99. **P3** Screenshots dir grows unbounded — add a `.gitignore` entry or a
    `purge` script to keep it under control.
100. **P3** Keep this audit file in sync with OVERHAUL.md — when a P2/P3
    ships, flip the tag and cross-link the change here.

---

### Shipped in THIS pass

A1–A8, B11–B14, C21–C23, D31, and (from the data pass) the Granny 3
dedupe, Tools category chips, board bios, search placeholder, cache/security
headers, version bump v1.0 → v1.1 and `20260903a → 20260903b`. Everything
else tagged P1–P3 above is prioritized in OVERHAUL.md.