/* Chalkle data. Sites and proxy apps route through the proxy below so the tab
   only ever talks to this origin - never the blocked domain. Both built-in
   routes ("Scramjet" and "Ultraviolet") point at the same-origin /res/
   rewriting relay served by this site's own server: it fetches the target
   server-side, rewrites the HTML/CSS so every URL flows back through /res/,
   and injects a tiny client patch for runtime fetch/XHR/WebSocket calls.

   Route format:  <proxy-url>/<hex(real-url)>

   Because /res/ lives on this same origin (not a throwaway tunnel), there is
   nothing separate for a filter to block and the URL can never go stale. */

window.ChalkProxies = [
  /* Hosted Scramjet-style instance (hash route + service worker). */
  { name: "GJSD", url: "https://gjsd.yan.ch/", mode: "frame", icon: "/assets/proxies/gjsd.png" },
  /* Hosted Scramjet-style instance, credit kelvin9rant. */
  { name: "Ovokee", url: "https://ovokee.sbs/", mode: "frame", credit: "kelvin9rant", icon: "/assets/proxies/ovokee.png" },
  /* SerumOS on Bunny CDN (hash route + service worker), credit c0mrade.
     Older builds listed 20 numbered mirrors of the same proxy; keep one. */
  { name: "Serium", url: "https://swiftnet8420.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium-01.svg" }
];