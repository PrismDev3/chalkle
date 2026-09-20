/* Chalkle service worker: the offline shell plus a versioned asset cache.
   Borrowed in spirit from the reference sites this branch studies:

   - cherrion.top runs a service worker that proxies every fetch through a
     whitelist, and keeps its big assets in browser storage so repeat visits
     never touch the network.
   - kiwi.college mounts its app into a full-viewport frame and keeps all of
     its lesson state on the device.

   Chalkle is one big HTML shell plus a pile of versioned scripts, so the win
   here is simple: serve the shell and the versioned files from disk on every
   visit after the first, and keep the chunked game parts so a 134 MB game
   only downloads once.

   Rules kept deliberately narrow, because a service worker that guesses is
   worse than none:

   1. Same-origin GET requests only. Cross-origin (the relay, YouTube,
      jsDelivr) is never intercepted or cached.
   2. Range requests pass through untouched. Caching partial video responses
      breaks seeking.
   3. The relay API routes (/api/, /yut/) always pass through. Those are live
      data, not assets.
   4. HTML navigations are network-first. You get a fresh page whenever the
      network works, and the cached shell only when it does not.
   5. Cache-first is reserved for files that already carry a version query
      (src/app.js?v=...) or live in an art/font directory, so a stale copy
      cannot shadow a new build.

   Bumping SERVICE_WORKER_VERSION below is what retires an old cache: the
   activate step deletes every cache that is not part of the current set. */

var SERVICE_WORKER_VERSION = "2026-09-16a";

var SHELL_CACHE = "chalkle-shell-" + SERVICE_WORKER_VERSION;
var ASSET_CACHE = "chalkle-assets-" + SERVICE_WORKER_VERSION;
var PART_CACHE = "chalkle-parts-" + SERVICE_WORKER_VERSION;
var KEEP_PREFIX = "chalkle-";

/* One game's worth of 16 MB parts. Older parts are trimmed on insert, so a
   second game cannot silently fill the disk. */
var PART_LIMIT = 10;

/* Nothing bigger than this lands in the general asset cache. */
var MAX_ASSET_BYTES = 26 * 1024 * 1024;

/* A page bigger than this is not an app shell worth keeping (the single-file
   build is one 150 MB HTML document). Refresh the shell cache only for pages
   that look like the real shell. */
var MAX_SHELL_BYTES = 3 * 1024 * 1024;

/* The offline fallback. Each entry is cached independently so one 404 (a
   mirror without apple-touch-icon.png, say) cannot fail the whole install. */
var SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./favicon.svg",
  "./favicon.ico",
  "./favicon-32x32.png",
  "./apple-touch-icon.png"
];

/* Path prefixes whose files are safe to serve cache-first without a version
   query. These directories are content-addressed by path or only change with
   a new deploy. */
var STATIC_PREFIXES = ["/assets/", "/tabs/", "/fonts/", "/shorts/", "/ugs/"];

/* The relay and the upload API. Live data, never cached. */
var PASS_PREFIXES = ["/api/", "/yut/", "/cdn-cgi/"];

function isStaticPath(pathname) {
  for (var i = 0; i < STATIC_PREFIXES.length; i++) {
    if (pathname.indexOf(STATIC_PREFIXES[i]) === 0) return true;
  }
  return false;
}

function isPassThrough(pathname) {
  for (var i = 0; i < PASS_PREFIXES.length; i++) {
    if (pathname.indexOf(PASS_PREFIXES[i]) === 0) return true;
  }
  return false;
}

/* A versioned file: /src/app.js?v=20260921a. The query is the version, so a
   cached copy can only ever be the one that was asked for, and a new build
   always arrives under a new URL. Immutable: no background refetch. */
function isImmutable(url) {
  return url.searchParams.has("v");
}

/* Hand-written script and style paths without a version query. These get a
   background refresh on every hit, because the same URL can be republished. */
function isVersioned(url) {
  var path = url.pathname;
  return path.indexOf("/src/") === 0 && /\.(js|css)$/.test(path);
}

/* Standalone pages worth caching whole: small, ours, and meant to be opened
   again offline (the archive app especially). Everything else same-origin is
   either the shell or a local game build that can run to 100 MB. */
