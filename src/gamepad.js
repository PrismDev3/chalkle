/* Chalkle gamepad navigation.

   A controller has no pointer, so this module gives it one: a cursor that
   lives on the same elements Tab can reach, moved with the d-pad or the left
   stick. It exists because a games site is very often driven from a couch,
   and because the reference build this branch studies (cherrion.top) ships a
   dedicated gamepad layer for exactly that reason.

   Mapping (standard gamepad layout):

     d-pad / left stick   move the cursor
     A  (0)               open the item under the cursor
     B  (1)               close whatever is open (same as Escape)
     LB (4) / RB (5)      previous / next tab
     Start (9)            jump to search

   Two rules keep it from fighting the rest of the app:

   1. While a game is open in the player, this module does nothing. The game
      reads the same controller, and two handlers on one pad is a bug.
   2. The cursor only ever moves inside the open overlay when one is open, so
      it can never land on something the user cannot currently see. */

(function () {
  "use strict";

  var DEADZONE = 0.55;      /* stick travel before a direction counts */
  var REPEAT_MS = 190;      /* held d-pad repeat gap */
  var DETECT_MS = 1500;     /* how often to look for a newly plugged pad */
  var HINT_MS = 6500;       /* how long the connected chip stays up */

  var current = null;
  var hoverClass = "gp-cursor";
  var held = {};
  var prev = {};
  var rafId = 0;
  var detectTimer = 0;
  var hintTimer = 0;
  var announced = false;

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.hidden) return false;
    if (typeof el.getClientRects === "function" && el.getClientRects().length === 0) return false;
    var style = null;
    try { style = window.getComputedStyle(el); } catch (e) { return false; }
    if (!style) return false;
    if (style.visibility === "hidden" || style.display === "none") return false;
    return true;
  }

  /* A game is playing: hands off the controller. */
  function gameIsOpen() {
    var player = document.getElementById("game-player");
    return !!(player && !player.hidden);
  }

  /* The open overlay wins over the view underneath it. */
  function scopeRoot() {
    var ids = [
      "admin-modal", "editor-modal", "urlauditor-modal", "pixel-modal",
      "domainhub-modal", "docs-modal", "partners-modal", "livetv-edit-modal",
      "whatsnew-overlay", "proxy-overlay"
    ];
    var i, el;
    for (i = 0; i < ids.length; i++) {
      el = document.getElementById(ids[i]);
      if (el && !el.hidden && isVisible(el)) return el;
    }
    return document.querySelector(".view.is-visible") || document.body;
  }

  var CANDIDATE_SELECTOR =
    'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), ' +
    '[role="button"]:not([aria-disabled="true"]), .nav-item';

  /* Rank by size, because a grid of cards and a row of tiny action buttons
     both match the selector. When the scope clearly holds real cards, keep
     only those: the small controls belong to a card, not beside it. */
  function candidates() {
    var root = scopeRoot();
    var found = [];
    var nodes = root.querySelectorAll(CANDIDATE_SELECTOR);
    var i, el, box, area;
    for (i = 0; i < nodes.length; i++) {
      el = nodes[i];
      if (!isVisible(el)) continue;
      if (el.closest && el.closest(".toast-box")) continue;
      box = el.getBoundingClientRect();
      area = box.width * box.height;
      if (area < 400) continue;                 /* a sliver is not a target */
      found.push({ el: el, area: area });
    }
    var big = found.filter(function (row) { return row.area >= 4000; });
    if (big.length >= 2) found = big;
    return found.map(function (row) { return row.el; });
  }

  function clearCursor() {
    if (current && current.classList) current.classList.remove(hoverClass);
    current = null;
  }

  function setCursor(el) {
    if (!el) return;
    if (current && current !== el && current.classList) current.classList.remove(hoverClass);
    current = el;
    try { el.classList.add(hoverClass); } catch (e) { /* svg or odd node */ }
    try { el.focus({ preventScroll: true }); } catch (e) {
      try { el.focus(); } catch (e2) { /* not focusable */ }
    }
    try { el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" }); } catch (e3) { /* old engines */ }
  }

  function center(el) {
    var box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }

  /* Nearest neighbor in one direction: distance along the axis plus a
     penalty for drifting off the line you were travelling on. */
  function move(dir) {
    var list = candidates();
    if (!list.length) return;
    if (current && list.indexOf(current) === -1) clearCursor();
    if (!current) { setCursor(list[0]); return; }

    var from = center(current);
    var best = null;
    var bestScore = Infinity;
    list.forEach(function (el) {
      if (el === current) return;
      var at = center(el);
      var dx = at.x - from.x;
      var dy = at.y - from.y;
      var along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
      if (along <= 4) return;
      var cross = (dir === "left" || dir === "right") ? Math.abs(dy) : Math.abs(dx);
      var score = along + cross * 2.4;
      if (score < bestScore) { bestScore = score; best = el; }
    });
    if (best) setCursor(best);
  }

  function pressA() {
    var target = current;
    if (!target) {
      var list = candidates();
      if (list.length) setCursor(list[0]);
      return;
    }
    try { target.click(); } catch (e) { /* detached between frames */ }
  }

  function pressB() {
    var ev = null;
    try {
      ev = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
    } catch (e) { return; }
    document.dispatchEvent(ev);
    clearCursor();
  }

  function cycleTab(step) {
    var tabs = Array.prototype.filter.call(document.querySelectorAll(".nav-item"), isVisible);
    if (!tabs.length) return;
    var at = 0;
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].classList.contains("is-active")) { at = i; break; }
    }
    var next = (at + step + tabs.length) % tabs.length;
    try { tabs[next].click(); } catch (e) { /* ignore */ }
    clearCursor();
  }

  function jumpToSearch() {
    var box = document.getElementById("search") ||
              document.getElementById("music-q") ||
              document.querySelector(".view.is-visible input[type='search']");
    if (box && isVisible(box)) { try { box.focus(); } catch (e) { /* ignore */ } }
  }

  function buttonDown(pad, i) {
    var b = pad.buttons && pad.buttons[i];
    if (!b) return false;
    return typeof b === "object" ? (b.pressed || b.value > 0.5) : b > 0.5;
  }

  function edge(pad, i, now) {
    var down = buttonDown(pad, i);
    var was = !!prev[i];
    prev[i] = down;
    return down && !was;
  }

  function heldReady(dir, now) {
    if (now - (held[dir] || 0) < REPEAT_MS) return false;
    held[dir] = now;
    return true;
  }

  function axisDir(pad) {
    var ax = pad.axes && pad.axes.length ? pad.axes[0] : 0;
    var ay = pad.axes && pad.axes.length > 1 ? pad.axes[1] : 0;
    if (Math.abs(ax) < DEADZONE) ax = 0;
    if (Math.abs(ay) < DEADZONE) ay = 0;
    if (!ax && !ay) return "";
    if (Math.abs(ax) >= Math.abs(ay)) return ax > 0 ? "right" : "left";
    return ay > 0 ? "down" : "up";
  }

  function firstPad() {
    var pads = [];
    try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) { return null; }
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) { if (pads[i] && pads[i].connected) return pads[i]; }
    return null;
  }

  function tick(now) {
    rafId = requestAnimationFrame(tick);
    if (document.hidden) return;
    var pad = firstPad();
    if (!pad) { prev = {}; held = {}; return; }

    /* The game owns the pad while it is open. Reset state so nothing queued
       fires the moment the player closes. */
    if (gameIsOpen()) { prev = {}; held = {}; return; }

    if (edge(pad, 0, now)) { pressA(); return; }
    if (edge(pad, 1, now)) { pressB(); return; }
    if (edge(pad, 4, now)) { cycleTab(-1); return; }
    if (edge(pad, 5, now)) { cycleTab(1); return; }
    if (edge(pad, 9, now)) { jumpToSearch(); return; }

    var dir = "";
    if (edge(pad, 12, now)) dir = "up";
    else if (edge(pad, 13, now)) dir = "down";
    else if (edge(pad, 14, now)) dir = "left";
    else if (edge(pad, 15, now)) dir = "right";
    else dir = axisDir(pad);

    if (dir && heldReady(dir, now)) move(dir);
  }

  /* ---------- the connected chip ---------- */

  function chip() {
    var el = document.getElementById("gp-hint");
    if (el) return el;
    el = document.createElement("div");
    el.id = "gp-hint";
    el.className = "gp-hint";
    el.setAttribute("role", "status");
    el.innerHTML =
      '<span class="gp-hint-dot" aria-hidden="true"></span>' +
      '<span class="gp-hint-text">Controller connected</span>' +
      '<span class="gp-hint-keys">A open &middot; B back &middot; LB/RB tabs &middot; Start search</span>';
    document.body.appendChild(el);
    return el;
  }

  function showHint() {
    var el = chip();
    el.classList.add("is-up");
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { el.classList.remove("is-up"); }, HINT_MS);
  }

  function startLoop() {
    if (rafId) return;
    rafId = requestAnimationFrame(tick);
    showHint();
  }

  function stopLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    clearCursor();
    prev = {};
    held = {};
  }

  function detect() {
    var pad = firstPad();
    if (pad) {
      announced = true;
      if (detectTimer) { clearInterval(detectTimer); detectTimer = 0; }
      startLoop();
    } else if (announced) {
      announced = false;
      stopLoop();
    }
  }

  function start() {
    window.addEventListener("gamepadconnected", function () { detect(); });
    window.addEventListener("gamepaddisconnected", function () { detect(); });
    /* Some browsers only expose a pad after a button press and do not fire
       the connect event for a pad that was already on. A slow poll covers
       both without waking the CPU every frame. */
    detect();
    if (!announced) detectTimer = setInterval(detect, DETECT_MS);
  }

  window.ChalkleGamepad = {
    connected: function () { return !!firstPad(); },
    hint: showHint,
    stop: stopLoop
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
