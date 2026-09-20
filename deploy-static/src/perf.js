/* Chalkle performance overlay: a live read on what the page is actually doing.

   Useful when a game stutters, a shelf takes a second to fill, or someone asks
   whether the site is heavy. It samples three things that explain a slow page:

     fps          frames per second the browser managed
     main thread  how late a fixed-interval tick fires, so a number near 100%
                  means the main thread is blocked (a big grid render, a runaway
                  script) and near 0% means the page is idle
     memory       JS heap in use, where the browser exposes it

   Off by default: it is a diagnostic, not decoration. Turn it on with the
   Display settings switch, Alt+P, or ?perf=1. Sampling stops while the tab is
   hidden, so an overlay left on in a background tab costs nothing.

   window.ChalklePerf: start(), stop(), toggle(), isOn() */
(function () {
  "use strict";

  var STORE_KEY = "chalkle-perf";
  var GRAPH_POINTS = 72;      /* history kept per chart */
  var SAMPLE_MS = 220;        /* how often the charts redraw */
  var TICK_MS = 50;           /* the main-thread probe interval */
  var CPU_WINDOW = 40;        /* samples averaged into the main-thread number */

  var panel = null;
  var rafId = 0;
  var tickTimer = null;
  var sampleTimer = null;
  var running = false;

  var fps = 0;
  var fpsFrames = 0;
  var fpsWindowStart = 0;
  var fpsAcc = 0;
  var fpsAccCount = 0;
  var lastFrame = 0;

  var busyWindow = [];
  var busyIndex = 0;
  var busyExpected = 0;
  var busyPct = 0;

  var fpsHistory = [];
  var busyHistory = [];
  var memValue = "";

  function pref(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function writePref(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* blocked storage */ }
  }

  /* ---------- panel ---------- */

  function graphRow(label, id) {
    return '<div class="perf-row">' +
      '<span class="perf-label">' + label + "</span>" +
      '<span class="perf-graph"><canvas id="' + id + '" width="120" height="26"></canvas></span>' +
      '<span class="perf-value" id="' + id + '-v">--</span>' +
      "</div>";
  }

  function buildPanel() {
    var el = document.createElement("div");
    el.className = "perf-overlay";
    el.id = "perf-overlay";
    el.setAttribute("role", "status");
    el.setAttribute("aria-label", "Performance overlay");
    el.hidden = true;
    el.innerHTML =
      '<div class="perf-head">' +
      '<span class="perf-title">Performance</span>' +
      '<button class="perf-close" id="perf-close" type="button" aria-label="Hide performance overlay">&times;</button>' +
      "</div>" +
      graphRow("fps", "perf-fps") +
      graphRow("thread", "perf-busy") +
      '<div class="perf-row perf-row-plain"><span class="perf-label">memory</span><span class="perf-value" id="perf-mem">--</span></div>' +
      '<div class="perf-foot" id="perf-foot"></div>';
    document.body.appendChild(el);
    el.querySelector("#perf-close").addEventListener("click", function () { window.ChalklePerf.stop(true); });
    return el;
  }

  function footText() {
    var bits = [];
    try {
      if (navigator.hardwareConcurrency) bits.push(navigator.hardwareConcurrency + " cores");
      if (navigator.deviceMemory) bits.push(navigator.deviceMemory + " GB");
      bits.push(window.innerWidth + "x" + window.innerHeight);
      if (window.devicePixelRatio && window.devicePixelRatio !== 1) bits.push(window.devicePixelRatio.toFixed(2) + "x");
      var conn = navigator.connection || navigator.mozConnection;
      if (conn && conn.effectiveType) bits.push(conn.effectiveType);
    } catch (e) { /* older engine: show whatever we already have */ }
    return bits.join(" \u00b7 ");
  }

  function accent() {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      return v || "#4cc56f";
    } catch (e) { return "#4cc56f"; }
  }

  /* A flat line chart: one accent stroke, no fill, so it reads at a glance and
     stays in the site's visual language. FPS scales to its own peak (a 30 fps
     phone and a 144 fps monitor both use the full height); the thread chart is
     fixed at 0-100% because that share is the meaningful part. */
  function draw(canvas, series, fixedMax) {
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    var dpr = window.devicePixelRatio || 1;
    var w = Math.round(canvas.clientWidth * dpr) || 120;
    var h = Math.round(canvas.clientHeight * dpr) || 26;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    if (series.length < 2) return;
    var max = fixedMax || Math.max(30, Math.max.apply(null, series) * 1.15);
    var step = w / (series.length - 1);
    ctx.beginPath();
    ctx.lineWidth = Math.max(1.5, dpr);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = accent();
    for (var i = 0; i < series.length; i++) {
      var v = Math.max(0, Math.min(1, series[i] / max));
      var x = i * step;
      var y = h - 1 - v * (h - 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /* ---------- sampling ---------- */

  function frame(now) {
    if (!running) return;
    if (!lastFrame) lastFrame = now;
    var inst = 1000 / Math.max(1, now - lastFrame);
    lastFrame = now;
    fpsAcc += inst;
    fpsAccCount++;
    fpsFrames++;
    if (!fpsWindowStart) fpsWindowStart = now;
    if (now - fpsWindowStart >= 500) {
      var avg = fpsAccCount ? fpsAcc / fpsAccCount : 0;
      /* Smoothed so a single dropped frame does not make the number jump. */
      fps = fps ? fps * 0.4 + avg * 0.6 : avg;
      fpsAcc = 0;
      fpsAccCount = 0;
      fpsWindowStart = now;
    }
    rafId = requestAnimationFrame(frame);
  }

  function threadTick() {
    var now = performance.now();
    var late = Math.max(0, now - busyExpected);
    busyWindow[busyIndex] = Math.min(late, 1000);
    busyIndex = (busyIndex + 1) % CPU_WINDOW;
    var total = 0;
    for (var i = 0; i < CPU_WINDOW; i++) {
      if (busyWindow[i] === undefined) continue;
      total += busyWindow[i];
    }
    busyPct = Math.min(100, Math.round((total / (CPU_WINDOW * TICK_MS)) * 100));
    busyExpected = now + TICK_MS;
  }

  function sample() {
    if (!running || !panel) return;
    fpsHistory.push(fps);
    if (fpsHistory.length > GRAPH_POINTS) fpsHistory.shift();
    busyHistory.push(busyPct);
    if (busyHistory.length > GRAPH_POINTS) busyHistory.shift();

    var fpsV = panel.querySelector("#perf-fps-v");
    if (fpsV) fpsV.textContent = fps ? String(Math.round(fps)) : "--";
    var busyV = panel.querySelector("#perf-busy-v");
    if (busyV) busyV.textContent = busyPct + "%";

    /* Heap is Chrome-only and only in secure contexts; say so honestly rather
       than showing a fake zero. */
    var mem = panel.querySelector("#perf-mem");
    if (mem) {
      var m = (performance && performance.memory) || null;
      if (m && m.usedJSHeapSize) {
        var mb = Math.round(m.usedJSHeapSize / 1048576);
        var cap = m.jsHeapSizeLimit ? Math.round(m.jsHeapSizeLimit / 1048576) : 0;
        memValue = cap ? mb + " / " + cap + " MB" : mb + " MB";
      } else if (!memValue) {
        memValue = "not exposed";
      }
      mem.textContent = memValue;
    }
    var foot = panel.querySelector("#perf-foot");
    if (foot) foot.textContent = footText();

    draw(panel.querySelector("#perf-fps"), fpsHistory, 0);
    draw(panel.querySelector("#perf-busy"), busyHistory, 100);
  }

  function reset() {
    fps = 0;
    fpsFrames = 0;
    fpsWindowStart = 0;
    fpsAcc = 0;
    fpsAccCount = 0;
    lastFrame = 0;
    busyPct = 0;
    busyIndex = 0;
    busyExpected = performance.now() + TICK_MS;
    for (var i = 0; i < CPU_WINDOW; i++) busyWindow[i] = undefined;
    fpsHistory.length = 0;
    busyHistory.length = 0;
  }

  function start(persist) {
    if (!panel) panel = buildPanel();
    panel.hidden = false;
    if (persist !== false) writePref(STORE_KEY, "1");
    if (running) return;
    running = true;
    reset();
    rafId = requestAnimationFrame(frame);
    tickTimer = setInterval(threadTick, TICK_MS);
    sample();
    sampleTimer = setInterval(sample, SAMPLE_MS);
  }

  function stop(persist) {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; }
    if (panel) panel.hidden = true;
    if (persist) writePref(STORE_KEY, "0");
  }

  window.ChalklePerf = {
    start: function () { start(true); },
    stop: function () { stop(true); },
    toggle: function () { if (running) stop(true); else start(true); },
    isOn: function () { return running; }
  };

  /* Hidden tabs do not need sampling; the tab that comes back resumes where it
     left off instead of charting the whole gap as one terrible frame. */
  document.addEventListener("visibilitychange", function () {
    if (!running) return;
    if (document.hidden) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    } else {
      reset();
      rafId = requestAnimationFrame(frame);
      tickTimer = setInterval(threadTick, TICK_MS);
    }
  });

  /* Alt+P toggles it from anywhere. Skipped while typing so a shortcut inside
     an input (the cloak title, admin forms) cannot be swallowed. */
  document.addEventListener("keydown", function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== "p" && e.key !== "P") return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    window.ChalklePerf.toggle();
  });

  function boot() {
    var forced = false;
    try {
      forced = new URLSearchParams(location.search).has("perf");
    } catch (e) { /* no URL API: fall back to the stored preference */ }
    if (forced || pref(STORE_KEY, "0") === "1") start(false);
    /* Self-bind the Display switch so app.js does not need to know about it. */
    var toggle = document.getElementById("opt-perf-overlay");
    if (toggle) {
      toggle.checked = running;
      toggle.addEventListener("change", function () {
        if (toggle.checked) start(true);
        else stop(true);
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
