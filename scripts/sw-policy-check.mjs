/**
 * Policy test for chalkle's service worker, run in Node against the real
 * sw.js (no browser needed).
 *
 *   node work/verify/sw_unit.mjs [path to sw.js]
 *
 * What it pins down:
 *   1. A navigation to a local game build (/game-builds/, /mc/) is NOT
 *      intercepted - the worker stays out of a 100+ MB page it could never
 *      cache anyway.
 *   2. The app shell still is.
 *   3. When a handled navigation fails offline, the shell is only served for
 *      the shell itself; any other page gets the "could not load" page naming
 *      the URL, instead of being silently swapped for the home screen.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'sw.js';
const code = readFileSync(file, 'utf8');

const ORIGIN = 'https://chalkle.example';

const norm = (u) => String(u).replace(ORIGIN + '/', '').replace(/^\.\//, '');

const makeCache = (entries = {}) => ({
  put: async () => {},
  delete: async () => true,
  keys: async () => [],
  match: async (req) => {
    const key = norm(typeof req === 'string' ? req : req.url);
    return entries[key] ? new Response(entries[key], { status: 200 }) : undefined;
  },
});

let fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
let respondWithCalls = 0;
let lastRespondedPromise = null;

const listeners = {};
const self = {
  location: { origin: ORIGIN, href: ORIGIN + '/sw.js' },
  addEventListener: (type, fn) => { listeners[type] = fn; },
  skipWaiting: () => {},
  clients: { claim: () => {} },
  registration: { scope: ORIGIN + '/' },
};

/* The install step precaches the shell: one entry, reachable as both
   "./index.html" and the absolute URL that resolves to. */
const shellEntry = { key: 'index.html', body: '<!doctype html><title>Chalkle shell</title>' };
const store = {};

const cachesApi = {
  open: async (name) => {
    if (!store[name]) {
      store[name] = /^chalkle-shell-/.test(name) ? makeCache({ [shellEntry.key]: shellEntry.body }) : makeCache({});
    }
    return store[name];
  },
  match: async (req) => {
    for (const cache of Object.values(store)) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    /* caches.match() also searches caches the worker has not opened yet. */
    return norm(typeof req === 'string' ? req : req.url) === shellEntry.key
      ? new Response(shellEntry.body, { status: 200 }) : undefined;
  },
  keys: async () => Object.keys(store),
  delete: async () => true,
};

const fn = new Function('self', 'caches', 'fetch', 'Request', 'Response', 'URL', 'console', code);
fn(self, cachesApi, (...a) => fetchImpl(...a), Request, Response, URL, console);

/* Node's Request refuses mode "navigate", so the events carry a plain stand-in
   with the fields the worker actually reads. */
const makeRequest = (url, mode = 'navigate') => ({
  url,
  method: 'GET',
  mode,
  headers: new Headers(),
  clone() { return this; },
});

const dispatchFetch = async (url, mode = 'navigate') => {
  respondWithCalls = 0;
  lastRespondedPromise = null;
  const event = {
    request: makeRequest(url, mode),
    respondWith: (p) => { respondWithCalls++; lastRespondedPromise = p; },
  };
  listeners.fetch(event);
  return { intercepted: respondWithCalls > 0, response: lastRespondedPromise ? await lastRespondedPromise : null };
};

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); };

/* 1. Big local game builds are left alone. */
for (const path of ['/game-builds/poke-clicker/index.html', '/mc/somepage.html', '/mirror/sub/game-builds/granny/index.html']) {
  const r = await dispatchFetch(ORIGIN + path);
  check('passes through ' + path, r.intercepted === false, 'intercepted=' + r.intercepted);
}

/* 2. The shell is still handled (and still served from cache when offline). */
{
  const r = await dispatchFetch(ORIGIN + '/index.html');
  check('handles the shell', r.intercepted === true, 'intercepted=' + r.intercepted);
  const body = r.response ? await r.response.text() : '';
  check('offline shell falls back to the cached shell', body.indexOf('Chalkle shell') > -1, 'body=' + body.slice(0, 60));
}

/* 3. A handled page that fails offline must NOT be handed the app shell. */
{
  const r = await dispatchFetch(ORIGIN + '/ugs/somegame.html');
  const body = r.response ? await r.response.text() : '';
  const status = r.response ? r.response.status : 0;
  check('failed /ugs/ page is not the app shell', body.indexOf('Chalkle shell') === -1, 'body=' + body.slice(0, 80));
  check('failed /ugs/ page reports the URL', status === 503 && body.indexOf('/ugs/somegame.html') > -1, 'status=' + status);
}

/* 4. A rejecting responder never surfaces as a rejected respondWith. */
{
  const savedFetch = fetchImpl;
  fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
  respondWithCalls = 0;
  lastRespondedPromise = null;
  const event = {
    request: makeRequest(ORIGIN + '/ugs/boom.html'),
    respondWith: (p) => { respondWithCalls++; lastRespondedPromise = p; },
  };
  listeners.fetch(event);
  let rejected = null;
  const settled = await lastRespondedPromise.then((r) => r, (e) => { rejected = e; return null; });
  check('respondWith promise never rejects', rejected === null, rejected ? String(rejected) : 'resolved');
  check('the fallback is a real Response', !!(settled && typeof settled.status === 'number'), 'status=' + (settled && settled.status));
  fetchImpl = savedFetch;
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + '  (' + r.detail + ')');
}
console.log(failed === 0 ? '\nall ' + results.length + ' checks passed' : '\n' + failed + ' of ' + results.length + ' checks FAILED');
process.exit(failed === 0 ? 0 : 1);
