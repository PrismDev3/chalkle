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
    /* Link entries are games streamed on a web service this site doesn't
       host (e.g. Fortnite on GeForce NOW). They open in the launch chooser
       instead of creating a Stratus session. */
    var isLink = g.kind === "link";
    var action = isLink ? "Play" : "Stream";
    return (
      '<article class="card cloud-card' + (isLink ? " is-link" : "") + '">' +
      '<button class="fav-btn ' + (isFav ? "is-fav" : "") + '" data-cloud-fav="' + esc(g.key) + '" aria-label="' + (isFav ? "Remove favorite" : "Add favorite") + '" title="' + (isFav ? "Remove favorite" : "Add favorite") + '">' +
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6L7.1 19l.9-5.5-4-3.9 5.5-.8z"/></svg>' +
      "</button>" +
      '<button class="cloud-play" data-cloud-play="' + esc(g.key) + '" title="' + action + ' ' + esc(g.title) + '">' +
      '<span class="card-thumb">' + thumbHtml(g) + '<span class="quick-launch">' + action + "</span></span>" +
      '<span class="card-body">' +
      '<span class="card-main"><span class="card-title" title="' + esc(g.title + (g.desc ? " " + g.desc : "")) + '">' + esc(g.title) + "</span>" + cat + "</span>" +
      /* One quiet source badge in the card footer. The Stream/Play pill on
         the art is the action; repeating the word under the title was noise. */
      '<span class="card-side"><span class="card-source">' + (isLink ? "web" : "cloud") + "</span></span>" +
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
    /* The relay boots a throwaway cloud account per session, which can take
       a while and occasionally drops the stream. Retry once server-side is
       exhausted (the relay retries on IncompleteRead), then give up. */
    function attempt(n) {
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
          var queuedUuid = "";
          for (var i = 0; i < events.length; i++) {
            var ev = events[i];
            /* finished_queue means the game is ready; queue means the game is
               busy and pollQueue will wait it out. Both carry the session id. */
            if (ev.status === "finished_queue" && ev.uuid) return ev.uuid;
            if (ev.status === "queue" && ev.uuid) queuedUuid = ev.uuid;
            if (ev.status === "error") throw new Error(ev.error || "session failed");
          }
          if (queuedUuid) return queuedUuid;
          throw new Error("no session returned");
        });
      }).catch(function (err) {
        var msg = String(err && err.message || err);
        if (n > 0 && msg.indexOf("IncompleteRead") !== -1) {
          return sleep(1500).then(function () { return attempt(n - 1); });
        }
        /* Mirrors / static hosts serve the site but not the /cloud/v1 relay,
           so every session 404s there. Say so instead of a bare "HTTP 404". */
        if (/HTTP 404|Failed to fetch|NetworkError/i.test(msg)) {
          throw new Error("Cloud streaming only runs on the main Chalkle site. This mirror doesn't host the game servers - open the main site for cloud games.");
        }
        throw err;
      });
    }
    return attempt(1);
  }

  function pollQueue(uuid, tries) {
    /* The relay allows one getQueue poll every 3 seconds and abandons a
       queued session after 60s without a poll, so pace ourselves accordingly:
       3.2s spacing, up to ~10 minutes (upstream queues can be long). */
    if (tries >= 180) return Promise.reject(new Error("Server busy or offline (queue timeout)"));
    return sleep(3200).then(function () {
      return apiFetch("/cloud/v1/getQueue?uuid=" + encodeURIComponent(uuid), { method: "GET" })
        .then(function (res) {
          if (!res.ok) {
            /* "Too fast" polls are harmless - just wait and try again. */
            if (res.status === 429) return pollQueue(uuid, tries + 1);
            throw new Error("Server returned HTTP " + res.status);
          }
          return res.json();
        })
        .then(function (j) {
          if (j.status === "finished_queue") return;
          if (j.status === "queue" || j.status === "queued" || j.status === "pending") {
            return pollQueue(uuid, tries + 1);
          }
          throw new Error((j.error || "Session ended") + (j.queue_pos != null ? " (spot " + j.queue_pos + ")" : ""));
        });
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

  /* The cloud player opens in a fresh tab before the session exists (so
     Chromebook popup policy doesn't eat the window). Write real content into
     that tab immediately - a loading page while the session boots, and a
     clear error page if it fails - so it is never a blank about:blank tab. */
  function writePlayerPage(win, kind, g, msg) {
    if (!win || win.closed) return;
    var title = (g && g.title) || "Cloud Play";
    var body, sub;
    if (kind === "error") {
      body = "Couldn't start " + title;
      sub = (msg || "The session could not be created. Close this tab and try again.").slice(0, 300);
      /* The provider gates some titles behind a paid membership upstream.
         Offer the working alternative instead of a raw JSON blob. */
      if (msg === "MEMBERSHIP_REQUIRED") {
        body = title + " needs a membership";
        sub = "The game host now requires a paid account for this title, so it can't be streamed right now. The regular version may still work - check the Cloud tab for alternatives.";
      }
    } else {
      body = "Starting " + title;
      sub = "Preparing your session\u2026 this tab switches to the game when it's ready.";
    }
    try {
      var doc = win.document;
      doc.open();
      doc.write(
        '<!doctype html><html><head><meta charset="utf-8"><title>' + (kind === "error" ? "Couldn't start" : "Connecting") + '</title>' +
        '<style>html,body{height:100%;margin:0;background:#12101a;color:#f2eef7;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center}.box{text-align:center;max-width:420px;padding:24px}.spin{width:38px;height:38px;margin:0 auto 18px;border:3px solid rgba(255,61,129,.25);border-top-color:#ff3d81;border-radius:50%;animation:sp 1s linear infinite}.err{font-size:30px;margin-bottom:8px}h2{margin:0 0 8px;font-size:17px;color:#ff5d8f}p{margin:0;font-size:13.5px;color:#9aa0b4;line-height:1.5;word-break:break-word}.x{margin-top:18px;padding:9px 20px;border:none;border-radius:9px;background:#ff3d81;color:#fff;font-weight:700;font-size:13px;cursor:pointer}@keyframes sp{to{transform:rotate(360deg)}}</style>' +
        '</head><body><div class="box">' +
        (kind === "error" ? '<div class="err">\u26a0\ufe0f</div>' : '<div class="spin"></div>') +
        '<h2>' + esc(body) + '</h2><p>' + esc(sub) + '</p>' +
        (kind === "error" ? '<button class="x" onclick="window.close()">Close tab</button>' : '') +
        '</div></body></html>'
      );
      doc.close();
    } catch (e) { /* cross-origin/closed mid-write; nothing left to show */ }
  }

  /* Same-tab inline player: the game boots inside the Cloud tab instead of a
     new window. The panel mounts synchronously on click, the session
     bootstraps behind it, and the stage swaps to /cloud-play.html when the
     stream is ready. Exit via the X button, ESC, or browser Back. */
  var currentInlineExit = null;

  function mountInline(g) {
    var host = document.getElementById("cloud-player-host");
    if (!host) return null;
    var gesc = esc(g.title || "Cloud Play");
    host.innerHTML =
      '<div class="cloud-player-bar">' +
        '<span class="cloud-player-title">' + gesc + '</span>' +
        '<span class="cloud-player-status" id="cloud-player-status">Preparing session\u2026</span>' +
        '<button class="cloud-player-x" id="cloud-player-exit" type="button" aria-label="Exit game" title="Exit (Esc)">\u2715 Exit</button>' +
      '</div>' +
      '<div class="cloud-player-stage" id="cloud-player-stage"><div class="cloud-player-spin"></div></div>';
    host.hidden = false;
    var grid = document.getElementById("cloud-grid");
    if (grid) grid.hidden = true;
    var empty = document.getElementById("cloud-empty");
    if (empty) empty.hidden = true;

    function teardown() {
      host.hidden = true;
      host.innerHTML = "";   /* removing the iframe ends the WebRTC stream */
      var grid2 = document.getElementById("cloud-grid");
      if (grid2) grid2.hidden = false;
      currentInlineExit = null;
      if (location.hash.indexOf("#cloud-play=") === 0) {
        try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* file:// */ }
      }
    }
    currentInlineExit = teardown;
    var x = document.getElementById("cloud-player-exit");
    if (x) x.addEventListener("click", teardown);
    return {
      status: function (msg) { var el = document.getElementById("cloud-player-status"); if (el) el.textContent = msg; },
      ready: function (url) {
        var stage = document.getElementById("cloud-player-stage");
        if (!stage) return;
        stage.innerHTML = '<iframe class="cloud-player-frame" src="' + esc(url) + '" title="Cloud game" allow="' + ((window.ChalkleApi && ChalkleApi.iframeAllow) ? ChalkleApi.iframeAllow() : "fullscreen; picture-in-picture") + '" allowfullscreen></iframe>';
      },
      fail: function (msg) {
        var stage = document.getElementById("cloud-player-stage");
        if (stage) stage.innerHTML = '<div class="cloud-player-err"><h3>Couldn\'t start ' + gesc + '</h3><p>' + esc(String(msg || "").slice(0, 300)) + '</p><button class="cloud-player-x" id="cloud-player-err-back" type="button">Back</button></div>';
        var b = document.getElementById("cloud-player-err-back");
        if (b) b.addEventListener("click", teardown);
      }
    };
  }

  function play(key, playerWindow) {
    var g = byKey(key);
    if (!g) return;
    /* No popup window handed in + a host in the DOM = same-tab mode. */
    var ui = (!playerWindow && document.getElementById("cloud-player-host")) ? mountInline(g) : null;
    setStatus("Starting " + g.title, "busy");
    if (ui) ui.status("Preparing session\u2026");
    else writePlayerPage(playerWindow, "loading", g);
    createSession(g)
      .then(function (uuid) {
        setStatus("Waiting in queue for " + g.title, "busy");
        if (ui) ui.status("Waiting in queue\u2026 you are spot-holding, this can take a minute.");
        return pollQueue(uuid, 0).then(function () { return startGame(uuid); }).then(function () {
          setStatus("Launching " + g.title, "online");
          var url = playerUrl(g, uuid);
          if (ui) ui.ready(url);
          else if (playerWindow && !playerWindow.closed) playerWindow.location.replace(url);
          else window.open(url, "_blank", "noopener");
        });
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        if (msg === "MEMBERSHIP_REQUIRED") {
          msg = g.title + " now needs a paid membership on the game host, so it can't be streamed. Try the regular version from the Cloud tab.";
        }
        if (ui) ui.fail(msg);
        else writePlayerPage(playerWindow, "error", g, msg);
        setStatus("Could not start: " + msg, "offline");
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
          var g = byKey(playBtn.dataset.cloudPlay);
          /* Link entries (Fortnite via GeForce NOW) skip the Stratus session
             and go straight to the launch chooser so the proxy routes work. */
          if (g && g.kind === "link" && g.url) {
            if (window.ChalkleLaunch && window.ChalkleLaunch.openWithOptions) {
              window.ChalkleLaunch.openWithOptions(g.url, g.title || g.url);
            } else {
              window.open(g.url, "_blank", "noopener");
            }
            return;
          }
          /* Same tab by default: the inline panel mounts synchronously from
             the user's click so nothing is lost to popup policy. A popup
             path stays for embeds without the host element. */
          if (document.getElementById("cloud-player-host")) {
            try { history.replaceState(null, "", "#cloud-play=" + playBtn.dataset.cloudPlay); } catch (e) { /* file:// */ }
            play(playBtn.dataset.cloudPlay, null);
          } else {
            var playerWindow = window.open("about:blank", "_blank");
            play(playBtn.dataset.cloudPlay, playerWindow);
          }
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

  /* Exit the inline player on ESC and on browser Back (hash restore). */
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !currentInlineExit) return;
    var host = document.getElementById("cloud-player-host");
    if (host && !host.hidden) currentInlineExit();
  });
  window.addEventListener("hashchange", function () {
    if (currentInlineExit && location.hash.indexOf("#cloud-play=") !== 0) currentInlineExit();
  });
})();
