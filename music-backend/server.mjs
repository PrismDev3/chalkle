/* Chalkle music backend. Thin HTTP wrapper around the vendored Meting core
   (@meting/core, MIT). Exposes the same API surface the site's /music relay
   needs: search / song / playlist / artist / url / lyric / pic. Runs on
   loopback only - the public site reaches it through serve-chalk.py's
   same-origin /music/* relay, so streams stay tunnel-friendly at school.

   Netease refuses to hand out stream urls for VIP-only / region-locked
   tracks; those read back as empty and the player shows them as
   unavailable. Free tracks resolve reliably (bitrate with level param). */

import http from "node:http";
import Meting from "./meting-src/meting.js";

const PORT = Number(process.env.MUSIC_BACKEND_PORT || 3004);
const HOST = "127.0.0.1";
const REQ_TIMEOUT = 28000; // some upstreams (netease api) can be slow

function b64url(src) {
  return Buffer.from(src).toString("base64url");
}

/* Rewrite direct CDN urls out of the response into our own relay so the
   browser only ever talks to the site origin (school-friendly). */
function rewrite(item, route) {
  if (Array.isArray(item)) return item.map((i) => rewrite(i, route));
  if (!item || typeof item !== "object") return item;
  for (const k of Object.keys(item)) {
    const v = item[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) {
      if (k === "url" || k === "stream" || k === "playUrl") {
        const kind = route === "pic" ? "pic" : "stream";
        item[k] = "/music/" + kind + "?u=" + b64url(v);
      } else if (k === "pic" || k === "cover" || k === "pic_big" || k === "pic_small") {
        item[k] = "/music/pic?u=" + b64url(v);
      }
    } else if (v && typeof v === "object") {
      item[k] = rewrite(v, route);
    }
  }
  return item;
}

function picks(p, name, def) {
  const v = p[name];
  return v && String(v).trim() !== "" ? String(v).trim() : def;
}

/* Stream url for a netease song id; never throws. Netease returns an empty
   url for tracks it will not stream here (VIP-only / region-locked) - the
   frontend surfaces those as unavailable instead of hanging on dead
   cross-provider fallbacks (kugou/tencent url endpoints return empty from
   this library build, and public Meting instances do too). */
async function providerUrl(songId, br) {
  try {
    const m = new Meting("netease");
    m.format(true);
    const r = JSON.parse(await m.url(String(songId), br));
    if (r && r.url) return { url: r.url, via: "netease", br };
  } catch (e) { /* unreachable */ }
  return null;
}

async function runRoute(meting, route, p) {
  switch (route) {
    case "search":
      return meting.search(picks(p, "q", "hot"), {
        type: Number(p.type || 1),
        page: 1,
        limit: Math.min(Number(p.limit || 30), 100),
      });
    case "song":
      return meting.song(picks(p, "id"));
    case "playlist":
      return meting.playlist(picks(p, "id"));
    case "artist":
      return meting.artist(picks(p, "id"), Math.min(Number(p.limit || 30), 100));
    case "url": {
      const br = Math.min(Number(p.br || 320), 999);
      const primary = await providerUrl(p.id, br);
      if (primary) return JSON.stringify({ url: primary.url, via: primary.via, sid: p.id, br });
      // Retry low-bitrate once: some tracks only expose a free preview at 128k.
      if (br > 128) {
        const low = await providerUrl(p.id, 128);
        if (low) return JSON.stringify({ url: low.url, via: low.via, sid: p.id, br: 128, preview: true });
      }
      return JSON.stringify({ url: "", size: 0, br: -1 });
    }
    case "lyric":
      return meting.lyric(picks(p, "id"));
    case "pic":
      return meting.pic(picks(p, "id"), Number(p.size || 300));
    default:
      return JSON.stringify({ error: "unknown route: " + route });
  }
}

/* Tiny TTL cache: netease eapi rate-limits per IP, so repeated visits
   (and my own debugging) would throttle the tab. Playlists/search/lyrics
   are stable for minutes; stream urls are signed and short-lived. */
const cache = new Map();
const TTL = {
  url: 45_000, search: 300_000, playlist: 300_000, artist: 300_000,
  song: 300_000, lyric: 600_000, pic: 600_000
};
function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return Promise.resolve(hit.v);
  return Promise.resolve()
    .then(fn)
    .then((v) => {
      cache.set(key, { t: Date.now(), v });
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      return v;
    });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = Object.fromEntries(u.searchParams.entries());
  const route = String(p.path || "").trim();

  if (u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, backend: "meting", port: PORT }));
    return;
  }
  if (u.pathname !== "/api" || !route) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const meting = new Meting(String(p.server || "netease"));
  meting.format(true);
  const key = route + "|" + JSON.stringify(p);
  const ttl = TTL[route] || 60_000;
  try {
    const body = await cached(key, ttl, () =>
      Promise.race([
        runRoute(meting, route, p).then((s) => JSON.parse(s)),
        new Promise((_, rej) => setTimeout(() => rej(new Error("upstream timeout")), REQ_TIMEOUT)),
      ])
    );
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(rewrite(body, route)));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: (e && e.message) || String(e) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log("music backend on http://" + HOST + ":" + PORT);
});