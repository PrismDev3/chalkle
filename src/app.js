/* Chalkle. Keep this file framework-free so it runs anywhere, even offline. */

(function () {
  "use strict";

  /* Diagnostics error ring: catch uncaught errors + rejections so Settings
     can show what actually went wrong instead of a silent blank page. */
  if (window.ChalkleCore && window.ChalkleCore.installErrorCapture) {
    window.ChalkleCore.installErrorCapture();
  }

  /* Build stamp. The ?v= on this very script tag is the only reliable way to
     tell which build a browser is running: versioned src URLs are served from
     the service worker cache after the first visit, so an un-bumped token can
     keep serving an old copy forever. Printing it in the sidebar footer turns
     "am I stale?" from a mystery into something you can read. */
  (function () {
    try {
      var tag = document.currentScript;
      if (!tag || !/\/app\.js/.test(tag.src || "")) {
        tag = null;
        for (var i = document.scripts.length - 1; i >= 0; i--) {
          if (/\/app\.js(\?|$)/.test(document.scripts[i].src || "")) { tag = document.scripts[i]; break; }
        }
      }
      var m = tag && String(tag.src || "").match(/[?&]v=([^&]+)/);
      if (!m) return;
      var label = document.querySelector(".side-foot-txt");
      if (label) label.textContent = "CHALKLE v1.1 \u00B7 " + m[1];
    } catch (e) { /* a missing stamp is cosmetic */ }
  })();

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
        var community = Array.isArray(window.ChalkCommunityGames) ? window.ChalkCommunityGames.slice() : [];
        /* Real in-game captures (assets/games/real/*.jpg) beat generated SVG
           covers for local builds. Swap the thumb at seed time when the URL
           stem has a capture, so every card and the library sync pick it up. */
        var realShots = window.ChalkRealShots || [];
        var realExt = window.ChalkRealShotExt || {};
        var realSet = {};
        realShots.forEach(function (s) { realSet[s] = true; });
        /* game-covers.js: the same idea for games that never got a capture -
           a hand-picked cover image keyed by normalised title. Titles are
           folded to letters and digits, so "Bloons TD 5" and "bloons-td-5"
           are one key and a cover cannot miss on punctuation alone. */
        var covers = window.ChalkGameCovers || {};
        var coverKey = function (title) {
          return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
        };
        var withRealArt = function (g) {
          var copy = Object.assign({}, g);
          if (copy.thumb && /^data:image\//i.test(String(copy.thumb))) {
            var m = /^\/(?:ugs|mc|gn)\/([^/]+)\.html$/i.exec(String(copy.url || ""));
            if (m && realSet[m[1]]) {
              /* Most captures are JPEGs. Some games were saved as WebP, which
                 is smaller for the same frame; those files were sitting on
                 disk unreferenced until the extension travelled with the
                 slug here. */
              copy.thumb = "/assets/games/real/" + encodeURIComponent(m[1]) +
                "." + (realExt[m[1]] || "jpg");
            } else {
              /* A real capture wins over a published cover: one is the game
                 actually running, the other is marketing art. */
              var cover = covers[coverKey(copy.title)];
              if (cover) copy.thumb = cover;
            }
          }
          return copy;
        };
        return ports
          .map(withRealArt)
          .concat((Array.isArray(window.ChalkGames) ? window.ChalkGames : []).map(withRealArt), community,
            (Array.isArray(window.ChalkNoahGames) ? window.ChalkNoahGames : []).map(withRealArt));
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
          { title: "James Brown", category: "Owners", role: "Founder", bio: "Started Chalkle. Handles the servers, the games, and the endless feature requests." },
          { title: "Ian Magadan", category: "Owners", role: "Co-founder", bio: "Builds the tools and keeps the community running. Message him for board spots." }
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
    /* Static mirrors don't serve the gitignored local-only folders
       (game-builds/, mc/, flare/, PS1), so root-absolute launch URLs and
       thumbs into them 404 there (cdn.jsdelivr.net/game-builds/...). Re-point
       those at the production relay (same helper the launcher uses). No-op
       on the real site. */
    try {
      if (window.ChalkleApi && window.ChalkleApi.localUrl) {
        (["url", "thumb"]).forEach(function (f) {
          if (typeof it[f] === "string") it[f] = window.ChalkleApi.localUrl(it[f]);
        });
      }
    } catch (e) { /* keep the original paths */ }
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
    /* Titles the admin deleted (see saveLib). loadLib re-seeds by title, so
       without this the removed entries would come straight back on reload.
       The del-set is computed once up front: the seed merge below must skip
       deleted titles too, or a deleted seed item would be re-added to the
       merged list, then dropped from the del-key by the saveLib diff. */
    function getDelSet() {
      var dels = [];
      try {
        var delRaw = localStorage.getItem(conf.key + "-del");
        if (delRaw) { var d = JSON.parse(delRaw); if (Array.isArray(d)) dels = d; }
      } catch (e) { /* corrupt */ }
      var set = {};
      dels.forEach(function (t) { set[t] = true; });
      return set;
    }
    var delSet = getDelSet();
    function applyDeletions(list) {
      if (!Object.keys(delSet).length) return list;
      return list.filter(function (it) { return !(it && it.title && delSet[it.title]); });
    }
    try {
      var raw = localStorage.getItem(conf.key);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          /* Mirror-label migration (sites.js now names the numbered loaders
             "Arctic Mirror N" / "Cherri Mirror N"). Rename already-saved rows
             in place, guarded by their loader URL, so the seed merge below
             refreshes their thumbs instead of adding duplicates. */
          var MIRROR_URLS = ["articsvg-", "cherribydono-"];
          var MIRROR_RENAME = {};
          (function () {
            var names = ["Arctic", "Cherri"], mi, mn;
            for (mi = 0; mi < names.length; mi++)
              for (mn = 1; mn <= 10; mn++)
                MIRROR_RENAME[names[mi] + " " + mn] = names[mi] + " Mirror " + mn;
          })();
          parsed = parsed.map(function (it) {
            if (it && MIRROR_RENAME[it.title] && it.url) {
              for (var ui = 0; ui < MIRROR_URLS.length; ui++) {
                if (String(it.url).indexOf(MIRROR_URLS[ui]) !== -1) {
                  it.title = MIRROR_RENAME[it.title];
                  break;
                }
              }
            }
            return it;
          });
          /* Sync built-ins: refresh canonical fields (url, thumb, category, …)
             from the seed so edits to games.js / sites.js / apps.js always show
             up on every device, while keeping admin-added items and edits. */
          var merged = withId(parsed).map(sanitizeItem).filter(Boolean);
          var seeds = withId(conf.seed()).map(sanitizeItem).filter(Boolean);
          var dirty = merged.length !== parsed.length; /* holes / nulls removed */
          var SYNC_FIELDS = ["url", "thumb", "banner", "category", "porter", "isNew", "html", "kind", "via", "thumbCover", "sourceRepo", "license", "sourceLabel", "desc"];
          seeds.forEach(function (seed) {
            if (!seed || !seed.title || delSet[seed.title]) return;
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
          return applyDeletions(merged);
        }
      }
    } catch (e) { /* corrupt, reseed below */ }
    var seeded = withId(conf.seed()).map(sanitizeItem).filter(Boolean);
    var kept = seeded.filter(function (it) { return !(it && it.title && delSet[it.title]); });
    saveLib(name, kept);
    return applyDeletions(kept);
  }

  function saveLib(name, arr) {
    var conf = LIB_CONF[name];
    if (!conf) return;
    var list = Array.isArray(arr) ? arr : [];
    /* localStorage quota fix: the seeded game library carries ~22MB of
       data-URI thumbnails, far beyond the 5-10MB every browser allows, so
       persisting it used to throw QuotaExceededError and every admin edit
       was silently dropped on reload ("admin stopped working"). Strip
       data-URI thumbs before writing - loadLib re-attaches them from the
       seed by title, so cards keep their art and additions/edits stick. */
    var slim = list.map(function (it) {
      if (!it || typeof it !== "object") return it;
      var c = Object.assign({}, it);
      if (typeof c.thumb === "string" && /^data:image/i.test(c.thumb)) delete c.thumb;
      return c;
    });
    /* Deletions: loadLib re-seeds by title, so a removed seed item would
       resurrect on the next load. Track a per-library list of deleted titles;
       the sync blob carries it along, so it survives across devices too.
       IMPORTANT: read the previous stored list BEFORE writing the new one -
       the diff is what reveals which seed items were removed. */
    var prev = [];
    try {
      var prevRaw = localStorage.getItem(conf.key);
      if (prevRaw) { var p = JSON.parse(prevRaw); if (Array.isArray(p)) prev = p; }
    } catch (e) { /* corrupt */ }
    var dels = [];
    try {
      var delRaw = localStorage.getItem(conf.key + "-del");
      if (delRaw) { var d = JSON.parse(delRaw); if (Array.isArray(d)) dels = d; }
    } catch (e) { /* corrupt */ }
    var inNew = {};
    list.forEach(function (it) { if (it && it.title) inNew[it.title] = true; });
    var mergedDels = dels.filter(function (t) { return !inNew[t]; });
    prev.forEach(function (it) {
      if (it && it.title && !inNew[it.title] && mergedDels.indexOf(it.title) === -1) mergedDels.push(it.title);
    });
    try { localStorage.setItem(conf.key, JSON.stringify(slim)); } catch (e) { /* no storage */ }
    try { localStorage.setItem(conf.key + "-del", JSON.stringify(mergedDels)); } catch (e) { /* no storage */ }
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
    music: "music-grid",
    "apps-tools": "apps-grid",
    proxies: "proxies-grid"
  };

  var EMPTY_IDS = {
    home: null,
    games: "games-empty",
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


  var state = {
    view: "home",
    tool: "launcher",
    query: "",
    genreFilters: [],
    appFilters: [],
    collapsed: readPref(COLLAPSED_KEY) === "1",
    /* Low-power default: index.html's early boot script sets __chalkleLowPower
       on small-memory Chromebooks and phones (before first paint), so those
       devices start with animations off instead of janky ones. An explicit
       Settings choice overwrites the stored pref, so this only ever seeds
       the first visit. */
    motion: readPref(MOTION_KEY) === "1" || window.__chalkleLowPower === true,
    size: readPref(SIZE_KEY) || "comfortable",
    sort: readPref(SORT_KEY) || "favorite",
    sitesSort: "az",
    /* Session-only on purpose: persisting this made every visit to Games
       open with a stale filter (e.g. Recents) the user never picked this
       session - it looked like the tab was "auto toggling" itself. */
    gameFilter: "all",
    gridFilter: "",
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

    /* Drop junk entries a fresh parse would choke on: empty names, URLs that
       don't resolve to a real http(s) host ("https://]d", "https://roblox").
       Runs before migration so the seed defaults never get filtered out. */
    list = list.filter(function (p) {
      if (!p || !String(p.name || "").trim()) return false;
      var u = String(p.url || "").trim();
      if (!u) return false;
      try {
        var parsed = new URL(/^[a-z]+:\/\//i.test(u) ? u : "https://" + u);
        if (!/^https?:$/.test(parsed.protocol)) return false;
        if (!parsed.hostname || !parsed.hostname.includes(".") || /[^a-z0-9.\-:\[\]]/i.test(parsed.hostname)) return false;
        return true;
      } catch (e) { return false; }
    });

    /* Proxy migration (v2): the old Scramjet pointed at a trycloudflare
       quick-tunnel that expires (that one is dead now). Proxies route
       through the same-origin /res/ rewriting proxy served by this site's
       own server - the URL can never go stale and there is nothing separate
       for a filter to block. Fix saved copies in place, then make sure both
       default proxies exist. */
    var dirty = false;
    list.forEach(function (p) {
      if (!p || !p.url) return;
      var u = String(p.url);
      if (u.indexOf("trycloudflare") !== -1 || /^(\/uv|\/res)\/?$/i.test(u)) {
        /* The built-in proxy is not shipped with the static site - routing
           through a dead copy made every game look blocked. Point stale
           entries at a real host. */
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
    /* Numbered per-mirror SerumOS mark (serium-NN.svg) when the entry carries
       an index in 1-20; the plain brand PNG only as a fallback. */
    function seriumIcon(n) {
      n = parseInt(n, 10);
      if (!n || n < 1 || n > 20) return "/assets/proxies/serium.png";
      return "/assets/proxies/serium-" + ("0" + n).slice(-2) + ".svg";
    }
    if (!has("gjsd")) { list.push({ name: "GJSD", url: "https://gjsd.yan.ch/", mode: "frame", icon: "/assets/proxies/gjsd.png" }); dirty = true; }
    if (!has("ovokee")) { list.push({ name: "Ovokee", url: "https://ovokee.sbs/", mode: "frame", credit: "kelvin9rant", icon: "/assets/proxies/ovokee.png" }); dirty = true; }
    /* SerumOS is one proxy (hash route + service worker), credit c0mrade.
       Older builds seeded 20 numbered CDN mirrors of it; collapse any saved
       copies into a single "Serium" card so the tab shows one of each proxy. */
    var seriumSeen = false;
    list = list.filter(function (p) {
      if (!p || !/^serium/i.test(String(p.name || ""))) return true;
      if (!seriumSeen) {
        seriumSeen = true;
        p.name = "Serium";
        dirty = true;
        return true;
      }
      dirty = true;
      return false;
    });
    if (!has("serium")) {
      list.push({ name: "Serium", url: "https://swiftnet8420.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium-01.svg" });
      dirty = true;
    }
    /* Drop any other entry pointing at the same SerumOS mirror (some saved
       copies carry the mirror under their own names). */
    var seriumUrl = "";
    list.forEach(function (p) { if (p && p.name === "Serium") seriumUrl = String(p.url || ""); });
    if (seriumUrl) {
      list = list.filter(function (p) {
        if (p && p.name === "Serium") return true;
        if (p && String(p.url || "") === seriumUrl) { dirty = true; return false; }
        return true;
      });
    }
    /* Backfill brand icons onto earlier saved copies (they were seeded before
       icons existed) so every card shows the real logo. */
    list.forEach(function (p) {
      if (!p) return;
      var nm = String(p.name || "").trim().toLowerCase();
      var want = null;
      if (nm === "gjsd") want = "/assets/proxies/gjsd.png";
      else if (nm === "ovokee") want = "/assets/proxies/ovokee.png";
      else if (nm.indexOf("serium") === 0) {
        var mSer = String(p.name || "").match(/serium\s*(\d{1,2})/i);
        want = mSer ? seriumIcon(parseInt(mSer[1], 10)) : "/assets/proxies/serium-01.svg";
      }
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
          '<span class="proxy-link-mark">' + (p.icon && !isLocalFileUrl(p.icon) ? '<img class="proxy-link-ico" src="' + escapeAttr(p.icon) + '" alt="" loading="lazy" onerror="this.onerror=null;this.classList.add(\'proxy-link-ico-failed\');">' : "") + letter + "</span>" +
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
    var list = state.proxies.slice();
    /* Static mirrors cannot host /uv themselves. Add the first-party relay
       as a normal proxy entry so older cached launcher.js builds can still
       route games and sites through the working server. */
    try {
      var relay = window.ChalkleApi && window.ChalkleApi.root ? String(window.ChalkleApi.root() || "").replace(/\/+$/, "") : "";
      if (relay && /^https?:/i.test(relay)) {
        var hasRelay = list.some(function (p) { return p && p.builtin && p.url === relay + "/res"; });
        if (!hasRelay) list.unshift({ name: "Chalkle Relay", url: relay + "/res", mode: "path", builtin: true, icon: "/favicon.svg" });
      }
    } catch (e) { /* keep the normal proxy list */ }
    window.ChalkleProxies = list;
    window.ChalkleGetProxies = function () {
      return list.slice();
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

  /* ---------- shared launch counts (plays.js) ----------
     Every card can show how many times a game has been played, and every
     ranking below prefers those shared totals. The local click counter stays
     the fallback, because a static mirror with no relay (or an offline copy)
     has no shared counts to read - and a card with no number at all would be
     worse than a personal one. */

  function sharedPlays(key) {
    try { return window.ChalklePlays ? (window.ChalklePlays.count(key) || 0) : 0; }
    catch (e) { return 0; }
  }

  function sharedTrend(key) {
    try { return window.ChalklePlays ? (window.ChalklePlays.trending(key) || 0) : 0; }
    catch (e) { return 0; }
  }

  function playsLabel(key, clicks) {
    var shared = sharedPlays(key);
    var n = shared || clicks || 0;
    if (!n) return "";
    var text = shared && window.ChalklePlays ? window.ChalklePlays.format(n) : formatCount(n);
    return text + (n === 1 ? " play" : " plays");
  }

  /* One score for the Most popular sort and the Home shelf: this week's shared
     plays weigh heaviest, then the all-time total, then the local signal. */
  function playScore(key) {
    var week = sharedTrend(key);
    var all = sharedPlays(key);
    if (week || all) return week * 4 + all;
    return (state.clicks[key] || 0) * 2 + (state.favs[key] ? 5 : 0);
  }

  /* ---------- playtime (playtime.js) ----------
     How long this device has actually had a game open in the in-app player.
     Local only, and only mentioned from a minute up, so a stray click never
     reads as a habit. Shared play counts say what everyone opens; this says
     what you stay in. */

  function playtimeMs(key) {
    try {
      return window.ChalklePlaytime ? (window.ChalklePlaytime.get(key) || 0) : 0;
    } catch (e) {
      return 0;
    }
  }

  function playtimeLabel(key) {
    if (!window.ChalklePlaytime) return "";
    var ms = playtimeMs(key);
    if (ms < window.ChalklePlaytime.MIN_SHOW_MS) return "";
    return window.ChalklePlaytime.format(ms) + " played";
  }

  /* Lenient text matching. People type "gta5", "amongus" or "fnaf2" and mean
     the title with the spaces and punctuation still in it. Folding both sides
     handles that, the initialism pass answers "gd" for Geometry Dash, and a
     bounded subsequence pass catches the rest without flooding the grid. */

  function matchFold(s) {
    return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function initialism(s) {
    var words = String(s == null ? "" : s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (words.length < 2 || words.length > 4) return "";
    var out = "";
    for (var i = 0; i < words.length; i++) out += words[i].charAt(0);
    return out;
  }

  /* Does the query read as the first letters of a title's words, or the start
     of them? "gd" -> Geometry Dash, "gta5" -> Grand Theft Auto 5, "hkr" ->
     Hollow Knight: Radiant. This is the precise cousin of a plain subsequence
     pass, which is tempting but wrong here: typing "gta5" matched Minecraft
     builds whose letters happened to appear in order, and a filter that
     answers with the wrong three games is worse than one that says none. */
  function initialsMatch(title, foldQ) {
    var ini = initialism(title);
    if (!ini) return false;
    return ini === foldQ || ini.indexOf(foldQ) === 0;
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

  /* --------------------------------------------------------- proxy backend
     The Proxies tab's backend selector. The registry itself lives in
     proxies.js (window.ChalkProxyBackends); everything here is rendering the
     picker, saving the choice, and showing the live status the relay reports
     at /api/proxy/backends. Built-in relay/direct and hosted web backends are
     the only selectable routing options. */
  var backendProbe = { ok: false, backends: {}, panels: {}, active: "", chained: false, via: "" };
  var backendProbedAt = 0;

  function backendById(id) {
    if (typeof window.ChalkProxyBackendFind !== "function") return null;
    return window.ChalkProxyBackendFind(id);
  }

  function backendActiveId() {
    if (typeof window.ChalkProxyBackendGet === "function") return window.ChalkProxyBackendGet();
    return "relay";
  }

  /* Latency, as a card should show it: one number, no unit soup. */
  function msLabel(ms) {
    if (ms === null || ms === undefined) return "";
    if (ms < 1000) return Math.round(ms) + " ms";
    return (ms / 1000).toFixed(1) + " s";
  }

  function nodeHealth() {
    return (typeof window.ChalkProxyHealthOf === "function")
      ? window.ChalkProxyHealthOf
      : function () { return { state: "unknown", ms: null, fails: 0, at: 0 }; };
  }

  /* The live state of a hosted node, from proxies.js's health store: the same
     reading the launcher routes on, so the card can never claim a node works
     while the launcher is skipping it. */
  function nodeHealthPill(b) {
    if (!b) return "";
    var h = nodeHealth()(b.id) || { state: "unknown", ms: null };
    if (h.state === "live") {
      return '<span class="proxy-pill is-live">' + (h.ms === null ? "Answered" : msLabel(h.ms)) + "</span>";
    }
    if (h.state === "slow") return '<span class="proxy-pill is-slow">Slow: ' + msLabel(h.ms) + "</span>";
    if (h.state === "dead") return '<span class="proxy-pill is-dead">No answer</span>';
    return '<span class="proxy-pill is-checking">Not checked</span>';
  }

  function relayHealthPill() {
    var h = nodeHealth()("relay") || { state: "unknown", ms: null };
    if (h.state === "live") return '<span class="proxy-pill is-live">Answered in ' + msLabel(h.ms) + "</span>";
    if (h.state === "slow") return '<span class="proxy-pill is-slow">Slow: ' + msLabel(h.ms) + "</span>";
    if (h.state === "dead") return '<span class="proxy-pill is-dead">No answer</span>';
    return '<span class="proxy-pill is-checking">Checking</span>';
  }

  function backendPill(b) {
    if (!b) return "";
    if (b.kind === "auto") {
      var pick = (typeof window.ChalkProxyResolve === "function") ? window.ChalkProxyResolve("auto") : null;
      if (pick && pick.id !== "auto" && pick.kind !== "relay") {
        return '<span class="proxy-pill is-live">Fastest now: ' + escapeHtml(pick.name) + "</span>";
      }
      return '<span class="proxy-pill">Falls back to the relay</span>';
    }
    if (b.kind === "relay") {
      var rh = nodeHealth()("relay") || { state: "unknown" };
      if (rh.state === "unknown") return '<span class="proxy-pill is-live">Always on</span>';
      return relayHealthPill();
    }
    if (b.kind === "direct") return '<span class="proxy-pill">No proxy</span>';
    if (b.kind === "chain") {
      var st = backendProbe.backends[b.id];
      if (st && st.live) {
        return '<span class="proxy-pill is-live">Auto-detected: ' +
          escapeHtml(String(st.transport || "")) + " on :" + escapeHtml(String(st.port || "")) + "</span>";
      }
      return '<span class="proxy-pill">Unavailable</span>';
    }
    if (b.kind === "panel") {
      var pn = backendProbe.panels[b.id];
      if (pn && pn.live) {
        var host = String(pn.url || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
        return '<span class="proxy-pill is-live">Panel up: ' + escapeHtml(host) + "</span>";
      }
      return '<span class="proxy-pill">Panel not running</span>';
    }
    /* Hosted nodes: the pill is the live check, not a promise. */
    return nodeHealthPill(b);
  }

  function backendWhy(b) {
    if (!b) return "";
    if (b.kind === "auto") {
      var pick = (typeof window.ChalkProxyResolve === "function") ? window.ChalkProxyResolve("auto") : null;
      if (pick && pick.id !== "auto" && pick.kind !== "relay") {
        return "Every hosted node on this list is checked, and the fastest one that answers is used. That is " +
          String(pick.name) + " right now.";
      }
      return "Every hosted node is checked and the fastest one that answers is used. Nothing has answered yet, " +
        "so pages fall back to Chalkle's own relay.";
    }
    if (b.kind === "chain") {
      var st = backendProbe.backends[b.id];
      if (st && st.live) {
        return "Chaining through " + String(st.transport || "") + "://127.0.0.1:" + String(st.port || "") +
          " - proxied pages are fetched through it.";
      }
      return "This backend is unavailable. Pages use the built-in relay or a hosted web backend.";
    }
    if (b.kind === "panel") {
      var pn = backendProbe.panels[b.id];
      if (pn && pn.live) return "Panel answered on " + String(pn.url || "") + " - Open loads it.";
      return "That panel is not running on this machine yet. Open will load it as soon as it is.";
    }
    if (b.kind === "relay") {
      if (!backendProbe.ok) return "Chalkle's own rewriting relay. This is what every game and app already uses.";
      if (backendProbe.chained && backendProbe.via) {
        return "Relay is live and its fetches are going out through " + String(backendProbe.via) + ".";
      }
      return "Relay is live - fetches go straight out from this machine.";
    }
    if (b.kind === "direct") return "Nothing is proxied. Games still load; nothing is hidden.";
    if (b.kind === "frame") {
      var h = nodeHealth()(b.id) || { state: "unknown", ms: null, at: 0 };
      var when = h.at ? " Last checked " + new Date(h.at).toLocaleTimeString() + "." : "";
      if (h.state === "live") return "Answered in " + msLabel(h.ms) + " on the last check." + when + " " + (b.note || "");
      if (h.state === "slow") return "Answered, but slowly (" + msLabel(h.ms) + "). A fast school line will still feel this one." + when;
      if (h.state === "dead") return "Nothing answered on the last check. It is down, or this network filters it." + when;
      return "Not checked on this device yet. " + (b.note || "");
    }
    return b.note || "";
  }

  var backendBarBound = false;

  /* The bar's markup is static (index.html) so the audit's "every JS id exists
     in HTML" check passes; this only fills the options and the status line. */
  function renderProxyBackendBar() {
    var sel = $("#proxy-backend-select");
    if (!sel) return;
    var list = (typeof window.ChalkProxyBackendList === "function" && window.ChalkProxyBackendList()) || [];
    if (!list.length) return;
    var groups = window.ChalkProxyBackendGroups || [];
    var active = backendActiveId();
    var cur = backendById(active);
    sel.innerHTML = groups.map(function (g) {
      var inGroup = list.filter(function (b) { return b && b.group === g.id; });
      if (!inGroup.length) return "";
      return '<optgroup label="' + escapeAttr(g.label) + '">' +
        inGroup.map(function (b) {
          return '<option value="' + escapeAttr(b.id) + '"' + (b.id === active ? " selected" : "") + ">" +
            escapeHtml(b.name) + "</option>";
        }).join("") + "</optgroup>";
    }).join("");
    sel.value = active;
    var meta = $("#proxy-backend-meta");
    if (meta) {
      meta.innerHTML = (cur
        ? '<span class="backend-bar-name">' + escapeHtml(cur.name) + "</span>" + backendPill(cur)
        : "") +
        '<button class="btn-ghost backend-check" type="button" data-backend-check-all="1">Check nodes</button>';
    }
    var why = $("#proxy-backend-why");
    if (why) why.textContent = backendWhy(cur);
    if (!backendBarBound) {
      backendBarBound = true;
      sel.addEventListener("change", function () { useProxyBackend(sel.value); });
      var openBtn = $("#proxy-backend-open");
      if (openBtn) openBtn.addEventListener("click", function () { openProxyBackend(sel.value); });
    }
  }

  function renderProxyBackendCards() {
    var box = $("#proxy-backends-grid");
    if (!box) return;
    var list = (typeof window.ChalkProxyBackendList === "function" && window.ChalkProxyBackendList()) || [];
    if (!list.length) { box.innerHTML = ""; return; }
    var groups = window.ChalkProxyBackendGroups || [];
    var active = backendActiveId();
    box.innerHTML = groups.map(function (g) {
      var inGroup = list.filter(function (b) { return b && b.group === g.id; });
      if (!inGroup.length) return "";
      return '<div class="backend-group">' +
        '<h3 class="backend-group-title">' + escapeHtml(g.label) +
        '<span class="backend-group-hint">' + escapeHtml(g.hint || "") + "</span></h3>" +
        '<div class="grid backend-grid">' +
        inGroup.map(function (b) {
          var isActive = b.id === active;
          return '<div class="card backend-card' + (isActive ? " is-active" : "") + '">' +
            '<div class="backend-head"><span class="backend-name">' + escapeHtml(b.name) + "</span>" +
            (isActive ? '<span class="proxy-pill is-live">In use</span>' : "") + "</div>" +
            '<div class="backend-pills">' + backendPill(b) +
            (b.credit ? '<span class="proxy-pill is-credit">by ' + escapeHtml(b.credit) + "</span>" : "") + "</div>" +
            '<p class="backend-note">' + escapeHtml(backendWhy(b)) + "</p>" +
            '<div class="backend-actions">' +
            '<button class="btn-ghost" data-backend-use="' + escapeAttr(b.id) + '">' + (isActive ? "Selected" : "Use") + "</button>" +
            (b.kind === "frame"
              ? '<button class="btn-ghost" data-backend-check="' + escapeAttr(b.id) + '">Check</button>'
              : "") +
            (b.kind === "frame" || b.kind === "panel"
              ? '<button class="btn-ghost" data-backend-open="' + escapeAttr(b.id) + '">Open</button>'
              : "") +
            "</div></div>";
        }).join("") + "</div></div>";
    }).join("");
  }

  /* One probe per ~20s: the relay's detection is cached for 15s anyway, and
     this keeps a tab switch back into Proxies from re-probing every time. */
  function refreshProxyBackends(force) {
    if (typeof window.ChalkProxyBackendProbe !== "function") return;
    var now = Date.now();
    if (!force && now - backendProbedAt < 20000) return;
    backendProbedAt = now;
    window.ChalkProxyBackendProbe(function (j) {
      if (j) backendProbe = j;
      renderProxyBackendBar();
      renderProxyBackendCards();
    });
    /* The hosted nodes are checked in the same visit that renders their
       cards: the user is looking at these numbers, so they may as well be
       from now instead of the last time the tab was opened. */
    if (typeof window.ChalkProxyCheckAll === "function") window.ChalkProxyCheckAll(null);
  }

  /* ------------------------------------------------------- proxy health ---
     The check itself lives in proxies.js (one health store for the tab, the
     launcher and the auto picker). These are the two actions the tab offers:
     check one node, or check everything including the relay. */
  function checkProxyNode(id) {
    if (typeof window.ChalkProxyPingNode !== "function") return;
    var b = backendById(id);
    if (b && b.name) showToast("Checking " + b.name + "...");
    window.ChalkProxyPingNode(id, function (rec) {
      if (b && b.name && rec) {
        showToast((rec.state === "live" || rec.state === "slow")
          ? b.name + ": answered in " + msLabel(rec.ms)
          : b.name + ": no answer");
      }
      window.ChalkleProxyRefresh();
    });
  }

  function checkProxyNodes(announce) {
    if (announce) showToast("Checking every proxy node...");
    if (typeof window.ChalkProxyCheckRelay === "function") window.ChalkProxyCheckRelay(null);
    if (typeof window.ChalkProxyCheckAll !== "function") return;
    window.ChalkProxyCheckAll(function (rows) {
      if (announce && rows) {
        var live = rows.filter(function (r) { return r.state === "live" || r.state === "slow"; }).length;
        showToast(live
          ? live + " of " + rows.length + " hosted nodes answered"
          : "No hosted node answered - using the relay");
      }
      window.ChalkleProxyRefresh();
    });
  }

  /* Repaint once per burst: a check-all settles every node within a few
     hundred milliseconds and each answer fires its own event. */
  var proxyRepaint = null;
  window.ChalkleProxyRefresh = function () {
    if (proxyRepaint) return;
    proxyRepaint = setTimeout(function () {
      proxyRepaint = null;
      renderProxyBackendBar();
      renderProxyBackendCards();
    }, 120);
  };
  document.addEventListener("chalkle:proxy-health", function () { window.ChalkleProxyRefresh(); });

  function useProxyBackend(id) {
    var b = backendById(id);
    if (!b) return;
    if (typeof window.ChalkProxyBackendSet === "function") window.ChalkProxyBackendSet(id);
    else persist("chalkle-proxy-backend", id);
    if (b.kind === "panel") {
      showToast(b.name + " selected - opening its panel");
      openProxyBackend(id);
    } else {
      showToast("Proxy backend: " + b.name);
    }
    renderProxyBackendBar();
    renderProxyBackendCards();
    refreshProxyBackends(true);
  }

  function openProxyBackend(id) {
    var b = backendById(id);
    if (!b) return;
    if (b.kind === "panel") {
      var pn = backendProbe.panels[b.id];
      if (pn && pn.url) {
        try { window.open(pn.url, "_blank", "noopener"); } catch (e) { /* popup blocked */ }
        return;
      }
      showToast("Start " + b.name + " and it is detected automatically");
      return;
    }
    if (b.kind === "frame" && b.url) {
      if (window.ChalkleBrowser && window.ChalkleBrowser.open) window.ChalkleBrowser.open(b.url, b.name);
      else { try { window.open(b.url, "_blank", "noopener"); } catch (e) { /* popup blocked */ } }
      return;
    }
    if (b.kind === "chain") {
      var st = backendProbe.backends[b.id];
      showToast(st && st.live
        ? "Chaining through " + String(st.transport || "") + " on :" + String(st.port || "")
        : "Start " + b.name + " and it is detected automatically");
      return;
    }
    /* relay / direct: prove it with a real page through the launcher. */
    if (window.ChalkleLaunch && window.ChalkleLaunch.openWithOptions) {
      window.ChalkleLaunch.openWithOptions("https://example.com/", b.name);
    }
  }

  /* Delegated once for the whole document: the two grids are re-rendered on
     every filter/theme change, so per-element handlers would leak. */
  document.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest) return;
    var use = e.target.closest("[data-backend-use]");
    if (use) { e.preventDefault(); useProxyBackend(use.getAttribute("data-backend-use")); return; }
    var op = e.target.closest("[data-backend-open]");
    if (op) { e.preventDefault(); openProxyBackend(op.getAttribute("data-backend-open")); return; }
    var chk = e.target.closest("[data-backend-check]");
    if (chk) { e.preventDefault(); checkProxyNode(chk.getAttribute("data-backend-check")); return; }
    var all = e.target.closest("[data-backend-check-all]");
    if (all) { e.preventDefault(); checkProxyNodes(true); }
  });

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

    /* Backend selector + the registry cards, then a fresh (throttled) probe
       so the status pills reflect the machine as it is right now. */
    renderProxyBackendBar();
    renderProxyBackendCards();
    refreshProxyBackends(false);
  }

  function openProxy(i) {
    var p = state.proxies[i];
    if (!p || !p.url) return;

    if (p.mode === "tab") {
      if (isLocalFileUrl(p.url)) return;
      window.open(p.url, "_blank", "noopener");
      return;
    }

    /* Proxy cards pass their URL through untouched (it is already a proxy
       route; re-routing would double-wrap it). */
    window.ChalkleBrowser.open(p.url, p.name, { raw: true });
  }

  function closeOverlay() {
    if (window.ChalkleBrowser && window.ChalkleBrowser.close) {
      window.ChalkleBrowser.close();
    }
    document.body.style.overflow = "";
  }

  function closeMoreNav() {
    var panel = document.getElementById("nav-more");
    var btn = document.getElementById("nav-more-btn");
    if (panel) { panel.classList.remove("is-open"); panel.hidden = true; }
    if (btn) { btn.classList.remove("is-open"); btn.setAttribute("aria-expanded", "false"); }
  }

  /* JS Movies: resolve the standalone page for the current deployment.
     The full single-file build embeds it as a data URI under /movies.html
     (same trick as embedded games); everywhere else it is a real page. */
  function moviesPageUrl() {
    try {
      var map = window.__SINGLE_GAMES__;
      if (map && map["/movies.html"]) return map["/movies.html"];
    } catch (e) { /* no single-file map */ }

    /* Prefer the in-memory /movies.html route when it is available (the
       deployed wrapper injects it through /api/chalkle). Otherwise fall back
       to the built-in single-file path. Once the wrapper is removed from the
       public URL plan, this can be simplified to just return "/movies.html" 
       everywhere. */
    try {
      var root = window.CHALKLE_API_ROOT || "";
      if (!root && window.ChalkleApi && typeof window.ChalkleApi.root === "function") {
        try { root = window.ChalkleApi.root(); } catch (e) {}
      }
      var apiRoot = root.trim() || "";
      if (apiRoot) {
        var apiMovies = (apiRoot.replace(/\/+$/, "") + "/movies.html").replace(/https?:\/\/([a-z0-9-]+\.)?lootline\.xyz/i, "");
        if (!apiMovies.startsWith("http")) {
          /* location.origin is the literal string "null" in sandboxed/srcdoc
             frames (svgbulk wrappers) - concatenating it produced the infamous
             /null/movies.html 404. Only build an origin-absolute URL from a
             real http(s) origin; otherwise fall through to the baseURI-
             relative resolution below, which the injected <base href> of
             wrapper/mirror pages resolves correctly. */
          var orgM = String(window.location.origin || "");
          if (/^https?:/i.test(orgM)) {
            var fromCurrent = orgM + apiMovies;
            try { var probe = new URL(fromCurrent, document.baseURI || location.href); if (/\/movies\.html$/i.test(probe.pathname)) return probe.href; } catch (e) {}
          }
        }
        if (apiMovies && apiMovies.indexOf("/null/") === 0) {
          // The wrapper advertised a bad path like /null/movies.html - ignore it and
          // fall through to the normal same-origin route instead of surfacing an
          // "Invalid URL" / 404 to the user.
          apiMovies = "";
        }
        if (apiMovies && apiMovies.indexOf("data:") !== 0 && apiMovies.indexOf("http") !== 0) {
          // Drop obviously broken paths (empty string, absolute path with no host,
          // or anything that isn't an http(s) URL / data URI) so we land on the
          // normal same-origin /movies.html page instead of surfacing an invalid URL.
          apiMovies = "";
        }
      }
    } catch (e) { /* keep it simple */ }

    try {
      /* Relative (not root-absolute): under an injected <base href> (svgbulk
         wrappers, jsDelivr subpaths) a leading slash resolves against the CDN
         ORIGIN ROOT and 404s, while the bare path resolves via <base> to the
         correct /gh/<repo>/<branch>/movies.html. Root deploys are unaffected
         (document base IS the root). */
      var resolved = new URL("movies.html", document.baseURI || location.href).href;
      if (resolved.indexOf("data:") === 0 || resolved.indexOf("http") === 0) return resolved;
      return "movies.html";
    } catch (e) { /* keep it simple */ }
    return "movies.html";
  }
  function loadMoviesFrame() {
    var frame = document.getElementById("movies-frame");
    if (!frame || frame.dataset.embedLoaded === "1") return;
    if (frame.src && frame.src.indexOf("movies.html") !== -1) return;
    var url = moviesPageUrl();
    if (!url || url.indexOf("data:") !== 0 && url.indexOf("http") !== 0) {
      // If the resolver produced a broken path (for example a /null/... route from
      // a wrapper configured with a bad base), ignore it so the iframe keeps its
      // normal same-origin /movies.html behavior instead of surfacing an invalid URL.
      return;
    }
    /* Inside the svgbulk/mirror wrappers (__CHALKLE_EMBED__) the CDN serves
       .html files as text/plain, so a plain <iframe src> shows the raw source.
       Fetch the page and hand it over as srcdoc - same trick as the top-level
       launcher that embedded index.html - so Movies actually renders. */
    if (window.__CHALKLE_EMBED__ || isMirrorHost()) {
      loadEmbedFrame(frame, url);
      return;
    }
    frame.src = url;
  }

  /* True when this page itself is served from a static mirror (jsDelivr,
     GitHub Pages, ...). Mirrors serve .html as text/plain with nosniff, so
     any same-origin page we iframe must go through the fetch+srcdoc path
     even without the __CHALKLE_EMBED__ wrapper flag. */
  function isMirrorHost() {
    try {
      if (window.ChalkleApi && typeof window.ChalkleApi.isMirror === "function") return window.ChalkleApi.isMirror();
    } catch (e) { /* fall through */ }
    try {
      var host = String(location.hostname || "");
      return /(?:^|\.)(?:jsdelivr\.net|githack\.com|unpkg\.com|esm\.sh|github\.io|pages\.dev|gitlab\.io|githubusercontent\.com|vercel\.app|netlify\.app|esm\.lootline\.xyz)$/i.test(host);
    } catch (e) {
      return false;
    }
  }

  /* Open a resolved page URL in a new tab. Data URIs (the single-file
     embeds) are blocked from top-level navigation by every browser, so
     convert them to a blob: URL first - blob: opens fine and stays
     same-origin even from file://. */
  function openResolvedTab(url) {
    return (window.ChalkleCore ? window.ChalkleCore.openTab(url) : fallbackOpen(url));
  }

  /* Pre-appcore path, kept for the rare case ChalkleCore is missing (e.g. a
     cached page half-loaded during a deploy). Handles the data:/embed blob
     wrap the shared helper also does. */
  function fallbackOpen(url) {
    if (!url) return null;
    if (url.indexOf("data:") !== 0 && !(window.__CHALKLE_EMBED__ && url.indexOf("data:") !== 0)) {
      var win0 = null;
      try { win0 = window.open(url, "_blank"); } catch (e) { return null; }
      if (win0) { try { win0.opener = null; } catch (e) { /* ignore */ } }
      return win0;
    }
    fetch(url).then(function (r) { return r.blob(); }).then(function (b) {
      var u = URL.createObjectURL(b);
      var win = window.open(u, "_blank");
      if (win) { try { win.opener = null; } catch (e) { } }
      setTimeout(function () { try { URL.revokeObjectURL(u); } catch (e) { } }, 180000);
    }).catch(function () {
      var win = window.open(url, "_blank");
      if (win) { try { win.opener = null; } catch (e) { } }
    });
    return null;
  }

  function chatPageUrl() {
    /* Lunchbreak chat is fully client-side (Firebase), so it runs from any
       host. Resolution mirrors moviesPageUrl(): single-file embed first, then
       the api-root mirror copy, then same-origin. Never a blocked external
       chat host. */
    try {
      var map = window.__SINGLE_GAMES__;
      if (map && map["/chat.html"]) return map["/chat.html"];
    } catch (e) { /* no single-file map */ }
    try {
      var root = window.CHALKLE_API_ROOT || "";
      if (!root && window.ChalkleApi && typeof window.ChalkleApi.root === "function") {
        try { root = window.ChalkleApi.root(); } catch (e2) {}
      }
      var apiRoot = (root || "").trim();
      if (apiRoot) {
        /* Strip ANY lootline host (lootline.xyz, chalkle.lootline.xyz, ...
           subdomains included): if the file is being run from a blocked
           network, the api root IS a lootline host and must never be used
           as the frame source. Same-origin /chat.html is always tried
           first by the caller anyway, so this only fires when same-origin
           is genuinely a different host that already serves chat. */
        var apiChat = (apiRoot.replace(/\/+$/, "") + "/chat.html").replace(/https?:\/\/([a-z0-9-]+\.)?lootline\.xyz/i, "");
        if (!apiChat.startsWith("http")) {
          /* Same "null"-origin guard as moviesPageUrl(): sandboxed/srcdoc
             frames report location.origin === "null" and used to produce
             /null/chat.html. Skip origin-absolute assembly for non-http(s)
             origins and fall through to baseURI-relative resolution. */
          var orgC = String(window.location.origin || "");
          if (/^https?:/i.test(orgC)) {
            var fromCurrent = orgC + apiChat;
            try { var probe = new URL(fromCurrent, document.baseURI || location.href); if (/\/chat\.html$/i.test(probe.pathname)) return probe.href; } catch (e3) {}
          }
        }
      }
    } catch (e4) { /* keep it simple */ }
    try {
      /* Relative, for the injected <base href> in wrappers/mirrors - see the
         moviesPageUrl() note above. */
      return new URL("chat.html", document.baseURI || location.href).href;
    } catch (e5) { /* keep it simple */ }
    return "chat.html";
  }
  function loadChatFrame() {
    var frame = document.getElementById("chat-frame");
    if (!frame || frame.dataset.embedLoaded === "1") return;
    if (frame.src && frame.src.indexOf("chat.html") !== -1) return;
    var url = chatPageUrl();
    frame.allow = "fullscreen";
    frame.setAttribute("allowfullscreen", "");
    /* Same text/plain trap as Movies: inside the embed wrapper the CDN serves
       .html as text/plain, so fetch + srcdoc instead of a raw <iframe src>. */
    if ((window.__CHALKLE_EMBED__ || isMirrorHost()) && url && url.indexOf("data:") !== 0) {
      loadEmbedFrame(frame, url);
      return;
    }
    frame.src = url;
  }

  /* Embed-mode frame loader: fetch the page HTML, inject a <base> pointing at
     the CDN folder (so relative asset refs resolve), strip root-absolute asset
     paths (they would resolve against the CDN origin root), and hand the result
     to the frame as srcdoc. Mirrors the top-level launcher in the svgbulk svg
     files, and the embed fixer in index.html. */
  function fixEmbedPaths(text) {
    text = text.replace(/(["'(])\/(assets\/[^"'()]+?\.(?:jpg|jpeg|png|webp|gif|svg|ico|woff2?|ttf|mp3|ogg))/gi, "$1$2");
    text = text.replace(/(["'(])\/(gn\/[^"'()]+?\.(?:jpg|jpeg|png|webp|gif|svg|ico|mp3|ogg))/gi, "$1$2");
    text = text.replace(/(["'(])\/(game-builds\/[^"'()]+?\.(?:jpg|jpeg|png|webp|gif|svg|ico|mp3|ogg))/gi, "$1$2");
    text = text.replace(/(["'])\/([A-Za-z0-9._-]+\.txt)\1/gi, "$1$2$1");
    return text;
  }
  function loadEmbedFrame(frame, url) {
    var base = url.slice(0, url.lastIndexOf("/") + 1);
    fetch(url + (url.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now())
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.text(); })
      .then(function (html) {
        html = html.replace(/<head([^>]*)>/i, '<head$1><base href="' + base + '">');
        html = fixEmbedPaths(html);
        frame.removeAttribute("src");
        frame.srcdoc = html;
        frame.dataset.embedLoaded = "1";
      })
      .catch(function () {
        /* Fetch failed - fall back to a plain navigation; same result as
           before on real deployments, and the CDN case at least tries. */
        frame.src = url;
      });
  }

  function setView(view) {
    /* Removed tabs (Sites, Board) never render; anything left pointing at
       them falls back to Home instead of a blank section. */
    if (view === "sites" || view === "board") view = "home";
    state.view = view;
    persist("chalkle-last-view", view);
    closeMoreNav();
    /*
      YouTube no longer pauses the Music tab by default.
      If you still want that behaviour, uncomment the block below.
    */
    /*
    if (view === "youtube" && window.ChalkleMusic && window.ChalkleMusic.pause) {
      window.ChalkleMusic.pause();
    }
    */
    /* Mirror the active tab on <body> so the top bar + chrome can tint with
       the section's accent color. */
    document.body.setAttribute("data-view", view);

    /* Lazy-load the big embedded frames only once the view is active. */
    if (view === "movies") {
      loadMoviesFrame();
    } else if (view === "chat") {
      loadChatFrame();
    }

    document.querySelectorAll(".nav-item").forEach(function (btn) {
      var active = btn.dataset.view === view;
      btn.classList.toggle("is-active", active);
      if (active) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
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
    } else if (view === "youtube") {
      /* owned by youtube.js - first open renders and fetches, later opens
         reuse the already-rendered tab */
      if (window.ChalkleYoutube && window.ChalkleYoutube.render) window.ChalkleYoutube.render();
    } else if (view === "livetv") {
      /* owned by livetv.js - first open also kicks off the channel/sports
         fetches that boot no longer does eagerly */
      if (window.ChalkleLiveTV && window.ChalkleLiveTV.render) window.ChalkleLiveTV.render();
    } else if (view === "movies") {
      loadMoviesFrame();
    } else if (view === "chat") {
      /* Lunchbreak chat is embedded as a fully client-side page (Firebase
         auth/firestore straight from the browser). loadChatFrame resolves it
         from the single-file embed, the api-root mirror, or same-origin - the
         same chain as the Movies tab, so it stays unblocked everywhere. */
      loadChatFrame();
    } else {
      /* Chromebook-friendly: paint the tab switch first, build the grid on
         the next frame so a 1,400-card library never blocks the click. */
      requestAnimationFrame(function () {
        render();
        if (view === "games") {
          /* Remember where you scrolled on Games across tab switches. */
          try {
            var sc = sessionStorage.getItem("chalkle-scroll-games");
            var mainEl = document.querySelector(".main");
            if (sc && mainEl) mainEl.scrollTop = parseInt(sc, 10) || 0;
          } catch (e) { /* no session */ }
        }
      });
    }
  }

  /* ---------- Global search ----------
     The top search bar stays put and shows a dropdown of matches from across
     every library, each labeled with the tab it lives in (Games / Sites /
     Apps-Tools). Typing never bounces you to another view - you pick a result. */

  var SEARCH_TABS = [
    { view: "games", label: "Games" },
    { view: "apps-tools", label: "Apps" }
  ];

  var searchFocusIdx = -1;
  var searchFocusList = [];
  /* Which field is driving the dropdown. Remembered at render time instead of
     read back off document.activeElement, which anything can move. */
  var searchSourceEl = null;
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

    /* Punctuation-insensitive pass: query and title are folded to letters and
       digits, so "gta5" matches "GTA 5", "spiderman" matches "Spider-Man"
       and "fnaf2" matches "FNAF 2". Every score here sits under the literal
       ones above, so a real substring hit always leads the list. */
    if (!short) {
      var foldQ = matchFold(q);
      var foldTitle = matchFold(title);
      if (foldQ.length >= 2 && foldTitle) {
        if (foldTitle === foldQ) return { score: 58, hit: true };
        if (foldTitle.indexOf(foldQ) === 0) return { score: 52, hit: true };
        if (foldTitle.indexOf(foldQ) !== -1) return { score: 46, hit: true };
        if (initialsMatch(title, foldQ)) return { score: 42, hit: true };
      }
    }

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
      var rank = { "apps-tools": 0, games: 1 };
      var dv = (rank[a.__view] || 3) - (rank[b.__view] || 3);
      if (dv) return dv;
      return naturalCmp(a.title, b.title);
    });
    return out.slice(0, SEARCH_MAX);
  }

  /* The dropdown is fixed-positioned: anchor it under whichever search
     field is focused (top bar or Home launcher). */
  function positionSearchResults() {
    var box = $("#search-results");
    if (!box || box.hidden) return;
    /* Anchor under the field that produced the list, not under whatever
       happens to hold focus right now. */
    var src = document.activeElement;
    var fields = { "search-input": 1, "home-search-input": 1 };
    var anchor = (searchSourceEl && fields[searchSourceEl.id])
      ? searchSourceEl
      : ((src && fields[src.id]) ? src : (els.search || null));
    if (!anchor || !anchor.getBoundingClientRect) return;
    var r = anchor.getBoundingClientRect();
    box.style.top = Math.round(r.bottom + 8) + "px";
    box.style.left = Math.round(r.left) + "px";
    box.style.width = Math.round(r.width) + "px";
  }

  function renderSearchResults(q, source) {
    var box = $("#search-results");
    if (!box) return;
    if (source) searchSourceEl = source;
    var list = collectSearchResults(q);
    searchFocusIdx = -1;
    searchFocusList = list;
    if (!list.length) {
      box.hidden = false;
      positionSearchResults();
      box.innerHTML =
        '<div class="search-empty">' +
        '<div class="search-empty-title">' + escapeHtml("No matches for \u201C" + (q || "") + "\u201D") + "</div>" +
        '<div class="search-empty-tip">Check the spelling, or try a shorter name. Still stuck? Jump straight into a section.</div>' +
        '<div class="search-empty-jumps">' +
        ["games", "apps-tools", "music", "cloud"].map(function (v) {
          var label = { "apps-tools": "Apps", music: "Music", cloud: "Cloud" }[v] ||
            ((SEARCH_TABS.find(function (t) { return t.view === v; }) || {}).label || v);
          return '<button class="search-empty-jump" data-search-go="' + v + '">' + escapeHtml(label) + "</button>";
        }).join("") +
        "</div></div>";
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
    /* Typing in the Home box needs one line of explanation, because that
       field also searches the web: Enter opens the match, Search goes out. */
    var fromHome = !!(searchSourceEl && searchSourceEl.id === "home-search-input");
    if (fromHome) {
      html += '<div class="search-hint">' + escapeHtml("Enter opens the top match \u00B7 the Search button goes to the web") + "</div>";
    }
    box.hidden = false;
    positionSearchResults();
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
    /* Empty-state quick jumps: hop straight into a section without typing. */
    box.querySelectorAll("[data-search-go]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        closeSearchResults();
        clearSearchFields();
        state.query = "";
        setView(btn.dataset.searchGo);
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

  /* Both search fields share one result list, so both must be emptied when a
     result is picked - otherwise the other box keeps a stale query. */
  function clearSearchFields() {
    if (els.search) els.search.value = "";
    if (els.homeSearch) els.homeSearch.value = "";
  }

  function closeSearchResults() {
    var box = $("#search-results");
    if (box) box.hidden = true;
    searchFocusIdx = -1;
    searchFocusList = [];
  }

  /* The omnibox in the in-app browser needs the same catalogue search the
     top-bar field uses. Exporting the two functions (rather than the scoring
     internals) keeps one ranked list behind every search field in the app, so
     typing "minecr" means the same thing wherever you type it. */
  window.ChalkleCatalog = {
    search: function (q, limit) {
      var n = parseInt(limit, 10);
      if (!isFinite(n) || n <= 0) n = 6;
      return collectSearchResults(q).slice(0, n).map(function (item) {
        return {
          title: item.title || "",
          category: item.category || "",
          url: item.url || "",
          label: item.__label || "",
          item: item
        };
      });
    },
    open: function (item) { launchSearchItem(item); }
  };

  /* Launch an item picked from search - same behaviour as clicking its card,
     but first it hops you to that item's tab for context. */
  function launchSearchItem(item) {
    if (!item) return;
    var view = item.__view;
    closeSearchResults();
    clearSearchFields();
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
    var u = item.url || "";
    if (item.html && String(item.html).trim() && window.ChalkleLaunch.htmlUrl) {
      u = window.ChalkleLaunch.htmlUrl(item.html);
    }
    if (u) {
      /* Every searchable item uses the same explicit chooser as a card. */
      window.ChalkleLaunch.openWithOptions(u, item.title || u);
      return;
    }
    if (item.kind === "editor" && window.ChalkleEditor) window.ChalkleEditor.open();
    else if (item.kind === "urlauditor" && window.ChalkleUrlAuditor) window.ChalkleUrlAuditor.open();
    else if (item.kind === "pixel" && window.ChalklePixel) window.ChalklePixel.open();
    else if (item.kind === "domainhub" && window.ChalkleDomainHub) window.ChalkleDomainHub.open();
    else if (item.kind === "iphone16") openIphone16();
    else if (item.kind === "browser") openBrowser();
    else if (item.kind === "vm") openVm();
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
    /* Mirrors don't serve game-builds/ (gitignored) - resolve to the relay. */
    try {
      if (window.ChalkleApi && window.ChalkleApi.localUrl) src = window.ChalkleApi.localUrl(src);
    } catch (e) { /* keep the raw path */ }
    var win = null;
    try { win = window.open(src, "_blank"); } catch (e) { /* ignore */ }
    if (win) {
      try { win.document.title = (window.ChalkleCloakTitle || "Home") + ""; } catch (e) { /* cross-origin - can't set title */ }
    }
  }

  /* Built-in proxied browser page (browser.html). Opens in its own tab -
     it's a full address-bar browser, not a card you embed. Single-file
     builds embed it (same trick as movies/chat) so the Browser tool works
     offline and on mirrors. */
  function browserPageUrl() {
    try {
      var map = window.__SINGLE_GAMES__;
      if (map && map["/browser.html"]) return map["/browser.html"];
    } catch (e) { /* no single-file map */ }
    return "/browser.html";
  }
  function openBrowser() {
    /* Open the in-app browser overlay directly on its new-tab page. The
       overlay already has tabs, an address bar, bookmarks, quick links and
       /res/ routing, so there is nothing left for browser.html to add - and
       hosting it inside the overlay would nest two browser UIs. */
    if (window.ChalkleBrowser && window.ChalkleBrowser.open) {
      window.ChalkleBrowser.open("", "Browser");
      return;
    }
    var win = null;
    try { win = window.open(browserPageUrl(), "_blank"); } catch (e) { /* ignore */ }
    if (win) {
      try { win.document.title = (window.ChalkleCloakTitle || "Home") + ""; } catch (e) { /* cross-origin - can't set title */ }
    }
  }

  /* Firefox VM needs a top-level tab for cross-origin isolation (its WASM
     threads refuse to boot inside an iframe), so it always opens full-page. */
  function openVm() {
    var w = window.open(ChalkleApi.url("/vm/"), "_blank");
    if (!w || w.closed) {
      try { if (window.showToast) showToast("Allow popups to launch the VM.", "error"); } catch (e) {}
    }
  }

  /* Boot intro door: once the overlay is gone, kick rendering that was
     waiting for the page to be visible. */

  function bootReady() {
    /* The single render pass at boot: init() skips its render when this has
       already run (repeat visits skip the intro, so this fires at script
       eval) or will run once the intro finishes. */
    window.__chalkleRendered = true;
    /* Come back to the last open tab instead of always landing on Home. */
    try {
      var lastView = localStorage.getItem("chalkle-last-view") || "";
      if (lastView && lastView !== "home" && document.querySelector('.view[data-view="' + CSS.escape(lastView) + '"]')) {
        setView(lastView);
        return;
      }
    } catch (e) { /* no storage */ }
    renderHome();
    renderProxies();
    render();
  }

  /* Defer one tick: the intro-skipped path reaches this line while the IIFE
     is still evaluating (PICK_TITLES and friends live further down the
     file). Calling bootReady synchronously crashed with "PICK_TITLES is
     undefined" on every repeat visit and killed the whole boot render. */
  if (window.__chalkleBootDone) {
    setTimeout(bootReady, 0);
  } else {
    window.addEventListener("chalkle-boot-done", bootReady, { once: true });
  }

  /* ---------- Generic rendering ---------- */

  /* Shared thumbnail builder: artwork fill + controller-icon fallback + a
     favicon rescue for remote URLs. Used by the classic card (sites) and the
     artwork-first game card. */
  function gameThumbInner(item) {
    var host = "";
    try {
      host = item.url ? new URL(item.url).hostname.replace(/^www\./, "") : "";
    } catch (e) { /* bad URL, leave host empty */ }

    /* Clean fallback tile with a subtle controller icon. */
    var fallbackHtml = '<span class="thumb-fallback" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><rect x="2.25" y="5.25" width="19.5" height="12" rx="5.75"/><path d="M7.25 8.25v6M5.25 11.25h4"/><circle cx="15.75" cy="10.5" r=".9" fill="currentColor"/><circle cx="18.25" cy="12.75" r=".9" fill="currentColor"/></svg></span>';
    var faviconUrl = host ? "https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=" + encodeURIComponent("https://" + host) + "&size=128" : "";
    /* Only distrust a thumbnail when it is served straight off a dead host -
       never when that host just happens to be wrapped inside a screenshot
       service like thum.io. */
    var thumbHost = "";
    try { thumbHost = new URL(item.thumb || "").hostname; } catch (e) { /* no thumb */ }
    var safeThumb = !!item.thumb && !isLocalFileUrl(item.thumb) && thumbHost !== "itgetyouhurt.gyalsanglama.com.np";
    /* Generated SVG covers are useful as a last resort, but they do not read
       like real game art. Prefer a raster page capture for items that expose a
       live URL, then let the existing image/favicons fallback handle failures.
       The service is intentionally opt-in per render and never replaces local
       artwork that already exists. */
    /* thum.io wants the target URL as a raw path segment - fully encoding it
       returns 400. Targets carrying their own query/hash would be ambiguous,
       so those keep the generated SVG cover. */
    var thumbUrl = String(item.thumb || "");
    var thumbTarget = /^https?:/i.test(thumbUrl) ? thumbUrl : (/^\//.test(thumbUrl) ? location.origin + thumbUrl : "");
    var rasterThumb = item.thumb && /^data:image\/svg\+xml/i.test(String(item.thumb)) && thumbTarget && thumbTarget.indexOf("?") === -1 && thumbTarget.indexOf("#") === -1
      ? "https://image.thum.io/get/width/640/crop/360/" + thumbTarget
      : "";
    if (rasterThumb) { item.__rasterThumb = rasterThumb; safeThumb = true; }
    /* 16:9 SVG banners (our Eaglercraft tiles) should fill the card like covers;
       smaller square data-URIs (icons) get the centered icon treatment. The old
       regex compared against the URL-encoded form (height%3D vs height=), so it
       never matched and every 640x360 SVG cover shrank to a small centered icon.
       Decode the data URI and check the actual SVG dimensions instead. */
    var thumbLooksLikeIcon = /favicon|apple-touch-icon|google\.com\/s2|gstatic\.com\/favicon|\/logo/i.test(item.thumb || "");
    if (/^data:image\/svg\+xml/i.test(item.thumb || "")) {
      var _svgThumbDecoded = "";
      try { _svgThumbDecoded = decodeURIComponent(item.thumb); } catch (e) { /* leave empty */ }
      if (/viewBox\s*=\s*"0 0 640 360"|width\s*=\s*"640"[^>]*height\s*=\s*"360"/i.test(_svgThumbDecoded)) {
        thumbLooksLikeIcon = false;
      }
    }
    /* thumbCover forces cover-fit for images whose URL incidentally looks like a
       logo (e.g. a big hero jpg that contains "/Logo") but should fill the box. */
    if (item.thumbCover) thumbLooksLikeIcon = false;
    /* A generated SVG cover swapped for a thum.io raster capture always fills
       the card like real art - never the centered small-icon treatment. */
    if (rasterThumb) thumbLooksLikeIcon = false;
    var fallbackAttr = faviconUrl ? ' data-fallback="' + escapeAttr(faviconUrl) + '"' : "";

    if (safeThumb) {
      var renderedThumb = item.__rasterThumb || item.thumb;
      return fallbackHtml + '<img class="thumb-art' + (thumbLooksLikeIcon ? ' thumb-icon' : '') + '" src="' + escapeAttr(renderedThumb) + '"' + fallbackAttr + ' alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.onerror=null;this.classList.add(\'thumb-failed\');' + (faviconUrl ? 'this.src=this.dataset.fallback;this.classList.add(\'thumb-icon\');' : 'this.remove();') + '">';
    }
    if (faviconUrl) {
      return fallbackHtml + '<img class="thumb-art thumb-icon" src="' + escapeAttr(faviconUrl) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.classList.add(\'thumb-failed\');this.remove()">';
    }
    return fallbackHtml;
  }

  function card(item) {
    var title = escapeHtml(item.title || "Untitled");
    var rawTitle = item.title || "Untitled";
    var host = "";
    try {
      host = item.url ? new URL(item.url).hostname.replace(/^www\./, "") : "";
    } catch (e) { /* bad URL, leave host empty */ }

    var thumb = gameThumbInner(item);

    var creditTxt = item.porter ? "web port by " + escapeHtml(item.porter) : (item.credit ? "by " + escapeHtml(item.credit) : "");
    var porter = creditTxt ? '<span class="card-sub">' + creditTxt + "</span>" : "";
    var badge = item.porter ? '<span class="card-badge">PC</span>' : "";
    var source = item.sourceLabel || (item.porter ? "PC port" : host || "web game");
    var ribbon = item.isNew ? '<span class="ribbon">New this week</span>' : "";
    /* The whole card body sits inside the launch anchor, so the source credit
       cannot be a real <a> (a nested anchor would make the parser close the
       launch link early and break the card). Render it as a clickable span and
       let the delegated #main handler below open the repo with preventDefault. */
    var sourceLink = item.sourceRepo ? '<span class="card-source-link" data-credit-repo="' + escapeAttr(item.sourceRepo) + '" title="View source repository (open source game)">' + escapeHtml(item.license ? item.license + " source" : "Source") + '</span>' : "";
    var category = item.category ? '<span class="card-cat">' + escapeHtml(item.category) + "</span>" : "";
    var htmlAttr = (item.html && String(item.html).trim()) ? ' data-html="' + escapeAttr(item.html) + '"' : "";
    /* Same-origin /game-builds pages and Unity ports must open as a real tab.
       Cloak iframes look "blocked" even when the files are hosted here. */
    var hostedHere = !!(item.url && window.ChalkleLaunch && window.ChalkleLaunch.isLocalPlayUrl && window.ChalkleLaunch.isLocalPlayUrl(item.url));
    var directAttr = (item.directOnly || hostedHere) ? ' data-direct-only="1"' : "";
    /* Blocked-network escape hatch: external http(s) games get a one-click
       "open through the proxy" button next to the favorite star. Local
       (/gn/, /game-builds/) and directOnly games never need it. */
    var canProxy = !!(item.url && /^https?:/i.test(item.url) && !item.directOnly && !hostedHere);
    var proxyBtn = canProxy
      ? '<button class="proxy-btn" data-game-proxy="' + escapeAttr(item.url) + '" data-title="' + escapeAttr(rawTitle) + '" aria-label="Open through Chalkle proxy" title="Blocked on your network? Open through Chalkle\'s proxy">' +
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l7 2.6v5.1c0 4.4-2.9 7.6-7 9.3-4.1-1.7-7-4.9-7-9.3V6.1z"/></svg></button>'
      : "";

    var href = safeHref(item.url);
    var dataTitle = escapeAttr(rawTitle);
    var tooltip = rawTitle + (item.url ? "\n" + item.url : (item.html ? "\nHTML code" : ""));
    var dataTooltip = escapeAttr(tooltip);
    var key = gameKey(item);
    var clicks = state.clicks[key] || 0;
    var fav = !!state.favs[key];
    var countLabel = clicks > 0 ? (clicks === 1 ? "1 click" : clicks + " clicks") : "";

    return (
      '<article class="card game-card">' +
      '<button class="fav-btn ' + (fav ? "is-fav" : "") + '" data-fav="' + escapeAttr(key) + '" aria-label="' + (fav ? "Remove favorite" : "Add favorite") + '">' +
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6L7.1 19l.9-5.5-4-3.9 5.5-.8z"/></svg>' +
      "</button>" +
      proxyBtn +
      '<button class="open-with" data-open-with data-url="' + escapeAttr(item.url || "") + '"' + (item.html ? ' data-html="' + escapeAttr(item.html) + '"' : "") + ' data-title="' + escapeAttr(rawTitle) + '" aria-label="Choose how to open" title="Choose how to open">' +
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.5v.1M12 12v.1M12 17.5v.1"/></svg>' +
      "</button>" +
      '<a class="game-launch" href="' + href + '" data-launch="1" data-url="' + href + '" data-title="' + dataTitle + '"' + htmlAttr + directAttr + ' title="' + dataTooltip + '">' +
      ribbon +
      '<span class="card-thumb">' + thumb + '<span class="quick-launch"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none"/></svg>Open</span></span>' +
      '<span class="card-body">' +
      '<span class="card-main"><span class="card-title" title="' + dataTooltip + '">' + title + "</span>" + category + badge + porter + "</span>" +
      '<span class="card-side"><span class="card-source">' + escapeHtml(source) + sourceLink + '</span><span class="card-count">' + countLabel + "</span></span>" +
      "</span>" +
      "</a>" +
      "</article>"
    );
  }

  /* The Games-library card: artwork fills the tile, one compact meta line
     under the title. Same delegated data attributes as the classic card, so
     favorites, the proxy escape hatch, the open-with menu and the launch
     flow all keep working untouched. */
  function gameCard(item) {
    var rawTitle = item.title || "Untitled";
    var title = escapeHtml(rawTitle);
    var thumb = gameThumbInner(item);

    var creditTxt = item.porter ? "web port by " + escapeHtml(item.porter) : (item.credit ? "by " + escapeHtml(item.credit) : "");
    var source = item.sourceLabel || (item.porter ? "PC port" : "");
    var key = gameKey(item);
    var clicks = state.clicks[key] || 0;
    var plays = playsLabel(key, clicks);
    var fav = !!state.favs[key];
    var recent = isRecentGame(key);

    /* Meta line: category first, then extra signals - only what the data
       actually carries. Play count shows only once the game has been played
       here; recents get a small Continue tag instead of a fake status. */
    var metaBits = [];
    if (item.category) metaBits.push('<span class="card-cat">' + escapeHtml(item.category) + "</span>");
    if (source) metaBits.push('<span class="card-src">' + escapeHtml(source) + "</span>");
    if (creditTxt) metaBits.push('<span class="card-src">' + creditTxt + "</span>");
    if (plays) metaBits.push('<span class="card-src card-plays">' + escapeHtml(plays) + "</span>");
    var played = playtimeLabel(key);
    if (played) metaBits.push('<span class="card-src card-time">' + escapeHtml(played) + "</span>");
    if (recent) metaBits.push('<span class="card-recent-tag">Continue</span>');
    var meta = metaBits.length ? '<span class="card-meta">' + metaBits.join('<span class="meta-sep" aria-hidden="true">&middot;</span>') + "</span>" : "";
    /* Ready marker: every library entry launches in the browser, so this
       status is honest without pretending to ping anything. */
    var status = '<span class="card-status"><span class="card-status-dot" aria-hidden="true"></span>Ready</span>';
    var metaRow = (meta || status || item.sourceRepo)
      ? '<span class="card-meta-row">' + meta + sourceLinkFor(item) + status + "</span>"
      : "";
    var htmlAttr = (item.html && String(item.html).trim()) ? ' data-html="' + escapeAttr(item.html) + '"' : "";
    var hostedHere = !!(item.url && window.ChalkleLaunch && window.ChalkleLaunch.isLocalPlayUrl && window.ChalkleLaunch.isLocalPlayUrl(item.url));
    var directAttr = (item.directOnly || hostedHere) ? ' data-direct-only="1"' : "";
    var canProxy = !!(item.url && /^https?:/i.test(item.url) && !item.directOnly && !hostedHere);
    var proxyBtn = canProxy
      ? '<button class="proxy-btn" data-game-proxy="' + escapeAttr(item.url) + '" data-title="' + escapeAttr(rawTitle) + '" aria-label="Open through Chalkle proxy" title="Blocked on your network? Open through Chalkle\'s proxy">' +
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l7 2.6v5.1c0 4.4-2.9 7.6-7 9.3-4.1-1.7-7-4.9-7-9.3V6.1z"/></svg></button>'
      : "";

    var href = safeHref(item.url);
    var tooltip = rawTitle + (item.url ? "\n" + item.url : (item.html ? "\nHTML code" : ""));
    var ribbon = item.isNew ? '<span class="ribbon">New</span>' : "";

    return (
      '<article class="card game-card">' +
      '<button class="fav-btn ' + (fav ? "is-fav" : "") + '" data-fav="' + escapeAttr(key) + '" aria-label="' + (fav ? "Remove favorite" : "Add favorite") + '">' +
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6L7.1 19l.9-5.5-4-3.9 5.5-.8z"/></svg>' +
      "</button>" +
      proxyBtn +
      '<button class="open-with" data-open-with data-url="' + escapeAttr(item.url || "") + '"' + (item.html ? ' data-html="' + escapeAttr(item.html) + '"' : "") + ' data-title="' + escapeAttr(rawTitle) + '" aria-label="Choose how to open" title="Choose how to open">' +
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.5v.1M12 12v.1M12 17.5v.1"/></svg>' +
      "</button>" +
      '<a class="game-launch" href="' + href + '" data-launch="1" data-url="' + href + '" data-title="' + escapeAttr(rawTitle) + '"' + htmlAttr + directAttr + ' title="' + escapeAttr(tooltip) + '">' +
      ribbon +
      '<span class="card-thumb">' + thumb + '<span class="quick-launch"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none"/></svg>Play</span></span>' +
      '<span class="card-body">' +
      '<span class="card-title" title="' + escapeAttr(tooltip) + '">' + title + "</span>" +
      metaRow +
      "</span>" +
      "</a>" +
      "</article>"
    );
  }

  /* Source link shared by both card flavors. A span, not an <a>: nested links
     inside the card's launch <a> are invalid HTML, so the delegated #main
     handler opens the repo with preventDefault instead. */
  function sourceLinkFor(item) {
    return item.sourceRepo
      ? '<span class="card-source-link" data-credit-repo="' + escapeAttr(item.sourceRepo) + '" title="View source repository (open source game)">' + escapeHtml(item.license ? item.license + " source" : "Source") + '</span>'
      : "";
  }

  /* Apps/Tools get their own presentation: a clean app tile with a rounded
     icon, title, category chip and an open affordance - themed to match the
     rest of Chalkle instead of the generic game card. */
  /* Walled targets (login-heavy socials/streaming) need the proxy to be
     usable at all, unlike plain bypass targets that only need it on filtered
     networks. Drives the proxy pill colour on app tiles. */
  function proxyWalled(cat) {
    return cat === "Social" || cat === "Streaming" || cat === "Music" || cat === "Video";
  }

  function toolCard(item) {
    var rawTitle = item.title || "Untitled";
    var title = escapeHtml(rawTitle);
    var href = safeHref(item.url);
    var htmlAttr = (item.html && String(item.html).trim()) ? ' data-html="' + escapeAttr(item.html) + '"' : "";
    /* Built-in apps (Blank tab launcher, HTML Editor) open their own modal
       instead of launching a URL - data-tool-kind handles that in the click
       handler. Everything else is a plain link tile. */
    var kind = item.kind === "editor" || item.kind === "urlauditor" || item.kind === "pixel" || item.kind === "domainhub" || item.kind === "iphone16" || item.kind === "browser" || item.kind === "vm" ? escapeAttr(item.kind) : "";
    var kindAttr = kind ? ' data-tool-kind="' + kind + '"' : '';
    var isProxy = item.via === "proxy" && !!item.url;
    var proxyAttr = isProxy ? ' data-proxy-app="' + escapeAttr(item.url) + '"' : "";
    var toolLetter = escapeHtml(rawTitle.charAt(0).toUpperCase() || "?");
    var toolFallback = '<span class="tool-tile-letter" aria-hidden="true">' + toolLetter + '</span>';
    var thumb = item.thumb && !isLocalFileUrl(item.thumb)
      ? toolFallback + '<img class="tool-tile-img" src="' + escapeAttr(item.thumb) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.onerror=null;this.classList.add(\'tool-tile-img-failed\');">'
      : toolFallback;
    var via = isProxy
      ? '<span class="tool-tile-via ' + (proxyWalled(item.category) ? "is-walled" : "is-bypass") + '" title="' + (proxyWalled(item.category)
          ? "Walled site - opens through Chalkle's proxy so it works on school Wi-Fi"
          : "Often blocked on school networks - opens through Chalkle's proxy") + '">proxy</span>'
      : "";
    var cat = item.category ? '<span class="card-cat">' + escapeHtml(item.category) + "</span>" : "";
    var note = item.note ? '<span class="tool-tile-note">' + escapeHtml(item.note) + "</span>" : "";
    var tileHref = (kind || isProxy) ? "#" : href;
    return (
      '<article class="tool-tile' + (isProxy ? " is-proxy" : "") + '">' +
      '<a class="tool-tile-link" href="' + tileHref + '"' + kindAttr + proxyAttr + (kind || isProxy ? '' : ' data-launch="1" data-url="' + href + '" data-title="' + escapeAttr(rawTitle) + '"' + htmlAttr) + ' title="Open ' + escapeAttr(rawTitle) + '">' +
      '<span class="tool-tile-art">' + thumb + "</span>" +
      '<span class="tool-tile-body">' +
      '<span class="tool-tile-title">' + title + "</span>" +
      '<span class="tool-tile-meta">' + cat + via + '<span class="tool-tile-open">Open</span></span>' + note +
      "</span>" +
      "</a>" +
      (kind || isProxy ? "" : '<button class="open-with open-with-tool" data-open-with data-url="' + escapeAttr(item.url || "") + '" data-title="' + escapeAttr(rawTitle) + '" aria-label="Open in a new tab" title="Open in a new tab">' +
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.5v.1M12 12v.1M12 17.5v.1"/></svg>' +
        "</button>") +
      "</article>"
    );
  }

  /* Editor's picks: a curated shelf shown on Home and at the top of the
     Games tab. Change PICK_TITLES here; titles must match games.js entries.
     First match wins, so a duplicate title picks the earlier entry. */
  var PICK_TITLES = [
    "Undertale", "Deltarune", "Cookie Clicker", "1v1.LOL",
    "Retro Bowl", "BitLife", "Slither.io", "Minecraft James Edition (26.2)",
    "Geometry Dash", "Subway Surfers", "Happy Wheels", "Stardew Valley"
  ];
  function pickItems() {
    var list = DATA.games || [];
    return PICK_TITLES.map(function (t) {
      for (var i = 0; i < list.length; i++) {
        if ((list[i].title || "") === t) return list[i];
      }
      return null;
    }).filter(Boolean);
  }
  function renderPicks() {
    var items = pickItems();
    var home = document.getElementById("home-picks");
    var games = document.getElementById("games-picks");
    var homeGrid = document.getElementById("home-picks-grid");
    var gamesGrid = document.getElementById("games-picks-grid");
    if (home) home.hidden = items.length === 0;
    if (homeGrid) homeGrid.innerHTML = items.map(gameCard).join("");
    /* On the Games tab the shelf is editorial browsing only - once the user
       searches or filters the grid it steps aside instead of showing a
       second, unrelated list of cards above the results. */
    if (games) {
      var browsing = !state.query &&
        !(state.genreFilters && state.genreFilters.length) &&
        (state.gameFilter === "all" || !state.gameFilter);
      games.hidden = items.length === 0 || !browsing;
      if (gamesGrid && !games.hidden) gamesGrid.innerHTML = items.map(gameCard).join("");
    }
  }

  /* Cover wall for the launch splash: the most played games plus a few
     random picks from the same category, excluding the launched game. */
  function splashCovers(item) {
    var list = DATA.games || [];
    var key = gameKey(item);
    var pool = [];
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      if (!g || gameKey(g) === key) continue;
      var ck = gameKey(g);
      pool.push({ g: g, plays: state.clicks[ck] || 0, same: g.category && item.category && g.category === item.category });
    }
    pool.sort(function (a, b) { return (b.same - a.same) || (b.plays - a.plays); });
    var top = pool.slice(0, 6);
    var rest = pool.slice(6);
    for (var j = rest.length - 1; j > 0; j--) {
      var k = Math.floor(Math.random() * (j + 1));
      var tmp = rest[j]; rest[j] = rest[k]; rest[k] = tmp;
    }
    var picks = top.concat(rest.slice(0, 3)).slice(0, 9);
    return picks.map(function (p) {
      return { t: p.g.title || "", i: gameThumbInner(p.g) };
    });
  }

  function gameKey(item) {
    return String((item && (item.url || item.title)) || "").toLowerCase();
  }

  /* Natural compare: "level 2" sorts before "level 10", not after it.
     Falls back to localeCompare for equal digit runs so letter casing and
     accents still order sensibly. */
  function naturalCmp(a, b) {
    var as = String(a || "").toLowerCase();
    var bs = String(b || "").toLowerCase();
    var ai = 0, bi = 0;
    while (ai < as.length && bi < bs.length) {
      var ac = as.charCodeAt(ai), bc = bs.charCodeAt(bi);
      var aDig = ac >= 48 && ac <= 57, bDig = bc >= 48 && bc <= 57;
      if (aDig && bDig) {
        var aj = ai, bj = bi;
        while (aj < as.length && as.charCodeAt(aj) >= 48 && as.charCodeAt(aj) <= 57) aj++;
        while (bj < bs.length && bs.charCodeAt(bj) >= 48 && bs.charCodeAt(bj) <= 57) bj++;
        /* Skip leading zeros so "007" == "7"; longer run means bigger number. */
        var az = ai; while (az < aj - 1 && as.charCodeAt(az) === 48) az++;
        var bz = bi; while (bz < bj - 1 && bs.charCodeAt(bz) === 48) bz++;
        if (aj - az !== bj - bz) return (aj - az) - (bj - bz);
        while (az < aj && bz < bj) {
          if (as.charCodeAt(az) !== bs.charCodeAt(bz)) return as.charCodeAt(az) - bs.charCodeAt(bz);
          az++; bz++;
        }
        ai = aj; bi = bj;
      } else {
        if (ac !== bc) return ac - bc;
        ai++; bi++;
      }
    }
    return (as.length - ai) - (bs.length - bi);
  }

  /* A game counts as "recent" if it is in the saved recents list. */
  function isRecentGame(key) {
    var list = readJson(RECENTS_KEY, []);
    key = String(key || "").toLowerCase();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].key || "").toLowerCase() === key) return true;
    }
    return false;
  }

  /* opts: { label, onClick, sticky }. Plain calls behave exactly as before -
     a line of text that fades. `sticky` plus a label turns it into something
     that waits for an answer (the update prompt), which is the only kind of
     notice that must not disappear before it is read. */
  function showToast(msg, opts) {
    var box = $("#toast-box");
    if (!box || !msg) return null;
    var o = opts || {};
    var t = document.createElement("div");
    t.className = "toast" + (o.sticky ? " is-sticky" : "");
    var txt = document.createElement("span");
    txt.className = "toast-txt";
    txt.textContent = msg;
    t.appendChild(txt);
    if (o.label && typeof o.onClick === "function") {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toast-action";
      btn.textContent = o.label;
      btn.addEventListener("click", function () {
        if (t.parentNode) t.parentNode.removeChild(t);
        try { o.onClick(); } catch (e) { /* the handler owns its own errors */ }
      });
      t.appendChild(btn);
    }
    box.appendChild(t);
    if (!o.sticky) {
      setTimeout(function () { t.classList.add("is-out"); }, 1500);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 1900);
    }
    return t;
  }

  /* A newer build is live on the server. Nothing reloads on its own - a game
     mid-level is worth more than a build - but the offer waits until it is
     answered or refreshed away. */
  var updateShownFor = "";
  document.addEventListener("chalkle:update-ready", function (e) {
    var detail = (e && e.detail) || {};
    var build = String(detail.build || "");
    if (build && build === updateShownFor) return;
    updateShownFor = build;
    showToast("A newer Chalkle is live", {
      label: "Update",
      sticky: true,
      onClick: function () {
        if (window.ChalkleCore && window.ChalkleCore.applyUpdate) window.ChalkleCore.applyUpdate();
        else try { location.reload(); } catch (err) { /* nothing else to try */ }
      }
    });
  });

  /* Ask once after boot: a tab left open across a deploy finds out on its own.
     Delayed past the first paint so the check never competes with drawing. */
  setTimeout(function () {
    if (window.ChalkleCore && window.ChalkleCore.checkForUpdate) {
      try { window.ChalkleCore.checkForUpdate(true); } catch (e) { /* offline */ }
    }
  }, 3000);

  /* The Browser tool, the ad check and any future module call this instead of
     owning a second notification style. browser.js already shipped calls to
     window.ChalkleToast.show - they silently did nothing until this line. */
  window.ChalkleToast = { show: showToast };

  var gridExpandAll = false;
  /* Remember the expanded grid per view for this session (#155): once you
     hit "Show all", coming back to the tab keeps the full grid instead of
     silently re-capping it at 480. */
  var EXPAND_KEY = "chalkle-grid-expanded";
  function readExpand() {
    try {
      var d = JSON.parse(sessionStorage.getItem(EXPAND_KEY) || "{}");
      return !!(d && d[state.view] === true);
    } catch (e) { return false; }
  }
  function writeExpand(on) {
    try {
      var d = JSON.parse(sessionStorage.getItem(EXPAND_KEY) || "{}");
      if (on) d[state.view] = true; else delete d[state.view];
      sessionStorage.setItem(EXPAND_KEY, JSON.stringify(d));
    } catch (e) { /* no storage */ }
  }

  function render(expandAll) {
    if (typeof expandAll === "boolean") {
      gridExpandAll = expandAll;
      writeExpand(expandAll);
    } else {
      gridExpandAll = readExpand();
    }
    if (state.view === "music") return; /* owned by music.js */
    renderPicks(); /* fill the curated shelf; Home refreshes it in renderHome */
    renderGameFeature(); /* Games hero panel; hides itself on other views */
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
          if (state.gameFilter === "recents") return isRecentGame(key);
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
          var popular = playScore(bk) - playScore(ak);
          if (popular) return popular;
        }
        /* Trending is the same ranking with the week's plays only, so a game
           people just picked up beats an old favorite that nobody opens. */
        if (state.sort === "trending") {
          var hot = sharedTrend(bk) - sharedTrend(ak);
          if (hot) return hot;
          var lifetime = sharedPlays(bk) - sharedPlays(ak);
          if (lifetime) return lifetime;
        }
        if (state.sort === "time") {
          var spent = playtimeMs(bk) - playtimeMs(ak);
          if (spent) return spent;
        }
        var at = (a.title || "");
        var bt = (b.title || "");
        return state.sort === "za" ? naturalCmp(bt, at) : naturalCmp(at, bt);
      });
      renderGameStats(items.length);
    }

    if (state.view === "apps-tools") {
      if (state.appFilters && state.appFilters.length) {
        items = items.filter(function (item) {
          for (var i = 0; i < state.appFilters.length; i++) {
            if (itemCategory(item) === state.appFilters[i]) return true;
          }
          return false;
        });
      }
      renderAppChips();
    }

    /* Text filter for the Games tab: with a 2,700+ game library and a 480-card
       initial render, titles below the cap are unfindable by scrolling. This
       narrows the grid live; Escape or the native clear button resets it. */
    if (state.view === "games" || state.view === "apps-tools") {
      var fq = String(state.gridFilter || "").toLowerCase().trim();
      if (fq) {
        /* Two passes: the literal one people expect, then a lenient one so
           "gta5" finds "GTA 5", "amongus" finds "Among Us" and "gd" finds
           "Geometry Dash" instead of an empty grid. */
        var foldQ = matchFold(fq);
        var lenient = foldQ.length >= 2;
        items = items.filter(function (item) {
          var title = String(item.title || item.name || "").toLowerCase();
          if (title.indexOf(fq) !== -1) return true;
          var cat = String(item.category || "").toLowerCase();
          if (cat.indexOf(fq) !== -1) return true;
          if (!lenient) return false;
          var foldTitle = matchFold(title);
          if (foldTitle.indexOf(foldQ) !== -1) return true;
          return initialsMatch(title, foldQ);
        });
      }
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
       swaps stay fast; a "Show more" button expands to the full set. The
       cap halves on low-power devices (the same signal as the Motion
       default) - content-visibility already keeps scrolling cheap, but
       building 240 cards instead of 480 keeps the first grid paint fast
       on a Chromebook's CPU. */
    var GRID_CAP = window.__chalkleLowPower ? 240 : 480;
    var capped = items.length > GRID_CAP && !gridExpandAll;
    var shown = capped ? items.slice(0, GRID_CAP) : items;
    var cardFn = state.view === "apps-tools" ? toolCard : (state.view === "games" ? gameCard : card);
    var html = shown.map(cardFn).join("");
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
     The full self-contained Eaglercraft 26.2 client ships with the site at
     /mc/eaglercraft-26.2.html - a single 75MB HTML file with every asset
     inlined (no CDN, no relay, nothing to block), served from this origin.
     On the hosted site that's the whole game: one tap, runs in its own tab.
     Static mirrors (jsDelivr/GitHub Pages) can't serve the 75MB client, so
     they fall back to the School Center tunnel URL if the dev stack set one
     (SCHOOL_CENTER_CONFIG.minecraftUrl), then localhost. */
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
    /* The self-contained client is a first-class origin asset. Only reach
       for the tunnel/localhost fallback on static mirrors where /mc/ is not
       served at all. */
    try {
      if (!window.ChalkleApi || !window.ChalkleApi.isMirror || !window.ChalkleApi.isMirror()) {
        return "/mc/eaglercraft-26.2.html";
      }
    } catch (e) { /* fall through to local */ }
    try {
      var cfg = window.SCHOOL_CENTER_CONFIG;
      if (cfg && cfg.minecraftUrl) return cfg.minecraftUrl;
    } catch (e) { /* no config */ }
    /* Mirror fallback: the tunnel relay serves the same /mc/ tree, which is
       far better than a dead localhost:80 that can never answer. */
    try {
      if (window.ChalkleApi && window.ChalkleApi.url) {
        var relayed = window.ChalkleApi.url("/mc/eaglercraft-26.2.html");
        if (/^https?:/i.test(relayed)) return relayed;
      }
    } catch (e) { /* fall through */ }
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

  /* Games tab hero: the single flagged feature from the library (or the
     most-played game when nothing is flagged) as a large cinematic panel.
     Play goes through the same delegated [data-launch] flow as the grid
     cards; the favorite control reuses the shared [data-fav] handler. */
  function renderGameFeature() {
    var box = document.getElementById("games-feature");
    if (!box) return;
    if (state.view !== "games") {
      box.hidden = true;
      return;
    }
    var games = (DATA.games || []).slice().filter(Boolean);
    var item = null;
    for (var i = 0; i < games.length; i++) {
      if (games[i].featured) { item = games[i]; break; }
    }
    if (!item) {
      games.sort(function (a, b) {
        return (state.clicks[gameKey(b)] || 0) - (state.clicks[gameKey(a)] || 0);
      });
      item = games[0];
    }
    if (!item) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    var rawTitle = item.title || "Untitled";
    /* Same key the grid cards use, so favoriting the feature lights the
       matching card and the Favorites filter finds it. */
    var key = gameKey(item);
    var fav = !!state.favs[key];
    var clicks = state.clicks[key] || 0;
    var metaBits = [];
    if (item.category) metaBits.push(escapeHtml(item.category));
    if (item.porter) metaBits.push("web port by " + escapeHtml(item.porter));
    else if (item.credit) metaBits.push("by " + escapeHtml(item.credit));
    if (clicks > 0) metaBits.push(clicks === 1 ? "1 play" : clicks + " plays");

    var href = safeHref(item.url);
    var htmlAttr = (item.html && String(item.html).trim()) ? ' data-html="' + escapeAttr(item.html) + '"' : "";
    var hostedHere = !!(item.url && window.ChalkleLaunch && window.ChalkleLaunch.isLocalPlayUrl && window.ChalkleLaunch.isLocalPlayUrl(item.url));
    var directAttr = (item.directOnly || hostedHere) ? ' data-direct-only="1"' : "";

    var art;
    if (isJamesEdition(item)) {
      art = '<img class="game-feature-img" src="' + escapeAttr(MC_KEY_ART) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src=' + JSON.stringify(MC_FEAT_MARK) + '">';
    } else {
      art = gameThumbInner(item);
    }

    box.innerHTML =
      '<div class="game-feature-art">' + art + "</div>" +
      '<div class="game-feature-body">' +
      '<span class="game-feature-eyebrow">Featured game</span>' +
      '<h2 class="game-feature-title">' + escapeHtml(rawTitle) + "</h2>" +
      (metaBits.length ? '<span class="game-feature-meta">' + metaBits.join('<span class="meta-sep" aria-hidden="true">&middot;</span>') + "</span>" : "") +
      '<div class="game-feature-actions">' +
      '<a class="btn btn-accent" href="' + href + '" data-launch="1" data-url="' + href + '" data-title="' + escapeAttr(rawTitle) + '"' + htmlAttr + directAttr + '>Play</a>' +
      '<button class="btn" data-fav="' + escapeAttr(key) + '" aria-label="' + (fav ? "Remove favorite" : "Add favorite") + '">' + (fav ? "Favorited" : "Favorite") + "</button>" +
      "</div></div>";
  }

  /* ---------- Game player ---------- */

  /* Small related shelf: same category first, then same porter, then the
     most-played fill. Real data only - no invented recommendations. */
  function relatedGames(item, n) {
    var list = (DATA.games || []).filter(Boolean);
    var selfKey = gameKey(item);
    var cat = item.category || "";
    var porter = item.porter || "";
    var out = [];
    var seen = {};
    function push(x) {
      var k = gameKey(x);
      if (seen[k] || k === selfKey) return;
      seen[k] = 1;
      out.push(x);
    }
    list.forEach(function (x) { if (cat && x.category === cat) push(x); });
    list.forEach(function (x) { if (porter && x.porter === porter) push(x); });
    list.slice().sort(function (a, b) {
      return (state.clicks[gameKey(b)] || 0) - (state.clicks[gameKey(a)] || 0);
    }).forEach(function (x) { push(x); });
    return out.slice(0, n);
  }

  /* Open a game in the dedicated in-app player. Returns false when the game
     must not be embedded (James Edition, directOnly) so the caller falls
     back to the old launch flow. */
  function openGamePlayer(item) {
    if (!item || !window.ChalkleGamePlayer) return false;
    if (item.directOnly) return false;
    if (isJamesEdition(item)) return false;
    var url = String(item.url || "");
    var target = "";
    if (item.html && window.ChalkleLaunch && window.ChalkleLaunch.htmlUrl) {
      target = window.ChalkleLaunch.htmlUrl(item.html);
    }
    if (!target && window.ChalkleLaunch && window.ChalkleLaunch.playTarget) {
      target = window.ChalkleLaunch.playTarget(url);
    }
    if (!target) return false;
    if (window.ChalkleLaunch && window.ChalkleLaunch.pauseMusicForTarget) {
      window.ChalkleLaunch.pauseMusicForTarget(url);
    }
    /* The game player always makes sound: stop Chalkle Music regardless of
       what the target URL is, so the two never play over each other. */
    try { if (window.ChalkleMusic && window.ChalkleMusic.pause) window.ChalkleMusic.pause(); } catch (e) { /* no music module */ }
    var art = gameThumbInner(item);
    var metaBits = [];
    if (item.category) metaBits.push(escapeHtml(item.category));
    if (item.porter) metaBits.push("web port by " + escapeHtml(item.porter));
    else if (item.credit) metaBits.push("by " + escapeHtml(item.credit));
    var key = gameKey(item);
    return window.ChalkleGamePlayer.open(target, item.title || "Playing", {
      art: art,
      sub: item.category ? escapeHtml(item.category) : "",
      meta: metaBits.join('<span class="meta-sep" aria-hidden="true">&middot;</span>'),
      originalUrl: url,
      favKey: key,
      fav: !!state.favs[key],
      covers: splashCovers(item),
      related: relatedGames(item, 8).map(gameCard).join(""),
      onFav: function (favKey, isFav) {
        if (isFav) state.favs[favKey] = 1; else delete state.favs[favKey];
        persist(FAVS_KEY, JSON.stringify(state.favs));
        render();
        showToast(isFav ? "Added to favorites" : "Removed from favorites");
      }
    });
  }

  /* Map a launched card back to its library item so the player can show real
     artwork, meta and related games. */
  function findGameByLaunch(launch) {
    var url = launch.dataset.url || "";
    var want = gameKey({ url: url, title: launch.dataset.title || "" });
    var list = DATA.games || [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it) continue;
      if (it.url === url) return it;
      if (gameKey(it) === want) return it;
    }
    return null;
  }

  function renderHome() {
    /* One broken shelf must never blank the rest of Home. */
    try { renderHomeInner(); } catch (e) {
      try { console.warn("renderHome shelf failed:", e); } catch (e2) { /* ignore */ }
    }
  }

  function renderHomeInner() {
    var g = $("#home-stat-games");
    var s = $("#home-stat-sites");
    var t = $("#home-stat-tools");
    var tm = $("#home-stat-time");
    if (g) g.textContent = (DATA.games || []).length;
    if (s) s.textContent = (DATA.sites || []).length;
    if (t) t.textContent = (DATA["apps-tools"] || []).length;
    if (tm) {
      tm.textContent = window.ChalklePlaytime ? window.ChalklePlaytime.format(window.ChalklePlaytime.total()) : "0m";
    }

    renderPicks();

    renderRecents();

    /* Featured banner - Minecraft James Edition, always front and center so
       it stays one click away on Home. */
    var featured = $("#home-featured");
    if (featured) {
      featured.innerHTML =
        '<button class="home-featured" data-featured-mc>' +
        '<span class="home-featured-img"><img src="' + escapeAttr(MC_KEY_ART) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src=' + JSON.stringify(MC_FEAT_MARK) + '"></span>' +
        '<span class="home-featured-body">' +
        '<span class="home-featured-eyebrow">Featured game<span class="home-feat-badge">Web</span></span>' +
        '<span class="home-featured-title">Minecraft James Edition</span>' +
        '<span class="home-featured-desc">The full self-contained Eaglercraft 26.2 client served straight from this site. Survival, creative, servers. Nothing to download or block.</span>' +
        '<span class="home-featured-cta">Play now</span>' +
        "</span></button>";
      featured.querySelector("[data-featured-mc]").addEventListener("click", function () {
        openJamesEdition("Minecraft James Edition");
      });
    }

    var popularBox = $("#home-popular-games");
    if (popularBox) {
      /* The shelf heading promises what everyone has been launching. It used
         to rank this device's own clicks plus favorites; now it ranks the
         shared counts, with the local signal as the fallback. */
      var games = (DATA.games || []).slice().filter(Boolean).sort(function (a, b) {
        var ak = gameKey(a);
        var bk = gameKey(b);
        return playScore(bk) - playScore(ak);
      }).slice(0, 6);
      popularBox.innerHTML = games.map(function (item) {
        var title = escapeHtml(item.title || "Untitled");
        var key = item._id || gameKey(item);
        var rasterTarget = String(item.url || "");
        var rasterTargetAbs = /^https?:/i.test(rasterTarget) ? rasterTarget : (/^\//.test(rasterTarget) ? location.origin + rasterTarget : "");
        var raster = item.thumb && /^data:image\/svg\+xml/i.test(String(item.thumb)) && rasterTargetAbs && rasterTargetAbs.indexOf("?") === -1 && rasterTargetAbs.indexOf("#") === -1
          ? "https://image.thum.io/get/width/640/crop/360/" + rasterTargetAbs
          : item.thumb;
        var art = (raster && !isLocalFileUrl(raster))
          ? hvFallback(escapeHtml((item.title || "?").charAt(0).toUpperCase() || "?")) + hvImg(raster, "")
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
            } else {
              window.ChalkleLaunch.openWithOptions(item.url || "", item.title || "");
            }
          }
        });
      });
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
    if (els.backdrop) els.backdrop.hidden = !open;
  }

  function closeSidebar() {
    document.body.classList.remove("sidebar-open");
    $("#hamburger").setAttribute("aria-expanded", "false");
    if (els.backdrop) els.backdrop.hidden = true;
  }

  /* ---------- Options ---------- */  function applyOptions() {
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

  function toggleAppFilter(cat) {
    var list = state.appFilters.slice();
    var i = list.indexOf(cat);
    if (i === -1) list.push(cat);
    else list.splice(i, 1);
    state.appFilters = list;
    render();
  }

  function renderAppChips() {
    var box = $("#apps-genres");
    if (!box) return;
    var seen = {};
    var cats = [];
    (DATA["apps-tools"] || []).forEach(function (a) {
      if (!a) return;
      var c = itemCategory(a);
      if (c && !seen[c]) { seen[c] = 1; cats.push(c); }
    });
    if (!cats.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML =
      '<button class="chip' + (state.appFilters.length === 0 ? " is-active" : "") + '" data-app-all>All</button>' +
      cats.map(function (c) {
        return '<button class="chip' + (state.appFilters.indexOf(c) !== -1 ? " is-active" : "") + '" data-app-cat="' + escapeAttr(c) + '">' + escapeHtml(c) + "</button>";
      }).join("");
    box.querySelectorAll(".chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.dataset.appAll !== undefined) {
          state.appFilters = [];
          render();
        } else {
          toggleAppFilter(btn.dataset.appCat);
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
    /* Same rule as sanitizeItem(): a file:/javascript: snapshot can never load
       on a hosted site, and Chrome logs the file:/// security error the moment
       it lands in the DOM - so never persist it into recents. */
    rec.unshift({
      key: key,
      title: String(title || ""),
      t: Date.now(),
      thumb: item && !isLocalFileUrl(item.thumb) ? item.thumb : undefined,
      url: item && !isLocalFileUrl(item.url) ? item.url : undefined,
      html: item && !isLocalFileUrl(item.html) ? item.html : undefined
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
         shows real art and stays relaunchable. Legacy entries may carry a
         file:/javascript: snapshot (saved before snapshots were sanitized) -
         strip it here so it can never reach the DOM. */
      return {
        title: r.title,
        _ghost: true,
        thumb: isLocalFileUrl(r.thumb) ? undefined : r.thumb,
        url: isLocalFileUrl(r.url) ? undefined : r.url,
        html: isLocalFileUrl(r.html) ? undefined : r.html
      };
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
          var recKey = item._id || gameKey(item);
          /* The Continue shelf is the one place a real time is worth more
             than the word "Continue". */
          var recStatus = playtimeLabel(recKey);
          if (recStatus) recStatus = recStatus.replace(" played", "");
          return homeCard("home-game", recKey, title, recStatus || "Continue", art);
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
    /* Fade the right edge while more cards are scrolled past - the mask lifts
       once the strip reaches the end so the last card is always crisp. */
    function updateFade() {
      if (!track) return;
      var wrap = track.parentElement;
      if (!wrap) return;
      var atEnd = track.scrollLeft >= track.scrollWidth - track.clientWidth - 20;
      wrap.classList.toggle("is-masked", !atEnd);
    }
    if (track) {
      track.addEventListener("scroll", function () { updateArrows(); updateFade(); }, { passive: true });
      if (prev) prev.addEventListener("click", function () { track.scrollBy({ left: -track.clientWidth * 0.8, behavior: "smooth" }); });
      if (next) next.addEventListener("click", function () { track.scrollBy({ left: track.clientWidth * 0.8, behavior: "smooth" }); });
      window.setTimeout(function () { updateArrows(); updateFade(); }, 60);
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
    { id: "slides", name: "Google Slides", title: "Untitled presentation - Google Slides", icon: "https://ssl.gstatic.com/images/branding/product/1x/slides_2020q4_32dp.png" },
    { id: "drive", name: "Drive", title: "My Drive - Google Drive", icon: "https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png" },
    { id: "canva", name: "Canva", title: "Home - Canva", icon: "https://static.canva.com/static/images/favicon.ico" },
    { id: "canvas", name: "Canvas", title: "Dashboard", icon: "https://du11hjcvx0uqb.cloudfront.net/dist/images/favicon.ico" },
    { id: "clever", name: "Clever", title: "Clever | Portal", icon: "https://www.clever.com/wp-content/uploads/2023/06/cropped-Favicon-512px-32x32.png" },
    { id: "khan", name: "Khan Academy", title: "Dashboard | Khan Academy", icon: "https://www.khanacademy.org/favicon.ico" },
    { id: "studyisland", name: "Study Island", title: "Edmentum\u00ae Learning Environment Login", icon: "https://app.studyisland.com/favicon.ico" },
    /* The three Pyrus ships that Chalkle's list was missing. Their own
       favicons answer with HTML or 403, so the icons come from Google's
       favicon service, which returns a real PNG. */
    { id: "schoology", name: "Schoology", title: "Home | Schoology", icon: "https://www.google.com/s2/favicons?domain=schoology.com&sz=64" },
    { id: "edgenuity", name: "Edgenuity", title: "Edgenuity Student Portal", icon: "https://www.google.com/s2/favicons?domain=edgenuity.com&sz=64" },
    { id: "classlink", name: "ClassLink", title: "ClassLink | Login", icon: "https://www.google.com/s2/favicons?domain=classlink.com&sz=64" },
    { id: "ixl", name: "IXL", title: "IXL | Math, Language Arts, Science, Social Studies, and Spanish", icon: "https://www.ixl.com/dv3/powZqMuTE7du4asFrVyNGxxoqkw/yui3/opengraph/assets/square_og_ixl.png" }
  ];

  /* Capture the real favicon href once, at first apply, so "None" restores it. */
  function captureCloakIcon() {
    if (cloakIcon) return;
    var link = document.querySelector('link[rel="icon"]');
    cloakIcon = link ? link.getAttribute("href") : "";
  }

  /* Custom cloak overrides (arsenic style): a personal title and icon that
     ride on top of any preset. Saved by the Settings fields further down. */
  function customCloak() {
    var t = "", icon = "";
    try {
      t = (localStorage.getItem("chalkle-cloak-title") || "").trim();
      icon = (localStorage.getItem("chalkle-cloak-icon") || "").trim();
    } catch (e) { /* no storage */ }
    return { title: t, icon: icon };
  }

  /* Apply (or clear) the tab cloak. */
  function applyCloak(id) {
    captureCloakIcon();
    var cloak = null;
    for (var i = 0; i < CLOAKS.length; i++) {
      if (CLOAKS[i].id === id) { cloak = CLOAKS[i]; break; }
    }
    var activeId = cloak ? cloak.id : "";
    var custom = customCloak();
    /* No cloak = keep the tab looking like the IXL preview, so what Discord
       promised and what the tab shows always agree. A custom title or icon
       from Settings wins over the preset when present. */
    document.title = custom.title || (cloak ? cloak.title
      : "IXL | Math, Language Arts, Science, Social Studies, and Spanish");
    var link = document.querySelector('link[rel="icon"]');
    if (link) link.href = custom.icon || (cloak ? cloak.icon : cloakIcon);
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

  /* ---------- Panic key (arsenic's escape hatch, ported) ----------
     One keypress swaps the page for an innocent site, or resurrects the
     educational cover, so a glance at the screen shows nothing suspicious.
     Config persists in localStorage so it works on every load. */
  var PANIC_CFG_KEY = "chalkle-panic";

  function panicConfig() {
    var cfg = { key: "`", target: "https://classroom.google.com/u/0/h" };
    try {
      var raw = localStorage.getItem(PANIC_CFG_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        if (saved && typeof saved.key === "string" && saved.key.length === 1) cfg.key = saved.key;
        if (saved && typeof saved.target === "string" && saved.target) cfg.target = saved.target;
      }
    } catch (e) { /* no storage or bad JSON: defaults hold */ }
    return cfg;
  }

  function savePanicConfig(key, target) {
    try { localStorage.setItem(PANIC_CFG_KEY, JSON.stringify({ key: key, target: target })); } catch (e) { /* no storage */ }
  }

  function panicEscape() {
    var cfg = panicConfig();
    if (cfg.target === "ixl") {
      /* The cover markup was captured at boot before removal (see index.html);
         rebuild it so the page looks exactly like the educational site. */
      try {
        if (!document.getElementById("ixl-cover") && window.ChalkleCoverHTML) {
          document.body.insertAdjacentHTML("afterbegin", window.ChalkleCoverHTML);
          var cover = document.getElementById("ixl-cover");
          if (cover) {
            /* The cover's own CSS assumes boot order (first in body). Rebuilt
               mid-session it must outright cover the app shell instead, which
               uses fixed chrome, so take over the viewport inline. */
            cover.style.cssText = "position:fixed;inset:0;z-index:2147483647;overflow:auto;background:#fff;margin:0;padding:0;";
          }
        }
        window.scrollTo(0, 0);
      } catch (e) { /* cover already up or rebuild failed */ }
      try { if (window.ChalkleMusic && window.ChalkleMusic.pause) window.ChalkleMusic.pause(); } catch (e) { /* no music */ }
      document.title = "IXL | Math, Language Arts, Science, Social Studies, and Spanish";
      return;
    }
    /* replace, not assign: the panic page must not sit behind the Back button. */
    location.replace(cfg.target);
  }

  document.addEventListener("keydown", function (e) {
    /* Never hijack keys while the user is typing somewhere, and never eat
       browser shortcuts. */
    var t = e.target;
    var tag = (t && t.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === panicConfig().key) {
      e.preventDefault();
      panicEscape();
    }
  });

  /* ---------- Admin panel ----------
     Locked behind a code. Lets you add / edit / delete games, sites, tools
     and proxies - each game or site can be a link (URL) and/or raw HTML code,
     and anything launches inside Chalkle\u2019s own browser (proxy-routed when needed). All changes persist to this device. */

  var ADMIN_CODE = "jamesypoo";
  var ADMIN_TABS = ["games", "tools", "proxies", "docs", "partners"];

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
    var role = m.role ? '<div class="board-role">' + escapeHtml(m.role) + "</div>" : "";
    return '<article class="board-person">' + avatar + '<div class="board-name">' + name + "</div>" + role + "</article>";
  }

  function renderBoard() {
    var root = document.querySelector(".board-columns");
    if (!root) return;
    var members = (DATA.board || []).filter(Boolean);
    root.innerHTML = BOARD_COLS.map(function (col) {
      var inCol = members.filter(function (m) { return String(m.category || "").trim() === col; });
      var body = inCol.length
        ? '<div class="board-members">' + inCol.map(boardMemberHTML).join("") + "</div>"
        : '<div class="board-empty board-open"><span class="board-open-label">' + col + ' spots are open</span><button class="btn-ghost board-apply-btn" type="button" data-board-apply="' + col + '">Apply here</button></div>';
      return '<section class="board-col"><h2>' + col + "</h2>" + body + "</section>";
    }).join("");
    root.querySelectorAll("[data-board-apply]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        window.open("https://discord.gg/Y8Zh2mE7Ke", "_blank", "noopener");
      });
    });
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
    var palette = ["#34a853", "#4285f4", "#e60073", "#26c6da", "#fb8c00", "#a970ff"];
    var rows = list.map(function (it, idx) {
      if (!it) return "";
      var name = escapeHtml(it.title || it.name || "Untitled");
      var letter = escapeHtml(String(it.title || it.name || "?").trim().charAt(0).toUpperCase() || "?");
      var color = palette[Math.abs(idx) % palette.length];
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
        if (it.category && it.url) sub = escapeHtml(it.category) + " &middot; " + escapeHtml(it.url);
      }
      var credit = it.credit ? '<span class="admin-tag is-credit">by ' + escapeHtml(it.credit) + "</span>" : "";
      return (
        '<div class="admin-row">' +
        '<div class="admin-row-ico" style="color:' + color + ';border-color:' + color + '66">' + letter + "</div>" +
        '<div class="admin-row-main">' +
        '<div class="admin-row-title"><span class="admin-row-name">' + name + "</span>" + tag + credit + "</div>" +
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
        '<input class="field field-credit" name="credit" placeholder="Credit (who shared it)" value="' + escapeAttr(pv.credit || "") + '">' +
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
      '<textarea class="field field-textarea" name="html" placeholder="&hellip;or paste HTML / code here - opens in its own tab" spellcheck="false">' + escapeHtml(eItem && eItem.html ? eItem.html : "") + "</textarea>" +
      '<div class="form-row">' +
      '<input class="field" name="thumb" placeholder="Thumbnail image link (optional)" value="' + escapeAttr(eItem ? eItem.thumb : "") + '" spellcheck="false">' +
      '<input class="field field-cat" name="category" list="' + dl + '" placeholder="Category (PC Port, Web&hellip;)" value="' + escapeAttr(eItem ? eItem.category : "") + '">' +
      '<datalist id="' + dl + '">' + cats.map(function (c) { return '<option value="' + escapeHtml(c) + '">'; }).join("") + "</datalist>" +
      "</div>" +
      '<div class="form-row">' +
      '<input class="field field-credit" name="credit" placeholder="Credit (who ported / shared it - shows as \"by …\")" value="' + escapeAttr(eItem ? eItem.credit : "") + '">' +
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
      mode: val("mode", "tab"), isNew: chk("isNew"),
      credit: String(val("credit", "") || "").trim()
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
      if (existing) { existing.name = v.name.trim(); existing.url = v.url; existing.mode = v.mode; existing.credit = v.credit; }
      else arr.push({ _id: "proxy-" + (++__idCounter), name: v.name.trim(), url: v.url, mode: v.mode, credit: v.credit });
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
      existing.credit = v.credit;
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
        credit: v.credit,
        porter: isPort ? "you" : undefined
      });
    }
    adminEditing[tab] = null;
    adminSave(tab, arr);
    adminRenderAll();
  }

  function handleAdminDelete(id, tab) {
    /* Confirm before deleting - a misclick on a card row should not wipe
       the entry with no way back (there is no undo). */
    var label = "";
    var target = (adminItems(tab) || []).find(function (x) { return x && x._id === id; });
    if (target) label = target.title || target.name || "";
    var what = label ? label : "this entry";
    if (!confirm("Delete " + what + " from " + tab + "? This cannot be undone.")) return;
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

  /* ---------- overlay focus trap ----------
     When one overlay opens, Tab has to stay inside it, and closing it has to
     hand focus back to whatever the user was on. This is the same job the
     kiwi.college dialog helper does with hideBackground / restoreBackground /
     focusableElements, trimmed to one shared watcher instead of a copy per
     overlay. The game player is left out on purpose: it passes the keyboard
     to the game inside its frame, so trapping Tab there would fight the game. */
  var TRAP_IDS = [
    "admin-modal", "editor-modal", "urlauditor-modal", "pixel-modal",
    "domainhub-modal", "docs-modal", "partners-modal", "livetv-edit-modal",
    "whatsnew-overlay", "proxy-overlay"
  ];
  var trapRoot = null;

  function trapFocusables(root) {
    var nodes = root.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    return Array.prototype.filter.call(nodes, function (el) {
      return el.offsetParent !== null && !el.hidden && el.getAttribute("aria-hidden") !== "true";
    });
  }

  function openTrap() {
    for (var i = 0; i < TRAP_IDS.length; i++) {
      var el = document.getElementById(TRAP_IDS[i]);
      if (el && !el.hidden) return el;
    }
    return null;
  }

  function installOverlayFocusTrap() {
    var last = null;
    function scan() {
      var open = openTrap();
      if (open === last) return;
      if (open) {
        trapRoot = open;
        var active = document.activeElement;
        open._chalkleReturnFocus = (active && active !== document.body && !open.contains(active)) ? active : null;
        if (!open.contains(document.activeElement)) {
          /* Wait one paint: overlays often build their body after unhiding. */
          setTimeout(function () {
            if (trapRoot !== open || open.contains(document.activeElement)) return;
            var first = trapFocusables(open)[0];
            if (first) { try { first.focus(); } catch (e) { /* not focusable */ } }
          }, 30);
        }
      } else {
        var back = trapRoot && trapRoot._chalkleReturnFocus;
        trapRoot = null;
        if (back && back.isConnected) { try { back.focus(); } catch (e) { /* gone */ } }
      }
      last = open;
    }

    var observer = new MutationObserver(function () {
      if (scan._queued) return;
      scan._queued = true;
      requestAnimationFrame(function () { scan._queued = false; scan(); });
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["hidden"], subtree: true });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Tab" || !trapRoot) return;
      var items = trapFocusables(trapRoot);
      if (!items.length) return;
      var first = items[0];
      var lastItem = items[items.length - 1];
      if (!trapRoot.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastItem.focus(); }
      else if (!e.shiftKey && document.activeElement === lastItem) { e.preventDefault(); first.focus(); }
    });

    scan();
  }

  function init() {
    els.search = $("#search-input");
    els.homeSearch = $("#home-search-input");
    els.hamburger = $("#hamburger");
    els.collapse = $("#collapse-btn");
    els.backdrop = $("#backdrop");
    /* Clock must never block the rest of init (nav binds happen below). */
    try { startClock(); } catch (e) { /* non-critical */ }

    /* Search placeholder scales down to the room the top bar actually gives
       it, so the invite never clips at any window width: full list on wide
       screens, a short invite mid-size, bare "Search" on phones. */
    function fitSearchPlaceholder() {
      var input = $("#search-input");
      if (!input) return;
    var opts = ["Search Chalkle", "Search Chalkle", "Search"];
      var cs = getComputedStyle(input);
      var cw = input.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0) - 2;
      var probe = document.createElement("canvas");
      var ctx = probe.getContext("2d");
      ctx.font = cs.font || "14.5px system-ui";
      var chosen = opts[opts.length - 1];
      for (var i = 0; i < opts.length; i++) {
        if (ctx.measureText(opts[i]).width <= cw) { chosen = opts[i]; break; }
      }
      if (input.getAttribute("placeholder") !== chosen) input.setAttribute("placeholder", chosen);
    }
    fitSearchPlaceholder();
    /* The app starts hidden behind the boot intro, so the first measure runs
       against a zero-width input. Watch the box itself instead of guessing
       events: it re-fits whenever the top bar actually gives it more or less
       room (boot reveal, viewer pill appearing, sidebar collapse, resize). */
    window.addEventListener("resize", fitSearchPlaceholder);
    window.addEventListener("chalkle-boot-done", fitSearchPlaceholder);
    window.addEventListener("load", fitSearchPlaceholder);
    if (typeof ResizeObserver !== "undefined") {
      try {
        var phObs = new ResizeObserver(fitSearchPlaceholder);
        if (els.search) phObs.observe(els.search);
      } catch (e) { /* no observer */ }
    }

    /* sync.js restores the server snapshot AFTER this file has seeded and
       built its catalogs. When the restore lands, re-read the libraries so
       the UI shows the merged catalog (fresh seeds + server edits) without a
       reload. Cheap: one JSON.parse per library, and the arrays are swapped
       in place before any view re-renders. */
    window.addEventListener("chalkle:sync-restored", function () {
      try {
        var g = loadLib("games");
        if (g.length !== DATA.games.length) {
          DATA.games.length = 0;
          Array.prototype.push.apply(DATA.games, g);
          render();
        }
      } catch (e) { /* non-critical */ }
    });

    document.querySelectorAll(".chalkle-logo").forEach(function (el) {
      el.innerHTML = buildLogo();
    });

    /* Section titles stay clean Space Grotesk headings. The multicolor
       bubble-letter treatment is reserved for the Chalkle wordmark only, so
       every page shares one typographic voice. */

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

    /* JS Movies: "Open full screen" must resolve like the in-view frame
       (single-file builds embed movies.html, plain sites serve it). */
    var moviesTabLink = document.getElementById("movies-open-tab");
    if (moviesTabLink) {
      moviesTabLink.addEventListener("click", function (e) {
        e.preventDefault();
        openResolvedTab(moviesPageUrl());
      });
    }

    var chatTabLink = document.getElementById("chat-open-tab");
    if (chatTabLink) {
      chatTabLink.addEventListener("click", function (e) {
        e.preventDefault();
        openResolvedTab(chatPageUrl());
      });
    }

    /* In-app fullscreen for Chat / Movies: maximize the view section over
       the whole app, and on top of that request the browser Fullscreen API
       so the browser chrome disappears too. Esc (or the button) backs out. */
    function setupInlineFullscreen(frameId, btnId) {
      var view = document.getElementById(frameId);
      var section = view ? view.closest(".view") : null;
      var btn = document.getElementById(btnId);
      if (!section || !btn) return;
      var label = btn.querySelector(".fx-fs-label");
      function apply() {
        var on = section.classList.contains("fx-full");
        btn.setAttribute("aria-pressed", on ? "true" : "false");
        if (label) label.textContent = on ? "Exit fullscreen" : "Fullscreen";
      }
      function exit() {
        section.classList.remove("fx-full");
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        if (fsEl && (fsEl === section || section.contains(fsEl))) {
          var ex = document.exitFullscreen || document.webkitExitFullscreen;
          if (ex) { try { ex.call(document); } catch (e2) { /* ignore */ } }
        }
        apply();
      }
      btn.addEventListener("click", function () {
        if (section.classList.contains("fx-full")) { exit(); return; }
        section.classList.add("fx-full");
        apply();
        var req = section.requestFullscreen || section.webkitRequestFullscreen;
        if (req) {
          try {
            var p = req.call(section);
            if (p && p.catch) p.catch(function () { /* CSS maximize still holds */ });
          } catch (e3) { /* CSS maximize still holds */ }
        }
      });
      document.addEventListener("fullscreenchange", syncFromBrowser);
      document.addEventListener("webkitfullscreenchange", syncFromBrowser);
      function syncFromBrowser() {
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        /* Native exit (Esc on Chromium) -> drop the CSS maximize too, so one
           Esc always lands the user back on the normal layout. */
        if (!fsEl && section.classList.contains("fx-full")) {
          section.classList.remove("fx-full");
        }
        apply();
      }
      /* Esc fallback: when the browser Fullscreen API never engaged (iframe
         focus, denied gesture, old browser), Esc should still exit. */
      document.addEventListener("keydown", function (e) {
        if (e.key !== "Escape") return;
        if (!section.classList.contains("fx-full")) return;
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        if (fsEl) return; /* native exit path handles it */
        exit();
      });
      /* Leaving the tab always restores normal layout. */
      var mo = new MutationObserver(function () {
        if (section.hidden) {
          section.classList.remove("fx-full");
          apply();
        }
      });
      try { mo.observe(section, { attributes: true, attributeFilter: ["hidden"] }); } catch (e4) { /* old browser */ }
    }
    setupInlineFullscreen("movies-frame", "movies-fullscreen");
    setupInlineFullscreen("chat-frame", "chat-fullscreen");

    /* Keep the Games scroll position across tab switches (per session). */
    var mainEl = document.querySelector(".main");
    if (mainEl) {
      mainEl.addEventListener("scroll", function () {
        if (state.view !== "games") return;
        try { sessionStorage.setItem("chalkle-scroll-games", String(mainEl.scrollTop)); } catch (e) { /* no session */ }
      });
    }

    /* Category shortcuts on the Home stage jump straight to their section. */
    document.querySelectorAll("[data-home-go]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setView(btn.dataset.homeGo);
      });
    });

    document.querySelectorAll("[data-game-filter]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.gameFilter = btn.dataset.gameFilter || "all";
        /* Not persisted: filters are a per-session browsing choice (see state). */
        document.querySelectorAll("[data-game-filter]").forEach(function (item) {
          item.classList.toggle("is-active", item === btn);
        });
        render();
      });
      /* Restored filters (or a persisted one) need the right chip lit. */
      btn.classList.toggle("is-active", btn.dataset.gameFilter === state.gameFilter);
    });

    /* Global search: one shared behavior for the top-bar field AND the
       Home launcher field - dropdown of matches across Games / Sites /
       Apps-Tools. Typing never switches the view on its own.

       `onFallback` is what the field does when the catalog has nothing to
       offer. The Home box passes its web search, so Enter opens a match when
       there is one and only then falls through to the browser. Without this
       the Home box ignored the catalog entirely: typing a game name into the
       biggest search field on the page looked like it did nothing at all. */
    function bindSearchBox(input, onFallback) {
      if (!input) return;
      input.addEventListener("input", function () {
        var q = input.value.trim();
        clearTimeout(musicSearchDebounce);
        musicSearchDebounce = setTimeout(function () {
          renderSearchResults(q, input);
        }, 110);
      });
      input.addEventListener("keydown", function (e) {
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
          /* A match on screen wins over the field's other job. */
          if (open && searchFocusList.length) {
            e.preventDefault();
            if (searchFocusIdx < 0) setSearchFocus(0);
            commitSearchFocus();
            return;
          }
          /* Empty catalog answer: the Home field still gets to be an address
             bar / web search. */
          if (onFallback) { e.preventDefault(); onFallback(); }
        }
      });
      /* Focusing an already-filled field re-opens its results. */
      input.addEventListener("focus", function () {
        if (input.value.trim()) renderSearchResults(input.value.trim(), input);
      });
    }
    /* The top bar is Chalkle's global catalog search. Home's field does both
       jobs: the same match list while you type, the web only when the catalog
       has nothing (or when the Search button is pressed). One shared behavior
       keeps typing a game name into the Home box from coming up empty. */
    bindSearchBox(els.search);
    bindSearchBox(els.homeSearch, openHomeWebSearch);
    /* Quiet border pulse on the home search bar - only on capable devices,
       and never while the tab is hidden. Flat accent color, no gradients. */
    (function () {
      var bar = document.querySelector(".home-search");
      if (!bar || !window.matchMedia) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      var lowMem = (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2);
      if (lowMem) return;
      var t0 = setTimeout(tick, 1800), iv = null;
      function tick() {
        if (document.hidden) return;
        bar.classList.remove("glow-run");
        void bar.offsetWidth;
        bar.classList.add("glow-run");
      }
      iv = setInterval(tick, 7000);
    })();
    function openHomeWebSearch() {
      if (!els.homeSearch) return;
      var value = els.homeSearch.value.trim();
      if (!value) { els.homeSearch.focus(); return; }
      /* ChalkleSearch owns the decision (address vs search, and which engine),
         so Home and the Browser tool can never disagree about a typed string.
         The inline fallback keeps the box working if that module is missing. */
      if (window.ChalkleSearch && window.ChalkleSearch.open) {
        window.ChalkleSearch.open(value, value);
        return;
      }
      var target = /^(https?:\/\/|ftp:\/\/)/i.test(value)
        ? value
        : (/^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i.test(value) && value.indexOf(" ") === -1
          ? "https://" + value
          : "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(value));
      // Home always goes to the web browser, never to Chalkle's catalog list.
      if (window.ChalkleBrowser && window.ChalkleBrowser.open) {
        window.ChalkleBrowser.open(target, value);
      } else {
        window.open(target, "_blank", "noopener");
      }
    }
    if (els.homeSearch) {
      els.homeSearch.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); openHomeWebSearch(); }
      });
      var homeSearchGo = $("#home-search-go");
      if (homeSearchGo) homeSearchGo.addEventListener("click", openHomeWebSearch);
    }

    window.addEventListener("resize", function () {
      var box = $("#search-results");
      if (box && !box.hidden) positionSearchResults();
    });
    document.addEventListener("scroll", function () {
      var box = $("#search-results");
      if (box && !box.hidden) closeSearchResults();
    }, true);

    /* Clicking away from the search closes the dropdown. */
    document.addEventListener("click", function (e) {
      var box = $("#search-results");
      if (!box || box.hidden) return;
      if (e.target && els.search && els.search.contains(e.target)) return;
      if (e.target && els.homeSearch && els.homeSearch.contains(e.target)) return;
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

    installOverlayFocusTrap();

    if (els.backdrop) {
      els.backdrop.addEventListener("click", closeSidebar);
    }

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (!$("#admin-modal").hidden) closeAdmin();
        else if (!$("#editor-modal").hidden && window.ChalkleEditor) window.ChalkleEditor.close();
        else if (!$("#urlauditor-modal").hidden && window.ChalkleUrlAuditor) window.ChalkleUrlAuditor.close();
        else if (!$("#pixel-modal").hidden && window.ChalklePixel) window.ChalklePixel.close();
        else if (!$("#domainhub-modal").hidden && window.ChalkleDomainHub) window.ChalkleDomainHub.close();
        else if (!$("#game-player").hidden && window.ChalkleGamePlayer) {
          if (window.ChalkleGamePlayer.inFs()) window.ChalkleGamePlayer.exitFs();
          else window.ChalkleGamePlayer.close();
        }
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
        var view = { "1": "home", "2": "games", "3": "music", "4": "apps-tools", "5": "proxies", "7": "settings", "8": "cloud", "0": "youtube" }[e.key];
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

    /* Settings: cloak title + icon (custom overrides on any preset) and
       panic key + redirect target. Empty custom fields mean "let the preset
       decide"; anything typed wins over the preset. */

    var cloakTitle = $("#opt-cloak-title");
    var cloakIconInput = $("#opt-cloak-icon");
    function currentCloakId() {
      try { return localStorage.getItem(CLOAK_KEY) || ""; } catch (e) { return ""; }
    }
    function refreshCloakFromSettings() {
      applyCloak(currentCloakId());
    }
    if (cloakTitle) {
      try { cloakTitle.value = localStorage.getItem("chalkle-cloak-title") || ""; } catch (e) { /* no storage */ }
      cloakTitle.addEventListener("input", function () {
        var v = cloakTitle.value.trim();
        try { localStorage.setItem("chalkle-cloak-title", v); } catch (e) { /* no storage */ }
        refreshCloakFromSettings();
      });
    }
    if (cloakIconInput) {
      try { cloakIconInput.value = localStorage.getItem("chalkle-cloak-icon") || ""; } catch (e) { /* no storage */ }
      cloakIconInput.addEventListener("input", function () {
        var v = cloakIconInput.value.trim();
        try { localStorage.setItem("chalkle-cloak-icon", v); } catch (e) { /* no storage */ }
        refreshCloakFromSettings();
      });
    }

    /* Panic key + target. The key input keeps only the last typed character
       so the field always holds exactly one key. */
    var panicKeyInput = $("#opt-panic-key");
    var panicTarget = $("#opt-panic-target");
    var panicCfg = panicConfig();
    if (panicKeyInput) {
      panicKeyInput.value = panicCfg.key;
      panicKeyInput.addEventListener("input", function () {
        var v = panicKeyInput.value.slice(-1);
        if (v) panicKeyInput.value = v;
        var t = panicTarget ? panicTarget.value : panicConfig().target;
        savePanicConfig(v || "`", t);
      });
    }
    if (panicTarget) {
      panicTarget.value = panicCfg.target;
      /* Keep a saved custom target visible instead of snapping to the first
         option when it is not one of the presets. */
      if (panicCfg.target && panicTarget.value !== panicCfg.target) {
        var panicOpt = document.createElement("option");
        panicOpt.value = panicCfg.target;
        panicOpt.textContent = "Custom: " + panicCfg.target;
        panicTarget.appendChild(panicOpt);
        panicTarget.value = panicCfg.target;
      }
      panicTarget.addEventListener("change", function () {
        var k = panicKeyInput ? panicKeyInput.value : panicConfig().key;
        savePanicConfig(k || "`", panicTarget.value);
      });
    }

    /* ---------- About:blank launcher ----------
       Opens a blank tab and frames this site inside it, so the browser's
       address bar just shows about:blank. Runs only from the Settings
       button: a click it actually has. */

    function openAboutBlankPopup() {
      var win = window.open("about:blank");
      if (!win || win.closed) {
        showToast("Popup blocked - allow popups for this site, then try again");
        return false;
      }
      try {
        var doc = win.document;
        var frame = doc.createElement("iframe");
        frame.src = location.href;
        frame.title = "Chalkle";
        frame.setAttribute("allow", (window.ChalkleApi && ChalkleApi.iframeAllow) ? ChalkleApi.iframeAllow() : "fullscreen; picture-in-picture");
        frame.setAttribute("allowfullscreen", "");
        Object.assign(frame.style, {
          width: "100%",
          height: "100%",
          border: "none"
        });
        Object.assign(doc.body.style, {
          margin: "0",
          height: "100%"
        });
        doc.documentElement.style.height = "100%";
        doc.body.appendChild(frame);
        showToast("Opened in About:blank");
        return true;
      } catch (e) {
        showToast("Couldn't build the About:blank page");
        return false;
      }
    }

    var aboutBtn = $("#opt-about-blank");
    if (aboutBtn) aboutBtn.addEventListener("click", function () { openAboutBlankPopup(); });

    window.ChalkleAboutBlank = {
      open: function () { return openAboutBlankPopup(false); }
    };

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

    /* ---- Built-ins hidden by deletions ---------------------------------
       loadLib re-seeds by title and skips anything on the per-library
       deletion list, so a built-in that was removed here (or removed on
       another device and synced over) stays gone forever - even after a
       later build ships it again. That is how a game arrives in games.js and
       still never shows up on a device that had it deleted once. These two
       helpers find exactly that case and undo it on request: only titles the
       CURRENT catalog still ships are restored, so an item that really was
       dropped from the catalog stays deleted. */
    function shippedTitles(name) {
      var conf = LIB_CONF[name];
      var set = {};
      if (!conf) return set;
      try {
        (conf.seed() || []).forEach(function (it) { if (it && it.title) set[it.title] = true; });
      } catch (e) { /* a broken seed ships nothing */ }
      return set;
    }
    function deletedTitles(name) {
      var conf = LIB_CONF[name];
      if (!conf) return [];
      try {
        var raw = localStorage.getItem(conf.key + "-del");
        var d = raw ? JSON.parse(raw) : [];
        return Array.isArray(d) ? d : [];
      } catch (e) { return []; }
    }
    function hiddenBuiltIns() {
      var out = [];
      Object.keys(LIB_CONF).forEach(function (name) {
        var shipped = shippedTitles(name);
        deletedTitles(name).forEach(function (t) {
          if (shipped[t]) out.push({ lib: name, title: t });
        });
      });
      return out;
    }
    function restoreBuiltIns() {
      var hidden = hiddenBuiltIns();
      Object.keys(LIB_CONF).forEach(function (name) {
        var conf = LIB_CONF[name];
        var shipped = shippedTitles(name);
        var keep = deletedTitles(name).filter(function (t) { return !shipped[t]; });
        try { localStorage.setItem(conf.key + "-del", JSON.stringify(keep)); } catch (e) { /* full */ }
      });
      return hidden.length;
    }

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
        var hidden = hiddenBuiltIns();
        box.innerHTML =
          '<div class="debug-row"><span>Settings keys</span><b>' + keys.length + '</b></div>' +
          '<div class="debug-row"><span>Storage used</span><b>' + kb + ' KB</b></div>' +
          '<div class="debug-row"><span>Saved proxies</span><b>' + (state.proxies ? state.proxies.length : 0) + '</b></div>' +
          '<div class="debug-row"><span>Favorites</span><b>' + (state.favs ? Object.keys(state.favs).length : 0) + '</b></div>' +
          (hidden.length
            ? '<div class="debug-row"><span>Built-ins hidden by deletions</span><b class="debug-warn">' + hidden.length + '</b></div>' +
              hidden.slice(0, 4).map(function (h) {
                return '<div class="debug-row"><span>&nbsp;' + escapeHtml(h.lib) + '</span><b>' + escapeHtml(h.title) + '</b></div>';
              }).join("")
            : "");
      }
      var restoreBtn = $("#opt-restore-builtins");
      if (restoreBtn) {
        var hiddenCount = hiddenBuiltIns().length;
        restoreBtn.hidden = !hiddenCount;
        restoreBtn.textContent = hiddenCount
          ? "Restore " + hiddenCount + " built-in" + (hiddenCount === 1 ? "" : "s")
          : "Restore built-ins";
      }
      /* Diagnostics: version, connection, storage health and the last few
         captured errors. Rendered with textContent so an error message can
         never inject markup. */
      var diag = $("#diag-info");
      if (diag) {
        diag.innerHTML = "";
        var core = window.ChalkleCore;
        var rows = [];
        if (core) {
          var st = core.storageStat();
          rows.push(["Version", "v" + core.version]);
          rows.push(["Online", navigator.onLine ? "yes" : "no"]);
          rows.push(["Storage", st.available ? "ok - " + st.keys + " keys, " + st.kb + " KB" : "unavailable"]);
          var errs = core.errors();
          rows.push(["Recent errors", errs.length ? String(errs.length) : "none"]);
          for (var e2 = 0; e2 < errs.length && e2 < 3; e2++) {
            rows.push(["  " + errs[e2].kind, errs[e2].message]);
          }
        } else {
          rows.push(["Version", "v1.1"]);
          rows.push(["Core module", "not loaded"]);
        }
        rows.forEach(function (pair) {
          var row = document.createElement("div");
          row.className = "debug-row";
          var label = document.createElement("span");
          label.textContent = pair[0];
          var value = document.createElement("b");
          value.textContent = pair[1];
          row.appendChild(label);
          row.appendChild(value);
          diag.appendChild(row);
        });
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

    /* Export: download every chalkle-* key as a versioned JSON envelope. */
    var exportBtn = $("#opt-export");
    if (exportBtn) {
      exportBtn.addEventListener("click", function () {
        var settings = {};
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf("chalkle") === 0) settings[k] = localStorage.getItem(k);
        }
        var data = {
          app: "chalkle",
          version: (window.ChalkleCore ? window.ChalkleCore.version : "1"),
          exported: new Date().toISOString(),
          settings: settings
        };
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
            var parsed = JSON.parse(reader.result);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              alert("That file is not a valid settings backup.");
              return;
            }
            /* Accept both the versioned envelope (settings key) and the old
               flat format, so pre-1.1 exports still restore. */
            var data = (parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)) ? parsed.settings : parsed;
            var count = 0;
            for (var k in data) {
              if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
              /* Prototype-pollution guard: these key names are dangerous
                 even though localStorage treats them as plain strings. */
              if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
              if (k.indexOf("chalkle") === 0) {
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

    /* Copy diagnostics: shared-core text via clipboard, textarea fallback. */
    var copyDiagBtn = $("#opt-copy-diag");
    if (copyDiagBtn) {
      copyDiagBtn.addEventListener("click", function () {
        if (window.ChalkleCore && window.ChalkleCore.copyDiagnostics) {
          window.ChalkleCore.copyDiagnostics(function (ok) {
            copyDiagBtn.textContent = ok ? "Copied" : "Copy failed - select manually";
            setTimeout(function () { copyDiagBtn.textContent = "Copy diagnostics"; }, 1800);
          });
        } else {
          copyDiagBtn.textContent = "Diagnostics unavailable";
        }
      });
    }

    /* Restore built-ins: un-delete the catalog entries this device is still
       hiding (see hiddenBuiltIns), then reload so the library re-seeds with
       them. Only shown when there is something to restore. */
    var restoreBiBtn = $("#opt-restore-builtins");
    if (restoreBiBtn) {
      restoreBiBtn.addEventListener("click", function () {
        var n = restoreBuiltIns();
        if (!n) return;
        if (window.ChalkleToast && window.ChalkleToast.show) {
          window.ChalkleToast.show("Restoring " + n + " built-in" + (n === 1 ? "" : "s") + " - reloading\u2026");
        }
        setTimeout(function () { try { location.reload(); } catch (e) { /* stay */ } }, 700);
      });
    }

    /* Service check: one on-demand probe of the relay's /_health, shown as
       ONLINE / OFFLINE rows. Never runs in the background. */
    var svcBtn = $("#opt-check-services");
    var svcBox = $("#svc-info");
    if (svcBtn && svcBox) {
      svcBtn.addEventListener("click", function () {
        if (!window.ChalkleCore || !window.ChalkleCore.checkServices) return;
        svcBtn.disabled = true;
        svcBtn.textContent = "Checking…";
        svcBox.hidden = false;
        svcBox.innerHTML = "";
        var waiting = document.createElement("div");
        waiting.className = "debug-row";
        waiting.innerHTML = "<span>Relay</span><b>…</b>";
        svcBox.appendChild(waiting);
        window.ChalkleCore.checkServices(function (rows) {
          svcBox.innerHTML = "";
          rows.forEach(function (r) {
            var row = document.createElement("div");
            row.className = "debug-row";
            var label = document.createElement("span");
            label.textContent = r.name;
            var value = document.createElement("b");
            value.textContent = r.state;
            if (r.state === "OFFLINE") value.style.color = "#e5534b";
            else if (r.state === "DEGRADED") value.style.color = "#d4a72c";
            row.appendChild(label);
            row.appendChild(value);
            svcBox.appendChild(row);
          });
          svcBtn.disabled = false;
          svcBtn.textContent = "Check services";
        });
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

    /* Inline feedback under the wallpaper URL field (used by Apply). */
    function wallpaperHint(msg, ok) {
      var hint = $("#opt-wallpaper-hint");
      if (!hint) return;
      if (!msg) { hint.hidden = true; hint.textContent = ""; return; }
      hint.textContent = msg;
      hint.classList.toggle("is-ok", !!ok);
      hint.hidden = false;
    }

    /* What's new: version changelog lightbox. A pink dot marks the sidebar
       version until the lightbox has been opened once for this release. */
    var WN_SEEN_KEY = "chalkle-wn-seen-v2";
    function whatsnewSeen() {
      try { return localStorage.getItem(WN_SEEN_KEY) === "1"; } catch (e) { return true; }
    }
    function whatsnewOpen() {
      var o = $("#whatsnew-overlay");
      if (!o) return;
      o.hidden = false;
      document.body.style.overflow = "hidden";
      try { localStorage.setItem(WN_SEEN_KEY, "1"); } catch (e) { /* full */ }
      document.querySelectorAll(".js-whatsnew").forEach(function (b) { b.classList.remove("is-wn-new"); });
    }
    function whatsnewClose() {
      var o = $("#whatsnew-overlay");
      if (o) o.hidden = true;
      document.body.style.overflow = "";
    }
    if (!whatsnewSeen()) {
      var sideVer = $("#side-foot-version");
      if (sideVer) sideVer.classList.add("is-wn-new");
    }
    document.querySelectorAll(".js-whatsnew").forEach(function (btn) {
      btn.addEventListener("click", whatsnewOpen);
    });
    var wnOverlay = $("#whatsnew-overlay");
    if (wnOverlay) {
      wnOverlay.addEventListener("click", function (e) {
        if (e.target === wnOverlay) whatsnewClose();
      });
      var wnX = $("#whatsnew-x");
      if (wnX) wnX.addEventListener("click", whatsnewClose);
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && !wnOverlay.hidden) whatsnewClose();
      });
    }

    /* Home Discord join bar: dismissing hides it for good on this device. */
    var joinBar = $("#home-join");
    var joinX = $("#home-join-x");
    if (joinBar && joinX) {
      try { if (localStorage.getItem("chalkle-join-dismiss") === "1") joinBar.hidden = true; } catch (e) { /* no storage */ }
      joinX.addEventListener("click", function () {
        joinBar.hidden = true;
        try { localStorage.setItem("chalkle-join-dismiss", "1"); } catch (e) { /* no storage */ }
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

    /* Time played: a local counter, with a way to clear it. The hint is built
       on demand (opening Settings or ending a session) rather than at boot,
       so it always shows the current total. */
    function refreshPlaytimeRow() {
      var hint = $("#playtime-hint");
      if (!hint || !window.ChalklePlaytime) return;
      var totalMs = window.ChalklePlaytime.total();
      var count = window.ChalklePlaytime.games();
      hint.textContent = totalMs > 0
        ? window.ChalklePlaytime.format(totalMs) + " across " + count +
          (count === 1 ? " game" : " games") + ", saved on this device only"
        : "Nothing recorded yet. Play a game and it starts counting";
    }
    refreshPlaytimeRow();
    window.addEventListener("chalkle:playtime", refreshPlaytimeRow);
    var playtimeReset = $("#opt-playtime-reset");
    if (playtimeReset) {
      playtimeReset.addEventListener("click", function () {
        if (!window.ChalklePlaytime) return;
        window.ChalklePlaytime.reset();
        refreshPlaytimeRow();
        render();
        showToast("Time played cleared");
      });
    }
    document.querySelectorAll(".settings-toggle").forEach(function (btn) {
      btn.addEventListener("click", refreshPlaytimeRow);
    });

    /* Block game pop-ups: the player reads this pref, and re-applies it to a
       frame that is already open so the switch never needs a reload. */
    var popupToggle = $("#opt-block-popups");
    if (popupToggle) {
      popupToggle.checked = readPref("chalkle-block-popups") !== "0";
      popupToggle.addEventListener("change", function () {
        persist("chalkle-block-popups", popupToggle.checked ? "1" : "0");
        try {
          if (window.ChalkleGamePlayer && window.ChalkleGamePlayer.applyPopupPolicy) {
            window.ChalkleGamePlayer.applyPopupPolicy();
          }
        } catch (e) { /* player not loaded yet */ }
        showToast(popupToggle.checked ? "Game pop-ups blocked" : "Game pop-ups allowed");
      });
    }

    /* Auto clicker panel: same live-apply pattern as the pop-up switch. */
    var clickerToggle = $("#opt-clicker-panel");
    if (clickerToggle) {
      clickerToggle.checked = readPref("chalkle-clicker-panel") !== "0";
      clickerToggle.addEventListener("change", function () {
        persist("chalkle-clicker-panel", clickerToggle.checked ? "1" : "0");
        try {
          if (window.ChalkleGamePlayer && window.ChalkleGamePlayer.applyClickerPolicy) {
            window.ChalkleGamePlayer.applyClickerPolicy();
          }
        } catch (e) { /* player not loaded yet */ }
        showToast(clickerToggle.checked ? "Auto clicker panel on" : "Auto clicker panel off");
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
          /* Wallpaper values are either url('...') images or bare colors.
             Assigning a color to backgroundImage throws 8 console errors
             ("Error in parsing value for 'background-image'") - send each
             value to the property that can actually parse it. */
          var wpVal = T.wallpapers[id];
          if (wpVal && wpVal.indexOf("url(") === 0) btn.style.backgroundImage = wpVal;
          else btn.style.background = wpVal;
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
          if (!url) { wallpaperHint(""); return; }
          if (!/^https?:\/\//i.test(url)) {
            wallpaperHint("Paste a full image URL starting with http(s)://");
            return;
          }
          var img = new Image();
          img.referrerPolicy = "no-referrer";
          img.onload = function () {
            savedWallpaper = T.getWallpaper();
            T.setWallpaper("custom:" + url);
            renderWallpaperGrid();
            wallpaperHint("Wallpaper applied", true);
          };
          img.onerror = function () {
            wallpaperHint("That image didn't load - check the URL and try again");
          };
          img.src = url;
        });
      }

      /* Undo: restore the wallpaper that was saved before the last change. */
      var undoWallpaper = $("#opt-wallpaper-undo");
      if (undoWallpaper) {
        undoWallpaper.addEventListener("click", function () {
          wallpaperHint("");
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

      /* Theme code: the whole look as one line. Sharing a theme should not
         need an account, a marketplace or a file; a code in a Discord message
         is enough. Every field is validated in theme.js before it reaches a
         CSS custom property, so a pasted code cannot inject styles. */
      var codeInput = $("#opt-theme-code");
      var codeApply = $("#opt-theme-code-apply");
      var codeCopy = $("#opt-theme-code-copy");
      var codeHint = $("#opt-theme-code-hint");
      var codeHintTimer = null;

      function codeNote(msg, ok) {
        if (!codeHint) return;
        clearTimeout(codeHintTimer);
        codeHint.textContent = msg || "";
        codeHint.hidden = !msg;
        /* .wallpaper-hint is red by default and turns accent with .is-ok, the
           same convention the wallpaper row already uses. */
        codeHint.classList.toggle("is-ok", ok === true);
        if (msg) codeHintTimer = setTimeout(function () { codeHint.hidden = true; }, 6000);
      }

      /* navigator.clipboard needs a secure context; the textarea path keeps
         Copy mine working on http:// LAN copies too. When both fail the code
         is left in the input selected, which is still copyable by hand. */
      function copyCode(text, done) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
            return;
          }
        } catch (e) { /* fall through */ }
        try {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand("copy");
          ta.remove();
          done(ok);
        } catch (e) { done(false); }
      }

      /* One install path for all three doors into a theme: a pasted code or
         JSON, a picked .json file, or a URL. Everything ends up in
         ChalkleTheme.install, so validation only lives in one place. */
      function installThemeText(text, source) {
        var res = T.install(text);
        if (!res || !res.ok) {
          codeNote((res && res.error) || "That does not look like a theme.", false);
          return false;
        }
        /* Keep every other control in the panel showing what is now live. */
        if (themeBg) themeBg.value = res.theme.bg;
        if (themeAccent) themeAccent.value = res.theme.accent;
        if (typeof renderPresetGrid === "function") renderPresetGrid();
        if (typeof renderWallpaperGrid === "function") renderWallpaperGrid();
        if (typeof renderCursorGrid === "function") renderCursorGrid();
        if (wallpaperUrl) {
          wallpaperUrl.value = res.theme.wallpaper.indexOf("custom:") === 0 ? res.theme.wallpaper.slice(7) : "";
        }
        codeNote("Installed \u201C" + res.theme.name + "\u201D" + (source ? " " + source : "") + ".", true);
        return true;
      }

      if (codeApply) {
        codeApply.addEventListener("click", function () {
          if (installThemeText(codeInput ? codeInput.value : "") && codeInput) codeInput.value = "";
        });
      }

      /* A VS Code theme file: the format is JSON with a colors map, so the
         file picker is the friendliest way in for the thousands of themes
         that only exist as a .json in some repo. */
      var themeFile = $("#opt-theme-file");
      if (themeFile) {
        themeFile.addEventListener("change", function () {
          var file = themeFile.files && themeFile.files[0];
          if (!file) return;
          try {
            var reader = new FileReader();
            reader.onload = function () {
              if (!installThemeText(String(reader.result || ""), "(from " + file.name + ")")) {
                codeNote("\u201C" + file.name + "\u201D is not a theme Chalkle can read.", false);
              }
              themeFile.value = "";
            };
            reader.onerror = function () { codeNote("Could not read that file.", false); };
            reader.readAsText(file);
          } catch (e) {
            codeNote("Could not read that file.", false);
          }
        });
      }

      /* Theme URLs: raw.githubusercontent, jsDelivr and most pages that serve
         JSON send permissive CORS headers, so a pasted link usually just
         works. When it does not the note says why instead of failing mute. */
      var themeUrl = $("#opt-theme-url");
      var themeUrlApply = $("#opt-theme-url-apply");
      if (themeUrlApply) {
        themeUrlApply.addEventListener("click", function () {
          var url = themeUrl ? themeUrl.value.trim() : "";
          if (!/^https?:\/\//i.test(url)) { codeNote("Paste an http(s) URL to a theme .json.", false); return; }
          codeNote("Fetching\u2026", true);
          fetch(url, { cache: "no-store", credentials: "omit", redirect: "follow" })
            .then(function (r) { return r.ok ? r.text() : null; })
            .then(function (body) {
              if (body === null) { codeNote("That URL answered with an error.", false); return; }
              if (installThemeText(body, "(from the web)") && themeUrl) themeUrl.value = "";
            })
            .catch(function () {
              codeNote("Could not fetch that URL \u2014 the host may not allow it (CORS) or you are offline.", false);
            });
        });
      }

      if (themeUrl) {
        themeUrl.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); if (themeUrlApply) themeUrlApply.click(); }
        });
      }

      if (codeCopy) {
        codeCopy.addEventListener("click", function () {
          var code = T.shareCode();
          if (codeInput) {
            codeInput.value = code;
            try { codeInput.select(); } catch (e) { /* not fatal */ }
          }
          copyCode(code, function (ok) {
            if (ok) { codeNote("Theme code copied \u2014 paste it anywhere.", true); if (codeInput) codeInput.value = ""; }
            else codeNote("Could not reach the clipboard \u2014 the code is in the box, copy it by hand.", false);
          });
        });
      }

      if (codeInput) {
        codeInput.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); if (codeApply) codeApply.click(); }
        });
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

    /* Shared play counts land after the first paint (the relay answers when it
       answers, and a warm cache answers instantly). Repaint once when they do,
       so the badges and the Home shelf stop showing local-only numbers. One
       repaint, not one per update: a re-render is not free at this library
       size, and a stale number for a few seconds is harmless. */
    var playsRepainted = false;
    window.addEventListener("chalkle:plays", function () {
      if (playsRepainted) return;
      playsRepainted = true;
      if (state.view === "games") render();
      else if (state.view === "home") renderHome();
    });

    /* Games/sites/apps tab filter box: live grid narrowing. Debounced so
       typing stays smooth over the big library. */
    var gridFilter = $("#games-filter");
    if (gridFilter) {
      var gfTimer = null;
      gridFilter.addEventListener("input", function () {
        clearTimeout(gfTimer);
        gfTimer = setTimeout(function () {
          state.gridFilter = gridFilter.value;
          /* Active filter must see every match (bypass the 480 cap); an
             empty box restores the capped grid. render(bool) persists it. */
          render(state.gridFilter.trim() ? true : false);
        }, 120);
      });
      gridFilter.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
          gridFilter.value = "";
          state.gridFilter = "";
          render();
        }
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
        /* Built-in app tiles (HTML Editor etc.) open their modal. */
        var toolKind = e.target.closest("[data-tool-kind]");
        if (toolKind) {
          e.preventDefault();
          if (toolKind.dataset.toolKind === "editor" && window.ChalkleEditor) window.ChalkleEditor.open();
          else if (toolKind.dataset.toolKind === "urlauditor" && window.ChalkleUrlAuditor) window.ChalkleUrlAuditor.open();
          else if (toolKind.dataset.toolKind === "pixel" && window.ChalklePixel) window.ChalklePixel.open();
          else if (toolKind.dataset.toolKind === "domainhub" && window.ChalkleDomainHub) window.ChalkleDomainHub.open();
          else if (toolKind.dataset.toolKind === "iphone16" && window.ChalkleLaunch) {
            var ipTile = toolKind.closest(".tool-tile");
            ipTileClick(ipTile);
          }
          else if (toolKind.dataset.toolKind === "browser") openBrowser();
          else if (toolKind.dataset.toolKind === "vm") openVm();
          return;
        }

        /* Proxy apps (TikTok, Discord, …) route their real URL through the
           configured proxy, then hand the proxied page to the launch picker so
           every method (in-app iframe, about:blank cloak, blob, new tab) works. */
        var proxyApp = e.target.closest("[data-proxy-app]");
        if (proxyApp && window.ChalkleLaunch) {
          e.preventDefault();
          var paTarget = proxyApp.dataset.proxyApp || "";
          var liveProxy =
            (window.ChalkleLaunch.firstProxy && window.ChalkleLaunch.firstProxy()) || null;
          var tileTitle = proxyApp.querySelector(".tool-tile-title");
          var paTitle = tileTitle ? tileTitle.textContent : "";
          if (!liveProxy) {
            /* Direct mode is an intentional selection, not a configuration
               error. Open the real app through the shell without pretending
               the hosted dashboard can consume a target hash. */
            if (window.ChalkleLaunch.openShell) window.ChalkleLaunch.openShell(paTarget, paTitle);
            else window.ChalkleLaunch.open(paTarget, paTitle);
            return;
          }
          /* Same guard as the launcher: hosted dashboards are not URL
             routers, so a hash-routed proxy would drop the target and show
             the dashboard's own welcome page instead of the app. */
          var paRoutes = liveProxy.builtin || liveProxy.mode === "path" ||
            (window.ChalkleLaunch.isTargetRoutingProxy
              ? window.ChalkleLaunch.isTargetRoutingProxy(liveProxy)
              : liveProxy.mode === "path");
          var paRouted = paRoutes
            ? window.ChalkleLaunch.routeProxy(paTarget, liveProxy.url, false)
            : paTarget;
          if (window.ChalkleLaunch.openShell) {
            /* Proxy apps are walled sites - bounce even the proxied URL
               through the redirector shell so no filter sees it as a link. */
            window.ChalkleLaunch.openShell(paRouted, paTitle);
          } else if (window.ChalkleLaunch.openProxyApp) {
            window.ChalkleLaunch.openProxyApp(paTarget, paTitle);
          } else {
            window.ChalkleLaunch.open(paRouted, paTitle);
          }
          return;
        }

        /* "How to open" button - opens the item through the launcher (the
           launcher decides in-app browser vs direct routing and the
           popup-blocked fallback). Kept as a separate affordance from the
           card click. */
        var openWith = e.target.closest("[data-open-with]");
        if (openWith && window.ChalkleLaunch) {
          e.preventDefault();
          var openUrl = openWith.dataset.url || "";
          if (openWith.dataset.html && window.ChalkleLaunch.htmlUrl) openUrl = window.ChalkleLaunch.htmlUrl(openWith.dataset.html);
          window.ChalkleLaunch.openWithOptions(openUrl, openWith.dataset.title || "");
          return;
        }

        /* Game-card proxy button - route this one game through the configured
           proxy (built-in /res/ when available) in a new tab. */
        var gameProxy = e.target.closest("[data-game-proxy]");
        if (gameProxy && window.ChalkleLaunch) {
          e.preventDefault();
          window.ChalkleLaunch.openProxyApp(gameProxy.dataset.gameProxy || "", gameProxy.dataset.title || "");
          return;
        }

        /* Open-source credit chip on a game card - takes the user to the
           project repository instead of launching the game. */
        var creditRepo = e.target.closest("[data-credit-repo]");
        if (creditRepo) {
          e.preventDefault();
          try { window.open(creditRepo.getAttribute("data-credit-repo"), "_blank", "noopener"); } catch (err) { /* popup blocked */ }
          return;
        }

        var fav = e.target.closest("[data-fav]");
        if (fav) {
          var favKey = fav.dataset.fav;
          if (state.favs[favKey]) delete state.favs[favKey];
          else          state.favs[favKey] = 1;
          persist(FAVS_KEY, JSON.stringify(state.favs));
          render();
          /* Pop the freshly rendered heart for feedback. */
          var fresh = document.querySelector('[data-fav="' + CSS.escape(favKey) + '"]');
          if (fresh) {
            fresh.classList.add("pop");
            setTimeout(function () { fresh.classList.remove("pop"); }, 380);
          }
          showToast(state.favs[favKey] ? "Added to favorites" : "Removed from favorites");
          return;
        }

        var launch = e.target.closest("[data-launch]");
        if (launch && window.ChalkleLaunch) {
          e.preventDefault();
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
          /* Pop the chooser FIRST. Click bookkeeping (counts, recents and the
             full grid re-render those trigger) is deferred below: rebuilding
             a 1,400+ card grid before showing the modal stalled the popup by
             seconds on Chromebooks. The chooser's own buttons carry a fresh
             user gesture, so window.open still opens on the user's click. */
          var cardEl = launch.closest(".game-card");
          if (cardEl) {
            cardEl.classList.add("launch-pop");
            setTimeout(function () {
              cardEl.classList.remove("launch-pop");
            }, 340);
          }
          if (launchUrl) {
            if (isJamesEdition(launchUrl)) {
              openJamesEdition(launch.dataset.title || "Minecraft James Edition");
            } else if (state.view === "games") {
              /* Games launch straight into the dedicated player; the chooser
                 stays one tap away on the card's open-with button and in the
                 player's error state. */
              var gpItem = findGameByLaunch(launch);
              if (!gpItem || !openGamePlayer(gpItem)) {
                window.ChalkleLaunch.openWithOptions(launchUrl, launch.dataset.title || launchUrl);
              }
            } else if (state.view === "apps-tools" && /^https?:/i.test(launchUrl) && window.ChalkleLaunch.openShell) {
              /* Apps/Tools always bounce through the same-origin redirector
                 shell (/go.html#<base64>) so the destination never shows up
                 as a link or request - it stays off the filter's radar. */
              window.ChalkleLaunch.openShell(launchUrl, launch.dataset.title || launchUrl);
            } else {
              /* Always ask before selecting direct, proxy, blank-tab, or frame. */
              window.ChalkleLaunch.openWithOptions(launchUrl, launch.dataset.title || launchUrl);
            }
          }
          setTimeout(function () {
            var key = gameKey({ url: launch.dataset.url, title: launch.dataset.title });
            state.clicks[key] = (state.clicks[key] || 0) + 1;
            persist(COUNTS_KEY, JSON.stringify(state.clicks));
            trackRecent(key, launch.dataset.title || "");
            /* Count it for everyone, not just this device. Fire and forget:
               a slow or missing relay never delays the launch. */
            if (window.ChalklePlays) window.ChalklePlays.report(key);
            if (state.view === "games") render();
          }, 400);
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

    /* Standalone browser.html (opened from Apps/Tools) posts back when its
       Chalkle quick links are used: hop to that view here, and close the
       in-app browser when the embedded page asks to. */
    window.addEventListener("message", function (e) {
      var d = e.data || {};
      if (!d || typeof d !== "object") return;
      if (d.chalkle === "goto") {
        setView(String(d.view || "home"));
        return;
      }
      if (d.chalkle === "close-browser" && window.ChalkleBrowser) {
        window.ChalkleBrowser.close();
      }
    });

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
          state.gridFilter = "";
          var gf = $("#games-filter");
          if (gf) gf.value = "";
          if (els.search) els.search.value = "";
          document.querySelectorAll("[data-game-filter]").forEach(function (item) {
            item.classList.toggle("is-active", item.dataset.gameFilter === "all");
          });
          render();
        });
      }
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
      var lockError = $("#admin-lock-error");
      if (lockForm) {
        lockForm.addEventListener("submit", function (e) {
          e.preventDefault();
          var code = $("#admin-code");
          if (code && tryUnlock(code.value)) {
            code.value = "";
            if (lockError) lockError.hidden = true;
          }
          else {
            var card = adminModal.querySelector(".admin-card");
            if (card) { card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake"); }
            if (lockError) lockError.hidden = false;
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
    /* Skip the boot-time render when bootReady() already built the grids
       (intro skipped this session) or when the intro is still up and will
       trigger it - building every grid twice doubled startup jank. */
    if (window.__chalkleRendered || (!window.__chalkleBootDone && document.getElementById("boot"))) return;
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
      /* Background tabs skip the ping: saves battery/data on long-idle tabs,
         and the server prunes after 20s anyway, so the count self-corrects
         via the visibilitychange ping when the tab wakes up. */
      if (document.visibilityState === "hidden") return;
      /* On mirrors (jsDelivr/GitHub Pages) /_active only exists on the relay
         - route the ping through ChalkleApi.mirrorPing to avoid a 400. */
      var pingUrl = "/_active?s=" + encodeURIComponent(vid || "anon");
      try {
        if (window.ChalkleApi && window.ChalkleApi.mirrorPing) pingUrl = window.ChalkleApi.mirrorPing(pingUrl);
      } catch (e) { /* keep same-origin */ }
      fetch(pingUrl, { cache: "no-store" })
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
