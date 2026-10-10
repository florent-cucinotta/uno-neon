// Standalone Uno server: serves public/ and the /api routes, keeps games in memory.
// Runs on any Node 18+ host (Render, Railway, a VPS, your own PC). Start with `npm start`.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { applyAct, botStep, idleStep, newState, view, cleanName } from "./public/engine.js";

const PORT = +process.env.PORT || 3000;

/* ---------- Discord login + battle-pass storage ----------
 * Env vars (set them in the Render dashboard, never in the repo):
 *   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET  -> Discord application (OAuth2)
 *   PUBLIC_URL                                -> e.g. https://uno-neon.onrender.com
 *   SESSION_SECRET                            -> signs the login cookie
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN -> where pass progress is kept
 * Without Upstash, progress is kept in memory and lost when the server sleeps. */
const DISCORD_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_SECRET = process.env.DISCORD_CLIENT_SECRET;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
const KV_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const discordOn = !!(DISCORD_ID && DISCORD_SECRET);
const kvOn = !!(KV_URL && KV_TOKEN);
const secureCookies = PUBLIC_URL.startsWith("https");
const memPass = new Map();

async function kvGet(key) {
  if (!kvOn) return memPass.get(key) ?? null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) throw new Error("storage read " + r.status);
  return (await r.json()).result ?? null;
}
async function kvSet(key, value) {
  if (!kvOn) { memPass.set(key, value); return; }
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}` }, body: value });
  if (!r.ok) throw new Error("storage write " + r.status);
}
function cookies(req) {
  const o = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) { try { o[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  return o;
}
function setCookie(res, name, value, maxAge) {
  const c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? "; Secure" : ""}`;
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", prev ? [].concat(prev, c) : c);
}
const sign = s => createHmac("sha256", SESSION_SECRET).update(s).digest("base64url");
function makeSession(u) {
  const body = Buffer.from(JSON.stringify({ ...u, exp: Date.now() + 30 * 86400_000 })).toString("base64url");
  return body + "." + sign(body);
}
function readSession(req) {
  const t = cookies(req).uno_sess; if (!t) return null;
  const [b, s] = t.split("."); if (!b || !s) return null;
  const expect = Buffer.from(sign(b)), got = Buffer.from(s);
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return null;
  try { const u = JSON.parse(Buffer.from(b, "base64url").toString()); return u.exp > Date.now() ? u : null; } catch { return null; }
}
function redirect(res, location) { res.writeHead(302, { Location: location, "cache-control": "no-store" }); res.end(); }
const SKIN_RE = /^[a-z]{2,20}$/;
function cleanPass(p) {
  if (!p || typeof p !== "object") return null;
  return {
    xp: Math.max(0, Math.min(10_000_000, Math.floor(+p.xp || 0))),
    claimed: Array.isArray(p.claimed) ? p.claimed.filter(x => typeof x === "string" && x.length <= 60).slice(-200) : [],
    table: SKIN_RE.test(p.table) ? p.table : "neon",
    deck: SKIN_RE.test(p.deck) ? p.deck : "classic",
    avatar: SKIN_RE.test(p.avatar) ? p.avatar : "robot",
  };
}

