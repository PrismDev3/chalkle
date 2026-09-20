/* Service worker logic test: runs sw.js against stub caches and a stub
   client, then checks which requests it intercepts and what it serves.
   Run from anywhere: node tools/sw-test.js */

const path = require("node:path");
const { readFileSync } = require("node:fs");
const source = readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");
const ORIGIN = "https://chalkle.test";
const store = new Map();

/* Cache.match hands back a fresh Response each time, so the stub clones. */
const clone = (hit) => (hit ? hit.clone() : undefined);

function cacheHandle(name) {
  if (!store.has(name)) store.set(name, new Map());
  const m = store.get(name);
  const keyOf = (k) => (typeof k === "string" ? k : k.url);
  return {
    put: async (k, res) => { m.set(keyOf(k), res); },
    match: async (k) => clone(m.get(keyOf(k))),
    keys: async () => [...m.keys()].map((u) => new Request(u)),
    delete: async (k) => m.delete(keyOf(k))
  };
}

const caches = {
  open: async (name) => cacheHandle(name),
  match: async (k) => {
    const key = typeof k === "string" ? k : k.url;
    for (const m of store.values()) if (m.has(key)) return clone(m.get(key));
    return undefined;
  },
  keys: async () => [...store.keys()],
  delete: async (name) => store.delete(name)
};

const listeners = {};
let skipped = 0;
let claimed = 0;
const self = {
  location: new URL(ORIGIN + "/sw.js"),
  addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  skipWaiting: async () => { skipped++; },
  clients: { claim: async () => { claimed++; } }
};

/* calls counts served responses, attempts counts every try at the network. */
const network = { calls: 0, attempts: 0, mode: "ok" };
async function fetchStub(request) {
  network.attempts++;
  const url = typeof request === "string" ? request : request.url;
  if (network.mode === "down") throw new Error("network down");
  network.calls++;
  /* A real static server (and the relay) always sends Content-Length, and the
     worker only refreshes cached pages when it can see the size, so model it. */
  const body = "body:" + url;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html", "content-length": String(body.length) }
  });
}

/* Node's Request refuses mode "navigate" and relative URLs; the worker only
   reads url, method, mode and headers, so these stand-ins are enough. */
function req(url, opts) {
  const headers = (opts && opts.headers) || {};
  return {
    url: String(url),
    method: (opts && opts.method) || "GET",
    mode: (opts && opts.mode) || "cors",
    headers: { get: (name) => headers[String(name).toLowerCase()] || null }
  };
}
class FakeRequest {
  constructor(url, opts) {
    this.url = String(url);
    this.method = (opts && opts.method) || "GET";
    this.mode = "no-cors";
    this.headers = { get: () => null };
  }
}

/* The source goes in last: only the final argument is the function body. */
new Function(
  "self", "caches", "fetch", "Response", "Request", "URL", "Promise", "setTimeout", "clearTimeout", source
)(self, caches, fetchStub, Response, FakeRequest, URL, Promise, setTimeout, clearTimeout);

function event(type, request) {
  const record = { intercepted: false, promise: null };
  const evt = {
    request,
    respondWith(p) { record.intercepted = true; record.promise = p; },
    waitUntil() {},
    source: null,
    ports: []
  };
  for (const fn of listeners[type] || []) fn(evt);
  return record;
}
function lifecycle(type) {
  return new Promise((resolve) => {
    const evt = { waitUntil: (p) => Promise.resolve(p).then(resolve, resolve) };
    for (const fn of listeners[type] || []) fn(evt);
    setTimeout(resolve, 800);
  });
}
const bodyOf = async (rec) => (await (await rec.promise).text());

const results = [];
const check = (name, pass, extra) => results.push((pass ? "PASS  " : "FAIL  ") + name + (extra ? "  (" + extra + ")" : ""));
const cacheNames = () => [...store.keys()];
const ask = (payload) => new Promise((resolve) => {
  const evt = { data: payload, ports: [{ postMessage: resolve }], source: null };
  for (const fn of listeners.message || []) fn(evt);
  setTimeout(() => resolve(null), 600);
});

