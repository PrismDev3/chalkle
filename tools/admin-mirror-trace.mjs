/* Mirror the failing flow (game add -> proxy add -> delete -> reload) with
   full write tracing to catch who resurrects Cuphead / clears the del-key. */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.env.TARGET || "http://127.0.0.1:4173";
const DBG = 9341;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-mirror-trace";
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

/* Trace setItem on every document (reload included). */
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(function(){
    if (window.__tr2) return;
    window.__tr2 = true;
    window.__trLog = [];
    window.__submits = [];
    document.addEventListener('submit', (e) => {
      const f = e.target;
      const q = (n) => { const el = f.querySelector('[name="' + n + '"]'); return el ? el.value : '(none)'; };
      window.__submits.push({ formAttr: f.getAttribute('data-admin-form'), id: f.id || '', name: q('name'), url: q('url'), credit: q('credit') });
    }, true);
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k.indexOf('gamelib') !== -1) {
        let stack = '';
        try { throw new Error('x'); } catch (e) { stack = (e.stack || '').split('\\n').slice(1, 5).map(s => s.trim()).join(' <- '); }
        window.__trLog.push((k === 'chalkle-gamelib-v4-del' ? 'DEL ' : 'LIB ') + 'len=' + String(v).length + ' :: ' + stack);
      }
      return orig.call(this, k, v);
    };
  })();`,
});
await sleep(5000);

const dumpTr = async (tag, n = 20) => {
  const t = await evalJs(`window.__trLog || []`);
  console.log(`[${tag}] ${Array.isArray(t) ? t.slice(-n).join("\\n  ") : JSON.stringify(t)}`);
};

/* unlock + add game */
await evalJs(`(function(){
  document.getElementById('opt-admin').click();
  const code = document.getElementById('admin-code');
  code.value = 'jamesypoo';
  document.getElementById('admin-lock-form').requestSubmit();
  return 1;
})()`);
await sleep(400);
const GAME_TITLE = "Probe Game " + Date.now();
await evalJs(`(function(){
  const form = document.querySelector('[data-admin-form="games"]');
  form.querySelector('[name="title"]').value = ${JSON.stringify(GAME_TITLE)};
  form.querySelector('[name="url"]').value = 'https://example.com/probe';
  form.querySelector('[name="credit"]').value = 'probe dev';
  form.requestSubmit();
  return 1;
})()`);
await sleep(250);

/* add proxy */
await evalJs(`(function(){
  document.querySelector('[data-admin-tab="proxies"]').click();
  const form = document.querySelector('[data-admin-form="proxies"]');
  form.querySelector('[name="name"]').value = 'Probe Proxy ' + Date.now();
  form.querySelector('[name="url"]').value = 'https://probe.example.com';
  form.querySelector('[name="credit"]').value = 'proxy person';
  form.requestSubmit();
  return 1;
})()`);
await sleep(250);
console.log("[proxy state]", JSON.stringify(await evalJs(`(function(){
  const rows = [...document.querySelectorAll('#admin-sheet-proxies .admin-row')];
  const hits = rows.filter(r => r.textContent.includes('Probe Proxy')).map(r => ({
    hasCredit: r.textContent.includes('by proxy person'),
    name: (r.querySelector('.admin-row-name') || {}).textContent,
    editId: (r.querySelector('[data-admin-edit]') || {}).dataset ? r.querySelector('[data-admin-edit]').dataset.adminEdit : null
  }));
  let stored = [];
  try { stored = JSON.parse(localStorage.getItem('chalkle-proxies') || '[]'); } catch (e) {}
  const fresh = stored.filter(p => p && p.name && p.name.indexOf('Probe Proxy') !== -1).map(p => JSON.stringify(p));
  return { hits: hits, total: rows.length, stored: fresh, formNames: [...document.querySelectorAll('[data-admin-form="proxies"]')].map(f => f.id || f.className || 'anon') };
})()`), null, 1));

/* delete Cuphead */
await evalJs(`(function(){
  window.confirm = function () { return true; };
  document.querySelector('[data-admin-tab="games"]').click();
  const rows = [...document.querySelectorAll('#admin-sheet-games .admin-row')];
  const target = rows.find(r => r.textContent.indexOf('Cuphead') !== -1);
  if (!target) return null;
  target.querySelector('[data-admin-del]').click();
  return 1;
})()`);
await sleep(400);
console.log("[submits]", JSON.stringify(await evalJs(`window.__submits || []`), null, 1));
console.log("[after delete]");
await dumpTr("after delete", 8);

/* reload */
await send("Page.reload", { ignoreCache: true });
await sleep(9000);
console.log("[after reload state]", JSON.stringify(await evalJs(`(function(){
  const arr = JSON.parse(localStorage.getItem('chalkle-gamelib-v4') || '[]');
  return {
    games: arr.length,
    cups: arr.filter(x => x && x.title === 'Cuphead').length,
    del: JSON.parse(localStorage.getItem('chalkle-gamelib-v4-del') || '[]')
  };
})()`)));
await dumpTr("reload writes", 24);

try { chrome.kill(); } catch {}
process.exit(0);