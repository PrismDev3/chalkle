/* Chalkle Apps/Tools. Built-in apps + tools - the full list lives in your saved
   library (Settings → Admin, code: jamesypoo) so you can add, edit and delete
   from the Tools tab too. Blank Tab (launcher) and HTML Editor are built-in
   apps: they open their own modal via kind, not a URL. */

window.ChalkApps = [
  {
    /* The Unsent Project archive rebuilt as one offline page (unsent.html).
       Local path, so there is no external host to block and nothing leaves
       the device: the posts are bundled, search runs in the page. */
    title: "Unsent Project",
    url: "/unsent.html",
    category: "Archive",
    note: "Offline copy",
    thumb: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23f4f4f5'/%3E%3Crect x='7' y='9' width='50' height='46' rx='4' fill='%23ffffff' stroke='%230c1210' stroke-width='2.4'/%3E%3Crect x='11' y='27' width='42' height='23' rx='2' fill='%23f97724'/%3E%3Crect x='11' y='15' width='24' height='6' rx='3' fill='%230c1210'/%3E%3Crect x='17' y='33' width='30' height='3' rx='1.5' fill='%23ffffff'/%3E%3Crect x='17' y='39' width='24' height='3' rx='1.5' fill='%23ffffff'/%3E%3Crect x='17' y='44' width='28' height='3' rx='1.5' fill='%23ffffff'/%3E%3C/svg%3E"
  },
  {
    title: "Cobalt",
    url: "https://cobalt.tools/",
    category: "Downloader",
    thumb: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230047ab'/%3E%3Cpath d='M32 14v20' stroke='%23e8eaed' stroke-width='6' stroke-linecap='round'/%3E%3Cpath d='M22 26l10 10 10-10' fill='none' stroke='%23e8eaed' stroke-width='6' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M18 44h28' stroke='%23e8eaed' stroke-width='6' stroke-linecap='round'/%3E%3C/svg%3E"
  },
  {
    title: "Browser",
    kind: "browser",
    category: "Built-in",
    thumb: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%234285f4%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%232a7d44%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2232%22%20r%3D%2218%22%20fill%3D%22none%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%223.5%22%2F%3E%3Cellipse%20cx%3D%2232%22%20cy%3D%2232%22%20rx%3D%227%22%20ry%3D%2218%22%20fill%3D%22none%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%223%22%2F%3E%3Cpath%20d%3D%22M14%2032h36%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%223%22%2F%3E%3C%2Fsvg%3E"
  },
  {
    title: "Firefox VM",
    kind: "vm",
    category: "Built-in",
    desc: "A real Firefox browser running in your tab, routed through Chalkle.",
    thumb: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23ff9500'/%3E%3Ccircle cx='32' cy='36' r='17' fill='none' stroke='%2312101a' stroke-width='4'/%3E%3Cpath d='M14 22c4-8 12-12 20-10l-6 8z' fill='%2312101a'/%3E%3Ccircle cx='26' cy='33' r='2.5' fill='%2312101a'/%3E%3Ccircle cx='38' cy='33' r='2.5' fill='%2312101a'/%3E%3Cpath d='M25 42c4 3 10 3 14 0' fill='none' stroke='%2312101a' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E"
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
    thumb: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%2326c6da%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23a970ff%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22url(%23g)%22%2F%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2232%22%20r%3D%2216%22%20fill%3D%22none%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%223.5%22%2F%3E%3Cpath%20d%3D%22M16%2020h32M16%2032h32M16%2044h32M32%2032v-16M32%2032v16%22%20stroke%3D%22%230c1210%22%20stroke-width%3D%222.6%22%20stroke-linecap%3D%22round%22%2F%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2232%22%20r%3D%224%22%20fill%3D%22%230c1210%22%2F%3E%3C%2Fsvg%3E"
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
    category: "Emulator",
    note: "Flash player. Load your own .swf file"
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
    category: "Emulator",
    note: "Bring your own ROM (.z64/.n64)"
  },
  {
    title: "Azahar",
    url: "/game-builds/azahar/index.html",
    thumb: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%0A%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23ff7a45%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23e2378c%22%2F%3E%3C%2FlinearGradient%3E%0A%3ClinearGradient%20id%3D%22s%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%237ff0e0%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%233aa0ff%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%0A%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22url(%23g)%22%2F%3E%0A%3Crect%20x%3D%2214%22%20y%3D%229%22%20width%3D%2236%22%20height%3D%2223%22%20rx%3D%225%22%20fill%3D%22%23140c1e%22%20stroke%3D%22rgba(0%2C0%2C0%2C0.35)%22%20stroke-width%3D%222%22%2F%3E%0A%3Crect%20x%3D%2218%22%20y%3D%2213%22%20width%3D%2213%22%20height%3D%2210%22%20rx%3D%221.5%22%20fill%3D%22url(%23s)%22%2F%3E%0A%3Crect%20x%3D%2233%22%20y%3D%2213%22%20width%3D%2213%22%20height%3D%2210%22%20rx%3D%221.5%22%20fill%3D%22url(%23s)%22%2F%3E%0A%3Crect%20x%3D%2214%22%20y%3D%2235%22%20width%3D%2236%22%20height%3D%2215%22%20rx%3D%225%22%20fill%3D%22%23140c1e%22%20stroke%3D%22rgba(0%2C0%2C0%2C0.35)%22%20stroke-width%3D%222%22%2F%3E%0A%3Crect%20x%3D%2218%22%20y%3D%2239%22%20width%3D%2228%22%20height%3D%227%22%20rx%3D%222%22%20fill%3D%22url(%23s)%22%2F%3E%0A%3Ccircle%20cx%3D%2222%22%20cy%3D%2246%22%20r%3D%221.4%22%20fill%3D%22%23fff%22%2F%3E%3Ccircle%20cx%3D%2242%22%20cy%3D%2246%22%20r%3D%221.4%22%20fill%3D%22%23fff%22%2F%3E%0A%3Cpath%20d%3D%22M27%2035v-3M37%2035v-3%22%20stroke%3D%22%23140c1e%22%20stroke-width%3D%222.5%22%20stroke-linecap%3D%22round%22%2F%3E%0A%3C%2Fsvg%3E",
    category: "Emulator",
    note: "3DS emulator. Bring your own ROM"
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
    thumb: "data:image/png;base64,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"
  }
];

