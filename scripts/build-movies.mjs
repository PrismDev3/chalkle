/**
 * build-movies.mjs
 * Builds the self-contained JS Movies tab page (movies.html) from the MILKBOX
 * source app (index.html + styles.css + app.js):
 *
 *   1. Retheme to Chalkle: dark base, red/pink identity, indigo "JS Movies"
 *      brand accent, Chalkle fonts (Boogaloo + Space Grotesk).
 *   2. Rebrand MILKBOX / LUCKYFLIX -> "JS Movies".
 *   3. Inline CSS + JS so the page is fully self-contained (single file that
 *      works on the multi-file site, jsDelivr mirrors and the single-file
 *      build's data-URI embed).
 *   4. Make localStorage safe for opaque origins (single-file embed): all
 *      app.js references are rewritten to __MBLS__ with a shim that falls
 *      back to in-memory storage when the real one is unreachable.
 *   5. Escape </script> / <!-- inside the inlined JS so the HTML stays valid.
 *
 * Usage: node scripts/build-movies.mjs
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const SRC =
  process.env.MILKBOX_SRC ||
  "C:\\Users\\zeqrY\\Downloads\\MILKBOX-main\\MILKBOX-main";
const out = path.join(root, "movies.html");

const indexHtml = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
let css = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
let js = fs.readFileSync(path.join(SRC, "app.js"), "utf8");

/* ---------- 1. Retheme CSS to Chalkle ---------- */
css = css.replace(
  /--mb-bg:\s*#[0-9a-fA-F]{3,8};/,
  "--mb-bg: #0d0f12;"
);
css = css.replace(
  /--mb-bg-soft:\s*#[0-9a-fA-F]{3,8};/,
  "--mb-bg-soft: #15181d;"
);
css = css.replace(
  /--mb-surface:\s*#[0-9a-fA-F]{3,8};/,
  "--mb-surface: #15181d;"
);
css = css.replace(
  /--mb-surface-2:\s*#[0-9a-fA-F]{3,8};/,
  "--mb-surface-2: #1d2127;"
);
css = css.replace(
  /--mb-text:\s*#[0-9a-fA-F]{3,8};/,
  "--mb-text: #e8eaed;"
);
css = css.replace(
  /--mb-muted:\s*#[0-9a-fA-F]{3,8};/,
  "--mb-muted: #9aa0a6;"
);
css = css.replace(
  /--mb-dim:\s*#[0-9a-fA-F]{3,8};/,
  "--mb-dim: #7d838b;"
);
css = css.replace(
  /--mb-accent:\s*#[0-9a-fA-F]{3,8};/,
  "--mb-accent: #818cf8;"
);
css = css.replace(
  /--mb-accent-2:\s*#[0-9a-fA-F]{3,8};/,
  "--mb-accent-2: #ff4d8d;"
);
css = css.replace(
  /--mb-pink:\s*#[0-9a-fA-F]{3,8};/,
  "--mb-pink: #ff4d8d;"
);
css = css.replace(
  /--mb-green:\s*#[0-9a-fA-F]{3,8};/,
  "--mb-green: #34a853;"
);
css = css.replace(
  /--mb-grad:\s*[^;]+;/,
  "--mb-grad: linear-gradient(135deg, #818cf8 0%, #ff4d8d 100%);"
);
/* The cineby-style restyle block (MILKBOX's own flat gray skin) sets the
   body background with !important and would fight the Chalkle theme - retheme
   it to the same indigo-on-charcoal palette as the rest of the app. */
