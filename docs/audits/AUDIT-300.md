# Chalkle - 100-Point Site Audit III

Audited 2026-09-04 against the working tree (which held a full pending rework:
new-tab launcher rewrite, Blank Tab removal, YouTube instance racing, AI tab
polish, the relay CORS dedupe) plus a headless-Chrome sweep of all 14 tabs and
live probes of lootline.xyz, the Pages mirror, the jsDelivr build and the
relay. Continues the numbering from AUDIT-200.md (items 201-300).

Status legend:

- **DONE** - shipped and verified in this pass
- **ALREADY** - existed before the audit; verified working
- **P1 / P2 / P3** - planned work, ordered by value; each has a concrete plan

---

## U. Launcher rework correctness (201-210)

201. **DONE** The pending launcher rewrite kept `window.open(url, "_blank",
     "noopener")` in four places. Per spec the "noopener" feature string makes
     window.open return null, so `openDirect`'s popup-blocked fallback
     (`if (!win) ... inAppFrame`) fired on every successful open (double-open)
     and `openProxy`/`openProxyApp` always reported failure. Replaced with a
     shared `openTab()` helper that opens without "noopener" and severs
     `win.opener` manually - cross-origin tabs can never reach back anyway.
202. **DONE** Verified the fix headless: launcher opens, popup-blocked
     fallback no longer double-fires, and all 14 tabs still pass the CDP sweep
     with zero page errors after the change.
203. **DONE** Stale copy updated to match the rework: the Proxies tab hint
     still advertised "open through it in the iframe, about:blank, new tab, or
     whatever mode you pick" - now describes plain new tab + in-app frame
     fallback. The admin form textarea placeholder still said "opens in
     about:blank, blob or this tab" - now "opens in its own tab". The
     open-with button aria-label/title ("Choose how to open") - now "Open in
     a new tab".
204. **DONE** app.js admin-panel header comment still described the removed
     "direct / about:blank / blob / iframe picker" - rewritten to the
     new-tab model so future readers don't go hunting for a picker that
     no longer exists.
205. **DONE** `blanktab.js` was deleted in the rework and every reference is
     gone (index.html, build script, checker SHIPPED list) - verified by
     grep across all shipped files.
206. **ALREADY** Proxy routing survived the rewrite correctly: local
     same-origin pages (/game-builds/...) never route through the rewriting
     proxy; `file:`/`javascript:` targets are refused; data:/blob: pass
     through untouched; hash-route vs path-route proxies both handled.
207. **DONE** The in-app frame overlay fallback sets `ChalkleLaunch.lastOpenUrl`
     so the overlay's "New tab" button can pop the game out - verified the
     property is set in `inAppFrame` and read by the overlay controls.
208. **DONE** The launch chooser markup is fully removed from index.html and
     the single-file build strips the chooser block via its existing regex -
     confirmed no `launch-modal`/`launchModal` references remain anywhere.
209. **P2** `openProxyApp` returns the routed URL string or "" as its only
     error signal; callers that ignore the "" case cannot distinguish
     "opened" from "silently dropped". Return a { ok, url } shape next time
     the launch API is touched.
210. **P3** The launcher probe of /uv/ runs once at boot with no retry; if the
     server comes up late (slow tunnel boot) the builtin proxy stays
     disabled for the session. Add a 10s-later re-probe on first failed use.

## V. Pending-rework verification (211-220)

211. **DONE** The working tree held an uncommitted rework (launcher rewrite,
     Blank Tab removal, YouTube parallel instance racing with per-instance
     cooldowns, AI model-list tooltip + "checked hh:mm" timestamp, Survival
     Race switched to the official survival-race.io embed, emulator notes
     like "Bring your own ROM (.z64/.n64)", Serium SVG/PNG art updates,
     start-chalkle.bat keeper changes). Reviewed and verified working before
     building this audit on top: checker clean, audit.mjs green, 14/14 tabs
     OK headless, relay endpoints 200 through the tunnel.
212. **DONE** Committed the pending rework as part of this pass so the audit
     baseline and the repo state finally agree (the CORS dedupe fix from
     the last session was sitting uncommitted and unprotected).
213. **DONE** checker.py SHIPPED list still named five files that do not exist
     (history.js, settings.js, tools.js, share.js, blanktab.js) - a missing
     file can never fail the gate, so the check was noise. List trimmed to
     the real shipped set.
