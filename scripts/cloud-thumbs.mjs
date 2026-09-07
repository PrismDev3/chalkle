/* Replaces "buns" cloud-game thumbnails with official Steam header art
 * (460x215, hotlink-friendly CDN). The cloud catalog (AAA streaming titles)
 * shares almost no titles with the Noah repo, so the art comes from Steam's
 * store CDN instead - which also works inside the single-file build, unlike
 * locally copied files.
 *
 * Title matching uses Steam's storesearch API; a result is accepted when its
 * normalized name starts with the query's first words (typo tolerant) and a
 * manual OVERRIDES map patches the rest.
 *
 * Usage: node scripts/cloud-thumbs.mjs [--dry] [--force]
 *   --dry    report only, no writes
 *   --force  re-fetch even entries that already point at Steam CDN art
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const force = args.includes("--force");

const FILE = path.join(root, "src", "cloudgames.js");
const text = fs.readFileSync(FILE, "utf8");

/* Titles whose Steam naming differs enough that search needs a hint.
 * "steam <words>" query -> exact title must contain <mustInclude>. */
const HINTS = {
  "Grand Theft Auto: Vice City": { q: "grand theft auto vice city", mustInclude: "vice city" },
  "GTA: Vice City": { q: "grand theft auto vice city", mustInclude: "vice city" },
  "Dead Space™ 3": { q: "dead space 3", mustInclude: "dead space" },
  "Dead Space 2": { q: "dead space 2", mustInclude: "dead space" },
  "The Last of Us™ Part II": { q: "the last of us part ii", mustInclude: "last of us" },
  "Diablo II - Resurrected": { q: "diablo ii resurrected", mustInclude: "diablo" },
  "GUILTY GEAR -STRIVE-": { q: "guilty gear strive", mustInclude: "guilty gear" },
  "God of War: Ragnarök": { q: "god of war ragnarok", mustInclude: "ragnar" },
  "Grand Theft Auto IV": { q: "grand theft auto iv", mustInclude: "grand theft auto" },
  "Call of Duty: Black Ops 6": { q: "call of duty black ops 6", mustInclude: "black ops" },
  "Red Dead Redemption 2": { q: "red dead redemption 2", mustInclude: "red dead" },
  "ELDEN RING": { q: "elden ring", mustInclude: "elden" },
  "Tomb Raider - Definitive Edition": { q: "tomb raider", mustInclude: "tomb raider" },
  "Cities: Skylines 2": { q: "cities skylines ii", mustInclude: "skylines" },
  "Poppy Playtime: Chapter 1": { q: "poppy playtime", mustInclude: "poppy playtime" },
  "GTA V MOD version": { q: "grand theft auto v", mustInclude: "grand theft auto" },
  "God of War 4": { q: "god of war", mustInclude: "god of war" },
  "Control": { q: "control ultimate edition", mustInclude: "control" },
  "Alan Wake 2": { q: "alan wake 2", mustInclude: "alan wake" },
  "GhostWire: Tokyo": { q: "ghostwire tokyo", mustInclude: "ghostwire" },
  "Subnautica Zero": { q: "subnautica below zero", mustInclude: "subnautica" },
  "Drift Racing Online": { q: "carx drift racing online", mustInclude: "drift racing" },
  "Football\uFF1APES 2021": { q: "efootball pes 2021", mustInclude: "pes" },
  "World War Z - Aftermath": { q: "world war z aftermath", mustInclude: "aftermath" },
  "Transformers: Battlegrounds": { q: "transformers battlegrounds", mustInclude: "transformers" },
  "Frostpunk 2": { q: "frostpunk 2", mustInclude: "frostpunk" },
  "Cities: Skylines 2": { q: "cities skylines 2", mustInclude: "skylines" },
  "Ranch Simulator22": { q: "ranch simulator", mustInclude: "ranch simulator" },
};

/* Names that will never resolve on Steam (non-Steam games, console/epic
 * exclusives, web games). Skipped instead of noise-matching. */
const SKIP = new Set([
  "Roblox", "Fortnite", "Among Us 3D", "Only Up", "Schedule 1",
  "I Am Jesus Christ", "Steal a Brainrot", "Grow a Garden 2",
  "Steal a Brainrot Rebirth", "Plants vs Brainrots", "Rivals",
  "99 Nights in the Forest", "Dead Rails", "Fisch", "Basketball Zero",
  "Volleyball Legends", "Blue Lock Rivals", "Anime Vanguards",
  "Jujutsu Infinite", "The Strongest Battlegrounds", "Dress to Impress",
  "Murder Mystery 2", "Adopt Me", "Brookhaven RP", "BedWars",
  "Tower of Hell", "Piggy", "Doors", "Blox Fruits",
]);

