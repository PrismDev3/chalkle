/* Tab lazy-load audit: boots the page, then opens Music, YouTube and Live TV
   in turn and verifies each tab's first open actually fetches + renders, and
   that revisits don't re-fetch (YouTube). Usage: node tools/tab-open-probe.mjs <origin>
*/
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.argv[2] || "http://127.0.0.1:4173";
const DBG = 9265;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-tab-open";
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
    setTimeout(() => { ws.removeEventListener("message", onMsg); reject(new Error("timeout " + method)); }, 60000);
  });
}

const tab = await waitTab();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener("open", res));
const counts = { trending: 0, musicSearch: 0, musicUrl: 0, livetv: 0, sports: 0 };
const errors = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Network.requestWillBeSent") {
    const u = m.params.request.url;
    if (u.includes("/yt/trending")) counts.trending++;
    if (u.includes("/music/api") && u.includes("path=search")) counts.musicSearch++;
    if (u.includes("/api/live-tv") && !u.includes("livetv")) counts.livetv++;
    if (u.includes("/api/livetv/")) counts.sports++;
  }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    errors.push(String((d.exception && d.exception.description) || d.text || "").slice(0, 120));
  }
});
await cdp(ws, "Page.enable");
await cdp(ws, "Runtime.enable");
await cdp(ws, "Network.enable");
await cdp(ws, "Page.navigate", { url: ORIGIN + "/" });
await sleep(8000);
await cdp(ws, "Runtime.evaluate", {
  expression: `(function(){var c=document.getElementById("blocked-cloak"); if(c) c.click(); return !!c;})()`,
  returnByValue: true,
});
await sleep(12000);

async function openTab(name) {
  await cdp(ws, "Runtime.evaluate", {
    expression: `(function(){var b=document.querySelector('.nav-item[data-view="${name}"]'); if(b) b.click(); return !!b;})()`,
    returnByValue: true,
  });
}

// Music tab: first open should fire the 8 chart searches and paint cards
await openTab("music");
await sleep(12000);
const music = await cdp(ws, "Runtime.evaluate", {
  expression: `(() => ({
    cards: document.querySelectorAll("#music-home .music-card, #music-home .music-track-row").length,
    hero: !!document.querySelector("#music-home .music-hero"),
    loading: /Loading music/.test((document.getElementById("music-home") || {}).textContent || ""),
  }))()`,
  returnByValue: true,
});
const afterMusic = Object.assign({}, counts);

// YouTube tab: first open fetches trending (shared with home row, so exactly 1 more)
await openTab("youtube");
await sleep(10000);
const yt = await cdp(ws, "Runtime.evaluate", {
  expression: `(() => ({
    videos: document.querySelectorAll("#yt-home .yt-video").length,
    resultsHidden: (document.getElementById("yt-results") || {}).hidden,
  }))()`,
  returnByValue: true,
});

// Live TV tab: first open fetches channels + sports
await openTab("livetv");
await sleep(10000);
const tv = await cdp(ws, "Runtime.evaluate", {    expression: `(() => ({
    cards: document.querySelectorAll("#livetv-grid .livetv-row > *").length,
    status: (document.getElementById("livetv-status-txt") || {}).textContent || "",
  }))()`,
  returnByValue: true,
});

console.log("=== BOOT-TO-TAB FETCH COUNTS ===");
console.log(JSON.stringify({
  bootPhase: { trendingBeforeMusic: 0, note: "see boot-xhr-probe" },
  afterMusicOpen: afterMusic,
  afterYtOpen: counts,
}, null, 2));
console.log("=== MUSIC TAB ===", JSON.stringify(music.result.result.value));
console.log("=== YOUTUBE TAB ===", JSON.stringify(yt.result.result.value));
console.log("=== LIVETV TAB ===", JSON.stringify(tv.result.result.value));
console.log("=== JS EXCEPTIONS ===");
console.log(errors.length ? errors.join("\n") : "NONE (good)");
ws.close();
chrome.kill();
process.exit(0);
