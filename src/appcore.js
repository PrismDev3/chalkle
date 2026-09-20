/* Chalkle app core: the small shared layer every other module leans on.
   One place for the version string, dev-gated logging, the global error ring
   that feeds Settings diagnostics, URL scheme validation, and the single
   tab-opening path (data:/embed blob handling, popup-blocked fallback,
   opener severing). Loaded before every feature module so all of them can
   use it without ordering games. */
(function () {
  "use strict";

  var VERSION = "1.1";

  /* ---------- logging + error ring ---------- */

  var ERROR_CAP = 10;
  var errors = [];
  var captureInstalled = false;

  function isDev() {
    try {
      return location.protocol === "file:" ||
             location.hostname === "localhost" ||
             location.hostname === "127.0.0.1";
    } catch (e) { return false; }
  }

  /* [Chalkle]-prefixed console logging that stays silent in production.
     Use for boot/service messages a developer would actually want. */
  function log() {
    if (!isDev()) return;
    var args = ["[Chalkle]"].concat(Array.prototype.slice.call(arguments));
    try { console.log.apply(console, args); } catch (e) { /* old engines */ }
  }

  function recordError(kind, message, source) {
    errors.push({
      at: new Date().toISOString(),
      kind: String(kind || "error"),
      message: String(message || "").slice(0, 300),
      source: String(source || "").slice(0, 200)
    });
    if (errors.length > ERROR_CAP) errors.shift();
  }

  /* Captures uncaught errors and rejected promises into the diagnostics ring.
     Never alerts, never spams the console - the browser already logs those;
     we just keep the last few around so Settings can show and copy them. */
  function installErrorCapture() {
    if (captureInstalled) return;
    captureInstalled = true;
    window.addEventListener("error", function (e) {
      var msg = e && (e.message || (e.target && e.target.tagName)) || "unknown";
      var src = e && e.filename ? e.filename.split("/").pop() : "";
      recordError("error", msg, src);
    }, true);
    window.addEventListener("unhandledrejection", function (e) {
      var r = e && e.reason;
      recordError("promise", (r && (r.message || r)) || "unhandled rejection", "");
    });
  }

  /* ---------- URL validation ---------- */

  /* Schemes a launch/open target is allowed to use. javascript:/vbscript:/
     file: and friends never pass, no matter where the string came from. */
  var SAFE_SCHEMES = { "http:": 1, "https:": 1, "blob:": 1, "data:": 1, "about:": 1 };

  function safeUrl(u) {
    var s = String(u || "").trim();
    if (!s) return null;
    /* Local paths and in-page anchors are trusted by construction. */
    if (s.charAt(0) === "/" && s.charAt(1) !== "/") return s;
    if (s.charAt(0) === "#") return s;
    try {
      var p = new URL(s, location.href);
      if (!SAFE_SCHEMES[p.protocol]) return null;
      if ((p.protocol === "http:" || p.protocol === "https:") && !p.host) return null;
      return p.href;
    } catch (e) { return null; }
  }

  /* ---------- opening tabs (the one true path) ---------- */

  /* Data URIs (the single-file build's embedded pages) are blocked from
     top-level navigation by every browser, so they go through fetch -> blob.
     Inside embed wrappers everything non-data gets the same treatment: the
     CDN serves .html as text/plain, so a direct new-tab would show source. */
  function needsBlobWrap(url) {
    if (url.indexOf("data:") === 0) return true;
    if (window.__CHALKLE_EMBED__ && url.indexOf("data:") !== 0) return true;
    return false;
  }

  function rawOpen(u) {
    var win = null;
    try { win = window.open(u, "_blank"); } catch (e) { return null; }
    if (win) { try { win.opener = null; } catch (e) { /* ignore */ } }
    return win;
  }

  /* openTab(url, opts) -> Window|null.
     opts.onBlocked(kind) fires when the popup was blocked or the URL was
     refused, so callers can show their own fallback message. When a blob
     wrap is needed the return value is null and the result arrives through
     onBlocked only. */
  function openTab(url, opts) {
    opts = opts || {};
    var safe = safeUrl(url);
    if (!safe) {
      if (opts.onBlocked) opts.onBlocked("bad-url");
      return null;
    }
    if (needsBlobWrap(safe)) {
      fetch(safe).then(function (r) { return r.blob(); }).then(function (b) {
        var u = URL.createObjectURL(b);
        var win = rawOpen(u);
        if (win) {
          setTimeout(function () { try { URL.revokeObjectURL(u); } catch (e) { /* gone */ } }, 180000);
        } else if (opts.onBlocked) {
          opts.onBlocked("popup");
        }
      }).catch(function () {
        var win = rawOpen(safe);
        if (!win && opts.onBlocked) opts.onBlocked("popup");
      });
      return null;
    }
    var win = rawOpen(safe);
    if (!win && opts.onBlocked) opts.onBlocked("popup");
    return win;
  }

  /* ---------- diagnostics ---------- */

  function storageStat() {
    try {
      var keys = 0, bytes = 0;
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf("chalkle") === 0) {
          keys++;
          try { bytes += (k.length + (localStorage.getItem(k) || "").length) * 2; } catch (e) { /* gone */ }
        }
      }
      return { available: true, keys: keys, kb: (bytes / 1024).toFixed(1) };
    } catch (e) {
      return { available: false, keys: 0, kb: "0" };
    }
  }

  function diagnosticsText() {
    var st = storageStat();
    var route = "";
    try { route = location.hash || "home"; } catch (e) { /* ignore */ }
    var lines = [
      "Chalkle v" + VERSION,
      "route: " + route,
      "online: " + (navigator.onLine ? "yes" : "no"),
      "platform: " + (navigator.platform || "unknown"),
      "user agent: " + (navigator.userAgent || ""),
      "storage: " + (st.available ? st.keys + " keys, " + st.kb + " KB" : "unavailable"),
      "clock: " + new Date().toISOString(),
      "errors: " + (errors.length ? "" : "none")
    ];
    for (var i = 0; i < errors.length; i++) {
      var e = errors[i];
      lines.push("  " + e.at + " " + e.kind + ": " + e.message + (e.source ? " (" + e.source + ")" : ""));
    }
    return lines.join("\n");
  }

  function copyDiagnostics(done) {
    var txt = diagnosticsText();
    function fail() { if (done) done(false); }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { if (done) done(true); }, fail);
        return;
      }
    } catch (e) { /* fall through to the textarea path */ }
    try {
      var ta = document.createElement("textarea");
      ta.value = txt;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      ta.remove();
      if (done) done(!!ok);
    } catch (e) { fail(); }
  }

  /* ---------- offline shell (service worker) ---------- */

  /* Registers sw.js: the cached app shell, the versioned scripts, and the
     chunked game parts. Deliberately limited to a real top-level https page,
     so the single-file build (data/blob URLs), CDN iframes and embed
     wrappers keep running exactly as they do now. Registration failure is
     never fatal: without a worker the site behaves as it always has. */
  var swReg = null;

  function swSupported() {
    if (!("serviceWorker" in navigator)) return false;
    try {
      if (window.top !== window.self) return false;      /* embedded page */
      /* The single-file build inlines every script (the build marks them with
         data-inline). Caching its own shell would mean keeping a 150 MB HTML
         file on disk, so that build opts out and behaves exactly as before. */
      if (document.querySelector("script[data-inline]")) return false;
      if (location.protocol === "https:") return true;
      return location.protocol === "http:" && isDev();
    } catch (e) { return false; }
  }

  /* The build this tab is actually running: the ?v= on its own app.js tag.
     Versioned URLs are served from the worker cache after the first visit, so
     a token that was not bumped keeps serving old code to every returning
     visitor - comparing this token with the one the server is offering is the
     cheapest honest staleness check there is. */
  var _buildTag = null;

  /* Read lazily and once: this file runs before the app.js tag has necessarily
     been parsed, so the scan happens on the first real use (after load) rather
     than at parse time. */
  function buildTag() {
    if (_buildTag !== null) return _buildTag;
    _buildTag = "";
    try {
      var tags = document.querySelectorAll('script[src*="src/app.js"]');
      for (var i = 0; i < tags.length; i++) {
        var m = String(tags[i].getAttribute("src") || "").match(/[?&]v=([^&"']+)/);
        if (m) { _buildTag = m[1]; break; }
      }
    } catch (e) { /* no DOM to read: the check simply stays off */ }
    return _buildTag;
  }

  var updateToken = "";
  var updateCheckAt = 0;
  var UPDATE_GAP_MS = 300000;  /* asking more often than every five minutes is noise */

  function readServerBuild() {
    return fetch("index.html", { cache: "no-store", credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.text() : ""; })
      .then(function (html) {
        var m = /src\/app\.js\?v=([^"'&\s]+)/.exec(html || "");
        return m ? m[1] : "";
      })
      .catch(function () { return ""; });
  }

  function noteUpdate(token) {
    var mine = buildTag();
    if (!token || token === mine) return false;
    var first = updateToken !== token;
    updateToken = token;
    if (first) log("update available", mine, "->", token);
    /* Dispatched on every check, not just the first: a listener that loads
       after the reading (app.js runs last) still has to hear about it. */
    try {
      document.dispatchEvent(new CustomEvent("chalkle:update-ready", {
        detail: { current: mine, build: token }
      }));
    } catch (e) { /* older engine: a plain reload still gets the new build */ }
    return true;
  }

  /* Resolves with the new build token when the server has moved on, null when
     this tab is current. checkForUpdate(true) ignores the throttle. The worker
     is nudged first because a worker that already fetched the new shell is the
     stronger signal; the network read is the fallback for sites without one. */
  function checkForUpdate(force) {
    if (!buildTag()) return Promise.resolve(null);
    var now = Date.now();
    if (!force && now - updateCheckAt < UPDATE_GAP_MS) return Promise.resolve(updateToken || null);
    updateCheckAt = now;
    try { if (swReg && swReg.update) swReg.update().catch(function () {}); } catch (e) { /* ignore */ }
    return readServerBuild().then(function (token) {
      if (!token || token === buildTag()) return null;
      noteUpdate(token);
      return token;
    });
  }

  /* Apply it: hand over to an installed worker first, then reload. The timer is
     the safety net for the normal case where the new build is already the
     active worker and no controllerchange ever fires. */
  function applyUpdate() {
    var reloaded = false;
    function reload() {
      if (reloaded) return;
      reloaded = true;
      try { location.reload(); } catch (e) { /* nothing else left to try */ }
    }
    try {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener("controllerchange", reload);
        if (swReg && swReg.waiting) swReg.waiting.postMessage({ type: "skipWaiting" });
      }
    } catch (e) { /* reload anyway */ }
    setTimeout(reload, 1200);
  }

  function registerServiceWorker() {
    if (!swSupported()) { checkForUpdate(true); return null; }
    try {
      /* updateViaCache: "none" keeps the HTTP cache out of the worker's own
         update path, so sw.js is compared with the server instead of a cached
         copy of itself. */
      navigator.serviceWorker.register("./sw.js", { scope: "./", updateViaCache: "none" }).then(function (reg) {
        swReg = reg;
        log("service worker registered", reg.scope);
        try { if (reg.update) reg.update().catch(function () {}); } catch (e) { /* ignore */ }
        checkForUpdate(true);
      }).catch(function (e) {
        log("service worker registration failed", e && e.message);
        checkForUpdate(true);
      });
    } catch (e) { /* blocked by policy */ }
    return swReg;
  }

  /* Asks the worker for its version and cache footprint. Resolves with null
     when there is no active worker, so Settings can simply hide the row. */
  function swStats(timeoutMs) {
    if (!swSupported() || !navigator.serviceWorker.controller) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var channel = null;
      try { channel = new MessageChannel(); } catch (e) { resolve(null); return; }
      var settled = false;
      function done(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }
      var timer = setTimeout(function () { done(null); }, timeoutMs || 1500);
      channel.port1.onmessage = function (event) {
        clearTimeout(timer);
        done(event.data || null);
      };
      try {
        navigator.serviceWorker.controller.postMessage({ type: "stats" }, [channel.port2]);
      } catch (e) {
        clearTimeout(timer);
        done(null);
      }
    });
  }

  /* Drops the cached shell and assets, then reloads so the next visit
     rebuilds them. Used by the Settings reset path. */
  function clearOfflineCache(done) {
    if (!swSupported() || !navigator.serviceWorker.controller) {
      if (done) done(false);
      return;
    }
    var channel = null;
    try { channel = new MessageChannel(); } catch (e) { if (done) done(false); return; }
    channel.port1.onmessage = function () { if (done) done(true); };
    try {
      navigator.serviceWorker.controller.postMessage({ type: "clear" }, [channel.port2]);
    } catch (e) { if (done) done(false); }
  }

  /* ---------- service health (on demand, never a background poller) ---------- */

  /* Probes the relay's aggregate /_health once and maps it to the diagnostics
     rows. Called from Settings when the user asks for it, so idle Chalkle
     tabs fire zero health requests. */
  function checkServices(done) {
    var root = "";
    try {
      if (window.ChalkleApi && window.ChalkleApi.url) root = window.ChalkleApi.url("");
    } catch (e) { root = ""; }
    var url = (root || "") + "/_health";
    var ctrl = null;
    try { ctrl = new AbortController(); } catch (e) { /* old engines */ }
    var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, 5000);
    var opts = { cache: "no-store" };
    if (ctrl) opts.signal = ctrl.signal;
    fetch(url, opts)
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) { done([{ name: "Chalkle relay", state: "OFFLINE" }]); return; }
        return r.json().catch(function () { return null; }).then(function (j) {
          var rows = [{ name: "Chalkle relay", state: j && j.ok ? "ONLINE" : "DEGRADED" }];
          var sv = (j && j.services) || {};
          rows.push({ name: "Cloud backend", state: sv.cloud ? "ONLINE" : "OFFLINE" });
          rows.push({ name: "VM (Firefox wasm)", state: sv.vm ? "ONLINE" : "OFFLINE" });
          rows.push({ name: "Chat uploads", state: sv.chatUpload ? "ONLINE" : "OFFLINE" });
          rows.push({ name: "Local storage", state: storageStat().available ? "ONLINE" : "OFFLINE" });
          swStats().then(function (sw) {
            if (sw) rows.push({ name: "Offline cache", state: sw.entries + " file" + (sw.entries === 1 ? "" : "s") + " ready" });
            done(rows);
          });
        });
      })
      .catch(function () {
        clearTimeout(timer);
        done([
          { name: "Chalkle relay", state: "OFFLINE" },
          { name: "Local storage", state: storageStat().available ? "ONLINE" : "OFFLINE" }
        ]);
      });
  }

  window.ChalkleCore = {
    version: VERSION,
    checkForUpdate: checkForUpdate,
    applyUpdate: applyUpdate,
    pendingUpdate: function () { return updateToken || ""; },
    isDev: isDev,
    log: log,
    recordError: recordError,
    installErrorCapture: installErrorCapture,
    safeUrl: safeUrl,
    openTab: openTab,
    registerServiceWorker: registerServiceWorker,
    swStats: swStats,
    clearOfflineCache: clearOfflineCache,
    swSupported: swSupported,
    storageStat: storageStat,
    diagnosticsText: diagnosticsText,
    copyDiagnostics: copyDiagnostics,
    checkServices: checkServices,
    errors: function () { return errors.slice(); }
  };

  /* build is a getter rather than a copied string: this file runs in <head>,
     before the app.js tag exists, so any value snapshotted here would be empty
     until the load event. Reading through buildTag() is correct at any moment. */
  try {
    Object.defineProperty(window.ChalkleCore, "build", { get: buildTag, enumerable: true });
  } catch (e) {
    window.ChalkleCore.build = buildTag();
  }

  /* Coming back to a tab is exactly when a stale one gets used, so that is
     when it is worth asking again - throttled, and never while hidden. */
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) checkForUpdate();
  });

  /* Registration runs after load: the worker install fetches the shell, and
     doing that during boot would compete with the scripts that draw the page.
     The build stamp is read here for the same reason - only now is the app.js
     tag certain to exist. */
  function boot() {
    registerServiceWorker();
  }
  if (document.readyState === "complete") boot();
  else window.addEventListener("load", boot);
})();
