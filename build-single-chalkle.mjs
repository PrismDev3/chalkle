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
const out = path.join(root, 'chalkle-single.html');
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
  return fs.existsSync(fp) ? `<style>${fs.readFileSync(fp,'utf8')}</style>` : m;
});

// ── 2. inline JS ──────────────────────────────────────────────
const SCRIPTS = ['theme.js','runtime-config.js','sync.js','games.js','cloudgames.js','webports.js','sites.js',
  'proxies.js','apps.js','music.js','launcher.js','cloud.js','blanktab.js','editor.js','urlauditor.js',
  'pixel.js','domainhub.js','ai.js','docs.js','partners.js','intro.js','app.js'];
const bodies = SCRIPTS.map((file) => {
  const fp = path.join(root, file);
  if (!fs.existsSync(fp)) { console.warn('skip missing', file); return ''; }
  let code = fs.readFileSync(fp,'utf8');
  code = code.replace(/<\/script>/gi, '<\\/script>').replace(/<!--/g, '<\\!--');
  return code;
});
const NONENTITY = '\nconst SKIP = true;\n';
idx = idx.replace(/<script[^>]*src="([^"]+)"[^>]*>\s*<\/script>/gi, (m, src) => {
  const name = src.split('?')[0].replace(/^.*\//,'');
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
// Scan the inlined games.js body for /game-builds/**/index.html (or .html)
// that reference no local sibling assets. Parse via a copy of the script.
let gjsCode = bodies[SCRIPTS.indexOf('games.js')];
const gameUrlRe = /["'`](\/game-builds\/[^"'`]+\.(?:html|htm))["'`]/g;
const gameUrls = [];
let gm;
while ((gm = gameUrlRe.exec(gjsCode))) gameUrls.push(gm[1]);
const embedMap = {};
const isSelfContained = (rel) => {
  const fp = path.join(root, rel.replace(/^\//,''));
  if (!fs.existsSync(fp)) return false;
  const html = fs.readFileSync(fp,'utf8');
  const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(x=>x[1])
    .filter(r => !/^(https?:|data:|blob:|#|javascript:|mailto:|tel:|<)/i.test(r)
      && !r.startsWith('//') && r!=='' && !/^\//.test(r) && !r.startsWith('window.')
      && !r.includes('://'));
  return refs.length === 0;
};
if (!CDN_SAFE) {
  for (const rel of [...new Set(gameUrls)]) {
    if (isSelfContained(rel)) {
      const uri = dataURI(path.join(root, rel.replace(/^\//,'')));
      if (uri) embedMap[rel] = uri;
    }
  }
}
console.log(`${CDN_SAFE ? 'CDN-safe build; external game/assets paths stay relative' : 'embedded self-contained html games'}: ${Object.keys(embedMap).length}`);

// ── 5. EMBED_STORE: fill the placeholder with the real body ──
const embeddedRandomPath = path.join(root, 'random-gaming-websites-embedded.txt');
const embeddedRandom = !CDN_SAFE && fs.existsSync(embeddedRandomPath) ? fs.readFileSync(embeddedRandomPath, 'utf8') : '';
const embeddedRandomB64 = Buffer.from(embeddedRandom, 'utf8').toString('base64');

const EMBED_STORE = `<script>
window.__SINGLE_GAMES__ = ${JSON.stringify(embedMap)};
window.__CHALKLE_RANDOM_GAMING_EMBEDDED__ = ${JSON.stringify(embeddedRandomB64)};
(function(){
  var map = window.__SINGLE_GAMES__||{};
  function resolve(u){ var s=String(u); if(map[s]) return map[s]; return null; }
  var _fetch = window.fetch;
  if (window.fetch) {
    window.fetch = function(u, o) {
      var uri = resolve(u);
      if (uri) return Promise.resolve(new Response(new Blob([atob(uri.split(',')[1]||'')], {type:'text/html'})));
      return _fetch(u, o);
    };
  }
  var _OXHR = window.XMLHttpRequest;
  if (_OXHR) {
    var _open = _OXHR.prototype.open;
    _OXHR.prototype.open = function(m, u){ this.__map = resolve(u); return _open.apply(this, arguments); };
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
fs.writeFileSync(out, idx);
const mb = (fs.statSync(out).size/1048576).toFixed(1);
console.log(`wrote ${out} (${mb} MB)`);
