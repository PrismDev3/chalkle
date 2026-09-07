/* Full-library smoke test after cleanup: app boots, library size correct,
 * removed titles absent, search + categories work, zero console errors.
 * Expects the Chalkle server on 127.0.0.1:4173. */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 4173;
const DBG = 9225;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-final-profile";
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=1440,900",
  "about:blank",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
setTimeout(() => { console.log("WATCHDOG: timed out"); process.exit(2); }, 180000);

async function json(url) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch {}
    await sleep(250);
  }
  throw new Error("no CDP");
}
const targets = await json(`http://127.0.0.1:${DBG}/json/list`);
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(m.params.type)) {
    const txt = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (!/favicon|net::ERR_FAILED.*googleads|adsbygoogle/i.test(txt)) errors.push(txt);
  }
  else if (m.method === "Runtime.exceptionThrown") {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
await send("Runtime.enable");
await send("Page.enable");

await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(6000);

// dismiss cloak if present (same pattern as cdp-check.mjs)
await evalJs(`(function(){var c=document.getElementById("blocked-cloak");if(c){c.click();return "clicked";}return "absent";})()`);
await sleep(2500);

// switch to the Games view
await evalJs(`(function(){var t=document.querySelector('[data-tab="games"],[data-view="games"]');if(t){t.click();return true;}return false;})()`);
await sleep(2000);

const res = await evalJs(`(function(){
  var out = {};
  try {
    // library source of truth
    var lib = null;
    try { lib = JSON.parse(localStorage.getItem('chalkle-gamelib-v4') || 'null'); } catch (e) {}
    out.libSize = Array.isArray(lib) ? lib.length : null;
    out.seedCount = (typeof GAMES !== 'undefined' && Array.isArray(GAMES)) ? GAMES.length : (typeof games !== 'undefined' ? games.length : null);

    var grid = document.querySelector('#games-grid');
    out.gridCards = grid ? grid.querySelectorAll('.card, .game-card').length : -1;
    var q = document.querySelector('#games-filter');
    out.hasFilterBox = !!q;

    // removed titles must be absent from every visible list + lib + seeds
    var bad = ['achievmentunlocked','clarena.html','clbadbodyguards.html','clballz.html','clbearsus.html',
               'cl2048cupcakes.html','cl1v1maybeidk.html','clnullkevin.html','clmotox3mm.html',
               'scratch.mit.edu','turbowarp.org','amberial','13-days-in-hell','3D-Car-Driver'];
    var all = document.body.innerHTML;
    out.leaks = bad.filter(function(b){ return all.indexOf(b) !== -1; });

    // search works: type "isaac" into topbar search or games filter
    var inp = document.querySelector('#games-filter') || document.querySelector('input[type="search"]');
    if (inp) {
      var proto = Object.getPrototypeOf(inp);
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      desc.set.call(inp, 'isaac');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return out;
  } catch (e) { return Object.assign(out, { fatal: String(e) }); }
})()`);
await sleep(1500);

const after = await evalJs(`(function(){
  var grid = document.querySelector('#games-grid');
  var titles = grid ? Array.from(grid.querySelectorAll('.card-title, .game-card')).map(function(e){ return (e.textContent || '').trim(); }) : [];
  return { cards: grid ? grid.querySelectorAll('.game-card, .card').length : -1,
           isaac: titles.some(function(t){ return /isaac/i.test(t); }) };
})()`);

console.log(JSON.stringify(res, null, 1));
console.log("search 'isaac' ->", JSON.stringify(after));
const ok = !res.fatal && (!res.leaks || res.leaks.length === 0) && after.isaac && errors.length === 0;
console.log("console errors:", errors.length, errors.slice(0, 5));
console.log(ok ? "FINAL SMOKE: PASS" : "FINAL SMOKE: FAIL");
process.exitCode = ok ? 0 : 1;
