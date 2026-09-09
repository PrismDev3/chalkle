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
  var ntPage = $("bz-newtab-page");
  var backBtn = $("bz-back"), fwdBtn = $("bz-fwd"), reloadBtn = $("bz-reload");
  var extBtn = $("bz-ext"), homeBtn = $("bz-home"), fsBtn = $("bz-fs"), closeBtn = $("bz-close");
  var progressBar = $("bz-progress-bar");
  var blocked = $("bz-blocked"), blockedMsg = $("bz-blocked-msg");
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

  /* Route an external target through the first configured proxy, mirroring
     the launcher's own in-app-frame behaviour. */
  function routeTarget(u) {
    var s = String(u || "");
    if (/^(blob:|data:|about:|javascript:|file:)/i.test(s)) return s;
    var L = window.ChalkleLaunch;
    if (L && L.firstProxy && L.routeProxy && L.shouldOpenDirect) {
      var p = L.firstProxy();
      if (p && /^https?:/i.test(s) && !L.shouldOpenDirect(s)) {
        return L.routeProxy(s, p.url, p.mode === "frame" || !!p.hashRoute);
      }
    }
    return s;
  }

  /* ---------- Sessions ---------- */
  var sessions = [];
  var activeId = null;
  var nextId = 1;
  var loadTimer = null;
  var MAX_TABS = 8;

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
  function showBlocked(s) {
    if (!blocked) return;
    blocked.hidden = false;
    if (s && s.url) blockedMsg.textContent = "We couldn\u2019t reach " + hostOf(s.url) + " from here. It may be blocking embedded play.";
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
    var s = { id: nextId++, title: "New tab", url: "", letter: "?", color: "#3e3930", hist: [], hi: -1, frame: null, el: null, loading: false, failed: false, blockedHost: "" };
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
      s.loading = false;
      s.failed = true;
      syncView();
      if (progressBar) {
        progressBar.style.width = "100%";
        setTimeout(function () { progressBar.style.opacity = "0"; }, 250);
      }
    }, 9000);
    renderTabs();
  }

  function finishLoading(s) {
    if (!s.loading) return;
    s.loading = false;
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
    finishLoading(s);
    try {
      var w = s.frame.contentWindow;
      var doc = w.document;
      var t = doc && doc.title;
      /* The proxy returns a same-origin error page for unreachable targets -
         surface it as the Chalkle error state instead of a raw 502. */
      if (t === "Proxy error" || (doc && doc.body && /proxy couldn't load/i.test(String(doc.body.textContent || "") ))) {
        s.failed = true;
        syncView();
        return;
      }
      if (t && String(t).trim() && t !== "New tab") {
        s.title = t;
        renderTabs();
      }
    } catch (e) { /* cross-origin - keep the provided title */ }
  }

  function navigate(url, opts) {
    opts = opts || {};
    var u = String(url || "").trim();
    if (!u || /^(javascript:|file:)/i.test(u)) return;
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
    ensureFrame(s);
    hideNt();
    startLoading(s);
    /* raw: the URL is already a resolved route (proxy cards) - never wrap it. */
    s.frame.src = opts.raw ? u : routeTarget(u);
    syncView();
  }

  function back() {
    var s = active();
    if (!s || !canBack()) return;
    s.hi--; s.url = s.hist[s.hi]; s.failed = false;
    ensureFrame(s);
    startLoading(s);
    s.frame.src = routeTarget(s.url);
    syncView();
  }
  function forward() {
    var s = active();
    if (!s || !canFwd()) return;
    s.hi++; s.url = s.hist[s.hi]; s.failed = false;
    ensureFrame(s);
    startLoading(s);
    s.frame.src = routeTarget(s.url);
    syncView();
  }
  function reload() {
    var s = active();
    if (!s || !s.url) return;
    s.failed = false;
    ensureFrame(s);
    startLoading(s);
    s.frame.src = routeTarget(s.url);
    syncView();
  }

  /* ---------- Public API ---------- */
  var api = {
    open: function (url, title, opts) {
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
  if (addr) {
    addr.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); submitFromBar(); }
    });
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
  if (blockedReload) blockedReload.addEventListener("click", reload);
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
