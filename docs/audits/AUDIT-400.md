# Chalkle - 100-Point Site Audit IV

Audited 2026-09-05 against the working tree after the latest round of changes
(Sizzle Studios partner and cursor, cursor resize pass, fake block-page cloak,
educational cover, editor's picks recolor, hidden keeper processes). Ran the
quality gates, a dependency-free headless Chrome sweep, and live probes of
lootline.xyz, the subdomains, the relay, the vendored games, the proxy path,
and the temp quick tunnel. Continues the numbering from AUDIT-300.md
(items 401-500).

Writing rules for this pass: no em dashes, no filler words, plain verbs.
Gradient washes were removed from the site per request; only functional
scroll fade masks remain.

Status legend (same as previous audits):

- **DONE** - shipped and verified in this pass
- **ALREADY** - existed before the audit; verified working
- **P1 / P2 / P3** - planned work, ordered by value; each has a concrete plan

---

## AB. This session's ship list (401-410)

401. **DONE** Sizzle Studios partner added. Logo at assets/partners/sizzle.png,
     seeded through partners.js defaults with the Discord invite. No official
     site yet, so the card lands in the Coming soon group with a live Discord
     button.
402. **DONE** sizzle studios cursor added. 36x36 base plus brightened hover,
     registered in theme.js under the lowercase label, visible in Settings.
403. **DONE** All cursors shrunk: 48 to 36, 64 to 48, 80 to 60. godlylinks and
     p2pgames keep their 48x46 aspect at 36x35. Hotspots updated per cursor.
404. **DONE** Hover lighten boosted. Every hover copy regenerated at brightness
     1.35, so the lighten on hover is clearly visible.
405. **DONE** Educational cover added. index.html carries a full IXL-style
     learning landing page as raw HTML. An inline script deletes it before
     first paint, so text scanners see education and users see nothing.
406. **DONE** Blocked cloak added. The block-page screenshot covers the page at
     the top layer until clicked, then fades over 400ms.
407. **DONE** Boot holds behind the cloak. intro.js starts only after the cloak
     is dismissed, so the boot logo and log play after the click.
408. **DONE** Cloak image slimmed from 934KB PNG to 36KB WebP at quality 82.
     No visible loss on a full-screen cover.
409. **DONE** Cloak is keyboard friendly. Enter and Space dismiss it like a
     button, tabindex 0.
410. **DONE** Editor's picks recolored. The shelf now uses the tab's own accent
     variable, so Games picks are green, Home stays pink, and a custom accent
     carries through.

## AC. Cloak and unblock stack (411-420)

411. **ALREADY** IXL meta stays byte-mirrored (description, og, twitter, title,
     favicon). The checker allowlist from item 214 still applies.
412. **DONE** The educational cover uses a flat hero background now, no color
     blend.
413. **DONE** noscript copy changed from "Chalkle needs JavaScript" to a neutral
     line, so a no-JS scan sees nothing game-related.
414. **ALREADY** Panic key intact: triple backtick or Ctrl+Shift+backtick jumps
     to Google Classroom.
415. **ALREADY** The cloak can never trap the site. intro.js has a 45s safety
     that starts the boot even if the click handler fails.
416. **DONE** Headless run confirms the unblock stack: cover removed, cloak
     present, boot held, 16 game cards behind.
417. **ALREADY** Link previews still mirror ixl.com through og:image and og:url.
418. **ALREADY** The cover sits in normal flow with no z-index, so it can never
     overlap the boot or the cloak.
419. **ALREADY** The cover removal script runs before first paint, inline and
     right after the div.
420. **ALREADY** Cloak is role=button with a label and focusable, with the focus
     ring suppressed so it reads as a real block page.

## AD. Cursors and theming (421-430)

421. **DONE** 28 cursor files verified: 14 pairs, every hover matches its base
     size.
422. **DONE** Hotspots scaled with the art: 24 24 to 18 18, 32 32 to 24 24,
     24 23 to 18 17, anko and ghostproxy to 18 18 on 60px art.
423. **ALREADY** The none (default) cursor still uses plain auto.
424. **DONE** Editor's picks background and border use color-mix over the
     accent, keeping the soft tint without a hardcoded color.
425. **DONE** Number badge on picks cards uses the accent with its ink color
     for contrast.
426. **DONE** Four tab glow washes removed (livetv, youtube, ai, cloud). The
     dark backgrounds stay, so each tab keeps its identity.
427. **ALREADY** Two mask-image fades kept. They are scroll fade-out masks, not
     color washes.
428. **DONE** Cache-bust bumped styles.css to 20260904e so browsers pick up the
     new colors.
429. **DONE** Remaining pink uses are all home-scoped (topbar, home accent, nav
     state). Grep confirms zero pink left in the picks shelf.
430. **ALREADY** WALLPAPERS and the accent picker untouched by the cursor
     resize.

## AE. Processes and infra (431-440)

431. **DONE** start-chalkle.bat launches server, music, and named tunnel hidden
     via PowerShell Start-Process, with logs to files. No taskbar windows.
432. **DONE** Hidden spawn pattern proven: a test run printed 42 to the
     redirected log file.
433. **DONE** start-keeper-hidden.vbs runs the keeper with zero windows. Use it
     at logon or in Task Scheduler.
434. **DONE** All visible Chalkle cmd windows closed. Services survived as
     background processes under one hidden keeper.
435. **ALREADY** Named tunnel healthy: lootline.xyz, www, and
     chalkle.lootline.xyz all return 200.
436. **ALREADY** Quick tunnel healthy: decision-measured-breath-emerald
     .trycloudflare.com returns 200.
437. **P2** Seven orphan node.exe music processes accumulated from earlier
     restarts. Plan: the keeper writes a PID file on start and kills only that
     PID on restart.
438. **P3** The quick tunnel is not in the keeper loop. Plan: an optional flag
     starts it beside the named tunnel, or a separate hidden bat.
439. **DONE** Keeper is single-instance now. The earlier double-keeper fight
     (two loops taskkilling each other's cloudflared) is gone.
440. **ALREADY** Keeper checks origin health before bouncing a tunnel, so a
     dead origin never causes a pointless tunnel restart.

## AF. Quality gates (441-450)

441. **ALREADY** audit.mjs green: no duplicate ids, every JS id exists, scripts
     present, hidden rules hold, all nav sections wired.
442. **ALREADY** tools/checker.py clean.
443. **DONE** node --check passes on intro.js, theme.js, and partners.js, plus
     the rest of the shipped scripts from earlier passes.
444. **DONE** Headless checker rewritten without puppeteer. The npm dep was
     never installed, so the old script could not run. Now uses Chrome
     dump-dom and passes.
445. **ALREADY** Both single-file builds regenerate from the same sources and
     stay in sync.
446. **DONE** Local build inlines the cloak as data:image/webp; the CDN build
     keeps the relative path. Both verified.
447. **ALREADY** manifest.json parses as valid JSON.
448. **DONE** Cache-bust convention followed: only styles.css carries a version,
     bumped once for this pass.
449. **DONE** Build sizes recorded: local 38.5MB, CDN 7.1MB. The cloak adds
     36KB, not 934KB.
450. **DONE** Zero console.log in shipped JS. One TODO/FIXME marker total in
     the shipped tree.

## AG. Live surfaces (451-460)

451. **ALREADY** lootline.xyz root 200 with the new cover and cloak.
452. **ALREADY** www.lootline.xyz 200.
453. **ALREADY** chalkle.lootline.xyz 200.
454. **ALREADY** relay /yt/search 200 through the tunnel.
455. **ALREADY** relay /music/api search 200 through the tunnel.
456. **ALREADY** vendored game gn/0.html 200 through the tunnel.
457. **ALREADY** /uv/ proxy path 200.
458. **ALREADY** quick tunnel 200 with the same content.
459. **DONE** New assets verified 200: sizzle partner logo, cursor pair, cloak
     webp, via origin and tunnel.
460. **DONE** Educational content reaches the live page: 33 cover markers plus
     hero copy on the served HTML.

## AH. Content and integrity (461-470)

461. **ALREADY** games.js lists 1374 titles.
462. **ALREADY** All 12 background url refs in styles.css exist on disk. None
     missing.
463. **ALREADY** Cursor files: 28 present, sizes match per pair.
464. **DONE** Sizzle Studios seeds for every visitor through partners.js
     defaults, with icon backfill for stored copies.
465. **DONE** The cursor picker renders sizzle studios from the same defaults
     object, so there is no second list to drift.
466. **ALREADY** All 8 editor's picks titles match games.js entries; each grep
     hits exactly once.
467. **ALREADY** Board, docs, and partners views each keep their own store key
     and share the same admin gate.
468. **ALREADY** The build script strips the launch chooser regex without
     touching the cloak or cover blocks.
469. **ALREADY** No duplicate element ids introduced by the cloak or cover
     (audit.mjs).
470. **ALREADY** File refs in index.html all resolve: styles, scripts, icons,
     manifest.

## AI. Accessibility and copy (471-480)

471. **ALREADY** Zero icon-only buttons missing aria-label. The 101 buttons
     without labels all carry visible text.
472. **DONE** Cloak is keyboard reachable and dismissible (tabindex 0, Enter
     and Space).
473. **DONE** Focus ring suppressed on the cloak only, so the block page looks
     un-clickable to a glance.
474. **ALREADY** Panic key has no side effects on typing: a single backtick is
     ignored, three fast presses trigger.
475. **ALREADY** Reduced motion skips the boot and shows the app right after
     the cloak click.
476. **ALREADY** Boot skip label appears at 900ms and finishes the boot early.
477. **DONE** noscript copy is neutral, no product name.
478. **ALREADY** All target blank links carry noopener (verified in AUDIT-300,
     unchanged).
479. **ALREADY** View titles color from their accent; the picks shelf follows
     the same rule now.
480. **ALREADY** partners.js and docs.js expose the same admin API surface
     (render, refreshAdminList, addPartner).

## AJ. Performance (481-490)

481. **DONE** Cloak payload cut from 934KB to 36KB, about 96% less.
482. **DONE** The cloak loads from a webp, which also inlines smaller into the
     single-file build.
483. **ALREADY** Game thumbs lazy load with loading=lazy and async decode.
484. **ALREADY** Fonts preconnect to fonts.googleapis and fonts.gstatic.
485. **ALREADY** Ads stay hidden until real unit ids are pasted; no ad network
     traffic on the page.
486. **ALREADY** The boot runs once per session and removes itself from the DOM
     after finishing.
487. **ALREADY** The cover is deleted before first paint, so it costs nothing
     for real users.
488. **ALREADY** The subpath mirror probe is one HEAD request, cached no-store,
     and stays dormant on lootline.xyz.
489. **ALREADY** The relay and music API share one origin through the tunnel, so
     no extra TLS handshakes.
490. **P3** The 38.5MB local single-file build is the price of embedding 8
     self-contained games. Plan: lazy game fetching if size ever matters.

## AK. Planned work (491-500)

491. **P1** Restore the full tab sweep. The headless checker covers home only.
     Plan: loop all 14 views with the same dump-dom method and report page
     errors per view.
492. **P2** Music orphan cleanup via PID file in the keeper (see 437).
493. **P2** Launch API shape { ok, url } so callers can tell opened from
     dropped (carried from AUDIT-300 item 209).
494. **P3** Re-probe /uv/ ten seconds after a failed first use (carried from
     AUDIT-300 item 210).
495. **P3** One-line notes on cloud and webport cards, like the emulator notes
     (carried from AUDIT-300 item 220).
496. **P3** Optional quick-tunnel support in the keeper (see 438).
497. **P3** Session-memory option for the cloak, if showing it once per day is
     preferred over every load.
498. **P3** Flatten the remaining mask fades if a fully flat look is wanted.
     They are functional, not decorative.
499. **P3** Confirm the Pages and jsDelivr mirrors ship the same build after
     this pass, since only the tunnel origin was probed live.
500. **P3** Document the hidden-keeper setup in one place so a reboot does not
     strand the site: start-keeper-hidden.vbs at logon, or Task Scheduler.