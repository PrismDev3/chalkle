/* Chalkle Music: a streaming-style discovery surface backed by the existing
   relay. The presentation is intentionally Chalkle, not a copy of another
   product: dark panels, pink/red accents, compact cards, and a persistent
   player around the existing search and playback APIs. */
(function () {
  "use strict";

  var PREFS_KEY = "chalkle-music-prefs-v1";
  var RECENT_KEY = "chalkle-music-recent-v1";
  var LIBRARY_KEY = "chalkle-music-library-v1";
  var CHART_QUERIES = ["drake", "taylor swift", "the weeknd", "kendrick lamar", "bad bunny", "billie eilish", "kanye west", "ariana grande"];

  var state = {
    page: "home",
    catalog: [],
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
  function getJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    });
  }
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

  function coverUrl(meta) {
    if (!meta || !meta.pic_id) return Promise.resolve("");
    if (meta._cover) return Promise.resolve(meta._cover);
    if (cov[meta.pic_id]) { meta._cover = cov[meta.pic_id]; return Promise.resolve(meta._cover); }
    return getJSON(api({ path: "pic", id: meta.pic_id, size: 480 })).then(function (d) {
      var url = d && d.url || "";
      cov[meta.pic_id] = url;
      meta._cover = url;
      return url;
    }).catch(function () { return ""; });
  }
  function artHtml(meta, cls) {
    var letter = esc((meta && (meta.name || meta.album || meta.artist && meta.artist[0]) || "?").charAt(0).toUpperCase());
    return '<span class="' + cls + '" data-pic="' + esc(meta && meta.pic_id || "") + '"><span class="thumb-letter">' + letter + "</span></span>";
  }
  function hydrateArts(scope) {
    (scope || document).querySelectorAll("[data-pic]").forEach(function (el) {
      var id = el.getAttribute("data-pic");
      if (!id || !cov[id]) return;
      el.innerHTML = '<img src="' + esc(cov[id]) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()">';
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
    return '<button class="music-save ' + (isSaved(meta) ? "is-saved" : "") + '" data-msave="' + esc(trackId(meta)) + '" aria-label="' + (isSaved(meta) ? "Remove from library" : "Add to library") + '" title="' + (isSaved(meta) ? "Remove from library" : "Add to library") + '">' + (isSaved(meta) ? "♥" : "♡") + "</button>";
  }
  function playIcon() { return '<span class="music-play-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>'; }
  function trackCard(meta, list, prefix) {
    var item = cloneMeta(meta, list, prefix);
    return '<article class="music-card" data-mplay="' + esc(item._key) + '" tabindex="0" role="button">' +
      '<span class="music-card-art">' + artHtml(item, "music-art") + playIcon() + '</span>' +
      '<span class="music-card-copy"><span class="music-card-title">' + esc(item.name || "Untitled") + '</span><span class="music-card-sub">' + esc(artistName(item)) + '</span></span>' +
      saveButton(item) + '</article>';
  }
  function albumCard(album, artist, meta, tracks) {
    var key = "album:" + album + "|" + artist;
    return '<button class="music-cover-card" data-mcollection="album" data-mcollection-key="' + esc(key) + '">' +
      '<span class="music-cover-art">' + artHtml(meta, "music-art") + playIcon() + '</span>' +
      '<span class="music-cover-title">' + esc(album || "Unknown album") + '</span>' +
      '<span class="music-cover-sub">' + esc(artist || "Unknown artist") + " · " + tracks.length + " tracks</span></button>";
  }
  function artistCard(name, meta) {
    return '<button class="music-artist-card" data-mcollection="artist" data-mcollection-key="' + esc(name) + '">' +
      '<span class="music-artist-art">' + artHtml(meta, "music-art") + playIcon() + '</span><span class="music-artist-name">' + esc(name) + '</span><span class="music-cover-sub">Artist</span></button>';
  }
  function section(title, note, body, extra) {
    return '<section class="music-section ' + (extra || "") + '"><div class="music-section-head"><div><h2>' + esc(title) + '</h2>' + (note ? '<span>' + esc(note) + '</span>' : '') + '</div><button class="music-show-all" type="button" data-music-show="' + esc(title) + '">Show all</button></div>' + body + '</section>';
  }
  function rowHtml(meta, i, list, prefix) {
    var item = cloneMeta(meta, list, prefix);
    return '<div class="music-track-row" data-mplay="' + esc(item._key) + '" tabindex="0" role="button">' +
      '<span class="music-track-num">' + (i + 1) + '</span>' +
      '<span class="music-track-art">' + artHtml(item, "music-art") + '</span>' +
      '<span class="music-track-main"><span class="music-track-name">' + esc(item.name || "Untitled") + '</span><span class="music-track-artist">' + esc(artistName(item)) + '</span></span>' +
      '<span class="music-track-album">' + esc(item.album || "Single") + '</span>' +
      '<span class="music-track-views">' + (Number(item.views) ? esc(formatViews(item.views)) : "") + '</span>' + saveButton(item) +
      '</div>';
  }
  function formatViews(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + "M plays";
    if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "K plays";
    return n + " plays";
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
    var found = [];
    state.recent.forEach(function (id) {
      var hit = state.catalog.find(function (m) { return trackId(m) === String(id); });
      if (hit) found.push(hit);
    });
    return found;
  }
  function registerTracks(list, prefix) {
    return (list || []).map(function (m) { return cloneMeta(m, list, prefix); });
  }

  function renderHome() {
    setPage("home");
    if (!state.catalog.length) {
      els.home.innerHTML = '<div class="music-loading"><span class="music-loading-dot"></span> Loading music for you…</div>';
      Promise.all(CHART_QUERIES.map(function (q) { return getJSON(api({ path: "search", q: q, limit: 10 })).catch(function () { return { items: [] }; }); }))
        .then(function (replies) {
          var all = [];
          replies.forEach(function (reply) { all = all.concat(reply && reply.items || []); });
          state.catalog = sortPopular(all);
          if (!state.catalog.length) throw new Error("empty");
          renderHome();
        }).catch(function () { showEmpty("Music is off-line", "The music source isn't answering right now. Try again in a minute."); });
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
    var heroPlay = '<button class="music-primary-btn" data-mplay="' + esc(heroItem._key) + '">' + playIcon() + ' Play featured</button>';
    var heroSave = saveButton(heroItem).replace("music-save", "music-hero-save");
    var html = '<div class="music-home-shell">' +
      '<div class="music-home-intro"><div><span class="music-eyebrow">Chalkle Music</span><h1>' + greeting() + '</h1><p>Find something to play, then keep browsing without losing your place.</p></div><span class="music-source-note">Live catalog · relay powered</span></div>' +
      '<div class="music-hero"><div class="music-hero-art">' + artHtml(heroItem, "music-art") + '</div><div class="music-hero-copy"><span class="music-eyebrow">Featured track</span><h2>' + esc(hero.name || "Untitled") + '</h2><p class="music-hero-artist">' + esc(artistName(hero)) + '</p><p class="music-hero-album">' + esc(hero.album || "Single") + '</p><div class="music-hero-actions">' + heroPlay + heroSave + '</div></div></div>' +
      section(recentTitle, recent.length ? "Pick up where you left off" : "Popular picks to get you started", '<div class="music-card-row">' + recentDisplay.map(function (m, i) { return trackCard(m, recentDisplay, "recent" + i); }).join("") + '</div>', "music-section-cards") +
      section("Made for you", "Based on what is popular right now", '<div class="music-card-row">' + made.map(function (m, i) { return trackCard(m, made, "made" + i); }).join("") + '</div>', "music-section-cards") +
      section("Popular albums", "Albums and collections", '<div class="music-cover-row">' + albums.map(function (a) { return albumCard(a.album, a.artist, a.meta, a.tracks); }).join("") + '</div>', "music-section-covers") +
      section("Popular artists", "Artists appearing across the catalog", '<div class="music-artist-row">' + artists.map(function (a) { return artistCard(a.name, a.meta); }).join("") + '</div>', "music-section-artists") +
      section("Popular tracks", "A compact list of what is getting played", '<div class="music-track-list">' + hot.map(function (m, i) { return rowHtml(m, i, hot, "popular"); }).join("") + '</div>', "music-section-tracks") +
      '</div>';
    els.home.innerHTML = html;
    bindInteractive(els.home);
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
    getJSON(api({ path: "search", q: q, limit: 40 })).then(function (reply) {
      var tracks = sortPopular(reply && reply.items || []);
      if (!tracks.length) { showEmpty("Nothing found", "Try a shorter title, an artist name, or a different spelling."); return; }
      metaIndex = {};
      var artistGroups = groupArtists(tracks).slice(0, 8);
      var albumGroups = groupAlbums(tracks).slice(0, 8);
      els.results.innerHTML = '<div class="music-search-head"><span class="music-eyebrow">Search results</span><h1>Results for “' + esc(q) + '”</h1><p>' + tracks.length + ' tracks from the music relay</p></div>' +
        (artistGroups.length ? section("Artists", "", '<div class="music-artist-row">' + artistGroups.map(function (a) { return artistCard(a.name, a.meta); }).join("") + '</div>', "music-section-artists") : "") +
        (albumGroups.length ? section("Albums", "", '<div class="music-cover-row">' + albumGroups.map(function (a) { return albumCard(a.album, a.artist, a.meta, a.tracks); }).join("") + '</div>', "music-section-covers") : "") +
        section("Songs", "", '<div class="music-track-list">' + tracks.map(function (m, i) { return rowHtml(m, i, tracks, "search"); }).join("") + '</div>', "music-section-tracks");
      bindInteractive(els.results);
      watchArts(els.results);
    }).catch(function () { showEmpty("Search failed", "The music server did not answer. Try again in a moment."); });
  }

  function collectionFromKey(type, key) {
    if (type === "artist") return { name: key, tracks: state.catalog.filter(function (m) { return (m.artist || []).indexOf(key) !== -1; }) };
    var split = String(key).replace(/^album:/, "").split("|");
    return { name: split[0], artist: split.slice(1).join("|"), tracks: state.catalog.filter(function (m) { return String(m.album || "Single") === split[0] && firstArtist(m) === split.slice(1).join("|"); }) };
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
    els.profile.innerHTML = '<div class="music-detail-head"><div class="music-detail-art">' + artHtml(first, "music-art") + '</div><div class="music-detail-copy"><span class="music-eyebrow">' + esc(subtitle) + '</span><h1>' + esc(title) + '</h1><p>' + esc(type === "artist" ? "Popular tracks from this artist" : (col.artist || "Album")) + ' · ' + tracks.length + ' songs</p><div class="music-hero-actions"><button class="music-primary-btn" data-mplay="' + esc(playListMeta._key) + '">' + playIcon() + ' Play all</button><button class="music-secondary-btn" data-msave-collection="' + esc(type + ":" + key) + '">+ Add to library</button></div></div></div>' +
      '<div class="music-detail-list">' + tracks.map(function (m, i) { return rowHtml(m, i, tracks, "detail"); }).join("") + '</div>';
    setPage("profile");
    els.profileBack.hidden = false;
    bindInteractive(els.profile);
    watchArts(els.profile);
  }
  function openProfile(id) {
    setPage("profile");
    els.profileBack.hidden = false;
    els.profile.innerHTML = '<div class="music-loading"><span class="music-loading-dot"></span> Loading playlist…</div>';
    getJSON(api({ path: "playlist", id: id })).then(function (list) {
      var tracks = sortPopular(Array.isArray(list) ? list : []).slice(0, 60);
      if (!tracks.length) { showEmpty("Empty playlist", "There is nothing to play here yet."); return; }
      metaIndex = {};
      var first = tracks[0];
      var playlistMeta = cloneMeta(first, tracks, "playlist-play");
      els.profile.innerHTML = '<div class="music-detail-head"><div class="music-detail-art">' + artHtml(first, "music-art") + '</div><div class="music-detail-copy"><span class="music-eyebrow">Playlist</span><h1>' + esc(first.album || "Playlist") + '</h1><p>' + tracks.length + ' songs from the music relay</p><button class="music-primary-btn" data-mplay="' + esc(playlistMeta._key) + '">' + playIcon() + ' Play playlist</button></div></div><div class="music-detail-list">' + tracks.map(function (m, i) { return rowHtml(m, i, tracks, "playlist"); }).join("") + '</div>';
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
    var tracks = state.library.map(function (id) { return state.catalog.find(function (m) { return trackId(m) === String(id); }); }).filter(Boolean);
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
    els.player.hidden = false;
    els.title.textContent = meta.name || "Untitled";
    els.artist.textContent = artistName(meta);
    setPlayingUI(false);
    coverUrl(meta).then(function () { fillPlayerArt(); });
    state.ly = [];
    els.lyricsBtn.classList.remove("is-on");
    fetchLyrics(meta);
    els.seek.value = 0; els.cur.textContent = "0:00"; els.dur.textContent = "0:00";
    highlightRows(); renderQueue();
    getJSON(api({ path: "url", id: meta.url_id != null ? meta.url_id : meta.id, br: 320 })).then(function (d) {
      var url = d && d.url || "";
      if (!url) { toast('"' + (meta.name || "Track") + '" is not available'); setTimeout(function () { next(true); }, 1000); return; }
      audio.src = url; audio.load(); applyTempo();
      if (autoplay) audio.play().catch(function () { setPlayingUI(false); });
    }).catch(function () { toast("Stream failed: " + (meta.name || "track")); setTimeout(function () { next(true); }, 1000); });
  }
  function fillPlayerArt() {
    var meta = state.queue[state.idx];
    if (!meta || !els.pArt) return;
    var url = cov[meta.pic_id] || meta._cover;
    els.pArt.innerHTML = url ? '<img src="' + esc(url) + '" alt="">' : '<span class="thumb-letter">' + esc((meta.name || "?").charAt(0).toUpperCase()) + '</span>';
  }
  function stopAll() {
    if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
    state.idx = -1; state.queue = []; setPlayingUI(false); els.player.hidden = true; renderQueue(); highlightRows();
  }
  function setPlayingUI(on) {
    state.playing = on;
    if (!els.play) return;
    els.play.title = on ? "Pause" : "Play"; els.play.setAttribute("aria-label", on ? "Pause" : "Play");
    var p = els.play.querySelector(".ico-play"), pa = els.play.querySelector(".ico-pause");
    if (p) p.hidden = !!on; if (pa) pa.hidden = !on;
  }
  function togglePlay() {
    if (state.idx < 0 || !state.queue.length) return;
    if (state.playing) audio.pause(); else audio.play().catch(function () {});
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
    els.queueList.innerHTML = state.queue.length ? state.queue.map(function (m, i) { return '<button class="p-qrow ' + (i === state.idx ? "is-cur" : "") + '" data-qjump="' + i + '"><span class="p-qnum">' + (i + 1) + '</span><span class="p-qname">' + esc(m.name) + '</span><span class="p-qsub">' + esc(artistName(m)) + '</span></button>'; }).join("") : '<p class="p-lyric-none">Queue is empty - play something.</p>';
    els.queueList.querySelectorAll("[data-qjump]").forEach(function (node) { node.addEventListener("click", function () { loadTrack(+node.getAttribute("data-qjump"), true); els.queuePanel.hidden = true; }); });
  }
  function togglePop(pop) {
    var open = pop.hidden;
    [els.tunePop, els.lyricsPanel, els.queuePanel].forEach(function (p) { if (p && p !== pop) p.hidden = true; });
    pop.hidden = !open;
  }

  function bind() {
    els.play.addEventListener("click", togglePlay); els.next.addEventListener("click", function () { next(); }); els.prev.addEventListener("click", prev);
    els.shuffle.addEventListener("click", function () { state.shuffle = !state.shuffle; els.shuffle.classList.toggle("is-on", state.shuffle); });
    els.repeat.addEventListener("click", function () { state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off"; var label = "Repeat: " + state.repeat; els.repeat.title = label; els.repeat.setAttribute("aria-label", label); els.repeat.classList.toggle("is-on", state.repeat !== "off"); });
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
    audio.addEventListener("play", function () { setPlayingUI(true); }); audio.addEventListener("pause", function () { setPlayingUI(false); }); audio.addEventListener("ended", function () { next(); });
    audio.addEventListener("timeupdate", function () { if (state.dragging) return; var d = isFinite(audio.duration) ? audio.duration : 0; els.seek.value = d ? Math.round(audio.currentTime / d * 1000) : 0; els.cur.textContent = fmt(audio.currentTime); els.dur.textContent = fmt(d); tickLyrics(); });
    audio.addEventListener("loadedmetadata", function () { if (isFinite(audio.duration)) els.dur.textContent = fmt(audio.duration); });
    audio.addEventListener("error", function () { var m = state.queue[state.idx]; if (m) toast("Couldn't load: " + m.name); setTimeout(function () { if (state.queue.length) next(true); }, 900); });
  }

  function init() {
    readPrefs();
    els = {
      q: $("music-q"), qClear: $("music-q-clear"), home: $("music-home"), results: $("music-results"), profile: $("music-profile"), profileBack: $("mprofile-back"), empty: $("music-empty"), emptyHint: $("music-empty-hint"), emptyCta: $("music-empty-cta"), player: $("music-player"), pArt: $("player-art"), title: $("player-title"), artist: $("player-artist"), play: $("p-play"), prev: $("p-prev"), next: $("p-next"), shuffle: $("p-shuffle"), repeat: $("p-repeat"), seek: $("p-seek"), cur: $("p-cur"), dur: $("p-dur"), vol: $("p-vol"), mute: $("p-mute"), tuneBtn: $("p-tune"), tunePop: $("p-tune-pop"), pitch: $("p-pitch"), pitchV: $("p-pitch-v"), speed: $("p-speed"), speedV: $("p-speed-v"), tuneReset: $("p-tune-reset"), lyricsBtn: $("p-lyrics"), lyricsPanel: $("p-lyrics-panel"), lyricsX: $("p-lyrics-x"), lyricBox: $("p-lyric-box"), queueBtn: $("p-queue"), queuePanel: $("p-queue-panel"), queueX: $("p-queue-x"), queueList: $("p-queue-list"), toast: $("p-toast")
    };
    audio = $("music-audio");
    if (!audio || !els.home) return;
    var view = document.querySelector('.view[data-view="music"]');
    state.viewHidden = view ? !view.classList.contains("is-visible") : true;
    if (view) new MutationObserver(function () { state.viewHidden = !view.classList.contains("is-visible"); }).observe(view, { attributes: true, attributeFilter: ["class"] });
    bind(); applyVol(); applyTempo(); els.pitch.value = state.pitch; els.speed.value = Math.round(state.speed * 100); renderHome();
  }

  window.ChalkMusic = [];
  window.ChalkleMusic = { render: function () { if (!state.catalog.length) renderHome(); else if (state.page === "home") renderHomeFromCatalog(); highlightRows(); }, play: playList, retry: function () { state.catalog = []; renderHome(); } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
