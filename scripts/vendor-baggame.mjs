/* Bag Game (A28) shipped as a jsDelivr document URL:
 *   https://cdn.jsdelivr.net/gh/SnakierdoorCode/GAMES@main/RIPS/A28/index.html
 * jsDelivr (and raw.githubusercontent) answer .html as `text/plain` with
 * nosniff - the browser prints the file instead of running it, so the card
 * showed the page's source and the game never started.
 *
 * The rest of that rip is fine: the document's own <base href> points at the
 * jsDelivr directory, and jsDelivr serves index.js / index.pck / the split
 * index.wasm.part1-3 with the right types. Only the document needs a host that
 * serves it as text/html, so this vendors the upstream HTML into ugs/ (tracked,
 * served by the relay - same treatment as the other web-port shells in there)
 * and points the catalog entry at it. No assets are copied.
 *
 * Deliberately byte-identical to upstream: nothing is rewritten, because the
 * <base href> is already absolute. Run it again after an upstream update, or
 * if ugs/clbagame.html is ever wiped:
 *   node scripts/vendor-baggame.mjs
 */
import fs from "node:fs";
import path from "node:path";

const REPO = "SnakierdoorCode/GAMES";
const BRANCH = "main";
const SRC_PATH = "RIPS/A28/index.html";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${SRC_PATH}`;
const CDN_DIR = `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/RIPS/A28/`;
const SHELL_REL = "ugs/clbagame.html";

const root = path.resolve(import.meta.dirname, "..");
const shellFile = path.join(root, SHELL_REL);

const r = await fetch(RAW, { headers: { "User-Agent": "chalkle-vendor" } });
if (!r.ok) throw new Error(`${RAW}: ${r.status}`);
const upstream = Buffer.from(await r.arrayBuffer());

/* The whole trick only works while the game loads its assets from the CDN
 * directory it was ripped from. If upstream ever switches to relative paths,
 * the vendored copy would resolve them against /ugs/ and 404 - fail loudly
 * instead of shipping a shell that silently loads nothing. */
const html = upstream.toString("utf8");
const base = (html.match(/<base[^>]*href="([^"]+)"/i) || [])[1] || "";
if (base !== CDN_DIR) {
  throw new Error(`unexpected <base href="${base}"> (wanted ${CDN_DIR}) - review before vendoring`);
}
for (const need of ["index.js", "index.pck", "index.wasm.part1", "index.wasm.part2", "index.wasm.part3"]) {
  if (html.indexOf(need) === -1) throw new Error(`upstream no longer references ${need}`);
}

if (fs.existsSync(shellFile) && fs.readFileSync(shellFile).equals(upstream)) {
  console.log(`  skip  ${SHELL_REL} (already the current upstream document)`);
} else {
  fs.mkdirSync(path.dirname(shellFile), { recursive: true });
  fs.writeFileSync(shellFile, upstream);
  console.log(`  vendor ${SHELL_REL} (${upstream.length} B from ${SRC_PATH})`);
}
console.log(`done - catalog should launch /${SHELL_REL.replace(/^ugs\//, "ugs/")}`);
