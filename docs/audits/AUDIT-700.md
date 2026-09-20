# Chalkle - 100-Point Site Audit VII

Audited 2026-09-14 after the keeper single instance and PID file work, the
new per view headless sweep, the TMDB keyless fallback fixes, and the skip
link. The pass started with a Freebuff restart that had killed everything,
and closed with one keeper, all gates green, and the sweep passing on all
15 views. Continues the numbering from AUDIT-600.md (items 701-800).

Writing rules held: no em dashes, no en dashes, no filler words, plain verbs.

Status legend:

- **DONE** - shipped and verified in this pass
- **ALREADY** - existed before the audit; verified working
- **P1 / P2 / P3** - planned work, ordered by value; each has a concrete plan

---

## BF. Keeper single instance and PID files (701-715)

701. **DONE** Freebuff restarted mid pass and killed the shell. Re found the
     state: the Task Scheduler watchdog had started the keeper through the
     production VBS path with the new script, the origin answered 200, and
     all five pid files existed. The new keeper survived a cold boot.

702. **DONE** keeper.log shows the guard firing in the wild: 20:17:12
     "another keeper is already running, this copy exits". The second copy
     from an earlier manual start was rejected. One keeper loop stayed up.

703. **DONE** scripts/keeper-singleton.ps1 counts other cmd processes whose
     command line mentions start-chalkle.bat and excludes its own caller by
     parent PID. The in bat tasklist /V approach was replaced after it
     proved unreliable in tests (item 606 depended on it).

704. **DONE** kill_stale in start-chalkle.bat now reads
     chalkle-pids/<name>.pid, kills the recorded PID only when it is still
     alive and still runs the expected image, then deletes the file. No
     parenthesized blocks, so delayed expansion cannot bite.

705. **DONE** All 23 tool call sites in the keeper are pinned to absolute
     System32 paths (tasklist, taskkill, find, curl, powershell). Root
     cause of the silent kill skip from earlier attempts: the keeper had
     inherited a bash style PATH where find resolves to GNU find, whose /I
     flag errors and flips the errorlevel check. Production launches have
     a clean PATH, but the pin makes the keeper immune either way.

706. **DONE** End to end proof of the kill path: planted a live sacrificial
     node as music.pid, killed the real music backend, and the keeper
     logged "killing stale music process 13468 before restart", killed the
     dummy, and restarted music. The new listener matched the new pid file.

707. **DONE** Restart through the keeper doubles as the deploy path for
     server code: killing the python PID made the keeper bring the origin
     back with the new code within one cycle. Used three times this pass.

708. **ALREADY** The crash loop guard on the server check (port answered
     but not 200 means leave it alone) held during every bounce this pass.

## BG. Per view headless sweep (716-725)

709. **DONE** scripts/sweep-views.mjs boots the real app in headless Chrome
     over CDP, derives the view list from the section.view data-view tags
     in index.html (no hardcoded list), walks every view, and captures per
     view console errors, page exceptions, local responses with status 400
     or worse, and whether the switch actually happened (body data-view
     plus visible section). Writes tmp/sweep-last.json after each run.

710. **DONE** The More menu tabs are clicked through the real path: if a
     tab button is inside the collapsed menu, the sweep opens the menu
     first. Every one of the 15 views switches and reports visible.

711. **DONE** The sweep found a real site bug on its first run, which is
     exactly what item 491 asked for. See items 719 to 723.

712. **DONE** Closed 09/16, next pass. The sweep mirrors every line to
     tmp/sweep-last.log as it prints it, so a truncated pipe can no longer
     hide the verdict, and its last line names both output files.

713. **P3** The sweep boots once and clicks through views. A per view full
     reload mode would catch boot order bugs the click walk cannot see.

714. **P3** final-smoke.mjs still covers library search and leak checks;
     the two scripts now overlap only in boot. Fine to keep both.

## BH. TMDB keyless fallback fixes (719-730)

715. **DONE** The sweep flagged 401s on /api/tmdb/... across 6 views. The
     vendored TMDB bearer token is dead ("Invalid API key"), and the
     Cinemeta fallback in serve-chalk.py answered some routes but passed
     the raw 401 through for others. No console errors appeared anywhere:
     the widgets degrade quietly, so only the sweep caught this.

716. **DONE** Route 1: TMDB /movie/popular and /tv/popular (home widgets
     and rail prefetches) were not covered by the fallback regex. New
     branch maps them to Cinemeta catalog/{movie|series}/popular.json with
     page based skip, verified returning real rows (Reacher first on tv).

717. **DONE** Route 2: numeric detail lookups under tv/ for ids the map
     knows as movies (tv/278 is Shawshank) failed because the fallback
     trusted the request type and Cinemeta answers a wrong type lookup
     with null. The detail branch now prefers the id map's stored type and
     tries the opposite type once before giving up. The four failing ids
     from the sweep all return 200 now.

718. **DONE** After both fixes the sweep passes 15 of 15 views with zero
     console errors and zero bad responses, and the fix is confirmed live
     through chalkle.lootline.xyz (200 on /api/tmdb/tv/popular).

## BI. Skip link and nav labels (731-735)

719. **DONE** Skip to content link added as the first element inside #app
     (items 690/697). Hidden until focused (translateY off screen), yellow
     pill in the cloak button style, jumps to #main. #main gained
     tabindex="-1" so the jump lands cleanly for keyboard and screen
     reader users.

720. **DONE** Verified in headless Chrome through the preview: the link is
     present with the right text and target, the computed style carries
     the off screen transform, and :focus slides it in. The focused check
     initially read as a failure because the headless page has no window
     focus (document.hasFocus() false), which is a test environment fact,
     not a bug.

