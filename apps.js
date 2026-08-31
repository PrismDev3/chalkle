/* Chalkle Apps/Tools. Built-in apps + tools - the full list lives in your saved
   library (Settings → Admin, code: jamesypoo) so you can add, edit and delete
   from the Tools tab too. Blank Tab (launcher) and HTML Editor are built-in
   apps: they open their own modal via kind, not a URL. */

window.ChalkApps = [
  {
    title: "Browser",
    kind: "browser",
    category: "Built-in",
    thumb: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%234285f4%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%232a7d44%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2232%22%20r%3D%2218%22%20fill%3D%22none%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%223.5%22%2F%3E%3Cellipse%20cx%3D%2232%22%20cy%3D%2232%22%20rx%3D%227%22%20ry%3D%2218%22%20fill%3D%22none%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%223%22%2F%3E%3Cpath%20d%3D%22M14%2032h36%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%223%22%2F%3E%3C%2Fsvg%3E"
  },
  {
    title: "Blank Tab",
    kind: "launcher",
    category: "Built-in",
    thumb: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%2334a853%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%232a7d44%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22url(%23g)%22%2F%3E%3Crect%20x%3D%2214%22%20y%3D%2214%22%20width%3D%2236%22%20height%3D%2236%22%20rx%3D%226%22%20fill%3D%22none%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%223.5%22%2F%3E%3Cpath%20d%3D%22M26%2038l10-6-10-6z%22%20fill%3D%22%230c1210%22%2F%3E%3C%2Fsvg%3E"
  },
  {
    title: "HTML Editor",
    kind: "editor",
    category: "Built-in",
    thumb: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22b%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%234285f4%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%233a6bd6%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22url(%23b)%22%2F%3E%3Cpath%20d%3D%22M24%2018L14%2032l10%2014M40%2018l10%2014-10%2014%22%20fill%3D%22none%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%225%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E",
  },
  {
    title: "Domain Hub",
    kind: "domainhub",
    category: "Built-in",
    thumb: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%2326c6da%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23a970ff%22%2F%3E%3C%2FlinearGradient%3E%3Cdefs%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2232%22%20r%3D%2216%22%20fill%3D%22none%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%223.5%22%2F%3E%3Cpath%20d%3D%22M16%2020h32M16%2032h32M16%2044h32M32%2032v-16M32%2032v16%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%222.6%22%20stroke-linecap%3D%22round%22%2F%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2232%22%20r%3D%224%22%20fill%3D%22%230c1210%22%2F%3E%3C%2Fsvg%3E"
  },
  {
    title: "URL Auditor",
    kind: "urlauditor",
    category: "Built-in",
    thumb: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22a%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%234285f4%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%2334a853%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22url(%23a)%22%2F%3E%3Ccircle%20cx%3D%2227%22%20cy%3D%2228%22%20r%3D%228%22%20fill%3D%22none%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%223.4%22%2F%3E%3Cpath%20d%3D%22M33%2034l8%208%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%223.4%22%20stroke-linecap%3D%22round%22%2F%3E%3Cpath%20d%3D%22M20%2046h24%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%223%22%20stroke-linecap%3D%22round%22%20opacity%3D%220.8%22%2F%3E%3Cpath%20d%3D%22M22%2046v-6M28%2046v-2M34%2046v-8M40%2046v-4%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%222.6%22%20opacity%3D%220.6%22%2F%3E%3C%2Fsvg%3E"
  },
  {
    title: "iPhone 16",
    url: "/game-builds/iphone16/index.html",
    kind: "iphone16",
    category: "Emulator",
    thumb: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20128%20128%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22b%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23e8ebf0%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23818a97%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%0A%3Crect%20width%3D%22128%22%20height%3D%22128%22%20rx%3D%2228%22%20fill%3D%22url(%23b)%22%2F%3E%0A%3Crect%20x%3D%2234%22%20y%3D%2222%22%20width%3D%2260%22%20height%3D%2284%22%20rx%3D%2214%22%20fill%3D%22%23070910%22%20stroke%3D%22%23343a44%22%20stroke-width%3D%222%22%2F%3E%0A%3Crect%20x%3D%2254%22%20y%3D%2228%22%20width%3D%2220%22%20height%3D%226%22%20rx%3D%223%22%20fill%3D%22%23000%22%2F%3E%0A%3Ccircle%20cx%3D%2264%22%20cy%3D%2234%22%20r%3D%225%22%20fill%3D%22%23000%22%20stroke%3D%22%23505a66%22%20stroke-width%3D%221.5%22%2F%3E%0A%3Crect%20x%3D%2241%22%20y%3D%2248%22%20width%3D%2246%22%20height%3D%2238%22%20rx%3D%225%22%20fill%3D%22%230a1226%22%2F%3E%0A%3Crect%20x%3D%2258%22%20y%3D%2255%22%20width%3D%2212%22%20height%3D%2214%22%20rx%3D%222%22%20fill%3D%22%230a84ff%22%2F%3E%0A%3Crect%20x%3D%2274%22%20y%3D%2255%22%20width%3D%2212%22%20height%3D%2214%22%20rx%3D%222%22%20fill%3D%22%2364d2ff%22%2F%3E%0A%3Crect%20x%3D%2250%22%20y%3D%22100%22%20width%3D%2228%22%20height%3D%222%22%20rx%3D%221%22%20fill%3D%22%23262b33%22%2F%3E%3C%2Fsvg%3E"
  },
  {
    title: "ExtHang3r",
    url: "https://raw.githack.com/Blobby-Boi/ExtHang3r/main/index.html",
    thumb: "/assets/games/t_7a613c9bc8.jpg",
    category: "School"
  },
  {
    title: "ExtPrint3r",
    url: "https://raw.githack.com/Blobby-Boi/ExtPrint3r/main/index.html",
    thumb: "/assets/games/t_cc6a8ac422.jpg",
    category: "School"
  },
  {
    title: "Mask3r",
    url: "https://raw.githack.com/Blobby-Boi/Mask3r/main/index.html",
    thumb: "/assets/games/t_5262713269.jpg",
    category: "School"
  },
  {
    title: "Data URL Generator",
    url: "https://raw.githack.com/Blobby-Boi/data-URL-Generator/main/index.html",
    thumb: "/assets/games/t_e13a04bb1b.jpg",
    category: "School"
  },
  {
    title: "Godot 3.7",
    url: "https://truffled.lol/tools/godot/godot.tools.html",
    thumb: "/assets/games/t_42e663fed8.jpg",
    category: "Engine"
  },
  {
    title: "Firefox",
    url: "https://truffled.lol/tools/firefox/index.html",
    thumb: "/assets/games/t_97d641440f.jpg",
    category: "Browser"
  },
  {
    title: "Ruffle",
    url: "https://truffled.lol/tools/ruffle.html",
    thumb: "/assets/games/t_0e44d1c8b2.jpg",
    category: "Emulator"
  },
  {
    title: "GUST",
    url: "/game-builds/gust/index.html",
    thumb: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%234285f4%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%232a6fb0%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22url(%23g)%22%2F%3E%3Crect%20x%3D%2214%22%20y%3D%2212%22%20width%3D%2236%22%20height%3D%2228%22%20rx%3D%224%22%20fill%3D%22none%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%223.5%22%2F%3E%3Cpath%20d%3D%22M27%2022l8%205-8%205z%22%20fill%3D%22%230c1210%22%2F%3E%3Cpath%20d%3D%22M24%2048h16M20%2043h24%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%223%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E",
    category: "Browser"
  },
  {
    title: "Discord",
    url: "/game-builds/discord/index.html",
    thumb: "/assets/games/t_1eb6d96c44.jpg",
    category: "Social"
  },
  {
    title: "N64",
    url: "https://truffled.lol/tools/n64.html",
    thumb: "/assets/games/t_5b609296df.jpg",
    category: "Emulator"
  },
  {
    title: "Azahar",
    url: "/game-builds/azahar/index.html",
    thumb: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%0A%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23ff7a45%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23e2378c%22%2F%3E%3C%2FlinearGradient%3E%0A%3ClinearGradient%20id%3D%22s%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%237ff0e0%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%233aa0ff%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%0A%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22url(%23g)%22%2F%3E%0A%3Crect%20x%3D%2214%22%20y%3D%229%22%20width%3D%2236%22%20height%3D%2223%22%20rx%3D%225%22%20fill%3D%22%23140c1e%22%20stroke%3D%22rgba(0%2C0%2C0%2C0.35)%22%20stroke-width%3D%222%22%2F%3E%0A%3Crect%20x%3D%2218%22%20y%3D%2213%22%20width%3D%2213%22%20height%3D%2210%22%20rx%3D%221.5%22%20fill%3D%22url(%23s)%22%2F%3E%0A%3Crect%20x%3D%2233%22%20y%3D%2213%22%20width%3D%2213%22%20height%3D%2210%22%20rx%3D%221.5%22%20fill%3D%22url(%23s)%22%2F%3E%0A%3Crect%20x%3D%2214%22%20y%3D%2235%22%20width%3D%2236%22%20height%3D%2215%22%20rx%3D%225%22%20fill%3D%22%23140c1e%22%20stroke%3D%22rgba(0%2C0%2C0%2C0.35)%22%20stroke-width%3D%222%22%2F%3E%0A%3Crect%20x%3D%2218%22%20y%3D%2239%22%20width%3D%2228%22%20height%3D%227%22%20rx%3D%222%22%20fill%3D%22url(%23s)%22%2F%3E%0A%3Ccircle%20cx%3D%2222%22%20cy%3D%2246%22%20r%3D%221.4%22%20fill%3D%22%23fff%22%2F%3E%3Ccircle%20cx%3D%2242%22%20cy%3D%2246%22%20r%3D%221.4%22%20fill%3D%22%23fff%22%2F%3E%0A%3Cpath%20d%3D%22M27%2035v-3M37%2035v-3%22%20stroke%3D%22%23140c1e%22%20stroke-width%3D%222.5%22%20stroke-linecap%3D%22round%22%2F%3E%0A%3C%2Fsvg%3E",
    category: "Emulator"
  },

  {
    title: "Tierlist Maker",
    url: "https://truffled.lol/extra/baddies.html",
    thumb: "/assets/games/t_9836f26bca.jpg",
    category: "Create"
  },
  {
    title: "Play.js",
    url: "https://truffled.lol/tools/playjs/index.html",
    thumb: "/assets/games/t_af653b8d76.jpg",
    category: "Code",
    category: "Code"
  },
  {
    title: "Aseprite",
    kind: "pixel",
    category: "Create",
    thumb: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22a%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23ff7a45%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23ff3b6e%22%2F%3E%3C%2FlinearGradient%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22url(%23a)%22%2F%3E%3Cg%20transform%3D%22translate(10%2C10)%22%3E%3Crect%20width%3D%2244%22%20height%3D%2244%22%20fill%3D%22%23fff%22%20opacity%3D%220.92%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%220%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%23222%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%220%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%23fff%22%2F%3E%3Crect%20x%3D%2222%22%20y%3D%220%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%23222%22%2F%3E%3Crect%20x%3D%2233%22%20y%3D%220%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%23fff%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%2211%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%23fff%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%2211%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%2334a853%22%2F%3E%3Crect%20x%3D%2222%22%20y%3D%2211%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%23fff%22%2F%3E%3Crect%20x%3D%2233%22%20y%3D%2211%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%2334a853%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%2222%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%23fff%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%2222%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%2334a853%22%2F%3E%3Crect%20x%3D%2222%22%20y%3D%2222%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%23fff%22%2F%3E%3Crect%20x%3D%2233%22%20y%3D%2222%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%23fff%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%2233%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%23fff%22%2F%3E%3Crect%20x%3D%2211%22%20y%3D%2233%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%23fff%22%2F%3E%3Crect%20x%3D%2222%22%20y%3D%2233%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%23fff%22%2F%3E%3Crect%20x%3D%2233%22%20y%3D%2233%22%20width%3D%2211%22%20height%3D%2211%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E"
  }
];

