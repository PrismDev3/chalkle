/* Chalkle proxy backends.

   window.ChalkProxyBackends is the routing registry behind the Proxies tab's
   backend selector. Every entry is keyless by design - nothing here asks the
   user for a token, a subscription URL, or an account:

     kind: "relay"   the same-origin rewriting relay served by this site's own
                     server (serve-chalk.py /res/). Always available.
     kind: "direct"  no proxy at all - load the real URL.
     kind: "frame"   a hosted web proxy (Scramjet / Nebula class). Routed with
                     the hash form: <host>#<base64url(target)>.
     kind: "panel"   an admin panel UI (3X-UI, Hiddify, Nginx Proxy Manager).
                     Nothing to route through; the selector opens its local UI.

   The relay reports which panel backends it actually found at
   GET /api/proxy/backends. */
window.ChalkProxyBackends = [
  /* ---------------------------------------------------------- built-in --- */
  {
    id: "relay",
    name: "Chalkle Relay",
    group: "built-in",
    kind: "relay",
    icon: "/favicon.svg",
    note: "Chalkle's own rewriting relay. Same origin, nothing separate to block, never goes stale.",
    ready: true
  },
  {
    id: "auto",
    name: "Auto (fastest live node)",
    group: "built-in",
    kind: "auto",
    note: "Checks every node on this list and opens the one that answers fastest. Dead nodes are skipped, and the relay takes over when nothing else answers."
  },
  {
    id: "direct",
    name: "Direct (no proxy)",
    group: "built-in",
    kind: "direct",
    note: "Loads the real URL as-is. Fastest, but nothing is hidden and school filters see everything.",
    ready: true
  },

  /* ------------------------------------------------------- web proxies --- */
  {
    id: "scramjet",
    name: "Scramjet",
    group: "web",
    kind: "frame",
    url: "https://scramjet.mercurywork.shop/",
    hashRoute: true,
    note: "Hosted Scramjet node (Mercury Workshop). Service-worker web proxy, no key."
  },
  {
    id: "nebula",
    name: "Nebula",
    group: "web",
    kind: "frame",
    url: "https://scramjet.mercurywork.shop/",
    hashRoute: true,
    note: "Nebula runs on the same Wisp transport as Scramjet, so it shares the node until you set your own instance URL."
  },
  {
    id: "hydrovolter",
    name: "Scramjet (Hydrovolter)",
    group: "web",
    kind: "frame",
    url: "https://admin.proxy.hydrovolter.com/scramjet/",
    hashRoute: true,
    note: "Second Scramjet node. Handy when the first one gets filtered."
  },
  {
    id: "gjsd",
    name: "GJSD",
    group: "web",
    kind: "frame",
    url: "https://gjsd.yan.ch/",
    hashRoute: true,
    icon: "/assets/proxies/gjsd.png",
    note: "Hosted Scramjet-style instance already listed in this tab."
  },
  {
    id: "ovokee",
    name: "Ovokee",
    group: "web",
    kind: "frame",
    url: "https://ovokee.sbs/",
    hashRoute: true,
    icon: "/assets/proxies/ovokee.png",
    credit: "kelvin9rant",
    note: "Hosted Scramjet-style instance, credit kelvin9rant."
  },

  /* Hosted dashboards are useful to open directly, but their landing pages do
     not accept a target URL in the hash. The launcher therefore falls back to
     the built-in relay when one of these is selected for navigation. */
  /* ------------------------------------------------------- admin panels --- */
  {
    id: "3xui",
    name: "3X-UI",
    group: "panel",
    kind: "panel",
    ports: [[2053, "http"], [54321, "http"], [2096, "http"]],
    note: "Proxy panel UI. Selector opens its local web panel (default :2053 / :54321)."
  },
  {
    id: "hiddify",
    name: "Hiddify Manager",
    group: "panel",
    kind: "panel",
    ports: [[2333, "http"], [80, "http"]],
    note: "Hiddify Manager panel UI on the local machine (default :2333)."
  },
  {
    id: "npm",
    name: "Nginx Proxy Manager",
    group: "panel",
    kind: "panel",
    ports: [[81, "http"], [8181, "http"]],
    note: "Nginx Proxy Manager admin UI (default :81)."
  }
];

