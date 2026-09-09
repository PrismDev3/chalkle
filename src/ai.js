/* ════════════════════════════════════════════════════════════════════════
   Chalkle · AI
   ------------------------------------------------------------------------
   A first-class AI tab: pick a model, chat, stream the reply. On the hosted
   site requests ride the same-origin relay (/api/ai/*) and the server
   injects its universal OpenRouter key - chat works for everyone with
   zero setup. On static mirrors (no relay) a visitor can optionally paste
   their own key and the tab talks to OpenRouter directly.

   Both paths speak the OpenAI chat-completions format, so streaming uses
   the standard SSE shape (choices[].delta.content). Conversations are
   saved locally and mirrored to the server when the relay is up.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  /* Conversation sync still rides the same-origin relay when it exists
     (self-hosted); on static/CDN builds the sync calls fail silently. */
  function apiUrl(path) {
    return window.ChalkleApi ? window.ChalkleApi.url(path) : path;
  }

  var OR_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
  var OR_MODELS_URL = "https://openrouter.ai/api/v1/models";
  var RELAY_CHAT = "/api/ai/chat";
  var RELAY_MODELS = "/api/ai/models";
  var KEY_KEY = "chalkle-openrouter-key";

  function getKey() {
    try { return String(localStorage.getItem(KEY_KEY) || "").trim(); } catch (e) { return ""; }
  }
  function setKey(k) {
    try {
      var v = String(k || "").trim();
      if (v) localStorage.setItem(KEY_KEY, v); else localStorage.removeItem(KEY_KEY);
    } catch (e) { /* private mode */ }
  }
  /* A personal key only matters on mirrors where the relay doesn't exist;
     the hosted site always has the server's universal key. */
  function hasServerKey() { return S.server; }

  var LS_KEY = "chalkle.ai.v2";
  var PAPERCLIP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
  /* Offline fallback list (real OpenRouter ids), shown only when the live
     model list hasn't loaded. Best first. */
  var DEFAULTS = [
    "openai/gpt-5.6-luna",
    "anthropic/claude-sonnet-5",
    "google/gemini-3.5-flash",
    "x-ai/grok-4.6",
    "deepseek/deepseek-chat-v3.1",
    "moonshotai/kimi-k3",
    "qwen/qwen3.7-flash",
    "z-ai/glm-5.3"
  ];
  /* Only real OpenRouter vendor prefixes make the picker. Anything else
     (roleplay fine-tunes, obscure one-offs) is filtered out. */
  var OR_VENDORS = [
    "anthropic/", "openai/", "google/", "x-ai/", "deepseek/", "moonshotai/",
    "qwen/", "meta-llama/", "meta/", "mistralai/", "z-ai/", "minimax/",
    "microsoft/", "cohere/", "amazon/", "perplexity/", "nvidia/"
  ];
  function curateModels(list) {
    var seen = {}, out = [];
    list.forEach(function (id) {
      if (!id || /:(?:free|floor|batch)$/i.test(id)) return;
      if (!OR_VENDORS.some(function (v) { return id.indexOf(v) === 0; })) return;
      if (seen[id]) return;
      seen[id] = 1;
      out.push(id);
    });
    out.sort(function (a, b) {
      var r = rankModel(a) - rankModel(b);
      if (r !== 0) return r;
      return displayName(a).localeCompare(displayName(b));
    });
    return out.slice(0, 60);
  }

  var S = {
    models: [],          // real model ids from the relay
    server: true,        // optimistic: assume the relay is up; probe() corrects
    active: null,        // active conversation id
    convos: {}           // id -> { id, title, model, messages: [{role, content}], ts }
  };

  /* Friendly names for the raw model ids the upstream reports. Unknown ids
     fall back to prettify(), so the picker never shows "accounts/foo/models/
     claude-fable-5-20250514"-style noise. */
  var LABELS = {
    "anthropic/claude-opus-5": "Claude Opus 5",
    "anthropic/claude-sonnet-5": "Claude Sonnet 5",
    "anthropic/claude-fable-5.1": "Claude Fable 5.1",
    "anthropic/claude-fable-5": "Claude Fable 5",
    "anthropic/claude-opus-4.8": "Claude Opus 4.8",
    "anthropic/claude-opus-4.7": "Claude Opus 4.7",
    "anthropic/claude-opus-4.6": "Claude Opus 4.6",
    "anthropic/claude-opus-4.5": "Claude Opus 4.5",
    "anthropic/claude-sonnet-4.6": "Claude Sonnet 4.6",
    "anthropic/claude-sonnet-4.5": "Claude Sonnet 4.5",
    "anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
    "openai/gpt-6-astra-pro": "GPT-6 Astra Pro",
    "openai/gpt-6-astra": "GPT-6 Astra",
    "openai/gpt-5.6-luna-pro": "GPT-5.6 Luna Pro",
    "openai/gpt-5.6-luna": "GPT-5.6 Luna",
    "openai/gpt-5.6-terra-pro": "GPT-5.6 Terra Pro",
    "openai/gpt-5.6-terra": "GPT-5.6 Terra",
    "openai/gpt-5.6-sol-pro": "GPT-5.6 Sol Pro",
    "openai/gpt-5.6-sol": "GPT-5.6 Sol",
    "openai/gpt-5.5-pro": "GPT-5.5 Pro",
    "openai/gpt-5.5": "GPT-5.5",
    "openai/gpt-5.4-pro": "GPT-5.4 Pro",
    "openai/gpt-5.4": "GPT-5.4",
    "openai/gpt-5.4-mini": "GPT-5.4 Mini",
    "openai/gpt-5.4-nano": "GPT-5.4 Nano",
    "openai/gpt-5.2-pro": "GPT-5.2 Pro",
    "openai/gpt-5.2": "GPT-5.2",
    "openai/gpt-5.1": "GPT-5.1",
    "openai/gpt-5-pro": "GPT-5 Pro",
    "openai/gpt-5": "GPT-5",
    "openai/gpt-5-mini": "GPT-5 Mini",
    "openai/gpt-5-nano": "GPT-5 Nano",
    "openai/o3-pro": "OpenAI o3-pro",
    "openai/o3": "OpenAI o3",
    "openai/o4-mini": "OpenAI o4-mini",
    "openai/o4-mini-high": "OpenAI o4-mini-high",
    "openai/gpt-4o": "GPT-4o",
    "openai/gpt-4o-mini": "GPT-4o mini",
    "openai/gpt-4.1": "GPT-4.1",
    "openai/gpt-4.1-mini": "GPT-4.1 mini",
    "openai/gpt-4-turbo": "GPT-4 Turbo",
    "openai/gpt-chat-latest": "GPT Chat",
    "openai/gpt-oss-120b": "GPT-OSS 120B",
    "openai/gpt-oss-20b": "GPT-OSS 20B",
    "google/gemini-3.1-pro-preview": "Gemini 3.1 Pro",
    "google/gemini-3.5-flash": "Gemini 3.5 Flash",
    "google/gemini-3.6-flash": "Gemini 3.6 Flash",
    "google/gemini-3.7-flash": "Gemini 3.7 Flash",
    "google/gemini-3.8-flash": "Gemini 3.8 Flash",
    "google/gemini-3.5-flash-lite": "Gemini 3.5 Flash Lite",
    "google/gemini-2.5-pro": "Gemini 2.5 Pro",
    "google/gemini-2.5-flash": "Gemini 2.5 Flash",
    "google/gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
    "google/gemma-4-31b-it": "Gemma 4 31B",
    "google/gemma-3-27b-it": "Gemma 3 27B",
    "x-ai/grok-4.6": "Grok 4.6",
    "x-ai/grok-4.5": "Grok 4.5",
    "x-ai/grok-4.3": "Grok 4.3",
    "x-ai/grok-4.20": "Grok 4.20",
    "deepseek/deepseek-v4-pro": "DeepSeek V4 Pro",
    "deepseek/deepseek-v4-pro-0813": "DeepSeek V4 Pro (0813)",
    "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash",
    "deepseek/deepseek-v4-flash-0731": "DeepSeek V4 Flash (0731)",
    "deepseek/deepseek-v3.2": "DeepSeek V3.2",
    "deepseek/deepseek-chat-v3.1": "DeepSeek V3.1",
    "deepseek/deepseek-chat-v3-0324": "DeepSeek V3 (0324)",
    "deepseek/deepseek-chat": "DeepSeek Chat",
    "deepseek/deepseek-r1-0528": "DeepSeek R1",
    "deepseek/deepseek-r1": "DeepSeek R1 (orig)",
    "moonshotai/kimi-k3": "Kimi K3",
    "moonshotai/kimi-k2.7-code": "Kimi K2.7 Code",
    "moonshotai/kimi-k2.6": "Kimi K2.6",
    "moonshotai/kimi-k2-thinking": "Kimi K2 Thinking",
    "moonshotai/kimi-k2": "Kimi K2",
    "qwen/qwen3.8-max-0902": "Qwen3.8 Max",
    "qwen/qwen3.7-max": "Qwen3.7 Max",
    "qwen/qwen3.7-plus": "Qwen3.7 Plus",
    "qwen/qwen3.7-flash": "Qwen3.7 Flash",
    "qwen/qwen3.6-max-preview": "Qwen3.6 Max",
    "qwen/qwen3.6-plus": "Qwen3.6 Plus",
    "qwen/qwen3.6-flash": "Qwen3.6 Flash",
    "qwen/qwen3.5-27b": "Qwen3.5 27B",
    "qwen/qwen3.5-9b": "Qwen3.5 9B",
    "qwen/qwen3-32b": "Qwen3 32B",
    "meta-llama/llama-4-maverick": "Llama 4 Maverick",
    "meta-llama/llama-4-scout": "Llama 4 Scout",
    "meta-llama/llama-3.3-70b-instruct": "Llama 3.3 70B",
    "mistralai/mistral-large-2512": "Mistral Large",
    "mistralai/mistral-medium-3.1": "Mistral Medium 3.1",
    "mistralai/mistral-medium-3-5": "Mistral Medium 3.5",
    "mistralai/mistral-small-3.2-24b-instruct": "Mistral Small 3.2",
    "mistralai/codestral-2508": "Codestral",
    "mistralai/mistral-nemo": "Mistral Nemo",
    "z-ai/glm-5.3": "GLM 5.3",
    "z-ai/glm-5.3-flash": "GLM 5.3 Flash",
    "z-ai/glm-5.2": "GLM 5.2",
    "z-ai/glm-5v-turbo": "GLM 5V Turbo",
    "z-ai/glm-4.7": "GLM 4.7",
    "z-ai/glm-4.6v": "GLM 4.6V",
    "minimax/minimax-m3": "MiniMax M3",
    "minimax/minimax-m2.7": "MiniMax M2.7",
    "microsoft/phi-4": "Phi 4",
    "cohere/command-a": "Command A",
    "cohere/command-r-plus-08-2024": "Command R+",
    "amazon/nova-premier-v1": "Nova Premier",
    "amazon/nova-pro-v1": "Nova Pro",
    "perplexity/sonar-pro": "Sonar Pro",
    "perplexity/sonar-reasoning-pro": "Sonar Reasoning Pro",
    "nvidia/nemotron-3-ultra-550b-a55b": "Nemotron 3 Ultra"
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
    // Anthropic
    "anthropic/claude-opus-5", "anthropic/claude-sonnet-5",
    "anthropic/claude-fable-5.1", "anthropic/claude-fable-5",
    "anthropic/claude-opus-4.8", "anthropic/claude-opus-4.7", "anthropic/claude-opus-4.6",
    "anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-4.5", "anthropic/claude-haiku-4.5",
    // OpenAI
    "openai/gpt-6-astra-pro", "openai/gpt-6-astra",
    "openai/gpt-5.6-luna-pro", "openai/gpt-5.6-terra-pro", "openai/gpt-5.6-sol-pro",
    "openai/gpt-5.6-luna", "openai/gpt-5.6-terra", "openai/gpt-5.6-sol",
    "openai/gpt-5.5-pro", "openai/gpt-5.4-pro", "openai/gpt-5.2-pro", "openai/gpt-5-pro",
    "openai/gpt-5.5", "openai/gpt-5.4", "openai/gpt-5.2", "openai/gpt-5.1", "openai/gpt-5",
    "openai/o3-pro", "openai/o3", "openai/o4-mini-high", "openai/o4-mini",
    "openai/gpt-5.4-mini", "openai/gpt-5-mini", "openai/gpt-5.4-nano", "openai/gpt-5-nano",
    "openai/gpt-chat-latest", "openai/gpt-4o", "openai/gpt-4.1", "openai/gpt-4o-mini",
    "openai/gpt-4.1-mini", "openai/gpt-4-turbo", "openai/gpt-oss-120b", "openai/gpt-oss-20b",
    // Google
    "google/gemini-3.1-pro-preview", "google/gemini-2.5-pro", "google/gemini-2.5-pro-preview",
    "google/gemini-3.8-flash", "google/gemini-3.7-flash", "google/gemini-3.6-flash",
    "google/gemini-3.5-flash", "google/gemini-2.5-flash", "google/gemini-3.5-flash-lite",
    "google/gemini-2.5-flash-lite", "google/gemma-4-31b-it", "google/gemma-3-27b-it",
    // xAI
    "x-ai/grok-4.6", "x-ai/grok-4.5", "x-ai/grok-4.3", "x-ai/grok-4.20",
    // DeepSeek
    "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro-0813",
    "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash-0731",
    "deepseek/deepseek-v3.2", "deepseek/deepseek-chat-v3.1", "deepseek/deepseek-r1-0528",
    "deepseek/deepseek-chat-v3-0324", "deepseek/deepseek-chat", "deepseek/deepseek-r1",
    // Moonshot
    "moonshotai/kimi-k3", "moonshotai/kimi-k2-thinking", "moonshotai/kimi-k2.6",
    "moonshotai/kimi-k2.7-code", "moonshotai/kimi-k2",
    // Qwen
    "qwen/qwen3.8-max-0902", "qwen/qwen3.7-max", "qwen/qwen3.7-plus", "qwen/qwen3.7-flash",
    "qwen/qwen3.6-max-preview", "qwen/qwen3.6-plus", "qwen/qwen3.6-flash",
    "qwen/qwen3.5-27b", "qwen/qwen3-32b",
    // Meta
    "meta-llama/llama-4-maverick", "meta-llama/llama-4-scout", "meta-llama/llama-3.3-70b-instruct",
    // Mistral
    "mistralai/mistral-large-2512", "mistralai/mistral-medium-3.1", "mistralai/mistral-medium-3-5",
    "mistralai/mistral-small-3.2-24b-instruct", "mistralai/codestral-2508", "mistralai/mistral-nemo",
    // z-ai
    "z-ai/glm-5.3", "z-ai/glm-5.3-flash", "z-ai/glm-5.2", "z-ai/glm-5v-turbo",
    "z-ai/glm-4.7", "z-ai/glm-4.6v", "z-ai/glm-4.5v", "z-ai/glm-4.5-air",
    // everyone else from the good vendors
    "minimax/minimax-m3", "minimax/minimax-m2.7", "microsoft/phi-4",
    "cohere/command-a", "cohere/command-r-plus-08-2024",
    "amazon/nova-premier-v1", "amazon/nova-pro-v1",
    "perplexity/sonar-reasoning-pro", "perplexity/sonar-pro",
    "nvidia/nemotron-3-ultra-550b-a55b"
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
      fetch(apiUrl("/api/ai/convos"), {
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
    return fetch(apiUrl("/api/ai/convos?v=" + encodeURIComponent(vid)), { method: "GET" })
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
  function clock(ts) {
    var d = new Date(ts || Date.now());
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function toast(msg) {
    var d = document.createElement("div");
    d.className = "dh-toast ai-toast";
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(function () { d.classList.add("show"); }, 10);
    setTimeout(function () { d.classList.remove("show"); setTimeout(function () { d.remove(); }, 300); }, 2200);
  }

  /* ---------- probe the relay (or OpenRouter with a personal key) ---------- */
  function probe() {
    var key = getKey();
    if (key) {
      /* Personal key present: use it, so mirrors and power users get their
         own OpenRouter account and model list. */
      return fetch(OR_MODELS_URL, { headers: { Authorization: "Bearer " + key } })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (d) {
          var list = (d && Array.isArray(d.data)) ? d.data.map(function (m) { return m && m.id; }).filter(Boolean) : [];
          S.models = curateModels(list);
          S.server = S.models.length > 0;
          S.lastCheck = Date.now();
          syncServer = S.server;
          if (S.server && Object.keys(S.convos).length) fetchConvos();
          return S.server;
        })
        .catch(function () { S.server = false; S.models = []; return false; });
    }
    /* No personal key: rely on the server's universal key via the relay. */
    return fetch(apiUrl(RELAY_MODELS), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (d) {
        var list = (d && Array.isArray(d.models)) ? d.models.filter(Boolean) : [];
        S.models = curateModels(list);
        S.server = S.models.length > 0;
        S.lastCheck = Date.now();
        syncServer = S.server;
        if (S.server && Object.keys(S.convos).length) fetchConvos();
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
    h += '<span class="view-meta' + (S.server ? " has-content" : "") + '" title="' + (S.server ? "Chat runs on the site's AI server" : "AI server unreachable - add a key to chat") + '">' + (S.server ? S.models.length + " models · checked " + (S.lastCheck ? clock(S.lastCheck) : "just now") : (getKey() ? "checking OpenRouter…" : "waiting for the AI server…")) + "</span></div>";
    var keySet = !!getKey();
    h += '<div class="ai-head-actions">';
    h += '<button class="btn ghost ai-key-btn' + (keySet ? " is-set" : "") + '" id="ai-key-btn" type="button" title="Optional personal OpenRouter key for mirrors">' + (keySet ? "key set" : "API key") + '</button>';
    h += '<select class="field field-mode ai-model" id="ai-model" aria-label="Pick a model"><option value="">Pick a model…</option>' + modelOptions() + "</select>";
    h += '<button class="btn ai-new" id="ai-new" type="button">＋ New chat</button>';
    h += "</div></div>";
    h += '<div class="ai-keyrow" id="ai-keyrow" hidden>' +
      '<input class="field ai-key-input" id="ai-key-input" type="password" placeholder="sk-or-v1-…" autocomplete="off" spellcheck="false" aria-label="OpenRouter API key">' +
      '<button class="btn" id="ai-key-save" type="button">Save</button>' +
      '<button class="btn ghost" id="ai-key-clear" type="button">Remove</button>' +
      '<span class="ai-key-hint">Optional. Only needed on mirrors; the main site provides AI for everyone.</span>' +
      "</div>";

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
      h += '<div class="ai-offline"><b>' + (getKey() ? "OpenRouter didn\u2019t respond." : "The AI server isn\u2019t reachable here.") + '</b> On mirrors you can add your own OpenRouter key to chat. ' + (getKey() ? "Check the key and try again." : "Paste a key above, pick a model, and you\u2019re set.") + '</div>';
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
    var keyBtn = el("ai-key-btn");
    var keyRow = el("ai-keyrow");
    var keyInput = el("ai-key-input");
    if (keyBtn && keyRow) keyBtn.addEventListener("click", function () {
      keyRow.hidden = !keyRow.hidden;
      if (!keyRow.hidden && keyInput) { keyInput.value = getKey(); keyInput.focus(); }
    });
    var keySave = el("ai-key-save");
    if (keySave) keySave.addEventListener("click", function () {
      var k = keyInput ? keyInput.value.trim() : "";
      if (!k) { toast("Paste your OpenRouter key first"); return; }
      setKey(k);
      if (keyRow) keyRow.hidden = true;
      toast("Key saved");
      probed = false;
      render();
    });
    var keyClear = el("ai-key-clear");
    if (keyClear) keyClear.addEventListener("click", function () {
      setKey("");
      if (keyRow) keyRow.hidden = true;
      toast("Key removed");
      probed = false;
      render();
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
    var keyBtn = el("ai-key-btn");
    /* The server's universal key carries the chat on the hosted site; a
       personal key is only required when the relay is unreachable. */
    if (!S.server && !getKey()) {
      toast("Add your OpenRouter key first");
      if (keyBtn) keyBtn.click();
      return;
    }
    var input = el("ai-input");
    var modelSel = el("ai-model");
    var model = modelSel ? modelSel.value : "";
    if (!model) { toast("Pick a model first"); if (modelSel) modelSel.focus(); return; }
    var text = (input ? input.value : "").trim();
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
    /* Personal key set: talk to OpenRouter directly (works on mirrors).
       Otherwise: the relay, which carries the server's universal key. */
    var key = getKey();
    var useRelay = !key;
    fetch(useRelay ? apiUrl(RELAY_CHAT) : OR_ENDPOINT, {
      method: "POST",
      headers: Object.assign(
        { "Content-Type": "application/json", "HTTP-Referer": location.origin, "X-Title": "Chalkle" },
        useRelay ? {} : { "Authorization": "Bearer " + key }
      ),
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var msg = (j && j.error && (j.error.message || (typeof j.error === "string" ? j.error : ""))) || (j && j.detail) || ("HTTP " + r.status);
          throw new Error(msg);
        });
      }
      if (!r.body) throw new Error("No stream");
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
