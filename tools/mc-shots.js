// mc-shots.js — Boots each mc/<slug>.html locally and captures a real
// in-game screenshot. Audio init in these EaglercraftX builds blocks on a
// user gesture, so we dispatch synthetic clicks early on. Real content is
// detected by PNG size stability (blank pages ~5.8KB; real frames >= 13KB).
// Usage: node tools/mc-shots.js [slug ...]   (default: all files in mc/)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:4173/mc/';
const OUT = path.join(__dirname, '..', 'tmp-mcshots');
const WORKERS = 4;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROME_FLAGS = [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-component-extensions-with-background-pages',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--window-size=1280,720'
];

async function grabTarget(port) {
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = t.find(x => x.type === 'page' && !x.url.startsWith('chrome'));
      if (page) return page;
    } catch {}
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

const UNSTICK = `(() => {
  const ev = (el, type, init) => { try { el.dispatchEvent(new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true }, init || {}))); } catch (e) {} };
  ev(document, 'pointerdown', { clientX: 640, clientY: 360, button: 0 });
  ev(document, 'mousedown', { clientX: 640, clientY: 360, button: 0 });
  ev(document, 'mouseup', { clientX: 640, clientY: 360, button: 0 });
  ev(document, 'click', { clientX: 640, clientY: 360, button: 0 });
  ev(window, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 });
  ev(window, 'keyup', { key: 'Enter', code: 'Enter', keyCode: 13 });
  return 1;
})()`;

const BODY_TXT = `(() => { const b = document.body; return b ? (b.innerText || '').slice(0, 200).replace(/\\s+/g, ' ') : ''; })()`;

async function shootOne(port, slug, budgetMs) {
  const page = await grabTarget(port);
  if (!page) return { slug, status: 'no-target' };
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  const send = cdp(ws);
  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: BASE + slug + '.html' });
    const start = Date.now();
    let best = 0;           // largest good shot bytes
    let stable = 0;         // consecutive polls where best didn't improve
    let polls = 0;
    let lastTxt = '';
    const outPath = path.join(OUT, slug + '.png');
    while (Date.now() - start < budgetMs) {
      await sleep(3500);
      polls++;
      const elapsed = Date.now() - start;
      // Unstick audio: only during the boot window (first ~12s), sparingly.
      if (elapsed < 12000 && polls % 2 === 0) {
        try { await send('Runtime.evaluate', { expression: UNSTICK, returnByValue: true }); } catch {}
      }
      let shot = null;
      try { shot = await send('Page.captureScreenshot', { format: 'png' }); } catch {}
      if (!shot || !shot.data) continue;
      const buf = Buffer.from(shot.data, 'base64');
      const isContent = buf.length >= 13000;
      let txt = '';
      try {
        const r = await send('Runtime.evaluate', { expression: BODY_TXT, returnByValue: true });
        txt = r.result && r.result.value ? r.result.value : '';
      } catch {}
      const loadingish = /(loading|compil|progress|%|downloading|decompress)/i.test(txt);
      if (isContent && !loadingish) {
        if (buf.length >= best) {
          if (buf.length > best) { best = buf.length; fs.writeFileSync(outPath, buf); }
          stable = 0;
        } else {
          stable++;
        }
      } else if (isContent && loadingish) {
        // DOM says still loading; keep polling
        stable = 0;
      } else {
        stable = 0;
      }
      // Done when content has been stable (not growing) for ~5 polls (~17s)
      // and we have at least a real frame.
      if (best >= 13000 && stable >= 5) break;
    }
    let status;
    if (best >= 13000) status = 'content';
    else if (fs.existsSync(outPath) && fs.statSync(outPath).size >= 13000) status = 'content';
    else status = 'weak-' + best;
    // if nothing good, drop any partial file so old generated thumbs stay
    if (status !== 'content' && fs.existsSync(outPath)) {
      try { fs.unlinkSync(outPath); } catch {}
    }
    return { slug, status, bytes: best, ms: Date.now() - start };
  } catch (e) {
    return { slug, status: 'err-' + e.message.slice(0, 80) };
  } finally {
    try { ws.close(); } catch {}
  }
}

async function worker(port, files, idx) {
  const done = [];
  for (const f of files) {
    const budget = f.size > 40 * 1024 * 1024 ? 280000 : f.size > 15 * 1024 * 1024 ? 200000 : 110000;
    try {
      const r = await shootOne(port, f.slug, budget);
      console.log(`[w${idx}] ${r.status} ${(r.bytes || 0)}B ${(r.ms / 1000).toFixed(0)}s ${f.name}`);
      done.push(r);
    } catch (e) {
      console.log(`[w${idx}] ERR ${f.name}: ${e.message}`);
      done.push({ slug: f.slug, status: 'err' });
    }
  }
  return done;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const slugs = process.argv.slice(2);
  let files;
  if (slugs.length) {
    files = slugs.map(s => ({ slug: s, name: s + '.html', size: fs.existsSync('mc/' + s + '.html') ? fs.statSync('mc/' + s + '.html').size : 0 }));
  } else {
    files = fs.readdirSync('mc').filter(f => f.endsWith('.html')).map(f => {
      const st = fs.statSync('mc/' + f);
      return { slug: f.slice(0, -5), name: f, size: st.size };
    });
  }
  files.sort((a, b) => b.size - a.size);
  const queues = Array.from({ length: WORKERS }, () => []);
  files.forEach((f, i) => queues[i % WORKERS].push(f));
  const results = [];
  for (let w = 0; w < WORKERS; w++) {
    const port = 9500 + w;
    const profile = path.join(os.tmpdir(), 'mc-shot-' + w + '-' + Date.now());
    const p = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...CHROME_FLAGS, 'about:blank'], { stdio: 'ignore' });
    results.push(worker(port, queues[w], w));
    results.push(new Promise(r => setTimeout(() => { try { p.kill(); } catch {} r(); }, 3600000)));
  }
  const out = await Promise.all(results);
  const flat = out.filter(Array.isArray).flat();
  const ok = flat.filter(r => r.status === 'content');
  const weak = flat.filter(r => r.status && r.status.startsWith('weak'));
  const bad = flat.filter(r => !r.status || (r.status !== 'content' && !r.status.startsWith('weak')));
  console.log(`\nSUMMARY: content=${ok.length} weak=${weak.length} bad=${bad.length} of ${flat.length}`);
  if (weak.length) console.log('weak:', weak.map(r => r.name || r.slug).join(', '));
  if (bad.length) console.log('bad:', bad.map(r => r.name || r.slug).join(', '));
  process.exit(0);
}

main().catch(e => { console.log('FATAL', e.message); process.exit(1); });
