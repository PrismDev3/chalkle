/**
 * build-single-chalkle.mjs
 * Builds a self-contained single-file Chalkle (chalkle-single.html).
 *
 *  1. Reads index.html, inlines <link stylesheet> and <script src>.
 *  2. Rewrites local image asset references in the whole doc to data URIs.
 *  3. Embeds self-contained local HTML games (no local sibling assets) as
 *     data:text/html and patches fetch/XHR so their /game-builds urls resolve.
 *  4. Injects a localStorage shim for opaque-origin contexts.
 *  5. Writes chalkle-single.html.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const out = path.join(root, 'build', 'chalkle-single.html');
const cdnOut = path.join(root, 'build', 'chalkle-single-cdn.html');
const CDN_SAFE = process.argv.includes('--cdn');

const MIME = {
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
  '.gif':'image/gif','.svg':'image/svg+xml','.ico':'image/x-icon','.html':'text/html',
  '.ttf':'font/ttf','.woff':'font/woff','.woff2':'font/woff2','.mp3':'audio/mpeg','.ogg':'audio/ogg'
};
const dataURI = (file) => {
  // Prefer the downscaled copy from _smallthumbs/ for image files (the
  // single-file build would otherwise embed 70+MB of full-size thumbnails).
  const IMG = { '.jpg':1,'.jpeg':1,'.png':1,'.webp':1 };
  const isImg = IMG[path.extname(file).toLowerCase()];
  if (isImg) {
    const small = path.join(root, '_smallthumbs', file.slice(root.length).replace(/^[\\/]+/,''));
    if (fs.existsSync(small)) file = small;
  }
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
};

let idx = fs.readFileSync(path.join(root,'index.html'),'utf8');

// ── strip the launch chooser (it is the multi-file site's entry screen;
//    the single file IS the payload the chooser launches, so it would
//    otherwise try to fetch itself) ────────────────────────────────
idx = idx.replace(/<!-- ── Launch chooser[\s\S]*?<\/script>\s*/i, '');

// ── 0. localStorage shim + fetch/XHR patch (inject FIRST) ────
// These must be injected into the ORIGINAL index.html positions BEFORE any
// script bodies are inlined: the inlined JS contains literal `</body>`/
// `</head>` inside its strings (game HTML wrappers), so running these
// replaces after inlining would split a script element in half and leak
// the rest of the document as raw text. The EMBED_STORE body is filled in
// later (step 5) via the placeholder, since it depends on embedMap.
const LS_SHIM = `<script>
(function(){ window.__SAFE_LS__ = null;
  try { localStorage.setItem('__t','1'); localStorage.removeItem('__t'); window.__SAFE_LS__ = window.localStorage; }
  catch(e){ window.__SAFE_LS__ = {}; window.localStorage = window.__SAFE_LS__; }
})();
</script>`;
idx = idx.replace(/<\/head>/i, LS_SHIM + '\n</head>');
idx = idx.replace(/<\/body>/i, '<!--EMBED_STORE_PLACEHOLDER-->' + '\n</body>');

// ── 1. inline CSS ─────────────────────────────────────────────
idx = idx.replace(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/gi, (m, href) => {
  const fp = path.join(root, href.split('?')[0]);
  if (!fs.existsSync(fp)) return m;
  let css = fs.readFileSync(fp,'utf8');
  /* The stylesheet lives at /src/styles.css where ../bg-chalk.webp is the
     repo root - correct for the multi-file origin. Once inlined into the
     single-file page, "../" breaks on subpath deployments (jsDelivr / GitHub
     Pages), so make the background page-relative: the page and bg-chalk.webp
     always sit side by side. */
  css = css.replace(/url\("\.\.\/bg-chalk\.webp"\)/g, 'url("bg-chalk.webp")');
  return `<style>${css}</style>`;
});

