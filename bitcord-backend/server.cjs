/* Bitcord backend for Chalkle (the original bitcord.xyz hosted instance is a
 * parked domain, so this re-implements the small API the bundled frontend
 * talks to). Listens on 127.0.0.1:4123; serve-chalk.py proxies /bitcord/api/*
 * and /bitcord/ws here.
 *
 * Protocol was reverse-engineered from the shipped frontend bundle:
 *  - REST: /api/auth/*, /api/users/me, /api/me/*, /api/members, /api/dm,
 *          /api/friends*, /api/servers*, /api/channels/:id/messages,
 *          /api/messages/:id (PATCH/DELETE), /api/threads/:id/messages,
 *          /api/unread, /api/upload/limits
 *  - WS:   client sends {t:'sub'|'unsub'|'typing'|'presence', ...}; server
 *          emits {t:'msg'|'del'|'typing'|'presence'|'unread'|'servers',
 *          channel, ...}.
 *
 * Storage is a JSON file (bitcord-data.json) with atomic writes - good enough
 * for a small friend-group chat and keeps the dependency list at zero (the
 * `ws` package is reused from stratus-api/node_modules). Session tokens are
 * signed-ish random ids stored server-side; the browser keeps them via the
 * cookie the relay mirrors (bc_session). Passwords are salted+sha256.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = 4123;
const DATA_FILE = path.join(__dirname, "bitcord-data.json");
let wsMod = null;
try { wsMod = require("ws"); } catch (e) {
  try { wsMod = require("../stratus-api/node_modules/ws"); } catch (e2) {}
}

/* ------------------------------------------------------------ persistence */
const DEFAULT_DB = {
  users: {},        // id -> {id, username, displayName, salt, hash, createdAt, settings}
  sessions: {},     // token -> {userId, createdAt}
  channels: {},     // id -> {id, name, kind:"dm"|"server"|"thread", serverId?, topic?, createdAt}
  members: {},      // userId -> {joinedAt}
  messages: {},     // channelId -> [ {id, channelId, authorId, text, createdAt, editedAt, replyTo, attachments} ]
  friends: {},      // userId -> [{id, userId, state:"pending_in"|"pending_out"|"friends"}]
  blocked: {},      // userId -> [userId]
  unreads: {},      // userId -> {channelId -> lastReadTs}
  servers: {},      // id -> {id, name, ownerId, categories:[{id,name,channels:[id]}]}
};
let db;
try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { db = null; }
if (!db || typeof db !== "object") db = JSON.parse(JSON.stringify(DEFAULT_DB));
for (const k of Object.keys(DEFAULT_DB)) if (db[k] === undefined) db[k] = JSON.parse(JSON.stringify(DEFAULT_DB[k]));

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DATA_FILE + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.error("[bitcord] save failed:", e.message); }
  }, 250);
}

const uid = () => crypto.randomBytes(9).toString("base64url");
const token = () => crypto.randomBytes(24).toString("base64url");
const now = () => Date.now();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/* ------------------------------------------------------------ seed content */
function seed() {
  const names = ["general", "games", "off-topic"];
  for (const n of names) {
    const id = uid();
    db.channels[id] = { id, name: n, kind: "server", serverId: "home", topic: "", createdAt: now() };
  }
  db.servers["home"] = {
    id: "home", name: "Chalkle", ownerId: "system",
    categories: [{ id: "cat-text", name: "Text Channels", channels: Object.keys(db.channels) }],
  };
  db.users["system"] = {
    id: "system", username: "chalkle", displayName: "Chalkle",
    salt: "", hash: "", createdAt: now(),
    settings: { theme: "dark" },
  };
  db.members["system"] = { joinedAt: now() };
  const home = Object.values(db.channels).find((c) => c.name === "general");
  db.messages[home.id] = [{
    id: uid(), channelId: home.id, authorId: "system",
    text: "Welcome to Chalkle Chat! Register a username to say hi.",
    createdAt: now(),
  }];
}
if (!Object.keys(db.channels).length) { seed(); save(); }

/* ------------------------------------------------------------ helpers */
function userPublic(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt };
}
function getSessionUser(req) {
  const cookies = (req.headers.cookie || "").split(/;\s*/);
  let tok = "";
  for (const c of cookies) {
    const [k, ...rest] = c.split("=");
    if (k.trim() === "bc_session") tok = decodeURIComponent(rest.join("="));
  }
  if (!tok) return null;
  const s = db.sessions[tok];
  if (!s) return null;
  return { user: db.users[s.userId], token: tok };
}
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  res.writeHead(code, headers);
  res.end(body);
}
function err(res, code, msg) { json(res, code, { error: msg }); }
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 5 * 1024 * 1024) { req.destroy(); resolve(null); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}
function channelBrief(c) {
  return { id: c.id, name: c.name, kind: c.kind, serverId: c.serverId, topic: c.topic || "", createdAt: c.createdAt };
}