721. **DONE** The primary nav gained aria-label="Primary" and audit.mjs
     now checks the three nav groups separately (primary, More menu,
     bottom) instead of one flat list (item 696). Current wiring: 8
     primary, 6 More, 1 bottom, all 15 sections accounted for.

722. **ALREADY** The bottom nav and the socials group already carried
     aria-labels.

## BJ. State of the hosts (736-740)

723. **ALREADY** Host routing in serve-chalk.py was re verified after a
     confusing probe round: lootline.xyz (apex) serves the Jexel tools hub
     from jexel/, yut.lootline.xyz serves the Yut upload site, and the
     main Chalkle site lives at chalkle.lootline.xyz. The 4173 origin is
     the single source for all three; nothing is stale.

724. **DONE** chalkle.lootline.xyz serves the new index.html (skip link
     present) and the new styles.css (v=20260930b).

725. **DONE** deploy-static/index.html and deploy-static/src/styles.css
     synced with the root copies after diffing to confirm the only deltas
     were this pass's changes. Cache param bumped to ?v=20260930b.

726. **DONE** build/chalkle-single.html and build/chalkle-single-cdn.html
     rebuilt from the new sources (150.6 MB and 37.7 MB).

727. **ALREADY** The named tunnel runs with the standard config, one
     connector, PID from the keeper.

## BK. Gates and close (741-750)

728. **DONE** node scripts/audit.mjs: all checks pass, including the three
     new labeled nav group lines.

729. **DONE** python tools/checker.py: clean (no dashes, no vocab words in
     shipped files, including this audit's shipped edits).

730. **DONE** node --check on every touched script. py_compile on
     serve-chalk.py.

731. **DONE** Closed 09/16, next pass. The proxy remembers the exact
     authorization header that a 401 or 403 refused and answers covered routes
     from the keyless fallback without asking again, so a repeat read of
     /api/tmdb/movie/popular dropped from one doomed upstream call to about a
     millisecond. Routes the fallback cannot build are still asked upstream, so
     a replaced token or a pasted key stays in play. Pinned by
     tools/tmdb-token-test.py.

732. **DONE** Closed 09/16, next pass. The sweep held its watchdog timer
     open, so a clean 15 view pass still sat for four minutes and then exited 2
     with "watchdog timeout". It now clears the timer, closes the socket, kills
     Chrome and exits 0 on a pass, or 1 on any failing view (checked against a
     dead port). The README gate list names it, so the three gates run
     together after content changes.

733. **P3** Monthly top 50 game URL probe (carried item 699) can reuse the
     sweep's CDP plumbing for per game load checks.

734. **DONE** State is clean at the close of this pass: one keeper, one
     origin, one named tunnel connector, sweep green on 15 views, gates
     green, mirror and single file builds current, main site fresh at
     chalkle.lootline.xyz.

## BL. Arsenic port pass (735-740)

735. **DONE** Mined the arsenic source (Downloads/arsenic-main) for portable
     features. Its decoy entry page (a novella reader hiding the app behind
     a base64 document write) and its about:blank launcher already have
     stronger Chalkle equivalents (the IXL cover plus block page, and the
     settings About:blank row), so the port picked what was missing: the
     panic escape key, custom cloak overrides, and it surfaced a latent
     settings bug. New probe: scripts/probe-cloak.mjs.

736. **DONE** Panic key. One keypress (default backtick) either swaps the tab
     for the panic redirect through location.replace so the escape page
     never sits behind the Back button, or rebuilds the educational cover
     in place. Rebuilt cover is pinned fixed on top with an inline takeover
     style because its own CSS assumed boot order. Key is ignored while
     typing in inputs, textareas, selects, or contenteditable, and never
     fires with ctrl, meta, or alt held. Config persists in localStorage
     under chalkle-panic.

737. **DONE** Panic target picker in Settings: Classroom, Docs, Google,
     Canvas, Clever, or the cover the site rebuilds. A saved custom target
     shows as its own option instead of snapping to the first preset.

738. **DONE** Custom cloak overrides (arsenic style): Settings now has a
     cloak tab icon URL field next to the title field, and both override
     any preset while empty fields mean the preset decides. This fixed a
     latent bug: the cloak title field saved to localStorage but nothing
     ever applied it. Its stored default value also would have stomped
     every preset title, so the default is now empty. Both edits reapply
     the active cloak live.

739. **DONE** Verified live in headless Chrome: 8 of 8 probe checks pass
     (custom title and icon win over presets, custom survives the None
     preset, panic key ignored in fields, cover rebuild fixed on top with
     the IXL title, URL escape leaves via replace). Full 15 view sweep
     PASS with zero console errors and zero bad responses after the
     changes, cache bumped to 20260930c, mirror synced, both single file
     builds rebuilt.

740. **P3** Panic cover could also pause in page video players (the music
     backend already pauses through ChalkleMusic); the YouTube and LiveTV
     frames keep playing under the rebuilt cover until the tab changes.

741. **DONE** Fixed Doodle Jump framing in both variants (cldoodlejump and
     cldoodlejumpgoober). The CodePen export hardcoded a 422x552 board on a
     black body top aligned, so Chalkle's tall game player showed a small
     column of gameplay in a sea of black. The board now scales to fit the
     window through a uniform CSS transform driven by a resize listener, so
     physics and hit targets scale together, and the letterbox uses the
     game's own paper tone sampled from its background tile instead of
     black. Also guarded the CodePen only maeExportApis_ parent call that
     threw a TypeError on every load, and renamed the goober entry from
     "CodePen - A Pen by bound20" to Doodle Jump Goober. Verified with a
     headless layout probe: scale, centering, letterbox color, and clean
     boot pass on both files, cache bumped for games2, mirror synced, both
     single file builds rebuilt.