var PAGE_CACHE = ["/unsent.html", "/browser.html", "/chat.html", "/movies.html",
                  "/play.html", "/go.html", "/cloud-play.html"];

function isCacheablePage(path) {
  for (var i = 0; i < PAGE_CACHE.length; i++) {
    if (path === PAGE_CACHE[i]) return true;
  }
  return false;
}

/* A chunked single-file game part: /ugs/nzp/part-03. Big, immutable, and the
   whole point of the parts cache. */
function isGamePart(pathname) {
  return /\/part-\d+$/.test(pathname);
}

function cachePut(cacheName, request, response) {
  if (!response || !response.ok || response.status !== 200) return;
  var len = Number(response.headers.get("content-length") || 0);
  if (len > MAX_ASSET_BYTES) return;
  var copy = response.clone();
  caches.open(cacheName).then(function (cache) {
    return cache.put(request, copy);
  }).then(function () {
    if (cacheName === ASSET_CACHE) maybePruneAssets();
  }).catch(function () { /* quota or opaque response: skip quietly */ });
}

/* Keep only the newest PART_LIMIT entries so repeated plays of several games
   stay bounded instead of growing forever. */
function trimParts(cache) {
  return cache.keys().then(function (keys) {
    if (keys.length <= PART_LIMIT) return;
    var drop = keys.slice(0, keys.length - PART_LIMIT);
    return Promise.all(drop.map(function (key) { return cache.delete(key); }));
  });
}

/* Every release publishes new ?v= URLs without overwriting the old ones, so
   the asset cache would otherwise grow by a full copy of the app per build.
   For each path, keep the highest version token and drop its predecessors.
   Runs on activate and then at most once per PRUNE_EVERY_PUTS inserts. */
var PRUNE_EVERY_PUTS = 25;
var putsSincePrune = 0;

function pruneSuperseded(cache) {
  return cache.keys().then(function (keys) {
    var newest = {};
    keys.forEach(function (key) {
      var url = new URL(key.url);
      var token = url.searchParams.get("v") || "";
      var slot = newest[url.pathname];
      if (!slot || token > slot.token) newest[url.pathname] = { token: token, url: key.url };
    });
    var drop = keys.filter(function (key) {
      var slot = newest[new URL(key.url).pathname];
      return slot && slot.url !== key.url;
    });
    return Promise.all(drop.map(function (key) { return cache.delete(key); }));
  });
}

function maybePruneAssets() {
  putsSincePrune++;
  if (putsSincePrune < PRUNE_EVERY_PUTS) return;
  putsSincePrune = 0;
  caches.open(ASSET_CACHE).then(pruneSuperseded).catch(function () {});
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return Promise.all(SHELL_FILES.map(function (file) {
        return fetch(new Request(file, { cache: "reload", credentials: "same-origin" }))
          .then(function (response) {
            if (response && response.ok) return cache.put(file, response);
          })
          .catch(function () { /* offline install: the shell fills in later */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  var keep = [SHELL_CACHE, ASSET_CACHE, PART_CACHE];
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name.indexOf(KEEP_PREFIX) !== 0) return null;
        if (keep.indexOf(name) !== -1) return null;
        return caches.delete(name);
      }));
    }).then(function () {
      /* Drop asset copies that a newer build has replaced. */
      return caches.open(ASSET_CACHE).then(pruneSuperseded).catch(function () {});
    }).then(function () { return self.clients.claim(); })
  );
});