css = css.replace(/--cb-bg:\s*#171717;/, "--cb-bg: #0d0f12;");
css = css.replace(/--cb-bg-soft:\s*#1c1c1c;/, "--cb-bg-soft: #15181d;");
css = css.replace(/--cb-surface:\s*#1f1f1f;/, "--cb-surface: #15181d;");
css = css.replace(/--cb-surface-2:\s*#262626;/, "--cb-surface-2: #1d2127;");
css = css.replace(/--cb-text:\s*#fff;/, "--cb-text: #e8eaed;");
css = css.replace(/--cb-body:\s*#ccc;/, "--cb-body: #e8eaed;");
css = css.replace(/--cb-muted:\s*#999;/, "--cb-muted: #9aa0a6;");
css = css.replace(/--cb-pink:\s*#ffb6d8;/, "--cb-pink: #c7d2fe;");
css = css.replace(/--cb-pink-strong:\s*#ff6b9d;/, "--cb-pink-strong: #818cf8;");
css = css.replace(
  /--cb-grad:\s*linear-gradient\(135deg, #[0-9a-fA-F]{6} 0%, #[0-9a-fA-F]{6} 100%\);/,
  "--cb-grad: linear-gradient(135deg, #818cf8 0%, #a5b4fc 100%);"
);
css = css.replace(
  /--mb-shadow:\s*[^;]+;/,
  "--mb-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);"
);
css = css.replace(
  /--mb-glass:\s*[^;]+;/,
  "--mb-glass: rgba(21, 24, 29, 0.72);"
);
/* body gradient -> indigo-tinted Chalkle wash */
css = css.replace(
  /radial-gradient\(1200px 600px at 80% -10%, rgba\(255, 46, 99, 0\.08\), transparent 60%\),/,
  "radial-gradient(1200px 600px at 80% -10%, rgba(129, 140, 248, 0.10), transparent 60%),"
);
css = css.replace(
  /radial-gradient\(900px 500px at 10% 10%, rgba\(120, 80, 255, 0\.06\), transparent 55%\),/,
  "radial-gradient(900px 500px at 10% 10%, rgba(255, 77, 141, 0.07), transparent 55%),"
);
css = css.replace(
  /linear-gradient\(180deg, #0b0b0f 0%, #0e0e14 100%\)/,
  "linear-gradient(180deg, #0d0f12 0%, #101318 100%)"
);
/* Fonts -> Chalkle stack */
css = css.replace(
  /font-family: 'Inter', sans-serif;/g,
  "font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;"
);
css = css.replace(/'Outfit'/g, "'Space Grotesk', system-ui, 'Segoe UI', Roboto, Arial, sans-serif");
css = css.replace(/'Bebas Neue'/g, "'Boogaloo', system-ui, 'Segoe UI', Roboto, Arial, sans-serif");
css = css.replace(/'DynaPuff'/g, "'Boogaloo', system-ui, 'Segoe UI', Roboto, Arial, sans-serif");
css = css.replace(/'Reggae One'/g, "'Boogaloo', system-ui, 'Segoe UI', Roboto, Arial, sans-serif");

/* ---------- 2. Rebrand app.js ---------- */
/* Drop the hosted third-party library fetch: rely on TMDB auto-load. */
js = js.replace(
  /const HOSTED_LIBRARY_URL = '[^']*';/,
  "const HOSTED_LIBRARY_URL = '';"
);
/* Branding strings -> JS Movies */
js = js.replace(/'MILKBOX'/g, "'JS Movies'");
js = js.replace(/"MILKBOX"/g, '"JS Movies"');
js = js.replace(/`MILKBOX`/g, "`JS Movies`");
js = js.replace(/'LUCKYFLIX'/g, "'JS Movies'");
js = js.replace(/Welcome to MILKBOX/g, "Welcome to JS Movies");

/* Default background -> Chalkle charcoal everywhere it appears (settings
   default, theme presets, color inputs, reset button). */
js = js.replace(/'#141414'/g, "'#0d0f12'");
js = js.replace(/"#141414"/g, '"#0d0f12"');
js = js.replace(/value="#141414"/g, 'value="#0d0f12"');
js = js.replace(/placeholder="#141414"/g, 'placeholder="#0d0f12"');

/* TMDB: route through the site's same-origin /api/tmdb proxy first (TMDB
   never grants the Bearer-header preflight, so direct calls are blocked in
   the browser); fall back to direct calls for static mirrors with no relay. */
js = js.replace(
  /const res = await fetch\(url, \{\s*headers: \{\s*'accept': 'application\/json',\s*'Authorization': effectiveTmdbAuth\(\)\s*\}\s*\}\);/,
  `let res = null;
    try {
        const proxyUrl = '/api/tmdb/' + String(path).replace(/^\\//, '');
        res = await fetch(proxyUrl, { headers: { 'accept': 'application/json' }, cache: 'no-store' });
        if (!res.ok) res = null;
    } catch (e) { res = null; }
    if (!res) res = await fetch(url, {
        headers: {
            'accept': 'application/json',
            'Authorization': effectiveTmdbAuth()
        }
    });`
);

/* ---------- 3. localStorage -> __MBLS__ (opaque-origin safe) ---------- */
const LS_SHIM = `(function(){
  var __mem = {};
  var __shim = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(__mem, k) ? __mem[k] : null; },
    setItem: function (k, v) { __mem[k] = String(v); },
    removeItem: function (k) { delete __mem[k]; },
    clear: function () { __mem = {}; },
    key: function (i) { return Object.keys(__mem)[i] || null; },
    get length() { return Object.keys(__mem).length; }
  };
  var __real = null;
  try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); __real = localStorage; } catch (e) {}
  try { Object.defineProperty(window, '__MBLS__', { value: __real || __shim, configurable: true, writable: true }); }
  catch (e) { window.__MBLS__ = __real || __shim; }
})();
`;
/* Replace the identifier (never inside strings: verified no quoted usages). */
js = js.replace(/\blocalStorage\b/g, "__MBLS__");

/* ---------- 4. Assemble HTML ---------- */
let html = indexHtml;
html = html.replace(
  /<title id="siteTitle">[^<]*<\/title>/,
  '<title id="siteTitle">JS Movies</title>'
);
html = html.replace(
  /<link rel="icon"[^>]*>/,
  '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'64\' height=\'64\' viewBox=\'0 0 64 64\'%3E%3Crect width=\'64\' height=\'64\' rx=\'12\' fill=\'%236a5cff\'/%3E%3Crect x=\'8\' y=\'18\' width=\'48\' height=\'30\' rx=\'4\' fill=\'none\' stroke=\'white\' stroke-width=\'3\'/%3E%3Cpath d=\'M8 26 L56 26 L48 18 L8 18 Z\' fill=\'white\'/%3E%3Cpath d=\'M26 30 L42 33 L26 38 Z\' fill=\'white\'/%3E%3C/svg%3E">'
);
/* Fonts -> Chalkle's */
html = html.replace(
  /<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Outfit[^"]*"[^>]*>/,
  '<link href="https://fonts.googleapis.com/css2?family=Boogaloo&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">'
);
html = html.replace(
  /<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Bebas\+Neue[^"]*"[^>]*>/,
  ""
);
html = html.replace(
  /<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Material\+Symbols\+Outlined[^"]*"[^>]*>/,
  ""
);
/* Logo -> inline clapperboard + JS Movies */
html = html.replace(
  /<img src="https:\/\/raw\.githubusercontent\.com\/IordBeerus\/MILKBOX\/main\/SiteIcon\.png"[^>]*>/,
  '<img src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'64\' height=\'64\' viewBox=\'0 0 64 64\'%3E%3Crect width=\'64\' height=\'64\' rx=\'12\' fill=\'%236a5cff\'/%3E%3Crect x=\'8\' y=\'18\' width=\'48\' height=\'30\' rx=\'4\' fill=\'none\' stroke=\'white\' stroke-width=\'3\'/%3E%3Cpath d=\'M8 26 L56 26 L48 18 L8 18 Z\' fill=\'white\'/%3E%3Cpath d=\'M26 30 L42 33 L26 38 Z\' fill=\'white\'/%3E%3C/svg%3E" alt="JS Movies" class="logo-image" style="height:32px;width:32px;border-radius:6px;object-fit:cover;margin-right:8px;">'
);
html = html.replace(
  /<h1 class="logo" id="siteLogo">[^<]*<\/h1>/,
  '<h1 class="logo" id="siteLogo">JS Movies</h1>'
);
html = html.replace(
  /<h2 class="hero-title" id="heroTitle">[^<]*<\/h2>/,
  '<h2 class="hero-title" id="heroTitle">Welcome to JS Movies</h2>'
);
html = html.replace(
  /<p class="hero-desc" id="heroDesc">[^<]*<\/p>/,
  '<p class="hero-desc" id="heroDesc">Movies, TV shows, anime and manga in one place. Search a title or pick something to watch.</p>'
);
html = html.replace(
  /<p id="footerTitle">[^<]*<\/p>/,
  '<p id="footerTitle">JS Movies - Your Streaming Tab</p>'
);
html = html.replace(
  /&copy; 2024 <span class="footer-brand">[^<]*<\/span>/,
  "&copy; 2024 <span class=\"footer-brand\">JS Movies</span>"
);
html = html.replace(/placeholder="MILKBOX"/g, 'placeholder="JS Movies"');

/* Inline styles.css */
html = html.replace(
  /<link rel="stylesheet" href="styles\.css">/,
  "<style>\n" + css + "\n</style>"
);

/* Inline app.js with the localStorage shim + escaping */
const escapedJs = js.replace(/<\/script>/gi, "<\\/script>").replace(/<!--/g, "<\\!--");
html = html.replace(
  /<script src="app\.js\?v=[^"]*"><\/script>/,
  "<script>\n" + LS_SHIM + "\n" + escapedJs + "\n</script>"
);

fs.writeFileSync(out, html, "utf8");
const mb = (fs.statSync(out).size / 1048576).toFixed(2);
console.log(`wrote ${out} (${mb} MB)`);
console.log("localStorage refs rewritten:", (js.match(/__MBLS__/g) || []).length);
console.log("branding refs:", (html.match(/JS Movies/g) || []).length);