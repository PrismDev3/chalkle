/* Chalkle Game Player - the focused in-app game experience.
   Opened by the Games library (and related-game shelves) via
   ChalkleGamePlayer.open(target, title, opts). The iframe lives in its own
   overlay inside #main, so the app's delegated card handlers (favorite,
   proxy, open-with, launch) keep working on the related shelf for free.
   Includes loading + error states, fullscreen, and session resume while the
   player stays open: clicking the same game again shows the running frame
   instead of restarting it. Closing the player unloads the frame so the
   game (and its audio) actually stops. */

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
  var splashEl = $("gp-splash"), splashRows = $("gp-splash-rows"), splashTitle = $("gp-splash-title");
  var splashTimer = null;

  var current = null;      /* { url, title, failed, favKey, fav, onFav } */
  var loadTimer = null;
  var fsActive = false;

  /* ---------- Pop-up guard ----------
     Local game builds run same-origin in this frame, and plenty of them carry
     an ad script that answers a click with a popup of somebody else's site.
     Hiding that is a one-line patch of the frame's own window.open. It only
     applies to frames we can actually reach; a cross-origin game is left
     alone, and Settings > Behavior has the off switch. */
  var POPUP_PREF = "chalkle-block-popups";
  var popupBlocks = 0;
  var popupNoticed = false;

  function popupPolicyOn() {
    try { return localStorage.getItem(POPUP_PREF) !== "0"; } catch (e) { return true; }
  }

  function frameWindow() {
    if (!iframeEl || iframeEl.src === "about:blank") return null;
    try { return iframeEl.contentWindow || null; } catch (e) { return null; }
  }

  function guardPopups() {
    var w = frameWindow();
    if (!w) return;
    try {
      if (!popupPolicyOn()) {
        /* Turning the policy back off restores the game's own window.open. */
        if (w.__chalklePopupGuard && typeof w.__chalklePopupOpen === "function") {
          w.open = w.__chalklePopupOpen;
          w.__chalklePopupGuard = false;
        }
        return;
      }
      if (w.__chalklePopupGuard) return;
      if (typeof w.open === "function") {
        var native = w.open;
        w.open = function () {
          popupBlocks++;
          if (!popupNoticed) {
            popupNoticed = true;
            try {
              if (window.ChalkleToast && window.ChalkleToast.show) {
                window.ChalkleToast.show("Pop-up blocked \u00b7 turn it off in Settings \u203a Behavior");
              }
            } catch (e) { /* no toast surface */ }
          }
          return null;
        };
        w.__chalklePopupOpen = native;
      }
      w.__chalklePopupGuard = true;
    } catch (e) { /* cross-origin frame: nothing to reach, nothing to break */ }
  }

  /* ---------- Auto clicker panel ----------
     Clicker games are all the same chore: wait, then click the same spot a
     few hundred times. When the opened game is a clicker (title or URL says
     so), the player bolts a small vertical panel to the frame's right edge
     that can do the clicking: a CPS number with presets, mouse or spacebar
     taps, a little speed randomization so patterns stay human, and a hotkey
     (F6 by default) that starts and stops without leaving the game. It only
     ever synthesizes events inside our own same-origin frame; Settings >
     Behavior has the off switch. */
  var CLICKER_PREF = "chalkle-clicker-panel";   /* "0" hides the panel */
  var CLICKER_STORE = "chalkle-clicker";        /* cps / mode / rand / hotkey */
  var ac = {
    host: null,
    armed: false,
    on: false,
    timer: null,
    cps: 10,
    mode: "mouse",     /* "mouse" | "space" */
    rand: 0,           /* 0..50 % timing jitter */
    hotkey: "f6",
    waitingKey: false,
    count: 0,
    beats: [],         /* timestamps of recent beats, for the live rate */
    unit: "s",         /* "s" | "m" | "h": what the rate number counts in */
    button: "left",    /* "left" | "middle" | "right" */
    duty: 50           /* % of each beat the button is held down */
  };

  /* MouseEvent button numbers plus the buttons bitmask each phase carries,
     so hold-aware games reading e.buttons get a real value. */
  var BUTTONS = {
    left:   { num: 0, down: 1 },
    middle: { num: 1, down: 4 },
    right:  { num: 2, down: 2 }
  };

  /* The panel's number is a rate in the chosen unit; the engine schedules
     in seconds only. A per-hour rate becomes a fractional cps and the loop
     simply waits that long between beats. */
  function acRatePerSecond() {
    if (ac.unit === "m") return Math.max(1 / 60, ac.cps / 60);
    if (ac.unit === "h") return Math.max(1 / 3600, ac.cps / 3600);
    return Math.max(1, ac.cps);
  }

  function looksLikeClicker(title, url) {
    /* Case-insensitive substring, not word-boundary: "Clickerheroes" and
       "italian-brainrot-clicker" must both match. Titles cover blob/data
       embeds whose URL carries no name at all. */
    var t = String(title || "").toLowerCase();
    var u = String(url || "").toLowerCase();
    return t.indexOf("clicker") !== -1 || u.indexOf("clicker") !== -1;
  }

  function acStore() {
    try { return JSON.parse(localStorage.getItem(CLICKER_STORE) || "{}") || {}; }
    catch (e) { return {}; }
  }

  function acSave() {
    try {
      localStorage.setItem(CLICKER_STORE, JSON.stringify({
        cps: ac.cps, mode: ac.mode, rand: ac.rand, hotkey: ac.hotkey,
        unit: ac.unit, button: ac.button, duty: ac.duty
      }));
    } catch (e) { /* private mode: panel still works, just not remembered */ }
  }

  function keyEv(w, type) {
    var e = null;
    try {
      e = new w.KeyboardEvent(type, {
        key: " ", code: "Space", bubbles: true, cancelable: true
      });
    } catch (err) { return null; }
    /* keyCode/which are read-only in the constructor; games written against
       them still deserve a real 32. */
    try {
      Object.defineProperty(e, "keyCode", { get: function () { return 32; } });
      Object.defineProperty(e, "which", { get: function () { return 32; } });
    } catch (err2) { /* older engine: key/code still went through */ }
    return e;
  }

  function frameDoc() {
    var w = frameWindow();
    if (!w) return null;
    try { return w.document || null; } catch (e) { return null; }
  }

  /* Where should the clicks land? Two layers:

     1. AUTOMATIC. Geometric center is wrong more often than it is right:
        Cookie Clicker keeps its giant cookie on the left half and a stats
        canvas dead center, so centered clicks hit the one thing that ignores
        them. A named clickable (id/class mentions click/cookie/button/main)
        wins when one exists, center otherwise.

     2. PICKED. A named target only gets the clicking done on ONE thing, and
        clickers have more than one thing: the cookie AND the upgrade store
        AND golden cookies. "Pick target" lets the user click any element
        inside the game once; that element is what the engine hits until the
        pick is cleared or the frame navigates. The pick survives in-session
        per player-open (element reference dies with the document; the pick
        re-resolves by index path after a reload or game swap).

     Targets are found lazily and cached between beats: querySelectorAll on
     every beat at 60 cps is real work. */
  var acTarget = { el: null, picked: null, beat: 0 };

  function acInvalidateTarget() {
    acTarget.el = null;
    acTarget.picked = null;
    acTarget.beat = 0;
    if (ac.host) {
      var btn = ac.host.querySelector(".gp-ac-pick");
      if (btn) {
        btn.classList.remove("on", "wait");
        btn.textContent = "Pick target";
      }
    }
  }

  function acFindTarget(doc, w) {
    /* A score is needed because "biggest visible match" beats "first match":
       engines love decorating the DOM with hidden #click-helper nodes. */
    var best = null, bestScore = 0;
    var candidates = doc.querySelectorAll(
      '[id*="click" i],[class*="click" i],[id*="cookie" i],[class*="cookie" i],[id*="button" i],[id*="main" i]'
    );
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var r, st;
      try { r = el.getBoundingClientRect(); st = w.getComputedStyle(el); }
      catch (err) { continue; }
      if (r.width < 24 || r.height < 24) continue;
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) continue;
      if (st.pointerEvents === "none") continue;
      /* Bigger wins; cap so one full-page wrapper cannot always take it. */
      var score = Math.min(r.width * r.height, 500 * 500);
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  /* CSS path to an element, so a picked target can be re-resolved after the
     game reloads (same document shape, fresh nodes). nth-of-type chains are
     bulky but stable for game UIs that never restructure mid-session. */
  function acPathOf(el) {
    var parts = [];
    var n = el;
    while (n && n.nodeType === 1 && parts.length < 12) {
      var seg = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(seg + "#" + CSS.escape(n.id)); break; }
      var parent = n.parentElement;
      if (parent) {
        var same = 0, idx = 0;
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i] === n) { idx = i; break; }
        }
        for (var j = 0; j < parent.children.length; j++) {
          if (parent.children[j].tagName === n.tagName) {
            same++;
            if (j === idx) break;
          }
        }
        seg += ":nth-of-type(" + same + ")";
      }
      parts.unshift(seg);
      n = parent;
    }
    return parts.join(" > ");
  }

  /* Arrow from the panel into the frame: a one-shot click-to-pick. The next
     click anywhere inside the game becomes the target; Esc cancels. While
     waiting, the frame gets a crosshair cursor and a visible outline on
     hover so the aim is obvious. */
  function acArmPick() {
    var w = frameWindow();
    if (!w) return false;
    var doc = null;
    try { doc = w.document; } catch (e) { return false; }
    if (!doc || !doc.body) return false;
    ac.picking = true;
    try { doc.documentElement.style.cursor = "crosshair"; } catch (e2) { /* fine */ }

    function onOver(e) {
      try { e.target.style && (e.target.__acPrevOutline = e.target.style.outline); e.target.style.outline = "2px solid #4cc56f"; } catch (err) {}
    }
    function onOut(e) {
      try { if (e.target.__acPrevOutline === undefined) e.target.style.outline = ""; else { e.target.style.outline = e.target.__acPrevOutline; delete e.target.__acPrevOutline; } } catch (err) {}
    }
    function onDown(e) {
      finish(true, e);
    }
    function onKey(e) {
      if (e.key === "Escape") finish(false, null);
    }
    function finish(accept, e) {
      ac.picking = false;
      doc.removeEventListener("mouseover", onOver, true);
      doc.removeEventListener("mouseout", onOut, true);
      doc.removeEventListener("mousedown", onDown, true);
      w.removeEventListener("keydown", onKey, true);
      try { doc.documentElement.style.cursor = ""; } catch (err2) {}
      if (ac.host) {
        var btn = ac.host.querySelector(".gp-ac-pick");
        if (btn) { btn.classList.remove("wait"); btn.textContent = "Pick target"; }
      }
      if (!accept || !e || !e.target || !e.target.getBoundingClientRect) return;
      var el = e.target;
      /* A click lands on whatever leaf is under the cursor (an SVG path, a
         span). Climb to the nearest ancestor that actually fills the aim:
         the smallest ancestor at least 24x24 keeps intentional small targets
         but skips decorative leaves. */
      var node = el;
      while (node && node !== doc.body) {
        var r = node.getBoundingClientRect();
        if (r.width >= 24 && r.height >= 24) break;
        node = node.parentElement;
      }
      if (!node || node === doc.body) node = el;
      acTarget.picked = { el: node, path: acPathOf(node), title: (node.id || node.className || node.tagName || "").toString().slice(0, 28) };
      acTarget.el = node;
      if (ac.host) {
        var btn2 = ac.host.querySelector(".gp-ac-pick");
        var tag = ac.host.querySelector(".gp-ac-picked");
        if (btn2) { btn2.classList.add("on"); btn2.textContent = "Picked"; }
        if (tag) { tag.textContent = acTarget.picked.title; tag.hidden = false; }
      }
    }
    doc.addEventListener("mouseover", onOver, true);
    doc.addEventListener("mouseout", onOut, true);
    doc.addEventListener("mousedown", onDown, true);
    w.addEventListener("keydown", onKey, true);
    return true;
  }

  /* A mouse event with a real buttons bitmask: the constructor's own value
     is ignored by games, so it is patched on like keyCode above. */
  function mouseEv(w, type, x, y, btn, buttons) {
    var e = null;
    try {
      e = new w.MouseEvent(type, {
        bubbles: true, cancelable: true, view: w, clientX: x, clientY: y, button: btn
      });
    } catch (err) { return null; }
    try { Object.defineProperty(e, "buttons", { get: function () { return buttons; } }); }
    catch (err2) { /* old engine: the button field still went through */ }
    return e;
  }

  function fireMouse(delay) {
    var doc = frameDoc();
    if (!doc || !doc.elementFromPoint) return;
    var w = iframeEl.contentWindow;
    var rect = iframeEl.getBoundingClientRect();
    /* Target pick: named clickable first, geometric center second. Re-scan
       when the frame navigated since the last pick (docRef check), and every
       ~50 beats so a game that swaps its UI still gets followed. */
    var el = null, x, y;
    ac.beatCount = (ac.beatCount || 0) + 1;
    /* Picked target first: user intent beats any heuristic. Re-resolve by
       path when the node died (game reload). */
    if (acTarget.picked) {
      var p = acTarget.picked;
      if (!p.el || !p.el.isConnected) {
        try { p.el = p.path ? doc.querySelector(p.path) : null; } catch (err) { p.el = null; }
      }
      if (p.el && p.el.isConnected) el = p.el;
      else acTarget.picked = null;
    }
    if (!el) {
      if (!acTarget.el || ac.beatCount % 50 === 0) {
        acTarget.el = acFindTarget(doc, w);
      }
      el = acTarget.el;
    }
    if (el) {
      try {
        var tr = el.getBoundingClientRect();
        if (tr.width > 1) {
          /* Aim at the element's visible center; elementFromPoint confirms the
             game has not covered it with an overlay at that spot. */
          x = Math.max(1, Math.min(rect.width - 1, Math.round(tr.left + tr.width / 2)));
          y = Math.max(1, Math.min(rect.height - 1, Math.round(tr.top + tr.height / 2)));
          var topAt = doc.elementFromPoint(x, y);
          var aimed = topAt || el;
          el = aimed;
        }
      } catch (err) { acTarget.el = null; acTarget.picked = null; }
    }
    if (!el) {
      x = Math.max(1, Math.round(rect.width / 2));
      y = Math.max(1, Math.round(rect.height / 2));
      el = doc.elementFromPoint(x, y) || doc.body || doc.documentElement;
    }
    if (!el || !el.dispatchEvent) return;
    /* Duty cycle: the button is HELD for the first duty% of the beat and
       released after, so hold-aware games (charge meters, drag pumping) see
       a real press length instead of an instant down+up pair. */
    var b = BUTTONS[ac.button] || BUTTONS.left;
    var upMs = Math.max(1, Math.round((delay || 100) * ac.duty / 100));
    var ptrOpts = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: b.num, clientX: x, clientY: y, bubbles: true, cancelable: true, view: w };
    try {
      if (w.PointerEvent) {
        el.dispatchEvent(new w.PointerEvent("pointerdown", ptrOpts));
      }
      el.dispatchEvent(mouseEv(w, "mousedown", x, y, b.num, b.down));
      setTimeout(function () {
        try {
          if (w.PointerEvent) el.dispatchEvent(new w.PointerEvent("pointerup", ptrOpts));
          el.dispatchEvent(mouseEv(w, "mouseup", x, y, b.num, 0));
          el.dispatchEvent(mouseEv(w, "click", x, y, b.num, 0));
        } catch (err) { /* node went stale between down and up */ }
      }, upMs);
    } catch (e) { /* node from a stale doc: skip this beat */ }
  }

  function fireSpace(delay) {
    var doc = frameDoc();
    if (!doc) return;
    var w = iframeEl.contentWindow;
    var target = doc.activeElement || doc.body || doc;
    if (!target || !target.dispatchEvent) target = doc;
    var down = keyEv(w, "keydown"), up = keyEv(w, "keyup");
    var hold = Math.max(1, Math.round((delay || 100) * ac.duty / 100));
    try {
      if (down) target.dispatchEvent(down);
      setTimeout(function () {
        try { if (up) target.dispatchEvent(up); } catch (err) { /* stale doc */ }
      }, hold);
    } catch (e) { /* stale doc: skip this beat */ }
  }

  function fireBeat(delay) {
    if (ac.mode === "space") fireSpace(delay); else fireMouse(delay);
    ac.count++;
    var now = Date.now();
    ac.beats.push(now);
    while (ac.beats.length && now - ac.beats[0] > 1200) ac.beats.shift();
    var live = ac.host && ac.host.querySelector(".gp-ac-live");
    var rate = ac.host && ac.host.querySelector(".gp-ac-rate");
    if (live) live.textContent = ac.count + (ac.count === 1 ? " click" : " clicks");
    if (rate) {
      /* The measured window is ~1.2s; rescale into the unit on the dial. */
      var m = ac.beats.length * (ac.unit === "m" ? 60 : ac.unit === "h" ? 3600 : 1);
      rate.textContent = m.toFixed(1) + (ac.unit === "s" ? "/s" : ac.unit === "m" ? "/min" : "/hr");
    }
  }

  function acLoop() {
    if (!ac.on) return;
    /* 500/s is the useful burst ceiling; below that the delay is exact. */
    var delay = Math.max(2, Math.round(1000 / acRatePerSecond()));
    fireBeat(delay);
    var beat = delay;
    if (ac.rand > 0) {
      var spread = delay * (ac.rand / 100);
      beat = delay - spread / 2 + Math.random() * spread;
    }
    ac.timer = setTimeout(acLoop, Math.max(2, beat));
  }

  function acStart() {
    if (ac.on || !ac.armed) return;
    ac.on = true;
    ac.count = 0;
    ac.beats = [];
    if (ac.host) {
      ac.host.classList.add("live");
      var go = ac.host.querySelector(".gp-ac-go");
      if (go) { go.textContent = "Stop"; }
    }
    acLoop();
  }

  function acStop() {
    ac.on = false;
    if (ac.timer) { clearTimeout(ac.timer); ac.timer = null; }
    if (ac.host) {
      ac.host.classList.remove("live");
      var go = ac.host.querySelector(".gp-ac-go");
      if (go) go.textContent = "Start";
    }
  }

  function acToggle() {
    if (ac.on) acStop(); else acStart();
  }

  function markChips(host) {
    if (!host) return;
    host.querySelectorAll(".gp-ac-chip[data-cps]").forEach(function (chip) {
      /* Presets are per-second values; they only light up on the /sec dial. */
      chip.classList.toggle("on", ac.unit === "s" && Number(chip.dataset.cps) === ac.cps);
    });
    host.querySelectorAll(".gp-ac-chip[data-mode]").forEach(function (chip) {
      chip.classList.toggle("on", chip.dataset.mode === ac.mode);
    });
    host.querySelectorAll(".gp-ac-chip[data-btn]").forEach(function (chip) {
      chip.classList.toggle("on", chip.dataset.btn === ac.button);
    });
  }

  function buildAcPanel() {
    if (!wrap || ac.host) return;
    var host = document.createElement("div");
    host.className = "gp-ac";
    host.hidden = true;
    host.innerHTML =
      '<div class="gp-ac-head">' +
        '<span class="gp-ac-dot" aria-hidden="true"></span>' +
        '<span class="gp-ac-name">Auto Clicker</span>' +
        '<button class="gp-ac-min" type="button" aria-label="Collapse panel">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="gp-ac-body">' +
        '<div class="gp-ac-block">' +
          '<span class="gp-ac-label">Click rate</span>' +
          '<div class="gp-ac-row">' +
            '<input class="gp-ac-num" type="number" min="1" max="500000" step="1" value="10" aria-label="Click rate">' +
            '<select class="gp-ac-unit" aria-label="Rate unit">' +
              '<option value="s">/sec</option>' +
              '<option value="m">/min</option>' +
              '<option value="h">/hr</option>' +
            '</select>' +
          '</div>' +
          '<div class="gp-ac-chips" role="group" aria-label="Speed presets (per second)">' +
            '<button class="gp-ac-chip" type="button" data-cps="5">5</button>' +
            '<button class="gp-ac-chip" type="button" data-cps="10">10</button>' +
            '<button class="gp-ac-chip" type="button" data-cps="20">20</button>' +
            '<button class="gp-ac-chip" type="button" data-cps="60">60</button>' +
          '</div>' +
        '</div>' +
        '<div class="gp-ac-block">' +
          '<span class="gp-ac-label">Mode</span>' +
          '<div class="gp-ac-chips" role="group" aria-label="Click mode">' +
            '<button class="gp-ac-chip" type="button" data-mode="mouse">Mouse</button>' +
            '<button class="gp-ac-chip" type="button" data-mode="space">Spacebar</button>' +
          '</div>' +
        '</div>' +
        '<div class="gp-ac-block">' +
          '<span class="gp-ac-label">Button</span>' +
          '<div class="gp-ac-chips" role="group" aria-label="Mouse button">' +
            '<button class="gp-ac-chip" type="button" data-btn="left">Left</button>' +
            '<button class="gp-ac-chip" type="button" data-btn="middle">Mid</button>' +
            '<button class="gp-ac-chip" type="button" data-btn="right">Right</button>' +
          '</div>' +
        '</div>' +
        '<div class="gp-ac-block">' +
          '<span class="gp-ac-label">Speed randomization <b class="gp-ac-randv">0%</b></span>' +
          '<input class="gp-ac-rand" type="range" min="0" max="50" step="5" value="0" aria-label="Speed randomization percent">' +
        '</div>' +
        '<div class="gp-ac-block">' +
          '<span class="gp-ac-label">Duty cycle <b class="gp-ac-dutyv">50%</b></span>' +
          '<input class="gp-ac-duty" type="range" min="5" max="95" step="5" value="50" aria-label="Duty cycle percent">' +
        '</div>' +
        '<div class="gp-ac-block">' +
          '<span class="gp-ac-label">Toggle hotkey</span>' +
          '<button class="gp-ac-key" type="button">F6</button>' +
        '</div>' +
        '<div class="gp-ac-block">' +
          '<span class="gp-ac-label">Click target</span>' +
          '<button class="gp-ac-pick" type="button">Pick target</button>' +
          '<span class="gp-ac-picked" hidden></span>' +
        '</div>' +
        '<button class="gp-ac-go" type="button">Start</button>' +
        '<div class="gp-ac-foot"><span class="gp-ac-live">0 clicks</span><span class="gp-ac-rate">0.0/s</span></div>' +
      '</div>';
    wrap.appendChild(host);
    ac.host = host;

    var stored = acStore();
    ac.unit = stored.unit === "m" || stored.unit === "h" ? stored.unit : "s";
    ac.cps = Math.min(ac.unit === "s" ? 500 : ac.unit === "m" ? 30000 : 100000,
                      Math.max(1, Math.round(Number(stored.cps) || 10)));
    ac.mode = stored.mode === "space" ? "space" : "mouse";
    ac.button = BUTTONS[stored.button] ? stored.button : "left";
    ac.rand = Math.min(50, Math.max(0, Number(stored.rand) || 0));
    ac.duty = Math.min(95, Math.max(5, Number(stored.duty) || 50));
    if (stored.hotkey && String(stored.hotkey).length <= 12) ac.hotkey = String(stored.hotkey).toLowerCase();

    var num = host.querySelector(".gp-ac-num");
    var unit = host.querySelector(".gp-ac-unit");
    var duty = host.querySelector(".gp-ac-duty");
    var dutyv = host.querySelector(".gp-ac-dutyv");
    var rand = host.querySelector(".gp-ac-rand");
    var randv = host.querySelector(".gp-ac-randv");
    var keyBtn = host.querySelector(".gp-ac-key");
    num.value = ac.cps;
    unit.value = ac.unit;
    duty.value = String(ac.duty);
    dutyv.textContent = ac.duty + "%";
    rand.value = String(ac.rand);
    randv.textContent = ac.rand + "%";
    keyBtn.textContent = ac.hotkey === " " ? "space" : ac.hotkey.toUpperCase();
    markChips(host);

    num.addEventListener("change", function () {
      var max = ac.unit === "s" ? 500 : ac.unit === "m" ? 30000 : 100000;
      ac.cps = Math.min(max, Math.max(1, Math.round(Number(num.value) || 10)));
      num.value = String(ac.cps);
      markChips(host);
      acSave();
    });
    unit.addEventListener("change", function () {
      ac.unit = unit.value === "m" || unit.value === "h" ? unit.value : "s";
      markChips(host);
      acSave();
    });
    duty.addEventListener("input", function () {
      ac.duty = Math.min(95, Math.max(5, Number(duty.value) || 50));
      dutyv.textContent = ac.duty + "%";
      acSave();
    });
    host.querySelectorAll(".gp-ac-chip[data-cps]").forEach(function (chip) {
      chip.addEventListener("click", function () {
        ac.unit = "s";              /* presets are per-second values */
        unit.value = "s";
        ac.cps = Number(chip.dataset.cps);
        num.value = String(ac.cps);
        markChips(host);
        acSave();
      });
    });
    host.querySelectorAll(".gp-ac-chip[data-btn]").forEach(function (chip) {
      chip.addEventListener("click", function () {
        ac.button = chip.dataset.btn;
        markChips(host);
        acSave();
      });
    });
    host.querySelectorAll(".gp-ac-chip[data-mode]").forEach(function (chip) {
      chip.addEventListener("click", function () {
        ac.mode = chip.dataset.mode;
        markChips(host);
        acSave();
      });
    });
    rand.addEventListener("input", function () {
      ac.rand = Number(rand.value) || 0;
      randv.textContent = ac.rand + "%";
      acSave();
    });
    keyBtn.addEventListener("click", function () {
      ac.waitingKey = true;
      keyBtn.textContent = "press key";
      keyBtn.classList.add("wait");
    });
    var pickBtn = host.querySelector(".gp-ac-pick");
    pickBtn.addEventListener("click", function () {
      if (ac.picking) return;
      pickBtn.classList.add("wait");
      pickBtn.textContent = "click in game";
      if (!acArmPick()) {
        pickBtn.classList.remove("wait");
        pickBtn.textContent = "Pick target";
        try {
          if (window.ChalkleToast && window.ChalkleToast.show) window.ChalkleToast.show("Open a game first, then pick a target");
        } catch (e) { /* no toast surface */ }
      }
    });
    host.querySelector(".gp-ac-min").addEventListener("click", function () {
      host.classList.toggle("min");
    });
    host.querySelector(".gp-ac-go").addEventListener("click", acToggle);
  }

  function syncAc() {
    var wanted = clickerPolicyOn() && !!current &&
      looksLikeClicker(current.title, current.url) ||
      clickerPolicyOn() && !!current &&
      looksLikeClicker("", current.originalUrl || "");
    if (!wanted) {
      acStop();
      ac.armed = false;
      if (ac.host) ac.host.hidden = true;
      return;
    }
    buildAcPanel();
    ac.armed = true;
    if (ac.host) ac.host.hidden = false;
  }

  function clickerPolicyOn() {
    try { return localStorage.getItem(CLICKER_PREF) !== "0"; } catch (e) { return true; }
  }

  /* Hotkey: start/stop without leaving the game. Ignored while typing in
     the panel's own fields or while a capture is pending.

     Two listeners are needed: the panel lives on this document, but while
     you are actually playing, keyboard focus sits INSIDE the game iframe,
     and key events never bubble across the frame boundary. The frame-side
     listener is re-attached on every frame load, same as the pop-up guard. */
  function acHandleKey(e) {
    if (ac.waitingKey) {
      e.preventDefault();
      e.stopPropagation();
      ac.waitingKey = false;
      var k = e.key === "Escape" ? null : String(e.key || "").toLowerCase();
      if (k === " ") k = "space";
      if (k) {
        ac.hotkey = k;
        acSave();
      }
      if (ac.host) {
        var keyBtn = ac.host.querySelector(".gp-ac-key");
        if (keyBtn) {
          keyBtn.classList.remove("wait");
          keyBtn.textContent = (ac.hotkey === " " || ac.hotkey === "space") ? "space" : ac.hotkey.toUpperCase();
        }
      }
      return;
    }
    if (player.hidden || !ac.armed) return;
    var tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    var pressed = String(e.key || "").toLowerCase();
    if (pressed === " ") pressed = "space";
    if (pressed === ac.hotkey) {
      e.preventDefault();
      acToggle();
    }
  }

  document.addEventListener("keydown", acHandleKey, true);

  function guardAcHotkey() {
    var w = frameWindow();
    if (!w) return;
    try {
      if (!w.__chalkleAcHooked) {
        w.addEventListener("keydown", acHandleKey, true);
        w.__chalkleAcHooked = true;
      }
    } catch (e) { /* cross-origin frame: parent-side key still works there */ }
  }

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

  /* ---------- Launch splash (cover-art wall behind the load panel) ---------- */

  function hideSplash() {
    if (splashTimer) { clearTimeout(splashTimer); splashTimer = null; }
    if (splashEl && !splashEl.hidden) {
      splashEl.classList.add("out");
      setTimeout(function () {
        if (!splashEl) return;
        splashEl.hidden = true;
        splashEl.classList.remove("out");
        if (splashRows) splashRows.innerHTML = "";
      }, 430);
    }
  }

  function beginSplash(covers) {
    if (!splashEl || !splashRows) return;
    var list = Array.isArray(covers) ? covers.slice(0, 9) : [];
    if (!list.length) return;
    splashRows.innerHTML = "";
    for (var r = 0; r < 3; r++) {
      var row = document.createElement("div");
      row.className = "gp-splash-row";
      for (var c = 0; c < 3; c++) {
        var cell = document.createElement("div");
        cell.className = "gp-splash-cell";
        var cover = list[r * 3 + c];
        if (cover && cover.i) {
          cell.title = cover.t || "";
          cell.innerHTML = cover.i;
        }
        row.appendChild(cell);
      }
      splashRows.appendChild(row);
    }
    if (splashTitle) splashTitle.textContent = current ? current.title : "";
    splashEl.hidden = false;
    splashEl.classList.remove("out");
    if (splashTimer) clearTimeout(splashTimer);
    /* Hard cap: never hold the wall more than 6s even if the frame stalls. */
    splashTimer = setTimeout(hideSplash, 6000);
  }

  function finishLoad() {
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    hideSplash();
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
    hideSplash();
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
    guardPopups();
    guardAcHotkey();
    syncAc();
    try {
      var w = iframeEl.contentWindow;
      var d = w && w.document;
      if (d) {
        var t = d.title || "";
        var txt = d.body ? String(d.body.textContent || "") : "";
        /* The /res/ relay returns a same-origin error page for unreachable
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
    syncAc();
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

    /* Time the sitting while the frame is open. start() keeps an existing
       session for the same game, so reopening it does not reset the clock. */
    try {
      if (window.ChalklePlaytime) {
        window.ChalklePlaytime.start(current.favKey || current.url, current.title);
      }
    } catch (e) { /* playtime module missing: the player still works */ }

    if (sameSession) {
      /* Reopening the same game resumes the running frame - no restart. */
      if (loadingEl) loadingEl.hidden = true;
      if (iframeEl) iframeEl.style.opacity = "1";
      if (progressEl) progressEl.style.opacity = "0";
    } else {
      beginLoad();
      beginSplash(opts.covers);
      if (iframeEl) {
        /* Chromium enforces @allow feature names; Firefox only warns about
           the ones it doesn't implement. Keep the full list for Chromium. */
        iframeEl.setAttribute("allow", (window.ChalkleApi && ChalkleApi.iframeAllow) ? ChalkleApi.iframeAllow() : "fullscreen; picture-in-picture");
        acInvalidateTarget();
        iframeEl.src = target;
      }
    }
    if (opts.onOpen) opts.onOpen();
    return true;
  }

  function close() {
    if (player.hidden) return;
    try { if (window.ChalklePlaytime) window.ChalklePlaytime.stop(); } catch (e) { /* ignore */ }
    player.hidden = true;
    document.body.style.overflow = "";
    exitFs(true);
    hideSplash();
    if (splashEl) { splashEl.hidden = true; splashEl.classList.remove("out"); if (splashRows) splashRows.innerHTML = ""; }
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    if (relatedGrid) relatedGrid.innerHTML = "";
    /* Tear the game document down. Hiding the overlay alone leaves the
       iframe (and its audio) running in the background. Navigating the
       frame to about:blank unloads the game and stops its sound; a fresh
       open() points the frame at the new target anyway. */
    if (iframeEl) {
      iframeEl.style.opacity = "0";
      try { iframeEl.src = "about:blank"; } catch (e) { /* ignore */ }
    }
    var cb = current && current.onClose;
    current = null;
    syncAc();
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
      acInvalidateTarget();
      if (iframeEl) iframeEl.src = current.url;
    },
    /* Re-apply the pop-up policy to the frame that is open right now, so the
       Settings switch takes effect without a reload. */
    applyPopupPolicy: function () { guardPopups(); },
    popupsBlocked: function () { return popupBlocks; },
    /* Same idea for the auto clicker panel: the Settings switch applies
       live, and the matcher is exposed so tests can pin it to the catalog. */
    applyClickerPolicy: function () { syncAc(); },
    clickerArmed: function () { return ac.armed; },
    clickerRunning: function () { return ac.on; },
    isClickerGame: looksLikeClicker
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

  var splashSkip = $("gp-splash-skip");
  if (splashSkip) splashSkip.addEventListener("click", function () { hideSplash(); });

  document.addEventListener("fullscreenchange", syncFromBrowser);
  document.addEventListener("webkitfullscreenchange", syncFromBrowser);
})();