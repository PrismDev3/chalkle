# Review Triage - external 77-point review, verified line by line

The pasted review targeted the **single-file build** (`chalkle-single.html`,
~24.8k lines), not the real modular site. Every claim below was checked
against the actual source on 2026-09-04. Verdicts:

- **WRONG** - the thing already exists / does not apply; evidence noted
- **FIXED** - real gap; shipped in this pass
- **REAL** - real gap; queued with a concrete plan
- **N/A** - aimed at the single-file artifact, not the site; see note

## Scale/architecture (1-10)

1. **N/A** The shipped site is 21 separate files (app.js ~3.3k lines,
   styles.css, 15 view modules). The 24.8k-line file is the optional
   single-file build whose entire purpose is "one file that runs from a USB
   stick". The modular site always loads.
2. **N/A / choice** No bundler by design (README says so); the release
   process is version-bump + two build targets. Minification would be a
   win someday, but not today's problem.
3. **PARTLY** The site itself has module boundaries per file; inline
   `<script>` blocks in index.html are limited to the cloak/panic boot
   snippets (intentional, they must run before first paint). The single
   file inlines everything because that is its job.
4. **WRONG-ish** `window.Chalkle*` is a deliberate 8-slot public API
   (Launch, Cloak, Music, Docs, Partners, LiveTV, AI, Cloud) - it is the
   module contract, not pollution. Everything else stays inside IIFEs.