214. **DONE** checker.py DASH scan flagged the IXL cloak meta (IXL's own copy
     contains "K-12" with an en dash) as 6 violations, making the gate red
     on every run and training everyone to ignore it. The mirrored IXL
     description must stay byte-identical, so the scan now allows exactly
     that meta line; gate is green again and still catches real dashes.
215. **ALREADY** The IXL unblock stack is consistent end to end: meta
     description/og/twitter byte-mirror ixl.com, favicon is
     ixl.com/favicon.ico, no-cloak tab title is the IXL page title, and
     `captureCloakIcon()` restores the IXL favicon when the cloak is set
     back to None.
216. **ALREADY** Panic key intact after the rework: `` ` `` triple-press or
     Ctrl+Shift+` clears any beforeunload guard and location.replace()s to
     Google Classroom; verified present in index.html inline script.
217. **ALREADY** AI reply rendering is XSS-safe: model output is escaped
     (`esc(m.content)`) before the `<br>` newline substitution lands in
     `bubble.innerHTML`; no raw innerHTML path for remote content.
218. **ALREADY** All `target="_blank"` links in index.html carry
     `rel="noopener"`; JS-built anchors use the same; file: URLs are
     rendered as "#" so a stray saved path can't trip Chrome's
     file-link security error.
219. **P2** The launcher `openTab` helper deliberately keeps a window handle
     and nulls opener - fine - but `openJamesEdition` still holds the opener
     on purpose to cloak the new tab's title. Document both patterns in one
     place so a future security pass doesn't "fix" either.
