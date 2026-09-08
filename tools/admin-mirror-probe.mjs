/* Mirror admin-verify.mjs exactly, dumping localStorage state at each step. */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.env.TARGET || "http://127.0.0.1:4173";
const DBG = 9321;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-admin-mirror";
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

const dump = async (tag) => {
  const s = await evalJs(`(function(){
    const g = JSON.parse(localStorage.getItem('chalkle-gamelib-v4') || '[]');
    const d = JSON.parse(localStorage.getItem('chalkle-gamelib-v4-del') || '[]');
    return { games: g.length, cupsInGames: g.filter(x => x && x.title === 'Cuphead').length, del: d };
  })()`);
  console.log(`[${tag}]`, JSON.stringify(s));
};

await dump("initial");

/* unlock */
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
await dump("after game add");

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
const proxyRow = await evalJs(`(function(){
  const rows = [...document.querySelectorAll('#admin-sheet-proxies .admin-row')];
  const hit = rows.find(r => r.textContent.includes('Probe Proxy'));
  return hit ? { found: true, hasCredit: hit.textContent.includes('by proxy person'), html: hit.outerHTML.slice(0, 220) } : { found: false, rows: rows.length };
})()`);
console.log("[proxy row]", JSON.stringify(proxyRow, null, 1));

/* delete */
await evalJs(`(function(){
  window.confirm = function () { return true; };
  document.querySelector('[data-admin-tab="games"]').click();
  const rows = [...document.querySelectorAll('#admin-sheet-games .admin-row')];
  const target = rows.find(r => !r.textContent.includes('Probe Game'));
  if (!target) return null;
  const del = target.querySelector('[data-admin-del]');
  del.click();
  return target.querySelector('.admin-row-name').textContent;
})()`);
await sleep(400);
await dump("after delete");

/* reload */
await send("Page.reload", { ignoreCache: true });
await sleep(9000);
await dump("after reload");

/* post-reload: does UI filter Cuphead? */
const ui = await evalJs(`(function(){
  const raw = localStorage.getItem('chalkle-gamelib-v4');
  const arr = JSON.parse(raw || '[]');
  const dels = JSON.parse(localStorage.getItem('chalkle-gamelib-v4-del') || '[]');
  const delTitle = 'Cuphead';
  return {
    pass: delTitle && dels.indexOf(delTitle) !== -1 && !arr.some(x => x && x.title === delTitle),
    delTitleInDels: dels.indexOf(delTitle) !== -1,
    cupheadInArr: arr.some(x => x && x.title === delTitle),
    gamesCount: arr.length
  };
})()`);
console.log("[post-reload check]", JSON.stringify(ui, null, 1));

try { chrome.kill(); } catch {}
process.exit(0);