/* Generates the "Chalkle Bulk List" docs entry:
 *  - reads scripts/svgbulk-doc-template.html
 *  - injects the link list (research/embedded/svgbulk-links-embedded.txt) as a
 *    JSON array literal into the __SVGBULK_DATA__ placeholder
 *  - base64-encodes the whole page into src/docs.js DEFAULT_DOCS
 * Idempotent: an existing "Chalkle Bulk List" entry is replaced in place.
 * Usage: node scripts/build-svgbulk-doc.mjs
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const tplPath = path.join(root, "scripts", "svgbulk-doc-template.html");
const linksPath = path.join(root, "research", "embedded", "svgbulk-links-embedded.txt");
const docsPath = path.join(root, "src", "docs.js");

const tpl = fs.readFileSync(tplPath, "utf8");
const links = fs.readFileSync(linksPath, "utf8");
const linkLines = links.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
if (!linkLines.length) throw new Error("no links parsed from " + linksPath);

const json = JSON.stringify(linkLines.join("\n"));
if (json.includes("</" + "script")) throw new Error("link data contains a script-closing sequence; refusing to inline");
const html = tpl.replace("__SVGBULK_DATA__", () => json);
const b64 = Buffer.from(html, "utf8").toString("base64");

const docs = fs.readFileSync(docsPath, "utf8");
const entry =
  '{ title: "Chalkle Bulk List", html: true, list: true, count: ' + linkLines.length +
  ', sub: "SVG cloak links across 12 CDN mirrors - search by repo, file, or mirror, then open any link.", contentB64: "' + b64 + '" }';

const marker = /{ title: "Chalkle Bulk List",[\s\S]*?contentB64: "[A-Za-z0-9+/=]+" \}/;
let out, action;
if (marker.test(docs)) {
  out = docs.replace(marker, () => entry);
  action = "replaced existing entry";
} else {
  const anchor = '{ title: "Discord",';
  const i = docs.indexOf(anchor);
  if (i === -1) throw new Error("anchor not found in docs.js");
  out = docs.slice(0, i) + entry + ",\n    " + docs.slice(i);
  action = "inserted new entry before Discord";
}
fs.writeFileSync(docsPath, out);
console.log("svgbulk doc: " + action + " (" + linkLines.length + " links, b64 " + b64.length + " chars)");
