/* Chalkle HTML Editor app. Write, preview, format, inspect, launch, and export
   HTML. Saved locally. Own modal and wiring.

   Highlights:
   - Live preview pane with optional INSPECT mode: hover an element in the
     preview and the matching tag is outlined there AND revealed in the code,
     then jump-click to scroll to it.
   - Line numbers gutter, word-wrap toggle, find-in-code, and a real formatter.
   - Launch your HTML anywhere: new tab (direct), blob tab, about:blank tab,
     or as a data: URL - plus download/copy/upload.
   - Throttled autosave to localStorage under STORE. */

(function () {
  "use strict";

  var STORE = "chalkle-html-editor";
  var DEFAULT_HTML =
    "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\">\n  <title>My page</title>\n  <style>\n    body { font-family: system-ui; margin: 2rem; color: #222; }\n    h1 { color: #1d4ed8; }\n    .card { border: 1px solid #d0d0d0; border-radius: 10px; padding: 1rem; max-width: 22rem; }\n    button { background: #1d4ed8; color: #fff; border: 0; border-radius: 8px; padding: .5rem 1rem; cursor: pointer; }\n  </style>\n</head>\n<body>\n  <div class=\"card\">\n    <h1>Hello, Chalkle</h1>\n    <p>Edit the HTML on the left. The preview on the right updates live.</p>\n    <button onclick=\"this.textContent='Clicked!'\">Click me</button>\n  </div>\n</body>\n</html>";

  /* Small inspector that runs INSIDE the sandboxed preview. It outlines the
     hovered element and tells the parent (via postMessage) which element it is
     so the editor can reveal it. The sandbox keeps scripts but drops
     same-origin, so we communicate through messages, never DOM access. */
  var INSPECT_CODE =
    "(function(){" +
    "var last=null;var pending=null;" +
    "function pathOf(el){var p=[];while(el&&el.nodeType===1&&el!==document.body){" +
    "var s=el.tagName.toLowerCase();if(el.id)s+='#'+el.id;else if(el.className&&typeof el.className==='string'&&el.className.trim()){" +
    "s+='.'+el.className.trim().split(/\\s+/).slice(0,2).join('.');}p.unshift(s);el=el.parentElement;}" +
    "return p.join(' > ');}" +
    "function tagOf(el){if(!el||el.nodeType!==1)return '';return el.tagName.toLowerCase();}" +
    "function snap(){var e=pending;pending=null;if(!e)return;var t=tagOf(e);if(!t)return;" +
    "parent.postMessage({chalkle:'ed',type:'hover',path:pathOf(e),tag:t},'*');}" +
    "document.addEventListener('mouseover',function(ev){var t=ev.target;\n" +
    "if(t&&t.nodeType===1){if(last){last.style.outline='';last.style.outlineOffset='';}" +
    "t.style.outline='2px solid #4285f4';t.style.outlineOffset='-2px';last=t;}" +
    "if(!pending){pending=t;setTimeout(snap,10);}else{pending=t;}});" +
    "document.addEventListener('mousedown',function(ev){ev.preventDefault();\n" +
    "var t=ev.target;if(t&&t.nodeType===1){parent.postMessage({chalkle:'ed',type:'pick',path:pathOf(t),tag:tagOf(t)},'*');}});" +
    "document.addEventListener('scroll',function(){},true);" +
    "})();";

  function injectInspector(html) {
    var script = "<script id=\"__chalkle_ed_insp\">" + INSPECT_CODE + "<\/script>";
    if (/<\/body>/i.test(String(html))) return String(html).replace(/<\/body>/i, script + "</body>");
    return String(html) + script;
  }

  function $(id) { return document.getElementById(id); }

  function load() {
    try { return localStorage.getItem(STORE) || DEFAULT_HTML; }
    catch (e) { return DEFAULT_HTML; }
  }

  function save(v) {
    try { localStorage.setItem(STORE, v); } catch (e) { /* no storage */ }
  }

  /* ---------- Syntax highlighting (with attribute/string/directive colors) ---------- */

  function hl(src, pre) {
    if (!pre) return;
    pre.textContent = "";
    var n = src.length;
    var i = 0;
    function add(t, cls) {
      if (!t) return;
      var s = document.createElement("span");
      s.className = cls || "tok-plain";
      s.textContent = t;
      pre.appendChild(s);
    }
    function tagPieces(tag) {
      /* Split one <...> into: angle+name = tok-tag, attrs = tok-attr,
         quoted values = tok-str. Handles <, </, comments excluded (handled
         before we reach here), and self-closing />. */
      var out = [];
      if (!tag) return out;
      var nameEnd = /^<\/?[A-Za-z][\w:-]*/;
      var nm = nameEnd.exec(tag);
      var head = nm ? nm[0] : tag.charAt(0) || "<";
      out.push({ s: head, cls: "tok-tag" });
      var body = tag.slice(head.length, tag.length - 1);
      var re = /("[^"]*"|'[^']*')/g;
      var last = 0;
      var m;
      while ((m = re.exec(body))) {
        if (m.index > last) out.push({ s: body.slice(last, m.index), cls: "tok-attr" });
        out.push({ s: m[0], cls: "tok-str" });
        last = m.index + m[0].length;
      }
      if (last < body.length) out.push({ s: body.slice(last), cls: "tok-attr" });
      out.push({ s: ">", cls: "tok-tag" });
      return out;
    }
    while (i < n) {
      if (src.slice(i, i + 4) === "<!--") {
        var ce = src.indexOf("-->", i + 4);
        if (ce === -1) ce = n - 4;
        add(src.slice(i, ce + 3), "tok-comment");
        i = ce + 3;
        continue;
      }
      if (src.charAt(i) === "<") {
        var te = src.indexOf(">", i);
        if (te === -1) te = n - 1;
        var tag = src.slice(i, te + 1);
        var pieces = tagPieces(tag);
        for (var k = 0; k < pieces.length; k++) add(pieces[k].s, pieces[k].cls);
        i = te + 1;
        continue;
      }
      var nx = src.indexOf("<", i);
      if (nx === -1) nx = n;
      add(src.slice(i, nx), "tok-plain");
      i = nx;
    }
  }

  /* ---------- Line numbers ---------- */

  var LINE_H = null; /* computed once we have the font applied */

  function buildGutter(codeEl, gutterEl) {
    if (!gutterEl) return;
    if (!LINE_H) {
      var probe = document.createElement("div");
      probe.className = "editor-hl";
      probe.style.cssText = "position:absolute;visibility:hidden;left:-9999px;";
      probe.textContent = "\n\n";
      document.body.appendChild(probe);
      var lineH = probe.getBoundingClientRect().height / 2;
      LINE_H = lineH > 0 ? lineH : 24;
      probe.remove();
    }
    var count = codeEl.value.split("\n").length;
    var lines = [];
    for (var i = 1; i <= count; i++) lines.push(String(i));
    gutterEl.textContent = lines.join("\n");
    /* No explicit height: the gutter stretches to the pane and scrolls in
       sync with the code (see syncScroll). */
  }

  var inited = false;

  function init() {
    var code = $("ed-code");
    var preview = $("ed-preview");
    var status = $("ed-status");
    var modeEl = $("ed-mode");
    var cursorEl = $("ed-cursor");
    var gutter = $("ed-gutter");
    if (!code || !preview) return;

    var inspectOn = false;
    var wrap = document.querySelector(".editor-wrap");

    code.value = load();

    var previewTimer = null;
    function pushPreview() {
      /* Reset scroll + clear stale outline between refreshes. */
      var html = code.value;
      if (inspectOn && html) html = injectInspector(html);
      try { preview.srcdoc = html; } catch (e) { /* ignore */ }
    }
    /* Grow the textarea to its content so the wrap becomes the scroller. */
    function autoSize() {
      code.style.height = "auto";
      code.style.height = code.scrollHeight + "px";
    }
    /* Keep line numbers + the highlight overlay glued to the code as the
       editor scrolls (both live outside the scrolling wrap). */
    function syncScroll() {
      var st = wrap ? wrap.scrollTop : code.scrollTop;
      if (gutter) gutter.scrollTop = st;
      var hlEl = $("ed-hl");
      if (hlEl) hlEl.style.transform = "translateY(" + (-st) + "px)";
    }
    function sizeOverlays() {
      var count = code.value.split("\n").length;
      var hlEl = $("ed-hl");
      if (hlEl) hlEl.style.height = (count * (LINE_H || 24) + 24) + "px";
      autoSize();
    }
    function refresh() {
      hl(code.value, $("ed-hl"));
      buildGutter(code, gutter);
      sizeOverlays();
      syncScroll();
      if (status) status.textContent = "Saved locally";
      clearTimeout(previewTimer);
      previewTimer = setTimeout(pushPreview, 350);
    }
    function forceRefresh() {
      hl(code.value, $("ed-hl"));
      buildGutter(code, gutter);
      sizeOverlays();
      syncScroll();
      pushPreview();
      save(code.value);
      if (status) status.textContent = "Preview refreshed";
    }
    function updateCursor() {
      if (!cursorEl) return;
      var p = code.selectionStart;
      var before = code.value.slice(0, p);
      var ln = before.split("\n").length;
      var col = p - before.lastIndexOf("\n");
      cursorEl.textContent = "Ln " + ln + ", Col " + col;
    }

    code.addEventListener("input", function () {
      hl(code.value, $("ed-hl"));
      buildGutter(code, gutter);
      sizeOverlays();
      syncScroll();
      if (status && status.textContent !== "Preview refreshed") status.textContent = "Editing...";
      updateCursor();
      clearTimeout(previewTimer);
      previewTimer = setTimeout(function () {
        pushPreview();
        save(code.value);
        if (status) status.textContent = "Saved locally";
      }, 350);
    });
    code.addEventListener("keyup", updateCursor);
    code.addEventListener("click", updateCursor);
    if (wrap) wrap.addEventListener("scroll", syncScroll);
    code.addEventListener("scroll", syncScroll);
    code.addEventListener("keydown", function (e) {
      var km = e.ctrlKey || e.metaKey;
      if (km && e.key === "Enter") { e.preventDefault(); forceRefresh(); }
      if (km && e.key.toLowerCase() === "s") { e.preventDefault(); forceRefresh(); }
      if (km && e.key.toLowerCase() === "e") {
        e.preventDefault();
        toggleInspect();
      }
      if (km && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openFind();
      }
      if (e.key === "Tab") {
        e.preventDefault();
        var st = code.selectionStart;
        var en = code.selectionEnd;
        code.value = code.value.slice(0, st) + "  " + code.value.slice(en);
        code.selectionStart = code.selectionEnd = st + 2;
        refresh();
        updateCursor();
      }
    });

    refresh();

    /* ---------- Inspect mode ---------- */

    function reveal(tagName) {
      if (!tagName) return;
      /* Find the first opening tag whose name isn't an ancestor of the match,
         search each occurrence and reveal the first opening tag of that name. */
      var re = new RegExp("<" + tagName + "(\\s|/?>|\\s)", "i");
      var idx = code.value.search(re);
      if (idx === -1) {
        /* Fall back to a pattern that also matches monospace tag like div/span */
        idx = code.value.toLowerCase().indexOf("<" + tagName);
      }
      if (idx === -1) {
        if (status) status.textContent = inspectOn ? "Inspect: no tag \"" + tagName + "\" in code" : "Saved locally";
        return;
      }
      var len = tagName.length + 1;
      code.focus();
      code.setSelectionRange(idx, idx + len);
      updateCursor();
      /* Scroll the textarea so the reveal line sits near the top of the pane. */
      var before = code.value.slice(0, idx);
      var line = before.split("\n").length;
      var linePx = LINE_H || 24;
      var target = Math.max(0, (line - 3) * linePx);
      code.scrollTop = target;
      if (gutter) gutter.scrollTop = code.scrollTop;
      if (status) status.textContent = inspectOn ? "Inspect: <" + tagName + ">" : "Saved locally";
    }

    window.addEventListener("message", function (e) {
      var d = e.data;
      if (!d || d.chalkle !== "ed") return;
      if (d.type === "hover" && inspectOn) {
        if (modeEl) modeEl.textContent = (d.path || d.tag || "") && ("<" + (d.tag || "?") + "> in " + (d.path || ""));
        reveal(d.tag);
      } else if (d.type === "pick" && inspectOn) {
        reveal(d.tag);
      }
    });

    function toggleInspect() {
      inspectOn = !inspectOn;
      var btn = $("ed-inspect");
      if (btn) btn.classList.toggle("is-on", inspectOn);
      if (modeEl) modeEl.textContent = inspectOn ? "Inspect on - hover the preview" : "Editing";
      if (inspectOn) forceRefresh();
    }

    var insp = $("ed-inspect");
    if (insp) insp.addEventListener("click", toggleInspect);

    /* Toolbar buttons that were rendered but never wired. */
    var ref = $("ed-refresh");
    if (ref) ref.addEventListener("click", forceRefresh);
    var findBtn = $("ed-find");
    if (findBtn) findBtn.addEventListener("click", openFind);
    var fmt = $("ed-format");
    if (fmt) fmt.addEventListener("click", function () {
      code.value = formatHtml(code.value);
      refresh();
      updateCursor();
      if (status) status.textContent = "Formatted";
    });

    /* Small, safe HTML pretty-printer: re-indents block tags while leaving
       inline tags and text alone. */
    function formatHtml(src) {
      var out = [];
      var indent = 0;
      var inline = { br: 1, img: 1, input: 1, meta: 1, link: 1, hr: 1, area: 1, base: 1, col: 1, embed: 1, source: 1, track: 1, wbr: 1 };
      function pushLine(line) {
        line = String(line).trim();
        if (line) out.push("  ".repeat(indent) + line);
      }
      var re = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>|<!DOCTYPE[^>]*>/g;
      var last = 0;
      var m;
      while ((m = re.exec(String(src)))) {
        var text = src.slice(last, m.index);
        if (text) text.split(/\r?\n/).forEach(pushLine);
        var tag = m[0];
        var isClose = /^<\//.test(tag);
        var isComment = /^<!--/.test(tag);
        var name = (tag.match(/^<\/?([A-Za-z][\w:-]*)/) || [])[1];
        var selfClose = /\/>$/.test(tag) || isClose || isComment;
        if (isClose) indent = Math.max(0, indent - 1);
        out.push("  ".repeat(indent) + tag);
        if (!selfClose && name && !inline[name]) indent++;
        last = m.index + tag.length;
      }
      if (src.slice(last).trim()) src.slice(last).split(/\r?\n/).forEach(pushLine);
      return out.join("\n").replace(/\n{3,}/g, "\n\n");
    }

    /* ---------- Launch methods ---------- */

    function runWith(method) {
      var html = code.value;
      var blobUrl;
      try { blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html" })); }
      catch (e) { blobUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html); }
      var win = null;
      if (method === "direct") {
        win = window.open(blobUrl, "_blank");
      } else if (method === "blob") {
        var full = '<!doctype html><html><head><meta charset="utf-8"><title>Chalkle</title></head><body style="margin:0">' +
          '<iframe src="' + blobUrl.replace(/"/g, "%22") + '" style="width:100vw;height:100vh;border:0;display:block" allow="fullscreen; clipboard-write"></iframe></body></html>';
        var wrapUrl = URL.createObjectURL(new Blob([full], { type: "text/html" }));
        win = window.open(wrapUrl, "_blank");
        setTimeout(function () { URL.revokeObjectURL(wrapUrl); }, 60000);
      } else if (method === "aboutblank") {
        win = window.open("about:blank", "_blank");
        if (win) {
          try { win.document.open(); win.document.write(html); win.document.close(); }
          catch (er) { win.close(); win = null; }
        }
      } else if (method === "dataurl") {
        win = window.open("data:text/html;charset=utf-8," + encodeURIComponent(html), "_blank");
      }
      setTimeout(function () {
        try { URL.revokeObjectURL(blobUrl); } catch (e) { /* ignore */ }
      }, 60000);
      if (status) status.textContent = win ? "Opened" : "Popup blocked";
    }

    /* Draggable splitter between the code pane and the preview. Defaults to a
       wider preview; the drag position is remembered on this device. */
    var splitter = $("ed-split");
    var editorEl = document.querySelector(".editor-modal .editor");
    var pane = document.querySelector(".editor-pane");
    var SPLIT_KEY = "chalkle-editor-split";
    var dragging = null;
    function applySplit(px) {
      if (editorEl) editorEl.style.gridTemplateColumns = px + "px 6px minmax(0, 1fr)";
    }
    try {
      var savedSplit = parseInt(localStorage.getItem(SPLIT_KEY), 10);
      if (savedSplit && savedSplit > 160 && editorEl) applySplit(savedSplit);
    } catch (e) { /* no storage */ }
    if (splitter) {
      splitter.addEventListener("pointerdown", function (ev) {
        ev.preventDefault();
        dragging = { startX: ev.clientX, startLeft: pane ? pane.offsetWidth : 480 };
        try { splitter.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        document.body.classList.add("ed-resizing");
      });
      splitter.addEventListener("pointermove", function (ev) {
        if (!dragging || !editorEl) return;
        var total = editorEl.getBoundingClientRect().width;
        var left = dragging.startLeft + (ev.clientX - dragging.startX);
        applySplit(Math.max(180, Math.min(total - 360, left)));
      });
      var endDrag = function () {
        if (!dragging) return;
        dragging = null;
        document.body.classList.remove("ed-resizing");
        try {
          var m = editorEl && editorEl.style.gridTemplateColumns.match(/(\d+)px/);
          if (m) localStorage.setItem(SPLIT_KEY, m[1]);
        } catch (e) { /* no storage */ }
      };
      splitter.addEventListener("pointerup", endDrag);
      splitter.addEventListener("pointercancel", endDrag);
    }

    var open = $("ed-open");
    if (open) open.addEventListener("click", function () { runWith("direct"); });
    var blob = $("ed-blob");
    if (blob) blob.addEventListener("click", function () { runWith("blob"); });
    var ab = $("ed-aboutblank");
    if (ab) ab.addEventListener("click", function () { runWith("aboutblank"); });
    var du = $("ed-dataurl");
    if (du) du.addEventListener("click", function () { runWith("dataurl"); });

    var dl = $("ed-dl");
    if (dl) dl.addEventListener("click", function () {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([code.value], { type: "text/html" }));
      a.download = "page.html";
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
    });

    var copy = $("ed-copy");
    if (copy) copy.addEventListener("click", function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code.value).then(function () {
          if (status) status.textContent = "Copied";
        });
      } else {
        code.select();
        try { document.execCommand("copy"); if (status) status.textContent = "Copied"; } catch (e) { /* ignore */ }
      }
    });

    var file = $("ed-file");
    if (file) {
      file.addEventListener("change", function () {
        var f = file.files && file.files[0];
        if (!f) return;
        var r = new FileReader();
        r.onload = function () {
          code.value = String(r.result || "");
          refresh();
          updateCursor();
        };
        r.readAsText(f);
        file.value = "";
      });
    }


    /* ---------- Find in code ---------- */

    var findRow = null;
    function openFind() {
      if (!findRow) {
        findRow = document.createElement("div");
        findRow.className = "ed-find";
        findRow.innerHTML =
          '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><line x1="16" y1="16" x2="20.5" y2="20.5"/></svg>' +
          '<input type="text" placeholder="Find in code…" aria-label="Find in code">' +
          '<span class="ed-find-count"></span>' +
          '<button class="ed-find-x" title="Close" aria-label="Close find">×</button>';
        var pane = document.querySelector(".editor-pane");
        if (pane) pane.appendChild(findRow);
        wireFindOnce();
      }
      findRow.hidden = false;
      var input = findRow.querySelector("input");
      input.value = "";
      var countEl = findRow.querySelector(".ed-find-count");
      if (countEl) countEl.textContent = "";
      input.focus();
    }
    /* Find listeners are attached exactly once so reopening the bar never
       stacks handlers (which used to double-fire on Enter). */
    function wireFindOnce() {
      var input = findRow.querySelector("input");
      var countEl = findRow.querySelector(".ed-find-count");
      var x = findRow.querySelector(".ed-find-x");
      x.addEventListener("click", function () { findRow.hidden = true; clearFindHighlight(); code.focus(); });
      input.addEventListener("input", function () {
        var q = input.value;
        if (!q) { clearFindHighlight(); if (countEl) countEl.textContent = ""; return; }
        highlightFind(q);
      });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          var q = input.value;
          if (!q) return;
          e.preventDefault();
          if (lastFindQuery !== q) highlightFind(q, true);
          else nextFind();
        } else if (e.key === "Escape") {
          findRow.hidden = true;
          clearFindHighlight();
          code.focus();
        }
      });
    }

    var lastFindQuery = null;
    var findIdx = 0;
    function clearFindHighlight() {
      lastFindQuery = null;
      findIdx = 0;
      var ph = $("ed-hl");
      if (ph) ph.classList.remove("ed-active-find");
    }
    function highlightFind(q, jump) {
      var ph = $("ed-hl");
      var src = code.value;
      var qi = src.toLowerCase();
      var ql = q.toLowerCase();
      var indices = [];
      var pos = -1;
      while ((pos = qi.indexOf(ql, pos + 1)) !== -1) indices.push(pos);
      if (indices.length === 0) {
        clearFindHighlight();
        var ce = document.querySelector(".ed-find-count");
        if (ce) ce.textContent = "No matches";
        return;
      }
      findIdx = jump ? 0 : (findIdx % indices.length);
      var tgt = indices[findIdx % indices.length];
      code.focus();
      code.setSelectionRange(tgt, tgt + ql.length);
      updateCursor();
      var line = src.slice(0, tgt).split("\n").length;
      var linePx = LINE_H || 24;
      code.scrollTop = Math.max(0, (line - 3) * linePx);
      if (gutter) gutter.scrollTop = code.scrollTop;
      if (ph) {
        ph.classList.remove("ed-active-find");
        void ph.offsetWidth;
        ph.classList.add("ed-active-find");
      }
      var cc = document.querySelector(".ed-find-count");
      if (cc) cc.textContent = (findIdx % indices.length + 1) + " / " + indices.length;
      findIdx++;
      lastFindQuery = q;
    }
    function nextFind() {
      if (lastFindQuery) highlightFind(lastFindQuery);
    }

    /* Wide clicks on gutter should do nothing (it's not interactive). */

    inited = true;
  }

  function open() {
    var modal = document.getElementById("editor-modal");
    if (!modal) return;
    if (!inited) init();
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    var code = $("ed-code");
    if (code) setTimeout(function () { code.focus(); code.setSelectionRange(code.value.length, code.value.length); }, 60);
  }

  function close() {
    var modal = document.getElementById("editor-modal");
    if (modal) modal.hidden = true;
    document.body.style.overflow = "";
  }

  window.ChalkleEditor = {
    open: open,
    close: close
  };

  document.addEventListener("DOMContentLoaded", function () {
    var modal = document.getElementById("editor-modal");
    if (!modal) return;
    modal.querySelectorAll("[data-editor-close]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        if (e.target === el || el.tagName === "BUTTON") close();
      });
    });
  });
})();