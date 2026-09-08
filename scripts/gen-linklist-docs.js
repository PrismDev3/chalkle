#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const INPUTS = [
  {
    file: "C:/Users/zeqrY/Downloads/nh.txt",
    title: "Noahs Tutoring Hub",
    tag: "list",
    sourceLabel: "Noahs Tutoring Hub link list"
  },
  {
    file: "C:/Users/zeqrY/Downloads/10KdaydreamX.txt",
    title: "10K Daydream X SVG links",
    tag: "list",
    sourceLabel: "10K Daydream X SVG link list"
  },
  {
    file: "C:/Users/zeqrY/Downloads/korona.lat.txt",
    title: "korona.lat",
    tag: "list",
    sourceLabel: "korona.lat link list"
  }
];

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

for (const input of INPUTS) {
  if (!fs.existsSync(input.file)) {
    console.warn("SKIP missing:", input.file);
    continue;
  }
  const txt = fs.readFileSync(input.file, "utf8");
  const urls = collectUrls(txt);
  const seed = {
    title: input.title,
    tag: input.tag,
    count: urls.length,
    links: urls,
    sourceFile: path.resolve(input.file),
    sourceLabel: input.sourceLabel
  };
  const out = path.join(__dirname, "..", "docs", "generated", input.title.replace(/[^A-Za-z0-9 _-]/g, "_") + ".seed.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(seed, null, 2), "utf8");
  console.log("WROTE", out, "links:", urls.length);
}
