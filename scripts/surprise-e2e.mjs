/* Surprise-me e2e: boots the real app headless (CDP), clicks the Surprise me
   button, and verifies a game actually opened in the dedicated player - plus
   a repeat-click check that two draws in a row never picked the same game.

   Expects the Chalkle server on 127.0.0.1:4173 (same as sweep-views).
   Run: node scripts/surprise-e2e.mjs */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";

const PORT = 4173;
/* Free debug port per run: a hardcoded port collided when run N's chrome was
   still releasing it while run N+1 started, killing every other run. */
const DBG = await new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  s.on("error", rej);
});
/* First Chrome/Chromium we can find: works on Windows dev boxes and the
   ubuntu CI runner (which installs chromium via apt) alike. */
function findChrome() {
  const candidates = process.env.CHALKLE_CHROME
    ? [process.env.CHALKLE_CHROME]
    : process.platform === "win32"
      ? [
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
          process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
        ]
      : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch {}
  }
  throw new Error("no Chrome/Chromium found (set CHALKLE_CHROME to override)");
}
const CHROME = findChrome();
/* Unique profile per run: a shared dir made run N+1 crash with EBUSY while
   run N's chrome was still releasing files on Windows. */
const profile = fs.mkdtempSync("/tmp/chalkle-surprise-" + process.pid + "-");
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  /* CI runners (GH sets CI=true) need the sandbox off and a bigger shm;
     local runs keep Chrome's defaults. */
  ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
  `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${profile}`,
  "--headless=new",
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--force-prefers-reduced-motion",
  "--window-size=1440,900",
  "about:blank",
], { stdio: "ignore" });

async function json(url) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error("no CDP: " + url);
}

