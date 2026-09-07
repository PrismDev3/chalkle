/* Wraps every wasm.rip webport game into a local /ugs/ page so no game ever
 * touches wasm.rip at runtime:
 *
 *  - Games with a full local build (copied into game-builds/): a plain
 *    launcher page that iframes the build on our own origin.
 *  - Games that are CDN shells: the original wasm.rip shell HTML is embedded
 *    into the wrapper as a data: URL (base64) and loaded in an iframe, so the
 *    document itself is self-contained like clwuhuislandexplorer.html - the
 *    build still streams from its (alive) jsDelivr/GitHub CDN, but wasm.rip
 *    itself is never contacted.
 *
 * Then rewrites src/webports.js to point every entry at the local wrapper.
 */
import fs from "node:fs";
import path from "node:path";

const W = "C:/Users/zeqrY/Downloads/wasm.rip-main/wasm.rip-main/files";
const root = process.cwd();

/* title in webports.js -> [repo folder, shell file, local build folder or null] */
const PLAN = {
  "Stardew Valley": ["stardewvalley", "index.html", null],
  "Inscryption": ["inscryption", "index.html", null],
  "One Shot: World Machine Edition": ["oneshot-wme", "index.html", null],
  "Bendy and the Ink Machine": ["BATIM", "index.html", null],
  "MiSide": ["miside", "miside.html", null],
  "Azahar": ["Azahar", "index.html", "azahar"],
  "Lobotomy Corporation": ["lob-corp", "index.html", null],
  "Trombone Champ": ["tchamp", "index.html", "tchamp"],
  "PEAK": ["peak", "PEAK.html", null],
  "Among Us": ["amongus", "index.html", "amongus"],
  "Ravenfield": ["ravenfield", "index.html", "ravenfield"],
  "The Man From The Window 2": ["MFDW2", "index.html", null],
  "SCP: Containment Breach": ["scp", "index.html", null],
  "Fez": ["FEZ", "fez.html", null],
  "Beatblock": ["beatblock", "index.html", null],
  "Helltaker": ["Helltaker", "helltaker.html", null],
  "Brotato Paws n' Claws": ["bpac", "index.html", "bpac"],
  "Baldi's Basics Birthday Bash": ["birthdaybash", "index.html", null],
  "Boil Noodles at Night": ["boilnoodles", "index.html", null],
  "Cheese Rolling": ["cheese-rolling", "index.html", null],
  "Dice A Million": ["diceAmillion", "diceamillion.html", null],
  "Ages of Conflict": ["aoc", "index.html", null],
  "While True: Learn()": ["wtl", "index.html", null],
  "Plague Inc": ["plauge", "index.html", null],
  "Happy Room": ["happy-room", "index.html", null],
};

const slugOf = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "") ;

function wrapper({ title, inner, url }) {
  return `<!DOCTYPE html>
<html lang="en-us">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<style>
  html,body{margin:0;height:100%;background:#0d0d11;overflow:hidden}
  iframe{position:fixed;inset:0;width:100%;height:100%;border:0;display:block;background:#0d0d11}
  #err{position:fixed;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#e8e6ea;font-family:system-ui,sans-serif;text-align:center;padding:24px}
  #err b{color:#ff5d8f}
</style>
</head>
<body>
${inner}
<div id="err"><b>${title} failed to load.</b><span>This can happen on offline exports where the build files are unreachable.</span></div>
<script>
  var frame = document.querySelector("iframe");
  var shown = false;
  frame.addEventListener("load", function(){ shown = true; document.getElementById("err").style.display = "none"; });
  setTimeout(function(){ if(!shown){ document.getElementById("err").style.display = "flex"; } }, 20000);
  document.addEventListener("click", function(){ try { frame.contentWindow.focus(); } catch(e){} });
</script>
</body>
</html>
`;
}

let localCount = 0, dataUrlCount = 0, missing = [];
const newEntries = [];

for (const [title, [dir, file, localBuild]] of Object.entries(PLAN)) {
  const shellPath = path.join(W, dir, file);
  if (!fs.existsSync(shellPath)) { missing.push(title); continue; }
  const slug = slugOf(title);
  const outPath = path.join(root, "ugs", "wp-" + slug + ".html");

  let inner;
  if (localBuild) {
    /* full local build: plain iframe, same-origin, zero external deps */
    inner = `<iframe src="/game-builds/${localBuild}/index.html" title="${title}" allow="autoplay; fullscreen; gamepad; clipboard-write" allowfullscreen></iframe>`;
    localCount++;
  } else {
    /* shell game: embed the original wasm.rip shell as a data URL so the
       wrapper document is self-contained (same trick as the wuhu island
       explorer build folder, but for single-file shells) */
    const shell = fs.readFileSync(shellPath, "utf8");
    const b64 = Buffer.from(shell, "utf8").toString("base64");
    inner = `<iframe src="data:text/html;base64,${b64}" title="${title}" allow="autoplay; fullscreen; gamepad; clipboard-write" allowfullscreen></iframe>`;
    dataUrlCount++;
  }

  fs.writeFileSync(outPath, wrapper({ title, inner, url: null }));
  newEntries.push({ title, url: "/ugs/wp-" + slug + ".html" });
}

/* Rewrite webports.js: swap wasm.rip URLs for the local wrappers. */
const wpPath = path.join(root, "src", "webports.js");
let wp = fs.readFileSync(wpPath, "utf8");
let swapped = 0;
for (const e of newEntries) {
  const re = new RegExp('(title:\\s*"' + e.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"[^}]*?url:\\s*")https://wasm\\.rip/files/[^"]*(")');
  if (re.test(wp)) { wp = wp.replace(re, "$1" + e.url + "$2"); swapped++; }
}
/* local builds no longer need directOnly (no cross-origin launch at all) */
wp = wp.replace(/(url: "\/ugs\/wp-[^"]*"), directOnly: true/g, "$1");
fs.writeFileSync(wpPath, wp);

console.log(`wrappers written: ${newEntries.length} (local-build: ${localCount}, data-url shells: ${dataUrlCount})`);
console.log(`webports.js urls swapped: ${swapped}/${newEntries.length}`);
if (missing.length) console.log("MISSING shells:", missing.join(", "));