// ── 2. inline JS ──────────────────────────────────────────────
const SCRIPTS = ['src/theme.js','src/runtime-config.js','src/sync.js','src/games.js','src/games2.js','src/community-games.js','src/real-shots.js','src/cloudgames.js','src/webports.js','src/sites.js',
  'src/proxies.js','src/apps.js','src/music.js','src/launcher.js','src/cloud.js','src/editor.js','src/urlauditor.js',
  'src/pixel.js','src/domainhub.js','src/ai.js','src/partners.js','src/docs.js','src/bookmarklets.js','src/livetv.js','src/youtube.js','src/intro.js','src/app.js'];
const bodies = SCRIPTS.map((file) => {
  const fp = path.join(root, file);
  if (!fs.existsSync(fp)) { console.warn('skip missing', file); return ''; }
  let code = fs.readFileSync(fp,'utf8');
  code = code.replace(/<\/script>/gi, '<\\/script>').replace(/<!--/g, '<\\!--');
  return code;
});
const NONENTITY = '\nconst SKIP = true;\n';
idx = idx.replace(/<script[^>]*src="([^"]+)"[^>]*>\s*<\/script>/gi, (m, src) => {
  const name = src.split('?')[0];
  const i = SCRIPTS.indexOf(name);
  if (i === -1) return m;
  return `<script data-inline="${name}">${bodies[i]}</script>`;
});

// ── 3. rewrite local assets → data URIs (robust) ─────────
const EXTS = 'jpg|jpeg|png|webp|gif|svg|ico|woff2?|ttf|mp3|ogg';
/* Replace bare local asset path tokens with data URIs. We deliberately leave
   quotes untouched: base64 URIs contain no quotes, so surrounding strings
   (including escaped \" inside url(\"...\") CSS embedded in JS) stay valid. */
