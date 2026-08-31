/* Chalkle boot intro. Full-screen game-station boot, once per session, skippable,
   respectful of the user's reduced-motion setting. */

(function () {
  "use strict";

  var BOOT_LINES = [
    "insert cartridge: chalkle-1.0",
    "loading storage… ok",
    "gathering controllers… ok",
    "warming player… ok",
    "spinning mirrors… ok",
    "ready"
  ];

  var DURATION = 2400;          /* total boot, ms */
  var LOG_STEP = 290;           /* ms between boot log lines */
  var FIRST_LOG = 720;          /* when the first line appears */

  var reduced = false;
  try {
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      document.documentElement.classList.contains("motion-off");
  } catch (e) { /* keep default */ }

  var boot = document.getElementById("boot");
  var progress = document.getElementById("boot-progress");
  var logEl = document.getElementById("boot-log");
  var skipEl = document.getElementById("boot-skip");
  var appEl = document.getElementById("app");

  if (!boot || !appEl) return;

  /* Build the bubble wordmark inside the boot screen too (letters pop in). */
  var logo = boot.querySelector(".boot-logo");
  if (logo) logo.innerHTML = buildLogo();

  var finished = false;
  var timers = [];
  var start = performance.now();

  function buildLogo() {
    var colors = ["#4285f4", "#ea4335", "#fbbc05", "#4285f4", "#34a853", "#ea4335", "#4285f4"];
    var shadows = ["#1557b0", "#b31412", "#e37400", "#1557b0", "#0d7734", "#b31412", "#1557b0"];
    function rgba(hex, a) {
      var n = parseInt(String(hex).replace("#", ""), 16);
      return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
    }
    var letters = "chalkle".split("");
    return letters.map(function (ch, i) {
      return (
        '<span class="bubble-letter" style="color:' + colors[i] +
        ";text-shadow:0 4px 0 " + shadows[i] +
        ",0 8px 12px " + rgba(colors[i], 0.4) +
        ';animation-delay:' + (0.25 + i * 0.07) + 's;">' + ch + "</span>"
      );
    }).join("");
  }

  function tick(now) {
    if (finished) return;
    var t = Math.min(1, (now - start) / DURATION);
    if (progress) progress.style.width = (t * 100).toFixed(1) + "%";
    if (t < 1) requestAnimationFrame(tick);
  }

  function lineAt(i) {
    if (logEl && BOOT_LINES[i]) logEl.textContent = BOOT_LINES[i];
  }

  function finish() {
    if (finished) return;
    finished = true;
    timers.forEach(clearTimeout);
    if (logEl) {
      logEl.textContent = "ready";
      logEl.classList.add("ready");
    }
    if (boot) boot.classList.add("done");

    setTimeout(function () {
      if (appEl) appEl.hidden = false;
      if (boot) {
        boot.style.transition = "opacity 450ms ease";
        boot.style.opacity = "0";
        boot.style.pointerEvents = "none";
      }
      setTimeout(function () {
        if (boot) boot.remove();
        dispatchReady();
      }, 500);
    }, 320);
  }

  function dispatchReady() {
    window.__chalkleBootDone = true;
    try {
      window.dispatchEvent(new CustomEvent("chalkle-boot-done"));
    } catch (e) { /* ignore */ }
  }

  /* Reduced motion: skip straight to ready, no transitions. */
  if (reduced || !window.requestAnimationFrame) {
    appEl.hidden = false;
    if (boot) boot.remove();
    dispatchReady();
    return;
  }

  /* Progress bar */
  requestAnimationFrame(tick);

  /* Boot log lines */
  for (var i = 0; i < BOOT_LINES.length; i++) {
    timers.push(setTimeout(function (idx) {
      return function () { lineAt(idx); };
    }(i), FIRST_LOG + i * LOG_STEP));
  }

  /* Auto-finish */
  timers.push(setTimeout(finish, DURATION));

  /* Manual skip */
  if (skipEl) {
    skipEl.addEventListener("click", finish);
    timers.push(setTimeout(function () {
      skipEl.style.opacity = "1";
    }, 900));
  }

  /* Don't skip when the user is simply clicking around; only the skip label lets you out early. */
})();