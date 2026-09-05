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
  const visible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && st.display !== 'none' && st.visibility !== 'hidden'; };
  // Once a canvas exists the game is running - NEVER click in-game controls
  // (emulator menu bars expose Pause/Restart/Save and would self-sabotage).
  const hasCanvas = !!document.querySelector('canvas');
  if (!hasCanvas) {
    // Pre-game: click boot controls (PLAY / Start overlays). Never anchors.
    try {
      const cands = [...document.querySelectorAll('button, .btn, [role=button], [class*=start], [class*=play], [id*=start], [id*=play], [onclick]')]
        .filter(el => { if (el.tagName === 'A') return false; return visible(el); });
      for (const el of cands.slice(0, 12)) {
        try { if (typeof el.click === 'function') el.click(); } catch (e) {}
        const r = el.getBoundingClientRect();
        const cx = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
        const cy = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
        ev(el, 'pointerdown', { clientX: cx, clientY: cy, button: 0 });
        ev(el, 'pointerup', { clientX: cx, clientY: cy, button: 0 });
        ev(el, 'mousedown', { clientX: cx, clientY: cy, button: 0 });
        ev(el, 'mouseup', { clientX: cx, clientY: cy, button: 0 });
        ev(el, 'click', { clientX: cx, clientY: cy, button: 0 });
      }
    } catch (e) {}
  }
  // Center pointer taps for games waiting on gestures. NO synthetic keyboard
  // events: Enter/Space at the wrong moment can pause or break games.
  ev(document, 'pointerdown', { clientX: 640, clientY: 360, button: 0 });
  ev(document, 'mousedown', { clientX: 640, clientY: 360, button: 0 });
  ev(document, 'mouseup', { clientX: 640, clientY: 360, button: 0 });
  ev(document, 'click', { clientX: 640, clientY: 360, button: 0 });
  return hasCanvas ? 'canvas' : 'boot';
})()`;

const BODY_TXT = `(() => { const b = document.body; return b ? (b.innerText || '').slice(0, 250).replace(/\\s+/g, ' ') : ''; })()`;

// In-page pixel analysis of a captured frame: mean luminance + stddev over a
// 320x180 downsample. Blank/loader frames (all-black or all-white, low
// variance) fail regardless of JPEG byte size; real gameplay passes.
function frameStatsExpr(b64) {
  return `new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = 160; c.height = 90;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, 160, 90);
      try {
        const d = x.getImageData(0, 0, 160, 90).data;
        let sum = 0, ss = 0, n = 0;
        for (let i = 0; i < d.length; i += 16) {
          const l = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
          sum += l; ss += l * l; n++;
        }
        const mean = sum / n;
        res({ mean: Math.round(mean), sd: Math.round(Math.sqrt(Math.max(ss / n - mean * mean, 0))) });
      } catch (e) { res({ mean: -1, sd: 0 }); }
    };
    img.onerror = () => res({ mean: -2, sd: 0 });
    img.src = 'data:image/jpeg;base64,' + '${b64}';
  })`;
}
const looksLikeContent = (st) => st && st.mean >= 18 && st.mean <= 240 && st.sd >= 10;

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
    // Let the page settle before the first poke, like a real user would.
    await sleep(3500);
    while (Date.now() - start < item.budgetMs) {
      await sleep(POLL_MS);
      polls++;
      const elapsed = Date.now() - start;
      let shot = null;
      try {
        shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
      } catch {}
      if (!shot || !shot.data) continue;
      const buf = Buffer.from(shot.data, 'base64');
      const isContent = buf.length >= CONTENT_MIN;
      let txt = '';
      let stats = null;
      try {
        const s = await send('Runtime.evaluate', { expression: frameStatsExpr(shot.data), awaitPromise: true, returnByValue: true });
        stats = s.result && s.result.value;
      } catch {}
      try {
        const r = await send('Runtime.evaluate', { expression: BODY_TXT, returnByValue: true });
        txt = r.result && r.result.value ? r.result.value : '';
      } catch {}
      const loadingish = /\b(loading|compiling|compile|progress|downloading|decompressing|please wait|preparing|error|404|not found|unavailable)\b/i.test(txt);
      const real = isContent && looksLikeContent(stats) && !loadingish;
      if (real) {
        if (buf.length >= best) {
          if (buf.length > best) { best = buf.length; fs.writeFileSync(outPath, buf); }
          stable = 0;
        } else {
          stable++;
        }
      } else {
        stable = 0;
      }
      // Only poke the page while it still looks blank/loading - once real
      // content is on screen, leave the game alone so it can settle.
      if (!real && elapsed < 60000) {
        try { await send('Runtime.evaluate', { expression: UNSTICK, returnByValue: true }); } catch {}
      }
      if (best >= CONTENT_MIN && stable >= STABLE_POLLS) break;
    }
    let status;
    if (best >= CONTENT_MIN && (best > 0)) status = 'content';
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
  const procs = [];
  const jobs = [];
  for (let w = 0; w < workersN; w++) {
    const port = 9400 + w;
    const profile = path.join(os.tmpdir(), 'real-shot-' + w + '-' + Date.now());
    const p = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...CHROME_FLAGS, 'about:blank'], { stdio: 'ignore' });
    procs.push(p);
    jobs.push(worker(port, queues[w], w));
  }
  const flat = (await Promise.all(jobs)).flat();
  for (const p of procs) { try { p.kill(); } catch {} }
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