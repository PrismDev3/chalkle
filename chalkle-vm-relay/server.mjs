/* Chalkle VM wisp relay.
   The VM (Puter firefox-wasm) opens its networking through a wisp WebSocket.
   This little server exposes @mercuryworkshop/wisp-js at /wisp/ on loopback;
   serve-chalk.py forwards /wisp/* WebSocket upgrades here (same pattern as
   the cloud signaling relay), so the public site only ever talks to this
   origin. */
import http from "node:http";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const PORT = Number(process.env.WISP_PORT || 3002);

logging.set_level(process.env.WISP_DEBUG === "1" ? logging.INFO : logging.ERROR);
wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;
wisp.options.allow_direct_ip = false;
wisp.options.port_whitelist = [80, 443, 8080, 8443];
wisp.options.stream_limit_per_host = 16;
wisp.options.stream_limit_total = 64;
wisp.options.dns_ttl = 300;
wisp.options.dns_result_order = "ipv4first";

const server = http.createServer((req, res) => {
  /* Health endpoint for the relay probe. */
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "chalkle-vm-wisp" }));
    return;
  }
  res.writeHead(426).end("Upgrade Required");
});

server.on("upgrade", (req, socket, head) => {
  const url = req.url || "/";
  /* Accept anything; the VM always asks for /wisp/. Normalize so wisp-js
     sees the route it expects. */
  if (!url.startsWith("/wisp/")) {
    req.url = "/wisp/" + url.replace(/^\/+/, "");
  }
  wisp.routeRequest(req, socket, head);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[chalkle-vm-wisp] listening on 127.0.0.1:${PORT} (route /wisp/)`);
});
