/**
 * build-movies.mjs
 *
 * Chlakle Movies ships as ONE self-contained page: movies.html holds the
 * styles, the markup and the whole app, because the same file has to work as
 * the multi-file site's tab, on jsDelivr/GitHub mirrors, and as the data-URI
 * embed the single-file build inlines. There is no source tree to concatenate
 * any more, so this script does the work that used to be forgotten instead:
 *
 *   1. syncs movies.html into deploy-static/ (what Cloudflare Pages publishes)
 *   2. verifies the contract the embed depends on:
 *        - no external <script src> / <link rel="stylesheet"> (must inline)
 *        - no TMDB token shipped to the browser (the relay owns the key)
 *        - the mirror shim and the app block both parse
 *        - the relay routes the app relies on are the ones it calls
 *
 * Usage: node scripts/build-movies.mjs [--check]
 *   --check   verify only; fail if deploy-static/movies.html has drifted
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const SRC = path.join(root, "movies.html");
const DEST = path.join(root, "deploy-static", "movies.html");
const CHECK_ONLY = process.argv.includes("--check");

const fails = [];
const passes = [];
function gate(ok, label) {
  (ok ? passes : fails).push(label);
}

if (!fs.existsSync(SRC)) {
  console.error("FAIL  movies.html is missing");
  process.exit(1);
}
const html = fs.readFileSync(SRC, "utf8");

/* ---- 1. self-contained: nothing the embed cannot resolve ----------------- */
const externalScript = /<script[^>]+\bsrc=/i.test(html);
const externalStyle = /<link[^>]+rel=["']?stylesheet/i.test(html);
gate(!externalScript, "no external <script src> in movies.html");
gate(!externalStyle, "no external stylesheet <link> in movies.html");

/* ---- 2. the relay owns the key ------------------------------------------ */
gate(!/eyJhbGciOi/.test(html), "no TMDB token shipped in the page");
gate(/\/api\/tmdb\//.test(html), "page talks to the server's /api/tmdb route");
gate(/\/res\//.test(html), "page routes embeds through the relay's /res/ proxy");

/* ---- 3. both inline blocks parse ---------------------------------------- */
const blocks = html.split("<script>").slice(1).map((chunk) => chunk.slice(0, chunk.indexOf("</script>")));
gate(blocks.length >= 2, "page carries the mirror shim and the app block");
blocks.forEach((code, i) => {
  try {
    new Function(code);
    gate(true, `inline script block ${i + 1} parses (${code.length} bytes)`);
  } catch (err) {
    gate(false, `inline script block ${i + 1} failed to parse: ${err.message}`);
  }
});

/* ---- 4. mirror copy ------------------------------------------------------ */
const mirror = fs.existsSync(DEST) ? fs.readFileSync(DEST, "utf8") : "";
if (mirror === html) {
  gate(true, "deploy-static/movies.html is in sync");
} else if (CHECK_ONLY) {
  gate(false, "deploy-static/movies.html has drifted - run: node scripts/build-movies.mjs");
} else {
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.writeFileSync(DEST, html);
  gate(true, `synced deploy-static/movies.html (${html.length} bytes)`);
}

for (const line of fails) console.log("FAIL  " + line);
for (const line of passes) console.log("ok    " + line);
if (fails.length) {
  console.error(`\n${fails.length} movie build check(s) failed`);
  process.exit(1);
}
console.log(`\nall ${passes.length} movie build checks pass`);
