/* The Unsent Project archive, rebuilt as one offline page.
   Ported from the site's own client bundle captured on 2026-09-13:
     - the card renderer mirrors its canvas code (440x496 board, "To: name" in
       33px arial, message in 44px arial wrapped to 7 lines, template.png
       stamped on top of the fill and under the name)
     - the palette, filter list and page markup come from the same build
     - the light/dark text choice per color comes from its color schemes
   What changed: data comes from a bundled snapshot instead of
   app-api.theunsentproject.com (that API only allows theunsentproject.com as an
   origin), search runs locally, and the analytics, ad, font and error-reporting
   tags are gone. Nothing here talks to the network. */
(function () {
  "use strict";

  var POSTS = window.__TUP_POSTS__ || [];
  var META = window.__TUP_META__ || { count: POSTS.length, captured: "" };
  var TEMPLATE_SRC = window.__TUP_TEMPLATE__ || "";
  var PAGE_SIZE = 45;            /* the site's own page size */
  var MAX_LINES = 7;
  var W = 440, H = 496;
  var MSG_X = 40, MSG_Y = 76, MSG_LEADING = 52, MSG_W = 359;
  var NAME_X = 107, NAME_Y = 16.5;
  var AGE_KEY = "tup-age-gate";

  /* slug -> [label, background, text]. Same values as the site's colorSchemes;
     labels are its filter list, in its order. */
  var COLORS = [
    ["white", "White", "#ffffff", "#000"],
    ["light-grey", "Light Grey", "#a2a2a2", "#fff"],
    ["grey", "Grey", "#6b6b6b", "#fff"],
    ["black", "Black", "#000000", "#fff"],
    ["light-orange", "Light Orange", "#fda44a", "#000"],
    ["yellow", "Yellow", "#fefe7c", "#000"],
    ["tan", "Tan", "#eddbba", "#000"],
    ["brown", "Brown", "#a27040", "#000"],
    ["blue-grey", "Blue Grey", "#a9b8bb", "#000"],
    ["turquoise", "Turquoise", "#698c8e", "#fff"],
    ["pale-blue", "Pale Blue", "#a9d1ee", "#000"],
    ["light-blue", "Light Blue", "#46d2fc", "#000"],
    ["purple", "Purple", "#711bcf", "#fff"],
    ["light-purple", "Light Purple", "#a377fb", "#000"],
    ["dull-purple", "Dull Purple", "#8c7e96", "#fff"],
    ["pale-purple", "Pale Purple", "#d1c5d8", "#000"],
    ["maroon", "Maroon", "#890404", "#fff"],
    ["red", "Red", "#f81b1b", "#fff"],
    ["orange", "Orange", "#f97724", "#fff"],
    ["tangerine", "Tangerine", "#fda37e", "#000"],
    ["army-green", "Army Green", "#71805b", "#fff"],
    ["dark-green", "Dark Green", "#057008", "#fff"],
    ["green", "Green", "#44d046", "#000"],
    ["light-green", "Light Green", "#a7fea7", "#000"],
    ["blue", "Blue", "#1227fc", "#fff"],
    ["dark-blue", "Dark Blue", "#053ea0", "#fff"],
    ["wine", "Wine", "#603442", "#fff"],
    ["dark-purple", "Dark Purple", "#341c3f", "#fff"],
    ["pale-pink", "Pale Pink", "#fbe0e9", "#000"],
    ["light-pink", "Light Pink", "#fda6fd", "#000"],
    ["pink", "Pink", "#f978d1", "#000"],
    ["peach", "Peach", "#fcd1a6", "#000"]
  ];
  var BY_SLUG = {};
  COLORS.forEach(function (c) { BY_SLUG[c[0]] = c; });

  var NOTICES = {
    shop: "The shop and the monthly sticker subscription are not part of this offline copy. The archive is fully browsable.",
    about: "The about page is not part of this offline copy. Everything visible here is the archive itself.",
    terms: "The terms of submission are not part of this offline copy. Submissions are closed here: this copy is read only.",
    submit: "Submitting a post needs the live site. This copy is read only, so the archive and its search are what you get."
  };

  var state = {
    q: "",
    color: "",
    type: "name",
    route: "list",
    postId: "",
    list: [],
    shown: 0,
    busy: false
  };

  /* ---------- small helpers ---------- */

  function byId(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function colorLabel(slug) {
    return BY_SLUG[slug] ? BY_SLUG[slug][1] : slug;
  }

  function postById(id) {
    for (var i = 0; i < POSTS.length; i++) if (String(POSTS[i][0]) === String(id)) return POSTS[i];
    return null;
  }

  /* ---------- card art ---------- */

  var templateImg = null, templateReady = null;

  function loadTemplate() {
    if (!templateReady) {
      templateReady = new Promise(function (resolve) {
        if (!TEMPLATE_SRC) { resolve(null); return; }
        var img = new Image();
        img.onload = function () { templateImg = img; resolve(img); };
        img.onerror = function () { resolve(null); };
        img.src = TEMPLATE_SRC;
      });
    }
    return templateReady;
  }

  /* The site's own wrap: greedy by measured width, honours "\n", caps the card
     at seven lines and ellipsizes the last one. */
  function wrapLines(ctx, text, maxWidth) {
    var words = String(text).split(" ");
    for (var i = 0; i < words.length - 1; i++) {
      if (words[i].indexOf("\n") !== -1) {
        var parts = words[i].split(/(\n)/g);
        words.splice.apply(words, [i, 1].concat(parts));
        i += parts.length - 1;
      }
    }
    var lines = [], line = words[0] || "";
    for (var j = 1; j < words.length; j++) {
      var word = words[j];
      ctx.font = "44px arial";
      var w = ctx.measureText(line + " " + word).width;
      if (word === "\n") { lines.push(line); line = ""; }
      else if (w < maxWidth) {
        if (words[j - 1] && words[j - 1] === "\n") line += word; else line += " " + word;
      } else { lines.push(line); line = word; }
    }
    lines.push(line);
    if (lines.length > MAX_LINES) {
      lines = lines.slice(0, MAX_LINES);
      var last = lines[MAX_LINES - 1];
      lines[MAX_LINES - 1] = last.substr(0, last.length - 3) + "...";
    }
    return lines;
  }

  function cardDataURL(post) {
    var canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d");
    var scheme = BY_SLUG[post[3]] || BY_SLUG.black;
    ctx.fillStyle = scheme[2];
    ctx.fillRect(0, 0, W, H);

    var msg = post[2] || "test";
    ctx.font = "44px arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = scheme[3];
    var lines = wrapLines(ctx, msg, MSG_W);
    for (var i = 0; i < lines.length; i++) {
      ctx.font = "44px arial";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = scheme[3];
      var m = ctx.measureText(lines[i]);
      var asc = m.actualBoundingBoxAscent || 32;
      ctx.fillText(lines[i], MSG_X, MSG_Y + asc / 2 + MSG_LEADING * i);
    }
    return loadTemplate().then(function () {
      if (templateImg) ctx.drawImage(templateImg, 0, 0, W, H);
      ctx.fillStyle = "#000";
      ctx.font = "33px arial";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      var name = "To: " + (post[1] || "");
      var nm = ctx.measureText(name);
      ctx.fillText(name, NAME_X, NAME_Y + (nm.actualBoundingBoxAscent || 24) / 2);
      return canvas.toDataURL();
    });
  }

  /* Cards render through a queue so a 45-card page does not lock the tab. */
  var cache = {}, queue = [], pumping = false;

  function queueCard(img, post) {
    var id = post[0];
    if (cache[id]) { img.src = cache[id]; return; }
    var scheme = BY_SLUG[post[3]] || BY_SLUG.black;
    img.style.backgroundColor = scheme[2];
    queue.push({ img: img, post: post });
    if (!pumping) { pumping = true; requestAnimationFrame(pump); }
  }

  function pump() {
    var budget = 0;
    while (budget++ < 4 && queue.length) drawCard(queue.shift());
    if (queue.length) { requestAnimationFrame(pump); } else { pumping = false; }
  }

  function drawCard(job) {
    cardDataURL(job.post).then(function (url) {
      cache[job.post[0]] = url;
      job.img.src = url;
    });
  }

  /* ---------- list ---------- */

  function matches() {
    var q = state.q.toLowerCase();
    var out = [];
    for (var i = 0; i < POSTS.length; i++) {
      var p = POSTS[i];
      if (state.color && p[3] !== state.color) continue;
      if (q) {
        var hay = state.type === "message" ? p[2] : p[1];
        if (String(hay).toLowerCase().indexOf(q) === -1) continue;
      }
      out.push(p);
    }
    return out;
  }

  function renderHeading() {
    var title = "A Collection Of Unsent Text Messages To First Loves";
    if (state.q) {
      title = state.type === "message"
        ? 'Searching the Archive for messages with "' + state.q + '"'
        : 'Searching the Archive for messages to "' + state.q + '"';
      if (state.color) title += " in " + colorLabel(state.color);
    } else if (state.color) {
      title += " in " + colorLabel(state.color);
    }
    byId("archive-title").textContent = title + " ";
    byId("archive-count").textContent = state.list.length.toLocaleString() + " Posts Found";
  }

  function resetList() {
    state.list = matches();
    state.shown = 0;
    byId("post-list").querySelectorAll("[data-post]").forEach(function (n) { n.remove(); });
    byId("archive-empty").hidden = state.list.length !== 0;
    renderHeading();
    addPage();
  }

  function postCard(post) {
    var li = document.createElement("li");
    li.className = "col-span-1 divide-y divide-gray-200";
    li.setAttribute("data-post", post[0]);
    var a = document.createElement("a");
    a.href = "#/posts/" + post[0];
    var img = document.createElement("img");
    img.className = "tup-card";
    img.width = W; img.height = H;
    img.alt = "To: " + post[1] + " - " + post[2];
    img.loading = "lazy";
    img.decoding = "async";
    queueCard(img, post);
    a.appendChild(img);
    li.appendChild(a);
    return li;
  }

  function addPage() {
    var list = byId("post-list");
    var end = Math.min(state.shown + PAGE_SIZE, state.list.length);
    if (end <= state.shown) return false;
    var frag = document.createDocumentFragment();
    for (var i = state.shown; i < end; i++) frag.appendChild(postCard(state.list[i]));
    list.appendChild(frag);
    state.shown = end;
    return true;
  }

  function maybeLoad() {
    if (state.route !== "list" || state.busy) return;
    if (state.shown >= state.list.length) return;
    if (window.pageYOffset <= 0) return;
    var cards = byId("post-list").querySelectorAll("[data-post]");
    if (!cards.length) return;
    var last = cards[cards.length - 1];
    var bottom = last.offsetTop + last.clientHeight;
    if (bottom - (window.pageYOffset + window.innerHeight) > 400) return;
    state.busy = true;
    byId("list-spinner").hidden = false;
    setTimeout(function () {              /* the site's own 250ms beat */
      addPage();
      byId("list-spinner").hidden = true;
      state.busy = false;
    }, 250);
  }

  /* ---------- single post ---------- */

  function prettyDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var mm = String(d.getMonth() + 1), dd = String(d.getDate());
    if (mm.length < 2) mm = "0" + mm;
    if (dd.length < 2) dd = "0" + dd;
    return mm + "/" + dd + "/" + d.getFullYear();
  }

  function renderPost(id) {
    var post = postById(id);
    var host = byId("post-view");
    if (!post) { location.hash = ""; return; }
    var scheme = BY_SLUG[post[3]] || BY_SLUG.black;
    host.innerHTML =
      '<div class="mb-4"><img class="tup-card" id="post-img" width="440" height="496" style="width:100%" alt="To: ' +
      esc(post[1]) + ' - ' + esc(post[2]) + '"></div>' +
      '<h1 class="text-2xl font-bold"><a href="#/?q=' + encodeURIComponent(post[1]) + '&type=name">' + esc(post[1]) + "</a></h1>" +
      '<div class="text-gray-700">Posted on <time>' + prettyDate(post[4]) + "</time> in " +
      '<a href="#/?color=' + encodeURIComponent(post[3]) + '"><div class="text-black font-semibold">' + esc(colorLabel(post[3])) + "</div></a></div>" +
      '<p class="text-xl mt-4">' + esc(post[2]) + "</p>";
    byId("post-img").style.backgroundColor = scheme[2];
    queueCard(byId("post-img"), post);
  }

  /* ---------- routing ---------- */

  function parseHash() {
    var raw = location.hash.replace(/^#/, "");
    var q = "", color = "", type = "name", postId = "";
    var post = raw.match(/^\/posts\/([^/?&]+)/);
    if (post) postId = post[1];
    var qs = raw.indexOf("?") === -1 ? "" : raw.slice(raw.indexOf("?") + 1);
    qs.split("&").forEach(function (pair) {
      if (!pair) return;
      var bits = pair.split("=");
      var key = decodeURIComponent(bits[0]);
      var val = decodeURIComponent((bits.slice(1).join("=") || "").replace(/\+/g, " "));
      if (key === "q") q = val;
      else if (key === "color") color = val;
      else if (key === "type") type = val === "message" ? "message" : "name";
    });
    return { postId: postId, q: q, color: color, type: type };
  }

  function route() {
    var r = parseHash();
    var archive = byId("archive-view"), single = byId("post-view");
    byId("mobile-menu").hidden = true;
    if (r.postId) {
      state.route = "single";
      state.postId = r.postId;
      archive.hidden = true;
      single.hidden = false;
      byId("offline-note").hidden = true;
      renderPost(r.postId);
      window.scrollTo(0, 0);
      return;
    }
    state.route = "list";
    archive.hidden = false;
    single.hidden = true;
    byId("offline-note").hidden = false;
    var changed = r.q !== state.q || r.color !== state.color || r.type !== state.type;
    state.q = r.q; state.color = r.color; state.type = r.type;
    byId("search").value = r.q;
    byId("filter-name").checked = r.type !== "message";
    byId("filter-message").checked = r.type === "message";
    syncColorRadios();
    if (changed || !state.list.length) resetList(); else renderHeading();
  }

  /* ---------- filter panel ---------- */

  function filterPanelHTML() {
    var rows = ['<div class="relative flex items-start"><div class="flex items-center h-5">' +
      '<input id="color_all" name="searchByColor" type="radio" value="" class="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 rounded"></div>' +
      '<div class="w-full ml-3 text-sm"><label for="color_all" class="flex items-center justify-between font-medium text-gray-700"><span>All Colors</span></label></div></div>'];
    COLORS.forEach(function (c) {
      rows.push('<div class="relative flex items-start"><div class="flex items-center h-5">' +
        '<input id="color_' + c[0] + '" name="searchByColor" type="radio" value="' + c[0] + '" class="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 rounded"></div>' +
        '<div class="w-full ml-3 text-sm"><label for="color_' + c[0] + '" class="flex items-center justify-between font-medium text-gray-700">' +
        "<span>" + c[1] + '</span><span class="w-4 h-4 ml-2 border border-black rounded-full" style="background-color:' + c[2] + '"></span></label></div></div>');
    });
    return '<div style="height:350px;width:300px;top:3rem" class="flex z-50 flex-col border-4 border-black shadow origin-top-right absolute right-0 mt-2 w-96 rounded bg-white ring-1 ring-black ring-opacity-5 divide-y divide-gray-100" role="dialog" aria-label="Archive Filters" id="filter-panel" hidden>' +
      '<div class="overflow-y-auto py-4">' +
      '<div class="px-4 sm:px-6"><div class="flex items-start justify-between"><h2 class="text-lg font-medium text-gray-900" id="archive-filters">Archive Filters</h2></div></div>' +
      '<div class="mt-6 relative flex-1 px-4 sm:px-6">' +
      '<fieldset><legend class="text-base font-medium text-gray-900">Search By</legend><div class="mt-4 space-y-4">' +
      '<div class="relative flex items-start"><div class="flex items-center h-5"><input id="filter-name" name="searchBy" type="radio" value="name" class="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 rounded"></div><div class="ml-3 text-sm"><label for="filter-name" class="font-medium text-gray-700">Name</label></div></div>' +
      '<div class="relative flex items-start"><div class="flex items-center h-5"><input id="filter-message" name="searchBy" type="radio" value="message" class="focus:ring-indigo-500 h-4 w-4 text-indigo-600 border-gray-300 rounded"></div><div class="ml-3 text-sm"><label for="filter-message" class="font-medium text-gray-700">Message</label></div></div>' +
      "</div></fieldset>" +
      '<fieldset class="mt-8"><legend class="text-base font-medium text-gray-900">Filter By Color</legend><div class="mt-4 space-y-4">' +
      rows.join("") +
      "</div></fieldset></div></div>" +
      '<div class="bottom-0 w-full p-3 from-transparent bg-white"><button type="button" data-filter-apply class="w-full justify-center inline-flex items-center px-5 py-3 border border-transparent text-sm font-medium rounded text-white bg-black hover:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"><span>Update Filters</span></button></div></div>';
  }

  function syncColorRadios() {
    var val = state.color || "";
    var input = document.querySelector('input[name="searchByColor"][value="' + (val || "") + '"]');
    if (input) input.checked = true;
    else byId("color_all").checked = true;
  }

  function toggleFilter(force) {
    var panel = byId("filter-panel");
    panel.hidden = typeof force === "boolean" ? !force : !panel.hidden;
    if (!panel.hidden) {
      byId("filter-name").checked = state.type !== "message";
      byId("filter-message").checked = state.type === "message";
      syncColorRadios();
      panel.querySelector("button").focus();
    }
  }

  /* ---------- wiring ---------- */

  function go(params) {
    var parts = [];
    if (params.q) parts.push("q=" + encodeURIComponent(params.q));
    if (params.type && params.type !== "name") parts.push("type=" + params.type);
    if (params.color) parts.push("color=" + encodeURIComponent(params.color));
    location.hash = parts.length ? "#/?" + parts.join("&") : "#/";
  }

  function wire() {
    byId("search-form").addEventListener("submit", function (e) {
      e.preventDefault();
      go({ q: byId("search").value.trim(), type: state.type, color: state.color });
    });

    document.addEventListener("click", function (e) {
      var t = e.target;
      var menu = t.closest("[data-menu-toggle]");
      if (menu) {
        e.preventDefault();
        byId("mobile-menu").hidden = !byId("mobile-menu").hidden;
        return;
      }
      if (t.closest("[data-goto-archive]")) {
        e.preventDefault();
        go({ q: state.q, type: state.type, color: state.color });
        window.scrollTo(0, 0);
        return;
      }
      var off = t.closest("[data-offline]");
      if (off) {
        e.preventDefault();
        byId("notice-text").textContent = NOTICES[off.getAttribute("data-offline")] || NOTICES.about;
        byId("notice").hidden = false;
        return;
      }
      if (t.closest("[data-notice-close]")) {
        e.preventDefault();
        byId("notice").hidden = true;
        return;
      }
      if (t.closest("[data-filter-toggle]")) {
        e.preventDefault();
        toggleFilter();
        return;
      }
      if (t.closest("[data-filter-apply]")) {
        e.preventDefault();
        var name = byId("filter-name").checked;
        var picked = document.querySelector('input[name="searchByColor"]:checked');
        toggleFilter(false);
        go({ q: byId("search").value.trim(), type: name ? "name" : "message", color: picked ? picked.value : "" });
        return;
      }
      if (t.closest("[data-age-accept]")) {
        e.preventDefault();
        try { localStorage.setItem(AGE_KEY, "1"); } catch (err) { /* private mode */ }
        byId("age-gate").hidden = true;
        return;
      }
      if (!t.closest("#filter-panel") && !t.closest("[data-filter-toggle]")) {
        var panel = byId("filter-panel");
        if (panel && !panel.hidden) panel.hidden = true;
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var panel = byId("filter-panel");
      if (panel && !panel.hidden) { panel.hidden = true; byId("search").focus(); return; }
      byId("mobile-menu").hidden = true;
      byId("notice").hidden = true;
    });

    window.addEventListener("scroll", maybeLoad, { passive: true });
    window.addEventListener("hashchange", route);
  }

  function start() {
    var searchRow = byId("search-row");
    searchRow.insertAdjacentHTML("beforeend", filterPanelHTML());
    byId("offline-note").textContent =
      "Offline copy of the archive: " + META.count.toLocaleString() + " posts"
      + (META.captured ? ", captured " + META.captured : "")
      + ". Search runs on this device, so it covers the posts bundled here.";
    try {
      if (localStorage.getItem(AGE_KEY) === "1") byId("age-gate").hidden = true;
    } catch (err) { /* private mode: leave the gate up */ }
    if (!location.hash) location.hash = "#/";
    wire();
    loadTemplate();
    route();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
