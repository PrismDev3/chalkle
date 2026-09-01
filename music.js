/* Chalkle Music tab.
   Real songs through the site's /music relay (serve-chalk.py -> local Meting
   backend). Streams and art flow through the relay too, so nothing on this
   page ever calls netease's CDN directly - school-friendly, no CORS, and the
   audio proxy supports Range so seeking works.
   Features: charts + search + playlist profiles, queue with shuffle/repeat,
   seek + volume, speed + pitch (chipmunk/slow-mo), synced karaoke lyrics. */
(function () {
  "use strict";

  var PREFS_KEY = "chalkle-music-prefs-v1";

  var CHARTS = [
    { id: "3778678", name: "Hot 50" },
    { id: "19723756", name: "Climbing" },
    { id: "3779629", name: "New songs" },
    { id: "2884035", name: "Original" }
  ];

  var state = {
    queue: [],
    idx: -1,
    playing: false,
    shuffle: false,
    repeat: "off", // off | all | one
    vol: 80,
    muted: false,
    speed: 1,
    pitch: 0,
    dragging: false,
    ly: [] // parsed lyrics [{t, text}]
  };

  var cov = {};        // pic_id -> resolved relay url
  var byKey = {};      // list key -> array index for highlight
  var els = {};
  var audio = null;
  var toastTimer = null;

  /* ---------- tiny helpers ---------- */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmt(s) {
    if (!isFinite(s) || s < 0) return "0:00";
    s = Math.floor(s);
    var m = Math.floor(s / 60), x = s % 60;
    return m + ":" + (x < 10 ? "0" : "") + x;
  }

  function api(p) {
    var q = Object.keys(p).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(p[k]);
    }).join("&");
    return "/music/api?" + q;
  }

  function getJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    });
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
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        vol: state.vol, muted: state.muted, speed: state.speed, pitch: state.pitch
      }));
    } catch (e) { /* no storage */ }
  }

  function toast(msg) {
    var t = els.toast;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2400);
  }

  /* ---------- cover art (lazy, via relay) ---------- */

  function coverUrl(meta) {
    if (meta._cover) return Promise.resolve(meta._cover);
    if (cov[meta.pic_id]) {
      meta._cover = cov[meta.pic_id];
      return Promise.resolve(meta._cover);
    }
    return getJSON(api({ path: "pic", id: meta.pic_id, size: 300 })).then(function (d) {
      var u = (d && d.url) || "";
      cov[meta.pic_id] = u;
      meta._cover = u;
      return u;
    }).catch(function () { return ""; });
  }

  function hydrateArts() {
    try {
      document.querySelectorAll("[data-pic]").forEach(function (el) {
        var id = el.getAttribute("data-pic");
        var u = cov[id];
        if (u) {
          el.innerHTML = '<img src="' + esc(u) + '" alt="" loading="lazy" decoding="async">';
          el.removeAttribute("data-pic");
        }
      });
    } catch (e) { /* non-critical */ }
  }

  /* ---------- row / card markup ---------- */

  function artHtml(meta, cls) {
    return '<span class="' + cls + '" data-pic="' + esc(meta.pic_id || "") + '">' +
      '<span class="thumb-letter">' + esc((meta.name || "?").charAt(0).toUpperCase()) + "</span></span>";
  }

  function rowHtml(meta, i, kind) {
    var key = kind + "-" + meta.id;
    byKey[key] = i;
    return (
      '<div class="mrow" data-mkey="' + key + '" data-mplay="' + key + '">' +
      '<span class="mrow-num">' + (i + 1) + "</span>" +
      artHtml(meta, "mrow-art") +
      '<span class="mrow-txt"><span class="mrow-name">' + esc(meta.name) + "</span>" +
      '<span class="mrow-album">' + esc((meta.artist || []).join(" · ")) + " · " + esc(meta.album || "") + "</span></span>" +
      '<span class="mrow-play" aria-hidden="true">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span>' +
      "</div>"
    );
  }

  /* ---------- views ---------- */

  function setPage(page) {
    els.home.hidden = page !== "home";
    els.results.hidden = page !== "search";
    els.profile.hidden = page !== "profile";
    els.empty.hidden = true;
  }

  function rowOfKey(key) {
    return document.querySelector('.mrow[data-mkey="' + key + '"]');
  }

  function highlightRows() {
    var cur = state.queue[state.idx];
    document.querySelectorAll(".mrow").forEach(function (r) {
      var k = r.getAttribute("data-mkey") || "";
      r.classList.toggle("is-playing", !!cur && k === cur._key);
    });
  }

  function renderHome() {
    setPage("home");
    els.home.innerHTML = '<p class="empty-title">Loading…</p>';
    // One playlist gates the home view (fast); the chart cards load on tap.
    getJSON(api({ path: "playlist", id: "3778678" }))
      .then(function (list) {
        var tracks = Array.isArray(list) ? list : [];
        if (!tracks.length) throw new Error("empty");
        var hot = tracks.slice(0, 20);
        hot.forEach(function (t, i) {
          t._key = "chart-" + t.id;
          t._list = hot;
          metaIndex[t._key] = t;
        });
        var html =
          '<div class="mstory-head"><span class="mstory-title">Charts</span><span class="mstory-sub">tap one to open</span></div>' +
          '<div class="mrail">' + CHARTS.map(function (c) {
            return '<div class="mpl-card" data-mpl="' + c.id + '">' +
              '<div class="mpl-art"><span class="thumb-letter">\u266a</span></div>' +
              '<div class="mpl-name">' + esc(c.name) + "</div>" +
              '<div class="mpl-sub">chart</div></div>';
          }).join("") + "</div>" +
          '<div class="mstory-head"><span class="mstory-title">Hot right now</span><span class="mstory-sub">tap a song to play</span></div>' +
          hot.map(function (t, i) { return rowHtml(t, i, "chart"); }).join("");
        els.home.innerHTML = html;
        bindListClicks();
        watchArts(els.home);
      })
      .catch(function () {
        els.home.innerHTML = "";
        showEmpty("Music is off-line", "The netease source isn't answering right now - try again in a minute.");
      });
  }

  /* Fetch album art only for rows near the viewport, so a full search result
     doesn't fire 40 netease pic requests at once. */
  var artObs = null;
  function watchArts(scope) {
    if (!scope || !("IntersectionObserver" in window)) return;
    if (artObs) artObs.disconnect();
    artObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var el = en.target;
        var id = el.getAttribute("data-pic");
        var row = el.closest(".mrow");
        var key = row ? row.getAttribute("data-mkey") : "";
        var meta = key ? metaIndex[key] : null;
        if (id && meta) coverUrl(meta).then(hydrateArts);
        artObs.unobserve(el);
      });
    }, { rootMargin: "240px" });
    scope.querySelectorAll(".mrow-art[data-pic]").forEach(function (el) { artObs.observe(el); });
  }

  function bindListClicks() {
    document.querySelectorAll("[data-mplay]").forEach(function (el) {
      if (el._bound) return;
      el._bound = true;
      el.addEventListener("click", function () {
        var key = el.getAttribute("data-mplay");
        var meta = metaOfKey(key);
        if (meta) playList(listOfMeta(meta), meta);
      });
    });
    document.querySelectorAll("[data-mpl]").forEach(function (el) {
      if (el._bound) return;
      el._bound = true;
      el.addEventListener("click", function () { openProfile(el.getAttribute("data-mpl")); });
    });
  }

  var metaIndex = {};
  function metaOfKey(key) { return metaIndex[key]; }
  function listOfMeta(meta) { return meta._list || [meta]; }

  function showSearch(q) {
    setPage("search");
    els.results.innerHTML = '<p class="empty-title">Searching…</p>';
    getJSON(api({ path: "search", q: q, limit: 40 })).then(function (list) {
      if (!Array.isArray(list) || !list.length) {
        els.results.innerHTML = "";
        showEmpty("Nothing found", "Try a different spelling or a shorter name.");
        return;
      }
      list.forEach(function (t, i) { t._key = "search-" + t.id; t._list = list; metaIndex[t._key] = t; });
      els.results.innerHTML = list.map(function (t, i) { return rowHtml(t, i, "search"); }).join("");
      bindListClicks();
      watchArts(els.results);
    }).catch(function () {
      els.results.innerHTML = "";
      showEmpty("Search failed", "The music server didn't answer. Try again in a moment.");
    });
  }

  function openProfile(id) {
    setPage("profile");
    els.profileBack.hidden = false;
    els.profile.innerHTML = '<p class="empty-title">Loading…</p>';
    getJSON(api({ path: "playlist", id: id })).then(function (list) {
      var tracks = (Array.isArray(list) ? list : []).slice(0, 60);
      if (!tracks.length) {
        els.profile.innerHTML = "";
        showEmpty("Empty playlist", "Nothing to play here.");
        return;
      }
      var first = tracks[0] || {};
      var head = '<div class="mprofile"><div class="mprofile-art" data-pic="' + esc(first.pic_id || "") + '">' +
        '<span class="thumb-letter">' + esc((first.name || "?").charAt(0).toUpperCase()) + "</span></div>" +
        '<div class="mprofile-head"><h3 class="mprofile-title">' + esc(first.album || "Playlist") + "</h3>" +
        '<div class="mprofile-meta">' + tracks.length + " songs</div>" +
        '<div class="mprofile-desc">Tap any track to queue it from here.</div></div></div>';
      tracks.forEach(function (t, i) {
        t._key = "pl-" + t.id;
        t._list = tracks;
        metaIndex[t._key] = t;
      });
      els.profile.innerHTML = head + '<div class="mprofile-tracks">' +
        tracks.map(function (t, i) { return rowHtml(t, i, "pl"); }).join("") + "</div>";
      bindListClicks();
      watchArts(els.profile);
    }).catch(function () {
      els.profile.innerHTML = "";
      showEmpty("Playlist failed", "The music server didn't answer. Try again in a moment.");
    });
  }

  function showEmpty(title, hint) {
    setPage("page-none");
    var e = els.empty;
    e.querySelector(".empty-title").textContent = title;
    els.emptyHint.textContent = hint || "";
    e.hidden = false;
  }

  /* ---------- playback ---------- */

  function playList(list, meta) {
    state.queue = list.slice();
    var i = list.indexOf(meta);
    state.idx = i >= 0 ? i : 0;
    loadTrack(state.idx, true);
    renderQueue();
    setPage(currentPageKind());
  }

  function currentPageKind() {
    if (!els.profile.hidden) return "profile";
    if (!els.results.hidden) return "search";
    return "home";
  }

  function loadTrack(i, autoplay) {
    if (!audio) return;
    if (i < 0 || i >= state.queue.length) {
      stopAll();
      return;
    }
    state.idx = i;
    var meta = state.queue[i];
    els.player.hidden = false;
    els.title.textContent = meta.name || "Untitled";
    els.artist.textContent = (meta.artist || []).join(" · ") || meta.album || "";
    setPlayingUI(false);
    coverUrl(meta).then(function () { hydrateArts(); fillPlayerArt(); });
    els.lyricsBtn.classList.remove("is-on");
    state.ly = [];
    fetchLyrics(meta);
    els.seek.value = 0;
    els.cur.textContent = "0:00";
    els.dur.textContent = "0:00";
    highlightRows();
    renderQueue();
    // Resolve the stream through the relay (url may be empty for VIP tracks).
    getJSON(api({ path: "url", id: meta.url_id != null ? meta.url_id : meta.id, br: 320 }))
      .then(function (d) {
        var u = (d && d.url) || "";
        if (!u) {
          toast('"' + meta.name + '" is not available on netease');
          setTimeout(function () { next(true); }, 1200);
          return;
        }
        audio.src = u;
        audio.load();
        applyTempo();
        if (autoplay) {
          audio.play().catch(function () { setPlayingUI(false); });
        }
      })
      .catch(function () {
        toast("Stream failed: " + (meta.name || "track"));
        setTimeout(function () { next(true); }, 1000);
      });
  }

  function fillPlayerArt() {
    var meta = state.queue[state.idx];
    if (!meta) return;
    var u = cov[meta.pic_id] || meta._cover;
    var box = els.pArt;
    if (u) {
      box.innerHTML = '<img src="' + esc(u) + '" alt="">';
    } else {
      box.innerHTML = '<span class="thumb-letter">' + esc((meta.name || "?").charAt(0).toUpperCase()) + "</span>";
    }
  }

  function stopAll() {
    if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
    setPlayingUI(false);
    els.player.hidden = true;
    state.idx = -1;
    state.queue = [];
    els.title.textContent = "Nothing playing";
    els.artist.textContent = "pick a song to start";
    els.cur.textContent = "0:00";
    els.dur.textContent = "0:00";
    renderQueue();
    highlightRows();
  }

  function setPlayingUI(on) {
    state.playing = on;
    els.play.title = on ? "Pause" : "Play";
    els.play.setAttribute("aria-label", on ? "Pause" : "Play");
    var p = els.play.querySelector(".ico-play");
    var pa = els.play.querySelector(".ico-pause");
    if (p) p.hidden = !!on;
    if (pa) pa.hidden = !on;
  }

  function togglePlay() {
    if (state.idx < 0 || !state.queue.length) return;
    if (state.playing) {
      audio.pause();
      setPlayingUI(false);
    } else {
      audio.play().catch(function () { /* blocked or no src */ });
    }
  }

  function next(skipBroken) {
    if (!state.queue.length) return;
    var n = state.queue.length;
    var i = state.idx;
    if (state.repeat === "one" && !skipBroken) {
      if (audio) { audio.currentTime = 0; audio.play().catch(function () {}); }
      return;
    }
    if (state.shuffle && n > 1) {
      var r = Math.floor(Math.random() * (n - 1));
      i = (i + 1 + r) % n;
    } else {
      i = i + 1;
      if (i >= n) {
        if (state.repeat === "all") i = 0;
        else { stopAll(); return; }
      }
    }
    loadTrack(i, true);
  }

  function prev() {
    if (!state.queue.length) return;
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
    var i = state.idx - 1;
    if (i < 0) i = state.queue.length - 1;
    loadTrack(i, true);
  }

  function applyTempo() {
    if (!audio) return;
    try {
      audio.preservesPitch = state.pitch === 0;
      audio.playbackRate = state.speed * Math.pow(2, state.pitch / 12);
    } catch (e) { /* older browsers */ }
    els.pitchV.textContent = (state.pitch > 0 ? "+" : "") + state.pitch + " st";
    els.speedV.textContent = state.speed.toFixed(2).replace(/0$/, "") + "x";
  }

  /* ---------- lyrics ---------- */

  function fetchLyrics(meta) {
    getJSON(api({ path: "lyric", id: meta.lyric_id != null ? meta.lyric_id : meta.id }))
      .then(function (d) {
        state.ly = parseLrc((d && d.lyric) || "");
        fullLyricsView();
      })
      .catch(function () { state.ly = []; fullLyricsView(); });
  }

  function parseLrc(text) {
    var out = [];
    var re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*(.*)/g;
    var m;
    while ((m = re.exec(text))) {
      var t = (+m[1]) * 60 + (+m[2]) + (+(m[3] || "0")) / 1000;
      var line = (m[4] || "").trim();
      if (!line) continue;
      if (/^(作词|作曲|编曲|制作人|OP|SP)/.test(line)) continue;
      out.push({ t: t, text: line });
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  function fullLyricsView() {
    var box = els.lyricBox;
    if (state.ly.length) {
      box.innerHTML = state.ly.map(function (l, i) {
        return '<p data-ly="' + i + '">' + esc(l.text) + "</p>";
      }).join("");
    } else {
      box.innerHTML = '<p class="p-lyric-none">No lyrics for this one.</p>';
    }
    els.lyricsBtn.classList.toggle("is-on", state.ly.length > 0 && !els.lyricsPanel.hidden);
  }

  function tickLyrics() {
    if (!state.ly.length || !audio) return;
    var t = audio.currentTime || 0;
    var i = 0;
    for (var j = 0; j < state.ly.length; j++) {
      if (state.ly[j].t <= t) i = j;
      else break;
    }
    var box = els.lyricBox;
    var els2 = box.querySelectorAll("p[data-ly]");
    if (!els2.length) return;
    els2.forEach(function (p) {
      p.classList.toggle("is-on", (+p.getAttribute("data-ly")) === i);
    });
    var cur = els2[i];
    if (cur && box.scrollHeight > box.clientHeight) {
      var target = cur.offsetTop - box.clientHeight / 2 + cur.clientHeight / 2;
      box.scrollTop = Math.max(0, target);
    }
  }

  /* ---------- queue panel ---------- */

  function renderQueue() {
    var box = els.queueList;
    if (!state.queue.length) {
      box.innerHTML = '<p class="p-lyric-none">Queue is empty - play something.</p>';
      return;
    }
    box.innerHTML = state.queue.map(function (m, i) {
      return '<div class="p-qrow' + (i === state.idx ? " is-cur" : "") + '" data-qjump="' + i + '">' +
        '<span class="p-qnum">' + (i + 1) + "</span>" +
        '<span class="p-qname">' + esc(m.name) + "</span>" +
        '<span class="p-qsub">' + esc((m.artist || []).join(" · ")) + "</span></div>";
    }).join("");
    box.querySelectorAll("[data-qjump]").forEach(function (el) {
      el.addEventListener("click", function () {
        loadTrack(+el.getAttribute("data-qjump"), true);
        els.queuePanel.hidden = true;
      });
    });
  }

  /* ---------- popups ---------- */

  function closePops(keep) {
    [els.tunePop, els.lyricsPanel, els.queuePanel].forEach(function (p) {
      if (p && p !== keep) p.hidden = true;
    });
  }

  function togglePop(pop) {
    var open = pop.hidden;
    closePops(open ? pop : null);
    pop.hidden = !open;
  }

  /* ---------- init ---------- */

  function bind() {
    els.play.addEventListener("click", togglePlay);
    els.next.addEventListener("click", function () { next(); });
    els.prev.addEventListener("click", prev);

    els.shuffle.addEventListener("click", function () {
      state.shuffle = !state.shuffle;
      els.shuffle.classList.toggle("is-on", state.shuffle);
    });

    els.repeat.addEventListener("click", function () {
      state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
      var label = { off: "Repeat: off", all: "Repeat: all", one: "Repeat: one" }[state.repeat];
      els.repeat.title = label;
      els.repeat.setAttribute("aria-label", label);
      els.repeat.classList.toggle("is-on", state.repeat !== "off");
    });

    els.seek.addEventListener("input", function () {
      state.dragging = true;
      var d = audio && isFinite(audio.duration) ? audio.duration : 0;
      els.cur.textContent = fmt((+els.seek.value) / 1000 * d);
    });
    els.seek.addEventListener("change", function () {
      var d = audio && isFinite(audio.duration) ? audio.duration : 0;
      if (audio && d) audio.currentTime = (+els.seek.value) / 1000 * d;
      state.dragging = false;
    });

    els.vol.addEventListener("input", function () {
      state.vol = +els.vol.value;
      state.muted = state.vol === 0;
      applyVol();
      savePrefs();
    });
    els.mute.addEventListener("click", function () {
      state.muted = !state.muted;
      els.mute.classList.toggle("is-on", state.muted);
      applyVol();
      savePrefs();
    });

    els.pitch.addEventListener("input", function () {
      state.pitch = +els.pitch.value;
      applyTempo();
      savePrefs();
    });
    els.speed.addEventListener("input", function () {
      state.speed = (+els.speed.value) / 100;
      applyTempo();
      savePrefs();
    });
    els.tuneReset.addEventListener("click", function () {
      els.pitch.value = 0; state.pitch = 0;
      els.speed.value = 100; state.speed = 1;
      applyTempo();
      savePrefs();
    });

    els.tuneBtn.addEventListener("click", function () { togglePop(els.tunePop); });
    els.lyricsBtn.addEventListener("click", function () { togglePop(els.lyricsPanel); });
    els.queueBtn.addEventListener("click", function () { togglePop(els.queuePanel); });
    els.lyricsX.addEventListener("click", function () { els.lyricsPanel.hidden = true; });
    els.queueX.addEventListener("click", function () { els.queuePanel.hidden = true; });
    if (els.profileBack) els.profileBack.addEventListener("click", renderHome);

    document.addEventListener("click", function (e) {
      var inPop = [els.tunePop, els.lyricsPanel, els.queuePanel].some(function (p) {
        return !p.hidden && (p.contains(e.target) || e.target === els.tuneBtn || e.target === els.lyricsBtn || e.target === els.queueBtn);
      });
      if (!inPop) closePops(null);
    });

    // Search
    els.q.addEventListener("input", function () {
      els.qClear.hidden = els.q.value.length === 0;
    });
    els.q.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && els.q.value.trim()) doSearch(els.q.value.trim());
    });
    els.qClear.addEventListener("click", function () {
      els.q.value = "";
      els.qClear.hidden = true;
      renderHome();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key !== " " && e.key !== "Spacebar") return;
      var el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (state.viewHidden) return;
      e.preventDefault();
      togglePlay();
    });

    audio.addEventListener("play", function () { setPlayingUI(true); });
    audio.addEventListener("pause", function () { setPlayingUI(false); });
    audio.addEventListener("ended", function () { next(); });
    audio.addEventListener("timeupdate", function () {
      if (state.dragging) return;
      var d = isFinite(audio.duration) ? audio.duration : 0;
      els.seek.value = d ? Math.round((audio.currentTime / d) * 1000) : 0;
      els.cur.textContent = fmt(audio.currentTime);
      els.dur.textContent = fmt(d);
      tickLyrics();
    });
    audio.addEventListener("loadedmetadata", function () {
      if (isFinite(audio.duration)) {
        els.dur.textContent = fmt(audio.duration);
        els.seek.value = audio.currentTime ? Math.round((audio.currentTime / audio.duration) * 1000) : 0;
      }
    });
    audio.addEventListener("error", function () {
      var meta = state.queue[state.idx];
      if (meta) toast("Couldn't load: " + meta.name);
      setTimeout(function () { if (state.queue.length) next(true); }, 900);
    });
  }

  function applyVol() {
    if (!audio) return;
    audio.muted = state.muted;
    audio.volume = Math.max(0, Math.min(1, state.vol / 100));
    els.vol.value = state.muted ? 0 : state.vol;
    els.mute.classList.toggle("is-on", state.muted);
  }

  function doSearch(q) {
    showSearch(q);
  }

  function render() {
    if (!els.home) return; // not the music page (guard)
    // Re-run whatever page the user is on; search box text persists.
    if (!els.search.textContent) renderHome();
  }

  function init() {
    readPrefs();
    els = {
      q: $("music-q"), qClear: $("music-q-clear"),
      home: $("music-home"), results: $("music-results"), profile: $("music-profile"),
      profileBack: $("mprofile-back"),
      empty: $("music-empty"), emptyHint: $("music-empty-hint"),
      player: $("music-player"), pArt: $("player-art"),
      title: $("player-title"), artist: $("player-artist"),
      play: $("p-play"), prev: $("p-prev"), next: $("p-next"),
      shuffle: $("p-shuffle"), repeat: $("p-repeat"),
      seek: $("p-seek"), cur: $("p-cur"), dur: $("p-dur"),
      vol: $("p-vol"), mute: $("p-mute"),
      tuneBtn: $("p-tune"), tunePop: $("p-tune-pop"),
      pitch: $("p-pitch"), pitchV: $("p-pitch-v"),
      speed: $("p-speed"), speedV: $("p-speed-v"), tuneReset: $("p-tune-reset"),
      lyricsBtn: $("p-lyrics"), lyricsPanel: $("p-lyrics-panel"), lyricsX: $("p-lyrics-x"), lyricBox: $("p-lyric-box"),
      queueBtn: $("p-queue"), queuePanel: $("p-queue-panel"), queueX: $("p-queue-x"), queueList: $("p-queue-list"),
      toast: $("p-toast"), search: $("music-q")
    };
    audio = $("music-audio");
    if (!audio || !els.home) return;
    var view = document.querySelector('.view[data-view="music"]');
    state.viewHidden = view ? !view.classList.contains("is-visible") : true;
    if (view) {
      var obs = new MutationObserver(function () {
        state.viewHidden = !view.classList.contains("is-visible");
      });
      obs.observe(view, { attributes: true, attributeFilter: ["class"] });
    }
    bind();
    applyVol();
    applyTempo();
    els.pitch.value = state.pitch;
    els.speed.value = Math.round(state.speed * 100);
    els.shuffle.classList.toggle("is-on", state.shuffle);
    els.repeat.classList.toggle("is-on", state.repeat !== "off");
    renderHome();
  }

  /* Music data for the global search dropdown: none (live search only). */
  window.ChalkMusic = [];

  /* Called by app.js whenever the Music tab is opened. */
  window.ChalkleMusic = {
    render: function () {
      if (state.idx < 0) renderHome();
      else highlightRows();
    },
    play: playList,
    retry: function () {
      state.idx = -1;
      renderHome();
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();