/* Proxy apps - these open through your configured UV/Scramjet proxy instead of
   hitting the real domain directly, so TikTok, Discord, etc. stay reachable
   past the filter. Add/remove them from the Admin panel like any app; set
   via to "proxy" and give the real site URL under "url".

   The thumbnails are the sites' own favicons so they always resolve. If you
   have prettier brand art handy, swap the thumb to any image URL. */

window.ChalkProxyApps = [
  { title: "TikTok", target: "https://www.tiktok.com/", via: "proxy", category: "Social", thumb: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23010101'/%3E%3Cg transform='translate(11.2 11.2) scale(1.7333)' fill='%23ffffff'%3E%3Cpath d='M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z'/%3E%3C/g%3E%3C/svg%3E" },
  { title: "Reddit", target: "https://www.reddit.com/", via: "proxy", category: "Social", thumb: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23ff4500'/%3E%3Cg transform='translate(11.2 11.2) scale(1.7333)' fill='%23ffffff'%3E%3Cpath d='M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z'/%3E%3C/g%3E%3C/svg%3E" },
  { title: "Instagram", target: "https://www.instagram.com/", via: "proxy", category: "Social", thumb: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23f09433%22%2F%3E%3Cstop%20offset%3D%220.5%22%20stop-color%3D%22%23dc2743%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23bc1888%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22url%28%23g%29%22%2F%3E%3Crect%20x%3D%2214%22%20y%3D%2214%22%20width%3D%2236%22%20height%3D%2236%22%20rx%3D%2210%22%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-width%3D%225%22%2F%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2232%22%20r%3D%228.5%22%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-width%3D%225%22%2F%3E%3Ccircle%20cx%3D%2243%22%20cy%3D%2221%22%20r%3D%222.8%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fsvg%3E" },
  { title: "Snapchat", target: "https://web.snapchat.com/", via: "proxy", category: "Social", thumb: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23fffc00'/%3E%3Cg transform='translate(11.2 11.2) scale(1.7333)' fill='%2316181c'%3E%3Cpath d='M12.206.793c.99 0 4.347.276 5.93 3.821.529 1.193.403 3.219.299 4.847l-.003.06c-.012.18-.022.345-.03.51.075.045.203.09.401.09.3-.016.659-.12 1.033-.301.165-.088.344-.104.464-.104.182 0 .359.029.509.09.45.149.734.479.734.838.015.449-.39.839-1.213 1.168-.089.029-.209.075-.344.119-.45.135-1.139.36-1.333.81-.09.224-.061.524.12.868l.015.015c.06.136 1.526 3.475 4.791 4.014.255.044.435.27.42.509 0 .075-.015.149-.045.225-.24.569-1.273.988-3.146 1.271-.059.091-.12.375-.164.57-.029.179-.074.36-.134.553-.076.271-.27.405-.555.405h-.03c-.135 0-.313-.031-.538-.074-.36-.075-.765-.135-1.273-.135-.3 0-.599.015-.913.074-.6.104-1.123.464-1.723.884-.853.599-1.826 1.288-3.294 1.288-.06 0-.119-.015-.18-.015h-.149c-1.468 0-2.427-.675-3.279-1.288-.599-.42-1.107-.779-1.707-.884-.314-.045-.629-.074-.928-.074-.54 0-.958.089-1.272.149-.211.043-.391.074-.54.074-.374 0-.523-.224-.583-.42-.061-.192-.09-.389-.135-.567-.046-.181-.105-.494-.166-.57-1.918-.222-2.95-.642-3.189-1.226-.031-.063-.052-.15-.055-.225-.015-.243.165-.465.42-.509 3.264-.54 4.73-3.879 4.791-4.02l.016-.029c.18-.345.224-.645.119-.869-.195-.434-.884-.658-1.332-.809-.121-.029-.24-.074-.346-.119-1.107-.435-1.257-.93-1.197-1.273.09-.479.674-.793 1.168-.793.146 0 .27.029.383.074.42.194.789.3 1.104.3.234 0 .384-.06.465-.105l-.046-.569c-.098-1.626-.225-3.651.307-4.837C7.392 1.077 10.739.807 11.727.807l.419-.015h.06z'/%3E%3C/g%3E%3C/svg%3E" },
  { title: "X (Twitter)", target: "https://twitter.com/home", via: "proxy", category: "Social", thumb: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230b0d10'/%3E%3Cg transform='translate(11.2 11.2) scale(1.7333)' fill='%23ffffff'%3E%3Cpath d='M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z'/%3E%3C/g%3E%3C/svg%3E" },
  { title: "Twitch", target: "https://www.twitch.tv/", via: "proxy", category: "Streaming", thumb: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%239146ff'/%3E%3Cg transform='translate(11.2 11.2) scale(1.7333)' fill='%23ffffff'%3E%3Cpath d='M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z'/%3E%3C/g%3E%3C/svg%3E" },
  { title: "Netflix", target: "https://www.netflix.com/", via: "proxy", category: "Streaming", thumb: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230b0d10'/%3E%3Cg transform='translate(11.2 11.2) scale(1.7333)' fill='%23e50914'%3E%3Cpath d='M5.398 0v.006c3.028 8.556 5.37 15.175 8.348 23.596 2.344.058 4.85.398 4.854.398-2.8-7.924-5.923-16.747-8.487-24zm8.489 0v9.63L18.6 22.951c-.043-7.86-.004-15.913.002-22.95zM5.398 1.05V24c1.873-.225 2.81-.312 4.715-.398v-9.22z'/%3E%3C/g%3E%3C/svg%3E" },
  { title: "Spotify", target: "https://open.spotify.com/", via: "proxy", category: "Music", thumb: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231db954'/%3E%3Cg transform='translate(11.2 11.2) scale(1.7333)' fill='%2310131a'%3E%3Cpath d='M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z'/%3E%3C/g%3E%3C/svg%3E" },
  { title: "YouTube", target: "https://www.youtube.com/", via: "proxy", category: "Video", thumb: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23ff0000'/%3E%3Cg transform='translate(11.2 11.2) scale(1.7333)' fill='%23ffffff'%3E%3Cpath d='M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z'/%3E%3C/g%3E%3C/svg%3E" },
  { title: "GitHub", target: "https://github.com/", via: "proxy", category: "Dev", thumb: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23181717'/%3E%3Cg transform='translate(11.2 11.2) scale(1.7333)' fill='%23ffffff'%3E%3Cpath d='M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'/%3E%3C/g%3E%3C/svg%3E" },
  { title: "Chess.com", target: "https://www.chess.com/", via: "proxy", category: "Games", thumb: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%2381b64c'/%3E%3Cg transform='translate(11.2 11.2) scale(1.7333)' fill='%23ffffff'%3E%3Cpath d='M12 0a3.85 3.85 0 0 0-3.875 3.846A3.84 3.84 0 0 0 9.73 6.969l-2.79 1.85c0 .622.144 1.114.434 1.649H9.83c-.014.245-.014.549-.014.925 0 .025.003.048.006.071-.064 1.353-.507 3.472-3.62 5.842-.816.625-1.423 1.495-1.806 2.533a.33.33 0 0 0-.045.084 8.124 8.124 0 0 0-.39 2.516c0 .1.216 1.561 8.038 1.561s8.038-1.46 8.038-1.561c0-2.227-.824-4.048-2.24-5.133-4.034-3.08-3.586-5.74-3.644-6.838h2.458c.29-.535.434-1.027.434-1.649l-2.79-1.836a3.86 3.86 0 0 0 1.604-3.123A3.873 3.873 0 0 0 13.445.275c-.004-.002-.01.004-.015.004A3.76 3.76 0 0 0 12 0Z'/%3E%3C/g%3E%3C/svg%3E" }
];
