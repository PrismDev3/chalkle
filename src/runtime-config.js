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
     mirrors still have working cloud, music, live data and proxy routes. */
  var main = configuredRoot() || "https://chalkle.lootline.xyz";
  window.SCHOOL_CENTER_CONFIG = {
    mainUrl: main,
    generatedAt: "2026-09-01"
  };

  function isMirror() {
    if (window.__CHALKLE_EMBED__) return true;
    try {
      if (location.protocol === "file:" || location.origin === "null") return true;
      var host = String(location.hostname || "");
      return /(?:^|\.)(?:jsdelivr\.net|githack\.com|unpkg\.com|github\.io|pages\.dev|gitlab\.io|githubusercontent\.com|vercel\.app|netlify\.app)$/i.test(host);
    } catch (e) {
      return false;
    }
  }

  function root() {
    if (!isMirror()) return "";
    return main;
  }

  window.ChalkleApi = {
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
          if (/\.jsdelivr\.net$/i.test(pu.hostname) && isLocalPrefix(pu.pathname)) {
            return main + pu.pathname + pu.search + pu.hash;
          }
        } catch (e) { /* not a url - keep raw */ }
      }
      return p;
    }

    if (p.indexOf("://") !== -1) {
      try {
        var pu = new URL(p);
        if (isLocalPrefix(pu.pathname)) {
          return main + pu.pathname + pu.search + pu.hash;
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
