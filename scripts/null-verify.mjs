/* Verify the three CDN bugs are fixed in a svgbulk-like environment.
 *
 * Repro: a file:// wrapper page (location.origin === "null", exactly like the
 * svgbulk SVG docs' sandboxed frames) fetches index.html from jsDelivr,
 * injects <base href>, and inline-loads the app scripts - the svgbulk flow.
 *
 * Checks:
 *  1. Clicking the Chat / Movies tabs assigns #chat-frame / #movies-frame a
 *     src that is a data: URI or http(s) URL WITHOUT "/null/" and WITHOUT a
 *     path escaping the /gh/PrismDev3/chalkle@main/ base.
 *  2. window.ChalkGames is assembled from BOTH script parts (>= 400 entries).
 *  3. No console exceptions.
 */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const DBG = 9262;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-null-verify";
const OUT = "C:/Users/zeqrY/AppData/Local/Temp/chalkle-null-verify";
fs.rmSync(profile, { recursive: true, force: true });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const BASE = "https://cdn.jsdelivr.net/gh/PrismDev3/chalkle@main/";
const WRAP = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script>
(async function () {
  try {
    const r = await fetch("${BASE}index.html?t=" + Date.now());
    if (!r.ok) { document.title = "FETCH-FAIL-" + r.status; return; }
    let html = await r.text();
    html = html.replace(/<head([^>]*)>/i, '<head$1><base href="${BASE}">');
    document.documentElement.innerHTML = html;
    const scripts = Array.from(document.documentElement.querySelectorAll("script"));
    let chain = Promise.resolve();
    for (const old of scripts) {
      chain = chain.then(async () => {
        const ns = document.createElement("script");
        if (old.src) {
          try {
            const rr = await fetch(new URL(old.src, document.baseURI).href);
            if (!rr.ok) throw new Error("http " + rr.status);
            ns.textContent = await rr.text();
          } catch (e) { ns.src = old.src; }
        } else { ns.textContent = old.textContent; }
        document.body.appendChild(ns);
        await new Promise((res) => setTimeout(res, 20));
      });
    }
    await chain;
    document.title = "WRAPPED-READY";
  } catch (e) { document.title = "WRAP-ERR"; console.error(e); }
})();
</script>
</body></html>`;

fs.writeFileSync(OUT + "/wrap.html", WRAP);

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=1400,900",
  "--no-proxy-server", "--allow-file-access-from-files",
  "file:///" + OUT.replace(/\\/g, "/") + "/wrap.html",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
setTimeout(() => { console.log("WATCHDOG"); process.exit(2); }, 240000);

await sleep(3000);
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
    errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || "").slice(0, 140));
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

let ready = "";
for (let i = 0; i < 90; i++) {
  ready = (await evalJs("document.title")) || "";
  if (ready === "WRAPPED-READY") break;
  await sleep(1000);
}
console.log("wrapper:", ready);

/* Wait for the two big script parts to actually execute (11.5MB each; the
   wrapper's sequential inline loader needs time, and a failed inline fetch
   falls back to a slow async <script src>). */
let gamesCount = -1;
for (let i = 0; i < 90; i++) {
  gamesCount = (await evalJs("(window.ChalkGames || []).length")) || 0;
  if (gamesCount > 0) break;
  await sleep(1000);
}
console.log("ChalkGames settled at:", gamesCount);

const results = await evalJs(`(async function(){
  const out = { origin: String(location.origin) };
  out.games = (window.ChalkGames || []).length;
  out.gamesIsArray = Array.isArray(window.ChalkGames);
  function frameSrc(view, frameId) {
    return new Promise((resolve) => {
      const before = (document.getElementById(frameId) || {}).src || "";
      const btn = document.querySelector('[data-view="' + view + '"]');
      if (!btn) return resolve({ err: "no nav button for " + view });
      btn.click();
      let n = 0;
      const t = setInterval(() => {
        const f = document.getElementById(frameId);
        if (++n > 20) { clearInterval(t); return resolve({ err: "frame never set", before }); }
        if (f && f.src && f.src !== before && f.src !== "about:blank") {
          clearInterval(t);
          resolve({ src: f.src, origin: String(location.origin) });
        }
      }, 250);
    });
  }
  out.chat = await frameSrc("chat", "chat-frame");
  out.movies = await frameSrc("movies", "movies-frame");
  return out;
})()`);
console.log(JSON.stringify(results, null, 2));

console.log("exceptions:", errors.length ? errors.slice(0, 5) : "none");

function srcOk(r) {
  if (!r || r.err || !r.src) return false;
  const s = String(r.src);
  if (s.indexOf("/null/") !== -1) return false;
  if (/^data:/i.test(s)) return true;
  if (/^https?:/i.test(s)) return s.indexOf("/gh/PrismDev3/chalkle") !== -1 || s.indexOf("chat.html") !== -1 || s.indexOf("movies.html") !== -1;
  return false;
}
let pass = true;
if (ready !== "WRAPPED-READY") { console.log("FAIL: wrapper never became ready"); pass = false; }
if (!results.gamesIsArray || results.games < 400) { console.log("FAIL: ChalkGames not assembled from both parts (got " + gamesCount + ")"); pass = false; }
else console.log("PASS: ChalkGames assembled (" + results.games + " games)");
if (!srcOk(results.chat)) { console.log("FAIL: chat frame src bad:", results.chat); pass = false; }
else console.log("PASS: chat frame src:", String(results.chat.src).slice(0, 90));
if (!srcOk(results.movies)) { console.log("FAIL: movies frame src bad:", results.movies); pass = false; }
else console.log("PASS: movies frame src:", String(results.movies.src).slice(0, 90));
if (errors.length) { console.log("FAIL: console exceptions"); pass = false; }
console.log(pass ? "NULL-VERIFY: PASS" : "NULL-VERIFY: FAIL");
process.exit(pass ? 0 : 1);
