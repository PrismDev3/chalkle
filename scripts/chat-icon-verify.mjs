/* Verify chat icon + declutter pass:
 *  - phone (390x844): lobby menubar chips each carry a decoding pixel icon,
 *    ustrip Settings/Sign Out hidden (chips cover them), New Room visible
 *  - desktop (1500x950): ustrip keeps all three buttons, menu items carry icons
 *  - every img.pixi on the page decodes; zero runtime exceptions
 */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.env.TARGET || "http://127.0.0.1:4173";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

async function run(width, height, label) {
  const DBG = 9253 + (label === "phone" ? 0 : 1);
  const profile = `/tmp/chalkle-icn-${label}`;
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--mute-audio", `--window-size=${width},${height}`,
    "--no-proxy-server", ORIGIN + "/chat.html",
  ], { stdio: "ignore" });
  process.on("exit", () => { try { chrome.kill(); } catch {} });
  try {
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
    const errors = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        errors.push((d.exception?.description || d.text || "exception").slice(0, 100));
      }
    };
    const send = (method, params = {}) =>
      new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 140) };
      return r.result?.result?.value;
    };
    await send("Page.enable");
    await send("Runtime.enable");
    await sleep(5000);

    await evalJs(`(function(){
      document.getElementById('aw')?.classList.remove('on');
      document.getElementById('lw')?.classList.add('on');
      return 1;
    })()`);
    await sleep(1400);

    const out = await evalJs(`(function(){
      const res = {};
      const chips = [...document.querySelectorAll('#lw .menubar .msub')];
      res.chips = chips.map(c => ({
        text: c.textContent.trim().slice(0, 24),
        hasImg: !!c.querySelector('img.pixi'),
      }));
      res.chipImgsDecode = [...document.querySelectorAll('#lw .menubar .msub img.pixi')]
        .every(i => i.complete && i.naturalWidth > 0);
      const us = document.querySelector('#lw .ustrip');
      res.ustrip = {
        newRoomVisible: (() => { const b = [...us.querySelectorAll('button')].find(x => x.textContent.includes('New Room')); return !!b && getComputedStyle(b).display !== 'none'; })(),
        settingsHidden: (() => { const b = [...us.querySelectorAll('button')].find(x => x.getAttribute('onclick') === 'openSettings()'); return !b || getComputedStyle(b).display === 'none'; })(),
        signoutHidden: (() => { const b = [...us.querySelectorAll('button')].find(x => x.getAttribute('onclick') === 'doLogout()'); return !b || getComputedStyle(b).display === 'none'; })(),
        buttonCount: us.querySelectorAll('button').length,
      };
      res.allPixiDecode = [...document.querySelectorAll('img.pixi')].every(i => i.complete && i.naturalWidth > 0);
      res.allPixiCount = document.querySelectorAll('img.pixi').length;
      return res;
    })()`);
    console.log(`== ${label} (${width}x${height}) ==`);
    console.log(JSON.stringify(out, null, 1));
    console.log("exceptions:", errors.length ? errors.slice(0, 4) : "none");
    return { ...out, errorCount: errors.length };
  } finally {
    try { chrome.kill(); } catch {}
  }
}

const phone = await run(390, 844, "phone");
const desktop = await run(1500, 950, "desktop");

let fail = 0;
const checks = [
  ["phone chips all have icons", phone?.chips?.length >= 3 && phone.chips.every(c => c.hasImg)],
  ["phone chips decode", phone?.chipImgsDecode === true],
  ["phone ustrip New Room visible", phone?.ustrip?.newRoomVisible === true],
  ["phone ustrip Settings hidden", phone?.ustrip?.settingsHidden === true],
  ["phone ustrip Sign Out hidden", phone?.ustrip?.signoutHidden === true],
  ["desktop ustrip keeps buttons", desktop?.ustrip?.buttonCount === 3],
  ["desktop ustrip Settings visible", desktop?.ustrip?.settingsHidden === false],
  ["desktop ustrip Sign Out visible", desktop?.ustrip?.signoutHidden === false],
  ["desktop chips have icons", desktop?.chips?.length >= 3 && desktop.chips.every(c => c.hasImg)],
  ["all pixi icons decode (phone)", phone?.allPixiDecode === true],
  ["no runtime exceptions (phone)", (phone?.errorCount ?? 0) === 0],
  ["no runtime exceptions (desktop)", (desktop?.errorCount ?? 0) === 0],
];
for (const [name, ok] of checks) {
  console.log((ok ? "PASS" : "FAIL") + "  " + name);
  if (!ok) fail++;
}
console.log(fail ? `\n${fail} FAILURES` : "\nALL PASS");
process.exit(fail ? 1 : 0);