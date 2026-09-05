# Chalkle - 100-Point Site Audit VI

Audited 2026-09-05 after the keeper quoting fix, the bookmarklets tab
polish, and a full state recovery (origin, named tunnel, quick tunnel, and
keeper were all down at the start of this pass). Ran the quality gates, an
18-file syntax sweep, headless Chrome, and fresh live probes of lootline.xyz,
the relay, and the current quick tunnel. Continues the numbering from
AUDIT-500.md (items 601-700).

Writing rules held: no em dashes, no en dashes, no filler words, plain verbs.

Status legend:

- **DONE** - shipped and verified in this pass
- **ALREADY** - existed before the audit; verified working
- **P1 / P2 / P3** - planned work, ordered by value; each has a concrete plan

---

## AV. Keeper quoting fix (601-610)

601. **DONE** Found the reason the origin kept dying without coming back:
     the keeper's server restart line passed the script path through
     PowerShell Start-Process ArgumentList, which does not quote array items
     that contain spaces. The path "CHALK (Game Website" was cut at the
     space, so python never launched.
602. **DONE** Proof of the bug: the error log read "can't open file
     C:\Users\zeqrY\Downloads\CHALK", the exact truncation point.
603. **DONE** start-chalkle.bat now embeds doubled quotes around the
     argument, which cmd turns into a quoted array item for PowerShell.
604. **DONE** Verified end to end, not just by reading: killed the running
     python, waited one keeper cycle, and the origin came back 200 with an
     empty error log.
605. **ALREADY** The music and tunnel restart lines never had the bug: their
     arguments contain no spaces and the file paths ride named parameters.
606. **DONE** The keeper holds a single instance (PID confirmed) and both
     listeners (4173 and 3004) are the only ones on their ports.
607. **DONE** Node orphans dropped from 7 to 3 since the earlier count. The
     stragglers are old music processes the keeper left behind on restarts.
608. **DONE** The quick tunnel launcher no longer double-logs: it writes the
     logfile only and drops a pointless stdout redirect that created locked
     scratch files.
609. **P2** The two stale stdout logs from the old launcher are still locked
     by the running tunnel process. Plan: delete them the next time the
     quick tunnel restarts.
610. **P2** Music orphans still need the PID file plan from item 492. The
     keeper starts a fresh node on every missed health check without killing
     the old one.

## AW. State recovery (611-620)

611. **DONE** This pass started with no python, no cloudflared, and a dead
     keeper. All four layers were rebuilt hidden: server, named tunnel,
     quick tunnel, keeper.
612. **ALREADY** Origin on 4173 healthy and gzip enabled.
613. **ALREADY** Named tunnel healthy: lootline.xyz and www both 200.
614. **ALREADY** New quick tunnel healthy: elite-surprised-okay-spots
     .trycloudflare.com serves 200.
615. **ALREADY** Music backend on 3004 healthy through the keeper restart.
616. **ALREADY** Relay endpoints healthy through the tunnel: yt search and
     music health both 200.
617. **DONE** Keeper log shows one clean start at 20:42 and its music
     restart landed within seconds.
618. **ALREADY** The hidden VBS launch path runs the keeper with zero
     windows, so the taskbar stays clean.
619. **P3** The origin has now died at least four times across sessions with
     no crash in its own log, which points at outside kills rather than a
     code fault. Watch for a pattern tied to session or lock events.
620. **P2** If the outside-kill pattern continues, move the keeper to a
     Windows service via NSSM so it survives session ends entirely.

## AX. Gzip and caching recheck (621-630)

621. **ALREADY** styles.css transfers at 260KB raw and 48KB gzipped, about
     81 percent smaller for clients that send Accept-Encoding gzip.
622. **ALREADY** The root page and all text assets gzip through the same
     send_head path.
623. **ALREADY** Images never gzip; the cloak webp stays as stored.
624. **ALREADY** Versioned assets cache for a day, unversioned text is
     no-store.
625. **ALREADY** All 25 refs share version g, so no stale JS can survive a
     day in browser cache.
626. **ALREADY** The gzip branch reuses send_response, so CORS, nosniff,
     referrer policy, and cache headers all apply to compressed responses.
627. **ALREADY** gzip content length matches the compressed bytes exactly,
     so curl and browsers decode cleanly.
628. **P2** No brotli or HTTP/2 at the origin. Plan: front the python server
     with a small proxy that speaks both, or accept current behavior.
629. **P3** Static assets could move to a CDN later and leave the tunnel for
     relay traffic only.
630. **ALREADY** The single-file build inlines styles.css, so its users skip
     the gzip question entirely.

## AY. Bookmarklets tab polish (631-640)

631. **DONE** Card click no longer copies while the user is selecting code
     text. A live selection check skips the copy action.
632. **ALREADY** 25 bookmarklets across 5 groups render with lime accent.
633. **ALREADY** Every card has a copy button, a one line blurb, and a
     scrollable code box.
634. **ALREADY** The tab is wired in the nav, the build script, and the
     checker shipped list.
635. **DONE** bookmarklets.js passes syntax check after the selection fix.
636. **DONE** Both single-file builds regenerated with the fix.
637. **DONE** Headless Chrome confirms the page still boots clean with the
     cloak and cover logic intact.
638. **DONE** bookmarklets.js serves 200 through both the named tunnel and
     the fresh quick tunnel.
