/* Movies tab E2E: open site, switch to Movies, wait for the catalog grid,
 * verify cards render with real posters, log /api/tmdb statuses. */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.env.TARGET || "https://lootline.xyz";
const DBG = 9243;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-movies-e2e";
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
setTimeout(() => { console.log("WATCHDOG"); process.exit(2); }, 150000);

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
const tmdbStatuses = [];
const tmdbFails = [];
const exceptions = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "Network.responseReceived") {
    const r = m.params.response;
    if (r.url.includes("/api/tmdb/")) tmdbStatuses.push(r.status);
    if (r.url.includes("/api/tmdb/") && r.status >= 400) tmdbFails.push(r.status + " " + r.url.slice(r.url.indexOf("/api/tmdb/"), r.url.indexOf("/api/tmdb/") + 90));
  }
  else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    exceptions.push((d.exception?.description || d.text || "exception").slice(0, 100));
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
await evalJs(`(function(){var c=document.getElementById("blocked-cloak");if(c)c.click();return 1;})()`);
await sleep(1200);

// find + click the Movies nav item
const clicked = await evalJs(`(function(){
  var items = [].slice.call(document.querySelectorAll(".nav-item"));
  var mv = items.find(function(b){ return /movies/i.test((b.dataset.view||"") + " " + (b.textContent||"")); });
  if (mv) { mv.click(); return mv.dataset.view || mv.textContent.trim(); }
  return "NOT FOUND";
})()`);
console.log("movies tab click:", clicked);
await sleep(9000); // let the catalog fetch + render

// switch into the movies iframe context
let frames = await send("Page.getFrameTree");
const frameList = [];
function walk(f) { frameList.push(f.frame); (f.childFrames || []).forEach(walk); }
walk(frames.result.frameTree);
const mvFrame = frameList.find((f) => (f.url || "").includes("movies.html"));
console.log("movies frame:", mvFrame ? mvFrame.url.slice(0, 60) : "NOT FOUND");

let grid = null;
if (mvFrame) {
  grid = await evalJs(`(function(){
    var f = document.querySelector('iframe[src*="movies.html"]');
    if (!f || !f.contentDocument) return { err: 'no iframe doc' };
    var doc = f.contentDocument;
    var imgs = [].slice.call(doc.querySelectorAll('img')).filter(function(i){ return (i.src||'').indexOf('metahub') >= 0 || (i.src||'').indexOf('image.tmdb.org') >= 0; });
    var loaded = imgs.filter(function(i){ return i.complete && i.naturalWidth > 0; }).length;
    return { totalImgs: doc.images.length, posterImgs: imgs.length, postersLoaded: loaded,
             bodyText: (doc.body.innerText||'').slice(0, 120).replace(/\\n/g,' | ') };
  })()`);
}
console.log("grid:", JSON.stringify(grid, null, 1));
console.log("tmdb api statuses:", JSON.stringify(tmdbStatuses));
console.log("tmdb failures:", JSON.stringify([...new Set(tmdbFails)], null, 1));
console.log("exceptions:", exceptions.length, exceptions.slice(0, 2));

const shot = await send("Page.captureScreenshot", { format: "png" });
fs.mkdirSync("shots", { recursive: true });
fs.writeFileSync("shots/movies-e2e.png", Buffer.from(shot.result.data, "base64"));

const ok = mvFrame && grid && grid.posterImgs > 5 && grid.postersLoaded > 3
  && tmdbStatuses.filter((s2) => s2 >= 400).length === 0 && exceptions.length === 0;
console.log(ok ? "MOVIES-E2E: PASS" : "MOVIES-E2E: FAIL");
process.exit(0);
