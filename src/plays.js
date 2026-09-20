/* Chalkle plays: launch counts shared by everyone, not just this device.

   The Games tab has always counted launches locally (chalkle-game-clicks), but
   that number only ever ranked the games one visitor personally opened. This
   module talks to the relay's /api/plays store instead: an all-time total per
   catalog key plus a rolling week, which is what "Most played" and the Home
   trending shelf rank on.

   Everything degrades quietly. No relay (a static mirror with no failover, a
   file:// copy, a blocked network) means count() reports 0 and report() parks
   the launch in a small local queue for the next successful load. A launch is
   never delayed, blocked, or retried in the user's face because of a counter.

   window.ChalklePlays:
     ready()            -> Promise, resolves after the first load attempt
     loaded             -> true once a load has answered
     count(key)         -> all-time plays for a catalog key (0 when unknown)
     trending(key)      -> plays in the last week (0 when unknown)
     format(n)          -> 1200 -> "1.2k"
     top(list, n)       -> the n most played items out of a list, best first
     report(key)        -> count one launch (fire and forget)
     flush()            -> retry anything queued
   It also dispatches "chalkle:plays" on window after every successful load so
   the grid and the Home shelf can repaint without polling. */
(function () {
  "use strict";

  var ENDPOINT = "/api/plays";
  var CACHE_KEY = "chalkle-plays-cache";
  var QUEUE_KEY = "chalkle-plays-queue";
  var CACHE_TTL = 5 * 60 * 1000;   /* serve a cached ranking for 5 minutes */
  var QUEUE_CAP = 40;              /* launches parked offline before we drop */
  var DEDUPE_MS = 3000;            /* same key counted once per 3 seconds */

  var counts = {};
  var trending = {};
  var lastReport = {};
  var loaded = false;
  var loadPromise = null;

  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* full or blocked */ }
  }

  /* Server endpoints live on the relay. On a static mirror a root-absolute
     fetch would resolve against the CDN host and 404, so route it through the
     same helper the viewer pill uses. */
  function endpoint() {
    var url = ENDPOINT;
    try {
      if (window.ChalkleApi && window.ChalkleApi.mirrorPing) url = window.ChalkleApi.mirrorPing(ENDPOINT);
    } catch (e) { /* keep same-origin */ }
    return url;
  }

  function numericMap(raw) {
    var out = {};
    if (!raw || typeof raw !== "object") return out;
    for (var k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      var n = Number(raw[k]);
      if (n > 0) out[k] = Math.floor(n);
    }
    return out;
  }

  function apply(payload) {
    counts = numericMap(payload && payload.plays);
    trending = numericMap(payload && payload.trending);
    loaded = true;
    writeJson(CACHE_KEY, { at: Date.now(), plays: counts, trending: trending });
    try {
      window.dispatchEvent(new CustomEvent("chalkle:plays", { detail: { plays: counts, trending: trending } }));
    } catch (e) { /* very old engine: no CustomEvent constructor */ }
  }

  function readCache() {
    var cached = readJson(CACHE_KEY, null);
    if (!cached || typeof cached !== "object") return false;
    if (Date.now() - Number(cached.at || 0) > CACHE_TTL) {
      /* Stale, but still better than nothing while the network answers: paint
         it now and let the fresh load replace it a moment later. */
      counts = numericMap(cached.plays);
      trending = numericMap(cached.trending);
      return false;
    }
    counts = numericMap(cached.plays);
    trending = numericMap(cached.trending);
    loaded = true;
    return true;
  }

  function queue() {
    var list = readJson(QUEUE_KEY, []);
    return Object.prototype.toString.call(list) === "[object Array]" ? list : [];
  }

  function send(key) {
    var body = JSON.stringify({ key: key });
    /* X-Requested-With mirrors the other stateful callers; the server's
       same-origin guard accepts a matching Origin too. */
    return fetch(endpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "chalkle" },
      body: body,
      cache: "no-store",
      credentials: "omit"
    }).then(function (r) {
      if (!r.ok) throw new Error("plays " + r.status);
      return r.json();
    });
  }

  function flush() {
    var pending = queue();
    if (!pending.length) return Promise.resolve(0);
    var sent = 0;
    var failed = [];
    var chain = Promise.resolve();
    /* Sequential on purpose: a burst of parallel posts on a cold relay is
       exactly what a launch click should never wait on. Only the keys that
       actually failed stay queued, so a retry can never double count one. */
    pending.forEach(function (key) {
      chain = chain.then(function () {
        return send(key).then(function () { sent++; }, function () { failed.push(key); });
      });
    });
    return chain.then(function () {
      writeJson(QUEUE_KEY, failed.slice(-QUEUE_CAP));
      return sent;
    });
  }

  function load() {
    var fresh = readCache();
    var fetched = fetch(endpoint(), { cache: "no-store", credentials: "omit" })
      .then(function (r) {
        if (!r.ok) throw new Error("plays " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data && data.ok) apply(data);
        return flush();
      })
      .catch(function () { return null; });
    /* A warm cache answers immediately; a cold one waits for the fetch so the
       first paint of the grid already has real numbers. */
    return fresh ? Promise.resolve() : fetched.then(function () {});
  }

  function count(key) {
    return counts[String(key || "")] || 0;
  }

  function trend(key) {
    return trending[String(key || "")] || 0;
  }

  function format(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    function trim(s) { return s.slice(-2) === ".0" ? s.slice(0, -2) : s; }
    if (n < 1000000) return trim((n / 1000).toFixed(1)) + "k";
    return trim((n / 1000000).toFixed(1)) + "m";
  }

  /* Ranking helper for shelves and sorts. Items with no plays are dropped, so
     a caller can hand over the whole library and get back only real results. */
  function top(list, limit, opts) {
    var byTrend = !(opts && opts.allTime);
    var scored = [];
    (list || []).forEach(function (item) {
      if (!item) return;
      var key = (opts && opts.keyOf) ? opts.keyOf(item) : (item._id || item.url || item.title);
      if (!key) return;
      var total = count(key);
      var week = trend(key);
      if (!total && !week) return;
      scored.push({ item: item, total: total, week: week });
    });
    scored.sort(function (a, b) {
      if (byTrend && b.week !== a.week) return b.week - a.week;
      if (b.total !== a.total) return b.total - a.total;
      return String(a.item.title || "").localeCompare(String(b.item.title || ""));
    });
    return scored.slice(0, limit || scored.length).map(function (row) { return row.item; });
  }

  function report(key) {
    key = String(key || "").trim();
    if (!key) return;
    var now = Date.now();
    if (lastReport[key] && now - lastReport[key] < DEDUPE_MS) return;
    lastReport[key] = now;
    /* Optimistic local bump so the card the visitor just opened already shows
       one more play before the server answers. */
    counts[key] = (counts[key] || 0) + 1;
    trending[key] = (trending[key] || 0) + 1;
    send(key).then(function (data) {
      if (data && typeof data.count === "number") {
        counts[key] = data.count;
        trending[key] = typeof data.trending === "number" ? data.trending : trending[key];
      }
    }).catch(function () {
      var pending = queue();
      if (pending.indexOf(key) === -1) pending.push(key);
      writeJson(QUEUE_KEY, pending.slice(-QUEUE_CAP));
    });
  }

  window.ChalklePlays = {
    ready: function () {
      if (!loadPromise) loadPromise = load();
      return loadPromise;
    },
    loaded: function () { return loaded; },
    count: count,
    trending: trend,
    format: format,
    top: top,
    report: report,
    flush: flush
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { window.ChalklePlays.ready(); });
  } else {
    window.ChalklePlays.ready();
  }

  /* Coming back to a tab that has been parked for a while is the cheapest
     moment to pick up other people's plays. */
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    var cached = readJson(CACHE_KEY, null);
    if (!cached || Date.now() - Number(cached.at || 0) > CACHE_TTL) window.ChalklePlays.ready();
    else flush();
  });
})();