async function auth(req, res, route) {
  if (route === "discord") {
    if (!discordOn) return redirect(res, "/#discord-off");
    const state = randomBytes(16).toString("hex");
    setCookie(res, "uno_state", state, 600);
    const q = new URLSearchParams({ client_id: DISCORD_ID, response_type: "code", redirect_uri: PUBLIC_URL + "/auth/discord/callback", scope: "identify", state, prompt: "none" });
    return redirect(res, "https://discord.com/oauth2/authorize?" + q);
  }
  if (route === "discord/callback") {
    const u = new URL(req.url, "http://x");
    const code = u.searchParams.get("code"), state = u.searchParams.get("state");
    if (!discordOn || !code || !state || state !== cookies(req).uno_state) return redirect(res, "/#discord-erreur");
    const tr = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: DISCORD_ID, client_secret: DISCORD_SECRET, grant_type: "authorization_code", code, redirect_uri: PUBLIC_URL + "/auth/discord/callback" }),
    });
    if (!tr.ok) { console.error("discord token", tr.status, await tr.text()); return redirect(res, "/#discord-erreur"); }
    const tk = await tr.json();
    const ur = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${tk.access_token}` } });
    if (!ur.ok) return redirect(res, "/#discord-erreur");
    const du = await ur.json();
    setCookie(res, "uno_state", "", 0);
    setCookie(res, "uno_sess", makeSession({ id: String(du.id), name: String(du.global_name || du.username || "Joueur").slice(0, 32), av: du.avatar || null }), 30 * 86400);
    return redirect(res, "/#discord-ok");
  }
  if (route === "logout" && req.method === "POST") { setCookie(res, "uno_sess", "", 0); return send(res, 200, { ok: true }); }
  res.writeHead(404); res.end();
}
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const BOT_DELAY = 900;
const IDLE_LIMIT = 60_000;
const GAME_TTL = 6 * 3600_000;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const games = new Map(); // code -> state

const okId = x => typeof x === "string" && /^[A-Za-z0-9_-]{4,40}$/.test(x);
const okCode = x => typeof x === "string" && /^[A-Z]{4}$/.test(x);
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
function genCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (;;) { let c = ""; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; if (!games.has(c)) return c; }
}
function commit(s) { s.v = (s.v || 0) + 1; s.updated = Date.now(); }
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 20_000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

// Bots and idle players advance on a server tick, so games keep moving without anyone polling.
setInterval(() => {
  const now = Date.now();
  for (const [code, s] of games) {
    if (now - s.updated > GAME_TTL || !s.players.some(p => !p.bot)) { games.delete(code); continue; }
    if (s.status !== "playing") continue;
    const cur = s.players[s.turn];
    const age = now - s.updated;
    if (cur.bot && age > BOT_DELAY) { if (botStep(s)) commit(s); }
    else if (!cur.bot && age > IDLE_LIMIT) { if (idleStep(s)) commit(s); }
  }
}, 250);

async function api(req, res, route) {
  if (req.method === "GET" && route === "tables") {
    const tables = [];
    for (const s of games.values()) {
      const humans = s.players.filter(p => !p.bot);
      if (s.status !== "lobby" || !humans.length) continue;
      const host = s.players.find(p => p.id === s.hostId) || humans[0];
      tables.push({ code: s.code, host: host.name, n: s.players.length, updated: s.updated });
    }
    tables.sort((a, b) => b.updated - a.updated);
    return send(res, 200, { tables: tables.slice(0, 30) });
  }
  if (req.method === "GET" && route === "me") {
    const u = readSession(req);
    if (!u) return send(res, 200, { discord: discordOn, saved: kvOn, user: null });
    const raw = await kvGet("pass:" + u.id);
    const avatar = u.av ? `https://cdn.discordapp.com/avatars/${u.id}/${u.av}.png?size=64` : null;
    return send(res, 200, { discord: discordOn, saved: kvOn, user: { name: u.name, avatar }, pass: raw ? cleanPass(JSON.parse(raw)) : null });
  }
  if (req.method === "POST" && route === "pass") {
    const u = readSession(req);
    if (!u) return send(res, 401, { error: "Connecte-toi avec Discord pour sauvegarder." });
    const b = await readBody(req);
    const p = cleanPass(b && b.pass);
    if (!p) return send(res, 400, { error: "Progression invalide" });
    const raw = await kvGet("pass:" + u.id);
    const old = raw ? cleanPass(JSON.parse(raw)) : null;
    const merged = old ? { ...p, xp: Math.max(old.xp, p.xp), claimed: [...new Set([...old.claimed, ...p.claimed])].slice(-200) } : p;
    await kvSet("pass:" + u.id, JSON.stringify(merged));
    return send(res, 200, { pass: merged });
  }
  if (req.method !== "POST") return send(res, 404, { error: "Route inconnue" });
  const b = await readBody(req);
  if (!b || !okId(b.pid) || !okId(b.key)) return send(res, 400, { error: "Requête invalide" });
  const { pid, key } = b;

  if (route === "create") {
    if (games.size > 2000) return send(res, 503, { error: "Serveur plein, réessaie plus tard." });
    const code = genCode();
    const s = newState(code, { id: pid, name: cleanName(b.name), lvl: b.lvl, skin: b.skin, key });
    games.set(code, s);
    return send(res, 200, { view: view(s, pid) });
  }

  if (!okCode(b.code)) return send(res, 400, { error: "Code de table invalide" });
  const s = games.get(b.code);
  if (!s) return send(res, 404, { error: "Cette table n'existe plus." });

  if (route === "state") {
    if (+b.v === s.v) return send(res, 200, { same: true });
    return send(res, 200, { view: view(s, pid) });
  }

  if (route === "act") {
    const a = b.act && typeof b.act === "object" ? b.act : {};
    const p = s.players.find(q => q.id === pid);
    let r;
    if (a.type === "join") r = p && p.key && p.key !== key ? "Identifiant déjà utilisé à cette table." : applyAct(s, pid, { ...a, key });
    else if (!p || p.key !== key) r = "Tu ne fais pas partie de cette table.";
    else r = applyAct(s, pid, a);
    if (typeof r === "string") return send(res, 409, { error: r, view: view(s, pid) });
    if (r !== false) commit(s);
    if (!s.players.some(q => !q.bot)) games.delete(s.code);
    return send(res, 200, { view: view(s, pid) });
  }
  return send(res, 404, { error: "Route inconnue" });
}

async function serveStatic(req, res, path) {
  const rel = normalize(decodeURIComponent(path === "/" ? "/index.html" : path)).replace(/^([\\/])+/, "");
  if (rel.includes("..")) { res.writeHead(400); return res.end(); }
  try {
    const data = await readFile(join(ROOT, rel));
    res.writeHead(200, { "content-type": MIME[extname(rel)] || "application/octet-stream", "cache-control": rel.endsWith(".html") ? "no-cache" : "public, max-age=300" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Introuvable");
  }
}

http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/healthz") { res.writeHead(200); return res.end("ok"); }
    if (path.startsWith("/api/")) return await api(req, res, path.slice(5));
    if (path.startsWith("/auth/")) return await auth(req, res, path.slice(6));
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    return await serveStatic(req, res, path);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: "Erreur serveur, réessaie." });
  }
}).listen(PORT, () => console.log(`Uno Néon prêt sur http://localhost:${PORT} · Discord ${discordOn ? "activé" : "désactivé"} · sauvegarde ${kvOn ? "Upstash" : "en mémoire"}`));
