#!/usr/bin/env node
/* Chalkle "Surprise me" test: the weighted-random launcher in src/app.js.

   Run: node tools/surprise-test.js

   The picker is a small block of app.js, but the parts that are easy to get
   wrong are exactly the parts a click-through never proves: that the weights
   actually skew the draw, that the last pick cannot repeat twice in a row,
   that the pool follows the active filters, and that a pool of one (or none)
   cannot crash the launch. So the launcher block is extracted from app.js and
   run here against a stubbed environment, the same trick sw-test.js uses for
   the service worker.

   If the extraction ever fails (someone renamed a marker or moved the
   functions), the test says so instead of passing vacuously. */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "src", "app.js");

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

/* ---- cut the launcher block out of app.js ---- */

const text = fs.readFileSync(SOURCE, "utf8");
const startMark = "/* ---------- Surprise me ----------";
const endMark = "function renderGameStats(";
const start = text.indexOf(startMark);
const end = text.indexOf(endMark, start);
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL  could not find the Surprise me block in src/app.js between");
  console.error("      \"" + startMark + "\" and \"" + endMark + "\" - the test needs updating.");
  process.exit(1);
}
const block = text.slice(start, end);

/* ---- stub environment: the block calls state/DATA helpers defined above it ---- */

function makeEnv(opts) {
  opts = opts || {};
  const games = opts.games || [];
  const store = {};
  const els = (opts.els || []).reduce((acc, id) => {
    acc[id] = { click: () => {}, remove: () => {}, style: {}, dataset: {} };
    return acc;
  }, {});
  const clicks = { className: "game-launch", style: { display: "none" }, dataset: {} };
  clicks.click = () => { clicked = true; };
  clicks.remove = () => {};
  let clicked = false;
  const host = {
    appendChild: (el) => { host.lastChild = el; },
    lastChild: null
  };
  const env = {
    console,
    Math,
    Date,
    /* what the block itself references */
    state: Object.assign({
      view: "games",
      gameFilter: "all",
      genreFilters: [],
      clicks: opts.clicks || {},
      favs: opts.favs || {},
      lastSurprise: opts.lastSurprise || ""
    }, opts.stateExtra || {}),
    DATA: { games: games },
    gameKey: (item) => String((item && (item.url || item.title)) || "").toLowerCase(),
    sharedTrend: (key) => ((opts.trend || {})[key] || 0),
    sharedPlays: (key) => ((opts.allPlays || {})[key] || 0),
    isRecentGame: () => true,
    itemCategory: (item) => (item && item.category) || "",
    isLocalFileUrl: (u) => /^(file:|javascript:)/i.test(String(u || "").trim()),
    safeHref: (u) => String(u || ""),
    escapeAttr: (s) => String(s == null ? "" : s).replace(/"/g, "&quot;"),
    setView: () => { env.setViewCalls++; },
    setViewCalls: 0,
    showToast: (msg) => { env.toasts.push(msg); },
    toasts: [],
    /* the app's $ helper: the launcher appends its synthetic anchor to #main */
    $: (sel) => (sel === "#main" ? host : null),
    document: {
      createElement: () => clicks,
      querySelector: (sel) => (/^\[data-view="games"\]$/.test(sel) ? host : null),
      body: host
    }
  };
  env.host = host;
  env.clickA = clicks;
  env.wasClicked = () => clicked;
  return env;
}

/* Pull just the four launcher functions out of the block and eval them. */
const pick = new Function(
  "state", "DATA", "gameKey", "sharedTrend", "sharedPlays", "isRecentGame",
  "itemCategory", "isLocalFileUrl", "safeHref", "escapeAttr", "setView",
  "showToast", "document", "$",
  block + "\nreturn { surpriseWeight, surprisePool, pickSurprise, surpriseMe };"
);

const G = (title, url, extra) => Object.assign({ title: title, url: url || "/" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "/" }, extra || {});

(async () => {
  /* ---- surpriseWeight ---- (gameKey prefers the URL, so keys are paths) */
  {
    const env = makeEnv({
      games: [G("A"), G("B")],
      trend: { "/b/": 10 },
      allPlays: { "/b/": 7 },
      clicks: { "/b/": 3 },
      favs: { "/b/": 1 }
    });
    const api = pick(
      env.state, env.DATA, env.gameKey, env.sharedTrend, env.sharedPlays,
      env.isRecentGame, env.itemCategory, env.isLocalFileUrl, env.safeHref,
      env.escapeAttr, env.setView, env.showToast, env.document, env.$
    );
    const a = api.surpriseWeight(env.DATA.games[0]);
    const b = api.surpriseWeight(env.DATA.games[1]);
    check("unplayed games get the default weight", a === 5, String(a));
    check("trend, plays, clicks and the favorite boost add up", b === 10 * 2 + 7 + 3 + 4 + 5, String(b));
  }

  /* ---- surprisePool follows the active filter ---- */
  {
    const games = [G("Ported", null, { porter: "someone" }), G("Casual")];
    const env = makeEnv({ games: games });
    env.state.gameFilter = "ports";
    const api = pick(
      env.state, env.DATA, env.gameKey, env.sharedTrend, env.sharedPlays,
      env.isRecentGame, env.itemCategory, env.isLocalFileUrl, env.safeHref,
      env.escapeAttr, env.setView, env.showToast, env.document, env.$
    );
    const pool = api.surprisePool();
    check("the ports filter narrows the pool", pool.length === 1 && pool[0].title === "Ported", pool.map((g) => g.title).join(","));

    env.state.gameFilter = "all";
    env.state.genreFilters = ["Idle"];
    const pool2 = api.surprisePool();
    check("a genre chip narrows the pool", pool2.length === 0, String(pool2.length));
  }

  /* ---- the last pick never repeats ---- */
  {
    const games = [G("A"), G("B"), G("C")];
    const env = makeEnv({ games: games, lastSurprise: "/b/" });
    const api = pick(
      env.state, env.DATA, env.gameKey, env.sharedTrend, env.sharedPlays,
      env.isRecentGame, env.itemCategory, env.isLocalFileUrl, env.safeHref,
      env.escapeAttr, env.setView, env.showToast, env.document, env.$
    );
    const seen = new Set();
    for (let i = 0; i < 400; i++) {
      const item = api.pickSurprise();
      if (!item) break;
      seen.add(env.gameKey(item));
      if (env.gameKey(item) === "/b/") {
        check("the last-drawn game is excluded from the next draw", false, "drew b again");
        return finish();
      }
    }
    check("the last-drawn game is excluded from the next draw", true, seen.size + " distinct");
    check("the other games still come up", seen.size >= 2, [...seen].join(","));
  }

  /* ---- degenerate pools ---- */
  {
    const env = makeEnv({ games: [G("Only one")] });
    const api = pick(
      env.state, env.DATA, env.gameKey, env.sharedTrend, env.sharedPlays,
      env.isRecentGame, env.itemCategory, env.isLocalFileUrl, env.safeHref,
      env.escapeAttr, env.setView, env.showToast, env.document, env.$
    );
    const item = api.pickSurprise();
    check("a pool of one still picks", !!item && item.title === "Only one", item && item.title);
  }
  {
    const env = makeEnv({ games: [] });
    const api = pick(
      env.state, env.DATA, env.gameKey, env.sharedTrend, env.sharedPlays,
      env.isRecentGame, env.itemCategory, env.isLocalFileUrl, env.safeHref,
      env.escapeAttr, env.setView, env.showToast, env.document, env.$
    );
    let threw = false;
    try { api.pickSurprise(); } catch (e) { threw = true; }
    check("an empty pool never throws", !threw);
  }
  {
    const env = makeEnv({ games: [G("Ghost", "file:///C:/game.html")] });
    const api = pick(
      env.state, env.DATA, env.gameKey, env.sharedTrend, env.sharedPlays,
      env.isRecentGame, env.itemCategory, env.isLocalFileUrl, env.safeHref,
      env.escapeAttr, env.setView, env.showToast, env.document, env.$
    );
    const item = api.pickSurprise();
    check("local-file entries are not launchable surprises", item === null, String(item));
  }

  /* ---- the weights actually skew the draw ---- */
  {
    const games = [G("Rare"), G("Common")];
    const env = makeEnv({
      games: games,
      allPlays: { "/common/": 500 }
    });
    const api = pick(
      env.state, env.DATA, env.gameKey, env.sharedTrend, env.sharedPlays,
      env.isRecentGame, env.itemCategory, env.isLocalFileUrl, env.safeHref,
      env.escapeAttr, env.setView, env.showToast, env.document, env.$
    );
    let common = 0;
    const N = 600;
    for (let i = 0; i < N; i++) {
      if (env.gameKey(api.pickSurprise()) === "/common/") common++;
    }
    /* Common's weight is 505 vs Rare's 5 -> expected share ~99%. A fair coin
       would sit at 50%; 75% is far below expectation and still far above it. */
    check("a heavily played game dominates the draw", common / N > 0.75, Math.round((common / N) * 100) + "% of " + N);
  }

  /* ---- surpriseMe launches through the real click flow ---- */
  {
    const games = [G("Launched")];
    const env = makeEnv({ games: games });
    const api = pick(
      env.state, env.DATA, env.gameKey, env.sharedTrend, env.sharedPlays,
      env.isRecentGame, env.itemCategory, env.isLocalFileUrl, env.safeHref,
      env.escapeAttr, env.setView, env.showToast, env.document, env.$
    );
    api.surpriseMe();
    check("the synthetic launch anchor was clicked", env.wasClicked());
    check("the launch remembers what was drawn", env.state.lastSurprise === "/launched/", env.state.lastSurprise);
    check("nothing was toasted on success", env.toasts.length === 0);
  }
  {
    const env = makeEnv({ games: [] });
    const api = pick(
      env.state, env.DATA, env.gameKey, env.sharedTrend, env.sharedPlays,
      env.isRecentGame, env.itemCategory, env.isLocalFileUrl, env.safeHref,
      env.escapeAttr, env.setView, env.showToast, env.document, env.$
    );
    api.surpriseMe();
    check("an empty pool says so instead of launching", !env.wasClicked() && env.toasts.length === 1, env.toasts.join("|"));
  }

  /* ---- the plain-S keyboard shortcut (the panic-key handler) ----

     The shortcut lives in the panic keydown handler, not the Surprise me
     block, so this section extracts that handler from app.js the same way
     and replays real key events against it: guards first, then the
     else-if that makes the panic key win when it IS "s". */
  {
    const keyMark = "/* Never hijack keys while the user is typing somewhere";
    const km = text.indexOf(keyMark);
    const listenerStart = km < 0 ? -1 : text.lastIndexOf('document.addEventListener("keydown"', km);
    const listenerEnd = km < 0 ? -1 : text.indexOf("\n  });", km);
    if (km < 0 || listenerStart < 0 || listenerEnd < 0) {
      check("the panic keydown handler was found for extraction", false, "markers moved");
      return finish();
    }
    const handlerBlock = text.slice(listenerStart, listenerEnd + "\n  });".length);

    function keyEnv(panicKey) {
      const handlers = {};
      const doc = { addEventListener: (type, fn) => { handlers[type] = fn; } };
      const calls = { panic: 0, surprise: 0 };
      new Function(
        "document", "panicConfig", "panicEscape", "surpriseMe",
        handlerBlock
      )(doc, () => ({ key: panicKey }), () => { calls.panic++; }, () => { calls.surprise++; });
      return { handler: handlers.keydown, calls };
    }

    function keyEvent(key, mods, tag, editable) {
      const ev = {
        key: key,
        ctrlKey: !!(mods && mods.ctrl), metaKey: !!(mods && mods.meta), altKey: !!(mods && mods.alt),
        target: { tagName: tag || "BODY", isContentEditable: !!editable },
        prevented: false,
        preventDefault: () => { ev.prevented = true; }
      };
      return ev;
    }

    {
      const env = keyEnv("`");
      env.handler(keyEvent("s"));
      check("plain S rolls a surprise", env.calls.surprise === 1 && env.calls.panic === 0, JSON.stringify(env.calls));
      env.handler(keyEvent("S"));
      check("shifted S rolls too", env.calls.surprise === 2, String(env.calls.surprise));
    }
    {
      const env = keyEnv("`");
      env.handler(keyEvent("s", { ctrl: true }));
      env.handler(keyEvent("s", { meta: true }));
      env.handler(keyEvent("s", { alt: true }));
      check("browser-shortcut combos are never eaten", env.calls.surprise === 0, JSON.stringify(env.calls));
    }
    {
      const env = keyEnv("`");
      env.handler(keyEvent("s", null, "INPUT"));
      env.handler(keyEvent("s", null, "TEXTAREA"));
      env.handler(keyEvent("s", null, "SELECT"));
      env.handler(keyEvent("s", null, "DIV", true)); /* a contentEditable div is typing */
      check("typing fields are never hijacked", env.calls.surprise === 0, JSON.stringify(env.calls));
      env.handler(keyEvent("s", null, "BUTTON"));
      check("a focused button does not block the shortcut", env.calls.surprise === 1, JSON.stringify(env.calls));
    }
    {
      const env = keyEnv("s");
      env.handler(keyEvent("s"));
      check("a panic key of s wins over the surprise shortcut", env.calls.panic === 1 && env.calls.surprise === 0, JSON.stringify(env.calls));
    }
    {
      const env = keyEnv("`");
      env.handler(keyEvent("`"));
      env.handler(keyEvent("s"));
      check("panic and surprise stay independent keys", env.calls.panic === 1 && env.calls.surprise === 1, JSON.stringify(env.calls));
    }
  }

  finish();
})().catch((e) => {
  console.error("FAIL  the test harness itself threw: " + (e && e.stack || e));
  process.exit(1);
});

function finish() {
  console.log("");
  if (fail) {
    console.log(fail + " check(s) FAILED, " + pass + " passed");
    process.exit(1);
  }
  console.log("all surprise checks pass");
  process.exit(0);
}
