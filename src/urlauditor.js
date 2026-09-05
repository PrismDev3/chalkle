/* Chalkle URL Auditor. Built-in tool (opens in its own themed modal, no URL).
   Paste any text (links auto-extract), type one per line, or import a .txt /
   .csv of links. Every URL is checked for a REAL HTTP status through a CORS
   relay (allorigins) so you can spot dead, blocked and reachable links at a
   glance, even in bulk. Results can be filtered, copied and exported. */

(function () {
  "use strict";

  var TEXT_KEY = "chalkle-ua-text";
  /* Check each link's real HTTP status through the site's OWN server
     (/_fetch), which proxies the request server-side and returns the status
     code as JSON. Same-origin means no CORS relay, no third-party downtime,
     no "timeout on a site that works" - the old allorigins relay is kept
     only as a fallback for when the page is opened without the local server. */
  var RELAYS = [
    function (url) { return "_fetch?url=" + encodeURIComponent(url); },                  /* same-origin proxy */
    function (url) { return "https://api.allorigins.win/get?url=" + encodeURIComponent(url); } /* fallback relay */
  ];
  var CONCURRENCY = 32;    /* how many links in flight at once */
  var TIMEOUT_MS = 12000;  /* shorter so dead links don't stall the queue */
  var RENDER_EVERY_MS = 200; /* throttle result-table rebuilds while scanning */

  var state = {
    urls: [],           // normalized, deduped, in input order
    results: {},        // url -> { code, label, kind, ms }
    scanning: false,
    scanningIdx: 0,
    filter: "all"
  };

  var workers = [];
  var cancelFlag = false;

  /* ---- small DOM helpers (self-contained) ---- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function h(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  /* ---- URL extraction / normalization ---- */
  var URL_RE = /(?:https?:\/\/|www\.)[^\s<>"')\]\}\]\\]+/gi;

  function extractUrls(text) {
    var out = [];
    var m;
    URL_RE.lastIndex = 0;
    var raw = String(text || "").replace(/https?:\/\/https?:\/\//gi, "http://"); // strip accidental double proto
    while ((m = URL_RE.exec(raw)) !== null) {
      var u = m[0].replace(/[.,;:!?]+$/, "").replace(/[,]+$/, "");
      if (u.length > 4) out.push(u);
    }
    return out;
  }

  function normalize(u) {
    var s = String(u || "").trim();
    if (!s) return "";
    if (/^(?:http|https|ftp|file):\/\//i.test(s)) return s;
    if (s.indexOf("://") !== -1) return s;
    return "https://" + s;
  }

  function addUrls(list) {
    var seen = {};
    for (var i = 0; i < state.urls.length; i++) seen[state.urls[i]] = true;
    list.forEach(function (u) {
      var norm = normalize(u);
      if (norm && !seen[norm]) { seen[norm] = true; state.urls.push(norm); }
    });
    renderInput();
  }

  /* ---- rendering the input area ---- */
  function $id(id) { return document.getElementById(id); }

  function renderInput() {
    var count = $id("ua-count");
    if (count) count.textContent = state.urls.length + (state.urls.length === 1 ? " link ready to scan" : " links ready to scan") + " (paste anywhere, links are auto-picked)";
  }

  /* ---- scanning engine ---- */
  function classify(code) {
    if (code === 0) return { kind: "unreachable", label: "Timeout / Unreachable" };
    if (code >= 200 && code < 300) return { kind: "ok", label: "OK" };
    if (code >= 300 && code < 400) return { kind: "redirect", label: "Redirect" };
    if (code === 401 || code === 403 || code === 429) return { kind: "blocked", label: "Blocked" };
    if (code >= 400 && code < 500) return { kind: "dead", label: "Link broken" };
    if (code >= 500) return { kind: "error", label: "Server error" };
    return { kind: "error", label: "Unknown (" + code + ")" };
  }

  function tryRelay(url, relayIdx, start) {
    if (relayIdx >= RELAYS.length) return Promise.resolve({ code: 0, ms: Math.round(performance.now() - start) });
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    return fetch(RELAYS[relayIdx](url), { signal: ctrl.signal })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (json) {
        var code = 0;
        if (json && typeof json.code === "number") {
          /* same-origin /_fetch shape: { ok, code, error } */
          code = json.code;
        } else if (json && json.status && typeof json.status.http_code === "number") {
          /* allorigins shape */
          code = json.status.http_code;
        } else if (json && json.status && json.status.status) {
          code = -1;
        }
        if (json && json.contents && json.contents.indexOf("Error fetching") !== -1) code = 0;
        if (code === 0 && relayIdx === 0) return tryRelay(url, relayIdx + 1, start);
        return { code: code, ms: Math.round(performance.now() - start) };
      })
      .catch(function () {
        if (relayIdx === 0) return tryRelay(url, relayIdx + 1, start);
        return { code: 0, ms: Math.round(performance.now() - start) };
      })
      .finally(function () {
        clearTimeout(t);
      });
  }

  function scanOne(url) {
    var start = performance.now();
    return tryRelay(url, 0, start);
  }

  function startScan() {
    if (state.scanning) return;
    if (state.urls.length === 0) { flash("Add at least one link first."); return; }
    state.scanning = true;
    cancelFlag = false;
    state.results = {};
    state.filter = "all";
    state.urls.forEach(function (u) { state.results[u] = { code: null, label: "Checking…", kind: "checking", ms: 0 }; });
    renderStats();
    renderFilters();
    renderResults();
    showProgress(true, 0, 0, state.urls.length);

    var list = state.urls.slice();
    var next = 0;
    var doneCount = 0;
    var lastRender = 0;

    /* Rendering the table is the expensive part (hundreds of rows). While
       scanning we only rebuild it every RENDER_EVERY_MS and once at the very
       end, never on every single completion. That removes the O(n) rebuild-per-
       request that made bulk scans crawl. */
    function maybeRender(force) {
      var now = Date.now();
      if (force || now - lastRender >= RENDER_EVERY_MS) {
        lastRender = now;
        renderResults();
        showProgress(true, doneCount, doneCount, list.length);
      }
    }

    function worker() {
      return new Promise(function (resolve) {
        (function loop() {
          if (cancelFlag || next >= list.length) { resolve(); return; }
          var url = list[next++];
          state.scanningIdx = next;
          scanOne(url).then(function (res) {
            if (cancelFlag) { state.results[url] = { code: 0, label: "Cancelled", kind: "unreachable", ms: 0 }; }
            else {
              var c = classify(res.code);
              state.results[url] = { code: res.code, label: c.label, kind: c.kind, ms: res.ms };
            }
            doneCount++;
            maybeRender(false);
            loop();
          });
        })();
      });
    }

    workers = Array(Math.min(CONCURRENCY, list.length)).fill(null).map(worker);
    Promise.all(workers).then(function () {
      state.scanning = false;
      maybeRender(true);
      showProgress(false, 0, 0, 0);  /* hide the bar AFTER the final render */
      renderStats();
      renderFilters();
    });
  }

  function cancelScan() {
    cancelFlag = true;
    state.scanning = false;
    showProgress(false, 0, 0, 0);
    state.urls.forEach(function (u) {
      if (state.results[u] && state.results[u].kind === "checking")
        state.results[u] = { code: 0, label: "Cancelled", kind: "unreachable", ms: 0 };
    });
    renderStats();
    renderFilters();
    renderResults();
  }

  /* ---- stats + filters ---- */
  function stats() {
    var s = { total: state.urls.length, ok: 0, redirect: 0, blocked: 0, dead: 0, error: 0, unreachable: 0, checking: 0 };
    state.urls.forEach(function (u) {
      var r = state.results[u];
      if (!r) return;
      if (s[r.kind] !== undefined) s[r.kind]++;
    });
    return s;
  }

  var KIND_LABEL = { ok: "OK", redirect: "Redirect", blocked: "Blocked", dead: "Broken", error: "Error", unreachable: "Timeout", checking: "Checking" };

  function renderStats() {
    var box = $id("ua-stats");
    if (!box) return;
    var s = stats();
    var order = [
      ["ok", "var(--accent)", cssVar("--accent-soft", "rgba(52,168,83,0.14)")],
      ["redirect", "var(--blue)", cssVar("--blue-soft", "rgba(66,133,244,0.14)")],
      ["blocked", "var(--red)", cssVar("--red-soft", "rgba(234,67,53,0.14)")],
      ["dead", "#fbbc05", "rgba(251,188,5,0.14)"],
      ["error", "var(--red)", cssVar("--red-soft", "rgba(234,67,53,0.14)")],
      ["unreachable", "var(--text-3)", "rgba(98,104,111,0.18)"]
    ];
    box.innerHTML = "";
    var grid = el("div", "ua-stats-grid");
    box.appendChild(grid);
    order.forEach(function (o) {
      var k = o[0];
      var chip = el("div", "ua-chip");
      chip.style.setProperty("--c", o[1]);
      chip.style.setProperty("--cs", o[2]);
      chip.innerHTML = "<span class='ua-dot'></span><b>" + s[k] + "</b><i>" + (KIND_LABEL[k] || k) + "</i>";
      grid.appendChild(chip);
    });
    var total = el("div", "ua-chip ua-chip-total");
    total.innerHTML = "<b>" + s.total + "</b><i>Total</i>";
    grid.appendChild(total);
  }

  function cssVar(name, fb) {
    try { var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fb; } catch (e) { return fb; }
  }

  function renderFilters() {
    var box = $id("ua-filters");
    if (!box) return;
    box.innerHTML = "";
    var s = stats();
    var keys = [["all", "All", s.total], ["ok", "OK", s.ok], ["redirect", "Redirect", s.redirect], ["blocked", "Blocked", s.blocked], ["dead", "Broken", s.dead], ["error", "Error", s.error], ["unreachable", "Timeout", s.unreachable]];
    keys.forEach(function (k) {
      if (k[1] === "All" || true) {
        var b = el("button", "btn-ghost ua-fbtn" + (state.filter === k[0] ? " is-set" : ""), k[1] + " (" + k[2] + ")");
        b.dataset.f = k[0];
        b.addEventListener("click", function () { state.filter = k[0]; renderFilters(); renderResults(); });
        box.appendChild(b);
      }
    });
  }

  /* ---- results table ---- */
  function renderResults() {
    var box = $id("ua-results");
    if (!box) return;
    box.innerHTML = "";

    if (state.urls.length === 0) {
      box.appendChild(h("<div class='empty-hint'>Paste links above (any text works, links are pulled out automatically) or import a .txt, then hit Scan.</div>"));
      return;
    }

    var filtered = state.urls.filter(function (u) {
      var r = state.results[u];
      if (state.filter === "all") return true;
      return r && r.kind === state.filter;
    });

    if (filtered.length === 0) {
      box.appendChild(h("<div class='empty-hint'>No results in this filter.</div>"));
      return;
    }

    var table = el("table", "ua-table");
    var thead = h("<thead><tr><th class='ua-col-url'>Link</th><th class='ua-col-status'>Status</th><th class='ua-col-code'>HTTP</th><th class='ua-col-ms'>ms</th><th class='ua-col-act'></th></tr></thead>");
    table.appendChild(thead);
    var tbody = el("tbody");
    filtered.forEach(function (u) {
      var r = state.results[u] || { code: null, label: "checking", kind: "checking", ms: 0 };
      var dot = el("span", "ua-dot");
      dot.style.setProperty("--c", dotColor(r.kind));
      setDotBg(dot, r.kind);
      var urlTd = h("<td class='ua-col-url'><span class='ua-url' title='" + safeAttr(u) + "'>" + safeHtml(u) + "</span></td>");
      var statusTd = el("td", "ua-col-status");
      statusTd.appendChild(dot);
      var st = el("span", "ua-status ua-status-" + r.kind, r.label);
      statusTd.appendChild(st);
      var codeTd = el("td", "ua-col-code ua-code-" + r.kind, r.code === null || r.code === undefined ? "" : (r.code > 0 ? String(r.code) : ""));
      var msTd = el("td", "ua-col-ms", r.ms ? r.ms + "ms" : "");
      var actTd = el("td", "ua-col-act");
      var copyBtn = el("button", "ua-mini", "Copy");
      copyBtn.addEventListener("click", function (ev) { ev.stopPropagation(); copyText(u); });
      var openBtn = el("button", "ua-mini", "Open");
      openBtn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (window.ChalkleLaunch && window.ChalkleLaunch.openDirect) window.ChalkleLaunch.openDirect(u);
        else window.open(u, "_blank", "noopener");
      });
      actTd.appendChild(copyBtn);
      actTd.appendChild(openBtn);
      var tr = el("tr");
      tr.appendChild(urlTd);
      tr.appendChild(statusTd);
      tr.appendChild(codeTd);
      tr.appendChild(msTd);
      tr.appendChild(actTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);
  }

  function dotColor(kind) {
    switch (kind) {
      case "ok": return "var(--accent)";
      case "redirect": return "var(--blue)";
      case "blocked": case "error": return "var(--red)";
      case "dead": return "#fbbc05";
      case "checking": return "var(--text-3)";
      default: return "var(--text-3)";
    }
  }
  function setDotBg(dot, kind) {
    switch (kind) {
      case "ok": dot.style.setProperty("--cs", "rgba(52,168,83,0.2)"); break;
      case "redirect": dot.style.setProperty("--cs", "rgba(66,133,244,0.2)"); break;
      case "blocked": case "error": dot.style.setProperty("--cs", "rgba(234,67,53,0.2)"); break;
      case "dead": dot.style.setProperty("--cs", "rgba(251,188,5,0.2)"); break;
      default: dot.style.setProperty("--cs", "rgba(98,104,111,0.25)");
    }
  }

  function safeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function safeAttr(s) { return safeHtml(s).replace(/"/g, "&quot;"); }

  function copyText(t) {
    try {
      navigator.clipboard.writeText(t);
      flash("Copied " + t);
    } catch (e) {
      var ta = document.createElement("textarea");
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e2) {}
      document.body.removeChild(ta);
      flash("Copied");
    }
  }

  /* copy all results as text */
  function copyResults() {
    var s = state.urls.map(function (u) {
      var r = state.results[u];
      if (!r) return u + "\t?\t";
      return u + "\t" + (r.code > 0 ? r.code : "") + "\t" + r.label;
    }).join("\n");
    copyText(s || "No results");
  }

  function downloadResults() {
    var head = "url\thttp_code\tstatus\n";
    var rows = state.urls.map(function (u) {
      var r = state.results[u] || {};
      return u + "\t" + (r.code > 0 ? r.code : "") + "\t" + (r.label || "");
    });
    var blob = new Blob([head + rows.join("\n")], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "chalkle-url-audit.txt";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  /* ---- progress bar ---- */
  function showProgress(on, done, checked, total) {
    var wrap = $id("ua-progress");
    if (!wrap) return;
    if (!on) { wrap.hidden = true; return; }
    wrap.hidden = false;
    var pct = total ? Math.min(100, Math.round((checked / total) * 100)) : 0;
    var bar = $id("ua-bar");
    if (bar) bar.style.width = pct + "%";
    var label = $id("ua-progress-label");
    if (label) label.textContent = "Checked " + checked + " of " + total + " links (" + pct + "%)…";
  }

  /* ---- toast ---- */
  var toastTimer = null;
  function flash(msg) {
    var t = $id("ua-toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }

  /* ---- state persistence ---- */
  function saveInput() {
    try { localStorage.setItem(TEXT_KEY, $id("ua-paste").value); } catch (e) {}
    var urls = ($id("ua-single").value.trim()) ? extractUrls($id("ua-single").value) : [];
    // single + textarea both feed the list on next open; we persist textarea only
  }
  function loadInput() {
    try { var v = localStorage.getItem(TEXT_KEY) || ""; $id("ua-paste").value = v; addUrls(extractUrls(v)); } catch (e) {}
  }

  /* ---- modal open/close ---- */
  function open() {
    var modal = $id("urlauditor-modal");
    if (!modal) return;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    try { var saved = localStorage.getItem(TEXT_KEY) || ""; $id("ua-paste").value = saved; } catch (e) {}
    if (cancelFlag) cancelFlag = false;
    if (state.urls.length === 0) addUrls(extractUrls($id("ua-paste").value || ""));
    renderInput();
    renderStats();
    renderFilters();
    renderResults();
    setTimeout(function () { var s = $id("ua-single"); if (s) s.focus(); }, 40);
  }

  function close() {
    var modal = $id("urlauditor-modal");
    if (modal) modal.hidden = true;
    document.body.style.overflow = "";
    if (state.scanning) cancelScan();
    try { localStorage.setItem(TEXT_KEY, $id("ua-paste").value || ""); } catch (e) {}
  }

  window.ChalkleUrlAuditor = { open: open, close: close, addUrls: addUrls };

  /* ---- wiring ---- */
  document.addEventListener("DOMContentLoaded", function () {
    var modal = $id("urlauditor-modal");
    if (!modal) return;

    modal.querySelectorAll("[data-ua-close]").forEach(function (c) {
      c.addEventListener("click", function (e) { if (e.target === c || e.target.tagName === "BUTTON") close(); });
    });

    var paste = $id("ua-paste");
    if (paste) {
      paste.addEventListener("input", function () {
        addUrls(extractUrls(paste.value));
        try { localStorage.setItem(TEXT_KEY, paste.value); } catch (e) {}
      });
    }

    var single = $id("ua-single");
    var addBtn = $id("ua-add");
    function addSingle() {
      if (single && single.value.trim()) {
        var raw = extractUrls(single.value);
        if (raw.length === 0) { flash("That doesn't look like a URL"); return; }
        addUrls(raw);
        single.value = "";
        if (paste) paste.value = state.urls.join("\n");
        try { localStorage.setItem(TEXT_KEY, paste ? paste.value : ""); } catch (e) {}
        renderInput();
      }
    }
    if (addBtn) addBtn.addEventListener("click", addSingle);
    if (single) single.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addSingle(); } });

    var fileInput = $id("ua-file");
    var fileLabel = $id("ua-file-label");
    function readFile(f) {
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || "");
        addUrls(extractUrls(text));
        if (paste) paste.value = state.urls.join("\n");
        try { localStorage.setItem(TEXT_KEY, paste ? paste.value : ""); } catch (e) {}
        renderInput();
        flash("Imported " + state.urls.length + " links");
      };
      reader.readAsText(f);
    }
    if (fileInput) fileInput.addEventListener("change", function () { readFile(fileInput.files && fileInput.files[0]); fileInput.value = ""; });

    var clearBtn = $id("ua-clear");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      state.urls = [];
      state.results = {};
      if (paste) paste.value = "";
      if (single) single.value = "";
      try { localStorage.setItem(TEXT_KEY, ""); } catch (e) {}
      renderInput(); renderStats(); renderFilters(); renderResults();
    });

    var scanBtn = $id("ua-scan");
    if (scanBtn) scanBtn.addEventListener("click", startScan);

    var cancelBtn = $id("ua-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", cancelScan);

    var copyAllBtn = $id("ua-copy-all");
    if (copyAllBtn) copyAllBtn.addEventListener("click", copyResults);

    var dlBtn = $id("ua-download");
    if (dlBtn) dlBtn.addEventListener("click", downloadResults);
  });
})();