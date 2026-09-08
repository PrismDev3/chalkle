/* Unit-test ChalkleApi.localUrl across deployment contexts without a
   browser: stub window/location per scenario and eval runtime-config.js.
   Run: node tools/localurl-probe.mjs */
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../src/runtime-config.js", import.meta.url), "utf8");

function makeCtx(url, extra = {}) {
  const u = new URL(url);
  const windowStub = Object.assign(
    {
      location: {
        protocol: u.protocol,
        hostname: u.hostname,
        host: u.host,
        origin: u.origin,
        href: url,
      },
      document: { querySelector: () => null },
      SCHOOL_CENTER_CONFIG: undefined,
    },
    extra
  );
  windowStub.window = windowStub;
  const ctx = vm.createContext(windowStub);
  vm.runInContext(src, ctx);
  return windowStub.ChalkleApi;
}

const cases = [
  {
    name: "prod site (lootline.xyz) - no rewrite",
    api: makeCtx("https://lootline.xyz/"),
    in: "/game-builds/undertale/index.html",
    want: "/game-builds/undertale/index.html",
  },
  {
    name: "prod site - committed path stays same-origin",
    api: makeCtx("https://lootline.xyz/"),
    in: "/gn/0.html",
    want: "/gn/0.html",
  },
  {
    name: "jsDelivr mirror - game-builds goes to relay",
    api: makeCtx("https://cdn.jsdelivr.net/gh/PrismDev3/chalkle@main/index.html"),
    in: "/game-builds/undertale/index.html",
    want: "https://chalkle.lootline.xyz/game-builds/undertale/index.html",
  },
  {
    name: "jsDelivr mirror - mc goes to relay",
    api: makeCtx("https://cdn.jsdelivr.net/gh/PrismDev3/chalkle@main/index.html"),
    in: "/mc/eaglercraft-26.2.html",
    want: "https://chalkle.lootline.xyz/mc/eaglercraft-26.2.html",
  },
  {
    name: "jsDelivr mirror - committed /gn/ path unchanged (base-resolved later)",
    api: makeCtx("https://cdn.jsdelivr.net/gh/PrismDev3/chalkle@main/index.html"),
    in: "/gn/0.html",
    want: "/gn/0.html",
  },
  {
    name: "jsDelivr mirror - external URL untouched",
    api: makeCtx("https://cdn.jsdelivr.net/gh/PrismDev3/chalkle@main/index.html"),
    in: "https://example.com/game-builds/x.html",
    want: "https://example.com/game-builds/x.html",
  },
  {
    name: "jsDelivr mirror - data URI untouched",
    api: makeCtx("https://cdn.jsdelivr.net/gh/PrismDev3/chalkle@main/index.html"),
    in: "data:image/png;base64,AAA",
    want: "data:image/png;base64,AAA",
  },
  {
    name: "github.io mirror - game-builds goes to relay",
    api: makeCtx("https://prismdev3.github.io/chalkle/"),
    in: "/game-builds/undertale/index.html",
    want: "https://chalkle.lootline.xyz/game-builds/undertale/index.html",
  },
  {
    name: "file:// single-file build - game-builds goes to relay",
    api: makeCtx("file:///C:/chalkle/chalkle-single.html"),
    in: "/game-builds/undertale/index.html",
    want: "https://chalkle.lootline.xyz/game-builds/undertale/index.html",
  },
  {
    name: "PS1 disc image path goes to relay on mirror",
    api: makeCtx("https://cdn.jsdelivr.net/gh/PrismDev3/chalkle@main/index.html"),
    in: "/assets/games/psx/index.html",
    want: "https://chalkle.lootline.xyz/assets/games/psx/index.html",
  },
  {
    name: "root of local-only folder (no trailing slash) also caught",
    api: makeCtx("https://cdn.jsdelivr.net/gh/PrismDev3/chalkle@main/index.html"),
    in: "/game-builds",
    want: "/game-builds",
  },
];

let fail = 0;
for (const c of cases) {
  const got = c.api.localUrl(c.in);
  const ok = got === c.want;
  if (!ok) fail++;
  console.log((ok ? "PASS" : "FAIL") + "  " + c.name);
  if (!ok) console.log("      want: " + c.want + "\n      got:  " + got);
}

// isMirror/root sanity
const mirror = makeCtx("https://cdn.jsdelivr.net/gh/PrismDev3/chalkle@main/index.html");
console.log(mirror.isMirror() === true ? "PASS" : "FAIL", "isMirror true on jsDelivr");
console.log(mirror.root() === "https://chalkle.lootline.xyz" ? "PASS" : "FAIL", "root() on jsDelivr -> relay");
const prod = makeCtx("https://lootline.xyz/");
console.log(prod.isMirror() === false ? "PASS" : "FAIL", "isMirror false on prod");
console.log(prod.root() === "" ? "PASS" : "FAIL", "root() empty on prod");

console.log(fail === 0 ? "ALL OK" : fail + " FAILURES");
process.exit(fail === 0 ? 0 : 1);