/* Group labels for the selector / cards. */
window.ChalkProxyBackendGroups = [
  { id: "built-in", label: "Built-in", hint: "Always available - no key, no third party." },
  { id: "web", label: "Web proxies", hint: "Hosted rewrite proxies. Pick one per network." },
  { id: "panel", label: "Panels", hint: "Admin UIs. Selecting one opens its local panel." }
];

/* Cards for the visible proxy list (unchanged shape - the tab's migration
   code, admin sheet, and server-side relay entry all still read this). */
window.ChalkProxies = [
  /* Hosted Scramjet-style instance (hash route + service worker). */
  { name: "GJSD", url: "https://gjsd.yan.ch/", mode: "frame", icon: "/assets/proxies/gjsd.png" },
  /* Hosted Scramjet-style instance, credit kelvin9rant. */
  { name: "Ovokee", url: "https://ovokee.sbs/", mode: "frame", credit: "kelvin9rant", icon: "/assets/proxies/ovokee.png" },
  /* SerumOS on Bunny CDN (hash route + service worker), credit c0mrade.
     Older builds listed 20 numbered mirrors of the same proxy; keep one. */
  { name: "Serium", url: "https://swiftnet8420.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium-01.svg" }
];

/* ------------------------------------------------------------------ API ---
   Small keyless helpers the launcher and the Proxies tab share.   The chosen backend id lives in localStorage and is pushed to the relay for
   the built-in relay/direct selection. Local proxy-client chaining is disabled. */

