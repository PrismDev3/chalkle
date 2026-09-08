#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

function collectUrls(txt) {
  const urls = [];
  const seen = new Set();
  const re = /https?:\/\/[^\s<>"'()]+/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    let u = m[0];
    if (u.endsWith(".")) u = u.slice(0, -1);
    if (!seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  }
  return urls;
}

function makeListPage(def, urls, max) {
  const shown = urls.slice(0, max);
  const html = [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>" + esc(def.title || "Links") + "</title><style>",
    ":root { --bg: #0c1210; --panel: #121a17; --line: #1f2b27; --tx: #e8f2ee; --tx2: #9db8ae; --tx3: #5f7a70; --ac: #8fd6c2; }",
    "* { box-sizing: border-box; margin: 0; padding: 0; }",
    "body { background: var(--bg); color: var(--tx); font: 14px/1.5 system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif; padding: 28px 20px 60px; min-height: 100vh; }",
    ".wrap { max-width: 880px; margin: 0 auto; }",
    "header { margin-bottom: 22px; }",
    "h1 { font-size: 26px; }",
    ".sub { color: var(--tx3); margin-top: 4px; font-size: 13px; }",
    ".stat { display: inline-block; margin-top: 10px; padding: 3px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--ac); font-size: 12px; background: var(--panel); }",
    ".search-row { display: flex; gap: 8px; margin-bottom: 14px; }",
    "input[type=\"search\"] { flex: 1; height: 42px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel); color: var(--tx); font-size: 14px; outline: none; }",
    "input[type=\"search\"]:focus { border-color: var(--ac); }",
    ".btn { height: 42px; padding: 0 18px; border-radius: 10px; border: none; background: var(--ac); color: #0a100d; font-weight: 700; font-size: 13px; cursor: pointer; white-space: nowrap; }",
    ".btn:hover { background: #bff0e2; }",
    ".btn.ghost { background: transparent; border: 1px solid var(--line); color: var(--tx2); }",
    ".meta { color: var(--tx3); font-size: 12px; margin-bottom: 10px; min-height: 18px; }",
    ".list { display: flex; flex-direction: column; gap: 6px; }",
    ".row { display: flex; align-items: center; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; }",
    ".row .idx { flex-shrink: 0; width: 52px; text-align: right; color: var(--ac); font-weight: 700; font-size: 14px; font-family: ui-monospace, \"Cascadia Mono\", Consolas, monospace; }",
    ".row a { flex: 1; min-width: 0; color: var(--ac); text-decoration: none; font-size: 12px; font-family: ui-monospace, \"Cascadia Mono\", Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".row a:hover { color: #bff0e2; text-decoration: underline; }",
    ".row .go { flex-shrink: 0; padding: 5px 12px; border-radius: 7px; border: none; background: var(--ac); color: #0a100d; font-weight: 700; font-size: 12px; cursor: pointer; }",
    ".pager { display: flex; gap: 8px; margin-top: 16px; }",
    ".hint { color: var(--tx3); font-size: 12px; margin-top: 18px; line-height: 1.6; }",
    "</style></head><body><div class=\"wrap\"><header>",
    "<h1>" + esc(def.title || "Links") + "</h1>",
    "<div class=\"sub\">" + esc(def.sub || "") + "</div>",
    "<div class=\"stat\" id=\"stat\">Loading...</div>",
    "</header>",
    "<div class=\"search-row\"><input type=\"search\" id=\"q\" placeholder=\"Search any part of the url\" autocomplete=\"off\" spellcheck=\"false\"><button class=\"btn\" id=\"searchBtn\">Search</button></div>",
    "<div class=\"meta\" id=\"meta\"></div>",
    "<div class=\"list\" id=\"list\"></div>",
    "<div class=\"pager\"><button class=\"btn ghost\" id=\"prevBtn\" disabled>Prev</button><button class=\"btn ghost\" id=\"moreBtn\" disabled>Load more</button></div>",
    "<div class=\"hint\"><b>Tip:</b> use <b>Search</b> to filter by any text in the url. If the full collection file is available, this preview pages through the first " + shown.length + " links it has embedded.</div>",
    "</div>",
    "<script>",
    "(function () {",
    "  var LIMIT = 200, offset = 0, query = \"\", ALL = [], FILTERED = [];",
    "  var list = document.getElementById(\"list\"), meta = document.getElementById(\"meta\"), stat = document.getElementById(\"stat\");",
    "  var qEl = document.getElementById(\"q\"), prevBtn = document.getElementById(\"prevBtn\"), moreBtn = document.getElementById(\"moreBtn\");",
    "  function esc(s) { return String(s).replace(/&/g, \"&amp;\").replace(/</g, \"&lt;\").replace(/>/g, \"&gt;\").replace(/\"/g, \"&quot;\"); }",
    "  function render(mode) {",
    "    var rows = FILTERED.slice(offset, offset + LIMIT), html = \"\";",
    "    for (var i = 0; i < rows.length; i++) {",
    "      var u = esc(rows[i]);",
    "      html += '<div class=\"row\"><span class=\"idx\">' + (offset + i + 1) + '</span><a href=\"' + u + '\" target=\"_blank\" rel=\"noopener\" title=\"' + u + '\">' + u + '</a><button class=\"go\" data-url=\"' + u + '\">Open</button></div>';",
    "    }",
    "    if (mode === \"append\") list.insertAdjacentHTML(\"beforeend\", html); else list.innerHTML = html;",
    "    var shown = mode === \"append\" ? offset + rows.length : rows.length;",
    "    if (query) meta.textContent = FILTERED.length.toLocaleString() + \" matches, showing \" + shown;",
    "    else meta.textContent = \"Showing \" + (offset + 1) + \"-\" + (offset + rows.length) + \" of \" + ALL.length.toLocaleString();",
    "    moreBtn.disabled = rows.length < LIMIT;",
    "    moreBtn.textContent = rows.length < LIMIT ? \"End of preview\" : \"Load more\";",
    "    prevBtn.disabled = offset === 0;",
    "  }",
    "  function search() {",
    "    query = qEl.value.trim().toLowerCase(); offset = 0;",
    "    FILTERED = query ? ALL.filter(function (l) { return l.toLowerCase().indexOf(query) !== -1; }) : ALL.slice();",
    "    render(\"reset\");",
    "  }",
    "  document.getElementById(\"searchBtn\").addEventListener(\"click\", search);",
    "  qEl.addEventListener(\"keydown\", function (e) { if (e.key === \"Enter\") search(); });",
    "  prevBtn.addEventListener(\"click\", function () { offset = Math.max(0, offset - LIMIT); render(\"reset\"); });",
    "  moreBtn.addEventListener(\"click\", function () { offset += LIMIT; render(\"append\"); });",
    "  list.addEventListener(\"click\", function (e) { var b = e.target.closest(\".go\"); if (b) window.open(b.dataset.url, \"_blank\", \"noopener\"); });",
    "  function normalize(u) {",
    "    return u.replace(/^https?:\\/\\//, \"\").replace(/^cdn\\.jsdelivr\\.net\\/gh\\/[^\\/]+\\/[^\\/]+\\/main\\//, \"cdn.jsdelivr.net/gh/.../main/\").replace(/^cdn\\.jsdelivr\\.net\\/gh\\/[^\\/]+\\/[^\\/]+\\/master\\//, \"cdn.jsdelivr.net/gh/.../master/\").replace(/^cdn\\.jsdelivr\\.net\\/gh\\/[^\\/]+\\/[^\\/]+\\/prod\\//, \"cdn.jsdelivr.net/gh/.../prod/\").replace(/^cdn\\.jsdelivr\\.net\\/gh\\/[^\\/]+\\/[^\\/]+\\/gh-pages\\//, \"cdn.jsdelivr.net/gh/.../gh-pages/\");",
    "  }",
    "  function firstLine(u) {",
    "    return esc(u.split(\"\\n\")[0]);",
    "  }",
    "  var first = [\n" + shown.map(function (u, i) {
      return "    " + JSON.stringify(esc(u)) + (i < shown.length - 1 ? "," : "");
    }).join("\n") + "\n  ];",
    "  var normalized = first.map(normalize);",
    "  ALL = normalized;",
    "  FILTERED = ALL.slice();",
    "  stat.textContent = ALL.length.toLocaleString() + \" links\";",
    "  render(\"reset\");",
    "})();",
    "<\/script></body></html>"
  ].join("\n");
  return html;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SPECS = [
  {
    key: "NOAHS_EMBEDDED",
    file: "C:/Users/zeqrY/Downloads/nh.txt",
    title: "Noahs Tutoring Hub",
    sub: "Noahs Tutoring Hub - search or browse the link list, then open any link.",
    max: 120
  },
  {
    key: "DAYDREAM_EMBEDDED",
    file: "C:/Users/zeqrY/Downloads/10KdaydreamX.txt",
    title: "10K Daydream X SVG links",
    sub: "10K Daydream X - search or browse the SVG link list, then open any link.",
    max: 120
  },
  {
    key: "KORONA_EMBEDDED",
    file: "C:/Users/zeqrY/Downloads/korona.lat.txt",
    title: "korona.lat",
    sub: "korona.lat - search or browse the link list, then open any link.",
    max: 120
  }
];

for (const spec of SPECS) {
  if (!fs.existsSync(spec.file)) {
    console.warn("SKIP missing:", spec.file);
    continue;
  }
  const txt = fs.readFileSync(spec.file, "utf8");
  const urls = collectUrls(txt);
  if (!urls.length) {
    console.warn("SKIP empty:", spec.file);
    continue;
  }
  const html = makeListPage({ title: spec.title, sub: spec.sub }, urls, spec.max);
  const b64 = Buffer.from(html, "utf8").toString("base64");
  console.log("EMBEDDED", spec.key, "len", html.length, "b64len", b64.length, "urls", urls.length);
  fs.writeFileSync(path.join(__dirname, "..", "tmp", spec.key.toLowerCase() + ".preview.b64.txt"), b64, "utf8");
  console.log("Wrote", path.join(__dirname, "..", "tmp", spec.key.toLowerCase() + ".preview.b64.txt"));
}
