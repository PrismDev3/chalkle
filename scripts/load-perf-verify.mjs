/* Verify the load-time fixes on the local server:
   1. Boot screen paints before the big game scripts execute (defer)
   2. Games still render after boot
   3. No eager /music/api searches at load
   4. CSS parse errors gone
   Usage: node scripts/load-perf-verify.mjs <origin>
*/
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.argv[2] || "http://127.0.0.1:4173";
const DBG = 9263;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-load-perf";
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
    await sleep(400);
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
const musicSearches = [];
const cssErrors = [];
const scriptEvents = [];
const consoleMsgs = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Runtime.consoleAPICalled") {
    consoleMsgs.push(m.params.args.map((a) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 160));
  } else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    const stack = (d.exception?.stack || d.exception?.description || d.text || "");
    consoleMsgs.push("EXC: " + stack.split("\n").slice(0, 3).join(" | "));
  }
  if (m.method === "Network.requestWillBeSent") {
    const u = m.params.request.url;
    if (u.includes("/music/api") && u.includes("path=search")) musicSearches.push(u);
    if (u.includes("games.js") || u.includes("games2.js")) scriptEvents.push({ kind: "req", t: Date.now(), u: u.split("?")[0].split("/").pop() });
  }
  if (m.method === "Runtime.consoleAPICalled") {
    const txt = m.params.args.map((a) => String(a.value ?? a.description ?? "")).join(" ");
    if (/Expected identifier for pseudo-class|bad selector|Ruleset ignored/i.test(txt)) cssErrors.push(txt.slice(0, 120));
  }
});
await cdp(ws, "Page.enable");
await cdp(ws, "Runtime.enable");
await cdp(ws, "Network.enable");
await cdp(ws, "Emulation.setScriptExecutionDisabled", { value: true });
await cdp(ws, "Page.navigate", { url: ORIGIN + "/" });
await sleep(400);
// With scripts disabled, the page should still have painted the boot screen
const earlyPaint = await cdp(ws, "Runtime.evaluate", {
  expression: `({ boot: !!document.getElementById("boot"), bootVisible: (function(){var b=document.getElementById("boot"); return b ? getComputedStyle(b).display !== "none" : false; })(), bodyChildren: document.body ? document.body.children.length : -1 })`,
  returnByValue: true,
});
await cdp(ws, "Emulation.setScriptExecutionDisabled", { value: false });
await cdp(ws, "Page.reload", { ignoreCache: true });
await sleep(8000);
// Dismiss the fake "blocked" cloak so the boot intro can run
await cdp(ws, "Runtime.evaluate", {
  expression: `(function(){var c=document.getElementById("blocked-cloak"); if(c) c.click(); return !!c;})()`,
  returnByValue: true,
});
await sleep(20000);

// click Games tab and count rendered cards
await cdp(ws, "Runtime.evaluate", {
  expression: `(function(){var b=document.querySelector('[data-view="games"]'); if(b) b.click(); return !!b;})()`,
  returnByValue: true,
});
await sleep(6000);
const final = await cdp(ws, "Runtime.evaluate", {
  expression: `(() => {
    const boot = document.getElementById("boot");
    const app = document.getElementById("app");
    const grid = document.getElementById("games-grid");
    return {
      bootGone: !boot || boot.classList.contains("done"),
      appVisible: app ? !app.hidden : false,
      gameCards: grid ? grid.querySelectorAll(".card, [class*=card]").length : -1,
      gamesTab: !!document.querySelector('[data-view="games"]'),
      url: location.href,
    };
  })()`,
  returnByValue: true,
});

console.log("=== EARLY PAINT (scripts disabled) ===");
console.log(JSON.stringify(earlyPaint.result.result.value));
console.log("=== AFTER RELOAD ===");
console.log(JSON.stringify(final.result.result.value));
console.log("=== EAGER MUSIC SEARCHES at load ===");
console.log(musicSearches.length ? musicSearches.join("\n") : "NONE (good)");
console.log("=== CONSOLE (last 8) ===");
console.log(consoleMsgs.slice(-8).join("\n"));
console.log("=== CSS PARSE ERRORS ===");
console.log(cssErrors.length ? cssErrors.join("\n") : "NONE (good)");
ws.close();
chrome.kill();