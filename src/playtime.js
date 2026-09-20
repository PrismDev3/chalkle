/* Chalkle playtime: how long each game has actually been open on this device.

   The catalog already counts launches, but a launch count says nothing about
   whether anyone stayed. This module times the in-app player instead: a
   session starts when a game opens, accrues while the tab is visible, and is
   written to localStorage every few seconds so a crash, a reload or a closed
   lid costs seconds rather than the whole sitting.

   Everything here is local. Nothing is sent anywhere, and the only way out is
   the Reset button in Settings.

   The numbers are deliberately conservative:
     - a hidden tab accrues nothing, so a game parked in a background tab
       while you do homework does not count as four hours of gaming;
     - one sitting stops counting at SEGMENT_CAP_MS, because a tab left open
       overnight is a parked tab, not a play session;
     - a delta under a second is never written, so flapping the player open
       and closed leaves no trace.

   window.ChalklePlaytime:
     get(key)     -> ms recorded for one catalog key (0 when unknown)
     all()        -> a copy of every recorded row
     total()      -> ms across all keys
     games()      -> how many keys have time on them
     format(ms)   -> 0m | 45m | 1h 20m | 12h
     top(list, n, keyOf) -> items with time, longest first
     add(key, ms) -> record a delta by hand
     start(key, title) -> begin (or continue) a session
     stop()       -> end the running session and flush
     running()    -> the key currently being timed, or ""
     reset()      -> forget everything
   It dispatches "chalkle:playtime" on window after a session ends, so open
   surfaces can repaint without polling. */
