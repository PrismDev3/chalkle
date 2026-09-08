import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const TARGET = process.env.TARGET || "https://raw.githubusercontent.com/PrismDev3/chalkle/main";
const DBG = 9277;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/icn-probe";
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=390,844", "--no-proxy-server",
  TARGET + "/chat.html",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
await sleep(4000);
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
const consoleMsgs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "Runtime.consoleAPICalled") {
    const a = m.params.args.map(x => x.value ?? x.description ?? "").join(" ").slice(0, 120);
    consoleMsgs.push(a);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 200) };
  return r.result?.result?.value;
};
await send("Runtime.enable");
await sleep(3000);
const probe = await evalJs(`(function(){ return {
  url: location.href,
  hasLw: !!document.getElementById("lw"),
  hasAw: !!document.getElementById("aw"),
  bodyLen: document.body ? document.body.innerHTML.length : -1,
  bodyTag: document.body ? document.body.tagName : null,
  contentType: document.contentType,
  first160: document.body ? document.body.innerHTML.slice(0, 160) : "none",
}; })()`);
console.log(JSON.stringify(probe, null, 1));
console.log("console tail:", consoleMsgs.slice(-6));
try { chrome.kill(); } catch {}
process.exit(0);