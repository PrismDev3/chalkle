/* Verify in-app fullscreen on the Chat and Movies views:
 * - clicking the button maximizes the view (fx-full) and requests browser fullscreen
 * - label flips to "Exit fullscreen"
 * - exiting restores the normal layout
 * Runs against the local static server on 127.0.0.1:4173. */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.env.TARGET || "http://127.0.0.1:4173";
const DBG = 9251;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-fxfs-profile";
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=1500,950",
  "--no-proxy-server",
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
const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    errors.push((d.exception?.description || d.text || "exception").slice(0, 120));
  }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 120) };
  return r.result?.result?.value;
};
await send("Page.enable");
await send("Runtime.enable");

await sleep(6000); // let the app boot
await evalJs(`(function(){var c=document.getElementById("blocked-cloak");if(c)c.click();return 1;})()`);
await sleep(800);

const results = {};
for (const which of ["chat", "movies"]) {
  const r = {};
  r.btnExists = await evalJs(`!!document.getElementById("${which}-fullscreen")`);
  // switch to the view
  await evalJs(`(function(){
    var items = [].slice.call(document.querySelectorAll(".nav-item"));
    var t = items.find(function(b){ return new RegExp("${which}","i").test((b.dataset.view||"") + " " + (b.textContent||"")); });
    if (t) t.click();
    return t ? t.dataset.view : "NOT FOUND";
  })()`);
  await sleep(1200);
  const before = await evalJs(`(function(){
    var f = document.getElementById("${which}-frame");
    var s = f && f.closest(".view");
    return { sectionVisible: !!s && !s.hidden, maximized: !!(s && s.classList.contains("fx-full")),
             frameH: f ? f.getBoundingClientRect().height : 0, fs: !!document.fullscreenElement };
  })()`);
  await evalJs(`document.getElementById("${which}-fullscreen").click()`);
  await sleep(1200);
  const during = await evalJs(`(function(){
    var f = document.getElementById("${which}-frame");
    var s = f && f.closest(".view");
    var btn = document.getElementById("${which}-fullscreen");
    return { maximized: !!(s && s.classList.contains("fx-full")),
             sectionW: s ? s.getBoundingClientRect().width : 0,
             sectionH: s ? s.getBoundingClientRect().height : 0,
             frameH: f ? f.getBoundingClientRect().height : 0,
             vw: window.innerWidth, vh: window.innerHeight,
             fs: !!(document.fullscreenElement || document.webkitFullscreenElement),
             label: btn ? (btn.querySelector(".fx-fs-label") || {}).textContent : null };
  })()`);
  // exit via the button
  await evalJs(`document.getElementById("${which}-fullscreen").click()`);
  await sleep(900);
  const after = await evalJs(`(function(){
    var f = document.getElementById("${which}-frame");
    var s = f && f.closest(".view");
    var btn = document.getElementById("${which}-fullscreen");
    return { maximized: !!(s && s.classList.contains("fx-full")),
             frameH: f ? f.getBoundingClientRect().height : 0,
             fs: !!(document.fullscreenElement || document.webkitFullscreenElement),
             label: btn ? (btn.querySelector(".fx-fs-label") || {}).textContent : null };
  })()`);
  // re-enter then exit with Escape (browser-native path)
  await evalJs(`document.getElementById("${which}-fullscreen").click()`);
  await sleep(900);
  const reFs = await evalJs(`!!(document.fullscreenElement || document.webkitFullscreenElement)`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(900);
  const afterEsc = await evalJs(`(function(){
    var f = document.getElementById("${which}-frame");
    var s = f && f.closest(".view");
    return { maximized: !!(s && s.classList.contains("fx-full")), fs: !!(document.fullscreenElement || document.webkitFullscreenElement) };
  })()`);
  results[which] = { before, during, after, reFs, afterEsc };
}

console.log(JSON.stringify(results, null, 1));
console.log("exceptions:", errors.length, errors.slice(0, 3));

let ok = true;
for (const which of ["chat", "movies"]) {
  const r = results[which];
  const d = r.during || {};
  const big = d.sectionW >= d.vw - 4 && d.sectionH >= d.vh - 4;
  const good = r.before && !r.before.maximized
    && d.maximized && big && d.label === "Exit fullscreen"
    && r.after && !r.after.maximized && r.after.label === "Fullscreen"
    && r.afterEsc && !r.afterEsc.maximized;
  if (!good) ok = false;
  console.log(`${which}: ${good ? "PASS" : "FAIL"} (during.big=${big} fs=${d.fs} frameH ${Math.round(r.before.frameH)}->${Math.round(d.frameH)}->${Math.round(r.after.frameH)})`);
}
console.log(errors.length === 0 && ok ? "FX-FULLSCREEN: PASS" : "FX-FULLSCREEN: FAIL");
process.exit(0);