/* Navigation: network first, the cached copy as the offline fallback. */
function handleNavigate(request) {
  /* The app shell lives at ./index.html, whatever path it was reached by. A
     different same-origin page (the offline archive app at /unsent.html, the
     standalone pages) is cached under its own URL instead, so it reopens
     offline and never overwrites the shell. Game pages under /ugs/ are kept
     too: their cores, ROMs and chunked parts already cache, so a played game
     reopens with no network at all. */
  var isShell = true, keep = true;
  try {
    var path = new URL(request.url).pathname;
    isShell = path === "/" || /\/index\.html$/.test(path);
    keep = isShell || isCacheablePage(path) || /^\/ugs\/[^/]+\.html$/.test(path);
  } catch (e) { /* unparsable URL: treat it as the shell */ }
  return fetch(request).then(function (response) {
    /* Refresh a cached page only from a clean, real response of a sane size. */
    var len = Number((response && response.headers.get("content-length")) || 0);
    if (response && response.ok && keep && len && len < MAX_SHELL_BYTES) {
      var copy = response.clone();
      caches.open(SHELL_CACHE).then(function (cache) {
        cache.put(isShell ? "./index.html" : request, copy);
      }).catch(function () {});
    }
    return response;
  }).catch(function () {
    return caches.match(request).then(function (hit) {
      if (hit) return hit;
      return caches.match("./index.html").then(function (shell) {
        return shell || caches.match("./");
      });
    }).then(function (fallback) {
      if (fallback) return fallback;
      return new Response("<h1>Offline</h1><p>Chalkle could not reach the network and has no cached copy yet.</p>", {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    });
  });
}

/* A file whose URL carries its version: serve the cache, fetch on a miss. */
function handleImmutable(request) {
  return caches.match(request).then(function (hit) {
    if (hit) return hit;
    return fetch(request).then(function (response) {
      cachePut(ASSET_CACHE, request, response);
      return response;
    });
  });
}

/* Unversioned art/script/style: cache first, refreshed in the background so
   the next visit already has the new copy. */
function handleAsset(request) {
  return caches.match(request).then(function (hit) {
    if (hit) {
      fetch(request).then(function (response) {
        cachePut(ASSET_CACHE, request, response);
      }).catch(function () {});
      return hit;
    }
    return fetch(request).then(function (response) {
      cachePut(ASSET_CACHE, request, response);
      return response;
    });
  });
}

/* Chunked game parts: cache first, then network with a trim after insert. */
function handlePart(request) {
  return caches.open(PART_CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (response) {
        if (response && response.ok) {
          cache.put(request, response.clone()).then(function () {
            return trimParts(cache);
          }).catch(function () {});
        }
        return response;
      });
    });
  });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (request.headers.get("range")) return;
  if (isPassThrough(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigate(request));
    return;
  }
  if (isGamePart(url.pathname)) {
    event.respondWith(handlePart(request));
    return;
  }
  if (isImmutable(url)) {
    event.respondWith(handleImmutable(request));
    return;
  }
  if (isVersioned(url) || isStaticPath(url.pathname)) {
    event.respondWith(handleAsset(request));
  }
});

/* Small control surface for the app: report the version and the cache
   footprint, or drop everything. Called from Settings diagnostics. */
self.addEventListener("message", function (event) {
  var data = event.data || {};
  var port = event.ports && event.ports[0];

  function reply(payload) {
    if (port) { try { port.postMessage(payload); } catch (e) {} return; }
    if (event.source && event.source.postMessage) {
      try { event.source.postMessage(payload); } catch (e) {}
    }
  }

  if (data.type === "version") {
    reply({ type: "version", version: SERVICE_WORKER_VERSION });
    return;
  }

  /* The page found a newer build and the user asked for it: activate now
     instead of waiting for every tab to close. */
  if (data.type === "skipWaiting") {
    try { self.skipWaiting(); } catch (e) { /* older worker */ }
    return;
  }

  if (data.type === "stats") {
    Promise.all([SHELL_CACHE, ASSET_CACHE, PART_CACHE].map(function (name) {
      return caches.open(name).then(function (cache) { return cache.keys(); })
        .then(function (keys) { return { name: name, entries: keys.length }; })
        .catch(function () { return { name: name, entries: 0 }; });
    })).then(function (rows) {
      var total = 0;
      rows.forEach(function (row) { total += row.entries; });
      reply({ type: "stats", version: SERVICE_WORKER_VERSION, entries: total, caches: rows });
    });
    return;
  }

  if (data.type === "clear") {
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name.indexOf(KEEP_PREFIX) !== 0) return null;
        return caches.delete(name);
      }));
    }).then(function () {
      reply({ type: "cleared" });
    });
  }
});