function norm(t) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function readCloud(src) {
  const start = src.indexOf("window.ChalkCloudGames");
  const arrStart = src.indexOf("[", start);
  let depth = 0, end = arrStart;
  for (; end < src.length; end++) {
    if (src[end] === "[") depth++;
    else if (src[end] === "]") { depth--; if (!depth) break; }
  }
  const body = src.slice(arrStart, end + 1);
  const titles = [...body.matchAll(/title:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  return { body, titles };
}

/* Steam storesearch: https://store.steampowered.com/api/storesearch/?term=..&cc=us&l=en
   Paced + retried: Steam rate-limits bursts of rapid requests. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const searchCache = new Map();
async function steamSearch(term) {
  const key = term.toLowerCase();
  if (searchCache.has(key)) return searchCache.get(key);
  const url = "https://store.steampowered.com/api/storesearch/?term=" + encodeURIComponent(term) + "&cc=us&l=en";
  let out = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 ChalkleThumbs/1.0" } });
      if (res.ok) {
        const j = await res.json();
        out = Array.isArray(j) ? j : (Array.isArray(j && j.items) ? j.items : []);
        if (out.length || attempt) break;
      } else if (attempt) break;
    } catch (e) { if (attempt) break; }
    await sleep(1600);
  }
  await sleep(150);
  searchCache.set(key, out);
  return out;
}

/* Each cloud entry: { title, img } parsed positionally. */
const { body, titles } = readCloud(text);
const imgs = [...body.matchAll(/img:\s*"([^"]*)"/g)].map((m) => m[1]);
const n = Math.max(titles.length, imgs.length);
const entries = [];
for (let i = 0; i < n; i++) entries.push({ i, title: titles[i] || "", img: imgs[i] || "" });

let swapped = 0, skipped = 0, failed = [];
const results = new Map(); // entry index -> new url

for (const e of entries) {
  if (!e.title) continue;
  if (SKIP.has(e.title)) { skipped++; continue; }
  if (!force && /cdn\.akamai\.steampipe|steamstatic|cdn\.cloud\.steampipe/.test(e.img)) { skipped++; continue; }
  const hint = HINTS[e.title];
  let term = hint ? hint.q : e.title
    .replace(/[™®:—－]/g, " ")          /* TM (R) colon fullwidth-colon dash */
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")  /* Tekken8 -> Tekken 8 */
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .replace(/\s+/g, " ").trim();
  const list = await steamSearch(term);
  const words = norm(term).split(" ").filter(Boolean);
  const head = words.slice(0, 3).join(" ");
  const must = hint ? hint.mustInclude : null;
  /* DLC / expansion / edition noise pollutes results; reject those names
     outright, then prefer an exact normalized match before prefix matches. */
  const BAD = ["dlc", "expansion", "upgrade", "costume", "pack", "soundtrack", "ost", "demo", "pre-order", "bonus", "bundle", "season pass", "artbook", "playtest", "server", "sdk", "toolkit", "modding", "cosmetic"];
  const titleN = norm(e.title);
  const okName = (r) => {
    const nm = norm(r.name);
    if (must && !nm.includes(norm(must))) return false;
    if (nm !== titleN) {
      for (const w of BAD) if (nm.includes(w) && !titleN.includes(w)) return false;
    }
    if (nm === titleN) return true;
    return nm.startsWith(head);
  };
  const exact = list.find((r) => okName(r) && norm(r.name) === norm(e.title));
  const prefix = list.find(okName);
  const pick = exact || prefix;
  if (!pick || !pick.tiny_image) { failed.push(e.title); continue; }
  /* Classic header CDN pattern is the reliable one: the storesearch capsule
     URL swaps to header.jpg.jpg under the new asset tree, while
     /steam/apps/<id>/header.jpg works for every appid. */
  const appId = pick.id || ((pick.tiny_image.match(/\/apps\/(\d+)\//) || [])[1]);
  if (!appId) { failed.push(e.title + " (no appid)"); continue; }
  const big = "https://cdn.akamai.steamstatic.com/steam/apps/" + appId + "/header.jpg";
  results.set(e.i, big);
  swapped++;
  console.log(`ok  ${e.title}  ->  ${pick.name}`);
}

console.log(`\nentries: ${entries.length}  matched: ${swapped}  skipped: ${skipped}  failed: ${failed.length}`);
if (failed.length) console.log("failed:\n  " + failed.join("\n  "));

if (!dry && swapped) {
  let k = 0;
  const out = text.replace(/(img:\s*")([^"]*)(")/g, (m, pre, url, post) => {
    const e = entries[k++];
    if (!e || !results.has(e.i)) return m;
    return pre + results.get(e.i) + post;
  });
  fs.writeFileSync(FILE, out);
  console.log("cloudgames.js rewritten.");
} else if (dry) {
  console.log("(dry run - nothing written)");
}
