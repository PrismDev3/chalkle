/* Chalkle importer: rebuilds games.js from Chud's games.js.
     - Games with an absolute game URL become live entries, with Chud's per-game
       image used as the card thumbnail when it is a usable icon.
     - Games with relative game files (games/412.html) are kept as a comment
       block, because those files are not in the Chud repo and would 404 here.
   Run from the chalkle root:
     node tools/import-chud.mjs "../Chud-main/Chud-main/games.js" */

import { readFileSync, writeFileSync } from "node:fs";

const src = process.argv[2] || "../Chud-main/Chud-main/games.js";
const raw = readFileSync(src, "utf8");

const re = /title: "([^"]+)",\s*desc: "([^"]*)",\s*url: "([^"]+)",\s*image: "([^"]*)"/g;
const games = [];
const relative = [];
let m;
while ((m = re.exec(raw))) {
  const [, title, , url, image] = m;
  if (/^https?:\/\//i.test(url)) games.push({ title, url, thumb: /^https?:\/\//i.test(image) ? image : "" });
  else relative.push({ title, url });
}

/* Asset paths that are clearly not game icons (sprite sheets, textures, etc.). */
const JUNK = /sheet|texture|atlas|blocks\/|buttons\/|sprites|\/x1\/|achievement|loading|moregames|act-block/i;
games.forEach((g) => {
  if (g.thumb && JUNK.test(g.thumb)) g.thumb = "";
});

/* Dedupe by url, keep first. */
const seen = new Set();
const unique = games.filter((g) => {
  if (seen.has(g.url)) return false;
  seen.add(g.url);
  return true;
});

const lines = [
  "/* Chalkle data. Game list + icons imported from Chud's games.js.",
  "   Regenerate with: node tools/import-chud.mjs <path-to-chud-games.js>",
  "   Add player counts with playing: N per entry when you have live data. */",
  "",
  "window.ChalkGames = [",
];

unique.forEach((g, i) => {
  const comma = i === unique.length - 1 ? "" : ",";
  const esc = (s) => s.replace(/"/g, '\\"');
  const thumb = g.thumb ? `, thumb: "${esc(g.thumb)}"` : "";
  lines.push(`  { title: "${esc(g.title)}", url: "${esc(g.url)}"${thumb} }${comma}`);
});

lines.push(
  "]",
  "",
  "/* The rest of Chud's list uses relative game files (games/412.html) that are not",
  "   inside the Chud repo, so they would be dead links here. Keep them for when",
  "   the games/ folder is available:",
  ""
);
relative.forEach((g) => {
  const esc = (s) => s.replace(/"/g, '\\"');
  lines.push(`   // { title: "${esc(g.title)}", url: "${esc(g.url)}" }`);
});
lines.push("*/");

writeFileSync("games.js", lines.join("\n") + "\n");
const withThumb = unique.filter((g) => g.thumb).length;
console.log(
  `Wrote games.js: ${unique.length} live games (${withThumb} with Chud icons), ` +
    `${relative.length} relative entries commented out.`
);
