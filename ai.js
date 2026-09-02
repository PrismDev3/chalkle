/* ════════════════════════════════════════════════════════════════════════
   Chalkle · AI
   ------------------------------------------------------------------------
   A first-class AI tab: pick a model, chat, stream the reply. All requests
   go through the same-origin /api/ai/chat relay in serve-chalk.py, which
   forwards to the upstream OpenAI-compatible endpoint server-side (the
   browser can't reach the plain-http upstream directly).

   On the static/CDN build (no server) the tab says so plainly and keeps a
   saved conversation locally instead of pretending to send anything.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var LS_KEY = "chalkle.ai.v1";
  var PAPERCLIP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
  var DEFAULTS = [
    "Mistral-Small-3.2-24B-Instruct-2506",
    "mistral-Nemo-Instruct-2407",
    "gpt-oss-20b",
    "Meta-Llama-3_3-70B-Instruct",
    "Qwen3.6-27B",
    "Qwen3-32B",
    "Qwen3.5-397B-A17B",
    "Qwen2.5-VL-72B-Instruct"
  ];

  var S = {
    models: [],          // real model ids from the relay
    server: false,       // whether /api/ai relay responded
    active: null,        // active conversation id
    convos: {}           // id -> { id, title, model, messages: [{role, content}], ts }
  };

  /* Friendly names for the raw model ids the upstream reports. Unknown ids
     fall back to prettify(), so the picker never shows "accounts/foo/models/
     claude-fable-5-20250514"-style noise. */
  var LABELS = {
    "gpt-4o": "GPT-4o",
    "gpt-4o-mini": "GPT-4o mini",
    "gpt-4-turbo": "GPT-4 Turbo",
    "gpt-4.1": "GPT-4.1",
    "gpt-4.1-mini": "GPT-4.1 mini",
    "o1": "OpenAI o1",
    "o3-mini": "OpenAI o3 mini",
    "claude-4-sonnet": "Claude 4 Sonnet",
    "claude-4-opus": "Claude 4 Opus",
    "claude-fable-5-20250514": "Claude Fable 5",
    "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
    "claude-sonnet-4-6-20250514": "Claude Sonnet 4.6",
    "claude-opus-4-6-20250514": "Claude Opus 4.6",
    "claude-opus-4-8-20250618": "Claude Opus 4.8",
    "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
    "claude-3-5-sonnet-latest": "Claude 3.5 Sonnet",
    "claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
    "claude-3-opus-20240229": "Claude 3 Opus",
    "hermes/claude-fable-5-20250514": "Claude Fable 5",
    "accounts/euromodels/models/claude-fable-5": "Claude Fable 5",
    "gemini-2.5-pro": "Gemini 2.5 Pro",
    "gemini-2.5-flash": "Gemini 2.5 Flash",
    "gemini-2.0-flash": "Gemini 2.0 Flash",
    "gemini-1.5-pro": "Gemini 1.5 Pro",
    "deepseek-r1": "DeepSeek R1",
    "deepseek-r1-7b": "DeepSeek R1 7B",
    "deepseek-v3": "DeepSeek V3",
    "deepseek-v4-pro": "DeepSeek V4 Pro",
    "llama3-70b": "Llama 3 70B",
    "llama3-8b": "Llama 3 8B",
    "llama-4-scout": "Llama 4 Scout",
    "llama-4-maverick": "Llama 4 Maverick",
    "mistral-large": "Mistral Large",
    "mistral-7b": "Mistral 7B",
    "qwen-max": "Qwen Max",
    "qwen3-72b": "Qwen3 72B",
    "glm-4-flash": "GLM-4 Flash",
    "kimi-k2.7": "Kimi K2.7",
    "kimi-k2.7-code": "Kimi K2.7 Code",
    "command-r": "Command R",
    "command-r-plus": "Command R+",
    "Qwen3.5-397B-A17B": "Qwen3.5 397B",
    "Qwen3.6-27B": "Qwen3.6 27B",
    "Qwen3-32B": "Qwen3 32B",
    "gpt-oss-20b": "GPT-OSS 20B",
    "gpt-oss:20b": "GPT-OSS 20B",
    "Meta-Llama-3_3-70B-Instruct": "Llama 3.3 70B",
    "Meta-Llama-3.1-8B-Instruct": "Llama 3.1 8B",
    "Qwen2.5-VL-72B-Instruct": "Qwen2.5 VL 72B ⛐ (vision)",
    "Mistral-Small-3.2-24B-Instruct-2506": "Mistral Small 24B",
    "mistral-Nemo-Instruct-2407": "Mistral Nemo",
    "minimax-m2.7": "MiniMax M2.7"
  };

  /* Turn any unknown model id into a readable label:
     accounts/x/models/claude-fable-5  -> Claude Fable 5
     meta-llama/llama-3.3-70b-instruct -> Llama 3.3 70B Instruct
     llama-4-scout0                    -> Llama 4 Scout */
  function prettify(id) {
    var s = String(id || "").trim();
    if (!s) return "";
    s = s.replace(/^accounts\/[^/]+\/models\//i, "");
    s = s.split("/").pop();
    s = s.replace(/-(?:\d{8}|latest|instruct|free|turbo|preview)$/i, "");
    s = s.replace(/-0(?=$)/, "");
    s = s.replace(/[_-]+/g, " ");
    // 70b -> 70B, 4o -> 4o, r1 -> R1 (keep the classic lowercase-o suffix)
    s = s.replace(/\b(\d+(?:\.\d+)?)([a-z]{1,3})\b/gi, function (m, n, suf) {
      return suf === "o" ? n + "o" : n + suf.toUpperCase();
    });
    s = s.replace(/\b(?:gpt|o1|o3|r1|v3|v4)\b/gi, function (m) { return m.toUpperCase(); });
    return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); }).trim();
  }

  function displayName(id) {
    if (!id) return "";
    return LABELS[id] || prettify(id);
  }

  /* Quality order for the model picker: best first. Anything not listed here
     drops below the known models, sorted by display name. */
  var QUALITY = [
    "claude-4-opus", "claude-opus-4-8-20250618", "claude-opus-4-6-20250514", "claude-opus-4-6",
    "claude-4-sonnet", "claude-sonnet-4-6-20250514", "claude-sonnet-4-6",
    "claude-fable-5-20250514", "hermes/claude-fable-5-20250514", "accounts/euromodels/models/claude-fable-5",
    "claude-3-5-sonnet-20241022", "claude-3-5-sonnet-latest",
    "gpt-4o", "gpt-4.1", "o1", "o3-mini", "gemini-2.5-pro",
    "gpt-4o-mini", "gpt-4.1-mini", "gemini-2.5-flash",
    "deepseek-r1", "deepseek-v4-pro", "deepseek-v3", "deepseek-r1-7b",
    "claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022", "gemini-2.0-flash",
    "llama-4-maverick", "llama-4-scout", "qwen-max", "qwen3-72b",
    "kimi-k2.7", "kimi-k2.7-code", "llama3-70b", "llama3-8b",
    "glm-4-flash", "mistral-large", "mistral-7b",
    "command-r-plus", "command-r",
    "gpt-4-turbo", "gemini-1.5-pro", "claude-3-opus-20240229",
    "Mistral-Small-3.2-24B-Instruct-2506", "mistral-Nemo-Instruct-2407",
    "gpt-oss-20b", "gpt-oss:20b", "Meta-Llama-3_3-70B-Instruct",
    "Qwen3.6-27B", "Qwen3-32B", "Qwen3.5-397B-A17B",
    "Qwen2.5-VL-72B-Instruct", "minimax-m2.7"
  ];
  var QUALITY_INDEX = {};
  QUALITY.forEach(function (id, i) { QUALITY_INDEX[id] = i; });

  function rankModel(id) {
    var i = QUALITY_INDEX[id];
    return i === undefined ? QUALITY.length : i;
  }

  function load() {
    try {
      var raw = (window.__SAFE_LS__ || window.localStorage).getItem(LS_KEY);
      if (raw) { var p = JSON.parse(raw); if (p && p.convos) { S.convos = p.convos; S.active = p.active || null; } }
    } catch (e) {}
  }
  var syncTimer = null;
  var syncServer = false;
  function save() {
    try {
      (window.__SAFE_LS__ || window.localStorage).setItem(LS_KEY, JSON.stringify({ convos: S.convos, active: S.active }));
    } catch (e) {}
    /* Mirror conversations to the same-origin server (when the relay is up) so
       they follow the visitor across every site that shares the server
       (localhost, the tunnel, mirrors). Static/CDN builds just stay local. */
    if (!syncServer) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      var vid = "";
      try { vid = localStorage.getItem("chalkle_visitor") || ""; } catch (e) {}
      if (!vid) {
        vid = "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
        try { localStorage.setItem("chalkle_visitor", vid); } catch (e) {}
      }
      fetch("/api/ai/convos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ v: vid, convos: S.convos })
      }).catch(function () {});
    }, 700);
  }

  /* Pull conversations saved on the server (any site that shares this relay). */
  function fetchConvos() {
    var vid = "";
    try { vid = localStorage.getItem("chalkle_visitor") || ""; } catch (e) {}
    if (!vid) return Promise.resolve(false);
    return fetch("/api/ai/convos?v=" + encodeURIComponent(vid), { method: "GET" })
      .then(function (r) { if (!r.ok) throw new Error("bad"); return r.json(); })
      .then(function (d) {
        if (d && d.ok && d.convos) {
          Object.keys(d.convos).forEach(function (cid) {
            var sc = d.convos[cid];
            if (!sc || !sc.id) return;
            var local = S.convos[cid];
            if (!local || (sc.ts || 0) >= (local.ts || 0)) S.convos[cid] = sc;
          });
          save();
        }
        return true;
      })
      .catch(function () { return false; });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function el(id) { return document.getElementById(id); }
  function uid() { return Math.random().toString(36).slice(2, 9); }
  function ago(ts) {
    if (!ts) return "";
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }
  function toast(msg) {
    var d = document.createElement("div");
    d.className = "dh-toast ai-toast";
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(function () { d.classList.add("show"); }, 10);
    setTimeout(function () { d.classList.remove("show"); setTimeout(function () { d.remove(); }, 300); }, 2200);
  }

  /* ---------- probe the relay ---------- */
  function probe() {
    return fetch("/api/ai/models?_=" + Date.now(), { method: "GET" })
      .then(function (r) { if (!r.ok) throw new Error("bad"); return r.json(); })
      .then(function (d) {
        S.server = !!(d && d.ok);
        S.models = (d && Array.isArray(d.models) && d.models.length) ? d.models : [];
        syncServer = S.server;
        if (S.server) fetchConvos();
        return S.server;
      })
      .catch(function () { S.server = false; S.models = []; return false; });
  }
  function modelOptions() {
    var list = (S.models.length ? S.models : DEFAULTS).slice().sort(function (a, b) {
      var r = rankModel(a) - rankModel(b);
      if (r !== 0) return r;
      return displayName(a).localeCompare(displayName(b));
    });
    return list.map(function (m) { return '<option value="' + esc(m) + '">' + esc(displayName(m)) + "</option>"; }).join("");
  }

  /* ---------- conversation helpers ---------- */
  function newConvo() {
    var c = { id: uid(), title: "New chat", model: null, messages: [], ts: Date.now() };
    S.convos[c.id] = c;
    S.active = c.id;
    save();
    return c;
  }
  function activeConvo() {
    if (!S.active || !S.convos[S.active]) return newConvo();
    return S.convos[S.active];
  }

  /* ---------- render ---------- */
  var probed = false;
  function render() {
    var root = el("ai-view");
    if (!root) return;
    buildShell();
    /* Probe the relay once per page load, not on every tab switch - the
       shell and chat history stay put instead of flashing/rebuilding. */
    if (!probed) {
      probed = true;
      probe().then(function () { buildShell(); });
    }
  }

  function buildShell() {
    var root = el("ai-view");
    if (!root) return;
    var convo = activeConvo();

    var h = '<div class="ai-head">';
    h += '<div class="ai-heading"><h1 class="view-title">AI</h1>';
    h += '<span class="view-meta' + (S.server ? " has-content" : "") + '">' + (S.server ? S.models.length + " models online" : "offline, needs serve-chalk.py") + "</span></div>";
    h += '<div class="ai-head-actions">';
    h += '<select class="field field-mode ai-model" id="ai-model" aria-label="Pick a model"><option value="">Pick a model…</option>' + modelOptions() + "</select>";
    h += '<button class="btn ai-new" id="ai-new" type="button">＋ New chat</button>';
    h += "</div></div>";

    h += '<div class="ai-layout">';
    // sidebar: saved conversations
    h += '<aside class="ai-side">';
    var ids = Object.keys(S.convos).sort(function (a, b) { return S.convos[b].ts - S.convos[a].ts; });
    if (!ids.length) {
      h += '<div class="ai-side-empty">No chats yet.<br>Start one on the right.</div>';
    } else {
      h += '<div class="ai-side-title">Chats</div>';
      ids.forEach(function (id) {
        var c = S.convos[id];
        h += '<button class="ai-convo' + (id === S.active ? " is-active" : "") + '" data-ai-open="' + id + '" type="button">' +
          '<span class="ai-convo-t">' + esc(c.title || "New chat") + "</span>" +
          '<span class="ai-convo-m">' + esc(displayName(c.model) || "no model") + ", " + c.messages.length + " msgs</span></button>";
      });
    }
    h += "</aside>";

    // chat pane
    h += '<div class="ai-pane">';
    if (!S.server) {
      h += '<div class="ai-offline"><b>No AI server detected.</b> The AI tab needs the same-origin relay in <code>serve-chalk.py</code> (static/CDN builds can&rsquo;t reach the upstream). Start the server and this tab lights up.</div>';
    }
    h += '<div class="ai-modelrow">';
    h += '<span class="ai-pill">' + esc(displayName(convo.model) || "No model selected") + "</span>";
    h += '<span class="ai-pill dim">' + convo.messages.length + " messages</span>";
    h += "</div>";

    h += '<div class="ai-msgs" id="ai-msgs"></div>';

    h += '<div class="ai-attach-row" id="ai-attach-row"></div>';
    h += '<div class="ai-composer">';
    h += '<button class="btn ghost ai-paperclip" id="ai-attach" type="button" title="Attach images or files (or drag/paste them here)">' + PAPERCLIP + '</button>';
    h += '<input type="file" id="ai-file" multiple hidden accept="image/*,.txt,.md,.markdown,.html,.htm,.js,.mjs,.cjs,.css,.json,.csv,.tsv,.py,.sh,.bash,.zsh,.xml,.yml,.yaml,.svg,.log,.ini,.toml">';
    h += '<textarea id="ai-input" rows="2" placeholder="Message ' + esc(convo.model ? "the model" : "pick a model first") + '… (paste/drop files too)" aria-label="Message"></textarea>';
    h += '<button class="btn btn-accent ai-send" id="ai-send" type="button">Send</button>';
    h += "</div>";
    h += "</div>";
    h += "</div>";

    root.innerHTML = h;
    bindShell(convo);
  }

  function bindShell(convo) {
    var modelSel = el("ai-model");
    if (modelSel) {
      if (convo.model) modelSel.value = convo.model;
      modelSel.addEventListener("change", function () {
        convo.model = modelSel.value;
        save();
        buildShell();
      });
    }
    var newBtn = el("ai-new");
    if (newBtn) newBtn.addEventListener("click", function () {
      newConvo();
      buildShell();
    });
    var root = el("ai-view");
    if (root) root.querySelectorAll("[data-ai-open]").forEach(function (b) {
      b.addEventListener("click", function () {
        S.active = b.getAttribute("data-ai-open");
        save();
        buildShell();
      });
    });
    var send = el("ai-send");
    if (send) send.addEventListener("click", sendMsg);
    var input = el("ai-input");
    if (input) input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); }
    });
    /* attach button + drag/drop + paste-to-attach */
    var fileBtn = el("ai-attach");
    var fileInput = el("ai-file");
    if (fileBtn && fileInput) fileBtn.addEventListener("click", function () { fileInput.click(); });
    if (fileInput) fileInput.addEventListener("change", function () {
      handleFiles(fileInput.files);
      fileInput.value = "";
    });
    var composer = root ? root.querySelector(".ai-composer") : null;
    if (composer) {
      composer.addEventListener("dragover", function (e) { e.preventDefault(); });
      composer.addEventListener("drop", function (e) {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
      });
      composer.addEventListener("paste", function (e) {
        var items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        var files = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === "file" && items[i].getAsFile) {
            var f = items[i].getAsFile();
            if (f) files.push(f);
          }
        }
        if (files.length) { e.preventDefault(); handleFiles(files); }
      });
    }
    renderAttachRow();
    renderMsgs();
  }

  function renderMsgs() {
    var box = el("ai-msgs");
    if (!box) return;
    var convo = activeConvo();
    if (!convo.messages.length) {
      box.innerHTML = '<div class="ai-empty"><div class="ai-empty-ico">✦</div>' +
        '<h3>Chat with AI</h3><p>Pick a model, type a message, and watch the reply stream in.</p>' +
        '<p class="ai-empty-sub">Attach images (png/jpg/webp), text files or code (txt/html/js/css…) with the 📎 button, or just paste/drop them here. Upload a file and ask the AI to read or edit it.</p></div>';
      return;
    }
    var h = "";
    convo.messages.forEach(function (m, i) {
      h += msgHTML(m, i);
    });
    box.innerHTML = h;
    box.scrollTop = box.scrollHeight;
    box.querySelectorAll("[data-act]").forEach(function (b) {
      b.addEventListener("click", function () {
        var mi = Number(b.getAttribute("data-i"));
        var m = convo.messages[mi];
        if (!m) return;
        var txt = contentToText(m.content);
        if (b.getAttribute("data-act") === "copy") {
          var ta = document.createElement("textarea");
          ta.value = txt;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); toast("Copied"); } catch (e) {}
          ta.remove();
        } else {
          var blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
          var a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "chalkle-ai-reply.txt";
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { a.remove(); URL.revokeObjectURL(a.href); }, 300);
        }
      });
    });
  }
  function msgContentHTML(c) {
    if (Array.isArray(c)) {
      var h = "";
      c.forEach(function (p) {
        if (!p) return;
        if (p.type === "image_url") {
          h += '<img class="ai-msg-img" src="' + esc((p.image_url && p.image_url.url) || "") + '" alt="attached image" loading="lazy">';
        } else if (p.type === "text") {
          var t = String(p.text || "");
          if (t.trim()) h += "<div>" + esc(t).replace(/\n/g, "<br>") + "</div>";
        }
      });
      return h;
    }
    return esc(c == null ? "" : c).replace(/\n/g, "<br>");
  }
  function msgHTML(m, i) {
    var user = m.role === "user";
    var body = msgContentHTML(m.content);
    var actions = "";
    if (!user && contentToText(m.content).trim()) {
      actions = '<div class="ai-msg-actions">' +
        '<button type="button" class="ai-act" data-act="copy" data-i="' + i + '">Copy</button>' +
        '<button type="button" class="ai-act" data-act="save" data-i="' + i + '">Save .txt</button></div>';
    }
    return '<div class="ai-msg ' + (user ? "user" : "bot") + '">' +
      '<div class="ai-msg-bubble">' + body + actions + "</div></div>";
  }

  /* ---------- attachments ---------- */
  var ATTACH = []; // { kind: "image"|"text", name, size, dataUrl|content }
  var TEXT_EXT = /\.(txt|md|markdown|html?|js|mjs|cjs|css|json|csv|tsv|py|sh|bash|zsh|xml|ya?ml|log|ini|cfg|conf|env|svg|ts|jsx|tsx|sql|java|c|cpp|h|rs|go|rb|php|ps1|bat|toml|yaml)$/i;

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    files.forEach(function (f) {
      if (ATTACH.length >= 6) { toast("Max 6 attachments"); return; }
      var type = String(f.type || "").toLowerCase();
      var name = f.name || "file";
      if (type.indexOf("image/") === 0 && type !== "image/svg+xml") {
        readImage(f, name);
      } else if (type === "image/svg+xml" || TEXT_EXT.test(name) || type.indexOf("text/") === 0 || type.indexOf("json") === 0 || type.indexOf("xml") === 0) {
        readText(f, name, false);
      } else {
        readText(f, name, true);
      }
    });
  }

  function readText(file, name, probeBinary) {
    var r = new FileReader();
    r.onload = function () {
      var text = String(r.result || "");
      if (probeBinary && /[\u0000-\u0008\u000e-\u001f]/.test(text.slice(0, 2000))) {
        toast(name + ": binary files aren't readable");
        return;
      }
      if (text.length > 60000) text = text.slice(0, 60000) + "\n…[truncated]";
      ATTACH.push({ kind: "text", name: name, size: file.size || text.length, content: text });
      renderAttachRow();
    };
    r.onerror = function () { toast(name + ": could not read file"); };
    r.readAsText(file, "utf-8");
  }

  function readImage(file, name) {
    var r = new FileReader();
    r.onload = function () {
      var img = new Image();
      img.onload = function () {
        var MAX = 1280, w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          var sc = MAX / Math.max(w, h);
          w = Math.round(w * sc); h = Math.round(h * sc);
        }
        var cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        ATTACH.push({ kind: "image", name: name, size: file.size, dataUrl: cv.toDataURL("image/jpeg", 0.85) });
        renderAttachRow();
      };
      img.onerror = function () { toast(name + ": could not read image"); };
      img.src = String(r.result);
    };
    r.onerror = function () { toast(name + ": could not read file"); };
    r.readAsDataURL(file);
  }

  function renderAttachRow() {
    var row = el("ai-attach-row");
    if (!row) return;
    if (!ATTACH.length) { row.innerHTML = ""; return; }
    row.innerHTML = ATTACH.map(function (a, i) {
      var preview = a.kind === "image"
        ? '<img class="ai-att-prev" src="' + a.dataUrl + '" alt="">'
        : '<span class="ai-att-ico">📄</span>';
      return '<span class="ai-att" title="' + esc(a.name) + '">' + preview +
        '<span class="ai-att-name">' + esc(a.name) + "</span>" +
        '<button type="button" class="ai-att-x" data-i="' + i + '" aria-label="Remove">×</button></span>';
    }).join("");
    row.querySelectorAll(".ai-att-x").forEach(function (b) {
      b.addEventListener("click", function () {
        ATTACH.splice(Number(b.getAttribute("data-i")), 1);
        renderAttachRow();
      });
    });
  }

  /* OpenAI-style content for a message built from text + attachments. */
  function buildContent(text) {
    if (!ATTACH.length) return text;
    var parts = [];
    ATTACH.forEach(function (a) {
      if (a.kind === "image") {
        parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
      } else {
        parts.push({ type: "text", text: "\n<file name=\"" + a.name + "\">\n" + a.content + "\n</file>\n" });
      }
    });
    if (text && text.trim()) parts.push({ type: "text", text: text });
    return parts;
  }

  function contentHasImage(c) {
    if (Array.isArray(c)) {
      for (var i = 0; i < c.length; i++) if (c[i] && c[i].type === "image_url") return true;
    }
    return false;
  }

  function contentToText(c) {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      var out = [];
      c.forEach(function (p) {
        if (!p) return;
        if (p.type === "text") out.push(String(p.text || ""));
        else if (p.type === "image_url") out.push("[image]");
      });
      return out.join("\n");
    }
    return String(c == null ? "" : c);
  }

  /* ---------- send ---------- */
  var busy = false;
  function sendMsg() {
    if (busy) return;
    var input = el("ai-input");
    var modelSel = el("ai-model");
    var model = modelSel ? modelSel.value : "";
    if (!model) { toast("Pick a model first"); if (modelSel) modelSel.focus(); return; }    var text = (input ? input.value : "").trim();
    if (!text && !ATTACH.length) return;

    var convo = activeConvo();
    convo.model = model;
    var content = buildContent(text);
    convo.messages.push({ role: "user", content: content });
    convo.ts = Date.now();
    if (convo.title === "New chat") convo.title = (text || (ATTACH[0] ? ATTACH[0].name : "Attachment")).slice(0, 42);
    save();
    if (input) input.value = "";
    ATTACH = [];
    renderAttachRow();
    renderMsgs();
    busy = true;
    setSendState(true);
    streamReply(convo, contentHasImage(content));
  }

  function setSendState(on) {
    var send = el("ai-send");
    var input = el("ai-input");
    if (send) { send.disabled = on; send.textContent = on ? "…" : "Send"; }
    if (input) input.disabled = on;
  }

  function streamReply(convo, vision) {
    // placeholder bot bubble
    convo.messages.push({ role: "assistant", content: "" });
    save();
    renderMsgs();
    var box = el("ai-msgs");
    var lastEl = box ? box.lastElementChild : null;

    var payload = { model: convo.model, messages: convo.messages.slice(0, -1), stream: true, vision: !!vision };
    fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
      var reader = r.body.getReader();
      var dec = new TextDecoder();
      var buf = "";
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) { finish(); return; }
          buf += dec.decode(res.value, { stream: true });
          var lines = buf.split("\n");
          buf = lines.pop();
          lines.forEach(handleSSE);
          return pump();
        });
      }
      function handleSSE(line) {
        var t = line.trim();
        if (!t || t.indexOf("data:") !== 0) return;
        var data = t.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          var j = JSON.parse(data);
          var delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (typeof delta === "string" && delta) append(delta);
        } catch (e) {}
      }
      function append(txt) {
        var m = convo.messages[convo.messages.length - 1];
        m.content = (m.content || "") + txt;
        if (lastEl) {
          var bubble = lastEl.querySelector(".ai-msg-bubble");
          if (bubble) bubble.innerHTML = esc(m.content).replace(/\n/g, "<br>");
          var box2 = el("ai-msgs");
          if (box2) box2.scrollTop = box2.scrollHeight;
        }
        /* Persist at most every 1.5s during streaming; save() stringifies all
           conversations and queues a server sync, and doing that per token
           makes the stream stutter. finish() saves the final text anyway. */
        var now = Date.now();
        if (!append.lastSave || now - append.lastSave > 1500) {
          append.lastSave = now;
          save();
        }
      }
      function finish() {
        var m = convo.messages[convo.messages.length - 1];
        if (!m || !m.content) m.content = "(empty reply)";
        save(); /* final save always runs, so nothing is lost */
        renderMsgs(); /* re-render so Copy / Save .txt actions appear */
        busy = false;
        setSendState(false);
      }
      return pump();
    }).catch(function (e) {
      var m = convo.messages[convo.messages.length - 1];
      m.content = "Request failed: " + (e && e.message ? e.message : "try again");
      save(); renderMsgs(); busy = false; setSendState(false);
    });
  }

  window.ChalkleAI = { render: render, probe: probe, getState: function () { return S; } };

  document.addEventListener("DOMContentLoaded", function () {
    // nothing modal-specific needed; render is called by app.js on view switch
  });
})();