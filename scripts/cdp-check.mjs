/* Runtime smoke test: load the app headless, dismiss the cloak, and verify
 * the imported Noah catalog merges into the library and renders.
 * Usage: node scripts/cdp-check.mjs  (expects a server on 127.0.0.1:4176) */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 4176;
const DBG = 9223;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-cdp-profile";
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
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

try {
  const targets = await json(`http://127.0.0.1:${DBG}/json/list`);
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(m.params.type)) {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
    else if (m.method === "Runtime.exceptionThrown") {
      consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;
  await send("Runtime.enable");
  await send("Emulation.setCPUThrottlingRate", { rate: 1 });

  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
  await sleep(1500);

  // Dismiss the boot cloak if present, then wait for the app to boot.
  await evalJs(`(function(){var c=document.getElementById("blocked-cloak");if(c){c.click();}return !!c;})()`);
  await sleep(3500);

  const checks = {};
  checks.noahListLoaded = await evalJs(`Array.isArray(window.ChalkNoahGames) && window.ChalkNoahGames.length`);
  checks.libSize = await evalJs(`(function(){try{return JSON.parse(localStorage.getItem("chalkle-gamelib-v4")||"[]").length}catch(e){return -1}})()`);
  checks.noahInLib = await evalJs(`(function(){try{var l=JSON.parse(localStorage.getItem("chalkle-gamelib-v4")||"[]");return l.filter(function(g){return /\\/ugs\\/noah\\//.test(String(g.url||""))}).length}catch(e){return -1}})()`);
  checks.cardsOnHome = await evalJs(`document.querySelectorAll(".card, .game-card, .home-card").length`);
  // Switch to the Games view and count rendered cards there.
  await evalJs(`(function(){var t=document.querySelector('[data-tab="games"],[data-view="games"],.nav-item');if(t)t.click();return true;})()`);
  await sleep(1200);
  checks.gamesGridCards = await evalJs(`document.querySelectorAll("#games-grid .card, .games-grid .card").length || document.querySelectorAll(".card").length`);
  checks.badThumbCount = await evalJs(`Array.prototype.filter.call(document.querySelectorAll("img.thumb-art"), function(i){return i.complete && i.naturalWidth===0 && !i.classList.contains("thumb-failed");}).length`);
  checks.noahThumbSample = await evalJs(`(function(){var i=document.querySelector('img.thumb-art[src*="/noah/"]');return i?{src:i.getAttribute("src"),loaded:i.complete&&i.naturalWidth>0}:null;})()`);

  console.log(JSON.stringify(checks, null, 2));
  console.log("console errors:", consoleErrors.length ? consoleErrors.slice(0, 10) : "none");

  const ok = checks.noahListLoaded > 0 && checks.noahInLib > 0 && checks.gamesGridCards > 0 && consoleErrors.length === 0;
  console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
  process.exitCode = ok ? 0 : 1;
} finally {
  try { chrome.kill(); } catch {}
}
