/* Chalkle Browser - the in-app browsing surface.
   Full browser chrome (tabs, toolbar, address bar, new-tab page, loading,
   error state, fullscreen) hosted inside #proxy-overlay. Games, proxy cards
   and popup-blocked launches land here through ChalkleLaunch (which resolves
   single-file embeds and proxy routing first) or directly via
   ChalkleBrowser.open(url, title, opts). */

(function () {
  "use strict";

  var overlay = document.getElementById("proxy-overlay");
  if (!overlay) return;

  var $ = function (id) { return document.getElementById(id); };
  var tabsEl = $("bz-tabs"), viewport = $("bz-viewport");
  var addr = $("bz-addr"), addrIco = $("bz-addr-ico"), goBtn = $("bz-go");
  var suggestEl = $("bz-suggest");
  var ntPage = $("bz-newtab-page");
  var backBtn = $("bz-back"), fwdBtn = $("bz-fwd"), reloadBtn = $("bz-reload");
  var extBtn = $("bz-ext"), homeBtn = $("bz-home"), fsBtn = $("bz-fs"), closeBtn = $("bz-close");
  var progressBar = $("bz-progress-bar");
  var blocked = $("bz-blocked"), blockedMsg = $("bz-blocked-msg");
  var blockedTitle = $("bz-blocked-title"), blockedHint = $("bz-blocked-hint");
  var blockedDetail = $("bz-blocked-detail"), blockedAnyway = $("bz-blocked-anyway");
  var blockedBack = $("bz-blocked-back"), blockedReload = $("bz-blocked-reload"), blockedExt = $("bz-blocked-ext");
  var notice = $("bz-notice"), noticeMsg = $("bz-notice-msg"), noticeExt = $("bz-notice-ext"), noticeX = $("bz-notice-x");
  var exitFsBtn = $("bz-exitfs");
  var ntLinksEl = $("bz-nt-links");
  var bkStar = $("bz-star"), bkWrap = $("bz-nt-bookmarks"), bkRow = $("bz-nt-bk-row");
  var ntLogo = overlay.querySelector(".browser-nt-logo");

  var LOGO_COLORS = ["#4285f4", "#ea4335", "#fbbc05", "#4285f4", "#34a853", "#ea4335", "#4285f4"];
  var LOGO_SHADOWS = ["#1557b0", "#b31412", "#e37400", "#1557b0", "#0d7734", "#b31412", "#1557b0"];

  /* ---------- Wordmark (same bubble letters as the app) ---------- */
  function paintLogo() {
    if (!ntLogo) return;
    ntLogo.innerHTML = "chalkle".split("").map(function (ch, i) {
      return '<span class="bubble-letter" style="color:' + LOGO_COLORS[i] + ";text-shadow:0 3px 0 " + LOGO_SHADOWS[i] + ';">' + ch + "</span>";
    }).join("");
  }

  /* ---------- Small helpers ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return String(u || ""); }
  }
  function cleanUrl(u) { return String(u || "").replace(/^https?:\/\//, "").replace(/\/$/, ""); }
  function letterOf(u) {
    var h = hostOf(u);
    return (h.charAt(0) || "?").toUpperCase();
  }
  var FAV_COLORS = ["#ea4335", "#f5b301", "#4cc56f", "#5b93ff", "#a06bff", "#23b8a5", "#e6438f", "#ff9d3c"];
  function favColor(u) {
    var h = hostOf(u);
    var n = 0;
    for (var i = 0; i < h.length; i++) n = (n * 31 + h.charCodeAt(i)) % 997;
    return FAV_COLORS[n % FAV_COLORS.length];
  }
  function looksUrl(t) {
    if (/^(https?:|ftp:)\/\//i.test(t)) return true;
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:[0-9]+)?(\/.*)?$/i.test(t) && t.indexOf(" ") === -1) return true;
    if (/^localhost(:\d+)?(\/.*)?$/i.test(t)) return true;
    return false;
  }
  function resolveInput(input) {
    var t = String(input || "").trim();
    if (!t) return null;
    /* ChalkleSearch owns the address-vs-search decision and the saved engine,
       so the address bar and the Home box stay in agreement. The inline
       fallback below keeps the browser usable if that module is absent. */
    if (window.ChalkleSearch && window.ChalkleSearch.target) {
      var r = window.ChalkleSearch.target(t);
      if (r && r.url) return r.url;
    }
    if (/^(https?:|ftp:)\/\//i.test(t)) return t;
    if (t.indexOf("://") !== -1) return t;
    if (looksUrl(t)) return "https://" + t;
    // DuckDuckGo Lite: tiny HTML results page that renders cleanly inside
    // the proxied iframe. Google's full results page is heavy and partially
    // broken when rewritten by /uv (scripts get opaque-response-blocked),
    // which is why plain Google search used to look dead in the browser.
    return "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(t);
  }
  function looksFrameBlocked(url) {
    try {
      var h = new URL(url).hostname.toLowerCase();
      return h.indexOf("minecraft") !== -1 || h.indexOf("eagler") !== -1;
    } catch (e) { return false; }
  }

  /* ---------- Routing ---------- */
  /* Ask the launcher for a route: it resolves single-file embeds, local-only
     builds and proxy routing in one place, and hands back the node it used.
     The browser needs that node - when a routed page fails, the failure is
     evidence about one node, and the retry has to skip it. */
  function routeForTarget(target, skip) {
    var t = String(target || "");
    if (/^(blob:|data:|about:|javascript:|file:)/i.test(t)) return { url: t, node: null };
    var L = window.ChalkleLaunch;
    if (!L || typeof L.routeFor !== "function") return { url: t, node: null };
    try {
      var r = L.routeFor(t, skip || []);
      return (r && r.url) ? { url: r.url, node: r.node || null } : { url: t, node: null };
    } catch (e) {
      return { url: t, node: null };
    }
  }

  /* Raw handoffs arrive already routed, with no node attached (the launcher
     resolved them before the overlay opened). Read the node back out of the
     route so a failure can still be attributed: /res/ on this origin is the
     relay, and anything under a listed node's host is that node. */
  function nodeFromRoute(url) {
    var u = String(url || "");
    if (!u || !/^https?:/i.test(u)) return null;
    try {
      var parsed = new URL(u, location.href);
      if (parsed.origin === location.origin && /^\/res\//i.test(parsed.pathname)) {
        return (typeof window.ChalkProxyBackendFind === "function")
          ? window.ChalkProxyBackendFind("relay") : null;
      }
      var all = (typeof window.ChalkProxyBackendList === "function")
        ? (window.ChalkProxyBackendList() || []) : [];
      for (var i = 0; i < all.length; i++) {
        var b = all[i];
        if (!b || !b.url) continue;
        try {
          var bu = new URL(b.url, location.href);
          if (bu.origin === parsed.origin && parsed.pathname.indexOf(bu.pathname) === 0) return b;
        } catch (e) { /* keep looking */ }
      }
    } catch (e) { /* not a URL: nothing to attribute */ }
    return null;
  }

  /* ---------- Failure recovery ----------
     A failed load is a fact about the route, not a verdict on the page. Nodes
     die on one network and work on the next, a relay can 502 on a cold start,
     a filter answers a dead tunnel with its own block page. So a failure is
     treated as a routing problem first: report it into the shared health
     store (proxies.js owns the reading the Proxies tab shows), retry the same
     route once - a cold tunnel usually answers the second time - then walk to
     a different route, and only then show the error panel. The panel always
     says which route failed and offers Show page anyway, because a page that
     never "finished" often rendered fine. */
  var FAIL_TEXT = {
    offline: {
      title: "You are offline",
      msg: "This device has no network connection right now, so nothing can load.",
      hint: "Reconnect, then hit Retry."
    },
    proxy: {
      title: "That route never answered",
      msg: "Nothing came back from the route Chalkle opened for {host}.",
      hint: "Retry in a moment, or open it in a new tab."
    },
    notfound: {
      title: "The site said no",
      msg: "{host} answered, but with a {code} error page instead of the page you wanted.",
      hint: "Check the address - this one probably has a typo or the page moved."
    },
    timeout: {
      title: "Taking longer than usual",
      msg: "{host} started loading but never finished.",
      hint: "Show what already rendered, or retry."
    },
    unreachable: {
      title: "Page unavailable",
      msg: "Chalkle could not reach {host} from here - it may be down, or blocked on this network.",
      hint: "Retry, or open it in a new tab where a different route applies."
    }
  };

  /* A routed load (there is a node behind the URL) versus a direct one: only
     the routed case is worth blaming on a route. */
  function isRouted(s) {
    return !!(s && s.node && s.node.id);
  }

  /* Chrome's error page for a host that never answered is readable and has no
     title, unlike any real page. Without this check a frame that "loaded" an
     error page counts as a success - which is how a dead host used to leave
     nothing but an empty panel behind. */
  function looksNetworkError(title, bodyText) {
    if (title) return false;
    var t = String(bodyText || "");
    return /ERR_[A-Z_]+/.test(t)
      || /can(?:not|'|\u2019)?t be reached/i.test(t)
      || /refused to connect/i.test(t)
      || /isn(?:'|\u2019)?t working/i.test(t)
      || /took too long to respond/i.test(t)
      || /dns_probe|no internet/i.test(t);
  }

  function reportRoute(s, ok) {
    if (!s || !s.node || !s.node.id) return;
    if (typeof window.ChalkProxyReport !== "function") return;
    try { window.ChalkProxyReport(s.node.id, !!ok); } catch (e) { /* health is best effort */ }
  }

  function routeLabel(s) {
    if (s && s.node && s.node.name) return s.node.name;
    if (s && s.node) return "proxy node";
    return "direct";
  }

  /* One failed attempt. The ladder is: same route once more, then the next
     route, then the panel - and a 4xx is not a failure at all, it is the site
     answering, so it goes straight to the panel without touching health. */
  function failReason(s, reason, code) {
    if (!s || s.failed) return;
    var why = (!navigator.onLine) ? "offline" : (reason || "unreachable");
    s.loading = false;
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    if (progressBar) {
      progressBar.style.width = "100%";
      setTimeout(function () { progressBar.style.opacity = "0"; }, 250);
    }
    renderTabs();
    /* Only a repeated failure is a health verdict: one timeout is weather,
       and a single 502 on a cold relay is not a dead relay. */
    if (why === "proxy" && s.attempts >= 2) reportRoute(s, false);
    if (why === "proxy" && s.attempts < 2) {
      s.attempts++;
      startLoading(s);
      if (s.frame) s.frame.src = s.route;
      return;
    }
    /* Another ROUTE is worth trying; another route is not "load it direct".
       A proxied failure that silently falls back to the raw URL would leak
       the request to the filter and usually just fail there too - the panel
       says so instead, and the health verdict on the failed route makes the
       NEXT navigation pick a different one on its own. */
    if ((why === "proxy" || why === "unreachable") && s.attempts < 4) {
      var next = routeForTarget(s.target, s.tried);
      var canSwitch = !!(next.node && next.node.id && s.node && next.node.id !== s.node.id);
      if (canSwitch) {
        if (s.node && s.node.id) s.tried.push(s.node.id);
        s.node = next.node;
        s.route = next.url;
        s.attempts++;
        s.reason = "";
        if (window.ChalkleToast && window.ChalkleToast.show) {
          window.ChalkleToast.show("That route did not answer - retrying through " + (next.node.name || "another node"));
        }
        startLoading(s);
        if (s.frame) s.frame.src = s.route;
        return;
      }
    }
    s.failed = true;
    s.reason = why;
    s.code = code || "";
    syncView();
  }

  /* Retry re-routes rather than replaying the dead URL: a route that just
     failed was demoted in the health store, so this attempt lands on a live
     one (or on the relay once it answers again) without the user having to
     know any of that. */
  function retry() {
    var s = active();
    if (!s || !s.url) return;
    var route = routeForTarget(s.target || s.url, []);
    s.failed = false;
    s.reason = "";
    s.route = route.url;
    s.node = route.node;
    s.tried = (route.node && route.node.id) ? [route.node.id] : [];
    s.attempts = Math.max(s.attempts + 1, 2);
    ensureFrame(s);
    startLoading(s);
    s.frame.src = s.route;
    syncView();
  }

  /* Keep what already rendered: a page that is slow is not a page that
     failed, and hiding it behind an error card is the worst option. */
  function showAnyway() {
    var s = active();
    if (!s) return;
    s.failed = false;
    s.reason = "";
    if (progressBar) progressBar.style.opacity = "0";
    syncView();
  }

  /* ---------- Sessions ---------- */
  var sessions = [];
  var activeId = null;
  var nextId = 1;
  var loadTimer = null;
  var MAX_TABS = 8;
  /* A load that has not finished in 11s is reported as slow, not as failed:
     heavy WebGL builds and cold tunnels routinely take longer. */
  var SLOW_MS = 11000;

  function active() {
    for (var i = 0; i < sessions.length; i++) if (sessions[i].id === activeId) return sessions[i];
    return null;
  }
  function canBack() { var s = active(); return !!(s && s.hi > 0); }
  function canFwd() { var s = active(); return !!(s && s.hi < s.hist.length - 1); }

  function renderTabs() {
    var html = "";
    sessions.forEach(function (s) {
      html += '<div class="browser-tab' + (s.id === activeId ? " is-active" : "") + (s.loading ? " is-loading" : "") +
        '" role="tab" tabindex="0" data-bz-tab="' + s.id + '">' +
        '<span class="browser-tab-fav" style="background:' + s.color + '">' + esc(s.letter) + "</span>" +
        '<span class="browser-tab-title">' + esc(s.title || "New tab") + "</span>" +
        '<button class="browser-tab-x" data-bz-close="' + s.id + '" type="button" aria-label="Close tab" title="Close (Ctrl+W)">' +
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>';
    });
    tabsEl.innerHTML = html;
    backBtn.disabled = !canBack();
    fwdBtn.disabled = !canFwd();
  }

  function showNt() { if (ntPage) ntPage.hidden = false; }
  function hideNt() { if (ntPage) ntPage.hidden = true; }
  /* The error card says WHAT failed, over WHICH route, and what to try next -
     a bare "page unavailable" leaves the user guessing whether the site is
     down, the proxy is dead, or the address is wrong. */
  function showBlocked(s) {
    if (!blocked) return;
    var t = FAIL_TEXT[(s && s.reason) || "unreachable"] || FAIL_TEXT.unreachable;
    var host = (s && s.url) ? hostOf(s.url) : "that site";
    var msg = String(t.msg).replace(/\{host\}/g, host).replace(/\{code\}/g, (s && s.code) || "404");
    blocked.hidden = false;
    if (blockedTitle) blockedTitle.textContent = t.title;
    if (blockedMsg) blockedMsg.textContent = msg;
    if (blockedHint) blockedHint.textContent = t.hint;
    if (blockedDetail) {
      var tries = Math.max(1, (s && s.attempts) || 1);
      blockedDetail.textContent = "route: " + routeLabel(s) + " \u00b7 " + tries + (tries === 1 ? " attempt" : " attempts");
    }
    /* A timeout is the one failure where the frame can hold a usable page. */
    if (blockedAnyway) blockedAnyway.hidden = !(s && s.reason === "timeout");
    if (blockedReload) blockedReload.textContent = "Retry";
  }
  function hideBlocked() { if (blocked) blocked.hidden = true; }

  function showNotice(on, msg) {
    if (!notice) return;
    notice.hidden = !on;
    if (on && msg) noticeMsg.textContent = msg;
  }

  function syncView() {
    var s = active();
    sessions.forEach(function (x) {
      if (x.frame) x.frame.style.display = x.id === activeId ? "block" : "none";
    });
    var onNt = !s || !s.url;
    if (onNt) showNt(); else hideNt();
    if (s && s.failed) showBlocked(s); else hideBlocked();
    if (s && s.blockedHost) showNotice(true, s.blockedHost + " may block embedded play."); else showNotice(false);
    renderTabs();
    if (suggestEl && !suggestEl.hidden) suggestEl.hidden = true;
    var cur = s && s.url ? cleanUrl(s.url) : "";
    if (document.activeElement !== addr) {
      addr.value = cur;
      if (addrIco) addrIco.classList.toggle("is-editing", false);
    }
    if (s && s.el && s.el.scrollIntoView) s.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    syncBk();
  }

  /* ---------- Bookmarks ---------- */
  var BK_KEY = "chalkle-browser-bookmarks";
  var MAX_BK = 24;
  function loadBookmarks() {
    try {
      var v = JSON.parse(localStorage.getItem(BK_KEY) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function saveBookmarks(list) {
    try { localStorage.setItem(BK_KEY, JSON.stringify(list)); } catch (e) { /* storage full - ignore */ }
  }
  function bkKeyOf(u) {
    try {
      var p = new URL(u);
      return p.hostname.replace(/^www\./, "") + p.pathname.replace(/\/$/, "");
    } catch (e) { return String(u || "").trim().toLowerCase(); }
  }
  function toggleBookmark() {
    var s = active();
    if (!s || !s.url) return;
    var list = loadBookmarks(), k = bkKeyOf(s.url), i = -1;
    for (var n = 0; n < list.length; n++) if (bkKeyOf(list[n].url) === k) { i = n; break; }
    if (i !== -1) {
      list.splice(i, 1);
      saveBookmarks(list);
      if (window.ChalkleToast && window.ChalkleToast.show) window.ChalkleToast.show("Bookmark removed");
    } else {
      if (list.length >= MAX_BK) {
        if (window.ChalkleToast && window.ChalkleToast.show) window.ChalkleToast.show("Bookmark limit reached - remove one first");
        return;
      }
      list.unshift({ url: s.url, title: s.title || hostOf(s.url), addedAt: Date.now() });
      saveBookmarks(list);
      if (window.ChalkleToast && window.ChalkleToast.show) window.ChalkleToast.show("Bookmarked " + hostOf(s.url));
    }
    syncBk();
  }
  function syncBk() {
    var s = active();
    var on = !!(s && s.url && isBookmarked(s.url));
    if (bkStar) {
      bkStar.disabled = !s || !s.url;
      bkStar.classList.toggle("is-on", on);
      bkStar.setAttribute("aria-pressed", on ? "true" : "false");
    }
    var list = loadBookmarks();
    if (!bkWrap || !bkRow) return;
    bkWrap.hidden = list.length === 0;
    bkRow.innerHTML = list.map(function (b, i) {
      return '<div class="browser-nt-bk">' +
        '<button class="browser-nt-bk-go" type="button" data-bz-bk="' + i + '" title="' + esc(b.title || b.url) + '">' +
        '<span class="browser-nt-bk-fav" style="background:' + favColor(b.url) + '">' + esc(letterOf(b.url)) + "</span>" +
        '<span class="browser-nt-bk-name">' + esc(b.title || hostOf(b.url)) + "</span></button>" +
        '<button class="browser-nt-bk-x" type="button" data-bz-bkdel="' + i + '" aria-label="Remove bookmark" title="Remove bookmark">' +
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>';
    }).join("");
  }
  function isBookmarked(u) {
    var k = bkKeyOf(u);
    return loadBookmarks().some(function (b) { return bkKeyOf(b.url) === k; });
  }

  function setActive(id) {
    if (id === activeId) return;
    activeId = id;
    syncView();
  }

  function newTab() {
    if (sessions.length >= MAX_TABS) {
      if (window.ChalkleToast && window.ChalkleToast.show) window.ChalkleToast.show("Tab limit reached - close one first");
      return null;
    }
    var s = {
      id: nextId++, title: "New tab", url: "", letter: "?", color: "#3e3930",
      hist: [], hi: -1, frame: null, el: null,
      loading: false, failed: false, blockedHost: "",
      /* Recovery state: the address the user asked for, the URL actually
         loaded, the node that served it, and the nodes already tried. */
      target: "", route: "", node: null, attempts: 0, tried: [], reason: "", code: ""
    };
    sessions.push(s);
    activeId = s.id;
    syncView();
    return s;
  }

  function closeTab(id) {
    var i = -1;
    for (var k = 0; k < sessions.length; k++) if (sessions[k].id === id) { i = k; break; }
    if (i === -1) return;
    var s = sessions[i];
    if (s.frame && s.frame.parentNode) s.frame.parentNode.removeChild(s.frame);
    sessions.splice(i, 1);
    if (!sessions.length) { newTab(); return; }
    if (activeId === id) activeId = sessions[Math.min(i, sessions.length - 1)].id;
    syncView();
  }

  function ensureFrame(s) {
    if (!s.frame) {
      var f = document.createElement("iframe");
      f.className = "browser-frame";
      f.title = "Browser tab";
      f.setAttribute("allow", (window.ChalkleApi && ChalkleApi.iframeAllow) ? ChalkleApi.iframeAllow() : "fullscreen; picture-in-picture");
      f.setAttribute("allowfullscreen", "");
      f.referrerPolicy = "no-referrer";
      f.addEventListener("load", function () { onFrameLoad(s); });
      viewport.appendChild(f);
      s.frame = f;
    }
    return s.frame;
  }

  function startLoading(s) {
    s.loading = true;
    s.failed = false;
    s.blockedHost = looksFrameBlocked(s.url) ? hostOf(s.url) : "";
    /* No network at all: say so now instead of waiting 11s for a timeout that
       was never going to have a different answer. */
    if (!navigator.onLine && /^https?:/i.test(String(s.route || s.url || ""))) {
      failReason(s, "offline");
      return;
    }
    showNotice(!!s.blockedHost, s.blockedHost ? s.blockedHost + " may block embedded play." : "");
    hideBlocked();
    if (progressBar) {
      progressBar.style.width = "0";
      progressBar.style.opacity = "1";
      requestAnimationFrame(function () { progressBar.style.width = "72%"; });
    }
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(function () {
      if (!s.loading) return;
      /* Still loading after SLOW_MS is a timeout, not a verdict - and the
         panel that follows keeps a Show page anyway escape hatch. */
      failReason(s, "timeout");
    }, SLOW_MS);
    renderTabs();
  }

  function finishLoading(s) {
    if (!s.loading && !s.failed) return;
    s.loading = false;
    /* The page arrived after the error card went up: the card was wrong, so
       take it down instead of leaving a working page hidden behind it. */
    if (s.failed) { s.failed = false; s.reason = ""; }
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    if (progressBar) {
      progressBar.style.width = "100%";
      setTimeout(function () { progressBar.style.opacity = "0"; }, 250);
    }
    /* Detect silently-blocked frames: an accessible, empty document after a
       real navigation usually means the site refused to render in-frame. */
    try {
      var doc = s.frame && s.frame.contentDocument;
      if (doc && (!doc.body || !doc.body.childNodes.length) && s.url && s.url.indexOf("about:blank") === -1) {
        if (!s.blockedHost) s.blockedHost = hostOf(s.url);
        if (s.blockedHost) showNotice(true, s.blockedHost + " may block embedded play.");
      }
    } catch (e) { /* cross-origin - loaded fine */ }
    renderTabs();
  }

  function onFrameLoad(s) {
    var title = "", bodyText = "", docRead = false;
    try {
      var doc = s.frame && s.frame.contentDocument;
      if (doc) {
        docRead = true;
        title = String(doc.title || "");
        bodyText = String((doc.body && doc.body.textContent) || "").slice(0, 600);
      }
    } catch (e) { /* cross-origin: it really loaded */ }
    /* Our own relay serves same-origin documents, so a route that "loaded"
       with no readable document never actually answered - that is the relay
       (or the server) being down, not the site. Any other unreadable frame is
       an ordinary cross-origin page. */
    if (s.node && s.node.builtin && !docRead) {
      failReason(s, "proxy");
      return;
    }
    /* "load" is not proof of success - the relay's own error page is a
       perfectly valid document, so read it before declaring anything. */
    if (title === "Proxy error" || /proxy couldn't load/i.test(bodyText)) {
      var m = bodyText.match(/HTTP\s*(\d{3})/i);
      var code = m ? m[1] : "";
      /* The relay answered, so the relay itself is fine: what it could not do
         is reach the target. A 4xx means the site answered too (the page is
         just not there); anything else means the site was unreachable from
         here. Retrying does not change either, so no ladder and no health
         verdict - the panel says which it was. */
      failReason(s, (/^4/.test(code)) ? "notfound" : "unreachable", code);
      return;
    }
    /* A Chrome error page is the opposite case: the ROUTE never answered at
       all. That is the failure worth retrying and worth recording. */
    if (looksNetworkError(title, bodyText)) {
      failReason(s, isRouted(s) ? "proxy" : "unreachable");
      return;
    }
    finishLoading(s);
    if (!s.failed) reportRoute(s, true);
    if (title && title.trim() && title !== "New tab") {
      s.title = title;
      renderTabs();
    }
  }

  function navigate(url, opts) {
    opts = opts || {};
    var u = String(url || "").trim();
    /* Same rule for typed and pasted addresses: script execution schemes
       never navigate (a data: page here would be self-inflicted XSS). */
    if (!u || /^(javascript:|file:|data:|vbscript:|blob:)/i.test(u)) return;
    var s = active();
    if (!s) return;
    /* current: address-bar navigation stays in the active tab (like a real
       browser). Opening content (games, quick links) creates a new tab. */
    var fresh = !s.url && !s.frame && s.hi === -1;
    if (!opts.current && !fresh) {
      s = newTab();
      if (!s) return;
    }
    s.title = opts.title || hostOf(u) || "New tab";
    s.letter = letterOf(u);
    s.color = favColor(u);
    s.hist = s.hist.slice(0, s.hi + 1);
    s.hist.push(u);
    s.hi = s.hist.length - 1;
    s.url = u;
    /* A raw handoff is already routed by the launcher: keep it as it is, but
       remember the address behind it plus the node it went through, so a
       failure can be attributed and retried. Everything else is routed here. */
    var route;
    if (opts.raw) {
      s.target = String(opts.source || u);
      route = { url: u, node: nodeFromRoute(u) };
    } else {
      s.target = u;
      route = routeForTarget(u, []);
    }
    s.route = route.url;
    s.node = route.node;
    s.tried = (route.node && route.node.id) ? [route.node.id] : [];
    s.attempts = 1;
    s.failed = false;
    s.reason = "";
    s.code = "";
    ensureFrame(s);
    hideNt();
    startLoading(s);
    s.frame.src = s.route;
    syncView();
  }

  /* History entries hold the address the user asked for, not the route, so a
     revisit is routed fresh (and through a live node, not the one that failed
     earlier in the session). */
  function loadHistory(s, url) {
    var route = routeForTarget(url, []);
    s.target = url;
    s.route = route.url;
    s.node = route.node;
    s.tried = (route.node && route.node.id) ? [route.node.id] : [];
    s.attempts = 1;
    s.failed = false;
    s.reason = "";
    s.code = "";
    ensureFrame(s);
    startLoading(s);
    s.frame.src = s.route;
    syncView();
  }

  function back() {
    var s = active();
    if (!s || !canBack()) return;
    s.hi--;
    s.url = s.hist[s.hi];
    loadHistory(s, s.url);
  }
  function forward() {
    var s = active();
    if (!s || !canFwd()) return;
    s.hi++;
    s.url = s.hist[s.hi];
    loadHistory(s, s.url);
  }
  /* Reload is a retry: same address, a fresh attempt, with the attempt count
     carried so a route that keeps failing is not retried forever. */
  function reload() { retry(); }

  /* ---------- Public API ---------- */
  var api = {
    open: function (url, title, opts) {
      /* Empty url: just open the overlay on its own new-tab page (quick
         links + address bar). Used by the Browser tool so it never nests a
         second browser UI inside this one. */
      if (!url) {
        if (overlay.hidden) {
          overlay.hidden = false;
          document.body.style.overflow = "hidden";
        }
        newTab();
        return true;
      }
      if (!overlay.hidden) {
        navigate(url, opts);
        return true;
      }
      overlay.hidden = false;
      document.body.style.overflow = "hidden";
      newTab();
      navigate(url, opts);
      return true;
    },
    close: function () {
      overlay.hidden = true;
      document.body.style.overflow = "";
      if (exitFsBtn && !exitFsBtn.hidden) exitFs();
    },
    isOpen: function () { return !overlay.hidden; },
    back: back,
    forward: forward,
    reload: reload,
    newTab: newTab,
    tabCount: function () { return sessions.length; },
    /* Pop the current tab out to a real browser tab. */
    popOut: function () {
      var s = active();
      if (!s || !s.url) return;
      var win = window.open(s.url, "_blank");
      if (win) { try { win.opener = null; } catch (e) { /* ignore */ } }
    }
  };
  window.ChalkleBrowser = api;

  /* ---------- Fullscreen ---------- */
  function enterFs() {
    overlay.classList.add("fs");
    if (exitFsBtn) exitFsBtn.hidden = false;
    var req = overlay.requestFullscreen || overlay.webkitRequestFullscreen;
    if (req) { try { var p = req.call(overlay); if (p && p.catch) p.catch(function () { /* CSS mode still holds */ }); } catch (e) { /* ignore */ } }
  }
  function exitFs() {
    overlay.classList.remove("fs");
    if (exitFsBtn) exitFsBtn.hidden = true;
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) { var ex = document.exitFullscreen || document.webkitExitFullscreen; if (ex) { try { ex.call(document); } catch (e) { /* ignore */ } } }
  }
  function syncFs() {
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fsEl && overlay.classList.contains("fs")) {
      overlay.classList.remove("fs");
      if (exitFsBtn) exitFsBtn.hidden = true;
    }
  }
  if (fsBtn) fsBtn.addEventListener("click", function () {
    if (overlay.classList.contains("fs")) exitFs(); else enterFs();
  });
  if (exitFsBtn) exitFsBtn.addEventListener("click", exitFs);
  document.addEventListener("fullscreenchange", syncFs);
  document.addEventListener("webkitfullscreenchange", syncFs);

  /* ---------- Address bar ---------- */
  function submitFromBar() {
    var u = resolveInput(addr.value);
    if (!u) return;
    navigate(u, { current: true });
  }

  /* What the typed string means. Same answer resolveInput gives the Go button,
     so the omnibox's first row is never a different promise than Enter keeps. */
  function classifyInput(t) {
    var u = resolveInput(t);
    if (!u) return null;
    return { kind: looksUrl(t) ? "open" : "search", url: u };
  }

  /* This session's addresses, newest first and de-duplicated, for the History
     rows. Per-tab history is all the browser keeps, so that is what we offer. */
  function sessionHistory() {
    var out = [], seen = {};
    sessions.slice().reverse().forEach(function (s) {
      for (var i = s.hist.length - 1; i >= 0; i--) {
        var u = s.hist[i];
        if (!u || seen[u]) continue;
        seen[u] = 1;
        out.push({ url: u, title: hostOf(u) || u });
      }
    });
    return out;
  }

  /* Catalogue hits for the omnibox come from the app's own ranked search
     (exposed as ChalkleCatalog) so typing "minecr" here finds what it finds
     in the top bar. Absent that module the field still works, just web-only. */
  function catalogSearch(q) {
    var C = window.ChalkleCatalog;
    if (!C || typeof C.search !== "function") return [];
    try {
      return (C.search(q, 5) || []).map(function (h) {
        return { title: h.title, category: h.category, url: h.url, badge: "Play", item: h.item || null };
      });
    } catch (e) { return []; }
  }

  function goSuggestion(r) {
    if (!r) return;
    /* A game row leaves the browser: the launcher opens its own surface, and
       stacking that under this overlay would hide it. */
    if (r.kind === "catalog" && r.item && window.ChalkleCatalog && window.ChalkleCatalog.open) {
      api.close();
      window.ChalkleCatalog.open(r.item);
      return;
    }
    if (r.url) navigate(r.url, { current: true });
  }

  if (addr) {
    if (window.ChalkleOmni && suggestEl) {
      window.ChalkleOmni.attach({
        input: addr,
        panel: suggestEl,
        classify: classifyInput,
        catalog: catalogSearch,
        context: function () { return { bookmarks: loadBookmarks(), history: sessionHistory() }; },
        go: goSuggestion,
        submit: function (value, first) {
          if (first && first.kind === "catalog") { goSuggestion(first); return; }
          submitFromBar();
        }
      });
    } else {
      /* No omnibox module: Enter still goes. */
      addr.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); submitFromBar(); }
      });
    }
    addr.addEventListener("focus", function () {
      addr.select();
      if (addrIco) addrIco.classList.add("is-editing");
    });
    addr.addEventListener("blur", function () { if (addrIco) addrIco.classList.remove("is-editing"); });
    addr.addEventListener("input", function () { if (addrIco) addrIco.classList.toggle("is-editing", !!addr.value); });
  }
  if (goBtn) goBtn.addEventListener("click", submitFromBar);
  if (bkStar) bkStar.addEventListener("click", toggleBookmark);
  if (bkRow) {
    bkRow.addEventListener("click", function (e) {
      var d = e.target.closest("[data-bz-bkdel]");
      if (d) {
        var list = loadBookmarks();
        list.splice(parseInt(d.dataset.bzBkdel, 10), 1);
        saveBookmarks(list);
        syncBk();
        return;
      }
      var g = e.target.closest("[data-bz-bk-go]");
      if (g) {
        var bk = loadBookmarks()[parseInt(g.dataset.bzBk, 10)];
        if (bk) navigate(bk.url);
      }
    });
  }

  /* ---------- Toolbar ---------- */
  if (backBtn) backBtn.addEventListener("click", back);
  if (fwdBtn) fwdBtn.addEventListener("click", forward);
  if (reloadBtn) reloadBtn.addEventListener("click", reload);
  if (extBtn) extBtn.addEventListener("click", function () { api.popOut(); });
  if (closeBtn) closeBtn.addEventListener("click", api.close);
  if (homeBtn) homeBtn.addEventListener("click", function () {
    api.close();
    var nav = document.querySelector('.nav-item[data-view="home"]');
    if (nav) nav.click();
  });

  /* ---------- Blocked panel ---------- */
  if (blockedBack) blockedBack.addEventListener("click", back);
  if (blockedReload) blockedReload.addEventListener("click", retry);
  if (blockedAnyway) blockedAnyway.addEventListener("click", showAnyway);
  if (blockedExt) blockedExt.addEventListener("click", function () { api.popOut(); });

  /* ---------- Notice bar ---------- */
  if (noticeX) noticeX.addEventListener("click", function () { showNotice(false); });
  if (noticeExt) noticeExt.addEventListener("click", function () {
    api.popOut();
    showNotice(false);
  });

  /* ---------- Tabs events ---------- */
  tabsEl.addEventListener("click", function (e) {
    var x = e.target.closest("[data-bz-close]");
    if (x) { closeTab(parseInt(x.dataset.bzClose, 10)); return; }
    var t = e.target.closest("[data-bz-tab]");
    if (t) setActive(parseInt(t.dataset.bzTab, 10));
  });
  tabsEl.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var t = e.target.closest("[data-bz-tab]");
    if (t) { e.preventDefault(); setActive(parseInt(t.dataset.bzTab, 10)); }
  });
  $("bz-newtab").addEventListener("click", newTab);

  /* ---------- New-tab quick links ---------- */
  var NT_VIEWS = [
    { label: "Games", view: "games" },
    { label: "Music", view: "music" },
    { label: "Movies", view: "movies" },
    { label: "Chat", view: "chat" },
    { label: "Cloud", view: "cloud" },
    { label: "Apps", view: "apps-tools" }
  ];
  var NT_WEB = [
    { label: "Google", url: "https://www.google.com" },
    { label: "YouTube", url: "https://www.youtube.com" },
    { label: "Wikipedia", url: "https://www.wikipedia.org" },
    { label: "Spotify", url: "https://open.spotify.com" },
    { label: "Poki", url: "https://www.poki.com" }
  ];
  function renderNtLinks() {
    if (!ntLinksEl) return;
    var html = NT_VIEWS.map(function (l) {
      return '<button class="browser-nt-link" type="button" data-bz-goto="' + l.view + '">' + esc(l.label) + "</button>";
    }).join("");
    html += NT_WEB.map(function (l) {
      return '<button class="browser-nt-link" type="button" data-bz-url="' + esc(l.url) + '">' + esc(l.label) + "</button>";
    }).join("");
    ntLinksEl.innerHTML = html;
  }
  if (ntLinksEl) {
    ntLinksEl.addEventListener("click", function (e) {
      var g = e.target.closest("[data-bz-goto]");
      if (g) {
        api.close();
        var nav = document.querySelector('.nav-item[data-view="' + g.dataset.bzGoto + '"]');
        if (nav) nav.click();
        return;
      }
      var u = e.target.closest("[data-bz-url]");
      if (u) navigate(u.dataset.bzUrl);
    });
  }

  /* ---------- Keyboard ---------- */
  document.addEventListener("keydown", function (e) {
    if (overlay.hidden) return;
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); back(); }
    else if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); forward(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R")) { e.preventDefault(); reload(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === "l" || e.key === "L")) { e.preventDefault(); if (addr) { addr.focus(); addr.select(); } }
    else if ((e.ctrlKey || e.metaKey) && (e.key === "t" || e.key === "T")) { e.preventDefault(); newTab(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === "w" || e.key === "W")) {
      e.preventDefault();
      var s = active();
      if (s) closeTab(s.id);
    }
    else if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) { e.preventDefault(); toggleBookmark(); }
    else if (e.key === "Escape") {
      if (overlay.classList.contains("fs")) { exitFs(); return; }
    }
  });

  /* ---------- Init ---------- */
  paintLogo();
  renderNtLinks();
  syncBk();
  newTab();
})();
