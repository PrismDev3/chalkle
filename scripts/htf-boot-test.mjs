/* How To Fish boot test: load the game page, wait for Unity to instantiate,
 * assert the loading bar disappears and no fatal errors occurred.
 * Expects the Chalkle server on 127.0.0.1:4173. */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 4173;
const DBG = 9231;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-htf-profile";
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=1280,800",
  "--no-proxy-server", "--proxy-bypass-list=<-loopback>",
  "about:blank",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
setTimeout(() => { console.log("WATCHDOG: timed out"); process.exit(2); }, 240000);

await sleep(1500);
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
const warnings = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "Runtime.consoleAPICalled") {
    const txt = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (m.params.type === "error") errors.push(txt);
    if (m.params.type === "warning" && txt.includes("[unity]")) warnings.push(txt);
  }
  else if (m.method === "Runtime.exceptionThrown") {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
await send("Runtime.enable");
await send("Page.enable");

await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/game-builds/how_to_fish/index.html` });

// Poll for Unity instantiation (localhost: 190MB fetch + wasm compile takes a while)
let booted = false;
let lastStatus = "";
for (let i = 0; i < 90; i++) {
  await sleep(2500);
  const st = await evalJs(`(function(){
    var bar = document.getElementById("unity-loading-bar");
    var status = document.getElementById("unity-load-status");
    var fill = document.getElementById("unity-progress-bar-full");
    var cv = document.getElementById("unity-canvas");
    return {
      barHidden: !bar || bar.style.display === "none",
      instType: typeof window.unityInstance,
      canvasW: cv ? cv.width : 0,
      status: status ? status.textContent : "",
      width: fill ? fill.style.width : ""
    };
  })()`);
  if (st) {
    lastStatus = `${st.status} | bar ${st.width} | inst ${st.instType} | cw ${st.canvasW}`;
    console.log(`t=${(i + 1) * 2.5}s  ${st.barHidden ? "BAR HIDDEN" : lastStatus}  raw=${JSON.stringify(st)}`);
    if (st.barHidden && st.canvasW > 0 && i > 5) { booted = true; break; }
  } else {
    console.log(`t=${(i + 1) * 2.5}s  eval returned null`);
  }
}

fs.mkdirSync("shots", { recursive: true });
await send("Page.captureScreenshot", { format: "png" }).then((r) => {
  fs.writeFileSync("shots/howtofish-boot.png", Buffer.from(r.result?.data || "", "base64"));
});

/* Whitelist what counts as fatal: real page-level JS/network failures.
 * Everything the game's own Unity runtime logs (C# exceptions, missing
 * Addressables/Localization data in the export, shader warnings) cannot
 * block boot and is ignored. */
const FATAL_RE = /Uncaught |ReferenceError|TypeError|ChunkLoadError|Failed to (load|fetch)|createPlayer|ERR_(NAME|CONNECTION|INTERNET)/i;
const fatal = errors.filter((e) => FATAL_RE.test(e) && !/UnityEngine|Addressables|Localization/i.test(e));
console.log("---");
console.log("booted:", booted);
console.log("fatal errors:", fatal.length, fatal.slice(0, 3));
console.log("unity warnings:", warnings.length ? warnings.slice(0, 2) : "none");
console.log(booted && fatal.length === 0 ? "HOW TO FISH BOOT: PASS" : "HOW TO FISH BOOT: FAIL");
process.exitCode = booted && fatal.length === 0 ? 0 : 1;
