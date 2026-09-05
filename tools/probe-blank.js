const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function grabTarget(port) {
  for (let i = 0; i < 20; i++) { await sleep(400); try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const page = t.find(x => x.type === 'page' && !x.url.startsWith('chrome')); if (page) return page; } catch {} }
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
  const p = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(os.tmpdir(), 'blank-' + Date.now())}`, '--headless=new', '--no-first-run', '--disable-extensions', '--enable-unsafe-swiftshader', '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });
  const page = await grabTarget(port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = cdp(ws);
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  for (const url of ['about:blank', 'data:text/html,<body style="background:%23e9eaeb"></body>', 'http://127.0.0.1:4173/bg-chalk.webp']) {
    try { await send('Page.navigate', { url }); await sleep(2000); } catch {}
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
    console.log(url, Buffer.from(shot.data, 'base64').length, 'bytes');
  }
  try { p.kill(); } catch {}
  process.exit(0);
}
main().catch(e => { console.log('FATAL', e.message); process.exit(1); });