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
     behind this origin. Probe at startup (with retries: the server may still
     be waking when the first click lands) and only advertise it when it
     really answers. A passing probe is remembered for the browser session so
     the very first click after a reload already routes through the proxy
     instead of gambling on the raw - and likely blocked - URL. */
  var UV_SEEN_KEY = "chalkle-uv-ok";
  var uvStatus = null; // null = probing, true = usable, false = unusable
  var uvAttempts = 0;
  function uvSeenGet() {
    try { return sessionStorage.getItem(UV_SEEN_KEY) === "1"; } catch (e) { return false; }
  }
  function uvSeenSet(ok) {
    try {
      if (ok) sessionStorage.setItem(UV_SEEN_KEY, "1");
      else sessionStorage.removeItem(UV_SEEN_KEY);
    } catch (e) { /* no storage */ }
  }
  function probeBuiltinProxy() {
    var origin = usableOrigin();
    if (!origin) { uvStatus = false; return; }
    if (uvStatus !== true && uvSeenGet()) uvStatus = true; /* trust this session */
    uvAttempts++;
    fetch(origin + "/uv/", { method: "GET", cache: "no-store" })
      .then(function (r) {
        if (r.ok) { uvStatus = true; uvSeenSet(true); return; }
        /* Not the proxy we know (404 on static hosts). Downgrade fast so a
           mirror never keeps sending tabs into a dead /uv, then two more
           tries in case the server is mid-restart. */
        uvStatus = false;
        if (uvAttempts < 3) { setTimeout(probeBuiltinProxy, 900 * uvAttempts); return; }
        uvSeenSet(false);
      })
      .catch(function () {
        uvStatus = false;
        if (uvAttempts < 3) { setTimeout(probeBuiltinProxy, 900 * uvAttempts); return; }
        uvSeenSet(false);
      });
  }
  /* Optimistic start on real http(s) origins: the built-in /uv route exists
     on the hosted site, so browser tabs can route through it immediately
     instead of waiting for the async probe - a search sent out direct in
     that window gets X-Frame-Options-blocked. file:// and opaque origins
     (single-file build) never get the flag; the probe downgrades it fast on
     mirrors where /uv does not exist. */
  var bootOrigin = usableOrigin();
  if (bootOrigin && !/^file:/i.test(String(location.protocol || ""))) uvStatus = true;
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

  /* Resolve a game target to the URL the in-app player or browser should
     load: single-file embeds first, then proxy routing for external hosts.
     Shared by the in-app browser and the game player, so both surfaces load
     exactly the same payload. */
  function playTarget(url) {
    var target = String(url || "");
    /* Single-file builds: resolve embedded local games before framing. */
    var emb = singleFileEmbed(target);
    if (emb) target = emb;
    var p = liveProxy();
    if (p && /^https?:/i.test(target) && !shouldOpenDirect(target)) {
      target = routeProxy(target, p.url, p.mode === "frame" || !!p.hashRoute);
    }
    return target;
  }

  /* Open a URL in the in-app browser (ChalkleBrowser when loaded, otherwise
     the legacy overlay). Used as the fallback when a popup is blocked, and
     by the "In-app frame" launch choice. Routing (single-file embeds, proxy
     rewriting) is resolved HERE, before the browser ever sees the target. */
  function inAppFrame(url, title) {
    pauseMusicForTarget(url);
    var target = playTarget(url);
    window.ChalkleLaunch.lastOpenUrl = target;
    if (window.ChalkleBrowser && window.ChalkleBrowser.open) {
      return window.ChalkleBrowser.open(target, title || "Playing");
    }
    return false;
  }

  /* Redirector shell. External links (apps/tools/proxy sites) open as
     /go.html#<base64>, a tiny same-origin page that decodes the target and
     window.location.replace()s to it. The destination never appears in the
     card's href, the click's network request, or this page's DOM, so link-
     and request-scanning filters see only our own origin. Base64 is standard
     (btoa/atob) so the shell stays a one-liner. */
  function shellUrl(target) {
    var t = String(target || "").trim();
    if (!t) return "";
    /* Resolve the payload target NOW, not inside go.html: the shell just
       does location.replace(atob(hash)) against its own base, so a
       root-absolute game-builds path would resolve against the mirror host
       and 404. Relocate local-only paths to the relay, then resolve against
       the document base. */
    try {
      if (t.charAt(0) === "/" && t.charAt(1) !== "/") {
        if (window.ChalkleApi && window.ChalkleApi.localUrl) t = window.ChalkleApi.localUrl(t) || t;
        if (t.charAt(0) === "/") t = new URL(t, document.baseURI || location.href).href;
      }
    } catch (e) { /* keep the raw path */ }
    var enc = "";
    try { enc = btoa(t); } catch (e) { return t; }
    var shell = "/go.html#" + enc;
    try { shell = new URL(shell, document.baseURI || location.href).href; } catch (e) { /* keep */ }
    return shell;
  }

  /* Open a target through the redirector shell. Popup blocked: fall back to
     the in-app frame (which renders the shell, which redirects in-frame). */
  function openShell(target, title) {
    var shell = shellUrl(target);
    if (!shell) return false;
    /* Stay inside Chalkle when the in-app browser is available: the shell
       page (and whatever it redirects to) loads in the overlay, not a new
       OS tab. The overlay's own pop-out button covers the rare full-tab
       case. */
    if (window.ChalkleBrowser && window.ChalkleBrowser.open) {
      window.ChalkleBrowser.open(shell, title || target || "", { raw: true });
      window.ChalkleLaunch.lastOpenUrl = shell;
      return true;
    }
    var win = openTab(shell);
    if (!win) inAppFrame(shell, title || target || "");
    return !!win || true;
  }

  /* Open a URL as a plain new tab and hand back the window handle. The
     "noopener" feature string is NOT used: per spec it makes window.open
     return null, which would break the popup-blocked fallback below and
     make every caller report failure. We sever opener access manually
     instead - cross-origin tabs cannot touch us either way, and a same-origin
     wrapper page has nothing sensitive to reach. */
  /* Opening YouTube (tab, app card or in-app frame) means audio is about to
     come from somewhere else - stop the Music tab's playback first. */
  function pauseMusicForTarget(url) {
    try {
      var h = String(url || "").toLowerCase();
      if (h.indexOf("youtube.com") !== -1 || h.indexOf("youtu.be") !== -1) {
        if (window.ChalkleMusic && window.ChalkleMusic.pause) window.ChalkleMusic.pause();
      }
    } catch (e) { /* no music module / no storage - ignore */ }
  }

  /* Absolute CDN URLs for local-only folders (game-builds/, mc/, flare/,
     assets/games/psx/) are a guaranteed 404 on static mirrors like jsDelivr,
     and they can reach the launcher in two ways: either directly from card data
     on a mirror bootstrap, or after a root-absolute path resolves against a
     CDN host. Re-point any such URL at the relay before opening. No-op on the
     real site and for anything not local-only. */
  function rerouteDeadMirrorGameUrl(url) {
    var u = String(url || "").trim();
    if (!u || u.indexOf("://") === -1) return url;
    try {
      var pu = new URL(u);
      var hostname = pu.hostname;
      if (hostname && /^(?:cdn\.jsdelivr\.net|githack\.com|unpkg\.com|github\.io|pages\.dev|gitlab\.io|githubusercontent\.com|vercel\.app|netlify\.app)$/i.test(hostname)) {
        /* Strip the CDN mirror subpath (e.g. /gh/user/repo@main/) so the
           local-only prefixes match the real repo-relative path. The
           versioned segment is the one containing "@". */
        var rawPath = String(pu.pathname || "");
        var atIdx = rawPath.indexOf("@");
        var path = (atIdx !== -1) ? rawPath.slice(rawPath.indexOf("/", atIdx)) : rawPath;
        if (!path || path.charAt(0) !== "/") path = rawPath;
        /* /ugs/ and /gn/ are mirrored by jsDelivr but served as text/plain
           (nosniff), so a game opened from a mirror URL shows raw source -
           they only play from the relay. Same treatment as game-builds. */
        if (path.indexOf("/game-builds/") === 0 || path.indexOf("/mc/") === 0 || path.indexOf("/flare/") === 0 || path.indexOf("/assets/games/psx/") === 0 || path.indexOf("/ugs/") === 0 || path.indexOf("/gn/") === 0) {
          var relay = "";
          try { relay = window.ChalkleApi && window.ChalkleApi.root ? String(window.ChalkleApi.root() || "").replace(/\/+$/, "") : ""; } catch (e) { /* keep raw */ }
          if (relay && /^https?:/i.test(relay)) {
            return relay + path + pu.search + pu.hash;
          }
        }
      }
    } catch (e) { /* not a url - keep raw */ }
    return url;
  }

  function openTab(url) {
    pauseMusicForTarget(url);
    /* Embedded single-file games (build/chalkle-single*.html): the game's
       HTML is stored in __SINGLE_GAMES__ keyed by its origin path. A static
       host can't serve /ugs/... so resolve to the embedded data URI before
       opening. */
    var emb = singleFileEmbed(url);
    if (emb) url = emb;
    /* Root-absolute paths ("/gn/0.html") must resolve against the document
       base, not the origin root - static mirrors are served from a subpath
       (e.g. github.io/chalkle/), where /gn/... 404s. new URL against the
       current href resolves relative refs (incl. <base>) correctly and is a
       no-op for absolute URLs. */
    try {
      var u = String(url || "");
      if (u.charAt(0) === "/" && u.charAt(1) !== "/") url = new URL(u, document.baseURI || location.href).href;
    } catch (e) { /* keep the raw path */ }
    /* Local-only folders (game-builds/, mc/, flare/, assets/games/psx/) only
       exist on the production relay. Re-point them through the API helper, and
       also catch any dead CDN absolute URLs that somehow reached the launcher
       (e.g. "https://cdn.jsdelivr.net/game-builds/undertale/index.html"). */
    try {
      if (window.ChalkleApi && window.ChalkleApi.localUrl) url = window.ChalkleApi.localUrl(url);
    } catch (e) { /* keep the resolved path */ }
    url = rerouteDeadMirrorGameUrl(url);
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
    /* Same rule as openProxyApp: proxied sites load in the in-app browser,
       never as raw new tabs. */
    if (window.ChalkleBrowser && window.ChalkleBrowser.open) {
      window.ChalkleBrowser.open(url, title || target || "", { raw: true });
      window.ChalkleLaunch.lastOpenUrl = url;
      return url;
    }
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
    /* Load inside Chalkle's own browser overlay: the whole point of the
       built-in /uv/ proxy is that the site never leaves the app as a raw
       tab. The overlay keeps tabs, back/forward and a pop-out button, and
       its frames route through /uv/ (raw: the URL is already routed). */
    if (window.ChalkleBrowser && window.ChalkleBrowser.open) {
      window.ChalkleBrowser.open(url, title || target || "", { raw: true });
      window.ChalkleLaunch.lastOpenUrl = url;
      return url;
    }
    /* No in-app browser (single-file builds): real tab, with the in-app
       frame as the popup-blocked fallback. */
    var win = openTab(url);
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
    pauseMusicForTarget(target);
    if (target.indexOf("//") === 0) target = location.protocol + target;
    if (target.indexOf("://") === -1) target = "https://" + target;
    /* A cloaked tab that loads a blocked URL is still a blocked tab - when
       the built-in proxy is live, route the framed page through it too. */
    var p = liveProxy();
    if (p && /^https?:/i.test(target) && !shouldOpenDirect(target)) {
      target = routeProxy(target, p.url, p.mode === "frame" || !!p.hashRoute);
    }
    /* file: can never load inside a data: page (Chrome logs "Content at … may
       not load or link to file:///" the instant it lands in the DOM), and
       about: here would blank the cloak instead of loading the game. */
    if (/^(file:|about:)/i.test(String(target).trim())) return false;
    var ident = cloakIdentity();
    
    /* Build a self-contained cloaked page as a data URL. This avoids any
       timing issues with document.write and ensures the guard is in place
       before the iframe even loads. The page immediately intercepts any
       attempt to steer the top window. */
    var cloakPage = '' +
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<title>' + escHtml(ident.title) + '</title>' +
      '<link rel="icon" href="' + escHtml(ident.icon) + '">' +
      '<meta http-equiv="refresh" content="0;url=about:blank" id="navGuard">' +
      '<style>' +
      'html,body{margin:0;height:100%;overflow:hidden;background:#fff}' +
      'iframe{position:fixed;inset:0;width:100vw;height:100vh;border:0;background:#fff}' +
      '</style>' +
      '</head><body>' +
      '<iframe id="gameFrame" src="about:blank" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-orientation-lock allow-pointer-lock allow-presentation" allow="' + ((window.ChalkleApi && ChalkleApi.iframeAllow) ? ChalkleApi.iframeAllow() + "; gamepad" : "fullscreen; picture-in-picture; gamepad") + '" allowfullscreen></iframe>' +
      '<script>' +
      '(function(){' +
      '  var locked = false;' +
      '  var frame = document.getElementById("gameFrame");' +
      '  ' +
      '  // Lock the top location immediately' +
      '  try {' +
      '    if (top.location !== self.location) {' +
      '      top.location.replace("about:blank");' +
      '    }' +
      '  } catch(e) {}' +
      '  ' +
      '  // Monitor every 50ms for top-level navigation attempts' +
      '  setInterval(function(){' +
      '    try {' +
      '      if (top.location.href !== "about:blank" && top.location.href !== self.location.href) {' +
      '        top.location.replace("about:blank");' +
      '      }' +
      '    } catch(e) {}' +
      '  }, 50);' +
      '  ' +
      '  // Load the actual game into the iframe' +
      '  try {' +
      '    frame.src = "' + target + '";' +
      '  } catch(e) {' +
      '    frame.src = target;' +
      '  }' +
      '  ' +
      '  // If the iframe tries to navigate, catch it' +
      '  frame.onload = function(){' +
      '    try {' +
      '      if (frame.contentWindow && frame.contentWindow.top && frame.contentWindow.top !== frame.contentWindow) {' +
      '        frame.contentWindow.top.location.replace("about:blank");' +
      '      }' +
      '    } catch(e) {}' +
      '  };' +
      '})();' +
      '</script>' +
      '</body></html>';
    
    try {
      var win = window.open("data:text/html;charset=utf-8," + encodeURIComponent(cloakPage), "_blank");
      if (!win) {
        // data URL blocked - fall back to about:blank with document.write
        win = window.open("about:blank", "_blank");
        if (!win) return inAppFrame(url, title || url);
        try { win.opener = null; } catch(e) { /* ignore */ }
        var doc = win.document;
        doc.open();
        doc.write(cloakPage);
        doc.close();
      }
      try { win.opener = null; } catch(e) { /* ignore */ }
      window.ChalkleLaunch.lastOpenUrl = target;
    } catch (e) {
      try { win.close(); } catch(e2) { /* ignore */ }
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
      if (/^https?:/i.test(u)) {
        /* External hosts are the things school filters block - with the
           built-in proxy live, external links route through it first. Only
           when no proxy exists fall back to the plain cloaked embed. */
        var p = liveProxy();
        if (p) return openProxyApp(u, title || u);
        return openBlankEmbed(u, title || u);
      }
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
    playTarget: playTarget,
    pauseMusicForTarget: pauseMusicForTarget,
    openShell: openShell,
    shellUrl: shellUrl,
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

  /* Single-file build: embedded local game HTML (build/chalkle-single*.html
     inlines self-contained games keyed by their origin path). Returns the
     matching data URI, or "" when the map is absent / has no entry. */
  function singleFileEmbed(url) {
    try {
      var map = window.__SINGLE_GAMES__;
      if (!map) return "";
      var u = String(url || "");
      /* The GBA player is embedded once (with every ROM as data URIs);
         the ?rom=X is passed along as a hash on the shared data URI. */
      var gba = u.match(/^\/assets\/gba\/index\.html\?rom=([^#&]+)/);
      if (gba) {
        var shared = map["/assets/gba/index.html"] || "";
        return shared ? shared + "#" + decodeURIComponent(gba[1]) : "";
      }
      /* Redirector shell (/go.html#<base64>) is embedded once too - keep the
         hash payload on the shared data URI so static single-file builds can
         still bounce through it. */
      var shell = u.match(/^\/go\.html#([^#]+)/);
      if (shell) {
        var shellShared = map["/go.html"] || "";
        return shellShared ? shellShared + "#" + shell[1] : "";
      }
      var v = map[u];
      return v || "";
    } catch (e) { return ""; }
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && chooser && !chooser.hidden) closeChooser();
  });
})();
