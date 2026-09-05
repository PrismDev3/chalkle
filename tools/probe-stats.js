// Probe: per-poll pixel stats (mean/sd) while clpokered boots after PLAY click.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 9356;
const profile = path.join(os.tmpdir(), 'probe-stats-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-component-extensions-with-background-pages',
  '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--window-size=1280,720', 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CLICK = `(() => { const b = [...document.querySelectorAll('button')].find(x => /play|start/i.test(x.textContent || '')); if (b) { b.click(); return 'clicked'; } return 'no button'; })()`;

async function main() {
  let target;
  for (let i = 0; i < 30; i++) { await sleep(400); try { const t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = t.find(x => x.type === 'page' && !x.url.startsWith('chrome')); if (target) break; } catch {} }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  await new Promise(r => ws.onopen = r);
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:4173/ugs/clpokered.html' });
  await sleep(4000);
  console.log('click:', (await send('Runtime.evaluate', { expression: CLICK, returnByValue: true })).result.value);
  for (let t = 6; t <= 46; t += 5) {
    await sleep(5000);
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
    const b64 = shot.data;
    const expr = `new Promise((res) => { const img = new Image();
      img.onload = () => { const c = document.createElement('canvas'); c.width = 160; c.height = 90;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0, 160, 90);
        try { const d = x.getImageData(0, 0, 160, 90).data; let sum = 0, ss = 0, n = 0;
          for (let i = 0; i < d.length; i += 16) { const l = (d[i]*299 + d[i+1]*587 + d[i+2]*114)/1000; sum += l; ss += l*l; n++; }
          const mean = sum/n; res({ mean: Math.round(mean), sd: Math.round(Math.sqrt(Math.max(ss/n - mean*mean, 0))) }); }
        catch (e) { res({ mean: -1, sd: 0 }); } };
      img.onerror = () => res({ mean: -2, sd: 0 });
      img.src = 'data:image/jpeg;base64,' + '${b64}'; })`;
    const st = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const kb = Math.round(Buffer.from(b64, 'base64').length / 1024);
    console.log(`t=${t}s kb=${kb}KB stats=${JSON.stringify(st.result && st.result.value)}`);
  }
  console.log('done');
}
main().catch(e => console.log('ERR', e.message)).finally(() => { setTimeout(() => { try { chrome.kill(); } catch {} process.exit(0); }, 500); });
