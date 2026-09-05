/* Chalkle launcher. External games/sites/tools/links open inside a fresh
   about:blank window: a system page, so screen-capture monitoring cannot see
   or flag the tab. The blank document carries the site's active cloak
   title/icon and a full-viewport no-referrer iframe. Local same-origin pages
   ( /game-builds/, /gn/, /ugs/ ), blob/data items and Unity builds keep
   opening top-level, and when a popup is blocked the item falls back to the
   in-app frame overlay on this page. */

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
    /* Root-absolute paths ("/gn/0.html") must resolve against the document
       base, not the origin root - static mirrors are served from a subpath
       (e.g. github.io/chalkle/), where /gn/... 404s. new URL against the
       current href resolves relative refs (incl. <base>) correctly and is a
       no-op for absolute URLs. */
    try {
      var u = String(url || "");
      if (u.charAt(0) === "/" && u.charAt(1) !== "/") url = new URL(u, document.baseURI || location.href).href;
    } catch (e) { /* keep the raw path */ }
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
    var win = openTab(url);
    /* Popup blocked (managed Chromebooks): play the proxied game in the
       in-app frame overlay instead of failing silently. */
    if (!win) inAppFrame(url, title || target || "");
    return url;
  }

  /* The blank window copies the site's active cloak (same preset list as the
     Settings tab) so the launched tab reads as a school page. Falls back to
     the custom cloak title, then "Classes" with the Classroom icon. */
  function cloakIdentity() {
    var CLOAK_PRESETS = {
      google: ["Google", "https://www.google.com/favicon.ico"],
      classroom: ["Classes", "https://ssl.gstatic.com/classroom/ic_product_classroom_32.png"],
      docs: ["Untitled document - Google Docs", "https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico"],
      drive: ["My Drive - Google Drive", "https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png"],
      canvas: ["Dashboard", "https://du11hjcvx0uqb.cloudfront.net/dist/images/favicon.ico"],
      clever: ["Clever | Portal", "https://www.clever.com/wp-content/uploads/2023/06/cropped-Favicon-512px-32x32.png"],
      khan: ["Dashboard | Khan Academy", "https://www.khanacademy.org/favicon.ico"],
      ixl: ["IXL | Math, Language Arts, Science, Social Studies, and Spanish", "https://www.ixl.com/favicon.ico"]
    };
    var preset = null;
    try {
      var id = localStorage.getItem("chalkle-cloak") || "";
      preset = CLOAK_PRESETS[id];
    } catch (e) { /* no storage */ }
    if (preset) return { title: preset[0], icon: preset[1] };
    var custom = "Classes";
    try { custom = localStorage.getItem("chalkle-cloak-title") || "Classes"; } catch (e) { /* no storage */ }
    return { title: custom, icon: "https://ssl.gstatic.com/classroom/ic_product_classroom_32.png" };
  }

  function escHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* Open an external URL inside a fresh about:blank window. about:blank is
     treated as a system page, so tab-watching and screenshot monitoring can't
     capture what runs here. The blank document sets the cloak title/icon and
     hosts a full-viewport no-referrer iframe (same shape as the classic
     about:blank embed, with fullscreen/autoplay allowed for games). */
  function openBlankEmbed(url, title) {
    var target = String(url || "").trim();
    if (!target) return false;
    if (target.indexOf("//") === 0) target = location.protocol + target;
    if (target.indexOf("://") === -1) target = "https://" + target;
    var ident = cloakIdentity();
    var win = window.open("about:blank", "_blank");
    if (!win) return inAppFrame(url, title || url);
    try { win.opener = null; } catch (e) { /* ignore */ }
    try {
      var doc = win.document;
      doc.open();
      doc.write(
        '<!doctype html><html><head><meta charset="utf-8">' +
        '<title>' + escHtml(ident.title) + '</title>' +
        '<link rel="icon" href="' + escHtml(ident.icon) + '">' +
        '</head><body style="margin:0;height:100vh;background:#fff"></body></html>'
      );
      doc.close();
      var frame = doc.createElement("iframe");
      frame.setAttribute("src", target);
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("allow", "fullscreen; autoplay; clipboard-read; clipboard-write; encrypted-media; picture-in-picture");
      frame.setAttribute("allowfullscreen", "");
      frame.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;border:0;margin:0;display:block;background:#fff";
      doc.body.appendChild(frame);
      window.ChalkleLaunch.lastOpenUrl = target;
    } catch (e) {
      try { win.close(); } catch (e2) { /* ignore */ }
      return inAppFrame(url, title || url);
    }
    return true;
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

  /* ---------- Explicit launch chooser ---------- */

  var chooser = null;
  var chooserPreviousFocus = null;
  var chooserState = null;

  function chooserOptions(url) {
    var u = String(url || "").trim();
    var local = isLocalPlayUrl(u);
    var binary = /^(?:blob:|data:)/i.test(u);
    var options = [];
    if (local || binary || shouldOpenDirect(u)) {
      options.push({ id: "direct", title: "Direct tab", desc: "Open the game in its own tab", featured: true });
    } else {
      options.push({ id: "direct", title: "Direct tab", desc: "Try the original game URL", featured: true });
      options.push({ id: "blank", title: "Cloaked tab", desc: "Load it inside a fresh blank tab" });
      if (liveProxy()) options.push({ id: "proxy", title: "Proxy tab", desc: "Route it through the configured proxy" });
    }
    if (document.getElementById("proxy-overlay")) {
      options.push({ id: "frame", title: "In-app frame", desc: "Keep the game inside Chalkle" });
    }
    return options;
  }

  function launchByMethod(method, url, title) {
    var target = String(url || "").trim();
    if (!target) return false;
    if (method === "blank" && /^https?:/i.test(target)) return openBlankEmbed(target, title || target);
    if (method === "proxy") return openProxyApp(target, title || target);
    if (method === "frame") return inAppFrame(target, title || target);
    return openDirect(target);
  }

  function closeChooser() {
    if (!chooser) return;
    chooser.hidden = true;
    chooserState = null;
    if (chooserPreviousFocus && chooserPreviousFocus.focus) chooserPreviousFocus.focus();
    chooserPreviousFocus = null;
  }

  function showChooser(url, title) {
    var options = chooserOptions(url);
    if (!options.length) return false;
    if (!chooser) {
      chooser = document.createElement("div");
      chooser.className = "launch-modal";
      chooser.hidden = true;
      chooser.setAttribute("role", "dialog");
      chooser.setAttribute("aria-modal", "true");
      chooser.setAttribute("aria-labelledby", "launch-chooser-title");
      document.body.appendChild(chooser);
      chooser.addEventListener("click", function (e) {
        if (e.target === chooser || e.target.closest("[data-launch-cancel]")) closeChooser();
        var btn = e.target.closest("[data-launch-method]");
        if (!btn || !chooserState) return;
        var ok = launchByMethod(btn.getAttribute("data-launch-method"), chooserState.url, chooserState.title);
        if (ok !== false) closeChooser();
      });
    }
    chooserState = { url: String(url || ""), title: String(title || "Playing") };
    chooserPreviousFocus = document.activeElement;
    chooser.innerHTML =
      '<div class="launch-card" tabindex="-1">' +
      '<div class="launch-head"><div class="launch-titles">' +
      '<span class="launch-name" id="launch-chooser-title">' + escHtml(title || "Open game") + '</span>' +
      '<span class="launch-sub">Choose how you want to open this item.</span></div>' +
      '<button class="launch-x" type="button" data-launch-cancel aria-label="Cancel">&times;</button></div>' +
      '<div class="launch-grid">' + options.map(function (o) {
        return '<button type="button" class="launch-opt' + (o.featured ? ' launch-featured' : '') + '" data-launch-method="' + o.id + '">' +
          '<span class="launch-opt-title">' + escHtml(o.title) + '</span>' +
          '<span class="launch-opt-desc">' + escHtml(o.desc) + '</span></button>';
      }).join("") + '</div>' +
      '<div class="launch-foot"><span class="launch-label">Nothing is opened until you choose a method.</span>' +
      '<button type="button" class="btn-ghost" data-launch-cancel>Cancel</button></div></div>';
    chooser.hidden = false;
    var first = chooser.querySelector("[data-launch-method]");
    if (first) first.focus();
    return true;
  }

  /* ---------- Public API ---------- */

  window.ChalkleLaunch = {
    /* External URLs open inside a cloaked about:blank window. Local pages
       (same-origin), blob/data items and Unity-style builds still open
       top-level, and a blocked popup falls back to the in-app frame. */
    open: function (url, title) {
      var u = String(url || "").trim();
      if (!u) return false;
      if (/^(blob:|data:|javascript:|about:)/i.test(u)) return openDirect(u);
      if (isLocalPlayUrl(u)) return openDirect(u);
      if (/^https?:/i.test(u)) return openBlankEmbed(u, title || u);
      return openDirect(u);
    },
    /* Every card-level launch asks first, instead of silently selecting a
       route based on URL shape or popup policy. */
    openWithOptions: function (url, title) {
      return showChooser(url || "", title || "Open item");
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
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && chooser && !chooser.hidden) closeChooser();
  });
})();
