/* Redesign smoke: boot the app, screenshot Home and Games, count console
 * errors, verify theme.js custom properties still resolve. */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 4173;
const DBG = 9229;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-redesign-profile";
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=1600,1000",
  "--hide-scrollbars",
  "about:blank",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
setTimeout(() => { console.log("WATCHDOG: timed out"); process.exit(2); }, 150000);

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
  else if (m.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(m.params.type)) {
    const txt = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (!/favicon|net::ERR_FAILED.*ads|adsbygoogle|ERR_BLOCKED_BY_CLIENT|gstatic|doubleclick/i.test(txt)) errors.push(txt);
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

await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(6500);
await evalJs(`(function(){var c=document.getElementById("blocked-cloak");if(c){c.click();}return !!c;})()`);
await sleep(2500);
fs.mkdirSync("shots", { recursive: true });
await send("Page.captureScreenshot", { format: "png" }).then((r) => {
  fs.writeFileSync("shots/redesign-home.png", Buffer.from(r.result?.data || "", "base64"));
});

// theme picker sanity: every theme var must resolve on :root
const themeVars = await evalJs(`(function(){
  var cs = getComputedStyle(document.documentElement);
  var keys = ["base","panel","panel-2","line","line-soft","topbar-bg","text","text-2","text-3","accent","accent-ink","accent-soft"];
  var out = {};
  keys.forEach(function(k){ var v = cs.getPropertyValue("--" + k).trim(); out[k] = v || "MISSING"; });
  return out;
})()`);

// switch to Games and screenshot
await evalJs(`(function(){var t=document.querySelector('[data-tab="games"],[data-view="games"]');if(t)t.click();return true;})()`);
await sleep(2500);
await send("Page.captureScreenshot", { format: "png" }).then((r) => {
  fs.writeFileSync("shots/redesign-games.png", Buffer.from(r.result?.data || "", "base64"));
});

const counts = await evalJs(`(function(){
  return {
    navItems: document.querySelectorAll('.nav-item').length,
    cards: document.querySelectorAll('#games-grid .card').length,
    chips: document.querySelectorAll('.chip').length
  };
})()`);
const missing = Object.entries(themeVars).filter(([, v]) => v === "MISSING").map(([k]) => k);
console.log("cards on games page:", counts.cards, "| nav items:", counts.navItems);
console.log("theme vars missing:", missing.length ? missing : "none (theme picker safe)");
console.log("console errors:", errors.length, errors.slice(0, 4));
const ok = counts.cards > 100 && missing.length === 0 && errors.length === 0;
console.log(ok ? "REDESIGN SMOKE: PASS" : "REDESIGN SMOKE: FAIL");
process.exitCode = ok ? 0 : 1;
