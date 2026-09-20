/* Headless functional probe for the cloaking suite (arsenic port, item 735).
   Boots the real app like sweep-views does, then verifies:
     1. Custom cloak title + icon ride on top of any preset
     2. The panic key is ignored while typing in a field
     3. Panic target "ixl" rebuilds the educational cover in place
     4. Panic target URL leaves via location.replace (Back button clean)
   Run: node scripts/probe-cloak.mjs   (needs the server on 127.0.0.1:4173) */
import { setTimeout as sleep } from "node:timers/promises";
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";

const PORT = 4173;
const DBG = 9227; /* sweep owns 9226, final-smoke 9225 */
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-cloak-probe-profile";
rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=1440,900",
  "about:blank",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
setTimeout(() => { console.log("PROBE: watchdog timeout"); process.exit(2); }, 120000);

async function json(url) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch {}
    await sleep(250);
  }
  throw new Error("no CDP endpoint on " + DBG);
}
const targets = await json(`http://127.0.0.1:${DBG}/json/list`);
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("page eval failed: " + (r.result.exceptionDetails.text || "?"));
  return r.result?.result?.value;
};

await send("Runtime.enable");
await send("Page.enable");

console.log("PROBE: booting app...");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(6000);
await evalJs(`(function(){var c=document.getElementById("blocked-cloak");if(c)c.click();return 1;})()`);
await sleep(2500);
console.log("PROBE: booted");

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  (" + detail + ")" : ""));
  if (!ok) failures++;
};

/* 1. Custom cloak title + icon win over the preset */
await evalJs(`
  localStorage.setItem("chalkle-cloak-title", "My Silent Study");
  localStorage.setItem("chalkle-cloak-icon", "https://example.com/custom-ico.png");
  window.ChalkleCloak.apply("google");
  1`);
await sleep(300);
const title1 = await evalJs(`document.title`);
const icon1 = await evalJs(`document.querySelector('link[rel="icon"]').href`);
check("custom title overrides preset", title1 === "My Silent Study", title1);
check("custom icon overrides preset", icon1 === "https://example.com/custom-ico.png", icon1);

/* Custom with the "None" preset still applies */
await evalJs(`window.ChalkleCloak.apply(""); 1`);
const title2 = await evalJs(`document.title`);
check("custom title survives None preset", title2 === "My Silent Study", title2);

/* 2. Panic key ignored while typing */
await evalJs(`
  localStorage.setItem("chalkle-panic", JSON.stringify({ key: "\`", target: "ixl" }));
  1`);
const guardBefore = await evalJs(`(function(){
  var inp = document.getElementById("opt-cloak-title");
  inp.focus();
  inp.dispatchEvent(new KeyboardEvent("keydown", { key: "\`", bubbles: true, cancelable: true }));
  return document.getElementById("ixl-cover") ? "covered" : "open";
})()`);
check("panic key ignored inside inputs", guardBefore === "open", guardBefore);

/* 3. Panic "ixl" rebuilds the educational cover */
await evalJs(`document.activeElement && document.activeElement.blur(); 1`);
const coverState = await evalJs(`(function(){
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "\`", bubbles: true, cancelable: true }));
  var cover = document.getElementById("ixl-cover");
  if (!cover) return { present: false };
  var cs = getComputedStyle(cover);
  return {
    present: true,
    fixed: cs.position === "fixed",
    onTop: cs.zIndex !== "auto" && Number(cs.zIndex) > 0,
    title: document.title.indexOf("IXL") === 0
  };
})()`);
check("panic ixl rebuilds cover", !!coverState.present, JSON.stringify(coverState));
check("panic ixl cover fixed on top", !!(coverState.fixed && coverState.onTop));
check("panic ixl sets IXL title", !!coverState.title);

/* 4. Panic URL target replaces the page (about:blank is offline-proof) */
await evalJs(`localStorage.setItem("chalkle-panic", JSON.stringify({ key: "\`", target: "about:blank" })); 1`);
await evalJs(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "\`", bubbles: true, cancelable: true })); 1`);
await sleep(1200);
const href = await evalJs(`location.href`);
check("panic url escapes via replace", href === "about:blank", href);

console.log("");
console.log(failures === 0 ? "PROBE: PASS (cloaking suite)" : "PROBE: " + failures + " failure(s)");
try { ws.close(); } catch {}
process.exit(failures === 0 ? 0 : 1);