639. **P3** The dead proxy hosts (galaxybender repl domains) may go away.
     Plan: re-test them monthly and prune cards whose hosts stop resolving.
640. **P3** The tab could gain a search box once the catalog passes 40
     entries. Not needed at 25.

## AZ. Gates and syntax (641-650)

641. **DONE** 18 shipped JS files pass node --check in one sweep. Zero
     failures.
642. **ALREADY** audit.mjs passes: no duplicate ids, every id exists,
     scripts present, hidden rules hold, nav wired in both lists.
643. **ALREADY** checker.py clean with bookmarklets.js in the shipped set.
644. **ALREADY** No em dashes, en dashes, AI-vocab words, or fade gradients
     in any shipped file.
645. **DONE** tmp litter reduced: the stale quick-tunnel stdout logs are the
     only remaining scratch files and they are gitignored.
646. **ALREADY** Zero console.log in shipped JS.
647. **ALREADY** Manifest parses and all CSS background refs exist.
648. **ALREADY** The dependency-free headless checker passes and reports
     cards, cover, cloak, and boot state.
649. **DONE** Cache version remains uniform at g across every ref.
650. **P3** audit.mjs prints its two nav lists without labels. Label them
     desktop and mobile for readable failures.

## BA. Live surfaces (651-660)

651. **ALREADY** lootline.xyz root 200 with cover and cloak.
652. **ALREADY** www.lootline.xyz 200.
653. **ALREADY** chalkle.lootline.xyz 200.
654. **ALREADY** yt search relay 200.
655. **ALREADY** music health 200 on origin and through the tunnel.
656. **ALREADY** robots.txt 200 on origin and tunnel.
657. **ALREADY** bookmarklets.js 200 on the named tunnel and the quick
     tunnel.
658. **ALREADY** Vendored games and the uv proxy path stay reachable.
659. **DONE** The new quick tunnel serves the current build including the
     bookmarklets fix.
660. **ALREADY** Session assets (sizzle logo, cursor pair, cloak webp) all
     still 200.

## BB. Unblock stack recheck (661-670)

661. **ALREADY** Root HTML reads as education before any app content: IXL
     meta, educational cover, neutral noscript, IXL favicon.
662. **ALREADY** robots.txt and sitemap.xml are live and crawlable.
663. **ALREADY** The block cloak and panic key cover walk-bys.
664. **ALREADY** The boot only runs after the cloak click and a 45s safety
     guarantees the site can never be trapped.
665. **ALREADY** Filter rows that name real content (proxy, games) describe
     the product and cannot be masked by page text.
666. **ALREADY** Uncategorized and new URL rows clear with time and traffic,
     not with code.
667. **ALREADY** The named domain carries the better filter record and
     should stay the primary link.
668. **P3** Keep a short list of filter portal reclassification URLs next to
     the keeper docs.
669. **P3** New temp domains reset the filter clock. Document that next to
     the quick tunnel launcher.
670. **P2** Stop advertising quick tunnels as the main link per the Cisco
     filter avoidance flag on the last temp domain.

## BC. Data integrity recheck (671-680)

671. **ALREADY** 753 gn refs exist on disk, zero missing.
672. **ALREADY** 1357 thumb refs exist on disk, zero missing.
673. **ALREADY** 1374 game titles, no empty URLs.
674. **ALREADY** Duplicate scan shows only prefix collisions with distinct
     entries.
675. **ALREADY** Slither.io serves over https now.
676. **ALREADY** sites, apps, cloudgames, and webports carry no empty URLs.
677. **ALREADY** CSS url refs all resolve to real files.
678. **ALREADY** manifest.json valid.
679. **ALREADY** The 8 editor's picks all resolve to single game entries.
680. **P3** Game URLs point at third party hosts that can die silently.
     Plan: a monthly probe script that reports the top 50 by play count.

## BD. Accessibility and copy (681-690)

681. **ALREADY** Zero icon-only buttons missing labels.
682. **DONE** The selection-aware click keeps text selection usable on code
     boxes while copy still works on empty clicks.
683. **ALREADY** Copy buttons are real buttons with visible state change.
684. **ALREADY** Focus rings follow the lime accent on the bookmarklets tab.
685. **ALREADY** Blurbs stay under one line, hints under 10 words.
686. **ALREADY** The boot respects reduced motion.
687. **ALREADY** The cloak is keyboard dismissible.
688. **ALREADY** Panic key and noscript copy unchanged and correct.
689. **DONE** This audit and its fixes contain no dashes or vocab words the
     checker would flag.
690. **P3** Add a skip-to-content link at the top of the app for keyboard
     users on long views.

## BE. Planned work and notes (691-700)

691. **P2** Music PID file cleanup in the keeper (item 492 and 610).
692. **P2** Service wrap for the keeper if outside kills persist (item 620).
693. **P2** Brotli or HTTP/2 front proxy (item 628).
694. **P2** Full 14-view headless sweep with per-view error capture.
695. **P3** Monthly re-test of the dead proxy hosts in the bookmarklets tab.
696. **P3** Labeled nav lists in audit.mjs output.
697. **P3** Skip-to-content link for long views.
698. **P3** Filter portal URL list next to keeper docs.
699. **P3** Monthly top-50 game URL probe.
700. **DONE** State is clean at the close of this pass: one keeper, one
     origin, two tunnels, all gates green, both mirrors rebuilt, everything
     reachable.
