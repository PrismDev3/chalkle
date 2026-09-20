/* Chalkle local music - play the files already on your device.

   The Music tab is a relay: every track is a search result streamed from a
   provider, so when that relay is blocked or down there is nothing to play.
   This module is the other half. It reads the tags straight out of audio files
   you pick (or drop) and keeps them in IndexedDB, so the Music tab has a
   library that works with no network at all - and survives a reload, because
   a Blob in IndexedDB outlives the object URL pointing at it.

   Tag support is hand-rolled rather than a dependency, because Chalkle has no
   build step and no vendored tag reader:

     ID3v2.2/2.3/2.4   MP3, and anything else carrying an ID3 header
     ID3v1             the 128 bytes at the end of older MP3s
     FLAC              Vorbis comments plus the embedded PICTURE block
     MP4/M4A           the iTunes ilst atoms, cover art included

   Anything unreadable falls back to the filename, which is the only tag a lot
   of downloaded music has anyway ("07 - Artist - Title.mp3" is parsed as such,
   because dropping the leading track number is the difference between a tidy
   album and 12 rows called "07 ...").

   window.ChalkleLocalMusic: ready(), list(), albums(), add(files, onProgress),
   remove(id), clear(), tracks() */

(function () {
  "use strict";

  var DB_NAME = "chalkle-local-music";
  var DB_VERSION = 1;
  var STORE = "tracks";
  var TAG_READ_BYTES = 2 * 1024 * 1024;   /* enough for tags + embedded art */

  var records = [];        /* every stored track, newest first */
  var views = {};          /* id -> object URL, created lazily */
  var dbPromise = null;

  /* ---------- small helpers ---------- */

  function bytesToStr(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
  function latin1(bytes) {
    try { return new TextDecoder("windows-1252").decode(bytes); }
    catch (e) { return bytesToStr(bytes); }
  }
  function utf8(bytes) {
    try { return new TextDecoder("utf-8").decode(bytes); }
    catch (e) { return bytesToStr(bytes); }
  }
  function decodeText(bytes, encoding) {
    if (!bytes.length) return "";
    if (encoding === 1 || encoding === 2) {
      var be = encoding === 2;
      /* Encoding 1 is UTF-16 with a BOM; 2 is UTF-16BE with no BOM. */
      if (encoding === 1 && bytes.length >= 2) {
        if (bytes[0] === 0xff && bytes[1] === 0xfe) be = false;
        else if (bytes[0] === 0xfe && bytes[1] === 0xff) be = true;
        else be = false;
      }
      var out = "";
      for (var i = 0; i + 1 < bytes.length; i += 2) {
        var code = be ? (bytes[i] << 8) | bytes[i + 1] : (bytes[i + 1] << 8) | bytes[i];
        if (code === 0) break;
        out += String.fromCharCode(code);
      }
      return out;
    }
    if (encoding === 3) return utf8(bytes).replace(/\0.*$/, "");
    return latin1(bytes).replace(/\0.*$/, "");
  }
  function syncsafe(bytes, at) {
    return ((bytes[at] & 0x7f) << 21) | ((bytes[at + 1] & 0x7f) << 14) |
      ((bytes[at + 2] & 0x7f) << 7) | (bytes[at + 3] & 0x7f);
  }
  function be32(bytes, at) {
    return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  }
  function le32(bytes, at) {
    return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
  }
  function ascii(bytes, at, len) {
    var out = "";
    for (var i = 0; i < len; i++) out += String.fromCharCode(bytes[at + i]);
    return out;
  }
  function tidy(s) {
    return String(s == null ? "" : s).replace(/\0/g, "").replace(/\s+/g, " ").trim();
  }
  function clean(value) {
    var v = tidy(value);
    /* Some rippers write the album as "Album (Deluxe Edition)" etc; leave those
       alone - only strip a wrapping pair of quotes, which is always noise. */
    return v.replace(/^["']|["']$/g, "").trim();
  }
  function twoDigits(n) {
    var s = String(n);
    return s.length === 1 ? "0" + s : s;
  }

  /* ---------- ID3v2 ---------- */

  /* Friendly name -> frame id. The ids differ between 2.2 (3 chars) and
     2.3/2.4 (4 chars), and 2.4 moved the year into TDRC. Cover art is the
     APIC frame (PIC in 2.2). */
  function frameMap(major) {
    if (major === 2) return { title: "TT2", artist: "TP1", album: "TAL", track: "TRK", year: "TYE", cover: "PIC" };
    if (major === 4) return { title: "TIT2", artist: "TPE1", album: "TALB", track: "TRCK", year: "TDRC", cover: "APIC" };
    return { title: "TIT2", artist: "TPE1", album: "TALB", track: "TRCK", year: "TYER", cover: "APIC" };
  }

  function parseId3v2(bytes) {
    var major = bytes[3];
    var flags = bytes[5];
    var size = syncsafe(bytes, 6);
    var start = 10;
    if (flags & 0x40 && major >= 3) {
      /* Extended header: its own size field, syncsafe in 2.4. */
      start += major === 4 ? syncsafe(bytes, start) : be32(bytes, start) + 4;
    }
    var out = {};
    var map = frameMap(major);
    var ids = {};
    Object.keys(map).forEach(function (k) { ids[map[k]] = k; });
    var at = start;
    var limit = Math.min(bytes.length, size + 10);
    while (at + 6 <= limit) {
      var id = ascii(bytes, at, major === 2 ? 3 : 4);
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
      var frameSize;
      if (major === 2) frameSize = (bytes[at + 3] << 16) | (bytes[at + 4] << 8) | bytes[at + 5];
      else if (major === 4) frameSize = syncsafe(bytes, at + 4);
      else frameSize = be32(bytes, at + 4);
      var headerLen = major === 2 ? 6 : 10;
      var body = at + headerLen;
      if (!(frameSize > 0) || body + frameSize > limit) break;
      var kind = ids[id];
      if (kind) {
        if (kind === "cover") {
          var enc = bytes[body];
          var p = body + 1;
          var mime;
          if (major === 2) mime = "image/" + ascii(bytes, p, 3).toLowerCase();
          else {
            var mEnd = p;
            while (mEnd < body + frameSize && bytes[mEnd] !== 0) mEnd++;
            mime = latin1(bytes.subarray(p, mEnd)) || "image/jpeg";
            p = mEnd + 1;
          }
          p += 1;   /* picture type */
          /* Description: null-terminated in the frame's own encoding. */
          if (enc === 1 || enc === 2) {
            while (p + 1 < body + frameSize && !(bytes[p] === 0 && bytes[p + 1] === 0)) p += 2;
            p += 2;
          } else {
            while (p < body + frameSize && bytes[p] !== 0) p++;
            p += 1;
          }
          if (p < body + frameSize) {
            out.cover = new Blob([bytes.subarray(p, body + frameSize)], { type: mime || "image/jpeg" });
          }
        } else {
          out[kind] = decodeText(bytes.subarray(body + 1, body + frameSize), bytes[body]);
        }
      }
      at = body + frameSize;
    }
    return out;
  }

  function parseId3v1(bytes) {
    /* The last 128 bytes of the file, if the file is long enough to have them. */
    if (bytes.length < 128) return {};
    var at = bytes.length - 128;
    if (ascii(bytes, at, 3) !== "TAG") return {};
    /* ID3v1.1 squeezed the track number into the comment area: byte 125 is a
       zero marker and byte 126 is the number. Older tags leave it at zero. */
    var track = 0;
    if (bytes[at + 125] === 0 && bytes[at + 126] > 0) track = bytes[at + 126];
    return {
      title: latin1(bytes.subarray(at + 3, at + 33)),
      artist: latin1(bytes.subarray(at + 33, at + 63)),
      album: latin1(bytes.subarray(at + 63, at + 93)),
      year: latin1(bytes.subarray(at + 93, at + 97)),
      comment: latin1(bytes.subarray(at + 97, at + 125)),
      track: track
    };
  }

  /* ---------- FLAC ---------- */

  function parseFlac(bytes) {
    var out = {};
    var at = 4;
    while (at + 4 <= bytes.length) {
      var header = bytes[at];
      var last = (header & 0x80) !== 0;
      var type = header & 0x7f;
      var len = (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
      var body = at + 4;
      if (body + len > bytes.length) break;
      if (type === 4) {           /* VORBIS_COMMENT */
        var p = body;
        var vendorLen = le32(bytes, p); p += 4 + vendorLen;
        var count = le32(bytes, p); p += 4;
        for (var i = 0; i < count && p + 4 <= body + len; i++) {
          var clen = le32(bytes, p); p += 4;
          if (p + clen > body + len) break;
          var pair = utf8(bytes.subarray(p, p + clen));
          p += clen;
          var eq = pair.indexOf("=");
          if (eq < 0) continue;
          var key = pair.slice(0, eq).toUpperCase();
          var value = pair.slice(eq + 1);
          if (key === "TITLE") out.title = value;
          else if (key === "ARTIST") out.artist = value;
          else if (key === "ALBUM") out.album = value;
          else if (key === "TRACKNUMBER") out.track = value;
          else if (key === "DATE") out.year = value;
        }
      } else if (type === 6 && !out.cover) {   /* PICTURE */
        var q = body;
        q += 4;                                     /* picture type */
        var mimeLen = be32(bytes, q); q += 4;
        var mime = ascii(bytes, q, mimeLen); q += mimeLen;
        var descLen = be32(bytes, q); q += 4 + descLen;
        q += 16;                                    /* w, h, depth, colours */
        var dataLen = be32(bytes, q); q += 4;
        if (dataLen > 0 && q + dataLen <= body + len) {
          out.cover = new Blob([bytes.subarray(q, q + dataLen)], { type: mime || "image/jpeg" });
        }
      }
      at = body + len;
      if (last) break;
    }
    return out;
  }

  /* ---------- MP4 / M4A (iTunes ilst) ---------- */

  var MP4_KEYS = {
    "\u00a9nam": "title", "\u00a9ART": "artist", "aART": "albumArtist",
    "\u00a9alb": "album", "\u00a9day": "year", "trkn": "track", "covr": "cover"
  };
  var ATOM_CONTAINERS = { moov: 1, udta: 1, meta: 1, ilst: 1, trak: 1, mdia: 1, minf: 1, stbl: 1 };

  function parseMp4(bytes) {
    var out = {};
    function walk(start, end, depth) {
      if (depth > 6) return;
      var at = start;
      while (at + 8 <= end) {
        var size = be32(bytes, at);
        var type = ascii(bytes, at + 4, 4);
        var header = 8;
        if (size === 1) { size = be32(bytes, at + 8) * 4294967296 + be32(bytes, at + 12); header = 16; }
        else if (size === 0) size = end - at;
        if (size < header || at + size > end) return;
        var body = at + header;
        if (type === "meta") { walk(body + 4, at + size, depth + 1); }
        else if (ATOM_CONTAINERS[type]) { walk(body, at + size, depth + 1); }
        else if (MP4_KEYS[type]) {
          /* Each ilst entry holds a `data` atom: size, 'data', version+flags,
             locale, then the payload. */
          var p = body;
          while (p + 16 <= at + size) {
            var dsize = be32(bytes, p);
            if (dsize < 16 || p + dsize > at + size) break;
            if (ascii(bytes, p + 4, 4) === "data") {
              var dtype = be32(bytes, p + 8) & 0x00ffffff;
              var payload = p + 16;
              var plen = dsize - 16;
              var key = MP4_KEYS[type];
              if (key === "cover") {
                if (!out.cover && plen > 0) {
                  out.cover = new Blob([bytes.subarray(payload, payload + plen)], { type: dtype === 14 ? "image/png" : "image/jpeg" });
                }
              } else if (key === "track") {
                if (plen >= 4) out.track = String((bytes[payload + 2] << 8) | bytes[payload + 3]);
              } else {
                out[key] = utf8(bytes.subarray(payload, payload + plen));
              }
            }
            p += dsize;
          }
        }
        at += size;
      }
    }
    walk(0, bytes.length, 0);
    return out;
  }

  /* ---------- filename fallback ---------- */

  function fromFilename(name) {
    var base = String(name || "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " ");
    var track = "";
    var m = /^(\d{1,2})[\s.\-]+(.+)$/.exec(base);
    if (m) { track = m[1]; base = m[2]; }
    var parts = base.split(/\s+-\s+/);
    if (parts.length >= 2) {
      return { title: tidy(parts.slice(1).join(" - ")), artist: tidy(parts[0]), track: track };
    }
    return { title: tidy(base), track: track };
  }

  /* ---------- tag reading ---------- */

  async function readPrefix(file, limit) {
    var end = Math.min(file.size, limit || TAG_READ_BYTES);
    return new Uint8Array(await file.slice(0, end).arrayBuffer());
  }

  async function readTags(file) {
    var tags = {};
    try {
      var head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      /* "ID3" is three characters followed by the version bytes, so compare
         three - reading four and comparing to "ID3" never matches. */
      var magic3 = ascii(head, 0, Math.min(head.length, 3));
      var magic4 = ascii(head, 0, Math.min(head.length, 4));
      if (magic3 === "ID3" && head.length >= 10) {
        var size = syncsafe(head, 6);
        tags = parseId3v2(new Uint8Array(await file.slice(0, Math.min(file.size, size + 10)).arrayBuffer()));
        /* Plenty of MP3s carry a stub ID3v2 (or only the artwork) and keep the
           real text in the 128-byte ID3v1 trailer, so always take a look. */
        if (!tags.title || !tags.artist || !tags.album) {
          var v1 = parseId3v1(new Uint8Array(await file.slice(Math.max(0, file.size - 128)).arrayBuffer()));
          Object.keys(v1).forEach(function (k) { if (!tags[k] && v1[k]) tags[k] = v1[k]; });
        }
      } else if (magic4 === "fLaC") {
        tags = parseFlac(await readPrefix(file));
      } else if (ascii(head, 4, 4) === "ftyp") {
        tags = parseMp4(await readPrefix(file));
      } else {
        /* No modern tag at all. Plenty of MP3s from the 2000s carry only the
           128-byte ID3v1 trailer, so ask for that before giving up and using
           the filename. */
        var v1only = parseId3v1(new Uint8Array(await file.slice(Math.max(0, file.size - 128)).arrayBuffer()));
        Object.keys(v1only).forEach(function (k) { if (!tags[k] && v1only[k]) tags[k] = v1only[k]; });
      }
    } catch (e) { tags = {}; }

    var name = fromFilename(file.name || "");
    var title = clean(tags.title) || name.title || "Untitled";
    var artist = clean(tags.artist) || name.artist || "Unknown artist";
    var album = clean(tags.album) || "";
    var track = String(clean(tags.track) || name.track || "").replace(/^0+(?=\d)/, "");
    return {
      title: title,
      artist: artist,
      album: album,
      track: track ? parseInt(track, 10) || 0 : 0,
      year: clean(tags.year) || "",
      cover: tags.cover || null
    };
  }

  /* ---------- IndexedDB ---------- */

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("no indexeddb")); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("album", "album", { unique: false });
          store.createIndex("addedAt", "addedAt", { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("indexeddb open failed")); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out = fn(store);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  /* One place that decides which object URLs should exist: every stored track
     gets one for its audio and, when it has art, one more keyed "<id>-art" so
     the cover can be revoked alongside the track instead of leaking. */
  function refreshViews() {
    var live = {};
    records.forEach(function (r) {
      live[r.id] = true;
      if (r.cover) live[r.id + "-art"] = true;
      if (!views[r.id]) {
        try { views[r.id] = URL.createObjectURL(r.blob); } catch (e) { views[r.id] = ""; }
      }
      if (r.cover && !views[r.id + "-art"]) {
        try { views[r.id + "-art"] = URL.createObjectURL(r.cover); } catch (e) { views[r.id + "-art"] = ""; }
      }
    });
    Object.keys(views).forEach(function (key) {
      if (live[key]) return;
      try { URL.revokeObjectURL(views[key]); } catch (e) { /* already gone */ }
      delete views[key];
    });
  }

  function loadAll() {
    return tx("readonly", function (store) {
      var out = [];
      store.openCursor().onsuccess = function (e) {
        var cur = e.target.result;
        if (!cur) return;
        out.push(cur.value);
        cur.continue();
      };
      return { get result() { return out; } };
    }).then(function (rows) {
      records = (rows || []).sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
      refreshViews();
      return records;
    }).catch(function () { return records; });
  }

  /* Same file already imported? Name plus size is enough to stop the common
     "I dragged the same folder in twice" duplicate without hashing megabytes. */
  function duplicateOf(name, size) {
    var key = String(name) + "\u0000" + String(size);
    for (var i = 0; i < records.length; i++) {
      if (String(records[i].name) + "\u0000" + String(records[i].size) === key) return records[i];
    }
    return null;
  }

  async function add(files, onProgress) {
    var list = Array.prototype.slice.call(files || []);
    var added = [], skipped = 0, failed = 0;
    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      if (onProgress) { try { onProgress(i, list.length, file.name); } catch (e) { /* caller's problem */ } }
      if (!file || !file.size) { failed++; continue; }
      if (!/^audio\//.test(file.type || "") && !/\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|weba|webm|mp4)$/i.test(file.name || "")) { skipped++; continue; }
      if (duplicateOf(file.name, file.size)) { skipped++; continue; }
      var tags;
      try { tags = await readTags(file); } catch (e) { tags = null; }
      if (!tags) { failed++; continue; }
      var record = {
        id: "loc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        name: file.name || "track",
        size: file.size,
        type: file.type || "audio/mpeg",
        addedAt: Date.now(),
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        track: tags.track,
        year: tags.year,
        cover: tags.cover,
        blob: file
      };
      try {
        await tx("readwrite", function (store) { store.put(record); return { result: 1 }; });
        records.unshift(record);
        added.push(record);
      } catch (e) { failed++; }
    }
    refreshViews();
    if (onProgress) { try { onProgress(list.length, list.length, ""); } catch (e) { /* done */ } }
    return { added: added, skipped: skipped, failed: failed, total: list.length };
  }

  function remove(id) {
    return tx("readwrite", function (store) { store.delete(id); return { result: 1 }; }).then(function () {
      records = records.filter(function (r) { return r.id !== id; });
      refreshViews();
    }).catch(function () { /* nothing stored */ });
  }

  function clear() {
    return tx("readwrite", function (store) { store.clear(); return { result: 1 }; }).then(function () {
      records = [];
      refreshViews();
    }).catch(function () { records = []; refreshViews(); });
  }

  /* ---------- shapes the Music tab already understands ---------- */

  /* A local track is dressed as a catalog entry: the Music tab's rows, queue,
     album grouping, save button and player all key off these fields, so a local
     song gets the same treatment as a streamed one without any of them
     knowing this module exists. */
  function toTrack(record) {
    return {
      id: record.id,
      name: record.title || fromFilename(record.name).title || record.name,
      artist: [record.artist || "Unknown artist"],
      album: record.album || "Singles",
      track: record.track || 0,
      duration: 0,
      source: "device",
      _local: true,
      _localId: record.id,
      _localUrl: views[record.id] || "",
      _localName: record.name,
      _cover: views[record.id + "-art"] || "",
      views: 0
    };
  }

  function tracks() {
    return records.map(toTrack);
  }

  function albums() {
    var groups = {};
    records.forEach(function (r) {
      var album = r.album || "Singles";
      var artist = r.artist || "Unknown artist";
      var key = album + "\u0000" + artist;
      if (!groups[key]) groups[key] = { album: album, artist: artist, records: [] };
      groups[key].records.push(r);
    });
    return Object.keys(groups).map(function (key) {
      var g = groups[key];
      g.records.sort(function (a, b) { return (a.track || 0) - (b.track || 0) || String(a.name).localeCompare(String(b.name)); });
      g.tracks = g.records.map(toTrack);
      g.cover = g.records[0] && g.records[0].cover ? views[g.records[0].id + "-art"] || "" : "";
      return g;
    });
  }

  var readyPromise = loadAll();

  function ready() {
    return (readyPromise || Promise.resolve(records)).then(function () { return records; });
  }

  window.ChalkleLocalMusic = {
    ready: ready,
    list: function () { return records.slice(); },
    tracks: tracks,
    albums: albums,
    add: add,
    remove: remove,
    clear: clear,
    count: function () { return records.length; },
    byId: function (id) {
      var hit = null;
      records.forEach(function (r) { if (r.id === id) hit = r; });
      return hit;
    },
    /* Exposed for the tests: parses one file without touching IndexedDB. */
    readTags: readTags
  };
})();