/* ------------------------------------------------------------ websocket */
const clients = new Set(); // {ws, userId, subs:Set<channelId>}
function broadcast(event, channelId) {
  const data = JSON.stringify(event);
  for (const c of clients) {
    if (channelId && !(c.subs.has(channelId))) continue;
    try { if (c.ws.readyState === 1) c.ws.send(data); } catch (e) {}
  }
}
function presenceList() {
  const out = [];
  for (const c of clients) if (c.userId && db.users[c.userId]) out.push(userPublic(db.users[c.userId]));
  return out;
}

let wss = null;
if (wsMod) {
  wss = new wsMod.WebSocketServer({ noServer: true });
} else {
  console.error("[bitcord] ws module not found - realtime disabled (REST still works)");
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const route = u.pathname.replace(/^\/bitcord/, "") || "/";
  const method = req.method;

  /* ---- auth ---- */
  if (route === "/api/auth/register" && method === "POST") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const username = String(body.username || "").trim().toLowerCase().slice(0, 24);
    const password = String(body.password || "");
    if (!/^[a-z0-9_.-]{2,24}$/.test(username)) return err(res, 400, "Username must be 2-24 chars (letters, numbers, _ . -)");
    if (password.length < 4) return err(res, 400, "Password must be at least 4 characters");
    if (Object.values(db.users).some((x) => x.username === username)) return err(res, 409, "Username already taken");
    const salt = crypto.randomBytes(8).toString("hex");
    const id = uid();
    const user = {
      id, username, displayName: username, salt, hash: sha(salt + password),
      createdAt: now(), settings: { theme: "dark" },
    };
    db.users[id] = user;
    db.members[id] = { joinedAt: now() };
    const tok = token();
    db.sessions[tok] = { userId: id, createdAt: now() };
    save();
    return json(res, 200, { user: userPublic(user) }, {
      "Set-Cookie": "bc_session=" + encodeURIComponent(tok) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000",
    });
  }
  if (route === "/api/auth/login" && method === "POST") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const username = String(body.username || "").trim().toLowerCase();
    const user = Object.values(db.users).find((x) => x.username === username);
    if (!user || user.hash !== sha(user.salt + String(body.password || ""))) return err(res, 401, "Wrong username or password");
    const tok = token();
    db.sessions[tok] = { userId: user.id, createdAt: now() };
    save();
    return json(res, 200, { user: userPublic(user) }, {
      "Set-Cookie": "bc_session=" + encodeURIComponent(tok) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000",
    });
  }
  if (route === "/api/auth/logout" && method === "POST") {
    const s = getSessionUser(req);
    if (s) { delete db.sessions[s.token]; save(); }
    return json(res, 200, { ok: true }, { "Set-Cookie": "bc_session=; Path=/; Max-Age=0" });
  }
  if (route === "/api/auth/me") {
    const s = getSessionUser(req);
    if (!s) return err(res, 401, "Not logged in");
    return json(res, 200, { user: userPublic(s.user) });
  }

  const sess = getSessionUser(req);
  const me = sess && sess.user;

  /* ---- users / members / settings ---- */
  if (route === "/api/users/me" && method === "PATCH") {
    if (!me) return err(res, 401, "Not logged in");
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    if (body.displayName) me.displayName = String(body.displayName).slice(0, 32);
    save();
    return json(res, 200, { user: userPublic(me) });
  }
  if (route === "/api/me/settings") {
    if (!me) return err(res, 401, "Not logged in");
    if (method === "PATCH") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      me.settings = { ...(me.settings || {}), ...body };
      save();
      return json(res, 200, { settings: me.settings });
    }
    return json(res, 200, { settings: me.settings || {} });
  }
  if (route === "/api/me/sessions") {
    if (!me) return err(res, 401, "Not logged in");
    return json(res, 200, { sessions: [{ id: sess.token.slice(0, 8), createdAt: now(), current: true }] });
  }
  if (route === "/api/me/blocked") {
    if (!me) return err(res, 401, "Not logged in");
    return json(res, 200, { blocked: (db.blocked[me.id] || []).map((id) => userPublic(db.users[id])).filter(Boolean) });
  }
  if (route === "/api/members") {
    return json(res, 200, { members: Object.keys(db.members).map((id) => userPublic(db.users[id])).filter(Boolean) });
  }
  if (route === "/api/upload/limits") {
    return json(res, 200, { maxSize: 8 * 1024 * 1024 });
  }

  /* ---- channels & messages ---- */
  if (route === "/api/dm") {
    const list = Object.values(db.channels).filter((c) => c.kind !== "thread").sort((a, b) => a.createdAt - b.createdAt);
    return json(res, 200, { channels: list.map(channelBrief) });
  }
  if (route === "/api/channels" && method === "POST") {
    if (!me) return err(res, 401, "Not logged in");
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const name = String(body.name || "").trim().slice(0, 24) || "channel";
    const id = uid();
    db.channels[id] = { id, name, kind: "server", serverId: body.serverId || "home", topic: "", createdAt: now() };
    const srv = db.servers["home"];
    if (srv) { srv.categories[0].channels.push(id); }
    save();
    broadcast({ t: "servers" });
    return json(res, 200, { channel: channelBrief(db.channels[id]) });
  }
  let m = route.match(/^\/api\/channels\/([^/]+)\/messages$/);
  if (m) {
    const ch = db.channels[m[1]];
    if (!ch) return err(res, 404, "Channel not found");
    if (method === "GET") {
      const q = u.searchParams;
      const before = q.get("before") ? Number(q.get("before")) : null;
      let list = db.messages[ch.id] || [];
      if (before) list = list.filter((x) => x.createdAt < before);
      const page = list.slice(-50);
      return json(res, 200, { messages: page });
    }
    if (method === "POST") {
      if (!me) return err(res, 401, "Not logged in");
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const text = String(body.text || body.content || "").slice(0, 4000);
      if (!text.trim() && !body.attachment) return err(res, 400, "Empty message");
      const msg = {
        id: uid(), channelId: ch.id, authorId: me.id, text,
        createdAt: now(),
        replyTo: body.replyTo || undefined,
        attachments: body.attachments || body.attachment || undefined,
      };
      (db.messages[ch.id] = db.messages[ch.id] || []).push(msg);
      if (db.messages[ch.id].length > 500) db.messages[ch.id] = db.messages[ch.id].slice(-500);
      save();
      broadcast({ t: "msg", op: "new", channel: ch.id, message: msg }, ch.id);
      return json(res, 200, { message: msg });
    }
  }
  m = route.match(/^\/api\/messages\/([^/]+)$/);
  if (m) {
    if (!me) return err(res, 401, "Not logged in");
    for (const arr of Object.values(db.messages)) {
      const i = arr.findIndex((x) => x.id === m[1]);
      if (i === -1) continue;
      if (arr[i].authorId !== me.id && me.id !== "system") return err(res, 403, "Not your message");
      if (method === "PATCH") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        arr[i].text = String(body.text || body.content || "").slice(0, 4000);
        arr[i].editedAt = now();
        save();
        broadcast({ t: "msg", op: "edit", channel: arr[i].channelId, message: arr[i] }, arr[i].channelId);
        return json(res, 200, { message: arr[i] });
      }
      if (method === "DELETE") {
        const [gone] = arr.splice(i, 1);
        save();
        broadcast({ t: "del", channel: gone.channelId, id: gone.id }, gone.channelId);
        return json(res, 200, { ok: true });
      }
    }
    return err(res, 404, "Message not found");
  }
  m = route.match(/^\/api\/threads\/([^/]+)\/messages$/);
  if (m) {
    const ch = db.channels[m[1]] || { id: m[1], name: "thread", kind: "thread" };
    if (!db.channels[m[1]]) db.channels[m[1]] = { ...channelBrief(ch), createdAt: now() };
    if (method === "GET") return json(res, 200, { messages: db.messages[m[1]] || [] });
    if (method === "POST") {
      if (!me) return err(res, 401, "Not logged in");
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const msg = { id: uid(), channelId: ch.id, authorId: me.id, text: String(body.text || "").slice(0, 4000), createdAt: now() };
      (db.messages[ch.id] = db.messages[ch.id] || []).push(msg);
      save();
      broadcast({ t: "threadmsg", channel: ch.id, message: msg }, ch.id);
      return json(res, 200, { message: msg });
    }
  }
  m = route.match(/^\/api\/channels\/([^/]+)\/pins$/);
  if (m) return json(res, 200, { pins: [] });
  m = route.match(/^\/api\/channels\/([^/]+)\/read$/);
  if (m && method === "POST") {
    if (!me) return err(res, 401, "Not logged in");
    db.unreads[me.id] = db.unreads[me.id] || {};
    db.unreads[me.id][m[1]] = now();
    save();
    return json(res, 200, { ok: true });
  }
  if (route === "/api/unread") {
    if (!me) return err(res, 401, "Not logged in");
    return json(res, 200, { unread: db.unreads[me.id] || {} });
  }

  /* ---- friends ---- */
  if (route === "/api/friends") {
    if (!me) return err(res, 401, "Not logged in");
    const list = (db.friends[me.id] || []).map((f) => ({
      id: f.id, state: f.state, user: userPublic(db.users[f.userId]),
    })).filter((f) => f.user);
    return json(res, 200, { friends: list });
  }
  if (route === "/api/friends/requests" && method === "POST") {
    if (!me) return err(res, 401, "Not logged in");
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const target = Object.values(db.users).find((x) => x.username === String(body.username || "").toLowerCase());
    if (!target) return err(res, 404, "No user with that name");
    if (target.id === me.id) return err(res, 400, "You cannot friend yourself");
    const fid = uid();
    db.friends[me.id] = db.friends[me.id] || [];
    db.friends[target.id] = db.friends[target.id] || [];
    db.friends[me.id].push({ id: fid, userId: target.id, state: "pending_out" });
    db.friends[target.id].push({ id: fid, userId: me.id, state: "pending_in" });
    save();
    return json(res, 200, { ok: true });
  }
  m = route.match(/^\/api\/friends\/requests\/([^/]+)\/(accept|decline)$/);
  if (m && method === "POST") {
    if (!me) return err(res, 401, "Not logged in");
    for (const f of db.friends[me.id] || []) {
      if (f.id === m[1]) f.state = m[2] === "accept" ? "friends" : "declined";
    }
    save();
    return json(res, 200, { ok: true });
  }
  m = route.match(/^\/api\/friends\/([^/]+)$/);
  if (m && method === "DELETE") {
    if (!me) return err(res, 401, "Not logged in");
    db.friends[me.id] = (db.friends[me.id] || []).filter((f) => f.id !== m[1]);
    save();
    return json(res, 200, { ok: true });
  }

  /* ---- servers (single "Chalkle" server shape) ---- */
  if (route === "/api/servers") {
    return json(res, 200, { servers: Object.values(db.servers).map((s) => ({ id: s.id, name: s.name })) });
  }
  m = route.match(/^\/api\/servers\/([^/]+)$/);
  if (m) {
    const srv = db.servers[m[1]];
    if (!srv) return err(res, 404, "Server not found");
    const chans = Object.values(db.channels).filter((c) => c.serverId === srv.id);
    return json(res, 200, {
      server: { id: srv.id, name: srv.name, categories: (srv.categories || []).map((cat) => ({
        id: cat.id, name: cat.name,
        channels: cat.channels.map((cid) => channelBrief(db.channels[cid])).filter(Boolean),
      })) },
      channels: chans.map(channelBrief),
    });
  }
  m = route.match(/^\/api\/servers\/([^/]+)\/(bans|invites|audit|reports)/);
  if (m) return json(res, 200, { bans: [], invites: [], audit: [], reports: [] });

  if (route === "/api/auth/recovery-code" || route.startsWith("/api/auth/recovery-code/")) {
    return err(res, 400, "Recovery codes are not enabled on this server");
  }
  if (route.startsWith("/api/auth/recover")) {
    return err(res, 400, "Account recovery is not enabled on this server");
  }

  return err(res, 404, "Unknown Bitcord route: " + method + " " + route);
});

