/* Chalkle launcher. Five ways to open a game or site:
   direct, about:blank, blob tab, in-app frame, and through a proxy.
   Wrappers follow the proven pattern: sandboxed iframe without top-navigation
   so frame-busting sites stay contained, plus a refusal watcher that only
   redirects when the browser actually refused to load the page. */

(function () {
  "use strict";

  var WRAP_TITLE = "Classes";
  try {
    WRAP_TITLE = localStorage.getItem("chalkle-cloak-title") || "Classes";
  } catch (e) { /* no storage */ }

  var WRAP_ICON = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3Cstyle%3E%40font-face%7Bfont-family%3A%22Boogaloo%22%3Bsrc%3Aurl(data%3Afont%2Fttf%3Bbase64%2CAAEAAAAPAIAAAwBwR0RFRgARAAIAAAEgAAAAFkdQT1NEdEx1AAABOAAAAB5HU1VCuPy46gAAAbwAAAAoT1MvMly0bagAAAJYAAAAYGNtYXAAeABaAAACHAAAADxnYXNwAAAAEAAAAQQAAAAIZ2x5ZvV2BCYAAAK4AAAAaGhlYWQDB5o1AAAB5AAAADZoaGVhB1YCvgAAAZgAAAAkaG10eAUsABoAAAEUAAAADGxvY2EAAAA0AAABDAAAAAhtYXhwAEwAQwAAAVgAAAAgbmFtZTEHTZ0AAAMgAAACUnBvc3T%2FYgBPAAABeAAAACBwcmVwaAaMhQAAAPwAAAAHuAH%2FhbAEjQAAAQAB%2F%2F8ADwAAAAAAAAA0AlgAAADyAAAB4gAaAAEAAAAMAAAAAAAAAAEAAQACAAEAAQAAAAEAAAAKABwAHAABREZMVAAIAAQAAAAA%2F%2F8AAAAAAAAAAQAAAAMAQAAHAAAAAAACAAAAAQABAAAAQAAAAAAAAAADAAAAAAAA%2F18ATwAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAOv%2FwoAAAP0%2F7v%2FvAPpAAEAAAAAAAAAAAAAAAAAAAADAAEAAAAKACYAJgACREZMVAASbGF0bgAOAAAAAAAEAAAAAP%2F%2FAAAAAAABAAAAAQCDBwPtyV8PPPUACwPoAAAAAMsTTJQAAAAA1TEJgP%2B7%2FwoD6QOvAAAACAACAAAAAAAAAAAAAgAAAAMAAAAUAAMAAQAAABQABAAoAAAABgAEAAEAAgAgAEP%2F%2FwAAACAAQ%2F%2F%2F%2F%2BH%2FvwABAAAAAAAAAAIBVgGQAAUAAAKUAlgAAP9EApQCWAAAAPsAMgD6CgYDBgkCAwICAgIDAAAAIwAAAAAAAAAAAAAAAE1ZRk8AQAAgAEMDr%2F8KAAADrwD2AAAAAQAAAAABUgHVAAAAIAACAAEAGv%2FiAdgCvwAgAAABIgYVFDMyNjY3FwYGIyImNTQ3NjYzMhcWFhcWFyc0JyYBDSxCXBonEQx%2FGmdcbHU6HGVBUCQSFwUJAoEYCwI%2F2VSwLTAqCnuCo36Ti0VZNRo2KkNNDIEhEQAAAAAIAGYAAwABBAkAAAEKAOIAAwABBAkAAQAQANIAAwABBAkAAgAOAMQAAwABBAkAAwA2AI4AAwABBAkABAAgAG4AAwABBAkABQAaAFQAAwABBAkABgAgADQAAwABBAkADgA0AAAAaAB0AHQAcAA6AC8ALwBzAGMAcgBpAHAAdABzAC4AcwBpAGwALgBvAHIAZwAvAE8ARgBMAEIAbwBvAGcAYQBsAG8AbwAtAFIAZQBnAHUAbABhAHIAVgBlAHIAcwBpAG8AbgAgADEALgAwADAAMgBCAG8AbwBnAGEAbABvAG8AIABSAGUAZwB1AGwAYQByADEALgAwADAAMgA7AE0AWQBGAE8AOwBCAG8AbwBnAGEAbABvAG8ALQBSAGUAZwB1AGwAYQByAFIAZQBnAHUAbABhAHIAQgBvAG8AZwBhAGwAbwBvAEMAbwBwAHkAcgBpAGcAaAB0ACAAKABjACkAIAAyADAAMQAxACwAIABKAG8AaABuACAAVgBhAHIAZwBhAHMAIABCAGUAbAB0AHIAYQBuACAAKAB3AHcAdwAuAGoAbwBoAG4AdgBhAHIAZwBhAHMAYgBlAGwAdAByAGEAbgAuAGMAbwBtAHwAagBvAGgAbgAuAHYAYQByAGcAYQBzAGIAZQBsAHQAcgBhAG4AQABnAG0AYQBpAGwALgBjAG8AbQApACwAIAB3AGkAdABoACAAUgBlAHMAZQByAHYAZQBkACAARgBvAG4AdAAgAE4AYQBtAGUAIAAiAEIAbwBvAGcAYQBsAG8AbwAiAC4AAA%3D%3D)%20format(%22truetype%22)%3B%7D%3C%2Fstyle%3E%3C%2Fdefs%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22%23111317%22%2F%3E%3Ctext%20x%3D%2232%22%20y%3D%2248%22%20font-family%3D%22Boogaloo%22%20font-size%3D%2234%22%20text-anchor%3D%22middle%22%20fill%3D%22%231557b0%22%3EC%3C%2Ftext%3E%3Ctext%20x%3D%2232%22%20y%3D%2244%22%20font-family%3D%22Boogaloo%22%20font-size%3D%2234%22%20text-anchor%3D%22middle%22%20fill%3D%22%234285f4%22%3EC%3C%2Ftext%3E%3C%2Fsvg%3E";

  var SANDBOX =
    "allow-scripts allow-forms allow-same-origin allow-popups " +
    "allow-popups-to-escape-sandbox allow-downloads allow-modals " +
    "allow-presentation allow-pointer-lock";

  /* Why allow-same-origin is here: without it the framed game runs as an
     opaque/null origin, which kills IndexedDB, localStorage, cookies,
     WebSockets, SharedArrayBuffer and service workers - the exact things
     Unity/WASM and live games need to boot. Giving the frame its own origin
     keeps those working while the iframe stays sandboxed (no top navigation,
     no parent access: the wrapper is a fresh about:blank/blob document, so
     there is nothing sensitive for the game to reach). Frame-blocking sites
     are still caught by the refusal watcher below and bounced to a proxy. */

  /* Pages that already live on this site ( /game-builds/... ). Wrapping them
     in about:blank / blob iframes makes Chromium treat fetches as origin
     "null", Unity/WASM fail, and school filters often refuse the iframe
     even though the same file works as a normal tab. Always open these
     top-level on this origin. */
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

  /* iOS Safari (iPhone/iPad) is strict about opaque origins: games running
     in an about:blank / blob / data cloak lose the ability to reach
     cross-origin resources (their embedded loaders then fail with errors
     like "Failed to fetch version info"). On iOS, self-hosted /game-builds/
     games open as a plain same-origin tab so they keep a real origin. */
  function isIOS() {
    try {
      var ua = String(navigator.userAgent || "");
      if (/iPhone|iPad|iPod/i.test(ua)) return true;
      if (navigator.userAgentData && navigator.userAgentData.platform) {
        if (/^iOS$/i.test(navigator.userAgentData.platform)) return true;
      }
      /* iPadOS reports a Mac UA but has a touchscreen. */
      if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true;
    } catch (e) { /* ignore */ }
    return false;
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

  function wrapHtml(url) {
    var safeUrl = String(url).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    var b64 = "";
    try { b64 = btoa(encodeURIComponent(url)); } catch (e) { b64 = ""; }
    return (
      '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>' + WRAP_TITLE + "</title>" +
      '<link rel="icon" href="' + WRAP_ICON + '"></head>' +
      '<body style="margin:0;overflow:hidden;background:#0c1210;">' +
      '<iframe id="game-frame" sandbox="' + SANDBOX + '" ' +
      'style="width:100vw;height:100vh;border:none;display:block;" ' +
      'allow="fullscreen; gamepad; picture-in-picture" referrerpolicy="no-referrer"></iframe>' +
      '<script>' +
      'var f = document.getElementById("game-frame");\n' +
      'var u = "' + safeUrl + '";\n' +
      'if ("' + b64 + '") { try { u = decodeURIComponent(atob("' + b64 + '")); } catch(e){} }\n' +
      'if (f) f.src = u;\n' +
      '</script>' +
      "</body></html>"
    );
  }

  /* Refusal watcher: when a site refuses to be framed (X-Frame-Options / CSP
     frame-ancestors), Chromium commits a chrome-error:// "refused to connect"
     document inside the sandboxed iframe. That page is same-origin, so we can
     read it. If we ever see it, or an empty committed frame, we bounce the
     whole cloak tab to the real URL in the top window - a plain navigation the
     server (rightly) never blocks. A successful cross-origin game throws when
     we touch contentWindow, so that case stays cloaked. No blind redirects. */
  /* The built-in same-origin /uv/ proxy. It is served by this site's own
     server, so a school filter has nothing separate to block and the URL can
     never go stale the way a hosted tunnel can. Every auto-route prefers it
     over hosted proxies (which can be blocked or die). */
  /* A usable same-origin base for the built-in /uv/ proxy. The single-file
     build runs from file:// or an opaque origin (about:blank / blob / data),
     where location.origin is the literal string "null" and there is no
     server behind it - the builtin /uv/ route cannot exist there. Returns ""
     when the origin can't host /uv/, so callers fall back to hosted
     proxies instead of building a broken "null/uv" URL. */
  function usableOrigin() {
    try {
      var o = String(location.origin || "");
      if (!o || o === "null") return "";
      return /^https?:/i.test(o) ? o.replace(/\/+$/, "") : "";
    } catch (e) {
      return "";
    }
  }

  /* The /uv/ rewriting proxy only exists when serve-chalk.py is actually
     behind this origin. On the jsDelivr mirror (cdn/fastly.jsdelivr.net) or a
     static host there is no server, so origin + "/uv" 404s - and blindly
     claiming it produced URLs like cdn.jsdelivr.net/uv/<base64> that the
     mirror can't serve. Probe once at startup (a same-origin fetch is fast)
     and only advertise the built-in proxy when it really answers. */
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
    /* Don't claim /uv/ exists while the probe is still in flight (first
       moments of a load) or after it failed - those cases must fall back to
       hosted proxies instead of building a dead origin+/uv URL. */
    if (uvStatus !== true) return null;
    return { name: "Built-in", url: origin + "/uv", mode: "path", builtin: true };
  }

  /* Pick the first real configured proxy (skips the "your-proxy-url"
     placeholder) so both openProxyApp and the refusal fallback agree.
     The same-origin /uv/ proxy always wins - hosted Scramjet/Serium
     instances are blockable domains, /uv/ is this site itself. */
  function liveProxy() {
    var builtin = builtinProxy();
    var proxies =
      (typeof window.ChalkleGetProxies === "function" && window.ChalkleGetProxies()) ||
      window.ChalkleProxies || window.ChalkProxies || [];
    var hosted = null;
    for (var i = 0; i < proxies.length; i++) {
      var p = proxies[i];
      if (p && p.url && !isDeadStubProxy(p.url)) {
        /* Prefer a same-origin /uv/ entry if the list has one. */
        try {
          if (new URL(p.url, location.href).origin === location.origin && /\/uv\/?$/.test(new URL(p.url, location.href).pathname)) {
            return p;
          }
        } catch (e) { /* fall through */ }
        if (!hosted) hosted = p;
        /* On a real origin the builtin /uv/ always wins. On file:// or an
           opaque origin (single-file build) it cannot exist, so keep scanning
           and remember the first hosted proxy instead. */
        if (builtin) break;
      }
    }
    if (builtin) return builtin;
    /* No same-origin /uv/ server (single-file build on file://, about:blank,
       blob or data): route through the first hosted proxy instead of the
       broken "null/uv". */
    return hosted || null;
  }

  function watchGameTab(win, url, opts) {
    var settled = false;
    var tries = 0;
    opts = opts || {};
    /* NEVER bounce the cloak tab to the real blocked origin. That summons the
       raw host (X-Frame-Options / CSP pages, or just a blocked site) and
       undoes the whole point. Instead: if a proxy is configured, route the
       SAME barrier tab to the proxied URL (tab only talks to the proxy origin);
       otherwise swap the frame to a contained, purely-holding page and surface
       a tiny notice - never the live host. */
    function redirect() {
      if (settled) return;
      settled = true;
      var p = opts.proxy || liveProxy();
      if (p && p.url) {
        try { win.location.replace(routeProxy(url, p.url, p.mode === "frame" || !!p.hashRoute)); return; } catch (e) { /* keep going */ }
      }
      if (opts.onBlocked) { try { opts.onBlocked(); } catch (e) { /* ignore */ } }
      /* No proxy: instead of leaving the user on a dead "blocked" page,
         pull the game into the in-app frame overlay (through the /uv/ relay
         when one is live) so it still plays inside the Chalkle tab. */
      try {
        if (opts.iframeOnBlock !== false && inAppFrame(opts.iframeUrl || url, opts.title)) {
          try { win.close(); } catch (e) { /* ignore */ }
          return;
        }
      } catch (e) { /* keep going */ }
      try {
        var body = win.document.body;
        if (body) {
          body.innerHTML =
            '<div style="all:unset;display:flex;align-items:center;justify-content:center;height:100vh;width:100vw;background:#0c1210;color:#8fd6c2;font:600 14px/1.5 system-ui;text-align:center;padding:24px;box-sizing:border-box;">' +
            "This site blocks being embedded.\u003cbr\u003e\u003cspan style=\u0027opacity:.75\u0027\u003eOpen it again and pick \u0027Proxy\u0027 to view it.\u003c/span\u003e</div>";
        }
      } catch (e) { /* ignore */ }
    }
    function consider() {
      if (settled) return;
      var frame = win.document.getElementById("game-frame");
      if (!frame) return;
      var rejected = false;
      try {
        var loc = frame.contentWindow && frame.contentWindow.location;
        if (loc && loc.href && loc.href.indexOf("chrome-error") !== -1) rejected = true;
      } catch (e) { /* cross-origin game loaded fine - stay cloaked */ }
      if (!rejected) {
        try {
          var doc = frame.contentDocument;
          if (doc && doc.body) {
            if (doc.URL && doc.URL !== "about:blank" && doc.body.children.length === 0) rejected = true;
            if (/refused to (connect|display)|X-Frame-Options/i.test(doc.body.textContent || "")) {
              rejected = true;
            }
          }
        } catch (e) { /* cross-origin - stay cloaked */ }
      }
      if (rejected) redirect();
    }
    function attach() {
      var frame = win.document.getElementById("game-frame");
      if (!frame) return;
      frame.addEventListener("load", function () {
        setTimeout(consider, 150);
        setTimeout(consider, 700);
      });
      var timer = setInterval(function () {
        if (settled) { clearInterval(timer); return; }
        consider();
        if (++tries > 12) clearInterval(timer);
      }, 800);
    }
    if (win.document.readyState === "complete") attach();
    else win.addEventListener("load", attach);
  }

  function openDirect(url) {
    /* Local file paths can never open from a web page and would throw a
       security error - refuse them here so every launch method is covered. */
    if (/^(file:|javascript:)/i.test(String(url || "").trim())) return false;
    var win = window.open(url, "_blank", "noopener");
    if (!win && isLocalPlayUrl(url)) {
      try { window.location.href = url; return true; } catch (e) { return false; }
    }
    /* Popup blocked (managed Chromebooks often block new tabs entirely):
       play right here in the app instead of failing silently. */
    if (!win && /^https?:/i.test(String(url || "").trim())) return inAppFrame(url, url);
    return !!win;
  }

  /* Local builds + Unity WebGL must be a real top-level tab. Cloak iframes
     break asset paths and look like a blocked page. */
  function shouldOpenDirect(url) {
    return isLocalPlayUrl(url) || looksLikeUnityUrl(url);
  }

  /* Unity WebGL builds resolve relative asset paths (StreamingAssets/, the
     .data/.wasm, Build/*loader.js) against the DOCUMENT base. In a blob /
     about:blank / iframe wrapper that base is blob:null/ or the wrapper, so
     the loader throws "StreamingAssets is not a valid URL" and the game
     never boots (a <base> tag we inject doesn't help - Unity reads location,
     not document.baseURI). Detect those builds by URL so every wrap method
     hard-forces a real top-level tab instead of a dead black screen. */
  function looksLikeUnityUrl(url) {
    var u = String(url || "");
    if (!u) return false;
    /* Relative /game-builds paths are Unity (or other origin-sensitive ports)
       as often as remote https ones - don't require an http(s) scheme. */
    return /\.unityweb(?:[?#]|$)|\/StreamingAssets(?:\/|$)|\bUnityLoader\.|\bcreateUnityInstance\b|\/Build\/[A-Za-z0-9_+\-./]*loader\.js(?:[?#]|$)|\/game-builds\/(?:granny|granny3|clustertruck|gta3|cuphead)\b/i.test(u);
  }

  function openAboutBlank(url, watch) {
    if (shouldOpenDirect(url)) return openDirect(url);
    var win = window.open("about:blank", "_blank");
    if (!win) return inAppFrame(url, url);
    try {
      win.document.open();
      win.document.write(wrapHtml(url));
      win.document.close();
      win.document.title = WRAP_TITLE;
      win.focus();
    } catch (e) {
      try { win.close(); } catch (ignore) { /* ignore */ }
      return false;
    }
    if (watch) watchGameTab(win, url);
    return true;
  }

  function openBlob(url, watch) {
    if (shouldOpenDirect(url)) return openDirect(url);
    var html = wrapHtml(url);
    var blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    var win = window.open(blobUrl, "_blank");
    if (!win) {
      URL.revokeObjectURL(blobUrl);
      return inAppFrame(url, url);
    }
    setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 60000);
    if (watch) watchGameTab(win, url);
    return true;
  }

  /* Open a URL as a data: URL ("Data URL" method). Images become
     data:image/*;base64; fetchable HTML (jsDelivr / raw.githubusercontent)
     becomes data:text/html with a <base> so relative assets resolve; anything
     else just opens direct. Handy for SVG launchers (like the gnmath ones)
     and for pages that are only reachable as inline data. Unity builds are
     forced direct (they can't run from a data/blob origin). */
  function openDataUrl(url, watch) {
    var u = String(url || "");
    if (!u) return false;
    if (/^(?:data|file|javascript):/i.test(u)) return openDirect(u);
    if (shouldOpenDirect(u)) return openDirect(u);
    var isImage = /\.(?:png|jpe?g|gif|webp|svg|avif|ico)(?:[?#]|$)/i.test(u);
    var fetchable = new RegExp("^https?:\\/\\/(?:(?:cdn|fastly)\\.jsdelivr\\.net\\/gh|raw\\.githubusercontent\\.com)\\/", "i").test(u);
    if (isImage) {
      return fetch(u).then(function (r) {
        if (!r.ok) return openDirect(u);
        return r.blob().then(function (blob) {
          return new Promise(function (resolve) {
            var fr = new FileReader();
            fr.onloadend = function () {
              var dataUrl = typeof fr.result === "string" ? fr.result : "";
              resolve(dataUrl ? (window.open(dataUrl, "_blank", "noopener") && true) : openDirect(u));
            };
            fr.readAsDataURL(blob);
          });
        });
      }).catch(function () { return openDirect(u); });
    }
    if (fetchable) {
      return fetch(u).then(function (r) { return r.ok ? r.text() : null; }).then(function (html) {
        if (html === null) return openDirect(u);
        if (looksLikeUnityUrl(u) || /createUnityInstance|UnityLoader|\.unityweb|StreamingAssets/i.test(String(html))) {
          return openDirect(u);
        }
        var base = String(u).replace(/[^/]*$/, "");
        var withBase = String(html).replace(/<head([^>]*)>/i, "<head$1><base href=\"" + base.replace(/"/g, "&quot;") + "\">");
        return window.open("data:text/html;charset=utf-8," + encodeURIComponent(withBase), "_blank", "noopener") && true;
      }).catch(function () { return openDirect(u); });
    }
    return openDirect(u);
  }

  /* Open a URL in the in-app frame overlay. When a live proxy exists (the
     built-in same-origin /uv/ relay first), the URL is routed through it:
     the frame then only ever talks to this origin, so a school filter has
     nothing to block and X-Frame-Options refusals get stripped by the relay.
     Without a proxy the frame loads the raw URL (the refusal watcher /
     overlay fallback still applies). This is the one launch method that
     keeps everything inside the Chalkle tab - monitors and popup blockers
     (managed Chromebooks) can't kill it, because nothing new ever opens. */
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

  function openIframe(url, title) {
    if (shouldOpenDirect(url)) return openDirect(url);
    return inAppFrame(url, title || url);
  }

  /* Base64url helper - the encoding Ultraviolet / Scramjet / Rammerhead style
     proxies understand: the target URL, base64url-encoded, appended to the
     proxy origin. Verified against a live Ultraviolet-style deployment. */
  function b64url(s) {
    try {
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } catch (e) {
      return encodeURIComponent(s);
    }
  }

  /* Build a routed URL for a target behind a given proxy host. This is the
     "open HTML through the proxy" route: the app runs from the proxy origin,
     so no request touches a blocked domain directly, and the proxy origin
     is what the school filter (hopefully) hasn't caught yet. Local paths
     (e.g. /game-builds/...) stay local - the built-in /uv/ proxy serves
     them from this same server and rewrites any CDN references inside. */
  function routeProxy(target, proxyUrl, hashRoute) {
    target = String(target || "").trim();
    if (!target || !proxyUrl) return target;
    if (/^\s*(data:|blob:|javascript:|file:)/i.test(target)) return target;
    var localPath = target.charAt(0) === "/" && target.charAt(1) !== "/";
    var base = String(proxyUrl).replace(/\/+$/, "");
    if (localPath) {
      /* Local webroot path: goes through the same-origin /uv/ proxy ONLY when
         that proxy actually exists (uaStatus === true - see builtinProxy).
         Hosted proxies can't fetch our local files, and on mirrors/static
         hosts /uv/ doesn't exist at all - so without a live built-in, hand the
         path back unchanged (the same-origin static server or the cloak's
         <base> then serves it directly) instead of building a dead
         origin+/uv/<b64> URL. */
      if (uvStatus === true) {
        return base + "/" + b64url(target);
      }
      return target;
    }
    if (target.indexOf("//") === 0) target = location.protocol + target;
    if (target.indexOf("://") === -1) target = "https://" + target;
    /* SW-based proxies (Scramjet/UV/Nebula) proxy through a service worker on
       their own origin. When the client reads the target from a URL hash
       (#<b64url>) it can boot the SW and route in the correct context. Some
       deployments accept the encoded URL as a path instead. */
    if (hashRoute) return base + "#" + b64url(target);
    return base + "/" + b64url(target);
  }

  /* Proxy route (new tab). Most deployments accept the target URL encoded
     after the host, which routeProxy builds. Falls back to returning false
     if no proxy is configured. Local /game-builds/ paths route through the
     same-origin /uv/ proxy too - the server serves the file and rewrites
     every CDN reference inside it, so even "self-hosted" shells whose
     assets live on a blocked CDN still boot. */
  function openProxy(url, proxyUrl) {
    if (!proxyUrl || isDeadStubProxy(proxyUrl)) return false;
    var win = window.open(routeProxy(url, proxyUrl), "_blank", "noopener");
    return !!win;
  }

  /* First configured proxy with a real URL, or null. Skips the
     "your-proxy-url" placeholder the proxy card ships with. */
  function firstProxy() {
    return liveProxy();
  }

  /* Route a site through the first configured proxy and open it.
     SW-based proxies (Scramjet/UV/Nebula) proxy via a service worker bound to
     the proxy origin - they break if wrapped in an about:blank tab (opaque
     origin). So a live proxy navigates DIRECT to the proxied URL. Without a
     live proxy we fall back to the normal picker on the raw target. */
  function openSiteProxied(target, title) {
    var p = firstProxy();
    if (!p) {
      ChalkleLaunch.open(target || "", title || target || "");
      return (target || "");
    }
    /* Scramjet-style proxies route via a URL hash the client reads; classic
       route proxies take the encoded path. Either way the proxied URL is what
       opens - the tab only ever talks to the proxy origin. Never wrap the
       proxied page in about:blank (an opaque origin can't use the SW). */
    var url = routeProxy(target, p.url, p.mode === "frame" || !!p.hashRoute);
    window.open(url, "_blank", "noopener");
    return url;
  }

  /* Route an app through the first configured proxy and hand it to the normal
     open() flow, so the user gets every launch method on the proxied page:
     in-app iframe, about:blank cloak, blob tab, new tab, or another proxy.
     With no proxy configured we open the plain target so it still has a
     chance. Returns the url actually launched, or "" on failure. */
  function openProxyApp(target, title) {
    var live = liveProxy();
    if (!live) { ChalkleLaunch.open(target || "", title || target || ""); return target || ""; }
    /* A proxied URL is a service-worker / app origin - the tab must only talk
       to the proxy host, never an opaque about:blank wrapper (the SW can't run
       there) and never the target origin. Send the encrypted route directly
       in a new top-level tab. */
    var url = routeProxy(target, live.url, live.mode === "frame" || !!live.hashRoute);
    window.open(url, "_blank", "noopener");
    return url;
  }

  /* ---------- Picker ---------- */

  var pending = null;

  function pickerOpen(url, title) {
    pending = { url: url, title: title };
    var modal = document.getElementById("launch-modal");
    var name = document.getElementById("launch-name");
    var proxySel = document.getElementById("launch-proxy-select");
    if (!modal) return false;
    if (name) name.textContent = title;
    if (proxySel) {
      var proxies = typeof window.ChalkleGetProxies === "function" ? window.ChalkleGetProxies() : (window.ChalkleProxies || window.ChalkProxies || []);
      var withUrl = proxies.filter(function (p) { return p.url && !isDeadStubProxy(p.url); });
      proxySel.innerHTML = withUrl
        .map(function (p) {
          return '<option value="' + p.url.replace(/"/g, "&quot;") + '">' + p.name.replace(/"/g, "&quot;") + "</option>";
        })
        .join("");
      proxySel.hidden = withUrl.length === 0;
      var proxyBtn = document.getElementById("launch-proxy");
      if (proxyBtn) proxyBtn.hidden = withUrl.length === 0;
    }
    modal.hidden = false;
    return true;
  }

  /* Always open the method menu for a URL, regardless of any saved default
     mode or "ask" setting - so even when everything else auto-launches, a
     site can still be opened in about:blank / blob / this-tab / proxy. */
  function openWithOptions(url, title) {
    pickerOpen(url, title);
    return true;
  }

  function pickerClose() {
    var modal = document.getElementById("launch-modal");
    if (modal) modal.hidden = true;
    pending = null;
  }

  function launchWith(method) {
    if (!pending) return;
    var url = pending.url;
    var title = pending.title;
    pickerClose();
    /* Local builds and Unity WebGL used to force a direct top-level tab -
       but direct is exactly what school filters block (the shell is local,
       its assets live on a blocked CDN). Route them through the proxy so
       every request stays on this origin. If the user explicitly asks for
       direct, still honour that. */
    if (shouldOpenDirect(url) && method !== "direct" && method !== "proxy") {
      openProxyApp(url, title);
      return;
    }
    switch (method) {
      case "direct": openDirect(url); break;
      case "dataurl": openDataUrl(url); break;
      case "aboutblank": openAboutBlank(url, true); break;
      case "blob": openBlob(url, true); break;
      case "iframe": openIframe(url, title); break;
      case "proxy": {
        var sel = document.getElementById("launch-proxy-select");
        if (!openProxy(url, sel ? sel.value : "")) {
          alert("No proxy configured. Add one in the Proxies tab first.");
        }
        break;
      }
    }
  }

  /* Turn raw HTML into a URL so it can flow through all five launch methods
     (direct new tab, about:blank cloak, blob tab, in-app frame, proxy). */
  function htmlUrl(html) {
    var src = String(html || "");
    if (!src.trim()) return "";
    try {
      return URL.createObjectURL(new Blob([src], { type: "text/html" }));
    } catch (e) {
      return "data:text/html;charset=utf-8," + encodeURIComponent(src);
    }
  }

  /* Fetch-and-inject: jsDelivr and raw.githubusercontent serve repo HTML as
     text/plain + nosniff (so an <iframe> shows raw text), but both send
     Access-Control-Allow-Origin: *, so we can fetch the HTML ourselves and
     open it as a local blob. A <base> tag is injected so relative asset
     refs (css/js/swf/images) resolve against the same CDN directory, which
     serves them with correct MIME types + CORS. The game then runs entirely
     from the blob URL - no link to the blocked origin, nothing to block. */
  function isFetchableHtml(url) {
    return /^https?:\/\/(?:(?:cdn|fastly)\.jsdelivr\.net\/gh|raw\.githubusercontent\.com)\//i.test(String(url || ""));
  }

  function openFetched(url, title) {
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (html) {
        /* Unity WebGL builds can't run from a blob even with a <base> tag
           (the loader resolves assets against location, not document.baseURI,
           so it throws "StreamingAssets is not a valid URL"). Drop them out
           of the blob path and route them through the /uv/ proxy instead -
           it serves a real origin on this same site and rewrites CDN refs. */
        if (looksLikeUnityUrl(url) || /createUnityInstance|UnityLoader|\.unityweb|StreamingAssets/i.test(String(html))) {
          openProxyApp(url, title || url);
          return;
        }
        var base = String(url).replace(/[^/]*$/, "");
        var withBase = String(html).replace(/<head([^>]*)>/i, "<head$1><base href=\"" + base.replace(/"/g, "&quot;") + "\">");
        var blobUrl = htmlUrl(withBase);
        if (!blobUrl) throw new Error("empty html");
        ChalkleLaunch.open(blobUrl, title || url);
      })
      .catch(function () {
        /* If the fetch is blocked too, fall back to the plain URL so the
           game still has a chance via direct/about:blank navigation. */
        ChalkleLaunch.open(url, title);
      });
  }

  /* Fetch-and-inject ANY https site's HTML through the same-origin /_fetch
     relay (the server fetches server-side, so there is no flaky CORS and no
     DIRECT browser request to the blocked host), then open it as a local blob
     with an injected <base> so relative css/js/assets resolve against the
     source. The tab only ever sits on a blob: URL from our origin - it never
     hard-navigates to the blocked site, so filters never see a top-level
     request to that host. Unity/WASM builds can't run from a blob, so they're
     always opened direct. Resolves true if a blob was opened, false if the
     item should fall back to the normal site path. */
  function openFetchedAny(url, title) {
    var u = String(url || "");
    if (!/^https?:/i.test(u)) return Promise.resolve(false);
    if (shouldOpenDirect(u)) { openProxyApp(u, title || u); return Promise.resolve(true); }
    return fetch("/_fetch?url=" + encodeURIComponent(u))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.ok || !j.body) throw new Error("relay failed " + (j && j.code) + " " + (j && j.error));
        /* A giant self-contained build (e.g. a 70MB Eaglercraft 26.2 HTML with
           the WASM embedded as base64) would blow up memory if we base64-decoded
           it, re-stringify it and opened it as a duplicate blob. Above ~21MB raw,
           prefer a normal open so the tab loads the real file directly instead of
           risking a crash. */
        if (j.body.length > 28 * 1024 * 1024) throw new Error("too-large");
        var raw;
        try { raw = atob(j.body); } catch (e) { throw new Error("base64"); }
        var mime = String(j.mime || "");
        var isHtml = /text\/html/i.test(mime) || /\s*<!?DOCTYPE|\<html|\<head|\<body/i.test(raw.slice(0, 4000));
        if (!isHtml) throw new Error("not-html");
        if (/createUnityInstance|UnityLoader|\.unityweb|StreamingAssets/i.test(raw)) { openProxyApp(u, title || u); return true; }
        /* Scheme-preserving origin for the <base>, so http sites stay http. */
        var m = u.match(/^https?:\/\/([^\/?#]+)/i);
        var origin = m ? u.match(/^(https?:)/i)[1] + "//" + m[1] + "/" : u;
        var withBase = String(raw).replace(/<head([^>]*)>/i, "<head$1><base href=\"" + origin.replace(/"/g, "&quot;") + "\">");
        var blobUrl = htmlUrl(withBase);
        if (!blobUrl) throw new Error("empty");
        ChalkleLaunch.open(blobUrl, title || u);
        return true;
      })
      .catch(function () { return false; });
  }

  /* ---------- Public API ---------- */

  window.ChalkleLaunch = {
    open: function (url, title) {
      /* iOS: self-hosted builds open as a real same-origin tab (never a
         cloak). Their loaders' fetches then work normally. */
      if (isIOS() && isLocalPlayUrl(url)) {
        openDirect(url);
        return;
      }
      /* Local builds and Unity WebGL can't open direct when their CDNs are
         blocked, and wrapping them in about:blank/blob breaks asset loading.
         The /uv/ proxy is this same origin - it serves local files and
         rewrites CDN refs, so route those through it by default. Explicit
         "direct" is still available from the picker. */
      if (shouldOpenDirect(url)) {
        openProxyApp(url, title || url);
        return;
      }
      var mode = "ask";
      try { mode = localStorage.getItem("chalkle-launch-mode") || "ask"; } catch (e) { /* no storage */ }
      var ask = true;
      try { ask = localStorage.getItem("chalkle-ask") !== "0"; } catch (e) { /* no storage */ }

      if (mode !== "ask" && !ask) {
        pending = { url: url, title: title || url };
        launchWith(mode);
        return;
      }
      if (!pickerOpen(url, title)) {
        /* No modal in the page: fall back to direct. */
        openDirect(url);
      }
    },
    launchWith: launchWith,
    openDirect: openDirect,
    openAboutBlank: openAboutBlank,
    openBlob: openBlob,
    openIframe: openIframe,
    openProxy: openProxy,
    openDataUrl: openDataUrl,
    openProxyApp: openProxyApp,
    openSiteProxied: openSiteProxied,
    firstProxy: firstProxy,
    openWithOptions: openWithOptions,
    routeProxy: routeProxy,
    b64url: b64url,
    htmlUrl: htmlUrl,
    openFetched: openFetched,
    openFetchedAny: openFetchedAny,
    isFetchableHtml: isFetchableHtml,
    isLocalPlayUrl: isLocalPlayUrl,
    shouldOpenDirect: shouldOpenDirect,
    close: pickerClose
  };

  /* The most-recently opened URL (set by inAppFrame) - lets the overlay's
     "New tab" button pop the current game out even when it was opened by
     the launcher rather than a proxy card. Initialised AFTER the object so
     the assignment above can never run before it exists. */
  window.ChalkleLaunch.lastOpenUrl = "";

  /* In a cloak-injected page (learn-N.svg on jsDelivr), the app HTML and
     scripts are written into the iframe after the document has already
     finished loading, so DOMContentLoaded never refires and these modal
     handlers would never bind (launcher buttons + close would do nothing).
     If the document is already complete, run them immediately instead. */
  function bindLaunchModal() {
    var modal = document.getElementById("launch-modal");
    if (!modal) return;

    modal.addEventListener("click", function (e) {
      if (e.target === modal) pickerClose();
    });

    var close = document.getElementById("launch-close");
    if (close) close.addEventListener("click", pickerClose);

    var setDefault = document.getElementById("launch-set-default");
    if (setDefault) {
      setDefault.addEventListener("click", function () {
        if (!pending) return;
        var sel = document.getElementById("launch-mode-select");
        var method = sel ? sel.value : "direct";
        try {
          localStorage.setItem("chalkle-launch-mode", method);
          localStorage.setItem("chalkle-ask", "0");
        } catch (e) { /* no storage */ }
        launchWith(method);
      });
    }

    var buttons = modal.querySelectorAll("[data-launch-method]");
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        launchWith(btn.dataset.launchMethod);
      });
    });

    var modeSel = document.getElementById("launch-mode-select");
    if (modeSel) {
      try {
        var saved = localStorage.getItem("chalkle-launch-mode") || "direct";
        modeSel.value = saved;
      } catch (e) { /* no storage */ }
    }
  }    if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindLaunchModal);
  } else {
    bindLaunchModal();
  }
})();