(async () => {
  check("worker registers its four listeners", ["install", "activate", "fetch", "message"].every((k) => (listeners[k] || []).length === 1), Object.keys(listeners).join(","));

  await lifecycle("install");
  check("install precaches the shell", skipped === 1 && cacheNames().some((n) => n.indexOf("chalkle-shell") === 0), cacheNames().join(", "));

  await lifecycle("activate");
  check("activate claims clients", claimed === 1);

  check("cross-origin GET is left alone", !event("fetch", req("https://relay.example.com/x.js")).intercepted);
  check("POST is left alone", !event("fetch", req(ORIGIN + "/src/app.js?v=2", { method: "POST" })).intercepted);
  check("range request is left alone", !event("fetch", req(ORIGIN + "/assets/video.mp4", { headers: { range: "bytes=0-99" } })).intercepted);
  check("relay API is left alone", !event("fetch", req(ORIGIN + "/api/live-tv")).intercepted);
  check("plain page fetch is left alone", !event("fetch", req(ORIGIN + "/movies.html")).intercepted);

  const nav = event("fetch", req(ORIGIN + "/index.html", { mode: "navigate" }));
  check("navigation is intercepted", nav.intercepted);
  const navBody = await bodyOf(nav);
  check("navigation serves the network copy when up", navBody.indexOf("body:" + ORIGIN) !== -1, navBody.slice(0, 30));

  /* A same-origin app page keeps its own cache entry and leaves the shell be. */
  await event("fetch", req(ORIGIN + "/unsent.html", { mode: "navigate" })).promise;
  const shellName = cacheNames().find((n) => n.indexOf("chalkle-shell") === 0);
  const shellStore = await caches.open(shellName);
  const appHit = await shellStore.match(ORIGIN + "/unsent.html");
  const shellHit = await shellStore.match("./index.html");
  const shellBody = shellHit ? await shellHit.text() : "";
  check("a named app page is cached under its own URL", !!appHit, appHit ? "hit" : "missing");
  check("it does not overwrite the cached shell", shellBody.indexOf("index.html") !== -1, shellBody.slice(0, 40));

  network.mode = "down";
  const before = network.attempts;
  const offline = event("fetch", req(ORIGIN + "/some-other-page", { mode: "navigate" }));
  const offlineBody = await bodyOf(offline);
  check("offline navigation falls back to the cached shell", offlineBody.indexOf("index.html") !== -1, offlineBody.slice(0, 30));
  check("offline navigation still tried the network first", network.attempts === before + 1, "attempts: " + (network.attempts - before));

  const offlineApp = await bodyOf(event("fetch", req(ORIGIN + "/unsent.html", { mode: "navigate" })));
  check("the cached app page reopens offline", offlineApp.indexOf("/unsent.html") !== -1, offlineApp.slice(0, 40));

  network.calls = 0;
  network.mode = "ok";
  await event("fetch", req(ORIGIN + "/src/app.js?v=2")).promise;
  const afterFirst = network.calls;
  const second = await bodyOf(event("fetch", req(ORIGIN + "/src/app.js?v=2")));
  check("a versioned file is fetched once and never revalidated", afterFirst === 1 && network.calls === 1 && second.indexOf("body:") === 0, "network calls: " + network.calls);

  await event("fetch", req(ORIGIN + "/assets/art/one.png")).promise;
  const swrCalls = network.calls;
  await event("fetch", req(ORIGIN + "/assets/art/one.png")).promise;
  check("an unversioned asset refreshes in the background", network.calls === swrCalls + 1, "network calls: " + network.calls);

  /* A new build publishes new version URLs; the old copies must not pile up. */
  await event("fetch", req(ORIGIN + "/src/theme.js?v=1")).promise;
  await event("fetch", req(ORIGIN + "/src/theme.js?v=2")).promise;
  await lifecycle("activate");
  const assetName = cacheNames().find((n) => n.indexOf("chalkle-assets") === 0);
  const themeKeys = assetName
    ? (await (await caches.open(assetName)).keys()).map((k) => k.url).filter((u) => u.indexOf("/src/theme.js") !== -1)
    : [];
  check("superseded asset versions are pruned on activate", themeKeys.length === 1 && themeKeys[0].indexOf("v=2") !== -1, themeKeys.join(" | "));
  const survivor = await bodyOf(event("fetch", req(ORIGIN + "/src/theme.js?v=2")));
  check("the newest version still serves from cache", survivor.indexOf("v=2") !== -1, survivor.slice(0, 40));

  for (let i = 0; i < 12; i++) {
    await event("fetch", req(ORIGIN + "/ugs/nzp/part-" + String(i).padStart(2, "0"))).promise;
  }
  const partName = cacheNames().find((n) => n.indexOf("chalkle-parts") === 0);
  const kept = partName ? (await (await caches.open(partName)).keys()).length : 0;
  check("game parts are cached and trimmed to the limit", kept === 10, "kept " + kept + " of 12");

  const stats = await ask({ type: "stats" });
  check("stats message reports entries", !!stats && stats.type === "stats" && stats.entries > 0, stats && String(stats.entries));

  network.mode = "down";
  await ask({ type: "clear" });
  const left = cacheNames().filter((n) => n.indexOf("chalkle-") === 0).length;
  check("clear message drops every chalkle cache", left === 0, "left: " + left);
  const coldBody = await bodyOf(event("fetch", req(ORIGIN + "/index.html", { mode: "navigate" })));
  check("offline with nothing cached explains itself", coldBody.indexOf("Offline") !== -1, coldBody.slice(0, 46));
  network.mode = "ok";

  console.log(results.join("\n"));
  const failed = results.filter((r) => r.indexOf("FAIL") === 0).length;
  console.log(failed ? failed + " check(s) FAILED" : "all service worker checks pass");
  process.exitCode = failed ? 1 : 0;
})();
