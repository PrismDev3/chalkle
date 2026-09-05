// real-shots.js — Boots local game HTML files headless and captures a real
// in-game screenshot as a JPEG thumb. Audio/gesture stalls are unstuck with
// synthetic clicks. Real content is detected by JPEG byte-size stability
// (blank/loading pages are small; rendered game frames are large).
//
// Worklist JSON: [{ slug, url, budgetMs, size }]
//   slug   -> output file assets/games/real/<slug>.jpg
//   url    -> absolute URL to load (local server)
//   budgetMs -> per-game capture budget
//
// Usage: node tools/real-shots.js worklist.json [workers]
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(__dirname, '..', 'assets', 'games', 'real');
const CONTENT_MIN = 16000; // jpeg bytes for a "real" frame (blank ~6KB, content >=16KB)
const STABLE_POLLS = 4;    // consecutive non-improving polls => done
const POLL_MS = 2500;
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

const BODY_TXT = `(() => { const b = document.body; return b ? (b.innerText || '').slice(0, 250).replace(/\\s+/g, ' ') : ''; })()`;

async function shootOne(port, item, idx) {
  const page = await grabTarget(port);
  if (!page) return { slug: item.slug, status: 'no-target' };
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  const send = cdp(ws);
  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: item.url });
    const start = Date.now();
    let best = 0;
    let stable = 0;
    let polls = 0;
    const outPath = path.join(OUT, item.slug + '.jpg');
    while (Date.now() - start < item.budgetMs) {
      await sleep(POLL_MS);
      polls++;
      const elapsed = Date.now() - start;
      // Unstick audio/gesture stalls during the boot window, sparingly.
      if (elapsed < 15000 && polls % 2 === 0) {
        try { await send('Runtime.evaluate', { expression: UNSTICK, returnByValue: true }); } catch {}
      }
      let shot = null;
      try {
        shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
      } catch {}
      if (!shot || !shot.data) continue;
      const buf = Buffer.from(shot.data, 'base64');
      const isContent = buf.length >= CONTENT_MIN;
      let txt = '';
      try {
        const r = await send('Runtime.evaluate', { expression: BODY_TXT, returnByValue: true });
        txt = r.result && r.result.value ? r.result.value : '';
      } catch {}
      const loadingish = /\b(loading|compiling|compile|progress|downloading|decompressing|please wait|preparing|error|404|not found|unavailable)\b/i.test(txt);
      if (isContent && !loadingish) {
        if (buf.length >= best) {
          if (buf.length > best) { best = buf.length; fs.writeFileSync(outPath, buf); }
          stable = 0;
        } else {
          stable++;
        }
      } else {
        stable = 0;
      }
      if (best >= CONTENT_MIN && stable >= STABLE_POLLS) break;
    }
    let status;
    if (best >= CONTENT_MIN) status = 'content';
    else if (fs.existsSync(outPath) && fs.statSync(outPath).size >= CONTENT_MIN) status = 'content';
    else status = 'weak-' + best;
    if (status !== 'content' && fs.existsSync(outPath)) {
      try { fs.unlinkSync(outPath); } catch {}
    }
    return { slug: item.slug, status, bytes: best, ms: Date.now() - start };
  } catch (e) {
    return { slug: item.slug, status: 'err-' + e.message.slice(0, 80) };
  } finally {
    try { ws.close(); } catch {}
  }
}

async function worker(port, items, idx) {
  const done = [];
  for (const it of items) {
    try {
      const r = await shootOne(port, it, idx);
      console.log(`[w${idx}] ${r.status} ${(r.bytes || 0)}B ${(r.ms / 1000).toFixed(0)}s ${it.slug}`);
      done.push(r);
    } catch (e) {
      console.log(`[w${idx}] ERR ${it.slug}: ${e.message}`);
      done.push({ slug: it.slug, status: 'err' });
    }
  }
  return done;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const worklistPath = process.argv[2];
  const workersN = parseInt(process.argv[3] || '8', 10);
  if (!worklistPath) { console.error('usage: node tools/real-shots.js worklist.json [workers]'); process.exit(1); }
  let items = JSON.parse(fs.readFileSync(worklistPath, 'utf8'));
  // Skip already-captured (resume support)
  items = items.filter(it => !fs.existsSync(path.join(OUT, it.slug + '.jpg')) || fs.statSync(path.join(OUT, it.slug + '.jpg')).size < CONTENT_MIN);
  items.sort((a, b) => (b.size || 0) - (a.size || 0));
  console.log(`worklist: ${items.length} to capture, ${workersN} workers`);
  const queues = Array.from({ length: workersN }, () => []);
  items.forEach((it, i) => queues[i % workersN].push(it));
  const results = [];
  for (let w = 0; w < workersN; w++) {
    const port = 9400 + w;
    const profile = path.join(os.tmpdir(), 'real-shot-' + w + '-' + Date.now());
    const p = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...CHROME_FLAGS, 'about:blank'], { stdio: 'ignore' });
    results.push(worker(port, queues[w], w));
    results.push(new Promise(r => setTimeout(() => { try { p.kill(); } catch {} r(); }, 4 * 3600000)));
  }
  const out = await Promise.all(results);
  const flat = out.filter(Array.isArray).flat();
  const ok = flat.filter(r => r.status === 'content');
  const weak = flat.filter(r => r.status && r.status.startsWith('weak'));
  const bad = flat.filter(r => !r.status || (r.status !== 'content' && !r.status.startsWith('weak')));
  console.log(`\nSUMMARY: content=${ok.length} weak=${weak.length} bad=${bad.length} of ${flat.length}`);
  if (weak.length) console.log('weak:', weak.map(r => r.slug).join(', '));
  if (bad.length) console.log('bad:', bad.map(r => r.slug).join(', '));
  fs.writeFileSync(path.join(__dirname, '..', 'tmp-real-shots-report.json'), JSON.stringify({ ok, weak, bad }, null, 1));
  process.exit(0);
}

main().catch(e => { console.log('FATAL', e.message); process.exit(1); });