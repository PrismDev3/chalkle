/* Probe: what does the browser actually render for the svgbulk SVG page? */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const URL = process.argv[2] || "https://cdn.jsdelivr.net/gh/PrismDev3/svgbulk-w6nwvo@main/learn-1-1-4ril.svg";
const DBG = 9261;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-svgbulk-probe";
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${profile}`,
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1000,800",
  "--disable-extensions",
], { stdio: "ignore" });

async function getTabs() {
  const r = await fetch(`http://127.0.0.1:${DBG}/json`);
  return r.json();
}
async function waitTab() {
  for (let i = 0; i < 40; i++) {
    try {
      const tabs = await getTabs();
      const t = tabs.find((x) => x.type === "page");
      if (t) return t;
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error("no tab");
}
let nextId = 1;
async function cdp(ws, method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener("message", onMsg); resolve(m); }
    };
    ws.addEventListener("message", onMsg);
    setTimeout(() => { ws.removeEventListener("message", onMsg); reject(new Error("timeout " + method)); }, 20000);
  });
}

const tab = await waitTab();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener("open", res));
const consoleMsgs = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Runtime.consoleAPICalled") {
    consoleMsgs.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  } else if (m.method === "Runtime.exceptionThrown") {
    consoleMsgs.push("EXC: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200));
  }
});
await cdp(ws, "Page.enable");
await cdp(ws, "Runtime.enable");
await cdp(ws, "Network.enable");
const failed = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Network.loadingFailed") failed.push(m.params.errorText + " " + (m.params.blockedReason || ""));
});

await cdp(ws, "Page.navigate", { url: URL });
await sleep(9000);

// top document state
const top = await cdp(ws, "Runtime.evaluate", {
  expression: `(() => {
    const doc = document;
    return {
      url: location.href,
      title: document.title,
      rootTag: document.documentElement ? document.documentElement.tagName : null,
      rootChildren: document.documentElement ? document.documentElement.children.length : -1,
      rootInnerStart: document.documentElement ? document.documentElement.innerHTML.slice(0, 400) : null,
      bodyText: (document.body ? document.body.innerText : "").slice(0, 300),
      iframeCount: document.querySelectorAll("iframe").length,
    };
  })()`,
  returnByValue: true,
});

// iframe state (srcdoc launcher)
const ifr = await cdp(ws, "Runtime.evaluate", {
  expression: `(async () => {
    const f = document.querySelector("iframe");
    if (!f) return { noIframe: true };
    await new Promise(r => { if (f.contentDocument) r(); else f.addEventListener("load", r); });
    const d = f.contentDocument;
    return {
      iframeSrc: f.getAttribute("srcdoc") ? "srcdoc:" + f.getAttribute("srcdoc").slice(0, 120) : f.src,
      iframeTitle: d.title,
      iframeRoot: d.documentElement ? d.documentElement.tagName : null,
      iframeHtmlLen: d.documentElement ? d.documentElement.innerHTML.length : -1,
      iframeBodyText: (d.body ? d.body.innerText : "").slice(0, 250),
      iframeChildren: d.documentElement ? d.documentElement.children.length : -1,
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
});

console.log("=== TOP ===");
console.log(JSON.stringify(top.result.result.value, null, 2));
console.log("=== IFRAME ===");
console.log(JSON.stringify(ifr.result.result.value, null, 2));
console.log("=== CONSOLE ===");
console.log(consoleMsgs.slice(0, 15).join("\n"));
console.log("=== NETWORK FAILURES ===");
console.log([...new Set(failed)].slice(0, 10).join("\n"));

ws.close();
chrome.kill();