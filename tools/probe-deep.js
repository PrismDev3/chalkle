const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function grabTarget(port) {
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = t.find(x => x.type === 'page' && !x.url.startsWith('chrome'));
      if (page) return page;
    } catch (e) {}
  }
  return null;
}
function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  const send = (method, params) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
  return send;
}
async function main() {
  const port = 9409;
  const p = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(os.tmpdir(), 'probe-' + Date.now())}`, '--headless=new', '--no-first-run', '--disable-extensions', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });
  const page = await grabTarget(port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = cdp(ws);
  const errs = [];
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Network.loadingFailed') errs.push(m.params.errorText + ' ' + m.params.type); });
  await send('Network.enable');
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:4173/ugs/cl2048cupcakes.html' });
  for (let i = 0; i < 14; i++) {
    await sleep(2500);
    const r = await send('Runtime.evaluate', { expression: `(() => {
      const c = document.querySelector('canvas');
      let info = null;
      if (c) {
        try {
          const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('2d');
          info = { w: c.width, h: c.height, hasGL: !!gl };
        } catch (e) { info = { w: c.width, h: c.height, err: e.message }; }
      }
      return { text: (document.body.innerText || '').slice(0, 300).replace(/\\s+/g,' '), canvas: info, iframes: document.querySelectorAll('iframe').length, title: document.title };
    })()`, returnByValue: true });
    const v = r.result.value;
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
    const buf = Buffer.from(shot.data, 'base64');
    fs.writeFileSync('tmp-diag/' + i + '.jpg', buf);
    console.log('poll', i, 'bytes', buf.length, JSON.stringify(v).slice(0, 300));
  }
  console.log('net errors:', errs.slice(0, 10));
  try { p.kill(); } catch {}
  process.exit(0);
}
main().catch(e => { console.log('FATAL', e.message); process.exit(1); });