/* Chalkle Pixel — an Aseprite-style pixel art editor, built in and offline.
   Layers, frames, animation, palette, pens/bucket/eyedropper/shapes, onion
   skin, symmetry, undo/redo, zoom, and PNG/GIF export. Uses an ABGR pixel
   buffer per layer per frame (just like real Aseprite) so undo is cheap and
   the live preview is a simple composite. Runs entirely locally; nothing is
   uploaded. */
(function () {
  "use strict";

  var APP_KEY = "chalkle.pixel.project.v1";

  /* ---------- tiny helpers ---------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- document model ---------- */

  function blankLayer(w, h) { return new Uint32Array(w * h); } /* ABGR, 0 = transparent */
  function blankFrame(layers, w, h) {
    var fr = [];
    for (var i = 0; i < layers.length; i++) fr.push({ data: blankLayer(w, h) });
    return fr;
  }

  function newDoc(w, h) {
    if (!w || w < 1 || w > 512) w = 64;
    if (!h || h < 1 || h > 512) h = 64;
    var layers = [
      { name: "Layer 1", visible: true, opacity: 255 },
      { name: "Layer 2", visible: true, opacity: 255 }
    ];
    return {
      w: w, h: h,
      layers: layers.slice(),
      frames: [blankFrame(layers, w, h)],
      // seeded so a first stroke isn't a blank start
      bg: "checker"
    };
  }

  function cloneDoc(doc) {
    var c = {
      w: doc.w, h: doc.h,
      layers: doc.layers.map(function (l) { return { name: l.name, visible: l.visible, opacity: l.opacity }; }),
      frames: []
    };
    for (var f = 0; f < doc.frames.length; f++) {
      var fl = [];
      for (var i = 0; i < doc.frames[f].length; i++) {
        fl.push({ data: new Uint32Array(doc.frames[f][i].data) });
      }
      c.frames.push(fl);
    }
    return c;
  }

  function colorAt(doc, f, l, x, y) {
    if (l < 0 || l >= doc.frames[f].length) return 0;
    return doc.frames[f][l].data[y * doc.w + x] >>> 0;
  }

  function setPixel(doc, f, l, x, y, c) {
    if (l < 0 || l >= doc.frames[f].length) return;
    if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return;
    var frameLayer = doc.frames[f][l];
    var meta = doc.layers && doc.layers[l] || {};
    if (meta.locked) return;
    if (meta.opacity != null && meta.opacity !== 255 && c) {
      var a = ((c >>> 24) & 0xff) * (meta.opacity / 255) | 0;
      c = (c & 0x00ffffff) | (a << 24);
    }
    frameLayer.data[y * doc.w + x] = c >>> 0;
  }

  /* Blend an ABGR color over an opaque RGBA pixel, returning packed ABGR. */
  function blend(overA, baseABGR) {
    var oa = ((overA >>> 24) & 0xff);
    if (oa === 255) return overA;
    var ba = ((baseABGR >>> 24) & 0xff);
    var a = oa + ba * (255 - oa) / 255;
    if (a === 0) return 0;
    var al = 255;
    var r = ((((overA) & 0xff) * oa + ((baseABGR) & 0xff) * ba * (255 - oa) / 255) / a) | 0;
    var g = (((((overA >> 8) & 0xff) * oa + ((baseABGR >> 8) & 0xff) * ba * (255 - oa) / 255) / a)) | 0;
    var b = (((((overA >> 16) & 0xff) * oa + ((baseABGR >> 16) & 0xff) * ba * (255 - oa) / 255) / a)) | 0;
    return al << 24 | b << 16 | g << 8 | r;
  }

  /* Composite all visible layers of a frame to an ABGR buffer. */
  function composite(doc, f) {
    var out = new Uint32Array(doc.w * doc.h);
    for (var l = 0; l < doc.frames[f].length; l++) {
      var frameLayer = doc.frames[f][l];
      var meta = doc.layers && doc.layers[l] || {};
      if (meta.visible === false) continue;
      var op = (meta.opacity == null ? 255 : meta.opacity);
      var data = frameLayer.data;
      for (var i = 0; i < out.length; i++) {
        var px = data[i];
        if (!px) continue;
        var a = (px >>> 24) & 0xff;
        if (a === 0) continue;
        if (op !== 255) { a = (a * op / 255) | 0; px = (px & 0x00ffffff) | (a << 24); }
        out[i] = a === 255 ? px : blend(px, out[i]);
      }
    }
    return out;
  }

  /* ---------- state ---------- */

  var S = {
    doc: null,
    frame: 0,
    layer: 0,
    tool: "pencil", // pencil, eraser, bucket, pick, line, rect, efill, ellipse, eellipse
    color: { r: 255, g: 0, b: 0, a: 255 },
    altColor: { r: 255, g: 255, b: 255, a: 255 }, // right-click color
    symH: false, symV: false,
    grid: true,
    onion: false,
    onionPrev: 1, onionNext: 0,
    playing: false, fps: 8,
    zoom: 6,
    panX: 0, panY: 0,
    // history
    undo: [],
    redo: [],
    drawing: false, lastX: -1, lastY: -1,
    canvasW: 0, canvasH: 0
  };

  function currentLayer() { return S.doc.layers[S.layer]; }

  function packColor(c) { return (c.a << 24) | (c.b << 16) | (c.g << 8) | c.r; }

  function lerpColor(a, b, t) {
    return { r: a.r + (b.r - a.r) * t | 0, g: a.g + (b.g - a.g) * t | 0, b: a.b + (b.b - a.b) * t | 0, a: a.a | 0 };
  }

  /* ---------- history ---------- */

  function pushHistory() {
    S.undo.push(cloneDoc(S.doc));
    if (S.undo.length > 40) S.undo.shift();
    S.redo = [];
    updateStatus();
  }

  function undo() {
    if (!S.undo.length) return;
    S.redo.push(cloneDoc(S.doc));
    S.doc = S.undo.pop();
    if (S.frame >= S.doc.frames.length) S.frame = S.doc.frames.length - 1;
    if (S.layer >= S.doc.layers.length) S.layer = S.doc.layers.length - 1;
    renderAll();
    updateStatus();
  }

  function redoAction() {
    if (!S.redo.length) return;
    S.undo.push(cloneDoc(S.doc));
    S.doc = S.redo.pop();
    if (S.frame >= S.doc.frames.length) S.frame = S.doc.frames.length - 1;
    if (S.layer >= S.doc.layers.length) S.layer = S.doc.layers.length - 1;
    renderAll();
    updateStatus();
  }

  /* ---------- core render to visible canvas ---------- */

  function renderFrameCanvas() {
    var canvas = document.getElementById("pixel-canvas");
    if (!canvas) return;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = S.canvasW = S.doc.w * S.zoom;
    canvas.height = S.canvasH = S.doc.h * S.zoom;
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // checkerboard background handled by CSS behind canvas edges; we draw transparent
    var buf = composite(S.doc, S.frame);

    // onion skin: draw previous/next frames ghosted
    if (S.onion) {
      var prev = S.frame - S.onionPrev, next = S.frame + S.onionNext;
      if (prev >= 0) drawBuffer(ctx, composite(S.doc, prev), 0.28);
      if (next < S.doc.frames.length) drawBuffer(ctx, composite(S.doc, next), 0.28);
    }

    drawBuffer(ctx, buf, 1);
  }

  function drawBuffer(ctx, buf, alpha) {
    var img = ctx.createImageData(S.doc.w, S.doc.h);
    var d = img.data;
    for (var i = 0; i < buf.length; i++) {
      var px = buf[i];
      var a = (px >>> 24) & 0xff;
      var r = px & 0xff;
      var g = (px >> 8) & 0xff;
      var b = (px >> 16) & 0xff;
      var o = i * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
    }
    var off = ctx.createImageData(S.doc.w, S.doc.h);
    var oo = off.data;
    for (var j = 0; j < buf.length; j++) { var o2 = j * 4; oo[o2 + 3] = 0; }
    // fast path: draw full res image
    var tmp = document.createElement("canvas");
    tmp.width = S.doc.w; tmp.height = S.doc.h;
    tmp.getContext("2d").putImageData(img, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = false;
    var scaled = S.zoom;
    // draw chunks to allow zoom beyond 2^n smoothness (draw cell-by-cell for crispness)
    ctx.drawImage(tmp, 0, 0, S.doc.w, S.doc.h, 0, 0, S.doc.w * scaled, S.doc.h * scaled);
    ctx.globalAlpha = 1;
  }

  /* Redraw everything: frame canvas + grid + panels + stats. */
  function renderAll() {
    if (!S.doc) return;
    renderFrameCanvas();
    renderGrid();
    renderTimeline();
    renderLayers();
    renderPreview();
    updateStatus();
    renderFrameLabel();
    scheduleSave();
  }

  /* ---------- grid overlay ---------- */

  function renderGrid() {
    var g = document.getElementById("pixel-grid-canvas");
    if (!g) return;
    g.style.width = (S.doc.w * S.zoom) + "px";
    g.style.height = (S.doc.h * S.zoom) + "px";
    g.style.display = S.grid ? "block" : "none";
    var ctx = g.getContext("2d");
    ctx.clearRect(0, 0, g.width, g.height);
    if (!S.grid) return;
    ctx.strokeStyle = "rgba(160,160,180,0.18)";
    ctx.lineWidth = 1;
    if (S.zoom >= 6) {
      var z = S.zoom;
      ctx.beginPath();
      for (var x = 0; x <= S.doc.w; x++) { ctx.moveTo(x * z + 0.5, 0); ctx.lineTo(x * z + 0.5, S.doc.h * z); }
      for (var y = 0; y <= S.doc.h; y++) { ctx.moveTo(0, y * z + 0.5); ctx.lineTo(S.doc.w * z, y * z + 0.5); }
      ctx.stroke();
    }
  }

  /* ---------- drawing primitives ---------- */

  function applyColorTo(doc, f, l, x, y, c, style) {
    // style: 'replace' (pencil, ignores alpha of base), 'erase' (zero alpha), 'blend' (fill over)
    if (style === "erase") { setPixel(doc, f, l, x, y, 0); return; }
    var base = colorAt(doc, f, l, x, y);
    var final = (style === "blend") ? blend(c, base) : c;
    setPixel(doc, f, l, x, y, final);
  }

  function floodFill(doc, f, l, x, y, target, fill) {
    var w = doc.w, h = doc.h;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    var data = doc.frames[f][l].data;
    var start = data[y * w + x];
    if (start === fill) return;
    var stack = [[x, y]];
    function tMatch(v) { return target === -1 ? v === 0 : v === target; }
    while (stack.length) {
      var p = stack.pop();
      var px = p[0], py = p[1];
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      var idx = py * w + px;
      var v = data[idx];
      // stop when not matching the sampled edge
      if (target === -1 ? v !== 0 : v !== start) continue;
      if (v === fill) continue;
      data[idx] = fill;
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
  }

  /* current tool cursor position -> cell coordinates */
  function cellFromEvent(e) {
    var wrap = document.getElementById("pixel-view");
    var r = wrap.getBoundingClientRect();
    var x = Math.floor((e.clientX - r.left) / S.zoom);
    var y = Math.floor((e.clientY - r.top) / S.zoom);
    return { x: x, y: y };
  }

  function drawStroke(x0, y0, x1, y1, color) {
    // Bresenham
    var dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    var err = dx + dy;
    while (true) {
      paintCell(x0, y0, color);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function paintCell(x, y, color) {
    var l = S.layer;
    // break loop if out of range
    setPixel(S.doc, S.frame, l, x, y, color);
    if (S.symH) setPixel(S.doc, S.frame, l, S.doc.w - 1 - x, y, color);
    if (S.symV) setPixel(S.doc, S.frame, l, x, S.doc.h - 1 - y, color);
    if (S.symH && S.symV) setPixel(S.doc, S.frame, l, S.doc.w - 1 - x, S.doc.h - 1 - y, color);
  }

  function drawShape(x0, y0, x1, y1, fill) {
    var color = packColor(S.color);
    var l = S.layer;
    if (S.tool === "line") { drawStroke(x0, y0, x1, y1, color); return; }
    var xmin = Math.min(x0, x1), xmax = Math.max(x0, x1);
    var ymin = Math.min(y0, y1), ymax = Math.max(y0, y1);
    if (S.tool === "rect") {
      for (var sx = xmin; sx <= xmax; sx++) { paintCell(sx, ymin, color); paintCell(sx, ymax, color); }
      for (var sy = ymin + 1; sy < ymax; sy++) { paintCell(xmin, sy, color); paintCell(xmax, sy, color); }
    } else if (S.tool === "efill") {
      for (var gy = ymin; gy <= ymax; gy++) for (var gx = xmin; gx <= xmax; gx++) paintCell(gx, gy, color);
    } else if (S.tool === "ellipse" || S.tool === "eellipse") {
      var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      var rx = Math.max(0, (xmax - xmin) / 2), ry = Math.max(0, (ymax - ymin) / 2);
      var filled = S.tool === "eellipse";
      var steps = 100;
      for (var i = 0; i <= steps; i++) {
        var t = i / steps * Math.PI * 2;
        var px = Math.round(cx + rx * Math.cos(t));
        var py = Math.round(cy + ry * Math.sin(t));
        paintCell(px, py, color);
      }
      if (filled) {
        for (var yy = Math.floor(cy - ry); yy <= Math.ceil(cy + ry); yy++) {
          for (var xx = Math.floor(cx - rx); xx <= Math.ceil(cx + rx); xx++) {
            var n = ((xx - cx) / (rx || 1)); var m = ((yy - cy) / (ry || 1));
            if (n * n + m * m <= 1) paintCell(xx, yy, color);
          }
        }
      }
    }
  }

  /* ---------- mouse interaction ---------- */

  function startStroke(e) {
    e.preventDefault();
    var c = cellFromEvent(e);
    var useAlt = e.button === 2;
    var chosen = useAlt ? S.altColor : S.color;
    pushHistory();
    S.drawing = true;
    S.lastX = c.x; S.lastY = c.y;
    var l = S.layer;
    if (S.tool === "bucket") {
      var target = colorAt(S.doc, S.frame, l, c.x, c.y);
      if (l >= 0 && l < S.doc.frames[S.frame].length) {
        S.doc.frames[S.frame][l].data[c.y * S.doc.w + c.x] = target; // noop safety
        floodFill(S.doc, S.frame, l, c.x, c.y, target, packColor(chosen));
      }
      renderAll();
      S.drawing = false;
      return;
    }
    if (S.tool === "pick") {
      var picked = colorAt(S.doc, S.frame, l, c.x, c.y);
      var pr = picked & 0xff, pg = (picked >> 8) & 0xff, pb = (picked >> 16) & 0xff, pa = (picked >>> 24) & 0xff;
      if (useAlt) S.altColor = { r: pr, g: pg, b: pb, a: pa }; else S.color = { r: pr, g: pg, b: pb, a: pa };
      syncColorUI();
      S.drawing = false;
      renderFrameCanvas();
      return;
    }
    var mustDiff = S.lastX !== c.x || S.lastY !== c.y;
    if (S.tool === "pencil" || S.tool === "eraser") {
      var color = S.tool === "eraser" ? 0 : packColor(chosen);
      paintCell(c.x, c.y, color);
      S.lastX = c.x; S.lastY = c.y;
    }
    // shapes drawn on release from anchor
    S.anchorX = c.x; S.anchorY = c.y;
    renderAll();
  }

  function moveStroke(e) {
    if (!S.drawing) return;
    e.preventDefault();
    var c = cellFromEvent(e);
    if (S.tool === "pencil" || S.tool === "eraser") {
      if (S.lastX === c.x && S.lastY === c.y) return;
      var color = S.tool === "eraser" ? 0 : packColor(S.color);
      drawStroke(S.lastX, S.lastY, c.x, c.y, color);
      S.lastX = c.x; S.lastY = c.y;
      renderFrameCanvas();
    } else if (S.tool === "line" || S.tool === "rect" || S.tool === "efill" || S.tool === "ellipse" || S.tool === "eellipse") {
      renderAll(); // repaint base, then we overlay shape preview
      // temporary shape preview drawn on a scratch layer is complex; we commit on release
    }
  }

  function endStroke(e) {
    if (!S.drawing) return;
    e.preventDefault();
    var c = cellFromEvent(e);
    if (S.tool === "line" || S.tool === "rect" || S.tool === "efill" || S.tool === "ellipse" || S.tool === "eellipse") {
      var l = S.layer;
      var x0 = S.anchorX, y0 = S.anchorY;
      drawShape(x0, y0, c.x, c.y, true);
    }
    S.drawing = false;
    renderAll();
  }

  /* ---------- color UI ---------- */

  function syncColorUI() {
    var c = S.color;
    var hex = "#" + [c.r, c.g, c.b].map(function (v) { return v.toString(16).padStart(2, "0"); }).join("");
    var hexIn = document.getElementById("pixel-hex");
    if (hexIn) hexIn.value = hex;
    var sw = document.getElementById("pixel-swatch");
    if (sw) sw.style.background = hex;
    var al = document.getElementById("pixel-alpha");
    if (al) al.value = c.a;
    var alv = document.getElementById("pixel-alpha-val");
    if (alv) alv.textContent = c.a;
    var rIn = document.getElementById("pixel-r"); if (rIn) rIn.value = c.r;
    var gIn = document.getElementById("pixel-g"); if (gIn) gIn.value = c.g;
    var bIn = document.getElementById("pixel-b"); if (bIn) bIn.value = c.b;
    var colPick = document.getElementById("pixel-color");
    if (colPick) colPick.value = hex;
    // alt color display
    var altSw = document.getElementById("pixel-swatch-alt");
    if (altSw) altSw.style.background = "#" + [S.altColor.r, S.altColor.g, S.altColor.b].map(function (v) { return v.toString(16).padStart(2, "0"); }).join("");
  }

  function setColorFromHex(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return;
    S.color.r = parseInt(m[1].slice(0, 2), 16);
    S.color.g = parseInt(m[1].slice(2, 4), 16);
    S.color.b = parseInt(m[1].slice(4, 6), 16);
    syncColorUI();
  }

  /* ---------- layers panel ---------- */

  function renderLayers() {
    var box = document.getElementById("pixel-layers");
    if (!box) return;
    box.innerHTML = "";
    S.doc.layers.forEach(function (ly, i) {
      var row = el("div", "pixel-layer" + (i === S.layer ? " is-active" : ""));
      row.style.opacity = ly.visible ? "" : "0.45";
      var vis = el("button", "pixel-mini", ly.visible ? "◉" : "○");
      vis.title = "Toggle visibility";
      vis.addEventListener("click", function () { ly.visible = !ly.visible; renderAll(); });
      var name = el("span", "pixel-layer-name", ly.name);
      name.title = ly.name;
      var up = el("button", "pixel-mini", "↑"); up.title = "Move up";
      up.addEventListener("click", function () { if (i > 0) { var t = S.doc.layers[i]; S.doc.layers[i] = S.doc.layers[i - 1]; S.doc.layers[i - 1] = t; /* reorder frames data too */ for (var f = 0; f < S.doc.frames.length; f++) { var tt = S.doc.frames[f][i]; S.doc.frames[f][i] = S.doc.frames[f][i - 1]; S.doc.frames[f][i - 1] = tt; } if (S.layer === i) S.layer = i - 1; else if (S.layer === i - 1) S.layer = i; renderAll(); } });
      var del = el("button", "pixel-mini danger", "✕"); del.title = "Delete layer";
      del.addEventListener("click", function () { if (S.doc.layers.length <= 1) return; for (var f = 0; f < S.doc.frames.length; f++) S.doc.frames[f].splice(i, 1); S.doc.layers.splice(i, 1); if (S.layer >= S.doc.layers.length) S.layer = S.doc.layers.length - 1; renderAll(); });
      row.addEventListener("click", function () { S.layer = i; renderAll(); });
      row.append(vis, name, up, del);
      box.appendChild(row);
    });
  }

  function addLayer() {
    var ly = { name: "Layer " + (S.doc.layers.length + 1), visible: true, opacity: 255 };
    S.doc.layers.push(ly);
    for (var f = 0; f < S.doc.frames.length; f++) S.doc.frames[f].push({ data: blankLayer(S.doc.w, S.doc.h) });
    S.layer = S.doc.layers.length - 1;
    renderAll();
  }

  function dupLayer() {
    if (!S.doc.layers.length) return;
    var src = S.doc.layers[S.layer];
    var ly = { name: (src.name || "Layer") + " copy", visible: true, opacity: src.opacity };
    S.doc.layers.push(ly);
    for (var f = 0; f < S.doc.frames.length; f++) S.doc.frames[f].push({ data: new Uint32Array(S.doc.frames[f][S.layer].data) });
    S.layer = S.doc.layers.length - 1;
    renderAll();
  }

  /* ---------- frame / timeline panel ---------- */

  function renderFrameLabel() {
    var lb = document.getElementById("pixel-framecount");
    if (lb) lb.textContent = (S.frame + 1) + " / " + S.doc.frames.length;
  }

  function renderTimeline() {
    var box = document.getElementById("pixel-timeline");
    if (!box) return;
    box.innerHTML = "";
    S.doc.frames.forEach(function (fr, i) {
      var thumb = document.createElement("canvas");
      thumb.width = S.doc.w; thumb.height = S.doc.h;
      thumb.className = "pixel-frame-thumb";
      var tctx = thumb.getContext("2d");
      var buf = composite(S.doc, i);
      var img = tctx.createImageData(S.doc.w, S.doc.h);
      for (var k = 0; k < buf.length; k++) {
        var px = buf[k]; var o = k * 4;
        img.data[o] = px & 0xff; img.data[o + 1] = (px >> 8) & 0xff; img.data[o + 2] = (px >> 16) & 0xff; img.data[o + 3] = (px >>> 24) & 0xff;
      }
      tctx.putImageData(img, 0, 0);
      var cell = el("div", "pixel-frame" + (i === S.frame ? " is-active" : ""));
      cell.title = "Frame " + (i + 1);
      var num = el("span", "pixel-frame-num", String(i + 1));
      cell.appendChild(thumb);
      cell.appendChild(num);
      var del = el("button", "pixel-mini px-abs", "✕"); del.title = "Delete frame";
      del.addEventListener("click", function (ev) { ev.stopPropagation(); if (S.doc.frames.length <= 1) return; S.doc.frames.splice(i, 1); if (S.frame >= S.doc.frames.length) S.frame = S.doc.frames.length - 1; renderAll(); });
      cell.appendChild(del);
      cell.addEventListener("click", function () { S.frame = i; renderAll(); });
      box.appendChild(cell);
    });
  }

  function addFrame() {
    var fr = blankFrame(S.doc.layers, S.doc.w, S.doc.h);
    S.doc.frames.splice(S.frame + 1, 0, fr);
    S.frame = S.frame + 1;
    renderAll();
  }

  function dupFrame() {
    var fr = [];
    for (var l = 0; l < S.doc.frames[S.frame].length; l++) fr.push({ data: new Uint32Array(S.doc.frames[S.frame][l].data) });
    S.doc.frames.splice(S.frame + 1, 0, fr);
    S.frame = S.frame + 1;
    renderAll();
  }

  /* ---------- preview / export ---------- */

  function renderPreview() {
    var pv = document.getElementById("pixel-preview");
    if (!pv) return;
    var buf = composite(S.doc, S.frame);
    pv.width = S.doc.w; pv.height = S.doc.h;
    var ctx = pv.getContext("2d");
    var img = ctx.createImageData(S.doc.w, S.doc.h);
    for (var k = 0; k < buf.length; k++) {
      var px = buf[k]; var o = k * 4;
      img.data[o] = px & 0xff; img.data[o + 1] = (px >> 8) & 0xff; img.data[o + 2] = (px >> 16) & 0xff; img.data[o + 3] = (px >>> 24) & 0xff;
    }
    ctx.putImageData(img, 0, 0);
  }

  function exportPng() {
    var buf = composite(S.doc, S.frame);
    var c = document.createElement("canvas");
    c.width = S.doc.w; c.height = S.doc.h;
    var ctx = c.getContext("2d");
    // draw on checkerboard? We keep transparency. Put on white for visibility? Keep PNG with alpha.
    var img = ctx.createImageData(S.doc.w, S.doc.h);
    for (var k = 0; k < buf.length; k++) {
      var px = buf[k]; var o = k * 4;
      img.data[o] = px & 0xff; img.data[o + 1] = (px >> 8) & 0xff; img.data[o + 2] = (px >> 16) & 0xff; img.data[o + 3] = (px >>> 24) & 0xff;
    }
    ctx.putImageData(img, 0, 0);
    var a = el("a");
    a.href = c.toDataURL("image/png");
    a.download = "chalkle-art.png";
    document.body.appendChild(a); a.click(); a.remove();
  }

  function exportGif() {
    // minimal animated GIF encoder (uncompressed LZW, RGBA flattened per frame is hard) — 
    // we ship a decent GIF encoder below via a bundled simple encoder.
    var frames = [];
    for (var f = 0; f < S.doc.frames.length; f++) frames.push(composite(S.doc, f));
    var gif = encodeGIF(frames, S.doc.w, S.doc.h, S.fps);
    var blob = new Blob([gif], { type: "image/gif" });
    var url = URL.createObjectURL(blob);
    var a = el("a"); a.href = url; a.download = "chalkle-anim.gif";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* Minimal GIF encoder: false-color mode with fixed 256-color global palette
     using a flattened composite (transparent pixels become the palette's first
     index). Good enough for pixel art sharing. */
  function encodeGIF(framesRaw, w, h, fps) {
    // Build a palette from all frames (quantize to 256 colors, keep alpha simple:
    // transparent = index 0, we use a solid-color passthrough otherwise).
    var n = w * h;
    var colorCount = {};
    var items = [];
    for (var f = 0; f < framesRaw.length; f++) {
      for (var i = 0; i < n; i++) {
        var px = framesRaw[f][i];
        var key = px >>> 0;
        if (!colorCount[key]) colorCount[key] = 0;
        colorCount[key]++;
      }
    }
    var keys = Object.keys(colorCount).map(function (k) { return +k; });
    keys.sort(function (a, b) { return colorCount[b] - colorCount[a]; });
    // top 255 opaque colors (we reserve none for transparency intentionally) — 
    // enforce max 256
    var palette = keys.slice(0, 256);
    var map = {};
    palette.forEach(function (k, idx) { map[k] = idx; });
    // any leftover colors map to nearest kept
    function idxOf(px) {
      if (map[px] !== undefined) return map[px];
      var best = 0, bestD = Infinity;
      var r = px & 0xff, g = (px >> 8) & 0xff, b = (px >> 16) & 0xff;
      for (var j = 0; j < palette.length; j++) {
        var kp = palette[j];
        var dr = (kp & 0xff) - r, dg = ((kp >> 8) & 0xff) - g, db = ((kp >> 16) & 0xff) - b;
        var dist = dr * dr + dg * dg + db * db;
        if (dist < bestD) { bestD = dist; best = j; }
      }
      map[px] = best;
      return best;
    }
    var bytes = [];
    function w8(v) { bytes.push(v & 0xff); }
    function w16(v) { bytes.push(v & 0xff, (v >> 8) & 0xff); }
    function w32(v) { bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); }

    // Header
    w8(0x47); w8(0x49); w8(0x46); w8(0x38); w8(0x39); w8(0x61); // GIF89a
    w16(w); w16(h);
    bytes.push(0xF7); // GCT present, 8 bits, color resolution 7, bg 0, aspect 0
    bytes.push(0x00); bytes.push(0x00); // bg + aspect
    // Global palette (256 entries * 3 = 768 bytes)
    for (var p = 0; p < 256; p++) {
      var col = palette[p] !== undefined ? palette[p] : 0;
      bytes.push(col & 0xff, (col >> 8) & 0xff, (col >> 16) & 0xff);
    }
    // Netscape looping extension
    bytes.push(0x21, 0xFF, 0x0B); bytes.push(0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30); bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);
    // delay = 100/fps in centiseconds
    var delay = Math.max(1, Math.round(100 / fps));
    for (var fr = 0; fr < framesRaw.length; fr++) {
      // Graphic control
      bytes.push(0x21, 0xF9, 0x04, 0x00); w16(delay); bytes.push(0x00, 0x00);
      // Image descriptor
      bytes.push(0x2C); w16(0); w16(0); w16(w); w16(h);
      bytes.push(0x00); // no local color table
      // LZW encode indexes
      var data = framesRaw[fr];
      var idxData = new Uint8Array(n);
      for (var k = 0; k < n; k++) idxData[k] = idxOf(data[k]);
      var lzw = lzwEncode(idxData, w);
      bytes.push(8); // LZW min code size 8
      // write sub-blocks
      for (var s = 0; s < lzw.length; s += 255) {
        var chunk = lzw.subarray(s, s + 255);
        bytes.push(chunk.length);
        for (var b = 0; b < chunk.length; b++) bytes.push(chunk[b]);
      }
      bytes.push(0x00);
    }
    bytes.push(0x3B); // trailer
    return new Uint8Array(bytes);
  }

  function lzwEncode(data, w) {
    // Standard GIF LZW with a 4096-entry dictionary, re-init when full.
    var minCode = 8;
    var clearCode = 1 << minCode;
    var endCode = clearCode + 1;
    var codeSize = minCode + 1;
    var dict = new Map();
    var outBits = [];
    var dictSize = endCode + 1;
    var buffer = 0, nbits = 0;
    function emit(code, size) {
      buffer |= code << nbits; nbits += size;
      while (nbits >= 8) { outBits.push(buffer & 0xff); buffer >>>= 8; nbits -= 8; }
    }
    emit(clearCode, codeSize);
    var prev = data[0];
    var wBytes = w;
    for (var i = 1; i < data.length; i++) {
      var cur = data[i];
      var key = prev * 4096 + cur;
      if (!dict.has(key)) {
        emit(prev, codeSize);
        dict.set(key, dictSize++);
        // grow code size
        if (dictSize === (1 << codeSize) && codeSize < 12) codeSize++;
        if (dictSize > 4095) {
          emit(clearCode, codeSize);
          dict.clear();
          dictSize = endCode + 1;
          codeSize = minCode + 1;
        }
        prev = cur;
      } else {
        prev = dict.get(key);
      }
    }
    emit(prev, codeSize);
    emit(endCode, codeSize);
    if (nbits > 0) outBits.push(buffer & 0xff);
    return new Uint8Array(outBits);
  }

  /* ---------- import ---------- */

  function openImageFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var tw = Math.min(img.width, 512), th = Math.min(img.height, 512);
        S.doc = newDoc(tw, th);
        // draw image onto a temp canvas, then sample to abgr
        var tmp = document.createElement("canvas");
        tmp.width = tw; tmp.height = th;
        var ctx = tmp.getContext("2d");
        ctx.drawImage(img, 0, 0, tw, th);
        var imgData = ctx.getImageData(0, 0, tw, th).data;
        var layer = S.doc.frames[0][0];
        for (var y = 0; y < th; y++) {
          for (var x = 0; x < tw; x++) {
            var o = (y * tw + x) * 4;
            var r = imgData[o], g = imgData[o + 1], b = imgData[o + 2], a = imgData[o + 3];
            layer.data[y * tw + x] = (a << 24) | (b << 16) | (g << 8) | r;
          }
        }
        // wipe extra layers
        while (S.doc.layers.length > 1) { S.doc.layers.pop(); }
        while (S.doc.frames[0].length > 1) { S.doc.frames[0].pop(); }
        renderAll();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function newDimensions() {
    var wIn = document.getElementById("pixel-ww"); var hIn = document.getElementById("pixel-wh");
    var w = parseInt(wIn.value, 10) || 64; var h = parseInt(hIn.value, 10) || 64;
    if (w < 1 || w > 512) w = 64; if (h < 1 || h > 512) h = 64;
    pushHistory();
    S.doc.frames = []; S.doc.layers = S.doc.layers || [];
    S.doc.w = w; S.doc.h = h;
    // rebuild layers + frames to fresh blank
    var oldLayers = S.doc.layers.length ? S.doc.layers.map(function (l, i) { return { name: l.name, visible: true, opacity: 255 }; }) : [{ name: "Layer 1", visible: true, opacity: 255 }];
    S.doc.layers = oldLayers;
    S.doc.frames = [blankFrame(oldLayers, w, h)];
    renderAll();
  }

  /* ---------- zoom / pan ---------- */

  function setZoom(z) { S.zoom = Math.max(1, Math.min(32, z)); renderAll(); }
  function zoomIn() { setZoom(S.zoom + 1); }
  function zoomOut() { setZoom(S.zoom - 1); }

  /* ---------- build UI ---------- */

  var inited = false;

  function init() {
    var app = document.getElementById("pixel-app");
    if (!app) return;

    /* Toolbar */
    var toolbar = el("div", "pixel-toolbar");
    var tools = [
      ["pencil", "Pencil", "✏", "Pencil (B)"],
      ["eraser", "Eraser", "◻", "Eraser (E)"],
      ["bucket", "Bucket", "🪣", "Fill (G)"],
      ["pick", "Eyedropper", "💧", "Pick color (I)"],
      ["line", "Line", "╱", "Line (L)"],
      ["rect", "Rect", "▭", "Rectangle"],
      ["efill", "Rect fill", "▬", "Filled rectangle"],
      ["ellipse", "Ellipse", "◯", "Ellipse outline"],
      ["eellipse", "Ellipse fill", "⬤", "Filled ellipse"]
    ];
    var toolBtns = {};
    tools.forEach(function (t) {
      var b = el("button", "pixel-tool" + (S.tool === t[0] ? " is-active" : ""), t[2]);
      b.title = t[3];
      b.addEventListener("click", function () { S.tool = t[0]; Object.keys(toolBtns).forEach(function (k) { toolBtns[k].classList.toggle("is-active", k === t[0]); }); });
      toolBtns[t[0]] = b;
      toolbar.appendChild(b);
    });

    /* Top action buttons */
    var toprow = el("div", "pixel-toprow");
    var btnNew = el("button", "pixel-btn", "New");
    var btndimM = el("div", "pixel-dim", "64×64");
    var btnOpen = el("label", "pixel-btn", "Open");
    var fileInput = el("input"); fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.style.display = "none";
    btnOpen.appendChild(fileInput);
    fileInput.addEventListener("change", function () { if (fileInput.files && fileInput.files[0]) openImageFile(fileInput.files[0]); fileInput.value = ""; });
    var btnUndo = el("button", "pixel-btn", "↩ Undo");
    var btnRedo = el("button", "pixel-btn", "↪ Redo");
    var btnClear = el("button", "pixel-btn", "Clear");
    btnNew.addEventListener("click", function () { toggleNewDims(true); });
    btnUndo.addEventListener("click", undo);
    btnRedo.addEventListener("click", redoAction);

    var pane = el("div", "pixel-left");
    pane.appendChild(toolbar);

    var colorPanel = el("div", "pixel-panel");
    var ct = el("h3", "pixel-panel-title", "Colors");
    // swatch + hex row
    var swRow = el("div", "pixel-row");
    var swatch = el("span", "pixel-swatch", ""); swatch.id = "pixel-swatch";
    var hexIn = el("input", "pixel-hex"); hexIn.id = "pixel-hex"; hexIn.spellcheck = false;
    hexIn.addEventListener("change", function () { setColorFromHex(hexIn.value); });
    var colPick = el("input"); colPick.type = "color"; colPick.id = "pixel-color"; colPick.className = "pixel-colpick";
    swRow.append(swatch, hexIn);
    var altRow = el("div", "pixel-row");
    var altLbl = el("span", "pixel-mini-lbl", "R-Click:");
    var altSwatch = el("span", "pixel-swatch alt", ""); altSwatch.id = "pixel-swatch-alt";
    altRow.append(altLbl, altSwatch);
    var alphaRow = el("div", "pixel-row");
    alphaRow.appendChild(el("span", "pixel-mini-lbl", "Alpha"));
    var alIn = el("input"); alIn.type = "range"; alIn.id = "pixel-alpha"; alIn.min = 0; alIn.max = 255;
    var alVal = el("span", "pixel-mini-lbl", "255"); alVal.id = "pixel-alpha-val";
    alphaRow.append(alIn, alVal);

    var rgbRow = el("div", "pixel-rgb");
    [["r", "R"], ["g", "G"], ["b", "B"]].forEach(function (pair) {
      var lbl = el("label", "pixel-rgb-item", pair[1]);
      var range = el("input"); range.type = "range"; range.id = "pixel-" + pair[0]; range.min = 0; range.max = 255;
      lbl.appendChild(range);
      rgbRow.appendChild(lbl);
    });

    function bindRGBA() {
      ["r", "g", "b", "alpha"].forEach(function (k) {
        var inp = document.getElementById("pixel-" + k);
        if (!inp) return;
        inp.addEventListener("input", function () {
          var v = parseInt(inp.value, 10) || 0;
          if (k === "alpha") S.color.a = v; else S.color[k] = v;
          syncColorUI();
        });
      });
      var pick = document.getElementById("pixel-color");
      if (pick) pick.addEventListener("input", function () { setColorFromHex(pick.value); });
    }

    colorPanel.append(ct, swRow, altRow);
    colorPanel.appendChild(colPick);
    colorPanel.appendChild(alphaRow);
    colorPanel.appendChild(rgbRow);

    /* Palette source — quick swatches that set the current color */
    var paletteRow = el("div", "pixel-palette");
    var palette = [
      "#000000", "#1d1f27", "#ffffff", "#ff004d", "#ffa300", "#3ae0ff", "#7dff00",
      "#ff77a8", "#20283d", "#705632", "#9b3b3b", "#e8a838", "#4e6bb0", "#8b61c4"
    ];
    palette.forEach(function (hex) {
      var sw = el("button", "pixel-palette-swatch", "");
      sw.style.background = hex;
      sw.addEventListener("click", function () { setColorFromHex(hex); });
      paletteRow.appendChild(sw);
    });
    colorPanel.appendChild(paletteRow);

    var optsPanel = el("div", "pixel-panel");
    var ottl = el("h3", "pixel-panel-title", "Options");
    function mkToggle(lbl, id, opts) {
      var lab = el("label", "pixel-check");
      var cb = el("input"); cb.type = "checkbox"; cb.id = id;
      lab.appendChild(cb); lab.appendChild(document.createTextNode(lbl));
      if (opts && opts.def) cb.checked = opts.def;
      optsPanel.appendChild(lab);
      return cb;
    }
    var gridCb = mkToggle("Grid", "pixel-grid", { def: true });
    var onionCb = mkToggle("Onion skin", "pixel-onion");
    var symHCb = mkToggle("Sym H", "pixel-symh");
    var symVCb = mkToggle("Sym V", "pixel-symv");
    var playCb = mkToggle("Animate", "pixel-animate");
    gridCb.addEventListener("change", function () { S.grid = gridCb.checked; renderAll(); });
    onionCb.addEventListener("change", function () { S.onion = onionCb.checked; renderAll(); });
    symHCb.addEventListener("change", function () { S.symH = symHCb.checked; });
    symVCb.addEventListener("change", function () { S.symV = symVCb.checked; });
    playCb.addEventListener("change", function () { if (playCb.checked) startPlay(); else stopPlay(); });

    var fpsRow = el("div", "pixel-row");
    fpsRow.appendChild(el("span", "pixel-mini-lbl", "FPS"));
    var fpsIn = el("input"); fpsIn.type = "range"; fpsIn.id = "pixel-fps"; fpsIn.min = 1; fpsIn.max = 24;
    fpsIn.value = S.fps;
    var fpsVal = el("span", "pixel-mini-lbl", S.fps + " fps"); fpsVal.id = "pixel-fps-val";
    fpsIn.addEventListener("input", function () { S.fps = +fpsIn.value; fpsVal.textContent = S.fps + " fps"; });
    fpsRow.append(fpsIn, fpsVal);

    /* Layers panel */
    var layersPanel = el("div", "pixel-panel pixel-layers-panel");
    var layersHead = el("div", "pixel-panel-title-row");
    layersHead.appendChild(el("h3", "pixel-panel-title", "Layers"));
    var btnAddLayer = el("button", "pixel-mini", "+"); btnAddLayer.title = "Add layer";
    var btnDupLayer = el("button", "pixel-mini", "⧉"); btnDupLayer.title = "Duplicate layer";
    layersHead.append(btnAddLayer, btnDupLayer);
    btnAddLayer.addEventListener("click", addLayer);
    btnDupLayer.addEventListener("click", dupLayer);
    var layersBox = el("div", "pixel-layers"); layersBox.id = "pixel-layers";
    layersPanel.append(layersHead, layersBox);

    /* Timeline */
    var tlPanel = el("div", "pixel-timeline-panel");
    var tlHead = el("div", "pixel-panel-title-row");
    var tlTitle = el("h3", "pixel-panel-title", "Timeline");
    tlHead.appendChild(tlTitle);
    var frameLabel = el("span", "pixel-mini-lbl", "1 / 1"); frameLabel.id = "pixel-framecount";
    tlHead.appendChild(frameLabel);
    var tlBtnAdd = el("button", "pixel-mini", "+ Frame");
    var tlBtnDup = el("button", "pixel-mini", "⧉ Frame");
    tlHead.append(tlBtnAdd, tlBtnDup);
    tlBtnAdd.addEventListener("click", addFrame);
    tlBtnDup.addEventListener("click", dupFrame);
    var tlRow = el("div", "pixel-timeline"); tlRow.id = "pixel-timeline";
    tlPanel.append(tlHead, tlRow, fpsRow);

    /* Export buttons */
    var exportRow = el("div", "pixel-export-row");
    var btnPng = el("button", "pixel-btn accent", "Export PNG");
    var btnGif = el("button", "pixel-btn accent", "Export GIF");
    var btnClear2 = el("button", "pixel-btn danger", "Clear frame");
    btnPng.addEventListener("click", exportPng);
    btnGif.addEventListener("click", exportGif);
    btnClear2.addEventListener("click", function () { if (!S.doc) return; pushHistory(); for (var l = 0; l < S.doc.frames[S.frame].length; l++) S.doc.frames[S.frame][l].data.fill(0); renderAll(); });
    exportRow.append(btnPng, btnGif, btnClear2);

    /* New dims overlay */
    var newDims = el("div", "pixel-newdims"); newDims.id = "pixel-newdims"; newDims.hidden = true;
    var ndCard = el("div", "pixel-newdims-card");
    ndCard.appendChild(el("h3", "pixel-panel-title", "New canvas"));
    var wRow = el("div", "pixel-row");
    wRow.appendChild(el("label", "pixel-mini-lbl", "Width"));
    var wIn = el("input"); wIn.type = "number"; wIn.id = "pixel-ww"; wIn.min = 1; wIn.max = 512; wIn.value = S.doc ? S.doc.w : 64;
    wRow.appendChild(wIn);
    var hRow = el("div", "pixel-row");
    hRow.appendChild(el("label", "pixel-mini-lbl", "Height"));
    var hIn = el("input"); hIn.type = "number"; hIn.id = "pixel-wh"; hIn.min = 1; hIn.max = 512; hIn.value = S.doc ? S.doc.h : 64;
    hRow.appendChild(hIn);
    var ndBtns = el("div", "pixel-row");
    var ndOk = el("button", "pixel-btn accent", "Create");
    var ndCancel = el("button", "pixel-btn", "Cancel");
    ndOk.addEventListener("click", function () { newDimensions(); toggleNewDims(false); });
    ndCancel.addEventListener("click", function () { toggleNewDims(false); });
    ndBtns.append(ndOk, ndCancel);
    ndCard.append(wRow, hRow, ndBtns);
    newDims.appendChild(ndCard);

    /* Status bar */
    var status = el("div", "pixel-status");
    var posLbl = el("span", "", "-"); posLbl.id = "pixel-pos";
    var zoomLbl = el("span", "", ""); zoomLbl.id = "pixel-zoom";
    var canLbl = el("span", "", ""); canLbl.id = "pixel-canvas-label";
    status.append(posLbl, zoomLbl, canLbl);

    /* Canvas viewport */
    var viewWrap = el("div", "pixel-view"); viewWrap.id = "pixel-view";
    var canvasEl = document.createElement("canvas");
    canvasEl.id = "pixel-canvas"; canvasEl.className = "pixel-canvas";
    var gridCanvas = document.createElement("canvas");
    gridCanvas.id = "pixel-grid-canvas"; gridCanvas.className = "pixel-grid";
    viewWrap.append(gridCanvas, canvasEl);

    /* Right side: preview */
    var rightCol = el("div", "pixel-right");
    rightCol.appendChild(el("h3", "pixel-panel-title", "Preview"));
    var previewCanvas = document.createElement("canvas");
    previewCanvas.id = "pixel-preview"; previewCanvas.className = "pixel-preview";
    var pvHint = el("p", "pixel-preview-hint", "Nearest-neighbor preview of the current frame");
    rightCol.append(previewCanvas, pvHint);

    /* Main layout */
    var main = el("div", "pixel-main");
    var leftCol = el("div", "pixel-leftcol");
    leftCol.append(pane, colorPanel, optsPanel, layersPanel);

    var centerCol = el("div", "pixel-centercol");
    centerCol.append(toprow, viewWrap, status);

    main.append(leftCol, centerCol, rightCol);

    app.appendChild(main);
    app.appendChild(tlPanel);
    app.appendChild(exportRow);
    app.appendChild(newDims);

    /* Wire inputs that were built dynamically */
    bindRGBA();
    btnClear.addEventListener("click", function () { if (!S.doc) return; pushHistory(); for (var l = 0; l < S.doc.frames[S.frame].length; l++) S.doc.frames[S.frame][l].data.fill(0); renderAll(); });
    toprow.append(btnNew, btndimM, btnOpen, btnUndo, btnRedo, btnClear);

    /* Mouse handling */
    viewWrap.addEventListener("mousedown", function (e) {
      if (e.button === 1 || e.button === 2) e.preventDefault();
      startStroke(e);
    });
    viewWrap.addEventListener("mousemove", function (e) {
      var cc = cellFromEvent(e);
      var pos = document.getElementById("pixel-pos");
      if (pos) pos.textContent = (cc.x >= 0 && cc.y >= 0) ? (cc.x + ", " + cc.y) : "-";
      moveStroke(e);
    });
    viewWrap.addEventListener("mouseup", endStroke);
    viewWrap.addEventListener("mouseleave", function () { if (S.drawing) { endStroke(); } });
    viewWrap.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    viewWrap.addEventListener("wheel", function (e) {
      e.preventDefault();
      if (e.ctrlKey) { setZoom(S.zoom + (e.deltaY < 0 ? 1 : -1)); }
    }, { passive: false });

    /* Toggle new-dims visibility */
    function toggleNewDims(show) {
      var nd = document.getElementById("pixel-newdims");
      if (nd) nd.hidden = !show;
    }

    /* Keyboard shortcuts */
    document.addEventListener("keydown", function (e) {
      var modal = document.getElementById("pixel-modal");
      if (!modal || modal.hidden) return;
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      var k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "z") { e.preventDefault(); redoAction(); }
      else if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redoAction(); }
      else if (k === "p") { S.tool = "pencil"; }
      else if (k === "e") { S.tool = "eraser"; }
      else if (k === "g") { S.tool = "bucket"; }
      else if (k === "i") { S.tool = "pick"; }
      else if (k === "l") { S.tool = "line"; }
    }, true);

    /* Play loop */
    var animTimer = null;
    function startPlay() { if (!S.doc || S.doc.frames.length <= 1) { playCb.checked = false; return; } stopPlay(); animTimer = setInterval(function () { S.frame = (S.frame + 1) % S.doc.frames.length; renderAll(); }, 1000 / S.fps); }
    function stopPlay() { if (animTimer) { clearInterval(animTimer); animTimer = null; } }

    S.startPlay = startPlay; S.stopPlay = stopPlay;

    // Load saved project if any
    loadProject();
    if (!S.doc) S.doc = newDoc(64, 64);
    renderAll();
    syncColorUI();
    updateStatus();
    inited = true;
  }

  function updateStatus() {
    var zoom = document.getElementById("pixel-zoom");
    if (zoom) zoom.textContent = S.zoom + "×";
    var can = document.getElementById("pixel-canvas-label");
    if (can && S.doc) can.textContent = S.doc.w + " × " + S.doc.h;
    var dim = document.querySelector(".pixel-dim");
    if (dim && S.doc) dim.textContent = S.doc.w + "×" + S.doc.h;
    var lb = document.getElementById("pixel-framecount");
    if (lb && S.doc) lb.textContent = (S.frame + 1) + " / " + S.doc.frames.length;
  }

  /* ---------- persistence ---------- */

  function loadProject() {
    try {
      var raw = localStorage.getItem(APP_KEY);
      if (!raw) return;
      var p = JSON.parse(raw);
      S.doc = p.doc; S.zoom = p.zoom || 6; S.frame = 0; S.layer = 0;
    } catch (e) { /* ignore */ }
  }
  function saveProject() {
    try {
      if (!S.doc) return;
      /* serialize uint32 arrays compactly */
      var sdoc = { w: S.doc.w, h: S.doc.h, layers: S.doc.layers.map(function (l) { return { name: l.name, visible: l.visible, opacity: l.opacity }; }), frames: [] };
      for (var f = 0; f < S.doc.frames.length; f++) {
        var fl = [];
        for (var i = 0; i < S.doc.frames[f].length; i++) {
          fl.push({ data: Array.from(S.doc.frames[f][i].data) });
        }
        sdoc.frames.push(fl);
      }
      localStorage.setItem(APP_KEY, JSON.stringify({ doc: sdoc, zoom: S.zoom }));
    } catch (e) { /* storage full - non fatal */ }
  }

  /* auto-save debounced on edit */
  var saveTimer = null;
  function scheduleSave() { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(saveProject, 800); }

  function open() {
    var modal = document.getElementById("pixel-modal");
    if (!modal) return;
    if (!inited) { init(); } else { if (!S.doc) { S.doc = newDoc(64, 64); } renderAll(); syncColorUI(); }
    modal.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function close() {
    var modal = document.getElementById("pixel-modal");
    if (modal) modal.hidden = true;
    document.body.style.overflow = "";
    saveProject();
    if (S.stopPlay) S.stopPlay();
  }

  window.ChalklePixel = { open: open, close: close };

  document.addEventListener("DOMContentLoaded", function () {
    var modal = document.getElementById("pixel-modal");
    if (!modal) return;
    modal.querySelectorAll("[data-pixel-close]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        if (e.target === el || el.tagName === "BUTTON") close();
      });
    });
  });
})();