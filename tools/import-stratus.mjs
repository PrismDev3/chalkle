/* Chalkle importer: rebuilds cloudgames.js from the Stratus API game catalog.
   Run from the chalkle root:
     node tools/import-stratus.mjs "/path/to/stratus-api-main/api/../cloud.json" */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const src = process.argv[2] || "../stratus-api-main/stratus-api-main/cloud.json";
const raw = readFileSync(src, "utf8");
const list = JSON.parse(raw);
if (!Array.isArray(list)) throw new Error("cloud.json must be an array of games");

const games = list
  .filter((g) => g && typeof g === "object" && g.game_key && g.name)
  .map((g) => ({
    title: String(g.name).trim(),
    key: String(g.game_key).trim(),
    category: (Array.isArray(g.tags) && g.tags[0]) ? String(g.tags[0]) : "",
    tags: Array.isArray(g.tags) ? g.tags.map(String) : [],
    desc: String(g.description || "").trim(),
    img: /^https?:/i.test(String(g.image || "")) ? String(g.image) : "",
    cover: /^https?:/i.test(String(g.cover || "")) ? String(g.cover) : ""
  }))
  // drop empty keys and dedupe by key
  .filter((g) => g.key)
  .filter((g, i, arr) => arr.findIndex((x) => x.key === g.key) === i);

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const lines = [
  "/* Chalkle data. Cloud gaming catalog imported from the Stratus API cloud.json.",
  "   Regenerate with: node tools/import-stratus.mjs <path-to-cloud.json>",
  "   Each entry maps to Stratus game_key, played through /cloud/v1. */",
  "",
  "window.ChalkCloudGames = ["
];

games.forEach((g, i) => {
  const comma = i === games.length - 1 ? "" : ",";
  const tags = g.tags.length ? `, tags: [${g.tags.map((t) => `"${esc(t)}"`).join(", ")}]` : "";
  const img = g.img ? `, img: "${esc(g.img)}"` : "";
  const cover = g.cover ? `, cover: "${esc(g.cover)}"` : "";
  const desc = g.desc ? `, desc: "${esc(g.desc)}"` : "";
  const cat = g.category ? `, category: "${esc(g.category)}"` : "";
  lines.push(`  { title: "${esc(g.title)}", key: "${esc(g.key)}"${cat}${tags}${desc}${img}${cover} }${comma}`);
});

lines.push("]");

writeFileSync(resolve("src", "cloudgames.js"), lines.join("\n") + "\n");
console.log(
  `Wrote src/cloudgames.js: ${games.length} cloud games, ` +
    `${games.filter((g) => g.img).length} with artwork, ${games.filter((g) => g.desc).length} with descriptions.`
);