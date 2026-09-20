/* Chalkle search: one place that decides where the Home search box sends you.

   Before this, the web box always went to DuckDuckGo Lite and a bare domain
   was guessed at with a loose regex, so typing "steamcommunity.com" or
   "192.168.1.1:8080" could land in a search results page instead of opening.
   Here:

     * the engine is a saved choice (DuckDuckGo Lite stays the default because
       its tiny HTML page is the one that still renders when the proxy rewrites
       everything - full Google/Bing result pages come out half broken there),
     * a real URL, a bare host, a LAN address or localhost opens directly,
     * anything else becomes a search on the chosen engine.

   The Browser tool and the Home box both resolve through ChalkleSearch.target,
   so they can never disagree about what a typed string meant.

   window.ChalkleSearch: engines(), engine(), setEngine(id), target(value),
   open(value, title), looksLikeHost(value) */
(function () {
  "use strict";

  var STORE_KEY = "chalkle-search-engine";

  /* url templates use %s. `note` is the one-line explanation the Home row
     shows, because "why is it lite duckduckgo" deserves an answer. */
  var ENGINES = [
    { id: "ddg-lite", name: "DuckDuckGo Lite", host: "lite.duckduckgo.com", url: "https://lite.duckduckgo.com/lite/?q=%s", note: "Tiny results page. The one that still works through the proxy." },
    { id: "ddg", name: "DuckDuckGo", host: "duckduckgo.com", url: "https://duckduckgo.com/?q=%s", note: "Full DuckDuckGo page." },
    { id: "google", name: "Google", host: "www.google.com", url: "https://www.google.com/search?q=%s", note: "Full results page. Some parts need the proxy." },
    { id: "bing", name: "Bing", host: "www.bing.com", url: "https://www.bing.com/search?q=%s", note: "Bing results, video tab included." },
    { id: "brave", name: "Brave Search", host: "search.brave.com", url: "https://search.brave.com/search?q=%s", note: "Independent index, no tracking." },
    { id: "startpage", name: "Startpage", host: "www.startpage.com", url: "https://www.startpage.com/sp/search?query=%s", note: "Google results without the tracking." },
    { id: "yandex", name: "Yandex", host: "yandex.com", url: "https://yandex.com/search/?text=%s", note: "Strong on images and non-English pages." },
    { id: "yahoo", name: "Yahoo", host: "search.yahoo.com", url: "https://search.yahoo.com/search?p=%s", note: "The old classic." }
  ];

  function find(id) {
    for (var i = 0; i < ENGINES.length; i++) {
      if (ENGINES[i].id === id) return ENGINES[i];
    }
    return ENGINES[0];
  }

  function engine() {
    var saved = "";
    try { saved = localStorage.getItem(STORE_KEY) || ""; } catch (e) { /* no storage */ }
    return find(saved).id;
  }

  function setEngine(id) {
    var next = find(id);
    try { localStorage.setItem(STORE_KEY, next.id); } catch (e) { /* no storage */ }
    return next.id;
  }

  /* Suffixes that look like a TLD but are almost always a filename in a search
     box. The ones that are real TLDs (zip, mov, app, dev, io, sh) are left
     alone, so "notes.zip" still opens while "notes.txt" searches. */
  var FILE_SUFFIXES = {
    txt: 1, md: 1, log: 1, csv: 1, pdf: 1, doc: 1, docx: 1, xls: 1, xlsx: 1, ppt: 1, pptx: 1,
    js: 1, mjs: 1, cjs: 1, ts: 1, jsx: 1, tsx: 1, py: 1, rb: 1, go: 1, rs: 1, java: 1, c: 1,
    h: 1, cpp: 1, cs: 1, php: 1, json: 1, xml: 1, yml: 1, yaml: 1, ini: 1, bat: 1, ps1: 1,
    png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, svg: 1, ico: 1, bmp: 1, tiff: 1, heic: 1,
    mp3: 1, wav: 1, flac: 1, ogg: 1, m4a: 1, mp4: 1, mkv: 1, avi: 1, webm: 1, wmv: 1,
    exe: 1, msi: 1, dmg: 1, apk: 1, deb: 1, rpm: 1, iso: 1, torrent: 1,
    css: 1, scss: 1, html: 1, htm: 1, pyc: 1, sql: 1, db: 1, bak: 1, tmp: 1
  };

  /* Is this string an address rather than a search? Deliberately stricter than
     "contains a dot": a filename ("notes.txt") or a sentence ("where is
     madrid") must stay a search, while a port, an IPv4, an IPv6 in brackets, a
     LAN name or localhost must open. */
  function looksLikeHost(value) {
    var s = String(value || "").trim();
    if (!s || /\s/.test(s)) return false;
    var authority = s.split(/[/?#]/)[0];
    if (!authority || authority.indexOf("@") !== -1) return false;
    if (/^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(authority)) return true;
    var parts = authority.split(":");
    if (parts.length > 2) return false;
    if (parts.length === 2 && !/^\d{1,5}$/.test(parts[1])) return false;
    var host = parts[0];
    if (!host) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
    if (/^localhost$/i.test(host)) return true;
    /* A real TLD, or any non-ASCII character (an internationalized domain). */
    if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i.test(host)) {
      var tld = host.slice(host.lastIndexOf(".") + 1).toLowerCase();
      return !FILE_SUFFIXES[tld];
    }
    return /[^\x00-\x7F]/.test(host);
  }

  function searchUrl(query) {
    return find(engine()).url.replace("%s", encodeURIComponent(query));
  }

  /* Resolve one typed string into {url, kind}. kind is "url" when the string
     is an address and "search" when it is a question. */
  function target(value) {
    var s = String(value == null ? "" : value).trim();
    if (!s) return null;
    if (/^(https?|ftp):\/\//i.test(s)) {
      try { return { url: new URL(s).toString(), kind: "url" }; } catch (e) { /* fall through */ }
    } else if (s.slice(0, 2) === "//") {
      if (looksLikeHost(s.slice(2))) {
        try { return { url: new URL("https:" + s).toString(), kind: "url" }; } catch (e) { /* fall through */ }
      }
    } else if (!/^\w+:/i.test(s) && looksLikeHost(s)) {
      try { return { url: new URL("https://" + s).toString(), kind: "url" }; } catch (e) { /* fall through */ }
    }
    return { url: searchUrl(s), kind: "search" };
  }

  /* Open a resolved target through the in-app browser when it is available
     (that is where the proxy and the address bar live), and a plain tab
     otherwise. Same path the Home box always used. */
  function open(value, title) {
    var t = target(value);
    if (!t) return null;
    if (window.ChalkleBrowser && window.ChalkleBrowser.open) {
      window.ChalkleBrowser.open(t.url, title || value);
    } else {
      window.open(t.url, "_blank", "noopener");
    }
    return t;
  }

  /* ---------- Home row ---------- */

  function buildRow() {
    var select = document.getElementById("home-search-engine");
    if (!select) return;
    select.innerHTML = ENGINES.map(function (e) {
      return '<option value="' + e.id + '">' + e.name + "</option>";
    }).join("");
    select.value = engine();
    var note = document.getElementById("home-engine-note");
    function paintNote() {
      if (note) note.textContent = find(select.value).note;
    }
    select.addEventListener("change", function () {
      setEngine(select.value);
      paintNote();
    });
    paintNote();
  }

  window.ChalkleSearch = {
    engines: function () { return ENGINES.slice(); },
    engine: engine,
    setEngine: setEngine,
    current: function () { return find(engine()); },
    looksLikeHost: looksLikeHost,
    searchUrl: searchUrl,
    target: target,
    open: open
  };

  function boot() {
    /* The engine row is convenience: if it cannot build, the search box still
       resolves through the default engine. */
    try { buildRow(); } catch (e) { /* row stays empty, box still searches */ }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
