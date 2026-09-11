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
        headers: { "Content-Type": "application/json" },
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

  /* Re-assert the saved backend once the relay is reachable, so a reload (or
     a tunnel that just came back) does not leave the relay on a stale
     upstream. Runs after the first paint so it never blocks boot. */
  setTimeout(function () { push(get(), null); }, 1200);
})();