/* ------------------------------------------------------------ ws upgrade */
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const route = u.pathname.replace(/^\/bitcord/, "");
  if (route !== "/ws" || !wss) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const client = { ws, userId: null, subs: new Set() };
    clients.add(client);
    ws.on("message", (raw) => {
      let e;
      try { e = JSON.parse(String(raw)); } catch { return; }
      if (e.t === "sub" && e.channel) client.subs.add(e.channel);
      else if (e.t === "unsub" && e.channel) client.subs.delete(e.channel);
      else if (e.t === "presence") {
        const cookies = (req.headers.cookie || "").split(/;\s*/);
        for (const c of cookies) {
          const [k, ...rest] = c.split("=");
          if (k.trim() === "bc_session") {
            const s = db.sessions[decodeURIComponent(rest.join("="))];
            if (s) client.userId = s.userId;
          }
        }
        broadcast({ t: "presence", users: presenceList() });
      } else if (e.t === "typing" && e.channel) {
        const who = client.userId && db.users[client.userId]
          ? userPublic(db.users[client.userId])
          : { id: "?", username: "someone", displayName: "Someone" };
        broadcast({ t: "typing", channel: e.channel, user: who }, e.channel);
      }
    });
    ws.on("close", () => {
      clients.delete(client);
      broadcast({ t: "presence", users: presenceList() });
    });
    try { ws.send(JSON.stringify({ t: "presence", users: presenceList() })); } catch (e2) {}
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[bitcord] backend listening on 127.0.0.1:${PORT}`));
