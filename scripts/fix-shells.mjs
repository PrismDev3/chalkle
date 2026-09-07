/* Fixes the 3 wasm.rip-shell games whose upstream changed:
 *  - BATIM:   repo restructured (bendy.* 30 parts -> bend.* 29 parts). Inline
 *             the repo's own updated index.html; fix its blob:<base> quirk by
 *             rewriting href="data:," to the real CDN base.
 *  - LobCorp: repo restructured (hash-named parts -> web.data.unitywebNN +
 *             web.json manifest). Inline the repo's own index.html and inject
 *             a <base> so its relative Build/ refs hit the CDN.
 *  - Stardew: original repo (cirsius/stardew-wasm) is gone; retarget <base>
 *             to the alive mirror degloved-net/stardew-wasm@main.
 */
import fs from "node:fs";
import path from "node:path";

const H = { headers: { "User-Agent": "chalkle-check" } };
const root = process.cwd();
const dir = path.join(root, "ugs");

const CDN = {
  batim: "https://cdn.jsdelivr.net/gh/woahhcrackers/BATIMWeb@main/",
  lobcorp: "https://cdn.jsdelivr.net/gh/Reeyuki/lobcorp@main/",
  stardew: "https://cdn.jsdelivr.net/gh/degloved-net/stardew-wasm@main/",
};

function wrap(inner, title) {
  const b64 = Buffer.from(inner, "utf8").toString("base64");
  return `<!DOCTYPE html>
<html lang="en-us">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; background: #0d0d11; overflow: hidden; }
  iframe { display: block; width: 100%; height: 100%; border: 0; }
</style>
</head>
<body>
<iframe src="data:text/html;base64,${b64}" allow="autoplay; fullscreen; gamepad; cross-origin-isolated" allowfullscreen></iframe>
</body>
</html>
`;
}

function writeWrapped(file, inner, title) {
  fs.writeFileSync(path.join(dir, file), wrap(inner, title));
  console.log("wrote " + file + " (inner " + inner.length + "B -> " + b64Length(inner) + "B b64)");
}
function b64Length(inner) { return Buffer.byteLength(Buffer.from(inner, "utf8").toString("base64")); }

/* --- BATIM: use the repo's own index.html --- */
const batimTxt = fs.readFileSync("batim-index.tmp.html", "utf8");
let batimInner = batimTxt.replace(
  /<base[^>]*href="data:,"[^>]*>/i,
  `<base href="${CDN.batim}">`
);
if (!/<base/i.test(batimInner)) {
  batimInner = batimInner.replace(/<head([^>]*)>/i, `<head$1>\n<base href="${CDN.batim}">`);
}
writeWrapped("wp-bendyandtheinkmachine.html", batimInner, "Bendy and the Ink Machine");

/* --- LobCorp: repo index.html + injected <base> --- */
const lobTxt = fs.readFileSync("lobcorp-index.tmp.html", "utf8");
let lobInner = lobTxt;
if (!/<base/i.test(lobInner)) {
  lobInner = lobInner.replace(/<head([^>]*)>/i, `<head$1>\n<base href="${CDN.lobcorp}">`);
}
writeWrapped("wp-lobotomycorporation.html", lobInner, "Lobotomy Corporation");

/* --- Stardew: keep shell, swap <base> to the alive mirror --- */
const svFile = path.join(dir, "wp-stardewvalley.html");
const svHtml = fs.readFileSync(svFile, "utf8");
const svM = svHtml.match(/iframe src="data:text\/html;base64,([A-Za-z0-9+/=]+)"/);
if (svM) {
  const inner = Buffer.from(svM[1], "base64").toString("utf8");
  const fixed = inner.replace(
    /href="https:\/\/cdn\.jsdelivr\.net\/gh\/cirsius\/stardew-wasm@master\/"/,
    `href="${CDN.stardew}"`
  );
  if (fixed === inner) {
    console.log("stardew: WARNING - base URL not found, no change written");
  } else {
    fs.writeFileSync(svFile, svHtml.replace(svM[0], 'iframe src="data:text/html;base64,' + Buffer.from(fixed, "utf8").toString("base64") + '"'));
    console.log("stardew: base retargeted to degloved-net/stardew-wasm@main");
  }
} else {
  console.log("stardew: no data-url iframe found?");
}

/* sanity: decode back all three and print their base/build refs */
for (const f of ["wp-bendyandtheinkmachine.html", "wp-lobotomycorporation.html", "wp-stardewvalley.html"]) {
  const html = fs.readFileSync(path.join(dir, f), "utf8");
  const m = html.match(/iframe src="data:text\/html;base64,([A-Za-z0-9+/=]+)"/);
  const inner = m ? Buffer.from(m[1], "base64").toString("utf8") : "(none)";
  const base = (inner.match(/<base[^>]*href="([^"]+)"/) || [])[1] || "(no base)";
  const merge = (inner.match(/fileMergerConfig[\s\S]{0,160}/) || ["(none)"])[0].replace(/\s+/g, " ").slice(0, 150);
  console.log("\n" + f + "\n  base: " + base + "\n  config: " + merge);
}
console.log("\ndone");
