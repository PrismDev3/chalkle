/* One-shot import of the Noah's Calculus Tutor catalog into Chalkle.
 * - Copies local game shells  -> ugs/noah/N.html
 * - Copies real cover art     -> assets/games/noah/<name>.<ext>
 * - Emits src/noah-games.js   -> window.ChalkNoahGames = [...]
 * Skips: secret entries, duplicate titles, titles Chalkle already has.
 * Run from the repo root:  node scripts/import-noah.mjs
 */
import fs from "node:fs";
import path from "node:path";

const SRC = "C:/Users/zeqrY/Downloads/Noahs-Calculus-Tutor-master/Noahs-Calculus-Tutor-master";
const OUT_UGS = "ugs/noah";
const OUT_IMG = "assets/games/noah";
const OUT_JS = "src/noah-games.js";

fs.mkdirSync(OUT_UGS, { recursive: true });
fs.mkdirSync(OUT_IMG, { recursive: true });

/* ---- parse the source catalog ------------------------------------------ */
const raw = fs.readFileSync(path.join(SRC, "games.js"), "utf8");
const games = eval(raw.replace(/^\s*const\s+games\s*=\s*/, "(").replace(/;\s*$/, ")"));
console.log("source entries:", games.length);

/* ---- titles Chalkle already has (exact, case-insensitive) --------------- */
function loadTitles(file) {
  const set = new Set();
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/title:\s*"([^"]+)"/g)) set.add(m[1].trim().toLowerCase());
  } catch {}
  return set;
}
const existing = loadTitles("src/games.js");
/* Same game, different name: map the source title to the Chalkle title so
   these don't import as near-duplicates. Keys are lowercase source titles. */
const ALIAS_SKIP = new Set();
for (let i = 1; i <= 5; i++) ALIAS_SKIP.add("bloons tower defense " + i);
for (let i = 1; i <= 5; i++) ALIAS_SKIP.add("bloons td " + i);

