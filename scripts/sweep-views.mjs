/* Headless view sweep (items 491/694).
   Boots the real app in headless Chrome over CDP, walks EVERY top-level
   view section found in index.html, and captures per view:
     - console errors / assertions
     - uncaught page exceptions
     - same-origin (and local backend) responses with status >= 400
     - whether the app actually switched (body[data-view] + section visible)
   Expects the Chalkle server on 127.0.0.1:4173.
   Run: node scripts/sweep-views.mjs */
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";

const PORT = 4173;
const DBG = 9226; /* final-smoke owns 9225; stay out of its way */
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const profile = "/tmp/chalkle-sweep-profile";
rmSync(profile, { recursive: true, force: true });

/* Every line goes to stdout and to tmp/sweep-last.log (item 712). A pipe
   through head truncated this run twice into a silent timeout, and a sweep
   whose verdict never reaches the terminal is worse than one that fails. */
const LOG_PATH = new URL("../tmp/sweep-last.log", import.meta.url);
writeFileSync(LOG_PATH, "");
const say = (...parts) => {
  const line = parts.join(" ");
  console.log(line);
  try { appendFileSync(LOG_PATH, line + "\n"); } catch {}
};

/* The view list is derived, never hardcoded: every <section class="view"
   data-view="..."> in index.html gets walked, so a new tab is swept
   automatically and a removed one stops being probed. */
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const VIEWS = [
  ...new Set(
    [...html.matchAll(/<section class="view[^"]*"\s+data-view="([^"]+)"/g)].map((m) => m[1])
  ),
];
if (VIEWS.length < 10) {
  say("SWEEP: only found " + VIEWS.length + " view sections, index.html parse is suspect");
  process.exit(2);
}

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DBG}`,
  `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--window-size=1440,900",
  "about:blank",
], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
/* Hard stop for a wedged CDP read, cleared on a normal finish. The old code
   left this timer ref'd, so a passing sweep still sat here for four minutes
   and then exited 2 with "watchdog timeout", which is why it could not be
   part of a gate list (item 732). */
const watchdog = setTimeout(() => { say("SWEEP: watchdog timeout"); process.exit(2); }, 240000);

async function json(url) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch {}
    await sleep(250);
  }
  throw new Error("no CDP endpoint on " + DBG);
}
const targets = await json(`http://127.0.0.1:${DBG}/json/list`);
say("SWEEP: CDP up, " + targets.length + " targets");
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
let bucket = null; /* errors land in the view that is being swept */
const results = {};
const benign = /favicon|googleads|adsbygoogle|net::ERR_FAILED.*gstatic/i;

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (!m.method) return;
  if (!bucket) return;
  const b = bucket;
  if (m.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(m.params.type)) {
    const txt = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300);
    if (txt && !benign.test(txt)) b.errors.push(txt);
  } else if (m.method === "Runtime.exceptionThrown") {
    b.errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || "").slice(0, 300));
  } else if (m.method === "Network.responseReceived") {
    const { url, status } = m.params.response;
    if (status >= 400 && /^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) {
      b.net.push(status + " " + url.replace(/^https?:\/\/[^/]+/, "").slice(0, 120));
    }
  }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");

/* Boot once. The cloak click dismisses the school-filter workaround cover
   exactly like final-smoke does. */
say("SWEEP: booting app...");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(6000);
say("SWEEP: page loaded, cloak=" + (await evalJs(`!!document.getElementById("blocked-cloak")`)));
const cloak = await evalJs(`(function(){var c=document.getElementById("blocked-cloak");if(c){c.click();return "clicked";}return "absent";})()`);
await sleep(2500);
say("SWEEP: boot done, cloak=" + cloak + ", walking " + VIEWS.length + " views");

const CLICK_VIEW = (v) => `(function(){
  var moreOpen = document.getElementById('nav-more-btn');
  var candidates = Array.prototype.slice.call(document.querySelectorAll('button[data-view="${v}"]'));
  var visible = candidates.filter(function(b){ return b.offsetParent !== null; });
  var target = visible[0] || candidates[0];
  if (!target) return 'no button for ${v}';
  if (!visible.length && target.closest('#nav-more') && moreOpen) moreOpen.click();
  target.click();
  return 'ok';
})()`;

const CHECK_VIEW = (v) => `(function(){
  var bodyOk = document.body.getAttribute('data-view') === '${v}';
  var sec = document.querySelector('section.view[data-view="${v}"]');
  var vis = !!sec && (sec.classList.contains('is-visible') || sec.offsetParent !== null || sec.offsetHeight > 0);
  return { bodyOk: bodyOk, sectionFound: !!sec, visible: vis };
})()`;

let failures = 0;
for (const v of VIEWS) {
  bucket = { errors: [], net: [] };
  const clicked = await evalJs(CLICK_VIEW(v));
  await sleep(1500);
  const state = await evalJs(CHECK_VIEW(v));
  const r = results[v] = {
    clicked: String(clicked),
    bodyOk: !!(state && state.bodyOk),
    visible: !!(state && state.visible),
    errors: bucket.errors,
    net: bucket.net,
  };
  const bad = !r.bodyOk || !r.visible || r.errors.length > 0 || r.net.length > 0;
  if (bad) failures++;
  say(
    (bad ? "FAIL" : "PASS") + "  " + v.padEnd(12) +
    " body=" + (r.bodyOk ? "ok" : "MISMATCH") +
    " visible=" + (r.visible ? "yes" : "NO") +
    " errors=" + r.errors.length + " badNet=" + r.net.length
  );
  for (const e of r.errors) say("        err: " + e);
  for (const n of r.net) say("        net: " + n);
  bucket = null;
}

writeFileSync(new URL("../tmp/sweep-last.json", import.meta.url), JSON.stringify({ when: new Date().toISOString(), cloak: String(cloak), results }, null, 1));

say("");
say(failures === 0 ? "SWEEP: PASS (" + VIEWS.length + " views)" : "SWEEP: " + failures + " of " + VIEWS.length + " views failed");
say("SWEEP: transcript in tmp/sweep-last.log, per view data in tmp/sweep-last.json");
clearTimeout(watchdog);
try { ws.close(); } catch {}
try { chrome.kill(); } catch {}
process.exitCode = failures === 0 ? 0 : 1;
/* The close above is all that should be left holding the loop. If a stalled
   socket refuses to drain, leave with the real verdict instead of hanging. */
setTimeout(() => process.exit(process.exitCode), 2000).unref();
