/* Phone dock + cleanup verify for chat.html:
 *  - phone (390x844): dock visible on lobby, Rooms/Friends switch panes,
 *    Settings opens the settings window, dock hides in a room, dots button OK
 *  - desktop (1500x950): dock never appears
 * Login needs Firebase, so the lobby window is forced visible (same trick as
 * phone-yt-verify). */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ORIGIN = process.env.TARGET || "http://127.0.0.1:4173";
const DBG = 9253;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-dock-profile";
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
setTimeout(() => { console.log("WATCHDOG"); process.exit(2); }, 90000);

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
  if (r.result?.exceptionDetails) return { __err: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 140) };
  return r.result?.result?.value;
};
await send("Page.enable");
await send("Runtime.enable");
await sleep(5000);

const results = { phone: {}, desktop: {} };

/* ---------- phone pass ---------- */
await evalJs(`(function(){
  document.getElementById('aw')?.classList.remove('on');
  document.getElementById('lw')?.classList.add('on');
  return 1;
})()`);
await sleep(1200); // let a dockSync tick fire
results.phone.dockVisible = await evalJs(`(function(){
  const d = document.getElementById('phone-dock');
  return !!d && !d.hidden && getComputedStyle(d).display !== 'none';
})()`);
results.phone.roomsPaneMode = await evalJs(`(function(){
  const pans = document.querySelectorAll('.lcols .lpan');
  const vis = [].filter.call(pans, p => { const r = p.getBoundingClientRect(); return r.width > 2 && r.height > 2; });
  return { visible: vis.length, dockAttr: document.body.dataset.dock || null, bodyDock: document.body.classList.contains('dock-on') };
})()`);
await evalJs(`document.getElementById('dock-friends')?.click()`);
await sleep(400);
results.phone.friendsPaneMode = await evalJs(`(function(){
  const pans = document.querySelectorAll('.lcols .lpan');
  const vis = [].filter.call(pans, p => { const r = p.getBoundingClientRect(); return r.width > 2 && r.height > 2; });
  const friendsTabOn = document.getElementById('fsubtab-friends');
  const fsOn = [].find.call(vis, p => p.querySelector('#fsubtab-friends, #dminboxlist, #reqlist'));
  return { visible: vis.length, friendsPaneShown: !!fsOn, dockAttr: document.body.dataset.dock || null,
           friendsOnClass: friendsTabOn ? friendsTabOn.style.color : null };
})()`);
await evalJs(`document.getElementById('dock-settings')?.click()`);
await sleep(700);
results.phone.settingsOpens = await evalJs(`(function(){
  const sw = document.getElementById('sw');
  const r = sw ? sw.getBoundingClientRect() : null;
  const nav = document.querySelector('#sw .snav');
  const navDir = nav ? getComputedStyle(nav).flexDirection : null;
  return { settingsOn: !!sw && sw.classList.contains('on'), dockAttr: document.body.dataset.dock || null,
           fullW: !!r && Math.abs(r.width - window.innerWidth) < 4, w: r ? Math.round(r.width) : 0, navDir };
})()`);
await evalJs(`document.getElementById('dock-rooms')?.click()`);
await sleep(400);
results.phone.backToRooms = await evalJs(`(function(){
  const lw = document.getElementById('lw');
  return { lobbyOn: !!lw && lw.classList.contains('on'), dockAttr: document.body.dataset.dock || null };
})()`);
results.phone.dockIconsDecode = await evalJs(`(function(){
  const imgs = document.querySelectorAll('#phone-dock img.pixi');
  let ok = 0;
  imgs.forEach(i => { if (i.complete && i.naturalWidth > 0) ok++; });
  return { total: imgs.length, decoded: ok };
})()`);
/* density: fake rooms at three counts -> class + floor + scroll behavior */
results.phone.density = await evalJs(`(async function(){
  const L = document.getElementById('publist');
  function mk(n) {
    L.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const row = document.createElement('div'); row.className = 'rrow';
      row.innerHTML = '<span class="rri"><img class="pixi" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""></span><div class="rrinf"><div class="rrn">Room ' + i + '</div><div class="rrm">host · CODE</div></div>';
      L.appendChild(row);
    }
  }
  const out = {};
  mk(2); if (typeof queueDensity === 'function') queueDensity(); await new Promise(r => setTimeout(r, 150));
  out.few = L.className;
  const xlRow = L.querySelector('.rrow');
  out.xlRowH = xlRow ? Math.round(xlRow.getBoundingClientRect().height) : 0;
  mk(9); if (typeof queueDensity === 'function') queueDensity(); await new Promise(r => setTimeout(r, 150));
  out.mid = L.className;
  mk(30); if (typeof queueDensity === 'function') queueDensity(); await new Promise(r => setTimeout(r, 150));
  out.many = L.className;
  out.scrolls = L.scrollHeight > L.clientHeight + 2;
  const xsRow = L.querySelector('.rrow');
  out.xsRowH = xsRow ? Math.round(xsRow.getBoundingClientRect().height) : 0;
  L.innerHTML = '';
  return out;
})()`);

