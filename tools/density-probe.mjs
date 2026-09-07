/* Probe: force density classes on publist and read computed styles. */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = "http://127.0.0.1:4173";
const DBG = 9257;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-density-probe";
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=390,844",
  "--no-proxy-server",
  ORIGIN + "/chat.html",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
setTimeout(() => { console.log("WATCHDOG"); process.exit(2); }, 60000);

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
  return r.result?.result?.value;
};
await sleep(5000);

const probe = await evalJs(`(function(){
  const out = {};
  const lists = document.querySelectorAll('#publist');
  out.publistCount = lists.length;
  const L = lists[0];
  out.owner = L.parentElement ? (L.parentElement.className || L.parentElement.tagName) : null;
  L.innerHTML = '';
  const row = document.createElement('div'); row.className = 'rrow';
  row.innerHTML = '<span class="rri">x</span><div class="rrinf"><div class="rrn">Room</div><div class="rrm">m</div></div>';
  L.appendChild(row);
  L.className = 'rlist density-xl';
  out.matches = row.matches('.rlist.density-xl .rrow');
  const cs = getComputedStyle(row);
  out.pad = cs.paddingTop + '/' + cs.paddingBottom;
  /* find the rule and read what the parser kept */
  for (const sh of document.styleSheets) {
    try {
      for (const r of sh.cssRules) {
        if (r.selectorText === '.rlist.density-xl .rrow') {
          out.rulePad = r.style.getPropertyValue('padding');
          out.ruleCss = r.cssText.slice(0, 140);
        }
        if (r.selectorText === '.rrow') out.baseRow = r.cssText.slice(0, 160);
      }
    } catch (e) {}
  }
  L.className = 'rlist';
  L.innerHTML = '';
  return out;
})()`);
console.log(JSON.stringify(probe, null, 1));
process.exit(0);
