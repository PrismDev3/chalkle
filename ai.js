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
  var DEFAULTS = [
    "hermes/claude-fable-5-20250514",
    "accounts/euromodels/models/claude-fable-5",
    "claude-4-sonnet",
    "claude-4-opus",
    "gpt-4o",
    "gpt-4o-mini",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "deepseek-r1",
    "deepseek-v4-pro",
    "llama3-70b",
    "mistral-large",
    "qwen-max",
    "glm-4-flash"
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
    "command-r-plus": "Command R+"
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
    "gpt-4-turbo", "gemini-1.5-pro", "claude-3-opus-20240229"
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
  function save() {
    try {
      (window.__SAFE_LS__ || window.localStorage).setItem(LS_KEY, JSON.stringify({ convos: S.convos, active: S.active }));
    } catch (e) {}
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
  function render() {
    var root = el("ai-view");
    if (!root) return;
    if (!S.models.length && !S.server) {
      // First render: probe. Keep the shell visible immediately.
    }
    buildShell();
    probe().then(function () { buildShell(); });
  }

  function buildShell() {
    var root = el("ai-view");
    if (!root) return;
    var convo = activeConvo();

    var h = '<div class="ai-head">';
    h += '<div class="ai-heading"><h1 class="view-title">AI</h1>';
    h += '<span class="view-meta' + (S.server ? " has-content" : "") + '">' + (S.server ? S.models.length + " models online" : "offline · needs serve-chalk.py") + "</span></div>";
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
          '<span class="ai-convo-m">' + esc(displayName(c.model) || "no model") + " · " + c.messages.length + " msgs</span></button>";
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

    h += '<div class="ai-composer">';
    h += '<textarea id="ai-input" rows="2" placeholder="Message ' + esc(convo.model ? "the model" : "pick a model first") + '…" aria-label="Message"></textarea>';
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
    renderMsgs();
  }

  function renderMsgs() {
    var box = el("ai-msgs");
    if (!box) return;
    var convo = activeConvo();
    if (!convo.messages.length) {
      box.innerHTML = '<div class="ai-empty"><div class="ai-empty-ico">✦</div>' +
        '<h3>Chat with AI</h3><p>Pick a model, type a message, and watch the reply stream in.</p></div>';
      return;
    }
    var h = "";
    convo.messages.forEach(function (m) {
      h += msgHTML(m);
    });
    box.innerHTML = h;
    box.scrollTop = box.scrollHeight;
  }
  function msgHTML(m) {
    var user = m.role === "user";
    return '<div class="ai-msg ' + (user ? "user" : "bot") + '">' +
      '<div class="ai-msg-bubble">' + (m.content === undefined || m.content === null ? "" : esc(m.content).replace(/\n/g, "<br>")) + "</div>" +
      "</div>";
  }

  /* ---------- send ---------- */
  var busy = false;
  function sendMsg() {
    if (busy) return;
    var input = el("ai-input");
    var modelSel = el("ai-model");
    var model = modelSel ? modelSel.value : "";
    if (!model) { toast("Pick a model first"); if (modelSel) modelSel.focus(); return; }
    var text = (input ? input.value : "").trim();
    if (!text) return;
    var convo = activeConvo();
    convo.model = model;
    convo.messages.push({ role: "user", content: text });
    convo.ts = Date.now();
    if (convo.title === "New chat") convo.title = text.slice(0, 42);
    save();
    if (input) input.value = "";
    renderMsgs();
    busy = true;
    setSendState(true);
    streamReply(convo);
  }

  function setSendState(on) {
    var send = el("ai-send");
    var input = el("ai-input");
    if (send) { send.disabled = on; send.textContent = on ? "…" : "Send"; }
    if (input) input.disabled = on;
  }

  function streamReply(convo) {
    // placeholder bot bubble
    convo.messages.push({ role: "assistant", content: "" });
    save();
    renderMsgs();
    var box = el("ai-msgs");
    var lastEl = box ? box.lastElementChild : null;

    var payload = { model: convo.model, messages: convo.messages.slice(0, -1), stream: true };
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
        save();
      }
      function finish() {
        var m = convo.messages[convo.messages.length - 1];
        if (!m || !m.content) m.content = "(empty reply)";
        save();
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