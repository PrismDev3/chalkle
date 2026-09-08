/* Boot XHR audit: counts relay calls fired while the page boots with NO tabs
   clicked. Expected: 1x /yt/trending (home row is above the fold), 0x
   /music/api, 0x /api/live-tv, 0x /api/livetv (sports/matches), and no
   "preloaded but not used" wallpaper warning.
   Usage: node tools/boot-xhr-probe.mjs <origin>
*/
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.argv[2] || "http://127.0.0.1:4173";
const DBG = 9264;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-boot-xhr";
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
const hits = { trending: 0, music: 0, livetv: 0, livetvSports: 0, wallpaperPreload: 0 };
const warns = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Network.requestWillBeSent") {
    const u = m.params.request.url;
    if (u.includes("/yt/trending")) hits.trending++;
    if (u.includes("/music/api")) hits.music++;
    if (u.includes("/api/live-tv")) hits.livetv++;
    if (u.includes("/api/livetv/")) hits.livetvSports++;
    if (u.includes("bg-chalk.webp")) hits.wallpaperPreload++;
  }
  if (m.method === "Runtime.consoleAPICalled" || m.method === "Log.entryAdded") {
    const e = m.params.entry || m.params;
    const txt = (e.args || []).map((a) => String(a.value ?? a.description ?? "")).join(" ") || String(e.text || "");
    if (/preloaded .* not used|not used within a few seconds|Ruleset ignored|parsing value/i.test(txt)) warns.push(txt.slice(0, 140));
  }
});
await cdp(ws, "Page.enable");
await cdp(ws, "Runtime.enable");
await cdp(ws, "Network.enable");
await cdp(ws, "Log.enable");
await cdp(ws, "Page.navigate", { url: ORIGIN + "/" });
await sleep(8000);
// dismiss cloak so boot intro can run, then let boot finish
await cdp(ws, "Runtime.evaluate", {
  expression: `(function(){var c=document.getElementById("blocked-cloak"); if(c) c.click(); return !!c;})()`,
  returnByValue: true,
});
await sleep(15000);

const state = await cdp(ws, "Runtime.evaluate", {
  expression: `(() => ({
    homeRecs: (document.getElementById("home-youtube-recs") || {}).childElementCount ?? -1,
    recCards: document.querySelectorAll("#home-youtube-recs [data-home-video]").length,
    hasFeaturedFn: typeof window.ChalkleFeaturedVideos === "function",
    hasOpenVideoFn: typeof window.ChalkleOpenVideo === "function",
    preloadLink: !!document.getElementById("chalkle-wallpaper-preload"),
  }))()`,
  returnByValue: true,
});

console.log("=== BOOT RELAY CALLS (no tabs clicked) ===");
console.log(JSON.stringify(hits, null, 2));
console.log("=== PAGE STATE ===");
console.log(JSON.stringify(state.result.result.value));
console.log("=== PERF-RELATED WARNINGS ===");
console.log(warns.length ? warns.join("\n") : "NONE (good)");
ws.close();
chrome.kill();
process.exit(0);
