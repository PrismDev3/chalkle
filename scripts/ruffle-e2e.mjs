/* Flash/Ruffle E2E: loads 3 different Flash games via the site's REAL
 * ruffleHtml launcher (src/games.js executed in the page), and asserts for
 * each: Ruffle API ready, player element mounted, no ChunkLoadError /
 * WASM / createPlayer errors. */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 4176;
const DBG = 9223;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-ruffle-profile";
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=1280,800",
  "about:blank",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
setTimeout(() => { console.log("WATCHDOG: timed out"); process.exit(2); }, 240000);

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
    errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
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

const GAMES = [
  "/game-builds/flash/swf/Age-of-War.swf",
  "/game-builds/flash/swf/Bloxors.swf",
  "/game-builds/flash/swf/3_foot_ninja.swf",
];

let allOk = true;
for (const swf of GAMES) {
  errors.length = 0;
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
  await sleep(1200);
  const hasFn = await evalJs(`(function(){
    return new Promise(function(resolve){
      if (typeof ruffleHtml === 'function') return resolve(true);
      var s = document.createElement('script');
      s.src = '/src/games.js';
      s.onload = function(){ resolve(typeof ruffleHtml === 'function'); };
      s.onerror = function(){ resolve(false); };
      document.head.appendChild(s);
    });
  })()`);
  if (!hasFn) { console.log(swf + ": FAIL - ruffleHtml unavailable"); allOk = false; continue; }

  await evalJs(`(function(){
    var html = ruffleHtml(${JSON.stringify(swf)});
    var b = new Blob([html], {type: 'text/html'});
    return new Promise(function(resolve){
      var f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:700px;border:0';
      f.src = URL.createObjectURL(b);
      f.onload = function(){ setTimeout(function(){ resolve(true); }, 14000); };
      document.body.appendChild(f);
      window.__ruffleFrame = f;
    });
  })()`);

  const state = await evalJs(`(function(){
    try {
      var f = window.__ruffleFrame;
      var w = f.contentWindow, d = f.contentDocument;
      var api = w.RufflePlayer;
      var apiOk = !!(api && typeof api.newest === 'function');
      var player = d ? d.querySelector('ruffle-player') : null;
      return { apiOk: apiOk, playerMounted: !!player, hasSwf: !!(player && player.innerHTML !== undefined) };
    } catch (e) { return { err: String(e) }; }
  })()`);

  const gameErrors = errors.filter(e =>
    /ChunkLoadError|Failed to load Ruffle WASM|createPlayer is not a function|core\.ruffle/i.test(e));
  const ok = state && state.apiOk && state.playerMounted && gameErrors.length === 0;
  console.log(`${swf}: ${ok ? "PASS" : "FAIL"} | api=${state && state.apiOk} player=${state && state.playerMounted} badErrors=${gameErrors.length}`);
  if (gameErrors.length) console.log("   errors:", gameErrors.slice(0, 3));
  if (!ok) { allOk = false; if (!state || state.err) console.log("   state:", JSON.stringify(state)); }
}
console.log(allOk ? "RUFFLE E2E ALL PASS" : "RUFFLE E2E FAILURES");
process.exitCode = allOk ? 0 : 1;