let exitCode = 1;
try {
  const targets = await json(`http://127.0.0.1:${DBG}/json/list`);
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const ctxIds = new Set();
  const ctxFrame = new Map(); /* execution context id -> owning frame id */
  let mainFrameId = null; /* set once the frame tree arrives; events can beat it */
  /* Error-ownership policy: errors naming first-party files are always the
     app's; unattributed errors count only before the first launch - after
     that they come from whatever random game (Ruffle fetching a dead swf,
     portal scripts, ...) is running and are not Chalkle's to own. */
  let firstLaunchStarted = false;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(m.params.type)
             && ctxIds.has(m.params.executionContextId)) {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }    else if (m.method === "Runtime.exceptionThrown") {
    /* Unlike consoleAPICalled, exceptionThrown carries no context id - the
       only ownership signal is the script URL. First-party app files always
       count; anything else counts only pre-launch (see the policy above). */
    const d = m.params.exceptionDetails;
    const url = String(d.url || "");
    const firstParty = /\/(index\.html|src\/|sw\.js)/.test(url);
    if (firstParty || (!firstLaunchStarted && !url)) {
      consoleErrors.push(d.exception?.description || d.text);
    }
  }
  else if (m.method === "Runtime.executionContextCreated") {
    /* Track every context with its owning frame; only MAIN-frame contexts
       count toward errors (games in the player iframe log their own noise:
       wasm MIME fallbacks, Ruffle failures - not Chalkle's to own). */
    ctxFrame.set(m.params.context.id, m.params.context.auxData && m.params.context.auxData.frameId);
    if (mainFrameId && m.params.context.auxData && m.params.context.auxData.frameId === mainFrameId) {
      ctxIds.add(m.params.context.id);
    }
  }
  else if (m.method === "Runtime.executionContextDestroyed") {
    ctxIds.delete(m.params.executionContextId);
  }
  else if (m.method === "Runtime.executionContextsCleared") {
    ctxIds.clear();
    ctxFrame.clear();
  }
  };
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;
  await send("Runtime.enable");
  await send("Page.enable");
  const frameTree = await send("Page.getFrameTree");
  mainFrameId = frameTree.result?.frame?.id;
  /* Contexts that arrived before we knew the main frame id. */
  for (const [ctxId, frameId] of ctxFrame) {
    if (frameId === mainFrameId) ctxIds.add(ctxId);
  }

  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
  await sleep(1500);
  await evalJs(`(function(){var c=document.getElementById("blocked-cloak");if(c){c.click();}return !!c;})()`);
  await sleep(3500);

  const results = [];
  const check = (name, ok, detail) => results.push((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  (" + detail + ")" : ""));

  /* The button must exist and end up visible on the Games view. Switch views
     through the real sidebar nav item - the .nav-item buttons are what the
     app's delegated nav handler matches; sections themselves are not
     clickable triggers. Visibility is polled because the view render is
     async - reading offsetParent in the same tick as the click is a race. */
  const switched = await evalJs(`(function(){
    var t = document.querySelector('button.nav-item[data-view="games"]');
    if (!t) return false;
    t.click();
    return true;
  })()`);
  let btnOk = "no games view";
  if (switched) {
    btnOk = "missing";
    for (let i = 0; i < 40 && btnOk !== "visible"; i++) {
      btnOk = await evalJs(`(function(){
        var b = document.getElementById("surprise-btn");
        return !b ? "missing" : (b.offsetParent !== null ? "visible" : "hidden");
      })()`);
      if (btnOk !== "visible") await sleep(250);
    }
  }
  check("surprise button exists and is visible on Games", btnOk === "visible", String(btnOk));

  const disabled = await evalJs(`(function(){
    var b = document.getElementById("surprise-btn");
    return !b || b.disabled || b.getAttribute("aria-disabled") === "true";
  })()`);
  check("the library is loaded and the button is enabled", disabled === false, "disabled=" + disabled);

  /* One click must open the game player (or fall back to a real tab). The
     launch pipeline (proxy picking, URL audit) is async before ChalkleGame
     Player.open() flips #game-player visible, so poll instead of sleeping.
     A random draw can be a heavy external portal (gamedistribution etc.)
     whose launch may never resolve inside a sandboxed CI network, so a draw
     gets a 60s budget and up to 4 attempts. A LOCAL draw that fails to open
     is a real failure; an unresolvable external one is a SKIP. */
  const isLocalKey = (k) => !k || k.charAt(0) === "/";
  const tag = (name, ok, detail) => {
    if (ok === "SKIP") results.push("SKIP  " + name + "  (" + detail + ")");
    else check(name, ok, detail);
  };
  let opened = false, player = null, key1 = null;
  for (let attempt = 0; attempt < 4 && !opened; attempt++) {
    if (attempt > 0) console.log("retrying draw (attempt " + (attempt + 1) + ", previous: " + key1 + ")");
    firstLaunchStarted = true;
    await evalJs("document.getElementById(\"surprise-btn\").click()");
    for (let i = 0; i < 240; i++) {
      player = await evalJs(`(function(){
        var p = document.getElementById("game-player");
        return {
          open: !!p && !p.hidden,
          title: (document.getElementById("gp-title") || {}).textContent || "",
          frame: !!document.querySelector("#game-player iframe")
        };
      })()`);
      if (player && player.open && player.title && player.title !== "Playing") { opened = true; break; }
      await sleep(250);
    }
    key1 = await evalJs("window.__lastSurpriseKey");
  }
  const localDraw = isLocalKey(key1);
  const verdict = opened ? true : (localDraw ? false : "SKIP");
  tag("clicking Surprise me opened the game player", verdict, JSON.stringify(player) + "  key=" + key1);
  tag("the player shows a real game title", verdict, String(player && player.title));

  /* A second click right after must not redraw the same game: pickSurprise
     excludes the last key. Asserted through the __lastSurpriseKey hook, not
     cosmetic titles; the key-level rule itself is pinned by the unit suite.
     The key is assigned synchronously in surpriseMe, the launch is async. */
  const secondClick = await evalJs(`(function(){
    try {
      document.getElementById("surprise-btn").click();
      return "ok";
    } catch (e) { return "error: " + e.message; }
  })()`);
  let key2 = null;
  for (let i = 0; i < 30; i++) {
    key2 = await evalJs("window.__lastSurpriseKey");
    if (key2 && key2 !== key1) break;
    await sleep(150);
  }
  check("a second surprise click does not error", secondClick === "ok", String(secondClick));
  check("the second draw picked a different game", !!key2 && key2 !== key1, key1 + " -> " + key2);
  let playerStillOk = false;
  for (let i = 0; i < 60; i++) {
    playerStillOk = await evalJs(`(function(){
      var p = document.getElementById("game-player");
      return !!p && !p.hidden;
    })()`);
    if (playerStillOk) break;
    await sleep(250);
  }
  /* If the first draw itself was skipped (unresolvable external), there is no
     open player to keep up - skip rather than fail the same environment. */
  tag("the player is still up after the second click", verdict === true ? playerStillOk : "SKIP", String(playerStillOk));

  /* Deterministically close the player: the keyboard tests need Home's
     search input focusable, which it never is under the overlay. */
  await evalJs(`(function(){
    var p = document.getElementById("game-player");
    if (p && !p.hidden) { var b = document.getElementById("gp-back"); if (b) b.click(); }
    return true;
  })()`);
  let playerClosed = false;
  for (let i = 0; i < 40 && !playerClosed; i++) {
    playerClosed = await evalJs(`document.getElementById("game-player").hidden`);
    if (!playerClosed) await sleep(150);
  }

  /* The field guard runs FIRST, while nothing is in flight: an S press while
     the search input is focused must type into it, never launch. Focus is
     asserted before the key press - a silent focus failure (e.g. under the
     still-open player overlay) would otherwise look like a guard win. */
  var guardSkippedFocus = false;
  if (verdict !== true) {
    tag("S typed in a field never launches", "SKIP", "first draw was skipped");
  } else if (!playerClosed) {
    check("S typed in a field never launches", false, "the player would not close");
  } else {
    await evalJs(`(function(){
      var t = document.querySelector('button.nav-item[data-view="home"]');
      if (t) t.click();
      return true;
    })()`);
    /* The view render is async - the input cannot take focus while its
       section is still hidden, so wait until it is actually visible. */
    let homeReady = false;
    for (let i = 0; i < 40 && !homeReady; i++) {
      homeReady = await evalJs(`(function(){
        var i = document.getElementById("home-search-input");
        return !!i && i.offsetParent !== null;
      })()`);
      if (!homeReady) await sleep(150);
    }
    if (!homeReady) {
      check("S typed in a field never launches", false, "the home search input never became visible");
      var guardSkippedFocus = true;
    }
    if (!guardSkippedFocus) {
      await evalJs(`(function(){
        var i = document.getElementById("home-search-input");
        i.focus();
        i.value = "";
        return true;
      })()`);
    }
    const focused = !guardSkippedFocus && await evalJs(`!!document.activeElement && document.activeElement.id === "home-search-input"`);
    if (!focused) {
      if (!guardSkippedFocus) check("S typed in a field never launches", false, "could not focus the search input");
    } else {
      await send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 83, code: "KeyS", key: "s", text: "s" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 83, code: "KeyS", key: "s" });
      await sleep(300);
      const guard = await evalJs(`(function(){
        var i = document.getElementById("home-search-input");
        return { typed: i.value, key: window.__lastSurpriseKey, stillFocused: document.activeElement === i };
      })()`);
      check("S typed in a field never launches", guard.typed === "s" && guard.key === key2 && guard.stillFocused, JSON.stringify(guard));
    }
    await evalJs(`(function(){
      var i = document.getElementById("home-search-input");
      i.blur();
      i.value = "";
      return true;
    })()`);
  }

  /* The S shortcut must work through real CDP key events. Dispatched keys
     go to the focused node - body here, the input blurred above - so the
     field guard does not fire. The key changes synchronously in surpriseMe. */
  const shortcutKey0 = key2;
  for (const c of ["KeyS", "ShiftS"]) {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown", windowsVirtualKeyCode: 83, code: "KeyS",
      key: c === "KeyS" ? "s" : "S", text: c === "KeyS" ? "s" : "S",
      modifiers: c === "KeyS" ? 0 : 8 /* Shift */
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp", windowsVirtualKeyCode: 83, code: "KeyS",
      key: c === "KeyS" ? "s" : "S", modifiers: c === "KeyS" ? 0 : 8
    });
  }
  let shortcutFired = false;
  for (let i = 0; i < 20; i++) {
    const k = await evalJs("window.__lastSurpriseKey");
    if (k && k !== shortcutKey0) { shortcutFired = true; break; }
    await sleep(150);
  }
  check("the S shortcut rolls a surprise", shortcutFired, "from " + shortcutKey0);

  /* The picker itself must be reachable and sane in the live page. */
  const libSize = await evalJs(`(JSON.parse(localStorage.getItem("chalkle-gamelib-v4")||"[]")).length`);
  check("the seeded library is non-trivial", libSize > 50, String(libSize));

  check("no console errors during the run", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));

  results.forEach((r) => console.log(r));
  exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
  console.log(exitCode === 0 ? "SURPRISE E2E OK" : "SURPRISE E2E FAILED");
  /* Kill only OUR headless test chrome: identify it by the test profile dir
     on its command line, so the user's real browser is never a target. */
  try {
    spawn("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*chalkle-surprise-*' } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { stdio: "ignore" }).on("error", () => {}); /* non-fatal without powershell */
  } catch {}
} catch (e) {
  console.error("E2E harness error:", e && e.message || e);
  exitCode = 1;
} finally {
  try { chrome.kill(); } catch {}
  process.exit(exitCode);
}
