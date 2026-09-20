// Chalkle CDN-method link builder.
// Serves the same three assets (learn SVG, our JS, our HTML) through every free
// CDN-style service we can reach: jsDelivr (all edges + combine + minify),
// StaticDelivr, GitHack/raw.githack, raw.githubusercontent, gitcdn.link,
// ghfast/gh.jasonzeng proxies, esm.sh/gh and GitHub Pages - plus the npm and
// mirror-repo methods that only need one publish/push to go live.
//   node scripts/build-cdn-methods.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "PrismDev3";
const OWNER_WEB = OWNER.toLowerCase();
const CONCURRENCY = 8;

/* ---------- asset sets ---------- */

// 250 already-published svgbulk files (one repo per upload batch).
function svgbulkFiles() {
  let txt = "";
  try { txt = readFileSync(join(root, "svgbulk-links-embedded.txt"), "utf8"); } catch { return []; }
  const seen = new Set();
  const out = [];
  for (const m of txt.matchAll(/PrismDev3\/(svgbulk-[A-Za-z0-9._-]+)@([^/]+)\/(\S+?\.svg)/g)) {
    const key = `${m[1]}@${m[2]}/${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo: m[1], ref: m[2], path: m[3] });
  }
  return out;
}

const AUTO_SVG_COUNT = 10000; // learn-N.svg files in chalkle-auto
const AUTO_SVG_DIGEST = 50;   // how many of them the flat .txt list spells out

const JS_FILES = [{ repo: "chalkle", ref: "main", path: "tmp_verify_localurl.js" }];
const HTML_FILES = [
  { repo: "chalkle", ref: "main", path: "index.html" },
  { repo: "chalkle", ref: "main", path: "ugs/cllearntofly.html" },
];

function svgFiles() {
  const auto = Array.from({ length: AUTO_SVG_DIGEST }, (_, i) => ({
    repo: "chalkle-auto", ref: "main", path: `learn-${i + 1}.svg`,
  }));
  return [...auto, ...svgbulkFiles()];
}

/* ---------- methods ---------- */
// kind: free    = live today off our public GitHub repos
//       npm     = needs `npm publish` once
//       mirror  = needs the repo mirrored to GitLab/Bitbucket/Codeberg once
//       curated = cannot self-publish (Google/Microsoft/cdnjs gatekeeping)
const METHODS = [
  { id: "jsdelivr", service: "jsDelivr (GitHub)", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://cdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}`, note: "main jsDelivr endpoint, free for any public repo" },
  { id: "jsdelivr-default-ref", service: "jsDelivr (default branch, no @ref)", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://cdn.jsdelivr.net/gh/{owner}/{repo}/{path}`, note: "same cache, ref left out of the path" },
  { id: "jsdelivr-fastly", service: "jsDelivr Fastly edge", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://fastly.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}`, note: "separate hostname - useful when the main one is filtered" },
  { id: "jsdelivr-gcore", service: "jsDelivr Gcore edge", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://gcore.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}` },
  { id: "jsdelivr-testingcf", service: "jsDelivr TestingCF edge", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://testingcf.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}` },
  { id: "jsdelivr-quantil", service: "jsDelivr Quantil edge", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://quantil.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}` },
  { id: "jsdelivr-originfastly", service: "jsDelivr OriginFastly edge", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://originfastly.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}` },
  { id: "jsdelivr-bcdn", service: "jsDelivr BunnyCDN edge (jsdelivr.b-cdn.net)", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://jsdelivr.b-cdn.net/gh/{owner}/{repo}@{ref}/{path}` },
  { id: "jsdelivr-combine", service: "jsDelivr /combine/ endpoint", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://cdn.jsdelivr.net/combine/gh/{owner}/{repo}@{ref}/{path}`,
    note: "append ,gh/other/repo@ref/file to bundle several files into one request" },
  { id: "jsdelivr-min", service: "jsDelivr auto-minify (.min.js)", kind: "free", exts: ["js"],
    tpl: `https://cdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}.min.js`,
    probeRef: "https://cdn.jsdelivr.net/gh/jquery/jquery@3.7.1/dist/jquery.min.js",
    note: "jsDelivr minifies on the fly - only works for browser-safe JS" },

  { id: "statically", service: "StaticDelivr (cdn.statically.io/gh)", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://cdn.statically.io/gh/{owner}/{repo}/{ref}/{path}` },
  { id: "statically-atref", service: "StaticDelivr (@ref form)", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://cdn.statically.io/gh/{owner}/{repo}@{ref}/{path}` },
  { id: "statically-minify", service: "StaticDelivr minify query", kind: "free", exts: ["js"],
    tpl: `https://cdn.statically.io/gh/{owner}/{repo}/{ref}/{path}?minify=true` },
  { id: "statically-gl", service: "StaticDelivr GitLab backend", kind: "mirror", exts: ["svg", "js", "html"],
    tpl: `https://cdn.statically.io/gl/{owner}/{repo}/{ref}/{path}`,
    install: `git remote add gl git@gitlab.com:${OWNER}/<repo>.git && git push gl main` },
  { id: "statically-bb", service: "StaticDelivr Bitbucket backend", kind: "mirror", exts: ["svg", "js", "html"],
    tpl: `https://cdn.statically.io/bb/{owner}/{repo}/{ref}/{path}`,
    install: `git remote add bb git@bitbucket.org:${OWNER}/<repo>.git && git push bb main` },

  { id: "githack", service: "GitHack (githack.com)", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://githack.com/{owner}/{repo}/{ref}/{path}`, note: "the original GitHack - serves HTML as text/html" },
  { id: "rawgithack", service: "raw.githack.com (dev mode)", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://raw.githack.com/{owner}/{repo}/{ref}/{path}`, note: "no caching - live the second you push" },
  { id: "rawcdn-githack", service: "rawcdn.githack.com (CDN mode)", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://rawcdn.githack.com/{owner}/{repo}/{ref}/{path}`, note: "cached copy, best for hot files" },

  { id: "github-raw", service: "raw.githubusercontent.com", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`, note: "text/plain for HTML - good for fetch(), not for direct open" },
  { id: "github-raw-page", service: "github.com/.../raw/", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://github.com/{owner}/{repo}/raw/{ref}/{path}` },

  { id: "gitcdnlink-repo", service: "gitcdn.link /repo/", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://gitcdn.link/repo/{owner}/{repo}/{ref}/{path}`, note: "serves HTML as text/html" },
  { id: "gitcdnlink-cdn", service: "gitcdn.link /cdn/", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://gitcdn.link/cdn/{owner}/{repo}/{ref}/{path}` },
  { id: "gitcdnlink-gh", service: "gitcdn.link /gh/", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://gitcdn.link/gh/{owner}/{repo}/{ref}/{path}` },

  { id: "ghfast", service: "ghfast.top proxy", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://ghfast.top/https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` },
  { id: "ghjasonzeng", service: "gh.jasonzeng.dev proxy", kind: "free", exts: ["svg", "js", "html"],
    tpl: `https://gh.jasonzeng.dev/https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` },

  { id: "esmsh-gh", service: "esm.sh /gh/", kind: "free", exts: ["svg", "html", "js"],
    tpl: `https://esm.sh/gh/{owner}/{repo}@{ref}/{path}`,
    note: "serves SVG/HTML as real image/svg+xml and text/html; JS must be a valid ES module" },

  { id: "ghpages", service: "GitHub Pages", kind: "free", exts: ["js", "html"],
    tpl: `https://{ownerweb}.github.io/{repo}/{path}`,
    note: "live for PrismDev3/chalkle; an SVG committed to that repo would show up at prismdev3.github.io/chalkle/learn-1.svg" },

  // ---- one npm publish away ----------------------------------------------
  { id: "unpkg", service: "unpkg (npm)", kind: "npm", exts: ["svg", "js", "html"],
    tpl: `https://unpkg.com/{pkg}@{version}/{path}`,
    probeRef: "https://unpkg.com/lucide-static@latest/icons/accessibility.svg",
    install: "npm publish --access public" },
  { id: "jsdelivr-npm", service: "jsDelivr /npm/", kind: "npm", exts: ["svg", "js", "html"],
    tpl: `https://cdn.jsdelivr.net/npm/{pkg}@{version}/{path}`,
    probeRef: "https://cdn.jsdelivr.net/npm/lucide-static@latest/icons/accessibility.svg",
    install: "npm publish --access public" },
  { id: "jsdelivr-esm", service: "jsDelivr /npm/ +esm", kind: "npm", exts: ["js"],
    tpl: `https://cdn.jsdelivr.net/npm/{pkg}@{version}/+esm`,
    probeRef: "https://cdn.jsdelivr.net/npm/lucide-static@latest/+esm",
    install: "npm publish --access public" },
  { id: "esmrun", service: "esm.run (jsDelivr ESM alias)", kind: "npm", exts: ["js"],
    tpl: `https://esm.run/{pkg}@{version}`,
    probeRef: "https://esm.run/lucide-static@latest", install: "npm publish --access public" },
  { id: "esmsh-npm", service: "esm.sh (npm)", kind: "npm", exts: ["js"],
    tpl: `https://esm.sh/{pkg}@{version}`,
    probeRef: "https://esm.sh/lucide-static@latest", install: "npm publish --access public" },
  { id: "jspm", service: "jspm.dev", kind: "npm", exts: ["js"],
    tpl: `https://jspm.dev/npm:{pkg}@{version}`,
    probeRef: "https://jspm.dev/npm:preact@10", install: "npm publish --access public" },

  // ---- mirror the repo once ----------------------------------------------
  { id: "gitlab-pages", service: "GitLab Pages", kind: "mirror", exts: ["svg", "js", "html"],
    tpl: `https://{ownerweb}.gitlab.io/{repo}/{path}`,
    install: "mirror the repo to gitlab.com + a .gitlab-ci.yml with a `pages:` job" },
  { id: "codeberg-pages", service: "Codeberg Pages", kind: "mirror", exts: ["svg", "js", "html"],
    tpl: `https://{ownerweb}.codeberg.page/{repo}/{path}`,
    install: "mirror the repo to codeberg.org - Codeberg Pages serves the `pages` branch" },

  // ---- curated, cannot self-publish --------------------------------------
  { id: "cdnjs", service: "cdnjs (Cloudflare)", kind: "curated", exts: ["js"],
    tpl: `https://cdnjs.cloudflare.com/ajax/libs/{pkg}/{version}/{path}`,
    probeRef: "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js",
    install: "popular libraries only - PR against cdnjs/cdnjs packages/<name>.json" },
  { id: "google", service: "Google Hosted Libraries", kind: "curated", exts: ["js"],
    tpl: `https://ajax.googleapis.com/ajax/libs/{pkg}/{version}/{path}`,
    probeRef: "https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js",
    install: "curated set (jQuery, Angular, React, ...) - no self-publish path" },
  { id: "microsoft", service: "Microsoft Ajax CDN", kind: "curated", exts: ["js"],
    tpl: `https://ajax.aspnetcdn.com/ajax/{pkg}/{version}/{path}`,
    probeRef: "https://ajax.aspnetcdn.com/ajax/jquery/jquery-3.7.1.min.js",
    install: "legacy frozen list - jQuery, ASP.NET Ajax, Bootstrap, Modernizr only" },

  // ---- verified dead in testing, kept so we don't re-add them ------------
  { id: "testingcdn", service: "testingcdn.jsdelivr.net", kind: "free", exts: ["svg"], dead: true,
    tpl: `https://testingcdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}` },
  { id: "rawcdn-jsdelivr", service: "rawcdn.jsdelivr.net", kind: "free", exts: ["svg"], dead: true,
    tpl: `https://rawcdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}` },
  { id: "gitcdn-xyz", service: "cdn.gitcdn.link / gitcdn.xyz", kind: "free", exts: ["svg"], dead: true,
    tpl: `https://cdn.gitcdn.link/github/{owner}/{repo}/{ref}/{path}` },
  { id: "ghproxy-net", service: "ghproxy.net / gh-proxy.com / raw.gitmirror.com", kind: "free", exts: ["svg"], dead: true,
    tpl: `https://ghproxy.net/https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` },
  { id: "statically-root", service: "statically.io/gh (missing cdn. host)", kind: "free", exts: ["svg"], dead: true,
    tpl: `https://statically.io/gh/{owner}/{repo}/{ref}/{path}`, note: "404s - the working host is cdn.statically.io" },
  { id: "jsdelivr-mirrors", service: "jsdelivr.pai233.top / jsd.cdn.zzko.cn / cdn.jsdelivr.nyc.mn", kind: "free", exts: ["svg"], dead: true,
    tpl: `https://jsdelivr.pai233.top/gh/{owner}/{repo}@{ref}/{path}` },
];

function buildUrl(tpl, file, ext) {
  return tpl
    .replaceAll("{owner}", OWNER)
    .replaceAll("{ownerweb}", OWNER_WEB)
    .replaceAll("{repo}", file.repo)
    .replaceAll("{ref}", file.ref)
    .replaceAll("{path}", file.path)
    .replaceAll("{pkg}", "chalkle")
    .replaceAll("{version}", "1.0.0")
    .replaceAll("{lib}", "chalkle");
}

/* ---------- probing ---------- */
async function probe(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 10000);
      const r = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (chalkle-cdn-method-check)" },
        signal: c.signal, redirect: "follow",
      });
      clearTimeout(t);
      return { status: r.status, type: (r.headers.get("content-type") || "").split(";")[0] };
    } catch (e) {
      if (attempt === 1) return { status: 0, type: "", error: e.message };
    }
  }
}

async function mapLimit(items, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

/* ---------- main ---------- */
const svgs = svgFiles();
const svgbulkCount = svgbulkFiles().length;
const samples = {
  svg: { repo: "chalkle-auto", ref: "main", path: "learn-1.svg" },
  js: JS_FILES[0],
  html: HTML_FILES[1],
};

console.log(`probing ${METHODS.length} methods...`);
const probed = await mapLimit(METHODS, async (m) => {
  const ext = m.exts.includes("html") ? "html" : m.exts[0];
  const url = m.probeRef || buildUrl(m.tpl, samples[ext], ext);
  const r = await probe(url);
  return { ...m, probeUrl: url, probedExt: ext, ...r, live: r.status === 200 };
});
for (const m of probed) {
  const flag = m.probeRef ? "(method check)" : "";
  console.log(`  ${String(m.status).padStart(3)} ${(m.type || "-").padEnd(24)} ${m.service} ${flag}`);
}

const liveFree = probed.filter((m) => m.kind === "free" && m.live && !m.dead);
const pending = probed.filter((m) => m.kind !== "free" && !m.dead);
const dead = probed.filter((m) => m.dead || (m.kind === "free" && !m.live));

/* ---------- 1. flat link list ---------- */
const freeFor = (ext) => liveFree.filter((m) => m.exts.includes(ext));
const lines = [];
lines.push("# Chalkle - every free CDN method, same files. Generated by scripts/build-cdn-methods.mjs");
lines.push(`# ${liveFree.length} live methods | ${svgs.length} svg files (learn-1..learn-${AUTO_SVG_DIGEST} of PrismDev3/chalkle-auto + ${svgbulkCount} svgbulk files)`);
lines.push("# SVG");
for (const f of svgs) for (const m of freeFor("svg")) lines.push(buildUrl(m.tpl, f, "svg"));
lines.push("# JS - PrismDev3/chalkle@main/tmp_verify_localurl.js");
for (const f of JS_FILES) for (const m of freeFor("js")) lines.push(buildUrl(m.tpl, f, "js"));
lines.push("# HTML - PrismDev3/chalkle@main");
for (const f of HTML_FILES) for (const m of freeFor("html")) lines.push(buildUrl(m.tpl, f, "html"));
const listOut = join(root, "cdn-methods-links.txt");
writeFileSync(listOut, lines.join("\n") + "\n", "utf8");
console.log(`\nWROTE ${listOut} (${lines.filter((l) => !l.startsWith("#")).length} urls)`);

/* ---------- 2. method matrix ---------- */
const mx = [];
mx.push("Chalkle CDN method matrix - generated by scripts/build-cdn-methods.mjs");
mx.push("");
mx.push("status  kind     service                                   content-type              tested url");
for (const m of probed) {
  const st = m.dead ? "DEAD" : m.probeRef ? `${m.status}*` : m.status === 0 ? "000" : String(m.status);
  mx.push(
    `${st.padEnd(7)} ${m.kind.padEnd(8)} ${m.service.slice(0, 40).padEnd(41)} ${(m.type || "-").slice(0, 24).padEnd(25)} ${m.probeUrl}`,
  );
}
mx.push("");
mx.push("* = probed against a reference package, because our own file has to be published first");
mx.push("");
mx.push("notes");
for (const m of probed.filter((m) => m.note || m.install)) {
  mx.push(`- ${m.id}: ${[m.note, m.install && `install: ${m.install}`].filter(Boolean).join(" | ")}`);
}
const matrixOut = join(root, "cdn-methods-matrix.txt");
writeFileSync(matrixOut, mx.join("\n") + "\n", "utf8");
console.log(`WROTE ${matrixOut}`);

/* ---------- 3. html viewer ---------- */
const clientData = {
  owner: OWNER,
  ownerweb: OWNER_WEB,
  methods: liveFree.map((m) => ({ id: m.id, service: m.service, tpl: m.tpl, exts: m.exts, type: m.type })),
  assets: { svg: svgs, js: JS_FILES, html: HTML_FILES },
  autoMax: AUTO_SVG_COUNT,
  pending: pending.map((m) => ({
    service: m.service, id: m.id, tpl: m.tpl, install: m.install || "", kind: m.kind,
    example: m.probeRef || "", status: m.status,
  })),
  dead: dead.map((m) => m.service),
};
const digestCount = svgs.length * freeFor("svg").length + JS_FILES.length * freeFor("js").length + HTML_FILES.length * freeFor("html").length;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CDN Methods</title>
<style>
  :root { --bg:#0b1016; --panel:#131a24; --line:#202b39; --tx:#e7eff7; --tx2:#9db0c4; --tx3:#5d7185; --ac:#5eead4; --ac2:#99f6e4; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--tx); font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; padding:26px 18px 60px; }
  .wrap { max-width:1080px; margin:0 auto; }
  h1 { font-size:25px; letter-spacing:-0.02em; }
  .sub { color:var(--tx3); margin-top:5px; font-size:13px; max-width:790px; }
  .stat { display:inline-block; margin-top:10px; padding:3px 10px; border:1px solid var(--line); border-radius:999px; color:var(--ac); font-size:12px; background:var(--panel); }
  input[type=search], input[type=number] { height:40px; padding:0 13px; border-radius:10px; border:1px solid var(--line); background:var(--panel); color:var(--tx); font-size:13.5px; outline:none; }
  input[type=search] { width:100%; margin:16px 0 10px; }
  input:focus { border-color:var(--ac); }
  .rangerow { display:flex; gap:8px; align-items:center; color:var(--tx3); font-size:12.5px; margin-bottom:12px; flex-wrap:wrap; }
  input[type=number] { width:88px; }
  .tabs { display:flex; gap:6px; margin-bottom:14px; flex-wrap:wrap; }
  .tab { height:33px; padding:0 13px; border-radius:9px; border:1px solid var(--line); background:var(--panel); color:var(--tx2); font-size:12.5px; cursor:pointer; white-space:nowrap; }
  .tab.on { background:var(--ac); color:#062018; border-color:var(--ac); font-weight:700; }
  .meta { color:var(--tx3); font-size:12px; margin-bottom:10px; }
  .list { display:flex; flex-direction:column; gap:6px; }
  .row { display:flex; align-items:center; gap:10px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:7px 12px; }
  .row .svc { flex:0 0 195px; font-size:12px; font-weight:600; color:var(--tx2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .row .url { flex:1; min-width:0; color:var(--ac); font-size:11.5px; font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .row .url:hover { color:var(--ac2); text-decoration:underline; }
  .go { flex-shrink:0; padding:5px 11px; border-radius:7px; border:none; background:var(--ac); color:#062018; font-weight:700; font-size:12px; cursor:pointer; }
  .go.copy { background:transparent; border:1px solid var(--line); color:var(--tx2); }
  .go.copy:hover { border-color:var(--ac); color:var(--ac); }
  .hint { color:var(--tx3); font-size:12px; margin-top:20px; line-height:1.75; }
  .hint b { color:var(--tx2); }
  .hint a { color:var(--ac); }
  code { font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; color:var(--tx2); }
  .dead { color:#f87171; }
  @media (max-width:720px) { .row .svc { display:none; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>CDN Methods</h1>
    <div class="sub">One learn SVG, one JS file and one HTML page pushed through every free CDN-style service that answers. jsDelivr (9 endpoints: Cloudflare + Fastly, Gcore, Quantil, TestingCF, OriginFastly, BunnyCDN, <code>/combine/</code> and <code>.min.js</code>), StaticDelivr, GitHack, raw.githack, raw.githubusercontent, gitcdn.link, ghfast / gh.jasonzeng proxies, esm.sh/gh and GitHub Pages.</div>
    <div class="stat" id="stat"></div>
  </header>
  <input type="search" id="q" placeholder="Filter by service, repo or filename..." autocomplete="off" spellcheck="false">
  <div class="rangerow">
    <span>chalkle-auto range:</span>
    learn-<input type="number" id="from" value="1" min="1" max="${AUTO_SVG_COUNT}">
    to learn-<input type="number" id="to" value="200" min="1" max="${AUTO_SVG_COUNT}">
    <button class="go" id="build">Build URLs</button>
    <span>(chalkle-auto holds ${AUTO_SVG_COUNT.toLocaleString()} files; the tab below lists a smaller slice)</span>
  </div>
  <div class="tabs" id="tabs"></div>
  <div class="meta" id="meta"></div>
  <div class="list" id="list"></div>
  <div class="hint" id="pending"></div>
  <div class="hint">
    <b>Dead after testing</b> (${dead.length}): <span class="dead">${dead.map((m) => m.service).join(" / ")}</span><br>
    <b>Content-type gotcha</b>: jsDelivr, StaticDelivr and raw.githubusercontent hand <code>.html</code> back as text/plain, so open games through GitHack, raw.githack, gitcdn.link, esm.sh/gh or GitHub Pages.<br>
    <b>GitHub Pages + SVG</b>: Pages is only enabled on the chalkle repo, so SVG links there start resolving the moment an SVG is committed to it; the svgbulk / chalkle-auto repos have no Pages.
  </div>
</div>
<script>
(function () {
  var D = ${JSON.stringify(clientData).replace(/</g, "\\u003c")};
  var MAXSHOW = 500;
  function build(tpl, f) {
    return tpl.replace("{owner}", D.owner).replace("{ownerweb}", D.ownerweb)
      .replace("{repo}", f.repo).replace("{ref}", f.ref).replace("{path}", f.path);
  }
  function urlFor(tpl, repo, ref, path) { return build(tpl, { repo: repo, ref: ref, path: path }); }
  var ALL = [];
  function add(service, id, url, cat) { ALL.push({ service: service, id: id, url: url, cat: cat }); }
  function addSet(ext, files, cat) {
    var ms = D.methods.filter(function (m) { return m.exts.indexOf(ext) !== -1; });
    for (var i = 0; i < files.length; i++)
      for (var j = 0; j < ms.length; j++) add(ms[j].service, ms[j].id, build(ms[j].tpl, files[i]), cat);
  }
  addSet("svg", D.assets.svg, "svg");
  addSet("js", D.assets.js, "js");
  addSet("html", D.assets.html, "html");

  var svgMethods = D.methods.filter(function (m) { return m.exts.indexOf("svg") !== -1; });
  function generateRange(from, to) {
    var rows = [], step = 1;
    if (to - from > 2000) step = Math.ceil((to - from) / 2000);
    for (var n = from; n <= to; n += step) {
      for (var j = 0; j < svgMethods.length; j++)
        rows.push({ service: svgMethods[j].service, id: svgMethods[j].id, url: urlFor(svgMethods[j].tpl, "chalkle-auto", "main", "learn-" + n + ".svg"), cat: "range" });
    }
    return rows;
  }
  var RANGE = generateRange(1, 200);

  var FILTERED = [], CAT = "all", Q = "";
  var list = document.getElementById("list"), meta = document.getElementById("meta");
  var BASE = ALL.slice();
  var tabs = [["all", "All"], ["range", "learn range"], ["svg", "SVG digest"], ["js", "JS"], ["html", "HTML"]];
  function pool() { return CAT === "range" ? RANGE : BASE; }
  function tabCount(cat) { return cat === "range" ? RANGE.length : BASE.filter(function (r) { return cat === "all" || r.cat === cat; }).length; }
  function drawTabs() {
    var th = "";
    for (var t = 0; t < tabs.length; t++)
      th += '<button class="tab' + (tabs[t][0] === CAT ? " on" : "") + '" data-cat="' + tabs[t][0] + '">' + tabs[t][1] + " (" + tabCount(tabs[t][0]).toLocaleString() + ")</button>";
    document.getElementById("tabs").innerHTML = th;
  }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function render() {
    var src = pool().filter(function (r) {
      if (CAT !== "all" && CAT !== "range" && r.cat !== CAT) return false;
      if (!Q) return true;
      return (r.service + " " + r.url).toLowerCase().indexOf(Q) !== -1;
    });
    FILTERED = src;
    var html = "";
    for (var i = 0; i < Math.min(src.length, MAXSHOW); i++) {
      var u = esc(src[i].url);
      html += '<div class="row"><span class="svc" title="' + esc(src[i].service) + '">' + esc(src[i].service) + "</span>" +
        '<a class="url" href="' + u + '" target="_blank" rel="noopener" title="' + u + '">' + u + "</a>" +
        '<button class="go" data-url="' + u + '">Open</button>' +
        '<button class="go copy" data-copy="' + u + '">Copy</button></div>';
    }
    list.innerHTML = html;
    meta.textContent = src.length.toLocaleString() + " links" + (Q ? ' matching "' + Q + '"' : "") +
      (src.length > MAXSHOW ? " - first " + MAXSHOW + " shown, use the search box to narrow" : "");
  }
  function apply() { render(); }
  document.getElementById("q").addEventListener("input", function (e) { Q = e.target.value.trim().toLowerCase(); apply(); });
  document.getElementById("tabs").addEventListener("click", function (e) {
    var b = e.target.closest(".tab");
    if (!b) return;
    CAT = b.getAttribute("data-cat"); drawTabs(); apply();
  });
  document.getElementById("build").addEventListener("click", function () {
    var from = Math.max(1, Math.min(D.autoMax, parseInt(document.getElementById("from").value, 10) || 1));
    var to = Math.max(from, Math.min(D.autoMax, parseInt(document.getElementById("to").value, 10) || from));
    RANGE = generateRange(from, to);
    CAT = "range"; drawTabs(); apply();
  });
  list.addEventListener("click", function (e) {
    var open = e.target.closest(".go[data-url]");
    if (open) { window.open(open.getAttribute("data-url"), "_blank", "noopener"); return; }
    var copy = e.target.closest(".go[data-copy]");
    if (copy) navigator.clipboard.writeText(copy.getAttribute("data-copy")).then(function () {
      var old = copy.textContent; copy.textContent = "Copied"; setTimeout(function () { copy.textContent = old; }, 1100);
    });
  });
  document.getElementById("stat").textContent = (BASE.length + RANGE.length).toLocaleString() + " links, " + D.methods.length + " live methods";
  drawTabs(); render();
})();
</script>
<script>
(function () {
  var D = ${JSON.stringify(clientData.pending).replace(/</g, "\\u003c")};
  var h = "<b>One step away</b> - " + D.length + " more methods, each needs a single publish or mirror push:<br>";
  for (var i = 0; i < D.length; i++) {
    h += "<br><b>" + D[i].service + "</b> (" + D[i].kind + "): <code>" + D[i].tpl + "</code>" +
      (D[i].install ? " &mdash; " + D[i].install : "") +
      (D[i].example ? ' &mdash; <a href="' + D[i].example + '" target="_blank" rel="noopener">method check ' + D[i].status + "</a>" : "");
  }
  document.getElementById("pending").innerHTML = h;
})();
</script>
</body>
</html>`;

const htmlOut = join(root, "build", "cdn-methods.html");
mkdirSync(dirname(htmlOut), { recursive: true });
writeFileSync(htmlOut, html, "utf8");
console.log(`WROTE ${htmlOut} (${(html.length / 1024).toFixed(0)} KB - ${digestCount} digest urls + any learn-N range built in the page)`);
console.log(`\nlive free methods: ${liveFree.length} | one step away: ${pending.length} | dead: ${dead.length}`);
