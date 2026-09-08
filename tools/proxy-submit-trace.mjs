/* Trace the admin proxy submit: inject the tracer BEFORE the page loads. */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.env.TARGET || "http://127.0.0.1:4173";
const DBG = 9351;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-proxy-submit-trace";
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=1500,950", "--no-proxy-server",
  "about:blank",
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
  if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 250) };
  return r.result?.result?.value;
};
await send("Page.enable");
await send("Runtime.enable");

/* Inject BEFORE navigating so the app page carries the tracer. */
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(function(){
    window.__submits = [];
    document.addEventListener('submit', (e) => {
      const f = e.target;
      const q = (n) => { const el = f.querySelector('[name="' + n + '"]'); return el ? el.value : '(none)'; };
      window.__submits.push({ formAttr: f.getAttribute('data-admin-form'), id: f.id || '', cls: f.className, name: q('name'), url: q('url'), credit: q('credit') });
    }, true);
    window.__pushLog = [];
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === 'chalkle-proxies') window.__pushLog.push('PROXIES ' + String(v).slice(0, 300));
      return orig.call(this, k, v);
    };
  })();`,
});

await send("Page.navigate", { url: ORIGIN + "/index.html" });
await sleep(6000);

/* unlock + add game (mirror the failing flow) */
await evalJs(`(function(){
  document.getElementById('opt-admin').click();
  const code = document.getElementById('admin-code');
  code.value = 'jamesypoo';
  document.getElementById('admin-lock-form').requestSubmit();
  return 1;
})()`);
await sleep(400);
await evalJs(`(function(){
  const form = document.querySelector('[data-admin-form="games"]');
  form.querySelector('[name="title"]').value = 'Probe Game ' + Date.now();
  form.querySelector('[name="url"]').value = 'https://example.com/probe';
  form.querySelector('[name="credit"]').value = 'probe dev';
  form.requestSubmit();
  return 1;
})()`);
await sleep(400);

/* add proxy */
const addRes = await evalJs(`(function(){
  document.querySelector('[data-admin-tab="proxies"]').click();
  const forms = [...document.querySelectorAll('[data-admin-form="proxies"]')];
  const form = forms[forms.length - 1];
  const nameVal = 'Probe Px ' + Date.now();
  form.querySelector('[name="name"]').value = nameVal;
  form.querySelector('[name="url"]').value = 'https://probe.example.com';
  form.querySelector('[name="credit"]').value = 'proxy person';
  const before = { name: form.querySelector('[name="name"]').value, credit: form.querySelector('[name="credit"]').value };
  let threw = null;
  try { form.requestSubmit(); } catch (e) { threw = String(e); }
  return { nameVal: nameVal, before: before, threw: threw, formCount: forms.length };
})()`);
console.log("[add]", JSON.stringify(addRes, null, 1));
await sleep(800);

console.log("[submits]", JSON.stringify(await evalJs(`window.__submits`), null, 1));
console.log("[proxies writes]", JSON.stringify(await evalJs(`window.__pushLog`), null, 1));
console.log("[stored fresh]", JSON.stringify(await evalJs(`(function(){
  const arr = JSON.parse(localStorage.getItem('chalkle-proxies') || '[]');
  return arr.filter(p => p && p.name && p.name.indexOf('Probe Px') !== -1);
})()`), null, 1));
console.log("[sheet rows]", JSON.stringify(await evalJs(`(function(){
  const rows = [...document.querySelectorAll('#admin-sheet-proxies .admin-row')];
  return rows.filter(r => r.textContent.indexOf('Probe Px') !== -1).map(r => ({ name: (r.querySelector('.admin-row-name')||{}).textContent, hasCredit: r.textContent.includes('by proxy person'), html: r.outerHTML.slice(0, 220) }));
})()`), null, 1));

try { chrome.kill(); } catch {}
process.exit(0);