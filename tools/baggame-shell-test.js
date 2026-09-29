/* Bag Game (A28) shipped as
   https://cdn.jsdelivr.net/gh/SnakierdoorCode/GAMES@main/RIPS/A28/index.html
   and jsDelivr answers .html as `text/plain`, so the card rendered the page's
   source instead of the game. The document is now vendored into ugs/ (served
   as text/html by the relay, like every other web-port shell there) and the
   catalog points at it; the build itself still streams from jsDelivr through
   the document's own <base href>.

   This pins the parts that make that work, because each one fails quietly:
   the catalog URL, the <base href> the assets depend on, the split-wasm
   assembly jsDelivr's 20 MB file cap forces, the relay-only prefix that keeps
   a mirror from serving its own text/plain copy, and that nothing ships a
   self-referencing CDN document URL again.

   Run from anywhere: node tools/baggame-shell-test.js */

const path = require("node:path");
const { readFileSync, existsSync } = require("node:fs");

const ROOT = path.join(__dirname, "..");
const SHELL = "ugs/clbagame.html";
const CDN_DIR = "https://cdn.jsdelivr.net/gh/SnakierdoorCode/GAMES@main/RIPS/A28/";
const results = [];

function check(label, ok, detail) {
  results.push((ok ? "PASS " : "FAIL ") + label + (ok || !detail ? "" : "  <- " + detail));
}

function entryFor(file, title) {
  const src = readFileSync(path.join(ROOT, file), "utf8");
  const at = src.indexOf('title: "' + title + '", url: "');
  if (at === -1) return null;
  const url = (src.slice(at).match(/title: "[^"]*", url: "([^"]*)"/) || [])[1] || "";
  return { url: url, src: src };
}

/* --- catalog points at the vendored shell --------------------------------- */
["src/games2.js", "deploy-static/src/games2.js"].forEach((file) => {
  const hit = entryFor(file, "Bag Game");
  check(file + " launches the vendored shell", !!hit && hit.url === "/" + SHELL,
    hit ? hit.url : "Bag Game entry not found");
  check(file + " has no card left on the text/plain CDN document",
    !!hit && hit.src.indexOf("RIPS/A28/index.html") === -1);
});

/* --- the shell itself ----------------------------------------------------- */
const shellPath = path.join(ROOT, SHELL);
check(SHELL + " exists (tracked in git, served by the mirror and the relay)", existsSync(shellPath));
const shell = existsSync(shellPath) ? readFileSync(shellPath, "utf8") : "";
check("is a document, not a build bundle", shell.length > 2000 && shell.length < 65536,
  shell.length + " B");
check("keeps the absolute <base href> the assets resolve against",
  shell.indexOf('<base href="' + CDN_DIR + '">') !== -1,
  (shell.match(/<base[^>]*>/i) || ["(no base tag)"])[0]);
check("still boots the Godot engine", shell.indexOf("GODOT_CONFIG") !== -1 && shell.indexOf("new Engine(") !== -1);
check("assembles the split wasm jsDelivr's 20 MB cap forces",
  ["index.wasm.part1", "index.wasm.part2", "index.wasm.part3"].every((p) => shell.indexOf(p) !== -1));
check("loads its own game files (index.js / index.pck / index.wasm)",
  ["index.js", "index.pck", '"index.wasm"'].every((p) => shell.indexOf(p) !== -1));
check("does not reference its own CDN document (that is what showed source)",
  shell.indexOf("RIPS/A28/index.html") === -1);

/* --- mirrors: /ugs/ is tracked, so the shell plays from the mirror copy.
       text/plain CDNs (jsDelivr family) boot it through the fetch+<base>
       shell instead of a chalkle.lootline.xyz embed, which defeated the
       mirror link on the very networks that need it ---------------------- */
const runtime = readFileSync(path.join(ROOT, "src", "runtime-config.js"), "utf8");
check("/ugs/ is NOT on the relay-only list (mirror-served, no chalkle embed)",
  !/LOCAL_ONLY_PREFIXES = \[[^\]]*"\/ugs\/"/.test(runtime));
check("text/plain CDNs boot through htmlBoot()",
  runtime.indexOf("htmlBoot:") !== -1 && runtime.indexOf("textPlainHtml:") !== -1);

/* --- the vendoring script has to keep copying this document --------------- */
const vendor = readFileSync(path.join(ROOT, "scripts", "vendor-baggame.mjs"), "utf8");
check("the vendor script fetches the same upstream document",
  vendor.indexOf("/RIPS/A28/index.html") !== -1 && vendor.indexOf(SHELL) !== -1);
check("the vendor script guards the <base href> it relies on",
  vendor.indexOf(CDN_DIR) !== -1 && vendor.indexOf("<base") !== -1);

console.log(results.join("\n"));
const failed = results.filter((r) => r.indexOf("FAIL") === 0).length;
console.log(failed ? failed + " check(s) FAILED" : "all Bag Game shell checks pass");
process.exitCode = failed ? 1 : 0;
