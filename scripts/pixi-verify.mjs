/* Verify pixel-icon chat: every img.pixi decodes, picker intact, zero errors. */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.env.TARGET || "http://127.0.0.1:4173";
const DBG = 9239;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-pixi-profile";
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=1500,950",
  "--no-proxy-server",
  ORIGIN + "/chat.html",
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
const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "Runtime.exceptionThrown") {
    errors.push(m.params.exceptionDetails.text || "exception");
  }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
await send("Page.enable");
await send("Runtime.enable");

await sleep(5000);
const stats = await evalJs(`(async function(){
  var imgs = [].slice.call(document.querySelectorAll("img.pixi"));
  var bad = [];
  for (var i = 0; i < imgs.length; i++) {
    var im = imgs[i];
    if (!im.complete) { try { await im.decode(); } catch (e) { bad.push("decode-fail#" + i); continue; } }
    if (im.naturalWidth === 0) bad.push("zero#" + i);
  }
  // unique icon count by data uri
  var uniq = {};
  imgs.forEach(function(im){ uniq[im.src.slice(-24)] = 1; });
  var dots = document.querySelectorAll("span.pixi-dot").length;
  var cs = getComputedStyle(document.querySelector("img.pixi") || document.body);
  var pickerOk = (typeof EMOJI_CATS === "object") && Object.keys(EMOJI_CATS).length;
  var qrOk = (typeof QUICK_REACTIONS === "object") && QUICK_REACTIONS.length;
  return {
    pixiImgs: imgs.length, uniqueIcons: Object.keys(uniq).length, broken: bad,
    dots: dots, imgW: cs.width, rendering: cs.imageRendering,
    pickerCats: pickerOk, quickReactions: qrOk,
    hasRenderReactions: typeof renderReactions === "function",
    title: document.title.slice(0, 40)
  };
})()`);
console.log("stats:", JSON.stringify(stats, null, 1));

const shot = await send("Page.captureScreenshot", { format: "png" });
fs.mkdirSync("shots", { recursive: true });
fs.writeFileSync("shots/pixi-chat.png", Buffer.from(shot.result.data, "base64"));
console.log("screenshot saved to shots/pixi-chat.png");
console.log("exceptions:", errors.length);
console.log(stats && stats.pixiImgs > 50 && stats.broken.length === 0 && stats.pickerCats >= 10
  && stats.quickReactions >= 8 && stats.hasRenderReactions && errors.length === 0
  ? "PIXI-CHAT: PASS" : "PIXI-CHAT: FAIL");
process.exit(0);