220. **P3** Emulator entries now carry helpful notes ("Flash player. Load your
     own .swf file"). Give cloud and webport cards the same one-line note
     slot so controls/ROM expectations are visible before launch.

## W. Quality gates & build (221-230)

221. **DONE** audit.mjs passes: no duplicate ids, every JS id exists in HTML,
     all script files exist, hidden elements stay hidden, nav sections wired
     (14 tabs + duplicates for the mobile drawer).
222. **DONE** checker.py green after the allowlist change (#214).
223. **DONE** Cache-bust version bumped 20260904a -> 20260904b across all 24
     script/CSS refs in index.html.
224. **DONE** **Build bug found:** `build-single-chalkle.mjs --cdn` wrote
     *both* chalkle-single.html and chalkle-single-cdn.html, so the last
     CDN run had silently clobbered the 35.6MB local build (8 embedded
     self-contained games) with the 6.8MB CDN variant. Fixed: each mode
     now writes only its own file, and the local build was rebuilt and
     restored (35.6MB, 8 embedded games verified).
225. **DONE** Both single-file builds regenerated from the fixed sources at
     v20260904b; CDN build carries the new expand-persistence code
     (verified by grep before pushing).
226. **DONE** Headless end-to-end test of the new grid persistence: games
     grid capped at 480 -> click "Show all N more" -> grid expands and
     sessionStorage stores {"games":true} -> navigate Home and back ->
     grid is still expanded (no Show-more button), zero console errors.
227. **DONE** 14-tab CDP sweep re-run after all edits: every tab OK, zero
     page errors, zero console errors.
228. **ALREADY** `404s` sweep on the local server reports 0 missing assets
     (thumbnails, icons, data files) after the earlier asset commits.
229. **P2** audit.mjs still cannot catch the class of bug in #224 (a build
     step destroying an artifact) or #201 (spec-level window.open behavior).
     Add a smoke step that runs both build modes and asserts each file's
     expected size class.
230. **P3** The two build modes share 95% of logic; a `--both` flag writing
     both files correctly would remove the temptation to run them in the
     wrong order during releases.

## X. Grid & data UX (231-240)

231. **DONE** The 480-card cap now remembers expansion per view in
     sessionStorage (`chalkle-grid-expanded`), closing AUDIT-200 #155 and
     AUDIT-100 #46: returning users keep the full grid for the session.
232. **ALREADY** "New this week" ribbons render on isNew cards (#154 from
     AUDIT-200 - shipped in the interim rework; verified in code and
     visible in the Games view).
233. **ALREADY** Sort controls (Favorites / Most popular / A-Z / Z-A) and the
     genre multi-select chips both verified wired in the current render().
234. **ALREADY** Recents keep launch-time snapshots (thumb/url/html) and
     resolve ghost entries by title fallback so renamed games still show
     real art - verified the snapshot/fallback chain survived the rework.
235. **P2** The Popular shelf is click-score based; a fresh profile sees a
     near-arbitrary order (AUDIT-200 #159). Bootstrap with a seeded
     popularity map shipped in the data files.
236. **P2** Editor's Picks titles are not validated against games.js at boot
     (AUDIT-200 #156); a renamed pick silently drops from the shelf.
     Validate on boot and log dropped picks to the console once.
237. **P3** Cloud grid lacks the standard "N items" meta line that other
     grids have; route it through the same meta element.
238. **P3** The apps/tools grid has category chips but no sort parity with
     Games (#158); queue a size/sort control row once categories settle.
239. **P3** Genre chips list is derived from live data, so a single test
     entry with a weird category adds a chip to everyone's UI; normalize
     categories at import time (import-chud/import-stratus) instead.
240. **P3** Add a "clear expanded-grid state" to the Advanced settings reset
     (when #182/#76 lands) so a stuck expanded state is recoverable.

## Y. Site, relay & mirrors (241-250)

241. **DONE** Verified every live surface healthy before writing this file:
     lootline.xyz 200, GitHub Pages 200, relay /yt/search 200,
     /api/ai/models 200 with a real model list, /music/health 200
     {"backend": "http://127.0.0.1:3004"}, and exactly one
     Access-Control-Allow-Origin header on relay responses (the earlier
     double-CORS fix is holding).
242. **ALREADY** The CORS dedupe guard in serve-chalk.py (last session's fix)
     is present in the pending diff and now committed; relay no longer
     sends `Access-Control-Allow-Origin: *, *`, which browsers reject.
243. **ALREADY** serve-chalk.py sends X-Content-Type-Options: nosniff and
     Referrer-Policy: same-origin on page responses; static assets carry
     cache headers; index is no-store (verified in local headers).
244. **DONE** flare/ (5.1GB local ruffle/flash experiment: ruffle.min.js,
     wasm builds, probe files) is unreferenced by any shipped file - the
     Apps/Tools emulator entries point at truffled.lol instead. Added
     flare/ to .gitignore so 5GB of local experiment never lands in git.
245. **DONE** screenshots/ (14MB audit output, flagged as P3 in AUDIT-100
     #99) added to .gitignore; the directory grows unbounded from test
     runs and has no place in the repo.
246. **DONE** README rewritten: the old text documented the removed launcher
     picker ("Direct, About:blank, Blob, This tab, or Proxy"), stale
     settings lists, "327 games" counts and a launcher.js description that
     no longer matched. New README covers the 14 tabs, the new-tab launcher
     with proxy routing + frame fallback, the cloak/panic system, the relay
     architecture, the mirror mode (runtime-config.js), the full audit
     workflow (checker, audit.mjs, build script, version bumps) and the
     real file map.
247. **P2** The keeper script (start-chalkle.bat) runs but has no
     verification step; add a curl self-check per loop that restarts
     serve-chalk.py on non-200 (it currently only watches processes).
248. **P3** serve-chalk.py is ~3,000 lines and growing; the YouTube racing
     code added this cycle deserves its own module (AUDIT-100 #98 stands).
249. **P3** The relay /music/api pass-through has no auth; fine while the
     backend is localhost-only, but add a token before exposing it.
250. **P3** runtime-config.js mirror resolution is verified working on
     Pages; document the override URL param (?api=) in the README mirror
     section so debugging mirrors is possible without editing files.

## Z. Repo hygiene & CRLF (251-260)

251. **DONE** Working tree cleaned of drift: the entire pending rework
     (launcher, youtube, ai, apps, sites, livetv, partners, games, styles,
     serve-chalk, checker, bat, build script) committed with this pass's
     fixes on top, so `git status` is clean after push for the first time
     in several days.
252. **ALREADY** .gitignore already covers game-builds/, web-port/, logs,
     scratch files (`_*`), runtime JSON and node_modules; this pass adds
     flare/ and screenshots/.
253. **P2** 84 tracked files use LF and the working copy keeps flipping to
     CRLF on edit ("LF will be replaced by CRLF" warnings on every git
     touch). Add a .gitattributes (`* text=auto eol=lf` for code files) so
     diffs stop carrying phantom line-ending churn.
254. **P2** The repo has no CI; the Pages deploy runs the moment main moves
     with no gate. Add the workflow step running checker.py + audit.mjs +
     a build smoke (see #229) before deploy (AUDIT-100 #96 / AUDIT-200
     #199 stand).
255. **P3** AUDIT files now number 300 items across three files; add a
     one-line index at the top of OVERHAUL.md pointing at all three so
     future passes don't re-audit shipped items.
256. **P3** tools/import-*.mjs scripts each embed their own data-shape
     assumptions; extract a shared normalize(entry) helper so category
     casing (#239) and isNew handling stay consistent.
257. **P3** music-backend/ ships without a README; document its endpoints
     (/music/api, /music/stream, /music/pic, /music/health) and the port
     expectation (3004) so the relay config is reproducible.
258. **P3** The stratus-api vendored copy drifts from upstream with no
     version note; record the upstream commit hash in a VENDORED.md.
259. **P3** Add `git check-ignore flare screenshots` to the smoke test so a
     future .gitignore edit can't silently re-admit 5GB.
260. **P3** Keep this audit in sync with OVERHAUL.md: flip P2/P3 tags here
     when they ship and link the change (AUDIT-100 #100 stands).

## AA. Unblock resilience (261-270)

261. **DONE** Verified the full unblock stack after the rework: IXL preview
     meta on index.html and inside the CDN build, IXL quick-disguise tile
     in Settings, no-cloak tab title = IXL, panic key wired, IXL favicon
     swap on cloak toggle - all present in the pushed build.
262. **ALREADY** The cloak grid carries Google, Classroom, Docs, Drive,
     Canvas, Clever, Khan and IXL with real icons; "None" restores the
     captured IXL favicon (not a Chalkle one), keeping preview and tab in
     agreement.
263. **ALREADY** The custom cloak-title field persists per device and
     overrides the quick-pick title text (app.js opt-cloak-title wiring
     verified).
264. **P2** The panic key currently always jumps to Google Classroom; make
     the panic target configurable in Settings (Classroom default, Docs /
     Drive / IXL as options) so it matches whatever the cloak claims.
265. **P2** The CDN build's fetch/XHR shim only intercepts paths present in
     the embedded map; a game that fetches a *sub-resource* of an embedded
     page (relative image inside embedded HTML) resolves against the
     blob/data origin and 404s. Test one embedded game end to end and
     document the limitation.
266. **P3** Add a second panic chord (e.g. Escape x5) for keyboards/locales
     where backtick needs a modifier.
267. **P3** The cloak icon list points at third-party favicons (gstatic,
     clever.com...); if one dies the tile shows a removed-image stub. Ship
     tiny inline SVG copies as onerror fallbacks.
268. **P3** Link-preview parity: og:image still points at the Chalkle
     background while title/description claim IXL; Discord shows an IXL
     card with a Chalkle screenshot. Either drop og:image (IXL's own
     preview has none) or ship a neutral "learning site" image.
269. **P3** Manifest name is "Chalkle" while the page title is IXL; PWA
     installs read the manifest, so an installed app shows Chalkle under an
     IXL favicon. Consider a manifest that inherits the cloak choice.
270. **P3** Verify the IXL mirror quarterly - ixl.com copy changes break the
     byte-identical claim silently; add a quarterly reminder item to
     OVERHAUL.md.

## AB. Music, TV & YouTube (271-280)

271. **ALREADY** Music backend healthy through the relay: /music/health
     returns ok with the real backend URL; /music/api routes verified.
272. **ALREADY** Music search now targets YouTube (server: "youtube") with
     results sorted by views; netease references in music.js are comments
     only, backend holds the Chinese-provider paths.
273. **DONE** YouTube fetch path hardened in the pending rework (now
     committed): all Piped instances race in parallel, dead instances get a
     45s cooldown, HTTP-error instances retry, 8s timeout - one slow
     instance can no longer stall a search for its full timeout.
274. **ALREADY** Client-side guards intact: parallel relay search, 8s
     timeouts, stale-response dropping, 15s client abort (AUDIT-100 #55).
275. **P2** The instance cooldown map (`_yt_down_until`) lives in-process;
     restarts lose it and the first search after each keeper restart
     re-probes dead instances. Persist it to a small JSON next to
     sync.json.
276. **P2** Live TV still has no per-channel health dot (AUDIT-200 #165);
     the relay's stream prober knows which channels 404.
277. **P2** No volume slider in the music player row (AUDIT-200 #163) -
     it lives only in the settings sheet.
278. **P3** HLS.min.js still loads on every page (AUDIT-100 #87); lazy-load
     it when the Live TV player first starts a stream.
279. **P3** YouTube results have no explicit "open in new tab" affordance
     beside the in-app player (AUDIT-200 #167).
280. **P3** Remember the last music search per session and restore it on tab
     re-entry (AUDIT-200 #168).

## AC. AI & settings (281-290)

281. **DONE** AI tab model-list line upgraded in the pending rework (now
     committed): tooltip explains the list comes from the site's AI relay,
     and the meta line shows "N models online - checked hh:mm" with a
     lastCheck timestamp so staleness is visible.
282. **ALREADY** AI conversations persist server-side via /api/ai/convos and
     the chat stream via /api/ai/chat - both verified 200 through the
     tunnel this pass.
283. **ALREADY** AI attachment types are whitelisted client-side (images +
     code/text extensions); accepted files render in an attachment row with
     remove buttons.
284. **P2** The AI "checked hh:mm" stamp never refreshes while the tab sits
     open; re-probe /api/ai/models on tab re-entry (setView hook) so the
     timestamp stays honest.
285. **P2** Settings still lacks the two-step "reset everything" button
     (AUDIT-200 #182); with cloak/panic/proxy state now riding on
     localStorage, a clean-slate button has real value.
286. **P2** Surface a "back up my setup" CTA in Appearance that downloads
     the export JSON directly (AUDIT-200 #183); export/import exists but
     is buried in Advanced.
287. **P3** The whatsnew overlay entries are markup-driven; move to a small
     JSON blob so releases stop touching HTML (AUDIT-200 #186).
288. **P3** Persist the last-viewed settings pane so reopening lands where
     the user was (AUDIT-200 #190).
289. **P3** Clock visibility toggle in the topbar (AUDIT-100 #79 /
     AUDIT-200 #184) still open; trivial and wanted.
290. **P3** Toast stack: add Esc-dismiss and a max stack of 3 (AUDIT-200
     #109); also route the admin alert() calls through the toast container
     (#110).

## AD. Accessibility & copy (291-300)

291. **DONE** Copy audit of the rework's user-visible strings: every
     launcher-related label now matches actual behavior (open-with button,
     admin placeholder, proxy tab hint, admin comment); no string still
     advertises a removed method.
292. **ALREADY** Escape closes overlays (more-nav, whatsnew, admin) with
     focus returned; verified handlers present after the markup changes.
293. **ALREADY** All iframes titled, icon-only buttons aria-labelled, one h1
     per view, lang="en" - spot-verified on the reworked markup.
294. **ALREADY** Reduced-motion rules cover the glow/blur effects added in
     AUDIT-200's flat-fill pass; verified motion-off class still toggled
     from settings.
295. **P2** Modal focus trap still open for whatsnew/editor/admin/launcher
     overlays (AUDIT-100 #18, AUDIT-200 #144) - third audit in a row with
     this open; it should be the next a11y item shipped.
296. **P2** The new "checked hh:mm" AI meta line and the tool notes are
     plain text nodes - good - but the AI tooltip is title-attribute only,
     invisible to keyboard users. Convert to a real focusable tooltip or
     visible text.
297. **P3** axe-core contrast pass per view (AUDIT-100 #20 / AUDIT-200 #150)
     still pending; the yellow New ribbon on chalk background remains the
     likely offender.
298. **P3** aria-expanded on music queue/lyrics/tune popups (AUDIT-200 #149)
     still open.
299. **P3** Document the flat-fills/no-dash copy rules in CONTRIBUTING (the
     checker enforces them but nothing tells a new contributor why).
300. **P3** Run the full 14-tab sweep + checker + audit.mjs + build smoke
     before every push - this pass's order (fix -> sweep -> build -> push)
     is the template; write it into the README audit section (done) and
     follow it every time.

---

### Shipped in THIS pass

U201-U205, U207, U208, V211, V212, V213, V214, W221-W228, X231, Y241, Y244,
Y245, Y246, Z251, AD291 plus committing the entire pending rework (launcher
new-tab rewrite, Blank Tab removal, YouTube instance racing, AI tab polish,
Serium art, CORS dedupe, Survival Race embed swap). Concretely: the
noopener/window.open spec bug fixed via a shared openTab helper; stale
launcher copy rewritten in four places; checker allowlist for the IXL meta
dash + stale SHIPPED list trimmed; grid expansion persisted per session
(verified headless); build script fixed so --cdn can no longer clobber the
35.6MB local build (restored and rebuilt); flare/ (5.1GB) and screenshots/
(14MB) gitignored; README fully refreshed; version bumped to 20260904b;
both single-file builds regenerated; checker + audit.mjs + 14-tab CDP sweep
green; every live surface (lootline.xyz, Pages, jsDelivr, relay, music
backend) verified 200. Everything tagged P1-P3 above is prioritised in
OVERHAUL.md.
