// minimal probe: one game, verbose logging, 60s hard cap
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function grabTarget(port) {
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = t.find(x => x.type === 'page' && !x.url.startsWith('chrome'));
      if (page) return page;
    } catch (e) { console.log('grab err', e.message); }
  }
  return null;
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return send;
}

async function main() {
  const port = 9409;
  const prof = pdir => path.join(os.tmpdir(), 'probe-' + pdir + '-' + Date.now());
  const p = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${prof('d')}`, '--headless=new', '--no-first-run', '--disable-extensions', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });
  console.log('chrome spawned pid', p.pid);
  const page = await grabTarget(port);
  if (!page) { console.log('NO TARGET'); process.exit(1); }
  console.log('target', page.url);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  console.log('ws open');
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  console.log('navigating');
  await send('Page.navigate', { url: 'http://127.0.0.1:4173/ugs/cl2048cupcakes.html' });
  for (let i = 0; i < 20; i++) {
    await sleep(2500);
    try {
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
      const buf = Buffer.from(shot.data, 'base64');
      console.log('poll', i, 'jpeg bytes', buf.length);
      if (buf.length > 35000) { console.log('CONTENT!'); break; }
    } catch (e) { console.log('shot err', e.message); }
  }
  try { p.kill(); } catch {}
  process.exit(0);
}
main().catch(e => { console.log('FATAL', e.message); process.exit(1); });