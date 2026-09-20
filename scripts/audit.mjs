/* Chalkle playtest audit.
   Static checks that catch the bugs a browser visit would:
   1. Duplicate ids in index.html
   2. Every id referenced by $()/getElementById/querySelector in JS exists in HTML
   3. Every script src exists on disk
   4. Elements with the hidden attribute are not forced visible by a CSS display rule
   5. Every view/grid/empty id wired in app.js exists
   6. The game library files load and hold no blank entries
   7. The three nav groups each wire their sections (item 696)
   Run: node audit.mjs */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

const root = process.cwd();
const read = (file) => readFileSync(join(root, file), "utf8");
const exists = (file) => existsSync(join(root, file));

const FILES = ["src/app.js", "src/music.js", "src/intro.js", "src/games.js", "src/proxies.js"];
const DYNAMIC_IDS = new Set([
  "state-retry",       /* created at runtime */
  "grid-show-more",    /* created at runtime (library render cap) */
  "home-featured",     /* guarded block; container removed from home HTML */
  "home-youtube-recs", /* guarded block; container removed from home HTML */
  /* Music's "on this device" panel: the empty state is also the drop target,
     so music.js builds it (and rebinds it) each time the tab renders. */
  "music-local-drop",
  "music-local-pick",
  "music-local-input",
  "music-local-clear"
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

/* 6: the game library data files contain only real entries. A stray comma
   between two entries leaves an elision in the array literal, which push.apply
   turns into a real undefined row: the grid then renders a blank card and the
   library sync writes the null into saved state. Evaluating the files here is
   the only way to see it, so do that. */
const LIBRARY_FILES = ["src/games.js", "src/games2.js", "src/ugs-games.js"];
{
  /* One shared window, so cross-file helpers (games.js defines ruffleHtml,
     games2.js calls it) still resolve. Each file is only judged on the
     entries it contributes, so a blank is reported against the file that
     actually holds it and not against every file loaded after it. */
  const sandbox = {
    window: {},
    console: { log() {}, warn() {}, error() {} }
  };
  createContext(sandbox);
  const problems = [];
  for (const f of LIBRARY_FILES) {
    if (!exists(f)) continue;
    const before = sandbox.window.ChalkGames;
    const startLen = Array.isArray(before) ? before.length : 0;
    try {
      runInContext(read(f), sandbox, { filename: f, timeout: 20000 });
    } catch (e) {
      problems.push(f + " does not parse (" + e.message.slice(0, 60) + ")");
      continue;
    }
    const after = sandbox.window.ChalkGames || [];
    /* A file that assigns a whole new array (games.js) is judged from zero;
       one that pushes onto the existing array is judged on its tail. */
    const from = after === before ? startLen : 0;
    let blanks = 0;
    let noUrl = 0;
    for (let i = from; i < after.length; i++) {
      if (!after[i] || typeof after[i] !== "object") blanks++;
      else if (!String(after[i].url || "").trim()) noUrl++;
    }
    if (blanks) problems.push(f + " has " + blanks + " empty entr" + (blanks === 1 ? "y" : "ies"));
    if (noUrl) problems.push(f + " has " + noUrl + " entr" + (noUrl === 1 ? "y" : "ies") + " with no url");
  }
  report(problems.length === 0, "game library entries are intact" + (problems.length ? "  (" + problems.join("; ") + ")" : ""));
}

/* 7: view wiring. The nav has three groups (item 696): the primary sidebar,
   the "More" overflow menu, and the bottom board/settings bar. Each group is
   checked separately so a tab can silently vanish from one group without
   another group masking it. */
const viewEls = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
const block = (start, end) => {
  const a = html.indexOf(start);
  if (a < 0) return "";
  const b = html.indexOf(end, a + start.length);
  return b < 0 ? "" : html.slice(a, b + end.length);
};
const desktopNav = block('<nav class="nav"', "</nav>");
const moreMenu = block("id=\"nav-more\"", "</div>");
const bottomNav = block('<nav class="nav nav-bottom"', "</nav>");
const inBlock = (b) => [...b.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]).filter((v) => viewEls.includes(v));
const primary = inBlock(desktopNav);
const more = inBlock(moreMenu);
const bottom = inBlock(bottomNav);
report(primary.length >= 5, "primary nav sections wired (" + primary.join(", ") + ")");
report(more.length >= 2, "More menu sections wired (" + more.join(", ") + ")");
report(bottom.length >= 1, "bottom nav sections wired (" + bottom.join(", ") + ")");

console.log(ok ? "\nAll playtest checks pass." : "\nPlaytest found issues, fix then re-run.");
process.exit(ok ? 0 : 1);