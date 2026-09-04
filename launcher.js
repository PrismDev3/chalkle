/* Chalkle launcher. Every game/site/app opens the real URL in a normal new
   tab - no method picker, no about:blank / blob / data: cloak tabs.
   Explicitly proxied items (Unity builds, proxy apps) still route through a
   configured proxy as a plain new tab, and when a popup is blocked the item
   falls back to the in-app frame overlay on this page. */

(function () {
  "use strict";

  /* Pages that already live on this site ( /game-builds/... ). They always
     open top-level on this origin. */
  function isLocalPlayUrl(url) {
    var u = String(url || "").trim();
    if (!u) return false;
    if (/^(?:blob:|data:|javascript:|about:)/i.test(u)) return false;
    if (u.charAt(0) === "/" && u.charAt(1) !== "/") return true;
    try {
      if (typeof location === "undefined" || !location.origin) return false;
      return new URL(u, location.href).origin === location.origin;
    } catch (e) {
      return false;
    }
  }

  /* Unity WebGL builds resolve relative asset paths (StreamingAssets/, the
     .data/.wasm, Build/*loader.js) against the DOCUMENT base. Detect those
     builds by URL so proxy routing can keep them on a real origin. */
  function looksLikeUnityUrl(url) {
    var u = String(url || "");
    if (!u) return false;
    return (
      u.indexOf(".unityweb") !== -1 ||
      u.indexOf("StreamingAssets/") !== -1 ||
      u.indexOf("UnityLoader.") !== -1 ||
      u.indexOf("createUnityInstance") !== -1 ||
      (u.indexOf("/Build/") !== -1 && u.indexOf("loader.js") !== -1)
    );
  }

  function shouldOpenDirect(url) {
    return isLocalPlayUrl(url) || looksLikeUnityUrl(url);
  }

  function isDeadStubProxy(url) {
    var u = String(url || "").trim();
    if (!u || u.indexOf("your-proxy") !== -1) return true;
    try {
      var parsed = u.indexOf("://") === -1 ? new URL(u, location.href) : new URL(u);
      if (parsed.origin === location.origin && /^\/uv\/?$/i.test(parsed.pathname)) return true;
    } catch (e) {
      if (/^\/uv\/?$/i.test(u)) return true;
    }
    return false;
  }

  /* A usable same-origin base for the built-in /uv/ proxy. The single-file
     build runs from file:// or an opaque origin, where location.origin is the
     literal string "null" - the builtin /uv/ route cannot exist there. */
  function usableOrigin() {
    try {
      if (window.ChalkleApi && window.ChalkleApi.root) {
        var apiRoot = String(window.ChalkleApi.root() || "").replace(/\/+$/, "");
        if (apiRoot) return apiRoot;
      }
    } catch (e) { /* fall through to the page origin */ }
    try {
      var o = String(location.origin || "");
      if (!o || o === "null") return "";
      return /^https?:/i.test(o) ? o.replace(/\/+$/, "") : "";
    } catch (e) {
      return "";
    }
  }

  /* The /uv/ rewriting proxy only exists when serve-chalk.py is actually
     behind this origin. Probe once at startup and only advertise it when it
     really answers. */
  var uvStatus = null; // null = probing, true = usable, false = unusable
  var builtinTried = false;
  function probeBuiltinProxy() {
    if (builtinTried) return;
    builtinTried = true;
    var origin = usableOrigin();
    if (!origin) { uvStatus = false; return; }
    fetch(origin + "/uv/", { method: "GET", cache: "no-store" })
      .then(function (r) { uvStatus = !!r.ok; })
      .catch(function () { uvStatus = false; });
  }
  probeBuiltinProxy();

  function builtinProxy() {
    var origin = usableOrigin();
    if (!origin) return null;
    if (uvStatus !== true) return null;
    return { name: "Built-in", url: origin + "/uv", mode: "path", builtin: true };
  }

  /* Pick the first real configured proxy (skips the "your-proxy-url"
     placeholder). The same-origin /uv/ proxy always wins. */
  function liveProxy() {
    var builtin = builtinProxy();
    var proxies =
      (typeof window.ChalkleGetProxies === "function" && window.ChalkleGetProxies()) ||
      window.ChalkleProxies || window.ChalkProxies || [];
    var hosted = null;
    for (var i = 0; i < proxies.length; i++) {
      var p = proxies[i];
      if (p && p.url && !isDeadStubProxy(p.url)) {
        try {
          if (new URL(p.url, location.href).origin === location.origin && /\/uv\/?$/.test(new URL(p.url, location.href).pathname)) {
            return p;
          }
        } catch (e) { /* fall through */ }
        if (!hosted) hosted = p;
        if (builtin) break;
      }
    }
    if (builtin) return builtin;
    return hosted || null;
  }

  /* Open a URL in the in-app frame overlay. Used as the fallback when a
     popup is blocked, and by the overlay's own controls. */
  function inAppFrame(url, title) {
    var overlay = document.getElementById("proxy-overlay");
    var frame = document.getElementById("proxy-frame");
    if (!overlay || !frame) return false;
    var label = document.getElementById("overlay-title");
    if (label) label.textContent = title || "Playing";
    var notice = document.getElementById("overlay-notice");
    if (notice) notice.hidden = true;
    var ext = document.getElementById("overlay-ext");
    var target = String(url || "");
    var p = liveProxy();
    if (p && /^https?:/i.test(target) && !shouldOpenDirect(target)) {
      target = routeProxy(target, p.url, p.mode === "frame" || !!p.hashRoute);
    }
    window.ChalkleLaunch.lastOpenUrl = target;
    if (ext) ext.href = target;
    frame.src = target;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    return true;
  }

  /* Open a URL as a plain new tab and hand back the window handle. The
     "noopener" feature string is NOT used: per spec it makes window.open
     return null, which would break the popup-blocked fallback below and
     make every caller report failure. We sever opener access manually
     instead - cross-origin tabs cannot touch us either way, and a same-origin
     wrapper page has nothing sensitive to reach. */
  function openTab(url) {
    var win = window.open(url, "_blank");
    if (win) {
      try { win.opener = null; } catch (e) { /* already cross-origin */ }
    }
    return win;
  }

  function openDirect(url) {
    /* Local file paths can never open from a web page and would throw a
       security error - refuse them here. */
    if (/^(file:|javascript:)/i.test(String(url || "").trim())) return false;
    var win = openTab(url);
    if (!win && isLocalPlayUrl(url)) {
      try { window.location.href = url; return true; } catch (e) { return false; }
    }
    /* Popup blocked (managed Chromebooks often block new tabs entirely):
       play right here in the app instead of failing silently. */
    if (!win && /^https?:/i.test(String(url || "").trim())) return inAppFrame(url, url);
    return !!win;
  }

  /* Base64url helper - the encoding Ultraviolet / Scramjet / Rammerhead style
     proxies understand. */
  function b64url(s) {
    try {
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } catch (e) {
      return encodeURIComponent(s);
    }
  }

  /* Build a routed URL for a target behind a given proxy host. */
  function routeProxy(target, proxyUrl, hashRoute) {
    target = String(target || "").trim();
    if (!target || !proxyUrl) return target;
    if (/^\s*(data:|blob:|javascript:|file:)/i.test(target)) return target;
    var localPath = target.charAt(0) === "/" && target.charAt(1) !== "/";
    var base = String(proxyUrl).replace(/\/+$/, "");
    if (localPath) {
      if (uvStatus === true) {
        return base + "/" + b64url(target);
      }
      return target;
    }
    if (target.indexOf("//") === 0) target = location.protocol + target;
    if (target.indexOf("://") === -1) target = "https://" + target;
    if (hashRoute) return base + "#" + b64url(target);
    return base + "/" + b64url(target);
  }

  /* Proxy route (new tab). Falls back to returning false if no proxy is
     configured. */
  function openProxy(url, proxyUrl) {
    if (!proxyUrl || isDeadStubProxy(proxyUrl)) return false;
    var win = openTab(routeProxy(url, proxyUrl));
    return !!win;
  }

  /* First configured proxy with a real URL, or null. */
  function firstProxy() {
    return liveProxy();
  }

  /* Route a site through the first configured proxy and open it as a plain
     new tab. With no live proxy we fall back to the normal direct open. */
  function openSiteProxied(target, title) {
    /* Local same-origin pages never need (or survive) the rewriting proxy. */
    if (isLocalPlayUrl(target)) {
      return openDirect(target || "") ? (target || "") : "";
    }
    var p = firstProxy();
    if (!p) {
      ChalkleLaunch.open(target || "", title || target || "");
      return (target || "");
    }
    var url = routeProxy(target, p.url, p.mode === "frame" || !!p.hashRoute);
    openTab(url);
    return url;
  }

  /* Route an app through the first configured proxy and open it as a plain
     new tab. With no proxy configured we open the plain target so it still
     has a chance. Returns the url actually launched, or "" on failure.
     Same-origin targets ( /game-builds/... ) never go through the proxy:
     they already live on this origin, and rewriting them breaks engines that
     load relative assets (GameMaker, some WebGL). Those open directly. */
  function openProxyApp(target, title) {
    if (isLocalPlayUrl(target)) {
      var directUrl = openDirect(target || "") ? (target || "") : "";
      return directUrl;
    }
    var live = liveProxy();
    if (!live) { ChalkleLaunch.open(target || "", title || target || ""); return target || ""; }
    var url = routeProxy(target, live.url, live.mode === "frame" || !!live.hashRoute);
    openTab(url);
    return url;
  }

  /* Turn raw HTML into a URL so inline items (e.g. Ruffle-wrapped games)
     can open as a local blob in a new tab. */
  function htmlUrl(html) {
    var src = String(html || "");
    if (!src.trim()) return "";
    try {
      return URL.createObjectURL(new Blob([src], { type: "text/html" }));
    } catch (e) {
      return "data:text/html;charset=utf-8," + encodeURIComponent(src);
    }
  }

  /* ---------- Public API ---------- */

  window.ChalkleLaunch = {
    /* Everything opens as a normal new tab. No picker, no cloaks. */
    open: function (url, title) {
      return openDirect(url || "");
    },
    /* "Open with…" affordances do the same thing - direct new tab. */
    openWithOptions: function (url, title) {
      return openDirect(url || "");
    },
    openDirect: openDirect,
    openProxy: openProxy,
    openProxyApp: openProxyApp,
    openSiteProxied: openSiteProxied,
    firstProxy: firstProxy,
    routeProxy: routeProxy,
    b64url: b64url,
    htmlUrl: htmlUrl,
    isLocalPlayUrl: isLocalPlayUrl,
    shouldOpenDirect: shouldOpenDirect
  };

  /* The most-recently opened URL (set by inAppFrame) - lets the overlay's
     "New tab" button pop the current game out even when it was opened by the
     launcher rather than a proxy card. */
  window.ChalkleLaunch.lastOpenUrl = "";
})();
