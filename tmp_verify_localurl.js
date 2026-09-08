(function () {
  "use strict";
  var assert = (cond, msg) => { if (!cond) { throw new Error(msg || "FAIL"); } };
  var makeSandbox = function (hostname, originProtocol, origin, embed) {
    var w = { ChalkleApi: undefined, __CHALKLE_EMBED__: embed ? true : undefined };
    var d = { querySelector: function () { return null; } };
    var loc = { protocol: originProtocol || "https:", hostname: hostname, origin: origin };
    var prevW = globalThis.window, prevD = globalThis.document, prevLoc = globalThis.location;
    globalThis.window = w; globalThis.document = d; globalThis.location = loc;
    try { require("./src/runtime-config.js"); } finally {
      globalThis.window = prevW; globalThis.document = prevD; globalThis.location = prevLoc;
    }
    return w;
  };
  var main = "https://chalkle.lootline.xyz";
  var deadJsd = "https://cdn.jsdelivr.net/game-builds/undertale/index.html";
  var deadJsdPath = "/game-builds/undertale/index.html";
  var aliveJsd = "https://cdn.jsdelivr.net/gh/PrismDev3/chalkle@main/index.html";
  var prodPath = "/games/spotlight/index.html";
  var prodHost = "lootline.xyz";
  var prodOrigin = "https://lootline.xyz";

  var w1 = makeSandbox("cdn.jsdelivr.net", "https:", "https://cdn.jsdelivr.net");
  assert(typeof w1.ChalkleApi === "object", "ChalkleApi exists on mirror");
  assert(typeof w1.ChalkleApi.localUrl === "function", "localUrl exists");
  assert(w1.ChalkleApi.isMirror() === true, "jsDelivr seen as mirror");
  assert(w1.ChalkleApi.localUrl(deadJsd) === main + deadJsdPath,
    "absolute dead jsDelivr game-builds re-pointed");
  assert(w1.ChalkleApi.localUrl(deadJsdPath) === main + deadJsdPath,
    "root-absolute dead game-builds re-pointed");
  assert(w1.ChalkleApi.localUrl(aliveJsd) === aliveJsd,
    "alive jsDelivr path left alone");
  assert(w1.ChalkleApi.localUrl(prodPath) === prodPath,
    "non-local-only path left alone");

  var w2 = makeSandbox(prodHost, "https:", prodOrigin, true);
  assert(w2.ChalkleApi.isMirror() === false, "prod host not seen as mirror");
  assert(w2.ChalkleApi.localUrl(deadJsdPath) === deadJsdPath,
    "prod keeps root-absolute local path as-is");
  assert(w2.ChalkleApi.localUrl(deadJsd) === deadJsd,
    "prod keeps dead absolute as-is");
})();
console.log("OK: runtime-config localUrl routing");