/* simulate entering a room: dock must hide */
await evalJs(`(function(){
  document.getElementById('lw')?.classList.remove('on');
  document.getElementById('cw')?.classList.add('on');
  return 1;
})()`);
await sleep(700);
results.phone.dockHiddenInRoom = await evalJs(`(function(){
  const d = document.getElementById('phone-dock');
  const mb = document.getElementById('mbtn-phone');
  return { dockHidden: !!d && d.hidden, membersBtnText: mb ? mb.textContent : null };
})()`);
await evalJs(`(function(){
  document.getElementById('cw')?.classList.remove('on');
  document.getElementById('lw')?.classList.add('on');
  return 1;
})()`);
await sleep(600);

const shot = await send("Page.captureScreenshot", { format: "png" });
fs.mkdirSync("shots", { recursive: true });
fs.writeFileSync("shots/phone-dock.png", Buffer.from(shot.result.data, "base64"));

/* ---------- desktop pass ---------- */
await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
await sleep(900);
results.desktop.dockHidden = await evalJs(`(function(){
  const d = document.getElementById('phone-dock');
  return { hidden: !!d && d.hidden, display: d ? getComputedStyle(d).display : null, bodyDock: document.body.classList.contains('dock-on') };
})()`);

console.log(JSON.stringify(results, null, 1));
console.log("exceptions:", errors.length, errors.slice(0, 3));

const p = results.phone, d = results.desktop;
const ok = p.dockVisible && p.roomsPaneMode?.visible === 1 && p.roomsPaneMode?.dockAttr === "rooms"
  && p.friendsPaneMode?.visible === 1 && p.friendsPaneMode?.friendsPaneShown
  && p.friendsPaneMode?.dockAttr === "friends"
  && p.settingsOpens?.settingsOn && p.settingsOpens?.fullW && p.settingsOpens?.navDir === "row"
  && p.backToRooms?.dockAttr === "rooms"
  && p.dockIconsDecode?.total === 3 && p.dockIconsDecode?.decoded === 3
  && ["density-xl", "density-lg", "density-md"].some(c => p.density?.few?.includes(c))
  && ["density-sm", "density-xs"].some(c => p.density?.mid?.includes(c))
  && p.density?.many?.includes("density-xs") && p.density?.scrolls
  && p.density?.xsRowH >= 18 && p.density?.xsRowH <= 34
  && p.density?.xlRowH >= 55
  && p.dockHiddenInRoom?.dockHidden && p.dockHiddenInRoom?.membersBtnText === "···"
  && d.dockHidden?.hidden && d.dockHidden?.display === "none"
  && errors.length === 0;
console.log(ok ? "PHONE-DOCK: PASS" : "PHONE-DOCK: FAIL");
process.exit(0);
