// Uno rules engine, shared by the Netlify function (server-authoritative online games)
// and the browser (offline solo games). Pure functions over a plain JSON state.

export const COLORS = ['r', 'y', 'g', 'b'];
export const CNAME = { r: 'Rouge', y: 'Jaune', g: 'Vert', b: 'Bleu' };
export const MAXP = 8;
const BOTNAMES = ['Ada', 'Max', 'Léa', 'Tom', 'Zoé', 'Hugo', 'Inès', 'Noé'];
export const SKINS = ['robot', 'cat', 'punk', 'astro', 'pirate', 'dj', 'alien', 'ninja', 'ghost', 'king'];
const cleanSkin = k => (SKINS.includes(k) ? k : 'robot');

const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function newDeck() {
  const d = [];
  for (const c of COLORS) { d.push(c + '0'); for (let i = 1; i <= 9; i++) d.push(c + i, c + i); for (const a of 'SRD') d.push(c + a, c + a); }
  for (let i = 0; i < 4; i++) d.push('wW', 'wF');
  return shuffle(d);
}
export const isNum = c => typeof c === 'string' && /^[0-9]$/.test(c[1]);
export const canPlayOn = (top, color, c) => typeof c === 'string' && (c[0] === 'w' || c[0] === color || c[1] === top[1]);
const topCard = s => s.discard[s.discard.length - 1];
const canPlay = (s, c) => canPlayOn(topCard(s), s.color, c);
const nextIdx = (s, k = 1) => { const n = s.players.length; return (((s.turn + s.dir * k) % n) + n) % n; };
const pname = (s, id) => (s.players.find(p => p.id === id) || {}).name || '?';
const isBot = (s, id) => !!(s.players.find(p => p.id === id) || {}).bot;
function addLog(s, t) { s.log = [...(s.log || []), t].slice(-5); }
export function cardLabel(c) {
  const col = CNAME[c[0]];
  switch (c[1]) { case 'S': return 'Passe ' + col; case 'R': return 'Inversion ' + col; case 'D': return '+2 ' + col; case 'W': return 'Joker'; case 'F': return '+4'; default: return col + ' ' + c[1]; }
}
export function cleanName(n) { return String(n || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Joueur'; }
const clampLvl = l => Math.max(0, Math.min(99, Math.floor(+l || 0)));

export function newState(code, host) {
  const now = Date.now();
  return { code, status: 'lobby', hostId: host.id, players: [{ id: host.id, name: cleanName(host.name), bot: false, lvl: clampLvl(host.lvl), skin: cleanSkin(host.skin), key: host.key }],
    hands: {}, deck: [], discard: [], color: 'r', turn: 0, dir: 1, drew: false, unoCalled: {}, vulnerable: null, winner: null,
    wins: {}, played: {}, log: [], round: 0, v: 1, updated: now, created: now };
}
export function isHost(s, pid) {
  if (s.hostId === pid) return true;
  const hostHuman = s.players.some(p => p.id === s.hostId && !p.bot);
  return !hostHuman && s.players.some(p => p.id === pid && !p.bot);
}
function botPlayer(s) {
  const used = new Set(s.players.map(p => p.name));
  const name = BOTNAMES.map(b => 'Bot ' + b).find(b => !used.has(b)) || 'Bot ' + (s.players.length + 1);
  const taken = new Set(s.players.map(p => p.skin));
  const free = SKINS.filter(k => !taken.has(k));
  const pool = free.length ? free : SKINS;
  return { id: 'bot_' + Math.random().toString(36).slice(2, 9), name, bot: true, lvl: 0, skin: pool[Math.floor(Math.random() * pool.length)] };
}

function drawCards(s, pid, n) {
  const h = s.hands[pid] || (s.hands[pid] = []); const got = [];
  for (let i = 0; i < n; i++) {
    if (!s.deck.length) { const t = s.discard.pop(); s.deck = shuffle(s.discard); s.discard = [t]; if (!s.deck.length) break; }
    const c = s.deck.pop(); h.push(c); got.push(c);
  }
  s.unoCalled[pid] = false;
  return got;
}
export function deal(s) {
  const d = newDeck(); s.hands = {};
  for (const p of s.players) s.hands[p.id] = d.splice(0, 7);
  const i = d.findIndex(c => c[0] !== 'w' && isNum(c)); const t = d.splice(i, 1)[0];
  s.deck = d; s.discard = [t]; s.color = t[0]; s.dir = 1; s.turn = Math.floor(Math.random() * s.players.length);
  s.drew = false; s.unoCalled = {}; s.vulnerable = null; s.winner = null; s.status = 'playing'; s.round = (s.round || 0) + 1;
  s.wins = s.wins || {}; s.played = {}; s.lastBy = null;
  s.log = []; addLog(s, 'Manche ' + s.round + ' : ' + s.players[s.turn].name + ' commence.');
}

function play(s, pid, card, color) {
  if (s.status !== 'playing') return false;
  const p = s.players[s.turn]; if (!p || p.id !== pid) return false;
  const h = s.hands[pid]; if (!h || typeof card !== 'string') return false;
  const i = h.indexOf(card); if (i < 0 || !canPlay(s, card)) return false;
  if (s.drew && card !== h[h.length - 1]) return false;
  if (card[0] === 'w' && !COLORS.includes(color)) return false;
  if (s.vulnerable && s.vulnerable !== pid) s.vulnerable = null;
  h.splice(i, 1); s.discard.push(card); s.color = card[0] === 'w' ? color : card[0]; s.drew = false; s.lastBy = pid;
  s.played = s.played || {}; s.played[pid] = (s.played[pid] || 0) + 1;
  let msg = p.name + ' joue ' + cardLabel(card) + (card[0] === 'w' ? ' → ' + CNAME[color] : '');
  if (h.length === 0) { s.status = 'over'; s.winner = pid; s.vulnerable = null; s.wins[pid] = (s.wins[pid] || 0) + 1; addLog(s, msg); addLog(s, p.name + ' gagne la manche !'); return; }
  if (h.length === 1) { if (!s.unoCalled[pid]) s.vulnerable = pid; } else s.unoCalled[pid] = false;
  const t = card[1];
  if (t === 'S') { msg += ' : ' + s.players[nextIdx(s)].name + ' passe son tour'; s.turn = nextIdx(s, 2); }
  else if (t === 'R') { if (s.players.length === 2) { msg += ' et rejoue'; s.turn = nextIdx(s, 2); } else { s.dir *= -1; msg += ' : sens inversé'; s.turn = nextIdx(s); } }
  else if (t === 'D' || t === 'F') { const k = t === 'D' ? 2 : 4; const v = s.players[nextIdx(s)]; drawCards(s, v.id, k); msg += ' : ' + v.name + ' pioche ' + k; s.turn = nextIdx(s, 2); }
  else s.turn = nextIdx(s);
  addLog(s, msg);
}
function drawAction(s, pid) {
  if (s.status !== 'playing' || s.players[s.turn].id !== pid || s.drew) return false;
  if (s.vulnerable && s.vulnerable !== pid) s.vulnerable = null;
  const [c] = drawCards(s, pid, 1); const nm = pname(s, pid);
  if (c && canPlay(s, c)) { s.drew = true; addLog(s, nm + ' pioche une carte'); }
  else { s.turn = nextIdx(s); addLog(s, nm + ' pioche et passe'); }
}
function passAction(s, pid) { if (s.status !== 'playing' || s.players[s.turn].id !== pid || !s.drew) return false; s.drew = false; s.turn = nextIdx(s); addLog(s, pname(s, pid) + ' passe'); }
function callUno(s, pid) {
  const h = s.hands[pid]; if (s.status !== 'playing' || !h || h.length > 2) return false;
  if (s.unoCalled[pid] && s.vulnerable !== pid) return false;
  s.unoCalled[pid] = true; if (s.vulnerable === pid) s.vulnerable = null; addLog(s, pname(s, pid) + ' crie UNO !');
}
function penalize(s, by) {
  const v = s.vulnerable; if (!v || v === by || s.status !== 'playing') return false;
  drawCards(s, v, 2); s.vulnerable = null; addLog(s, pname(s, by) + ' attrape ' + pname(s, v) + ' sans UNO : +2');
}
function leaveState(s, pid) {
  const i = s.players.findIndex(p => p.id === pid); if (i < 0) return false;
  if (s.status === 'lobby') s.players.splice(i, 1);
  else { if (s.players[i].bot) return false; s.players[i].bot = true; addLog(s, s.players[i].name + ' a quitté, un bot prend sa place'); }
  if (s.hostId === pid) { const h = s.players.find(p => !p.bot && p.id !== pid); s.hostId = h ? h.id : null; }
}

function bestColor(h, skip) {
  const n = { r: 0, y: 0, g: 0, b: 0 }; let sk = false;
  for (const c of h) { if (c === skip && !sk) { sk = true; continue; } if (c[0] !== 'w') n[c[0]]++; }
  const m = Math.max(...Object.values(n));
  return m ? COLORS.find(c => n[c] === m) : COLORS[Math.floor(Math.random() * 4)];
}
function pickBot(s, pid) {
  const h = s.hands[pid]; const ok = h.filter(c => canPlay(s, c)); if (!ok.length) return null;
  const nx = s.players[nextIdx(s)]; const danger = (s.hands[nx.id] || []).length <= 2;
  const score = c => { if (c === 'wF') return danger ? 100 : 1; if (c === 'wW') return danger ? 40 : 2; let v = 10; if ('SDR'.includes(c[1])) v = danger ? 90 : 14; if (c[0] === s.color) v += 5; if (isNum(c)) v += (+c[1]) / 10; return v; };
  return ok.sort((a, b) => score(b) - score(a))[0];
}
function botMove(s, pid, catchHumans = true) {
  if (catchHumans && s.vulnerable && s.vulnerable !== pid && !isBot(s, s.vulnerable) && Math.random() < 0.8) penalize(s, pid);
  const h = s.hands[pid]; let c = pickBot(s, pid);
  if (s.drew) { const last = h[h.length - 1]; if (canPlay(s, last)) c = last; else { passAction(s, pid); return; } }
  if (!c) { drawAction(s, pid); if (!s.drew || s.players[s.turn].id !== pid) return; c = h[h.length - 1]; }
  if (h.length === 2) callUno(s, pid);
  play(s, pid, c, bestColor(h, c));
}
/** One move for the bot whose turn it is. Returns true when something changed. */
export function botStep(s) {
  if (s.status !== 'playing') return false;
  const p = s.players[s.turn]; if (!p || !p.bot) return false;
  botMove(s, p.id); return true;
}
/** A human who has been idle too long gets one automatic move. */
export function idleStep(s) {
  if (s.status !== 'playing') return false;
  const p = s.players[s.turn]; if (!p || p.bot) return false;
  addLog(s, p.name + ' tarde : coup automatique');
  botMove(s, p.id, false); return true;
}

/** Apply one player's action. Returns undefined (changed), false (nothing to do) or an error message. */
export function applyAct(s, pid, a) {
  a = a || {};
  const host = isHost(s, pid);
  switch (a.type) {
    case 'join': {
      const p = s.players.find(q => q.id === pid);
      if (p) { if (p.bot && s.status !== 'playing') { p.bot = false; p.name = cleanName(a.name); p.lvl = clampLvl(a.lvl); p.skin = cleanSkin(a.skin); return; } return false; }
      if (s.status === 'playing') return 'Partie en cours : tu pourras rejoindre à la fin de la manche.';
      if (s.players.length >= MAXP) return 'Cette table est complète.';
      s.players.push({ id: pid, name: cleanName(a.name), bot: false, lvl: clampLvl(a.lvl), skin: cleanSkin(a.skin), key: a.key });
      return;
    }
    case 'play': return play(s, pid, a.card, a.color);
    case 'draw': return drawAction(s, pid);
    case 'pass': return passAction(s, pid);
    case 'uno': return callUno(s, pid);
    case 'catch': return penalize(s, pid);
    case 'leave': return leaveState(s, pid);
    case 'start': if (!host || s.status !== 'lobby') return false; if (s.players.length < 2) return 'Il faut au moins 2 joueurs.'; deal(s); return;
    case 'again': if (!host || s.status !== 'over') return false; deal(s); return;
    case 'addbot': if (!host || s.status !== 'lobby' || s.players.length >= MAXP) return false; s.players.push(botPlayer(s)); return;
    case 'kick': { if (!host || s.status !== 'lobby' || a.target === pid) return false; const n = s.players.length; s.players = s.players.filter(p => p.id !== a.target); return s.players.length === n ? false : undefined; }
    case 'botify': { if (!host || s.status !== 'playing' || a.target === pid) return false; const q = s.players.find(p => p.id === a.target); if (!q || q.bot) return false; q.bot = true; addLog(s, q.name + ' est remplacé par un bot'); return; }
  }
  return false;
}

/** What one player is allowed to see: their own hand, everyone else's card count. */
export function view(s, pid) {
  return {
    code: s.code, status: s.status, hostId: s.hostId,
    players: s.players.map(p => ({ id: p.id, name: p.name, bot: !!p.bot, lvl: p.lvl || 0, skin: p.skin || 'robot', n: (s.hands[p.id] || []).length })),
    lastBy: s.lastBy || null,
    hand: [...(s.hands[pid] || [])], top: s.discard.slice(-3), discardN: s.discard.length, deckN: s.deck.length,
    color: s.color, turn: s.turn, dir: s.dir, drew: s.drew, unoCalled: { ...s.unoCalled }, vulnerable: s.vulnerable,
    winner: s.winner, wins: { ...s.wins }, played: { ...(s.played || {}) }, log: [...(s.log || [])],
    round: s.round, v: s.v, created: s.created, updated: s.updated,
  };
}
