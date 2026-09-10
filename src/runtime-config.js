// Runtime deployment configuration. A static mirror can optionally provide
// its production API origin through a meta tag or window.CHALKLE_API_ROOT.
// Keep this file free of temporary tunnel URLs so a deployment can change
// hosts without a frontend rebuild.
(function () {
  "use strict";
  function configuredRoot() {
    var value = window.CHALKLE_API_ROOT || "";
    var meta = document.querySelector('meta[name="chalkle-api-root"]');
    if (!value && meta) value = meta.getAttribute("content") || "";
    return String(value).trim().replace(/\/+$/, "");
  }
  /* Static mirrors cannot execute the Chalkle relay themselves. Keep the
     public first-party relay as the default API origin so jsDelivr/GitHub
     mirrors still have working cloud, music, live data and proxy routes.
     BACKUP_RELAYS are second-party relays running the same serve-chalk.py;
     when the primary is unreachable (blocked network, dead host) the mirror
     automatically re-points everything at the first healthy backup. */
  var main = configuredRoot() || "https://chalkle.lootline.xyz";
  var BACKUP_RELAYS = (window.CHALKLE_BACKUP_RELAYS || [
    "https://chalkle.lootline.workers.dev"
  ]).slice();
  window.SCHOOL_CENTER_CONFIG = {
    mainUrl: main,
    generatedAt: "2026-09-01"
  };

  function isMirror() {
    if (window.__CHALKLE_EMBED__) return true;
    try {
      if (location.protocol === "file:" || location.origin === "null") return true;
      var host = String(location.hostname || "");
      return /(?:^|\.)(?:jsdelivr\.net|githack\.com|unpkg\.com|esm\.sh|github\.io|pages\.dev|gitlab\.io|githubusercontent\.com|vercel\.app|netlify\.app|esm\.lootline\.xyz)$/i.test(host);
    } catch (e) {
      return false;
    }
  }

  function root() {
    if (!isMirror()) return "";
    return active;
  }

  /* Relay health failover (mirrors only). The primary relay is probed once at
     boot; if it does not answer, the active relay moves to the first backup
     that answers. Consumers that cached a root value keep working because
     root() is always read fresh; long-lived callers are patched through
     onFailover below. */
  var active = main;
  var failoverDone = false;
  var failoverListeners = [];
  function tryProbe(base, timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      var fin = function (ok) { if (!settled) { settled = true; resolve(ok); } };
      var t = setTimeout(function () { fin(false); }, timeoutMs || 5000);
      try {
        fetch(base + "/api/live-tv", { cache: "no-store", mode: "cors" })
          .then(function (r) { clearTimeout(t); fin(r.ok || r.status === 401 || r.status === 403); })
          .catch(function () { clearTimeout(t); fin(false); });
      } catch (e) { clearTimeout(t); fin(false); }
    });
  }
  function pickRelay() {
    if (failoverDone || !isMirror()) return Promise.resolve();
    failoverDone = true;
    return tryProbe(active).then(function (ok) {
      if (ok) return null;
      var idx = 0;
      function next() {
        if (idx >= BACKUP_RELAYS.length) return null;
        var cand = BACKUP_RELAYS[idx++];
        return tryProbe(cand, 6000).then(function (up) {
          if (up) return cand;
          return next();
        });
      }
      return next().then(function (winner) {
        if (winner && winner !== active) {
          var old = active;
          active = winner;
          for (var i = 0; i < failoverListeners.length; i++) {
            try { failoverListeners[i](winner, old); } catch (e) { /* listener error */ }
          }
        }
        return winner;
      });
    });
  }
  if (isMirror()) {
    try { pickRelay(); } catch (e) { /* never block boot */ }
  }

  window.ChalkleApi = {
    /* Fired when the mirror's active relay changes (primary dead, backup took
       over). window.ChalkleOnRelayFailover(fn) registers a listener that gets
       (newRoot, oldRoot); listeners should re-point anything they cached. */
    onFailover: function (fn) {
      if (typeof fn === "function") failoverListeners.push(fn);
    },
    relayReady: function () { return pickRelay(); },
    /* Chromium is the only engine that enforces iframe @allow; Firefox logs
       a "Feature Policy: Skipping unsupported feature name" warning for
       every name it doesn't implement (autoplay, clipboard-*). Firefox
       ignores @allow entirely, so giving it the short list loses nothing
       and silences the console spam. */
    iframeAllow: function () {
      try {
        var ua = navigator.userAgent || "";
        if (ua.indexOf("Chrome/") !== -1 || ua.indexOf("Chromium/") !== -1 || ua.indexOf("Edg/") !== -1) {
          return "fullscreen; autoplay; clipboard-read; clipboard-write; picture-in-picture";
        }
      } catch (e) { /* fall through */ }
      return "fullscreen; picture-in-picture";
    },
    isMirror: isMirror,
    root: root,
    url: function (path) {
      path = String(path || "");
      if (!path) return root();
      if (/^https?:/i.test(path)) return path;
      if (path.charAt(0) !== "/") path = "/" + path;
      return root() + path;
    },
    host: function () {
      var r = root();
      if (!r) {
        try { return location.host; } catch (e) { return ""; }
      }
      try { return new URL(r).host; } catch (e) { return ""; }
    },
    /* Server-side app endpoints (/_sync state sync, /_active viewer pill)
       only exist on the relay. On a static mirror a root-absolute fetch of
       them resolves against the CDN host and dies with a 400. Route them to
       the relay origin on mirrors; on the real site this is a no-op. */
    mirrorPing: function (path) {
      var p = String(path || "");
      var mirrored = false;
      try { mirrored = !!isMirror(); } catch (e) { mirrored = false; }
      if (!mirrored) return p;
      return root() + (p.charAt(0) === "/" ? p : "/" + p);
    }
  };

  /* Root-absolute paths into folders that are gitignored (local-only) can
     never exist on a static mirror: game-builds/, mc/, flare/ and the PS1
     disc image are served only by the production relay, so on jsDelivr /
     GitHub Pages / file:// a path like /game-builds/undertale/index.html
     must be re-pointed at the relay instead of resolving against the CDN
     host (cdn.jsdelivr.net/game-builds/... is a guaranteed 404).

     This helper is intentionally broad: it accepts both root-absolute paths
     ("/game-builds/..." ) AND absolute mirror URLs that already point at a
     dead CDN host (e.g. "https://cdn.jsdelivr.net/game-builds/..."). On the
     real site it is a no-op; on a mirror it re-points any local-only prefix
     to the relay so local games still launch. */
  /* /ugs/ and /gn/ are tracked in the repo (so jsDelivr mirrors them), but
     jsDelivr serves .html as text/plain with nosniff - opening a mirror URL
     for a game shows raw source instead of running it. They only play
     correctly from the relay, so treat them as relay-only for launching. */
  var LOCAL_ONLY_PREFIXES = ["/game-builds/", "/mc/", "/flare/", "/assets/games/psx/", "/ugs/", "/gn/"];

  /* jsDelivr mirrors the repo under /gh/<user>/<repo>@<branch>/, so an
     absolute CDN URL like "https://cdn.jsdelivr.net/gh/user/repo@main/ugs/x.html"
     carries the mirror subpath in its pathname. Strip everything up to and
     including the versioned segment (the one containing "@") so the
     local-only prefix check sees /ugs/... and the URL can be re-pointed at
     the relay. */
  function stripCdnSubpath(pathname) {
    var p = String(pathname || "");
    var at = p.indexOf("@");
    if (at !== -1) {
      var slash = p.indexOf("/", at);
      if (slash !== -1) return p.slice(slash);
    }
    return p;
  }
  window.ChalkleApi.localUrl = function (path) {
    var p = String(path || "").trim();
    if (!p) return p;

    var mirrored = false;
    try { mirrored = !!isMirror(); } catch (e) { mirrored = false; }
    if (!mirrored) {
      /* On the real site, also catch absolute URLs that are already pointing
         at a known dead CDN host, because the launcher may receive them
         directly from card data on a mirror bootstrap. */
      if (p.indexOf("://") !== -1) {
        try {
          var pu = new URL(p);
          if (/\.jsdelivr\.net$/i.test(pu.hostname) && isLocalPrefix(stripCdnSubpath(pu.pathname))) {
            return main + stripCdnSubpath(pu.pathname) + pu.search + pu.hash;
          }
        } catch (e) { /* not a url - keep raw */ }
      }
      return p;
    }

    if (p.indexOf("://") !== -1) {
      try {
        var pu = new URL(p);
        if (isLocalPrefix(stripCdnSubpath(pu.pathname))) {
          return main + stripCdnSubpath(pu.pathname) + pu.search + pu.hash;
        }
      } catch (e) { /* not a url - fall through to string path */ }
      return p;
    }

    if (p.charAt(0) !== "/" || p.charAt(1) === "/") return p;
    for (var i = 0; i < LOCAL_ONLY_PREFIXES.length; i++) {
      if (p.indexOf(LOCAL_ONLY_PREFIXES[i]) === 0) return main + p;
    }
    return p;
  };

  function isLocalPrefix(pathname) {
    for (var i = 0; i < LOCAL_ONLY_PREFIXES.length; i++) {
      if (pathname.indexOf(LOCAL_ONLY_PREFIXES[i]) === 0) return true;
    }
    return false;
  }
})();
