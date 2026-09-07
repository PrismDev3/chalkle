/* E2E: live svgbulk svg -> embedded app -> Movies/Chat frames must render
   (srcdoc-injected), not show raw text/plain HTML. */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const URL = process.argv[2] || "https://cdn.jsdelivr.net/gh/PrismDev3/svgbulk-w6nwvo@main/learn-1-1-4ril.svg";
const DBG = 9262;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-svgbulk-e2e";
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${profile}`,
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1280,900",
  "--disable-extensions",
], { stdio: "ignore" });

async function getTabs() { return (await fetch(`http://127.0.0.1:${DBG}/json`)).json(); }
async function waitTab() {
  for (let i = 0; i < 40; i++) {
    try {
      const t = (await getTabs()).find((x) => x.type === "page");
      if (t) return t;
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error("no tab");
}
let nextId = 1;
function cdp(ws, method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener("message", onMsg); resolve(m); }
    };
    ws.addEventListener("message", onMsg);
    setTimeout(() => { ws.removeEventListener("message", onMsg); reject(new Error("timeout " + method)); }, 30000);
  });
}

const tab = await waitTab();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener("open", res));
const msgs = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Runtime.consoleAPICalled") {
    msgs.push("CONSOLE: " + m.params.args.map((a) => (a.value ?? a.description ?? "")).join(" ").slice(0, 160));
  } else if (m.method === "Runtime.exceptionThrown") {
    msgs.push("EXC: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 160));
  }
});
await cdp(ws, "Page.enable");
await cdp(ws, "Runtime.enable");
await cdp(ws, "Page.navigate", { url: URL });
await sleep(11000); // let the boot sequence + app finish

async function evalIn(expr) {
  const r = await cdp(ws, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
}

// Reach into the app iframe (same-origin via srcdoc) and click Movies
const boot = await evalIn(`(() => {
  const f = document.querySelector("iframe#test");
  if (!f || !f.contentDocument) return { error: "no app iframe yet" };
  const d = f.contentDocument;
  const btn = d.querySelector('[data-view="movies"]');
  if (btn) btn.click();
  return { clicked: !!btn, viewBtns: d.querySelectorAll(".nav-item").length };
})()`);
console.log("boot click:", JSON.stringify(boot));

// Wait for the movies frame to load (srcdoc path)
let movies = null;
for (let i = 0; i < 20; i++) {
  await sleep(1000);
  movies = await evalIn(`(() => {
    const f = document.querySelector("iframe#test");
    if (!f || !f.contentDocument) return null;
    const d = f.contentDocument;
    const mf = d.querySelector("#movies-frame");
    if (!mf) return null;
    return {
      hasSrcDoc: mf.getAttribute("srcdoc") ? true : false,
      src: (mf.src || "").slice(0, 120),
      bodyText: (mf.contentDocument && mf.contentDocument.body ? mf.contentDocument.body.innerText : "").slice(0, 120),
      bodyTag: mf.contentDocument ? mf.contentDocument.documentElement.tagName : null,
    };
  })()`);
  if (movies && (movies.hasSrcDoc || (movies.bodyText && movies.bodyText.length > 5))) break;
}
console.log("movies frame:", JSON.stringify(movies));

// Now click Chat
await evalIn(`(() => {
  const f = document.querySelector("iframe#test");
  const d = f.contentDocument;
  const btn = d.querySelector('[data-view="chat"]');
  if (btn) btn.click();
  return true;
})()`);
let chat = null;
for (let i = 0; i < 20; i++) {
  await sleep(1000);
  chat = await evalIn(`(() => {
    const f = document.querySelector("iframe#test");
    if (!f || !f.contentDocument) return null;
    const d = f.contentDocument;
    const cf = d.querySelector("#chat-frame");
    if (!cf) return null;
    return {
      hasSrcDoc: cf.getAttribute("srcdoc") ? true : false,
      src: (cf.src || "").slice(0, 120),
      bodyText: (cf.contentDocument && cf.contentDocument.body ? cf.contentDocument.body.innerText : "").slice(0, 120),
    };
  })()`);
  if (chat && (chat.hasSrcDoc || (chat.bodyText && chat.bodyText.length > 5))) break;
}
console.log("chat frame:", JSON.stringify(chat));

console.log("=== console (last 12) ===");
console.log(msgs.slice(-12).join("\n"));
ws.close();
chrome.kill();