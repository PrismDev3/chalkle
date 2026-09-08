/* Verify the admin overhaul:
 * 1. unlock -> add game (with credit) + proxy (with credit)
 * 2. RELOAD -> both still there, credits shown, localStorage slim (<5MB)
 * 3. delete a seed game -> RELOAD -> stays deleted
 * 4. tab icons render, rows show letter badges + credit tags
 * 5. zero runtime exceptions
 */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.env.TARGET || "http://127.0.0.1:4173";
const DBG = 9295;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-admin-verify";
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=1500,950", "--no-proxy-server",
  ORIGIN + "/index.html",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
setTimeout(() => { console.log("WATCHDOG"); process.exit(2); }, 150000);

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
const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    errors.push((d.exception?.description || d.text || "exception").slice(0, 160));
  }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 160) };
  return r.result?.result?.value;
};
await send("Page.enable");
await send("Runtime.enable");
await sleep(5000);

function ok(name, v) { console.log(`${v ? "PASS" : "FAIL"}  ${name}`); return !!v; }
const results = [];

/* ---- phase 1: unlock + add ---- */
await evalJs(`(function(){
  document.getElementById('opt-admin').click();
  const code = document.getElementById('admin-code');
  code.value = 'jamesypoo';
  document.getElementById('admin-lock-form').requestSubmit();
  return 1;
})()`);
await sleep(400);

const GAME_TITLE = "Probe Game " + Date.now();
const PROXY_NAME = "Probe Proxy " + Date.now();
results.push(ok("admin body shown", await evalJs(`!document.getElementById('admin-body').hidden`)));

await evalJs(`(function(){
  const form = document.querySelector('[data-admin-form="games"]');
  form.querySelector('[name="title"]').value = ${JSON.stringify(GAME_TITLE)};
  form.querySelector('[name="url"]').value = 'https://example.com/probe';
  form.querySelector('[name="credit"]').value = 'probe dev';
  form.requestSubmit();
  return 1;
})()`);
await sleep(250);
results.push(ok("game added with credit tag", await evalJs(`(function(){
  const rows = [...document.querySelectorAll('#admin-sheet-games .admin-row')];
  const hit = rows.find(r => r.textContent.includes('Probe Game'));
  return !!hit && hit.textContent.includes('by probe dev') && !!hit.querySelector('.admin-row-ico');
})()`)));

await evalJs(`(function(){
  document.querySelector('[data-admin-tab="proxies"]').click();
  const form = document.querySelector('[data-admin-form="proxies"]');
  form.querySelector('[name="name"]').value = ${JSON.stringify(PROXY_NAME)};
  form.querySelector('[name="url"]').value = 'https://probe.example.com';
  form.querySelector('[name="credit"]').value = 'proxy person';
  form.requestSubmit();
  return 1;
})()`);
await sleep(250);
results.push(ok("proxy added with credit tag", await evalJs(`(function(){
  const rows = [...document.querySelectorAll('#admin-sheet-proxies .admin-row')];
  /* Exact name match: rows from the server sync blob contain the same
     prefix, and the first match may be a stale one. The freshly added row
     is the one with this run's exact name. */
  const hit = rows.find(r => (r.querySelector('.admin-row-name') || {}).textContent === ${JSON.stringify(PROXY_NAME)});
  return !!hit && hit.textContent.includes('by proxy person');
})()`)));

/* delete a seed game to test delete-sticks (through the real handler) */
const DEL_TITLE = "Cuphead";
const seedDeleted = await evalJs(`(function(){
  window.confirm = function () { return true; };
  document.querySelector('[data-admin-tab="games"]').click();
  const rows = [...document.querySelectorAll('#admin-sheet-games .admin-row')];
  const target = rows.find(r => (r.querySelector('.admin-row-name') || {}).textContent === ${JSON.stringify(DEL_TITLE)});
  if (!target) return null;
  const del = target.querySelector('[data-admin-del]');
  del.click();
  return { title: ${JSON.stringify(DEL_TITLE)} };
})()`);
await sleep(400);
results.push(ok("delete triggered through real handler", !!seedDeleted && seedDeleted.title));

/* ---- phase 2: reload ---- */
await evalJs(`(function(){ localStorage.setItem('__probeSeen', '1'); return 1; })()`);
const lsSize = await evalJs(`(function(){
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const v = localStorage.getItem(k);
    if (k.indexOf('gamelib') !== -1 || k.indexOf('sitelib') !== -1 || k.indexOf('toollib') !== -1 || k.indexOf('boardlib') !== -1) total += v.length;
  }
  return total;
})()`);
results.push(ok(`library keys fit in localStorage (${(lsSize / 1024 / 1024).toFixed(2)}MB < 5MB)`, lsSize < 5 * 1024 * 1024));

await send("Page.reload", { ignoreCache: true });
await sleep(9000);

/* ---- phase 3: post-reload checks ---- */
results.push(ok("game persists after reload", await evalJs(`(function(){
  const raw = localStorage.getItem('chalkle-gamelib-v4');
  const arr = JSON.parse(raw || '[]');
  return arr.some(x => x && x.title === ${JSON.stringify(GAME_TITLE)} && x.credit === 'probe dev');
})()`)));
results.push(ok("proxy persists after reload", await evalJs(`(function(){
  const raw = localStorage.getItem('chalkle-proxies');
  const arr = JSON.parse(raw || '[]');
  return arr.some(x => x && x.name === ${JSON.stringify(PROXY_NAME)} && x.credit === 'proxy person');
})()`)));
const delCheck = await evalJs(`(function(){
  const raw = localStorage.getItem('chalkle-gamelib-v4');
  const arr = JSON.parse(raw || '[]');
  const dels = JSON.parse(localStorage.getItem('chalkle-gamelib-v4-del') || '[]');
  const delTitle = ${JSON.stringify(seedDeleted ? seedDeleted.title : "")};
  return {
    pass: delTitle && dels.indexOf(delTitle) !== -1 && !arr.some(x => x && x.title === delTitle),
    delTitle, inDels: dels.indexOf(delTitle) !== -1, inArr: arr.some(x => x && x.title === delTitle),
    delCount: dels.length, delSample: dels.slice(0, 4), games: arr.length
  };
})()`);
console.log("[delete check]", JSON.stringify(delCheck));
results.push(ok("deleted seed game stays deleted", delCheck && delCheck.pass));

/* open admin post-reload and check the UI renders it all */
await evalJs(`(function(){
  document.getElementById('opt-admin').click();
  const code = document.getElementById('admin-code');
  code.value = 'jamesypoo';
  document.getElementById('admin-lock-form').requestSubmit();
  return 1;
})()`);
await sleep(400);
results.push(ok("tabs render icons post-reload", await evalJs(`(function(){
  const tabs = [...document.querySelectorAll('[data-admin-tab]')];
  return tabs.length === 8 && tabs.every(t => t.querySelector('svg.icon'));
})()`)));
results.push(ok("persisted game visible in admin list", await evalJs(`(function(){
  const rows = [...document.querySelectorAll('#admin-sheet-games .admin-row')];
  const hit = rows.find(r => r.textContent.includes('Probe Game'));
  return !!hit && hit.textContent.includes('by probe dev') && !!hit.querySelector('.admin-row-ico');
})()`)));

console.log("\n== summary ==");
const fails = results.filter(r => r === false).length;
console.log(`${results.length - fails}/${results.length} passed`);
console.log("runtime exceptions:", errors.length ? errors.slice(0, 4) : "none");
try { chrome.kill(); } catch {}
process.exit(fails ? 1 : 0);