/* ---- category classifier ------------------------------------------------ */
const CATS = [
  ["Minecraft", /minecraft/i],
  ["Rhythm", /fnf|funkin|vs\s|rewrite|agoti|kapi|camellia|pibby|rhythm|jammer|lammy|parappa|trombone|beatblock|vib-?ribbon|lumines|sprunki|tempoverdose|shapes\s*&?\s*beats/i],
  ["Horror", /horror|five nights|fnaf|granny|slend|scary|fear|haunt|creepypasta|sonic\.?exe|endoparasitic|iron lung|amnesia|silent hill|omori|fears to fathom|night(?!fall)|epstein|tung sahur|bloodmoney|shift at midnight|midnight shift|no mouth/i],
  ["Tower Defense", /tower defense|bloons|btd/i],
  ["RPG", /rpg|zelda|undertale|deltarune|deltatraveler|earthbound|final fantasy|ace attorn|isaac|daggerfall|hollow knight|celeste|pok[eé]mon|kirby|mother 3|mario(?! kart)|sonic(?!\.exe)|pape?rs please|deltarune/i],
  ["Racing", /racer|rac(e|ing)|kart|drift|driv|escape road|highway|traffic|jelly drift|tanuki|going balls|wheely|earn to die|road of fury/i],
  ["Sports", /basketball|soccer|baseball|football|golf|pool|boxing|hockey|volley|sports|duel\s*beat|ultrapool/i],
  ["Simulation", /simulator|simulation|papa'?s|cook|farm|stardew|sandbox|people playground|spaceflight|flight|get yoked|gacha|pet|kitty|beeswarm|happy room|needy streamer|customer support|shut\s*down/i],
  ["Puzzle", /puzzle|portal|peggle|tetris|minesweeper|alchemy|snake|worm|logic|hardest game|wheely|fireboy|watergirl|little alchemy|abandoned|helltaker|tile|match/i],
  ["Multiplayer", /\.io\b|multiplayer|1v1|pvp|online/i],
  ["Retro", /doom|wolfenstein|retro|arcade|donkey kong|frogger|pac-?man|8-?bit|16-?bit|mega man|sonic the|street fighter|mortal kombat|metroid|castlevania|half-?life|heretic|postal|quake|blood\b|duke/i],
  ["Action", /shooter|shoot|action|brawl|fight|combat|ninja|stick|zomb|gun|soldier|battle|war\b|rogue|dungeon|platformer|parkour|climb|run|jump/i],
];

function classify(title, desc) {
  const hay = title + " " + (desc || "");
  for (const [cat, re] of CATS) if (re.test(hay)) return cat;
  return "Arcade";
}

/* ---- import loop --------------------------------------------------------- */
const seen = new Set();
const out = [];
let copiedPages = 0, copiedImgs = 0, skippedExisting = 0, skippedDup = 0, skippedSecret = 0, skippedMissing = 0;
const imgNameMap = new Map(); // source image basename -> dest basename

for (const g of games) {
  if (!g || !g.title) continue;
  if (g.secret) { skippedSecret++; continue; }
  const key = String(g.title).trim().toLowerCase();
  if (ALIAS_SKIP.has(key)) { skippedExisting++; continue; }
  if (seen.has(key)) { skippedDup++; continue; }
  if (existing.has(key)) { skippedExisting++; seen.add(key); continue; }
  seen.add(key);

  const entry = { title: String(g.title).trim(), category: classify(g.title, g.desc) };
  if (g.desc) entry.desc = String(g.desc).trim();

  const gh = /\/games\/(\d+)\.html$/i.exec(String(g.url || ""));
  if (gh) {
    const id = gh[1];
    const srcPage = path.join(SRC, "games", id + ".html");
    if (!fs.existsSync(srcPage)) { skippedMissing++; continue; }
    fs.copyFileSync(srcPage, path.join(OUT_UGS, id + ".html"));
    copiedPages++;
    entry.url = "/ugs/noah/" + id + ".html";
  } else if (/^https?:\/\//i.test(String(g.url || ""))) {
    entry.url = String(g.url); // external embed (Kart Bros etc.)
  } else {
    skippedMissing++;
    continue;
  }

  const imgFile = String(g.image || "").split("/").pop() || "";
  if (imgFile && /\.(jpe?g|png|webp|avif|gif)$/i.test(imgFile) && fs.existsSync(path.join(SRC, "images", imgFile))) {
    // rename the one profane filename; everything else keeps its basename
    const dest = /^fuckthis\.jpg$/i.test(imgFile) ? "mk4" + path.extname(imgFile) : imgFile;
    if (!imgNameMap.has(imgFile)) {
      fs.copyFileSync(path.join(SRC, "images", imgFile), path.join(OUT_IMG, dest));
      imgNameMap.set(imgFile, dest);
      copiedImgs++;
    }
    entry.thumb = "/assets/games/noah/" + imgNameMap.get(imgFile);
  }

  out.push(entry);
}

/* ---- emit src/noah-games.js --------------------------------------------- */
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const body = out
  .map((e) => {
    const f = Object.entries(e).map(([k, v]) => `${k}: "${esc(v)}"`);
    return "  { " + f.join(", ") + " }";
  })
  .join(",\n");
const banner =
  "/* Imported from the Noah's Calculus Tutor catalog (424-entry collection).\n" +
  " * Game pages: /ugs/noah/*.html (local shells; most load builds from jsDelivr).\n" +
  " * Thumbnails: /assets/games/noah/* (real cover art shipped with the source repo).\n" +
  " * Regenerate with: node scripts/import-noah.mjs */\n" +
  '(function () {\n  "use strict";\n\n  window.ChalkNoahGames = [\n' + body + "\n  ];\n})();\n";
fs.writeFileSync(OUT_JS, banner, "utf8");

console.log(`imported: ${out.length}  (pages: ${copiedPages}, images: ${copiedImgs})`);
console.log(`skipped: ${skippedExisting} already-in-chalkle, ${skippedDup} dup, ${skippedSecret} secret, ${skippedMissing} missing page`);
console.log("wrote", OUT_JS);
