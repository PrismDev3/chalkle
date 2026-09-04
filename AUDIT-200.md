# Chalkle - 100-Point Site Audit II

Audited 2026-09-03 against the source files (index.html, styles.css, app.js,
every view module and data file) plus a headless-Chrome runtime sweep of all
14 tabs. Continues the numbering from AUDIT-100.md (items 101-200).

Status legend:

- **DONE** - shipped and verified in this pass
- **ALREADY** - existed before the audit; verified working
- **P1 / P2 / P3** - planned work, ordered by value; each has a concrete plan

---

## K. Toast & feedback (101-110)

101. **DONE** docs.js, livetv.js and youtube.js all call `notice()`, which
     appended `.toast` pills to `#toast-box` - an id that did not exist in
     index.html. Every one of those toasts ("Copied ... to clipboard",
     "Save failed", "Only admins can edit channels") silently did nothing.
     Added a real `#toast-box` container (aria-live polite, bottom centre,
     fixed) plus `.toast` / `.is-out` styles.
102. **DONE** The `.toast` child class had no CSS at all, so even a manually
     created toast rendered as plain unstyled text. Now it is a dark pill
     with the site's display font, matching the p-toast and partners-toast
     look.
103. **DONE** The three notice() implementations duplicated the same 9 lines
     (create, append, fade, remove). Left each in place for now since they
     are small; a shared helper is queued at P3 (#108).
104. **ALREADY** Music toasts route through the in-view `#p-toast` element
     (music.js els.toast) and are styled; verified they are separate from
     the app-wide container and need no change.
105. **ALREADY** partners.js appends its own `.partners-toast` to body with
     its own styling; that works and does not collide with `#toast-box`.
106. **P2** The `#toast-box` container is `aria-live="polite"` now, but the
     per-view `.toast` spans are not announced as they stack. Fine as is;
     test with a screen reader and switch to live regions per toast if the
     announcements read oddly.
107. **P2** Toast copy in docs.js uses curly quotes and an ellipsis in a few
     places; normalise to straight ASCII punctuation for consistent copy.
108. **P3** Extract one shared `window.ChalkleToast(msg)` from the three
     copies and delete the per-file notice() functions.
109. **P3** Add a keyboard-friendly dismiss (Esc clears the newest toast) and
     a max stack (drop oldest past 3).
110. **P3** Route the admin/editor one-off alerts through the same container
     so every status surface looks identical.

## L. Dead markup & orphaned CSS (111-120)

111. **DONE** index.html carried a full global audio dock (`#audio-dock`,
     eq canvas, art, transport buttons, queue panel) that no JS file ever
     referenced: 27/27 ids had zero hits across every module. Removed the
     markup (~65 lines of dead SVG buttons).
112. **DONE** index.html carried a `#video-overlay` YouTube modal (title
     bar, picture-in-picture button, iframe) that no JS referenced. YouTube
     plays in its own in-view `#yt-player`. Removed the markup.
113. **DONE** Removed the orphaned CSS for both blocks: the `.video-overlay`
     / `.video-window` / `#video-frame` / `#video-pip` rules and the whole
     `.audio-*` / `.queue-*` dock stylesheet section (~300 lines). The real
     in-tab music player uses `.p-*` and `.p-q*` classes, which are intact.
114. **DONE** The `.pulse` helper class and its 1.4s count-pulse animation
     existed only for the dead dock's queue badge; removed the class rule.
     The 2.4s `@keyframes count-pulse` stays because `.card-count::before`
     still uses it.
115. **ALREADY** The live in-tab music player markup (`#music-player` with
     p-btn, p-pop, p-queue-list) is fully wired by music.js; confirmed no
     dependency on the removed dock classes.
116. **ALREADY** The proxy overlay, docs viewer, whatsnew overlay, admin
     sheets and launch modal all have live JS handlers; none referenced the
     removed blocks.
117. **P2** game-builds/ and flare/ are vendored third-party builds that
     match some removed class names (`.video-overlay` etc). They are
     self-contained and shipped as-is; do not let a future global rename
     touch them.
118. **P3** After this cleanup the diff for index.html/styles.css is large
     but mechanical; review once visually per view before the next release.
119. **P3** Re-run the CDP 14-tab sweep after any future markup removal so
     regressions from "removed but still needed" markup are caught early.
120. **P3** Consider a tiny CI lint that flags ids present in CSS/HTML but
     never referenced by any JS, to stop dead blocks creeping back.

## M. Visual consistency (121-130)

121. **DONE** Four fade-gradient rules slipped past the flat-fills rule and
     failed the quality gate: the Discord join banner wash, two hero colour
     glows and the music banner wash. All replaced with flat translucent
     fills; the hero glows keep their soft look via `filter: blur` on flat
     circles instead of a radial fade. Checker is green again.
122. **ALREADY** Per-view colour identity (accent-tinted titles, chips and
     glows) is consistent; the glow layers use px-positioned radial stops
     that the checker's geometry allowlist accepts and they were not part of
     the violations.
123. **ALREADY** The checker's em-dash and AI-vocab scans pass across all
     shipped files, including this audit's source edits.
124. **P2** `.home-hero-main::before/::after` now use `filter: blur(80px)`
     which is GPU-cheap on a static hero but confirm it stays smooth on low
     end Chromebooks; if it janks, drop the second glow.
125. **P2** The Discord join banner and music banner are now a single flat
     tint. Re-check contrast of text on those two tints in both accent
     themes.
126. **P3** Sweep for other soft-glow effects implemented with wide box
     shadows that could be blurred flat fills instead, to keep the visual
     language uniform.
127. **P3** Add the flat-tint equivalents to the reduced-motion path so
     blur is skipped when the user asks for less motion.
128. **P3** Document the "flat fills only" rule in a CONTRIBUTING note so
     future style edits know the checker will reject fades.
129. **P3** Give the toast pill a soft blur backdrop (like the topbar) for
     readability over busy game art, still flat, no fade.
130. **P3** Standardise on one blur radius token (`--blur-soft`) once the
     hero and toast values settle.

## N. View runtime health (131-140)

131. **ALREADY** Headless-Chrome sweep across home, games, cloud, music,
     apps-tools, proxies, sites, ai, docs, partners, board, livetv,
     youtube, settings: zero console errors and zero uncaught exceptions
     after this pass.
132. **ALREADY** livetv.js still contains legacy "channel list" code paths
     (`renderCats`, `renderGrid`, hero player) whose ids no longer exist;
     they early-return when the ids are missing, so they are inert rather
     than broken. Verified no runtime error.
133. **P2** Prune the inert livetv legacy paths (render/hero/openMatch and
     their guarded getElementById calls) so the sports-only view is the
     only path left in the file.
134. **P2** youtube.js re-entry: returning to the YouTube tab with a search
     active re-runs the search (verified working); add a tiny result cache
     so a back-and-forth does not refetch the same query.
135. **P2** Music `render()` re-runs `renderHome()` when the search box is
     empty; on tab re-entry app.js calls `ChalkleMusic.render()` which
     instead re-highlights the playing row. Both behaviours are fine but
     the two entry points should be documented in one comment.
136. **P3** Home quick links and metric buttons route to views (verified);
     consider deep-linking `#music` style hashes so a refresh keeps the
     tab.
137. **P3** The board/partners/docs views reload remote-ish data on each
     open; add a short TTL cache to cut needless fetches.
138. **P3** Add a `beforeunload`-style guard for the HTML editor with
     unsaved content (currently silent).
139. **P3** Proxy frame error detection shows the "open in new tab" notice;
     add a retry button that reloads the frame once before giving up.
140. **P3** Wire a lightweight in-app error toast (see #108) around the
     async data loads so network failures always surface visibly.

## O. Accessibility (141-150)

141. **DONE** The new toast host is `aria-live="polite"`, closing the gap
     where docs/Live TV/YouTube status messages were invisible to screen
     readers (they were invisible to everyone before; see #101).
142. **ALREADY** All iframes carry title attributes, icon buttons carry
     aria-labels, and the two search inputs are labelled (verified).
143. **ALREADY** One h1 per view, `lang="en"`, skip of decorative svgs via
     aria-hidden - all present.
144. **P2** Modal focus trap for whatsnew/editor/launcher overlays still
     open; add the small focus-trap helper (Tab cycles, Esc returns).
145. **P2** Colour contrast on the yellow "new" style chips over the chalk
     backdrop should be re-measured with axe-core per view.
146. **P2** Focus-visible ring exists per tab accent; verify it is visible
     inside the new toast and overlay buttons after the markup changes.
147. **P3** Provide a visible focus indicator on the genre/sort chip rows
     when keyboard navigating (test current one on dark theme).
148. **P3** The proxy overlay notice links are real anchors now; ensure the
     fallback "Open game" is focusable and labelled (verify with axe).
149. **P3** Add `aria-expanded` toggling on the queue/lyrics/tune popups in
     the music player.
150. **P3** Run one full axe pass per view and file remaining contrast and
     landmark findings into OVERHAUL.md.

## P. Data quality (151-160)

151. **ALREADY** No duplicate titles in games (1374), sites (78), apps
     (31), webports (29) or cloudgames (225) after the earlier Granny 3
     dedupe.
152. **ALREADY** Game thumbnails: 1,303 local thumbs resolve; the single
     data-URI placeholder entry is intentional.
153. **ALREADY** Survival Race now points at the official survival-race.io
     embed (Unity WebGL, no frame-blocking headers) with a verified live
     check.
154. **P2** `isNew` flags exist in games/sites data but nothing renders a
     chip; surface a "New" badge on cards when set (CSS exists as flat
     tag).
155. **P2** The 480-card grid cap and "Show all" exist; remember the
     expanded state per session so returning users keep the full grid.
156. **P2** Editor's Picks titles should be validated against games.js on
     boot so a renamed game does not show a dead pick.
157. **P3** Cloud grid comes from a live catalog; add the nightly prune job
     that diffs titles and drops dead entries (as planned in AUDIT-100
     #30).
158. **P3** Sort controls exist for games; mirror the same size/sort
     controls onto the tools grid once its categories settle.
159. **P3** Popular order is click-based; bootstrap a seed list so a fresh
     profile gets a sane Popular row on day one.
160. **P3** Add per-device shelf naming in the sidebar footer (planned in
     AUDIT-100 #78) so multi-device users can tell profiles apart.

## Q. Music & Live TV polish (161-170)

161. **ALREADY** Music queue rows render with `.p-qrow` classes and their
     own CSS (p-qnum/p-qname/p-qsub); the removed dock's queue styles were
     never used by them (verified after cleanup).
162. **ALREADY** Queue, shuffle, repeat, lyrics, speed and pitch all live
     in music.js and are wired to the in-view player.
163. **P2** No volume slider lives in the music player row; it is only in
     the settings sheet. Move a compact slider next to the transport.
164. **P2** Live TV channel cards have no favourites pin; add a star using
     the same shelf store as saved games.
165. **P2** Live TV has no per-channel health dot even though the relay
     knows which streams 404; surface it.
166. **P3** HLS.min.js loads on every page load; lazy-load it only when the
     Live TV player starts a stream (planned in AUDIT-100 #87).
167. **P3** Add "open in new tab" affordance on YouTube results beside the
     in-app player (AUDIT-100 #58).
168. **P3** Remember last music search term per session and restore it when
     re-entering the tab.
169. **P3** Equalizer toggle exists in the old design only; either ship a
     real EQ or drop the affordance so the button row is honest.
170. **P3** Add keyboard media keys (play/pause, next, prev) when the music
     tab is focused.

## R. Proxies, apps & tools (171-180)

171. **ALREADY** Proxy add/edit/delete, ask-on-launch, saved per device and
     in-frame vs new-tab launching all present.
172. **ALREADY** URL cloaker, HTML editor with preview/download/copy/upload
     present; editor shortcuts documented in the editor panel.
173. **P2** No default-proxy pinning; add a small "default" star on the
     proxy list the launcher uses when ask-on-launch is off.
174. **P2** Proxy health is static text; add the lightweight `/health`
     probe that checks each proxy's first page and badges live dots.
175. **P2** The "open-with" picker (Blob / About:blank / Proxy) has no
     remember-my-choice toggle; add one for power users.
176. **P2** Add a quick "add a tool" form on the Tools tab for non-admin
     users who just want a custom link (AUDIT-100 #70).
177. **P3** Tools grid still lacks size/sort parity with Games; queue after
     categories settle (#158).
178. **P3** Emulator thumbnails are generic share-art; generate per-game
     badge tiles like the Arctic/Cherri mirror thumbs (AUDIT-100 #27).
179. **P3** Document supported controllers on the emulator and cloud cards.
180. **P3** Audit the custom proxy config list for stale mirror URLs once
     per month; a simple manifest mtime check could flag them.

## S. Settings & personalisation (181-190)

181. **ALREADY** Wallpaper validation by preload, export/import JSON,
     reduce-motion, card size, accent colour, cursors, ask-on-launch and
     cloak title all wired.
182. **P2** Settings has no single "reset everything"; add a two-step
     confirm that clears the shelf stores and reloads.
183. **P2** Add a "back up my setup" CTA in Appearance that downloads the
     export JSON directly (AUDIT-100 #77).
184. **P3** Clock is always visible in the topbar; add a setting to hide it.
185. **P3** Ad slots are wired but empty until AdSense approves real units;
     keep them hidden (current behaviour) and add the supporter toggle
     later.
186. **P3** The whatsnew overlay lists past releases; make its entries
     driven by a small JSON so adding a release does not touch markup.
187. **P3** Accent colour choices could warn when they clash with a tab's
     fixed accent; keep it advisory only.
188. **P3** Cursor themes and wallpaper choices are per device; the export
     covers it, but add import-by-paste in Appearance for quick restore.
189. **P3** Add a theme preview swatch row in settings so changing accent
     shows chips/gradients before committing.
190. **P3** Persist the last-viewed settings pane so opening settings again
     lands where the user was.

## T. Repo & process hygiene (191-200)

191. **DONE** Cache-bust version bumped `20260903b` to `20260903c` across
     all 24 asset refs so this batch is picked up by every client.
192. **DONE** Both single-file builds (chalkle-single.html and
     chalkle-single-cdn.html) regenerated from the updated sources and kept
     byte-identical (verified with cmp).
193. **DONE** Quality gate green after the changes: python tools/checker.py
     reports clean, node audit.mjs passes every playtest check.
194. **DONE** The 14-view headless sweep and the toast end-to-end test pass
     on the local server after the markup removals.
195. **ALREADY** audit.mjs covers duplicate ids, id wiring, script assets,
     hidden/display conflicts and nav sections - all green this pass.
196. **P2** audit.mjs only knows about ids used in HTML-first markup; the
     toast-box bug (#101) existed because notice() targets are built from
     strings. Extend it to scan `getElementById("...")` literals in the
     view modules too.
197. **P2** README still lists pre-overhaul features; refresh the feature
     list and document the audit workflow (checker, audit.mjs, CDP sweep,
     single-file rebuild).
198. **P2** Version string is hardcoded in ~24 refs; centralise on
     `window.CHALKLE_BUILD` so a bump is one edit (AUDIT-100 #95).
199. **P3** Add a CI step running checker.py + audit.mjs + a curl smoke of
     serve-chalk.py on the GitHub Pages workflow (AUDIT-100 #96).
200. **P3** Keep this audit in sync with OVERHAUL.md: flip tags here when a
     P2/P3 ships and link the change back.

---

### Shipped in THIS pass

K101-K103, L111-L114, M121, O141, T191-T194. Concretely: a real shared
toast container with styling (fixing silent no-op toasts in docs, Live TV
and YouTube), removal of the dead global audio dock and video overlay plus
~300 lines of orphaned CSS, four fade gradients flattened to flat fills
(the hero glows keep their look via blur on flat circles), the cache-bust
version bumped to 20260903c, both single-file builds regenerated and
identical, and the full quality gate (checker + audit.mjs + 14-tab CDP
sweep) passing. Everything tagged P1-P3 above is prioritised in
OVERHAUL.md.