(function () {
  "use strict";

  var STORE_KEY = "chalkle-playtime";
  var FLUSH_MS = 15000;              /* how often a running session writes */
  var SEGMENT_CAP_MS = 4 * 3600 * 1000;  /* stop counting one sitting here */
  var MIN_WRITE_MS = 1000;           /* never store a sub-second delta */
  var MAX_KEYS = 500;                /* oldest rows are dropped past this */
  var MIN_SHOW_MS = 60000;           /* one minute before any UI mentions it */

  var store = null;
  var session = null;

  function now() { return Date.now(); }

  function readStore() {
    if (store) return store;
    store = {};
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return store; }
    if (!raw) return store;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return store; }
    if (!parsed || typeof parsed !== "object") return store;
    for (var k in parsed) {
      if (!Object.prototype.hasOwnProperty.call(parsed, k)) continue;
      var row = parsed[k];
      /* Accept both the current { ms, at } shape and a bare number, so an
         older string of this key can never poison the store. */
      var ms = row && typeof row === "object" ? Number(row.ms) : Number(row);
      if (!isFinite(ms) || ms < 0) continue;
      var at = row && typeof row === "object" ? Number(row.at) : 0;
      store[k] = { ms: Math.round(ms), at: isFinite(at) && at > 0 ? Math.round(at) : 0 };
    }
    return store;
  }

  function prune(data) {
    var keys = Object.keys(data);
    if (keys.length <= MAX_KEYS) return;
    keys.sort(function (a, b) { return (data[a].at || 0) - (data[b].at || 0); });
    var drop = keys.length - MAX_KEYS;
    for (var i = 0; i < drop; i++) delete data[keys[i]];
  }

  function writeStore() {
    var data = readStore();
    prune(data);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) { /* full or blocked */ }
  }

  function get(key) {
    key = String(key == null ? "" : key);
    if (!key) return 0;
    var row = readStore()[key];
    return row && row.ms > 0 ? row.ms : 0;
  }

  function add(key, ms) {
    key = String(key == null ? "" : key).trim();
    ms = Math.round(Number(ms) || 0);
    if (!key || ms <= 0) return 0;
    /* Keep keys to a sane length so one pathological catalog entry cannot
       bloat the store. */
    if (key.length > 200) key = key.slice(0, 200);
    var data = readStore();
    var row = data[key] || { ms: 0, at: 0 };
    row.ms = Math.round((Number(row.ms) || 0) + ms);
    row.at = now();
    data[key] = row;
    writeStore();
    return row.ms;
  }

  function total() {
    var data = readStore();
    var sum = 0;
    for (var k in data) {
      if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
      sum += data[k].ms || 0;
    }
    return sum;
  }

  function games() {
    var data = readStore();
    var n = 0;
    for (var k in data) {
      if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
      if (data[k].ms > 0) n++;
    }
    return n;
  }

  function all() {
    var data = readStore();
    var out = {};
    for (var k in data) {
      if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
      out[k] = { ms: data[k].ms || 0, at: data[k].at || 0 };
    }
    return out;
  }

  function format(ms) {
    var mins = Math.floor((Number(ms) || 0) / 60000);
    if (mins < 1) return "0m";
    if (mins < 60) return mins + "m";
    var hours = Math.floor(mins / 60);
    var rest = mins % 60;
    return rest ? hours + "h " + rest + "m" : hours + "h";
  }

  /* ---------- session ---------- */

  function accrue() {
    if (!session) return;
    var t = now();
    var elapsed = t - session.mark;
    session.mark = t;
    if (elapsed <= 0) return;
    /* A hidden tab is a parked game, not a played one. */
    if (document.visibilityState === "hidden") return;
    if (session.accrued >= SEGMENT_CAP_MS) return;
    session.accrued += elapsed;
    if (session.accrued > SEGMENT_CAP_MS) session.accrued = SEGMENT_CAP_MS;
  }

  function flush() {
    if (!session) return 0;
    accrue();
    var delta = session.accrued - session.written;
    if (delta < MIN_WRITE_MS) return 0;
    session.written = session.accrued;
    return add(session.key, delta);
  }

  function start(key, title) {
    key = String(key == null ? "" : key).trim();
    if (!key) return false;
    /* Reopening the game that is already running keeps the same session: the
       player resumes the running frame, so the clock must keep running too. */
    if (session && session.key === key) return false;
    stop();
    session = {
      key: key,
      title: String(title == null ? "" : title),
      accrued: 0,
      written: 0,
      mark: now()
    };
    startTimer();
    return true;
  }

  function stop() {
    if (!session) return 0;
    var key = session.key;
    flush();
    session = null;
    stopTimer();
    var ms = get(key);
    try {
      window.dispatchEvent(new CustomEvent("chalkle:playtime", { detail: { key: key, ms: ms } }));
    } catch (e) { /* very old engine: no CustomEvent constructor */ }
    return ms;
  }

  function top(list, limit, keyOf) {
    var rows = [];
    (list || []).forEach(function (item) {
      if (!item) return;
      var key = keyOf ? keyOf(item) : (item._id || item.url || item.title);
      var ms = get(key);
      if (ms <= 0) return;
      rows.push({ item: item, ms: ms });
    });
    rows.sort(function (a, b) {
      if (b.ms !== a.ms) return b.ms - a.ms;
      return String(a.item.title || a.item.name || "").localeCompare(String(b.item.title || b.item.name || ""));
    });
    return rows.slice(0, limit || rows.length).map(function (r) { return r.item; });
  }

  function reset() {
    stop();
    store = {};
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* blocked */ }
    try { window.dispatchEvent(new CustomEvent("chalkle:playtime", { detail: { key: "", ms: 0 } })); } catch (e) {}
  }

  /* The timer only runs while a session does: an idle page should not hold a
     wake-up every fifteen seconds for nothing. */
  var timer = null;

  function startTimer() {
    if (timer) return;
    timer = setInterval(function () { flush(); }, FLUSH_MS);
  }

  function stopTimer() {
    if (!timer) return;
    try { clearInterval(timer); } catch (e) { /* ignore */ }
    timer = null;
  }

  /* A backgrounded tab flushes on the way out, and a closed page flushes
     instead of losing the tail of the session (pagehide fires in cases
     beforeunload does not, such as a mobile tab eviction). */
  document.addEventListener("visibilitychange", function () { flush(); });
  window.addEventListener("pagehide", function () { stop(); });
  window.addEventListener("beforeunload", function () { stop(); });

  window.ChalklePlaytime = {
    get: get,
    all: all,
    add: add,
    total: total,
    games: games,
    format: format,
    top: top,
    start: start,
    stop: stop,
    running: function () { return session ? session.key : ""; },
    reset: reset,
    segmentCapMs: SEGMENT_CAP_MS,
    MIN_SHOW_MS: MIN_SHOW_MS
  };
})();
