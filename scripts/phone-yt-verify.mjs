/* Verify phone UI + YouTube embeds in chat.html (desktop + phone viewport). */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.env.TARGET || "http://127.0.0.1:4173";
const DBG = 9241;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-phone-profile";
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=390,844",
  "--no-proxy-server",
  ORIGIN + "/chat.html",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
setTimeout(() => { console.log("WATCHDOG"); process.exit(2); }, 120000);

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
    errors.push((d.exception?.description || d.text || "exception").slice(0, 120));
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
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

await sleep(5000);

// ---- phone layout checks (login window is the visible .mscr) ----
const phone = await evalJs(`(function(){
  var w = document.querySelector('.win.mscr.on') || document.querySelector('.win.mscr');
  var cs = w ? getComputedStyle(w) : null;
  var mb = document.querySelector('#lw .menubar') || document.querySelector('.menubar');
  var chip = mb ? mb.querySelector('.msub') : null;
  var chipVis = chip ? getComputedStyle(chip).display : 'none';
  var r = { vw: innerWidth, vh: innerHeight,
    winW: cs ? cs.width : '-', winH: cs ? cs.height : '-',
    chipDisplay: chipVis, hasDrawerBtn: !!document.getElementById('mbtn-phone') };
  var inp = document.querySelector('.cinp');
  if (inp) r.inpFont = getComputedStyle(inp).fontSize;
  return r;
})()`);
console.log("phone:", JSON.stringify(phone, null, 1));

// ---- youtube pipeline: run the real procTxt ----
const yt = await evalJs(`(async function(){
  var url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  var html = procTxt('check this out ' + url + ' and https://youtu.be/abc123def45?t=30 also https://example.com');
  var host = document.createElement('div');
  host.innerHTML = html;
  var card = host.querySelector('.yt-embed');
  var n = host.querySelectorAll('.yt-embed').length;
  var plain = host.querySelectorAll('a.mlnk').length;
  var res = { cards: n, plainLinks: plain, ids: [].map.call(host.querySelectorAll('.yt-embed'), function(c){ return c.dataset.yid; }) };
  if (card) {
    // click-to-load: press the thumb, expect an iframe pointing at the nocookie embed
    var btn = card.querySelector('.yt-thumb');
    btn.click();
    await new Promise(function(r){ setTimeout(r, 60); });
    var f = card.querySelector('iframe');
    res.iframeSrc = f ? f.src.slice(0, 72) : 'NONE';
    res.thumbBg = btn.style.backgroundImage.indexOf('i.ytimg.com') >= 0;
    res.aspect = getComputedStyle(card.querySelector('.yt-thumb') || card).aspectRatio;
  }
  // not-youtube must NOT become a card
  var h2 = procTxt('no embed https://vimeo.com/12345 here');
  res.vimeoCards = (h2.match(/yt-embed/g) || []).length;
  res.vimeoLink = h2.indexOf('a class="mlnk"') >= 0;
  return res;
})()`);
console.log("youtube:", JSON.stringify(yt, null, 1));

// screenshot of phone login + after arming a card
const shot = await send("Page.captureScreenshot", { format: "png" });
fs.mkdirSync("shots", { recursive: true });
fs.writeFileSync("shots/chat-phone.png", Buffer.from(shot.result.data, "base64"));

console.log("exceptions:", errors.length, errors.slice(0, 3));
const ok = phone && parseInt(phone.winH) > 800 && phone.chipDisplay !== "none"
  && phone.hasDrawerBtn && yt && yt.cards === 2 && yt.iframeSrc.indexOf("youtube-nocookie") > 0
  && yt.vimeoCards === 0 && errors.length === 0;
console.log(ok ? "PHONE-YT: PASS" : "PHONE-YT: FAIL");
process.exit(0);
