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

  var CURSORS = {
    cat: { label: "cat", css: "url('/assets/cursors/cursor-cat.png') 24 24, auto", preview: "/assets/cursors/cursor-cat.png", hover: "/assets/cursors/cursor-cat-hover.png" },
    "cat-black": { label: "black cat", css: "url('/assets/cursors/cursor-cat-black.png') 24 24, auto", preview: "/assets/cursors/cursor-cat-black.png", hover: "/assets/cursors/cursor-cat-black-hover.png" },
    puppy: { label: "puppy", css: "url('/assets/cursors/cursor-puppy.png') 24 24, auto", preview: "/assets/cursors/cursor-puppy.png", hover: "/assets/cursors/cursor-puppy-hover.png" },
    kyro: { label: "kyro", css: "url('/assets/cursors/cursor-kyro.png') 18 18, auto", preview: "/assets/cursors/cursor-kyro.png", hover: "/assets/cursors/cursor-kyro-hover.png" },
    neoos: { label: "neo os", css: "url('/assets/cursors/cursor-neoos.png') 18 18, auto", preview: "/assets/cursors/cursor-neoos.png", hover: "/assets/cursors/cursor-neoos-hover.png" },
    godlylinks: { label: "godly links", css: "url('/assets/cursors/cursor-godlylinks.png') 18 17, auto", preview: "/assets/cursors/cursor-godlylinks.png", hover: "/assets/cursors/cursor-godlylinks-hover.png" },
    projectbugs: { label: "project bugs", css: "url('/assets/cursors/cursor-projectbugs.png') 18 18, auto", preview: "/assets/cursors/cursor-projectbugs.png", hover: "/assets/cursors/cursor-projectbugs-hover.png" },
    frosted: { label: "frosted", css: "url('/assets/cursors/cursor-frosted.png') 18 18, auto", preview: "/assets/cursors/cursor-frosted.png", hover: "/assets/cursors/cursor-frosted-hover.png" },
    p2pgames: { label: "p2p games", css: "url('/assets/cursors/cursor-p2pgames.png') 18 17, auto", preview: "/assets/cursors/cursor-p2pgames.png", hover: "/assets/cursors/cursor-p2pgames-hover.png" },
    sv: { label: "s.v", css: "url('/assets/cursors/cursor-sv.png') 18 18, auto", preview: "/assets/cursors/cursor-sv.png", hover: "/assets/cursors/cursor-sv-hover.png" },
    anko: { label: "anko", css: "url('/assets/cursors/cursor-anko.png') 18 18, auto", preview: "/assets/cursors/cursor-anko.png", hover: "/assets/cursors/cursor-anko-hover.png" },
    ghostproxy: { label: "ghost proxy", css: "url('/assets/cursors/cursor-ghostproxy.png') 18 18, auto", preview: "/assets/cursors/cursor-ghostproxy.png", hover: "/assets/cursors/cursor-ghostproxy-hover.png" },
    array: { label: "array", css: "url('/assets/cursors/cursor-array.png') 18 18, auto", preview: "/assets/cursors/cursor-array.png", hover: "/assets/cursors/cursor-array-hover.png" },
    sizzle: { label: "sizzle studios", css: "url('/assets/cursors/cursor-sizzle.png') 18 18, auto", preview: "/assets/cursors/cursor-sizzle.png", hover: "/assets/cursors/cursor-sizzle-hover.png" },
    none: { label: "default", css: "auto", preview: null }
  };

  var WALLPAPERS = {
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
    sunset:    { label: "Sunset",    bg: "#22111d", accent: "#ff6b6b" }
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

  var ChalkleTheme = {
    presets: PRESETS,
    wallpapers: WALLPAPERS,
    cursors: CURSORS,
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