const REWRITE_RE = new RegExp(
  `(\/(?:assets\/[^"'\`(){}\]{1,240}\.(?:${EXTS})|favicon\.svg|bg-chalk\.webp|arctic-thumb\.png|favicon\.ico))`,
  'g'
);
const cache = {};
function rewriteAssets(text) {
  if (CDN_SAFE) return text;
  return text.replace(REWRITE_RE, (m, rel) => {
    if (cache[rel]) return cache[rel];
    const fp = path.join(root, rel.replace(/^\//,''));
    const uri = dataURI(fp);
    if (uri) { cache[rel] = uri; return uri; }
    return m;
  });
}
idx = rewriteAssets(idx);

// for the inlined <script> bodies we already replaced global doc refs above
// (they're part of idx now). No second pass needed.

// ── 4. embed self-contained local html games ──────────────────
// Scan the inlined games.js body for single-file local games - /ugs/,
// /gn/, /mc/ HTML stashes and /game-builds/**/index.html - and embed the
// ones that reference no local sibling assets and are small enough to
// inline. Everything else keeps its origin path (served by the multi-file
// site's Python relay / Cloudflare folder; huge MC builds and multi-file
// game-builds can't be embedded into one HTML document anyway).
let gjsCode = (bodies[SCRIPTS.indexOf('src/games.js')] || '') + '\n' + (bodies[SCRIPTS.indexOf('src/webports.js')] || '');
const EMBED_MAX = 512 * 1024; // per-game size cap (bytes) - keeps the file usable
const gameUrlRe = /["'`](\/(?:ugs|gn|mc)\/[^"'`]+\.(?:html|htm)|\/assets\/(?:gba|psx)\/index\.html[^"'`]*|game-builds\/[^"'`]+\.(?:html|htm))["'`]/g;
const gameUrls = [];
let gm;
while ((gm = gameUrlRe.exec(gjsCode))) gameUrls.push(gm[1]);
const embedMap = {};
const isSelfContained = (rel) => {
  const fp = path.join(root, rel.replace(/^\//,''));
  if (!fs.existsSync(fp)) return false;
  try { if (fs.statSync(fp).size > EMBED_MAX) return false; } catch (e) { return false; }
  const html = fs.readFileSync(fp,'utf8');
  const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(x=>x[1])
    .filter(r => !/^(https?:|data:|blob:|#|javascript:|mailto:|tel:|<)/i.test(r)
      && !r.startsWith('//') && r!=='' && !/^\//.test(r) && !r.startsWith('window.')
      && !r.includes('://'));
  /* Also reject pages whose inline JS pulls sibling-folder assets (e.g.
     "wuhu-build/Build/WuhuWeb.loader.js"). As a data URI the relative path
     cannot resolve, so the game would silently fall back to a remote host.
     Leaving it path-based lets static mirrors (jsDelivr / Pages) serve the
     committed folder next to the page, which works fully offline-free. */
  const siblingRef = /["'`]([A-Za-z0-9_\-]+\/)[^"'`]{0,160}\.(?:js|wasm|data|json|png|jpe?g|webp|css|unityweb|htm|html)/i.test(html);
  return refs.length === 0 && !siblingRef;
};
if (!CDN_SAFE) {
  /* GBA player: the ROMs live next to it in assets/games/gba. Inject them
     as data URIs under window.__GBA_ROMS__ so the embedded player works
     with zero server paths (multi-file site still uses the plain paths). */
  const ejsOfflineInject = () => {
    /* Every file the EmulatorJS loader / core can fetch, as data URIs, so
       the embedded players work with zero network access to CDNs. */
    const paths = {};   // loader.js loadScript/loadStyle keys
    const filePaths = {}; // downloadFile basename keys (cores, reports...)
    const uriOf = (rel, mime) => {
      const fp = path.join(root, rel);
      if (!fs.existsSync(fp)) return null;
      return `data:${mime};base64,` + fs.readFileSync(fp).toString('base64');
    };
    for (const rel of [
      'assets/emulatorjs/emulator.min.js',
      'assets/emulatorjs/emulator.min.css',
      'assets/emulatorjs/src/emulator.js',
      'assets/emulatorjs/src/nipplejs.js',
      'assets/emulatorjs/src/shaders.js',
      'assets/emulatorjs/src/storage.js',
      'assets/emulatorjs/src/gamepad.js',
      'assets/emulatorjs/src/GameManager.js',
      'assets/emulatorjs/src/socket.io.min.js',
      'assets/emulatorjs/src/compression.js'
    ]) {
      const key = rel.replace(/^assets\/emulatorjs\//, '');
      const u = uriOf(rel, rel.endsWith('.css') ? 'text/css' : 'text/javascript');
      if (u) paths[key] = u;
    }
    for (const [rel, mime] of [
      ['assets/emulatorjs/cores/mgba-wasm.data', 'application/octet-stream'],
      ['assets/emulatorjs/cores/mgba-legacy-wasm.data', 'application/octet-stream'],
      ['assets/emulatorjs/cores/pcsx_rearmed-wasm.data', 'application/octet-stream'],
      ['assets/emulatorjs/cores/pcsx_rearmed-legacy-wasm.data', 'application/octet-stream'],
      ['assets/emulatorjs/cores/reports/mgba.json', 'application/json'],
      ['assets/emulatorjs/cores/reports/pcsx_rearmed.json', 'application/json'],
      ['assets/emulatorjs/compression/extract7z.js', 'text/javascript'],
      ['assets/emulatorjs/version.json', 'application/json']
    ]) {
      const u = uriOf(rel, mime);
      if (u) filePaths[path.basename(rel)] = u;
    }
    const loader = fs.readFileSync(path.join(root, 'assets', 'emulatorjs', 'loader.js'), 'utf8');
    return '<script>window.__EJS_OFFLINE__=' + JSON.stringify({ paths, filePaths }) + ';</script>' +
      '<script>window.__EJS_LOADER__=function(){"use strict";' + loader + '};</script>';
  };
  const gbaPlayerURI = () => {
    const fp = path.join(root, 'assets', 'gba', 'index.html');
    let html = fs.readFileSync(fp, 'utf8');
    const roms = {};
    try {
      const romDir = path.join(root, 'assets', 'games', 'gba');
      for (const f of fs.readdirSync(romDir)) {
        if (!/\.gba$/i.test(f)) continue;
        const uri = dataURI(path.join(romDir, f));
        if (uri) roms['/assets/games/gba/' + f] = uri;
      }
    } catch (e) { /* no ROM folder - fall back to path-based */ }
    const inj = '<script>window.__GBA_ROMS__=' + JSON.stringify(roms) + ';</script>\n' + ejsOfflineInject();
    return html.replace(/<\/head>/i, inj + '\n</head>');
  };
  const psxPlayerURI = () => {
    const fp = path.join(root, 'assets', 'psx', 'index.html');
    const html = fs.readFileSync(fp, 'utf8');
    const injected = html.replace(/<\/head>/i, ejsOfflineInject() + '\n</head>');
    return 'data:text/html;base64,' + Buffer.from(injected, 'utf8').toString('base64');
  };
  /* JS Movies: the whole tab app is one self-contained page. Embed it under
     its origin path so the single-file build's iframe and "open full screen"
     both resolve to the embedded copy (no network, no 404 on static hosts). */
  const moviesPath = path.join(root, 'movies.html');
  if (fs.existsSync(moviesPath) && fs.statSync(moviesPath).size < 2 * 1024 * 1024) {
    embedMap['/movies.html'] = dataURI(moviesPath);
  }
  /* Lunchbreak chat: fully client-side (Firebase), so the whole page embeds
     like movies.html and chat works from the single file / any static host
     with zero backend. */
  const chatPath = path.join(root, 'chat.html');
  if (fs.existsSync(chatPath) && fs.statSync(chatPath).size < 2 * 1024 * 1024) {
    embedMap['/chat.html'] = dataURI(chatPath);
  }
  /* Redirector shell: apps/tools bounce through /go.html#<base64>. Embed it
     so the single-file build's shell resolution works on static hosts. */
  const goPath = path.join(root, 'go.html');
  if (fs.existsSync(goPath)) {
    embedMap['/go.html'] = dataURI(goPath);
  }
  for (const rel of [...new Set(gameUrls)]) {
    const fileRel = rel.split(/[?#]/)[0];
    if (isSelfContained(fileRel)) {
      /* The GBA player HTML (with every ROM injected) is identical across
         all ?rom= URLs. Embed it ONCE under the bare path; the launcher
         resolves /assets/gba/index.html?rom=X to this URI plus #X. */
      let mapKey = rel;
      let uri;
      if (fileRel === '/assets/gba/index.html') {
        mapKey = '/assets/gba/index.html';
        uri = gbaPlayerURI();
      } else if (fileRel === '/assets/psx/index.html') {
        uri = psxPlayerURI();
      } else {
        uri = dataURI(path.join(root, fileRel.replace(/^\//,'')));
      }
      if (uri) embedMap[mapKey] = uri;
    }
  }
}
/* Movies, Lunchbreak chat and the go.html redirector are small, fully
   client-side pages. They are embedded in BOTH builds (CDN-safe included):
   those tabs must never depend on lootline reachability, and on a blocked
   network the api-root fallback is a lootline host anyway, which the app
   strips. chat.html is ~370KB and movies.html ~180KB; worth every byte. */
for (const [p, key] of [
  [path.join(root, 'movies.html'), '/movies.html'],
  [path.join(root, 'chat.html'), '/chat.html'],
  [path.join(root, 'go.html'), '/go.html'],
  [path.join(root, 'browser.html'), '/browser.html'],
]) {
  if (fs.existsSync(p) && !embedMap[key]) {
    const uri = dataURI(p);
    if (uri) embedMap[key] = uri;
  }
}
console.log(`${CDN_SAFE ? 'CDN-safe build; external game/assets paths stay relative' : 'embedded self-contained html games'}: ${Object.keys(embedMap).length}`);

// ── 5. EMBED_STORE: fill the placeholder with the real body ──
const embeddedRandomPath = path.join(root, 'research', 'embedded', 'random-gaming-websites-embedded.txt');
const embeddedRandom = !CDN_SAFE && fs.existsSync(embeddedRandomPath) ? fs.readFileSync(embeddedRandomPath, 'utf8') : '';
const embeddedRandomB64 = Buffer.from(embeddedRandom, 'utf8').toString('base64');

const embeddedArcticPath = path.join(root, 'research', 'embedded', 'arctic-1m-links-embedded.txt');
const embeddedArctic = !CDN_SAFE && fs.existsSync(embeddedArcticPath) ? fs.readFileSync(embeddedArcticPath, 'utf8') : '';
const embeddedArcticB64 = Buffer.from(embeddedArctic, 'utf8').toString('base64');

const EMBED_STORE = `<script>
window.__SINGLE_GAMES__ = ${JSON.stringify(embedMap)};
window.__CHALKLE_RANDOM_GAMING_EMBEDDED__ = ${JSON.stringify(embeddedRandomB64)};
window.__CHALKLE_ARCTIC_EMBEDDED__ = ${JSON.stringify(embeddedArcticB64)};
(function(){
  var map = window.__SINGLE_GAMES__||{};
  function resolve(u){ var s=String(u); if(map[s]) return map[s]; return null; }
  var _fetch = window.fetch;
  /* Root-absolute local paths (/ugs/x.html) must resolve against the page's
     base, not the origin root: static mirrors are served from a subpath
     (jsDelivr /gh/user/repo@ref/), where /ugs/... 404s. Non-http contexts
     (file://, opaque data URIs) can't resolve - keep the raw path. */
  function baseAbs(u){
    try {
      var s = String(u);
      if (s.charAt(0) === '/' && s.charAt(1) !== '/') {
        var b = document.baseURI || location.href;
        if (/^https?:/i.test(b)) return new URL(s, b).href;
      }
    } catch (e) {}
    return u;
  }
  if (window.fetch) {
    window.fetch = function(u, o) {
      var uri = resolve(u);
      if (uri) return Promise.resolve(new Response(new Blob([atob(uri.split(',')[1]||'')], {type:'text/html'})));
      return _fetch(baseAbs(u), o);
    };
  }
  var _OXHR = window.XMLHttpRequest;
  if (_OXHR) {
    var _open = _OXHR.prototype.open;
    _OXHR.prototype.open = function(m, u){ this.__map = resolve(u); this.__abs = baseAbs(u); return _open.call(this, m, this.__abs || u); };
    var _send = _OXHR.prototype.send;
    _OXHR.prototype.send = function(_b){
      if (this.__map) {
        this.readyState = 4; this.status = 200;
        this.responseText = atob(this.__map.split(',')[1]||''); this.response = this.responseText;
        this.responseType = this.responseType||'text';
        var th = this, ct = 0;
        // simulate readystatechange progression
        try { th.readyState=2; var ev=function(){ th.readyState=4; if(typeof th.onreadystatechange==='function') th.onreadystatechange(); if(typeof th.onload==='function') th.onload(); }; setTimeout(ev,0);}catch(e){}
        return;
      }
      return _send.apply(this, arguments);
    };
  }
})();
</script>`;
idx = idx.replace('<!--EMBED_STORE_PLACEHOLDER-->', EMBED_STORE);

// ── 6. write ──────────────────────────────────────────────────
fs.mkdirSync(path.dirname(out), {recursive:true});
/* Write only the build this mode produces: a --cdn run must never clobber
   the local build (which embeds ~30MB of self-contained games) with the
   6.8MB CDN-safe variant, and vice versa. */
const written = CDN_SAFE ? cdnOut : out;
fs.writeFileSync(written, idx);
const mb = (fs.statSync(written).size/1048576).toFixed(1);
console.log(`wrote ${written} (${mb} MB)`);
