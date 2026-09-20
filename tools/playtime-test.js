#!/usr/bin/env node
/* Chalkle playtime test: src/playtime.js under a fake DOM.

   Run: node tools/playtime-test.js

   Pins the parts that are easy to get wrong and impossible to notice by
   clicking: that a hidden tab stops the clock, that switching games banks the
   sitting you just left, that sub-second noise never reaches storage, that one
   sitting cannot run past the segment cap, and that the store stays bounded.

   The module is loaded in a vm with a stub localStorage and a controllable
   document.visibilityState, so the whole thing runs without a browser. */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "src", "playtime.js");

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log("PASS  " + name + (detail ? "  (" + detail + ")" : ""));
  } else {
    fail++;
    console.log("FAIL  " + name + (detail ? "  (" + detail + ")" : ""));
  }
}

function makePage() {
  const store = {};
  const sandbox = {
    console,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    document: { visibilityState: "visible", addEventListener() {} },
    setInterval,
    clearInterval,
    CustomEvent: function CustomEvent(type, opts) { this.type = type; this.detail = opts && opts.detail; },
    JSON, Math, Date, Number, String, Object, Array, Boolean, isFinite, parseInt
  };
  sandbox.window = sandbox;
  sandbox.dispatchEvent = () => {};
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox, { filename: "playtime.js" });
  return { store, sandbox, api: sandbox.window.ChalklePlaytime };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  const page = makePage();
  const P = page.api;

  check("module exposes its API", !!P && typeof P.start === "function" && typeof P.format === "function");

  /* format() is what every badge and the Home stat print. */
  const formatted = [0, 59000, 60000, 600000, 3600000, 4800000, 43200000].map(P.format).join("|");
  check("format covers nothing / minutes / hours", formatted === "0m|0m|1m|10m|1h|1h 20m|12h", formatted);
  check("show threshold is one minute", P.MIN_SHOW_MS === 60000, String(P.MIN_SHOW_MS));

  /* A visible sitting is timed. */
  P.start("visible-game", "Visible");
  await sleep(1400);
  P.stop();
  const visibleMs = P.get("visible-game");
  check("a visible sitting is recorded", visibleMs >= 1000 && visibleMs <= 2200, visibleMs + " ms");
  check("nothing is running after stop", P.running() === "", P.running());

  /* A hidden tab is a parked game, not a played one. */
  P.start("hidden-game", "Hidden");
  await sleep(500);
  page.sandbox.document.visibilityState = "hidden";
  await sleep(900);
  P.stop();
  const hiddenMs = P.get("hidden-game");
  check("a hidden tab stops the clock", hiddenMs === 0, hiddenMs + " ms");
  page.sandbox.document.visibilityState = "visible";

  /* Opening a second game banks the first. */
  P.start("switched-from", "A");
  await sleep(1300);
  P.start("switched-to", "B");
  const banked = P.get("switched-from");
  check("switching games banks the sitting you left", banked >= 1000, banked + " ms");
  check("the new game is the running session", P.running() === "switched-to", P.running());
  await sleep(1100);
  P.stop();

  /* Reopening the same game keeps one session instead of restarting the clock.
     Long enough to clear the minimum write, so the kept time is real. */
  P.start("resume", "R");
  await sleep(1200);
  const restarted = P.start("resume", "R");
  await sleep(200);
  P.stop();
  check("reopening the running game does not restart it", restarted === false, String(restarted));
  check("the resumed session keeps the time before the reopen", P.get("resume") >= 1200, P.get("resume") + " ms");

  /* Sub-second flapping leaves no trace. */
  P.reset();
  P.start("blip", "Blip");
  P.stop();
  check("a sub-second session is not stored", P.get("blip") === 0, P.get("blip") + " ms");

  /* The cap: one sitting cannot claim an overnight parked tab. */
  P.add("capped", P.segmentCapMs);
  P.add("capped", P.segmentCapMs);
  check("the segment cap is four hours", P.segmentCapMs === 4 * 3600 * 1000, String(P.segmentCapMs));

  /* Bounded store: oldest rows are dropped past the cap. */
  const page2 = makePage();
  for (let i = 0; i < 520; i++) page2.api.add("k" + i, 1000);
  const keys = Object.keys(page2.api.all()).length;
  const newestKept = Object.keys(page2.api.all()).includes("k519");
  check("the store stays bounded at 500 keys", keys === 500, String(keys));
  check("pruning drops the oldest rows, not the newest", newestKept);

  /* Totals, counts, ranking and reset. */
  page2.api.reset();
  page2.api.add("a", 3 * 60000);
  page2.api.add("b", 9 * 60000);
  page2.api.add("c", 60000);
  const total = page2.api.total();
  const ranked = page2.api.top([{ title: "A", url: "a" }, { title: "B", url: "b" }, { title: "C", url: "c" }, { title: "D", url: "d" }], 5, (x) => x.url).map((x) => x.title).join(",");
  check("total adds every row", total === 13 * 60000, P.format(total));
  check("games() counts only rows with time", page2.api.games() === 3, String(page2.api.games()));
  check("top() ranks longest first and drops untouched items", ranked === "B,A,C", ranked);
  page2.api.reset();
  check("reset forgets everything", page2.api.total() === 0 && page2.api.games() === 0);
  check("reset clears the stored key", !("chalkle-playtime" in page2.store) || page2.store["chalkle-playtime"] === undefined);

  /* A malformed or legacy value must never poison the store. */
  const page3 = makePage();
  page3.store["chalkle-playtime"] = "{\"legacy\": 5000, \"bad\": \"nope\", \"neg\": -20, \"modern\": {\"ms\": 7000, \"at\": 5}}";
  const legacy = page3.api.get("legacy");
  const modern = page3.api.get("modern");
  check("a bare-number row still reads", legacy === 5000, String(legacy));
  check("the { ms, at } shape reads", modern === 7000, String(modern));
  check("junk and negative rows are dropped", page3.api.get("bad") === 0 && page3.api.get("neg") === 0);

  const page4 = makePage();
  page4.store["chalkle-playtime"] = "{ this is not json";
  check("a corrupt store recovers instead of throwing", page4.api.total() === 0);

  console.log("");
  if (fail) {
    console.log(fail + " playtime check" + (fail === 1 ? "" : "s") + " failed");
    process.exit(1);
  }
  console.log("all " + pass + " playtime checks pass");
  process.exit(0);
})();
