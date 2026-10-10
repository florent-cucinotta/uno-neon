// Standalone Uno server: serves public/ and the /api routes, keeps games in memory.
// Runs on any Node 18+ host (Render, Railway, a VPS, your own PC). Start with `npm start`.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAct, botStep, idleStep, newState, view, cleanName } from "./public/engine.js";

const PORT = +process.env.PORT || 3000;
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
  if (req.method !== "POST") return send(res, 404, { error: "Route inconnue" });
  const b = await readBody(req);
  if (!b || !okId(b.pid) || !okId(b.key)) return send(res, 400, { error: "Requête invalide" });
  const { pid, key } = b;

  if (route === "create") {
    if (games.size > 2000) return send(res, 503, { error: "Serveur plein, réessaie plus tard." });
    const code = genCode();
    const s = newState(code, { id: pid, name: cleanName(b.name), lvl: b.lvl, key });
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
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    return await serveStatic(req, res, path);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: "Erreur serveur, réessaie." });
  }
}).listen(PORT, () => console.log(`Uno Néon prêt sur http://localhost:${PORT}`));
