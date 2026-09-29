/* Bank Robbery 2 (ugs/clbankbreakout2.html) loads its Unity build from
 * cdn.jsdelivr.net/gh/oz-53-b/z@main, and jsDelivr has banned that GitHub
 * user: every asset under it now answers
 *   "User oz-53-b is blocked. Please refer to https://www.jsdelivr.com/..."
 * so the loader script never runs and the player shows a dead page.
 *
 * The GitHub repo itself is alive, and it also ships the merged
 * Build/BankRobbery2.data.unityweb. The split part1/part2 files only exist
 * because jsDelivr caps a single file at 20 MB - the shell patches fetch at
 * runtime to staple them back together (29 MB of data joined in the tab).
 *
 * So this mirrors the build into game-builds/bankrobbery2/ (local-only, like
 * every other web-port build) and points the shell at it: same-origin, no
 * CDN that can ban the account, no filter to trip over, and the join hack
 * can go because a local file has no size cap.
 *
 * Idempotent: matching files are skipped (byte size from the repo tree), and
 * the shell rewrite is a no-op once its URLs are local. Run it again after a
 * wipe, or if the upstream build is ever updated.
 *   node scripts/mirror-bankrobbery2.mjs
 */
import fs from "node:fs";
import path from "node:path";

const REPO = "oz-53-b/z";
const BRANCH = "main";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
const CDN_BASE = `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}`;
const MIRROR_REL = "game-builds/bankrobbery2";
const SHELL = "ugs/clbankbreakout2.html";

const root = path.resolve(import.meta.dirname, "..");
const mirrorDir = path.join(root, MIRROR_REL);

/* Exactly what the shell loads. TemplateData/style.css is the Unity template
 * layout (canvas/container sizing); without it the frame renders unstyled. */
const FILES = [
  "Build/BankRobbery2.loader.js",
  "Build/BankRobbery2.framework.js.unityweb",
  "Build/BankRobbery2.wasm.unityweb",
  "Build/BankRobbery2.data.unityweb",
  "TemplateData/style.css",
];

async function tree() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`, {
    headers: { "User-Agent": "chalkle-mirror" },
  });
  if (!r.ok) throw new Error(`tree ${r.status}`);
  const d = await r.json();
  const sizes = new Map();
  for (const t of d.tree || []) if (t.type === "blob") sizes.set(t.path, t.size || 0);
  return sizes;
}

async function download(file, size) {
  const dest = path.join(mirrorDir, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size === size) {
    console.log(`  skip  ${file} (${size} B already here)`);
    return;
  }
  const r = await fetch(RAW + file, { headers: { "User-Agent": "chalkle-mirror" } });
  if (!r.ok) throw new Error(`${file}: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (size && buf.length !== size) throw new Error(`${file}: got ${buf.length} B, expected ${size} B`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log(`  mirror ${file} (${buf.length} B)`);
}

/* The shell's own URLs. Everything else in the file stays byte-identical:
 * this is a vendored Yandex-Games port, and only its asset host is broken. */
function rewriteShell() {
  const file = path.join(root, SHELL);
  let html = fs.readFileSync(file, "utf8");
  const before = html;

  html = html.split(`${CDN_BASE}/Build`).join(`/${MIRROR_REL}/Build`);
  html = html.split(`${CDN_BASE}/TemplateData`).join(`/${MIRROR_REL}/TemplateData`);

  /* Drop the split-data patch: BankRobbery2.data.unityweb is mirrored whole,
   * so nothing has to be fetched in two pieces and joined at runtime. */
  html = html.replace(
    /\r?\n\s*\/\/ Patch UnityLoader to support multiple data files[\s\S]*?return originalUnityLoaderFetch\(url, \.\.\.args\);\r?\n\s*\};/,
    ""
  );

  if (html === before) {
    console.log("  shell  already points at the local build");
    return;
  }
  if (html.includes("oz-53-b")) {
    console.log("  shell  WARNING - a jsDelivr reference survived, check " + SHELL);
  }
  if (html.includes("originalUnityLoaderFetch")) {
    console.log("  shell  WARNING - the split-data patch was not removed, check " + SHELL);
  }
  fs.writeFileSync(file, html);
  console.log(`  shell  rewrote ${SHELL} -> /${MIRROR_REL}/`);
}

console.log(`Bank Robbery 2 mirror (${REPO}@${BRANCH}) -> ${MIRROR_REL}`);
const sizes = await tree();
for (const f of FILES) {
  if (!sizes.has(f)) throw new Error(`upstream no longer has ${f}`);
  await download(f, sizes.get(f));
}
rewriteShell();
const total = FILES.reduce((n, f) => n + (sizes.get(f) || 0), 0);
console.log(`done - ${FILES.length} files, ${(total / 1048576).toFixed(1)} MB`);
