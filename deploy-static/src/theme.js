/* Chalkle theme engine. Pick your own background + accent colors, wallpaper
   (gradient presets or a custom image URL) and cursor, all saved on this
   device and applied live. Mirrors the default dark Chalkle look until you
   change something, so first-run users see no difference. */

(function () {
  "use strict";

  var CUSTOM_KEY = "chalkle-custom-theme";
  var WALLPAPER_KEY = "chalkle-wallpaper";
  var CURSOR_KEY = "chalkle-cursor";
  var PRESET_KEY = "chalkle-theme-preset";
  var RESET_FLAG = "chalkle-theme-reset-v1";

  /* One-time auto-reset: older builds could leave behind a weird saved theme
     (a light "white + pink" palette, candy wallpaper, etc.) that users never
     deliberately picked, and it came back on every load. On the first boot
     after this ships, clear any stored custom theme / preset / wallpaper so
     everyone lands on the default dark Chalkle look again. Runs exactly once
     per device: after that, theme choices ARE respected and persist. */
  function autoResetOnce() {
    try {
      if (localStorage.getItem(RESET_FLAG)) return;
      localStorage.removeItem(CUSTOM_KEY);
      localStorage.removeItem(PRESET_KEY);
      localStorage.removeItem(WALLPAPER_KEY);
      localStorage.setItem(RESET_FLAG, "1");
      /* Tell sync.js (which loads later) that THIS session cleared the old
         synced theme, so its /_sync restore drops any stale palette the
         server still has instead of putting it back. */
      window.__chalkleThemeAutoReset = true;
    } catch (e) { /* private mode: nothing to do */ }
  }

  /* url() inside a CSS custom property resolves against the stylesheet that
     USES the var (src/styles.css), not the document - so a relative path like
     "assets/cursors/cursor-cat.png" silently becomes /src/assets/... and 404s.
     Resolve every asset to an absolute document-relative URL up front; that
     keeps cursors and wallpapers working on the real site, CDN subpaths and
     file:// copies alike. */
  function absAsset(path) {
    try {
      return new URL(path, document.baseURI).href;
    } catch (e) {
      return path;
    }
  }

  var CURSORS = {
    cat: { label: "cat", css: "url('assets/cursors/cursor-cat.png') 24 24, auto", preview: "assets/cursors/cursor-cat.png", hover: "assets/cursors/cursor-cat-hover.png" },
    "cat-black": { label: "black cat", css: "url('assets/cursors/cursor-cat-black.png') 24 24, auto", preview: "assets/cursors/cursor-cat-black.png", hover: "assets/cursors/cursor-cat-black-hover.png" },
    puppy: { label: "puppy", css: "url('assets/cursors/cursor-puppy.png') 24 24, auto", preview: "assets/cursors/cursor-puppy.png", hover: "assets/cursors/cursor-puppy-hover.png" },
    kyro: { label: "kyro", css: "url('assets/cursors/cursor-kyro.png') 18 18, auto", preview: "assets/cursors/cursor-kyro.png", hover: "assets/cursors/cursor-kyro-hover.png" },
    neoos: { label: "neo os", css: "url('assets/cursors/cursor-neoos.png') 18 18, auto", preview: "assets/cursors/cursor-neoos.png", hover: "assets/cursors/cursor-neoos-hover.png" },
    godlylinks: { label: "godly links", css: "url('assets/cursors/cursor-godlylinks.png') 18 17, auto", preview: "assets/cursors/cursor-godlylinks.png", hover: "assets/cursors/cursor-godlylinks-hover.png" },
    projectbugs: { label: "project bugs", css: "url('assets/cursors/cursor-projectbugs.png') 18 18, auto", preview: "assets/cursors/cursor-projectbugs.png", hover: "assets/cursors/cursor-projectbugs-hover.png" },
    frosted: { label: "frosted", css: "url('assets/cursors/cursor-frosted.png') 18 18, auto", preview: "assets/cursors/cursor-frosted.png", hover: "assets/cursors/cursor-frosted-hover.png" },
    p2pgames: { label: "p2p games", css: "url('assets/cursors/cursor-p2pgames.png') 18 17, auto", preview: "assets/cursors/cursor-p2pgames.png", hover: "assets/cursors/cursor-p2pgames-hover.png" },
    sv: { label: "s.v", css: "url('assets/cursors/cursor-sv.png') 18 18, auto", preview: "assets/cursors/cursor-sv.png", hover: "assets/cursors/cursor-sv-hover.png" },
    anko: { label: "anko", css: "url('assets/cursors/cursor-anko.png') 18 18, auto", preview: "assets/cursors/cursor-anko.png", hover: "assets/cursors/cursor-anko-hover.png" },
    ghostproxy: { label: "ghost proxy", css: "url('assets/cursors/cursor-ghostproxy.png') 18 18, auto", preview: "assets/cursors/cursor-ghostproxy.png", hover: "assets/cursors/cursor-ghostproxy-hover.png" },
    array: { label: "array", css: "url('assets/cursors/cursor-array.png') 18 18, auto", preview: "assets/cursors/cursor-array.png", hover: "assets/cursors/cursor-array-hover.png" },
    sizzle: { label: "sizzle studios", css: "url('assets/cursors/cursor-sizzle.png') 18 18, auto", preview: "assets/cursors/cursor-sizzle.png", hover: "assets/cursors/cursor-sizzle-hover.png" },
    "korona.lat": { label: "korona.lat", css: "url('assets/cursors/cursor-korona.lat.png') 18 18, auto", preview: "assets/cursors/cursor-korona.lat.png", hover: "assets/cursors/cursor-korona.lat-hover.png" },
    studify: { label: "studify", css: "url('assets/cursors/cursor-studify.png') 18 18, auto", preview: "assets/cursors/cursor-studify.png", hover: "assets/cursors/cursor-studify-hover.png" },
    none: { label: "default", css: "auto", preview: null }
  };
  Object.keys(CURSORS).forEach(function (id) {
    var c = CURSORS[id];
    if (!c || !c.css) return;
    var m = /^url\('([^']+)'\)(.*)$/.exec(c.css);
    if (m) c.css = "url('" + absAsset(m[1]) + "')" + m[2];
    if (c.preview) c.preview = absAsset(c.preview);
    if (c.hover) c.hover = absAsset(c.hover);
  });

  var WALLPAPERS = {
    /* Relative on purpose (subpath mirrors + file:// copies); absAsset makes
       them absolute so the url() survives custom-property resolution. */
    chalk: "url('bg-chalk.webp')",
    aurora: "#20343b",
    sunset: "#4a1d2d",
    citrus: "#5a4514",
    candy: "#4a2931",
    dusk: "#263b45",
    grape: "#302042",
    night: "#182437",
    forest: "#173525"
  };
  Object.keys(WALLPAPERS).forEach(function (id) {
    var v = WALLPAPERS[id];
    var m = typeof v === "string" ? /^url\('([^']+)'\)$/.exec(v) : null;
    if (m) WALLPAPERS[id] = "url('" + absAsset(m[1]) + "')";
  });

  /* One-click theme presets (bg + accent). Palettes from the Interstellar /
     catppuccin collections - each renders a two-tone preview swatch. */
  var PRESETS = {
    mocha:     { label: "Mocha",     bg: "#1e1e2e", accent: "#cba6f7" },
    macchiato: { label: "Macchiato", bg: "#24273a", accent: "#c6a0f6" },
    frappe:    { label: "Frappe",    bg: "#303446", accent: "#ca9ee6" },
    latte:     { label: "Latte",     bg: "#eff1f5", accent: "#8839ef" },
    sky:       { label: "Sky",       bg: "#173055", accent: "#38bdf8" },
    sakura:    { label: "Sakura",    bg: "#2a1b26", accent: "#ff9e9e" },
    forest:    { label: "Forest",    bg: "#0e1712", accent: "#7dbf59" },
    sunset:    { label: "Sunset",    bg: "#22111d", accent: "#ff6b6b" },
    amber:     { label: "Cyber Gold", bg: "#0d0c0a", accent: "#ff8c00" },
    midnight:  { label: "Midnight",  bg: "#0a1118", accent: "#5b93ff" },
    graphite:  { label: "Graphite",  bg: "#131315", accent: "#c9cdd4" }
  };

  /* Chalkle CSS vars that the palette can drive. Category colors (--blue,
     --yellow, ...) stay fixed so badges keep their meaning. */
  var VARS = [
    "base", "panel", "panel-2", "line", "line-soft", "topbar-bg",
    "text", "text-2", "text-3",
    "accent", "accent-ink", "accent-soft"
  ];

  function topbarFrom(hex) {
    var c = hexToRgb(hex);
    return "rgba(" + c.r + ", " + c.g + ", " + c.b + ", 0.94)";
  }

  function hexToRgb(hex) {
    hex = String(hex || "").replace("#", "");
    if (hex.length === 3) hex = hex.split("").map(function (c) { return c + c; }).join("");
    if (hex.length !== 6) return { r: 13, g: 15, b: 18 };
    var n = parseInt(hex, 16);
    if (isNaN(n)) return { r: 13, g: 15, b: 18 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map(function (v) {
      return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    }).join("");
  }

  function luminance(hex) {
    var c = hexToRgb(hex);
    return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
  }

  function mix(hexA, hexB, weight) {
    var a = hexToRgb(hexA), b = hexToRgb(hexB);
    return rgbToHex(
      a.r + (b.r - a.r) * weight,
      a.g + (b.g - a.g) * weight,
      a.b + (b.b - a.b) * weight
    );
  }

  function lighten(hex, pct) { return mix(hex, "#ffffff", pct / 100); }
  function darken(hex, pct) { return mix(hex, "#000000", pct / 100); }

  /* Build the full Chalkle palette from a chosen background + accent.
     Light backgrounds flip to a light theme automatically. */
  function buildPalette(bg, accent) {
    var isDark = luminance(bg) < 0.5;
    var a = hexToRgb(accent);
    var p = {};

    if (isDark) {
      p.base = bg;
      p.panel = lighten(bg, 7);
      p["panel-2"] = lighten(bg, 12);
      p.line = lighten(bg, 20);
      p["line-soft"] = lighten(bg, 14);
      p.text = "#e8eaed";
      p["text-2"] = lighten(bg, 55);
      p["text-3"] = lighten(bg, 35);
      p["topbar-bg"] = topbarFrom(bg);
    } else {
      p.base = bg;
      p.panel = darken(bg, 5);
      p["panel-2"] = darken(bg, 10);
      p.line = darken(bg, 22);
      p["line-soft"] = darken(bg, 12);
      p.text = "#0d0f12";
      p["text-2"] = darken(bg, 42);
      p["text-3"] = darken(bg, 30);
      p["topbar-bg"] = topbarFrom(bg);
    }

    var accentLum = luminance(accent);
    p.accent = accent;
    p["accent-ink"] = accentLum > 0.5 ? "#0a0c0e" : "#ffffff";
    p["accent-soft"] = "rgba(" + a.r + ", " + a.g + ", " + a.b + ", 0.14)";
    return p;
  }

  function applyPalette(p) {
    VARS.forEach(function (key) {
      if (p[key]) document.documentElement.style.setProperty("--" + key, p[key]);
    });
    document.documentElement.style.colorScheme = luminance(p.base) < 0.5 ? "dark" : "light";
  }

  function clearPalette() {
    VARS.forEach(function (key) {
      document.documentElement.style.removeProperty("--" + key);
    });
    document.documentElement.style.removeProperty("color-scheme");
  }

  function applyWallpaper(value) {
    if (!value || value === "none") {
      document.documentElement.style.removeProperty("--wallpaper-image");
      document.documentElement.style.removeProperty("--wallpaper-scrim");
      return;
    }
    var css;
    if (value.indexOf("custom:") === 0) {
      var url = value.slice(7);
      /* Only http(s)/data/blob URLs can render as a wallpaper on a web page.
         A file:// (or other exotic scheme) URL saved earlier throws a
         SecurityError in the console and leaves the background transparent,
         so it is rejected here. */
      if (!/^(https?:|data:|blob:)/i.test(url)) {
        document.documentElement.style.removeProperty("--wallpaper-image");
        document.documentElement.style.removeProperty("--wallpaper-scrim");
        return;
      }
      css = "url('" + url.replace(/'/g, "%27") + "')";
    } else if (WALLPAPERS[value]) {
      css = WALLPAPERS[value];
    } else {
      document.documentElement.style.removeProperty("--wallpaper-image");
      document.documentElement.style.removeProperty("--wallpaper-scrim");
      return;
    }
    document.documentElement.style.setProperty("--wallpaper-image", css);
    document.documentElement.style.setProperty("--wallpaper-scrim", value === "chalk" ? "0" : "0.45");
    syncWallpaperPreload(value);
  }

  /* No <link rel=preload> for the wallpaper, dynamic or static: the body's
     background-image fetch is the only fetch. A preload here kept firing
     "preloaded but not used within a few seconds" warnings even with the
     chalk art active (the app body doesn't render it until the boot intro
     clears), and the second fetch was pure waste - the file is decorative,
     sits behind the boot overlay anyway, and is in the HTTP cache on every
     visit after the first. Any old preload tag left by earlier builds is
     removed here. */
  function syncWallpaperPreload() {
    var link = document.getElementById("chalkle-wallpaper-preload");
    if (link) link.remove();
  }

  function applyCursor(value) {
    var choice = CURSORS[value] ? value : "none";
    var c = CURSORS[choice];
    document.documentElement.style.setProperty("--custom-cursor", c.css);
    /* Hovering never swaps the cursor to a different shape: interactive
       elements reuse the same image, but a brightened copy of it, so the
       cursor simply lightens. The brightened copy keeps the same hotspot,
       read from the base cursor's url(). */
    var m = /url\('([^']+)'\)\s*(\d+)\s+(\d+)/.exec(c.css || "");
    var pointerCss = "pointer";
    if (m) {
      var hoverImg = c.hover || m[1].replace(/(\.\w+)$/, "-hover$1");
      pointerCss = "url('" + hoverImg + "') " + m[2] + " " + m[3] + ", pointer";
    }
    document.documentElement.style.setProperty("--custom-cursor-pointer", pointerCss);
  }

  /* --------------------------------------------------------- theme codes ---
     A whole look is four values, so it travels as one line of text: the
     values, JSON-encoded and base64url'd behind a short prefix. Paste a code
     (or an exported JSON blob) to install it. Pyrus ships a theme marketplace
     with a catalogue and an install flow; the same thing works without a
     server at all when the "package" is a string anyone can send.

     Codes are untrusted input, so nothing is applied before every field is
     checked: colors must be #rrggbb, the wallpaper must be one of ours or a
     renderable http(s)/data/blob URL, and the cursor must exist locally. A
     bad field is dropped rather than allowed to reach the CSS custom
     properties, where an arbitrary string would be a style injection. */

  var CODE_PREFIX = "CHK1.";

  function b64urlEncode(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(text) {
    var b = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    var bin = atob(b);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function isHex(v) {
    return /^#[0-9a-f]{6}$/i.test(String(v || "").trim());
  }

  function cleanWallpaper(v) {
    var wp = String(v == null ? "" : v).trim();
    if (!wp) return "chalk";
    if (wp === "none") return "none";
    if (WALLPAPERS[wp]) return wp;
    if (wp.indexOf("custom:") === 0 && /^(https?:|data:|blob:)/i.test(wp.slice(7))) return wp;
    return "chalk";
  }

  /* ------------------------------------------------- VS Code themes ---
     A VS Code colour theme is just JSON with a colors map, and there are
     thousands of them. Reading one turns that whole catalogue into Chalkle
     themes: the editor background becomes the canvas, and the first
     trustworthy accent key becomes the accent. Ordering matters more than
     completeness here - button.background is a deliberate brand colour, while
     foreground/text keys are often near-white and make a useless accent. */

  var VS_BG_KEYS = [
    "editor.background", "sideBar.background", "activityBar.background",
    "terminal.background", "panel.background", "titleBar.activeBackground"
  ];
  var VS_ACCENT_KEYS = [
    "button.background", "button.primaryBackground", "activityBarBadge.background",
    "progressBar.background", "focusBorder", "activityBar.activeBorder",
    "textLink.foreground", "textLink.activeForeground", "editorCursor.foreground",
    "terminal.ansiBlue", "terminal.ansiCyan", "terminal.ansiMagenta", "charts.blue"
  ];

  /* VS Code allows #rgb, #rrggbb and #rrggbbaa; the CSS variables want #rrggbb. */
  function vsHex(value) {
    var s = String(value == null ? "" : value).trim();
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return "";
    if (s.length === 4) s = "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    if (s.length === 9) s = s.slice(0, 7);
    return s.toLowerCase();
  }

  function fromVsCode(raw) {
    if (!raw || typeof raw !== "object") return null;
    var colors = (raw.colors && typeof raw.colors === "object") ? raw.colors
      : ((raw.workbench && raw.workbench.colorCustomizations) || null);
    if (!colors) return null;
    var bg = "", i, accent = "";
    for (i = 0; i < VS_BG_KEYS.length && !bg; i++) bg = vsHex(colors[VS_BG_KEYS[i]]);
    if (!bg) return null;
    for (i = 0; i < VS_ACCENT_KEYS.length && !accent; i++) accent = vsHex(colors[VS_ACCENT_KEYS[i]]);
    /* Plenty of themes define no button or link colour at all. Deriving one
       from the background is better than refusing the import. */
    if (!accent) accent = luminance(bg) < 0.5 ? lighten(bg, 55) : darken(bg, 45);
    var name = String(raw.name || "VS Code theme").replace(/\s+/g, " ").trim().slice(0, 40);
    return { bg: bg, accent: accent, name: name || "VS Code theme" };
  }

  /* Accepts our objects, an exported JSON string, a CHK1. code, or a VS Code
     theme. Returns a fully validated theme or null. */
  function readTheme(text) {
    var raw = null;
    if (text && typeof text === "object") raw = text;
    else {
      var s = String(text == null ? "" : text).trim();
      if (!s) return null;
      try {
        if (s.indexOf(CODE_PREFIX) === 0) raw = JSON.parse(b64urlDecode(s.slice(CODE_PREFIX.length)));
        else if (s.charAt(0) === "{") raw = JSON.parse(s);
      } catch (e) { return null; }
    }
    if (!raw || typeof raw !== "object") return null;
    var fromVs = false;
    if (!isHex(raw.bg) || !isHex(raw.accent)) {
      var vs = fromVsCode(raw);
      if (!vs) return null;
      fromVs = true;
      /* A VS Code theme has no opinion about wallpaper or cursor, so keep the
         one already in use instead of resetting the room around the colours. */
      raw = {
        bg: vs.bg, accent: vs.accent, name: vs.name,
        wallpaper: raw.wallpaper || ChalkleTheme.getWallpaper(),
        cursor: raw.cursor || ChalkleTheme.getCursor()
      };
    }
    /* Anything the sender did not specify keeps this device's current choice:
       a two-colour theme should not silently reset your wallpaper. */
    if (!raw.wallpaper) raw.wallpaper = ChalkleTheme.getWallpaper();
    if (!raw.cursor) raw.cursor = ChalkleTheme.getCursor();
    var cursor = String(raw.cursor || "").trim();
    if (!cursor || !CURSORS[cursor]) cursor = "none";
    var name = String(raw.name == null ? "" : raw.name).replace(/\s+/g, " ").trim().slice(0, 40) || "Shared theme";
    var theme = { app: "chalkle-theme", v: 1, name: name, bg: raw.bg.trim(), accent: raw.accent.trim(), wallpaper: cleanWallpaper(raw.wallpaper), cursor: cursor };
    if (fromVs) theme.vscode = true;
    return theme;
  }

  function snapshot() {
    var custom = ChalkleTheme.getCustom() || {};
    var presetId = ChalkleTheme.getPreset();
    var p = PRESETS[presetId];
    return {
      app: "chalkle-theme",
      v: 1,
      name: (custom.name || (p && p.label) || "Custom"),
      bg: custom.bg || "",
      accent: custom.accent || "",
      wallpaper: ChalkleTheme.getWallpaper(),
      cursor: ChalkleTheme.getCursor()
    };
  }

  function installTheme(text) {
    var theme = readTheme(text);
    if (!theme) return { ok: false, error: "That does not look like a Chalkle theme code." };
    try {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify({ bg: theme.bg, accent: theme.accent, name: theme.name }));
      if (theme.wallpaper && theme.wallpaper !== "none") localStorage.setItem(WALLPAPER_KEY, theme.wallpaper);
      else localStorage.removeItem(WALLPAPER_KEY);
      localStorage.setItem(CURSOR_KEY, theme.cursor);
      localStorage.removeItem(PRESET_KEY);
    } catch (e) { /* no storage: still applies for this session */ }
    applyPalette(buildPalette(theme.bg, theme.accent));
    applyWallpaper(theme.wallpaper);
    applyCursor(theme.cursor);
    return { ok: true, theme: theme };
  }

  var ChalkleTheme = {
    presets: PRESETS,
    wallpapers: WALLPAPERS,
    cursors: CURSORS,
    /* Sharing API: snapshot() for the current look, shareCode() for the one-line
       code, exportTheme() for a readable JSON blob, install() to take one. */
    snapshot: snapshot,
    shareCode: function () {
      return CODE_PREFIX + b64urlEncode(JSON.stringify(snapshot()));
    },
    exportTheme: function () {
      return JSON.stringify(snapshot(), null, 2);
    },
    install: installTheme,
    read: readTheme,
    codePrefix: CODE_PREFIX,
    getCursor: function () {
      return localStorage.getItem(CURSOR_KEY) || "none";
    },
    setCursor: function (value) {
      localStorage.setItem(CURSOR_KEY, value);
      applyCursor(value);
    },
    getWallpaper: function () {
      return localStorage.getItem(WALLPAPER_KEY) || "chalk";
    },
    setWallpaper: function (value) {
      localStorage.setItem(WALLPAPER_KEY, value);
      applyWallpaper(value);
    },
    getCustom: function () {
      try {
        var raw = localStorage.getItem(CUSTOM_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },
    setCustom: function (bg, accent) {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify({ bg: bg, accent: accent }));
      applyPalette(buildPalette(bg, accent));
    },
    getPreset: function () {
      return localStorage.getItem(PRESET_KEY) || "";
    },
    setPreset: function (id) {
      var p = PRESETS[id];
      if (!p) {
        localStorage.removeItem(PRESET_KEY);
        return;
      }
      localStorage.setItem(PRESET_KEY, id);
      applyPalette(buildPalette(p.bg, p.accent));
      localStorage.setItem(CUSTOM_KEY, JSON.stringify({ bg: p.bg, accent: p.accent }));
    },
    resetPreset: function () {
      localStorage.removeItem(PRESET_KEY);
    },
    resetCustom: function () {
      localStorage.removeItem(CUSTOM_KEY);
      clearPalette();
    },
    apply: function () {
      var custom = this.getCustom();
      if (custom && custom.bg && custom.accent) {
        applyPalette(buildPalette(custom.bg, custom.accent));
      }
      applyWallpaper(this.getWallpaper());
      applyCursor(this.getCursor());
    }
  };

  window.ChalkleTheme = ChalkleTheme;
  autoResetOnce();
  ChalkleTheme.apply();
})();
