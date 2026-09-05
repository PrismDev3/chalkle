# Chalkle - 100-Point Site Audit V

Audited 2026-09-05 after the bookmarklets tab, the gzip pass, the unblock
work, and the cleanup push. Ran the quality gates, headless Chrome renders,
and live probes of lootline.xyz, the relay, and the quick tunnel. Continues
the numbering from AUDIT-400.md (items 501-600).

Writing rules held: no em dashes, no en dashes, no filler words, plain verbs.

Status legend:

- **DONE** - shipped and verified in this pass
- **ALREADY** - existed before the audit; verified working
- **P1 / P2 / P3** - planned work, ordered by value; each has a concrete plan

---

## AL. Unblock reality check (501-510)

501. **DONE** Re-read the third-party filter report for lootline.xyz and the
     temp domain. Most red rows are "Uncategorized", "Not rated", or "New
     URL", which are data states, not content verdicts. Code cannot speed
     those up; they clear as filter databases learn the domain.
502. **ALREADY** The rows that name real content (Securly "Anonymous
     proxies", CleanBrowsing "Proxy and VPN", Senso "Games") describe what
     the site is. No page text can hide a proxy that is being proxied and
     games that are being played. That is a product truth, not a bug.
503. **DONE** The root page already reads as education before any app
     content: IXL meta, the educational cover, neutral noscript, IXL
     favicon. Verified again this pass by raw HTML scan.
504. **DONE** Added robots.txt and sitemap.xml so crawlers index the
     educational landing and see one clean public URL. Both return 200
     through the tunnel.
505. **ALREADY** The block-page cloak gives a teacher who glances at the
     screen a real filter screenshot, and the panic key jumps to Google
     Classroom. Those are the walk-by defenses that actually work.
506. **ALREADY** The cloak cannot trap the site (45s safety) and the boot
     only plays after the cloak click.
507. **ALREADY** GoGuardian AI and Deledao already rate the site safe or
     unclassified, and several filters (Linewize, iBoss, FortiGuard) rate it
     business or IT. Partial coverage exists and is unchanged.
508. **P3** If a filter shows a false category, the fix is a reclassification
     request from the filter's portal, not a code change. Keep a short list
     of portal URLs next to the keeper docs.
509. **P3** New domains start unrated and improve with traffic and age. The
     named domain should be used everywhere instead of fresh quick-tunnel
     domains, which reset the clock each time.
510. **P2** The temp quick-tunnel domain got a "Filter Avoidance" flag from
     Cisco. Plan: stop advertising quick tunnels as the main link and point
     at lootline.xyz, which has a cleaner record.

## AM. Bookmarklets tab (511-525)

511. **DONE** New tab "Bookmarklets" added under the More menu with its own
     bookmark icon.
512. **DONE** The tab uses lime, the one accent color no other tab uses.
     View accent, active nav state, topbar border, and topbar tint are all
     lime. Home stays pink, Games stays green.
513. **DONE** New bookmarklets.js renders the catalog. Self contained like
     partners.js and docs.js, no storage, no remote calls.
514. **DONE** 25 bookmarklets across 5 groups: Cloak and hide, Cloaked
     proxies, Edit and inspect, Handy tools, Just for fun.
515. **DONE** Every card has a one line blurb, the code in a scrollable
     box, and a Copy button. Clicking the card copies too.
516. **DONE** Copy feedback: button flips to "Copied" with the lime fill for
     a second, then returns.
517. **DONE** Clipboard uses the async API when available and a hidden
     textarea fallback when not.
518. **DONE** Cloak and hide holds: Tab cloak, Drive disguise, Embed site,
     Blur page, Unblur page.
519. **DONE** Cloaked proxies holds a cloaked launcher for this site's own
     proxy plus Nebula, Ultraviolet, Incognito, Holy Unblocker, and General
     Mathematics, all about:blank style.
520. **DONE** Edit and inspect holds: Edit page, Stop editing, Show
     passwords, Delete element.
521. **DONE** Handy tools holds: Calculator, History flood, Autoclicker,
     Word count.
522. **DONE** Just for fun holds: Snake, StopAtNothing, Disorient, Rainbow
     page, Spazzy images, Panic screen. Snake is the full self contained
     game; Panic screen is a fake blue screen overlay.
523. **DONE** Intro copy on the tab is two short sentences: what a
     bookmarklet is and how to add one. No walls of text.
524. **DONE** Dead external hosts were skipped (rawgit, rawgita, fontbomb,
     kathack, websiteasteroids, chengyinliu). The old http scripts pointed
     at sites that no longer exist, so shipping them would ship broken
     buttons.
525. **DONE** Tab registered everywhere a view must live: index.html nav and
     section, audit.mjs passes with the new view in both nav lists,
     checker.py SHIPPED list, and the single-file build script.

## AN. Gzip and caching (526-535)

526. **DONE** serve-chalk.py now gzips static text when the client accepts
     it. html, css, js, json, svg, and txt are covered; images pass
     through untouched.
527. **DONE** The gzip branch sends the same headers as a normal response
     (CORS, nosniff, referrer policy, cache rules) because it runs through
     send_response.
528. **DONE** The root path resolves index.html before gzip applies, so the
     landing page is compressed too.
529. **DONE** Verified live: Accept-Encoding gzip returns Content-Encoding
     gzip for the root and styles.css, and the webp cloak stays unencoded.
530. **ALREADY** Versioned assets cache for a day; unversioned text is
     no-store. That split predates this pass and still holds.
531. **DONE** Found and fixed a stale-cache bug from earlier sessions: 23 of
     24 refs were pinned at version d while styles.css moved to e, so
     changed JS could sit in browser cache for a day. All refs now share
     one version.
532. **DONE** The same version now covers the new bookmarklets.js script
     tag.
533. **ALREADY** Images keep a one day cache and the cloak webp inlines into
     the local single-file build as a small data URI.
534. **P2** The origin does not serve HTTP/2 or brotli. Plan: put a tiny
     reverse proxy in front of python later, or accept the current single
     connection per asset.
535. **P3** Long term, move static files to a CDN origin and keep the tunnel
     for relay traffic only.

## AO. Data integrity and repo hygiene (536-545)

536. **DONE** Slither.io pointed at http://slither.com/io. Now https, and it
     is one of the editor's picks, so the fix reaches the home shelf.
537. **ALREADY** 753 gn game refs all exist on disk. 1357 thumb refs all
     exist. Zero missing in either set.
538. **ALREADY** Duplicate title scan found only prefix collisions (FNF
     builds, Baldi variants, Papa's series, Assassin's Creed games). Each
     is a distinct entry with its own URL.
539. **ALREADY** No empty URLs in games, sites, apps, cloudgames, or
     webports data.
540. **ALREADY** manifest.json parses. CSS background refs all exist.
541. **DONE** .gitignore now covers tmp-* files, so scratch scripts stop
     showing as untracked litter.
542. **DONE** install-autostart.bat now registers the logon task through the
     hidden VBS launcher instead of opening a visible cmd window at every
     logon.
543. **DONE** The startup-folder half already used a hidden VBS; both paths
     now run the keeper with zero windows.
544. **DONE** robots.txt and sitemap.xml added and verified 200 on origin
     and through the tunnel.
545. **ALREADY** Pages workflow intentionally ships only tracked files, so
     gitignored builds and logs never leak to the mirror.

## AP. Gates and builds (546-555)

546. **ALREADY** audit.mjs green: no duplicate ids, every JS id exists,
     scripts present, hidden rules hold, nav wired with bookmarklets in
     both lists.
547. **ALREADY** checker.py clean with bookmarklets.js added to the shipped
     set. No dashes, no AI vocab, no fade gradients in any shipped file.
548. **DONE** node --check passes on bookmarklets.js, intro.js, theme.js,
     partners.js, and the rest of the shipped scripts.
549. **DONE** Headless Chrome renders the bookmarklets tab: 5 groups with
     titles, cards with names, copy buttons, lime accent class present.
550. **DONE** Both single-file builds regenerated after the tab, the version
     bump, and the robots files. Local 38.5MB, CDN 7.1MB.
551. **ALREADY** The build script inlines bookmarklets.js from the updated
     SCRIPTS list, so the mirror and the live site stay identical.
552. **ALREADY** The checker's hard-stop gradient rule still allows the two
     functional scroll fade masks and nothing else.
553. **DONE** Cache version moved to g in one sweep across 25 refs, so no
     script or stylesheet lags a day behind.
554. **ALREADY** Zero console.log in shipped JS. One TODO/FIXME marker total.
555. **P3** audit.mjs prints two nav lists with no labels. Plan: label them
     desktop and mobile so a failing row is readable at a glance.

## AQ. Live surfaces (556-565)

556. **ALREADY** lootline.xyz root 200 with the educational cover and cloak.
557. **ALREADY** www.lootline.xyz 200.
558. **ALREADY** chalkle.lootline.xyz 200.
559. **ALREADY** relay yt search 200, music search 200 through the tunnel.
560. **ALREADY** vendored game gn/0.html 200, uv proxy path 200.
561. **ALREADY** quick tunnel 200 on the same build.
562. **DONE** bookmarklets.js serves 200 through the tunnel with the g
     version.
563. **DONE** gzip headers verified on the live tunnel for html and css.
564. **DONE** robots.txt and sitemap.xml 200 on origin and tunnel.
565. **ALREADY** Assets from the whole session (sizzle logo, cursor pair,
     cloak webp) all still 200.

## AR. Accessibility and copy (566-575)

566. **ALREADY** Zero icon-only buttons missing labels across index.html.
567. **DONE** Bookmarklet cards are clickable cards with a real button for
     copy, so keyboard users get a labeled control.
568. **ALREADY** Cloak is focusable and dismissible with Enter or Space.
569. **ALREADY** Focus rings use the tab accent, which is now lime on the
     bookmarklets view.
570. **DONE** Blurbs stay under one line. The longest is 11 words.
571. **DONE** Group hints stay under 10 words. No paragraph walls anywhere
     on the tab.
572. **DONE** No em dashes, en dashes, or AI-vocab words in the tab copy,
     the data file, or this audit (checker enforced).
573. **ALREADY** Reduced motion skips the boot and reveals the app right
     after the cloak.
574. **ALREADY** The boot skip still works and the panic key is untouched.
575. **ALREADY** Noscript copy stays neutral and product free.

## AS. Performance (576-585)

576. **DONE** Cloak payload holds at 36KB webp, down from 934KB png.
577. **DONE** Gzip now cuts html and css transfer by roughly 70 percent for
     clients that ask for it.
578. **DONE** Versioned js and css cache for a full day, so repeat visits
     skip downloads entirely.
579. **ALREADY** Game thumbs lazy load with async decode.
580. **ALREADY** Fonts preconnect to both Google hosts.
581. **ALREADY** Ads stay inert until real unit ids exist.
582. **DONE** bookmarklets.js is under 20KB raw and gzips smaller, added to
     a page that already lazy-renders its data tabs.
583. **ALREADY** The cover is deleted before first paint and costs users
     nothing.
584. **ALREADY** The subpath mirror probe is one HEAD request and stays
     dormant on the real domain.
585. **P3** The 38.5MB local single-file build remains the price of 8
     embedded games. Lazy fetch plan still open from item 490.

## AT. Processes and infra (586-595)

586. **ALREADY** One hidden keeper runs server, music, and named tunnel.
     No taskbar windows.
587. **ALREADY** The hidden spawn pattern was proven earlier by a test run
     that wrote 42 to its log.
588. **ALREADY** Named tunnel healthy; quick tunnel healthy on this pass.
589. **DONE** Server restarted cleanly after the gzip edit and passed the
     compile check first.
590. **P2** Seven orphan node music processes were counted earlier. The PID
     file plan from item 492 still stands.
591. **ALREADY** Keeper checks origin health before bouncing a tunnel.
592. **ALREADY** The autostart path now registers the hidden VBS launcher at
     logon, both Startup folder and Task Scheduler.
593. **P3** Quick tunnel support in the keeper stays optional and open.
594. **ALREADY** No cmd windows left open from this session; scratch DOM
     dumps went to the gitignored temp path.
595. **P3** Write the keeper setup into one doc so a reboot never strands
     the site.

## AU. Cleanup ledger and next (596-600)

596. **DONE** Scratch files from the session are gone or gitignored. The
     tmp-start bats stay because they are the documented manual restart
     path.
597. **DONE** Version string is uniform at g across all 25 refs.
598. **DONE** Single-file mirrors match the live sources after the rebuild.
599. **P2** Full 14-tab sweep with page-error capture per view, using the
     dependency-free headless checker pattern.
600. **P2** Ship the bookmarklets tab to the mirrors (Pages workflow) and
     re-probe the filter report after the robots and sitemap go live.
