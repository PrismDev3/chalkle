/* Chalkle. Keep this file framework-free so it runs anywhere, even offline. */

(function () {
  "use strict";

  /* Saved libraries. On first load each list is seeded from the built-in
     data, then everything lives in localStorage so the Admin panel can add,
     edit and remove games / sites / tools and it all sticks on this device. */
  var LIB_CONF = {
    games: {
      /* v4: reseeds the library from the (fixed, 82-game) games.js so any
         corrupted copy saved during the earlier file-mangling is discarded. */
      key: "chalkle-gamelib-v4",
      seed: function () {
        var ports = (window.ChalkWebPorts || []).map(function (p) {
          var copy = Object.assign({}, p);
          if (!copy.category) copy.category = "PC Port";
          return copy;
        });
        return ports.concat(Array.isArray(window.ChalkGames) ? window.ChalkGames.slice() : []);
      }
    },
    sites: { key: "chalkle-sitelib-v2", seed: function () { return (window.ChalkSites || []).slice(); } },
    tools: {
      key: "chalkle-toollib-v6",
      seed: function () {
        /* The proxy apps (TikTok, GitHub, ...) live in ChalkProxyApps and are
           declared with `target`; every launch path (the data-proxy-app tile
           and the search dropdown) reads `url`, so normalize both lists here.
           The library sync then copies `url` onto already-saved copies on
           this device. */
        var normalize = function (a) {
          if (a && !a.url && a.target) {
            var copy = Object.assign({}, a);
            copy.url = copy.target;
            return copy;
          }
          return a;
        };
        return (window.ChalkApps || [])
          .map(normalize)
          .concat((window.ChalkProxyApps || []).map(normalize));
      }
    },
    board: {
      key: "chalkle-boardlib-v1",
      seed: function () {
        return [
          { title: "James Brown", category: "Owners" },
          { title: "Ian Magadan", category: "Owners" }
        ];
      }
    }
  };

  var __idCounter = 0;

  function withId(list) {
    return (Array.isArray(list) ? list : []).map(function (it) {
      if (!it || typeof it !== "object") return it;
      if (!it._id) {
        var base = String(it.title || it.name || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
        it._id = base + "-" + (++__idCounter);
      }
      return it;
    });
  }

  /* Local file / javascript: URLs must never reach the DOM on a hosted site -
     Chrome logs "Content at … may not load or link to file:///." the instant a
     file:/// URL appears in any attribute (even an unclicked href). This wipes
     them from the URL-bearing fields of every item at load, so a stray saved
     path (e.g. an old local file:/// thumb) can't trigger that security log or
     a broken inline page. */
  function sanitizeItem(it) {
    if (!it || typeof it !== "object") return it;
    (["url", "thumb", "html"]).forEach(function (f) {
      if (typeof it[f] === "string" && /^(file:|javascript:)/i.test(String(it[f]).trim())) {
        it[f] = "";
      }
    });
    /* Repair known-dead FNF sources so older/renamed library copies that still
       point at truffled.lol/404 resolve to the working HTML5 build. */
    if (/funkin|fnf|friday\snight/i.test(String(it.title || ""))) {
      var url = String(it.url || "");
      if (/truffled\.lol\/404|truffled\.lol/i.test(url) || !url) {
        if (/week\s*7/i.test(String(it.title || ""))) {
          it.url = "https://raw.githack.com/SnowyOwlNugget/FNF-Week7-Html5-Test/main/index.html";
        } else {
          it.url = "https://raw.githack.com/genizy/fridayfunk/main/index.html";
        }
      }
    }
    return it;
  }

  function loadLib(name) {
    var conf = LIB_CONF[name];
    if (!conf) return [];
    try {
      var raw = localStorage.getItem(conf.key);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          /* Sync built-ins: refresh canonical fields (url, thumb, category, …)
             from the seed so edits to games.js / sites.js / apps.js always show
             up on every device, while keeping admin-added items and edits. */
          var merged = withId(parsed).map(sanitizeItem).filter(Boolean);
          var seeds = withId(conf.seed()).map(sanitizeItem).filter(Boolean);
          var dirty = merged.length !== parsed.length; /* holes / nulls removed */
          var SYNC_FIELDS = ["url", "thumb", "category", "porter", "isNew", "html", "kind", "via", "thumbCover"];
          seeds.forEach(function (seed) {
            if (!seed || !seed.title) return;
            var hit = null;
            for (var i = 0; i < merged.length; i++) {
              if (merged[i] && merged[i].title === seed.title) { hit = merged[i]; break; }
            }
            if (hit) {
              SYNC_FIELDS.forEach(function (f) {
                if (seed[f] !== undefined && seed[f] !== hit[f]) { hit[f] = seed[f]; dirty = true; }
              });
            } else {
              merged.push(seed);
              dirty = true;
            }
          });
          if (dirty) saveLib(name, merged);
          return merged;
        }
      }
    } catch (e) { /* corrupt, reseed below */ }
    var seeded = withId(conf.seed()).map(sanitizeItem).filter(Boolean);
    saveLib(name, seeded);
    return seeded;
  }

  function saveLib(name, arr) {
    try { localStorage.setItem(LIB_CONF[name].key, JSON.stringify(arr)); } catch (e) { /* no storage */ }
  }

  var libs = {
    games: loadLib("games"),
    sites: loadLib("sites"),
    tools: loadLib("tools"),
    board: loadLib("board")
  };

  var DATA = {
    games: libs.games,
    sites: libs.sites,
    "apps-tools": libs.tools,
    board: libs.board,
    music: window.ChalkMusic || [],
    proxies: window.ChalkProxies || []
  };

  var TAB_DATA = { games: "games", sites: "sites", tools: "apps-tools", board: "board" };

  var GRID_IDS = {
    home: null,
    games: "games-grid",
    sites: "sites-grid",
    music: "music-grid",
    "apps-tools": "apps-grid",
    proxies: "proxies-grid"
  };

  var EMPTY_IDS = {
    home: null,
    games: "games-empty",
    sites: "sites-empty",
    music: "music-empty",
    "apps-tools": "apps-empty",
    proxies: "proxies-empty"
  };

  var STORAGE_KEY = "chalkle-proxies";
  var SIZE_KEY = "chalkle-size";
  var MOTION_KEY = "chalkle-motion";
  var COLLAPSED_KEY = "chalkle-collapsed";
  var COUNTS_KEY = "chalkle-game-clicks";
  var FAVS_KEY = "chalkle-game-favs";
  var SORT_KEY = "chalkle-game-sort";
  var RECENTS_KEY = "chalkle-game-recents";

  var currentProxy = null;

  var state = {
    view: "home",
    tool: "launcher",
    query: "",
    genreFilters: [],
    collapsed: readPref(COLLAPSED_KEY) === "1",
    motion: readPref(MOTION_KEY) === "1",
    size: readPref(SIZE_KEY) || "comfortable",
    sort: readPref(SORT_KEY) || "favorite",
    sitesSort: "az",
    gameFilter: "all",
    clicks: readJson(COUNTS_KEY, {}),
    favs: readJson(FAVS_KEY, {}),
    proxies: loadProxies()
  };

  var els = {};
  var musicSearchDebounce = null;

  function $(id) {
    return document.getElementById(String(id).replace(/^#/, ""));
  }

  /* ---------- Chalkle wordmark ---------- */

  /* The Chalkle wordmark - multicolor bubble letters (the colors you picked,
     red first, matching the Google-style letters) with a hard drop shadow. */
  var LOGO_COLORS = ["#4285f4", "#ea4335", "#fbbc05", "#4285f4", "#34a853", "#ea4335", "#4285f4"];
  var LOGO_SHADOWS = ["#1557b0", "#b31412", "#e37400", "#1557b0", "#0d7734", "#b31412", "#1557b0"];

  function hexToRgba(hex, alpha) {
    var n = parseInt(String(hex || "#000000").replace("#", ""), 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + alpha + ")";
  }

  function buildLogo() {
    var letters = "chalkle".split("");
    return letters
      .map(function (ch, i) {
        return (
          '<span class="bubble-letter" style="color:' +
          LOGO_COLORS[i] +
          ";text-shadow:0 4px 0 " +
          LOGO_SHADOWS[i] +
          ",0 8px 12px " +
          hexToRgba(LOGO_COLORS[i], 0.4) +
          ';">' +
          ch +
          "</span>"
        );
      })
      .join("");
  }

  /* Section titles (Games, Sites, YouTube…) get the same bubble-letter look as
     the Chalkle wordmark, but in ONE color matching that tab: the hard drop
     shadow in the color's darker shade plus a soft matching glow underneath. */
  function bubbleTitle(text, color, shadow) {
    var c = color || "#34a853";
    var s = shadow || "#0d7734";
    return String(text || "")
      .split("")
      .map(function (ch) {
        if (ch === " ") return '<span class="title-letter" style="width:0.34em;">&nbsp;</span>';
        return (
          '<span class="title-letter" style="color:' +
          c +
          ";text-shadow:0 4px 0 " +
          s +
          ",0 8px 12px " +
          hexToRgba(c, 0.4) +
          ';">' +
          escapeHtml(ch) +
          "</span>"
        );
      })
      .join("");
  }

  /* ---------- Proxies ---------- */

  function readPref(k) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  }

  function persist(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) { /* no storage */ }
  }

  function readJson(k, fallback) {
    try {
      var raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function loadProxies() {
    var saved = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch (e) { /* no storage */ }
    var list = null;
    if (saved) {
      try {
        list = withId(JSON.parse(saved));
      } catch (e) { /* corrupt, fall through to seeds */ }
    }
    if (!list) list = withId(window.ChalkProxies || []).slice();

    /* Proxy migration (v2): the old Scramjet pointed at a trycloudflare
       quick-tunnel that expires (that one is dead now). Both Scramjet and
       Ultraviolet route through the same-origin /uv/ rewriting proxy served
       by this site's own server - the URL can never go stale and there is
       nothing separate for a filter to block. Fix saved copies in place, then
       make sure both default proxies exist. */
    var dirty = false;
    list.forEach(function (p) {
      if (!p || !p.url) return;
      var u = String(p.url);
      if (u.indexOf("trycloudflare") !== -1 || /^\/uv\/?$/i.test(u)) {
        /* /uv/ is not shipped with the static site - routing through it
           made every game look blocked. Point stale entries at a real host. */
        p.url = "https://gjsd.yan.ch/";
        p.mode = "frame";
        dirty = true;
      }
    });
    function has(name) {
      return list.some(function (p) {
        return p && String(p.name || "").toLowerCase() === name;
      });
    }
    if (!has("gjsd")) { list.push({ name: "GJSD", url: "https://gjsd.yan.ch/", mode: "frame", icon: "/assets/proxies/gjsd.png" }); dirty = true; }
    if (!has("ovokee")) { list.push({ name: "Ovokee", url: "https://ovokee.sbs/", mode: "frame", credit: "kelvin9rant", icon: "/assets/proxies/ovokee.png" }); dirty = true; }
    /* SerumOS instances (hash route + service worker), credit c0mrade. */
    [
      "swiftnet8420", "clearzone8524", "litezone9637", "meganet1958", "brightlink8769",
      "megaweb8626", "swiftgrid8322", "nextnet5497", "cleanwave3711", "cleanzone3531",
      "ultracdn5100", "superhost8321", "nextbeam4305", "megacore4871", "swiftcdn8722",
      "superweb7539", "boldnet2503", "megagrid9752", "nextnode6517", "litesite4767"
    ].forEach(function (host, idx) {
      var nm = "serium " + (idx + 1);
      if (!has(nm)) {
        list.push({ name: "Serium " + (idx + 1), url: "https://" + host + ".b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" });
        dirty = true;
      }
    });
    /* Backfill brand icons onto earlier saved copies (they were seeded before
       icons existed) so every card shows the real logo. */
    list.forEach(function (p) {
      if (!p) return;
      var nm = String(p.name || "").trim().toLowerCase();
      var want = null;
      if (nm === "gjsd") want = "/assets/proxies/gjsd.png";
      else if (nm === "ovokee") want = "/assets/proxies/ovokee.png";
      else if (nm.indexOf("serium") === 0) want = "/assets/proxies/serium.png";
      if (want && p.icon !== want) { p.icon = want; dirty = true; }
    });
    if (dirty) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (e) { /* no storage */ }
    }
    return list;
  }

  /* Settings view: every saved proxy as a clickable link (like the Sites
     tab) - name, host, and an Open affordance, so the proxies live in
     Settings too, not just the Proxies tab. */
  function renderSettingsProxies() {
    var box = $("#settings-proxy-list");
    if (!box) return;
    var list = state.proxies.filter(function (p) { return p && p.url; });
    if (!list.length) {
      box.innerHTML = '<span class="setting-hint">No proxies saved yet - add one in the Proxies tab.</span>';
      return;
    }
    box.innerHTML = list
      .map(function (p) {
        var host = "";
        try { host = new URL(p.url).hostname; } catch (e) { host = p.url; }
        var letter = escapeHtml((p.name || "?").charAt(0).toUpperCase() || "?");
        var credit = p.credit
          ? '<span class="proxy-link-credit">by ' + escapeHtml(p.credit) + "</span>"
          : "";
        return (
          '<a class="proxy-link" href="' + escapeAttr(p.url) + '" target="_blank" rel="noopener" title="' + escapeAttr(p.url) + '">' +
          '<span class="proxy-link-mark">' + (p.icon && !isLocalFileUrl(p.icon) ? '<img class="proxy-link-ico" src="' + escapeAttr(p.icon) + '" alt="" loading="lazy" onerror="this.remove()">' : "") + letter + "</span>" +
          '<span class="proxy-link-txt"><span class="proxy-link-name">' + escapeHtml(p.name) + "</span>" +
          '<span class="proxy-link-url">' + escapeHtml(host || p.url) + credit + "</span></span>" +
          '<span class="proxy-link-open">Open</span>' +
          "</a>"
        );
      })
      .join("");
  }

  function saveProxies() {
    persist(STORAGE_KEY, JSON.stringify(state.proxies));
    syncProxies();
  }

  function syncProxies() {
    window.ChalkleProxies = state.proxies.slice();
    window.ChalkleGetProxies = function () {
      return state.proxies.slice();
    };
  }

  function formatCount(n) {
    if (typeof n !== "number" || !isFinite(n)) return "";
    if (n >= 1000) {
      var k = n / 1000;
      return (k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)) + "k";
    }
    return String(n);
  }

  function proxyCard(item, i) {
    var url = item.url ? escapeAttr(item.url) : "";
    var isHosted = !!url;
    var mode = item.mode === "tab" ? "New tab" : "In-app";
    var host = "";
    if (item.url) {
      try { host = new URL(item.url).hostname; } catch (e) { host = ""; }
    }
    var markLetter = escapeHtml((item.name || "?").charAt(0).toUpperCase());
    var markColor = ["#34a853", "#4285f4", "#e60073", "#26c6da", "#fb8c00", "#a970ff"][Math.abs(i) % 6];
    var mark;
    if (item.icon && !isLocalFileUrl(item.icon)) {
      /* Real bundled brand logo (Serium / GJSD / Ovokee). */
      mark = '<span class="proxy-mark-letter" style="color:' + markColor + '">' + markLetter + '</span><img class="proxy-fav" src="' + escapeAttr(item.icon) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">';
    } else if (host) {
      /* Favicon ladder: Google s2, then Google faviconV2, then DuckDuckGo.
         All three are commonly blocked on school networks, so the letter
         chip stays behind the image either way. */
      mark = '<span class="proxy-mark-letter" style="color:' + markColor + '">' + markLetter + '</span><img class="proxy-fav" src="https://www.google.com/s2/favicons?domain=' + escapeAttr(host) + '&sz=64" alt="" loading="lazy" referrerpolicy="no-referrer" data-host="' + escapeAttr(host) + '" data-i="0" onerror="var t=this;var h=t.getAttribute(\'data-host\')||\'\';var i=parseInt(t.getAttribute(\'data-i\')||\'0\',10)+1;var u=[\'https://www.google.com/s2/favicons?domain=\'+encodeURIComponent(h)+\'&sz=64\',\'https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=\'+encodeURIComponent(\'https://\'+h)+\'&size=128\',\'https://icons.duckduckgo.com/ip3/\'+encodeURIComponent(h)+\'.ico\'];if(!h||i>=u.length){t.remove();return;}t.setAttribute(\'data-i\',String(i));t.src=u[i];">';
    } else {
      mark = markLetter;
    }
    var row =
      '<div class="card proxy-card">' +
      '<div class="proxy-card-top">' +
      '<div class="proxy-mark" aria-hidden="true">' + mark + "</div>" +
      '<div class="proxy-copy"><div class="card-title">' + escapeHtml(item.name) + "</div>" +
      '<div class="proxy-url">' + (url || "not hosted yet") + "</div></div>" +
      "</div>" +
      '<div class="proxy-meta-line">' +
      '<span class="proxy-pill ' + (isHosted ? "is-live" : "is-missing") + '">' + (isHosted ? "Ready" : "Needs URL") + "</span>" +
      '<span class="proxy-pill">' + mode + "</span>" +
      (item.credit ? '<span class="proxy-pill is-credit">by ' + escapeHtml(item.credit) + "</span>" : "") +
      "</div>" +
      '<div class="proxy-actions">' +
      '<button class="btn-ghost" data-proxy-open="' + i + '">Open</button>' +
      '<button class="btn-ghost" data-proxy-set="' + i + '">' + (url ? "Change URL" : "Set URL") + "</button>" +
      "</div>" +
      "</div>";
    return row;
  }

  function renderProxies() {
    var grid = $(GRID_IDS.proxies);
    var empty = $(EMPTY_IDS.proxies);
    if (!grid || !empty) return;

    var items = state.proxies.map(function (item, index) {
      return { item: item, index: index };
    });

    if (state.query) {
      var q = state.query.toLowerCase();
      items = items.filter(function (entry) {
        return (
          (entry.item.name || "").toLowerCase().indexOf(q) !== -1 ||
          (entry.item.url || "").toLowerCase().indexOf(q) !== -1
        );
      });
    }

    if (items.length === 0) {
      grid.innerHTML = "";
      empty.hidden = false;
      updateEmptyState();
      return;
    }

    empty.hidden = true;
    grid.innerHTML = items
      .map(function (entry) {
        return proxyCard(entry.item, entry.index);
      })
      .join("");
  }

  function openProxy(i) {
    var p = state.proxies[i];
    if (!p || !p.url) return;

    if (p.mode === "tab") {
      if (isLocalFileUrl(p.url)) return;
      window.open(p.url, "_blank", "noopener");
      return;
    }

    var frame = $("#proxy-frame");
    var title = $("#overlay-title");
    var overlay = $("#proxy-overlay");
    var notice = $("#overlay-notice");
    var fallback = $("#overlay-open-fallback");
    if (!frame || !overlay) return;

    title.textContent = p.name;
    currentProxy = p;
    if (fallback) fallback.href = isLocalFileUrl(p.url) ? "#" : p.url;
    if (notice) notice.hidden = !looksFrameBlocked(p.url);
    frame.src = p.url;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function looksFrameBlocked(url) {
    try {
      var host = new URL(url).hostname.toLowerCase();
      return host.indexOf("minecraft") !== -1 || host.indexOf("eagler") !== -1 || host.indexOf("google") !== -1;
    } catch (e) {
      return false;
    }
  }

  function closeOverlay() {
    var overlay = $("#proxy-overlay");
    var frame = $("#proxy-frame");
    var notice = $("#overlay-notice");
    if (overlay) overlay.hidden = true;
    if (notice) notice.hidden = true;
    if (frame) frame.src = "about:blank";
    currentProxy = null;
    document.body.style.overflow = "";
  }

  function closeMoreNav() {
    var panel = document.getElementById("nav-more");
    var btn = document.getElementById("nav-more-btn");
    if (panel) { panel.classList.remove("is-open"); panel.hidden = true; }
    if (btn) { btn.classList.remove("is-open"); btn.setAttribute("aria-expanded", "false"); }
  }

  function setView(view) {
    state.view = view;
    closeMoreNav();
    /* Mirror the active tab on <body> so the top bar + chrome can tint with
       the section's accent color. */
    document.body.setAttribute("data-view", view);

    document.querySelectorAll(".nav-item").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.dataset.view === view);
    });

    document.querySelectorAll(".view").forEach(function (section) {
      section.classList.toggle("is-visible", section.dataset.view === view);
    });

    if (view === "home") {
      renderHome();
      return;
    }

    if (view === "proxies") {
      renderProxies();
    } else if (view === "settings") {
      renderSettingsProxies();
    } else if (view === "docs") {
      /* owned by docs.js */
      if (window.ChalkleDocs && window.ChalkleDocs.render) window.ChalkleDocs.render();
    } else if (view === "partners") {
      /* owned by partners.js */
      if (window.ChalklePartners && window.ChalklePartners.render) window.ChalklePartners.render();
    } else if (view === "ai") {
      /* owned by ai.js */
      if (window.ChalkleAI && window.ChalkleAI.render) window.ChalkleAI.render();
    } else if (view === "cloud") {
      /* owned by cloud.js */
      if (window.ChalkleCloud && window.ChalkleCloud.render) window.ChalkleCloud.render();
    } else if (view === "music") {
      /* owned by music.js */
      if (window.ChalkleMusic && window.ChalkleMusic.render) window.ChalkleMusic.render();
    } else {
      render();
    }
  }

  /* ---------- Global search ----------
     The top search bar stays put and shows a dropdown of matches from across
     every library, each labeled with the tab it lives in (Games / Sites /
     Apps-Tools). Typing never bounces you to another view - you pick a result. */

  var SEARCH_TABS = [
    { view: "games", label: "Games" },
    { view: "sites", label: "Sites" },
    { view: "apps-tools", label: "Apps" }
  ];

  var searchFocusIdx = -1;
  var searchFocusList = [];
  var SEARCH_MAX = 12; /* cap the dropdown so short queries don't flood it */

  /* Real relevance scoring, not a bare includes().
     exact title > title starts with the query > the query starts a word
     (word boundary) > substring anywhere > category tag. Single-char queries
     only allow prefix / word-start hits so "w" doesn't match every title
     that happens to contain a "w". Returns an object { hit, score } or null. */
  function scoreSearch(item, q) {
    if (!item) return null;
    var title = String(item.title || item.name || "").toLowerCase();
    var short = q.length === 1;

    if (title === q) return { score: 100, hit: true };
    if (title.indexOf(q) === 0) return { score: 90, hit: true };

    /* Word-boundary: query starts right after a non-letter, to catch the "W"
       in "While True", "World", "Twitch", "Stardew"… */
    var qi = title.indexOf(q);
    if (qi >= 0) {
      var gap = qi === 0 ? "" : title.charAt(qi - 1);
      if (qi === 0 || /[^a-z0-9]/.test(gap)) return { score: 80, hit: true };
    }

    /* For >=2 chars allow plain substring (still later than prefix/word-start). */
    if (!short && title.indexOf(q) !== -1) return { score: 60, hit: true };

    /* Non-title fields still count, but only for 2+ char queries and ranked
       below any title hit so the right game still leads: category ("sports",
       "puzzle"), PC-port marker, and the hostname of the url (typing a domain
       finds every game/site hosted there). */
    if (!short) {
      var category = String(item.category || "").toLowerCase();
      if (category.indexOf(q) !== -1) return { score: 45, hit: true };
      if (item.porter && String(item.porter).toLowerCase().indexOf(q) !== -1) return { score: 40, hit: true };
      var host = "";
      try { host = String(item.url || "").replace(/^https?:\/\//i, "").split("/")[0].toLowerCase(); } catch (e) {}
      if (host && host.indexOf(q) !== -1) return { score: 35, hit: true };
    }

    return null;
  }

  function collectSearchResults(q) {
    var out = [];
    q = (q || "").toLowerCase();
    if (!q) return out;
    SEARCH_TABS.forEach(function (tab) {
      ((DATA[tab.view] || [])).forEach(function (item) {
        var s = scoreSearch(item, q);
        if (s && s.hit) {
          item.__view = tab.view;
          item.__label = tab.label;
          item.__score = s.score;
          out.push(item);
        }
      });
    });
    /* Best relevance first, then view order as a tiebreak, then title. */
    out.sort(function (a, b) {
      var byScore = (b.__score || 0) - (a.__score || 0);
      if (byScore) return byScore;
      var rank = { "apps-tools": 0, games: 1, sites: 2 };
      var dv = (rank[a.__view] || 3) - (rank[b.__view] || 3);
      if (dv) return dv;
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
    return out.slice(0, SEARCH_MAX);
  }

  function renderSearchResults(q) {
    var box = $("#search-results");
    if (!box) return;
    var list = collectSearchResults(q);
    searchFocusIdx = -1;
    searchFocusList = list;
    if (!list.length) {
      box.hidden = false;
      box.innerHTML = '<div class="search-empty">' + escapeHtml("No matches for \u201C" + (q || "") + "\u201D") + "</div>";
      return;
    }
    var html = "";
    var lastView = "";
    list.forEach(function (item, i) {
      if (item.__view !== lastView) {
        html += '<div class="search-results-group">' + escapeHtml(SEARCH_TABS.find(function (t) { return t.view === item.__view; }).label) + "</div>";
        lastView = item.__view;
      }
      var letter = escapeHtml((item.title || "?").charAt(0).toUpperCase() || "?");
      var thumb = item.thumb && !isLocalFileUrl(item.thumb)
        ? '<img class="search-r-img" src="' + escapeAttr(item.thumb) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.onerror=null;this.remove()">'
        : '<span class="search-r-img" style="display:grid;place-items:center;background:var(--panel-2);color:var(--text-2);font-weight:700;text-align:center;">' + letter + "</span>";
      var sub = item.category ? String(item.category) : (item.__view === "sites" ? String(item.url || "").replace(/^https?:\/\//, "") : "");
      html += '<button class="search-r" role="option" data-search-i="' + i + '">' +
        thumb +
        '<span class="search-r-txt"><span class="search-r-title">' + escapeHtml(item.title || "Untitled") + "</span>" +
        (sub ? '<span class="search-r-sub">' + escapeHtml(sub) + "</span>" : "") +
        "</span>" +
        '<span class="search-r-in">in ' + escapeHtml(item.__label) + "</span>" +
        "</button>";
    });
    box.hidden = false;
    box.innerHTML = html;

    box.querySelectorAll("[data-search-i]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var item = searchFocusList[parseInt(btn.dataset.searchI, 10)];
        if (item) launchSearchItem(item);
      });
      btn.addEventListener("mousemove", function () {
        var i = parseInt(btn.dataset.searchI, 10);
        if (i !== searchFocusIdx) setSearchFocus(i);
      });
    });
  }

  function setSearchFocus(i) {
    searchFocusIdx = i;
    var box = $("#search-results");
    if (!box) return;
    box.querySelectorAll("[data-search-i]").forEach(function (btn, j) {
      btn.classList.toggle("is-active", j === searchFocusIdx);
    });
    var act = box.querySelector(".search-r.is-active");
    if (act && act.scrollIntoView) act.scrollIntoView({ block: "nearest" });
  }

  function moveSearchFocus(dir) {
    if (!searchFocusList.length) return;
    var n = searchFocusList.length;
    searchFocusIdx = (searchFocusIdx + dir + n) % n;
    setSearchFocus(searchFocusIdx);
  }

  function commitSearchFocus() {
    if (searchFocusIdx >= 0 && searchFocusList[searchFocusIdx]) launchSearchItem(searchFocusList[searchFocusIdx]);
  }

  function closeSearchResults() {
    var box = $("#search-results");
    if (box) box.hidden = true;
    searchFocusIdx = -1;
    searchFocusList = [];
  }

  /* Launch an item picked from search - same behaviour as clicking its card,
     but first it hops you to that item's tab for context. */
  function launchSearchItem(item) {
    if (!item) return;
    var view = item.__view;
    closeSearchResults();
    if (els.search) els.search.value = "";
    state.query = "";
    setView(view);
    if (!window.ChalkleLaunch) return;
    if (isLocalFileUrl(item.url)) {
      alert("That item points to a local file (" + item.url + ") - local paths can't open on the hosted site. Edit it in Admin and set a web URL instead.");
      return;
    }
    if (isJamesEdition(item)) {
      openJamesEdition(item.title || "Minecraft James Edition");
      return;
    }
    if (item.directOnly && window.ChalkleLaunch.openProxyApp) {
      /* Unity WebGL etc. must run on a real origin - blob/about:blank breaks
         relative asset loading. The /uv/ proxy IS a real origin on this same
         site and rewrites CDN refs, so route directOnly items through it
         instead of opening the raw (blockable) host. */
      window.ChalkleLaunch.openProxyApp(item.url || "", item.title || "");
      return;
    }
    if (item.via === "proxy" && window.ChalkleLaunch.openProxyApp) {
      window.ChalkleLaunch.openProxyApp(item.url || "", item.title || "");
      return;
    }
    if (item.html && String(item.html).trim()) {
      window.ChalkleLaunch.open(window.ChalkleLaunch.htmlUrl(item.html), item.title || "");
      return;
    }
    var u = item.url || "";
    if (u) {
      /* Sites open through the launcher picker too - same as clicking a card
         on the Sites tab - so about:blank / blob / proxy are always on the
         table instead of auto-launching. */
      if (view === "sites" && window.ChalkleLaunch.openWithOptions) {
        window.ChalkleLaunch.openWithOptions(u, item.title || u);
        return;
      }
      /* Prefer fetch-and-inject: pull the site's HTML through the same-origin
         /_fetch relay and open it as a local blob so the tab never
         hard-navigates to the blocked host. Sites get blocked easily in
         about:blank because the cloak still loads the real URL - a blob of
         the HTML doesn't. Falls back automatically if it can't fetch. */
      if (window.ChalkleLaunch.openFetchedAny) {
        window.ChalkleLaunch.openFetchedAny(u, item.title || "").then(function (used) {
          if (used) return;
          /* Couldn't fetch-and-inject. Prefer the proxy on the Sites tab, else
             open through the normal picker (about:blank / blob / direct). */
          if (view === "sites" && window.ChalkleLaunch.openSiteProxied) {
            window.ChalkleLaunch.openSiteProxied(u, item.title || "");
          } else {
            window.ChalkleLaunch.open(u, item.title || "");
          }
        });
        return;
      }
      if (window.ChalkleLaunch.isFetchableHtml && window.ChalkleLaunch.isFetchableHtml(u)) {
        window.ChalkleLaunch.openFetched(u, item.title || "");
      } else if (view === "sites" && window.ChalkleLaunch.openSiteProxied) {
        /* Sites route through the configured proxy so the tab never touches
           the blocked origin - about:blank / blob wrap the proxied URL. */
        window.ChalkleLaunch.openSiteProxied(u, item.title || "");
      } else {
        window.ChalkleLaunch.open(u, item.title || "");
      }
      return;
    }
    if (item.kind === "launcher" && window.ChalkleBlankTab) window.ChalkleBlankTab.open();
    else if (item.kind === "editor" && window.ChalkleEditor) window.ChalkleEditor.open();
    else if (item.kind === "urlauditor" && window.ChalkleUrlAuditor) window.ChalkleUrlAuditor.open();
    else if (item.kind === "pixel" && window.ChalklePixel) window.ChalklePixel.open();
    else if (item.kind === "domainhub" && window.ChalkleDomainHub) window.ChalkleDomainHub.open();
    else if (item.kind === "iphone16") openIphone16();
    else if (item.kind === "browser") openBrowser();
  }

  /* iPhone 16 simulator always opens in its own full-screen about:blank tab -
     it's a self-contained app, so the launch method picker would only add a
     pointless step. */
  function ipTileClick(tile) {
    var url = tile ? (tile.querySelector("[data-url]") ? tile.querySelector("[data-url]").getAttribute("data-url") : (tile.querySelector(".tool-tile-link") ? tile.querySelector(".tool-tile-link").getAttribute("data-url") : "")) : "";
    openIphone16(url || "/game-builds/iphone16/index.html");
  }
  function openIphone16(url) {
    var src = url || "/game-builds/iphone16/index.html";
    var win = null;
    try { win = window.open(src, "_blank"); } catch (e) { /* ignore */ }
    if (win) {
      try { win.document.title = (window.ChalkleCloakTitle || "Home") + ""; } catch (e) { /* cross-origin - can't set title */ }
    }
  }

  /* Built-in proxied browser page (browser.html). Opens in its own tab -
     it's a full address-bar browser, not a card you embed. */
  function openBrowser() {
    var win = null;
    try { win = window.open("/browser.html", "_blank"); } catch (e) { /* ignore */ }
    if (win) {
      try { win.document.title = (window.ChalkleCloakTitle || "Home") + ""; } catch (e) { /* cross-origin - can't set title */ }
    }
  }

  /* Boot intro door: once the overlay is gone, kick rendering that was
     waiting for the page to be visible. */

  function bootReady() {
    setTimeout(function () {
      renderHome();
      renderProxies();
      render();
    }, 60);
  }

  if (window.__chalkleBootDone) {
    bootReady();
  } else {
    window.addEventListener("chalkle-boot-done", bootReady, { once: true });
  }

  /* ---------- Generic rendering ---------- */

  function card(item) {
    var title = escapeHtml(item.title || "Untitled");
    var rawTitle = item.title || "Untitled";
    var host = "";
    try {
      host = item.url ? new URL(item.url).hostname.replace(/^www\./, "") : "";
    } catch (e) { /* bad URL, leave host empty */ }

    /* Clean fallback tile: a soft brand gradient with a subtle controller icon.
       No more big JS-letter blocks when a thumbnail is missing or broken. */
    var fallbackHtml = '<span class="thumb-fallback" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><rect x="2.25" y="5.25" width="19.5" height="12" rx="5.75"/><path d="M7.25 8.25v6M5.25 11.25h4"/><circle cx="15.75" cy="10.5" r=".9" fill="currentColor"/><circle cx="18.25" cy="12.75" r=".9" fill="currentColor"/></svg></span>';
    var faviconUrl = host ? "https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=" + encodeURIComponent("https://" + host) + "&size=128" : "";
    /* Only distrust a thumbnail when it is served straight off a dead host -
       never when that host just happens to be wrapped inside a screenshot
       service like thum.io. */
    var thumbHost = "";
    try { thumbHost = new URL(item.thumb || "").hostname; } catch (e) { /* no thumb */ }
    var safeThumb = !!item.thumb && !isLocalFileUrl(item.thumb) && thumbHost !== "itgetyouhurt.gyalsanglama.com.np";
    /* 16:9 SVG banners (our Eaglercraft tiles) should fill the card like covers;
       smaller square data-URIs (icons) get the centered icon treatment. */
    var thumbLooksLikeIcon = /favicon|apple-touch-icon|google\.com\/s2|gstatic\.com\/favicon|\/logo|^data:image(?!.*%22640%22%20height=%22360%22)/i.test(item.thumb || "");
    /* thumbCover forces cover-fit for images whose URL incidentally looks like a
       logo (e.g. a big hero jpg that contains "/Logo") but should fill the box. */
    if (item.thumbCover) thumbLooksLikeIcon = false;
    var fallbackAttr = faviconUrl ? ' data-fallback="' + escapeAttr(faviconUrl) + '"' : "";

    var thumb;
    if (safeThumb) {
      thumb = fallbackHtml + '<img class="thumb-art' + (thumbLooksLikeIcon ? ' thumb-icon' : '') + '" src="' + escapeAttr(item.thumb) + '"' + fallbackAttr + ' alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.onerror=null;this.classList.add(\'thumb-failed\');' + (faviconUrl ? 'this.src=this.dataset.fallback;this.classList.add(\'thumb-icon\');' : 'this.remove();') + '">';
    } else if (faviconUrl) {
      thumb = fallbackHtml + '<img class="thumb-art thumb-icon" src="' + escapeAttr(faviconUrl) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.classList.add(\'thumb-failed\');this.remove()">';
    } else {
      thumb = fallbackHtml;
    }

    var porter = item.porter ? '<span class="card-sub">web port by ' + escapeHtml(item.porter) + "</span>" : "";
    var badge = item.porter ? '<span class="card-badge">PC</span>' : "";
    var source = item.porter ? "PC port" : host || "web game";    var ribbon = item.isNew ? '<span class="ribbon">New this week</span>' : "";
    var category = item.category ? '<span class="card-cat">' + escapeHtml(item.category) + "</span>" : "";
    var htmlAttr = (item.html && String(item.html).trim()) ? ' data-html="' + escapeAttr(item.html) + '"' : "";
    /* Same-origin /game-builds pages and Unity ports must open as a real tab.
       Cloak iframes look "blocked" even when the files are hosted here. */
    var hostedHere = !!(item.url && window.ChalkleLaunch && window.ChalkleLaunch.isLocalPlayUrl && window.ChalkleLaunch.isLocalPlayUrl(item.url));
    var directAttr = (item.directOnly || hostedHere) ? ' data-direct-only="1"' : "";

    var href = safeHref(item.url);
    var dataTitle = escapeAttr(rawTitle);
    var tooltip = rawTitle + (item.url ? "\n" + item.url : (item.html ? "\nHTML code" : ""));
    var dataTooltip = escapeAttr(tooltip);
    var key = gameKey(item);
    var clicks = state.clicks[key] || 0;
    var fav = !!state.favs[key];
    var countLabel = clicks === 1 ? "1 click" : clicks + " clicks";

    return (
      '<article class="card game-card">' +
      '<button class="fav-btn ' + (fav ? "is-fav" : "") + '" data-fav="' + escapeAttr(key) + '" aria-label="' + (fav ? "Remove favorite" : "Add favorite") + '">' +
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6L7.1 19l.9-5.5-4-3.9 5.5-.8z"/></svg>' +
      "</button>" +
      '<button class="open-with" data-open-with data-url="' + escapeAttr(item.url || "") + '" data-title="' + escapeAttr(rawTitle) + '" aria-label="Choose how to open" title="Open with options">' +
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.5v.1M12 12v.1M12 17.5v.1"/></svg>' +
      "</button>" +
      '<a class="game-launch" href="' + href + '" data-launch="1" data-url="' + href + '" data-title="' + dataTitle + '"' + htmlAttr + directAttr + ' title="' + dataTooltip + '">' +
      ribbon +
      '<span class="card-thumb">' + thumb + '<span class="quick-launch">Launch</span></span>' +
      '<span class="card-body">' +
      '<span class="card-main"><span class="card-title" title="' + dataTooltip + '">' + title + "</span>" + category + badge + porter + "</span>" +
      '<span class="card-side"><span class="card-source">' + escapeHtml(source) + '</span><span class="card-count">' + countLabel + "</span></span>" +
      "</span>" +
      "</a>" +
      "</article>"
    );
  }

  /* Apps/Tools get their own presentation: a clean app tile with a rounded
     icon, title, category chip and an open affordance - themed to match the
     rest of Chalkle instead of the generic game card. */
  function toolCard(item) {
    var rawTitle = item.title || "Untitled";
    var title = escapeHtml(rawTitle);
    var href = safeHref(item.url);
    var htmlAttr = (item.html && String(item.html).trim()) ? ' data-html="' + escapeAttr(item.html) + '"' : "";
    /* Built-in apps (Blank tab launcher, HTML Editor) open their own modal
       instead of launching a URL - data-tool-kind handles that in the click
       handler. Everything else is a plain link tile. */
    var kind = item.kind === "launcher" || item.kind === "editor" || item.kind === "urlauditor" || item.kind === "pixel" || item.kind === "domainhub" || item.kind === "iphone16" || item.kind === "browser" ? escapeAttr(item.kind) : "";
    var kindAttr = kind ? ' data-tool-kind="' + kind + '"' : '';
    var isProxy = item.via === "proxy" && !!item.url;
    var proxyAttr = isProxy ? ' data-proxy-app="' + escapeAttr(item.url) + '"' : "";
    var toolLetter = escapeHtml(rawTitle.charAt(0).toUpperCase() || "?");
    var toolFallback = '<span class="tool-tile-letter" aria-hidden="true">' + toolLetter + '</span>';
    var thumb = item.thumb && !isLocalFileUrl(item.thumb)
      ? toolFallback + '<img class="tool-tile-img" src="' + escapeAttr(item.thumb) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">'
      : toolFallback;
    var via = isProxy ? '<span class="tool-tile-via" title="Opens through your configured proxy">proxy</span>' : "";
    var cat = item.category ? '<span class="card-cat">' + escapeHtml(item.category) + "</span>" : "";
    var tileHref = (kind || isProxy) ? "#" : href;
    return (
      '<article class="tool-tile' + (isProxy ? " is-proxy" : "") + '">' +
      '<a class="tool-tile-link" href="' + tileHref + '"' + kindAttr + proxyAttr + (kind || isProxy ? '' : ' data-launch="1" data-url="' + href + '" data-title="' + escapeAttr(rawTitle) + '"' + htmlAttr) + ' title="Open ' + escapeAttr(rawTitle) + '">' +
      '<span class="tool-tile-art">' + thumb + "</span>" +
      '<span class="tool-tile-body">' +
      '<span class="tool-tile-title">' + title + "</span>" +
      '<span class="tool-tile-meta">' + cat + via + '<span class="tool-tile-open">Open</span></span>' +
      "</span>" +
      "</a>" +
      (kind || isProxy ? "" : '<button class="open-with open-with-tool" data-open-with data-url="' + escapeAttr(item.url || "") + '" data-title="' + escapeAttr(rawTitle) + '" aria-label="Choose how to open" title="Open with options">' +
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.5v.1M12 12v.1M12 17.5v.1"/></svg>' +
        "</button>") +
      "</article>"
    );
  }

  function gameKey(item) {
    return String((item && (item.url || item.title)) || "").toLowerCase();
  }

  var gridExpandAll = false;

  function render(expandAll) {
    gridExpandAll = !!expandAll;
    if (state.view === "music") return; /* owned by music.js */
    var items = (DATA[state.view] || []).slice().filter(Boolean);

    if (state.query) {
      var q = state.query.toLowerCase();
      items = items.filter(function (item) {
        return (item.title || "").toLowerCase().indexOf(q) !== -1;
      });
    }

    if (state.view === "games") {
      if (state.gameFilter !== "all") {
        items = items.filter(function (item) {
          var key = gameKey(item);
          if (state.gameFilter === "ports") return !!item.porter;
          if (state.gameFilter === "favorites") return !!state.favs[key];
          if (state.gameFilter === "new") return !!item.isNew;
          return true;
        });
      }
      /* Multi-select genre / tag filter - OR within the chosen set. */
      if (state.genreFilters && state.genreFilters.length) {
        items = items.filter(function (item) {
          for (var i = 0; i < state.genreFilters.length; i++) {
            if (itemCategory(item) === state.genreFilters[i]) return true;
          }
          return false;
        });
      }
      renderGenreChips();
      items.sort(function (a, b) {
        var ak = gameKey(a);
        var bk = gameKey(b);
        var af = state.favs[ak] ? 1 : 0;
        var bf = state.favs[bk] ? 1 : 0;
        if (state.sort === "favorite" && af !== bf) return bf - af;
        if (state.sort === "popular") {
          var popular = (state.clicks[bk] || 0) - (state.clicks[ak] || 0);
          if (popular) return popular;
        }
        var at = (a.title || "").toLowerCase();
        var bt = (b.title || "").toLowerCase();
        return state.sort === "za" ? bt.localeCompare(at) : at.localeCompare(bt);
      });
      renderGameStats(items.length);
    }

    if (state.view === "sites") {
      items.sort(function (a, b) {
        if (state.sitesSort === "new") {
          var an = a.isNew ? 1 : 0;
          var bn = b.isNew ? 1 : 0;
          if (an !== bn) return bn - an;
        }
        var at = (a.title || "").toLowerCase();
        var bt = (b.title || "").toLowerCase();
        return state.sitesSort === "za" ? bt.localeCompare(at) : at.localeCompare(bt);
      });
    }

    var grid = $(GRID_IDS[state.view]);
    var empty = $(EMPTY_IDS[state.view]);
    if (!grid || !empty) return;

    var meta = $(state.view + "-meta");
    if (meta) {
      meta.textContent = items.length + (items.length === 1 ? " item" : " items");
      meta.classList.toggle("has-content", items.length > 0);
    }

    if (items.length === 0) {
      grid.innerHTML = "";
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    /* Big libraries (1,400+ games) cap the initial render so filter/sort
       swaps stay fast; a "Show more" button expands to the full set. */
    var GRID_CAP = 480;
    var capped = items.length > GRID_CAP && !gridExpandAll;
    var shown = capped ? items.slice(0, GRID_CAP) : items;
    var html = shown.map(state.view === "apps-tools" ? toolCard : card).join("");
    if (capped) {
      html += '<div class="grid-more"><button class="btn" id="grid-show-more">Show all ' + (items.length - GRID_CAP) + " more</button></div>";
    }
    grid.innerHTML = html;
    var moreBtn = document.getElementById("grid-show-more");
    if (moreBtn) {
      moreBtn.addEventListener("click", function () { render(true); });
    }
  }

  /* Minecraft James Edition (26.2) ------------------------------------------------
     Our full-stack Eaglercraft 26.2 build. The School Center launcher auto-boots
     its servers (friends :8787, world :25565, web client :80) and publishes them
     on a public Cloudflare quick-tunnel, writing the live URL into
     SCHOOL_CENTER_CONFIG.minecraftUrl. We resolve that public URL (so friends
     anywhere can join - never localhost) and open it unblocked in about:blank. */
  /* Mojang grass-block mark for James Edition (crisp vector, transparent bg).
     Reused by the Featured home card and kept in sync with games.js. */
  /* Real Minecraft horizontal key art (official banner) used for the game grid
     tile (games.js uses the same artwork). */
  var MC_KEY_ART = "https://static.wikia.nocookie.net/minecraft_gamepedia/images/a/a3/Minecraft_horizontal_key_art.webp/revision/latest?cb=20230225041534";

  /* Crisp square grass-block mark for the Featured home card. The wikia key
     art is horizontal and got cropped badly in the 132x132 featured square;
     this SVG banner fits the square perfectly, matches the chalk theme, and is
     a data URI so it can never 404 or be blocked. */
  var MC_FEAT_MARK = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22264%22%20height%3D%22264%22%20viewBox%3D%220%200%20264%20264%22%3E%0A%3Cdefs%3E%0A%3ClinearGradient%20id%3D%22top%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%237ac65a%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%234f9e38%22%2F%3E%3C%2FlinearGradient%3E%0A%3ClinearGradient%20id%3D%22l%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23b5935f%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%238a6a3c%22%2F%3E%3C%2FlinearGradient%3E%0A%3ClinearGradient%20id%3D%22r%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23a07a45%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%236b4c26%22%2F%3E%3C%2FlinearGradient%3E%0A%3ClinearGradient%20id%3D%22bg%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%232a2417%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23140f06%22%2F%3E%3C%2FlinearGradient%3E%0A%3C%2Fdefs%3E%0A%3Crect%20width%3D%22264%22%20height%3D%22264%22%20rx%3D%2226%22%20fill%3D%22url(%23bg)%22%2F%3E%0A%3Cg%20stroke%3D%22rgba(255%2C255%2C255%2C0.08)%22%3E%3Cpath%20d%3D%22M0%20132H264%20M132%200V264%20M66%200V264%20M198%200V264%20M0%2066H264%20M0%20198H264%22%2F%3E%3C%2Fg%3E%0A%3Cg%20transform%3D%22translate(132%20128)%20scale(4.6)%22%20style%3D%22filter%3Adrop-shadow(0%206px%208px%20rgba(0%2C0%2C0%2C0.45))%22%3E%0A%3Cpolygon%20points%3D%22-16%2C-16%2016%2C-16%2016%2C-6%20-16%2C-6%22%20fill%3D%22url(%23top)%22%2F%3E%0A%3Cpolygon%20points%3D%22-16%2C-6%20-16%2C6%2016%2C6%2016%2C-6%22%20fill%3D%22url(%23l)%22%2F%3E%0A%3Cpolygon%20points%3D%22-16%2C6%2016%2C6%2016%2C18%20-16%2C18%22%20fill%3D%22url(%23l)%22%2F%3E%0A%3Cpolygon%20points%3D%22-16%2C-6%20-16%2C6%20-24%2C8%20-24%2C-4%22%20fill%3D%22url(%23r)%22%2F%3E%0A%3Cpolygon%20points%3D%22-16%2C6%20-16%2C18%20-24%2C20%20-24%2C8%22%20fill%3D%22url(%23r)%22%2F%3E%0A%3Cpolygon%20points%3D%2216%2C-6%2016%2C6%2024%2C8%2024%2C-4%22%20fill%3D%22url(%23r)%22%2F%3E%0A%3Cpolygon%20points%3D%2216%2C6%2016%2C18%2024%2C20%2024%2C8%22%20fill%3D%22url(%23r)%22%2F%3E%0A%3Ccircle%20cx%3D%22-8%22%20cy%3D%22-10%22%20r%3D%221.6%22%20fill%3D%22%23b6e29a%22%20opacity%3D%220.9%22%2F%3E%0A%3Ccircle%20cx%3D%226%22%20cy%3D%22-13%22%20r%3D%221.2%22%20fill%3D%22%2366a84a%22%2F%3E%0A%3Ccircle%20cx%3D%220%22%20cy%3D%22-8%22%20r%3D%221%22%20fill%3D%22%23cdea9f%22%20opacity%3D%220.8%22%2F%3E%0A%3Ccircle%20cx%3D%22-3%22%20cy%3D%220%22%20r%3D%221%22%20fill%3D%22%237d5c30%22%20opacity%3D%220.7%22%2F%3E%0A%3Ccircle%20cx%3D%229%22%20cy%3D%222%22%20r%3D%221%22%20fill%3D%22%237d5c30%22%20opacity%3D%220.6%22%2F%3E%0A%3Ccircle%20cx%3D%225%22%20cy%3D%2212%22%20r%3D%221%22%20fill%3D%22%238a6a3c%22%20opacity%3D%220.7%22%2F%3E%0A%3Ccircle%20cx%3D%22-8%22%20cy%3D%228%22%20r%3D%221%22%20fill%3D%22%237d5c30%22%20opacity%3D%220.6%22%2F%3E%0A%3C%2Fg%3E%0A%3C%2Fsvg%3E";

  function minecraftUrl() {
    try {
      var cfg = window.SCHOOL_CENTER_CONFIG;
      if (cfg && cfg.minecraftUrl) return cfg.minecraftUrl;
    } catch (e) { /* no config */ }
    return "http://localhost:80";
  }

  function isJamesEdition(itemOrUrl) {
    if (!itemOrUrl) return false;
    if (typeof itemOrUrl === "string") return itemOrUrl === "__MC26__";
    return itemOrUrl.url === "__MC26__" || (itemOrUrl.title || "").indexOf("James Edition") !== -1;
  }

  function openJamesEdition(title) {
    var url = minecraftUrl();
    /* The Minecraft host sends X-Frame-Options: SAMEORIGIN, so it can NEVER
       load inside an about:blank/blob wrapper (those iframe the URL) from a
       different origin. It must open in its own top-level tab. We cloak that
       tab title/icon so it reads as a school site anyway. */
    var win = null;
    try {
      /* Keep the parent-tab reference (no noopener) so we can cloak the new
         tab's title/icon as a school site once it opens. */
      win = window.open(url, "_blank");
    } catch (e) { /* ignore */ }
    if (win) {
      try {
        win.document.title = (window.ChalkleCloakTitle || "Chalkle") + "";
      } catch (e) { /* cross-origin - can't set title */ }
    }
    return !!win;
  }

  /* Home cover-card art + wrapper, shared by Continue playing / Popular /
     Watch next so every shelf renders the same crisp cards. */
  function hvFallback(letter) {
    return '<span class="home-card-fall">' + letter + "</span>";
  }
  function hvImg(src, favUrl) {
    return '<img class="home-card-img" src="' + escapeAttr(src) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"' +
      (favUrl ? ' onerror="this.onerror=null;this.src=\'' + escapeAttr(favUrl) + '\'"' : ' onerror="this.onerror=null;this.remove()"') + '>';
  }
  function homeCard(attr, key, title, meta, art) {
    return '<button class="home-card" data-' + attr + '="' + escapeAttr(key) + '">' +
      '<span class="home-card-art">' + art + '</span>' +
      '<span class="home-card-txt"><span class="home-card-title">' + title + '</span>' +
      '<span class="home-card-meta">' + meta + "</span></span></button>";
  }

  function renderHome() {
    var g = $("#home-stat-games");
    var s = $("#home-stat-sites");
    var t = $("#home-stat-tools");
    var f = $("#home-stat-favs");
    if (g) g.textContent = (DATA.games || []).length;
    if (s) s.textContent = (DATA.sites || []).length;
    if (t) t.textContent = (DATA["apps-tools"] || []).length;
    if (f) f.textContent = Object.keys(state.favs || {}).length;

    renderRecents();

    /* Featured banner - Minecraft James Edition, always front and center so
       it stays one click away on Home. */
    var featured = $("#home-featured");
    if (featured) {
      featured.innerHTML =
        '<button class="home-featured" data-featured-mc>' +
        '<span class="home-featured-img"><img src="' + escapeAttr(MC_KEY_ART) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src=' + JSON.stringify(MC_FEAT_MARK) + '"></span>' +
        '<span class="home-featured-body">' +
        '<span class="home-featured-eyebrow">Play now &middot; Eaglercraft 26.2</span>' +
        '<span class="home-featured-title">Minecraft James Edition</span>' +
        '<span class="home-featured-desc">Survival, creative, and your friends&rsquo; servers on one self-hosted build. Runs in its own tab.</span>' +
        '<span class="home-featured-cta">Launch</span>' +
        "</span></button>";
      featured.querySelector("[data-featured-mc]").addEventListener("click", function () {
        openJamesEdition("Minecraft James Edition");
      });
    }

    var popularBox = $("#home-popular-games");
    if (popularBox) {
      var games = (DATA.games || []).slice().filter(Boolean).sort(function (a, b) {
        var ak = gameKey(a);
        var bk = gameKey(b);
        var aScore = (state.clicks[ak] || 0) * 2 + (state.favs[ak] ? 5 : 0);
        var bScore = (state.clicks[bk] || 0) * 2 + (state.favs[bk] ? 5 : 0);
        return bScore - aScore;
      }).slice(0, 6);
      popularBox.innerHTML = games.map(function (item) {
        var title = escapeHtml(item.title || "Untitled");
        var key = item._id || gameKey(item);
        var art = (item.thumb && !isLocalFileUrl(item.thumb))
          ? hvFallback(escapeHtml((item.title || "?").charAt(0).toUpperCase() || "?")) + hvImg(item.thumb, "")
          : hvFallback(escapeHtml((item.title || "?").charAt(0).toUpperCase() || "?"));
        return homeCard("home-game", key, title, escapeHtml(item.porter ? "PC port" : (item.category || "Game")), art);
      }).join("");
      popularBox.querySelectorAll("[data-home-game]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          setView("games");
          state.query = "";
          if (els.search) els.search.value = "";
          var key = btn.dataset.homeGame;
          var item = games.find(function (x) { return (x._id || gameKey(x)) === key; });
          if (item && window.ChalkleLaunch) {
            if (isJamesEdition(item)) {
              openJamesEdition(item.title || "Minecraft James Edition");
              return;
            }
            if (item.directOnly && window.ChalkleLaunch.openProxyApp) {
              window.ChalkleLaunch.openProxyApp(item.url || "", item.title || "");
              return;
            }
            if (item.html && window.ChalkleLaunch.htmlUrl) {
              window.ChalkleLaunch.open(window.ChalkleLaunch.htmlUrl(item.html), item.title || "");
            } else if (item.url && window.ChalkleLaunch.isFetchableHtml && window.ChalkleLaunch.isFetchableHtml(item.url)) {
              window.ChalkleLaunch.openFetched(item.url, item.title || "");
            } else {
              window.ChalkleLaunch.open(item.url || "", item.title || "");
            }
          }
        });
      });
    }

    var recBox = $("#home-youtube-recs");
    if (recBox) {
      recBox.innerHTML = '<div class="home-recs-loading">Loading trending videos&hellip;</div>';
      if (window.ChalkleFeaturedVideos) {
        window.ChalkleFeaturedVideos().then(function (tracks) {
          if (!tracks || tracks.length === 0) {
            recBox.innerHTML = '<div class="home-recs-loading">No videos right now - check the YouTube tab.</div>';
            return;
          }
          recBox.innerHTML = tracks.map(function (t) {
            var title = escapeHtml(t.title || "Untitled");
            var artist = escapeHtml(t.artist || "");
            var art = t.cover
              ? hvFallback(escapeHtml((t.title || "?").charAt(0).toUpperCase() || "?")) + hvImg(t.cover, "")
              : hvFallback(escapeHtml((t.title || "?").charAt(0).toUpperCase() || "?"));
            return homeCard("home-video", String(t.id), title, artist, art);
          }).join("");
          recBox.querySelectorAll("[data-home-video]").forEach(function (btn) {
            btn.addEventListener("click", function () {
              var id = btn.dataset.homeVideo;
              var track = tracks.find(function (x) { return x.id === id; });
              if (!track) return;
              setView("music");
              setTimeout(function () {
                if (window.ChalkleOpenVideo) window.ChalkleOpenVideo(track);
              }, 0);
            });
          });
        }).catch(function () {
          recBox.innerHTML = '<div class="home-recs-loading">Couldn\u2019t load videos - check the YouTube tab.</div>';
        });
      } else {
        recBox.innerHTML = "";
      }
    }
  }

  function updateEmptyState() {
    var empty = $("games-empty");
    if (!empty || state.view !== "games") return;
    var title = empty.querySelector(".empty-title");
    var hint = empty.querySelector(".empty-hint");
    if (!title || !hint) return;
    if (state.query) {
      title.textContent = "No games found.";
      hint.textContent = "Try a shorter search or switch filters.";
    } else if (state.gameFilter === "favorites") {
      title.textContent = "No favorites yet.";
      hint.textContent = "Tap the star on a game to save it here.";
    } else if (state.gameFilter === "ports") {
      title.textContent = "No PC ports found.";
      hint.textContent = "Switch back to All games.";
    } else if (state.gameFilter === "new") {
      title.textContent = "Nothing new right now.";
      hint.textContent = "Use All games for the full library.";
    } else {
      title.textContent = "This cabinet is empty.";
      hint.textContent = "Add real entries to games.js and they show up here.";
    }
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* Local file paths can never load on a hosted site - and Chrome logs a
     security error the moment a file:/// URL lands in the DOM (even as an
     unclicked <a href>). Treat file: URLs as "no link": render them as # and
     block launches, so a stray saved path can't trigger
     "Content at … may not load or link to file:///." */
  function isLocalFileUrl(u) {
    return /^(file:|javascript:)/i.test(String(u || "").trim());
  }

  function safeHref(u) {
    return isLocalFileUrl(u) ? "#" : escapeAttr(u || "");
  }

  function escapeAttr(s) {
    return escapeHtml(String(s));
  }

  /* Shared non-blank fallback thumbnail. It is deterministic per item, so
     repeated missing art still has a deliberate identity instead of a raw
     stock image or a black square. */
  function chalkFallbackSvg(label, seed) {
    var palette = ["#34a853", "#4285f4", "#e60073", "#26c6da", "#fb8c00", "#a970ff"];
    var n = 0;
    String(seed || label || "chalkle").split("").forEach(function (c) { n = (n * 31 + c.charCodeAt(0)) >>> 0; });
    var color = palette[n % palette.length];
    var letter = String(label || "?").trim().charAt(0).toUpperCase() || "?";
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
      '<rect width="128" height="128" fill="#15181d"/>' +
      '<path d="M0 96L32 64l24 20 22-28 50 44v28H0z" fill="' + color + '" opacity=".24"/>' +
      '<circle cx="98" cy="28" r="14" fill="' + color + '" opacity=".35"/>' +
      '<text x="64" y="80" text-anchor="middle" font-family="system-ui,sans-serif" font-size="52" font-weight="800" fill="' + color + '">' + letter + '</text>' +
      '</svg>';
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function fallbackThumb(label, seed) {
    return chalkFallbackSvg(label, seed);
  }


  /* ---------- Sidebar ---------- */

  function applyCollapsed() {
    document.body.classList.toggle("sidebar-collapsed", state.collapsed);
    var btn = $("#collapse-btn");
    if (btn) {
      btn.setAttribute("aria-label", state.collapsed ? "Expand sidebar" : "Collapse sidebar");
      var lbl = btn.querySelector(".nav-label");
      if (lbl) lbl.textContent = state.collapsed ? "Expand" : "Collapse";
    }
  }

  function toggleSidebar() {
    var open = document.body.classList.toggle("sidebar-open");
    $("#hamburger").setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeSidebar() {
    document.body.classList.remove("sidebar-open");
    $("#hamburger").setAttribute("aria-expanded", "false");
  }

  /* ---------- Options ---------- */

  function applyOptions() {
    document.documentElement.classList.toggle("motion-off", state.motion);
    document.body.classList.toggle("size-compact", state.size === "compact");

    var motion = $("#opt-motion");
    if (motion) motion.checked = state.motion;

    document.querySelectorAll(".seg-btn").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.dataset.size === state.size);
    });
  }

  function renderGameStats(visibleCount) {
    var all = (DATA.games || []).filter(Boolean);
    var ports = all.filter(function (item) { return !!item.porter; }).length;
    var favs = all.filter(function (item) { return !!state.favs[gameKey(item)]; }).length;
    var clicks = Object.keys(state.clicks || {}).reduce(function (sum, key) {
      return sum + (Number(state.clicks[key]) || 0);
    }, 0);
    var values = {
      "stat-games": visibleCount == null ? all.length : visibleCount,
      "stat-ports": ports,
      "stat-favs": favs,
      "stat-clicks": clicks
    };
    Object.keys(values).forEach(function (id) {
      var el = $(id);
      if (el) el.textContent = formatCount(values[id]);
    });
  }

  /* ---------- Genre / tag filters ----------
     Each game card carries a category chip. We collect every distinct
     category (dropping the noise: generic "Web" / "Game") into filter chips
     so you can browse by type. Selections are multi-select and persist. */

  function itemCategory(item) {
    if (!item) return "";
    var c = String(item.category || "").trim();
    if (!c) c = item.porter ? "PC Port" : "Web";
    return c;
  }

  function allGenres() {
    var seen = {};
    var out = [];
    (DATA.games || []).forEach(function (g) {
      if (!g) return;
      var c = itemCategory(g);
      if (seen[c]) return;
      seen[c] = 1;
      out.push(c);
    });
    return out;
  }

  function toggleGenre(cat) {
    var list = state.genreFilters.slice();
    var i = list.indexOf(cat);
    if (i === -1) list.push(cat);
    else list.splice(i, 1);
    state.genreFilters = list;
    render();
  }

  function renderGenreChips() {
    var box = $("#genre-filters");
    if (!box) return;
    var genres = allGenres();
    if (!genres.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML =
      '<button class="chip" data-genre-all>All</button>' +
      genres
        .map(function (c) {
          return '<button class="chip' + (state.genreFilters.indexOf(c) !== -1 ? " is-active" : "") + '" data-genre="' + escapeAttr(c) + '">' + escapeHtml(c) + "</button>";
        })
        .join("");
    box.querySelectorAll(".chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var cat = btn.dataset.genre;
        if (cat === undefined) {
          state.genreFilters = [];
          render();
        } else {
          toggleGenre(cat);
        }
      });
    });
  }

  /* ---------- Recently played ----------
     Remember the last few games you launched so the homepage can offer a
     quick "continue where you left off" row (and "Popular games" stays
     all-time favorites). */

  function findAnyItem(key) {
    var lists = [DATA.games, DATA.sites, DATA["apps-tools"]];
    for (var i = 0; i < lists.length; i++) {
      var arr = lists[i] || [];
      for (var j = 0; j < arr.length; j++) {
        var it = arr[j];
        if (it && (it._id || gameKey(it)) === key) return it;
      }
    }
    return null;
  }

  function trackRecent(key, title) {
    var list = readJson(RECENTS_KEY, []);
    var rec = list.filter(function (r) { return r && r.key !== key; });
    /* Snapshot the item (thumb/url/html) at launch time so the row keeps real
       art and stays relaunchable even if the game is renamed or removed. */
    var item = findAnyItem(key);
    rec.unshift({
      key: key,
      title: String(title || ""),
      t: Date.now(),
      thumb: item ? item.thumb : undefined,
      url: item ? item.url : undefined,
      html: item ? item.html : undefined
    });
    rec = rec.slice(0, 8);
    persist(RECENTS_KEY, JSON.stringify(rec));
  }

  function norm(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function findAnyByTitle(title) {
    var want = norm(title);
    var lists = [DATA.games, DATA.sites, DATA["apps-tools"]];
    for (var i = 0; i < lists.length; i++) {
      var arr = lists[i] || [];
      for (var j = 0; j < arr.length; j++) {
        var it = arr[j];
        if (it && it.title && norm(it.title) === want) return it;
      }
    }
    return null;
  }

  function recentGames() {
    var list = readJson(RECENTS_KEY, []);
    if (!list.length) return [];
    return list.map(function (r) {
      if (!r) return null;
      /* Key match across games, sites AND apps/tools, so recents can be any of
         them, and old entries saved before snapshots need this to resolve. */
      var item = findAnyItem(r.key);
      if (item) return item;
      /* Old recents saved only {key,title}: if the item was renamed or the key
         changed, fall back to a title match so the row still finds the live
         item and shows its real art instead of a placeholder. */
      if (r.title) {
        item = findAnyByTitle(r.title);
        if (item) return item;
      }
      /* Ghost: renamed/removed item, keep the launch snapshot so it still
         shows real art and stays relaunchable. */
      return { title: r.title, _ghost: true, thumb: r.thumb, url: r.url, html: r.html };
    }).filter(Boolean);
  }

  function renderRecents() {
    var box = $("#home-recents");
    if (!box) return;
    var recents = recentGames();
    if (!recents.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML =
      '<div class="home-recents-head"><h2 class="home-recents-title">Continue playing</h2>' +
      '<div class="home-recents-actions">' +
      '<button class="home-recents-arrow" data-recents-prev aria-label="Scroll back"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>' +
      '<button class="home-recents-arrow" data-recents-next aria-label="Scroll forward"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>' +
      '<button class="home-recents-clear">Clear</button></div></div>' +
      '<div class="home-recents-scroll"><div class="home-recents-track">' +
      recents
        .slice(0, 6)
        .map(function (item) {
          var title = escapeHtml(item.title || "Untitled");
          var letter = escapeHtml((item.title || "?").charAt(0).toUpperCase() || "?");
          /* Favicon chain (same as game cards): if the real thumbnail fails,
             swap to the site's real favicon before the placeholder shows. */
          var favUrl = "";
          try {
            var host = item.url ? new URL(item.url).hostname.replace(/^www\./, "") : "";
            if (host) favUrl = "https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=" + encodeURIComponent("https://" + host) + "&size=128";
          } catch (e) { /* bad url */ }
          var art;
          if (item.thumb && !isLocalFileUrl(item.thumb)) {
            art = hvFallback(letter) + hvImg(item.thumb, favUrl);
          } else if (favUrl) {
            art = hvFallback(letter) + hvImg(favUrl, "");
          } else {
            art = hvFallback(letter);
          }
          return homeCard("home-game", item._id || gameKey(item), title, "Continue", art);
        })
        .join("") +
      '</div></div>';
    box.querySelectorAll("[data-home-game]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.dataset.homeGame;
        var item = recents.find(function (x) { return (x._id || gameKey(x)) === key; });
        if (item && window.ChalkleLaunch) {
          if (isJamesEdition(item)) { openJamesEdition(item.title || "Minecraft James Edition"); return; }
          if (item.directOnly && window.ChalkleLaunch.openProxyApp) {
            window.ChalkleLaunch.openProxyApp(item.url || "", item.title || "");
            return;
          }
          if (item.html && window.ChalkleLaunch.htmlUrl) {
            window.ChalkleLaunch.open(window.ChalkleLaunch.htmlUrl(item.html), item.title || "");
          } else if (item.url && window.ChalkleLaunch.isFetchableHtml && window.ChalkleLaunch.isFetchableHtml(item.url)) {
            window.ChalkleLaunch.openFetched(item.url, item.title || "");
          } else {
            window.ChalkleLaunch.open(item.url || "", item.title || "");
          }
        }
      });
    });
    var track = box.querySelector(".home-recents-track");
    var prev = box.querySelector("[data-recents-prev]");
    var next = box.querySelector("[data-recents-next]");
    function updateArrows() {
      if (!track || !prev || !next) return;
      var max = track.scrollWidth - track.clientWidth - 4;
      prev.disabled = track.scrollLeft <= 4;
      next.disabled = track.scrollLeft >= max;
    }
    if (track) {
      track.addEventListener("scroll", updateArrows, { passive: true });
      if (prev) prev.addEventListener("click", function () { track.scrollBy({ left: -track.clientWidth * 0.8, behavior: "smooth" }); });
      if (next) next.addEventListener("click", function () { track.scrollBy({ left: track.clientWidth * 0.8, behavior: "smooth" }); });
      window.setTimeout(updateArrows, 60);
    }
    var clearBtn = box.querySelector(".home-recents-clear");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      persist(RECENTS_KEY, JSON.stringify([]));
      renderHome();
    });
  }

  /* ---------- Tab cloak: disguise the whole tab as a school site ---------- */

  var CLOAK_KEY = "chalkle-cloak";
  var cloakIcon = null;

  var CLOAKS = [
    { id: "google", name: "Google", title: "Google", icon: "https://www.google.com/favicon.ico" },
    { id: "classroom", name: "Classroom", title: "Classes", icon: "https://ssl.gstatic.com/classroom/ic_product_classroom_32.png" },
    { id: "docs", name: "Google Docs", title: "Untitled document - Google Docs", icon: "https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico" },
    { id: "drive", name: "Drive", title: "My Drive - Google Drive", icon: "https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png" },
    { id: "canvas", name: "Canvas", title: "Dashboard", icon: "https://du11hjcvx0uqb.cloudfront.net/dist/images/favicon.ico" },
    { id: "clever", name: "Clever", title: "Clever | Portal", icon: "https://www.clever.com/wp-content/uploads/2023/06/cropped-Favicon-512px-32x32.png" },
    { id: "khan", name: "Khan Academy", title: "Dashboard | Khan Academy", icon: "https://www.khanacademy.org/favicon.ico" }
  ];

  /* Capture the real favicon href once, at first apply, so "None" restores it. */
  function captureCloakIcon() {
    if (cloakIcon) return;
    var link = document.querySelector('link[rel="icon"]');
    cloakIcon = link ? link.getAttribute("href") : "";
  }

  function applyCloak(id) {
    captureCloakIcon();
    var cloak = null;
    for (var i = 0; i < CLOAKS.length; i++) {
      if (CLOAKS[i].id === id) { cloak = CLOAKS[i]; break; }
    }
    var activeId = cloak ? cloak.id : "";
    document.title = cloak ? cloak.title : "Chalkle";
    var link = document.querySelector('link[rel="icon"]');
    if (link) link.href = cloak ? cloak.icon : cloakIcon;
    try { localStorage.setItem(CLOAK_KEY, activeId); } catch (e) { /* no storage */ }
    document.querySelectorAll("[data-cloak]").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.dataset.cloak === activeId);
    });
  }

  function renderCloaks() {
    var grid = $("#cloak-grid");
    if (!grid) return;
    grid.innerHTML = [{ id: "", name: "None" }].concat(CLOAKS)
      .map(function (c) {
        var iconHtml = c.icon
          ? '<img class="cloak-ico" src="' + escapeAttr(c.icon) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">'
          : '<span class="cloak-ico cloak-ico-none" aria-hidden="true">&#10005;</span>';
        return '<button class="cloak-btn" data-cloak="' + c.id + '" title="' + escapeAttr(c.title) + '">' +
          iconHtml + '<span class="cloak-label">' + escapeHtml(c.name) + "</span></button>";
      })
      .join("");
    grid.querySelectorAll("[data-cloak]").forEach(function (btn) {
      btn.addEventListener("click", function () { applyCloak(btn.dataset.cloak); });
    });
  }

  window.ChalkleCloak = { apply: applyCloak };

  /* ---------- Admin panel ----------
     Locked behind a code. Lets you add / edit / delete games, sites, tools
     and proxies - each game or site can be a link (URL) and/or raw HTML code,
     and anything launches through the normal direct / about:blank / blob /
     iframe picker. All changes persist to this device. */

  var ADMIN_CODE = "jamesypoo";
  var ADMIN_TABS = ["games", "sites", "tools", "proxies", "board", "docs", "partners"];

  /* ---------- The Board (data-driven) ---------- */

  var BOARD_COLS = ["Owners", "Admins", "VIPS"];

  function boardMemberHTML(m) {
    var name = escapeHtml(m.title || "Untitled");
    var letter = escapeHtml(String(m.title || "?").trim().charAt(0).toUpperCase() || "?");
    var avatar;
    var thumb = m.thumb && !isLocalFileUrl(m.thumb) ? String(m.thumb).trim() : "";
    if (thumb) {
      avatar =
        '<div class="board-pfp has-img"><img class="board-pfp-img" src="' + escapeAttr(thumb) +
        '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-letter="' + escapeAttr(letter) +
        '" onerror="var p=this.parentNode;p.classList.remove(\'has-img\');p.classList.add(\'img-failed-letter\');p.textContent=this.dataset.letter||\'?\';"></div>';
    } else {
      avatar = '<div class="board-pfp">' + letter + "</div>";
    }
    return '<article class="board-person">' + avatar + '<div class="board-name">' + name + "</div></article>";
  }

  function renderBoard() {
    var root = document.querySelector(".board-columns");
    if (!root) return;
    var members = (DATA.board || []).filter(Boolean);
    root.innerHTML = BOARD_COLS.map(function (col) {
      var inCol = members.filter(function (m) { return String(m.category || "").trim() === col; });
      var body = inCol.length
        ? '<div class="board-members">' + inCol.map(boardMemberHTML).join("") + "</div>"
        : '<div class="board-empty">Open spots</div>';
      return '<section class="board-col"><h2>' + col + "</h2>" + body + "</section>";
    }).join("");
  }
  var UNLOCK_KEY = "chalkle-admin-unlocked";
  var adminEditing = {};   /* tab -> _id or null */
  var adminUnlocked = false;
  function adminRemembered() {
    try { return localStorage.getItem(UNLOCK_KEY) === "1"; } catch (e) { return false; }
  }

  function adminItems(tab) {
    if (tab === "proxies") return state.proxies;
    if (tab === "board") return DATA.board;
    return DATA[TAB_DATA[tab]] || [];
  }

  function adminSave(tab, arr) {
    if (tab === "proxies") {
      state.proxies = arr;
      saveProxies();
      renderProxies();
      return;
    }
    saveLib(tab, arr);
    DATA[TAB_DATA[tab]] = arr;
    if (tab === "board") { renderBoard(); return; }
    render();
  }

  function adminListHTML(tab) {
    var list = adminItems(tab);
    if (!list.length) return '<p class="empty-hint">Nothing here yet.</p>';
    var rows = list.map(function (it) {
      if (!it) return "";
      var name = escapeHtml(it.title || it.name || "Untitled");
      var kind = it.html && String(it.html).trim() ? "html" : (it.url ? "link" : "empty");
      var sub = tab === "board" ? "" : String((it.category || it.url || "") || "");
      var tag;
      if (tab === "board") {
        tag = (it.thumb && String(it.thumb).trim())
          ? '<span class="admin-tag">photo</span>'
          : '<span class="admin-tag is-empty">letter badge</span>';
        sub = String(it.category || "");
      } else {
        tag = kind === "html" ? '<span class="admin-tag is-html">HTML</span>' : (kind === "link" ? '<span class="admin-tag">link</span>' : '<span class="admin-tag is-empty">no source</span>');
      }
      return (
        '<div class="admin-row">' +
        '<div class="admin-row-main">' +
        '<div class="admin-row-title"><span class="admin-row-name">' + name + "</span>" + tag + "</div>" +
        '<div class="admin-row-sub">' + escapeHtml(sub) + "</div>" +
        "</div>" +
        '<div class="admin-row-actions">' +
        '<button class="btn-ghost" data-admin-edit="' + escapeAttr(it._id) + '" data-tab="' + tab + '">Edit</button>' +
        '<button class="btn-ghost danger" data-admin-del="' + escapeAttr(it._id) + '" data-tab="' + tab + '">Delete</button>' +
        "</div>" +
        "</div>"
      );
    }).join("");
    return '<div class="admin-list">' + rows + "</div>";
  }

  function adminSheetHTML(tab) {
    var editingId = adminEditing[tab] || null;
    var eItem = null;
    if (editingId) eItem = (adminItems(tab) || []).find(function (x) { return x && x._id === editingId; }) || null;

    if (tab === "board") {
      var bv = eItem || { title: "", category: "Owners", thumb: "" };
      var roles = ["Owners", "Admins", "VIPS"].map(function (r) {
        return '<option value="' + r + '"' + ((bv.category || "Owners") === r ? " selected" : "") + ">" + r + "</option>";
      }).join("");
      var form =
        '<form class="admin-form" data-admin-form="board">' +
        '<div class="field-stack">' +
        '<input class="field field-name" name="title" placeholder="Member name (required)" value="' + escapeAttr(bv.title) + '" required>' +
        '<div class="form-row">' +
        '<select class="field field-cat" name="category">' + roles + "</select>" +
        '<input class="field" name="thumb" placeholder="Portrait image link (optional, leave for letter badge)" value="' + escapeAttr(bv.thumb || "") + '" spellcheck="false">' +
        "</div>" +
        '<div class="form-row admin-submit-row">' +
        '<span class="admin-spacer"></span>' +
        '<button class="btn" type="submit">' + (eItem ? "Save changes" : "Add") + "</button>" +
        (eItem ? '<button class="btn-ghost" type="button" data-admin-cancel>Cancel</button>' : '<button class="btn-ghost" type="button" data-admin-clear>Clear</button>') +
        "</div>" +
        "</div></form>";
      return form + adminListHTML(tab);
    }

    if (tab === "proxies") {
      var pv = eItem || { name: "", url: "", mode: "tab" };
      var pform =
        '<form class="admin-form" data-admin-form="proxies">' +
        '<div class="form-row">' +
        '<input class="field field-name" name="name" placeholder="Name" value="' + escapeAttr(pv.name) + '" required>' +
        '<input class="field field-url" name="url" placeholder="Proxy URL (https://…)" value="' + escapeAttr(pv.url) + '" spellcheck="false" required>' +
        '<select class="field field-mode" name="mode">' +
        '<option value="tab"' + (pv.mode !== "frame" ? " selected" : "") + '>New tab</option>' +
        '<option value="frame"' + (pv.mode === "frame" ? " selected" : "") + '>In-app</option>' +
        "</select>" +
        '<button class="btn" type="submit">' + (eItem ? "Save" : "Add") + "</button>" +
        "</div></form>";
      return pform + adminListHTML(tab);
    }

    var cats = ["PC Port", "Web", "Action", "Puzzle", "Racing", "Sports", "Retro", "Multiplayer", "HTML Code"];
    var dl = "admin-cats-" + tab;
    var form =
      '<form class="admin-form" data-admin-form="' + tab + '">' +
      '<div class="field-stack">' +
      '<input class="field field-name" name="title" placeholder="Title (required)" value="' + escapeAttr(eItem ? eItem.title : "") + '" required>' +
      '<input class="field" name="url" placeholder="Link &rsaquo; https://game.com" value="' + escapeAttr(eItem ? eItem.url : "") + '" spellcheck="false">' +
      '<textarea class="field field-textarea" name="html" placeholder="&hellip;or paste HTML / code here - opens in about:blank, blob or this tab" spellcheck="false">' + escapeHtml(eItem && eItem.html ? eItem.html : "") + "</textarea>" +
      '<div class="form-row">' +
      '<input class="field" name="thumb" placeholder="Thumbnail image link (optional)" value="' + escapeAttr(eItem ? eItem.thumb : "") + '" spellcheck="false">' +
      '<input class="field field-cat" name="category" list="' + dl + '" placeholder="Category (PC Port, Web&hellip;)" value="' + escapeAttr(eItem ? eItem.category : "") + '">' +
      '<datalist id="' + dl + '">' + cats.map(function (c) { return '<option value="' + escapeHtml(c) + '">'; }).join("") + "</datalist>" +
      "</div>" +
      '<div class="form-row admin-submit-row">' +
      '<label class="admin-check"><input type="checkbox" name="isNew"' + (eItem && eItem.isNew ? " checked" : "") + '> Mark as new</label>' +
      '<span class="admin-spacer"></span>' +
      '<button class="btn" type="submit">' + (eItem ? "Save changes" : "Add") + "</button>" +
      (eItem ? '<button class="btn-ghost" type="button" data-admin-cancel>Cancel</button>' : '<button class="btn-ghost" type="button" data-admin-clear>Clear</button>') +
      "</div>" +
      "</div></form>";
    return form + adminListHTML(tab);
  }

  function adminRenderSheet(tab) {
    var node = $("#admin-sheet-" + tab);
    if (node) node.innerHTML = adminSheetHTML(tab);
  }

  function adminRenderAll() {
    ADMIN_TABS.forEach(adminRenderSheet);
  }

  function adminFormValues(scopeEl) {
    function val(n, fb) { var e = scopeEl.querySelector('[name="' + n + '"]'); return e ? (e.value !== undefined ? e.value : fb) : fb; }
    function chk(n) { var e = scopeEl.querySelector('[name="' + n + '"]'); return !!(e && e.checked); }
    return {
      title: val("title", ""), name: val("name", ""),
      url: String(val("url", "") || "").trim(),
      html: val("html", ""),
      thumb: String(val("thumb", "") || "").trim(),
      category: String(val("category", "") || "").trim(),
      mode: val("mode", "tab"), isNew: chk("isNew")
    };
  }

  function handleAdminSubmit(e, form) {
    e.preventDefault();
    var tab = form.getAttribute("data-admin-form");
    var editingId = adminEditing[tab] || null;
    var arr = adminItems(tab);
    var existing = null;
    if (editingId) existing = arr.find(function (x) { return x && x._id === editingId; });
    var v = adminFormValues(form);

    if (tab === "board") {
      if (!v.title.trim()) return;
      if (existing) { existing.title = v.title.trim(); existing.category = v.category || "Owners"; existing.thumb = v.thumb; }
      else arr.push({ _id: "member-" + (++__idCounter), title: v.title.trim(), category: v.category || "Owners", thumb: v.thumb });
      adminEditing[tab] = null;
      adminSave(tab, arr);
      adminRenderAll();
      return;
    }

    if (tab === "proxies") {
      if (!v.name.trim() || !v.url) return;
      if (existing) { existing.name = v.name.trim(); existing.url = v.url; existing.mode = v.mode; }
      else arr.push({ _id: "proxy-" + (++__idCounter), name: v.name.trim(), url: v.url, mode: v.mode });
      adminEditing[tab] = null;
      adminSave(tab, arr);
      adminRenderAll();
      return;
    }

    if (!v.title.trim()) return;
    if (!v.url && !v.html.trim()) { alert("Give this a link or some HTML code."); return; }
    var isPort = v.category.toLowerCase() === "pc port";
    if (existing) {
      existing.title = v.title.trim();
      existing.url = v.url;
      existing.html = v.html.trim() ? v.html : "";
      existing.thumb = v.thumb;
      existing.category = v.category;
      existing.isNew = v.isNew;
      if (isPort) existing.porter = existing.porter || "you";
    } else {
      arr.push({
        _id: "item-" + (++__idCounter),
        title: v.title.trim(),
        url: v.url,
        html: v.html.trim() ? v.html : "",
        thumb: v.thumb,
        category: v.category,
        isNew: v.isNew,
        porter: isPort ? "you" : undefined
      });
    }
    adminEditing[tab] = null;
    adminSave(tab, arr);
    adminRenderAll();
  }

  function handleAdminDelete(id, tab) {
    var arr = adminItems(tab).filter(function (x) { return !(x && x._id === id); });
    adminEditing[tab] = null;
    adminSave(tab, arr);
    adminRenderAll();
  }

  function handleAdminEdit(id, tab) {
    adminEditing[tab] = id;
    adminRenderSheet(tab);
  }

  function openAdmin() {
    var modal = $("#admin-modal");
    if (!modal) return;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    var gate = $("#admin-gate");
    var body = $("#admin-body");
    if (adminUnlocked) {
      if (gate) gate.hidden = true;
      if (body) body.hidden = false;
      adminRenderAll();
    } else {
      adminEditing = {};
      var code = $("#admin-code");
      if (code) setTimeout(function () { code.focus(); }, 40);
    }
  }

  function closeAdmin() {
    var modal = $("#admin-modal");
    if (modal) modal.hidden = true;
    document.body.style.overflow = "";
    var code = $("#admin-code");
    if (code) code.value = "";
  }

  function tryUnlock(val) {
    if (String(val) === ADMIN_CODE) {
      adminUnlocked = true;
      var remember = $("#admin-remember");
      try {
        if (remember && remember.checked) localStorage.setItem(UNLOCK_KEY, "1");
      } catch (e) { /* no storage */ }
      var gate = $("#admin-gate");
      var body = $("#admin-body");
      if (gate) gate.hidden = true;
      if (body) body.hidden = false;
      adminRenderAll();
      if (window.ChalkleDocs && window.ChalkleDocs.applyAdminUI) window.ChalkleDocs.applyAdminUI();
      if (window.ChalklePartners && window.ChalklePartners.applyAdminUI) window.ChalklePartners.applyAdminUI();
      if (window.ChalkleLiveTV && window.ChalkleLiveTV.applyAdminUI) window.ChalkleLiveTV.applyAdminUI();
      return true;
    }
    return false;
  }

  function adminSetTab(tab) {
    document.querySelectorAll("[data-admin-tab]").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.dataset.adminTab === tab);
    });
    document.querySelectorAll("[data-admin-panel]").forEach(function (panel) {
      panel.hidden = panel.dataset.adminPanel !== tab;
    });
    /* Keep the Docs / Partners admin lists live whenever their panel is shown
       so edits to existing entries show up without a reload. */
    if (tab === "docs" && window.ChalkleDocs && window.ChalkleDocs.refreshAdminList) {
      window.ChalkleDocs.refreshAdminList();
    }
    if (tab === "partners" && window.ChalklePartners && window.ChalklePartners.refreshAdminList) {
      window.ChalklePartners.refreshAdminList();
    }
    if (tab === "livetv" && window.ChalkleLiveTV && window.ChalkleLiveTV.refreshAdminList) {
      window.ChalkleLiveTV.refreshAdminList();
    }
  }

  /* ---------- Wire up ---------- */

  /* Clock options, read live from localStorage so toggling a setting
     immediately reshapes the top-bar time. */
  function clockPref(k, dflt) {
    try {
      var v = localStorage.getItem(k);
      return v === null ? dflt : (v === "1");
    } catch (e) { return dflt; }
  }

  function applyClockPrefs() {
    var timeEl = $("clock-time");
    if (!timeEl) return;
    timeEl.classList.toggle("c-military", clockPref("chalkle-clock-military", false));
    timeEl.classList.toggle("no-h", !clockPref("chalkle-clock-h", true));
    timeEl.classList.toggle("no-m", !clockPref("chalkle-clock-m", true));
    timeEl.classList.toggle("no-s", !clockPref("chalkle-clock-s", true));
  }

  /* Live clock: 12-hour or military (setting), Boogaloo numerals matching
     the wordmark. Ticks every second and hysteresis-drops the seconds part. */
  function startClock() {
    var timeEl = $("clock-time");
    var ampmEl = $("clock-ampm");
    if (!timeEl) return;
    /* The clock is cosmetic. Wrap every tick so a scripting hiccup here can
       never bubble up and abort init() (which would silently unbind the tab
       clicks). Unknown pref keys or stale bundles just skip a frame. */
    function tick() {
      try {
        applyClockPrefs();
        var now = new Date();
        var h = now.getHours();
        var m = now.getMinutes();
        var s = now.getSeconds();
        var ampm = h >= 12 ? "PM" : "AM";
        var h12 = h % 12 || 12;
        var pad = function (n) { return (n < 10 ? "0" : "") + n; };
        var out = "";
        var showH = clockPref("chalkle-clock-h", true);
        var showM = clockPref("chalkle-clock-m", true);
        var showS = clockPref("chalkle-clock-s", true);
        if (showH) out += (clockPref("chalkle-clock-military", false) ? pad(h) : h12);
        if (showM) {
          if (out) out += ":";
          out += pad(m);
        }
        if (showS) {
          if (out) out += ":";
          out += pad(s);
        }
        timeEl.textContent = out || "--:--";
        if (ampmEl) ampmEl.textContent = (!clockPref("chalkle-clock-military", false) && showH) ? ampm : "";
      } catch (e) { /* ignore: clock is non-critical */ }
    }
    tick();
    setInterval(tick, 1000);
    window.__chalkleClockTick = tick;
  }

  function init() {
    els.search = $("#search-input");
    els.hamburger = $("#hamburger");
    els.collapse = $("#collapse-btn");
    els.backdrop = $("#backdrop");
    /* Clock must never block the rest of init (nav binds happen below). */
    try { startClock(); } catch (e) { /* non-critical */ }

    document.querySelectorAll(".chalkle-logo").forEach(function (el) {
      el.innerHTML = buildLogo();
    });

    /* Bubble-letter section titles: each title wears ONE color - the same
       color as its sidebar tab (Games=green, Sites=blue, YouTube=red, …). */
    var TITLE_COLORS = {
      games: ["#34a853", "#0d7734"],
      cloud: ["#b7e63f", "#7f9f14"],
      sites: ["#4285f4", "#1557b0"],
      music: ["#e60073", "#8c003d"],
      "apps-tools": ["#fbbc05", "#e37400"],
      proxies: ["#12b5a5", "#0a7f74"],
      settings: ["#a970ff", "#7a3fd0"],
      board: ["#fb8c00", "#c25e00"],
      docs: ["#6ec6ff", "#1a6b9e"],
      partners: ["#d8a368", "#8a5a24"],
      home: ["#ff4d8d", "#c2185b"],
      livetv: ["#4ab88c", "#1f7a5c"],
      youtube: ["#ff0033", "#b30024"]
    };
    document.querySelectorAll(".view-title").forEach(function (el) {
      var label = (el.textContent || "").trim();
      if (!label) return;
      var view = "";
      var v = el.closest(".view");
      if (v) view = v.getAttribute("data-view") || "";
      var pair = TITLE_COLORS[view] || TITLE_COLORS.games;
      el.innerHTML = bubbleTitle(label, pair[0], pair[1]);
    });

    applyCollapsed();
    applyOptions();
    syncProxies();

    /* One-time cleanup: genre filters used to persist and could leave the
       Games tab stuck on a tiny subset across reloads. They're session-only
       now; remove any stale saved selection. */
    try { localStorage.removeItem("chalkle-game-genre-filters"); } catch (e) { /* no storage */ }

    /* The More button toggles the overflow panel; panels inside it are real
       nav items (data-view) and ride the normal nav click path below. */
    var moreBtn = document.getElementById("nav-more-btn");
    var morePanel = document.getElementById("nav-more");
    if (moreBtn && morePanel) {
      moreBtn.addEventListener("click", function () {
        /* More folds into the sidebar. When the sidebar is a 64px rail the
           panel opens as an icon-only column inside it (CSS hides the labels
           in collapsed mode), so it never forces the sidebar back open. */
        var open = morePanel.classList.toggle("is-open");
        /* The panel must not keep its [hidden] attribute or the global
           [hidden]{display:none!important} rule beats .is-open's flex. */
        morePanel.hidden = !open;
        moreBtn.classList.toggle("is-open", open);
        moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }
    document.addEventListener("click", function (e) {
      if (!morePanel || !morePanel.classList.contains("is-open")) return;
      if (moreBtn.contains(e.target)) return;
      if (morePanel.contains(e.target)) return;
      closeMoreNav();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeMoreNav();
    });

    document.querySelectorAll(".nav-item").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var view = btn.dataset.view;
        if (!view) return; /* the More toggle has no data-view */
        setView(view);
        closeSidebar();
      });
    });

    /* Jump back in: the headline quick cards stay on the hero, the rest fold
       into the All tabs dropdown so a growing tab list never stacks the hero
       into a wall of tiles. */
    var quickMoreBtn = document.getElementById("home-quick-more-btn");
    var quickMenu = document.getElementById("home-quick-menu");
    if (quickMoreBtn && quickMenu) {
      quickMoreBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        var open = quickMenu.hidden;
        quickMenu.hidden = !open;
        quickMoreBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });
      document.addEventListener("click", function (e) {
        if (quickMenu.hidden) return;
        if (e.target && (quickMoreBtn.contains(e.target) || quickMenu.contains(e.target))) return;
        quickMenu.hidden = true;
        quickMoreBtn.setAttribute("aria-expanded", "false");
      });
      document.addEventListener("keydown", function (e) {
        if (e.key !== "Escape") return;
        quickMenu.hidden = true;
        quickMoreBtn.setAttribute("aria-expanded", "false");
      });
    }

    document.querySelectorAll("[data-home-go]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setView(btn.dataset.homeGo);
        /* A tab picked from the All tabs menu: close it after navigating. */
        if (quickMenu && !quickMenu.hidden) {
          quickMenu.hidden = true;
          if (quickMoreBtn) quickMoreBtn.setAttribute("aria-expanded", "false");
        }
      });
    });

    document.querySelectorAll("[data-game-filter]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.gameFilter = btn.dataset.gameFilter || "all";
        document.querySelectorAll("[data-game-filter]").forEach(function (item) {
          item.classList.toggle("is-active", item === btn);
        });
        render();
      });
    });

    if (els.search) {
      els.search.addEventListener("input", function () {
        var q = els.search.value.trim();
        /* Global search: show a dropdown of matches across Games / Sites /
           Apps-Tools. Typing never switches the view on its own. */
        clearTimeout(musicSearchDebounce);
        musicSearchDebounce = setTimeout(function () {
          renderSearchResults(q);
        }, 110);
      });
      els.search.addEventListener("keydown", function (e) {
        var box = $("#search-results");
        var open = box && !box.hidden;
        if (e.key === "Escape") {
          closeSearchResults();
          return;
        }
        if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          moveSearchFocus(e.key === "ArrowDown" ? 1 : -1);
          return;
        }
        if (e.key === "Enter") {
          if (open && searchFocusIdx >= 0) {
            e.preventDefault();
            commitSearchFocus();
          }
        }
      });
    }

    /* Clicking away from the search closes the dropdown. */
    document.addEventListener("click", function (e) {
      var box = $("#search-results");
      if (!box || box.hidden) return;
      if (e.target && (els.search && els.search.contains(e.target))) return;
      if (box.contains(e.target)) return;
      closeSearchResults();
    });

    if (els.collapse) {
      els.collapse.addEventListener("click", function () {
        state.collapsed = !state.collapsed;
        persist("chalkle-collapsed", state.collapsed ? "1" : "0");
        applyCollapsed();
      });
    }

    if (els.hamburger) {
      els.hamburger.addEventListener("click", toggleSidebar);
    }

    if (els.backdrop) {
      els.backdrop.addEventListener("click", closeSidebar);
    }

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (!$("#admin-modal").hidden) closeAdmin();
        else if (!$("#blanktab-modal").hidden && window.ChalkleBlankTab) window.ChalkleBlankTab.close();
        else if (!$("#editor-modal").hidden && window.ChalkleEditor) window.ChalkleEditor.close();
        else if (!$("#urlauditor-modal").hidden && window.ChalkleUrlAuditor) window.ChalkleUrlAuditor.close();
        else if (!$("#pixel-modal").hidden && window.ChalklePixel) window.ChalklePixel.close();
        else if (!$("#domainhub-modal").hidden && window.ChalkleDomainHub) window.ChalkleDomainHub.close();
        else if (!$("#proxy-overlay").hidden) closeOverlay();
        else closeSidebar();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        if (state.view === "music") {
          var mq = document.getElementById("music-q");
          if (mq) mq.focus();
        } else if (els.search) {
          els.search.focus();
        }
        return;
      }

      /* Space toggles music playback when nothing else is focused. */
      if (e.code === "Space" && !e.ctrlKey && !e.metaKey && !e.altKey && e.target === document.body) {
        if (window.ChalklePlayer && window.ChalklePlayer.active()) {
          e.preventDefault();
          window.ChalklePlayer.toggle();
        }
      }

      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        var view = { "1": "home", "2": "games", "3": "music", "4": "apps-tools", "5": "proxies", "6": "board", "7": "settings" }[e.key];
        if (view) {
          e.preventDefault();
          setView(view);
        }
      }
    });

    /* Tab cloak presets */

    renderCloaks();
    var savedCloak = "";
    try { savedCloak = localStorage.getItem(CLOAK_KEY) || ""; } catch (e) { /* no storage */ }
    applyCloak(savedCloak);

    /* Settings: launch defaults + cloak title */

    var ask = $("#opt-ask");
    if (ask) {
      try { ask.checked = localStorage.getItem("chalkle-ask") !== "0"; } catch (e) { /* no storage */ }
      ask.addEventListener("change", function () {
        try { localStorage.setItem("chalkle-ask", ask.checked ? "1" : "0"); } catch (e) { /* no storage */ }
      });
    }

    var defMode = $("#opt-default-mode");
    if (defMode) {
      try { defMode.value = localStorage.getItem("chalkle-launch-mode") || "ask"; } catch (e) { /* no storage */ }
      defMode.addEventListener("change", function () {
        try { localStorage.setItem("chalkle-launch-mode", defMode.value); } catch (e) { /* no storage */ }
      });
    }

    var cloakTitle = $("#opt-cloak-title");
    if (cloakTitle) {
      try { cloakTitle.value = localStorage.getItem("chalkle-cloak-title") || "Classes"; } catch (e) { /* no storage */ }
      cloakTitle.addEventListener("input", function () {
        var v = cloakTitle.value.trim();
        try { localStorage.setItem("chalkle-cloak-title", v || "Classes"); } catch (e) { /* no storage */ }
      });
    }

    /* Settings options */

    /* Collapsible settings panels. Open state persists per panel. */
    var SETTINGS_OPEN_KEY = "chalkle-settings-open-v1";
    function settingsOpenMap() {
      try { return JSON.parse(localStorage.getItem(SETTINGS_OPEN_KEY) || "{}"); }
      catch (e) { return {}; }
    }
    document.querySelectorAll(".settings-panel").forEach(function (panel) {
      var toggle = panel.querySelector(".settings-toggle");
      var body = panel.querySelector(".settings-body");
      if (!toggle || !body) return;
      var key = panel.dataset.settingsPanel;
      var openMap = settingsOpenMap();
      var isOpen = openMap[key] !== undefined ? !!openMap[key] : toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
      body.hidden = !isOpen;
      panel.classList.toggle("is-open", isOpen);
      toggle.addEventListener("click", function () {
        var next = body.hidden;
        body.hidden = !next;
        panel.classList.toggle("is-open", next);
        toggle.setAttribute("aria-expanded", next ? "true" : "false");
        var m = settingsOpenMap();
        m[key] = next;
        try { localStorage.setItem(SETTINGS_OPEN_KEY, JSON.stringify(m)); } catch (e) { /* full */ }
      });
    });

    /* Keyboard: arrow up/down moves between section headers, Enter toggles. */
    var settingsToggles = Array.prototype.slice.call(document.querySelectorAll(".settings-toggle"));
    settingsToggles.forEach(function (tog, idx) {
      tog.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          var step = e.key === "ArrowDown" ? 1 : -1;
          var next = settingsToggles[(idx + step + settingsToggles.length) % settingsToggles.length];
          if (next) next.focus();
        }
      });
    });

    /* Advanced group: live count chip + debug info. */
    function refreshAdvancedSummary() {
      var chip = $("#settings-adv-count");
      if (chip) {
        var n = (state.proxies ? state.proxies.length : 0) + (state.favs ? Object.keys(state.favs).length : 0);
        chip.textContent = n + " saved";
      }
      var box = $("#debug-info");
      if (box) {
        var keys = [];
        var bytes = 0;
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf("chalkle") === 0) {
            keys.push(k);
            try { bytes += (k.length + (localStorage.getItem(k) || "").length) * 2; } catch (e) { /* noop */ }
          }
        }
        var kb = (bytes / 1024).toFixed(1);
        box.innerHTML =
          '<div class="debug-row"><span>Settings keys</span><b>' + keys.length + '</b></div>' +
          '<div class="debug-row"><span>Storage used</span><b>' + kb + ' KB</b></div>' +
          '<div class="debug-row"><span>Saved proxies</span><b>' + (state.proxies ? state.proxies.length : 0) + '</b></div>' +
          '<div class="debug-row"><span>Favorites</span><b>' + (state.favs ? Object.keys(state.favs).length : 0) + '</b></div>';
      }
    }
    refreshAdvancedSummary();

    /* Cloud chip: show configured / offline in the collapsed header. */
    function refreshCloudStatus() {
      var chip = $("#cloud-cfg-status");
      if (!chip) return;
      try {
        var cfg = JSON.parse(localStorage.getItem("chalkle-cloud-cfg-v1") || "{}");
        chip.textContent = cfg.base ? "configured" : "offline";
        chip.classList.toggle("is-on", !!cfg.base);
      } catch (e) { chip.textContent = "offline"; }
    }
    refreshCloudStatus();

    /* Export: download every chalkle-* key as JSON. */
    var exportBtn = $("#opt-export");
    if (exportBtn) {
      exportBtn.addEventListener("click", function () {
        var data = {};
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf("chalkle") === 0) data[k] = localStorage.getItem(k);
        }
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "chalkle-settings.json";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 800);
      });
    }

    /* Import: restore chalkle-* keys from a JSON file, then reload. */
    var importBtn = $("#opt-import");
    var importFile = $("#opt-import-file");
    if (importBtn && importFile) {
      importBtn.addEventListener("click", function () { importFile.click(); });
      importFile.addEventListener("change", function () {
        var f = importFile.files && importFile.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var data = JSON.parse(reader.result);
            var count = 0;
            for (var k in data) {
              if (Object.prototype.hasOwnProperty.call(data, k) && k.indexOf("chalkle") === 0) {
                try { localStorage.setItem(k, String(data[k])); count++; } catch (e) { /* full */ }
              }
            }
            if (count > 0) { location.reload(); return; }
            alert("No Chalkle settings found in that file.");
          } catch (e) {
            alert("That file is not a valid settings backup.");
          }
        };
        reader.readAsText(f);
        importFile.value = "";
      });
    }

    /* Reset: wipe all chalkle-* keys. */
    var resetBtn = $("#opt-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        if (!confirm("Reset everything saved on this device? This clears favorites, recents, settings, and proxies.")) return;
        var gone = [];
        for (var i = localStorage.length - 1; i >= 0; i--) {
          var k = localStorage.key(i);
          if (k && k.indexOf("chalkle") === 0) { gone.push(k); localStorage.removeItem(k); }
        }
        location.reload();
      });
    }

    /* "Make it yours": expand Appearance and scroll to it. */
    var makeYours = $("#opt-make-yours");
    if (makeYours) {
      makeYours.addEventListener("click", function () {
        var appPanel = document.querySelector('[data-settings-panel="appearance"]');
        if (!appPanel) return;
        var body = appPanel.querySelector(".settings-body");
        if (body && body.hidden) {
          body.hidden = false;
          appPanel.classList.add("is-open");
          var tog = appPanel.querySelector(".settings-toggle");
          if (tog) tog.setAttribute("aria-expanded", "true");
          var m = settingsOpenMap();
          m.appearance = true;
          try { localStorage.setItem(SETTINGS_OPEN_KEY, JSON.stringify(m)); } catch (e) { /* full */ }
        }
        appPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    var motion = $("#opt-motion");
    if (motion) {
      motion.addEventListener("change", function () {
        state.motion = motion.checked;
        persist("chalkle-motion", state.motion ? "1" : "0");
        applyOptions();
      });
    }

    document.querySelectorAll(".seg-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.size = btn.dataset.size;
        persist("chalkle-size", state.size);
        applyOptions();
      });
    });

    /* Clock display options (24h + which parts to show). */
    ["opt-clock-military", "opt-clock-h", "opt-clock-m", "opt-clock-s"].forEach(function (id) {
      var box = $(id);
      if (!box) return;
      var keys = {
        "opt-clock-military": "chalkle-clock-military",
        "opt-clock-h": "chalkle-clock-h",
        "opt-clock-m": "chalkle-clock-m",
        "opt-clock-s": "chalkle-clock-s"
      };
      var dflt = id === "opt-clock-military" ? false : true;
      try {
        box.checked = localStorage.getItem(keys[id]) === null ? dflt : localStorage.getItem(keys[id]) === "1";
      } catch (e) {}
      box.addEventListener("change", function () {
        persist(keys[id], box.checked ? "1" : "0");
        applyClockPrefs();
        if (window.__chalkleClockTick) window.__chalkleClockTick();
      });
    });

    /* Appearance: custom theme, wallpapers, cursors (see theme.js). */

    var T = window.ChalkleTheme;
    if (T) {
      var themeBg = $("#opt-theme-bg");
      var themeAccent = $("#opt-theme-accent");
      var themeReset = $("#opt-theme-reset");
      var wallpaperGrid = $("#wallpaper-grid");
      var wallpaperUrl = $("#opt-wallpaper-url");
      var wallpaperApply = $("#opt-wallpaper-apply");
      var cursorGrid = $("#cursor-grid");

      function computedHex(varName, fallback) {
        var val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
        return /^#[0-9a-f]{6}$/i.test(val) ? val : fallback;
      }

      var existingCustom = T.getCustom();
      if (themeBg) themeBg.value = (existingCustom && existingCustom.bg) || computedHex("--base", "#0d0f12");
      if (themeAccent) themeAccent.value = (existingCustom && existingCustom.accent) || computedHex("--accent", "#34a853");

      function applyCustomFromInputs() {
        T.setCustom(themeBg.value, themeAccent.value);
      }

      if (themeBg) themeBg.addEventListener("input", applyCustomFromInputs);
      if (themeAccent) themeAccent.addEventListener("input", applyCustomFromInputs);

      if (themeReset) {
        themeReset.addEventListener("click", function () {
          T.resetCustom();
          T.resetPreset();
          if (themeBg) themeBg.value = computedHex("--base", "#0d0f12");
          if (themeAccent) themeAccent.value = computedHex("--accent", "#34a853");
          if (typeof renderPresetGrid === "function") renderPresetGrid();
        });
      }

      function renderWallpaperGrid() {
        if (!wallpaperGrid) return;
        var current = T.getWallpaper();
        wallpaperGrid.innerHTML = "";
        Object.keys(T.wallpapers).forEach(function (id) {
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "wallpaper-swatch" + (current === id ? " is-active" : "");
          btn.style.backgroundImage = T.wallpapers[id];
          btn.title = id;
          btn.setAttribute("aria-label", "Wallpaper " + id);
          btn.addEventListener("click", function () {
            T.setWallpaper(id);
            savedWallpaper = id; /* undo reverts to this */
            renderWallpaperGrid();
          });
          wallpaperGrid.appendChild(btn);
        });
      }

      renderWallpaperGrid();

      if (wallpaperUrl) {
        var curWall = T.getWallpaper();
        if (curWall.indexOf("custom:") === 0) wallpaperUrl.value = curWall.slice(7);
      }

      /* Live preview: typing a URL shows it instantly (debounced); Apply
         saves it. Undo reverts to whatever was saved before this edit. */
      var savedWallpaper = T.getWallpaper();
      var previewTimer = null;

      function previewWallpaper(value) {
        if (!value) return;
        var css;
        if (/^(https?:|data:|blob:)/i.test(value)) {
          css = "url('" + value.replace(/'/g, "%27") + "')";
        } else if (T.wallpapers[value]) {
          css = T.wallpapers[value];
        } else {
          return;
        }
        document.documentElement.style.setProperty("--wallpaper-image", css);
        document.documentElement.style.setProperty("--wallpaper-scrim", value === "chalk" ? "0" : "0.45");
      }

      if (wallpaperUrl) {
        wallpaperUrl.addEventListener("input", function () {
          var url = wallpaperUrl.value.trim();
          clearTimeout(previewTimer);
          previewTimer = setTimeout(function () { previewWallpaper(url); }, 250);
        });
      }

      if (wallpaperApply) {
        wallpaperApply.addEventListener("click", function () {
          var url = (wallpaperUrl ? wallpaperUrl.value : "").trim();
          if (!url) return;
          savedWallpaper = T.getWallpaper();
          T.setWallpaper("custom:" + url);
          renderWallpaperGrid();
        });
      }

      /* Undo: restore the wallpaper that was saved before the last change. */
      var undoWallpaper = $("#opt-wallpaper-undo");
      if (undoWallpaper) {
        undoWallpaper.addEventListener("click", function () {
          T.setWallpaper(savedWallpaper);
          if (wallpaperUrl) {
            wallpaperUrl.value = savedWallpaper.indexOf("custom:") === 0 ? savedWallpaper.slice(7) : "";
          }
          renderWallpaperGrid();
        });
      }

      function renderCursorGrid() {
        if (!cursorGrid) return;
        var current = T.getCursor();
        cursorGrid.innerHTML = "";
        Object.keys(T.cursors).forEach(function (id) {
          var cursor = T.cursors[id];
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "cursor-swatch" + (current === id ? " is-active" : "");
          var art = cursor.preview
            ? '<img src="' + escapeAttr(cursor.preview) + '" alt="" loading="lazy" decoding="async">'
            : '<span class="cursor-none-ico" aria-hidden="true">&#10005;</span>';
          btn.innerHTML = art + "<span>" + escapeHtml(cursor.label) + "</span>";
          btn.addEventListener("click", function () {
            T.setCursor(id);
            renderCursorGrid();
          });
          cursorGrid.appendChild(btn);
        });
      }

      renderCursorGrid();

      /* One-click theme presets (bg + accent together, from the Interstellar /
         catppuccin palettes). Clicking a preset applies it and updates the
         color pickers so they stay in sync. */
      var presetGrid = $("#preset-grid");
      if (presetGrid && T.presets) {
        function renderPresetGrid() {
          presetGrid.innerHTML = "";
          var active = T.getPreset();
          Object.keys(T.presets).forEach(function (id) {
            var p = T.presets[id];
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "preset-swatch" + (active === id ? " is-active" : "");
            btn.title = p.label;
            btn.setAttribute("aria-label", "Theme " + p.label);
            btn.innerHTML =
              '<span class="preset-dot" style="background:' + p.bg + '"></span>' +
              '<span class="preset-dot is-accent" style="background:' + p.accent + '"></span>' +
              "<span>" + escapeHtml(p.label) + "</span>";
            btn.addEventListener("click", function () {
              T.setPreset(id);
              if (themeBg) themeBg.value = p.bg;
              if (themeAccent) themeAccent.value = p.accent;
              renderPresetGrid();
            });
            presetGrid.appendChild(btn);
          });
        }
        renderPresetGrid();
      }
    }

    var sort = $("#game-sort");
    if (sort) {
      sort.value = state.sort;
      sort.addEventListener("change", function () {
        state.sort = sort.value;
        persist(SORT_KEY, state.sort);
        render();
      });
    }

    var sitesSort = $("#sites-sort");
    if (sitesSort) {
      sitesSort.value = state.sitesSort;
      sitesSort.addEventListener("change", function () {
        state.sitesSort = sitesSort.value;
        render();
      });
    }

    var clearProxies = $("#opt-clear");
    if (clearProxies) {
      clearProxies.addEventListener("click", function () {
        if (!confirm("Remove all saved proxies from this device?")) return;
        state.proxies = [];
        saveProxies();
        renderProxies();
      });
    }

    /* Proxy form */

    var form = $("#proxy-form");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var name = $("#proxy-name").value.trim();
        var url = $("#proxy-url").value.trim();
        var mode = $("#proxy-mode").value;
        if (!name || !url) return;

        if (url.indexOf("://") === -1) {
          url = "https://" + url;
        }

        state.proxies.push({ _id: "proxy-" + (++__idCounter), name: name, url: url, mode: mode });
        saveProxies();
        $("#proxy-name").value = "";
        $("#proxy-url").value = "";
        renderProxies();
      });
    }

    /* Proxy card buttons (event delegation) */

    var main = $("#main");
    if (main) {
      main.addEventListener("click", function (e) {
        /* Built-in app tiles (Blank tab launcher, HTML Editor) open their modal. */
        var toolKind = e.target.closest("[data-tool-kind]");
        if (toolKind) {
          e.preventDefault();
          if (toolKind.dataset.toolKind === "launcher" && window.ChalkleBlankTab) window.ChalkleBlankTab.open();
          else if (toolKind.dataset.toolKind === "editor" && window.ChalkleEditor) window.ChalkleEditor.open();
          else if (toolKind.dataset.toolKind === "urlauditor" && window.ChalkleUrlAuditor) window.ChalkleUrlAuditor.open();
          else if (toolKind.dataset.toolKind === "pixel" && window.ChalklePixel) window.ChalklePixel.open();
          else if (toolKind.dataset.toolKind === "domainhub" && window.ChalkleDomainHub) window.ChalkleDomainHub.open();
          else if (toolKind.dataset.toolKind === "iphone16" && window.ChalkleLaunch) {
            var ipTile = toolKind.closest(".tool-tile");
            ipTileClick(ipTile);
          }
          return;
        }

        /* Proxy apps (TikTok, Discord, …) route their real URL through the
           configured proxy, then hand the proxied page to the launch picker so
           every method (in-app iframe, about:blank cloak, blob, new tab) works. */
        var proxyApp = e.target.closest("[data-proxy-app]");
        if (proxyApp && window.ChalkleLaunch) {
          e.preventDefault();
          var paTarget = proxyApp.dataset.proxyApp || "";
          var proxies =
            (typeof window.ChalkleGetProxies === "function" && window.ChalkleGetProxies()) ||
            window.ChalkleProxies || window.ChalkProxies || [];
          var liveProxy = null;
          for (var pi = 0; pi < proxies.length; pi++) {
            if (proxies[pi] && proxies[pi].url) { liveProxy = proxies[pi]; break; }
          }
          var tileTitle = proxyApp.querySelector(".tool-tile-title");
          var paTitle = tileTitle ? tileTitle.textContent : "";
          if (!liveProxy) {
            alert("No proxy configured. Add your proxy in the Proxies tab first (e.g. your Ultraviolet or Scramjet host), then this app will route through it.");
            setView("proxies");
            return;
          }
          if (window.ChalkleLaunch.openProxyApp) {
            window.ChalkleLaunch.openProxyApp(paTarget, paTitle);
          } else {
            window.ChalkleLaunch.open(window.ChalkleLaunch.routeProxy(paTarget, liveProxy.url, liveProxy.mode === "frame" || !!liveProxy.hashRoute), paTitle);
          }
          return;
        }

        /* "How to open" button - always shows the method menu (about:blank,
           blob, this tab, proxy) even when a default mode is saved. */
        var openWith = e.target.closest("[data-open-with]");
        if (openWith && window.ChalkleLaunch) {
          /* Always show the method picker (Direct / Data URL / About:blank /
             Blob / This tab / Proxy) for every card, including sites. The
             proxied route is one of the options inside the picker. */
          e.preventDefault();
          window.ChalkleLaunch.openWithOptions(openWith.dataset.url || "", openWith.dataset.title || "");
          return;
        }

        var fav = e.target.closest("[data-fav]");
        if (fav) {
          var favKey = fav.dataset.fav;
          if (state.favs[favKey]) delete state.favs[favKey];
          else state.favs[favKey] = 1;
          persist(FAVS_KEY, JSON.stringify(state.favs));
          render();
          /* Pop the freshly rendered heart for feedback. */
          var fresh = document.querySelector('[data-fav="' + CSS.escape(favKey) + '"]');
          if (fresh) {
            fresh.classList.add("pop");
            setTimeout(function () { fresh.classList.remove("pop"); }, 380);
          }
          return;
        }

        var launch = e.target.closest("[data-launch]");
        if (launch && window.ChalkleLaunch) {
          e.preventDefault();
          var cardEl = launch.closest(".game-card");
          if (cardEl) {
            cardEl.classList.add("launch-pop");
            setTimeout(function () {
              cardEl.classList.remove("launch-pop");
            }, 340);
          }
          var key = gameKey({ url: launch.dataset.url, title: launch.dataset.title });
          state.clicks[key] = (state.clicks[key] || 0) + 1;
          persist(COUNTS_KEY, JSON.stringify(state.clicks));
          trackRecent(key, launch.dataset.title || "");
          if (state.view === "games" || state.view === "sites") render();
          var launchUrl = "";
          if (launch.dataset.html && window.ChalkleLaunch.htmlUrl) {
            /* Inline HTML (e.g. Ruffle-wrapped games) always wins - it runs
               as a local blob, so there is no link to block. */
            launchUrl = window.ChalkleLaunch.htmlUrl(launch.dataset.html);
          }
          if (!launchUrl) launchUrl = launch.dataset.url || "";
          if (isLocalFileUrl(launchUrl)) {
            alert("That item points to a local file (" + launchUrl + ") - local paths can't open on the hosted site. Edit it in Admin and set a web URL instead.");
            return;
          }
          if (isJamesEdition(launchUrl)) {
            openJamesEdition(launch.dataset.title || "Minecraft James Edition");
            return;
          }
          if (launch.dataset.directOnly && window.ChalkleLaunch.openProxyApp) {
            /* Unity WebGL etc. must run on a real origin - the /uv/ proxy IS
               one (this same site) and rewrites CDN refs, so route directOnly
               items through it instead of the raw blockable host. */
            window.ChalkleLaunch.openProxyApp(launchUrl, launch.dataset.title || "");
            return;
          }
          if (launchUrl) {
            /* Always open through the launcher picker (about:blank / Blob / Direct / iframe / Proxy)
               so users can choose their preferred unblocked launch method for any game or site. */
            window.ChalkleLaunch.openWithOptions(launchUrl, launch.dataset.title || launchUrl);
          }
          return;
        }

        var open = e.target.closest("[data-proxy-open]");
        if (open) {
          openProxy(parseInt(open.dataset.proxyOpen, 10));
          return;
        }

        var set = e.target.closest("[data-proxy-set]");
        if (set) {
          var i = parseInt(set.dataset.proxySet, 10);
          var url = prompt("Proxy URL for " + state.proxies[i].name + ":", state.proxies[i].url || "");
          if (url === null) return;
          url = url.trim();
          if (!url) return;
          if (url.indexOf("://") === -1) url = "https://" + url;
          state.proxies[i].url = url;
          saveProxies();
          renderProxies();
        }
      });
    }

    var back = $("#overlay-back");
    if (back) back.addEventListener("click", closeOverlay);

    var overlay = $("#proxy-overlay");
    if (overlay) {
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) closeOverlay();
      });
    }

    var ext = $("#overlay-ext");
    if (ext) {
      ext.addEventListener("click", function () {
        var url = currentProxy && currentProxy.url;
        /* Launcher-opened games (in-app frame) have no currentProxy - pop
           out whatever URL the launcher is showing instead. */
        if (!url && window.ChalkleLaunch && window.ChalkleLaunch.lastOpenUrl) {
          url = window.ChalkleLaunch.lastOpenUrl;
        }
        closeOverlay();
        if (url) window.open(url, "_blank", "noopener");
      });
    }

    /* ---------- Admin wiring ---------- */

    var adminModal = $("#admin-modal");
    if (adminModal) {
      if (adminRemembered()) {
        adminUnlocked = true;
        adminEditing = {};
        if (window.ChalkleDocs && window.ChalkleDocs.applyAdminUI) window.ChalkleDocs.applyAdminUI();
        if (window.ChalklePartners && window.ChalklePartners.applyAdminUI) window.ChalklePartners.applyAdminUI();
      }
      var optAdmin = $("#opt-admin");
      if (optAdmin) optAdmin.addEventListener("click", openAdmin);

      /* Empty-state CTAs: give every dead end a way forward. */
      var gamesCta = $("#games-empty-cta");
      if (gamesCta) {
        gamesCta.addEventListener("click", function () {
          state.query = "";
          state.gameFilter = "all";
          if (els.search) els.search.value = "";
          document.querySelectorAll("[data-game-filter]").forEach(function (item) {
            item.classList.toggle("is-active", item.dataset.gameFilter === "all");
          });
          render();
        });
      }
      var sitesCta = $("#sites-empty-cta");
      if (sitesCta) sitesCta.addEventListener("click", openAdmin);
      var musicCta = $("#music-empty-cta");
      if (musicCta) {
        musicCta.addEventListener("click", function () {
          if (window.ChalkleMusic && window.ChalkleMusic.retry) window.ChalkleMusic.retry();
        });
      }

      adminModal.querySelectorAll("[data-admin-close]").forEach(function (el) {
        el.addEventListener("click", function (e) {
          if (e.target === el || el.tagName === "BUTTON") closeAdmin();
        });
      });

      var lockForm = $("#admin-lock-form");
      if (lockForm) {
        lockForm.addEventListener("submit", function (e) {
          e.preventDefault();
          var code = $("#admin-code");
          if (code && tryUnlock(code.value)) { code.value = ""; }
          else {
            var card = adminModal.querySelector(".admin-card");
            if (card) { card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake"); }
            if (code) code.select();
          }
        });
      }

      document.querySelectorAll("[data-admin-tab]").forEach(function (btn) {
        btn.addEventListener("click", function () { adminSetTab(btn.dataset.adminTab); });
      });

      /* Docs + Partners live entirely inside the admin menu: hook their
         upload/add controls here so a regular user never sees them. */
      var adminDocsFile = $("#admin-docs-file");
      if (adminDocsFile) {
        adminDocsFile.addEventListener("change", function () {
          if (adminDocsFile.files && adminDocsFile.files.length && window.ChalkleDocs && window.ChalkleDocs.handleFiles) {
            window.ChalkleDocs.handleFiles(adminDocsFile.files);
          }
          adminDocsFile.value = "";
        });
      }
      var adminDocsNew = $("#admin-docs-new");
      if (adminDocsNew && window.ChalkleDocs && window.ChalkleDocs.newDoc) {
        adminDocsNew.addEventListener("click", function () { window.ChalkleDocs.newDoc(); });
      }
      var adminPartnersAdd = $("#admin-partners-add");
      if (adminPartnersAdd && window.ChalklePartners && window.ChalklePartners.addPartner) {
        adminPartnersAdd.addEventListener("click", function () { window.ChalklePartners.addPartner(); });
      }
      var adminLivetvAdd = $("#admin-livetv-add");
      if (adminLivetvAdd && window.ChalkleLiveTV && window.ChalkleLiveTV.addChannel) {
        adminLivetvAdd.addEventListener("click", function () { window.ChalkleLiveTV.addChannel(); });
      }

      var adminBody = $("#admin-body");
      if (adminBody) {
        adminBody.addEventListener("submit", function (e) {
          var form = e.target.closest("[data-admin-form]");
          if (form) handleAdminSubmit(e, form);
        });
        adminBody.addEventListener("click", function (e) {
          var del = e.target.closest("[data-admin-del]");
          if (del) { handleAdminDelete(del.dataset.adminDel, del.dataset.tab); return; }
          var ed = e.target.closest("[data-admin-edit]");
          if (ed) { handleAdminEdit(ed.dataset.adminEdit, ed.dataset.tab); return; }
          var cancel = e.target.closest("[data-admin-cancel]");
          if (cancel) { renderSheetsForForm(cancel); return; }
          var clear = e.target.closest("[data-admin-clear]");
          if (clear) { var f = clear.closest("[data-admin-form]"); if (f) { adminEditing[f.getAttribute("data-admin-form")] = null; f.reset(); adminRenderSheet(f.getAttribute("data-admin-form")); } return; }
        });
      }
    }

    renderBoard();
    render();
  }

  function renderSheetsForForm(cancelBtn) {
    var f = cancelBtn.closest("[data-admin-form]");
    if (f) adminEditing[f.getAttribute("data-admin-form")] = null;
    adminRenderAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

/* Live viewer pill: pings the same-origin /_active endpoint every few seconds
   to keep this tab marked "online" and shows how many people are on right now.
   Isolated so a failure can never break the rest of the app. */
(function () {
  function bootViewer() {
    var pill = document.getElementById("viewer-pill");
    if (!pill) return;
    var countEl = document.getElementById("viewer-count");
    if (!countEl) return;
    var vid = "";
    try { vid = localStorage.getItem("chalkle_visitor") || ""; } catch (e) {}
    if (!vid) {
      vid = "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
      try { localStorage.setItem("chalkle_visitor", vid); } catch (e) {}
    }
    var fails = 0;
    var lastN = -1;
    var flashTimer = null;
    function ping() {
      fetch("/_active?s=" + encodeURIComponent(vid || "anon"), { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var n = (d && typeof d.active === "number") ? d.active : 0;
          fails = 0;
          pill.hidden = false;
          if (n !== lastN) {
            lastN = n;
            countEl.textContent = String(n);
            /* Small pop on every change so movement is visible in real time. */
            countEl.classList.remove("is-pop");
            void countEl.offsetWidth; /* restart the animation */
            countEl.classList.add("is-pop");
            clearTimeout(flashTimer);
            flashTimer = setTimeout(function () { countEl.classList.remove("is-pop"); }, 420);
          }
        })
        .catch(function () {
          fails++;
          if (fails >= 2) pill.hidden = true;
        });
    }
    ping();
    /* ~4s keeps it feeling live (matches the server's prune cadence) while
       staying light for the cloudflare tunnel. */
    setInterval(ping, 4000);
    /* Wake up immediately when the tab comes back, don't wait for the tick. */
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") ping();
    });
    window.addEventListener("online", ping);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootViewer);
  else bootViewer();
})();
