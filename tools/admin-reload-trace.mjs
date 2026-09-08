/* Trace localStorage writes across reload to find who re-adds Cuphead / clears del. */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.env.TARGET || "http://127.0.0.1:4173";
const DBG = 9331;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-admin-trace";
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=1500,950", "--no-proxy-server",
  ORIGIN + "/index.html",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
setTimeout(() => { console.log("WATCHDOG"); process.exit(2); }, 120000);

await sleep(2500);
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
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 200) };
  return r.result?.result?.value;
};
await send("Page.enable");
await send("Runtime.enable");
await sleep(5000);

/* Inject a setItem logger on EVERY new document (including the reload). */
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(function(){
    if (window.__traceInstalled) return;
    window.__traceInstalled = true;
    window.__traceLog = [];
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k.indexOf('gamelib') !== -1) {
        let stack = '';
        try { throw new Error('trace'); } catch (e) { stack = (e.stack || '').split('\\n').slice(1, 4).join(' | '); }
        window.__traceLog.push(k + ' len=' + String(v).length + ' :: ' + stack);
      }
      return orig.call(this, k, v);
    };
  })();`,
});

await sleep(1500);
/* delete Cuphead via admin */
const delTitle = await evalJs(`(function(){
  document.getElementById('opt-admin').click();
  const code = document.getElementById('admin-code');
  code.value = 'jamesypoo';
  document.getElementById('admin-lock-form').requestSubmit();
  return 1;
})()`);
await sleep(400);
await evalJs(`(function(){
  window.confirm = function () { return true; };
  const rows = [...document.querySelectorAll('#admin-sheet-games .admin-row')];
  const target = rows.find(r => r.textContent.indexOf('Cuphead') !== -1);
  if (!target) return null;
  target.querySelector('[data-admin-del]').click();
  return 1;
})()`);
await sleep(500);
console.log("[after delete]", JSON.stringify(await evalJs(`(function(){
  return {
    del: JSON.parse(localStorage.getItem('chalkle-gamelib-v4-del') || '[]'),
    trace: window.__traceLog.slice(-6)
  };
})()`), null, 1));

/* reload and watch the trace grow */
await send("Page.reload", { ignoreCache: true });
await sleep(9000);
console.log("[after reload]", JSON.stringify(await evalJs(`(function(){
  return {
    games: JSON.parse(localStorage.getItem('chalkle-gamelib-v4') || '[]').length,
    cups: JSON.parse(localStorage.getItem('chalkle-gamelib-v4') || '[]').filter(x => x && x.title === 'Cuphead').length,
    del: JSON.parse(localStorage.getItem('chalkle-gamelib-v4-del') || '[]'),
    trace: window.__traceLog.slice(-14)
  };
})()`), null, 1));

try { chrome.kill(); } catch {}
process.exit(0);