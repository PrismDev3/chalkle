// Chalkle backup relay. Passes every request straight through to the primary
// relay (chalkle.lootline.xyz). Deployed on *.workers.dev so a network that
// blocks the primary domain (or its tunnel) still reaches the same backend
// through Cloudflare's edge.
//
// Design notes:
// - Pure passthrough: no caching, no body buffering. HLS segments and game
//   assets stream unchanged.
// - CORS stays permissive (the primary already answers OPTIONS with *; we
//   re-set allow-origin defensively in case an origin response lacks it).
// - Redirects to the primary origin are rewritten to this worker's origin so
//   clients keep talking to the backup they reached.
// - WebSocket upgrades (cloud gaming signal, /uv ws) pass through untouched.

const ORIGIN = "https://chalkle.lootline.xyz";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const upstream = ORIGIN + url.pathname + url.search;

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const init = {
      method: request.method,
      headers: request.headers,
      redirect: "manual",
      body: hasBody ? request.body : undefined,
    };
    if (hasBody && request.body) init.duplex = "half";

    let resp;
    try {
      resp = await fetch(upstream, init);
    } catch (e) {
      return new Response("backup relay could not reach the primary", {
        status: 502,
        headers: { "access-control-allow-origin": "*", "content-type": "text/plain" },
      });
    }

    const headers = new Headers(resp.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    headers.set("access-control-allow-origin", "*");

    const loc = headers.get("location");
    if (loc && loc.indexOf(ORIGIN) === 0) {
      headers.set("location", url.origin + loc.slice(ORIGIN.length));
    }

    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
  },
};
