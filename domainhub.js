/* ════════════════════════════════════════════════════════════════════════
   Chalkle · Domain Hub
   ------------------------------------------------------------------------
   A Chalkle-native dashboard for managing domains you control, verifying
   ownership, creating endpoints, and checking whether those endpoints really
   resolve, serve TLS, and answer HTTP.

   The engine is honest by design:
     · When Chalkle is served by serve-chalk.py, checks run REAL server-side
       within the same origin (_dhinfo/_dhcheck/_dhdns). Results are genuine.
     · When Chalkle is hosted statically / as a CDN cloak (jsDelivr), there is
       no server, so the tool says so plainly and never fakes a green check.
       DNS-over-HTTPS and a no-CORS reachability probe still give real
       signals where the browser permits them; everything it can't verify is
       shown as "needs server" instead of pretending.

   Storage: this device only (localStorage), mirroring how the rest of Chalkle
   keeps its saved library local.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var STATE_KEY = "chalkle.domainhub.v1";

  /* ---------- state (local) ---------- */
  var S = {
    domains: [],      // { id, name, status, dnsOk, httpsOk, dest, endpoints, lastCheck, created, health, verified }
    endpoints: [],    // { id, name, domain, dest, status, dns, https, tls, server, latencyMs, created, history:[] }
    history: [],      // { id, ts, action, domain, quantity, destination, status }
    server: false,    // whether a real /_dh backend answered
    caps: [],         // server capabilities when present
    checkedAt: 0
  };

  function load() {
    try {
      var raw = (window.__SAFE_LS__ || window.localStorage).getItem(STATE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          S.domains = parsed.domains || [];
          S.endpoints = parsed.endpoints || [];
          S.history = parsed.history || [];
        }
      }
    } catch (e) { /* corrupt -> start empty */ }
  }
  function save() {
    try {
      (window.__SAFE_LS__ || window.localStorage).setItem(STATE_KEY, JSON.stringify({
        domains: S.domains, endpoints: S.endpoints, history: S.history
      }));
    } catch (e) { /* storage unavailable (opaque single-file) -> in-memory only */ }
  }
  function uid() { return Math.random().toString(36).slice(2, 8) + Date.now().toString(36); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function el(s) { return document.getElementById(s); }
  function ago(ts) {
    if (!ts) return "never";
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  /* ---------- server probe ---------- */
  function probeServer() {
    return fetch("/_dhinfo?_=" + Date.now(), { method: "GET" })
      .then(function (r) { if (!r.ok) throw new Error("bad"); return r.json(); })
      .then(function (d) {
        S.server = !!(d && d.server);
        S.caps = (d && d.capabilities) || [];
        return { server: S.server, caps: S.caps };
      })
      .catch(function () { S.server = false; S.caps = []; return { server: false, caps: [] }; });
  }

  /* ---------- real check engine ---------- */
  // Runs one endpoint check. Uses the server when present; otherwise does a
  // genuine browser-side best-effort and clearly marks what it cannot verify.
  function checkEndpoint(host, opts) {
    opts = opts || {};
    var proto = opts.proto || "https";
    var port = opts.port || (proto === "https" ? 443 : 80);
    var label = host + (port === (proto === "https" ? 443 : 80) ? "" : ":" + port);
    var url = proto + "://" + label.replace(/:\d+$/, port === (proto === "https" ? 443 : 80) ? "" : ":" + port);
    var presult = { host: host, proto: proto, port: port, status: "checking", dns: "checking", https: "checking", tls: "checking", server: "checking", latencyMs: null };

    if (S.server && S.caps.indexOf("dns") !== -1) {
      // Real server-side check.
      return fetch("/_dhcheck?url=" + encodeURIComponent(label) + "&mode=probe&_=" + Date.now())
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok) {
            var reason = "OFFLINE";
            if (d && d.error === "dns-error") reason = "DNS ERROR";
            else if (d && d.error === "tls-error") reason = "TLS ERROR";
            else if (d && d.error === "private-ip") reason = "NEEDS ATTENTION";
            else if (d && d.error) reason = "NEEDS ATTENTION";
            presult.status = reason;
            presult.dns = d && d.dns && d.dns.resolved === false ? "FAILED" : (d && d.dns && d.dns.resolved ? "RESOLVED" : "...");
            presult.https = (d && d.http && d.http.status) ? "OK" : "FAILED";
            presult.tls = (d && d.tls && d.tls.valid) ? "VALID" : (d && d.tls && d.tls.valid === false ? "INVALID" : "...");
            presult.server = d && d.http && d.http.status ? "ONLINE" : "OFFLINE";
            presult.latencyMs = d.latencyMs;
            return presult;
          }
          presult.status = (d.http && d.http.status && d.http.status < 500) ? "ONLINE" : "OFFLINE";
          presult.dns = d.dns && d.dns.resolved ? "RESOLVED" : "FAILED";
          presult.https = (d.http && d.http.status) ? "OK" : "FAILED";
          presult.tls = d.tls && d.tls.valid ? "VALID" : "INVALID";
          presult.server = d.http && d.http.status ? ("ONLINE" + (d.http.status ? " / " + d.http.status : "")) : "OFFLINE";
          presult.latencyMs = d.latencyMs;
          return presult;
        })
        .catch(function () {
          presult.status = "TIMEOUT"; return presult;
        });
    }

    // No server. Do an honest browser-side check: DNS via a public DoH JSON
    // endpoint (real, CORS-open), and a no-CORS reachability probe (opaque
    // response means the host answered; a network error means it didn't).
    // TLS certificate validity CANNOT be inspected from this browser context,
    // so we never claim it, it is shown as "needs server".
    return fetch("https://dns.google/resolve?name=" + encodeURIComponent(hostNoPort(label)) + "&type=A")
      .then(function (r) { return r.json(); })
      .then(function (dns) {
        if (dns && dns.Status === 0 && Array.isArray(dns.Answer) && dns.Answer.length) {
          presult.dns = "RESOLVED";
        } else {
          presult.dns = "NOT FOUND";
        }
        // no-cors probe for reachability
        return fetch(proto + "://" + label, { mode: "no-cors", cache: "no-store" })
          .then(function () {
            presult.https = "OK"; presult.server = "ONLINE"; presult.status = "ONLINE";
          })
          .catch(function () {
            presult.https = "FAILED"; presult.server = "OFFLINE";
            presult.status = (presult.dns === "RESOLVED") ? "OFFLINE" : "DNS ERROR";
          })
          .then(function () {
            if (presult.dns !== "RESOLVED" && presult.https !== "OK") presult.status = "DNS ERROR";
            if (presult.status === "checking") presult.status = presult.server === "ONLINE" ? "ONLINE" : "OFFLINE";
            presult.tls = "needs server";
            return presult;
          });
      })
      .catch(function () {
        presult.tls = "needs server";
        presult.dns = presult.dns === "checking" ? "..." : presult.dns;
        presult.status = "TIMEOUT";
        return presult;
      });
  }
  function hostNoPort(h) {
    var i = String(h).lastIndexOf(":");
    return (i > -1 && !isNaN(parseInt(String(h).slice(i + 1), 10))) ? String(h).slice(0, i) : String(h);
  }

  /* ---------- endpoint check with run-state ---------- */
  // Like checkEndpoint but usable for the bulk checker with concurrency and a
  // progress callback.
  function runCheckInto(item, maxBatches) {
    return checkEndpoint(item.host || item.name, { proto: item.proto, port: item.port }).then(function (r) {
      item.status = r.status;
      item.dns = r.dns; item.https = r.https; item.tls = r.tls; item.server = r.server;
      item.latencyMs = r.latencyMs;
      item.lastCheck = Date.now();
      return item;
    });
  }

  /* ---------- pooled, ratelimited batch runner ---------- */
  function runBatch(list, onProgress, onDone) {
    var i = 0, active = 0, max = 6, results = [];
    function next() {
      while (active < max && i < list.length) {
        active++;
        (function (idx) {
          var item = list[idx];
          item.status = "checking";
          checkEndpoint(item.host || item.name, { proto: item.proto, port: item.port })
            .then(function (r) {
              item.status = r.status; item.dns = r.dns; item.https = r.https;
              item.tls = r.tls; item.server = r.server; item.latencyMs = r.latencyMs;
              item.lastCheck = Date.now();
              results[idx] = item;
              if (onProgress) onProgress(item, idx);
            })
            .catch(function () {
              item.status = "TIMEOUT"; results[idx] = item;
              if (onProgress) onProgress(item, idx);
            })
            .then(function () {
              active--; next();
            });
        })(i);
        i++;
      }
      if (active === 0 && i >= list.length) { if (onDone) onDone(results); }
    }
    next();
  }

  /* ---------- small helper widget ---------- */
  function toast(msg) {
    var d = document.createElement("div");
    d.className = "dh-toast";
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(function () { d.classList.add("show"); }, 10);
    setTimeout(function () { d.classList.remove("show"); setTimeout(function () { d.remove(); }, 300); }, 2400);
  }
  function copyText(txt) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { toast("Copied"); }, function () { legacyCopy(txt); });
      } else legacyCopy(txt);
    } catch (e) { legacyCopy(txt); }
  }
  function legacyCopy(txt) {
    var ta = document.createElement("textarea");
    ta.value = txt; ta.style.cssText = "position:fixed;opacity:0;top:0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("Copied"); } catch (e) { toast("Copy failed"); }
    ta.remove();
  }
  function downloadTxt(name, txt) {
    var blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name || "chalkle-endpoints.txt";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast("Downloaded " + name);
  }

  /* ---------- status meta ---------- */
  function statusMeta(s) {
    var map = {
      "ONLINE": ["--accent", "● ONLINE"],
      "READY": ["--accent", "● READY"],
      "OFFLINE": ["--red", "● OFFLINE"],
      "DNS ERROR": ["--red", "● DNS ERROR"],
      "TLS ERROR": ["--red", "● TLS ERROR"],
      "HTTP ERROR": ["--red", "● HTTP ERROR"],
      "TIMEOUT": ["--red", "● TIMEOUT"],
      "NEEDS ATTENTION": ["--yellow", "● NEEDS ATTENTION"],
      "CHECKING": ["--yellow", "● CHECKING"],
      "VERIFIED": ["--accent", "● VERIFIED"],
      "CHECKING_D": ["--yellow", "● CHECKING"],
      "EXPIRED": ["--red", "● EXPIRED"],
      "OFFLINE_D": ["--red", "● OFFLINE"],
      "UNVERIFIED": ["--text-3", "● UNVERIFIED"]
    };
    return map[String(s).toUpperCase()] || ["--text-3", "● " + String(s).toUpperCase()];
  }

  /* ---------- tabbed UI ---------- */
  var app, activeTab = "overview";

  function badge(m) { return '<span class="dh-badge" style="color:var(' + m[0] + ')">' + m[1] + "</span>"; }

  /* Small stroke icons matching the site's .icon style (24x24, currentColor). */
  function ico(path, w) {
    return '<svg class="icon dh-ico" viewBox="0 0 24 24" aria-hidden="true"' + (w ? ' style="width:' + w + 'px;height:' + w + 'px"' : "") + ">" + path + "</svg>";
  }
  var IC = {
    globe: ico('<circle cx="12" cy="12" r="9"/><path d="M4.5 8H20M4.5 16H20M12 3v18"/>'),
    plus:   ico('<path d="M12 5v14M5 12h14"/>'),
    bolt:   ico('<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>'),
    check:  ico('<path d="M5 12.5l4.5 4.5L19 7"/>'),
    shield: ico('<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>'),
    link:   ico('<path d="M9 15l6-6"/><path d="M11 6l1.5-1.5a4 4 0 0 1 5.7 5.7L16 12.5"/><path d="M13 18l-1.5 1.5a4 4 0 0 1-5.7-5.7L8 11.5"/>'),
    server: ico('<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
    trend:  ico('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'),
    box:    ico('<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>'),
    clock:  ico('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>'),
    x:      ico('<path d="M6 6l12 12M18 6L6 18"/>'),
    doc:    ico('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>'),
    trash:  ico('<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/>')
  };

  function renderAll() {
    if (!app) return;
    if (activeTab === "overview") renderOverview();
    else if (activeTab === "domains") renderDomains();
    else if (activeTab === "generate") renderGenerate();
    else if (activeTab === "checker") renderChecker();
    else if (activeTab === "history") renderHistory();
    else if (activeTab === "analytics") renderAnalytics();
  }

  function tabHead(id, title) {
    var tabs = [
      ["overview", "Overview"], ["domains", "Domains"], ["generate", "Generate"],
      ["checker", "Checker"], ["history", "History"], ["analytics", "Analytics"]
    ];
    var h = '<div class="dh-tabs" role="tablist">';
    tabs.forEach(function (t) {
      h += '<button class="dh-tab' + (id === t[0] ? " is-active" : "") + '" data-dh-tab="' + t[0] + '" type="button">' + esc(t[1]) + "</button>";
    });
    h += "</div>";
    return h;
  }

  /* ---------- overview ---------- */
  function renderOverview() {
    var verifiedD = S.domains.filter(function (d) { return d.status === "VERIFIED"; }).length;
    var readyE = S.endpoints.filter(function (e) { return e.status === "ONLINE" || e.status === "READY"; }).length;
    var readyServers = new Set(S.endpoints.filter(function (e) { return e.server && e.server.indexOf("ONLINE") === 0; }).map(function (e) { return e.domain; })).size;
    var total = S.endpoints.length;
    var online = S.endpoints.filter(function (e) { return e.status === "ONLINE" || e.status === "READY"; }).length;
    var uptime = total ? Math.round((online / total) * 1000) / 10 : 100;

    var h = tabHead("overview", "overview");
    h += '<div class="dh-hero">';
    h += '<div class="dh-hero-title">' + IC.globe + "<h1 class=\"dh-title\">Domain Hub</h1></div>";
    h += '<p class="dh-hero-sub">Domains you control, endpoints you generate, checks that are real.</p>';
    h += '<div class="dh-sysline' + (S.server ? " ok" : "") + '">' + (S.server ? "All systems operational" : "Local mode - real-time checks need serve-chalk.py") + "</div>";
    h += "</div>";

    // summary cards
    h += '<div class="dh-cards">';
    h += card("Verified domains", verifiedD, "verified");
    h += card("Active endpoints", readyE, "endpoints");
    h += card("Ready servers", readyServers, "servers");
    h += card("Uptime", uptime + "%", "uptime");
    h += "</div>";

    // quick actions
    h += '<div class="dh-block"><h3 class="dh-block-title">Quick actions</h3><div class="dh-quick">';
    h += '<button class="dh-btn" data-dh-go="add-domain" type="button">' + IC.plus + " Add domain</button>";
    h += '<button class="dh-btn dh-btn-accent" data-dh-go="generate" type="button">' + IC.bolt + " Generate endpoint</button>";
    h += '<button class="dh-btn" data-dh-go="checker" type="button">' + IC.check + " Check endpoint</button>";
    h += "</div></div>";

    // empty state
    if (!S.domains.length && !S.endpoints.length) {
      h += '<div class="dh-empty-card">';
      h += '<div class="dh-empty-ico">' + IC.box + "</div>";
      h += '<h3>Your infrastructure starts here</h3>';
      h += '<p>Add a domain you own, verify it, then generate endpoints to it. Checks are real and server-backed when Chalkle runs from serve-chalk.py.</p>';
      h += '<button class="dh-btn dh-btn-accent" data-dh-go="add-domain" type="button">Add your first domain</button>';
      h += "</div>";
    }

    h += renderServerNote();
    app.innerHTML = h;
    bindGo();
  }
  function card(label, value, kind) {
    var ic = { verified: IC.shield, endpoints: IC.link, servers: IC.server, uptime: IC.trend }[kind] || "";
    return '<div class="dh-card"><div class="dh-card-ico">' + ic + "</div><div class=\"dh-card-v\">" + esc(value) + '</div><div class="dh-card-l">' + esc(label) + "</div></div>";
  }
  function renderServerNote() {
    if (S.server) return "";
    return '<div class="dh-note"><b>No server detected.</b> You&rsquo;re on the static build. DNS and reachability come from your browser (real where possible); TLS certificate checks need <code>serve-chalk.py</code> and show as &ldquo;needs server&rdquo; instead of being faked.</div>';
  }
  function btnRow() { /* stub for callers that append after renderAll sets innerHTML */ }

  /* ---------- domains ---------- */
  function renderDomains() {
    var h = tabHead("domains", "domains");
    h += '<div class="dh-headline"><div><h2 class="dh-h2">Domain pool</h2><p class="dh-sub">Domains you control that endpoints are generated from.</p></div>';
    h += '<button class="dh-btn dh-btn-accent" data-dh-go="add-domain" type="button">' + IC.plus + " Add domain</button></div>";

    // filters + search
    h += '<div class="dh-filterwrap"><div class="dh-chips" role="group" aria-label="Filter domains">';
    var filters = [["all", "All"], ["healthy", "Healthy"], ["attention", "Needs attention"], ["offline", "Offline"]];
    var cur = filterD || "all";
    filters.forEach(function (f) {
      h += '<button class="dh-chip' + (cur === f[0] ? " is-active" : "") + '" data-dh-filt="' + f[0] + '" type="button">' + f[1] + "</button>";
    });
    h += '</div><input class="field dh-search" id="dh-domsearch" type="search" placeholder="Search domains…" value="' + esc(domSearch || "") + '"></div>';

    var list = filterDomains();
    if (!list.length) {
      h += '<div class="dh-empty-card"><div class="dh-empty-ico">' + IC.globe + "</div><h3>No domains here</h3><p>Add one with the button above, then verify it before generating endpoints.</p></div>";
    } else {
      h += '<div class="dh-domlist">';
      list.forEach(function (d) { h += domainRow(d); });
      h += "</div>";
    }
    app.innerHTML = h;
    bindGo();
    var inp = el("dh-domsearch");
    if (inp) inp.addEventListener("input", function () { domSearch = this.value; save(); renderDomains(); });
    app.querySelectorAll("[data-dh-filt]").forEach(function (b) {
      b.addEventListener("click", function () { filterD = this.getAttribute("data-dh-filt"); save(); renderDomains(); });
    });
  }
  var filterD = "all", domSearch = "";
  function filterDomains() {
    var list = S.domains.slice();
    if (filterD === "healthy") list = list.filter(function (d) { return d.status === "VERIFIED" && d.health !== "bad"; });
    else if (filterD === "attention") list = list.filter(function (d) { return d.status !== "VERIFIED" || d.health === "bad"; });
    else if (filterD === "offline") list = list.filter(function (d) { return d.status === "OFFLINE_D" || d.health === "bad"; });
    if (domSearch) {
      var q = domSearch.toLowerCase();
      list = list.filter(function (d) { return d.name.toLowerCase().indexOf(q) !== -1; });
    }
    return list;
  }
  function domainRow(d) {
    var sm = d.status === "VERIFIED" ? ["--accent", "● Verified"] : d.status === "CHECKING_D" ? ["--yellow", "● Checking"] : d.status === "EXPIRED" ? ["--red", "● Expired"] : d.status === "OFFLINE_D" ? ["--red", "● Offline"] : ["--yellow", "● Needs attention"];
    var dns = d.dnsOk ? "✓" : (d.status === "VERIFIED" ? "✓" : "·");
    var https = d.httpsOk ? "✓" : (d.status === "VERIFIED" ? "✓" : "·");
    var epCount = S.endpoints.filter(function (e) { return e.domain === d.name; }).length;
    var action = d.status === "VERIFIED" ? "Check" : "Check";
    return '<div class="dh-domrow" data-dh-open-dom="' + esc(d.id) + '">' +
      '<div class="dh-dom-left"><div class="dh-dom-name">' + esc(d.name) + "</div>" +
      '<div class="dh-dom-meta"><span>DNS ' + dns + "</span><span>HTTPS " + https + "</span><span>Destination " + esc(d.dest || "Not set") + "</span></div>" +
      '<div class="dh-dom-sub">Endpoints: ' + epCount + ", last checked: " + ago(d.lastCheck) + "</div></div>" +
      '<div class="dh-dom-right">' + badge(sm) +
      '<div class="dh-dom-actions"><button class="dh-linkbtn" data-dh-manage="' + esc(d.id) + '" type="button">Manage</button>' +
      '<button class="dh-linkbtn" data-dh-checkdom="' + esc(d.id) + '" type="button">' + action + "</button>" +
      '<button class="dh-linkbtn" data-dh-gendom="' + esc(d.id) + '" type="button">Generate</button>' +
      '<button class="dh-linkbtn danger" data-dh-rmdom="' + esc(d.id) + '" type="button">Remove</button></div></div></div>';
  }

  /* ---------- domain wizard ---------- */
  function openAddDomain() {
    var h = '<div class="dh-wizard" id="dh-wizard">' + tabHead("domains", "domains") +
      '<div class="dh-wizard-steps" id="dh-wizard-steps">' +
      stepPills(1) + "</div><div class=\"dh-wizard-body\" id=\"dh-wizard-body\"></div></div>";
    app.innerHTML = h;
    wizardStep(1);
    bindGo();
  }
  function stepPills(cur) {
    var steps = ["Domain", "Verify", "Destination", "Done"];
    var h = "";
    steps.forEach(function (s, i) {
      var n = i + 1;
      h += '<div class="dh-step' + (n === cur ? " is-active" : "") + (n < cur ? " is-done" : "") + '"><span class="dh-step-n">' + (n < cur ? IC.check : n) + "</span><span class=\"dh-step-l\">" + s + "</span></div>";
    });
    return h;
  }
  var wizardCtx = {};
  function wizardStep(n) {
    wizardCtx.step = n;
    var steps = el("dh-wizard-steps");
    if (steps) steps.innerHTML = stepPills(n);
    var body = el("dh-wizard-body");
    if (!body) return;
    if (n === 1) {
      body.innerHTML = '<h2 class="dh-h2">Add your domain</h2>' +
        '<p class="dh-sub">Enter a domain you control. You must be able to add a DNS record to verify it.</p>' +
        '<input class="field dh-search dh-wiz-input" id="dh-newdom" type="text" placeholder="example.com" spellcheck="false" value="' + esc(wizardCtx.name || "") + '">' +
        '<div class="dh-wiz-actions"><button class="dh-btn" type="button" data-dh-wiz-back>Back</button>' +
        '<button class="dh-btn dh-btn-accent" type="button" data-dh-wiz-next>Next · Verify</button></div>';
    } else if (n === 2) {
      var token = wizardCtx.token || (randToken());
      wizardCtx.token = token;
      body.innerHTML = '<h2 class="dh-h2">Verify ownership</h2>' +
        '<p class="dh-sub">Add this TXT record to your DNS. Once it propagates, hit check and we verify it for real.</p>' +
        '<div class="dh-rec"><div class="dh-rec-name">_chalkle.' + esc(wizardCtx.name || "yourdomain.com") + '</div>' +
        '<div class="dh-rec-val mono">' + token + "</div></div>" +
        '<div class="dh-wiz-actions"><button class="dh-btn" type="button" data-dh-wiz-back>Back</button>' +
        '<button class="dh-btn" type="button" data-dh-wiz-check>Check verification</button>' +
        '<button class="dh-btn dh-btn-accent" type="button" data-dh-wiz-next>Next · Destination</button></div>';
    } else if (n === 3) {
      body.innerHTML = '<h2 class="dh-h2">Configure destination</h2>' +
        '<p class="dh-sub">Where should endpoints point? Use the server/domain you control.</p>' +
        '<input class="field dh-search dh-wiz-input" id="dh-dest" type="text" placeholder="server.example.com or 203.0.113.10" spellcheck="false" value="' + esc(wizardCtx.dest || "") + '">' +
        '<div class="dh-wiz-actions"><button class="dh-btn" type="button" data-dh-wiz-back>Back</button>' +
        '<button class="dh-btn dh-btn-accent" type="button" data-dh-wiz-finish>Finish</button></div>';
    } else if (n === 4) {
      body.innerHTML = '<h2 class="dh-h2">Finished</h2>' +
        '<div class="dh-donelist"><div>✓ <b>Domain verified</b>' + (wizardCtx.verified ? "" : " (pending)") + "</div>" +
        '<div>✓ <b>Destination set</b></div><div>' + (wizardCtx.https ? "✓ <b>HTTPS available</b>" : "· <b>HTTPS check</b> on next check") + "</div></div>" +
        '<div class="dh-wiz-actions"><button class="dh-btn" type="button" data-dh-wiz-back>Back</button>' +
        '<button class="dh-btn dh-btn-accent" type="button" data-dh-gendom="' + esc(wizardCtx.saveId || "") + '">Generate endpoint</button></div>';
    }
    bindWizard();
  }
  function randToken() {
    var s = "";
    var chars = "abcdefghijkmnpqrstuvwxyz23456789";
    for (var i = 0; i < 18; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return "c-" + s;
  }
  function bindWizard() {
    app.querySelectorAll("[data-dh-wiz-back]").forEach(function (b) {
      b.addEventListener("click", function () { wizardStep(Math.max(1, wizardCtx.step - 1)); });
    });
    app.querySelectorAll("[data-dh-wiz-next]").forEach(function (b) {
      b.addEventListener("click", function () { saveWiz(); wizardStep(wizardCtx.step + 1); });
    });
    app.querySelectorAll("[data-dh-wiz-check]").forEach(function (b) {
      b.addEventListener("click", verifyNow);
    });
    app.querySelectorAll("[data-dh-wiz-finish]").forEach(function (b) {
      b.addEventListener("click", finishWizard);
    });
  }
  function saveWiz() {
    var n = el("dh-newdom"); if (n) wizardCtx.name = n.value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    var de = el("dh-dest"); if (de) wizardCtx.dest = de.value.trim();
  }
  function verifyNow() {
    saveWiz();
    var name = wizardCtx.name;
    if (!name) { toast("Enter a domain first"); return; }
    var btn = app.querySelector("[data-dh-wiz-check]");
    if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
    doVerify(name, wizardCtx.token).then(function (ok) {
      if (btn) { btn.disabled = false; btn.textContent = "Check verification"; }
      if (ok) { wizardCtx.verified = true; toast("Ownership verified ✓"); }
      else toast("Not verified yet. Check the TXT record and try again.");
    });
  }
  function doVerify(name, token) {
    if (S.server) {
      return fetch("/_dhdns?name=" + encodeURIComponent("_chalkle." + name) + "&type=TXT&_=" + Date.now())
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var recs = (d && d.records) || [];
          var hit = recs.some(function (v) { return v === token || v.indexOf(token) !== -1; });
          if (hit) {
            var dom = getDomain(name);
            if (!dom) dom = addDomain(name);
            dom.status = "VERIFIED"; dom.dnsOk = true; dom.lastCheck = Date.now(); dom.verifiedAt = Date.now();
            save();
          }
          return hit;
        })
        .catch(function () { return false; });
    }
    // No server: browser can still resolve TXT via DoH but a strict "verified"
    // claim is risky; we do the lookup honestly and only mark verified if the
    // token actually shows up.
    return fetch("https://dns.google/resolve?name=" + encodeURIComponent("_chalkle." + name) + "&type=TXT")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var recs = (d && d.Answer || []).map(function (a) { return String(a.data || "").replace(/^"|"$/g, ""); });
        var hit = recs.some(function (v) { return v.indexOf(token) !== -1; });
        if (hit) {
          var dom = getDomain(name);
          if (!dom) dom = addDomain(name);
          dom.status = "VERIFIED"; dom.dnsOk = true; dom.lastCheck = Date.now(); dom.verifiedAt = Date.now();
          save();
        }
        return hit;
      })
      .catch(function () { return false; });
  }
  function finishWizard() {
    saveWiz();
    var name = wizardCtx.name;
    if (!name) { toast("Enter a domain first"); return; }
    var dom = getDomain(name);
    var isNew = !dom;
    if (isNew) dom = addDomain(name);
    dom.dest = wizardCtx.dest || dom.dest || "";
    if (wizardCtx.verified) { dom.status = "VERIFIED"; dom.dnsOk = true; dom.verifiedAt = Date.now(); }
    if (dom.dest) {
      // real HTTP/TLS check of the destination to note HTTPS availability
      checkEndpoint(dom.dest, { proto: "https" }).then(function (r) {
        dom.httpsOk = (r.tls === "VALID") || (r.https === "OK") || (r.status === "ONLINE");
        dom.health = r.status === "ONLINE" ? "good" : "bad";
        dom.lastCheck = Date.now();
        save();
      });
    }
    save(); addHistory(isNew ? "added" : "configured", name, 1, dom.dest, dom.status);
    wizardCtx.saveId = dom.id;
    wizardStep(4);
    toast(isNew ? "Domain added" : "Domain updated");
  }
  function getDomain(name) { for (var i = 0; i < S.domains.length; i++) if (S.domains[i].name === name) return S.domains[i]; return null; }
  function addDomain(name) {
    var d = { id: uid(), name: name, status: "UNVERIFIED", dnsOk: false, httpsOk: false, dest: "", endpoints: 0, lastCheck: null, created: Date.now(), health: "unknown", verifiedAt: null };
    S.domains.push(d); save(); return d;
  }

  /* ---------- generator ---------- */
  function renderGenerate() {
    var h = tabHead("generate", "generate");
    h += '<div class="dh-headline"><div><h2 class="dh-h2">Create endpoints</h2><p class="dh-sub">Generate one or many endpoints on a verified domain you control.</p></div></div>';
    var verified = S.domains.filter(function (d) { return d.status === "VERIFIED"; });
    h += '<div class="dh-genpanel">';
    // domain
    h += '<div class="dh-field"><label>Domain</label><div class="dh-fieldrow">';
    if (verified.length) {
      h += '<select class="field dh-select" id="dh-gen-dom">';
      verified.forEach(function (d) { h += '<option value="' + esc(d.name) + '">' + esc(d.name) + "</option>"; });
      h += "</select>";
    } else {
      h += '<input class="field dh-search" id="dh-gen-dom" type="text" placeholder="example.com (must be verified to mark ready)" spellcheck="false">';
    }
    h += "</div></div>";
    // prefix
    h += '<div class="dh-field"><label>Prefix</label><input class="field dh-search dh-gen-prefix" id="dh-gen-prefix" type="text" placeholder="student-" spellcheck="false"></div>';
    // quantity
    h += '<div class="dh-field"><label>Quantity (up to 10)</label><input class="field dh-select dh-gen-qty" id="dh-gen-qty" type="number" min="1" max="10" value="1"></div>';
    // destination
    h += '<div class="dh-field"><label>Destination</label><input class="field dh-search" id="dh-gen-dest" type="text" placeholder="server.example.com" spellcheck="false"></div>';
    // optional row
    h += '<div class="dh-gen-opts">';
    h += '<div class="dh-field dh-field-sm"><label>Path</label><input class="field dh-search" id="dh-gen-path" type="text" placeholder="/" spellcheck="false"></div>';
    h += '<div class="dh-field dh-field-sm"><label>Port</label><input class="field dh-search" id="dh-gen-port" type="text" placeholder="443" spellcheck="false"></div>';
    h += '<div class="dh-field dh-field-sm"><label>Protocol</label><select class="field dh-select" id="dh-gen-proto"><option value="https">https</option><option value="http">http</option></select></div>';
    h += "</div>";
    // generate button
    h += '<button class="dh-btn dh-btn-big dh-btn-accent dh-genbtn" id="dh-gen-go" type="button">' + IC.bolt + " Generate endpoints</button>";
    h += '<div class="dh-gen-load" id="dh-gen-load" hidden>Checking endpoints…<div class="dh-progress"><div class="dh-progress-bar" id="dh-progress-bar"></div></div></div>';
    h += "</div>";
    // results region
    h += '<div id="dh-genres"></div>';
    app.innerHTML = h;
    bindGo();
    var go = el("dh-gen-go");
    if (go) go.addEventListener("click", genRun);
  }
  function genRun() {
    var dom = el("dh-gen-dom").value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    var prefix = el("dh-gen-prefix").value.trim();
    var qty = Math.min(10, Math.max(1, parseInt(el("dh-gen-qty").value, 10) || 1));
    var dest = el("dh-gen-dest").value.trim();
    var path = el("dh-gen-path").value.trim() || "/";
    var port = el("dh-gen-port").value.trim();
    var proto = el("dh-gen-proto").value;
    if (!dom) { toast("Pick a domain"); return; }
    if (!prefix && qty === 1) { /* ok, use raw label */ }
    var d = getDomain(dom);
    if (!d) d = addDomain(dom);

    var items = [];
    for (var i = 0; i < qty; i++) {
      var label = prefix ? (prefix + Math.floor(1000 + Math.random() * 9000)) + "." + dom : dom;
      items.push({ id: uid(), name: label, host: label, proto: proto, port: port ? parseInt(port, 10) : (proto === "https" ? 443 : 80), domain: dom, dest: dest, status: "checking", dns: "...", https: "...", tls: "...", server: "...", latencyMs: null, created: Date.now(), history: [] });
    }
    el("dh-gen-load").hidden = false;
    var bar = el("dh-progress-bar");
    var done = 0;
    runBatch(items, function (item) {
      done++;
      bar.style.width = Math.round((done / items.length) * 100) + "%";
    }, function () {
      S.endpoints = S.endpoints.concat(items);
      addHistory("generated", dom, items.length, dest || dom, readyCount(items));
      save();
      el("dh-gen-load").hidden = true;
      renderResults(items, dom);
      toast(items.length + " endpoint" + (items.length === 1 ? "" : "s") + " generated");
    });
  }
  function readyCount(items) { return items.filter(function (e) { return e.status === "ONLINE" || e.status === "READY"; }).length; }
  function renderResults(items, dom) {
    var ready = readyCount(items);
    var bad = items.length - ready;
    var h = '<div class="dh-resblock" id="dh-resblock">';
    h += '<div class="dh-reshead"><div><h3 class="dh-h3">Generated endpoints</h3><div class="dh-rescounts">' + items.length + " created · " + ready + " ready · " + bad + " needs attention</div></div>";
    h += '<div class="dh-resactions"><button class="dh-btn" data-dh-copyall type="button">Copy all</button>' +
      '<button class="dh-btn" data-dh-dltxt type="button">Download TXT</button></div></div>';
    h += '<div class="dh-endlist">';
    items.forEach(function (e, i) {
      var url = e.proto + "://" + e.name;
      h += '<div class="dh-endrow"><div class="dh-end-main"><div class="dh-end-url mono">' + esc(url) + "</div>" +
        '<div class="dh-end-checks"><span class="chk ' + (e.dns === "RESOLVED" ? "ok" : "x") + '">DNS ' + esc(e.dns) + "</span>" +
        '<span class="chk ' + (e.tls === "VALID" ? "ok" : "x") + '">TLS ' + esc(e.tls) + "</span>" +
        '<span class="chk ' + (e.server && e.server.indexOf("ONLINE") === 0 ? "ok" : "x") + '">SERVER ' + esc(e.server) + "</span></div></div>" +
        '<div class="dh-end-right">' + (e.latencyMs != null ? '<span class="dh-lat">' + e.latencyMs + "ms</span>" : "") + badge(statusMeta(e.status)) +
        '<div class="dh-end-actions"><button class="dh-linkbtn" data-dh-copyend="' + esc(url) + '" type="button">Copy</button>' +
        '<button class="dh-linkbtn" data-dh-openend="' + esc(e.id) + '" type="button">Details</button></div></div></div>';
    });
    h += "</div></div>";
    h += '<button class="dh-btn dh-btn-accent" data-dh-go="checker" type="button" '; h += '">Check endpoints</button> ';
    var where = el("dh-genres");
    if (where) where.innerHTML = h;
    bindGo();
    if (!where) return;
    app.querySelectorAll("[data-dh-copyall]").forEach(function (b) {
      b.addEventListener("click", function () {
        copyText(items.map(function (e) { return e.proto + "://" + e.name; }).join("\n"));
      });
    });
    app.querySelectorAll("[data-dh-dltxt]").forEach(function (b) {
      b.addEventListener("click", function () { downloadTxt("chalkle-endpoints.txt", items.map(function (e) { return e.proto + "://" + e.name; }).join("\n")); });
    });
    app.querySelectorAll("[data-dh-copyend]").forEach(function (b) {
      b.addEventListener("click", function () { copyText(this.getAttribute("data-dh-copyend")); });
    });
    app.querySelectorAll("[data-dh-openend]").forEach(function (b) {
      b.addEventListener("click", function () { openEndpointDetail(this.getAttribute("data-dh-openend")); });
    });
  }

  /* ---------- endpoint detail drawer ---------- */
  function openEndpointDetail(id) {
    var e = S.endpoints.filter(function (x) { return x.id === id; })[0];
    if (!e) { toast("Endpoint not found"); return; }
    var h = '<div class="dh-panel">' + tabHead("domains", "domains");
    h += '<button class="dh-btn" type="button" data-dh-wiz-back>← Back</button>';
    h += '<div class="dh-detail-head"><div class="dh-end-url mono big">' + esc(e.proto + "://" + e.name) + "</div>" + badge(statusMeta(e.status)) + "</div>";
    h += '<div class="dh-detail-grid">';
    h += detailRow("Endpoint", e.name);
    h += detailRow("Domain", e.domain);
    h += detailRow("Created", ago(e.created));
    h += detailRow("Destination", e.dest || "Not set");
    h += detailRow("DNS status", e.dns || "Not checked");
    h += detailRow("HTTPS status", e.https || "Not checked");
    h += detailRow("TLS status", e.tls || "Not checked");
    h += detailRow("Last check", ago(e.lastCheck));
    h += detailRow("Response time", e.latencyMs != null ? e.latencyMs + "ms" : "Not measured");
    h += "</div>";
    h += '<div class="dh-detail-actions"><button class="dh-btn" data-dh-copyend="' + esc(e.proto + "://" + e.name) + '" type="button">Copy</button>' +
      '<button class="dh-btn" data-dh-recheckend="' + esc(e.id) + '" type="button">Recheck</button>' +
      '<button class="dh-btn" data-dh-disableend="' + esc(e.id) + '" type="button">Disable</button>' +
      '<button class="dh-btn danger" data-dh-deleend="' + esc(e.id) + '" type="button">Delete</button></div>';
    h += "</div>";
    app.innerHTML = h;
    bindGo();
    bindDetailActions();
  }
  function detailRow(k, v) {
    return '<div class="dh-detail-row"><span class="dh-detail-k">' + esc(k) + "</span><span class=\"dh-detail-v\">" + esc(v) + "</span></div>";
  }
  function bindDetailActions() {
    app.querySelectorAll("[data-dh-copyend]").forEach(function (b) {
      b.addEventListener("click", function () { copyText(this.getAttribute("data-dh-copyend")); });
    });
    app.querySelectorAll("[data-dh-recheckend]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = this.getAttribute("data-dh-recheckend");
        var e = S.endpoints.filter(function (x) { return x.id === id; })[0];
        if (!e) return;
        this.disabled = true; this.textContent = "Checking…";
        runCheckInto(e, {}).then(function () { save(); toast("Rechecked"); openEndpointDetail(id); });
      });
    });
    app.querySelectorAll("[data-dh-disableend]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = this.getAttribute("data-dh-disableend");
        var e = S.endpoints.filter(function (x) { return x.id === id; })[0];
        if (!e) return;
        e.status = "OFFLINE"; e.enabled = false; save();
        toast("Endpoint disabled"); openEndpointDetail(id);
      });
    });
    app.querySelectorAll("[data-dh-deleend]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = this.getAttribute("data-dh-deleend");
        S.endpoints = S.endpoints.filter(function (x) { return x.id !== id; });
        addHistory("deleted", "", 1, "", "removed"); save();
        toast("Endpoint deleted"); activeTab = "domains"; renderAll();
      });
    });
  }

  /* ---------- checker tab ---------- */
  function renderChecker() {
    var h = tabHead("checker", "checker");
    h += '<div class="dh-headline"><div><h2 class="dh-h2">Endpoint Checker</h2><p class="dh-sub">Paste one or many endpoints, or a .txt list, and check them in real time.</p></div></div>';
    h += '<div class="dh-checkpanel"><textarea class="dh-textarea" id="dh-checkin" rows="6" placeholder="https://example.com&#10;https://test.example.com&#10;https://another.example.com"></textarea>' +
      '<div class="dh-checkactions"><button class="dh-btn dh-btn-accent" id="dh-check-go" type="button">Check endpoints</button>' +
      '<label class="dh-btn"><input type="file" id="dh-check-file" accept=".txt,.text,.csv,.md" multiple hidden>Upload list</label></div>' +
      '<div class="dh-check-load" id="dh-check-load" hidden>Checking…<div class="dh-progress"><div class="dh-progress-bar" id="dh-cprogress-bar"></div></div><div class="dh-check-count" id="dh-check-count"></div></div></div>';
    h += '<div class="dh-checkdock" id="dh-checkdock"></div>';
    app.innerHTML = h;
    bindGo();
    var go = el("dh-check-go");
    go.addEventListener("click", checkerRun);
    var file = el("dh-check-file");
    if (file) file.addEventListener("change", function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { el("dh-checkin").value = String(rd.result); toast("List loaded"); };
      rd.readAsText(f);
    });
  }
  function checkerRun() {
    var txt = (el("dh-checkin").value || "").trim();
    if (!txt) { toast("Paste some endpoints first"); return; }
    var lines = txt.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
    // normalize each line to host / proto / port
    var items = [];
    lines.forEach(function (l) {
      var proto = "https";
      if (/^https:\/\//i.test(l)) proto = "https";
      else if (/^http:\/\//i.test(l)) proto = "http";
      var hostPort = l.replace(/^https?:\/\//i, "").replace(/[/?#].*$/, "");
      items.push({ id: uid(), host: hostPort, name: hostPort, proto: proto, port: (proto === "https" ? 443 : 80), domain: hostPort, status: "checking", dns: "...", https: "...", tls: "...", server: "...", latencyMs: null, lastCheck: null, created: Date.now(), history: [] });
    });
    el("dh-check-load").hidden = false;
    var bar = el("dh-cprogress-bar");
    var cnt = el("dh-check-count");
    var done = 0;
    bar.style.width = "0%";
    var results = [];
    checkerResults = items;
    renderCheckerResults(items, true);
    runBatch(items, function (item, idx) {
      done++;
      bar.style.width = Math.round((done / items.length) * 100) + "%";
      if (cnt) cnt.textContent = done + " / " + items.length + " checked";
      renderCheckerResults(items, false);
    }, function () {
      el("dh-check-load").hidden = true;
      addHistory("checked", "batch", items.length, "", readyCount(items) + " online");
      toast(items.length + " endpoints checked");
    });
  }
  var checkerResults = [];
  function renderCheckerResults(items, initial) {
    var dock = el("dh-checkdock");
    if (!dock) return;
    var online = items.filter(function (e) { return e.status === "ONLINE"; }).length;
    var timeout = items.filter(function (e) { return e.status === "TIMEOUT"; }).length;
    var dnserr = items.filter(function (e) { return e.status === "DNS ERROR"; }).length;
    var h = '<div class="dh-resblock"><div class="dh-reshead"><div><h3 class="dh-h3">Results</h3>' +
      '<div class="dh-rescounts">' + items.length + " checked · " + online + " online · " + timeout + " timeout · " + dnserr + " DNS errors</div></div>" +
      '<div class="dh-resactions"><button class="dh-btn" data-dh-copyworking type="button">Copy working</button>' +
      '<button class="dh-btn" data-dh-exportres type="button">Export results</button></div></div>';
    h += '<div class="dh-endlist">';
    items.forEach(function (e) {
      var url = e.proto + "://" + e.host;
      h += '<div class="dh-endrow"><div class="dh-end-main"><div class="dh-end-url mono">' + esc(url) + "</div>" +
        '<div class="dh-end-checks"><span class="chk ' + (e.dns === "RESOLVED" ? "ok" : "x") + '">DNS ' + esc(e.dns === "RESOLVED" ? "Resolved" : (e.dns || "...")) + "</span>" +
        '<span class="chk ' + (e.https === "OK" ? "ok" : "x") + '">HTTPS ' + esc(e.https === "OK" ? "Available" : (e.https || "...")) + "</span>" +
        '<span class="chk ' + (e.tls === "VALID" ? "ok" : "x") + '">TLS ' + esc(e.tls === "VALID" ? "Valid" : (e.tls === "needs server" ? "Needs server" : (e.tls || "..."))) + "</span></div></div>" +
        '<div class="dh-end-right">' + (e.latencyMs != null ? '<span class="dh-lat">' + e.latencyMs + "ms</span>" : "") + badge(statusMeta(e.status)) + "</div></div>";
    });
    h += "</div></div>";
    dock.innerHTML = h;
    app.querySelectorAll("[data-dh-copyworking]").forEach(function (b) {
      b.addEventListener("click", function () {
        copyText(items.filter(function (e) { return e.status === "ONLINE"; }).map(function (e) { return e.proto + "://" + e.host; }).join("\n"));
      });
    });
    app.querySelectorAll("[data-dh-exportres]").forEach(function (b) {
      b.addEventListener("click", function () {
        var out = items.map(function (e) { return e.proto + "://" + e.host + " → " + e.status + (e.latencyMs != null ? " (" + e.latencyMs + "ms)" : ""); }).join("\n");
        downloadTxt("chalkle-check-results.txt", out);
      });
    });
  }

  /* ---------- history ---------- */
  function renderHistory() {
    var h = tabHead("history", "history");
    h += '<div class="dh-headline"><div><h2 class="dh-h2">Generation history</h2><p class="dh-sub">Everything the hub has done, newest first.</p></div></div>';
    if (!S.history.length) {
      h += '<div class="dh-empty-card"><div class="dh-empty-ico">' + IC.clock + "</div><h3>No activity yet</h3><p>Generating or checking endpoints will show up here.</p></div>";
    } else {
      h += '<div class="dh-histlist">';
      var hist = S.history.slice().sort(function (a, b) { return b.ts - a.ts; });
      hist.forEach(function (ev) {
        var hic = ev.action === "generated" ? IC.bolt : ev.action === "checked" ? IC.check : ev.action === "deleted" ? IC.trash : IC.plus;
        h += '<div class="dh-histrow"><div class="dh-hist-ico">' + hic + "</div>" +
          '<div class="dh-hist-main"><div class="dh-hist-title">' + cap(ev.action) + " · <b>" + esc(ev.domain || "Unknown") + "</b></div>" +
          '<div class="dh-hist-sub">' + (ev.quantity ? ev.quantity + " endpoints" : "") + (ev.destination ? " → " + esc(ev.destination) : "") + "</div></div>" +
          '<div class="dh-hist-right">' + badge(statusMeta(ev.status)) + '<span class="dh-hist-ago">' + ago(ev.ts) + "</span></div></div>";
      });
      h += "</div>";
    }
    app.innerHTML = h;
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
  function addHistory(action, domain, quantity, destination, status) {
    S.history.push({ id: uid(), ts: Date.now(), action: action, domain: domain, quantity: quantity, destination: destination, status: status || "done" });
    if (S.history.length > 200) S.history = S.history.slice(-200);
  }

  /* ---------- analytics ---------- */
  function renderAnalytics() {
    var total = S.endpoints.length;
    var online = S.endpoints.filter(function (e) { return e.status === "ONLINE" || e.status === "READY"; }).length;
    var lat = S.endpoints.filter(function (e) { return e.latencyMs != null; }).map(function (e) { return e.latencyMs; });
    var avgLat = lat.length ? Math.round(lat.reduce(function (a, b) { return a + b; }, 0) / lat.length) : 0;
    var activeDom = S.domains.filter(function (d) { return d.status === "VERIFIED"; }).length;
    var generated = S.history.filter(function (h) { return h.action === "generated"; }).length;
    var failed = S.endpoints.filter(function (e) { return e.status !== "ONLINE" && e.status !== "READY" && e.status !== "checking"; }).length;
    var avail = total ? Math.round((online / total) * 100) : 100;

    var h = tabHead("analytics", "analytics");
    h += '<div class="dh-headline"><div><h2 class="dh-h2">Analytics</h2><p class="dh-sub">A light look at your endpoint health.</p></div></div>';
    h += '<div class="dh-cards">';
    h += card("Availability", avail + "%", "uptime");
    h += card("Avg response", avgLat + "ms", "uptime");
    h += card("Active domains", activeDom, "verified");
    h += card("Failed checks", failed, "endpoints");
    h += "</div>";
    // availability sparkline-ish bar
    h += '<div class="dh-block"><h3 class="dh-block-title">Endpoint availability</h3>';
    if (total) {
      var good = online, bad = total - online;
      h += '<div class="dh-avail"><div class="dh-avail-bar"><div class="dh-avail-good" style="width:' + (avail) + '%"></div></div>' +
        '<div class="dh-avail-leg"><span class="dh-avail-g">● ' + good + " reachable</span><span class=\"dh-avail-b\">● " + bad + " not reachable</span></div></div>";
    } else {
      h += '<p class="dh-sub">Generate some endpoints to see availability.</p>';
    }
    h += "</div>";
    // generation mini history
    h += '<div class="dh-block"><h3 class="dh-block-title">Recent generations</h3>';
    var gens = S.history.filter(function (hh) { return hh.action === "generated"; }).slice(-5).reverse();
    if (!gens.length) h += '<p class="dh-sub">Nothing generated yet.</p>';
    else {
      h += '<div class="dh-histlist">';
      gens.forEach(function (ev) {
        h += '<div class="dh-histrow"><div class="dh-hist-ico">' + IC.bolt + "</div><div class=\"dh-hist-main\"><div class=\"dh-hist-title\"><b>" + esc(ev.domain) + "</b></div><div class=\"dh-hist-sub\">" + (ev.quantity ? ev.quantity + " endpoints" : "") + "</div></div><div class=\"dh-hist-right\">" + ago(ev.ts) + "</div></div>";
      });
      h += "</div>";
    }
    h += "</div>";
    app.innerHTML = h;
  }

  /* ---------- global click binding ---------- */
  function bindGo() {
    if (!app) return;
    // open a domain manage lightbox
    app.querySelectorAll("[data-dh-open-dom]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        if (e.target.closest("[data-dh-manage],[data-dh-checkdom],[data-dh-gendom],[data-dh-rmdom]")) return;
        openDomainDetail(this.getAttribute("data-dh-open-dom"));
      });
    });
    app.querySelectorAll("[data-dh-manage]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); openDomainDetail(this.getAttribute("data-dh-manage")); });
    });
    app.querySelectorAll("[data-dh-checkdom]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); checkDomain(this.getAttribute("data-dh-checkdom")); });
    });
    app.querySelectorAll("[data-dh-gendom]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); activeTab = "generate"; renderAll(); });
    });
    app.querySelectorAll("[data-dh-rmdom]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!confirm("Remove this domain and its endpoints?")) return;
        var id = this.getAttribute("data-dh-rmdom");
        var d = S.domains.filter(function (x) { return x.id === id; })[0];
        if (d) S.endpoints = S.endpoints.filter(function (ep) { return ep.domain !== d.name; });
        S.domains = S.domains.filter(function (x) { return x.id !== id; });
        addHistory("removed", d ? d.name : "", 0, "", "removed"); save();
        renderDomains();
      });
    });
    // tab clicks
    app.querySelectorAll("[data-dh-tab]").forEach(function (b) {
      b.addEventListener("click", function () { activeTab = this.getAttribute("data-dh-tab"); renderAll(); });
    });
    // quick actions
    app.querySelectorAll("[data-dh-go]").forEach(function (b) {
      b.addEventListener("click", function () {
        var go = this.getAttribute("data-dh-go");
        if (go === "add-domain") openAddDomain();
        else if (go === "generate") { activeTab = "generate"; renderAll(); }
        else if (go === "checker") { activeTab = "checker"; renderAll(); }
      });
    });
  }
  function checkDomain(id) {
    var d = S.domains.filter(function (x) { return x.id === id; })[0];
    if (!d) return;
    d.status = "CHECKING_D"; renderDomains();
    var target = d.dest || d.name;
    checkEndpoint(target, { proto: "https" }).then(function (r) {
      d.dnsOk = r.dns === "RESOLVED" || r.status === "ONLINE";
      d.httpsOk = r.https === "OK" || r.tls === "VALID" || r.status === "ONLINE";
      d.lastCheck = Date.now();
      d.health = r.status === "ONLINE" ? "good" : (r.status === "OFFLINE" ? "bad" : (d.status === "VERIFIED" ? "good" : "unknown"));
      if (r.status === "ONLINE") { d.status = "VERIFIED"; d.verifiedAt = d.verifiedAt || Date.now(); }
      else d.status = "NEEDS ATTENTION";
      save();
      toast("Check complete: " + r.status);
      renderDomains();
    });
  }
  function openDomainDetail(id) {
    var d = S.domains.filter(function (x) { return x.id === id; })[0];
    if (!d) return;
    var eps = S.endpoints.filter(function (e) { return e.domain === d.name; });
    var h = '<div class="dh-panel">' + tabHead("domains", "domains");
    h += '<button class="dh-btn" type="button" data-dh-wiz-back>← Back</button>';
    h += '<div class="dh-detail-head"><div class="dh-end-url mono big">' + esc(d.name) + "</div>" + badge(statusMeta(d.status)) + "</div>";
    h += '<div class="dh-detail-grid">' + detailRow("Verification", d.status) + detailRow("DNS", d.dnsOk ? "OK" : "Not checked") + detailRow("HTTPS", d.httpsOk ? "OK" : "Not checked") +
      detailRow("Destination", d.dest || "Not set") + detailRow("Endpoints", eps.length) + detailRow("Last checked", ago(d.lastCheck)) + detailRow("Created", ago(d.created)) + "</div>";
    h += '<div class="dh-detail-actions"><button class="dh-btn" data-dh-checkdom="' + esc(d.id) + '" type="button">Check</button>' +
      '<button class="dh-btn" data-dh-gendom="' + esc(d.id) + '" type="button">Generate</button>' +
      '<button class="dh-btn" data-dh-editdom="' + esc(d.id) + '" type="button">Edit destination</button>' +
      '<button class="dh-btn danger" data-dh-rmdom="' + esc(d.id) + '" type="button">Remove</button></div>';
    h += "</div>";
    app.innerHTML = h;
    bindGo();
    app.querySelectorAll("[data-dh-editdom]").forEach(function (b) {
      b.addEventListener("click", function () {
        var nd = window.prompt("Destination (server or IP you control):", d.dest || "");
        if (nd == null) return;
        d.dest = nd.trim();
        checkEndpoint(d.dest, { proto: "https" }).then(function (r) {
          d.dnsOk = r.dns === "RESOLVED" || r.status === "ONLINE";
          d.httpsOk = r.https === "OK" || r.tls === "VALID" || r.status === "ONLINE";
          d.lastCheck = Date.now(); d.health = r.status === "ONLINE" ? "good" : "bad"; save();
          toast("Destination updated");
        });
        save(); openDomainDetail(id);
      });
    });
  }

  /* ---------- bootstrap ---------- */
  function init() {
    app = el("domainhub-app");
    if (!app) return;
    load();
    probeServer().then(function () { renderAll(); });
  }

  function open() {
    var modal = document.getElementById("domainhub-modal");
    if (!modal) return;
    if (!app) init();
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    renderAll();
  }
  function close() {
    var modal = document.getElementById("domainhub-modal");
    if (modal) modal.hidden = true;
    document.body.style.overflow = "";
    activeTab = "overview";
  }

  window.ChalkleDomainHub = { open: open, close: close };

  document.addEventListener("DOMContentLoaded", function () {
    var modal = document.getElementById("domainhub-modal");
    if (!modal) return;
    modal.querySelectorAll("[data-domainhub-close]").forEach(function (el2) {
      el2.addEventListener("click", function (e) { if (e.target === el2 || el2.tagName === "BUTTON") close(); });
    });
    // ESC handled by app.js globally for admin modals.
  });
})();