(function () {
  var KEY = "chalkle-proxy-backend";
  var DEFAULT_ID = "relay";

  function list() {
    return (window.ChalkProxyBackends || []).slice();
  }

  function find(id) {
    var all = list();
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].id === id) return all[i];
    }
    return null;
  }

  function get() {
    var id = "";
    try { id = localStorage.getItem(KEY) || ""; } catch (e) { id = ""; }
    var b = find(id);
    if (b) return b.id;
    /* A saved id from an older build (or a hand-edited value) must never
       leave the user with no backend at all - fall back to the relay. */
    return find(DEFAULT_ID) ? DEFAULT_ID : (list()[0] ? list()[0].id : DEFAULT_ID);
  }

  function relayRoot() {
    try {
      if (window.ChalkleApi && window.ChalkleApi.root) {
        var r = String(window.ChalkleApi.root() || "").replace(/\/+$/, "");
        if (/^https?:/i.test(r)) return r;
      }
    } catch (e) { /* fall through */ }
    try {
      var o = String(location.origin || "");
      if (/^https?:/i.test(o)) return o.replace(/\/+$/, "");
    } catch (e) { /* opaque origin */ }
    return "";
  }

  /* Tell the relay which upstream to chain through. Fire-and-forget: the
     relay answers with the live backend table, which the tab renders. */
  function push(id, done) {
    var root = relayRoot();
    if (!root) { if (done) done(null); return; }
    try {
      fetch(root + "/api/proxy/backend", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "chalkle" },
        body: JSON.stringify({ id: id })
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (done) done(j); })
        .catch(function () { if (done) done(null); });
    } catch (e) {
      if (done) done(null);
    }
  }

  function set(id) {
    var b = find(id);
    var use = b ? b.id : DEFAULT_ID;
    try { localStorage.setItem(KEY, use); } catch (e) { /* no storage */ }
    push(use, null);
    return use;
  }

  /* Live status from the relay:
       {ok, active, chained, via, panels:{3xui:{live:true,url:"http://127.0.0.1:2053/"}, ...}}
     Falls back to an empty shape when the relay (or the endpoint) is not
     reachable - static mirrors do not run it. */
  function probe(done) {
    var empty = { ok: false, active: get(), chained: false, via: "", backends: {}, panels: {} };
    var root = relayRoot();
    if (!root) { if (done) done(empty); return; }
    try {
      fetch(root + "/api/proxy/backends", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) { if (done) done(empty); return; }
          if (!j.backends) j.backends = {};
          if (!j.panels) j.panels = {};
          if (done) done(j);
        })
        .catch(function () { if (done) done(empty); });
    } catch (e) {
      if (done) done(empty);
    }
  }

  window.ChalkProxyBackendList = list;
  window.ChalkProxyBackendFind = find;
  window.ChalkProxyBackendGet = get;
  window.ChalkProxyBackendSet = set;
  window.ChalkProxyBackendProbe = probe;
  window.ChalkProxyBackendRelayRoot = relayRoot;
  window.ChalkProxyResolve = resolveBackend;
  window.ChalkProxyHealthOf = healthOf;
  window.ChalkProxyCheckAll = checkAll;
  window.ChalkProxyCheckRelay = checkRelay;
  window.ChalkProxyPingNode = pingNodeById;
  window.ChalkProxyBestNode = bestNode;
  window.ChalkProxyCandidates = candidates;
  window.ChalkProxyReport = report;
  window.ChalkProxyRelayHealth = relayHealth;

  /* -------------------------------------------------------- node health ---
     A proxy list that never says what is actually up is a list of guesses.
     Hosted nodes go stale, work on one network and not the next, and a school
     filter answers a dead tunnel with its own block page while the card still
     claims the node is fine. Every entry therefore carries a health record:
     the Proxies tab renders it, and the launcher reads it before routing.

     The check is one timed opaque request. `mode: "no-cors"` cannot read the
     answer, but it does settle when the origin answers and rejects when the
     host is gone, the TLS handshake fails, or a filter blocks the request -
     the three ways these nodes actually die here. The time it took is the
     latency the card shows, which is the number that matters when picking
     between them. */

  var HEALTH_KEY = "chalkle-proxy-health";
  var HEALTH_STALE_MS = 300000;  /* a five-minute-old reading is not "now" */
  var PING_TIMEOUT_MS = 4500;
  var SLOW_MS = 1500;
  var PING_TRIES = 2;
  var RELAY_WATCH_MS = 60000;

  var health = {};
  var healthReady = false;
  var pinging = {};
  var relayWatch = null;

  function loadHealth() {
    if (healthReady) return health;
    healthReady = true;
    try {
      var raw = localStorage.getItem(HEALTH_KEY);
      var saved = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === "object") health = saved;
    } catch (e) { health = {}; }
    return health;
  }

  function saveHealth() {
    /* Only the newest reading per node is kept, so the record stays a few
       hundred bytes and can be written on every probe. */
    try {
      var out = {};
      var ids = Object.keys(health);
      for (var i = 0; i < ids.length; i++) {
        var h = health[ids[i]];
        if (h) out[ids[i]] = { state: h.state, ms: h.ms, fails: h.fails, at: h.at };
      }
      localStorage.setItem(HEALTH_KEY, JSON.stringify(out));
    } catch (e) { /* no storage: health still lives for this session */ }
  }

  function healthOf(id) {
    loadHealth();
    var h = health[id];
    if (!h) return { state: "unknown", ms: null, fails: 0, at: 0 };
    if (h.state === "live" && h.at && Date.now() - h.at > HEALTH_STALE_MS) {
      return { state: "unknown", ms: h.ms, fails: h.fails, at: h.at };
    }
    return h;
  }

  function recordState(id, state, ms) {
    loadHealth();
    var prev = health[id] || { fails: 0 };
    var changed = (prev.state || "unknown") !== state;
    var fails = state === "live" || state === "slow" ? 0 : (prev.fails || 0) + 1;
    health[id] = { state: state, ms: ms, fails: fails, at: Date.now() };
    saveHealth();
    tell({ id: id, state: state, ms: ms, fails: fails, changed: changed });
    return health[id];
  }

  function tell(detail) {
    try {
      document.dispatchEvent(new CustomEvent("chalkle:proxy-health", { detail: detail }));
    } catch (e) { /* older browser: the tab simply re-renders on its next open */ }
  }

  /* A node is pingable when it is something the browser can reach by URL:
     hosted nodes only. The relay has its own check because it is same-origin
     and answers with a real status. */
  function pingable(b) {
    return !!(b && b.url && (b.kind === "frame" || b.kind === "chain"));
  }

  function pingNode(b, done) {
    var id = b && b.id;
    if (!id || !pingable(b)) { if (done) done(healthOf(id)); return; }
    if (pinging[id]) return;  /* one probe per node at a time */
    pinging[id] = true;
    var tries = 0;

    function finish(state, ms) {
      pinging[id] = false;
      var rec = recordState(id, state, ms);
      if (done) done(rec);
    }

    function once() {
      tries++;
      var started = Date.now();
      var settled = false;
      var timer = setTimeout(function () { settle(false); }, PING_TIMEOUT_MS);

      function settle(answered) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (answered) {
          var ms = Date.now() - started;
          finish(ms > SLOW_MS ? "slow" : "live", ms);
          return;
        }
        /* One retry with a short backoff, like any client that expects a
           cold tunnel or a filtering middlebox to be intermittent. */
        if (tries < PING_TRIES) { setTimeout(once, 400 * tries); return; }
        finish("dead", null);
      }

      try {
        fetch(b.url, { mode: "no-cors", cache: "no-store", credentials: "omit", redirect: "follow" })
          .then(function () { settle(true); })
          .catch(function () { settle(false); });
      } catch (e) { settle(false); }
    }

    once();
  }

  function pingNodeById(id, done) {
    return pingNode(find(id), done);
  }

  /* The built-in relay lives on this origin, so its check can read the real
     status code. Same origin means no opaque response and no CORS surprise. */
  function checkRelay(done) {
    var root = relayRoot();
    if (!root) {
      var none = { ok: false, ms: null, state: "unknown" };
      if (done) done(none);
      return;
    }
    var started = Date.now();
    var settled = false;
    var timer = setTimeout(function () { settle(false); }, PING_TIMEOUT_MS);
    /* Read the previous reading BEFORE overwriting it: the flip is what the
       toast fires on, and a first-ever reading (unknown) is not a flip. */
    var before = healthOf("relay").state;

    function settle(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      var ms = ok ? Date.now() - started : null;
      var rec = recordState("relay", ok ? (ms > SLOW_MS ? "slow" : "live") : "dead", ms);
      try {
        document.dispatchEvent(new CustomEvent("chalkle:proxy-relay", {
          detail: { ok: ok, ms: ms, state: rec.state, changed: before !== "unknown" && (before === "dead") !== !ok }
        }));
      } catch (e) { /* ignore */ }
      if (done) done({ ok: ok, ms: ms, state: rec.state });
    }

    try {
      fetch(root + "/res/", { cache: "no-store", credentials: "omit" })
        .then(function (r) { settle(!!r && r.ok); })
        .catch(function () { settle(false); });
    } catch (e) { settle(false); }
  }

  function relayHealth() {
    var h = healthOf("relay");
    return { state: h.state, ms: h.ms, at: h.at };
  }

  /* Every hosted node at once. The tab calls this when it opens and when the
     user asks for a re-check; the answers land in the health store either
     way, so the cards are correct even if the user never watches them. */
  function checkAll(done) {
    var nodes = list().filter(pingable);
    var pending = nodes.length;
    if (!pending) { if (done) done([]); return; }
    var out = [];
    nodes.forEach(function (b) {
      pingNode(b, function (rec) {
        out.push({ id: b.id, name: b.name, state: rec.state, ms: rec.ms });
        pending--;
        if (!pending && done) done(out);
      });
    });
  }

  /* Every hosted node in the order a router should try them: something that
     answered first, then the untested, and never the ones known dead. `skip`
     is the list of node ids already tried for the navigation being routed -
     a retry walks this list so it can never land on the node that just
     failed. "slow" still beats nothing, and an unchecked node is a guess
     rather than a failure, so it comes last instead of being written off. */
  function orderedNodes(skip) {
    var skipIds = skip || [];
    var rank = { live: 0, slow: 1, unknown: 2 };
    var pool = list().filter(function (b) {
      if (!pingable(b)) return false;
      for (var i = 0; i < skipIds.length; i++) {
        if (skipIds[i] && skipIds[i] === b.id) return false;
      }
      return healthOf(b.id).state !== "dead";
    });
    var rows = pool.map(function (b) { return { b: b, h: healthOf(b.id) }; });
    rows.sort(function (x, y) {
      var rx = rank[x.h.state];
      var ry = rank[y.h.state];
      if (rx === undefined) rx = 3;
      if (ry === undefined) ry = 3;
      if (rx !== ry) return rx - ry;
      var mx = (x.h.ms === null || x.h.ms === undefined) ? 999999 : x.h.ms;
      var my = (y.h.ms === null || y.h.ms === undefined) ? 999999 : y.h.ms;
      return mx - my;
    });
    return rows.map(function (r) { return r.b; });
  }

  function bestNode() {
    return orderedNodes()[0] || null;
  }

  /* The retry list for one navigation: every node that has not been tried and
     is not known dead, best first. The launcher reads this when a route
     failed and it has to walk somewhere else. */
  function candidates(skip) {
    return orderedNodes(skip);
  }

  /* A verdict from the launcher or the in-app browser: a routed page either
     answered or it did not. That is stronger evidence than an opaque ping, so
     it is recorded in the same store - the Proxies tab pill, the auto picker
     and the next route all read the one reading instead of disagreeing. */
  function report(id, ok) {
    if (!id) return null;
    var b = find(id);
    if (!b) return null;
    if (b.kind === "relay") {
      /* The relay is this origin, so its verdict travels as the relay-check
         shape: the launcher already follows that event and demotes or
         restores the built-in route from it. */
      /* Keep the last measured latency: a page load proves the relay answered,
         it does not time it, and "Answered in " with no number reads broken. */
      var lastMs = healthOf("relay").ms;
      var rec = recordState("relay", ok ? "live" : "dead", ok ? lastMs : null);
      try {
        document.dispatchEvent(new CustomEvent("chalkle:proxy-relay", {
          detail: { ok: !!ok, ms: null, state: rec.state, changed: false }
        }));
      } catch (e) { /* older browser: the next timed check still corrects it */ }
      return rec;
    }
    if (!pingable(b)) return null;
    return recordState(id, ok ? "live" : "dead", null);
  }

  /* "auto" is answered at the moment of use, never stored as a node: the
     fastest node today is not the fastest node tomorrow. */
  function resolveBackend(id) {
    var b = find(id);
    if (!b || b.kind !== "auto") return b;
    return bestNode() || find(DEFAULT_ID) || b;
  }

  /* Re-check the relay in the background so a tunnel that dies (or comes
     back) mid-session is noticed without a reload. Paused while the tab is
     hidden: a background tab should not spend the network on this. */
  function watchRelay() {
    if (relayWatch) return;
    relayWatch = setInterval(function () {
      try {
        if (document.hidden) return;
      } catch (e) { /* keep going */ }
      checkRelay(null);
    }, RELAY_WATCH_MS);
  }

  loadHealth();
  watchRelay();

  /* First check after the page has painted: it must never compete with boot. */
  setTimeout(function () { checkRelay(null); checkAll(null); }, 2500);

  /* Re-assert the saved backend once the relay is reachable, so a reload (or
     a tunnel that just came back) does not leave the relay on a stale
     upstream. Runs after the first paint so it never blocks boot. */
  setTimeout(function () { push(get(), null); }, 1200);
})();