/* Proxy apps - these open through your configured UV/Scramjet proxy instead of
   hitting the real domain directly, so TikTok, Discord, etc. stay reachable
   past the filter. Add/remove them from the Admin panel like any app; set
   via to "proxy" and give the real site URL under "url".

   The thumbnails are the sites' own favicons so they always resolve. If you
   have prettier brand art handy, swap the thumb to any image URL. */

window.ChalkProxyApps = [
  { title: "TikTok", target: "https://www.tiktok.com/", via: "proxy", category: "Social", thumb: "/assets/games/t_71302612aa.jpg" },
  { title: "Reddit", target: "https://www.reddit.com/", via: "proxy", category: "Social", thumb: "/assets/games/t_0d19af5116.jpg" },
  { title: "Instagram", target: "https://www.instagram.com/", via: "proxy", category: "Social", thumb: "/assets/games/t_393dd219e3.jpg" },
  { title: "Snapchat", target: "https://web.snapchat.com/", via: "proxy", category: "Social", thumb: "/assets/games/t_3b262d63d2.jpg" },
  { title: "X (Twitter)", target: "https://twitter.com/home", via: "proxy", category: "Social", thumb: "/assets/games/t_8c05109a36.jpg" },
  { title: "Twitch", target: "https://www.twitch.tv/", via: "proxy", category: "Streaming", thumb: "/assets/games/t_2274376e88.jpg" },
  { title: "Netflix", target: "https://www.netflix.com/", via: "proxy", category: "Streaming", thumb: "/assets/games/t_13e0fe9f1b.jpg" },
  { title: "Spotify", target: "https://open.spotify.com/", via: "proxy", category: "Music", thumb: "/assets/games/t_6db1408eb5.jpg" },
  { title: "YouTube", target: "https://www.youtube.com/", via: "proxy", category: "Video", thumb: "/assets/games/t_3822f0920c.jpg" },
  { title: "GitHub", target: "https://github.com/", via: "proxy", category: "Dev", thumb: "/assets/games/t_bdebb488ce.jpg" },
  { title: "Chess.com", target: "https://www.chess.com/", via: "proxy", category: "Games", thumb: "/assets/games/t_2836721094.jpg" }
];
