/* Chalkle Omnibox - the suggestion list under the in-app browser's address bar.

   Before this, typing in the address bar gave no feedback at all: you had to
   press Enter to find out whether "run 3" meant a search, and the games you
   already own were unreachable from the field that looks most like a search
   box. This module turns that field into an omnibox. As you type it shows, in
   order:

     1. what Enter will do right now ("Open example.com" / 'Search for "run 3"'),
     2. matching catalogue games (launch straight from the address bar),
     3. your bookmarks and this session's history.

   Rows are built by `rows()`, which is pure - it takes the typed text and a
   context of bookmarks/history and returns plain objects. `attach()` is the
   DOM half: it renders those rows into a panel and owns ArrowUp/ArrowDown/
   Enter/Escape. Keeping them apart means the ranking can be tested without a
   browser, and the browser chrome only has to say how to open a row.

   window.ChalkleOmni: rows(value, ctx), attach(cfg) */

(function () {
  "use strict";

  var MAX = 9;          /* rows in the panel */
  var MAX_CATALOG = 5;
  var MAX_SIDE = 3;     /* bookmarks, and history, each */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function cleanUrl(u) { return String(u || "").replace(/^https?:\/\//, "").replace(/\/$/, ""); }
  /* Fold to letters+digits so "run3" finds "Run 3" and "fnaf2" finds "FNAF 2". */
  function fold(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
  function hostOf(u) {
    try { return new URL(u, location.href).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
  }
  function normUrl(u) {
    try {
      var p = new URL(u, location.href);
      return (p.hostname.replace(/^www\./, "") + p.pathname.replace(/\/$/, "") + p.search).toLowerCase();
    } catch (e) { return String(u || "").trim().toLowerCase(); }
  }

  function engineName() {
    try {
      if (window.ChalkleSearch && typeof window.ChalkleSearch.engines === "function") {
        var id = window.ChalkleSearch.engine();
        var all = window.ChalkleSearch.engines() || [];
        for (var i = 0; i < all.length; i++) {
          if (all[i].id === id) return all[i].name;
        }
      }
    } catch (e) { /* no search module: fall through */ }
    return "DuckDuckGo Lite";
  }

  /* Catalogue hits come from the app's own ranked search, so the omnibox and
     the top-bar field can never disagree about which game "minecr" means. */
  function catalogHits(q, ctx) {
    if (ctx && typeof ctx.catalog === "function") {
      try { return ctx.catalog(q) || []; } catch (e) { return []; }
    }
    return [];
  }

  function sideRows(list, kind, badge, q, seen) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < MAX_SIDE; i++) {
      var it = list[i];
      if (!it || !it.url) continue;
      var id = normUrl(it.url);
      if (seen[id]) continue;
      var label = String(it.title || it.label || cleanUrl(it.url));
      if (q && fold(label).indexOf(fold(q)) === -1 && fold(it.url).indexOf(fold(q)) === -1) continue;
      seen[id] = true;
      out.push({
        kind: kind,
        label: label,
        sub: cleanUrl(it.url),
        badge: badge,
        url: it.url,
        doc: /^https?:/i.test(it.url) ? it.url : ""
      });
    }
    return out;
  }

  /* Pure: (typed text, context) -> the rows the panel shows. */
  function rows(value, ctx) {
    ctx = ctx || {};
    var t = String(value || "").trim();
    if (!t) return [];

    var out = [];
    var seen = {};

    /* 1. What the field means right now. Always the first row, so Enter's
       behaviour is readable instead of a coin flip. */
    var cls = null;
    try { cls = ctx.classify ? ctx.classify(t) : null; } catch (e) { cls = null; }
    if (cls && cls.url) {
      seen[normUrl(cls.url)] = true;
      if (cls.kind === "open") {
        out.push({
          kind: "open",
          label: "Open " + (hostOf(cls.url) || t),
          sub: cls.url.replace(/^https?:\/\//, ""),
          badge: "Address",
          url: cls.url,
          doc: cls.url
        });
      } else {
        out.push({
          kind: "search",
          label: "Search \u201C" + t + "\u201D",
          sub: engineName(),
          badge: "Web",
          url: cls.url,
          doc: ""
        });
      }
    }

    /* 2. Games and apps you already have. */
    var hits = catalogHits(t, ctx);
    for (var i = 0; i < hits.length && i < MAX_CATALOG; i++) {
      var h = hits[i];
      if (!h || !h.title) continue;
      var key = h.url ? normUrl(h.url) : "";
      if (key && seen[key]) continue;
      if (key) seen[key] = true;
      out.push({
        kind: "catalog",
        label: String(h.title),
        sub: String(h.category || h.label || ""),
        badge: h.badge || "Play",
        url: h.url || "",
        item: h.item || null
      });
    }

    /* 3. Bookmarks, then this session's history. */
    sideRows(ctx.bookmarks, "bookmark", "Bookmark", t, seen).forEach(function (r) { out.push(r); });
    sideRows(ctx.history, "history", "History", t, seen).forEach(function (r) { out.push(r); });

    return out.slice(0, MAX);
  }

  function attach(cfg) {
    var input = cfg.input, panel = cfg.panel;
    if (!input || !panel) return null;

    var list = [];
    var idx = -1;

    function context() {
      var c = {};
      try { c = cfg.context ? (cfg.context() || {}) : {}; } catch (e) { c = {}; }
      c.classify = cfg.classify;
      c.catalog = cfg.catalog;
      return c;
    }

    function render() {
      list = rows(input.value, context());
      idx = -1;
      if (!list.length) { hide(); return; }
      panel.innerHTML = list.map(function (r, i) {
        return '<button class="browser-sg-row" type="button" role="option" data-sg="' + i + '" aria-selected="false">' +
          '<span class="browser-sg-badge">' + esc(r.badge || "") + "</span>" +
          '<span class="browser-sg-txt"><span class="browser-sg-label">' + esc(r.label) + "</span>" +
          (r.sub ? '<span class="browser-sg-sub">' + esc(r.sub) + "</span>" : "") +
          "</span></button>";
      }).join("");
      panel.hidden = false;
    }

    function hide() {
      panel.hidden = true;
      panel.innerHTML = "";
      list = [];
      idx = -1;
    }

    function focusRow(n) {
      if (!list.length) return;
      idx = (n + list.length) % list.length;
      Array.prototype.forEach.call(panel.querySelectorAll("[data-sg]"), function (b, i) {
        var on = i === idx;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
        if (on && b.scrollIntoView) b.scrollIntoView({ block: "nearest" });
      });
    }

    function commit(i) {
      var r = list[i];
      if (!r) return false;
      hide();
      cfg.go(r);
      return true;
    }

    /* mousedown, not click: the input's blur would empty the panel before a
       click ever landed. */
    panel.addEventListener("mousedown", function (e) {
      var b = e.target.closest("[data-sg]");
      if (!b) return;
      e.preventDefault();
      commit(parseInt(b.dataset.sg, 10));
    });
    panel.addEventListener("mousemove", function (e) {
      var b = e.target.closest("[data-sg]");
      if (b) focusRow(parseInt(b.dataset.sg, 10));
    });

    input.addEventListener("input", render);
    input.addEventListener("focus", render);
    input.addEventListener("blur", function () { setTimeout(hide, 120); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (panel.hidden) render(); focusRow(idx + 1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); if (panel.hidden) render(); focusRow(idx - 1); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        if (idx >= 0 && commit(idx)) return;
        var first = list[0];
        hide();
        if (cfg.submit) cfg.submit(input.value, first || null);
        return;
      }
      if (e.key === "Escape" && !panel.hidden) {
        /* Close the list, not the browser: the overlay's own Escape handler
           only exits fullscreen, and this must not reach it. */
        e.preventDefault();
        e.stopPropagation();
        hide();
      }
    });

    return { render: render, hide: hide, rows: function () { return list.slice(); } };
  }

  window.ChalkleOmni = { rows: rows, attach: attach };
})();
