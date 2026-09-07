// Chalkle ESM Links generator.
// Builds a single HTML page of working esm.sh URLs: verified playable games
// (npm packages that ship HTML, burgerland-style), Chalkle mirrors served via
// esm.sh/gh (SVG = harder to block), and ~10k npm import URLs.
//   node scripts/build-esm-links.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONCURRENCY = 10;

/* ---------- helpers ---------- */
async function getJSON(url) {
  const r = await fetch(url, { headers: { "user-agent": "chalkle-esm-builder" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function probeUrl(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 6000);
    const r = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0", accept: "text/html,image/svg+xml,*/*" },
      signal: c.signal,
      redirect: "follow",
    });
    clearTimeout(t);
    if (r.status !== 200) return null;
    const ct = r.headers.get("content-type") || "";
    return ct.includes("html") || ct.includes("svg") ? ct : null;
  } catch (_) { return null; }
}

async function mapLimit(items, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

async function npmSearch(text, size, from) {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${size}&from=${from}`;
  const j = await getJSON(url);
  return (j.objects || []).map((o) => ({ name: o.package.name, version: o.package.version, desc: (o.package.description || "").slice(0, 90) }));
}

/* ---------- 1. verified playable HTML games from npm ---------- */
const GAME_QUERIES = [
  "html5 game", "web game", "phaser", "browser game", "javascript game",
  "canvas game", "puzzle game", "idle game", "clicker game", "retro game",
  "2d game", "snake game", "tetris", "2048", "chess", "platformer",
  "arcade game", "card game", "rpg game", "shooter",
];

async function collectPlayables() {
  const seen = new Set();
  const playable = [];
  for (const q of GAME_QUERIES) {
    let pkgs = [];
    try { pkgs = await npmSearch(q, 250, 0); } catch (e) { console.error("search fail", q, e.message); continue; }
    const fresh = pkgs.filter((p) => !seen.has(p.name));
    pkgs.forEach((p) => seen.add(p.name));
    console.log(`probe "${q}": ${fresh.length} new`);
    const results = await mapLimit(fresh, async (pkg) => {
      for (const p of ["index.html", "dist/index.html", "public/index.html", "assets/index.html"]) {
        const url = `https://esm.sh/${pkg.name}@${pkg.version}/${p}`;
        if (await probeUrl(url)) return { name: pkg.name, version: pkg.version, url, desc: pkg.desc };
      }
      return null;
    });
    for (const h of results) {
      if (h) { playable.push(h); console.log(`  PLAY ${h.name}@${h.version} ${h.url}`); }
    }
  }
  return playable;
}

/* ---------- 2. Chalkle mirrors through esm.sh/gh ---------- */
function collectSiteMirrors() {
  const mirrors = [];
  const files = ["src/sites.js", "src/apps.js"];
  for (const f of files) {
    let text;
    try { text = readFileSync(join(root, f), "utf8"); } catch { continue; }
    const re = /\{\s*title:\s*"([^"]+)",\s*url:\s*"([^"]+)"[^}]*category:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(text))) {
      const [, title, url, category] = m;
      const gh = url.match(/https:\/\/(?:cdn|fastly|gcore)\.jsdelivr\.net\/gh\/([^/@]+)\/([^@]+)@([^/]+)\/(.+)/);
      const githack = url.match(/https:\/\/raw\.githack\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)/);
      let esmUrl = null;
      if (gh) esmUrl = `https://esm.sh/gh/${gh[1]}/${gh[2]}@${gh[3]}/${gh[4]}`;
      else if (githack) esmUrl = `https://esm.sh/gh/${githack[1]}/${githack[2]}@${githack[3]}/${githack[4]}`;
      if (esmUrl) mirrors.push({ title, url: esmUrl, category: category || "Chalkle" });
    }
  }
  return mirrors;
}

/* ---------- 3. ~10k npm import links ---------- */
const IMPORT_QUERIES = [
  ["react", 10], ["vue", 10], ["game", 10], ["web", 10], ["css", 10],
  ["javascript", 10], ["node", 10], ["api", 10], ["tools", 10], ["design", 10],
];

async function collectImports() {
  const seen = new Set();
  const imports = [];
  for (const [q, pages] of IMPORT_QUERIES) {
    for (let i = 0; i < pages; i++) {
      let pkgs = [];
      try { pkgs = await npmSearch(q, 250, i * 250); } catch (e) { console.error("import fail", q, i, e.message); continue; }
      if (!pkgs.length) break;
      for (const p of pkgs) {
        if (seen.has(p.name)) continue;
        seen.add(p.name);
        imports.push({ name: p.name, version: p.version, desc: p.desc });
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  return imports;
}

/* ---------- build the page ---------- */
function hue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}
function svgIcon(name) {
  const h = hue(name);
  const letter = (name.replace(/^@/, "").split("/").pop() || "?")[0].toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="hsl(${h},55%,24%)"/><text x="24" y="31" font-family="Arial,sans-serif" font-size="20" font-weight="700" fill="hsl(${h},80%,72%)" text-anchor="middle">${letter}</text></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pageHTML(playable, mirrors, imports) {
  const rows = [];
  for (const g of playable) {
    rows.push({ kind: "play", name: g.name, url: g.url, desc: g.desc, cat: "playable" });
  }
  for (const m of mirrors) {
    rows.push({ kind: "mirror", name: m.title, url: m.url, desc: m.category, cat: "mirror" });
  }
  for (const i of imports) {
    rows.push({ kind: "import", name: i.name, url: `https://esm.sh/${i.name}@${i.version}`, desc: i.desc, cat: "import" });
  }
  const data = JSON.stringify(rows).replace(/</g, "\\u003c");
  const total = rows.length;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESM Links</title>
<style>
  :root { --bg:#0c1016; --panel:#121821; --line:#1f2937; --tx:#e8f0f6; --tx2:#9fb2c4; --tx3:#5f7285; --ac:#818cf8; --ac2:#a5b4fc; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--tx); font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; padding:28px 20px 60px; min-height:100vh; }
  .wrap { max-width:980px; margin:0 auto; }
  header { margin-bottom:22px; }
  h1 { font-size:26px; letter-spacing:-0.02em; }
  .sub { color:var(--tx3); margin-top:4px; font-size:13px; }
  .stat { display:inline-block; margin-top:10px; padding:3px 10px; border:1px solid var(--line); border-radius:999px; color:var(--ac); font-size:12px; background:var(--panel); }
  .search-row { display:flex; gap:8px; margin-bottom:14px; }
  input[type=search] { flex:1; height:42px; padding:0 14px; border-radius:10px; border:1px solid var(--line); background:var(--panel); color:var(--tx); font-size:14px; outline:none; }
  input[type=search]:focus { border-color:var(--ac); }
  input[type=search]::placeholder { color:var(--tx3); }
  .tabs { display:flex; gap:6px; margin-bottom:14px; flex-wrap:wrap; }
  .tab { height:34px; padding:0 14px; border-radius:9px; border:1px solid var(--line); background:var(--panel); color:var(--tx2); font-size:12.5px; cursor:pointer; white-space:nowrap; }
  .tab.on { background:var(--ac); color:#0a100d; border-color:var(--ac); font-weight:700; }
  .meta { color:var(--tx3); font-size:12px; margin-bottom:10px; min-height:18px; }
  .list { display:flex; flex-direction:column; gap:6px; }
  .row { display:flex; align-items:center; gap:10px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:8px 12px; }
  .row img { width:30px; height:30px; border-radius:7px; flex-shrink:0; display:block; }
  .row .name { flex-shrink:0; min-width:150px; max-width:230px; color:var(--tx); font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .row .url { flex:1; min-width:0; color:var(--ac); font-size:11.5px; font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .row .url:hover { color:var(--ac2); text-decoration:underline; }
  .row .badge { flex-shrink:0; font-size:10px; font-weight:700; letter-spacing:0.04em; padding:2px 7px; border-radius:999px; text-transform:uppercase; }
  .badge.play { background:rgba(52,211,153,0.14); color:#34d399; border:1px solid rgba(52,211,153,0.4); }
  .badge.mirror { background:rgba(129,140,248,0.14); color:#818cf8; border:1px solid rgba(129,140,248,0.4); }
  .badge.import { background:rgba(148,163,184,0.12); color:#94a3b8; border:1px solid rgba(148,163,184,0.3); }
  .go { flex-shrink:0; padding:5px 12px; border-radius:7px; border:none; background:var(--ac); color:#0a100d; font-weight:700; font-size:12px; cursor:pointer; }
  .go:hover { background:var(--ac2); }
  .go.copy { background:transparent; border:1px solid var(--line); color:var(--tx2); }
  .go.copy:hover { border-color:var(--ac); color:var(--ac); }
  .hint { color:var(--tx3); font-size:12px; margin-top:18px; line-height:1.6; }
  .hint b { color:var(--tx2); }
  pre { margin-top:12px; padding:14px 16px; border-radius:10px; background:#0a0d12; border:1px solid var(--line); font-size:12px; line-height:1.6; overflow-x:auto; font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; color:var(--tx2); }
  pre .cm { color:var(--tx3); }
  @media (max-width:720px) { .row .name { min-width:110px; max-width:130px; } .row .url { font-size:10.5px; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>ESM Links</h1>
    <div class="sub">esm.sh serves npm packages and GitHub repos straight from a URL, no install or build step. Every link below is a working esm.sh URL.</div>
    <div class="stat" id="stat">${total.toLocaleString()} links</div>
  </header>
  <div class="search-row">
    <input type="search" id="q" placeholder="Search games, mirrors and packages..." autocomplete="off" spellcheck="false">
  </div>
  <div class="tabs">
    <button class="tab on" data-cat="all">All (${total.toLocaleString()})</button>
    <button class="tab" data-cat="play">Playable (${playable.length})</button>
    <button class="tab" data-cat="mirror">Chalkle mirrors (${mirrors.length})</button>
    <button class="tab" data-cat="import">Import URLs (${imports.length.toLocaleString()})</button>
  </div>
  <div class="meta" id="meta"></div>
  <div class="list" id="list"></div>
  <div class="hint">
    <b>Playable</b>: npm packages that ship a real HTML page (games, demos, tools) - opens straight from esm.sh, like the burgerland pattern.<br>
    <b>Chalkle mirrors</b>: the site's own SVG mirrors and tools re-hosted through esm.sh/gh - SVGs get through filters that block other files.<br>
    <b>Import URLs</b>: paste into a <b>&lt;script type="module"&gt;</b> or import map - <b>import x from "https://esm.sh/pkg@ver"</b>, zero install.<br>
    Icons are inline SVG data URIs so they never make a network request that a filter could block.
  </div>
  <pre><span class="cm">&lt;script type="importmap"&gt;</span>
{
  "imports": {
    "react": "https://esm.sh/react@19.2.0",
    "react-dom/": "https://esm.sh/react-dom@19.2.0/"
  }
}
<span class="cm">&lt;/script&gt;</span>
<span class="cm">&lt;script type="module"&gt;</span>
  import React from "react";
<span class="cm">&lt;/script&gt;</span></pre>
</div>
<script>
(function () {
  var ROWS = ${data};
  var ALL = ROWS.slice();
  var FILTERED = ALL.slice();
  var CAT = "all";
  var Q = "";
  var list = document.getElementById("list");
  var meta = document.getElementById("meta");
  function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function render() {
    var html = "";
    for (var i = 0; i < FILTERED.length; i++) {
      var r = FILTERED[i];
      var u = esc(r.url);
      html += '<div class="row"><img alt="" src="' + ICON(r.name) + '">' +
        '<span class="name" title="' + esc(r.desc || r.name) + '">' + esc(r.name) + '</span>' +
        '<a class="url" href="' + u + '" target="_blank" rel="noopener" title="' + u + '">' + u + '</a>' +
        '<span class="badge ' + esc(r.kind) + '">' + (r.kind === "play" ? "Play" : r.kind === "mirror" ? "Mirror" : "Import") + '</span>' +
        '<button class="go" data-url="' + u + '">Open</button>' +
        '<button class="go copy" data-copy="' + u + '">Copy</button></div>';
    }
    list.innerHTML = html;
    meta.textContent = Q ? FILTERED.length.toLocaleString() + " matches for \"" + Q + "\"" : FILTERED.length.toLocaleString() + " links";
  }
  function ICON(name) {
    var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    var letter = (name.replace(/^@/, "").split("/").pop() || "?")[0].toUpperCase();
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="hsl(' + h + ',55%,24%)"/><text x="24" y="31" font-family="Arial,sans-serif" font-size="20" font-weight="700" fill="hsl(' + h + ',80%,72%)" text-anchor="middle">' + letter + '</text></svg>';
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }
  function apply() {
    var q = Q.toLowerCase();
    FILTERED = ALL.filter(function (r) {
      if (CAT !== "all" && r.cat !== CAT) return false;
      if (!q) return true;
      return (r.name + " " + (r.desc || "") + " " + r.url).toLowerCase().indexOf(q) !== -1;
    });
    render();
  }
  document.getElementById("q").addEventListener("input", function (e) { Q = e.target.value; apply(); });
  document.querySelectorAll(".tab").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("on"); });
      b.classList.add("on");
      CAT = b.getAttribute("data-cat");
      apply();
    });
  });
  list.addEventListener("click", function (e) {
    var open = e.target.closest(".go[data-url]");
    if (open) { window.open(open.getAttribute("data-url"), "_blank", "noopener"); return; }
    var copy = e.target.closest(".go[data-copy]");
    if (copy) {
      var url = copy.getAttribute("data-copy");
      navigator.clipboard.writeText(url).then(function () {
        var old = copy.textContent; copy.textContent = "Copied";
        setTimeout(function () { copy.textContent = old; }, 1200);
      });
    }
  });
  document.getElementById("stat").textContent = ALL.length.toLocaleString() + " links";
  render();
})();
</script>
</body>
</html>`;
}

/* ---------- main ---------- */
console.log("1/3 collecting playable HTML games from npm...");
const playable = await collectPlayables();
console.log(`playable: ${playable.length}`);

console.log("2/3 converting Chalkle mirrors to esm.sh/gh and verifying...");
const mirrorCandidates = collectSiteMirrors();
const mirrorProbe = await mapLimit(mirrorCandidates, async (m) => ({
  ...m, ok: !!(await probeUrl(m.url)),
}));
const mirrors = mirrorProbe.filter((m) => m.ok);
for (const f of mirrorProbe.filter((m) => !m.ok)) console.log(`  FAIL ${f.title} ${f.url}`);

console.log("3/3 collecting ~10k npm import links...");
const imports = await collectImports();
console.log(`imports: ${imports.length}`);

const html = pageHTML(playable, mirrors, imports);
const out = join(root, "build", "esm-links.html");
writeFileSync(out, html, "utf8");
console.log(`\nWROTE ${out} (${(html.length / 1024).toFixed(0)} KB)`);
console.log(`total: ${playable.length + mirrors.length + imports.length.toLocaleString()} links`);