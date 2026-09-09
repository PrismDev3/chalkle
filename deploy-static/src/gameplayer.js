/* Chalkle Game Player - the focused in-app game experience.
   Opened by the Games library (and related-game shelves) via
   ChalkleGamePlayer.open(target, title, opts). The iframe lives in its own
   overlay inside #main, so the app's delegated card handlers (favorite,
   proxy, open-with, launch) keep working on the related shelf for free.
   Includes loading + error states, fullscreen, and session resume: reopening
   the same game shows the still-running frame instead of restarting it. */

(function () {
  "use strict";

  var player = document.getElementById("game-player");
  if (!player) return;

  var $ = function (id) { return document.getElementById(id); };
  var iframeEl = $("gp-frame");
  var wrap = $("gp-frame-wrap");
  var loadingEl = $("gp-loading"), errorEl = $("gp-error"), progressEl = $("gp-progress");
  var loadArt = $("gp-loading-art"), loadTitle = $("gp-loading-title");
  var titleEl = $("gp-title"), subEl = $("gp-sub");
  var infoTitle = $("gp-info-title"), infoMeta = $("gp-info-meta");
  var infoFav = $("gp-info-fav"), infoFavLabel = $("gp-info-fav-label");
  var gpFav = $("gp-fav");
  var relatedEl = $("gp-related"), relatedGrid = $("gp-related-grid");
  var backBtn = $("gp-back"), closeBtn = $("gp-close"), reloadBtn = $("gp-reload");
  var fsBtn = $("gp-fs"), exitFsBtn = $("gp-exitfs");
  var retryBtn = $("gp-retry"), errTabBtn = $("gp-error-tab"), errBackBtn = $("gp-error-back");

  var current = null;      /* { url, title, failed, favKey, fav, onFav } */
  var loadTimer = null;
  var fsActive = false;

  /* ---------- UI ---------- */

  function syncFav() {
    if (gpFav) {
      gpFav.classList.toggle("is-fav", !!current.fav);
      gpFav.setAttribute("aria-label", current.fav ? "Remove favorite" : "Add favorite");
      gpFav.title = current.fav ? "Remove favorite" : "Favorite";
    }
    if (infoFav) {
      infoFav.classList.toggle("is-fav", !!current.fav);
      infoFav.setAttribute("aria-label", current.fav ? "Remove favorite" : "Add favorite");
    }
    if (infoFavLabel) infoFavLabel.textContent = current.fav ? "Favorited" : "Favorite";
  }

  function beginLoad() {
    current.failed = false;
    if (errorEl) errorEl.hidden = true;
    if (loadingEl) loadingEl.hidden = false;
    if (iframeEl) iframeEl.style.opacity = "0";
    if (progressEl) {
      progressEl.style.width = "0";
      progressEl.style.opacity = "1";
      requestAnimationFrame(function () { if (progressEl) progressEl.style.width = "72%"; });
    }
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(function () {
      if (!player.hidden && current && !current.failed) fail("timeout");
    }, 15000);
  }

  function finishLoad() {
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    if (loadingEl) loadingEl.hidden = true;
    if (iframeEl) iframeEl.style.opacity = "1";
    if (progressEl) {
      progressEl.style.width = "100%";
      setTimeout(function () { if (progressEl) progressEl.style.opacity = "0"; }, 250);
    }
  }

  function fail(reason) {
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    if (current) current.failed = true;
    if (loadingEl) loadingEl.hidden = true;
    if (errorEl) errorEl.hidden = false;
    if (progressEl) {
      progressEl.style.width = "100%";
      setTimeout(function () { if (progressEl) progressEl.style.opacity = "0"; }, 250);
    }
    var hint = $("gp-error-hint");
    if (hint) {
      hint.textContent = reason === "blocked"
        ? "This game blocks embedded play, or the network is filtering it."
        : "The game took too long to load. Check your connection and try again.";
    }
  }

  function onFrameLoad() {
    if (!current || current.failed) return;
    finishLoad();
    try {
      var w = iframeEl.contentWindow;
      var d = w && w.document;
      if (d) {
        var t = d.title || "";
        var txt = d.body ? String(d.body.textContent || "") : "";
        /* The /uv/ proxy returns a same-origin error page for unreachable
           targets - surface it as the Chalkle error state. */
        if (t === "Proxy error" || /proxy couldn't load/i.test(txt)) {
          fail("blocked");
          return;
        }
        /* Silently blocked frames: an accessible empty document after a real
           navigation usually means the host refused to render in-frame. */
        if ((!d.body || !d.body.childNodes.length) && current.url.indexOf("about:blank") === -1) {
          fail("blocked");
        }
      }
    } catch (e) { /* cross-origin - loaded fine */ }
  }

  /* ---------- Fullscreen ---------- */

  function applyFs() {
    player.classList.toggle("fs", fsActive);
    if (exitFsBtn) exitFsBtn.hidden = !fsActive;
  }

  function exitFs(skipNative) {
    if (!fsActive) return;
    fsActive = false;
    applyFs();
    if (!skipNative) {
      var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      var ex = document.exitFullscreen || document.webkitExitFullscreen;
      if (ex && fsEl) { try { ex.call(document); } catch (e) { /* ignore */ } }
    }
  }

  function syncFromBrowser() {
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    /* Native exit (Esc on Chromium) drops the CSS maximize too, so one Esc
       always lands the user back on the normal player layout. */
    if (!fsEl && fsActive) {
      fsActive = false;
      applyFs();
    }
  }

  /* ---------- API ---------- */

  function open(target, title, opts) {
    opts = opts || {};
    target = String(target || "");
    if (!target) return false;
    var sameSession = current && current.url === target && !current.failed;
    current = {
      url: target,
      title: title || "Playing",
      originalUrl: opts.originalUrl || target,
      failed: false,
      favKey: opts.favKey || "",
      fav: !!opts.fav,
      onFav: opts.onFav || null
    };

    if (titleEl) titleEl.textContent = current.title;
    if (subEl) subEl.textContent = opts.sub || "";
    if (loadTitle) loadTitle.textContent = current.title;
    if (loadArt) loadArt.innerHTML = opts.art || "";
    if (infoTitle) infoTitle.textContent = current.title;
    if (infoMeta) infoMeta.innerHTML = opts.meta || "";
    syncFav();

    var relatedHtml = Array.isArray(opts.related) ? opts.related.join("") : String(opts.related || "");
    if (relatedEl) relatedEl.hidden = !relatedHtml;
    if (relatedGrid) relatedGrid.innerHTML = relatedHtml;

    if (errorEl) errorEl.hidden = true;
    player.hidden = false;
    document.body.style.overflow = "hidden";

    if (sameSession) {
      /* Reopening the same game resumes the running frame - no restart. */
      if (loadingEl) loadingEl.hidden = true;
      if (iframeEl) iframeEl.style.opacity = "1";
      if (progressEl) progressEl.style.opacity = "0";
    } else {
      beginLoad();
      if (iframeEl) {
        /* Chromium enforces @allow feature names; Firefox only warns about
           the ones it doesn't implement. Keep the full list for Chromium. */
        iframeEl.setAttribute("allow", (window.ChalkleApi && ChalkleApi.iframeAllow) ? ChalkleApi.iframeAllow() : "fullscreen; picture-in-picture");
        iframeEl.src = target;
      }
    }
    if (opts.onOpen) opts.onOpen();
    return true;
  }

  function close() {
    if (player.hidden) return;
    player.hidden = true;
    document.body.style.overflow = "";
    exitFs(true);
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    if (relatedGrid) relatedGrid.innerHTML = "";
    var cb = current && current.onClose;
    current = null;
    if (cb) cb();
  }

  var api = {
    open: open,
    close: close,
    isOpen: function () { return !player.hidden; },
    inFs: function () { return fsActive; },
    exitFs: exitFs,
    reload: function () {
      if (!current || !current.url || player.hidden) return;
      beginLoad();
      if (iframeEl) iframeEl.src = current.url;
    }
  };
  window.ChalkleGamePlayer = api;

  /* ---------- Wiring ---------- */

  if (iframeEl) iframeEl.addEventListener("load", onFrameLoad);

  if (backBtn) backBtn.addEventListener("click", close);
  if (closeBtn) closeBtn.addEventListener("click", close);

  if (reloadBtn) reloadBtn.addEventListener("click", function () { api.reload(); });
  if (retryBtn) retryBtn.addEventListener("click", function () { api.reload(); });
  if (errTabBtn) errTabBtn.addEventListener("click", function () {
    if (!current) return;
    try { window.open(current.originalUrl || current.url, "_blank"); } catch (e) { /* popup blocked */ }
  });
  if (errBackBtn) errBackBtn.addEventListener("click", close);

  function handleFavClick() {
    if (!current || !current.favKey) return;
    current.fav = !current.fav;
    syncFav();
    if (current.onFav) current.onFav(current.favKey, current.fav);
  }
  if (gpFav) gpFav.addEventListener("click", handleFavClick);
  if (infoFav) infoFav.addEventListener("click", handleFavClick);

  if (fsBtn) fsBtn.addEventListener("click", function () {
    if (fsActive) { exitFs(); return; }
    fsActive = true;
    applyFs();
    var req = player.requestFullscreen || player.webkitRequestFullscreen;
    if (req) {
      try {
        var p = req.call(player);
        if (p && p.catch) p.catch(function () { /* CSS maximize still holds */ });
      } catch (e) { /* CSS maximize still holds */ }
    }
  });
  if (exitFsBtn) exitFsBtn.addEventListener("click", function () { exitFs(); });

  document.addEventListener("fullscreenchange", syncFromBrowser);
  document.addEventListener("webkitfullscreenchange", syncFromBrowser);
})();