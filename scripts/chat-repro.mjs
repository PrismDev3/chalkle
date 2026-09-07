/* Chat 405 repro: boots lootline.xyz (public), switches to the Chat tab,
 * logs every network response >= 400 plus console errors, tries the AI chat
 * and a Bitcord-ish flow too. */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.env.TARGET || "https://lootline.xyz";
const DBG = 9237;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-chat-repro";
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
const bad = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "Network.responseReceived") {
    const r = m.params.response;
    if (r.status >= 400) bad.push(`${r.status} ${r.requestMethod || "?"} ${r.url.slice(0, 130)}`);
  }
  else if (m.method === "Network.loadingFailed") {
    bad.push(`FAILED ${m.params.errorText} ${m.params.type}`);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
await send("Page.enable");
await send("Network.enable");
await send("Runtime.enable");

await sleep(6000);
await evalJs(`(function(){var c=document.getElementById("blocked-cloak");if(c)c.click();return true;})()`);
await sleep(1500);

// Which nav item is the chat tab?
const chatInfo = await evalJs(`(function(){
  var items = [].map.call(document.querySelectorAll(".nav-item"), function(b){
    return { view: b.dataset.view, text: (b.textContent || "").trim().slice(0, 20) };
  });
  return items.filter(function(i){ return /chat/i.test(i.view + " " + i.text); });
})()`);
console.log("chat nav items:", JSON.stringify(chatInfo));

// Click the chat tab
await evalJs(`(function(){
  var b = document.querySelector('.nav-item[data-view="chat"]');
  if (!b) b = document.querySelector('.nav-item[data-view="ai"]');
  if (b) b.click();
  return b ? (b.dataset.view) : "none";
})()`);
await sleep(6000);

// What is visible / what did the iframe load?
const state = await evalJs(`(function(){
  var f = document.getElementById("chat-frame");
  return {
    frameSrc: f ? f.src : "(no #chat-frame)",
    frameOk: f ? (f.contentDocument ? "accessible" : "cross-origin") : "-",
    activeView: document.body.getAttribute("data-view"),
    title: document.title.slice(0, 40)
  };
})()`);
console.log("state:", JSON.stringify(state, null, 1));

// Also exercise the AI tab (send a chat message if the input exists)
await evalJs(`(function(){
  var b = document.querySelector('.nav-item[data-view="ai"]');
  if (b) b.click();
  return true;
})()`);
await sleep(2500);
const ai = await evalJs(`(function(){
  var t = document.querySelector("#ai-input, .ai-input, textarea");
  if (!t) return "no ai input";
  return "ai input found: " + (t.id || t.className);
})()`);
console.log("ai:", ai);

console.log("bad responses (" + bad.length + "):");
bad.slice(0, 25).forEach((b) => console.log("  " + b));
console.log(bad.length === 0 ? "REPRO: clean" : "REPRO: found failures");
process.exit(0);
