import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.env.TARGET || "http://127.0.0.1:4173";
const DBG = 9297;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-proxy-probe";
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=1500,950", "--no-proxy-server",
  ORIGIN + "/index.html",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
setTimeout(() => process.exit(2), 90000);
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
    errors.push((d.exception?.description || d.text || "exception").slice(0, 200));
  }
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

await evalJs(`(function(){
  document.getElementById('opt-admin').click();
  const code = document.getElementById('admin-code');
  code.value = 'jamesypoo';
  document.getElementById('admin-lock-form').requestSubmit();
  return 1;
})()`);
await sleep(400);

// add a game first (same as admin-verify)
await evalJs(`(function(){
  const gform = document.querySelector('[data-admin-form="games"]');
  gform.querySelector('[name="title"]').value = 'Probe Game ' + Date.now();
  gform.querySelector('[name="url"]').value = 'https://example.com/probe';
  gform.querySelector('[name="credit"]').value = 'probe dev';
  gform.requestSubmit();
  return 1;
})()`);
await sleep(300);

const r1 = await evalJs(`(function(){
  document.querySelector('[data-admin-tab="proxies"]').click();
  const form = document.querySelector('[data-admin-form="proxies"]');
  const before = JSON.parse(localStorage.getItem('chalkle-proxies') || '[]').length;
  form.querySelector('[name="name"]').value = 'Probe Proxy X';
  form.querySelector('[name="url"]').value = 'https://probe.example.com';
  form.querySelector('[name="credit"]').value = 'proxy person';
  const submitted = form.requestSubmit();
  return { before, submitted: submitted === undefined ? 'ok' : String(submitted),
           hasForm: !!form, hasCredit: !!form.querySelector('[name="credit"]') };
})()`);
console.log("submit call:", JSON.stringify(r1));
await sleep(250); // same as admin-verify
const r2 = await evalJs(`(function(){
  const stored = JSON.parse(localStorage.getItem('chalkle-proxies') || '[]');
  const probeRows = stored.filter(p => p && (p.name || '').indexOf('Probe') !== -1).map(p => ({ name: p.name, credit: p.credit || null, id: p._id }));
  const html = document.getElementById('admin-sheet-proxies').innerHTML;
  const frags = [];
  let from = 0;
  while (true) {
    const idx = html.indexOf('admin-row-name', from);
    if (idx === -1) break;
    const end = html.indexOf('</span>', idx);
    frags.push(html.slice(html.indexOf('>', idx) + 1, end));
    from = end + 1;
  }
  return { storedProbe: probeRows, rowNames: frags, hasCreditInHtml: html.indexOf('by proxy person') !== -1 };
})()`);
console.log("after:", JSON.stringify(r2, null, 1));
console.log("errors:", errors.length ? errors.slice(0, 4) : "none");
try { chrome.kill(); } catch {}
process.exit(0);