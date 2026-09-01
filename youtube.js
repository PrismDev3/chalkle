/* YouTube tab. Everything runs through the site's /yt relay (serve-chalk.py
   -> public Piped API instances), so the browser never touches a third-party
   host: search, trending, channel profiles and thumbnails all come from this
   origin. Videos play through the official youtube-nocookie embed, which
   handles both on-demand videos and live streams.
   "For you" is a real personal feed: it ranks the channels you actually
   watched (localStorage) and pulls their latest uploads first, then fills
   with trending. The channels row ships the creators people ask for most. */
(function () {
  "use strict";

  var WATCH_KEY = "chalkle-yt-watch-v1";   /* [{id,title,channel,channelId,t}] */
  var LAST_KEY = "chalkle-yt-last";        /* last video id played */

  var CHANNELS = [
    { id: "UCoEmptob-eEGKk18c2VplJg", name: "Kai Cenat" },
    { id: "UCvCfpQXRXdJdL07pzTIA6Cw", name: "Kai Cenat Live" },
    { id: "UCjiXtODGCCulmhwypZAWSag", name: "Jynxzi" },
    { id: "UCX6OQ3DkcsbYNE6H8uQQuVA", name: "MrBeast" },
    { id: "UCGRryxFxjXbVAtBPE9EbyMg", name: "Joe Bartolozzi" },
    { id: "UCAtYkwdhJ5o32z7gS-ef5vg", name: "TommyNFG" }
  ];

  var CATS = ["home", "live", "trending", "music", "gaming"];

  var state = { cat: "home", q: "", loading: false, lastSearch: "" };

  var els = {};

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtCount(n) {
    if (n == null || isNaN(n) || n <= 0) return "";
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (h) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    return m + ":" + String(s).padStart(2, "0");
  }

  function vidId(item) {
    var u = item && item.url;
    if (!u) return "";
    var m = String(u).match(/[?&]v=([\w-]{6,})/);
    return m ? m[1] : String(u).split("/").pop() || "";
  }

  function thumbUrl(id) {
    return "/yt/thumb?u=" + btoa("https://i.ytimg.com/vi/" + id + "/hqdefault.jpg").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function isLive(item) {
    return item && (item.type === "stream" && (item.duration === -1 || item.duration === 0)) ||
      (item.duration === -1);
  }

  /* ---------- watch history ---------- */

  function getWatch() {
    try { return JSON.parse(localStorage.getItem(WATCH_KEY) || "[]"); }
    catch (e) { return []; }
  }

  function recordWatch(item) {
    var id = vidId(item);
    if (!id) return;
    var list = getWatch();
    list = list.filter(function (w) { return w.id !== id; });
    list.unshift({
      id: id,
      title: item.title || "",
      channel: item.uploaderName || "",
      channelId: (item.uploaderUrl || "").split("/").pop() || "",
      t: Date.now()
    });
    if (list.length > 60) list.length = 60;
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(list)); } catch (e) { /* full */ }
    try { localStorage.setItem(LAST_KEY, id); } catch (e) { /* ignore */ }
  }

  function topChannels(n) {
    var counts = {};
    getWatch().forEach(function (w) {
      if (!w.channelId) return;
      counts[w.channelId] = counts[w.channelId] || { id: w.channelId, name: w.channel, n: 0 };
      counts[w.channelId].n++;
      if (counts[w.channelId].name) counts[w.channelId].name = w.channel;
    });
    return Object.keys(counts)
      .map(function (k) { return counts[k]; })
      .sort(function (a, b) { return b.n - a.n; })
      .slice(0, n);
  }

  /* ---------- api ---------- */

  function api(path) {
    return fetch(path, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    });
  }

  function search(q, filter) {
    return api("/yt/search?q=" + encodeURIComponent(q) + "&filter=" + encodeURIComponent(filter || "videos"));
  }

  function trending() {
    return api("/yt/trending?region=US");
  }

  /* ---------- rendering ---------- */

  function channelIdOf(item) {
    var u = item && (item.uploaderUrl || "");
    if (!u) return "";
    var parts = String(u).split("/");
    var last = parts[parts.length - 1] || "";
    return /^UC[\w-]{10,}$/.test(last) ? last : "";
  }

  /* Each video card is a div that holds a main play button plus a separate
     clickable creator button - nested <button>s are invalid, so the card is
     a <div> and both actions are sibling <button>s. Clicking the channel
     name jumps to that creator's page (subs, uploads, shorts, playlists,
     other channels). */
  function videoCard(item) {
    var id = vidId(item);
    if (!id) return "";
    var live = isLive(item);
    var dur = live ? "" : fmtDur(item.duration);
    var views = fmtCount(item.views);
    var title = esc(item.title || "Untitled");
    var chan = esc(item.uploaderName || "");
    var cid = channelIdOf(item);
    var chanBtn = cid
      ? '<button class="yt-video-chan" data-yt-chan="' + esc(cid) + '" data-yt-chan-name="' + chan + '" type="button" title="Go to ' + chan + '">' + chan + (views ? ' · ' + views + " views" : "") + "</button>"
      : '<span class="yt-video-chan">' + chan + (views ? ' · ' + views + " views" : "") + "</span>";
    return '<div class="yt-video" data-yt-id="' + esc(id) + '" data-yt-json="' + esc(JSON.stringify(item).replace(/"/g, "&quot;")) + '">' +
      '<button class="yt-video-main" type="button" data-yt-play>' +
      '<span class="yt-video-thumb">' +
        '<img src="' + thumbUrl(id) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">' +
        (live ? '<span class="yt-video-live">LIVE</span>' : (dur ? '<span class="yt-video-dur">' + dur + "</span>" : "")) +
      "</span>" +
      '<span class="yt-video-body">' +
        '<span class="yt-video-title">' + title + "</span>" +
      "</span>" +
      "</button>" +
      '<span class="yt-video-chanrow">' + chanBtn + "</span>" +
    "</div>";
  }

  function row(title, note, items, max) {
    if (!items || !items.length) return "";
    var cards = items.slice(0, max || 12).map(videoCard).join("");
    return '<section class="yt-block">' +
      '<div class="yt-block-head"><h2 class="yt-block-title">' + esc(title) + "</h2>" +
      (note ? '<span class="yt-block-note">' + esc(note) + "</span>" : "") + "</div>" +
      '<div class="yt-grid">' + cards + "</div></section>";
  }

  /* Shorts get a horizontal snap-scroll strip - the grid would squash their
     9:16 frames. Falls back to a plain grid when scroll containers aren't
     needed (tiny screens). */
  function shortsRow(title, items, max) {
    if (!items || !items.length) return "";
    var cards = items.slice(0, max || 12).map(videoCard).join("");
    return '<section class="yt-block">' +
      '<div class="yt-block-head"><h2 class="yt-block-title">' + esc(title) + "</h2>" +
      '<span class="yt-block-note">quick vertical clips</span></div>' +
      '<div class="yt-shorts-strip">' + cards + "</div></section>";
  }

  function channelCard(ch) {
    var thumb = ch.avatarUrl
      ? '<img src="' + esc(ch.avatarUrl) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">'
      : '<span class="yt-chan-letter">' + esc((ch.name || "?").charAt(0).toUpperCase()) + "</span>";
    var subs = fmtCount(ch.subscriberCount);
    return '<button class="yt-channel" data-yt-channel="' + esc(ch.id) + '" data-yt-name="' + esc(ch.name) + '" type="button">' +
      '<span class="yt-chan-ava">' + thumb + "</span>" +
      '<span class="yt-chan-body">' +
        '<span class="yt-chan-name">' + esc(ch.name) + "</span>" +
        '<span class="yt-chan-subs">' + (subs ? subs + " subscribers" : "channel") + "</span>" +
      "</span>" +
    "</button>";
  }

  function channelsRow() {
    var cards = CHANNELS.map(channelCard).join("");
    return '<section class="yt-block">' +
      '<div class="yt-block-head"><h2 class="yt-block-title">Channels</h2>' +
      '<span class="yt-block-note">the creators everyone&rsquo;s watching</span></div>' +
      '<div class="yt-chan-grid">' + cards + "</div></section>";
  }

  function loadingHtml() {
    return '<div class="yt-loading"><span class="yt-loading-spin"></span> Loading YouTube&hellip;</div>';
  }

  /* ---------- home feed ---------- */

  function loadHome() {
    var home = els.home;
    home.innerHTML = loadingHtml();

    var watched = topChannels(3).map(function (c) { return c.id; });
    var seenIds = {};
    getWatch().forEach(function (w) { seenIds[w.id] = true; });

    /* 1. For you: latest uploads from channels you watch, then fill from
          trending. Fresh viewers get trending instead. */
    var forYou = [];
    var promise = Promise.resolve();
    if (watched.length) {
      promise = Promise.all(watched.map(function (cid) {
        return search("channel:" + cid, "videos").then(function (j) {
          return (j.items || []).filter(function (it) { return (it.uploaderUrl || "").indexOf(cid) !== -1; });
        }).catch(function () { return []; });
      })).then(function (groups) {
        var seen = {};
        groups.forEach(function (g) {
          (g || []).forEach(function (it) {
            var id = vidId(it);
            if (!id || seen[id] || seenIds[id]) return;
            seen[id] = true;
            forYou.push(it);
          });
        });
      });
    }
    return promise.then(function () {
      return trending().then(function (j) {
        var trend = (j.items || []).filter(function (it) { return !seenIds[vidId(it)]; });
        if (!forYou.length) forYou = trend.slice();
        else {
          var seen = {};
          forYou.forEach(function (it) { seen[vidId(it)] = true; });
          for (var i = 0; i < trend.length && forYou.length < 12; i++) {
            if (!seen[vidId(trend[i])]) forYou.push(trend[i]);
          }
        }

        var live = trend.filter(isLive);
        var html = "";
        if (watched.length) {
          var names = topChannels(3).map(function (c) { return c.name; }).filter(Boolean);
          html += row("For you", names.length ? "from " + names.slice(0, 2).join(" and ") : "latest uploads", forYou, 12);
        } else {
          html += row("For you", "trending right now - start watching to tune it", forYou, 12);
        }
        if (live.length) html += row("Live now", "happening this very moment", live, 8);
        html += row("Trending", "what everyone's watching today", trend, 12);
        /* Shorts row: only real shorts (<= 61s verticals). Most Piped
           instances return none right now, so the strip hides itself - it
           shows up the moment the relay feeds shorts. */
        var allVids = forYou.concat(trend);
        var shorts = [];
        var seenSh = {};
        allVids.forEach(function (it) {
          var d = Number(it.duration) || 0;
          var id = vidId(it);
          if (d > 0 && d <= 61 && id && !seenSh[id]) { seenSh[id] = true; shorts.push(it); }
        });
        html += shorts.length ? shortsRow("Shorts", shorts, 10) : "";
        html += channelsRow();
        home.innerHTML = html || '<div class="empty"><p class="empty-title">YouTube is off-line.</p><p class="empty-hint">The relay isn\'t answering right now. Try again in a moment.</p></div>';
        wireHome();
      });
    }).catch(function () {
      home.innerHTML = '<div class="empty"><p class="empty-title">YouTube is off-line.</p><p class="empty-hint">The relay isn\'t answering right now. Try again in a moment.</p></div>';
      wireHome();
    });
  }

  /* New card layout: the div is the whole card, the main button plays, the
     channel button opens the creator page. Also collects channel cards and
     playlist cards that can appear in the same rendered blocks. */
  function wireCards(box) {
    box.querySelectorAll(".yt-video[data-yt-id]").forEach(function (card) {
      var play = card.querySelector("[data-yt-play]");
      if (play) play.addEventListener("click", function () {
        var item = null;
        try { item = JSON.parse(card.dataset.ytJson || "null"); } catch (e) { /* bad */ }
        openVideo(card.dataset.ytId, item);
      });
      card.querySelectorAll("[data-yt-chan]").forEach(function (b) {
        b.addEventListener("click", function (ev) {
          ev.stopPropagation();
          openChannel(b.dataset.ytChan, b.dataset.ytChanName);
        });
      });
    });
    box.querySelectorAll("[data-yt-channel]").forEach(function (btn) {
      btn.addEventListener("click", function () { openChannel(btn.dataset.ytChannel, btn.dataset.ytName); });
    });
    box.querySelectorAll("[data-yt-playlist]").forEach(function (btn) {
      btn.addEventListener("click", function () { openPlaylist(btn.dataset.ytPlaylist); });
    });
  }

  function wireHome() {
    wireCards(els.home);
  }

  /* ---------- channel view ---------- */

  /* A full creator page: header with avatar + subs + description, then rows
     for latest uploads, shorts, playlists and other channels from the same
     creator. Every row degrades gracefully when the relay has nothing. */
  function openChannel(cid, name) {
    if (!cid) return;
    state.cat = "channel:" + cid;
    state.channelName = name || "Channel";
    render();
    var box = els.home;
    box.innerHTML = loadingHtml();

    var profile = null;
    var uploads = [], shorts = [], playlists = [], other = [];

    Promise.all([
      api("/yt/channel/" + encodeURIComponent(cid)).then(function (d) { profile = d; }).catch(function () { /* optional */ }),
      search("channel:" + cid, "videos").then(function (j) {
        uploads = (j.items || []).filter(function (it) { return (it.uploaderUrl || "").indexOf(cid) !== -1; });
        if (!uploads.length) uploads = (j.items || []).slice(0, 12);
      }).catch(function () { /* nothing */ }),
      search("channel:" + cid, "shorts").then(function (j) {
        shorts = (j.items || []).filter(function (it) { return (it.uploaderUrl || "").indexOf(cid) !== -1; });
      }).catch(function () { /* nothing */ }),
      search(name || cid, "playlists").then(function (j) {
        playlists = (j.items || []).filter(function (it) {
          return !cid || (it.uploaderUrl || "").indexOf(cid) !== -1;
        });
      }).catch(function () { /* nothing */ }),
      search(name || cid, "channels").then(function (j) {
        other = (j.items || []).filter(function (it) {
          var otherId = String(it.url || "").split("/").pop() || "";
          return otherId !== cid && /^UC[\w-]{10,}$/.test(otherId);
        });
      }).catch(function () { /* nothing */ })
    ]).then(function () {
      var p = profile || {};
      var pname = esc(p.name || state.channelName || "Channel");
      var avatar = p.avatarUrl
        ? '<img class="yt-profile-ava-img" src="' + esc(p.avatarUrl) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()">'
        : '<span class="yt-profile-ava-letter">' + esc((p.name || state.channelName || "?").charAt(0).toUpperCase()) + "</span>";
      var subs = fmtCount(p.subscriberCount);
      var desc = p.description ? esc(String(p.description).slice(0, 300)) : "";

      var html = '<div class="yt-channel-page">' +
        '<div class="yt-profile">' +
          '<span class="yt-profile-ava">' + avatar + "</span>" +
          '<div class="yt-profile-info">' +
            '<h2 class="yt-profile-name">' + pname + "</h2>" +
            '<span class="yt-profile-subs">' + (subs ? subs + " subscribers" : "channel") + "</span>" +
            (desc ? '<p class="yt-profile-desc">' + desc + "</p>" : "") +
          "</div>" +
        "</div>" +
        (uploads.length ? row("Latest uploads", pname, uploads, 12) : "") +
        (shorts.length ? row("Shorts", "quick vertical clips", shorts, 12) : "") +
        (playlists.length ? playlistsRow(playlists) : "") +
        (other.length ? otherChannelsRow(other) : "") +
        "</div>";
      box.innerHTML = html || '<div class="empty"><p class="empty-title">Couldn\'t load that channel.</p></div>';
      wireHome();
    }).catch(function () {
      box.innerHTML = '<div class="empty"><p class="empty-title">Couldn\'t load that channel.</p></div>';
    });
  }

  function playlistCard(pl) {
    var list = String(pl.url || "").match(/list=([\w-]+)/);
    var lid = list ? list[1] : "";
    var thumb = pl.thumbnail
      ? '<img src="' + esc(pl.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">'
      : '<span class="yt-play-letter">' + esc((pl.name || "?").charAt(0).toUpperCase()) + "</span>";
    return '<button class="yt-playlist" data-yt-playlist="' + esc(pl.url || "") + '" data-yt-playlist-name="' + esc(pl.name || "Playlist") + '" type="button">' +
      '<span class="yt-play-thumb">' + thumb + "</span>" +
      '<span class="yt-play-body">' +
        '<span class="yt-play-name">' + esc(pl.name || "Playlist") + "</span>" +
        '<span class="yt-play-chan">' + esc(pl.uploaderName || "") + "</span>" +
      "</span>" +
    "</button>";
  }

  function playlistsRow(playlists) {
    var cards = playlists.slice(0, 8).map(playlistCard).join("");
    return '<section class="yt-block">' +
      '<div class="yt-block-head"><h2 class="yt-block-title">Playlists</h2>' +
      '<span class="yt-block-note">from this creator</span></div>' +
      '<div class="yt-play-grid">' + cards + "</div></section>";
  }

  function otherChannelsRow(chans) {
    /* search() items are plain objects, not the channel objects channelCard
       expects - build the row from the search payload shape. */
    var cards = chans.slice(0, 8).map(function (c) {
      var oid = String(c.url || "").split("/").pop() || "";
      var thumb = c.thumbnail
        ? '<img src="' + esc(c.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">'
        : '<span class="yt-chan-letter">' + esc((c.name || "?").charAt(0).toUpperCase()) + "</span>";
      return '<button class="yt-channel" data-yt-channel="' + esc(oid) + '" data-yt-name="' + esc(c.name || "") + '" type="button">' +
        '<span class="yt-chan-ava">' + thumb + "</span>" +
        '<span class="yt-chan-body">' +
          '<span class="yt-chan-name">' + esc(c.name || "") + "</span>" +
          '<span class="yt-chan-subs">' + (c.subscriberCount ? fmtCount(c.subscriberCount) + " subscribers" : "channel") + "</span>" +
        "</span>" +
      "</button>";
    }).join("");
    return '<section class="yt-block">' +
      '<div class="yt-block-head"><h2 class="yt-block-title">More from</h2>' +
      '<span class="yt-block-note">other channels by this creator</span></div>' +
      '<div class="yt-chan-grid">' + cards + "</div></section>";
  }

  /* ---------- search / categories ---------- */

  function renderCats() {
    var box = els.cats;
    var active = state.cat;
    box.innerHTML = CATS.map(function (c) {
      return '<button class="chip' + (active === c ? " is-active" : "") + '" data-yt-cat="' + c + '" type="button">' +
        c.charAt(0).toUpperCase() + c.slice(1) + "</button>";
    }).join("") +
      (active.indexOf("channel:") === 0
        ? '<button class="chip is-active" data-yt-cat="home" type="button">' + esc(state.channelName || "Channel") + "</button>"
        : "");
  }

  function loadCat(cat) {
    var box = els.results;
    els.home.hidden = true;
    els.results.hidden = false;
    box.innerHTML = loadingHtml();
    var p;
    if (cat === "live") {
      p = search("live", "videos").then(function (j) {
        var items = (j.items || []).filter(isLive);
        if (items.length < 6) { /* live results are thin - pad with any streams */
          items = (j.items || []).slice(0, 12);
        }
        return row("Live now", "streaming right now", items, 24);
      });
    } else if (cat === "trending") {
      p = trending().then(function (j) { return row("Trending", "US today", j.items || [], 24); });
    } else if (cat === "music" || cat === "gaming") {
      p = search(cat, "videos").then(function (j) { return row(cat, "popular " + cat + " videos", j.items || [], 24); });
    } else {
      return loadHome();
    }
    p.then(function (html) {
      box.innerHTML = html || '<div class="empty"><p class="empty-title">Nothing here.</p></div>';
      wireResults();
    }).catch(function () {
      box.innerHTML = '<div class="empty"><p class="empty-title">Couldn\'t load that.</p><p class="empty-hint">The relay might be down. Try again in a moment.</p></div>';
    });
  }

  function doSearch(q) {
    state.q = q;
    els.home.hidden = true;
    els.results.hidden = false;
    els.empty.hidden = true;
    els.results.innerHTML = loadingHtml();
    search(q, "videos").then(function (j) {
      var items = j.items || [];
      els.results.innerHTML = row("Results for \u201c" + esc(q) + "\u201d", j.count + " found", items, 24) ||
        '<div class="empty"><p class="empty-title">No videos found.</p><p class="empty-hint">Try a different search.</p></div>';
      wireResults();
    }).catch(function () {
      els.results.innerHTML = '<div class="empty"><p class="empty-title">Search failed.</p><p class="empty-hint">The relay isn\'t answering. Try again in a moment.</p></div>';
    });
  }

  function wireResults() {
    wireCards(els.results);
  }

  /* ---------- player ---------- */

  function openVideo(id, item) {
    if (!id) return;
    if (item) recordWatch(item);
    var title = item && item.title ? item.title : "YouTube";
    var chan = item && item.uploaderName ? item.uploaderName : "";
    els.playerTitle.textContent = title;
    els.playerSub.textContent = chan;
    var frame = els.frame;
    frame.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(id) +
      "?autoplay=1&rel=0&modestbranding=1";
    els.player.hidden = false;
    document.body.classList.add("no-scroll");
  }

  /* Playlists play through the official playlist embed (videoseries) - it
     handles the list param same as the video embed, so no extra relay work. */
  function openPlaylist(url) {
    var list = String(url || "").match(/[?&]list=([\w-]+)/);
    if (!list) { notice("That playlist can't be loaded right now."); return; }
    els.playerTitle.textContent = "Playlist";
    els.playerSub.textContent = "";
    els.frame.src = "https://www.youtube-nocookie.com/embed/videoseries?list=" +
      encodeURIComponent(list[1]) + "&autoplay=1&rel=0";
    els.player.hidden = false;
    document.body.classList.add("no-scroll");
  }

  function notice(msg) {
    var box = document.getElementById("toast-box");
    if (!box) return;
    var t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(function () { t.classList.add("is-out"); }, 2200);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2700);
  }

  function closePlayer() {
    els.frame.src = "about:blank";
    els.player.hidden = true;
    document.body.classList.remove("no-scroll");
  }

  /* ---------- init ---------- */

  function render() {
    renderCats();
    if (state.q) {
      doSearch(state.q);
    } else if (state.cat === "home" || state.cat === "channel:" + (state.channelId || "")) {
      els.home.hidden = false;
      els.results.hidden = true;
      if (state.cat.indexOf("channel:") === 0) openChannel(state.cat.slice(8), state.channelName);
      else loadHome();
    } else {
      loadCat(state.cat);
    }
  }

  function init() {
    els.home = $("yt-home");
    if (!els.home) return; /* not the YouTube page - this file also loads elsewhere */
    els.results = $("yt-results");
    els.empty = $("yt-empty");
    els.cats = $("yt-cats");
    els.q = $("yt-q");
    els.qClear = $("yt-q-clear");
    els.player = $("yt-player");
    els.playerTitle = $("yt-player-title");
    els.playerSub = $("yt-player-sub");
    els.frame = $("yt-frame");
    els.msg = $("yt-player-msg");

    /* category chips */
    els.cats.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-yt-cat]");
      if (!btn) return;
      state.cat = btn.dataset.ytCat;
      state.q = "";
      els.q.value = "";
      els.qClear.hidden = true;
      if (state.cat === "home") {
        els.home.hidden = false;
        els.results.hidden = true;
        loadHome();
      } else {
        loadCat(state.cat);
      }
      renderCats();
    });

    /* search */
    var t = null;
    els.q.addEventListener("input", function () {
      els.qClear.hidden = !els.q.value;
      clearTimeout(t);
      t = setTimeout(function () {
        var q = els.q.value.trim();
        if (!q) { render(); return; }
        doSearch(q);
      }, 350);
    });
    els.q.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        clearTimeout(t);
        var q = els.q.value.trim();
        if (q) doSearch(q);
      }
    });
    els.qClear.addEventListener("click", function () {
      els.q.value = "";
      els.qClear.hidden = true;
      state.q = "";
      render();
    });

    /* player close */
    if (els.player) {
      $("yt-player-close").addEventListener("click", closePlayer);
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && !els.player.hidden) closePlayer();
      });
    }

    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
