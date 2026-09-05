// Probe: watch clpokered.html boot over ~70s, dumping state each poll.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 9355;
const profile = path.join(os.tmpdir(), 'probe-ejs-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-component-extensions-with-background-pages',
  '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--window-size=1280,720', 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CLICK = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => /play|start/i.test(x.textContent || ''));
  if (b) { b.click(); return 'clicked:' + b.textContent; }
  return 'no button';
})()`;
const STATE = `(() => {
  const canvases = [...document.querySelectorAll('canvas')].map(c => { const r = c.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); });
  const txt = (document.body && document.body.innerText ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 200);
  return { href: location.href, canvases, txt,
    game: !!document.getElementById('game'),
    btn: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).slice(0, 4) };
})()`;

async function main() {
  let target;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    try { const t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = t.find(x => x.type === 'page' && !x.url.startsWith('chrome')); if (target) break; } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  await new Promise(r => ws.onopen = r);
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:4173/ugs/clpokered.html' });
  await sleep(3000);
  console.log('t=3s click:', await (await send('Runtime.evaluate', { expression: CLICK, returnByValue: true })).result.value);
  const netErrors = [];
  const orig = (await send('Network.enable')).ok;
  // attach late network logging via separate listener
  for (let t = 5; t <= 75; t += 5) {
    await sleep(5000);
    const r = await send('Runtime.evaluate', { expression: STATE, returnByValue: true });
    const st = r.result && r.result.value;
    let shot = null;
    try { shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 }); } catch {}
    console.log(`t=${t}s canvases=${JSON.stringify(st && st.canvases)} shot=${shot && shot.data ? Math.round(Buffer.from(shot.data, 'base64').length / 1024) : 0}KB game=${st && st.game} btn=${JSON.stringify(st && st.btn)} txt="${st && st.txt ? st.txt.slice(0, 90) : ''}"`);
  }
  console.log('done');
}
main().catch(e => console.log('ERR', e.message)).finally(() => { setTimeout(() => { try { chrome.kill(); } catch {} process.exit(0); }, 500); });
