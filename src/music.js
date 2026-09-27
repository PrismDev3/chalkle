/* Chalkle Music: a streaming-style discovery surface backed by the existing
   relay. The presentation is intentionally Chalkle, not a copy of another
   product: dark panels, pink/red accents, compact cards, and a persistent
   player around the existing search and playback APIs. */
(function () {
  "use strict";

  var PREFS_KEY = "chalkle-music-prefs-v1";
  var RECENT_KEY = "chalkle-music-recent-v1";
  var LIBRARY_KEY = "chalkle-music-library-v1";
  var CATALOG_KEY = "chalkle-music-catalog-v1";   /* last good home catalog */
  var CHART_QUERIES = ["drake", "taylor swift", "the weeknd", "kendrick lamar", "bad bunny", "billie eilish", "kanye west", "ariana grande"];

  var state = {
    page: "home",
    catalog: [],
    /* Files kept on this device (src/locallib.js). They are held apart from
       the relay catalogue because the catalogue is replaced wholesale on every
       chart refresh, and merged in by allTracks() instead. */
    local: [],
    queue: [],
    idx: -1,
    playing: false,
    shuffle: false,
    repeat: "off",
    vol: 80,
    muted: false,
    speed: 1,
    pitch: 0,
    dragging: false,
    ly: [],
    library: readArray(LIBRARY_KEY),
    recent: readArray(RECENT_KEY)
  };

  var cov = {};
  var covPending = {};
  var metaIndex = {};
  var els = {};
  var audio = null;
  var artObs = null;
  var toastTimer = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmt(s) {
    if (!isFinite(s) || s < 0) return "0:00";
    s = Math.floor(s);
    return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
  }
  function readArray(key) {
    try {
      var value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value : [];
    } catch (e) { return []; }
  }
  function saveArray(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }
  function api(params) {
    var p = Object.assign({ server: "youtube" }, params);
    var q = Object.keys(p).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(p[k]); }).join("&");
    var path = "/music/api?" + q;
    return window.ChalkleApi ? window.ChalkleApi.url(path) : path;
  }
  function getJSON(url, signal) {
    return fetch(url, { cache: "no-store", signal: signal }).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    });
  }
  /* Per-track stream loads: only the newest load may act, and any request that
     outlives the timeout is dropped so one dead track can't wedge the queue. */
  var loadSeq = 0;
  var loadCtrl = null;
  var LOAD_TIMEOUT_MS = 20000;
  function toast(msg) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, 2400);
  }
  function readPrefs() {
    try {
      var d = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      if (typeof d.vol === "number") state.vol = d.vol;
      if ("muted" in d) state.muted = !!d.muted;
      if (typeof d.speed === "number") state.speed = d.speed;
      if (typeof d.pitch === "number") state.pitch = d.pitch;
    } catch (e) { /* defaults */ }
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ vol: state.vol, muted: state.muted, speed: state.speed, pitch: state.pitch })); } catch (e) { /* no storage */ }
  }
  function artistName(meta) { return (meta && meta.artist && meta.artist.length) ? meta.artist.join(" · ") : ((meta && meta.album) || "Unknown artist"); }
  /* Piped repeats feature tags in some titles ("... ft. Daft Punk (Official
     Video) ft. Daft Punk"). Drop later duplicates and tidy stray spaces. */
  function cleanName(name) {
    var str = String(name || "");
    var seen = {};
    str = str.replace(/\b(?:ft|feat)\.\s+[A-Za-z0-9&'.-]+/gi, function (m) {
      var key = m.toLowerCase().replace(/\s+/g, " ");
      if (seen[key]) return "";
      seen[key] = true;
      return m;
    });
    return str.replace(/\s{2,}/g, " ").replace(/\s+\)/g, ")").replace(/\s+$/g, "").replace(/^\s+/g, "");
  }
  /* Search results carry no real album; Piped reuses the channel name, so the
     album column would just repeat the artist. Show "Single" instead. */
  function albumLabel(meta) {
    var album = String(meta && meta.album || "").trim();
    if (!album || album.toLowerCase() === artistName(meta).toLowerCase()) return "Single";
    return album;
  }
  function trackCountLabel(n) {
    n = Number(n) || 0;
    return n + (n === 1 ? " track" : " tracks");
  }
  function firstArtist(meta) { return meta && meta.artist && meta.artist.length ? String(meta.artist[0]) : "Unknown artist"; }
  function trackId(meta) { return String(meta && (meta.id || meta.url_id || meta.name) || ""); }
  function isSaved(meta) { return state.library.indexOf(trackId(meta)) !== -1; }
  function cloneMeta(meta, list, prefix) {
    var copy = Object.assign({}, meta);
    copy.artist = Array.isArray(meta.artist) ? meta.artist.slice() : [];
    copy._list = list;
    copy._key = prefix + "-" + trackId(meta);
    metaIndex[copy._key] = copy;
    return copy;
  }
  function uniqueTracks(items) {
    var seen = {};
    return (items || []).filter(function (item) {
      var id = trackId(item);
      if (!id || seen[id]) return false;
      seen[id] = true;
      return true;
    });
  }
  function sortPopular(items) {
    return uniqueTracks(items).sort(function (a, b) { return (Number(b.views) || 0) - (Number(a.views) || 0); });
  }

  function directCoverUrl(meta, size) {
    if (!meta || !meta.pic_id || String(meta.source || "").toLowerCase() !== "youtube") return "";
    return "https://i.ytimg.com/vi/" + encodeURIComponent(String(meta.pic_id)) + "/" + (size || "mqdefault") + ".jpg";
  }
  function relayCoverUrl(meta, size) {
    if (!meta || !meta.pic_id || String(meta.source || "").toLowerCase() !== "youtube") return "";
    var raw = "https://i.ytimg.com/vi/" + String(meta.pic_id) + "/" + (size || "mqdefault") + ".jpg";
    try {
      var token = btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      var path = "/yt/thumb?u=" + token;
      return window.ChalkleApi ? window.ChalkleApi.url(path) : path;
    } catch (e) { return ""; }
  }
  function coverUrl(meta) {
    if (!meta) return Promise.resolve("");
    /* Art that came out of the file itself (a local track) or was attached by
       the caller needs no cover lookup at all. */
    if (meta._cover) return Promise.resolve(meta._cover);
    if (!meta.pic_id) return Promise.resolve("");
    if (cov[meta.pic_id]) { meta._cover = cov[meta.pic_id]; return Promise.resolve(meta._cover); }
    /* YouTube's thumbnail is already a public JPEG keyed by the video id.
       Use it immediately; the relay remains the fallback for filtered networks
       and for providers that do not expose a predictable image URL. */
    var direct = directCoverUrl(meta, "mqdefault");
    if (direct) { cov[meta.pic_id] = direct; meta._cover = direct; return Promise.resolve(direct); }
    var pending = covPending[meta.pic_id];
    if (pending) return pending;
    var request = getJSON(api({ path: "pic", id: meta.pic_id, size: 480 })).then(function (d) {
      var url = d && d.url || "";
      cov[meta.pic_id] = url;
      meta._cover = url;
      delete covPending[meta.pic_id];
      return url;
    }).catch(function () { delete covPending[meta.pic_id]; return ""; });
    covPending[meta.pic_id] = request;
    return request;
  }
  function artHtml(meta, cls) {
    var letter = esc((meta && (meta.name || meta.album || meta.artist && meta.artist[0]) || "?").charAt(0).toUpperCase());
    /* Embedded cover art (local files) beats the relay's picture lookup. */
    if (meta && meta._cover) {
      return '<span class="' + cls + '"><img src="' + esc(meta._cover) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()"><span class="thumb-letter">' + letter + "</span></span>";
    }
    var direct = directCoverUrl(meta, "mqdefault");
    var relay = relayCoverUrl(meta, "mqdefault");
    if (direct) {
      return '<span class="' + cls + '"><img src="' + esc(direct) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"' + (relay ? ' data-cover-relay="' + esc(relay) + '" onerror="if(this.dataset.coverRelay){this.src=this.dataset.coverRelay;this.removeAttribute(\'data-cover-relay\');}else{this.remove();}"' : ' onerror="this.remove()"') + '><span class="thumb-letter">' + letter + "</span></span>";
    }
    return '<span class="' + cls + '" data-pic="' + esc(meta && meta.pic_id || "") + '"><span class="thumb-letter">' + letter + "</span></span>";
  }
  function hydrateArts(scope) {
    (scope || document).querySelectorAll("[data-pic]").forEach(function (el) {
      var id = el.getAttribute("data-pic");
      if (!id || !cov[id]) return;
      el.innerHTML = '<img src="' + esc(cov[id]) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">';
      el.removeAttribute("data-pic");
    });
  }
  function metaByPic(id) {
    var match = (state.catalog || []).find(function (m) { return String(m.pic_id || "") === String(id || ""); });
    if (match) return match;
    var keys = Object.keys(metaIndex);
    for (var i = 0; i < keys.length; i++) {
      if (String(metaIndex[keys[i]].pic_id || "") === String(id || "")) return metaIndex[keys[i]];
    }
    return null;
  }
  function watchArts(scope) {
    if (!scope) return;
    hydrateArts(scope);
    if (!("IntersectionObserver" in window)) {
      scope.querySelectorAll("[data-pic]").forEach(function (el) {
        var id = el.getAttribute("data-pic");
        var meta = metaByPic(id);
        if (meta) coverUrl(meta).then(function () { hydrateArts(scope); });
      });
      return;
    }
    if (artObs) artObs.disconnect();
    artObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var node = entry.target;
        var id = node.getAttribute("data-pic");
        var meta = metaByPic(id);
        if (meta) coverUrl(meta).then(function () { hydrateArts(scope); });
        artObs.unobserve(node);
      });
    }, { rootMargin: "320px" });
    scope.querySelectorAll("[data-pic]").forEach(function (el) { artObs.observe(el); });
  }

  function saveButton(meta) {
    /* SVG heart (Lucide-style line icon) instead of text glyphs, so the
       control matches the rest of the icon system stroke for stroke. */
    var on = isSaved(meta);
    return '<button class="music-save ' + (on ? "is-saved" : "") + '" data-msave="' + esc(trackId(meta)) + '" aria-label="' + (on ? "Remove from library" : "Add to library") + '" title="' + (on ? "Remove from library" : "Add to library") + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></button>';
  }
  function heartSvg(on) {
    /* Filled heart marks the saved state; stroke heart marks unsaved. */
    return '<svg viewBox="0 0 24 24" aria-hidden="true"' + (on ? ' class="is-filled"' : '') + '><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
  }
  function playIcon() {
    return '<span class="music-play-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>' +
      '</svg></span>';
  }
  function trackCard(meta, list, prefix) {
    var item = cloneMeta(meta, list, prefix);
    return '<article class="music-card" data-mplay="' + esc(item._key) + '" tabindex="0" role="button" aria-label="Play ' + esc(cleanName(item.name) || "Untitled") + '">' +
      '<span class="music-card-art">' + artHtml(item, "music-art") + '<span class="music-play-overlay" aria-hidden="true">' + playIcon() + '</span></span>' +
      '<span class="music-card-copy"><span class="music-card-title">' + esc(cleanName(item.name) || "Untitled") + '</span><span class="music-card-sub">' + esc(artistName(item)) + '</span></span>' +
      saveButton(item) + '</article>';
  }
  function albumCard(album, artist, meta, tracks) {
    var key = "album:" + album + "|" + artist;
    return '<button class="music-cover-card" data-mcollection="album" data-mcollection-key="' + esc(key) + '">' +
      '<span class="music-cover-art">' + artHtml(meta, "music-art") + '<span class="music-play-overlay" aria-hidden="true">' + playIcon() + '</span></span>' +
      '<span class="music-cover-title">' + esc(album || "Unknown album") + '</span>' +
      '<span class="music-cover-sub">' + esc(artist || "Unknown artist") + " · " + trackCountLabel(tracks.length) + "</span></button>";
  }
  function artistCard(name, meta) {
    return '<button class="music-artist-card" data-mcollection="artist" data-mcollection-key="' + esc(name) + '">' +
      '<span class="music-artist-art">' + artHtml(meta, "music-art") + '<span class="music-play-overlay" aria-hidden="true">' + playIcon() + '</span></span><span class="music-artist-name">' + esc(name) + '</span><span class="music-cover-sub">Artist</span></button>';
  }
  function section(title, note, body, extra) {
    return '<section class="music-section ' + (extra || "") + '"><div class="music-section-head"><div><h2>' + esc(title) + '</h2>' + (note ? '<span>' + esc(note) + '</span>' : '') + '</div><button class="music-show-all" type="button" data-music-show="' + esc(title) + '">Show all</button></div>' + body + '</section>';
  }
  function rowHtml(meta, i, list, prefix) {
    var item = cloneMeta(meta, list, prefix);
    return '<div class="music-track-row" data-mplay="' + esc(item._key) + '" tabindex="0" role="button" aria-label="Play ' + esc(cleanName(item.name) || "Untitled") + '">' +
      '<span class="music-track-num" aria-hidden="true">' + (i + 1) + '</span>' +
      '<span class="music-track-art">' + artHtml(item, "music-art") + '</span>' +
      '<span class="music-track-main"><span class="music-track-name">' + esc(cleanName(item.name) || "Untitled") + '</span><span class="music-track-artist">' + esc(artistName(item)) + '</span></span>' +
      '<span class="music-track-album">' + esc(albumLabel(item)) + '</span>' +
      '<span class="music-track-views">' + (Number(item.views) ? esc(formatViews(item.views)) : "") + '</span>' + saveButton(item) +
      '</div>';
  }
  function formatViews(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + "M plays";
    if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "K plays";
    return n + " plays";
  }

  /* ---- Your own files ---------------------------------------------------
     Everything else in this tab is streamed from the relay, so the tab is dead
     the moment the relay is blocked. Audio you import is read for its tags
     (src/locallib.js) and kept in IndexedDB, then dressed as an ordinary
     catalogue entry, which means the queue, album grouping, search, save
     button and player all handle a local song without knowing it is local. */
  var LOCAL = window.ChalkleLocalMusic || null;

  function allTracks() { return state.local.concat(state.catalog); }

  function localTracks() {
    if (!LOCAL) return Promise.resolve([]);
    return LOCAL.ready().then(function () {
      state.local = LOCAL.tracks();
      return state.local;
    }).catch(function () {
      state.local = [];
      return [];
    });
  }
  function localAlbums() { return LOCAL ? LOCAL.albums() : []; }
  function localCount() { return LOCAL ? LOCAL.count() : 0; }

  function refreshMusic() {
    if (state.page === "home") renderHomeFromCatalog();
    else if (state.page === "library") renderLibrary();
    else if (state.page === "search" && els.q.value.trim()) showSearch(els.q.value.trim());
  }

  function importFiles(files) {
    if (!LOCAL) { toast("This build has no local music support."); return; }
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    toast("Reading " + list.length + (list.length === 1 ? " file…" : " files…"));
    LOCAL.add(list, function (done, total) {
      if (total > 4 && done > 0 && done < total) toast("Reading file " + done + " of " + total + "…");
    }).then(function (res) {
      return localTracks().then(function () { return res; });
    }).then(function (res) {
      var parts = [];
      if (res.added.length) parts.push(res.added.length + (res.added.length === 1 ? " track added" : " tracks added"));
      if (res.skipped) parts.push(res.skipped + " already here");
      if (res.failed) parts.push(res.failed + " could not be read");
      toast(parts.join(" · ") || "Nothing to import");
      refreshMusic();
    }).catch(function () { toast("Could not read those files."); });
  }

  /* The drop target is the whole panel, so a dropped folder-full of music works
     from anywhere in the section rather than only on a small dashed box. */
  function bindLocal(scope) {
    if (!scope) return;
    var pick = scope.querySelector("#music-local-pick");
    var input = scope.querySelector("#music-local-input");
    if (pick && input) pick.addEventListener("click", function () { input.click(); });
    if (input) input.addEventListener("change", function () { importFiles(input.files); input.value = ""; });
    var wipe = scope.querySelector("#music-local-clear");
    if (wipe) wipe.addEventListener("click", function () {
      if (!LOCAL) return;
      LOCAL.clear().then(function () { return localTracks(); }).then(function () {
        toast("Local music removed from this device");
        refreshMusic();
      });
    });
    var drop = scope.querySelector("#music-local-drop");
    if (!drop || drop._dropBound) return;
    drop._dropBound = true;
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("is-drop"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("is-drop"); });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.classList.remove("is-drop");
      var dt = e.dataTransfer;
      if (!dt) return;
      if (dt.files && dt.files.length) { importFiles(dt.files); return; }
      /* Dragging a folder gives items, not files; ask the items for their
         entries and walk them one level so a dropped album folder works. */
      var items = dt.items;
      if (!items || !items.length || typeof items[0].webkitGetAsEntry !== "function") return;
      var found = [];
      var walk = function (entry, depth) {
        if (!entry) return Promise.resolve();
        if (entry.isFile) {
          return new Promise(function (res) { entry.file(function (f) { found.push(f); res(); }, function () { res(); }); });
        }
        if (entry.isDirectory && depth < 3) {
          var reader = entry.createReader();
          var all = [];
          var readBatch = function () {
            return new Promise(function (res) {
              reader.readEntries(function (batch) {
                if (!batch.length) { res(all); return; }
                all = all.concat(Array.prototype.slice.call(batch));
                res(readBatch());
              }, function () { res(all); });
            });
          };
          return readBatch().then(function (entries) {
            return Promise.all(entries.map(function (child) { return walk(child, depth + 1); }));
          });
        }
        return Promise.resolve();
      };
      Promise.all(Array.prototype.map.call(items, function (it) { return walk(it.webkitGetAsEntry(), 0); }))
        .then(function () { importFiles(found); });
    });
  }

  function localSection() {
    var n = localCount();
    if (!LOCAL) return "";
    if (!n) {
      return '<div class="music-local" id="music-local-drop">' +
        '<div class="music-local-copy"><span class="music-eyebrow">On this device</span>' +
        '<h2>Play your own music</h2>' +
        '<p>Drop audio files (or a folder) here and they become a real library: tags and cover art are read from the files, albums are grouped for you, and playback needs no relay at all.</p>' +
        '<p class="music-local-note">Files never leave this device.</p></div>' +
        '<div class="music-local-actions"><button class="music-primary-btn" id="music-local-pick" type="button">Choose files</button></div>' +
        '<input id="music-local-input" type="file" accept="audio/*,.mp3,.m4a,.m4a,.flac,.ogg,.oga,.opus,.wav" multiple hidden>' +
        '</div>';
    }
    var albums = localAlbums();
    return section("On this device", trackCountLabel(n) + " kept on this machine",
      '<div class="music-local" id="music-local-drop">' +
      '<div class="music-cover-row">' + albums.slice(0, 12).map(function (a) {
        return albumCard(a.album, a.artist, a.tracks[0], a.tracks);
      }).join("") + '</div>' +
      '<div class="music-local-actions"><button class="music-primary-btn" id="music-local-pick" type="button">Add files</button>' +
      '<button class="music-secondary-btn" id="music-local-clear" type="button">Remove all</button></div>' +
      '<input id="music-local-input" type="file" accept="audio/*,.mp3,.m4a,.flac,.ogg,.oga,.opus,.wav" multiple hidden>' +
      '</div>', "music-section-local");
  }

  function setPage(page) {
    state.page = page;
    if (els.home) els.home.hidden = page !== "home";
    if (els.results) els.results.hidden = page !== "search" && page !== "library";
    if (els.profile) els.profile.hidden = page !== "profile";
    if (els.empty) els.empty.hidden = true;
    document.querySelectorAll("[data-music-page]").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.getAttribute("data-music-page") === page);
    });
  }
  function greeting() {
    var h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  }
  function groupAlbums(items) {
    var groups = {};
    items.forEach(function (m) {
      var album = String(m.album || "Single");
      var artist = firstArtist(m);
      var key = album + "|" + artist;
      if (!groups[key]) groups[key] = { album: album, artist: artist, meta: m, tracks: [] };
      groups[key].tracks.push(m);
    });
    return Object.keys(groups).map(function (k) { return groups[k]; });
  }
  function groupArtists(items) {
    var groups = {};
    items.forEach(function (m) {
      (m.artist && m.artist.length ? m.artist : ["Unknown artist"]).forEach(function (name) {
        if (!groups[name]) groups[name] = { name: name, meta: m, tracks: [] };
        groups[name].tracks.push(m);
      });
    });
    return Object.keys(groups).map(function (k) { return groups[k]; });
  }
  function recentTracks() {
    var all = allTracks();
    var found = [];
    state.recent.forEach(function (id) {
      var hit = all.find(function (m) { return trackId(m) === String(id); });
      if (hit) found.push(hit);
    });
    return found;
  }
  function registerTracks(list, prefix) {
    return (list || []).map(function (m) { return cloneMeta(m, list, prefix); });
  }

  /* One chart refresh: 8 parallel relay searches merged into the catalog.
     Resolves after repainting; rejects when everything came back empty
     (upstream outage) so callers can fall back or retry. */
  function fetchCharts() {
    return Promise.all(CHART_QUERIES.map(function (q) { return getJSON(api({ path: "search", q: q, limit: 10 })).catch(function () { return { items: [] }; }); }))
      .then(function (replies) {
        var all = [];
        replies.forEach(function (reply) { all = all.concat(reply && reply.items || []); });
        var merged = sortPopular(all);
        if (!merged.length) throw new Error("empty");
        state.catalog = merged;
        try { localStorage.setItem(CATALOG_KEY, JSON.stringify(state.catalog.slice(0, 120))); } catch (e) { /* private mode */ }
        renderHomeFromCatalog();
      });
  }

  function renderHome() {
    setPage("home");
    if (!state.catalog.length) {
      /* Stale-while-revalidate: painting the last good catalog from
         localStorage takes 0ms, so the tab opens instantly, then this
         background refresh swaps in fresh data when it lands (silently -
         a slightly stale grid beats a 4-second spinner on every visit). */
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(CATALOG_KEY) || "null"); } catch (e) { saved = null; }
      if (Array.isArray(saved) && saved.length) {
        state.catalog = sortPopular(saved);
        renderHomeFromCatalog();
        fetchCharts().catch(function () { /* keep the stale catalog */ });
        return;
      }
      els.home.innerHTML = '<div class="music-loading"><span class="music-loading-dot"></span> Loading music for you…</div>';
      /* Two silent retries before the off-line banner: every Piped instance
         can blip at once for a few seconds; a 1.5s/4s backoff usually rides
         it out so users never see an error that would have fixed itself. */
      var tries = 0;
      var loadCharts = function () {
        fetchCharts()
          .catch(function () {
            /* The relay itself serves stale caches during upstream outages;
               if we still got nothing, fall back to the last good catalog on
               this device before showing the off-line banner. */
            if (!state.catalog.length) {
              try {
                var cached = JSON.parse(localStorage.getItem(CATALOG_KEY) || "[]");
                if (Array.isArray(cached) && cached.length) { state.catalog = cached; renderHomeFromCatalog(); return; }
              } catch (e) { /* fall through */ }
            }
            if (++tries < 3) { setTimeout(loadCharts, tries === 1 ? 1500 : 4000); return; }
            showEmpty("Music is off-line", "The music source isn't answering right now. Try again in a minute.");
          });
      };
      loadCharts();
      return;
    }
    renderHomeFromCatalog();
  }
  function renderHomeFromCatalog() {
    metaIndex = {};
    var all = state.catalog;
    var hot = all.slice(0, 18);
    var hero = hot[0];
    var recent = recentTracks();
    var recentDisplay = recent.length ? recent.slice(0, 8) : hot.slice(1, 9);
    var albums = groupAlbums(all).slice(0, 10);
    var artists = groupArtists(all).slice(0, 10);
    var made = hot.slice(8, 16);
    var recentTitle = recent.length ? "Recently played" : "Start listening";
    var heroItem = cloneMeta(hero, hot, "hero");
    var heroSaved = isSaved(heroItem);
    /* Cinematic hero: the artwork sits in a soft spotlight, derived from the
       page accent, instead of a boxed card with a colored strip beneath. */
    var heroHtml =
      '<section class="music-hero">' +
        '<div class="music-hero-art">' + artHtml(heroItem, "music-art") + '<span class="music-hero-glow" aria-hidden="true"></span></div>' +
        '<div class="music-hero-copy">' +
          '<span class="music-eyebrow">Featured single</span>' +
          '<h2 class="music-hero-title">' + esc(cleanName(hero.name) || "Untitled") + '</h2>' +
          '<p class="music-hero-artist">' + esc(artistName(hero)) + '</p>' +
          '<p class="music-hero-album">' + esc(albumLabel(hero)) + '</p>' +
          '<div class="music-hero-actions">' +
            '<button class="music-primary-btn" data-mplay="' + esc(heroItem._key) + '"><svg viewBox="0 0 24 24" aria-hidden="true" class="is-fill"><path d="M8 5v14l11-7z"/></svg><span>Play</span></button>' +
            '<button class="music-icon-btn music-hero-save' + (heroSaved ? " is-saved" : "") + '" data-msave="' + esc(trackId(heroItem)) + '" aria-label="' + (heroSaved ? "Remove from library" : "Add to library") + '">' + heartSvg(heroSaved) + '</button>' +
          '</div>' +
        '</div>' +
      '</section>';
    var quickBits = '';
    if (recent.length) quickBits += '<a class="music-quick" href="#" data-music-page-link="home" data-quick="recent"><span class="music-quick-art music-quick-art-a"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg></span><span class="music-quick-name">Recently played</span></a>';
    if (state.library.length) quickBits += '<a class="music-quick" href="#" data-music-page-link="library" data-quick="liked"><span class="music-quick-art music-quick-art-b"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></span><span class="music-quick-name">Liked songs</span></a>';
    quickBits += '<a class="music-quick" href="#" data-music-page-link="search" data-quick="discover"><span class="music-quick-art music-quick-art-c"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><line x1="16" y1="16" x2="20.5" y2="20.5"/></svg></span><span class="music-quick-name">Discover</span></a>';
    var html = '<div class="music-home-shell">' +
      '<div class="music-home-intro"><div><span class="music-eyebrow">Chalkle Music</span><h1>' + greeting() + '</h1><p>Find something to play, then keep browsing without losing your place.</p></div><span class="music-source-note">Live catalog · relay powered</span></div>' +
      localSection() +
      heroHtml +
      (quickBits ? section("Quick access", "", '<div class="music-quick-grid">' + quickBits + '</div>', "music-section-quick") : "") +
      section(recentTitle, recent.length ? "Pick up where you left off" : "Popular picks to get you started", '<div class="music-card-row">' + recentDisplay.map(function (m, i) { return trackCard(m, recentDisplay, "recent" + i); }).join("") + '</div>', "music-section-cards") +
      section("Made for you", "Based on what is popular right now", '<div class="music-card-row">' + made.map(function (m, i) { return trackCard(m, made, "made" + i); }).join("") + '</div>', "music-section-cards") +
      section("Popular albums", "Albums and collections", '<div class="music-cover-row">' + albums.map(function (a) { return albumCard(a.album, a.artist, a.meta, a.tracks); }).join("") + '</div>', "music-section-covers") +
      section("Popular artists", "Artists appearing across the catalog", '<div class="music-artist-row">' + artists.map(function (a) { return artistCard(a.name, a.meta); }).join("") + '</div>', "music-section-artists") +
      section("Popular tracks", "A compact list of what is getting played", '<div class="music-track-list">' + hot.map(function (m, i) { return rowHtml(m, i, hot, "popular"); }).join("") + '</div>', "music-section-tracks") +
      '</div>';
    els.home.innerHTML = html;
    els.home.querySelectorAll("[data-music-page-link]").forEach(function (node) {
      node.addEventListener("click", function (e) { e.preventDefault(); var page = node.getAttribute("data-music-page-link"); if (page === "library") renderLibrary(); else if (page === "search") { setPage("search"); els.q.focus(); } else renderHome(); });
    });
    bindInteractive(els.home);
    bindLocal(els.home);
    watchArts(els.home);
  }

  function showEmpty(title, hint) {
    setPage("empty");
    els.empty.querySelector(".empty-title").textContent = title;
    els.emptyHint.textContent = hint || "";
    els.empty.hidden = false;
  }

  function showSearch(q) {
    q = String(q || "").trim();
    if (!q) { renderHome(); return; }
    setPage("search");
    els.results.innerHTML = '<div class="music-loading"><span class="music-loading-dot"></span> Searching for “' + esc(q) + '”…</div>';
    /* Music on this device is matched locally and shown first: it always works,
       and it is the half of the library the relay cannot see. */
    var needle = q.toLowerCase();
    var mine = state.local.filter(function (m) {
      return String(m.name || "").toLowerCase().indexOf(needle) !== -1 ||
        String(m.album || "").toLowerCase().indexOf(needle) !== -1 ||
        String((m.artist || []).join(" ")).toLowerCase().indexOf(needle) !== -1;
    });
    var localBit = function () {
      return mine.length ? section("On this device", "", '<div class="music-track-list">' + mine.map(function (m, i) { return rowHtml(m, i, mine, "localsearch"); }).join("") + '</div>', "music-section-tracks") : "";
    };
    var relayBit = function () {
      getJSON(api({ path: "search", q: q, limit: 40 })).then(function (reply) {
        var tracks = sortPopular(reply && reply.items || []);
        if (!tracks.length) {
          if (mine.length) { paintSearch(q, tracks, localBit()); return; }
          showEmpty("Nothing found", "Try a shorter title, an artist name, or a different spelling.");
          return;
        }
        paintSearch(q, tracks, localBit());
      }).catch(function () {
        /* The relay is the thing most likely to be blocked; your own files are
           not, so keep showing them instead of an empty-state screen. */
        if (mine.length) { paintSearch(q, [], localBit()); return; }
        showEmpty("Search failed", "The music server did not answer. Try again in a moment.");
      });
    };
    function paintSearch(query, tracks, localHtml) {
      var artistGroups = groupArtists(tracks).slice(0, 8);
      var albumGroups = groupAlbums(tracks).slice(0, 8);
      var countNote = tracks.length + (tracks.length === 1 ? " track" : " tracks") + " from the music relay";
      if (!tracks.length) countNote = "Nothing from the relay - showing your own files";
      els.results.innerHTML = '<div class="music-search-head"><span class="music-eyebrow">Search results</span><h1>Results for “' + esc(query) + '”</h1><p>' + esc(countNote) + '</p></div>' +
        localHtml +
        (artistGroups.length ? section("Artists", "", '<div class="music-artist-row">' + artistGroups.map(function (a) { return artistCard(a.name, a.meta); }).join("") + '</div>', "music-section-artists") : "") +
        (albumGroups.length ? section("Albums", "", '<div class="music-cover-row">' + albumGroups.map(function (a) { return albumCard(a.album, a.artist, a.meta, a.tracks); }).join("") + '</div>', "music-section-covers") : "") +
        (tracks.length ? section("Songs", "", '<div class="music-track-list">' + tracks.map(function (m, i) { return rowHtml(m, i, tracks, "search"); }).join("") + '</div>', "music-section-tracks") : "");
      bindInteractive(els.results);
      watchArts(els.results);
    }
    metaIndex = {};
    relayBit();
  }

  function collectionFromKey(type, key) {
    /* allTracks, not state.catalog: an album card for music on this device has
       to open the same way a streamed album does. */
    var all = allTracks();
    if (type === "artist") return { name: key, tracks: all.filter(function (m) { return (m.artist || []).indexOf(key) !== -1; }) };
    var split = String(key).replace(/^album:/, "").split("|");
    return { name: split[0], artist: split.slice(1).join("|"), tracks: all.filter(function (m) { return String(m.album || "Single") === split[0] && firstArtist(m) === split.slice(1).join("|"); }) };
  }
  function openCollection(type, key) {
    var col = collectionFromKey(type, key);
    if (!col.tracks.length) return;
    metaIndex = {};
    var tracks = col.tracks.slice(0, 60);
    var first = tracks[0];
    var title = type === "artist" ? col.name : col.name;
    var subtitle = type === "artist" ? "Artist" : (col.artist || "Album");
    var playListMeta = cloneMeta(tracks[0], tracks, "detail-play");
    var back = document.getElementById("mprofile-back");
    if (back && back.parentElement === els.profile) els.profile.removeChild(back);
    els.profile.innerHTML =
      '<div class="music-detail-head"><div class="music-detail-art">' + artHtml(first, "music-art") + '<span class="music-hero-glow" aria-hidden="true"></span></div><div class="music-detail-copy"><span class="music-eyebrow">' + esc(subtitle) + '</span><h1>' + esc(title) + '</h1><p>' + esc(type === "artist" ? "Popular tracks from this artist" : (col.artist || "Album")) + ' · ' + tracks.length + ' songs</p><div class="music-hero-actions"><button class="music-primary-btn" data-mplay="' + esc(playListMeta._key) + '"><svg viewBox="0 0 24 24" aria-hidden="true" class="is-fill"><path d="M8 5v14l11-7z"/></svg><span>Play all</span></button><button class="music-secondary-btn" data-msave-collection="' + esc(type + ":" + key) + '">+ Add to library</button></div></div></div>' +
      '<div class="music-detail-list">' + tracks.map(function (m, i) { return rowHtml(m, i, tracks, "detail"); }).join("") + '</div>';
    if (back) els.profile.insertBefore(back, els.profile.firstChild);
    setPage("profile");
    els.profileBack.hidden = false;
    bindInteractive(els.profile);
    watchArts(els.profile);
  }
  function openProfile(id) {
    setPage("profile");
    els.profileBack.hidden = false;
    var back0 = document.getElementById("mprofile-back");
    if (back0 && back0.parentElement === els.profile) els.profile.removeChild(back0);
    els.profile.innerHTML = '<div class="music-loading"><span class="music-loading-dot"></span> Loading playlist…</div>';
    getJSON(api({ path: "playlist", id: id })).then(function (list) {
      var tracks = sortPopular(Array.isArray(list) ? list : []).slice(0, 60);
      if (!tracks.length) { showEmpty("Empty playlist", "There is nothing to play here yet."); return; }
      metaIndex = {};
      var first = tracks[0];
      var playlistMeta = cloneMeta(first, tracks, "playlist-play");
      els.profile.innerHTML = '<div class="music-detail-head"><div class="music-detail-art">' + artHtml(first, "music-art") + '<span class="music-hero-glow" aria-hidden="true"></span></div><div class="music-detail-copy"><span class="music-eyebrow">Playlist</span><h1>' + esc(first.album || "Playlist") + '</h1><p>' + tracks.length + ' songs from the music relay</p><button class="music-primary-btn" data-mplay="' + esc(playlistMeta._key) + '"><svg viewBox="0 0 24 24" aria-hidden="true" class="is-fill"><path d="M8 5v14l11-7z"/></svg><span>Play playlist</span></button></div></div><div class="music-detail-list">' + tracks.map(function (m, i) { return rowHtml(m, i, tracks, "playlist"); }).join("") + '</div>';
      if (back0) els.profile.insertBefore(back0, els.profile.firstChild);
      bindInteractive(els.profile);
      watchArts(els.profile);
    }).catch(function () { showEmpty("Playlist failed", "The music server did not answer. Try again in a moment."); });
  }

  function trackRecent(meta) {
    var id = trackId(meta);
    state.recent = [id].concat(state.recent.filter(function (x) { return String(x) !== id; })).slice(0, 12);
    saveArray(RECENT_KEY, state.recent);
  }
  function toggleSavedById(id) {
    var i = state.library.indexOf(String(id));
    if (i === -1) { state.library.unshift(String(id)); toast("Added to Your Library"); }
    else { state.library.splice(i, 1); toast("Removed from Your Library"); }
    saveArray(LIBRARY_KEY, state.library);
    if (state.page === "home") renderHomeFromCatalog();
    else if (state.page === "search" && els.q.value.trim()) showSearch(els.q.value.trim());
    else if (state.page === "library") renderLibrary();
  }
  function renderLibrary() {
    var pool = allTracks();
    var tracks = state.library.map(function (id) { return pool.find(function (m) { return trackId(m) === String(id); }); }).filter(Boolean);
    setPage("library");
    metaIndex = {};
    els.results.innerHTML = '<div class="music-search-head"><span class="music-eyebrow">Your Library</span><h1>Saved music</h1><p>' + tracks.length + ' saved tracks on this device</p></div>' + (tracks.length ? '<div class="music-track-list">' + tracks.map(function (m, i) { return rowHtml(m, i, tracks, "library"); }).join("") + '</div>' : '<div class="music-library-empty">Save tracks with the heart button and they will appear here.</div>');
    bindInteractive(els.results);
    watchArts(els.results);
  }
  function metaOfKey(key) { return metaIndex[key]; }
  function playList(list, meta) {
    var clean = (list || []).filter(Boolean);
    state.queue = clean.slice();
    var index = clean.indexOf(meta);
    if (index < 0 && meta) {
      var id = trackId(meta);
      index = clean.findIndex(function (item) { return trackId(item) === id; });
    }
    state.idx = index >= 0 ? index : 0;
    meta = state.queue[state.idx] || meta;
    trackRecent(meta);
    loadTrack(state.idx, true);
    renderQueue();
  }
  function saveCollection(key) {
    var type = String(key || "").split(":")[0];
    var raw = String(key || "").slice(type.length + 1);
    var collection = collectionFromKey(type, raw);
    var added = 0;
    collection.tracks.forEach(function (meta) {
      var id = trackId(meta);
      if (id && state.library.indexOf(id) === -1) { state.library.unshift(id); added++; }
    });
    saveArray(LIBRARY_KEY, state.library);
    toast(added ? "Added " + added + " tracks to Your Library" : "Already in Your Library");
  }
  function bindInteractive(scope) {
    if (!scope) return;
    scope.querySelectorAll("[data-mplay]").forEach(function (node) {
      if (node._musicBound) return;
      node._musicBound = true;
      function launch() {
        var key = node.getAttribute("data-mplay");
        var meta = metaOfKey(key);
        if (meta) playList(meta._list || [meta], meta);
      }
      node.addEventListener("click", launch);
      node.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); launch(); } });
    });
    scope.querySelectorAll("[data-mcollection]").forEach(function (node) {
      if (node._musicBound) return;
      node._musicBound = true;
      node.addEventListener("click", function () { openCollection(node.getAttribute("data-mcollection"), node.getAttribute("data-mcollection-key")); });
    });
    scope.querySelectorAll("[data-msave]").forEach(function (node) {
      if (node._musicBound) return;
      node._musicBound = true;
      node.addEventListener("click", function (e) { e.stopPropagation(); toggleSavedById(node.getAttribute("data-msave")); });
    });
    scope.querySelectorAll("[data-msave-collection]").forEach(function (node) {
      if (node._musicBound) return;
      node._musicBound = true;
      node.addEventListener("click", function (e) { e.stopPropagation(); saveCollection(node.getAttribute("data-msave-collection")); });
    });
    scope.querySelectorAll("[data-music-show]").forEach(function (node) {
      if (node._musicBound) return;
      node._musicBound = true;
      node.addEventListener("click", function () { toast("Scroll through the full " + node.getAttribute("data-music-show") + " section above."); });
    });
  }

  function loadTrack(i, autoplay) {
    if (!audio || i < 0 || i >= state.queue.length) return;
    state.idx = i;
    var meta = state.queue[i];
    // Stop the previous stream immediately when a different row is selected.
    // Otherwise the old song keeps playing while the relay resolves the new URL,
    // making a click look like it did nothing.
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    els.player.hidden = false;
    els.title.textContent = cleanName(meta.name) || "Untitled";
    els.artist.textContent = artistName(meta);
    updateMediaSession(meta);
    miniShow(meta); miniArt(cov[meta.pic_id] || meta._cover, meta);
    fsnpShow(meta);
    setPlayingUI(false);
    coverUrl(meta).then(function () { fillPlayerArt(); });
    state.ly = [];
    els.lyricsBtn.classList.remove("is-on");
    fetchLyrics(meta);
    els.seek.value = 0; els.cur.textContent = "0:00"; els.dur.textContent = "0:00";
    var bar = document.getElementById("music-mobile-bar");
    if (bar && meta) {
      var bt = document.getElementById("mmb-title"), ba = document.getElementById("mmb-artist");
      if (bt) bt.textContent = cleanName(meta.name) || "Untitled";
      if (ba) ba.textContent = artistName(meta);
      /* Visibility follows the layout mode: the compact bar only exists
         below 900px, where the desktop player is display:none. */
      if (window._musicApplyPlayerMode) window._musicApplyPlayerMode(); else bar.hidden = false;
    }
    highlightRows(); renderQueue();

    /* A file on this device is already playable: the object URL is the stream.
       Asking the relay for it would fail, because there is no video id behind
       it, and the failure would look like a broken track. */
    if (meta._local) {
      if (!meta._localUrl) { toast('"' + (cleanName(meta.name) || "That file") + '" is no longer on this device'); return; }
      audio.src = meta._localUrl;
      audio.load();
      applyTempo();
      if (autoplay) audio.play().catch(function () { setPlayingUI(false); });
      return;
    }

    loadSeq++;
    var seq = loadSeq;
    if (loadCtrl) { try { clearTimeout(loadCtrl._timer); } catch (e) {} try { loadCtrl.abort(); } catch (e) {} loadCtrl = null; }
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    if (ctrl) {
      loadCtrl = ctrl;
      ctrl._timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, LOAD_TIMEOUT_MS);
    }
    var signal = ctrl ? ctrl.signal : undefined;
    getJSON(api({ path: "url", id: meta.url_id != null ? meta.url_id : meta.id, br: 320 }), signal)
      .then(function (d) {
        if (seq !== loadSeq) return;  // a newer track started; drop this response
        var url = d && d.url || "";
        if (!url) { toast('"' + (cleanName(meta.name) || "Track") + '" is not available'); setTimeout(function () { next(true); }, 1000); return; }
        audio.src = url; audio.load(); applyTempo();
        if (autoplay) audio.play().catch(function () { setPlayingUI(false); });
      })
      .catch(function () {
        if (seq !== loadSeq) return;
        toast("Stream timed out or failed: " + (cleanName(meta.name) || "track"));
        setTimeout(function () { next(true); }, 1000);
      })
      .then(function () {
        if (loadCtrl === ctrl) { loadCtrl = null; if (ctrl) { try { clearTimeout(ctrl._timer); } catch (e) {} } }
      });
  }
  function fillPlayerArt() {
    var meta = state.queue[state.idx];
    if (!meta || !els.pArt) return;
    var url = cov[meta.pic_id] || meta._cover;
    els.pArt.innerHTML = url ? '<img src="' + esc(url) + '" alt="">' : '<span class="thumb-letter">' + esc((meta.name || "?").charAt(0).toUpperCase()) + '</span>';
    miniArt(url, meta);
    var fsArt = document.getElementById("fsnp-art");
    if (fsArt) fsArt.innerHTML = url ? '<img src="' + esc(url) + '" alt="">' : '<span class="thumb-letter">' + esc((meta.name || "?").charAt(0).toUpperCase()) + '</span>';
    var fsBg = document.getElementById("fsnp-bg");
    if (fsBg) fsBg.style.backgroundImage = url ? 'url("' + esc(url) + '")' : "none";
  }
  /* ---- Full-screen now playing ------------------------------------------
     An overlay, not a route: the queue keeps playing underneath, Escape or
     the close button returns you exactly where you were. Synced from the
     same state the bottom player renders from, so the two can never drift. */
  var fsnpOpen = false;
  function fsnpShow(meta) {
    var t = document.getElementById("fsnp-title"), a = document.getElementById("fsnp-artist"), al = document.getElementById("fsnp-album");
    if (!t) return;
    t.textContent = cleanName(meta && meta.name) || "Untitled";
    if (a) a.textContent = artistName(meta || {});
    if (al) al.textContent = albumLabel(meta || {});
  }
  function fsnpToggle(open) {
    var box = document.getElementById("fsnp-overlay");
    if (!box) return;
    fsnpOpen = open === undefined ? !fsnpOpen : !!open;
    box.hidden = !fsnpOpen;
    box.setAttribute("aria-hidden", fsnpOpen ? "false" : "true");
    document.body.classList.toggle("fsnp-open", fsnpOpen);
    if (fsnpOpen) {
      var meta = state.queue[state.idx];
      fsnpShow(meta);
      var url = meta ? (cov[meta.pic_id] || meta._cover) : "";
      var art = document.getElementById("fsnp-art");
      if (art) art.innerHTML = url ? '<img src="' + esc(url) + '" alt="">' : '<span class="thumb-letter">' + esc((meta && meta.name || "?").charAt(0).toUpperCase()) + '</span>';
      var bg = document.getElementById("fsnp-bg");
      if (bg) bg.style.backgroundImage = url ? 'url("' + esc(url) + '")' : "none";
      fsnpSync();
      fsnpSeekFromAudio();
    }
  }
  function fsnpSync() {
    var playing = !!(audio && !audio.paused && !audio.ended);
    ["fsnp-play", "mmb-play"].forEach(function (id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.classList.toggle("is-playing", playing);
      var p = btn.querySelector(".ico-play"), pa = btn.querySelector(".ico-pause");
      if (p) p.hidden = playing;
      if (pa) pa.hidden = !playing;
      btn.setAttribute("aria-label", playing ? "Pause" : "Play");
    });
    var meta = state.queue[state.idx];
    var saved = !!meta && isSaved(meta);
    ["p-fav", "fsnp-fav"].forEach(function (id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.classList.toggle("is-on", saved);
      btn.setAttribute("aria-label", saved ? "Remove from library" : "Add to library");
      btn.title = saved ? "Remove from library" : "Add to library";
      btn.innerHTML = heartSvg(saved);
    });
    ["fsnp-shuffle", "p-shuffle"].forEach(function (id) { var b = document.getElementById(id); if (b) b.classList.toggle("is-on", state.shuffle); });
    ["fsnp-repeat", "p-repeat"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) { b.classList.toggle("is-on", state.repeat !== "off"); var label = "Repeat: " + state.repeat; b.title = label; b.setAttribute("aria-label", label); }
    });
  }
  function fsnpSeekFromAudio() {
    if (!audio) return;
    var d = isFinite(audio.duration) ? audio.duration : 0;
    var val = d ? Math.round(audio.currentTime / d * 1000) : 0;
    var fs = document.getElementById("fsnp-seek");
    var fc = document.getElementById("fsnp-cur"), fd = document.getElementById("fsnp-dur");
    if (fs && document.activeElement !== fs) fs.value = val;
    if (fc) fc.textContent = fmt(audio.currentTime || 0);
    if (fd) fd.textContent = fmt(d);
  }
  /* ---- OS media controls ---------------------------------------------------
     The Media Session API is what puts the current song on a lock screen,
     a Windows media overlay or a car head unit, and what makes the hardware
     play/pause/next keys work on the Music tab. Every call is guarded, so a
     browser without the API loses nothing. */
  function mediaSessionOk() {
    return typeof navigator !== "undefined" && "mediaSession" in navigator;
  }

  function setMediaAction(name, handler) {
    try { navigator.mediaSession.setActionHandler(name, handler); }
    catch (e) { /* unsupported action name on this browser */ }
  }

  function updateMediaSession(meta) {
    if (!mediaSessionOk() || !meta) return;
    var title = cleanName(meta.name) || "Untitled";
    var artist = artistName(meta) || "Chalkle Music";
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: artist,
        album: meta.album || "Chalkle Music"
      });
    } catch (e) { /* MediaMetadata missing */ }
    coverUrl(meta).then(function (url) {
      if (!url || !navigator.mediaSession.metadata) return;
      try {
        navigator.mediaSession.metadata.artwork = [
          { src: url, sizes: "96x96", type: "image/jpeg" },
          { src: url, sizes: "256x256", type: "image/jpeg" },
          { src: url, sizes: "512x512", type: "image/jpeg" }
        ];
      } catch (e) { /* metadata locked by the browser */ }
    });
  }

  function setMediaPlaybackState(playing) {
    if (!mediaSessionOk()) return;
    try { navigator.mediaSession.playbackState = playing ? "playing" : "paused"; }
    catch (e) { /* ignore */ }
  }

  function bindMediaKeys() {
    if (!mediaSessionOk()) return;
    setMediaAction("play", function () { if (audio && audio.paused) togglePlay(); });
    setMediaAction("pause", function () { if (audio && !audio.paused) togglePlay(); });
    setMediaAction("previoustrack", function () { prev(); });
    setMediaAction("nexttrack", function () { next(); });
    setMediaAction("seekbackward", function (d) { if (audio) audio.currentTime = Math.max(0, (audio.currentTime || 0) - (d && d.seekOffset || 10)); });
    setMediaAction("seekforward", function (d) { if (audio) audio.currentTime = (audio.currentTime || 0) + (d && d.seekOffset || 10); });
    setMediaAction("seekto", function (d) { if (audio && d && typeof d.seekTime === "number") audio.currentTime = d.seekTime; });
  }

  /* ---- Mini player (topbar) ------------------------------------------------
     A tiny transport that lives next to the clock so play/pause/next/prev/mute
     are always one click away without switching back to the Music tab. It is
     driven from the same state the full player renders from. */
  function miniQ(id) { return document.getElementById(id); }
  function miniShow(meta) {
    var box = miniQ("mini-music");
    if (!box) return;
    if (!meta) { box.classList.remove("is-active"); return; }
    box.classList.add("is-active");
    var t = miniQ("mini-music-title"), a = miniQ("mini-music-artist");
    if (t) t.textContent = cleanName(meta.name) || "Untitled";
    if (a) a.textContent = artistName(meta);
  }
  function miniPlaying(on) {
    var box = miniQ("mini-music");
    if (!box) return;
    box.classList.toggle("is-playing", !!on);
    var p = box.querySelector(".mm-ico-play"), pa = box.querySelector(".mm-ico-pause");
    if (p) p.hidden = !!on;
    if (pa) pa.hidden = !on;
    var playBtn = miniQ("mini-music-play");
    if (playBtn) {
      playBtn.classList.toggle("is-playing", !!on);
      playBtn.setAttribute("aria-label", on ? "Pause" : "Play");
    }
  }
  function miniMuted(on) {
    var box = miniQ("mini-music");
    if (box) box.classList.toggle("is-muted", !!on);
  }
  function miniArt(url, meta) {
    var art = miniQ("mini-music-art");
    if (!art) return;
    art.innerHTML = url
      ? '<img src="' + esc(url) + '" alt="">'
      : '<span class="thumb-letter">' + esc((meta && meta.name || "?").charAt(0).toUpperCase()) + "</span>";
  }
  function miniToggleMute() {
    if (state.muted) { state.muted = false; if (state.vol === 0) state.vol = 50; }
    else state.muted = true;
    applyVol(); savePrefs();
  }
  function miniBind() {
    var bPlay = miniQ("mini-music-play"), bNext = miniQ("mini-music-next"), bPrev = miniQ("mini-music-prev"), bMute = miniQ("mini-music-mute"), bOpen = miniQ("mini-music-open");
    if (bPlay) bPlay.addEventListener("click", function (e) { e.stopPropagation(); togglePlay(); reconcilePlayFromClick(); });
    if (bNext) bNext.addEventListener("click", function (e) { e.stopPropagation(); next(); });
    if (bPrev) bPrev.addEventListener("click", function (e) { e.stopPropagation(); prev(); });
    if (bMute) bMute.addEventListener("click", function (e) { e.stopPropagation(); miniToggleMute(); });
    if (bOpen) bOpen.addEventListener("click", function () {
      var nav = document.querySelector('.nav-item[data-view="music"]');
      if (nav) nav.click();
    });
  }

  function stopAll() {
    if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
    setMediaPlaybackState(false);
    if (mediaSessionOk()) { try { navigator.mediaSession.metadata = null; } catch (e) { /* ignore */ } }
    state.idx = -1; state.queue = []; setPlayingUI(false); els.player.hidden = true; renderQueue(); highlightRows();
    miniShow(null); miniPlaying(false);
    var bar = document.getElementById("music-mobile-bar");
    if (bar) bar.hidden = true;
  }
  function setPlayingUI(on) {
    state.playing = on;
    if (els.play) {
      els.play.classList.toggle("is-playing", !!on);
      els.play.title = on ? "Pause" : "Play";
      els.play.setAttribute("aria-label", on ? "Pause" : "Play");
      var p = els.play.querySelector(".ico-play"), pa = els.play.querySelector(".ico-pause");
      if (p) p.hidden = !!on;
      if (pa) pa.hidden = !on;
    }
    miniPlaying(on);
    var card = document.getElementById("music-player");
    if (card) card.classList.toggle("is-playing", !!on);
    var bar = document.getElementById("music-mobile-bar");
    if (bar) {
      bar.classList.toggle("is-playing", !!on);
      var bp = bar.querySelector(".ico-play"), bpa = bar.querySelector(".ico-pause");
      if (bp) bp.hidden = !!on;
      if (bpa) bpa.hidden = !on;
    }
    fsnpSync();
  }
  function syncPlayingUI() {
    /* Re-derive the play/pause icon from reality, not just from the local
       flag. This prevents the button from staying stuck on 'pause' when the
       browser silently paused playback (autoplay restriction, resume needed,
       or a transient decoder drop).
       We only flip the icon when the browser's actual playing state disagrees
       with the UI, so a legit pause() from the user or from another app stays
       stable.
    */
    var real = !!(audio && audio.src && !audio.paused && !audio.ended);
    if (state.playing !== real) {
      state.playing = real;
      setPlayingUI(real);
    }
  }
  function reconcilePlayFromClick() {
    /* Called right after a user click on the play button. If the audio element
       already has a source and the browser is refusing to start (autoplay
       policy) we still want the icon to reflect reality, not just the local
       optimistic flag we set on click.
       This is intentionally separate from syncPlayingUI because it is meant
       to run synchronously after user gestures where the spec allows play().
    */
    if (!audio || !audio.src) return;
    var real = !!(!audio.paused && !audio.ended);
    if (state.playing !== real) {
      state.playing = real;
      setPlayingUI(real);
    }
  }
  function togglePlay() {
    if (state.idx < 0 || !state.queue.length) return;
    if (audio && !audio.paused && !audio.ended) {
      audio.pause();
      return;
    }
    state.playing = true;
    setPlayingUI(true);
    if (audio && audio.src) {
      audio.play().then(function () { syncPlayingUI(); }).catch(function () {
        state.playing = false;
        setPlayingUI(false);
      });
    }
  }
  function next(skipBroken) {
    if (!state.queue.length) return;
    if (state.repeat === "one" && !skipBroken) { audio.currentTime = 0; audio.play().catch(function () {}); return; }
    var i = state.idx + 1;
    if (state.shuffle && state.queue.length > 1) i = (state.idx + 1 + Math.floor(Math.random() * (state.queue.length - 1))) % state.queue.length;
    if (i >= state.queue.length) { if (state.repeat === "all") i = 0; else { stopAll(); return; } }
    loadTrack(i, true);
  }
  function prev() {
    if (!state.queue.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    loadTrack(state.idx > 0 ? state.idx - 1 : state.queue.length - 1, true);
  }
  function applyTempo() {
    if (!audio) return;
    try { audio.preservesPitch = state.pitch === 0; audio.playbackRate = state.speed * Math.pow(2, state.pitch / 12); } catch (e) { /* old browser */ }
    if (els.pitchV) els.pitchV.textContent = (state.pitch > 0 ? "+" : "") + state.pitch + " st";
    if (els.speedV) els.speedV.textContent = state.speed.toFixed(2).replace(/0$/, "") + "x";
  }
  function applyVol() {
    if (!audio) return;
    audio.muted = state.muted; audio.volume = Math.max(0, Math.min(1, state.vol / 100));
    els.vol.value = state.muted ? 0 : state.vol; els.mute.classList.toggle("is-on", state.muted);
    miniMuted(state.muted);
  }
  function highlightRows() {
    var current = state.queue[state.idx];
    document.querySelectorAll("[data-mplay]").forEach(function (node) { node.classList.toggle("is-playing", !!current && metaOfKey(node.getAttribute("data-mplay")) === current); });
  }
  function parseLrc(text) {
    var out = [], re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*(.*)/g, m;
    while ((m = re.exec(text || ""))) {
      var line = (m[4] || "").trim();
      if (!line || /^(作词|作曲|编曲|制作人|OP|SP)/.test(line)) continue;
      out.push({ t: (+m[1]) * 60 + (+m[2]) + (+(m[3] || 0)) / 1000, text: line });
    }
    return out.sort(function (a, b) { return a.t - b.t; });
  }
  function fetchLyrics(meta) {
    /* Local files have no lyric id, and the relay request would 404 for each
       one as it plays. */
    if (meta && meta._local) { state.ly = []; fullLyricsView(); return; }
    getJSON(api({ path: "lyric", id: meta.lyric_id != null ? meta.lyric_id : meta.id })).then(function (d) { state.ly = parseLrc(d && d.lyric || ""); fullLyricsView(); }).catch(function () { state.ly = []; fullLyricsView(); });
  }
  function fullLyricsView() {
    if (!els.lyricBox) return;
    els.lyricBox.innerHTML = state.ly.length ? state.ly.map(function (l, i) { return '<p data-ly="' + i + '">' + esc(l.text) + '</p>'; }).join("") : '<p class="p-lyric-none">No lyrics for this one.</p>';
    els.lyricsBtn.classList.toggle("is-on", state.ly.length > 0 && !els.lyricsPanel.hidden);
  }
  function tickLyrics() {
    if (!state.ly.length || !audio || !els.lyricBox) return;
    var idx = 0, t = audio.currentTime || 0;
    state.ly.forEach(function (line, i) { if (line.t <= t) idx = i; });
    els.lyricBox.querySelectorAll("p[data-ly]").forEach(function (p) { p.classList.toggle("is-on", +p.getAttribute("data-ly") === idx); });
  }
  function renderQueue() {
    if (!els.queueList) return;
    els.queueList.innerHTML = state.queue.length ? state.queue.map(function (m, i) { return '<button class="p-qrow ' + (i === state.idx ? "is-cur" : "") + '" data-qjump="' + i + '"><span class="p-qnum">' + (i + 1) + '</span><span class="p-qname">' + esc(cleanName(m.name)) + '</span><span class="p-qsub">' + esc(artistName(m)) + '</span></button>'; }).join("") : '<p class="p-lyric-none">Queue is empty - play something.</p>';
    els.queueList.querySelectorAll("[data-qjump]").forEach(function (node) { node.addEventListener("click", function () { loadTrack(+node.getAttribute("data-qjump"), true); els.queuePanel.hidden = true; }); });
  }
  function togglePop(pop) {
    var open = pop.hidden;
    [els.tunePop, els.lyricsPanel, els.queuePanel].forEach(function (p) { if (p && p !== pop) p.hidden = true; });
    pop.hidden = !open;
  }

  function mirrorShuffleRepeat() {
    var label = "Repeat: " + state.repeat;
    ["p-shuffle", "fsnp-shuffle"].forEach(function (id) { var b = document.getElementById(id); if (b) b.classList.toggle("is-on", state.shuffle); });
    ["p-repeat", "fsnp-repeat"].forEach(function (id) { var b = document.getElementById(id); if (b) { b.classList.toggle("is-on", state.repeat !== "off"); b.title = label; b.setAttribute("aria-label", label); } });
  }

  function bind() {
    els.play.addEventListener("click", function () { togglePlay(); reconcilePlayFromClick(); });
    els.next.addEventListener("click", function () { next(); }); els.prev.addEventListener("click", prev);
    miniBind();
    els.shuffle.addEventListener("click", function () { state.shuffle = !state.shuffle; mirrorShuffleRepeat(); });
    els.repeat.addEventListener("click", function () { state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off"; mirrorShuffleRepeat(); });
    els.seek.addEventListener("input", function () { state.dragging = true; var d = audio && isFinite(audio.duration) ? audio.duration : 0; els.cur.textContent = fmt((+els.seek.value) / 1000 * d); });
    els.seek.addEventListener("change", function () { var d = audio && isFinite(audio.duration) ? audio.duration : 0; if (d) audio.currentTime = (+els.seek.value) / 1000 * d; state.dragging = false; });
    els.vol.addEventListener("input", function () { state.vol = +els.vol.value; state.muted = state.vol === 0; applyVol(); savePrefs(); });
    els.mute.addEventListener("click", function () { state.muted = !state.muted; applyVol(); savePrefs(); });
    els.pitch.addEventListener("input", function () { state.pitch = +els.pitch.value; applyTempo(); savePrefs(); });
    els.speed.addEventListener("input", function () { state.speed = (+els.speed.value) / 100; applyTempo(); savePrefs(); });
    els.tuneReset.addEventListener("click", function () { state.pitch = 0; state.speed = 1; els.pitch.value = 0; els.speed.value = 100; applyTempo(); savePrefs(); });
    els.tuneBtn.addEventListener("click", function () { togglePop(els.tunePop); }); els.lyricsBtn.addEventListener("click", function () { togglePop(els.lyricsPanel); }); els.queueBtn.addEventListener("click", function () { togglePop(els.queuePanel); });
    els.lyricsX.addEventListener("click", function () { els.lyricsPanel.hidden = true; }); els.queueX.addEventListener("click", function () { els.queuePanel.hidden = true; });
    els.profileBack.addEventListener("click", renderHome);
    els.emptyCta.addEventListener("click", function () { state.catalog = []; renderHome(); });
    /* Player open affordances: the artwork row opens the immersive overlay;
       on narrow screens the compact mobile bar does the same. */
    var playerOpen = document.getElementById("music-player-open");
    if (playerOpen) playerOpen.addEventListener("click", function () { fsnpToggle(true); });
    var fsClose = document.getElementById("fsnp-close");
    if (fsClose) fsClose.addEventListener("click", function () { fsnpToggle(false); });
    var fsBox = document.getElementById("fsnp-overlay");
    if (fsBox) fsBox.addEventListener("click", function (e) { if (e.target === fsBox) fsnpToggle(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && fsnpOpen) fsnpToggle(false); });
    var fsPlay = document.getElementById("fsnp-play");
    if (fsPlay) fsPlay.addEventListener("click", function () { togglePlay(); reconcilePlayFromClick(); });
    var fsPrev = document.getElementById("fsnp-prev");
    if (fsPrev) fsPrev.addEventListener("click", prev);
    var fsNext = document.getElementById("fsnp-next");
    if (fsNext) fsNext.addEventListener("click", function () { next(); });
    var fsShuffle = document.getElementById("fsnp-shuffle");
    if (fsShuffle) fsShuffle.addEventListener("click", function () { state.shuffle = !state.shuffle; mirrorShuffleRepeat(); });
    var fsRepeat = document.getElementById("fsnp-repeat");
    if (fsRepeat) fsRepeat.addEventListener("click", function () { state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off"; mirrorShuffleRepeat(); });
    var fsSeek = document.getElementById("fsnp-seek");
    if (fsSeek) {
      fsSeek.addEventListener("input", function () { state.dragging = true; var d = audio && isFinite(audio.duration) ? audio.duration : 0; var fc = document.getElementById("fsnp-cur"); if (fc) fc.textContent = fmt((+fsSeek.value) / 1000 * d); });
      fsSeek.addEventListener("change", function () { var d = audio && isFinite(audio.duration) ? audio.duration : 0; if (d) audio.currentTime = (+fsSeek.value) / 1000 * d; state.dragging = false; });
    }
    ["p-fav", "fsnp-fav"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener("click", function () { var meta = state.queue[state.idx]; if (!meta) { toast("Nothing is playing"); return; } toggleSavedById(trackId(meta)); fsnpSync(); });
    });
    var fsQueueBtn = document.getElementById("fsnp-queue");
    if (fsQueueBtn) fsQueueBtn.addEventListener("click", function () { fsnpToggle(false); togglePop(els.queuePanel); });
    var fsLyricsBtn = document.getElementById("fsnp-lyrics");
    if (fsLyricsBtn) fsLyricsBtn.addEventListener("click", function () { fsnpToggle(false); togglePop(els.lyricsPanel); });
    /* Mobile compact bar: tap anywhere but the buttons expands the player. */
    var bar = document.getElementById("music-mobile-bar");
    if (bar) {
      var mPlay = document.getElementById("mmb-play");
      var mNext = document.getElementById("mmb-next");
      if (mPlay) mPlay.addEventListener("click", function (e) { e.stopPropagation(); togglePlay(); reconcilePlayFromClick(); });
      if (mNext) mNext.addEventListener("click", function (e) { e.stopPropagation(); next(); });
      bar.addEventListener("click", function (e) { if (e.target.closest(".p-btn")) return; fsnpToggle(true); });
    }
    document.querySelectorAll("[data-music-page]").forEach(function (btn) { btn.addEventListener("click", function () { var page = btn.getAttribute("data-music-page"); if (page === "library") renderLibrary(); else if (page === "home") renderHome(); else if (page === "search") { setPage("search"); els.q.focus(); } }); });
    els.q.addEventListener("input", function () { els.qClear.hidden = !els.q.value; });
    els.q.addEventListener("keydown", function (e) { if (e.key === "Enter") showSearch(els.q.value); });
    els.qClear.addEventListener("click", function () { els.q.value = ""; els.qClear.hidden = true; renderHome(); });
    document.addEventListener("click", function (e) {
      var pop = [els.tunePop, els.lyricsPanel, els.queuePanel];
      if (!pop.some(function (p) { return p && !p.hidden && (p.contains(e.target) || e.target === els.tuneBtn || e.target === els.lyricsBtn || e.target === els.queueBtn); })) pop.forEach(function (p) { if (p) p.hidden = true; });
      var save = e.target.closest && e.target.closest("[data-msave]");
      if (save && !save._musicBound) { e.preventDefault(); toggleSavedById(save.getAttribute("data-msave")); }
    });
    document.addEventListener("keydown", function (e) { if ((e.key === " " || e.key === "Spacebar") && !/INPUT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName || "")) { if (!state.viewHidden) { e.preventDefault(); togglePlay(); } } });
    audio.addEventListener("play", function () { state.playing = true; setPlayingUI(true); syncPlayingUI(); setMediaPlaybackState(true); });
    audio.addEventListener("pause", function () {
      if (audio.src) {
        state.playing = false;
        setPlayingUI(false);
        setMediaPlaybackState(false);
      }
    });
    audio.addEventListener("ended", function () { next(); });
    audio.addEventListener("resume", syncPlayingUI);
    audio.addEventListener("play", syncPlayingUI);
    audio.addEventListener("pause", syncPlayingUI);
    audio.addEventListener("timeupdate", function () { if (state.dragging) return; var d = isFinite(audio.duration) ? audio.duration : 0; els.seek.value = d ? Math.round(audio.currentTime / d * 1000) : 0; els.cur.textContent = fmt(audio.currentTime); els.dur.textContent = fmt(d); tickLyrics(); if (fsnpOpen) fsnpSeekFromAudio(); });
    audio.addEventListener("loadedmetadata", function () { if (isFinite(audio.duration)) els.dur.textContent = fmt(audio.duration); });
    audio.addEventListener("error", function () { var m = state.queue[state.idx]; if (m) toast("Couldn't load: " + m.name); setTimeout(function () { if (state.queue.length) next(true); }, 900); });
  }

  function init() {
    readPrefs();
    els = {
      q: $("music-q"), qClear: $("music-q-clear"), home: $("music-home"), results: $("music-results"), profile: $("music-profile"), profileBack: $("mprofile-back"), empty: $("music-empty"), emptyHint: $("music-empty-hint"), emptyCta: $("music-empty-cta"), player: $("music-player"), pArt: $("player-art"), title: $("player-title"), artist: $("player-artist"), play: $("p-play"), prev: $("p-prev"), next: $("p-next"), shuffle: $("p-shuffle"), repeat: $("p-repeat"), seek: $("p-seek"), cur: $("p-cur"), dur: $("p-dur"), vol: $("p-vol"), mute: $("p-mute"), tuneBtn: $("p-tune"), tunePop: $("p-tune-pop"), pitch: $("p-pitch"), pitchV: $("p-pitch-v"), speed: $("p-speed"), speedV: $("p-speed-v"), tuneReset: $("p-tune-reset"), lyricsBtn: $("p-lyrics"), lyricsPanel: $("p-lyrics-panel"), lyricsX: $("p-lyrics-x"), lyricBox: $("p-lyric-box"), queueBtn: $("p-queue"), queuePanel: $("p-queue-panel"), queueX: $("p-queue-x"), queueList: $("p-queue-list"), toast: $("p-toast"), fav: $("p-fav")
    };
    audio = $("music-audio");
    if (!audio || !els.home) return;
    /* The desktop player stays hidden below 900px; the compact bar replaces it
       there. Above 900px the compact bar never appears. */
    var mq = window.matchMedia("(min-width: 900px)");
    var applyPlayerMode = function () {
      var wide = mq.matches;
      var bar2 = document.getElementById("music-mobile-bar");
      if (bar2) bar2.classList.toggle("is-desktop", wide);
      if (wide && bar2) bar2.hidden = true;
      else if (bar2 && state.queue.length) bar2.hidden = false;
    };
    if (mq.addEventListener) mq.addEventListener("change", applyPlayerMode);
    window._musicApplyPlayerMode = applyPlayerMode;
    var view = document.querySelector('.view[data-view="music"]');
    state.viewHidden = view ? !view.classList.contains("is-visible") : true;
    if (view) new MutationObserver(function () { state.viewHidden = !view.classList.contains("is-visible"); }).observe(view, { attributes: true, attributeFilter: ["class"] });
    bind(); bindMediaKeys(); applyVol(); applyTempo(); els.pitch.value = state.pitch; els.speed.value = Math.round(state.speed * 100);
    /* Don't fire the 8 chart searches on page load when the Music tab is
       hidden - they all hit the relay at once and compete with the boot
       scripts. render() below (called by setView when the tab is opened)
       runs renderHome() then, so the charts load on first open instead. */
    if (!state.viewHidden) renderHome();
    /* Files on this device are read before any network call, so the local
       section is there on the first paint even if the relay never answers. */
    localTracks().then(function () {
      if (!state.viewHidden && state.catalog.length && state.page === "home") renderHomeFromCatalog();
    });
  }

  window.ChalkMusic = [];
  /* pause() / isPlaying() let the rest of the app stop playback when the user
     opens something that makes noise itself (YouTube, a movie, a game). */
  window.ChalkleMusic = {
    render: function () {
      var before = localCount();
      if (!state.catalog.length) renderHome(); else if (state.page === "home") renderHomeFromCatalog();
      highlightRows();
      /* Re-read the device library only when it actually changed (a file added
         or removed in another tab), so opening the tab never repaints twice. */
      localTracks().then(function () {
        if (state.viewHidden || localCount() === before) return;
        if (state.page === "home" && state.catalog.length) renderHomeFromCatalog();
        else if (state.page === "library") renderLibrary();
      });
    },
    play: playList,
    pause: function () { if (audio) { try { audio.pause(); } catch (e) {} } },
    isPlaying: function () { return !!state.playing; },
    retry: function () { state.catalog = []; renderHome(); }
  };
  /* Home tab "trending videos" click-through: app.js hands us the light
     track shape produced by ChalkleFeaturedVideos ({id,title,artist,...})
     and we convert it to a music track and start playing it. */
  window.ChalkleOpenVideo = function (t) {
    if (!t || !t.id) return;
    var meta = {
      id: t.id, url_id: t.id, pic_id: t.id, lyric_id: t.id,
      name: t.title || t.name || "Video",
      artist: [t.artist || "Unknown artist"],
      album: "",
      views: t.views || 0,
      duration: t.duration || 0,
      source: "youtube"
    };
    playList([meta], meta);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
