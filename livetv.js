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

  var state = { channels: [], admin: [], cat: "all", q: "", hls: null };

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
    if (meta) meta.textContent = items.length + (items.length === 1 ? " channel" : " channels");

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
      var name = el("span", "livetv-card-name", c.name || "Channel");
      var cat = el("span", "livetv-card-cat", c.category || "Other");
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
      video.play().catch(function () { /* autoplay handled */ });
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
    if (state.hls) { try { state.hls.destroy(); } catch (e) { /* ignore */ } state.hls = null; }
    if (video) { try { video.pause(); } catch (e) { /* ignore */ } video.removeAttribute("src"); video.load(); }
    if (modal) modal.hidden = true;
    document.body.style.overflow = "";
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