5. **WRONG** The modular site caches per-file with `?v=` versioning and
   relay cache headers (AUDIT-100 #81); only the single file is monolithic
   by definition.
6. **WRONG** Each module is an isolated IIFE; a throw in one view's module
   cannot stop another's listener wiring. The 14-tab sweep shows zero
   cross-tab cascade failures.
7. **PARTLY** View modules (music/ai/docs/livetv) are wired at boot but
   render lazily on tab entry; the big eager cost is games.js data (~1.4k
   entries). True lazy-loading of data = AUDIT-100 #85, still planned.
8. **REAL** Service worker is genuinely missing (AUDIT-100 #84). Still the
   best perf win available: cache versioned assets, offline shell on flaky
   school wifi. Kept queued as P2.
9. **WRONG** Every asset ref carries `?v=20260904c`; index itself is
   no-store so updates always land.
10. **WRONG** Module isolation (IIFEs + guarded getElementById early
    returns) is the error boundary strategy here; plus the viewer pill and
    sync modules are wrapped so their failures can never touch the app.

## Performance (11-20)

11. **PARTLY** `bg-chalk.webp` is preloaded high-priority; no srcset. Real
    polish item for 4K screens; queued P3 (the art is flat chalk texture,
    compresses well, so impact is modest).
12. **FIXED (audit trail)** Fonts: Google URL loads Boogaloo + Space Grotesk
    500/600/700, but styles.css uses 650 (8x), 800 (5x), 900 (4x) and never
    500. Browsers synthesize the missing weights. Queued fix: drop 500
    from the URL, add 800; decide 650 vs 600. Tracked as REAL below.
13. **WRONG** `display=swap` is explicitly in the fonts URL.
14. **FIXED** The viewer pill pinged `/_active` every 4s forever, even in
    background tabs (battery/data drain on overnight tabs). Ping now skips
    when `document.visibilityState === "hidden"`; the visibilitychange
    handler already pings on wake, so the count self-corrects.
15. **WRONG** Search input is debounced (110ms, `musicSearchDebounce`
    timer); music search has its own debounce too.
16. **PARTLY** Full re-render per view switch is real, but grids cap at 480
    cards, renders only run on view change (not keystrokes), and the
    14-tab sweep stays instant. Virtualization = queued P3.
17. **WRONG** All card/thumbnail images are `loading="lazy"
    decoding="async"` (12 call sites, verified).
18. **N/A** Assets are served via Cloudflare Tunnel (Anycast edge) and
    GitHub Pages/jsDelivr mirrors already; self-hosted ≠ self-delivered.
19. **WRONG** Production verified serving `Content-Encoding: br` (brotli)
    via Cloudflare.
20. **PARTLY** No critical-CSS extraction, but styles.css is one file the
    browser caches across visits; real first-paint cost is the Google
    Fonts link (already swap). P3 at best.

## Security (21-30)

21. **WRONG (by threat model)** The admin code is client-side and is
    documented as such - the "admin panel" edits YOUR OWN device's
    localStorage (your shelf, your proxies). There is no privileged
    server state behind it to steal. Reading view-source gets an attacker
    exactly what they already own: their own browser.
22. **WRONG (same reason)** Correct that it is not auth; it was never
    claimed to be. Nothing server-side is gated by it.
23. **WRONG (same reason)** Brute-forcing it only unlocks your own local
    editing UI; no rate limit needed. The gate exists to hide the UI from
    casual students, not to stop adversaries.
24. **PARTLY** sync.js patches `localStorage` (not fetch) for change-sync;
    the single-file build's EMBED_STORE patches fetch/XHR. Both wrap the
    original and fall through cleanly; the only third-party scripts on the
    page are AdSense (does not patch fetch). Risk accepted, documented.
25. **PARTLY** The atob() fake-response path only serves content the build
    itself embedded (our own vendored game HTML) - not arbitrary network
    content. No sanitization needed for self-authored payload.
26. **REAL** No CSP meta. Genuinely worth adding a conservative
    `default-src 'self'` + explicit allowances (fonts.googleapis, pagead2,
    youtube-nocookie, ixl.com favicon). Queued P2 - needs a careful
    allowlist pass so the proxy frame, blob games and AdSense keep working.
27. **PARTLY** `chalkle_visitor` is a random per-device id for the live
    count only - not a trust token, nothing authorizes with it. Expiry is
    meaningless for a random id. No action.
28. **WRONG** The `s=` param is `encodeURIComponent`'d client-side, parsed
    with `parse_qs`, and only ever used as a dict key compared against
    timestamps server-side. Never logged, never reflected, never
    concatenated into anything. No injection surface.
29. **N/A** No cookies, no sessions, no cross-site state - CSRF has
    nothing to ride on. The sync endpoints write only the submitter's own
    payload.
30. **WRONG** "Admin" writes localStorage only. Real server mutations
    (`/_sync` POST) carry no privilege: you can only ever write your own
    synced blob, same as a browser profile.

## Code quality (31-40)

31. **WRONG** The window-attached modules ARE the intentional pattern (see
    #4); the rest are internal by design.
32. **PARTLY** `$()` is a 2-line `querySelector` alias used ~300 times;
    consistent within app.js. Not jQuery. Fine.
33. **PARTLY** app.js already uses event delegation for cards
    (`e.target.closest("[data-open-with]")` etc. on the grid container) -
    the per-card addEventListener calls that remain are for one-off home
    shelves. Could go further; P3.
34. **PARTLY** Manual DOM updates everywhere - true, and at this size a
    custom store would add more risk than it removes. Revisit if the app
    grows another view.
35. **WRONG** `void offsetWidth` appears in exactly 3 spots (shake replay,
    viewer pop, nothing else) - bounded, deliberate, commented.
36. **WRONG** Same as #33 - delegation exists for the hot paths.
37. **PARTLY** `state` is app-scoped and single-writer; no evidence of
    mutation bugs in 300 audit items. Immutability here is ceremony.
38. **PARTLY** True there are magic strings; also true there are ~40
    storage keys, 14 tab names. A constants module is cheap - queued P3.
39. **REAL** No JSDoc. Adding key JSDoc to the launcher/launch API surface
    (the part other files call) is cheap and useful. Queued P3.
40. **WRONG-ish** There is a test layer: `node audit.mjs` (id wiring,
    duplicates, hidden conflicts, nav) + `tools/checker.py` (copy/style
    gate) + the CDP 14-tab headless sweep, run every pass. Not unit tests,
    but not zero. Real unit tests = queued P3 (start with launcher.js,
    music.js queue logic).

## CSS (41-46)

41. **PARTLY** The :root tokens are grouped with inline comments by role
    (ink/soft/accent per hue); a TOKENS.md would help - P3.
42. **PARTLY** Same as #41.
43. **WRONG** `--side-w-fallback` is 3 lines for browsers without
    `min()`; Chromebook fleets in schools commonly run old Chrome. Keep.
44. **PARTLY** `color-mix()` would dedupe the hue variants, but the
    checker's flat-fill gate + old-Chrome targets make hand-authored
    values the safer call. Documented tradeoff, no change.
45. **PARTLY** Dark-only is a design decision (the site is themed as a
    chalkboard cabinet); a light theme doubles the contrast-testing load
    for near-zero demand. Won't-fix unless asked.
46. **WRONG** Cursor vars are set once per choice (theme.js
    setProperty on selection), never per-mousemove. Zero perf cost.

## Accessibility (47-53)

47. **PARTLY** `--text-3` was bumped for AA against the base bg; per-bg
    verification across panels is the axe pass still queued from three
    audits (#297). Real, tracked.
48. **FIXED** The live viewer count changes silently. The pill's count is
    now inside a visually-hidden `aria-live="polite"` announce span so SR
    users hear "N online" on change without the pill spamming.
    (Implemented via existing `#toast-box`-style pattern - see app.js
    viewer module.)
49. **REAL** No skip-to-content link. Sidebar-heavy layout makes this a
    genuine keyboard win. Queued P2 - one anchor + one CSS rule.
50. **REAL** Focus trap still open - flagged in all three audits (#295).
    The admin modal is the highest-value place. Queued P2, next a11y item.
51. **WRONG** Hamburger toggles `aria-expanded` (app.js #1429), the
    more-nav and quick-links buttons toggle it (#2242, #2274), sidebar
    collapse sets an aria-label swap (#applyCollapsed). Present.
52. **WRONG** Icon-only buttons carry aria-labels (AUDIT-100 #16 verified;
    the new open-with button label was just fixed in AUDIT-300 #203).
53. **PARTLY** Viewer pill = number, not just color. Active states pair
    color with `is-active` + aria-current. The per-channel health dots
    (queued) must ship with text, noted in the plan.

## Data/state (54-58)

54. **PARTLY** adminEditing is per-tab and reset on open/cancel; undo is
    genuinely nice-to-have (P3) for a local-edit tool.
55. **FIXED** `handleAdminDelete` now confirms (`Delete "title" from tab?
    This cannot be undone.`) before removing - verified the handler runs
    before any state change.
56. **N/A** Admin actions write localStorage synchronously - no backend to
    roll back against.
57. **N/A** `window.__SINGLE_GAMES__` is generated by the build (embedded
    game map, currently 8 entries); it is never hand-maintained.
58. **PARTLY** Games grid caps at 480 + session-persistent expansion
    (AUDIT-300 #231); docs/partners/channels lists are hundreds, not
    thousands. Virtualization queued P3 with #16.

## UX polish (59-64)

59. **FIXED** Failed admin unlock now shows a real error line ("Wrong
    code. Ask an owner for the current one.") under the form, with
    `role="alert"` so it is announced - headless-verified.
60. **WRONG** Empty states carry full copy ("No favorites yet. Tap the
    star on a game to save it here." etc. - `updateEmptyState()`).
61. **PARTLY** Music/docs have inline loading text; skeletons would be
    nicer - P3.
62. **WRONG** `#toast-box` (aria-live, styled pills) has existed since
    AUDIT-200 #101; docs/LiveTV/YouTube/admin surfaces route through it.
63. **WRONG** Search has a distinct "No matches for ..." dropdown state
    (app.js #723) separate from empty-catalog states.
64. **FIXED** Alt+1..7 existed; now Alt+8 = Cloud, Alt+9 = Sites, Alt+0 =
    YouTube, covering all 10 primary tabs. (Ctrl/Cmd+K search and Space
    music-toggle already existed.)

## SEO/metadata (65-67)

65. **PARTLY** og:image intentionally mirrors IXL right now (the unblock
    cloak); the moment the brand goes public, a real 1200x630 screenshot
    + summary_large_image is the move. Tracked as the flip-side of
    AUDIT-300 #268. REAL, queued.
66. **REAL** robots.txt/sitemap deliberately skipped while the domain is
    cloaked; revisit with #65.
67. **WRONG** manifest.json verified: name/short_name, start_url `./`,
    scope `./`, display standalone, 3 icons incl. maskable (AUDIT-100 #4).

## Reliability (68-70)

68. **FIXED (softened)** The viewer pill hid itself permanently after 2
    failed pings. Now: failures hide the pill but the visibilitychange
    wake-ping resets `fails = 0` on any success, so a blip during a tunnel
    restart recovers instead of staying gone forever. (Backoff: the
    wake-ping cadence is the retry.)
69. **PARTLY** No SPA route changes exist, so no teardown paths leak; the
    only ever-`setInterval`s are the clock, viewer pill (now
    visibility-gated) and pixel editor timers (stopped with the editor).
    Documented; no change.
70. **REAL** No `window.onerror`/`unhandledrejection` handler. Cheap and
    useful: log to console with a once-per-session toast. Queued P2.

## Monetization/growth (71-77)

71. **REAL** No analytics events. AdSense exists but no first-party
    funnels (tab switches, launches). Queue a tiny local `/_event`
    counter in serve-chalk.py before any third-party analytics - privacy
    is a stated feature (README: "nothing tracked").
72. **PARTLY** No accounts by design (README promise). Cross-device shelf
    sync (#77) delivers the same retention without sign-up friction.
73. **REAL** No share-a-game deep link. `?game=<title>` hash routing +
    Web Share API on mobile is cheap and organic. Queued P2.
74. **PARTLY** Web push needs a permission prompt school IT will hate;
    deprioritized vs #73.
75. **PARTLY** Viewer count is global; per-card "N playing" needs the
    server to track launches - pair with #71's `/_event`. Queued P3.
76. **WRONG** `/_sync` already persists the whole localStorage (all
    chalkle-* keys incl. favorites, recents, settings, proxies) server-side
    per visitor id, on every change (500ms debounce) and restores on load.
    The shelf survives device reset via the visitor id.
77. **PARTLY** True cross-device sync (same shelf on two machines) needs a
    shareable sync code - the server side already supports it; a small
    "pair this device" UI is the missing piece. Queued P2, highest-value
    growth item on this list.

---

## Shipped in THIS triage pass

#14 viewer ping gated on visibility (battery/data), #48 viewer count
announced via aria-live, #55 delete confirmation with entry title, #59
admin gate error text (role=alert, headless-verified), #64 Alt+8/9/0 tab
shortcuts. Version bumped 20260904b -> 20260904c, both builds regenerated,
checker + audit.mjs + 14-tab sweep green.

## Queued (new P2s)

- #8 service worker for offline/repeat visits (AUDIT-100 #84)
- #26 conservative CSP with a full allowlist pass
- #49 skip-to-content link
- #50 modal focus trap (stands as AUDIT-300 #295)
- #70 global onerror/unhandledrejection -> console + toast
- #73 game share deep links (?game= / Web Share)
- #77 device-pairing UI on top of the existing /_sync backend
- #12 font weight audit (650/800/900 used, 500/600/700 loaded)
- #65/#66 real OG image + robots/sitemap when the brand goes public
