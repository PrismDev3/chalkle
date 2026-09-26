/* Chalkle Pixel: an Aseprite-grade pixel art editor, built in and offline.
   Matches the real Aseprite toolset: pencil (with pixel-perfect), eraser,
   eyedropper, hand, move, marquee + lasso + magic wand selections, paint
   bucket, line, rect/ellipse (outline + filled), contour, shading, blur.
   Layers with opacity + blend modes, frames with onion skin, symmetry,
   palettes, undo/redo, zoom, PNG/GIF/ASE-ish export. Runs entirely locally;
   nothing is uploaded. */

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

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* ---------- document model ---------- */

  /* One pixel = ABGR in a Uint32Array: (a<<24)|(b<<16)|(g<<8)|r, 0 = transparent. */

  function blankLayer(w, h) { return new Uint32Array(w * h); }

  function blankFrame(layers, w, h) {
    var fr = [];
    for (var i = 0; i < layers.length; i++) fr.push({ data: blankLayer(w, h) });
    return fr;
  }

  function newDoc(w, h) {
    if (!w || w < 1 || w > 512) w = 64;
    if (!h || h < 1 || h > 512) h = 64;
    var layers = [
      { name: "Layer 1", visible: true, opacity: 255, blend: "normal" },
      { name: "Layer 2", visible: true, opacity: 255, blend: "normal" }
    ];
    return {
      w: w, h: h,
      layers: layers.slice(),
      frames: [blankFrame(layers, w, h)]
    };
  }

  function cloneDoc(doc) {
    var layers = doc.layers.map(function (l) {
      return { name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend || "normal" };
    });
    var frames = doc.frames.map(function (fr) {
      return fr.map(function (cel) {
        return { data: new Uint32Array(cel.data) };
      });
    });
    return { w: doc.w, h: doc.h, layers: layers, frames: frames };
  }

  function colorAt(doc, f, l, x, y) {
    if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return 0;
    return doc.frames[f][l].data[y * doc.w + x];
  }

  function setPixel(doc, f, l, x, y, c) {
    if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return;
    doc.frames[f][l].data[y * doc.w + x] = c;
  }

  /* ---------- whole-sprite transforms (Sprite menu / Edit flip+rotate) ---------- */

  /* Flip/rotate the active layer's cel on the current frame. Aseprite's menu
     ops work on the selection first, but layer cels cover the common case. */
  function transformCel(fn) {
    var w = S.doc.w, h = S.doc.h;
    var src = S.doc.frames[S.frame][S.layer].data;
    var out = new Uint32Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var t = fn(x, y, w, h);
        if (t.x < 0 || t.y < 0 || t.x >= w || t.y >= h) continue;
        out[t.y * w + t.x] = src[y * w + x];
      }
    }
    src.set(out);
  }
  function flipLayer(vertical) {
    pushHistory();
    transformCel(function (x, y, w, h) { return vertical ? { x: x, y: h - 1 - y } : { x: w - 1 - x, y: y }; });
    renderAll();
  }
  function rotateLayer(deg) {
    pushHistory();
    if (deg === 180) {
      transformCel(function (x, y, w, h) { return { x: w - 1 - x, y: h - 1 - y }; });
    } else {
      transformCel(function (x, y, w, h) { return { x: h - 1 - y, y: x }; });
    }
    renderAll();
  }

  /* ---------- color / blend math ---------- */

  function unpack(c) {
    return { a: (c >>> 24) & 0xff, b: (c >> 16) & 0xff, g: (c >> 8) & 0xff, r: c & 0xff };
  }
  function pack(r, g, b, a) {
    return ((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
  }

  /* Channel blend for Aseprite's blend modes. Returns blended 0-255. */
  function blendCh(mode, back, front) {
    var b = back / 255, f = front / 255;
    switch (mode) {
      case "multiply": return 255 * b * f;
      case "screen": return 255 * (b + f - b * f);
      case "overlay":
        return 255 * (b < 0.5 ? 2 * b * f : 1 - 2 * (1 - b) * (1 - f));
      case "darken": return Math.min(back, front);
      case "lighten": return Math.max(back, front);
      case "difference": return 255 * Math.abs(b - f);
      case "exclusion": return 255 * (b + f - 2 * b * f);
      case "dodge":
      case "color_dodge": return f >= 1 ? 255 : 255 * Math.min(1, b / (1 - f));
      case "burn":
      case "color_burn": return f <= 0 ? 0 : 255 * (1 - Math.min(1, (1 - b) / f));
      case "hard_light": return 255 * (f < 0.5 ? 2 * b * f : 1 - 2 * (1 - b) * (1 - f));
      case "soft_light": return 255 * ((1 - 2 * f) * b * b + 2 * f * b);
      case "addition": return Math.min(255, back + front);
      case "subtract": return Math.max(0, back - front);
      case "divide": return f <= 0 ? 255 : 255 * Math.min(1, b / f);
      case "hsl_hue":
      case "hsl_sat":
      case "hsl_color":
      case "hsl_lum":
        return front; /* per-channel fallback; handled specially below */
      default: return front;
    }
  }

  /* Full RGB blend honoring Aseprite HSL modes. */
  function blendRGB(mode, br, bg, bb, fr, fg, fb) {
    if (mode === "hsl_hue" || mode === "hsl_sat" || mode === "hsl_color" || mode === "hsl_lum") {
      var bh = rgb2hsl(br, bg, bb), fh = rgb2hsl(fr, fg, fb);
      var h, s, l;
      if (mode === "hsl_hue") { h = fh[0]; s = bh[1]; l = bh[2]; }
      else if (mode === "hsl_sat") { h = bh[0]; s = fh[1]; l = bh[2]; }
      else if (mode === "hsl_color") { h = fh[0]; s = fh[1]; l = bh[2]; }
      else { h = bh[0]; s = bh[1]; l = fh[2]; }
      var r = hsl2rgb(h, s, l);
      return [r[0], r[1], r[2]];
    }
    return [blendCh(mode, br, fr), blendCh(mode, bg, fg), blendCh(mode, bb, fb)];
  }

  function rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }

  function hsl2rgb(h, s, l) {
    if (s === 0) { var v = Math.round(l * 255); return [v, v, v]; }
    function hue2rgb(p, q, t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    return [
      Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
    ];
  }

  /* Composite the document for frame f into a flat ABGR buffer.
     Applies per-layer opacity + blend modes, bottom layer first (index 0). */
  function composite(doc, f) {
    var w = doc.w, h = doc.h, n = w * h;
    var out = new Uint32Array(n); /* transparent */
    for (var li = 0; li < doc.layers.length; li++) {
      var ly = doc.layers[li];
      if (!ly.visible) continue;
      var cel = doc.frames[f][li];
      var op = clamp(ly.opacity, 0, 255) / 255;
      var mode = ly.blend || "normal";
      for (var i = 0; i < n; i++) {
        var src = cel.data[i];
        if (src === 0 || op === 0) continue;
        var sa = ((src >>> 24) & 0xff) / 255 * op;
        if (sa === 0) continue;
        var sr = src & 0xff, sg = (src >> 8) & 0xff, sb = (src >> 16) & 0xff;
        var dst = out[i];
        var da = (dst >>> 24) & 0xff;
        if (da === 0) {
          out[i] = pack(sr, sg, sb, Math.round(sa * 255));
          continue;
        }
        var dr = dst & 0xff, dg = (dst >> 8) & 0xff, db = (dst >> 16) & 0xff;
        /* blend modes only apply over opaque backing like Aseprite's composite */
        var m = blendRGB(mode, dr, dg, db, sr, sg, sb);
        var outA = sa + da / 255 * (1 - sa);
        var oa = outA || 1;
        var or = (m[0] * sa + dr * (da / 255) * (1 - sa)) / oa;
        var og = (m[1] * sa + dg * (da / 255) * (1 - sa)) / oa;
        var ob = (m[2] * sa + db * (da / 255) * (1 - sa)) / oa;
        out[i] = pack(Math.round(or), Math.round(og), Math.round(ob), Math.round(outA * 255));
      }
    }
    return out;
  }

  /* ---------- state ---------- */

  var S = {
    doc: null,
    frame: 0,
    layer: 0,
    tool: "pencil",
    color: { r: 255, g: 0, b: 0, a: 255 },
    altColor: { r: 255, g: 255, b: 255, a: 255 },
    symH: false, symV: false,
    grid: true,
    pixelPerfect: false,
    onion: false, onionPrev: 1, onionNext: 1, onionOpacity: 0.28,
    playing: false, fps: 8,
    zoom: 6,
    /* selection state: null or { mask: Uint8Array, x0, y0, x1, y1 } (mask 255 = selected) */
    sel: null,
    /* clipboard for copy/paste */
    clip: null,
    /* history */
    undo: [], redo: [],
    drawing: false, lastX: -1, lastY: -1,
    toolOpt: {} /* per-tool transient state (tolerance etc.) */
  };

  S.toolOpt.tolerance = 0;
  S.toolOpt.gradientRadial = false; /* Shift inverts the gradient, Aseprite-style */    S.snap = false; S.gridSize = 8; /* snap-to-grid guides (View options) */
  S.brush = 1; /* brush diameter in cells ([ and ] resize it, like Aseprite) */

  /* Timeline state: per-frame durations (ms), loop tags, play mode. */
  S.durations = []; /* one entry per frame, ms; 1000/fps when untouched */
  S.tags = []; /* { name, from, to, color } inclusive frame range */
  S.playMode = "loop"; S.playDir = 1; S.playing = false;

  function currentLayer() { return S.doc.layers[S.layer]; }

  /* Brush diameter helper ([ / ] shortcuts). */
  function setBrush(d) {
    S.brush = clamp(d, 1, 32);
    updateStatus();
  }

  /* 1-0 keys: set the active layer opacity to 10%..100% like Aseprite. */
  function setLayerOpacityPreset(pct) {
    if (!S.doc) return;
    currentLayer().opacity = Math.round(clamp(pct, 0, 100) * 255 / 100);
    var opIn = document.getElementById("pixel-layer-opacity");
    if (opIn) opIn.value = currentLayer().opacity;
    renderAll();
  }

  /* Aseprite's full blend mode list, in menu order. */
  var BLEND_MODES = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color_dodge", "color_burn", "hard_light", "soft_light", "difference", "exclusion", "hsl_hue", "hsl_sat", "hsl_color", "hsl_lum", "addition", "subtract", "divide"];
  var BLEND_LABELS = { "normal": "Normal", "multiply": "Multiply", "screen": "Screen", "overlay": "Overlay", "darken": "Darken", "lighten": "Lighten", "color_dodge": "Color Dodge", "color_burn": "Color Burn", "hard_light": "Hard Light", "soft_light": "Soft Light", "difference": "Difference", "exclusion": "Exclusion", "hsl_hue": "Hue", "hsl_sat": "Saturation", "hsl_color": "Color", "hsl_lum": "Luminosity", "addition": "Addition", "subtract": "Subtract", "divide": "Divide" };

  function packColor(c) { return pack(c.r, c.g, c.b, c.a); }

  /* ---------- selection ---------- */

  function newMask(w, h) { return new Uint8Array(w * h); }

  function clearSel() { S.sel = null; renderFrameCanvas(); renderSelOverlay(); updateStatus(); }

  function selectAll() {
    var w = S.doc.w, h = S.doc.h;
    var mask = newMask(w, h); mask.fill(255);
    S.sel = { mask: mask, x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
    renderFrameCanvas(); renderSelOverlay(); updateStatus();
  }

  function invertSel() {
    if (!S.sel) { selectAll(); return; }
    for (var i = 0; i < S.sel.mask.length; i++) S.sel.mask[i] = S.sel.mask[i] ? 0 : 255;
    renderSelOverlay();
  }

  function selActive() { return S.sel && S.sel.mask; }

  function selRectToMask(x0, y0, x1, y1, ellipse) {
    var w = S.doc.w, h = S.doc.h;
    var mask = newMask(w, h);
    var xmin = clamp(Math.min(x0, x1), 0, w - 1), xmax = clamp(Math.max(x0, x1), 0, w - 1);
    var ymin = clamp(Math.min(y0, y1), 0, h - 1), ymax = clamp(Math.max(y0, y1), 0, h - 1);
    var cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
    var rx = (xmax - xmin) / 2, ry = (ymax - ymin) / 2;
    for (var y = ymin; y <= ymax; y++) {
      for (var x = xmin; x <= xmax; x++) {
        if (!ellipse || (rx <= 0 && ry <= 0) ||
            ((x - cx) * (x - cx)) / (rx * rx || 1) + ((y - cy) * (y - cy)) / (ry * ry || 1) <= 1) {
          mask[y * w + x] = 255;
        }
      }
    }
    S.sel = { mask: mask, x0: xmin, y0: ymin, x1: xmax, y1: ymax };
  }

  function selLasso(points) {
    /* fill polygon via scanline parity (points in canvas cell space) */
    var w = S.doc.w, h = S.doc.h;
    var mask = newMask(w, h);
    if (points.length < 3) return;
    for (var y = 0; y < h; y++) {
      var inside = false;
      for (var x = 0; x < w; x++) {
        var crossings = 0;
        for (var i = 0, j = points.length - 1; i < points.length; j = i++) {
          var xi = points[i].x, yi = points[i].y, xj = points[j].x, yj = points[j].y;
          if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1) + xi) crossings++;
        }
        if (crossings % 2 === 1) mask[y * w + x] = 255;
      }
    }
    S.sel = { mask: mask, x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
  }

  function selWand(x, y, tolerance, contiguous) {
    var w = S.doc.w, h = S.doc.h;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    var l = S.layer;
    var data = S.doc.frames[S.frame][l].data;
    var target = data[y * w + x];
    var tr = target & 0xff, tg = (target >> 8) & 0xff, tb = (target >> 16) & 0xff, ta = (target >>> 24) & 0xff;
    function match(v) {
      var vr = v & 0xff, vg = (v >> 8) & 0xff, vb = (v >> 16) & 0xff, va = (v >>> 24) & 0xff;
      var d = Math.sqrt((vr - tr) * (vr - tr) + (vg - tg) * (vg - tg) + (vb - tb) * (vb - tb) + (va - ta) * (va - ta));
      return d <= tolerance;
    }
    var mask = newMask(w, h);
    if (contiguous) {
      var stack = [[x, y]];
      while (stack.length) {
        var p = stack.pop();
        var px = p[0], py = p[1];
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        var idx = py * w + px;
        if (mask[idx]) continue;
        if (!match(data[idx])) continue;
        mask[idx] = 255;
        stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
      }
    } else {
      for (var i = 0; i < data.length; i++) if (match(data[i])) mask[i] = 255;
    }
    S.sel = { mask: mask, x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
    renderAll();
  }

  /* Get selected pixels as {data, w, h, x0, y0} or null. */
  function selectedRegion() {
    if (!selActive()) return null;
    var w = S.doc.w, h = S.doc.h;
    var mask = S.sel.mask;
    var x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    return { x0: x0, y0: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /* ---------- history ---------- */

  function pushHistory() {
    S.undo.push({ doc: cloneDoc(S.doc), sel: S.sel ? new Uint8Array(S.sel.mask) : null });
    if (S.undo.length > 50) S.undo.shift();
    S.redo = [];
    updateStatus();
  }

  function undo() {
    if (!S.undo.length) return;
    S.redo.push({ doc: cloneDoc(S.doc), sel: S.sel ? new Uint8Array(S.sel.mask) : null });
    var st = S.undo.pop();
    S.doc = st.doc;
    S.sel = st.sel ? { mask: st.sel } : null;
    if (S.frame >= S.doc.frames.length) S.frame = S.doc.frames.length - 1;
    if (S.layer >= S.doc.layers.length) S.layer = S.doc.layers.length - 1;
    renderAll();
    updateStatus();
  }

  function redoAction() {
    if (!S.redo.length) return;
    S.undo.push({ doc: cloneDoc(S.doc), sel: S.sel ? new Uint8Array(S.sel.mask) : null });
    var st = S.redo.pop();
    S.doc = st.doc;
    S.sel = st.sel ? { mask: st.sel } : null;
    if (S.frame >= S.doc.frames.length) S.frame = S.doc.frames.length - 1;
    if (S.layer >= S.doc.layers.length) S.layer = S.doc.layers.length - 1;
    renderAll();
    updateStatus();
  }

  /* ---------- core render ---------- */

  function renderFrameCanvas() {
    var canvas = document.getElementById("pixel-canvas");
    if (!canvas || !S.doc) return;
    canvas.width = S.canvasW = S.doc.w * S.zoom;
    canvas.height = S.canvasH = S.doc.h * S.zoom;
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (S.onion) {
      var prev = S.frame - S.onionPrev, next = S.frame + S.onionNext;
      var stop = S.tags && S.tags.length ? S.tags.reduce(function (acc, tg) { return Math.min(acc, tg.from); }, Infinity) : -Infinity;
      if (prev >= stop) {
        var buf = composite(S.doc, prev);
        for (var i = 0; i < buf.length; i++) if ((buf[i] >>> 24) < 128) buf[i] = (buf[i] & 0x00ffffff) | 0x80000000;
        drawBuffer(ctx, buf, S.onionOpacity);
      }
      if (next < S.doc.frames.length) drawBuffer(ctx, composite(S.doc, next), S.onionOpacity);
    }
    drawBuffer(ctx, composite(S.doc, S.frame), 1);
  }

  function drawBuffer(ctx, buf, alpha) {
    var w = S.doc.w, h = S.doc.h;
    var img = ctx.createImageData(w, h);
    var d = img.data;
    for (var i = 0; i < buf.length; i++) {
      var px = buf[i];
      var o = i * 4;
      d[o] = px & 0xff; d[o + 1] = (px >> 8) & 0xff; d[o + 2] = (px >> 16) & 0xff; d[o + 3] = (px >>> 24) & 0xff;
    }
    var tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    tmp.getContext("2d").putImageData(img, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, w, h, 0, 0, w * S.zoom, h * S.zoom);
    ctx.globalAlpha = 1;
  }

  function renderAll() {
    if (!S.doc) return;
    renderFrameCanvas();
    renderGrid();
    renderRulers();
    renderSelOverlay();
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
    if (!g || !S.doc) return;
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

  /* ---------- rulers (top + left, Aseprite always shows them) ---------- */

  var RULER_W = 22;

  function renderRulers() {
    var top = document.getElementById("pixel-ruler-top");
    var left = document.getElementById("pixel-ruler-left");
    if (!top || !left || !S.doc) return;
    var z = S.zoom;
    var tw = S.doc.w * z, th = S.doc.h * z;
    top.width = tw + RULER_W; top.height = RULER_W;
    left.width = RULER_W; left.height = th + RULER_W;
    top.style.width = (tw + RULER_W) + "px"; top.style.height = RULER_W + "px";
    left.style.width = RULER_W + "px"; left.style.height = (th + RULER_W) + "px";
    var bg = "#1e2025", fg = "#5a616e", line = "#34383f";
    [top, left].forEach(function (c) {
      var ctx = c.getContext("2d");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (c === top) { ctx.moveTo(0.5, RULER_W - 0.5); ctx.lineTo(c.width - 0.5, RULER_W - 0.5); }
      else { ctx.moveTo(RULER_W - 0.5, 0.5); ctx.moveTo(RULER_W - 0.5, 0.5); ctx.lineTo(RULER_W - 0.5, c.height - 0.5); }
      ctx.stroke();
      ctx.fillStyle = fg;
      ctx.font = "9px 'Segoe UI', system-ui, sans-serif";
      ctx.textBaseline = "top";
    });
    var tctx = top.getContext("2d");
    for (var x = 0; x <= S.doc.w; x++) {
      var px = RULER_W + x * z;
      var major = z >= 5 || x % 10 === 0;
      tctx.strokeStyle = line;
      tctx.beginPath();
      tctx.moveTo(px + 0.5, major ? RULER_W - 10 : RULER_W - 5);
      tctx.lineTo(px + 0.5, RULER_W - 1);
      tctx.stroke();
      if (major && z >= 5) { tctx.fillStyle = fg; tctx.fillText(String(x), px + 2, 2); }
    }
    var lctx = left.getContext("2d");
    for (var y = 0; y <= S.doc.h; y++) {
      var py = RULER_W + y * z;
      var maj = z >= 5 || y % 10 === 0;
      lctx.strokeStyle = line;
      lctx.beginPath();
      lctx.moveTo(maj ? RULER_W - 10 : RULER_W - 5, py + 0.5);
      lctx.lineTo(RULER_W - 1, py + 0.5);
      lctx.stroke();
      if (maj && z >= 5) {
        lctx.fillStyle = fg;
        lctx.save();
        lctx.translate(2, py + 2);
        lctx.rotate(-Math.PI / 2);
        lctx.fillText(String(y), 0, 0);
        lctx.restore();
      }
    }
  }

  /* ---------- selection marching-ants overlay ---------- */

  var antsOffset = 0, antsTimer = null;

  function sizeSelCanvas(c) {
    if (!c || !S.doc) return;
    c.width = S.doc.w * S.zoom;
    c.height = S.doc.h * S.zoom;
    c.style.width = (S.doc.w * S.zoom) + "px";
    c.style.height = (S.doc.h * S.zoom) + "px";
  }

  function renderSelOverlay() {
    var c = document.getElementById("pixel-sel-canvas");
    if (!c || !S.doc) return;
    sizeSelCanvas(c);
    var ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    if (!selActive()) { if (antsTimer) { clearInterval(antsTimer); antsTimer = null; } return; }
    if (!antsTimer) {
      antsTimer = setInterval(function () { antsOffset = (antsOffset + 1) % 8; renderSelOverlay(); }, 110);
    }
    var w = S.doc.w, h = S.doc.h, z = S.zoom, mask = S.sel.mask;
    /* faint fill over selected area */
    ctx.fillStyle = "rgba(120,220,255,0.10)";
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      if (mask[y * w + x]) ctx.fillRect(x * z, y * z, z, z);
    }
    /* marching ants on the boundary */
    ctx.strokeStyle = "#8fd6c2";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -antsOffset;
    ctx.beginPath();
    var drew = false;
    for (var yy = 0; yy < h; yy++) for (var xx = 0; xx < w; xx++) {
      if (!mask[yy * w + xx]) continue;
      var edges = [];
      if (xx === 0 || !mask[yy * w + xx - 1]) edges.push([xx * z, yy * z, xx * z, (yy + 1) * z]);
      if (xx === w - 1 || !mask[yy * w + xx + 1]) edges.push([(xx + 1) * z, yy * z, (xx + 1) * z, (yy + 1) * z]);
      if (yy === 0 || !mask[(yy - 1) * w + xx]) edges.push([xx * z, yy * z, (xx + 1) * z, yy * z]);
      if (yy === h - 1 || !mask[(yy + 1) * w + xx]) edges.push([xx * z, (yy + 1) * z, (xx + 1) * z, (yy + 1) * z]);
      for (var e = 0; e < edges.length; e++) {
        ctx.moveTo(edges[e][0] + 0.5, edges[e][1] + 0.5);
        ctx.lineTo(edges[e][2] + 0.5, edges[e][3] + 0.5);
        drew = true;
      }
    }
    if (drew) ctx.stroke();
    ctx.setLineDash([]);
  }

  /* ---------- drawing primitives ---------- */

  function applyColorTo(doc, f, l, x, y, c, style) {
    if (style === "erase") { setPixel(doc, f, l, x, y, 0); return; }
    var base = colorAt(doc, f, l, x, y);
    var final = (style === "blend") ? blend(c, base) : c;
    setPixel(doc, f, l, x, y, final);
  }

  /* Alpha-composite color c over base ABGR (for soft eraser / alpha pencil). */
  function blend(overABGR, baseABGR) {
    var oa = (overABGR >>> 24) & 0xff, ba = (baseABGR >>> 24) & 0xff;
    if (oa >= 255) return overABGR;
    if (oa === 0) return baseABGR;
    var or = overABGR & 0xff, og = (overABGR >> 8) & 0xff, ob = (overABGR >> 16) & 0xff;
    var br = baseABGR & 0xff, bg = (baseABGR >> 8) & 0xff, bb = (baseABGR >> 16) & 0xff;
    var a = oa / 255, na = 1 - a;
    return pack(
      Math.round(or * a + br * na), Math.round(og * a + bg * na), Math.round(ob * a + bb * na),
      Math.round(oa + ba * na)
    );
  }

  function floodFill(doc, f, l, x, y, target, fill, tolerance) {
    var w = doc.w, h = doc.h;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    var data = doc.frames[f][l].data;
    var start = data[y * w + x];
    if (start === fill) return;
    if (tolerance > 0) {
      var tr = start & 0xff, tg = (start >> 8) & 0xff, tb = (start >> 16) & 0xff, ta = (start >>> 24) & 0xff;
      function match(v) {
        var vr = v & 0xff, vg = (v >> 8) & 0xff, vb = (v >> 16) & 0xff, va = (v >>> 24) & 0xff;
        return Math.sqrt((vr - tr) * (vr - tr) + (vg - tg) * (vg - tg) + (vb - tb) * (vb - tb) + (va - ta) * (va - ta)) <= tolerance;
      }
      var stack = [[x, y]];
      while (stack.length) {
        var p = stack.pop();
        var px = p[0], py = p[1];
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        var idx = py * w + px;
        if (!match(data[idx])) continue;
        if (data[idx] === fill) continue;
        data[idx] = fill;
        stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
      }
      return;
    }
    var tstack = [[x, y]];
    function tMatch(v) { return target === -1 ? v === 0 : v === target; }
    while (tstack.length) {
      var tp = tstack.pop();
      var tpx = tp[0], tpy = tp[1];
      if (tpx < 0 || tpy < 0 || tpx >= w || tpy >= h) continue;
      var tidx = tpy * w + tpx;
      var tv = data[tidx];
      if (target === -1 ? tv !== 0 : tv !== start) continue;
      if (tv === fill) continue;
      data[tidx] = fill;
      tstack.push([tpx + 1, tpy], [tpx - 1, tpy], [tpx, tpy + 1], [tpx, tpy - 1]);
    }
  }

  function cellFromEvent(e) {
    /* Map against the rendered canvas, not the viewport. The canvas can be
       centered, scrolled, or zoomed, and using the viewport origin makes the
       brush land several pixels away from the cursor in those states. */
    var canvas = document.getElementById("pixel-canvas");
    var r = canvas ? canvas.getBoundingClientRect() : document.getElementById("pixel-view").getBoundingClientRect();
    var x = Math.floor((e.clientX - r.left) / S.zoom);
    var y = Math.floor((e.clientY - r.top) / S.zoom);
    /* Snap-to-grid guides round the pointer onto the grid (View option). */
    if (S.snap && !/marquee|lasso|wand|hand|zoom|move|pick/.test(S.tool) && S.doc) {
      var gs = Math.max(1, S.gridSize | 0);
      x = Math.round(x / gs) * gs;
      y = Math.round(y / gs) * gs;
    }
    return { x: x, y: y };
  }

  function drawStroke(x0, y0, x1, y1, color, paintFn) {
    var dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    var err = dx + dy;
    while (true) {
      paintFn(x0, y0, color);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function paintCell(x, y, color) {
    var l = S.layer;
    setPixel(S.doc, S.frame, l, x, y, color);
    if (S.symH) setPixel(S.doc, S.frame, l, S.doc.w - 1 - x, y, color);
    if (S.symV) setPixel(S.doc, S.frame, l, x, S.doc.h - 1 - y, color);
    if (S.symH && S.symV) setPixel(S.doc, S.frame, l, S.doc.w - 1 - x, S.doc.h - 1 - y, color);
  }

  /* Round brush stamp: paints a filled circle of diameter S.brush around
     (x, y), mirroring paintCell's symmetry behavior. Used when S.brush > 1. */
  function paintBrush(x, y, color) {
    var r = (S.brush - 1) / 2;
    var rr = r * r;
    for (var dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (var dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        var d2 = dx * dx + dy * dy;
        if (d2 <= rr || (d2 - rr) <= Math.max(1, rr * 0.15)) {
          paintCell(Math.round(x + dx), Math.round(y + dy), color);
        }
      }
    }
  }

  /* Aseprite pixel-perfect pencil: removes the L-corner cell so clean
     diagonal strokes stay 1px thick instead of staircasing. We record every
     cell painted this stroke (with the color that was there before) and, after
     each move, walk the trailing cells and blank out any L-corner. */
  var strokeCells = null; /* [{x,y,orig}] in paint order */

  function isLCorner(p0, p1, p2) {
    return (p0.x === p1.x || p0.y === p1.y) &&
           (p1.x === p2.x || p1.y === p2.y) &&
           p0.x !== p2.x && p0.y !== p2.y;
  }

  function paintPPMove(x, y, color) {
    var l = S.layer;
    function paintOne(cx, cy) {
      var inside = cx >= 0 && cy >= 0 && cx < S.doc.w && cy < S.doc.h;
      var orig = inside ? S.doc.frames[S.frame][l].data[cy * S.doc.w + cx] : 0;
      paintCell(cx, cy, color);
      strokeCells.push({ x: cx, y: cy, orig: orig });
    }
    paintOne(x, y);
    /* L-corner removal on the trailing run */
    while (strokeCells.length >= 3) {
      var p0 = strokeCells[strokeCells.length - 3];
      var p1 = strokeCells[strokeCells.length - 2];
      var p2 = strokeCells[strokeCells.length - 1];
      if (!isLCorner(p0, p1, p2)) break;
      /* blank the corner back to its original color */
      if (p1.x >= 0 && p1.y >= 0 && p1.x < S.doc.w && p1.y < S.doc.h) {
        S.doc.frames[S.frame][l].data[p1.y * S.doc.w + p1.x] = p1.orig;
      }
      strokeCells.splice(strokeCells.length - 2, 1);
    }
  }

  /* Draw a line/rect/ellipse/etc. The shape tools (rect, ellipse) can take
     an explicit outline or filled variant like Aseprite's right-click cycle:
     mode "outline" strokes the border, "fill" paints the interior, "mixed"
     uses the tool id itself (frect/fellipse fill, rect/ellipse outline). */
  function drawShape(x0, y0, x1, y1, modeArg) {
    var color = packColor(S.color);
    var l = S.layer;
    var mode = modeArg || (S.tool === "rect" || S.tool === "ellipse" ? "outline" : "fill");
    var cell = S.brush > 1 ? paintBrush : paintCell;
    if (S.tool === "line") { drawStroke(x0, y0, x1, y1, color, cell); return; }
    var xmin = Math.min(x0, x1), xmax = Math.max(x0, x1);
    var ymin = Math.min(y0, y1), ymax = Math.max(y0, y1);
    if (S.tool === "rect" || S.tool === "frect") {
      if (mode === "fill") {
        for (var fy = ymin; fy <= ymax; fy++) for (var fx = xmin; fx <= xmax; fx++) cell(fx, fy, color);
      } else {
        for (var sx = xmin; sx <= xmax; sx++) { cell(sx, ymin, color); cell(sx, ymax, color); }
        for (var sy = ymin + 1; sy < ymax; sy++) { cell(xmin, sy, color); cell(xmax, sy, color); }
      }
    } else if (S.tool === "ellipse" || S.tool === "fellipse") {
      var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      var rx = Math.max(0, (xmax - xmin) / 2), ry = Math.max(0, (ymax - ymin) / 2);
      var filled = mode === "fill";
      var steps = 120;
      for (var i = 0; i <= steps; i++) {
        var t = i / steps * Math.PI * 2;
        var px = Math.round(cx + rx * Math.cos(t));
        var py = Math.round(cy + ry * Math.sin(t));
        cell(px, py, color);
      }
      if (filled) {
        for (var yy = Math.floor(cy - ry); yy <= Math.ceil(cy + ry); yy++) {
          for (var xx = Math.floor(cx - rx); xx <= Math.ceil(cx + rx); xx++) {
            var n = ((xx - cx) / (rx || 1)); var m = ((yy - cy) / (ry || 1));
            if (n * n + m * m <= 1) cell(xx, yy, color);
          }
        }
      }
    } else if (S.tool === "contour") {
      /* outline of the contiguous region under the cursor */
      var w = S.doc.w, h = S.doc.h;
      var data = S.doc.frames[S.frame][S.layer].data;
      var start = data[y0 * w + x0];
      var region = new Uint8Array(w * h);
      var stack = [[x0, y0]];
      function tM(v) { return start === 0 ? v === 0 : v === start; }
      while (stack.length) {
        var p = stack.pop();
        var px = p[0], py = p[1];
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        var idx = py * w + px;
        if (region[idx]) continue;
        if (!tM(data[idx])) continue;
        region[idx] = 1;
        stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
      }
      for (var cy2 = 0; cy2 < h; cy2++) for (var cx2 = 0; cx2 < w; cx2++) {
        if (!region[cy2 * w + cx2]) continue;
        var onEdge = false;
        if (cx2 === 0 || cy2 === 0 || cx2 === w - 1 || cy2 === h - 1) onEdge = true;
        else if (!region[cy2 * w + cx2 - 1] || !region[cy2 * w + cx2 + 1] || !region[(cy2 - 1) * w + cx2] || !region[(cy2 + 1) * w + cx2]) onEdge = true;
        if (onEdge) paintCell(cx2, cy2, color);
      }
    } else if (S.tool === "shading") {
      /* lighten/darken pass on the stroke area (multiplicative) */
      var amt = 0.7; /* 30% darker */
      var w2 = S.doc.w, h2 = S.doc.h;
      var data2 = S.doc.frames[S.frame][S.layer].data;
      drawStroke(x0, y0, x1, y1, 0, function (px, py) {
        if (px < 0 || py < 0 || px >= w2 || py >= h2) return;
        var idx = py * w2 + px;
        var v = data2[idx];
        if (v === 0) return;
        var vr = clamp(Math.round((v & 0xff) * amt), 0, 255);
        var vg = clamp(Math.round(((v >> 8) & 0xff) * amt), 0, 255);
        var vb = clamp(Math.round(((v >> 16) & 0xff) * amt), 0, 255);
        data2[idx] = pack(vr, vg, vb, (v >>> 24) & 0xff);
      });
    } else if (S.tool === "blur") {
      /* box blur the stroke radius */
      var bw = S.doc.w, bh = S.doc.h;
      var data3 = S.doc.frames[S.frame][S.layer].data;
      var src = new Uint32Array(data3);
      function blured(px, py) {
        var accR = 0, accG = 0, accB = 0, accA = 0, cnt = 0;
        for (var dy2 = -1; dy2 <= 1; dy2++) for (var dx2 = -1; dx2 <= 1; dx2++) {
          var sx2 = px + dx2, sy2 = py + dy2;
          if (sx2 < 0 || sy2 < 0 || sx2 >= bw || sy2 >= bh) continue;
          var v = src[sy2 * bw + sx2];
          accR += v & 0xff; accG += (v >> 8) & 0xff; accB += (v >> 16) & 0xff; accA += (v >>> 24) & 0xff;
          cnt++;
        }
        if (!cnt) return 0;
        return pack(accR / cnt | 0, accG / cnt | 0, accB / cnt | 0, accA / cnt | 0);
      }
      var r = S.brush > 1 ? (S.brush >> 1) : 1;
      var bx0 = clamp(x0 - r, 0, bw - 1), by0 = clamp(y0 - r, 0, bh - 1), bx1 = clamp(x1 + r, 0, bw - 1), by1 = clamp(y1 + r, 0, bh - 1);
      var bminx = Math.min(bx0, bx1), bmaxx = Math.max(bx0, bx1);
      var bminy = Math.min(by0, by1), bmaxy = Math.max(by0, by1);
      for (var by2 = bminy; by2 <= bmaxy; by2++) for (var bx2 = bminx; bx2 <= bmaxx; bx2++) {
        if (data3[by2 * bw + bx2] === 0) continue;
        var accR = 0, accG = 0, accB = 0, accA = 0, cnt = 0;
        for (var dy2 = -r; dy2 <= r; dy2++) for (var dx2 = -r; dx2 <= r; dx2++) {
          var sx2 = bx2 + dx2, sy2 = by2 + dy2;
          if (sx2 < 0 || sy2 < 0 || sx2 >= bw || sy2 >= bh) continue;
          var v = src[sy2 * bw + sx2];
          accR += v & 0xff; accG += (v >> 8) & 0xff; accB += (v >> 16) & 0xff; accA += (v >>> 24) & 0xff;
          cnt++;
        }
        if (!cnt) continue;
        data3[by2 * bw + bx2] = pack(accR / cnt | 0, accG / cnt | 0, accB / cnt | 0, accA / cnt | 0);
      }
    } else if (S.tool === "sharpen") {
      /* unsharp: push each pixel away from its neighborhood mean, like Aseprite's Sharpen */
      var sw = S.doc.w, sh = S.doc.h;
      var sdata = S.doc.frames[S.frame][S.layer].data;
      var ssrc = new Uint32Array(sdata);
      var sr = S.brush > 1 ? (S.brush >> 1) : 1;
      var shx0 = clamp(Math.min(x0, x1) - sr, 0, sw - 1), shy0 = clamp(Math.min(y0, y1) - sr, 0, sh - 1);
      var shx1 = clamp(Math.max(x0, x1) + sr, 0, sw - 1), shy1 = clamp(Math.max(y0, y1) + sr, 0, sh - 1);
      for (var sy3 = shy0; sy3 <= shy1; sy3++) for (var sx3 = shx0; sx3 <= shx1; sx3++) {
        var si = sy3 * sw + sx3;
        var sv = sdata[si];
        if (sv === 0) continue;
        var bR = 0, bG = 0, bB = 0, cnt2 = 0;
        for (var dy3 = -1; dy3 <= 1; dy3++) for (var dx3 = -1; dx3 <= 1; dx3++) {
          var nx = sx3 + dx3, ny = sy3 + dy3;
          if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue;
          var nv = ssrc[ny * sw + nx];
          bR += nv & 0xff; bG += (nv >> 8) & 0xff; bB += (nv >> 16) & 0xff; cnt2++;
        }
        if (!cnt2) continue;
        bR /= cnt2; bG /= cnt2; bB /= cnt2;
        var vr2 = clamp(Math.round((sv & 0xff) + ((sv & 0xff) - bR) * 0.7), 0, 255);
        var vg2 = clamp(Math.round(((sv >> 8) & 0xff) + (((sv >> 8) & 0xff) - bG) * 0.7), 0, 255);
        var vb2 = clamp(Math.round(((sv >> 16) & 0xff) + (((sv >> 16) & 0xff) - bB) * 0.7), 0, 255);
        sdata[si] = pack(vr2, vg2, vb2, (sv >>> 24) & 0xff);
      }
    } else if (S.tool === "jumble") {
      /* Aseprite Jumble: smear - pull a random neighbor's color over each cell */
      var jw = S.doc.w, jh = S.doc.h;
      var jdata = S.doc.frames[S.frame][S.layer].data;
      var jsrc = new Uint32Array(jdata);
      var jr = S.brush > 1 ? (S.brush >> 1) : 1;
      var jx0 = clamp(Math.min(x0, x1) - jr, 0, jw - 1), jy0 = clamp(Math.min(y0, y1) - jr, 0, jh - 1);
      var jx1 = clamp(Math.max(x0, x1) + jr, 0, jw - 1), jy1 = clamp(Math.max(y0, y1) + jr, 0, jh - 1);
      for (var jy = jy0; jy <= jy1; jy++) for (var jx = jx0; jx <= jx1; jx++) {
        var ji = jy * jw + jx;
        var nv2 = jsrc[clamp(jy + (Math.random() * 3 | 0) - 1, 0, jh - 1) * jw + clamp(jx + (Math.random() * 3 | 0) - 1, 0, jw - 1)];
        if (nv2 !== 0) jdata[ji] = nv2;
      }
    } else if (S.tool === "spray") {
      /* airbrush: scatter color inside the brush radius */
      var r2 = (S.brush >> 1) + 1;
      var density = 0.35 + 0.65 * Math.random();
      for (var s2 = 0; s2 < S.brush * S.brush * density; s2++) {
        var ang = Math.random() * Math.PI * 2, rad = Math.sqrt(Math.random()) * r2;
        paintCell(Math.round(x0 + Math.cos(ang) * rad), Math.round(y0 + Math.sin(ang) * rad), color);
      }
    } else if (S.tool === "gradient") {
      /* Aseprite gradient: linear (or radial with Shift) drag from fg toward bg */
      var dist = Math.max(1, Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)));
      var radG = S.brush > 1 ? (S.brush >> 1) : 0;
      var cA = packColor(S.color), cB = packColor(S.altColor);
      var uA = unpack(cA), uB = unpack(cB);
      var gr, gc, gb, ga, t;
      for (var gy = 0; gy < S.doc.h; gy++) for (var gx = 0; gx < S.doc.w; gx++) {
        if (S.toolOpt.gradientRadial) {
          t = Math.sqrt((gx - x0) * (gx - x0) + (gy - y0) * (gy - y0)) / dist;
        } else {
          t = ((gx - x0) * (x1 - x0) + (gy - y0) * (y1 - y0)) / (dist * dist);
        }
        if (t < 0) t = 0; if (t > 1) t = 1;
        ga = Math.round(uA.a + (uB.a - uA.a) * t);
        if (ga === 0) continue;
        gr = Math.round(uA.r + (uB.r - uA.r) * t);
        gc = Math.round(uA.g + (uB.g - uA.g) * t);
        gb = Math.round(uA.b + (uB.b - uA.b) * t);
        if (radG) {
          paintCell(gx, gy, pack(gr, gc, gb, ga));
        } else {
          for (var oy2 = -radG; oy2 <= radG; oy2++) for (var ox2 = -radG; ox2 <= radG; ox2++) {
            if (ox2 * ox2 + oy2 * oy2 <= radG * radG + 0.01) paintCell(gx + ox2, gy + oy2, pack(gr, gc, gb, ga));
          }
        }
      }
    }
  }

  /* ---------- move tool ---------- */

  var moveState = null;

  function startMove(e) {
    var c = cellFromEvent(e);
    var l = S.layer;
    var region = selectedRegion();
    if (region) {
      var w = S.doc.w, h = S.doc.h, mask = S.sel.mask;
      var data = new Uint32Array(region.w * region.h);
      var src = S.doc.frames[S.frame][l].data;
      for (var y = 0; y < region.h; y++) for (var x = 0; x < region.w; x++) {
        var sx = region.x0 + x, sy = region.y0 + y;
        if (mask[sy * w + sx]) data[y * region.w + x] = src[sy * w + sx];
      }
      /* clear source under mask */
      for (var cy = 0; cy < h; cy++) for (var cx = 0; cx < w; cx++) {
        if (mask[cy * w + cx]) src[cy * w + cx] = 0;
      }
      moveState = { mode: "sel", data: data, rw: region.w, rh: region.h, x0: region.x0, y0: region.y0, ox: c.x, oy: c.y };
    } else {
      var cel = S.doc.frames[S.frame][l];
      var data2 = new Uint32Array(cel.data);
      for (var i = 0; i < cel.data.length; i++) cel.data[i] = 0;
      moveState = { mode: "layer", data: data2, x0: 0, y0: 0, ox: c.x, oy: c.y };
    }
    renderFrameCanvas();
    renderSelOverlay();
  }

  function moveDrag(e) {
    if (!moveState) return;
    var c = cellFromEvent(e);
    moveState.dx = c.x - moveState.ox;
    moveState.dy = c.y - moveState.oy;
    /* redraw base then blit the moving content */
    var canvas = document.getElementById("pixel-canvas");
    var ctx = canvas.getContext("2d");
    renderFrameCanvas();
    var w = S.doc.w, h = S.doc.h;
    var tmp = document.createElement("canvas");
    tmp.width = moveState.rw || w; tmp.height = moveState.rh || h;
    var tctx = tmp.getContext("2d");
    var img = tctx.createImageData(tmp.width, tmp.height);
    var d = img.data;
    var srcBuf = moveState.data;
    for (var y = 0; y < tmp.height; y++) for (var x = 0; x < tmp.width; x++) {
      var px = srcBuf[y * tmp.width + x];
      var o = (y * tmp.width + x) * 4;
      d[o] = px & 0xff; d[o + 1] = (px >> 8) & 0xff; d[o + 2] = (px >> 16) & 0xff; d[o + 3] = (px >>> 24) & 0xff;
    }
    tctx.putImageData(img, 0, 0);
    var dx = moveState.dx, dy = moveState.dy;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, (moveState.x0 + dx) * S.zoom, (moveState.y0 + dy) * S.zoom, tmp.width * S.zoom, tmp.height * S.zoom);
  }

  function endMove() {
    if (!moveState) return;
    var dx = moveState.dx || 0, dy = moveState.dy || 0;
    if (dx !== 0 || dy !== 0) {
      var w = S.doc.w, h = S.doc.h;
      var cel = S.doc.frames[S.frame][S.layer].data;
      var data = moveState.data, rw = moveState.rw || w, rh = moveState.rh || h;
      var x0 = moveState.x0 + dx, y0 = moveState.y0 + dy;
      for (var y = 0; y < rh; y++) for (var x = 0; x < rw; x++) {
        var px = data[y * rw + x];
        if (!px) continue;
        setPixel(S.doc, S.frame, S.layer, x0 + x, y0 + y, px);
      }
      pushHistory();
      if (moveState.mode === "sel") clearSel();
      renderAll();
    }
    moveState = null;
  }

  /* ---------- mouse interaction ---------- */

  function startStroke(e) {
    e.preventDefault();
    var c = cellFromEvent(e);
    var useAlt = e.button === 2;
    var chosen = useAlt ? S.altColor : S.color;
    var l = S.layer;

    /* eyedropper always available as right-click (except on zoom/pan/move/selection tools) */
    if (useAlt && S.tool !== "hand" && S.tool !== "move" && S.tool !== "marquee" && S.tool !== "lasso" && S.tool !== "wand" && S.tool !== "zoom") {
      var picked = colorAt(S.doc, S.frame, l, c.x, c.y);
      S.altColor = { r: picked & 0xff, g: (picked >> 8) & 0xff, b: (picked >> 16) & 0xff, a: (picked >>> 24) & 0xff };
      syncColorUI();
      return;
    }

    if (S.tool === "zoom") {
      /* Aseprite zoom tool: left-click steps in, right-click or Shift-click steps out */
      setZoom(S.zoom + ((useAlt || e.shiftKey) ? -1 : 1));
      return;
    }
    if (S.tool === "move") { pushHistory(); startMove(e); return; }
    if (S.tool === "hand" || S.spacePan) { S.drawing = true; S.lastX = e.clientX; S.lastY = e.clientY; return; }
    if (S.tool === "marquee" || S.tool === "lasso" || S.tool === "wand") {
      pushHistory();
      if (S.tool === "marquee") {
        S.anchorX = c.x; S.anchorY = c.y; S.drawing = true;
      } else if (S.tool === "lasso") {
        S.lassoPts = [{ x: c.x, y: c.y }]; S.drawing = true;
      } else {
        selWand(c.x, c.y, S.toolOpt.tolerance, true);
        return;
      }
      return;
    }

    pushHistory();
    S.drawing = true;
    S.lastX = c.x; S.lastY = c.y;
    strokeCells = S.pixelPerfect ? [] : null;

    if (S.tool === "bucket") {
      var target = colorAt(S.doc, S.frame, l, c.x, c.y);
      if (l >= 0 && l < S.doc.frames[S.frame].length) {
        floodFill(S.doc, S.frame, l, c.x, c.y, target, packColor(chosen), S.toolOpt.tolerance);
      }
      renderAll();
      S.drawing = false;
      return;
    }
    if (S.tool === "pick") {
      var pk = colorAt(S.doc, S.frame, l, c.x, c.y);
      S.color = { r: pk & 0xff, g: (pk >> 8) & 0xff, b: (pk >> 16) & 0xff, a: (pk >>> 24) & 0xff };
      syncColorUI();
      S.drawing = false;
      renderFrameCanvas();
      return;
    }
    if (S.tool === "pencil" || S.tool === "eraser") {
      var color = S.tool === "eraser" ? 0 : packColor(chosen);
      if (S.tool === "pencil" && S.pixelPerfect) {
        var l2 = S.layer;
        var orig = (c.x >= 0 && c.y >= 0 && c.x < S.doc.w && c.y < S.doc.h) ? S.doc.frames[S.frame][l2].data[c.y * S.doc.w + c.x] : 0;
        paintCell(c.x, c.y, color);
        strokeCells = [{ x: c.x, y: c.y, orig: orig }];
      } else {
        paintCell(c.x, c.y, color);
      }
      S.lastX = c.x; S.lastY = c.y;
    }
    S.anchorX = c.x; S.anchorY = c.y;
    renderAll();
  }

  function moveStroke(e) {
    if (!S.drawing) return;
    e.preventDefault();
    if (S.tool === "hand" || S.spacePan) { /* Space+drag pans from any tool */
      var view = document.getElementById("pixel-view");
      view.scrollLeft -= (e.clientX - S.lastX);
      view.scrollTop -= (e.clientY - S.lastY);
      S.lastX = e.clientX; S.lastY = e.clientY;
      return;
    }
    var c = cellFromEvent(e);
    if (S.tool === "marquee") {
      renderFrameCanvas();
      var x0 = Math.min(S.anchorX, c.x), x1 = Math.max(S.anchorX, c.x);
      var y0 = Math.min(S.anchorY, c.y), y1 = Math.max(S.anchorY, c.y);
      var cv = document.getElementById("pixel-sel-canvas");
      sizeSelCanvas(cv);
      var ctx = cv.getContext("2d");
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.strokeStyle = "#8fd6c2";
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x0 * S.zoom + 0.5, y0 * S.zoom + 0.5, (x1 - x0 + 1) * S.zoom, (y1 - y0 + 1) * S.zoom);
      ctx.setLineDash([]);
      return;
    }
    if (S.tool === "lasso") {
      S.lassoPts.push({ x: c.x, y: c.y });
      var cv2 = document.getElementById("pixel-sel-canvas");
      sizeSelCanvas(cv2);
      var ctx2 = cv2.getContext("2d");
      ctx2.clearRect(0, 0, cv2.width, cv2.height);
      ctx2.strokeStyle = "#8fd6c2";
      ctx2.setLineDash([4, 4]);
      ctx2.beginPath();
      ctx2.moveTo(S.lassoPts[0].x * S.zoom + 0.5, S.lassoPts[0].y * S.zoom + 0.5);
      for (var i = 1; i < S.lassoPts.length; i++) ctx2.lineTo(S.lassoPts[i].x * S.zoom + 0.5, S.lassoPts[i].y * S.zoom + 0.5);
      ctx2.stroke();
      ctx2.setLineDash([]);
      return;
    }
    if (S.tool === "move") { moveDrag(e); return; }      if (S.tool === "spray" || S.tool === "sharpen" || S.tool === "jumble") {
        if (S.lastX === c.x && S.lastY === c.y) return;
        drawShape(S.lastX, S.lastY, c.x, c.y);
        S.lastX = c.x; S.lastY = c.y;
        renderFrameCanvas();
      } else if (S.tool === "pencil" || S.tool === "eraser") {
        if (S.lastX === c.x && S.lastY === c.y) return;
        var color = S.tool === "eraser" ? 0 : packColor(S.color);
        if (S.tool === "pencil" && S.pixelPerfect) {
          drawStroke(S.lastX, S.lastY, c.x, c.y, color, paintPPMove);
        }
        else drawStroke(S.lastX, S.lastY, c.x, c.y, color, paintCell);
        S.lastX = c.x; S.lastY = c.y;
        renderFrameCanvas();
      } else if (S.tool === "line" || S.tool === "rect" || S.tool === "frect" || S.tool === "ellipse" || S.tool === "fellipse" || S.tool === "contour" || S.tool === "shading" || S.tool === "blur" || S.tool === "sharpen" || S.tool === "jumble" || S.tool === "gradient") {
      /* live preview: redraw canvas + preview shape */
      renderFrameCanvas();
      var cv3 = document.getElementById("pixel-sel-canvas");
      sizeSelCanvas(cv3);
      var ctx3 = cv3.getContext("2d");
      ctx3.clearRect(0, 0, cv3.width, cv3.height);
      ctx3.strokeStyle = "rgba(143,214,194,0.9)";
      ctx3.lineWidth = 1;
      if (S.tool === "line") {
        ctx3.beginPath();
        ctx3.moveTo((S.anchorX + 0.5) * S.zoom, (S.anchorY + 0.5) * S.zoom);
        ctx3.lineTo((c.x + 0.5) * S.zoom, (c.y + 0.5) * S.zoom);
        ctx3.stroke();
      } else if (S.tool === "rect" || S.tool === "frect") {
        ctx3.strokeRect(Math.min(S.anchorX, c.x) * S.zoom + 0.5, Math.min(S.anchorY, c.y) * S.zoom + 0.5,
          (Math.abs(c.x - S.anchorX) + 1) * S.zoom, (Math.abs(c.y - S.anchorY) + 1) * S.zoom);
      } else if (S.tool === "ellipse" || S.tool === "fellipse") {
        ctx3.beginPath();
        ctx3.ellipse((S.anchorX + c.x) / 2 * S.zoom + 0.5, (S.anchorY + c.y) / 2 * S.zoom + 0.5,
          Math.abs(c.x - S.anchorX) / 2 * S.zoom, Math.abs(c.y - S.anchorY) / 2 * S.zoom, 0, 0, Math.PI * 2);
        ctx3.stroke();
      }
    }
  }

  function endStroke(e) {
    if (!S.drawing) return;
    e.preventDefault();
    var c = cellFromEvent(e);
    if (S.tool === "marquee") {
      selRectToMask(S.anchorX, S.anchorY, c.x, c.y, false);
      S.drawing = false;
      renderAll();
      return;
    }
    if (S.tool === "lasso") {
      S.lassoPts.push({ x: c.x, y: c.y });
      selLasso(S.lassoPts);
      S.lassoPts = null;
      S.drawing = false;
      renderAll();
      return;
    }
    if (S.tool === "move") { endMove(); S.drawing = false; return; }
    if (S.tool === "hand" || S.spacePan) { S.drawing = false; return; }
    if (S.tool === "line" || S.tool === "rect" || S.tool === "frect" || S.tool === "ellipse" || S.tool === "fellipse" || S.tool === "contour" || S.tool === "shading" || S.tool === "blur" || S.tool === "sharpen" || S.tool === "jumble" || S.tool === "gradient") {
      drawShape(S.anchorX, S.anchorY, c.x, c.y);
    }
    strokeCells = null;
    S.drawing = false;
    renderAll();
  }

  /* ---------- selection actions ---------- */

  function cutSel() {
    var region = selectedRegion();
    if (!region) return;
    var w = S.doc.w, h = S.doc.h, mask = S.sel.mask;
    var data = new Uint32Array(region.w * region.h);
    var cel = S.doc.frames[S.frame][S.layer].data;
    for (var y = 0; y < region.h; y++) for (var x = 0; x < region.w; x++) {
      var sx = region.x0 + x, sy = region.y0 + y;
      if (mask[sy * w + sx]) data[y * region.w + x] = cel[sy * w + sx];
    }
    S.clip = { data: data, w: region.w, h: region.h };
    pushHistory();
    for (var cy = 0; cy < h; cy++) for (var cx = 0; cx < w; cx++) {
      if (mask[cy * w + cx]) cel[cy * w + cx] = 0;
    }
    clearSel();
    renderAll();
  }

  function copySel() {
    var region = selectedRegion();
    if (!region) return;
    var w = S.doc.w, h = S.doc.h, mask = S.sel.mask;
    var data = new Uint32Array(region.w * region.h);
    var cel = S.doc.frames[S.frame][S.layer].data;
    for (var y = 0; y < region.h; y++) for (var x = 0; x < region.w; x++) {
      var sx = region.x0 + x, sy = region.y0 + y;
      if (mask[sy * w + sx]) data[y * region.w + x] = cel[sy * w + sx];
    }
    S.clip = { data: data, w: region.w, h: region.h };
    updateStatus();
  }

  function pasteClip() {
    if (!S.clip) return;
    pushHistory();
    /* place at center-top-ish: top-left of canvas */
    var x0 = Math.max(0, Math.floor((S.doc.w - S.clip.w) / 2));
    var y0 = Math.max(0, Math.floor((S.doc.h - S.clip.h) / 2));
    var cel = S.doc.frames[S.frame][S.layer].data;
    for (var y = 0; y < S.clip.h; y++) for (var x = 0; x < S.clip.w; x++) {
      var px = S.clip.data[y * S.clip.w + x];
      if (px) setPixel(S.doc, S.frame, S.layer, x0 + x, y0 + y, px);
    }
    clearSel();
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
    var altSw = document.getElementById("pixel-swatch-alt");
    if (altSw) altSw.style.background = "#" + [S.altColor.r, S.altColor.g, S.altColor.b].map(function (v) { return v.toString(16).padStart(2, "0"); }).join("");
    renderRamp();
  }

  function setColorFromHex(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return;
    S.color.r = parseInt(m[1].slice(0, 2), 16);
    S.color.g = parseInt(m[1].slice(2, 4), 16);
    S.color.b = parseInt(m[1].slice(4, 6), 16);
    S.toolOpt.tstBase = null;
    var tst = document.getElementById("pixel-tst");
    if (tst) tst.value = 0;
    var tv = document.getElementById("pixel-tst-val");
    if (tv) tv.textContent = "0";
    syncColorUI();
  }

  function setColorFromHexBg(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return;
    S.altColor.r = parseInt(m[1].slice(0, 2), 16);
    S.altColor.g = parseInt(m[1].slice(2, 4), 16);
    S.altColor.b = parseInt(m[1].slice(4, 6), 16);
    syncColorUI();
  }

  function normHex(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (m) return "#" + m[1].toLowerCase();
    m = /^#?([0-9a-f]{3})$/i.exec(String(hex).trim());
    if (m) return "#" + m[1][0] + m[1][0] + m[1][1] + m[1][1] + m[1][2] + m[1][2];
    return "#000000";
  }

  function swapColors() {
    var t = S.color; S.color = S.altColor; S.altColor = t;
    syncColorUI();
  }

  /* DawnBringer's DB32 - the classic indexed pixel-art palette. */
  var DB32 = [
    "#000000", "#222034", "#45283c", "#663931", "#8f563b", "#df7126", "#d9a066", "#eec39a",
    "#fbf236", "#99e550", "#6abe30", "#37946e", "#4b692f", "#524b24", "#323c39", "#3f3f74",
    "#306082", "#5b6ee1", "#639bff", "#5fcde4", "#cbdbfc", "#ffffff", "#9badb7", "#847e87",
    "#696a6a", "#595652", "#76428a", "#ac3232", "#d95763", "#d77bba", "#8f974a", "#8a6f30"
  ];

  /* Tint/Shade/Tone applied against the color the drag started from, so the
     slider is relative and never compounds. Plus: lighter, Tone: grayer. */
  function applyTST(v) {
    var base = S.toolOpt.tstBase || { r: S.color.r, g: S.color.g, b: S.color.b };
    var t = clamp(v, -100, 100) / 100;
    var h = rgb2hsl(base.r, base.g, base.b);
    var s = h[1], l = h[2];
    if (t > 0) { l = l + (1 - l) * t; s = s * (1 - t * 0.3); }
    else if (t < 0) { l = l * (1 + t); }
    var rgb = hsl2rgb(h[0], s, clamp(l, 0, 1));
    S.color.r = rgb[0]; S.color.g = rgb[1]; S.color.b = rgb[2];
    syncColorUI();
  }

  /* Aseprite's tint/shade/tone ramp: 4 rows x 12 steps derived from the
     current color (tint, tone, pure hue, shade). Filled by syncColorUI. */
  var rampGrid = null;
  function renderRamp() {
    if (!rampGrid) return;
    var hsl = rgb2hsl(S.color.r, S.color.g, S.color.b);
    rampGrid.innerHTML = "";
    for (var row = 0; row < 4; row++) {
      for (var col = 0; col < 12; col++) {
        var t = col / 11;
        var s = hsl[1], l = hsl[2];
        if (row === 0) { l = l + (1 - l) * t; s = s * (1 - t * 0.4); }
        else if (row === 1) { l = 0.5 + (l - 0.5) * (1 - t); s = s * (1 - t); }
        else if (row === 3) { l = l * (1 - t * 0.92); }
        var rgb = hsl2rgb(hsl[0], s, clamp(l, 0, 1));
        var hex = "#" + rgb.map(function (v) { return v.toString(16).padStart(2, "0"); }).join("");
        var cell = el("button", "pixel-ramp-cell", "");
        cell.style.background = hex;
        cell.title = hex;
        (function (h) { cell.addEventListener("click", function () { setColorFromHex(h); }); })(hex);
        rampGrid.appendChild(cell);
      }
    }
  }

  /* ---------- layers panel ---------- */

  /* Aseprite: active layer thumbnail composited on checkerboard. */
  function layerThumb(buf, cls, title) {
    var c = document.createElement("canvas");
    c.width = S.doc.w; c.height = S.doc.h;
    c.className = cls || "pixel-thumb";
    if (title) c.title = title;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#787878";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#a0a0a0";
    for (var y = 0; y < c.height; y += 8) for (var x = ((y >> 3) & 1) * 8; x < c.width; x += 16) ctx.fillRect(x, y, 8, 8);
    var img = ctx.createImageData(c.width, c.height);
    for (var k = 0; k < buf.length; k++) {
      var px = buf[k], o = k * 4;
      img.data[o] = px & 0xff; img.data[o + 1] = (px >> 8) & 0xff; img.data[o + 2] = (px >> 16) & 0xff; img.data[o + 3] = (px >>> 24) & 0xff;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function moveLayer(dir) {
    var i = S.layer;
    var j = i + dir;
    if (j < 0 || j >= S.doc.layers.length) return;
    var t = S.doc.layers[i]; S.doc.layers[i] = S.doc.layers[j]; S.doc.layers[j] = t;
    for (var f = 0; f < S.doc.frames.length; f++) { var tt = S.doc.frames[f][i]; S.doc.frames[f][i] = S.doc.frames[f][j]; S.doc.frames[f][j] = tt; }
    if (S.layer === i) S.layer = j;
    pushHistory();
    renderAll();
  }

  function removeLayer(i) {
    if (S.doc.layers.length <= 1) return;
    pushHistory();
    for (var f = 0; f < S.doc.frames.length; f++) S.doc.frames[f].splice(i, 1);
    S.doc.layers.splice(i, 1);
    if (S.layer >= S.doc.layers.length) S.layer = S.doc.layers.length - 1;
    renderAll();
  }

  /* Merge the active layer into the one below it (Aseprite: Merge Down). */
  function mergeDown() {
    var i = S.layer;
    if (i <= 0) return;
    pushHistory();
    var w = S.doc.w, h = S.doc.h;
    var over = S.doc.frames[S.frame][i].data;
    var under = S.doc.frames[S.frame][i - 1].data;
    var lyo = S.doc.layers[i], lyu = S.doc.layers[i - 1];
    for (var k = 0; k < over.length; k++) {
      var s = over[k];
      if (s === 0) continue;
      var sa = ((s >>> 24) & 0xff) / 255 * clamp(lyo.opacity, 0, 255) / 255;
      if (sa === 0) continue;
      var sr = s & 0xff, sg = (s >> 8) & 0xff, sb = (s >> 16) & 0xff;
      var d = under[k], da = (d >>> 24) & 0xff;
      if (da === 0) { under[k] = pack(sr, sg, sb, Math.round(sa * 255)); continue; }
      var m = blendRGB(lyo.blend || "normal", d & 0xff, (d >> 8) & 0xff, (d >> 16) & 0xff, sr, sg, sb);
      var outA = sa + da / 255 * (1 - sa), oa = outA || 1;
      under[k] = pack(
        Math.round((m[0] * sa + (d & 0xff) * (da / 255) * (1 - sa)) / oa),
        Math.round((m[1] * sa + ((d >> 8) & 0xff) * (da / 255) * (1 - sa)) / oa),
        Math.round((m[2] * sa + ((d >> 16) & 0xff) * (da / 255) * (1 - sa)) / oa),
        Math.round(outA * 255));
    }
    /* The result keeps the lower layer's blend mode + opacity. */
    lyu.blend = "normal";
    for (var f = 0; f < S.doc.frames.length; f++) S.doc.frames[f].splice(i, 1);
    S.doc.layers.splice(i, 1);
    S.layer = i - 1;
    renderAll();
  }

  /* Aseprite "Layer Properties" dialog: name, mode, opacity. */
  function layerProperties() {
    var ly = currentLayer();
    var name = prompt("Layer name", ly.name || "Layer");
    if (name === null) return;
    var ly2 = S.doc.layers[S.layer];
    pushHistory();
    ly2.name = name || ly2.name;
    var blendSel = document.getElementById("pixel-layer-blend");
    if (blendSel) ly2.blend = blendSel.value;
    var opIn = document.getElementById("pixel-layer-opacity");
    if (opIn) ly2.opacity = clamp(+opIn.value | 0, 0, 255);
    renderAll();
  }

  /* Shared context menu for the layers panel (Aseprite: right-click a layer). */
  function openLayerMenu(i, ev) {
    closeCtxMenu();
    S.layer = i;
    renderLayers();
    var m = el("div", "pixel-ctxmenu");
    m.id = "pixel-ctx";
    function item(label, fn, dis) {
      var b = el("button", "pixel-ctxitem" + (dis ? " is-dis" : ""), label);
      if (!dis) b.addEventListener("click", function () { closeCtxMenu(); fn(); });
      m.appendChild(b);
    }
    item("New Layer", addLayer);
    item("Duplicate Layer", dupLayer);
    item("Merge Down", mergeDown, S.layer <= 0);
    item("Remove Layer", function () { removeLayer(i); }, S.doc.layers.length <= 1);
    item("Properties", layerProperties);
    document.body.appendChild(m);
    m.style.left = Math.min(ev.clientX, window.innerWidth - 180) + "px";
    m.style.top = Math.min(ev.clientY, window.innerHeight - 170) + "px";
  }

  function closeCtxMenu() {
    var old = document.getElementById("pixel-ctx");
    if (old) old.remove();
  }

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
      var thumb = layerThumb(S.doc.frames[S.frame][i].data, "pixel-thumb", ly.name);
      var name = el("span", "pixel-layer-name", ly.name);
      name.title = ly.name;
      row.addEventListener("click", function () { S.layer = i; renderAll(); });
      row.addEventListener("contextmenu", function (ev) { ev.preventDefault(); ev.stopPropagation(); openLayerMenu(i, ev); });
      row.append(vis, thumb, name);
      box.appendChild(row);
    });
    /* active layer opacity + blend controls */
    var opIn = document.getElementById("pixel-layer-opacity");
    var blendSel = document.getElementById("pixel-layer-blend");
    var ly = currentLayer();
    if (opIn) opIn.value = ly.opacity;
    if (blendSel) {
      if (!blendSel.dataset.full) {
        blendSel.innerHTML = "";
        BLEND_MODES.forEach(function (m) {
          var opt = document.createElement("option");
          opt.value = m; opt.textContent = BLEND_LABELS[m];
          blendSel.appendChild(opt);
        });
        blendSel.dataset.full = "1";
      }
      blendSel.value = ly.blend || "normal";
    }
  }

  function addLayer() {
    var ly = { name: "Layer " + (S.doc.layers.length + 1), visible: true, opacity: 255, blend: "normal" };
    S.doc.layers.push(ly);
    for (var f = 0; f < S.doc.frames.length; f++) S.doc.frames[f].push({ data: blankLayer(S.doc.w, S.doc.h) });
    S.layer = S.doc.layers.length - 1;
    renderAll();
  }

  function dupLayer() {
    if (!S.doc.layers.length) return;
    var src = S.doc.layers[S.layer];
    var ly = { name: (src.name || "Layer") + " copy", visible: true, opacity: src.opacity, blend: src.blend };
    S.doc.layers.push(ly);
    for (var f = 0; f < S.doc.frames.length; f++) S.doc.frames[f].push({ data: new Uint32Array(S.doc.frames[f][S.layer].data) });
    S.layer = S.doc.layers.length - 1;
    renderAll();
  }

  /* ---------- frame / timeline panel ---------- */

  function renderFrameLabel() {
    var lb = document.getElementById("pixel-framecount");
    if (lb && S.doc) {
      var sum = (S.durations && S.durations.length === S.doc.frames.length) ? S.durations.reduce(function (a, d) { return a + d; }, 0) : 0;
      lb.textContent = (S.frame + 1) + " / " + S.doc.frames.length + (sum ? " \u00b7 " + Math.round(sum) + "ms" : "");
    }
  }

  /* Aseprite timeline: layer rows x frame columns, per-frame duration via
     double-click, tags (colored bars), onion-skin range marker, and the
     play/once/loop/pingpong + onion toggles on the left rail. */
  var TAG_COLORS = ["#ff4d4d", "#4dff4d", "#4d9bff", "#ffd24d", "#b04dff", "#4dffe0", "#ff9f4d", "#ff4dc4", "#a8ff4d", "#4dc3ff", "#ffe04d", "#8c8cff"];
  function ensureDurations() {
    while (S.durations.length < S.doc.frames.length) S.durations.push(1000 / S.fps);
    S.durations.length = S.doc.frames.length;
    /* frames removed by undo/redo: clamp tags, drop the fully clipped ones */
    var n = S.doc.frames.length;
    S.tags = S.tags.filter(function (t) { return t && t.to >= 0 && t.to >= t.from && t.from < n; });
    S.tags.forEach(function (t) { t.from = Math.max(0, t.from); t.to = Math.min(t.to, n - 1); });
  }
  function tagAt(f) {
    for (var t = 0; t < S.tags.length; t++) {
      var tg = S.tags[t];
      if (f >= tg.from && f <= tg.to) return tg;
      if (tg.from < 0 && f <= tg.to && f >= 0) return tg;
    }
    return null;
  }
  function openTagMenu(fi, ev) {
    closeCtxMenu();
    var m = el("div", "pixel-ctxmenu"); m.id = "pixel-ctx";
    var tg = tagAt(fi);
    function item(label, fn, dis) {
      var b = el("button", "pixel-ctxitem" + (dis ? " is-dis" : ""), label);
      if (!dis) b.addEventListener("click", function () { closeCtxMenu(); fn(); });
      m.appendChild(b);
    }
    item("New Tag", function () {
      var name = prompt("Tag name", "Tag " + (S.tags.length + 1));
      if (name === null) return;
      var fromS = prompt("From frame (1-" + S.doc.frames.length + ")", String(fi + 1));
      if (fromS === null) return;
      var toS = prompt("To frame (1-" + S.doc.frames.length + ")", String(fi + 1));
      if (toS === null) return;
      var a = clamp((parseInt(fromS, 10) || fi + 1) - 1, 0, S.doc.frames.length - 1);
      var b = clamp((parseInt(toS, 10) || fi + 1) - 1, 0, S.doc.frames.length - 1);
      S.tags.push({ name: name || "Tag", from: Math.min(a, b), to: Math.max(a, b), color: TAG_COLORS[S.tags.length % TAG_COLORS.length] });
      renderTimeline();
    });
    if (tg) {
      item("Edit Tag \"" + tg.name + "\"", function () {
        var name = prompt("Tag name", tg.name);
        if (name === null) return;
        tg.name = name || tg.name;
        renderTimeline();
      });
      item("Delete Tag \"" + tg.name + "\"", function () {
        S.tags.splice(S.tags.indexOf(tg), 1);
        renderTimeline();
      });
    }
    m.appendChild(el("div", "pixel-ctxsep", ""));
    item("New Frame", function () { addFrameAt(fi + 1); });
    item("Duplicate Frame", function () { dupFrameAt(fi); });
    item("Delete Frame", function () { removeFrameAt(fi); }, S.doc.frames.length <= 1);
    document.body.appendChild(m);
    m.style.left = Math.min(ev.clientX, window.innerWidth - 220) + "px";
    m.style.top = Math.min(ev.clientY, window.innerHeight - 180) + "px";
  }
  function renderTimeline() {
    var box = document.getElementById("pixel-timeline");
    if (!box) return;
    ensureDurations();
    box.innerHTML = "";
    var grid = el("div", "pixel-tl-grid");
    var tlarea = el("div", "pixel-tl-area");
    var rail = el("div", "pixel-tl-rail");
    grid.append(rail, tlarea);
    function railBtn(label, title, cls, fn) {
      var b = el("button", "pixel-tl-railbtn" + (cls ? " " + cls : ""), label);
      b.title = title;
      b.addEventListener("click", fn);
      rail.appendChild(b);
      return b;
    }
    railBtn("▶", "Play (Enter)", S.playing ? "is-on" : "", function () { if (S.playing) { S.stopPlay(); } else if (S.startPlay) { S.startPlay(); } var cb = document.getElementById("pixel-animate"); if (cb) cb.checked = S.playing; renderTimeline(); });
    railBtn("→", "Play once", S.playMode === "once" ? "is-on" : "", function () { S.playMode = "once"; renderTimeline(); });
    railBtn("⟳", "Loop", S.playMode === "loop" ? "is-on" : "", function () { S.playMode = "loop"; renderTimeline(); });
    railBtn("⇄", "Ping-pong", S.playMode === "pingpong" ? "is-on" : "", function () { S.playMode = "pingpong"; renderTimeline(); });
    railBtn("◐", "Onion skin", S.onion ? "is-on" : "", function () { S.onion = !S.onion; var cb = document.getElementById("pixel-onion"); if (cb) cb.checked = S.onion; renderAll(); });
    /* tags row: bars absolutely positioned over the frame columns
       (68px layer-name gutter + 66px per column, matching the header) */
    var CELL_W = 66;
    var tagrow = el("div", "pixel-tl-tagrow");
    S.tags.forEach(function (tg) {
      var bar = el("div", "pixel-tl-tag", tg.name);
      bar.style.left = (68 + tg.from * CELL_W) + "px";
      bar.style.minWidth = ((tg.to - tg.from + 1) * CELL_W - 2) + "px";
      bar.style.background = tg.color;
      bar.title = tg.name + " (frames " + (tg.from + 1) + "-" + (tg.to + 1) + ")";
      bar.addEventListener("contextmenu", function (ev) { ev.preventDefault(); ev.stopPropagation(); openTagMenu(tg.to, ev); });
      tagrow.appendChild(bar);
    });
    /* header row: frame numbers + durations */
    var hdr = el("div", "pixel-tl-hdr");
    hdr.appendChild(el("div", "pixel-tl-corner", ""));
    S.doc.frames.forEach(function (_, i) {
      var c = el("div", "pixel-tl-fnum" + (i === S.frame ? " is-active" : ""), String(i + 1));
      c.title = "Frame " + (i + 1) + " - double-click to set duration (ms), right-click for tags";
      c.addEventListener("click", function () { S.frame = i; renderAll(); });
      c.addEventListener("dblclick", function (ev) {
        ev.stopPropagation();
        var ms = prompt("Frame duration (ms)", String(Math.round(S.durations[i])));
        if (ms === null) return;
        S.durations[i] = clamp(parseInt(ms, 10) || 100, 20, 65500);
        renderTimeline();
        renderFrameLabel();
      });
      c.addEventListener("contextmenu", function (ev) { ev.preventDefault(); ev.stopPropagation(); openTagMenu(i, ev); });
      hdr.appendChild(c);
    });
    tlarea.append(tagrow, hdr);
    /* layer rows x frame columns */
    S.doc.layers.forEach(function (ly, li) {
      var row = el("div", "pixel-tl-row");
      var rowHead = el("div", "pixel-tl-lname" + (li === S.layer ? " is-active" : ""));
      rowHead.textContent = ly.name;
      rowHead.title = ly.name + " - click to select layer";
      rowHead.addEventListener("click", function () { S.layer = li; renderAll(); });
      rowHead.addEventListener("contextmenu", function (ev) { ev.preventDefault(); ev.stopPropagation(); openLayerMenu(li, ev); });
      row.appendChild(rowHead);
      S.doc.frames.forEach(function (_, fi) {
        var cellEl = el("div", "pixel-tl-cell" + (fi === S.frame && li === S.layer ? " is-active" : (fi === S.frame ? " is-curframe" : "")));
        if (S.onion) {
          var dp = S.frame - fi;
          if (dp > 0 && dp <= S.onionPrev) cellEl.classList.add("is-onion-prev");
          var dn = fi - S.frame;
          if (dn > 0 && dn <= S.onionNext) cellEl.classList.add("is-onion-next");
        }
        cellEl.appendChild(layerThumb(S.doc.frames[fi][li].data, "pixel-tl-thumb"));
        cellEl.title = ly.name + " - frame " + (fi + 1);
        cellEl.addEventListener("click", function () { S.layer = li; S.frame = fi; renderAll(); });
        cellEl.addEventListener("contextmenu", function (ev) { ev.preventDefault(); ev.stopPropagation(); openLayerMenu(li, ev); });
        row.appendChild(cellEl);
      });
      tlarea.appendChild(row);
    });
    box.appendChild(grid);
  }

  function addFrame() {
    addFrameAt(S.frame + 1);
  }

  function addFrameAt(at) {
    var fr = blankFrame(S.doc.layers, S.doc.w, S.doc.h);
    S.doc.frames.splice(at, 0, fr);
    if (S.durations) S.durations.splice(at, 0, 1000 / S.fps);
    S.frame = at;
    renderAll();
  }

  function dupFrame() {
    dupFrameAt(S.frame);
  }

  function dupFrameAt(fi) {
    var fr = [];
    for (var l = 0; l < S.doc.frames[fi].length; l++) fr.push({ data: new Uint32Array(S.doc.frames[fi][l].data) });
    S.doc.frames.splice(fi + 1, 0, fr);
    if (S.durations) S.durations.splice(fi + 1, 0, S.durations[fi] || 1000 / S.fps);
    /* tags spanning the copied frame grow with it */
    S.tags.forEach(function (tg) { if (tg.to >= fi + 1) tg.to++; if (tg.from >= fi + 1) tg.from++; });
    S.frame = fi + 1;
    renderAll();
  }

  function removeFrameAt(fi) {
    if (S.doc.frames.length <= 1) return;
    S.doc.frames.splice(fi, 1);
    if (S.durations) S.durations.splice(fi, 1);
    S.tags = S.tags.filter(function (tg) {
      if (tg.to < fi) return true;
      if (tg.from > fi) { tg.from--; tg.to--; return true; }
      tg.from = Math.min(tg.from, fi - 1 < 0 ? 0 : fi - 1);
      tg.to = Math.max(tg.from, tg.to - 1);
      return tg.to >= tg.from;
    });
    if (S.frame >= S.doc.frames.length) S.frame = S.doc.frames.length - 1;
    renderAll();
  }

  /* ---------- preview / export ---------- */

  function renderPreview() {
    var pv = document.getElementById("pixel-preview");
    if (!pv || !S.doc) return;
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

  function compositeToCanvas(buf, w, h) {
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var ctx = c.getContext("2d");
    var img = ctx.createImageData(w, h);
    for (var k = 0; k < buf.length; k++) {
      var px = buf[k]; var o = k * 4;
      img.data[o] = px & 0xff; img.data[o + 1] = (px >> 8) & 0xff; img.data[o + 2] = (px >> 16) & 0xff; img.data[o + 3] = (px >>> 24) & 0xff;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function exportPng() {
    var c = compositeToCanvas(composite(S.doc, S.frame), S.doc.w, S.doc.h);
    var a = el("a");
    a.href = c.toDataURL("image/png");
    a.download = "chalkle-art.png";
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* Sprite sheet export: every frame in one row (Aseprite's default sheet). */
  function exportSheet() {
    var w = S.doc.w, h = S.doc.h;
    var c = document.createElement("canvas");
    c.width = w * S.doc.frames.length; c.height = h;
    var ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    for (var f = 0; f < S.doc.frames.length; f++) {
      var fc = compositeToCanvas(composite(S.doc, f), w, h);
      ctx.drawImage(fc, f * w, 0);
    }
    var a = el("a");
    a.href = c.toDataURL("image/png");
    a.download = "chalkle-sheet.png";
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* Small Aseprite-style shortcuts reference (Help menu). */
  function showShortcuts() {
    var old = document.getElementById("pixel-shortcuts");
    if (old) old.remove();
    var ov = el("div", "pixel-newdims"); ov.id = "pixel-shortcuts";
    var card = el("div", "pixel-newdims-card pixel-shortcuts-card");
    card.appendChild(el("h3", "pixel-panel-title", "Keyboard Shortcuts"));
    var rows = [
      ["B", "Pencil"], ["E", "Eraser"], ["G", "Paint Bucket"], ["Shift+G", "Gradient"],
      ["I", "Eyedropper"], ["M", "Rectangular Marquee"], ["L", "Lasso"], ["W", "Magic Wand"],
      ["U", "Rectangle"], ["Shift+U", "Ellipse"], ["N", "Line"], ["H", "Hand"], ["Z", "Zoom"], ["V", "Move"],
      ["X", "Swap colors"], ["[ / ]", "Smaller / larger brush"], ["Space+drag", "Pan"],
      ["1-9, 0", "Layer opacity 10%..90%, 100%"],
      ["Enter", "Play animation"], ["Ctrl+Z / Ctrl+Y", "Undo / Redo"],
      ["Ctrl+C / X / V", "Copy / Cut / Paste"], ["Ctrl+D", "Deselect"], ["Ctrl+A", "Select All"]
    ];
    rows.forEach(function (r) {
      var row = el("div", "pixel-sc-row");
      row.appendChild(el("span", "pixel-sc-key", r[0]));
      row.appendChild(el("span", "pixel-sc-lbl", r[1]));
      card.appendChild(row);
    });
    var close = el("button", "pixel-btn accent", "Close");
    close.addEventListener("click", function () { ov.remove(); });
    card.appendChild(close);
    ov.appendChild(card);
    document.body.appendChild(ov);
  }

  function exportGif() {
    var frames = [];
    var useDurs = framesHavePerMs();
    for (var f = 0; f < S.doc.frames.length; f++) frames.push(composite(S.doc, f));
    var gif = encodeGIF(frames, S.doc.w, S.doc.h, S.fps, useDurs ? S.durations.map(function (d) { return Math.max(20, d | 0); }) : null);
    var blob = new Blob([gif], { type: "image/gif" });
    var url = URL.createObjectURL(blob);
    var a = el("a"); a.href = url; a.download = "chalkle-anim.gif";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function framesHavePerMs() {
    if (!S.durations || S.durations.length !== S.doc.frames.length) return false;
    for (var i = 0; i < S.durations.length; i++) if (S.durations[i] !== 1000 / S.fps) return true;
    return false;
  }

  /* GIF encoder: 256-color global palette from all frames, LZW.
     dursMs optionally gives a per-frame delay in ms (Aseprite per-frame timing). */
  function encodeGIF(framesRaw, w, h, fps, dursMs) {
    var n = w * h;
    var colorCount = {};
    for (var f = 0; f < framesRaw.length; f++) {
      for (var i = 0; i < n; i++) {
        var px = framesRaw[f][i] >>> 0;
        if (!colorCount[px]) colorCount[px] = 0;
        colorCount[px]++;
      }
    }
    var keys = Object.keys(colorCount).map(function (k) { return +k; });
    keys.sort(function (a, b) { return colorCount[b] - colorCount[a]; });
    var palette = keys.slice(0, 256);
    var map = {};
    palette.forEach(function (k, idx) { map[k] = idx; });
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

    w8(0x47); w8(0x49); w8(0x46); w8(0x38); w8(0x39); w8(0x61);
    w16(w); w16(h);
    bytes.push(0xF7); bytes.push(0x00); bytes.push(0x00);
    for (var p = 0; p < 256; p++) {
      var col = palette[p] !== undefined ? palette[p] : 0;
      bytes.push(col & 0xff, (col >> 8) & 0xff, (col >> 16) & 0xff);
    }
    bytes.push(0x21, 0xFF, 0x0B); bytes.push(0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30); bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);
    var delay = Math.max(1, Math.round(100 / fps));
    for (var fr = 0; fr < framesRaw.length; fr++) {
      var fdelay = dursMs && dursMs[fr] ? Math.max(2, Math.round(dursMs[fr] / 10)) : delay;
      bytes.push(0x21, 0xF9, 0x04, 0x00); w16(fdelay); bytes.push(0x00, 0x00);
      bytes.push(0x2C); w16(0); w16(0); w16(w); w16(h);
      bytes.push(0x00);
      var data = framesRaw[fr];
      var idxData = new Uint8Array(n);
      for (var k = 0; k < n; k++) idxData[k] = idxOf(data[k]);
      var lzw = lzwEncode(idxData, w);
      bytes.push(8);
      for (var s = 0; s < lzw.length; s += 255) {
        var chunk = lzw.subarray(s, s + 255);
        bytes.push(chunk.length);
        for (var b = 0; b < chunk.length; b++) bytes.push(chunk[b]);
      }
      bytes.push(0x00);
    }
    bytes.push(0x3B);
    return new Uint8Array(bytes);
  }

  function lzwEncode(data, w) {
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
    for (var i = 1; i < data.length; i++) {
      var cur = data[i];
      var key = prev * 4096 + cur;
      if (!dict.has(key)) {
        emit(prev, codeSize);
        dict.set(key, dictSize++);
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
        var tmp = document.createElement("canvas");
        tmp.width = tw; tmp.height = th;
        var ctx = tmp.getContext("2d");
        ctx.drawImage(img, 0, 0, tw, th);
        var imgData = ctx.getImageData(0, 0, tw, th).data;
        var layer = S.doc.frames[0][0];
        for (var y = 0; y < th; y++) {
          for (var x = 0; x < tw; x++) {
            var o = (y * tw + x) * 4;
            layer.data[y * tw + x] = (imgData[o + 3] << 24) | (imgData[o + 2] << 16) | (imgData[o + 1] << 8) | imgData[o];
          }
        }
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
    var oldLayers = S.doc.layers.length ? S.doc.layers.map(function (l, i) { return { name: l.name, visible: true, opacity: 255, blend: "normal" }; }) : [{ name: "Layer 1", visible: true, opacity: 255, blend: "normal" }];
    S.doc.layers = oldLayers;
    S.doc.frames = [blankFrame(oldLayers, w, h)];
    S.sel = null;
    /* a resized canvas starts a fresh timeline */
    S.durations = [1000 / S.fps];
    S.tags = [];
    renderAll();
  }

  /* ---------- zoom / pan ---------- */

  function setZoom(z) { S.zoom = Math.max(1, Math.min(32, z)); syncZoomUI(); renderAll(); }
  function zoomIn() { setZoom(S.zoom + 1); }
  function zoomOut() { setZoom(S.zoom - 1); }

  /* ---------- build UI ---------- */

  var inited = false;

  function init() {
    var app = document.getElementById("pixel-app");
    if (!app) return;

    /* Toolbar: Aseprite's layout: a vertical icon strip on the left, with
       the tool set ordered like the real app and monochrome line-art icons
       (drawn to mirror Aseprite's tool glyphs) instead of emoji. */
    /* Aseprite's native tool order. Each entry: id, label, icon name, tooltip.
       Marquee/Lasso/Rect/Ellipse carry two variants (outline/fill); right-click
       cycles between them like Aseprite's tool modifier. Zoom tool: click =
       zoom in, right-click / Shift-click = zoom out. */
    var TOOL_DEFS = [
      ["marquee", "Rectangular Marquee", "marquee", "Rectangular Marquee (M)"],
      ["lasso", "Lasso", "lasso", "Lasso (L)"],
      ["wand", "Magic Wand", "wand", "Magic Wand (W)"],
      ["pencil", "Pencil", "pencil", "Pencil (B)"],
      ["spray", "Spray", "spray", "Spray (Shift+B)"],
      ["eraser", "Eraser", "eraser", "Eraser (E)"],
      ["pick", "Eyedropper", "pick", "Eyedropper (I)"],
      ["bucket", "Paint Bucket", "bucket", "Paint Bucket (G)"],
      ["gradient", "Gradient", "gradient", "Gradient (Shift+G)"],
      ["line", "Line", "line", "Line (N)"],
      ["curve", "Curve", "curve", "Curve"],
      ["rect", "Rectangle", "rect", "Rectangle (U) - right-click for fill variant"],
      ["frect", "Filled Rectangle", "frect", "Filled Rectangle (Shift+U)"],
      ["ellipse", "Ellipse", "ellipse", "Ellipse (Shift+U) - right-click for fill variant"],
      ["fellipse", "Filled Ellipse", "fellipse", "Filled Ellipse (Ctrl+U)"],
      ["blur", "Blur", "blur", "Blur (R)"],
      ["sharpen", "Sharpen", "sharpen", "Sharpen"],
      ["jumble", "Jumble", "jumble", "Jumble"],
      ["move", "Move", "move", "Move (V)"],
      ["zoom", "Zoom", "zoom", "Zoom (Z) - click: in, right-click: out"],
      ["hand", "Hand", "hand", "Hand (H)"],
      ["slice", "Slice", "slice", "Slice"]
    ];
    /* right-click on these toggles the outline/fill sibling */
    var VARIANT_GROUPS = [
      ["rect", "frect"],
      ["ellipse", "fellipse"]
    ];
    var ICONS = {
      marquee: '<path d="M3 5v14M21 5v14M3 5h2M7 5h10M19 5h2M3 19h2M7 19h10M19 19h2M3 7v10M21 7v10"/>',
      lasso: '<path d="M12 4c5 0 9 2.2 9 5.5 0 2.6-2.6 4.6-6 5.3M12 4C7 4 3 6.2 3 9.5c0 2.5 2.2 4.4 5.2 5.1M8.2 14.6c-1.4.5-2.2 1.3-2.2 2.4 0 1.7 2.7 3 6 3s6-1.3 6-3c0-.8-.7-1.6-1.8-2.1"/><circle cx="12" cy="20" r="1.6"/>',
      wand: '<path d="M4 20 15 9"/><path d="m9 12-4-4 7-7 4 4z"/><path d="m19 5 .8 1.7L21.5 7.5l-1.7.8L19 10l-.8-1.7-1.7-.8 1.7-.8z"/><path d="m15 11 .5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5z"/><path d="m20 11 .5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5z"/>',
      pencil: '<path d="M4 20l8-9 4 4-9 9H4z"/><path d="M12 11l3-3c1-1 3-3 4-2s0 3-1 4l-3 3"/><path d="M17 4l3 3"/>',
      spray: '<path d="M9 21V8h6v13z"/><path d="M9 8V5h4v3"/><path d="M17 4h.01M20 6h.01M17 8h.01M20 10h.01M17 12h.01M20 14h.01"/><path d="M4 4h.01M4 8h.01M4 12h.01"/>',
      eraser: '<path d="M13 4l7 7-8 8-7-7z"/><path d="M5 21h7"/><rect x="7" y="14" width="4" height="4" fill="currentColor" stroke="none"/>',
      pick: '<path d="m8 2 4 4-6 6-4-4z"/><path d="M18 14a4 4 0 0 1-4 4"/><path d="M10 8l8 8-4 4-8-8"/><path d="m6 16-3 6 6-3"/>',
      bucket: '<path d="M7 4l13 8-5 9H9L4 12l6-4"/><path d="M4 12l5-3"/><path d="M13 6l1.5-1.5a2 2 0 0 1 3 2.6L13 11"/><path d="M9 20l-2 1M13 20l2 1M7 18l2 1"/>',
      gradient: '<path d="M4 20h16"/><path d="M4 20 20 4"/><path d="M8 20h.01M11 17h.01M14 14h.01M17 11h.01"/>',
      line: '<path d="M4 20 18 5"/><rect x="2" y="19" width="4" height="4" ry="1" fill="currentColor" stroke="none"/><rect x="17" y="3" width="4" height="4" ry="1" fill="currentColor" stroke="none"/>',
      curve: '<path d="M4 18C7 6 17 6 20 18"/>',
      rect: '<rect x="3" y="5" width="18" height="14" ry="1"/>',
      frect: '<rect x="3" y="5" width="18" height="14" ry="1" fill="currentColor" stroke="none"/>',
      ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
      fellipse: '<ellipse cx="12" cy="12" rx="9" ry="7" fill="currentColor" stroke="none"/>',
      blur: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
      sharpen: '<path d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
      jumble: '<path d="M5 5h4v4H5zM15 5h4v4h-4zM10 10h4v4h-4zM5 15h4v4H5zM15 15h4v4h-4z"/>',
      move: '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
      zoom: '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 21 21"/><path d="M8 11h6M11 8v6"/>',
      hand: '<path d="M7 11V6a1.5 1.5 0 0 1 3 0v4M10 9V5a1.5 1.5 0 0 1 3 0v5M13 10V6a1.5 1.5 0 0 1 3 0v5"/><path d="M16 8a1.5 1.5 0 0 1 3 0v6c0 4-3 7-7 7h-2c-2.5 0-4-1-5-3L3 14c-.7-1 0-2.5 1-2.5S5 12 6 13v-5"/>',
      slice: '<path d="M4 3v18h16"/><path d="M8 3v18M14 3v18"/><path d="M4 8h16M4 14h16"/>'
    };
    function iconSvg(name, cls) {
      return '<svg class="' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>";
    }
    function cycleVariant(tool) {
      for (var g = 0; g < VARIANT_GROUPS.length; g++) {
        var idx = VARIANT_GROUPS[g].indexOf(tool);
        if (idx === -1) continue;
        var next = VARIANT_GROUPS[g][(idx + 1) % VARIANT_GROUPS[g].length];
        selectTool(next);
        return;
      }
    }
    function selectTool(id) {
      S.tool = id;
      Object.keys(toolBtns).forEach(function (k) { toolBtns[k].classList.toggle("is-active", k === id); });
      var vw = document.getElementById("pixel-view");
      if (vw) vw.dataset.tool = id; /* drives the per-tool cursor via CSS */
      updateStatus();
    }
    var toolbar = el("div", "pixel-toolbar");
    var toolBtns = {};
    TOOL_DEFS.forEach(function (t) {
      var b = el("button", "pixel-tool" + (S.tool === t[0] ? " is-active" : ""));
      b.innerHTML = iconSvg(t[2], "pixel-tool-ico");
      b.title = t[3];
      b.setAttribute("data-tool", t[0]);
      b.setAttribute("aria-label", t[1]);
      b.addEventListener("click", function () { selectTool(t[0]); });
      b.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (S.tool === "zoom") { setZoom(S.zoom - 1); return; }
        cycleVariant(t[0]);
      });
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
    var btnCut = el("button", "pixel-btn", "Cut");
    var btnCopy = el("button", "pixel-btn", "Copy");
    var btnPaste = el("button", "pixel-btn", "Paste");
    var btnDeselect = el("button", "pixel-btn", "Deselect");
    var btnZoomOut = el("button", "pixel-btn", "−");
    var btnZoomIn = el("button", "pixel-btn", "+");
    btnNew.addEventListener("click", function () { toggleNewDims(true); });
    btnUndo.addEventListener("click", undo);
    btnRedo.addEventListener("click", redoAction);
    btnCut.addEventListener("click", cutSel);
    btnCopy.addEventListener("click", copySel);
    btnPaste.addEventListener("click", pasteClip);
    btnDeselect.addEventListener("click", function () { if (S.doc) { clearSel(); } });
    btnZoomOut.addEventListener("click", zoomOut);
    btnZoomIn.addEventListener("click", zoomIn);

    var brushLbl = el("span", "", ""); brushLbl.id = "pixel-brush-label";
    brushLbl.title = "Brush size - [ and ] resize it";
    toprow.appendChild(brushLbl);

    var colorPanel = el("div", "pixel-panel");
    var ct = el("h3", "pixel-panel-title", "Colors");
    var swRow = el("div", "pixel-row");
    var swatch = el("span", "pixel-swatch", ""); swatch.id = "pixel-swatch";
    var hexIn = el("input", "pixel-hex"); hexIn.id = "pixel-hex"; hexIn.spellcheck = false;
    hexIn.addEventListener("change", function () { setColorFromHex(hexIn.value); });
    var colPick = el("input"); colPick.type = "color"; colPick.id = "pixel-color"; colPick.className = "pixel-colpick";
    swRow.append(swatch, hexIn);
    var altRow = el("div", "pixel-row");
    var altLbl = el("span", "pixel-mini-lbl", "R-Click:");
    var altSwatch = el("span", "pixel-swatch alt", ""); altSwatch.id = "pixel-swatch-alt";
    var swapBtn = el("button", "pixel-mini", "⇄ Swap (X)");
    swapBtn.addEventListener("click", swapColors);
    altRow.append(altLbl, altSwatch, swapBtn);
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

    /* Palette: Aseprite's indexed swatch grid (DB32 by default).
       Click = foreground, right-click = background, double-click = edit the
       entry, drag = reorder. Drag-and-drop keeps everything editable. */
    var paletteRow = el("div", "pixel-palette");
    S.palette = DB32.slice();
    var dragging = -1;
    function renderPalette() {
      paletteRow.innerHTML = "";
      S.palette.forEach(function (hex, idx) {
        var sw = el("button", "pixel-palette-swatch", "");
        sw.style.background = hex;
        sw.title = hex + " (click: fg, right-click: bg, double-click: edit, drag: reorder)";
        sw.draggable = true;
        sw.addEventListener("click", function () { setColorFromHex(hex); });
        sw.addEventListener("contextmenu", function (e) { e.preventDefault(); setColorFromHexBg(hex); });
        sw.addEventListener("dblclick", function () {
          var pick = document.getElementById("pixel-color");
          if (pick) { pick.value = normHex(hex); pick.click(); }
          var done = function (ev) {
            var after = document.getElementById("pixel-color");
            if (after) S.palette[idx] = normHex(after.value);
            renderPalette();
            setTimeout(function () {
              document.removeEventListener("change", done, true);
              document.removeEventListener("input", done, true);
            }, 300);
          };
          setTimeout(function () {
            document.addEventListener("change", done, true);
            document.addEventListener("input", done, true);
          }, 50);
        });
        sw.addEventListener("dragstart", function () { dragging = idx; });
        sw.addEventListener("dragover", function (e) { e.preventDefault(); });
        sw.addEventListener("drop", function (e) {
          e.preventDefault();
          if (dragging < 0 || dragging === idx) return;
          var moved = S.palette.splice(dragging, 1)[0];
          S.palette.splice(idx, 0, moved);
          dragging = -1;
          renderPalette();
        });
        paletteRow.appendChild(sw);
      });
    }
    renderPalette();
    colorPanel.appendChild(paletteRow);

    /* Tint/Shade/Tone slider + Aseprite's ramp preview */
    var tstRow = el("div", "pixel-row");
    tstRow.appendChild(el("span", "pixel-mini-lbl", "T/S"));
    var tstIn = el("input"); tstIn.type = "range"; tstIn.id = "pixel-tst"; tstIn.min = -100; tstIn.max = 100; tstIn.value = 0;
    var tstVal = el("span", "pixel-mini-lbl", "0"); tstVal.id = "pixel-tst-val";
    tstIn.addEventListener("mousedown", function () {
      if (!S.toolOpt.tstBase) S.toolOpt.tstBase = { r: S.color.r, g: S.color.g, b: S.color.b };
    });
    tstIn.addEventListener("touchstart", function () {
      if (!S.toolOpt.tstBase) S.toolOpt.tstBase = { r: S.color.r, g: S.color.g, b: S.color.b };
    });
    tstIn.addEventListener("input", function () {
      applyTST(+tstIn.value);
      tstVal.textContent = tstIn.value;
    });
    tstIn.addEventListener("change", function () { S.toolOpt.tstBase = null; });
    tstRow.append(tstIn, tstVal);
    colorPanel.appendChild(tstRow);
    rampGrid = el("div", "pixel-ramp");
    colorPanel.appendChild(rampGrid);

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
    var ppCb = mkToggle("Pixel-perfect", "pixel-pp");
    var symHCb = mkToggle("Sym H", "pixel-symh");
    var symVCb = mkToggle("Sym V", "pixel-symv");
    var playCb = mkToggle("Animate", "pixel-animate");
    gridCb.addEventListener("change", function () { S.grid = gridCb.checked; renderAll(); });
    onionCb.addEventListener("change", function () { S.onion = onionCb.checked; renderAll(); });
    ppCb.addEventListener("change", function () { S.pixelPerfect = ppCb.checked; });
    symHCb.addEventListener("change", function () { S.symH = symHCb.checked; });
    symVCb.addEventListener("change", function () { S.symV = symVCb.checked; });
    playCb.addEventListener("change", function () { if (playCb.checked) startPlay(); else stopPlay(); });

    var tolRow = el("div", "pixel-row");
    tolRow.appendChild(el("span", "pixel-mini-lbl", "Tolerance"));
    var tolIn = el("input"); tolIn.type = "range"; tolIn.id = "pixel-tol"; tolIn.min = 0; tolIn.max = 100; tolIn.value = 0;
    var tolVal = el("span", "pixel-mini-lbl", "0"); tolVal.id = "pixel-tol-val";
    tolIn.addEventListener("input", function () { S.toolOpt.tolerance = +tolIn.value; tolVal.textContent = tolIn.value; });
    tolRow.append(tolIn, tolVal);

    var onionRow = el("div", "pixel-row");
    onionRow.appendChild(el("span", "pixel-mini-lbl", "Onion"));
    var onionPrevIn = el("input"); onionPrevIn.type = "number"; onionPrevIn.id = "pixel-onion-prev"; onionPrevIn.min = 0; onionPrevIn.max = 5; onionPrevIn.value = 1; onionPrevIn.style.width = "42px";
    var onionNextIn = el("input"); onionNextIn.type = "number"; onionNextIn.id = "pixel-onion-next"; onionNextIn.min = 0; onionNextIn.max = 5; onionNextIn.value = 1; onionNextIn.style.width = "42px";
    onionPrevIn.addEventListener("input", function () { S.onionPrev = Math.max(0, +onionPrevIn.value || 0); renderAll(); });
    onionNextIn.addEventListener("input", function () { S.onionNext = Math.max(0, +onionNextIn.value || 0); renderAll(); });
    onionRow.append(onionPrevIn, onionNextIn);

    var fpsRow = el("div", "pixel-row");
    fpsRow.appendChild(el("span", "pixel-mini-lbl", "FPS"));
    var fpsIn = el("input"); fpsIn.type = "range"; fpsIn.id = "pixel-fps"; fpsIn.min = 1; fpsIn.max = 24;
    fpsIn.value = S.fps;
    var fpsVal = el("span", "pixel-mini-lbl", S.fps + " fps"); fpsVal.id = "pixel-fps-val";
    fpsIn.addEventListener("input", function () { S.fps = +fpsIn.value; fpsVal.textContent = S.fps + " fps"; });
    fpsRow.append(fpsIn, fpsVal);

    optsPanel.append(ottl, gridCb, onionCb, ppCb, symHCb, symVCb, tolRow, onionRow, fpsRow, playCb);

    /* Snap-to-grid guides (works alongside pixel-perfect, like Aseprite) */
    var snapRow = el("div", "pixel-row");
    snapRow.appendChild(el("span", "pixel-mini-lbl", "Snap"));
    var snapCb = el("input"); snapCb.type = "checkbox"; snapCb.id = "pixel-snap";
    var snapSizeIn = el("input"); snapSizeIn.type = "number"; snapSizeIn.id = "pixel-snap-size"; snapSizeIn.min = 1; snapSizeIn.max = 64; snapSizeIn.value = S.gridSize; snapSizeIn.style.width = "42px";
    snapCb.addEventListener("change", function () { S.snap = snapCb.checked; });
    snapSizeIn.addEventListener("input", function () { S.gridSize = clamp(parseInt(snapSizeIn.value, 10) || 1, 1, 64); });
    snapRow.append(snapCb, snapSizeIn);
    optsPanel.appendChild(snapRow);

    /* Layers panel */
    var layersPanel = el("div", "pixel-panel pixel-layers-panel");
    var layersHead = el("div", "pixel-panel-title-row");
    layersHead.appendChild(el("h3", "pixel-panel-title", "Layers"));
    var btnAddLayer = el("button", "pixel-mini", "+"); btnAddLayer.title = "New layer";
    var btnDupLayer = el("button", "pixel-mini", "⧉"); btnDupLayer.title = "Duplicate layer";
    var btnUpLayer = el("button", "pixel-mini", "↑"); btnUpLayer.title = "Move layer up";
    var btnDnLayer = el("button", "pixel-mini", "↓"); btnDnLayer.title = "Move layer down";
    var btnMerge = el("button", "pixel-mini", "⤓"); btnMerge.title = "Merge down";
    var btnDelLayer = el("button", "pixel-mini", "✕"); btnDelLayer.title = "Remove layer";
    layersHead.append(btnAddLayer, btnDupLayer, btnUpLayer, btnDnLayer, btnMerge, btnDelLayer);
    btnAddLayer.addEventListener("click", addLayer);
    btnDupLayer.addEventListener("click", dupLayer);
    btnUpLayer.addEventListener("click", function () { moveLayer(-1); });
    btnDnLayer.addEventListener("click", function () { moveLayer(1); });
    btnMerge.addEventListener("click", mergeDown);
    btnDelLayer.addEventListener("click", function () { removeLayer(S.layer); });
    var layersBox = el("div", "pixel-layers"); layersBox.id = "pixel-layers";
    /* layer opacity + blend */
    var lbRow = el("div", "pixel-row");
    lbRow.appendChild(el("span", "pixel-mini-lbl", "Op"));
    var opIn = el("input"); opIn.type = "range"; opIn.id = "pixel-layer-opacity"; opIn.min = 0; opIn.max = 255; opIn.value = 255;
    opIn.addEventListener("input", function () { if (S.doc) { currentLayer().opacity = +opIn.value; renderAll(); } });
    lbRow.appendChild(opIn);
    var blendSel = el("select"); blendSel.id = "pixel-layer-blend"; blendSel.className = "pixel-blend";
    BLEND_MODES.forEach(function (m) {
      var o = el("option", "", BLEND_LABELS[m]);
      o.value = m;
      blendSel.appendChild(o);
    });
    blendSel.addEventListener("change", function () { if (S.doc) { currentLayer().blend = blendSel.value; renderAll(); } });
    lbRow.appendChild(blendSel);
    layersPanel.append(layersHead, layersBox, lbRow);

    /* Timeline */
    var tlPanel = el("div", "pixel-timeline-panel");
    var tlHead = el("div", "pixel-panel-title-row");
    var tlTitle = el("h3", "pixel-panel-title", "Timeline");
    tlHead.appendChild(tlTitle);
    var frameLabel = el("span", "pixel-mini-lbl", "1 / 1"); frameLabel.id = "pixel-framecount";
    tlHead.appendChild(frameLabel);
    var tlBtnAdd = el("button", "pixel-mini", "+"); tlBtnAdd.title = "New frame";
    var tlBtnDup = el("button", "pixel-mini", "⧉"); tlBtnDup.title = "Duplicate frame";
    var tlBtnDel = el("button", "pixel-mini", "✕"); tlBtnDel.title = "Delete frame";
    tlHead.append(tlBtnAdd, tlBtnDup, tlBtnDel);
    tlBtnAdd.addEventListener("click", addFrame);
    tlBtnDup.addEventListener("click", dupFrame);
    tlBtnDel.addEventListener("click", function () { removeFrameAt(S.frame); });
    var tlRow = el("div", "pixel-timeline"); tlRow.id = "pixel-timeline";
    tlPanel.append(tlHead, tlRow);

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

    /* Status bar: cursor coords, functioning zoom (click to type an exact %),
       canvas size, tool name, snap controls - Aseprite's bottom strip. */
    var status = el("div", "pixel-status");
    var posLbl = el("span", "", "-"); posLbl.id = "pixel-pos";
    var zoomWrap = el("span", "pixel-zoomwrap"); zoomWrap.id = "pixel-zoomwrap";
    var zoomPct = el("span", "pixel-zoom-pct", "600%"); zoomPct.id = "pixel-zoom-pct";
    zoomWrap.title = "Click to type an exact zoom percent";
    zoomWrap.addEventListener("click", function () {
      var cur = Math.round(S.zoom * 100);
      var raw = window.prompt("Zoom percent", String(cur));
      if (raw === null) return;
      var v = parseInt(raw, 10);
      if (!v || v < 1) v = 1;
      setZoom(clamp(Math.round(v / 100), 1, 32));
    });
    var zoomLbl = el("span", "", ""); zoomLbl.id = "pixel-zoom";
    var canLbl = el("span", "", ""); canLbl.id = "pixel-canvas-label";
    var toolLbl = el("span", "", ""); toolLbl.id = "pixel-tool-label";
    status.append(posLbl, zoomWrap, zoomPct, zoomLbl, canLbl, toolLbl);

    /* Canvas viewport: the canvas stack lives in a fixed-size box so the
       rulers can hug its edges and scroll together with it. */
    var viewWrap = el("div", "pixel-view"); viewWrap.id = "pixel-view";
    var canvasEl = document.createElement("canvas");
    canvasEl.id = "pixel-canvas"; canvasEl.className = "pixel-canvas";
    var gridCanvas = document.createElement("canvas");
    gridCanvas.id = "pixel-grid-canvas"; gridCanvas.className = "pixel-grid";
    var selCanvas = document.createElement("canvas");
    selCanvas.id = "pixel-sel-canvas"; selCanvas.className = "pixel-grid";
    var canvasBox = el("div", "pixel-canvasbox"); canvasBox.id = "pixel-canvasbox";
    canvasBox.append(gridCanvas, selCanvas, canvasEl);
    var rulerTop = document.createElement("canvas");
    rulerTop.id = "pixel-ruler-top"; rulerTop.className = "pixel-ruler pixel-ruler-top";
    var rulerLeft = document.createElement("canvas");
    rulerLeft.id = "pixel-ruler-left"; rulerLeft.className = "pixel-ruler pixel-ruler-left";
    canvasBox.append(rulerTop, rulerLeft);
    viewWrap.appendChild(canvasBox);

    /* Right side: preview */
    var rightCol = el("div", "pixel-right");
    rightCol.appendChild(el("h3", "pixel-panel-title", "Preview"));
    var previewCanvas = document.createElement("canvas");
    previewCanvas.id = "pixel-preview"; previewCanvas.className = "pixel-preview";
    var pvHint = el("p", "pixel-preview-hint", "Nearest-neighbor preview of the current frame");
    rightCol.append(previewCanvas, pvHint);

    /* Main layout: Aseprite style: menu bar on top, slim icon toolbar far-left,
       color + options sidebar beside it, canvas dead-center, layers + preview
       docked right, timeline + export along the bottom. */
    var menubar = el("div", "pixel-menubar");
    function closeMenus() { Array.prototype.forEach.call(menubar.children, function (w) { w.classList.remove("is-open"); }); }
    function anyMenuOpen() { return !!menubar.querySelector(".pixel-menu.is-open"); }
    function addMenu(label, items) {
      var wrap = el("div", "pixel-menu");
      var btn = el("button", "pixel-menu-btn", label);
      var drop = el("div", "pixel-menu-drop");
      items.forEach(function (it) {
        if (it === "-") { drop.appendChild(el("div", "pixel-menu-sep", "")); return; }
        var row = el("button", "pixel-menu-item");
        row.appendChild(el("span", "pixel-menu-label", it[0]));
        row.appendChild(el("span", "pixel-menu-key", it[2] || ""));
        row.addEventListener("click", function (ev) {
          ev.stopPropagation();
          closeMenus();
          closeCtxMenu();
          it[1]();
        });
        drop.appendChild(row);
      });
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var was = wrap.classList.contains("is-open");
        closeMenus();
        if (!was) { wrap.classList.add("is-open"); closeCtxMenu(); }
      });
      btn.addEventListener("mouseenter", function () { if (anyMenuOpen() && !wrap.classList.contains("is-open")) { closeMenus(); wrap.classList.add("is-open"); } });
      wrap.append(btn, drop);
      menubar.appendChild(wrap);
    }
    addMenu("File", [
      ["New...", function () { toggleNewDims(true); }, "Ctrl+N"],
      ["Open...", function () { fileInput.click(); }, "Ctrl+O"],
      "-",
      ["Save Project", saveProject, "Ctrl+S"],
      ["Export PNG", exportPng],
      ["Export GIF", exportGif],
      ["Export Sprite Sheet", exportSheet]
    ]);
    addMenu("Edit", [
      ["Undo", undo, "Ctrl+Z"],
      ["Redo", redoAction, "Ctrl+Y"],
      "-",
      ["Cut", cutSel, "Ctrl+X"],
      ["Copy", copySel, "Ctrl+C"],
      ["Paste", pasteClip, "Ctrl+V"],
      ["Clear", function () { if (!S.doc) return; pushHistory(); S.doc.frames[S.frame][S.layer].data.fill(0); renderAll(); }, "Del"],
      "-",
      ["Deselect", clearSel, "Ctrl+D"],
      ["Select All", selectAll, "Ctrl+A"],
      "-",
      ["Flip Horizontal", function () { flipLayer(false); }],
      ["Flip Vertical", function () { flipLayer(true); }],
      ["Rotate 90 CW", function () { rotateLayer(90); }],
      ["Rotate 180", function () { rotateLayer(180); }]
    ]);
    addMenu("Sprite", [
      ["Canvas Size...", function () { toggleNewDims(true); }, "Ctrl+C"],
      ["Flip Horizontal", function () { flipLayer(false); }],
      ["Flip Vertical", function () { flipLayer(true); }],
      ["Rotate 90 CW", function () { rotateLayer(90); }],
      ["Rotate 180", function () { rotateLayer(180); }],
      ["Clear All Layers", function () { if (!S.doc) return; pushHistory(); S.doc.frames[S.frame].forEach(function (c) { c.data.fill(0); }); renderAll(); }]
    ]);
    addMenu("Layer", [
      ["New Layer", addLayer, "Shift+N"],
      ["Duplicate Layer", dupLayer],
      ["Merge Down", mergeDown, "Ctrl+E"],
      ["Remove Layer", function () { removeLayer(S.layer); }],
      "-",
      ["Properties...", layerProperties, "P"]
    ]);
    addMenu("Frame", [
      ["New Frame", addFrame, "Alt+N"],
      ["Duplicate Frame", dupFrame, "Alt+D"],
      ["Delete Frame", function () { removeFrameAt(S.frame); }, "Delete"]
    ]);
    addMenu("Select", [
      ["Deselect", clearSel, "Ctrl+D"],
      ["Select All", selectAll, "Ctrl+A"],
      ["Invert Selection", invertSel, "Ctrl+Shift+I"]
    ]);
    addMenu("View", [
      ["Normal Size (100%)", function () { setZoom(1); }],
      ["Zoom In", zoomIn, "+"],
      ["Zoom Out", zoomOut, "-"],
      "-",
      ["Toggle Grid", function () { S.grid = !S.grid; var cb = document.getElementById("pixel-grid"); if (cb) cb.checked = S.grid; renderAll(); }],
      ["Toggle Pixel Grid", function () { S.pixelGrid = !S.pixelGrid; renderAll(); }],
      ["Toggle Onion Skin", function () { S.onion = !S.onion; var cb = document.getElementById("pixel-onion"); if (cb) cb.checked = S.onion; renderAll(); }],
      ["Toggle Symmetry H", function () { S.symH = !S.symH; var cb = document.getElementById("pixel-symh"); if (cb) cb.checked = S.symH; }],
      ["Toggle Symmetry V", function () { S.symV = !S.symV; var cb = document.getElementById("pixel-symv"); if (cb) cb.checked = S.symV; }]
    ]);
    addMenu("Help", [
      ["Keyboard Shortcuts...", showShortcuts]
    ]);
    document.addEventListener("click", function () { closeMenus(); closeCtxMenu(); });

    var main = el("div", "pixel-main");
    var toolStrip = el("div", "pixel-toolstrip");
    toolStrip.appendChild(toolbar);
    var leftCol = el("div", "pixel-leftcol");
    leftCol.append(colorPanel, optsPanel);

    var centerCol = el("div", "pixel-centercol");
    centerCol.append(toprow, viewWrap, status);

    var rightCol2 = el("div", "pixel-right");
    rightCol2.append(layersPanel, rightCol);

    main.append(toolStrip, leftCol, centerCol, rightCol2);

    var bottom = el("div", "pixel-bottom");
    bottom.appendChild(tlPanel);
    bottom.appendChild(exportRow);

    app.appendChild(menubar);
    app.appendChild(main);
    app.appendChild(bottom);
    app.appendChild(newDims);

    bindRGBA();
    toprow.append(btnNew, btndimM, btnOpen, btnUndo, btnRedo, btnCut, btnCopy, btnPaste, btnDeselect, btnZoomOut, btnZoomIn, brushLbl);

    /* Mouse handling */
    viewWrap.addEventListener("mousedown", function (e) {
      if (e.button === 1) e.preventDefault();
      startStroke(e);
    });
    viewWrap.addEventListener("mousemove", function (e) {
      var cc = cellFromEvent(e);
      var pos = document.getElementById("pixel-pos");
      if (pos) pos.textContent = (cc.x >= 0 && cc.y >= 0) ? (cc.x + ", " + cc.y) : "-";
      moveStroke(e);
    });
    viewWrap.addEventListener("mouseup", endStroke);
    viewWrap.addEventListener("mouseleave", function () { if (S.drawing && S.tool !== "lasso") { endStroke(); } });
    viewWrap.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    viewWrap.addEventListener("wheel", function (e) {
      e.preventDefault();
      if (e.ctrlKey) { setZoom(S.zoom + (e.deltaY < 0 ? 1 : -1)); }
    }, { passive: false });

    /* middle-mouse pan */
    viewWrap.addEventListener("mousedown", function (e) {
      if (e.button === 1) { e.preventDefault(); S.panning = true; S.lastX = e.clientX; S.lastY = e.clientY; }
    });
    document.addEventListener("mousemove", function (e) {
      if (S.panning) {
        var view = document.getElementById("pixel-view");
        view.scrollLeft -= (e.clientX - S.lastX);
        view.scrollTop -= (e.clientY - S.lastY);
        S.lastX = e.clientX; S.lastY = e.clientY;
      }
    });
    document.addEventListener("mouseup", function () { S.panning = false; });

    function toggleNewDims(show) {
      var nd = document.getElementById("pixel-newdims");
      if (nd) nd.hidden = !show;
    }

    /* Keyboard shortcuts: Aseprite defaults. Tools: B pencil, E eraser,
       G bucket, Shift+G gradient, I eyedropper, M marquee, L lasso, W wand,
       U rectangle, Shift+U ellipse, N line, H hand, Z zoom, V move.
       X swaps colors, [ ] resize the brush, 1-0 set layer opacity presets,
       Enter plays the animation, Space+drag pans. */
    document.addEventListener("keydown", function (e) {
      var modal = document.getElementById("pixel-modal");
      if (!modal || modal.hidden) return;
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      var k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
        else if (e.shiftKey && k === "z") { e.preventDefault(); redoAction(); }
        else if (k === "y") { e.preventDefault(); redoAction(); }
        else if (k === "x") { e.preventDefault(); cutSel(); }
        else if (k === "c") { e.preventDefault(); copySel(); }
        else if (k === "v") { e.preventDefault(); pasteClip(); }
        else if (k === "d") { e.preventDefault(); if (S.doc) clearSel(); }
        else if (k === "a") { e.preventDefault(); if (S.doc) selectAll(); }
        else if (k === "s") { e.preventDefault(); saveProject(); }
        else if (k === "e" && S.doc && S.layer > 0) { e.preventDefault(); mergeDown(); }
        return;
      }
      if (e.altKey && k === "n") { addFrame(); return; }
      if (k === "enter") { if (S.playing) stopPlay(); else startPlay(); var pcb = document.getElementById("pixel-animate"); if (pcb) pcb.checked = S.playing; renderTimeline(); return; }
      if (k === " ") { S.spacePan = true; e.preventDefault(); return; }
      var map = {
        b: "pencil", e: "eraser", g: "bucket", i: "pick", h: "hand", v: "move",
        n: "line", u: "rect", z: "zoom", r: "blur",
        m: "marquee", l: "lasso", w: "wand"
      };
      var shiftMap = { u: "ellipse", g: "gradient" };
      if (e.shiftKey && shiftMap[k]) { selectTool(shiftMap[k]); }
      else if (!e.shiftKey && map[k]) { selectTool(map[k]); }
      else if (k === "x") { swapColors(); }
      else if (k === "[") { setBrush(Math.max(1, S.brush - 1)); }
      else if (k === "]") { setBrush(Math.min(32, S.brush + 1)); }
      else if (k >= "1" && k <= "9") { setLayerOpacityPreset(+k * 10); }
      else if (k === "0") { setLayerOpacityPreset(100); }
      else if (k === "delete" || k === "backspace") {
        var region = selectedRegion();
        if (region) {
          e.preventDefault();
          pushHistory();
          var w = S.doc.w, h = S.doc.h, mask = S.sel.mask;
          var cel = S.doc.frames[S.frame][S.layer].data;
          for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (mask[y * w + x]) cel[y * w + x] = 0;
          renderAll();
        }
      }
      /* keep the toolbar highlight in sync with S.tool */
      var btns = document.querySelectorAll(".pixel-toolbar .pixel-tool[data-tool]");
      btns.forEach(function (b) { b.classList.toggle("is-active", b.getAttribute("data-tool") === S.tool); });
      updateStatus();
    }, true);
    document.addEventListener("keyup", function (e) {
      if (e.key === " ") S.spacePan = false;
    });

    /* Play loop */
    var animTimer = null;
    function startPlay() {
      if (!S.doc || S.doc.frames.length <= 1) { playCb.checked = false; return; }
      stopPlay();
      S.playing = true; playCb.checked = true;
      var f = S.frame, acc = 0, last = Date.now();
      animTimer = setInterval(function () {
        var now = Date.now();
        acc += now - last; last = now;
        var len = S.doc.frames.length;
        while (acc >= 20 && S.playing) {
          var dur = Math.max(20, (S.durations && S.durations[f] ? S.durations[f] : 1000 / S.fps));
          if (acc < dur) break;
          acc -= dur;
          f += (S.playDir || 1);
          if (f >= len) {
            if (S.playMode === "once") { stopPlay(); playCb.checked = false; S.frame = len - 1; renderAll(); return; }
            if (S.playMode === "pingpong") { S.playDir = -1; f = len - 2; }
            else f = 0;
          } else if (f < 0) {
            if (S.playMode === "pingpong") { S.playDir = 1; f = 1; }
            else f = 0;
          }
          if (len <= 1) f = 0;
        }
        S.frame = f;
        renderAll();
      }, 33);
    }
    function stopPlay() { if (animTimer) { clearInterval(animTimer); animTimer = null; } S.playing = false; S.playDir = 1; }

    S.startPlay = startPlay; S.stopPlay = stopPlay;

    /* Drag & drop import */
    viewWrap.addEventListener("dragover", function (e) { e.preventDefault(); });
    viewWrap.addEventListener("drop", function (e) {
      e.preventDefault();
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files[0]) openImageFile(dt.files[0]);
    });

    loadProject();
    if (!S.doc) S.doc = newDoc(64, 64);
    renderAll();
    syncColorUI();
    updateStatus();
    inited = true;
  }

  function syncZoomUI() {
    var pct = document.getElementById("pixel-zoom-pct");
    if (pct) pct.textContent = Math.round(S.zoom * 100) + "%";
    var z2 = document.getElementById("pixel-zoom");
    if (z2) z2.textContent = S.zoom + "×";
  }

  function updateStatus() {
    syncZoomUI();
    var can = document.getElementById("pixel-canvas-label");
    if (can && S.doc) can.textContent = S.doc.w + " × " + S.doc.h;
    var dim = document.querySelector(".pixel-dim");
    if (dim && S.doc) dim.textContent = S.doc.w + "×" + S.doc.h;
    var lb = document.getElementById("pixel-framecount");
    if (lb && S.doc) lb.textContent = (S.frame + 1) + " / " + S.doc.frames.length;
    var tl = document.getElementById("pixel-tool-label");
    if (tl) tl.textContent = S.tool;
    var br = document.getElementById("pixel-brush-label");
    if (br) br.textContent = S.brush > 1 ? S.brush + "px brush" : "";
  }

  /* ---------- persistence ---------- */

  function loadProject() {
    try {
      var raw = localStorage.getItem(APP_KEY);
      if (!raw) return;
      var p = JSON.parse(raw);
      S.doc = p.doc; S.zoom = p.zoom || 6; S.frame = 0; S.layer = 0;
      /* normalize layers to new fields */
      for (var i = 0; i < S.doc.layers.length; i++) {
        if (S.doc.layers[i].blend === undefined) S.doc.layers[i].blend = "normal";
      }
      /* restore timeline extras (older saves just get defaults) */
      S.durations = (p.durations && p.durations.length === S.doc.frames.length) ? p.durations.slice() : [];
      while (S.durations.length < S.doc.frames.length) S.durations.push(1000 / (p.fps || S.fps));
      S.tags = (p.tags && p.tags.length) ? p.tags.filter(function (t) { return t && t.to >= t.from && t.from >= 0 && t.to < S.doc.frames.length; }).map(function (t) { return { name: String(t.name || "Tag"), from: Math.max(0, t.from | 0), to: t.to | 0, color: t.color || TAG_COLORS[0] }; }) : [];
    } catch (e) { /* ignore */ }
  }

  function saveProject() {
    try {
      if (!S.doc) return;
      var sdoc = { w: S.doc.w, h: S.doc.h, layers: S.doc.layers.map(function (l) { return { name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend || "normal" }; }), frames: [] };
      for (var f = 0; f < S.doc.frames.length; f++) {
        var fl = [];
        for (var i = 0; i < S.doc.frames[f].length; i++) {
          fl.push({ data: Array.from(S.doc.frames[f][i].data) });
        }
        sdoc.frames.push(fl);
      }
      localStorage.setItem(APP_KEY, JSON.stringify({ doc: sdoc, zoom: S.zoom, durations: S.durations, tags: S.tags, playMode: S.playMode }));
    } catch (e) { /* storage full - non fatal */ }
  }

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
    if (antsTimer) { clearInterval(antsTimer); antsTimer = null; }
  }

  window.ChalklePixel = { open: open, close: close };

  document.addEventListener("DOMContentLoaded", function () {
    var modal = document.getElementById("pixel-modal");
    if (!modal) return;
    modal.querySelectorAll("[data-pixel-close]").forEach(function (el2) {
      el2.addEventListener("click", function (e) {
        if (e.target === el2 || el2.tagName === "BUTTON") close();
      });
    });
  });
})();
