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
      case "dodge": return f >= 1 ? 255 : 255 * Math.min(1, b / (1 - f));
      case "burn": return f <= 0 ? 0 : 255 * (1 - Math.min(1, (1 - b) / f));
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

  function currentLayer() { return S.doc.layers[S.layer]; }

  function packColor(c) { return pack(c.r, c.g, c.b, c.a); }

  /* ---------- selection ---------- */

  function newMask(w, h) { return new Uint8Array(w * h); }

  function clearSel() { S.sel = null; renderFrameCanvas(); renderSelOverlay(); updateStatus(); }

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
      if (prev >= 0) drawBuffer(ctx, composite(S.doc, prev), S.onionOpacity);
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
    var wrap = document.getElementById("pixel-view");
    var r = wrap.getBoundingClientRect();
    var x = Math.floor((e.clientX - r.left) / S.zoom);
    var y = Math.floor((e.clientY - r.top) / S.zoom);
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

  function drawShape(x0, y0, x1, y1, fill) {
    var color = packColor(S.color);
    var l = S.layer;
    if (S.tool === "line") { drawStroke(x0, y0, x1, y1, color, paintCell); return; }
    var xmin = Math.min(x0, x1), xmax = Math.max(x0, x1);
    var ymin = Math.min(y0, y1), ymax = Math.max(y0, y1);
    if (S.tool === "rect" || S.tool === "frect") {
      if (S.tool === "frect") {
        for (var fy = ymin; fy <= ymax; fy++) for (var fx = xmin; fx <= xmax; fx++) paintCell(fx, fy, color);
      } else {
        for (var sx = xmin; sx <= xmax; sx++) { paintCell(sx, ymin, color); paintCell(sx, ymax, color); }
        for (var sy = ymin + 1; sy < ymax; sy++) { paintCell(xmin, sy, color); paintCell(xmax, sy, color); }
      }
    } else if (S.tool === "ellipse" || S.tool === "fellipse") {
      var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      var rx = Math.max(0, (xmax - xmin) / 2), ry = Math.max(0, (ymax - ymin) / 2);
      var filled = S.tool === "fellipse";
      var steps = 120;
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
      var bx0 = clamp(x0, 0, bw - 1), by0 = clamp(y0, 0, bh - 1), bx1 = clamp(x1, 0, bw - 1), by1 = clamp(y1, 0, bh - 1);
      var bminx = Math.min(bx0, bx1), bmaxx = Math.max(bx0, bx1);
      var bminy = Math.min(by0, by1), bmaxy = Math.max(by0, by1);
      for (var by2 = bminy; by2 <= bmaxy; by2++) for (var bx2 = bminx; bx2 <= bmaxx; bx2++) {
        var bidx = by2 * bw + bx2;
        if (data3[bidx] !== 0) data3[bidx] = blured(bx2, by2);
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

    /* eyedropper always available as right-click */
    if (useAlt && S.tool !== "hand" && S.tool !== "move" && S.tool !== "marquee" && S.tool !== "lasso" && S.tool !== "wand") {
      var picked = colorAt(S.doc, S.frame, l, c.x, c.y);
      S.altColor = { r: picked & 0xff, g: (picked >> 8) & 0xff, b: (picked >> 16) & 0xff, a: (picked >>> 24) & 0xff };
      syncColorUI();
      return;
    }

    if (S.tool === "move") { pushHistory(); startMove(e); return; }
    if (S.tool === "hand") { S.drawing = true; S.lastX = e.clientX; S.lastY = e.clientY; return; }
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
    if (S.tool === "hand") {
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
    if (S.tool === "move") { moveDrag(e); return; }      if (S.tool === "pencil" || S.tool === "eraser") {
        if (S.lastX === c.x && S.lastY === c.y) return;
        var color = S.tool === "eraser" ? 0 : packColor(S.color);
        if (S.tool === "pencil" && S.pixelPerfect) {
          drawStroke(S.lastX, S.lastY, c.x, c.y, color, paintPPMove);
        }
        else drawStroke(S.lastX, S.lastY, c.x, c.y, color, paintCell);
        S.lastX = c.x; S.lastY = c.y;
        renderFrameCanvas();
      } else if (S.tool === "line" || S.tool === "rect" || S.tool === "frect" || S.tool === "ellipse" || S.tool === "fellipse" || S.tool === "contour" || S.tool === "shading" || S.tool === "blur") {
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
    if (S.tool === "hand") { S.drawing = false; return; }
    if (S.tool === "line" || S.tool === "rect" || S.tool === "frect" || S.tool === "ellipse" || S.tool === "fellipse" || S.tool === "contour" || S.tool === "shading" || S.tool === "blur") {
      drawShape(S.anchorX, S.anchorY, c.x, c.y, true);
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
  }

  function setColorFromHex(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return;
    S.color.r = parseInt(m[1].slice(0, 2), 16);
    S.color.g = parseInt(m[1].slice(2, 4), 16);
    S.color.b = parseInt(m[1].slice(4, 6), 16);
    syncColorUI();
  }

  function swapColors() {
    var t = S.color; S.color = S.altColor; S.altColor = t;
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
      up.addEventListener("click", function () { if (i > 0) { var t = S.doc.layers[i]; S.doc.layers[i] = S.doc.layers[i - 1]; S.doc.layers[i - 1] = t; for (var f = 0; f < S.doc.frames.length; f++) { var tt = S.doc.frames[f][i]; S.doc.frames[f][i] = S.doc.frames[f][i - 1]; S.doc.frames[f][i - 1] = tt; } if (S.layer === i) S.layer = i - 1; else if (S.layer === i - 1) S.layer = i; renderAll(); } });
      var del = el("button", "pixel-mini danger", "✕"); del.title = "Delete layer";
      del.addEventListener("click", function () { if (S.doc.layers.length <= 1) return; for (var f = 0; f < S.doc.frames.length; f++) S.doc.frames[f].splice(i, 1); S.doc.layers.splice(i, 1); if (S.layer >= S.doc.layers.length) S.layer = S.doc.layers.length - 1; renderAll(); });
      row.addEventListener("click", function () { S.layer = i; renderAll(); });
      row.append(vis, name, up, del);
      box.appendChild(row);
    });
    /* active layer opacity + blend controls */
    var opIn = document.getElementById("pixel-layer-opacity");
    var blendSel = document.getElementById("pixel-layer-blend");
    var ly = currentLayer();
    if (opIn) opIn.value = ly.opacity;
    if (blendSel) blendSel.value = ly.blend || "normal";
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

  function exportGif() {
    var frames = [];
    for (var f = 0; f < S.doc.frames.length; f++) frames.push(composite(S.doc, f));
    var gif = encodeGIF(frames, S.doc.w, S.doc.h, S.fps);
    var blob = new Blob([gif], { type: "image/gif" });
    var url = URL.createObjectURL(blob);
    var a = el("a"); a.href = url; a.download = "chalkle-anim.gif";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* GIF encoder: 256-color global palette from all frames, LZW. */
  function encodeGIF(framesRaw, w, h, fps) {
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
      bytes.push(0x21, 0xF9, 0x04, 0x00); w16(delay); bytes.push(0x00, 0x00);
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

    /* Toolbar: Aseprite's layout: a vertical icon strip on the left, with
       the tool set ordered like the real app and monochrome line-art icons
       (drawn to mirror Aseprite's tool glyphs) instead of emoji. */
    var ICONS = {
      pencil: '<path d="M4 20l8-9 4 4-9 9H4z"/><path d="M12 11l3-3c1-1 3-3 4-2s0 3-1 4l-3 3"/><path d="M17 4l3 3"/>',
      eraser: '<path d="M13 4l7 7-8 8-7-7z"/><path d="M5 21h7"/><rect x="7" y="14" width="4" height="4" fill="currentColor" stroke="none"/>',
      bucket: '<path d="M7 4l13 8-5 9H9L4 12l6-4"/><path d="M4 12l5-3"/><path d="M13 6l1.5-1.5a2 2 0 0 1 3 2.6L13 11"/><path d="M9 20l-2 1M13 20l2 1M7 18l2 1"/>',
      pick: '<path d="m8 2 4 4-6 6-4-4z"/><path d="M18 14a4 4 0 0 1-4 4"/><path d="M10 8l8 8-4 4-8-8"/><path d="m6 16-3 6 6-3"/>',
      hand: '<path d="M7 11V6a1.5 1.5 0 0 1 3 0v4M10 9V5a1.5 1.5 0 0 1 3 0v5M13 10V6a1.5 1.5 0 0 1 3 0v5"/><path d="M16 8a1.5 1.5 0 0 1 3 0v6c0 4-3 7-7 7h-2c-2.5 0-4-1-5-3L3 14c-.7-1 0-2.5 1-2.5S5 12 6 13v-5"/>',
      move: '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
      line: '<path d="M4 20 18 5"/><rect x="2" y="19" width="4" height="4" ry="1" fill="currentColor" stroke="none"/><rect x="17" y="3" width="4" height="4" ry="1" fill="currentColor" stroke="none"/>',
      rect: '<rect x="3" y="5" width="18" height="14" ry="1"/>',
      frect: '<rect x="3" y="5" width="18" height="14" ry="1" fill="currentColor" stroke="none"/>',
      ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
      fellipse: '<ellipse cx="12" cy="12" rx="9" ry="7" fill="currentColor" stroke="none"/>',
      contour: '<path d="M4 12a8 8 0 0 1 8-8"/><path d="M4 12a8 8 0 0 0 8 8"/><path d="M12 4v7h2"/>',
      shading: '<circle cx="12" cy="12" r="9"/><path d="M3 12a9 9 0 0 1 18 0Z" fill="currentColor" stroke="none"/>',
      blur: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
      marquee: '<rect x="3" y="5" width="18" height="14" rx="1" stroke-dasharray="3.5 2.5"/><rect x="1" y="3" width="4" height="4" fill="currentColor" stroke="none" opacity="0"/><path d="M3 3v2h2M21 5v-2h-2M21 19v2h-2M3 21v-2h2"/>',
      lasso: '<path d="M5 7c1.5-3 12-4 14 1s-6 4-6 6"/><path d="M13 14a2 2 0 1 0 2 2c0-4 4-6 7-6v0"/>',
      wand: '<path d="M4 20 15 9"/><path d="M14 9l1-1M16 7l1-1"/><path d="m9 12-4-4 7-7 4 4z"/><path d="m9 8 3 3"/><path d="M4 20l2-2"/><path d="m19 7 .8 1.7L21.5 9l-1.7.8L19 11.5l-.8-1.7L16.5 9l1.7-.8z"/><path d="m14 3 .5 1L16 4.5l-1 .5-.5 1-.5-1L13 4.5 14 4z"/>'
    };
    function iconSvg(name, cls) {
      return '<svg class="' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>";
    }
    var toolbar = el("div", "pixel-toolbar");
    var tools = [
      ["marquee", "Rectangular selection", "marquee", "Rectangular selection (M)"],
      ["lasso", "Lasso selection", "lasso", "Freehand selection (Q)"],
      ["wand", "Magic wand", "wand", "Magic wand (W)"],
      ["move", "Move", "move", "Move content (V)"],
      ["hand", "Hand", "hand", "Hand / pan (H)"],
      ["pencil", "Pencil", "pencil", "Pencil (B)"],
      ["bucket", "Paint bucket", "bucket", "Fill (G)"],
      ["eraser", "Eraser", "eraser", "Eraser (E)"],
      ["line", "Line", "line", "Line (L)"],
      ["rect", "Rectangle", "rect", "Rectangle (U)"],
      ["frect", "Rectangle fill", "frect", "Filled rectangle (Shift+U)"],
      ["ellipse", "Ellipse", "ellipse", "Ellipse (O)"],
      ["fellipse", "Ellipse fill", "fellipse", "Filled ellipse (Shift+O)"],
      ["contour", "Contour", "contour", "Contour outline (D)"],
      ["shading", "Shade darker", "shading", "Shade darker (S)"],
      ["blur", "Blur", "blur", "Blur (R)"],
      ["pick", "Eyedropper", "pick", "Pick color (I)"]
    ];
    var toolBtns = {};
    tools.forEach(function (t) {
      var b = el("button", "pixel-tool" + (S.tool === t[0] ? " is-active" : ""));
      b.innerHTML = iconSvg(t[2], "pixel-tool-ico");
      b.title = t[3];
      b.setAttribute("data-tool", t[0]);
      b.setAttribute("aria-label", t[1]);
      b.addEventListener("click", function () { S.tool = t[0]; Object.keys(toolBtns).forEach(function (k) { toolBtns[k].classList.toggle("is-active", k === t[0]); }); updateStatus(); });
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

    /* Palette: click sets fg, right-click sets bg */
    var paletteRow = el("div", "pixel-palette");
    var palette = [
      "#000000", "#1d1f27", "#ffffff", "#ff004d", "#ffa300", "#3ae0ff", "#7dff00",
      "#ff77a8", "#20283d", "#705632", "#9b3b3b", "#e8a838", "#4e6bb0", "#8b61c4",
      "#f0f0f0", "#2b2b2b", "#ff6b6b", "#ffd93d", "#6bcb77", "#4d96ff", "#c77dff"
    ];
    palette.forEach(function (hex) {
      var sw = el("button", "pixel-palette-swatch", "");
      sw.style.background = hex;
      sw.addEventListener("click", function () { setColorFromHex(hex); });
      sw.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        var m = /^#?([0-9a-f]{6})$/i.exec(hex);
        if (m) {
          S.altColor.r = parseInt(m[1].slice(0, 2), 16);
          S.altColor.g = parseInt(m[1].slice(2, 4), 16);
          S.altColor.b = parseInt(m[1].slice(4, 6), 16);
          syncColorUI();
        }
      });
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
    /* layer opacity + blend */
    var lbRow = el("div", "pixel-row");
    lbRow.appendChild(el("span", "pixel-mini-lbl", "Op"));
    var opIn = el("input"); opIn.type = "range"; opIn.id = "pixel-layer-opacity"; opIn.min = 0; opIn.max = 255; opIn.value = 255;
    opIn.addEventListener("input", function () { if (S.doc) { currentLayer().opacity = +opIn.value; renderAll(); } });
    lbRow.appendChild(opIn);
    var blendSel = el("select"); blendSel.id = "pixel-layer-blend"; blendSel.className = "pixel-blend";
    ["normal", "multiply", "screen", "overlay", "darken", "lighten", "difference", "exclusion", "dodge", "burn", "hsl_hue", "hsl_sat", "hsl_color", "hsl_lum"].forEach(function (m) {
      var o = el("option", "", m.charAt(0).toUpperCase() + m.slice(1).replace("_", " "));
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
    var tlBtnAdd = el("button", "pixel-mini", "+ Frame");
    var tlBtnDup = el("button", "pixel-mini", "⧉ Frame");
    tlHead.append(tlBtnAdd, tlBtnDup);
    tlBtnAdd.addEventListener("click", addFrame);
    tlBtnDup.addEventListener("click", dupFrame);
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

    /* Status bar */
    var status = el("div", "pixel-status");
    var posLbl = el("span", "", "-"); posLbl.id = "pixel-pos";
    var zoomLbl = el("span", "", ""); zoomLbl.id = "pixel-zoom";
    var canLbl = el("span", "", ""); canLbl.id = "pixel-canvas-label";
    var toolLbl = el("span", "", ""); toolLbl.id = "pixel-tool-label";
    status.append(posLbl, zoomLbl, canLbl, toolLbl);

    /* Canvas viewport */
    var viewWrap = el("div", "pixel-view"); viewWrap.id = "pixel-view";
    var canvasEl = document.createElement("canvas");
    canvasEl.id = "pixel-canvas"; canvasEl.className = "pixel-canvas";
    var gridCanvas = document.createElement("canvas");
    gridCanvas.id = "pixel-grid-canvas"; gridCanvas.className = "pixel-grid";
    var selCanvas = document.createElement("canvas");
    selCanvas.id = "pixel-sel-canvas"; selCanvas.className = "pixel-grid";
    viewWrap.append(gridCanvas, selCanvas, canvasEl);

    /* Right side: preview */
    var rightCol = el("div", "pixel-right");
    rightCol.appendChild(el("h3", "pixel-panel-title", "Preview"));
    var previewCanvas = document.createElement("canvas");
    previewCanvas.id = "pixel-preview"; previewCanvas.className = "pixel-preview";
    var pvHint = el("p", "pixel-preview-hint", "Nearest-neighbor preview of the current frame");
    rightCol.append(previewCanvas, pvHint);

    /* Main layout: Aseprite style: slim icon toolbar far-left, color +
       options sidebar beside it, canvas dead-center, layers + preview
       docked right, timeline + export along the bottom. */
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

    app.appendChild(main);
    app.appendChild(bottom);
    app.appendChild(newDims);

    bindRGBA();
    toprow.append(btnNew, btndimM, btnOpen, btnUndo, btnRedo, btnCut, btnCopy, btnPaste, btnDeselect, btnZoomOut, btnZoomIn);

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

    /* Keyboard shortcuts: Aseprite defaults */
    document.addEventListener("keydown", function (e) {
      var modal = document.getElementById("pixel-modal");
      if (!modal || modal.hidden) return;
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      var k = e.key.toLowerCase();
      var map = {
        b: "pencil", e: "eraser", g: "bucket", i: "pick", h: "hand", v: "move",
        l: "line", u: "rect", o: "ellipse", d: "contour", s: "shading", r: "blur",
        m: "marquee", q: "lasso", w: "wand"
      };
      if (e.shiftKey && k === "u") { S.tool = "frect"; }
      else if (e.shiftKey && k === "o") { S.tool = "fellipse"; }
      else if (map[k]) { S.tool = map[k]; }
      if (e.ctrlKey || e.metaKey) {
        if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
        else if (e.shiftKey && k === "z") { e.preventDefault(); redoAction(); }
        else if (k === "y") { e.preventDefault(); redoAction(); }
        else if (k === "x") { e.preventDefault(); cutSel(); }
        else if (k === "c") { e.preventDefault(); copySel(); }
        else if (k === "v") { e.preventDefault(); pasteClip(); }
        else if (k === "d") { e.preventDefault(); if (S.doc) clearSel(); }
        return;
      }
      if (k === "x" && !e.ctrlKey && !e.metaKey) { swapColors(); }
      else if (k === "d" && !e.ctrlKey && !e.metaKey) { S.color = { r: 0, g: 0, b: 0, a: 255 }; S.altColor = { r: 255, g: 255, b: 255, a: 255 }; syncColorUI(); }
      else if (k === "[" ) { zoomOut(); }
      else if (k === "]") { zoomIn(); }
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
      /* update active tool highlight */
      var btns = document.querySelectorAll(".pixel-toolbar .pixel-tool[data-tool]");
      btns.forEach(function (b) { b.classList.toggle("is-active", b.getAttribute("data-tool") === S.tool); });
      updateStatus();
    }, true);

    /* Play loop */
    var animTimer = null;
    function startPlay() { if (!S.doc || S.doc.frames.length <= 1) { playCb.checked = false; return; } stopPlay(); animTimer = setInterval(function () { S.frame = (S.frame + 1) % S.doc.frames.length; renderAll(); }, 1000 / S.fps); }
    function stopPlay() { if (animTimer) { clearInterval(animTimer); animTimer = null; } }

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

  function updateStatus() {
    var zoom = document.getElementById("pixel-zoom");
    if (zoom) zoom.textContent = S.zoom + "×";
    var can = document.getElementById("pixel-canvas-label");
    if (can && S.doc) can.textContent = S.doc.w + " × " + S.doc.h;
    var dim = document.querySelector(".pixel-dim");
    if (dim && S.doc) dim.textContent = S.doc.w + "×" + S.doc.h;
    var lb = document.getElementById("pixel-framecount");
    if (lb && S.doc) lb.textContent = (S.frame + 1) + " / " + S.doc.frames.length;
    var tl = document.getElementById("pixel-tool-label");
    if (tl) tl.textContent = S.tool;
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
      localStorage.setItem(APP_KEY, JSON.stringify({ doc: sdoc, zoom: S.zoom }));
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
