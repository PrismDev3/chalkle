/* Chalkle Cloud Gaming tab.
   Games are streamed from a Stratus API server, one session per play. The
   most common setup is the built-in same-origin relay (serve-chalk.py forwards
   /cloud/v1/* to a local Stratus), so no CORS or mixed-content ever appears;
   a standalone server URL works too via the Cloud settings panel.

   Play flow (Stratus v1 API):
     POST /cloud/v1/createSession {game_key}   -> NDJSON stream of events
     GET  /cloud/v1/getQueue?uuid=             -> poll until finished_queue
     POST /cloud/v1/startGame {uuid}           -> WebRTC credentials
     then open the player (cloud-play.html) which reads embed-data + signaling */

(function () {
  "use strict";

  var CFG_KEY = "chalkle-cloud-cfg-v1";
  var FAVS_KEY = "chalkle-cloud-favs-v1";
  var DEFAULT_CFG = { base: "", key: "" };

  var games = Array.isArray(window.ChalkCloudGames) ? window.ChalkCloudGames.slice() : [];
  var favs = readJson(FAVS_KEY, {});
  var state = { filter: "all", genre: "", query: "" };
  var genreChipsBuilt = false;

  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw) || fallback;
    } catch (e) { /* no storage */ }
    return fallback;
  }

  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* no storage */ }
  }

  function cfg() {
    return Object.assign({}, DEFAULT_CFG, readJson(CFG_KEY, {}));
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function byKey(key) {
    for (var i = 0; i < games.length; i++) {
      if (games[i] && games[i].key === key) return games[i];
    }
    return null;
  }

  /* API calls always go to the same-origin relay (/cloud/v1/*), which forwards
     to the configured Stratus backend server-side. The browser never talks to
     the Stratus host directly, so no CORS or mixed-content ever appears. */
  function apiUrl(path) {
    return window.ChalkleApi ? window.ChalkleApi.url(path) : path;
  }

  /* ---------------- Catalog rendering ---------------- */

  function filtered() {
    var q = state.query.trim().toLowerCase();
    var out = games.filter(function (g) {
      if (state.filter === "favorites" && !favs[g.key]) return false;
      if (state.genre && (g.category !== state.genre) &&
          !(g.tags || []).some(function (t) { return t === state.genre; })) return false;
      if (q) {
        var hay = (g.title + " " + (g.category || "") + " " + (g.tags || []).join(" ")).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    return out.sort(function (a, b) {
      return (a.title || "").toLowerCase().localeCompare((b.title || "").toLowerCase());
    });
  }

  function genreList() {
    var counts = {};
    games.forEach(function (g) {
      (g.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 12);
  }

  function tilePalette(key) {
    var PAL = [["#1d6f5c", "#0e3a30"], ["#1557b0", "#0a2c5e"], ["#7a3fd0", "#3a1a66"],
               ["#c25e00", "#5e2a00"], ["#b31412", "#5c0a09"], ["#8a5a24", "#3c250c"]];
    var n = 0;
    for (var i = 0; i < key.length; i++) n = (n * 31 + key.charCodeAt(i)) >>> 0;
    return PAL[n % PAL.length];
  }

  function thumbHtml(g) {
    var src = g.img || g.cover || "";
    if (src) {
      return '<img class="thumb-art" src="' + esc(src) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">' +
        '<span class="thumb-letter">' + esc((g.title || "?").charAt(0).toUpperCase()) + "</span>";
    }
    var pal = tilePalette(g.key);
    return '<span class="thumb-letter cloud-tile" style="background:' + pal[0] + '">' +
      esc((g.title || "?").charAt(0).toUpperCase()) + "</span>";
  }

  function cloudCard(g) {
    var isFav = !!favs[g.key];
    var cat = g.category ? '<span class="card-cat">' + esc(g.category) + "</span>" : "";
    return (
      '<article class="card cloud-card">' +
      '<button class="fav-btn ' + (isFav ? "is-fav" : "") + '" data-cloud-fav="' + esc(g.key) + '" aria-label="' + (isFav ? "Remove favorite" : "Add favorite") + '" title="' + (isFav ? "Remove favorite" : "Add favorite") + '">' +
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6L7.1 19l.9-5.5-4-3.9 5.5-.8z"/></svg>' +
      "</button>" +
      '<button class="cloud-play" data-cloud-play="' + esc(g.key) + '" title="Stream ' + esc(g.title) + '">' +
      '<span class="card-thumb">' + thumbHtml(g) + '<span class="quick-launch">Stream</span></span>' +
      '<span class="card-body">' +
      '<span class="card-main"><span class="card-title" title="' + esc(g.title + (g.desc ? " " + g.desc : "")) + '">' + esc(g.title) + "</span>" + cat + "</span>" +
      '<span class="card-side"><span class="card-source">cloud</span><span class="card-count">stream</span></span>' +
      "</span>" +
      "</button>" +
      "</article>"
    );
  }

  function renderGenres() {
    var box = document.getElementById("cloud-genres");
    if (!box) return;
    var genres = genreList();
    if (!genreChipsBuilt) {
      genreChipsBuilt = true;
      box.innerHTML =
        '<button class="chip is-active" data-cloud-genre="all">All genres</button>' +
        genres.map(function (t) {
          return '<button class="chip" data-cloud-genre="' + esc(t) + '">' + esc(t) + "</button>";
        }).join("");
    }
    box.hidden = genres.length < 2;
    box.querySelectorAll("[data-cloud-genre]").forEach(function (chip) {
      var val = chip.dataset.cloudGenre;
      chip.classList.toggle("is-active", val === (state.genre || "all"));
    });
  }

  function setStatus(text, cls) {
    var box = document.getElementById("cloud-status");
    var txt = document.getElementById("cloud-status-txt");
    if (box) box.className = "cloud-status" + (cls ? " is-" + cls : "");
    if (txt) txt.textContent = text;
  }

  function checkServer() {
    var box = document.getElementById("cloud-status");
    if (!box) return;
    fetch(apiUrl("/cloud/health"), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) setStatus("server online", "online");
        else if (j && j.error) setStatus(j.error, "offline");
        else setStatus("server not reachable", "offline");
      })
      .catch(function () { setStatus("server not reachable", "offline"); });
  }

  function render() {
    var grid = document.getElementById("cloud-grid");
    var empty = document.getElementById("cloud-empty");
    var meta = document.getElementById("cloud-meta");
    if (!grid || !empty) return;

    var items = filtered();
    if (meta) {
      meta.textContent = items.length + (items.length === 1 ? " game" : " games");
      meta.classList.toggle("has-content", items.length > 0);
    }
    renderGenres();

    if (!items.length) {
      grid.innerHTML = "";
      empty.hidden = false;
      setStatus(state.filter === "favorites" && !hasFavs() ? "no saved games yet" : "catalog loaded", hasFavs() ? "online" : "busy");
      return;
    }
    empty.hidden = true;
    grid.innerHTML = items.map(cloudCard).join("");
    setStatus("server check", "busy");
    checkServer();
  }

  function hasFavs() {
    for (var k in favs) { if (favs[k]) return true; }
    return false;
  }

  /* ---------------- Session flow ---------------- */

  function apiFetch(path, opts) {
    var headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    /* No client API key is ever sent: the relay injects the configured key. */
    return fetch(apiUrl(path), Object.assign({}, opts, { headers: headers }));
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function readNdjson(text) {
    var events = [];
    String(text).split("\n").forEach(function (line) {
      line = line.trim();
      if (!line) return;
      try { events.push(JSON.parse(line)); } catch (e) { /* skip noise */ }
    });
    return events;
  }

  function createSession(g) {
    return apiFetch("/cloud/v1/createSession", {
      method: "POST",
      body: JSON.stringify({ game_key: g.key })
    }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) {
          var msg = "HTTP " + res.status;
          try { msg = JSON.parse(text).error || msg; } catch (e) { /* keep */ }
          throw new Error(msg);
        }
        var events = readNdjson(text);
        for (var i = 0; i < events.length; i++) {
          var ev = events[i];
          if (ev.status === "finished_queue" && ev.uuid) return ev.uuid;
          if (ev.status === "error") throw new Error(ev.error || "session failed");
        }
        throw new Error("no session returned");
      });
    });
  }

  function pollQueue(uuid, tries) {
    /* Cloud queues can legitimately take more than a minute. Five 1.5s polls
       made a healthy session look dead, especially through a Chromebook
       tunnel. Keep polling for about five minutes, with a small backoff. */
    if (tries >= 100) return Promise.reject(new Error("Server busy or offline (queue timeout)"));
    return apiFetch("/cloud/v1/getQueue?uuid=" + encodeURIComponent(uuid), { method: "GET" })
      .then(function (res) {
        if (!res.ok) throw new Error("Server returned HTTP " + res.status);
        return res.json();
      })
      .then(function (j) {
        if (j.status === "finished_queue") return;
        if (j.status === "queue" || j.status === "queued" || j.status === "pending") {
          return sleep(Math.min(5000, 1200 + tries * 80)).then(function () { return pollQueue(uuid, tries + 1); });
        }
        throw new Error((j.error || "Session ended") + (j.queue_pos != null ? " (spot " + j.queue_pos + ")" : ""));
      });
  }

  function startGame(uuid) {
    return apiFetch("/cloud/v1/startGame", { method: "POST", body: JSON.stringify({ uuid: uuid }) })
      .then(function (res) { return res.json().then(function (j) {
        if (!res.ok) throw new Error(j.error || "start failed");
        return j;
      }); });
  }

  function playerUrl(g, uuid) {
    /* The player is served by this site; it reads session data through the
       same relay, so it works no matter where the Stratus backend lives. The
       host param tells the player to point its signaling websocket back at
       THIS origin (the signal ws is also rewritten on the server side). */
    var name = encodeURIComponent(g.title || "Cloud Play");
    return (
      apiUrl("/cloud-play.html") + "?id=" + encodeURIComponent(uuid) +
      "&name=" + name + "&host=" + encodeURIComponent(location.host)
    );
  }

  function play(key, playerWindow) {
    var g = byKey(key);
    if (!g) return;
    setStatus("Starting " + g.title, "busy");
    createSession(g)
      .then(function (uuid) {
        setStatus("Waiting in queue for " + g.title, "busy");
        return pollQueue(uuid, 0).then(function () { return startGame(uuid); }).then(function () {
          setStatus("Launching " + g.title, "online");
          if (playerWindow && !playerWindow.closed) playerWindow.location.replace(playerUrl(g, uuid));
          else window.open(playerUrl(g, uuid), "_blank", "noopener");
        });
      })
      .catch(function (err) {
        if (playerWindow && !playerWindow.closed) playerWindow.close();
        setStatus("Could not start: " + (err && err.message ? err.message : err), "offline");
      });
  }

  /* ---------------- Event binding ---------------- */

  function bind() {
    var grid = document.getElementById("cloud-grid");
    if (grid) {
      grid.addEventListener("click", function (e) {
        var fav = e.target.closest ? e.target.closest("[data-cloud-fav]") : null;
        if (fav) {
          var k = fav.dataset.cloudFav;
          if (favs[k]) delete favs[k]; else favs[k] = true;
          saveJson(FAVS_KEY, favs);
          render();
          return;
        }
        var playBtn = e.target.closest ? e.target.closest("[data-cloud-play]") : null;
        if (playBtn) {
          /* Open synchronously from the user's click. Chromebook popup
             policy otherwise blocks the window after the queue promises. */
          var playerWindow = window.open("about:blank", "_blank");
          play(playBtn.dataset.cloudPlay, playerWindow);
        }
      });
    }

    var search = document.getElementById("cloud-search");
    if (search) {
      search.addEventListener("input", function () {
        state.query = search.value;
        render();
      });
    }

    document.querySelectorAll("[data-cloud-filter]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.filter = btn.dataset.cloudFilter || "all";
        document.querySelectorAll("[data-cloud-filter]").forEach(function (chip) {
          chip.classList.toggle("is-active", chip === btn);
        });
        render();
      });
    });

    var genres = document.getElementById("cloud-genres");
    if (genres) {
      genres.addEventListener("click", function (e) {
        var chip = e.target.closest ? e.target.closest("[data-cloud-genre]") : null;
        if (!chip) return;
        var val = chip.dataset.cloudGenre;
        state.genre = state.genre === val ? "" : (val === "all" ? "" : val);
        render();
      });
    }

    var save = document.getElementById("cloud-cfg-save");
    if (save) {
      var baseInput = document.getElementById("cloud-cfg-base");
      var keyInput = document.getElementById("cloud-cfg-key");
      if (baseInput) baseInput.value = cfg().base;
      if (keyInput) keyInput.value = cfg().key;
      save.addEventListener("click", function () {
        var payload = { base: (baseInput ? baseInput.value : "").trim(), key: (keyInput ? keyInput.value : "").trim() };
        var saved = document.getElementById("cloud-cfg-saved");
        fetch(apiUrl("/cloud/config"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (saved) {
            saved.textContent = j && j.ok ? "Saved" : ((j && j.error) || "Save failed");
            saved.hidden = false;
            setTimeout(function () { saved.hidden = true; }, 2400);
          }
          checkServer();
        }).catch(function () {
          if (saved) {
            saved.textContent = "Save failed";
            saved.hidden = false;
            setTimeout(function () { saved.hidden = true; }, 2400);
          }
        });
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }

  window.ChalkleCloud = { render: render, play: play, checkServer: checkServer };
})();
