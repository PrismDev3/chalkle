/* Chalkle data. Sites and proxy apps route through the proxy below so the tab
   only ever talks to this origin - never the blocked domain. Both built-in
   routes ("Scramjet" and "Ultraviolet") point at the same-origin /uv/
   rewriting proxy served by this site's own server: it fetches the target
   server-side, rewrites the HTML/CSS so every URL flows back through /uv/,
   and injects a tiny client patch for runtime fetch/XHR/WebSocket calls.

   Route format:  <proxy-url>/<base64url(real-url)>

   Because /uv/ lives on this same origin (not a throwaway tunnel), there is
   nothing separate for a filter to block and the URL can never go stale. */

window.ChalkProxies = [
  /* Hosted Scramjet-style instance (hash route + service worker). */
  { name: "GJSD", url: "https://gjsd.yan.ch/", mode: "frame", icon: "/assets/proxies/gjsd.png" },
  /* Hosted Scramjet-style instance, credit kelvin9rant. */
  { name: "Ovokee", url: "https://ovokee.sbs/", mode: "frame", credit: "kelvin9rant", icon: "/assets/proxies/ovokee.png" },
  /* SerumOS instances on Bunny CDN (hash route + service worker), credit c0mrade. */
  { name: "Serium 1", url: "https://swiftnet8420.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 2", url: "https://clearzone8524.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 3", url: "https://litezone9637.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 4", url: "https://meganet1958.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 5", url: "https://brightlink8769.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 6", url: "https://megaweb8626.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 7", url: "https://swiftgrid8322.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 8", url: "https://nextnet5497.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 9", url: "https://cleanwave3711.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 10", url: "https://cleanzone3531.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 11", url: "https://ultracdn5100.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 12", url: "https://superhost8321.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 13", url: "https://nextbeam4305.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 14", url: "https://megacore4871.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 15", url: "https://swiftcdn8722.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 16", url: "https://superweb7539.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 17", url: "https://boldnet2503.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 18", url: "https://megagrid9752.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 19", url: "https://nextnode6517.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" },
  { name: "Serium 20", url: "https://litesite4767.b-cdn.net/", mode: "frame", credit: "c0mrade", icon: "/assets/proxies/serium.png" }
];
