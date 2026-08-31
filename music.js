/* Chalkle Music.
   Full-length music from public mirrors: search, trending, playback, queue.
   No server, no accounts, no ads, no cuts. Streams are resolved through a
   rotating list of Piped instances, byte-verified before they touch the
   <audio> element, with Invidious as the last-resort source. */

(function () {
  "use strict";

  /* ---------- Mirrors (public, working as of writing) ---------- */

  var PIPED = [
    "pipedapi.adminforge.de",
    "pipedapi.kavin.rocks",
    "pipedapi.reallyaweso.me"
  ];

  var INVIDIOUS = [
    "invidious.flokinet.to",
    "invidious.nerdvpn.de",
    "inv.nadeko.net",
    "invidious.f5.si",
    "invidious.tiekoetter.com"
  ];

  var VIDEO_HOSTS = [
    "https://www.youtube-nocookie.com/embed/",
    "https://www.youtube.com/embed/"
  ];

  /* When opened straight from the filesystem, window.location.origin is the
     literal string "null", which breaks YouTube's origin param (needs a real
     URL). Fall back to a plausible host so the embed validates cleanly. */
  function videoOrigin() {
    var o = window.location.origin;
    if (!o || o === "null" || o.indexOf("://") === -1) return "http://localhost";
    return o;
  }

  var COOLDOWN_MS = 20000;
  var TIMEOUT_MS = 12000;
  var CORS_RELAYS = [
    "https://r.jina.ai/http://"
  ];

  /* Instances verified to send Access-Control-Allow-Origin:* - only these can
     be fetched directly from the browser. Everyone else is fetched through
     the relay chain directly (no doomed direct attempt that just fills the
     console with CORS errors). */
  var DIRECT_CORS = { "invidious.flokinet.to": true };

  var pipedCursor = 0;
  var invCursor = 0;
  var pipedCooldown = {};
  var invCooldown = {};

  /* Small in-memory result cache so re-searching the same query (or bouncing
     between tabs) is instant instead of hitting the mirrors again. */
  var CACHE_TTL = 60000;
  var resultCache = {};

  function cacheGet(key) {
    var hit = resultCache[key];
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
    return null;
  }

  function cacheSet(key, value) {
    resultCache[key] = { at: Date.now(), value: value };
  }

  /* ---------- State ---------- */

  var state = {
    chip: "trending",
    query: "",
    items: [],
    head: "",
    queue: [],
    qi: -1,
    playing: false,
    current: null,
    source: "",
    repeat: get("chalkle-repeat", "off"),
    shuffle: get("chalkle-shuffle", false),
    volume: Math.min(1, Math.max(0, Number(get("chalkle-vol", 0.9)) || 0.9)),
    muted: get("chalkle-mute", false),
    eqOn: get("chalkle-eq", true),
    favs: loadFavs(),
    busy: false
  };

  var audio = new Audio();
  audio.volume = state.muted ? 0 : state.volume;
  audio.preload = "auto";

  var els = {};
  var ctx = null;   /* AudioContext */
  var analyser = null;
  var eqRAF = null;
  var featuredVideos = null;

  function $(id) {
    return document.getElementById(id);
  }

  function get(k, fallback) {
    try {
      var v = localStorage.getItem(k);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }

  function set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { /* no storage */ }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) return "0:00";
    var total = Math.floor(sec);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  /* ---------- Mirror transport ---------- */

  function rawFetch(url, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || TIMEOUT_MS);
    return fetch(url, { signal: controller.signal }).finally(function () {
      clearTimeout(timer);
    });
  }

  function relayUrl(url, relay) {
    var clean = String(url || "").replace(/^https?:\/\//i, "");
    /* Jina treats an unescaped ampersand as part of its own URL query. */
    if (relay === "https://r.jina.ai/http://") {
      return relay + clean.replace(/&/g, "%26").replace(/#/g, "%23");
    }
    return relay + encodeURIComponent(url);
  }

  function fetchTextWithRelays(url, timeoutMs) {
    var directErr = null;
    var i = 0;

    function next() {
      if (i >= CORS_RELAYS.length) {
        return Promise.reject(directErr || new Error("all relays failed"));
      }
      var relay = CORS_RELAYS[i++];
      return rawFetch(relayUrl(url, relay), timeoutMs).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      }).catch(function (err) {
        directErr = err;
        return next();
      });
    }

    return next();
  }

  function parseJsonText(text) {
    var trimmed = String(text || "").trim();
    var marker = "Markdown Content:";
    var markerAt = trimmed.indexOf(marker);
    if (markerAt !== -1) trimmed = trimmed.slice(markerAt + marker.length).trim();
    var start = trimmed.indexOf("{");
    var alt = trimmed.indexOf("[");
    if (start === -1 || (alt !== -1 && alt < start)) start = alt;
    if (start === -1) throw new Error("no json");
    return JSON.parse(trimmed.slice(start));
  }

  /* CORS-enabled instances (e.g. flokinet sends Access-Control-Allow-Origin:
     *) can be fetched straight from the browser - no relay round-trip, which
     is much faster. Hosts that don't send CORS headers skip the doomed direct
     attempt and go straight to the relay chain, so the console doesn't fill
     with "CORS missing allow origin" noise on every search/trending load. */
  function fetchJson(host, path, timeoutMs) {
    var url = "https://" + host + path;
    function viaDirect() {
      return rawFetch(url, timeoutMs).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      }).then(parseJsonText);
    }
    function viaRelay() {
      return fetchTextWithRelays(url, timeoutMs).then(parseJsonText);
    }
    if (DIRECT_CORS[host]) {
      /* Direct first, relay only as fallback. */
      return viaDirect().catch(viaRelay);
    }
    return viaRelay();
  }

  function decodeHtml(s) {
    return String(s || "")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  function cleanText(s) {
    return decodeHtml(String(s || "").replace(/\s+/g, " ").trim());
  }

  function parseSearchHtml(text) {
    var out = [];
    var seen = {};
    var src = String(text || "");
    var re = /href="\/watch\?v=([A-Za-z0-9_-]{6,})[^"]*"[\s\S]{0,1800}?title="([^"]+)"[\s\S]{0,1800}?src="([^"]+)"/g;
    var m;
    while ((m = re.exec(src))) {
      var id = m[1];
      if (seen[id]) continue;
      seen[id] = true;
      out.push({
        videoId: id,
        title: cleanText(m[2]),
        author: "",
        videoThumbnails: m[3] ? [{ url: m[3] }] : [],
        lengthSeconds: 0
      });
      if (out.length >= 36) break;
    }
    return out;
  }

  function pipedFetch(path, timeoutMs) {
    var now = Date.now();
    var candidates = PIPED.filter(function (h) { return (pipedCooldown[h] || 0) <= now; });
    if (candidates.length === 0) return Promise.reject(new Error("mirrors busy"));

    var next = function (i) {
      if (i >= candidates.length) {
        return Promise.reject(new Error("all mirrors failed"));
      }
      var host = candidates[(pipedCursor + i) % candidates.length];
      return fetchJson(host, path, timeoutMs).then(function (data) {
        pipedCursor = (candidates.indexOf(host) + 1) % candidates.length;
        return { data: data, host: host };
      }).catch(function () {
        pipedCooldown[host] = Date.now() + COOLDOWN_MS;
        return next(i + 1);
      });
    };
    return next(0);
  }

  /* Race every Invidious instance at once - first healthy response wins.
     Instances fail fast (401/403/CORS/refused), so this resolves in roughly
     the fastest instance's latency instead of serially waiting out each
     dead mirror's timeout. */
  function raceInvidious(makePath) {
    var now = Date.now();
    var candidates = INVIDIOUS.filter(function (h) { return (invCooldown[h] || 0) <= now; });
    if (candidates.length === 0) return Promise.reject(new Error("mirrors busy"));

    return new Promise(function (resolve, reject) {
      var pending = candidates.length;
      var settled = false;
      candidates.forEach(function (host, idx) {
        var path = makePath(host);
        var t = fetchJson(host, path, 8000);
        t.then(function (data) {
          if (settled) return;
          settled = true;
          invCursor = (idx + 1) % candidates.length;
          resolve({ data: data, host: host });
        }).catch(function () {
          invCooldown[host] = Date.now() + COOLDOWN_MS;
          pending -= 1;
          if (pending === 0 && !settled) {
            settled = true;
            reject(new Error("all mirrors failed"));
          }
        });
      });
    });
  }

  function invidiousSearch(query) {
    var key = "s:" + query.toLowerCase();
    var hit = cacheGet(key);
    if (hit) return Promise.resolve(hit);
    return raceInvidious(function () {
      return "/api/v1/search?q=" + encodeURIComponent(query) + "&type=video";
    }).then(function (r) {
      var out = { data: { items: r.data }, host: r.host };
      cacheSet(key, out);
      return out;
    });
  }

  function invidiousTrending() {
    var hit = cacheGet("trending");
    if (hit) return Promise.resolve(hit);
    return raceInvidious(function () {
      return "/api/v1/trending?type=music";
    }).then(function (r) {
      var out = { data: r.data, host: r.host };
      cacheSet("trending", out);
      return out;
    });
  }


  /* ---------- Channels ---------- */

  /* Curated creators shown on the Channels tab. Users watch these to train
     their own recommendations. */
  var SEED_CHANNELS = [
    { id: "UCX6OQ3DkcsbYNE6H8uQQuVA", name: "MrBeast", avatar: "" },
    { id: "UCGRryxFxjXbVAtBPE9EbyMg", name: "Joe Bart", avatar: "" },
    { id: "UCAtYkwdhJ5o32z7gS-ef5vg", name: "TommyNFG", avatar: "" },
    { id: "UCqV7UZ1zHpgo0He4Rj2naMw", name: "HardlyTommyNFG", avatar: "" }
  ];

  function watchHistory() {
    return get("chalkle-watch", {});
  }

  function saveWatchHistory(h) {
    set("chalkle-watch", h);
  }

  function recordWatch(t) {
    if (!t || !t.id) return;
    var h = watchHistory();
    if (!h[t.id]) h[t.id] = { n: 0, at: Date.now(), artist: t.artist || "", authorId: t.authorId || "", cover: t.cover || "", title: t.title || "" };
    h[t.id].n += 1;
    h[t.id].at = Date.now();
    h[t.id].artist = t.artist || h[t.id].artist;
    h[t.id].authorId = t.authorId || h[t.id].authorId;
    h[t.id].title = t.title || h[t.id].title;
    // Cap so storage never balloons.
    var keys = Object.keys(h);
    if (keys.length > 800) {
      keys.sort(function (a, b) { return h[a].at - h[b].at; });
      for (var k = 0; k < keys.length - 800; k++) delete h[keys[k]];
    }
    saveWatchHistory(h);
  }

  /* Build recommendation scores from watch history: author affinity >=
     recency/play-count. Returns a ranked list of track candidates. */
  function recommendFromHistory(limit) {
    limit = limit || 30;
    var h = watchHistory();
    var keys = Object.keys(h);
    var authorScores = {};
    var tracks = [];
    keys.forEach(function (k) {
      var e = h[k];
      var track = {
        id: k, title: e.title, artist: e.artist, cover: e.cover,
        authorId: e.authorId, duration: 0, local: false
      };
      tracks.push(track);
      var aid = e.authorId || e.artist;
      if (aid) authorScores[aid] = (authorScores[aid] || 0) + Math.min(10, e.n) * (1 + (Date.now() - e.at) / (7 * 864e5));
    });
    // Rank: watched channels first, then most-recently-watched.
    tracks.sort(function (a, b) {
      var sa = authorScores[a.authorId || a.artist] || 0;
      var sb = authorScores[b.authorId || b.artist] || 0;
      if (sa !== sb) return sb - sa;
      return (h[b.id] ? h[b.id].at : 0) - (h[a.id] ? h[a.id].at : 0);
    });
    return tracks.slice(0, limit);
  }

  function invidiousChannelVideos(channelId) {
    return raceInvidious(function () {
      return "/api/v1/channels/" + encodeURIComponent(channelId) + "/videos?sort=newest";
    }).then(function (r) {
      var vids = (r.data && r.data.videos) || [];
      return vids.map(mapInv).filter(Boolean).map(function (t) {
        // Author name/id may be absent per-video; backfill the rest.
        if (!t.authorId) t.authorId = channelId;
        return t;
      });
    });
  }

  function loadChannel(channelId, channelName) {
    state.busy = true;
    loadingState();
    status("Loading channel…");
    invidiousChannelVideos(channelId).then(function (vids) {
      state.busy = false;
      state.channel = { id: channelId, name: channelName || "Channel" };
      state.items = vids;
      state.head = channelName || "Channel videos";
      state.source = "invidious";
      setHead(state.head);
      status(vids.length ? vids.length + " videos" : "");
      renderGrid();
      if (vids.length === 0) showEmpty("No videos on this channel.", "Try the trending feed instead.", "");
    }).catch(function (err) {
      state.busy = false;
      showEmpty("Channel unreachable", (err && err.message) || "Try the trending feed instead.", '<button class="btn" id="ch-retry">Back</button>');
      var retry = $("ch-retry");
      if (retry) retry.addEventListener("click", function () { loadTrending(); });
    });
  }

  function loadChannelGrid() {
    state.items = [];
    var empty = els.empty;
    if (empty) empty.innerHTML = "";
    if (empty) empty.hidden = true;
    var grid = els.grid;
    if (!grid) return;
    grid.hidden = false;
    grid.innerHTML = SEED_CHANNELS.map(function (c) {
      return channelCard(c);
    }).join("");
    if (els.head) els.head.textContent = "Channels";
    if (els.status) els.status.textContent = SEED_CHANNELS.length + " creators you can follow";
  }

  function channelCard(c) {
    var initial = esc((c.name || "?").charAt(0).toUpperCase() || "?");
    var img = c.avatar
      ? '<img src="' + esc(c.avatar) + '" alt="" loading="lazy" onerror="this.remove()">'
      : "";
    return (
      '<div class="card channel-card" data-channel="' + esc(c.id) + '">' +
      '<span class="card-thumb channel-thumb">' +
      '<span class="fallback">' + initial + "</span>" + img +
      "</span>" +
      '<span class="card-body">' +
      '<span class="card-titles"><span class="card-title">' + esc(c.name) + "</span>" +
      '<span class="card-sub">Open channel</span></span>' +
      "</span>" +
      "</div>"
    );
  }

  function openChannelPage(channelId, name) {
    loadChannel(channelId, name || channelNameFromId(channelId));
    setChannelBack();
  }

  function channelNameFromId(id) {
    var seed = SEED_CHANNELS.filter(function (c) { return c.id === id; })[0];
    if (seed) return seed.name;
    return "Channel";
  }

  function setChannelBack() {
    var back = $("channel-back");
    if (back) back.hidden = false;
  }

  function clearChannelBack() {
    var back = $("channel-back");
    if (back) back.hidden = true;
  }

  /* Recommended = the user's own history (in-app YouTube algorithm) merged
     with trending, so it never feels empty on a fresh device. */
  function loadRecommended() {
    state.busy = true;
    loadingState();
    status("Building your recommendations…");
    var mine = recommendFromHistory(12);
    invidiousTrending().then(function (r) {
      state.busy = false;
      var trend = (r.data || []).map(mapInv).filter(Boolean);
      var mineIds = {};
      mine.forEach(function (t) { mineIds[t.id] = true; });
      var picks = mine.slice();
      trend.forEach(function (t) {
        if (picks.length >= 30) return;
        if (mineIds[t.id]) return;
        picks.push(t);
      });
      state.items = picks;
      state.head = "Recommended for you";
      state.source = mine.length ? "based on what you watch" : "trending while you build history";
      setHead(state.head);
      status(state.source);
      renderGrid();
      if (picks.length === 0) showEmpty("Nothing to recommend yet.", "Watch a few videos or search to train your feed.", "");
    }).catch(function (err) {
      state.busy = false;
      state.items = mine;
      state.head = "Recommended for you";
      setHead(state.head);
      status(mine.length ? "from your watch history" : "watch videos to personalize this");
      renderGrid();
      if (mine.length === 0) showEmpty("Nothing to recommend yet.", "Watch a few videos to train your feed.", "");
    });
  }

  function getFeaturedVideos() {
    if (!featuredVideos) {
      featuredVideos = invidiousTrending().then(function (r) {
        return (r.data || []).map(mapInv).filter(Boolean).slice(0, 6);
      }).catch(function (err) {
        featuredVideos = null;
        throw err;
      });
    }
    return featuredVideos;
  }

  function absoluteUrl(u, host) {
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    return "https://" + host + (u.charAt(0) === "/" ? "" : "/") + u;
  }

  function videoIdFromUrl(u) {
    var m = u.match(/[?&]v=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
    var p = u.match(/\/watch\/([A-Za-z0-9_-]{6,})/);
    return p ? p[1] : "";
  }

  /* Cover fallback: if the instance's thumbnail fails, use YouTube's own
     thumbnail CDN for the same video, then hide the img (letter fallback). */
  window.chalkThumb = function (img, id) {
    if (!img.dataset.fb) {
      img.dataset.fb = "1";
      img.src = "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg";
    } else {
      img.style.display = "none";
    }
  };

  function thumbErr(t) {
    var id = t && t.id ? String(t.id).replace(/[^A-Za-z0-9_-]/g, "") : "";
    return id ? "chalkThumb(this,'" + id + "')" : "this.style.display='none'";
  }

  /* ---------- Track mapping ---------- */

  function mapPiped(item, host) {
    if (item.type !== "stream" || !item.url || !item.title) return null;
    var id = videoIdFromUrl(item.url);
    if (!id) return null;
    return {
      id: id,
      title: item.title,
      artist: item.uploaderName || "Unknown",
      cover: absoluteUrl(item.thumbnail, host) || "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg",
      duration: item.duration > 0 ? item.duration : 0,
      authorId: item.uploaderId || item.uploaderUrl || "",
      local: false
    };
  }

  function mapInv(item) {
    /* Only real videos belong in the grid - never channels, playlists or
       creator profiles. */
    if (!item || (item.type && item.type !== "video")) return null;
    if (!item.videoId || !item.title) return null;
    /* Invidious serves relative /vi/... thumbnail paths that resolve against
       the app origin (404). Always use YouTube's own thumbnail CDN - it is
       stable and CORS-free for <img>. */
    var aid = "";
    if (item.authorId) aid = item.authorId;
    else if (item.authorUrl) aid = (item.authorUrl.match(/channel\/([A-Za-z0-9_-]{6,})/) || ["", ""])[1];
    return {
      id: item.videoId,
      title: item.title,
      artist: item.author || "Unknown",
      cover: "https://i.ytimg.com/vi/" + item.videoId + "/hqdefault.jpg",
      duration: item.lengthSeconds || 0,
      authorId: aid,
      avatar: (item.authorThumbnails && item.authorThumbnails.length && item.authorThumbnails[item.authorThumbnails.length - 1].url) || "",
      local: false
    };
  }

  /* ---------- Sources ---------- */

  function loadTrending() {
    state.busy = true;
    loadingState();
    status("Loading trending…");
    invidiousTrending().then(function (r) {
      state.busy = false;
      state.items = (r.data || []).map(mapInv).filter(Boolean);
      state.head = "Trending videos";
      state.source = "invidious · " + r.host;
      setHead(state.head);
      status(state.source);
      renderGrid();
      if (state.items.length === 0) {
        showEmpty("No trending videos right now.", "Try searching for a video instead.", "");
      }
    }).catch(function (err) {
      state.busy = false;
      showEmpty("Music mirrors unreachable", (err && err.message) || "Try again in a minute.", '<button class="btn" id="state-retry">Retry</button>');
      var retry = $("state-retry");
      if (retry) retry.addEventListener("click", loadTrending);
    });
  }

  function doSearch(q) {
    q = String(q || "").trim();
    state.query = q;
    if (!q) {
      loadTrending();
      return;
    }
    state.busy = true;
    loadingState();
    status("Searching…");
    invidiousSearch(q).then(function (r) {
      state.busy = false;
      state.items = (r.data.items || []).map(function (it) {
        return mapInv(it);
      }).filter(Boolean);
      state.head = "Video results for \u201C" + q + "\u201D";
      state.source = "invidious search · " + r.host;
      setHead(state.head);
      status(state.source);
      renderGrid();
      if (state.items.length === 0) {
        showEmpty("No videos found.", "Try a different search.", "");
      }
    }).catch(function (err) {
      state.busy = false;
      showEmpty("Search failed", (err && err.message) || "Try again in a minute.", '<button class="btn" id="state-retry">Retry</button>');
      var retry = $("state-retry");
      if (retry) retry.addEventListener("click", function () { doSearch(q); });
    });
  }

  function loadFavorites() {
    state.items = state.favs.slice();
    state.head = state.items.length ? "Favorites" : "No favorites yet";
    setHead(state.head);
    status(state.items.length ? state.favs.length + " saved on this device" : "");
    renderGrid();
    if (state.items.length === 0) {
      showEmpty("No favorites yet.", "Tap the heart on any video to save it here.", "");
    }
  }

  /* ---------- Favorites ---------- */

  function loadFavs() {
    try {
      var raw = localStorage.getItem("chalkle-favs");
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveFavs() {
    set("chalkle-favs", state.favs);
  }

  function isFav(t) {
    return state.favs.some(function (f) { return f.id === t.id; });
  }

  function toggleFav(t) {
    if (!t || t.local) return;
    if (isFav(t)) {
      state.favs = state.favs.filter(function (f) { return f.id !== t.id; });
    } else {
      state.favs.push({ id: t.id, title: t.title, artist: t.artist, cover: t.cover, duration: t.duration, authorId: t.authorId, local: false });
    }
    saveFavs();
    if (state.chip === "favorites") loadFavorites();
    else renderGrid();
    updatePlayerHeart();
  }

  /* ---------- Rendering ---------- */

  var PLAY =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.5l10 6.5-10 6.5z"/></svg>';
  var HEART =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.3 4.6 13a4.6 4.6 0 0 1 6.5-6.5L12 7.6l0.9-.9a4.6 4.6 0 0 1 6.5 6.5L12 20.3z"/></svg>';

  function songCard(t, i, isCurrent) {
    var letter = esc((t.title || "?").charAt(0).toUpperCase() || "?");
    var thumb;
    if (t.cover) {
      thumb =
        '<span class="fallback">' + letter + "</span>" +
        '<img src="' + esc(t.cover) + '" alt="" loading="lazy" onerror="' + thumbErr(t) + '">';
    } else {
      thumb = '<span class="fallback">' + letter + "</span>";
    }

    var fav = isFav(t) ? " is-on" : "";
    var artist = esc(t.artist);
    /* Clicking the artist opens that creator's channel page in-app. */
    var artistHtml = t.authorId
      ? '<button class="card-author" data-author="' + esc(t.authorId) + '" data-author-name="' + artist + '" title="Open ' + artist + ' channel">' + artist + '</button>'
      : '<span class="card-sub">' + artist + "</span>";

    return (
      '<div class="card song-card' + (isCurrent ? " is-current" : "") + '" data-song="' + i + '">' +
      '<span class="card-thumb">' + thumb +
      '<span class="card-play"><span class="play-btn">' + PLAY + "</span></span>" +
      '<button class="song-fav' + fav + '" data-fav="' + i + '" aria-label="Favorite">' + HEART + "</button>" +
      "</span>" +
      '<span class="card-body">' +
      '<span class="card-titles"><span class="card-title">' + esc(t.title) + "</span>" +
      '<span class="card-author-wrap">' + artistHtml + "</span></span>" +
      '<span class="card-dur">' + fmt(t.duration) + "</span>" +
      "</span>" +
      "</div>"
    );
  }

  function renderGrid() {
    var grid = els.grid;
    var empty = els.empty;
    if (!grid || !empty) return;

    if (state.items.length === 0) {
      grid.innerHTML = "";
      grid.hidden = true;
      empty.hidden = false;
      return;
    }

    grid.hidden = false;
    empty.hidden = true;
    grid.innerHTML = state.items.map(function (t, i) {
      return songCard(t, i, state.current && t.id === state.current.id);
    }).join("");
  }

  function setHead(text) {
    if (els.head) els.head.textContent = text;
  }

  function status(msg) {
    if (els.status) els.status.textContent = msg;
  }

  function showEmpty(title, hint, action) {
    var empty = els.empty;
    if (!empty) return;
    empty.innerHTML =
      '<span class="bubble-letter big chalkle-logo" role="img" aria-label="Chalkle"></span>' +
      '<p class="empty-title">' + esc(title) + "</p>" +
      '<p class="empty-hint">' + esc(hint) + "</p>" +
      (action || "");
    empty.hidden = false;
    if (els.grid) els.grid.hidden = true;
  }

  function loadingState() {
    var empty = els.empty;
    if (!empty) return;
    empty.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 18.5V5.5l9.5-2.5v13"/><circle cx="6.5" cy="18.25" r="2.75"/><circle cx="16.5" cy="16.25" r="2.75"/></svg>' +
      '<p class="empty-title pulse">Loading YouTube videos...</p>' +
      '<p class="empty-hint">Connecting to public YouTube search mirrors.</p>';
    empty.hidden = false;
    if (els.grid) els.grid.hidden = true;
  }

  /* ---------- Player ---------- */

  function playAt(i) {
    if (i < 0 || i >= state.items.length) return;
    var track = state.items[i];
    if (!track || !track.id) return;
    state.queue = state.items.slice();
    state.qi = i;
    state.current = track;
    renderGrid();
    updatePlayer();
    status("Loading video…");
    openVideoPlayer(track);
  }

  function openVideoPlayer(track) {
    var overlay = $("video-overlay");
    var frame = $("video-frame");
    var title = $("video-overlay-title");
    if (!overlay || !frame) return;
    if (title) title.textContent = track.title || "YouTube video";
    frame.src = VIDEO_HOSTS[0] + encodeURIComponent(track.id) + "?playsinline=1&rel=0&origin=" + encodeURIComponent(videoOrigin());
    frame.dataset.hostIndex = "0";
    overlay.hidden = false;
    /* Watch history powers the in-app recommendation feed. */
    recordWatch(track);
  }

  function openFeaturedVideo(track) {
    if (!track || !track.id) return;
    state.items = [track];
    state.queue = [track];
    state.qi = 0;
    state.current = track;
    state.head = "Now playing";
    setHead(state.head);
    renderGrid();
    updatePlayer();
    openVideoPlayer(track);
  }

  function closeVideoPlayer() {
    var overlay = $("video-overlay");
    var frame = $("video-frame");
    if (overlay) overlay.hidden = true;
    if (frame) frame.src = "about:blank";
  }

  function requestVideoPip() {
    var frame = $("video-frame");
    if (!frame) return;
    var message = "Picture in picture is not available for this embedded video in this browser.";
    try {
      if (document.pictureInPictureElement && document.exitPictureInPicture) {
        document.exitPictureInPicture();
        return;
      }
      if (frame.requestPictureInPicture) {
        frame.requestPictureInPicture().catch(function () { alert(message); });
        return;
      }
    } catch (e) { /* browser denied PiP */ }
    alert(message + " YouTube embeds may require opening the video directly.");
  }

  function playTrack(track, list, i) {
    if (!track) return;
    state.queue = list || [track];
    state.qi = i == null ? 0 : i;
    state.current = track;
    renderGrid();
    updatePlayer();

    status("Resolving stream…");
    resolveStream(track).then(function (res) {
      if (state.current !== track) return; /* user moved on */
      state.source = res.source;
      status(res.source);
      audio.src = res.url;
      audio.play().catch(function () { /* user clicked, autoplay is allowed */ });
    }).catch(function (err) {
      status("stream failed: " + ((err && err.message) || "unknown"));
      next(true);
    });
  }

  function togglePlay() {
    if (!state.current) return;
    if (audio.paused) audio.play();
    else audio.pause();
  }

  function next(skipFailed) {
    var q = state.queue;
    if (q.length === 0) return;

    if (state.shuffle && q.length > 1) {
      var r;
      do {
        r = Math.floor(Math.random() * q.length);
      } while (r === state.qi);
      playTrack(q[r], q, r);
      return;
    }

    if (state.repeat === "one" && !skipFailed) {
      playTrack(state.current, q, state.qi);
      return;
    }

    var n = state.qi + 1;
    if (n >= q.length) {
      if (state.repeat === "all") {
        playTrack(q[0], q, 0);
      } else {
        audio.pause();
        audio.currentTime = 0;
        state.qi = -1;
        state.current = null;
        updatePlayer();
        renderGrid();
      }
      return;
    }
    playTrack(q[n], q, n);
  }

  function prev() {
    if (state.queue.length === 0) return;
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    var p = state.qi - 1;
    if (p < 0) p = state.queue.length - 1;
    playTrack(state.queue[p], state.queue, p);
  }

  /* ---------- Stream resolution ---------- */

  function looksLikeMedia(bytes) {
    if (bytes.length < 4) return false;
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true; /* webm */
    if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return true; /* mp4 */
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; /* id3 */
    if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true; /* mp3 */
    if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return true; /* ogg */
    if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return true; /* flac */
    return false;
  }

  function verifyMedia(url) {
    return fetch(url, { headers: { Range: "bytes=0-1023" } }).then(function (res) {
      if (!res.ok) return false;
      var type = (res.headers.get("content-type") || "").toLowerCase();
      if (!/^(audio|video)\//.test(type)) return false;
      return res.arrayBuffer().then(function (buf) {
        return looksLikeMedia(new Uint8Array(buf));
      });
    }).catch(function () {
      /* CORS or network error: media elements don't need CORS, so trust it. */
      return true;
    });
  }

  function resolveStream(track) {
    if (track.local) return Promise.resolve({ url: track.local, source: "local" });

    var now = Date.now();
    var candidates = PIPED.filter(function (h) { return (pipedCooldown[h] || 0) <= now; });
    var attempt = 0;

    function tryPiped() {
      if (attempt >= candidates.length) return tryInvidious();
      var host = candidates[(pipedCursor + attempt) % candidates.length];
      attempt += 1;
      return fetchJson(host, "/api/streams/" + encodeURIComponent(track.id), 10000)
        .then(function (data) {
          var progressive = function (u) {
            return !!u && u.indexOf(".m3u8") === -1 && u.toLowerCase().indexOf("mpegurl") === -1;
          };
          var byBitrate = function (a, b) { return (b.bitrate || 0) - (a.bitrate || 0); };
          var audioS = (data.audioStreams || []).filter(function (s) { return progressive(s.url); }).sort(byBitrate);
          var muxed = (data.videoStreams || []).filter(function (s) { return progressive(s.url); }).sort(byBitrate);
          var chosen = audioS[0] || muxed[0];
          if (!chosen || !chosen.url) throw new Error("no stream");
          var url = absoluteUrl(chosen.url, host);
          return verifyMedia(url).then(function (ok) {
            if (!ok) throw new Error("bad stream");
            pipedCursor = (candidates.indexOf(host) + 1) % candidates.length;
            return { url: url, source: "piped · " + host };
          });
        })
        .catch(function () {
          pipedCooldown[host] = Date.now() + COOLDOWN_MS;
          return tryPiped();
        });
    }

    function tryInvidious() {
      var list = INVIDIOUS.filter(function (h) { return (invCooldown[h] || 0) <= Date.now(); });
      var i = 0;
      /* Try several itag / local combos per host: instances differ in what
         they can resolve right now. 140 = audio-only m4a, 251 = webm audio,
         18 = muxed mp4. */
      var combos = [
        { itag: 140, local: true },
        { itag: 251, local: true },
        { itag: 140, local: false },
        { itag: 18, local: false }
      ];
      function next() {
        if (i >= list.length * combos.length) return Promise.reject(new Error("all mirrors failed"));
        var hi = Math.floor(i / combos.length);
        var ci = i % combos.length;
        i += 1;
        var host = list[(invCursor + hi) % list.length];
        var c = combos[ci];
        var url = "https://" + host + "/latest_version?id=" + encodeURIComponent(track.id) + "&itag=" + c.itag + "&local=" + (c.local ? "true" : "false");
        return verifyMedia(url).then(function (ok) {
          if (!ok) throw new Error("bad stream");
          invCursor = (list.indexOf(host) + 1) % list.length;
          return { url: url, source: "invidious · " + host };
        }).catch(function () {
          invCooldown[host] = Date.now() + COOLDOWN_MS;
          return next();
        });
      }
      return next();
    }

    return tryPiped();
  }

  /* ---------- Player UI ---------- */

  var ICON_PLAY =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>';
  var ICON_PAUSE =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z"/></svg>';
  var ICON_REPEAT =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3.5 20.5 7 17 10.5M20 7H4.5A2.5 2.5 0 0 0 2 9.5v1M7 20.5 3.5 17 7 13.5M4 17h15.5a2.5 2.5 0 0 0 2.5-2.5v-1"/></svg>';
  var ICON_REPEAT_ONE =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3.5 20.5 7 17 10.5M20 7H4.5A2.5 2.5 0 0 0 2 9.5v1M7 20.5 3.5 17 7 13.5M4 17h15.5a2.5 2.5 0 0 0 2.5-2.5v-1"/><path d="M12 9v6M12 9l-1.5 1M12 9l1.5 1"/></svg>';
  var ICON_VOL =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5H4z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M17.8 6.6a8 8 0 0 1 0 10.8"/></svg>';
  var ICON_MUTE =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5H4z"/><path d="M15 9.5l5 5M20 9.5l-5 5"/></svg>';
  var NOTE =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 17.5V6.5l9-2.5v11"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/></svg>';

  function updatePlayer() {
    var t = state.current;
    var dock = els.dock;
    if (!dock) return;
    if (!t) {
      dock.hidden = true;
      return;
    }
    dock.hidden = false;

    els.art.innerHTML = t.cover
      ? '<span class="fallback">' + esc((t.title || "?").charAt(0).toUpperCase()) + '</span><img src="' + esc(t.cover) + '" alt="" onerror="' + thumbErr(t) + '">'
      : '<span class="fallback note">' + NOTE + "</span>";
    els.title.textContent = t.title;
    els.artist.textContent = t.artist;
    updatePlayerHeart();
    updatePlayIcon();
    updateButtons();
    renderQueue();
  }

  function updatePlayerHeart() {
    if (!els.heart || !state.current) return;
    els.heart.classList.toggle("is-on", isFav(state.current));
  }

  function updatePlayIcon() {
    if (!els.play) return;
    els.play.innerHTML = audio.paused ? ICON_PLAY : ICON_PAUSE;
  }

  function updateButtons() {
    if (els.shuffle) els.shuffle.classList.toggle("is-on", state.shuffle);
    if (els.repeat) {
      els.repeat.classList.toggle("is-on", state.repeat !== "off");
      els.repeat.innerHTML = state.repeat === "one" ? ICON_REPEAT_ONE : ICON_REPEAT;
    }
    if (els.volIcon) els.volIcon.innerHTML = state.muted || audio.volume === 0 ? ICON_MUTE : ICON_VOL;
    if (els.vol) els.vol.value = String(audio.volume);
  }

  function renderQueue() {
    var list = els.queueList;
    if (!list) return;
    if (state.queue.length === 0) {
      list.innerHTML = '<div class="queue-none">Queue is empty.</div>';
      if (els.queueCount) els.queueCount.textContent = "0";
      return;
    }
    list.innerHTML = state.queue.map(function (t, i) {
      var cur = i === state.qi ? " is-current" : "";
      return (
        '<div class="queue-row' + cur + '" data-qi="' + i + '">' +
        '<span class="queue-idx">' + (i === state.qi ? "\u25B6" : i + 1) + "</span>" +
        '<span class="queue-titles"><span class="queue-title">' + esc(t.title) + "</span>" +
        '<span class="queue-sub">' + esc(t.artist) + "</span></span>" +
        '<span class="queue-dur">' + fmt(t.duration) + "</span>" +
        "</div>"
      );
    }).join("");
    if (els.queueCount) els.queueCount.textContent = String(state.queue.length);
  }

  /* ---------- Equalizer ---------- */

  function ensureAudioGraph() {
    if (ctx) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      var src = ctx.createMediaElementSource(audio);
      src.connect(analyser);
      analyser.connect(ctx.destination);
    } catch (e) { /* no web audio */ }
  }

  function startEq() {
    if (!state.eqOn || !analyser || eqRAF) return;
    var canvas = els.eqCanvas;
    if (!canvas) return;
    var cctx = canvas.getContext("2d");
    var freq = new Uint8Array(analyser.frequencyBinCount);

    function draw() {
      if (!state.eqOn || !els.eqStage || els.eqStage.hidden) {
        eqRAF = null;
        cctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      analyser.getByteFrequencyData(freq);
      var w = canvas.width;
      var h = canvas.height;
      cctx.clearRect(0, 0, w, h);
      cctx.fillStyle = "#34a853";
      var bars = 32;
      var gap = 2;
      var bw = (w - gap * (bars - 1)) / bars;
      for (var i = 0; i < bars; i++) {
        var v = freq[Math.floor((i / bars) * freq.length * 0.6 + 2)] / 255;
        var bh = Math.max(2, v * h);
        cctx.fillRect(i * (bw + gap), h - bh, bw, bh);
      }
      eqRAF = requestAnimationFrame(draw);
    }
    eqRAF = requestAnimationFrame(draw);
  }

  function stopEq() {
    if (eqRAF) {
      cancelAnimationFrame(eqRAF);
      eqRAF = null;
    }
  }

  function toggleEq() {
    state.eqOn = !state.eqOn;
    set("chalkle-eq", state.eqOn);
    if (!els.eqStage) return;
    els.eqStage.hidden = !state.eqOn;
    if (state.eqOn) startEq();
    else stopEq();
    if (els.eqBtn) els.eqBtn.classList.toggle("is-on", state.eqOn);
  }

  /* ---------- Uploads ---------- */

  function handleUpload(files) {
    if (!files || files.length === 0) return;
    var list = Array.prototype.slice.call(files);
    var tracks = list.map(function (f) {
      var name = f.name.replace(/\.[^.]+$/, "");
      return {
        id: "local:" + name + ":" + Date.now() + ":" + Math.random(),
        title: name,
        artist: "Local file",
        cover: "",
        duration: 0,
        local: URL.createObjectURL(f)
      };
    });

    state.queue = tracks.concat(state.queue);
    state.qi = 0;
    setHead("Uploaded");
    status(state.queue.length + " local file" + (state.queue.length === 1 ? "" : "s") + " ready");
    if (els.grid) els.grid.hidden = true;
    if (els.empty) els.empty.hidden = true;
    renderQueue();
    playTrack(state.queue[0], state.queue, 0);
  }

  /* ---------- Logo (empty states reuse the wordmark) ---------- */

  function buildLogo() {
    var colors = ["#4285f4", "#ea4335", "#fbbc05", "#4285f4", "#34a853", "#ea4335", "#4285f4"];
    var shadows = ["#1557b0", "#b31412", "#e37400", "#1557b0", "#0d7734", "#b31412", "#1557b0"];
    function rgba(hex, a) {
      var n = parseInt(String(hex).replace("#", ""), 16);
      return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
    }
    var letters = "chalkle".split("");
    return letters.map(function (ch, i) {
      return (
        '<span class="bubble-letter" style="color:' + colors[i] +
        ";text-shadow:0 4px 0 " + shadows[i] +
        ",0 8px 12px " + rgba(colors[i], 0.4) +
        ';">' + ch + "</span>"
      );
    }).join("");
  }

  /* ---------- Wire up ---------- */

  function init() {
    document.querySelectorAll(".chalkle-logo").forEach(function (el) {
      el.innerHTML = buildLogo();
    });

    els.grid = $("music-grid");
    els.empty = $("music-empty");
    els.head = $("music-head");
    els.status = $("music-status");
    els.dock = $("audio-dock");
    els.art = $("audio-art");
    els.title = $("audio-title");
    els.artist = $("audio-artist");
    els.heart = $("audio-heart");
    els.play = $("btn-play");
    els.prev = $("btn-prev");
    els.next = $("btn-next");
    els.shuffle = $("btn-shuffle");
    els.repeat = $("btn-repeat");
    els.vol = $("audio-vol");
    els.volIcon = $("btn-vol");
    els.seek = $("audio-seek");
    els.cur = $("audio-cur");
    els.dur = $("audio-dur");
    els.eqStage = $("audio-eq");
    els.eqCanvas = $("eq-canvas");
    els.eqBtn = $("btn-eq");
    els.queueBtn = $("btn-queue");
    els.queuePanel = $("audio-queue");
    els.queueList = $("audio-queue-list");
    els.queueCount = $("queue-count");
    els.queueClose = $("btn-queue-close");

    /* chips */
    document.querySelectorAll("[data-music-chip]").forEach(function (chip) {
      chip.addEventListener("click", function () {
        state.chip = chip.dataset.musicChip;
        document.querySelectorAll("[data-music-chip]").forEach(function (c) {
          c.classList.toggle("is-active", c === chip);
        });
        if (state.chip === "trending") { clearChannelBack(); loadTrending(); }
        else if (state.chip === "favorites") { clearChannelBack(); loadFavorites(); }
        else if (state.chip === "channels") loadChannelGrid();
        else if (state.chip === "recommended") { clearChannelBack(); loadRecommended(); }
        else if (state.chip === "search") { clearChannelBack(); doSearch(""); }
      });
    });

    /* back button from a channel page */
    var channelBack = $("channel-back");
    if (channelBack) channelBack.addEventListener("click", function () {
      clearChannelBack();
      if (state.chip === "recommended") loadRecommended();
      else if (state.chip === "favorites") loadFavorites();
      else loadTrending();
    });

    /* search */
    var q = $("music-q");
    var clearSearch = $("music-q-clear");
    if (q) {
      var debounce = null;
      q.addEventListener("input", function () {
        if (clearSearch) clearSearch.hidden = !q.value;
        clearTimeout(debounce);
        debounce = setTimeout(function () {
          doSearch(q.value.trim());
        }, 450);
      });
      q.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          clearTimeout(debounce);
          doSearch(q.value.trim());
        }
      });
    }
    if (clearSearch) clearSearch.addEventListener("click", function () {
      if (!q) return;
      q.value = "";
      clearSearch.hidden = true;
      doSearch("");
      q.focus();
    });

    /* upload */
    var up = $("music-upload");
    if (up) {
      up.addEventListener("change", function () {
        handleUpload(up.files);
        up.value = "";
      });
    }

    /* grid clicks: play, fav, channel cards, and artist->channel */
    if (els.grid) {
      els.grid.addEventListener("click", function (e) {
        var fav = e.target.closest("[data-fav]");
        if (fav) {
          e.preventDefault();
          toggleFav(state.items[parseInt(fav.dataset.fav, 10)]);
          return;
        }
        var chan = e.target.closest("[data-channel]");
        if (chan) {
          openChannelPage(chan.dataset.channel);
          return;
        }
        var author = e.target.closest("[data-author]");
        if (author) {
          openChannelPage(author.dataset.author, author.dataset.authorName);
          return;
        }
        var card = e.target.closest("[data-song]");
        if (card) playAt(parseInt(card.dataset.song, 10));
      });
    }

    var videoFrame = $("video-frame");
    if (videoFrame) videoFrame.addEventListener("error", function () {
      var index = Number(videoFrame.dataset.hostIndex || 0) + 1;
      if (index < VIDEO_HOSTS.length && state.current) {
        videoFrame.dataset.hostIndex = String(index);
        videoFrame.src = VIDEO_HOSTS[index] + encodeURIComponent(state.current.id) + "?playsinline=1&rel=0&origin=" + encodeURIComponent(videoOrigin());
      }
    });

    var videoPip = $("video-pip");
    if (videoPip) {
      videoPip.addEventListener("click", requestVideoPip);
      if (!("pictureInPictureEnabled" in document)) videoPip.title = "Picture in picture is controlled by the embedded player";
    }

    var videoClose = $("video-overlay-close");
    if (videoClose) videoClose.addEventListener("click", closeVideoPlayer);
    var videoOverlay = $("video-overlay");
    if (videoOverlay) videoOverlay.addEventListener("click", function (e) {
      if (e.target === videoOverlay) closeVideoPlayer();
    });

    /* player buttons */
    if (els.play) els.play.addEventListener("click", togglePlay);
    if (els.next) els.next.addEventListener("click", next);
    if (els.prev) els.prev.addEventListener("click", prev);
    if (els.shuffle) {
      els.shuffle.addEventListener("click", function () {
        state.shuffle = !state.shuffle;
        set("chalkle-shuffle", state.shuffle);
        updateButtons();
      });
    }
    if (els.repeat) {
      els.repeat.addEventListener("click", function () {
        state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
        set("chalkle-repeat", state.repeat);
        updateButtons();
      });
    }
    if (els.eqBtn) els.eqBtn.addEventListener("click", toggleEq);
    if (els.vol) {
      els.vol.addEventListener("input", function () {
        audio.volume = Number(els.vol.value);
        state.muted = audio.volume === 0;
        set("chalkle-vol", audio.volume);
        updateButtons();
      });
    }
    if (els.volIcon) {
      els.volIcon.addEventListener("click", function () {
        state.muted = !state.muted;
        audio.volume = state.muted ? 0 : state.volume;
        set("chalkle-mute", state.muted);
        updateButtons();
      });
    }
    if (els.seek) {
      els.seek.addEventListener("input", function () {
        if (isFinite(audio.duration) && audio.duration > 0) {
          audio.currentTime = (Number(els.seek.value) / 1000) * audio.duration;
        }
      });
    }
    if (els.heart) {
      els.heart.addEventListener("click", function () {
        if (state.current) toggleFav(state.current);
      });
    }
    if (els.queueBtn) {
      els.queueBtn.addEventListener("click", function () {
        if (els.queuePanel) els.queuePanel.hidden = !els.queuePanel.hidden;
      });
    }
    if (els.queueClose) {
      els.queueClose.addEventListener("click", function () {
        if (els.queuePanel) els.queuePanel.hidden = true;
      });
    }
    if (els.queueList) {
      els.queueList.addEventListener("click", function (e) {
        var row = e.target.closest("[data-qi]");
        if (row) {
          var qi = parseInt(row.dataset.qi, 10);
          playTrack(state.queue[qi], state.queue, qi);
          if (els.queuePanel) els.queuePanel.hidden = true;
        }
      });
    }

    /* audio events */
    audio.addEventListener("play", function () {
      state.playing = true;
      updatePlayIcon();
      ensureAudioGraph();
      if (ctx && ctx.state === "suspended") ctx.resume();
      if (state.eqOn && els.eqStage) els.eqStage.hidden = false;
      if (state.eqOn) startEq();
    });
    audio.addEventListener("pause", function () {
      state.playing = false;
      updatePlayIcon();
      stopEq();
    });
    audio.addEventListener("loadedmetadata", function () {
      if (isFinite(audio.duration)) {
        if (els.seek) els.seek.max = "1000";
        if (els.dur) els.dur.textContent = fmt(audio.duration);
      }
    });
    audio.addEventListener("timeupdate", function () {
      if (isFinite(audio.duration) && audio.duration > 0) {
        if (els.cur) els.cur.textContent = fmt(audio.currentTime);
        if (els.seek) els.seek.value = String(Math.floor((audio.currentTime / audio.duration) * 1000));
      }
    });
    audio.addEventListener("ended", function () { next(); });
    audio.addEventListener("error", function () {
      if (!state.current) return;
      status("Mirror failed mid-track, switching…");
      resolveStream(state.current).then(function (res) {
        if (!state.current) return;
        status(res.source);
        audio.src = res.url;
        audio.play().catch(function () {});
      }).catch(function () {
        next(true);
      });
    });

    updateButtons();
    loadTrending();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  /* Exposed for the app shell: topbar search routing + spacebar playback. */
  window.ChalkleMusicSearch = doSearch;
  window.ChalkleFeaturedVideos = getFeaturedVideos;
  window.ChalkleOpenVideo = openFeaturedVideo;
  window.ChalkleOpenChannel = openChannelPage;
  window.ChalkleRecommended = loadRecommended;
  window.ChalkleChannels = loadChannelGrid;
  window.ChalklePlayer = {
    toggle: togglePlay,
    active: function () { return !!state.current; }
  };
})();
