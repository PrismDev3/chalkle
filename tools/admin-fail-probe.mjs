/* Probe the two failing admin checks with full dumps. */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.env.TARGET || "http://127.0.0.1:4173";
const DBG = 9311;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-admin-fail-probe";
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=1500,950", "--no-proxy-server",
  ORIGIN + "/index.html",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
setTimeout(() => { console.log("WATCHDOG"); process.exit(2); }, 90000);

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

/* unlock */
await evalJs(`(function(){
  document.getElementById('opt-admin').click();
  const code = document.getElementById('admin-code');
  code.value = 'jamesypoo';
  document.getElementById('admin-lock-form').requestSubmit();
  return 1;
})()`);
await sleep(400);

/* add a proxy and dump the sheet */
await evalJs(`(function(){
  document.querySelector('[data-admin-tab="proxies"]').click();
  const form = document.querySelector('[data-admin-form="proxies"]');
  form.querySelector('[name="name"]').value = 'Probe Px ' + Date.now();
  form.querySelector('[name="url"]').value = 'https://probe.example.com';
  form.querySelector('[name="credit"]').value = 'proxy person';
  form.requestSubmit();
  return 1;
})()`);
await sleep(500);

console.log("== proxy sheet rows (outerHTML trimmed) ==");
const rows = await evalJs(`(function(){
  return [...document.querySelectorAll('#admin-sheet-proxies .admin-row')]
    .filter(r => r.textContent.includes('Probe Px'))
    .map(r => r.outerHTML.slice(0, 700));
})()`);
for (const r of (rows || [])) { console.log(r); console.log("---"); }

console.log("== localStorage proxies after add ==");
const px = await evalJs(`(function(){
  const raw = localStorage.getItem('chalkle-proxies') || '[]';
  const arr = JSON.parse(raw);
  return arr.filter(x => x.name.indexOf('Probe Px') !== -1).map(x => JSON.stringify(x));
})()`);
for (const p of (px || [])) console.log(p);

/* now delete a seed game, instrumenting setItem to trace what saveLib writes */
console.log("== delete flow ==");
const delRes = await evalJs(`(function(){
  window.__setLog = [];
  const orig = Storage.prototype.setItem.bind(localStorage);
  localStorage.setItem = function (k, v) {
    window.__setLog.push(k + " len=" + String(v).length + " head=" + String(v).slice(0, 60));
    return orig(k, v);
  };
  window.confirm = function () { return true; };
  document.querySelector('[data-admin-tab="games"]').click();
  const rows = [...document.querySelectorAll('#admin-sheet-games .admin-row')];
  const target = rows.find(r => !r.textContent.includes('Probe'));
  if (!target) return { err: 'no row' };
  const del = target.querySelector('[data-admin-del]');
  const title = target.querySelector('.admin-row-name').textContent;
  del.click();
  return { title: title, writes: window.__setLog.slice(-8) };
})()`);
console.log(JSON.stringify(delRes, null, 1));
await sleep(300);
console.log(JSON.stringify(await evalJs(`(function(){
  const raw = localStorage.getItem('chalkle-gamelib-v4') || '[]';
  const arr = JSON.parse(raw);
  const delRaw = localStorage.getItem('chalkle-gamelib-v4-del') || '[]';
  const dels = JSON.parse(delRaw);
  const delTitle = ${JSON.stringify(null)};
  return { delCount: dels.length, delSamples: dels.slice(0, 5), deletedStillInArr: (function(){ const d = dels[0]; return d ? arr.some(x => x && x.title === d) : false; })() };
})()`), null, 1));

try { chrome.kill(); } catch {}
process.exit(0);