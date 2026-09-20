/* Chalkle ad state: is an ad blocker running? Answered once, quietly.

   The site is free and the relay costs money, so knowing whether the ad layer
   loaded matters - but a visitor with a blocker already knows they have one.
   So this never opens a modal, never blocks the page, and never nags: it sets
   a class on <html>, fills one line in Settings > Advanced, and shows a single
   dismissible toast per session.

   Two checks, because either alone is easy to fool:
     element   the classic bait div that every blocker hides
     network   a real request to the AdSense runtime host the page itself uses

   The verdict is cached for half a day (ad blockers are not turned on and off
   between page loads), so the probe costs nothing on repeat visits.

   window.ChalkleAdState: { blocked, settled, ready: Promise, onVerdict(fn) } */
(function () {
  "use strict";

  var STORE_KEY = "chalkle-ads-state";
  var PROBE_URL = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";
  var PROBE_TIMEOUT = 2500;
  var CACHE_TTL = 12 * 60 * 60 * 1000;
  var NOTICE_KEY = "chalkle-ads-notice";

  var root = document.documentElement;
  var listeners = [];
  var settled = false;
  var resolveReady;

  var api = window.ChalkleAdState = {
    blocked: null,
    settled: false,
    ready: new Promise(function (res) { resolveReady = res; }),
    onVerdict: function (fn) {
      if (typeof fn !== "function") return;
      if (settled) fn(api.blocked);
      else listeners.push(fn);
    }
  };

  function config() {
    return (window.CHALKLE_ADS && typeof window.CHALKLE_ADS === "object") ? window.CHALKLE_ADS : null;
  }

  function apply(blocked) {
    root.classList.toggle("ads-blocked", !!blocked);
    root.classList.toggle("ads-ok", !blocked);
  }

  function remember(blocked) {
    try {
      localStorage.setItem(STORE_KEY, (blocked ? "1" : "0") + ":" + Date.now());
      return;
    } catch (e) { /* fall through to session storage */ }
    try { sessionStorage.setItem(STORE_KEY, (blocked ? "1" : "0") + ":" + Date.now()); } catch (e2) { /* nothing to do */ }
  }

  function recall() {
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { /* ignore */ }
    if (raw === null) {
      try { raw = sessionStorage.getItem(STORE_KEY); } catch (e2) { /* ignore */ }
    }
    if (!raw) return null;
    var parts = String(raw).split(":");
    var stamp = parseInt(parts[1] || "0", 10);
    if (!stamp || Date.now() - stamp > CACHE_TTL) return null;
    return parts[0] === "1";
  }

  /* One line in Settings so the state is visible instead of mysterious: an
     empty ad slot with no explanation looks like a broken page. */
  function paintSettings(blocked) {
    var box = document.getElementById("adcheck-info");
    if (!box) return;
    var verdict = blocked
      ? '<span class="debug-warn">Blocker detected</span>'
      : "Not detected";
    box.innerHTML =
      '<div class="debug-row"><span>Ad blocker</span><b>' + verdict + "</b></div>" +
      '<div class="debug-row"><span>Ad layer</span><b>' + (config() ? "configured" : "off") + "</b></div>" +
      '<div class="debug-row"><span>Last check</span><b>' + new Date().toLocaleTimeString() + "</b></div>";
    var note = document.getElementById("adcheck-note");
    if (note) {
      note.textContent = blocked
        ? "An ad blocker is running, so the sponsored slots stay empty. Ads are what keep the relay and the game builds online. No changes were made to your browser."
        : "The sponsored slots can load normally. Nothing here tracks you beyond what the ad network does on its own.";
    }
  }

  function notice() {
    var seen = "";
    try { seen = sessionStorage.getItem(NOTICE_KEY) || ""; } catch (e) { /* ignore */ }
    if (seen === "1") return;
    try { sessionStorage.setItem(NOTICE_KEY, "1"); } catch (e) { /* ignore */ }
    var msg = "Ad blocker detected. Ads keep the relay and the game builds online, so the empty slots are expected.";
    if (window.ChalkleToast && window.ChalkleToast.show) {
      window.ChalkleToast.show(msg);
      return;
    }
    /* No toast host on this page (brochure pages, embeds): skip it rather than
       inventing a second notification style. */
  }

  function settle(blocked) {
    if (settled) return;
    settled = true;
    api.settled = true;
    api.blocked = !!blocked;
    remember(api.blocked);
    apply(api.blocked);
    paintSettings(api.blocked);
    var pending = listeners;
    listeners = [];
    for (var i = 0; i < pending.length; i++) {
      try { pending[i](api.blocked); } catch (e) { /* a listener error is not ours */ }
    }
    resolveReady(api.blocked);
    if (api.blocked && config()) notice();
  }

  /* A div with the class names every blocker's cosmetic filter list hides. If
     it comes back hidden or zero-sized, something is filtering the page. */
  function elementCheck() {
    var host = document.body || document.documentElement;
    if (!host) return false;
    var bait = document.createElement("div");
    bait.className = "adsbox ad-banner pub_300x250 text-ad ad-placement";
    bait.setAttribute("style", "position:absolute;left:-9999px;top:-9999px;width:3px;height:3px;pointer-events:none");
    bait.innerHTML = "&nbsp;";
    host.appendChild(bait);
    var style = null;
    try { style = getComputedStyle(bait); } catch (e) { style = null; }
    var hidden = bait.offsetParent === null
      || bait.offsetHeight === 0
      || bait.clientHeight === 0
      || !style
      || style.display === "none"
      || style.visibility === "hidden";
    host.removeChild(bait);
    return hidden;
  }

  /* A blocked request to the ad host surfaces as a rejected fetch. no-cors
     keeps it a simple request, so a filter sees the hostname and nothing else.
     A timeout counts as "not blocked": a slow network is not a blocker. */
  function networkCheck(done) {
    if (!window.fetch) { done(null); return; }
    var finished = false;
    function finish(value) {
      if (finished) return;
      finished = true;
      done(value);
    }
    var timer = setTimeout(function () { finish(null); }, PROBE_TIMEOUT);
    fetch(PROBE_URL, { method: "GET", mode: "no-cors", cache: "no-store", credentials: "omit" })
      .then(function () { clearTimeout(timer); finish(false); })
      .catch(function () { clearTimeout(timer); finish(true); });
  }

  function run() {
    /* Ads are not configured on this build: there is nothing to be blocked, so
       stay silent rather than reporting a false positive. */
    if (!config() || !config().client) {
      apply(false);
      settle(false);
      return;
    }
    var cached = recall();
    if (cached !== null) {
      apply(cached);
      settle(cached);
      return;
    }
    if (elementCheck()) {
      settle(true);
      return;
    }
    networkCheck(function (blocked) {
      /* Only a definitive rejection settles it early; a null (timeout) falls
         through to the timer below so a slow network never reads as blocked. */
      if (blocked === true) settle(true);
    });
    /* Last word: if the network probe never answered, trust the element check,
       which already said no. */
    setTimeout(function () { if (!settled) settle(false); }, PROBE_TIMEOUT + 400);
  }

  /* Someone who just turned their blocker off wants the verdict now, not in
     half a day: drop the cache and probe again. */
  function recheck() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
    settled = false;
    api.settled = false;
    api.blocked = null;
    api.ready = new Promise(function (res) { resolveReady = res; });
    listeners = [];
    run();
  }

  api.recheck = recheck;

  /* After load, so the probe can never delay first paint or compete with the
     games grid. */
  window.addEventListener("load", function () {
    var go = window.requestIdleCallback || function (cb) { return setTimeout(cb, 1200); };
    try { go(run, { timeout: 4000 }); } catch (e) { setTimeout(run, 1200); }
  });

  function boot() {
    var btn = document.getElementById("adcheck-recheck");
    if (btn) btn.addEventListener("click", recheck);
    if (settled) paintSettings(api.blocked);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && settled) paintSettings(api.blocked);
  });
})();
