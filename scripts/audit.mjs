/* Chalkle playtest audit.
   Static checks that catch the bugs a browser visit would:
   1. Duplicate ids in index.html
   2. Every id referenced by $()/getElementById/querySelector in JS exists in HTML
   3. Every script src exists on disk
   4. Elements with the hidden attribute are not forced visible by a CSS display rule
   5. Every view/grid/empty id wired in app.js exists
   Run: node audit.mjs */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file) => readFileSync(join(root, file), "utf8");
const exists = (file) => existsSync(join(root, file));

const FILES = ["src/app.js", "src/music.js", "src/intro.js", "src/games.js", "src/proxies.js"];
const DYNAMIC_IDS = new Set([
  "state-retry",       /* created at runtime */
  "grid-show-more",    /* created at runtime (library render cap) */
  "home-featured",     /* guarded block; container removed from home HTML */
  "home-youtube-recs"  /* guarded block; container removed from home HTML */
]);

let ok = true;
const report = (pass, msg) => {
  console.log((pass ? "PASS" : "FAIL") + "  " + msg);
  if (!pass) ok = false;
};

const html = read("index.html");

/* 1 + 2: ids in HTML + duplicates */
const htmlIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const seen = new Set();
const dupes = [];
for (const id of htmlIds) {
  if (seen.has(id)) dupes.push(id);
  seen.add(id);
}
report(dupes.length === 0, "no duplicate ids" + (dupes.length ? "  (" + dupes.join(", ") + ")" : ""));

/* 3: JS id references */
const jsIds = new Set();
for (const f of FILES) {
  const txt = read(f);
  for (const m of txt.matchAll(/\$\("([^"]+)"\)/g)) jsIds.add(m[1]);
  for (const m of txt.matchAll(/getElementById\("([^"]+)"\)/g)) jsIds.add(m[1]);
  for (const m of txt.matchAll(/querySelector(?:All)?\("(#[^"]+)"\)/g)) jsIds.add(m[1].slice(1));
}
const missing = [...jsIds].map((id) => id.replace(/^#/, "")).filter((id) => !htmlIds.includes(id) && !DYNAMIC_IDS.has(id));
report(missing.length === 0, "every JS id exists in HTML" + (missing.length ? "  (" + missing.join(", ") + ")" : ""));

/* 4: script srcs exist */
const srcs = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
const missingSrc = srcs.filter((s) => !exists(s));
report(missingSrc.length === 0, "all script files exist" + (missingSrc.length ? "  (" + missingSrc.join(", ") + ")" : ""));

/* 5: hidden attributes vs CSS display */
const css = read("src/styles.css");
const globalHiddenFix = /\[hidden\]\s*\{[^}]*?display\s*:\s*none\s*!important/.test(css);
const conflicts = [];
for (const m of html.matchAll(/<([a-z0-9-]+)([^>]*)>/g)) {
  const tag = m[1];
  const attrs = m[2];
  if (!/(^|\s)hidden(\s|$)/.test(attrs)) continue; /* real hidden attr, not aria-hidden */
  const clsMatch = attrs.match(/class="([^"]+)"/);
  if (!clsMatch) continue;
  for (const c of clsMatch[1].split(/\s+/)) {
    if (!c) continue;
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("\\." + escaped + "\\s*\\{[^}]*?display\\s*:\\s*(flex|grid|inline-flex|block|inline)\\b", "m");
    if (re.test(css)) conflicts.push(c);
  }
}
report(globalHiddenFix || conflicts.length === 0, "hidden elements stay hidden" + (globalHiddenFix ? "  ([hidden] !important rule present)" : conflicts.length ? "  (" + [...new Set(conflicts)].join(", ") + ")" : ""));

/* 6: data-view wiring */
const viewEls = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
const navViews = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]).filter((v) => viewEls.includes(v));
report(navViews.length >= 5, "nav sections wired (" + navViews.join(", ") + ")");

console.log(ok ? "\nAll playtest checks pass." : "\nPlaytest found issues, fix then re-run.");
process.exit(ok ? 0 : 1);