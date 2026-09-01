/* Live TV: channels live in livetv.json on the server (never in the page).
   The grid comes from GET /api/live-tv and every stream plays through this
   server's HLS relay (/api/live-tv/<id>), so upstream URLs stay server-side.
   Admins manage channels from Settings -> Live TV. Self-contained, mirrors
   partners.js (same admin gate), but persists through the backend instead of
   localStorage. */
(function () {
  "use strict";

  var ADMIN_KEY = "chalkle-admin-unlocked"; /* same key app.js uses for the admin panel */
  var CAT_KEY = "chalkle-livetv-cat";       /* remembered category filter */

  var state = { channels: [], admin: [], cat: "all", q: "", hls: null, sports: [], sport: "all", matches: [] };

  var SPORT_KEY = "chalkle-livetv-sport"; /* remembered sport filter */

  function isAdmin() {
    try { return localStorage.getItem(ADMIN_KEY) === "1"; } catch (e) { return false; }
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function letterOf(name) {
    return String(name || "?").trim().charAt(0).toUpperCase() || "?";
  }

  function notice(msg) {
    var box = document.getElementById("toast-box");
    if (!box) return;
    var t = el("div", "toast", msg);
    box.appendChild(t);
    setTimeout(function () { t.classList.add("is-out"); }, 2200);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2700);
  }

  function setStatus(text, cls) {
    var box = document.getElementById("livetv-status");
    var txt = document.getElementById("livetv-status-txt");
    if (box) box.className = "cloud-status" + (cls ? " is-" + cls : "");
    if (txt) txt.textContent = text;
  }

  /* ---------- data ---------- */

  function load() {
    setStatus("loading channels", "busy");
    return fetch("/api/live-tv", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.channels = (j && Array.isArray(j.channels)) ? j.channels : [];
        if (!state.channels.length && j && j.error) setStatus("no channels yet", "offline");
        render();
      })
      .catch(function () {
        setStatus("could not load channels", "offline");
        render();
      });
  }

  function loadAdmin() {
    return fetch("/api/live-tv/admin", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.admin = (j && Array.isArray(j.channels)) ? j.channels : [];
        refreshAdminList();
      })
      .catch(function () { state.admin = []; refreshAdminList(); });
  }

  function saveAdmin() {
    setStatus("saving channels", "busy");
    return fetch("/api/live-tv/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channels: state.admin })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) {
          notice("Saved " + j.count + " channel" + (j.count === 1 ? "" : "s") + ".");
          return load().then(loadAdmin);
        }
        notice((j && j.error) ? "Save failed: " + j.error : "Save failed.");
        return null;
      })
      .catch(function () { notice("Save failed - is the server up?"); });
  }

  /* ---------- rendering ---------- */

  function categories() {
    var seen = {};
    state.channels.forEach(function (c) { seen[c.category || "Other"] = true; });
    return Object.keys(seen).sort(function (a, b) { return a.localeCompare(b); });
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return state.channels.filter(function (c) {
      if (state.cat !== "all" && (c.category || "Other") !== state.cat) return false;
      if (!q) return true;
      return (c.name || "").toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderCats() {
    var box = document.getElementById("livetv-cats");
    if (!box) return;
    var cats = categories();
    var html = '<button class="chip' + (state.cat === "all" ? " is-active" : "") + '" data-livetv-cat="all">All</button>';
    cats.forEach(function (c) {
      html += '<button class="chip' + (state.cat === c ? " is-active" : "") + '" data-livetv-cat="' + esc(c) + '">' + esc(c) + "</button>";
    });
    box.innerHTML = html;
    box.querySelectorAll("[data-livetv-cat]").forEach(function (chip) {
      chip.addEventListener("click", function () {
        state.cat = chip.dataset.livetvCat;
        try { localStorage.setItem(CAT_KEY, state.cat); } catch (e) { /* ignore */ }
        renderCats();
        renderGrid();
      });
    });
  }

  function renderGrid() {
    var grid = document.getElementById("livetv-grid");
    var empty = document.getElementById("livetv-empty");
    var meta = document.getElementById("livetv-meta");
    if (!grid) return;

    var items = filtered();
    if (meta) meta.textContent = (state.matches.length ? state.matches.length + (state.matches.length === 1 ? " match" : " matches") + "+ " : "") + items.length + (items.length === 1 ? " channel" : " channels");

    if (!items.length) {
      grid.innerHTML = "";
      if (empty) empty.hidden = false;
      setStatus(state.channels.length ? "no matches" : "no channels yet", state.channels.length ? "busy" : "offline");
      return;
    }
    if (empty) empty.hidden = true;
    setStatus("live now", "online");

    grid.innerHTML = "";
    items.forEach(function (c) {
      var card = el("button", "livetv-card" + (c.live !== false ? " is-live" : ""));
      card.type = "button";
      card.title = "Stream " + (c.name || "Channel");

      var preview = el("div", "livetv-card-preview");
      if (c.logo) {
        var img = document.createElement("img");
        img.src = c.logo;
        img.alt = "";
        img.loading = "lazy";
        preview.appendChild(img);
      } else {
        var fallbackLetter = el("span", "livetv-preview-letter", letterOf(c.name));
        preview.appendChild(fallbackLetter);
      }

      var liveBadge = el("span", "livetv-card-live-badge", "LIVE");
      var playOverlay = el("div", "livetv-card-play-overlay");
      playOverlay.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
      preview.append(liveBadge, playOverlay);

      var meta = el("div", "livetv-card-meta");
      var name = el("div", "livetv-card-name", c.name || "Channel");
      var cat = el("div", "livetv-card-cat", c.category || "Other");
      meta.append(name, cat);

      card.append(preview, meta);
      card.addEventListener("click", function () {
        document.querySelectorAll(".livetv-card").forEach(function (x) { x.classList.remove("is-selected"); });
        card.classList.add("is-selected");
        openPlayer(c);
      });
      grid.appendChild(card);
    });
  }

  function render() {
    renderCats();
    renderGrid();
  }

  /* ---------- player ---------- */

  function openPlayer(ch) {
    var heroTitle = document.getElementById("livetv-hero-title");
    var heroCat = document.getElementById("livetv-hero-cat");
    var video = document.getElementById("livetv-hero-video");
    var placeholder = document.getElementById("livetv-hero-placeholder");
    var msg = document.getElementById("livetv-hero-msg");
    var stage = document.getElementById("livetv-hero-stage");

    if (!video) return;

    if (heroTitle) heroTitle.textContent = ch.name || "Live Channel";
    if (heroCat) heroCat.textContent = ch.category || "Live Stream";
    if (placeholder) placeholder.hidden = true;
    if (msg) msg.hidden = true;
    video.style.display = "block";

    if (stage) stage.scrollIntoView({ behavior: "smooth", block: "nearest" });

    var cleanup = function () { if (state.hls) { try { state.hls.destroy(); } catch (e) { /* ignore */ } state.hls = null; } };

    var streamUrl = ch.stream || ch.streamUrl;
    if (window.Hls && Hls.isSupported()) {
      cleanup();
      var hls = new Hls({
        lowLatencyMode: true,
        maxBufferLength: 30,
        liveSyncDurationCount: 2,
        backBufferLength: 30
      });
      state.hls = hls;
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      /* Only start playback once the manifest is actually parsed - calling
         play() before data exists can silently consume the autoplay grant. */
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        video.play().catch(function () { /* autoplay handled */ });
      });
      /* hls.js live-sync seeks to the live edge as it catches up; the seek can
         leave the video paused with plenty of buffer ahead. Resume it so the
         stream never dead-ends mid-playback. */
      video.addEventListener("seeked", function resumeLive() {
        if (!video.paused || video.ended) return;
        if (video.buffered.length && video.buffered.end(video.buffered.length - 1) > video.currentTime + 1) {
          video.play().catch(function () { /* handled */ });
        }
      });
      hls.on(Hls.Events.ERROR, function (evt, data) {
        if (!data || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          showPlayerMsg(msg, "This channel stream is currently unavailable.");
          cleanup();
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      cleanup();
      video.src = streamUrl;
      video.play().catch(function () { /* autoplay handled */ });
    } else {
      showPlayerMsg(msg, "This browser can't play HLS live streams directly.");
    }
  }

  function showPlayerMsg(msg, text) {
    if (!msg) return;
    msg.textContent = text;
    msg.hidden = false;
  }

  function closePlayer() {
    var modal = document.getElementById("livetv-player");
    var video = document.getElementById("livetv-video");
    var frame = document.getElementById("livetv-embed-frame");
    if (state.hls) { try { state.hls.destroy(); } catch (e) { /* ignore */ } state.hls = null; }
    if (video) { try { video.pause(); } catch (e) { /* ignore */ } video.removeAttribute("src"); video.load(); }
    if (frame) { frame.removeAttribute("src"); frame.style.display = "none"; }
    if (modal) modal.hidden = true;
    document.body.style.overflow = "";
  }

  /* ---------- live sports (streamed.pk via this server) ---------- */

  function kickoffLabel(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var tom = new Date(now);
    tom.setDate(now.getDate() + 1);
    var sameTom = d.toDateString() === tom.toDateString();
    var time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (sameDay) return "Today " + time;
    if (sameTom) return "Tomorrow " + time;
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
  }

  function sportLabel(id) {
    for (var i = 0; i < state.sports.length; i++) {
      if (state.sports[i].id === id) return state.sports[i].name || id;
    }
    return id;
  }

  function matchArt(m) {
    if (m.poster) {
      return '<img class="livetv-match-post" src="' + esc(m.poster) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.onerror=null;this.remove()">';
    }
    var h = m.teams && m.teams.home ? m.teams.home : { name: "?", badge: null };
    var a = m.teams && m.teams.away ? m.teams.away : { name: "?", badge: null };
    var hb = h.badge
      ? '<img class="livetv-match-badge" src="' + esc(h.badge) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.onerror=null;this.remove()">'
      : '<span class="livetv-match-badge livetv-match-badge-letter">' + esc((h.name || "?").charAt(0).toUpperCase()) + "</span>";
    var ab = a.badge
      ? '<img class="livetv-match-badge" src="' + esc(a.badge) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.onerror=null;this.remove()">'
      : '<span class="livetv-match-badge livetv-match-badge-letter">' + esc((a.name || "?").charAt(0).toUpperCase()) + "</span>";
    return '<div class="livetv-match-badges"><span class="livetv-match-badge-wrap">' + hb +
      '<span class="livetv-match-team-name">' + esc(h.name || "") + "</span></span>" +
      '<span class="livetv-match-vs">vs</span>' +
      '<span class="livetv-match-badge-wrap">' + ab +
      '<span class="livetv-match-team-name">' + esc(a.name || "") + "</span></span></div>";
  }

  function matchCard(m) {
    var live = (m.date || 0) <= Date.now();
    var tags = '<span class="livetv-match-tag' + (live ? " is-live" : " is-up") + '">' +
      (live ? "LIVE" : "UP NEXT") + "</span>";
    if (m.hd) tags += '<span class="livetv-match-tag is-hd">HD</span>';
    if (m.lang) tags += '<span class="livetv-match-tag is-lang">' + esc(m.lang) + "</span>";
    var cats = m.category ? sportLabel(m.category) : "";
    return '<button class="livetv-match" type="button" data-match="' + esc(m.id || "") + '" title="Watch\n' + esc((m.title || "").replace(/\n/g, " ")) + '">' +
      '<span class="livetv-match-art">' + matchArt(m) +
      '<span class="livetv-match-blink"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg><span>Watch</span></span></span>' +
      '<span class="livetv-match-body">' +
      '<span class="livetv-match-title">' + esc(m.title || "") + "</span>" +
      '<span class="livetv-match-meta">' +
      '<span class="livetv-match-time">' + esc(kickoffLabel(m.date)) + "</span>" +
      (cats ? '<span class="livetv-match-cat">' + esc(cats) + "</span>" : "") +
      "</span>" +
      '<span class="livetv-match-tags">' + tags + "</span>" +
      "</span></button>";
  }

  function openMatch(m) {
    if (!m || !m.embed) { notice("No playable stream for that match right now."); return; }
    var modal = document.getElementById("livetv-player");
    var frame = document.getElementById("livetv-embed-frame");
    var video = document.getElementById("livetv-video");
    var title = document.getElementById("livetv-player-title");
    if (!modal || !frame) return;
    if (title) title.textContent = m.title || "Live match";
    if (state.hls) { try { state.hls.destroy(); } catch (e) { /* ignore */ } state.hls = null; }
    if (video) { try { video.pause(); } catch (e) { /* ignore */ } video.removeAttribute("src"); video.load(); }
    frame.style.display = "block";
    frame.src = m.embed;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function renderMatches() {
    var grid = document.getElementById("livetv-matches");
    var empty = document.getElementById("livetv-matches-empty");
    var note = document.getElementById("livetv-sports-note");
    if (!grid) return;
    var items = state.matches;
    if (note) note.textContent = items.length
      ? items.length + (items.length === 1 ? " live match" : " live matches") + " ready to watch"
      : "No matches right now";
    if (empty) empty.hidden = items.length > 0;
    var meta = document.getElementById("livetv-meta");
    if (meta) meta.textContent = (items.length ? items.length + (items.length === 1 ? " match" : " matches") + " + " : "") + state.channels.length + (state.channels.length === 1 ? " channel" : " channels");
    grid.innerHTML = items.map(matchCard).join("");
    grid.querySelectorAll("[data-match]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var m = null;
        for (var i = 0; i < state.matches.length; i++) {
          if (state.matches[i].id === btn.dataset.match) { m = state.matches[i]; break; }
        }
        if (m) openMatch(m);
      });
    });
  }

  function loadMatches(silent) {
    var grid = document.getElementById("livetv-matches");
    var note = document.getElementById("livetv-sports-note");
    if (!silent) {
      if (grid) grid.innerHTML = '<div class="livetv-loading">Finding live matches…</div>';
      if (note) note.textContent = "Finding live matches…";
    }
    var url = "/api/livetv/matches" + (state.sport && state.sport !== "all" ? "?sport=" + encodeURIComponent(state.sport) : "");
    fetch(url, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.matches = (j && Array.isArray(j.matches)) ? j.matches : [];
        renderMatches();
      })
      .catch(function () {
        state.matches = [];
        renderMatches();
      });
  }

  /* Keep the LIVE list current: matches start and end all day, so silently
     re-fetch every few minutes in the background. Only the chips bar and the
     grid re-render; an open player modal is left alone. */
  var refreshTimer = null;
  function armRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(function () {
      var player = document.getElementById("livetv-player");
      if (player && !player.hidden) return;  // don't yank a stream out from under them
      loadMatches(true);
    }, 3 * 60 * 1000);
  }

  function renderSportChips() {
    var box = document.getElementById("livetv-sports-cats");
    if (!box) return;
    var html = '<button class="chip' + (state.sport === "all" ? " is-active" : "") + '" data-sport="all">All</button>';
    state.sports.forEach(function (s) {
      var id = s.id || "";
      html += '<button class="chip' + (state.sport === id ? " is-active" : "") + '" data-sport="' + esc(id) + '">' + esc(s.name || id) + "</button>";
    });
    box.innerHTML = html;
    box.querySelectorAll("[data-sport]").forEach(function (chip) {
      chip.addEventListener("click", function () {
        state.sport = chip.dataset.sport;
        try { localStorage.setItem(SPORT_KEY, state.sport); } catch (e) { /* ignore */ }
        renderSportChips();
        loadMatches();
      });
    });
  }

  function loadSports() {
    fetch("/api/livetv/sports", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.sports = (j && Array.isArray(j.sports)) ? j.sports : [];
        renderSportChips();
        loadMatches();
      })
      .catch(function () {
        state.sports = [];
        renderSportChips();
        loadMatches();
      });
  }

  /* ---------- admin ---------- */

  function openModal(ch) {
    if (!isAdmin()) { notice("Only admins can edit channels."); return; }
    var modal = document.getElementById("livetv-edit-modal");
    if (!modal) return;

    modal.dataset.editId = ch ? (ch.id || "") : "";
    document.getElementById("livetv-edit-title").textContent = ch ? "Edit channel" : "Add channel";
    document.getElementById("livetv-edit-name").value = ch ? (ch.name || "") : "";
    document.getElementById("livetv-edit-category").value = ch ? (ch.category || "") : "";
    document.getElementById("livetv-edit-logo").value = ch ? (ch.logo || "") : "";
    document.getElementById("livetv-edit-stream").value = ch ? (ch.streamUrl || "") : "";
    document.getElementById("livetv-edit-referer").value = ch ? (ch.referer || "") : "";
    document.getElementById("livetv-edit-ua").value = ch ? (ch.userAgent || "") : "";
    document.getElementById("livetv-edit-enabled").checked = ch ? (ch.enabled !== false) : true;

    modal.hidden = false;
    document.body.style.overflow = "hidden";
    document.getElementById("livetv-edit-name").focus();
  }

  function closeModal() {
    var modal = document.getElementById("livetv-edit-modal");
    if (modal) modal.hidden = true;
    document.body.style.overflow = "";
  }

  function onSaveChannel() {
    if (!isAdmin()) { notice("Only admins can edit channels."); return; }
    var modal = document.getElementById("livetv-edit-modal");
    var id = modal.dataset.editId || "";
    var name = document.getElementById("livetv-edit-name").value.trim();
    if (!name) { notice("Give the channel a name."); document.getElementById("livetv-edit-name").focus(); return; }

    var entry = {
      id: id,
      name: name,
      category: document.getElementById("livetv-edit-category").value.trim() || "Other",
      logo: document.getElementById("livetv-edit-logo").value.trim(),
      streamUrl: document.getElementById("livetv-edit-stream").value.trim(),
      referer: document.getElementById("livetv-edit-referer").value.trim(),
      userAgent: document.getElementById("livetv-edit-ua").value.trim(),
      enabled: document.getElementById("livetv-edit-enabled").checked
    };

    if (id) {
      for (var i = 0; i < state.admin.length; i++) {
        if (state.admin[i].id === id) { state.admin[i] = entry; break; }
      }
    } else {
      entry.id = "";
      state.admin.push(entry);
    }
    closeModal();
    saveAdmin();
  }

  function deleteChannel(ch) {
    if (!isAdmin()) return;
    if (!confirm('Remove "' + (ch.name || "Channel") + '"?')) return;
    state.admin = state.admin.filter(function (x) { return x.id !== ch.id; });
    saveAdmin();
  }

  function refreshAdminList() {
    var box = document.getElementById("admin-livetv-list");
    if (!box) return;
    if (!state.admin.length) {
      box.innerHTML = "<p class=\"empty-hint\">No channels yet. Add one above.</p>";
      return;
    }
    var rows = [];
    state.admin.slice().sort(function (a, b) {
      return (a.name || "").localeCompare(b.name || "");
    }).forEach(function (c) {
      var row = document.createElement("div");
      row.className = "admin-lib-row";
      var grip = document.createElement("span");
      grip.className = "admin-lib-icon";
      grip.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6.5" width="19" height="13" rx="2.5"/><path d="m10 10.5 5 2.75-5 2.75z"/></svg>';
      var info = document.createElement("span");
      info.className = "admin-lib-name";
      info.textContent = c.name || "Channel";
      info.title = c.name || "";
      var tag = document.createElement("span");
      tag.className = "admin-lib-tag";
      tag.textContent = c.category || "Other";
      var btnEdit = document.createElement("button");
      btnEdit.type = "button";
      btnEdit.className = "btn-ghost admin-lib-edit";
      btnEdit.textContent = "Edit";
      btnEdit.addEventListener("click", function () { openModal(c); });
      var btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "btn-ghost admin-lib-edit admin-lib-del";
      btnDel.textContent = "Delete";
      btnDel.addEventListener("click", function () { deleteChannel(c); });
      row.append(grip, info, tag, btnEdit, btnDel);
      rows.push(row);
    });
    box.innerHTML = "";
    rows.forEach(function (r) { box.appendChild(r); });
  }

  /* Hide nothing for regular users (channels are public), but keep the admin
     modal closed unless an admin opened it. */
  function applyAdminUI() {
    var modal = document.getElementById("livetv-edit-modal");
    if (modal && !isAdmin()) modal.hidden = true;
  }

  /* ---------- wiring ---------- */

  function init() {
    var grid = document.getElementById("livetv-grid");
    if (!grid) return;

    try { state.cat = localStorage.getItem(CAT_KEY) || "all"; } catch (e) { state.cat = "all"; }
    try { state.sport = localStorage.getItem(SPORT_KEY) || "all"; } catch (e) { state.sport = "all"; }

    var search = document.getElementById("livetv-search");
    if (search) {
      search.addEventListener("input", function () {
        state.q = search.value;
        renderGrid();
      });
    }

    var fsBtn = document.getElementById("livetv-hero-fs-btn");
    if (fsBtn) {
      fsBtn.addEventListener("click", function () {
        var video = document.getElementById("livetv-hero-video");
        if (!video) return;
        if (video.requestFullscreen) video.requestFullscreen();
        else if (video.webkitRequestFullscreen) video.webkitRequestFullscreen();
        else if (video.msRequestFullscreen) video.msRequestFullscreen();
      });
    }

    var modal = document.getElementById("livetv-edit-modal");
    if (modal) {
      modal.querySelectorAll("[data-livetv-close]").forEach(function (x) {
        x.addEventListener("click", closeModal);
      });
      var cancel = document.getElementById("livetv-edit-cancel");
      if (cancel) cancel.addEventListener("click", closeModal);
      var save = document.getElementById("livetv-edit-save");
      if (save) save.addEventListener("click", onSaveChannel);
    }

    var player = document.getElementById("livetv-player");
    if (player) {
      var close = document.getElementById("livetv-player-close");
      if (close) close.addEventListener("click", closePlayer);
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (!document.getElementById("livetv-player").hidden) closePlayer();
        if (!document.getElementById("livetv-edit-modal").hidden) closeModal();
      }
    });

    applyAdminUI();
    load();
    loadSports();
    armRefresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.ChalkleLiveTV = {
    render: render,
    refresh: render,
    load: load,
    addChannel: function () { openModal(null); },
    editChannel: openModal,
    refreshAdminList: refreshAdminList,
    applyAdminUI: applyAdminUI
  };
})();
