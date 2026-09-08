/* Drive the admin menu end-to-end headlessly:
 * unlock -> add game -> add proxy -> switch tabs -> close/reopen x3
 * -> normal view switching in between -> look for the freeze / errors.
 */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.env.TARGET || "http://127.0.0.1:4173";
const DBG = 9291;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-admin-probe";
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=1500,950", "--no-proxy-server",
  ORIGIN + "/index.html",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
setTimeout(() => { console.log("WATCHDOG"); process.exit(2); }, 120000);

await sleep(3000);
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
const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    errors.push((d.exception?.description || d.text || "exception").slice(0, 200));
  }
  else if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
    const a = m.params.args.map(x => x.value ?? x.description ?? "").join(" ").slice(0, 160);
    if (!/favicon|Sentry|DevTools|WebGL|audio|Autoplay|adsbygoogle|Blocked|blocked/i.test(a)) logs.push(a);
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
await sleep(4000);

function step(name, v) { console.log(`${v ? "OK  " : "!!  "} ${name}`, v && typeof v === "object" ? JSON.stringify(v) : ""); return v; }

/* 1. open admin via the settings button */
step("open admin", await evalJs(`(function(){
  const b = document.getElementById('opt-admin');
  if (!b) return 'no opt-admin btn';
  b.click();
  const m = document.getElementById('admin-modal');
  return { visible: !!m && !m.hidden, gateVisible: !document.getElementById('admin-gate').hidden };
})()`));

/* 2. unlock with the code */
step("unlock", await evalJs(`(function(){
  const code = document.getElementById('admin-code');
  code.value = 'jamesypoo';
  document.getElementById('admin-lock-form').requestSubmit();
  const body = document.getElementById('admin-body');
  const gate = document.getElementById('admin-gate');
  return { bodyShown: !body.hidden, gateHidden: gate.hidden, sheetGamesLen: (document.getElementById('admin-sheet-games').innerHTML || '').length };
})()`));
await sleep(300);

/* 3. add a game */
step("add game", await evalJs(`(function(){
  const form = document.querySelector('[data-admin-form="games"]');
  if (!form) return 'no games form';
  form.querySelector('[name="title"]').value = 'Probe Game ' + Date.now();
  form.querySelector('[name="url"]').value = 'https://example.com/probe';
  form.requestSubmit();
  return true;
})()`));
await sleep(300);
step("game in list", await evalJs(`(function(){
  const rows = [...document.querySelectorAll('#admin-sheet-games .admin-row')];
  return { rows: rows.length, hasProbe: rows.some(r => r.textContent.includes('Probe Game')) };
})()`));

/* 4. add a proxy */
step("switch to proxies tab", await evalJs(`(function(){
  const t = document.querySelector('[data-admin-tab="proxies"]');
  t.click();
  return { active: t.classList.contains('is-active'), panelShown: !document.querySelector('[data-admin-panel="proxies"]').hidden };
})()`));
await sleep(200);
step("add proxy", await evalJs(`(function(){
  const form = document.querySelector('[data-admin-form="proxies"]');
  if (!form) return 'no proxies form';
  form.querySelector('[name="name"]').value = 'Probe Proxy';
  form.querySelector('[name="url"]').value = 'https://probe.example.com';
  form.requestSubmit();
  return true;
})()`));
await sleep(300);
step("proxy in list", await evalJs(`(function(){
  const rows = [...document.querySelectorAll('#admin-sheet-proxies .admin-row')];
  return { rows: rows.length, hasProbe: rows.some(r => r.textContent.includes('Probe Proxy')) };
})()`));

/* 5. close + reopen x3, switching app views in between */
for (let i = 1; i <= 3; i++) {
  step(`close/reopen #${i}`, await evalJs(`(function(){
    const close = document.querySelector('#admin-modal [data-admin-close]');
    close.click();
    const reopened = (function(){
      document.getElementById('opt-admin').click();
      return !document.getElementById('admin-modal').hidden;
    })();
    return { closed: document.getElementById('admin-modal').hidden || reopened ? 'toggled' : 'stuck' };
  })()`));
  await sleep(250);
}

/* 6. edit flow: click Edit on the probe game, verify form prefills, cancel */
step("edit prefill", await evalJs(`(function(){
  const ed = document.querySelector('#admin-sheet-games [data-admin-edit]');
  if (!ed) return 'no edit btn';
  ed.click();
  const form = document.querySelector('[data-admin-form="games"]');
  const hasProbe = (form.querySelector('[name="title"]').value || '').includes('Probe Game');
  const cancel = form.querySelector('[data-admin-cancel]');
  if (cancel) cancel.click();
  return { prefilled: hasProbe };
})()`));
await sleep(200);

/* 7. switch app views (render()) then reopen admin and check sheets alive */
step("switch views", await evalJs(`(function(){
  const tab = document.querySelector('[data-view]');
  if (tab) { const ev = new Event('click', { bubbles: true }); tab.dispatchEvent(ev); }
  document.getElementById('opt-admin').click();
  return { sheetLen: (document.getElementById('admin-sheet-games').innerHTML || '').length };
})()`));
await sleep(400);

const fin = await evalJs(`(function(){
  return {
    modalOpen: !document.getElementById('admin-modal').hidden,
    bodyShown: !document.getElementById('admin-body').hidden,
    sheets: ['games','sites','tools','proxies','board'].map(t => (document.getElementById('admin-sheet-' + t).innerHTML || '').length),
  };
})()`);
step("final state", fin);
console.log("\n== console errors/warnings ==");
console.log(logs.length ? logs.slice(0, 12).join("\n") : "none");
console.log("\n== runtime exceptions ==");
console.log(errors.length ? errors.slice(0, 6).join("\n---\n") : "none");
try { chrome.kill(); } catch {}
process.exit(errors.length ? 1 : 0);