'use strict';
/* =====================================================================
   AVENTURIA — SERVIDOR GLOBAL
   Sem dependências: só precisa do Node 18+.   Uso:  node server.js
   - Serve o jogo (aventuria_mmorpg_v5.html) em http://HOST:PORT/
   - WebSocket em ws://HOST:PORT/ (mesmo endereço)
   - Todos os jogadores caem no MESMO mapa (semente fixa)
   - Raids: o servidor controla chefes/lacaios; todos lutam juntos
   - PvP: só entre quem ligou o PvP, fora da Área Safe
   - Construções: temporárias (somem sozinhas após STRUCT_TTL)
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------- CONFIG ------------------------- */
const PORT = +process.env.PORT || 3000;
const SEED = +process.env.SEED || 20260101;          // tem que ser a mesma do cliente (o servidor manda no welcome)
const MAX_PLAYERS = +process.env.MAX_PLAYERS || 100;
const STRUCT_TTL = (+process.env.STRUCT_TTL_SEC || 600) * 1000; // construções duram 10 min
const MAX_STRUCT_PER_PLAYER = 40;
const MAX_STRUCT_TOTAL = 3000;
const TICK = 50;                                     // 20 Hz
const AOI = 2600;                                    // raio de interesse (px) para enviar jogadores/chefes
const CLIENT_FILE = path.join(__dirname, 'aventuria_mmorpg_v5.html');

/* ------------------------- MUNDO (idêntico ao cliente) ------------------------- */
const TILE = 32, MT = 125, MAP = TILE * MT, CX = MAP / 2;
const SAFE = { x: CX, y: CX, radius: 260 };
const BKEYS = ['forest', 'desert', 'snow', 'swamp', 'volcano'];
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function hash2(x, y, seed) { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
function vnoise(x, y, seed) { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, s = t => t * t * (3 - 2 * t); const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed), u = s(xf), v = s(yf); return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; }
function biomeCalc(x, y) {
  const dx = x - CX, dy = y - CX, r = Math.hypot(dx, dy), n = vnoise(x / 260, y / 260, SEED) - .5;
  if (r < 720 + n * 380) return 'forest';
  let a = Math.atan2(dy, dx) + n * 1.1; a = (a / (Math.PI * 2) + 1) % 1;
  return a < .25 ? 'desert' : a < .5 ? 'swamp' : a < .75 ? 'snow' : 'volcano';
}
const TB = new Uint8Array(MT * MT);
for (let ty = 0; ty < MT; ty++) for (let tx = 0; tx < MT; tx++) TB[ty * MT + tx] = BKEYS.indexOf(biomeCalc(tx * TILE + 16, ty * TILE + 16));
function biomeAt(x, y) { const tx = Math.max(0, Math.min(MT - 1, Math.floor(x / TILE))), ty = Math.max(0, Math.min(MT - 1, Math.floor(y / TILE))); return BKEYS[TB[ty * MT + tx]]; }
const PONDS = [];
(function genPonds() {
  const r = mulberry32(SEED), P = PONDS;
  P.push({ x: CX - 520, y: CX + 380, r: 135, kind: 'water' });
  const want = { snow: [['ice', 3]], swamp: [['swamp', 6]], volcano: [['lava', 5]], desert: [['water', 1]] };
  for (const b in want) for (const [kind, n] of want[b]) {
    let k = 0, tries = 0;
    while (k < n && tries++ < 400) {
      const x = 200 + r() * (MAP - 400), y = 200 + r() * (MAP - 400);
      if (biomeAt(x, y) !== b || biomeAt(x + 90, y + 90) !== b || biomeAt(x - 90, y - 90) !== b) continue;
      if (Math.hypot(x - CX, y - CX) < SAFE.radius + 260) continue;
      const rad = kind === 'water' ? 70 : kind === 'lava' ? 60 : kind === 'ice' ? 100 : 75;
      if (P.some(p => Math.hypot(p.x - x, p.y - y) < p.r + rad + 120)) continue;
      P.push({ x, y, r: rad, kind }); k++;
    }
  }
})();
function pondAt(x, y, pad) { pad = pad || 0; for (const p of PONDS) if (Math.hypot(x - p.x, y - p.y) < p.r + pad) return p; return null; }

/* ------------------------- DADOS DE RAID (iguais ao cliente) ------------------------- */
const TIERS = [
  { n: 'Comum', hp: 600, dmg: 10, sz: 34, req: 1, min: 380, minions: 3, spd: 1.7, cd: 3.8, col: '#d1d5db' },
  { n: 'Incomum', hp: 1400, dmg: 17, sz: 40, req: 7, min: 600, minions: 4, spd: 1.9, cd: 3.4, col: '#4ade80' },
  { n: 'Rara', hp: 3200, dmg: 28, sz: 46, req: 15, min: 900, minions: 5, spd: 2.0, cd: 3.0, col: '#60a5fa' },
  { n: 'Épica', hp: 7500, dmg: 44, sz: 54, req: 25, min: 1200, minions: 6, spd: 2.1, cd: 2.6, col: '#c084fc' },
  { n: 'LENDÁRIA', hp: 18000, dmg: 70, sz: 64, req: 38, min: 1450, minions: 7, spd: 2.2, cd: 2.2, col: '#fbbf24' }
];
const BOSS_NAMES = {
  forest: ['Javali Rei', 'Lobo Alfa Sombrio', 'Ent Corrompido', 'Cervo Espectral', 'Guardião Ancestral'],
  desert: ['Escorpião Gigante', 'Chacal Bandido', 'Faraó de Areia', 'Rainha Escorpiã', 'Colosso do Deserto Eterno'],
  snow: ['Urso Polar Alfa', 'Lobo da Geada', 'Yeti Titã', 'Bruxa do Inverno', 'Dragão de Gelo Eterno'],
  swamp: ['Crocodilo Ancião', 'Sapo-Gigante Venenoso', 'Bruxa do Lodo', 'Hidra do Pântano', 'Leviatã do Brejo'],
  volcano: ['Salamandra Ardente', 'Cão do Inferno', 'Golem de Magma', 'Senhor das Cinzas', 'Dragão Ígneo Primordial']
};
const BOSS_COL = { forest: '#3d7a4b', desert: '#b8863a', snow: '#8cc4e0', swamp: '#5f7a3a', volcano: '#a8321a' };
const BOSS_PROFILE = {
  forest: { hp: 1.1, spd: 1.2, dmg: .95, pool: ['slam', 'charge', 'charge', 'fan'] },
  desert: { hp: .9, spd: 1.0, dmg: 1.15, pool: ['rain', 'rain', 'charge', 'slam'] },
  snow: { hp: 1.3, spd: .85, dmg: 1.0, pool: ['nova', 'fan', 'slam'] },
  swamp: { hp: 1.2, spd: .9, dmg: .9, pool: ['rain', 'fan', 'slam', 'slam'] },
  volcano: { hp: 1.0, spd: 1.1, dmg: 1.25, pool: ['nova', 'charge', 'rain', 'fan'] }
};
const MINION_KIND = { forest: 'lobo', desert: 'escorpiao', snow: 'lobo_gelo', swamp: 'slime', volcano: 'lobo_infernal' };
const MINION_DEF = {
  lobo: { n: 'Lobo', hp: 55, spd: 2.7, sz: 11, dmg: 7, xp: 22 },
  escorpiao: { n: 'Escorpião', hp: 45, spd: 2.0, sz: 11, dmg: 9, xp: 24 },
  lobo_gelo: { n: 'Lobo de Gelo', hp: 70, spd: 2.7, sz: 11, dmg: 9, xp: 34 },
  slime: { n: 'Slime', hp: 40, spd: .9, sz: 14, dmg: 5, xp: 30 },
  lobo_infernal: { n: 'Lobo Infernal', hp: 95, spd: 2.8, sz: 12, dmg: 13, xp: 42 }
};
const OKT = { slam: 0, charge: 1, fan: 1, rain: 2, nova: 3 };
const MAX_ACTIVE_RAIDS = 8;

/* ------------------------- UTIL ------------------------- */
const rand = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function rollRarity(w) { let t = w.reduce((a, b) => a + b, 0), r = Math.random() * t; for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; } return 0; }
const now = () => Date.now();
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
const inSafe = p => Math.hypot(p.x - SAFE.x, p.y - SAFE.y) <= SAFE.radius;

/* ------------------------- ESTADO ------------------------- */
let nextId = 1;
const players = new Map();      // id -> player
const structs = new Map();      // id -> struct
const cellKey = (gx, gy) => gx + ',' + gy;
const cells = new Map();        // "gx,gy" -> struct id
const raids = [];               // raids ativas
const minions = new Map();      // id -> minion
const projs = [];               // projéteis inimigos
const hazards = [];             // áreas de ataque pendentes
let nextRaidId = 1, nextMinionId = 1, nextStructId = 1;
let spawnTimer = 12;

/* ------------------------- WEBSOCKET (implementação mínima) ------------------------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsSend(sock, str) {
  if (sock.destroyed || !sock.writable) return;
  const payload = Buffer.from(str), len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x81;
  try { sock.write(Buffer.concat([head, payload])); } catch (e) { /* ignora */ }
}
function wsPing(sock) { try { sock.write(Buffer.from([0x89, 0])); } catch (e) { } }
function wsClose(sock, code) { try { const b = Buffer.alloc(4); b[0] = 0x88; b[1] = 2; b.writeUInt16BE(code || 1000, 2); sock.write(b); } catch (e) { } try { sock.end(); } catch (e) { } }

function attachWS(sock, onMessage, onClose) {
  let buf = Buffer.alloc(0), frag = [];
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 1 << 20) { sock.destroy(); return; }
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 64 * 1024) { sock.destroy(); return; }
      if (!masked) { sock.destroy(); return; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.slice(off, off + 4), data = Buffer.alloc(len);
      for (let i = 0; i < len; i++) data[i] = buf[off + 4 + i] ^ mask[i & 3];
      buf = buf.slice(off + 4 + len);
      if (op === 0x8) { wsClose(sock, 1000); return; }
      if (op === 0x9) { try { const h = Buffer.alloc(2); h[0] = 0x8a; h[1] = len; sock.write(Buffer.concat([h, data.slice(0, 125)])); } catch (e) { } continue; }
      if (op === 0xa) { sock._alive = true; continue; }
      if (op === 0x1 || op === 0x0) {
        frag.push(data);
        if (fin) { const msg = Buffer.concat(frag).toString('utf8'); frag = []; onMessage(msg); }
      }
    }
  });
  sock.on('close', onClose); sock.on('error', () => { }); sock.on('end', () => { try { sock.end(); } catch (e) { } });
}

/* ------------------------- HTTP (serve o jogo) ------------------------- */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, players: players.size, raids: raids.length, structs: structs.size })); return; }
  if (url === '/' || url === '/index.html') {
    fs.readFile(CLIENT_FILE, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Coloque aventuria_mmorpg_v5.html na mesma pasta do server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(data);
    });
    return;
  }
  res.writeHead(404); res.end('404');
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  if (players.size >= MAX_PLAYERS) { sock.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const ip = (req.headers['x-forwarded-for'] || sock.remoteAddress || '').toString().split(',')[0].trim();
  const conn = { sock, ip, id: 0, player: null, msgs: 0, msgT: now(), _alive: true };
  attachWS(sock, msg => handleRaw(conn, msg), () => dropPlayer(conn));
});

/* ------------------------- ENVIO ------------------------- */
const J = o => JSON.stringify(o);
function send(p, o) { if (p && p.conn) wsSend(p.conn.sock, J(o)); }
function broadcast(o, except) { const s = J(o); for (const p of players.values()) if (p !== except) wsSend(p.conn.sock, s); }
function near(p, x, y, r) { return Math.abs(p.x - x) < (r || AOI) && Math.abs(p.y - y) < (r || AOI); }
function toNear(x, y, o, r) { const s = J(o); for (const p of players.values()) if (near(p, x, y, r)) wsSend(p.conn.sock, s); }

/* ------------------------- JOGADORES ------------------------- */
function handleRaw(conn, raw) {
  const t = now();
  if (t - conn.msgT > 1000) { conn.msgT = t; conn.msgs = 0; }
  if (++conn.msgs > 140) { wsClose(conn.sock, 1008); return; }
  if (raw.length > 4096) return;
  let m; try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  if (!conn.player) { if (m.t === 'join') joinPlayer(conn, m); return; }
  handleMsg(conn.player, m);
}
function joinPlayer(conn, m) {
  const id = nextId++;
  const p = {
    id, conn, name: clean(m.name, 16) || 'Herói', cls: clean(m.cls, 14), race: clean(m.race, 14), hair: /^#[0-9a-f]{6}$/i.test(m.hair) ? m.hair : '#583a2b', eye: /^#[0-9a-f]{6}$/i.test(m.eye) ? m.eye : '#28211b',
    lvl: Math.max(1, Math.min(60, num(m.lvl, 1) | 0)), inventory: Array.isArray(m.inventory) ? m.inventory.slice(0,60) : [], equipment: m.equipment && typeof m.equipment==='object' ? m.equipment : {}, trade: null, x: SAFE.x, y: SAFE.y + 110, dir: 'down', mv: 0, hp: 100, mh: 100, pvp: false, at: 0, aa: 0, tr: 0,
    hitTokens: 12, hitT: now(), lastChat: 0, lastBuild: 0, structCount: 0, lastHitBy: new Map(), lastKill: new Map(), seen: now(), kills: 0
  };
  const sx = num(m.x, null), sy = num(m.y, null);
  if (sx != null && sy != null) { p.x = Math.max(30, Math.min(MAP - 30, sx)); p.y = Math.max(30, Math.min(MAP - 30, sy)); }
  conn.player = p; conn.id = id; players.set(id, p);
  const t = now();
  send(p, {
    t: 'welcome', id, seed: SEED, ttl: STRUCT_TTL,
    structs: [...structs.values()].map(s => structOut(s, t)),
    raids: raids.map(raidOut),
    roster: roster()
  });
  broadcast({ t: 'sys', m: p.name + ' entrou no mundo.' }, p);
  broadcast({ t: 'roster', roster: roster() });
  console.log(`[+] ${p.name} (#${id}) entrou — ${players.size} online`);
}
function dropPlayer(conn) {
  const p = conn.player; if (!p || !players.has(p.id)) return;
  const other=tradePeer(p); if(other){other.trade=null;send(other,{t:'trade_error',message:'O outro jogador desconectou.'});}
  players.delete(p.id);
  // construções ficam até expirarem (temporárias de qualquer forma)
  broadcast({ t: 'bye', id: p.id });
  broadcast({ t: 'sys', m: p.name + ' saiu.' });
  broadcast({ t: 'roster', roster: roster() });
  console.log(`[-] ${p.name} (#${p.id}) saiu — ${players.size} online`);
}
const roster = () => [...players.values()].map(p => ({ id: p.id, n: p.name, l: p.lvl, c: p.cls, pv: p.pvp ? 1 : 0 }));

function handleMsg(p, m) {
  p.seen = now();
  switch (m.t) {
    case 'p': { // posição / estado
      const x = num(m.x, p.x), y = num(m.y, p.y);
      // anti-teleporte básico: máx ~ 2500 px/s com folga (dash + buffs); acima disso, ignora e corrige
      const dt = Math.max(.02, (now() - (p._pt || now() - 50)) / 1000); p._pt = now();
      const maxStep = 2600 * Math.min(dt, 1) + 120;
      if (Math.hypot(x - p.x, y - p.y) > maxStep && !m.tp) { send(p, { t: 'fix', x: p.x, y: p.y }); break; }
      p.x = Math.max(30, Math.min(MAP - 30, x)); p.y = Math.max(30, Math.min(MAP - 30, y));
      p.dir = ['up', 'down', 'left', 'right'].includes(m.d) ? m.d : p.dir; p.mv = m.m ? 1 : 0;
      p.hp = Math.max(0, num(m.hp, p.hp)); p.mh = Math.max(1, num(m.mh, p.mh)); p.lvl = Math.max(1, Math.min(60, num(m.lvl, p.lvl) | 0));
      p.pvp = !!m.pv; p.at = m.at ? 1 : 0; p.aa = num(m.aa, 0); p.tr = m.tr ? 1 : 0;
      break;
    }
    case 'chat': {
      const t = now(); if (t - p.lastChat < 1000) break; p.lastChat = t;
      const text = clean(m.m, 120); if (!text) break;
      broadcast({ t: 'chat', id: p.id, n: p.name, m: text });
      break;
    }
    case 'hit': return handleHit(p, m);
    case 'build': return handleBuild(p, m);
    case 'demo': return handleDemolish(p, m);
    case 'died': return handleDied(p, m);
    case 'trade_invite': return handleTradeInvite(p,m);
    case 'trade_offer': return handleTradeOffer(p,m);
    case 'trade_accept': return handleTradeAccept(p);
    case 'trade_cancel': return cancelTrade(p,'Negociação cancelada.');
    case 'pong': break;
  }
}


/* ------------------------- TROCA SEGURA (servidor autoritativo) ------------------------- */
function tradePeer(p){return p.trade&&players.get(p.trade.peer)||null}
function tradeState(p){const q=tradePeer(p);send(p,{t:'trade_state',peer:q?q.id:0,offer:q&&q.trade?q.trade.offer:null,peerAccepted:!!(q&&q.trade&&q.trade.accepted)});}
function cancelTrade(p,message){const q=tradePeer(p);p.trade=null;if(q){q.trade=null;send(q,{t:'trade_error',message});}send(p,{t:'trade_error',message});}
function handleTradeInvite(p,m){const q=players.get(num(m.peer,0));if(!q||q===p||p.trade||q.trade||dist(p,q)>180||inSafe(p)===false||inSafe(q)===false)return send(p,{t:'trade_error',message:'Jogador indisponível. Ambos precisam estar próximos e na Área Safe.'});p.trade={peer:q.id,offer:null,accepted:false};q.trade={peer:p.id,offer:null,accepted:false};tradeState(p);tradeState(q);}
function handleTradeOffer(p,m){const q=tradePeer(p);if(!q||dist(p,q)>220||!inSafe(p)||!inSafe(q))return cancelTrade(p,'Troca fora da distância ou da Área Safe.');const id=clean(m.itemId,80),item=p.inventory.find(x=>x&&String(x.id)===id);if(!item)return send(p,{t:'trade_error',message:'Item não pertence ao seu inventário.'});p.trade.offer=id;p.trade.accepted=false;q.trade.accepted=false;tradeState(p);tradeState(q);}
function handleTradeAccept(p){const q=tradePeer(p);if(!q||!p.trade.offer||!q.trade.offer||dist(p,q)>220||!inSafe(p)||!inSafe(q))return send(p,{t:'trade_error',message:'Os dois jogadores precisam oferecer um item e permanecer na Área Safe.'});p.trade.accepted=true;tradeState(q);if(!q.trade.accepted)return tradeState(p);const a=p.inventory.findIndex(x=>String(x.id)===p.trade.offer),b=q.inventory.findIndex(x=>String(x.id)===q.trade.offer);if(a<0||b<0)return cancelTrade(p,'Um dos itens não está mais disponível.');const ia=p.inventory.splice(a,1)[0],ib=q.inventory.splice(b,1)[0];p.inventory.push(ib);q.inventory.push(ia);p.trade=q.trade=null;send(p,{t:'trade_done',inventory:p.inventory});send(q,{t:'trade_done',inventory:q.inventory});}

/* ------------------------- COMBATE: validação de golpes ------------------------- */
function refillHits(p) { const t = now(); p.hitTokens = Math.min(14, p.hitTokens + (t - p.hitT) / 1000 * 12); p.hitT = t; }
const dmgCap = p => 60 + p.lvl * 28;

function handleHit(p, m) {
  refillHits(p); if (p.hitTokens < 1) return; p.hitTokens--;
  if (p.hp <= 0) return;
  let d = num(m.d, 0); if (d <= 0) return; d = Math.min(d, dmgCap(p));
  const k = m.k;
  if (k === 'b') {            // chefe de raid
    const r = raids.find(x => x.id === m.id); if (!r || r.state !== 'active' || r.boss.hp <= 0) return;
    if (dist(p, r.boss) > 640) return;
    damageBoss(r, p, d);
  } else if (k === 'm') {     // lacaio
    const mn = minions.get(m.id); if (!mn || mn.hp <= 0) return;
    if (dist(p, mn) > 640) return;
    mn.hp -= d; mn.hitT = .25; mn.last = p.id;
    if (mn.hp <= 0) {
      minions.delete(mn.id);
      send(p, { t: 'mk', kind: mn.kind, x: mn.x, y: mn.y, m: mn.m });
    }
  } else if (k === 'p') {     // PvP
    const v = players.get(m.id); if (!v || v === p) return;
    if (!p.pvp || !v.pvp) return;
    if (inSafe(p) || inSafe(v)) return;
    if (dist(p, v) > 640) return;
    v.lastHitBy.set(p.id, now());
    send(v, { t: 'hurt', raw: d, src: p.name, from: p.id, kind: 'pvp' });
  }
}
function handleDied(p, m) {
  // vítima avisa que morreu por PvP; servidor confere se o golpe foi recente
  const killer = players.get(m.by); if (!killer || killer === p) return;
  const t = now(), last = p.lastHitBy.get(killer.id);
  if (!last || t - last > 8000) return;
  p.lastHitBy.clear();
  const prev = killer.lastKill.get(p.id) || 0;
  const reward = (t - prev) > 120000;      // anti-farm: mesmo alvo só rende a cada 2 min
  killer.lastKill.set(p.id, t); killer.kills++;
  send(killer, { t: 'kill', vn: p.name, vl: p.lvl, reward });
  broadcast({ t: 'sys', m: `⚔ ${killer.name} derrotou ${p.name} no PvP!` });
}

/* ------------------------- RAIDS ------------------------- */
function raidOut(r) {
  return { id: r.id, tier: r.tier, tierName: TIERS[r.tier].n, req: TIERS[r.tier].req, biome: r.biome, x: r.x, y: r.y, r: r.r, state: r.state, name: r.boss.name, sz: r.boss.sz, hp: r.boss.hp, mh: r.boss.maxHp, participants: r.groupAtStart || 0 };
}
function spawnRaid(forceTier, forceBiome) {
  const act = raids.filter(r => r.state !== 'cleared');
  let tier = forceTier;
  if (tier == null) { tier = rollRarity([40, 28, 18, 10, 4]); if (tier === 4 && act.some(r => r.tier === 4)) tier = 3; if (tier === 3 && act.filter(r => r.tier === 3).length >= 2) tier = 2; }
  const T = TIERS[tier]; let biome = forceBiome;
  if (!biome) { const opts = BKEYS.filter(b => b !== 'forest' || tier <= 1); biome = pick(opts); }
  for (let i = 0; i < 300; i++) {
    const x = 300 + Math.random() * (MAP - 600), y = 300 + Math.random() * (MAP - 600);
    if (biomeAt(x, y) !== biome) continue; const rr = Math.hypot(x - CX, y - CX);
    if (rr < T.min || rr < SAFE.radius + 260) continue; if (pondAt(x, y, 260)) continue;
    if (raids.some(o => Math.hypot(o.x - x, o.y - y) < 600)) continue;
    const PR = BOSS_PROFILE[biome], R = 210 + tier * 22, hp = Math.round(T.hp * PR.hp);
    const raid = {
      id: 'r' + (nextRaidId++), tier, biome, x, y, r: R, state: 'idle', born: now(), removeAt: 0, nextSummon: tier >= 1 ? [.66, .33] : [], dmgBy: new Map(), emptyT: 0, target: null, retarget: 0,
      boss: { name: BOSS_NAMES[biome][tier], x, y, hp, maxHp: hp, dmg: T.dmg * PR.dmg, spd: T.spd * PR.spd, sz: T.sz, cd: 2, swing: 0, atk: null, enr: false, face: 1, last: null }
    };
    raids.push(raid);
    broadcast({ t: 'raids', raids: raids.map(raidOut) });
    broadcast({ t: 'sys', m: `⚔ Raid ${T.n.toUpperCase()} surgiu: ${raid.boss.name}` });
    return raid;
  }
  return null;
}
function playersIn(r, extra) { const out = []; for (const p of players.values()) if (p.hp > 0 && !inSafe(p) && Math.hypot(p.x - r.x, p.y - r.y) <= r.r + (extra || 0)) out.push(p); return out; }
function activateRaid(r, group) {
  r.state = 'active'; const T = TIERS[r.tier], n = Math.max(1, group.length);
  // Modo solo é suportado: chefe com 70% da vida-base e menos lacaios.
  // Em grupo, a vida cresce 55% por participante além do segundo.
  const mult = n === 1 ? 0.70 : 1 + .55 * (n - 2);
  r.boss.maxHp = Math.max(1, Math.round(r.boss.maxHp * mult)); r.boss.hp = r.boss.maxHp; r.groupAtStart = n;
  r.dmgBy = new Map();
  const minionCount = n === 1 ? Math.max(2, Math.ceil(T.minions * .6)) : T.minions + (n - 2);
  for (let i = 0; i < minionCount; i++) spawnMinion(r);
  broadcast({ t: 'raids', raids: raids.map(raidOut) });
  toNear(r.x, r.y, { t: 'rstart', id: r.id, name: r.boss.name, tier: r.tier, req: T.req }, r.r + 1500);
}
function spawnMinion(r) {
  const a = Math.random() * 6.283, d = rand(60, r.r * .8), kind = MINION_KIND[r.biome], def = MINION_DEF[kind];
  const x = r.x + Math.cos(a) * d, y = r.y + Math.sin(a) * d;
  const m = (1 + Math.hypot(x - CX, y - CX) / CX * .9) * (.45 + r.tier * .22);
  const id = 'm' + (nextMinionId++);
  minions.set(id, { id, raid: r.id, kind, def, x, y, hp: def.hp * m, maxHp: def.hp * m, m, dmg: def.dmg * m * 1.1, face: 1, atkCd: rand(0, 1), hitT: 0, last: null });
}
function removeMinions(raidId) { for (const [id, m] of minions) if (m.raid === raidId) minions.delete(id); }
function resetRaid(r) {
  r.state = 'idle'; r.boss.maxHp = Math.round(TIERS[r.tier].hp * BOSS_PROFILE[r.biome].hp); r.boss.hp = r.boss.maxHp; r.boss.x = r.x; r.boss.y = r.y; r.boss.atk = null; r.boss.cd = 2; r.boss.enr = false;
  r.nextSummon = r.tier >= 1 ? [.66, .33] : []; r.dmgBy = new Map(); r.emptyT = 0; r.target = null;
  removeMinions(r.id);
  for (let i = hazards.length - 1; i >= 0; i--) if (hazards[i].raid === r.id) hazards.splice(i, 1);
  broadcast({ t: 'raids', raids: raids.map(raidOut) });
  toNear(r.x, r.y, { t: 'sys', m: `A raid ${r.boss.name} foi reiniciada (ninguém restou na arena).` }, r.r + 1500);
}
function damageBoss(r, p, d) {
  const b = r.boss; d = Math.min(d, b.hp);
  b.hp -= d; b.hitT = .25; r.dmgBy.set(p.id, (r.dmgBy.get(p.id) || 0) + d);
  if (b.hp <= 0) bossDead(r);
}
function bossDead(r) {
  r.state = 'cleared'; r.removeAt = now() + 25000; r.boss.atk = null;
  removeMinions(r.id);
  const parts = [];
  for (const [pid, dmg] of r.dmgBy) { const p = players.get(pid); if (!p) continue; const inArena = Math.hypot(p.x - r.x, p.y - r.y) <= r.r + 150; if (dmg >= r.boss.maxHp * .01 || (inArena && dmg > 0)) parts.push(pid); }
  broadcast({ t: 'raids', raids: raids.map(raidOut) });
  const msg = { t: 'rwin', id: r.id, parts, n: parts.length, top: [...r.dmgBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([pid, d]) => ({ n: (players.get(pid) || {}).name || '?', d: Math.round(d) })) };
  broadcast(msg);
  broadcast({ t: 'sys', m: `🏆 ${r.boss.name} foi derrotado por ${parts.length} jogador(es)!` });
}
function hurtPlayer(p, raw, src, kind) { send(p, { t: 'hurt', raw, src, kind }); }

function enemyProj(r, x, y, ang, spd, dmg, life, col) {
  const pr = { x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, r: 7, dmg, life, raid: r.id };
  projs.push(pr);
  toNear(x, y, { t: 'ev', k: 'proj', x, y, vx: pr.vx, vy: pr.vy, r: 7, life, col }, 1800);
}
function addHazard(r, x, y, rad, t, dmg, col, src) {
  hazards.push({ raid: r.id, x, y, r: rad, t, dmg, src: src || 'Chefe' });
  toNear(x, y, { t: 'ev', k: 'hz', x, y, r: rad, tt: t, col }, 1800);
}
function pickTarget(r) {
  const cand = playersIn(r, 220); if (!cand.length) return null;
  let best = null, bd = 1e9; for (const p of cand) { const d = dist(p, r.boss); if (d < bd) { bd = d; best = p; } }
  return best;
}
function updateRaid(r, dt) {
  const T = TIERS[r.tier], b = r.boss;
  if (r.state === 'cleared') return;
  if (r.state === 'idle') {
    const g = playersIn(r).filter(p => Math.hypot(p.x - r.x, p.y - r.y) < r.r * .8);
    if (g.length) activateRaid(r, playersIn(r)); return;
  }
  // ativa
  const inside = playersIn(r, 320);
  if (!inside.length) { r.emptyT += dt; if (r.emptyT > 5) { resetRaid(r); return; } } else r.emptyT = 0;
  b.hitT = Math.max(0, (b.hitT || 0) - dt); b.swing = Math.max(0, b.swing - dt);
  b.enr = b.hp < b.maxHp * .25 && r.tier >= 2;
  const frac = b.hp / b.maxHp;
  while (r.nextSummon.length && frac <= r.nextSummon[0]) { r.nextSummon.shift(); for (let i = 0; i < 2 + r.tier + Math.max(0, inside.length - 1); i++) spawnMinion(r); toNear(r.x, r.y, { t: 'sys', m: `${b.name} convoca aliados!` }, r.r + 1500); }
  r.retarget -= dt;
  if (!r.target || !players.has(r.target.id) || r.target.hp <= 0 || inSafe(r.target) || r.retarget <= 0) { r.target = pickTarget(r); r.retarget = 2.5; }
  const tp = r.target; if (!tp) return;
  const ang = Math.atan2(tp.y - b.y, tp.x - b.x), d = dist(tp, b); b.face = Math.cos(ang) >= 0 ? 1 : -1;
  const clampArena = () => { const dd = Math.hypot(b.x - r.x, b.y - r.y); if (dd > r.r + 40) { b.x = r.x + (b.x - r.x) / dd * (r.r + 40); b.y = r.y + (b.y - r.y) / dd * (r.r + 40); } };
  if (b.atk) {
    const A = b.atk; A.t -= dt;
    if (A.kind === 'charge') {
      if (A.phase === 'tele') { if (A.t > .25) A.ang = ang; if (A.t <= 0) { A.phase = 'dash'; A.t = .5; A.hit = new Set(); } }
      else {
        b.x += Math.cos(A.ang) * 11 * dt * 60; b.y += Math.sin(A.ang) * 11 * dt * 60; clampArena();
        for (const p of inside) if (!A.hit.has(p.id) && dist(p, b) < b.sz + 16) { A.hit.add(p.id); hurtPlayer(p, b.dmg * 1.4, b.name, 'boss'); }
        if (A.t <= 0) { b.atk = null; b.cd = T.cd; }
      }
    } else if (A.t <= 0) {
      if (A.kind === 'fan') { const n = 5 + r.tier * 2; for (let i = 0; i < n; i++) { const a2 = ang + (i - (n - 1) / 2) * (1.1 / n) * 1.4; enemyProj(r, b.x, b.y, a2, 260, b.dmg * .7, 2.4, BOSS_COL[r.biome]); } }
      else if (A.kind === 'nova') { for (let k = 0; k < 2; k++) setTimeout(() => { if (r.state !== 'active') return; for (let i = 0; i < 18; i++) { const a2 = i / 18 * 6.283 + k * .17; enemyProj(r, b.x, b.y, a2, 190 + k * 40, b.dmg * .6, 3, '#fbbf24'); } }, k * 550); }
      b.atk = null; b.cd = T.cd * (b.enr ? .7 : 1);
    }
  } else {
    b.cd -= dt;
    if (d > b.sz + 12) { const sp = b.spd * (b.enr ? 1.25 : 1) * dt * 60; b.x += Math.cos(ang) * sp; b.y += Math.sin(ang) * sp; clampArena(); }
    if (b.swing <= 0) {
      let hit = false;
      for (const p of inside) if (dist(p, b) < b.sz + 24) { hit = true; hurtPlayer(p, b.dmg * (b.enr ? 1.2 : 1), b.name, 'boss'); }
      if (hit) { b.swing = 1.1; toNear(b.x, b.y, { t: 'ev', k: 'fx', x: b.x + Math.cos(ang) * b.sz, y: b.y + Math.sin(ang) * b.sz, r: 8, max: 34, tt: .25, col: '#fca5a5' }, 1800); }
    }
    if (b.cd <= 0) {
      let opts = BOSS_PROFILE[r.biome].pool.filter(k => r.tier >= OKT[k]); if (!opts.length) opts = ['slam'];
      let k = pick(opts); if (k === b.last && opts.length > 1) k = pick(opts); b.last = k;
      const fast = 1 - r.tier * .08;
      if (k === 'slam') { const R = 70 + r.tier * 14, dd = 1.1 * fast; b.atk = { kind: 'slam', t: dd, dur: dd }; addHazard(r, tp.x, tp.y, R, dd, b.dmg * 1.6, T.col); }
      else if (k === 'charge') b.atk = { kind: 'charge', phase: 'tele', t: .85 * fast, ang, hit: new Set() };
      else if (k === 'fan') b.atk = { kind: 'fan', t: .5, dur: .5 };
      else if (k === 'rain') {
        b.atk = { kind: 'rain', t: .6, dur: .6 };
        const n = 4 + r.tier + Math.max(0, inside.length - 1) * 2;
        for (let i = 0; i < n; i++) { const c = inside.length ? pick(inside) : tp, a2 = Math.random() * 6.283, dd = Math.random() * 230; addHazard(r, c.x + Math.cos(a2) * dd, c.y + Math.sin(a2) * dd, 58, 1.2 + i * .12, b.dmg * 1.2, '#fb923c'); }
      } else b.atk = { kind: 'nova', t: .7, dur: .7 };
    }
  }
}
function updateMinions(dt) {
  for (const m of minions.values()) {
    const r = raids.find(x => x.id === m.raid); if (!r || r.state !== 'active') { minions.delete(m.id); continue; }
    m.hitT = Math.max(0, m.hitT - dt); m.atkCd = Math.max(0, m.atkCd - dt);
    let best = null, bd = 1e9; for (const p of players.values()) { if (p.hp <= 0 || inSafe(p)) continue; const d = dist(p, m); if (d < bd && d < r.r + 400) { bd = d; best = p; } }
    if (!best) continue;
    const dx = best.x - m.x, dy = best.y - m.y, d = Math.hypot(dx, dy) || 1; m.face = dx >= 0 ? 1 : -1;
    if (m.kind !== 'slime' || d < 225) { const sp = m.def.spd * dt * 60; if (d > m.def.sz + 12) { m.x += dx / d * sp; m.y += dy / d * sp; } }
    if (d < m.def.sz + 16 && m.atkCd <= 0) { m.atkCd = 1.15; hurtPlayer(best, m.dmg, m.def.n, 'minion'); }
  }
}
function updateHazardsProjs(dt) {
  for (let i = hazards.length - 1; i >= 0; i--) {
    const h = hazards[i]; h.t -= dt;
    if (h.t <= 0) { for (const p of players.values()) if (p.hp > 0 && Math.hypot(p.x - h.x, p.y - h.y) < h.r) hurtPlayer(p, h.dmg, h.src, 'hazard'); hazards.splice(i, 1); }
  }
  for (let i = projs.length - 1; i >= 0; i--) {
    const q = projs[i]; q.x += q.vx * dt; q.y += q.vy * dt; q.life -= dt; let dead = q.life <= 0;
    if (!dead) for (const p of players.values()) if (p.hp > 0 && Math.hypot(q.x - p.x, q.y - p.y) < q.r + 10) { hurtPlayer(p, q.dmg, 'Projétil', 'proj'); dead = true; break; }
    if (dead) projs.splice(i, 1);
  }
}

/* ------------------------- CONSTRUÇÕES TEMPORÁRIAS ------------------------- */
const BUILD_TYPES = new Set(['wall_wood', 'wall_stone', 'fence_wood', 'campfire', 'chest']);
const structOut = (s, t) => ({ id: s.id, ty: s.type, gx: s.gx, gy: s.gy, rot: s.rot, o: s.owner, on: s.ownerName, rem: Math.max(0, s.expires - (t || now())) });
function handleBuild(p, m) {
  const t = now(); if (t - p.lastBuild < 120) return; p.lastBuild = t;
  const fail = why => send(p, { t: 'berr', why, ty: m.ty });
  if (!BUILD_TYPES.has(m.ty)) return fail('Estrutura inválida.');
  const gx = m.gx | 0, gy = m.gy | 0;
  if (gx < 1 || gy < 1 || gx >= MT - 1 || gy >= MT - 1) return fail('Fora do mapa.');
  const x = gx * 32 + 16, y = gy * 32 + 16;
  if (p.hp <= 0) return fail('Você está caído.');
  if (Math.hypot(p.x - x, p.y - y) > 200) return fail('Muito longe para construir!');
  if (Math.hypot(x - SAFE.x, y - SAFE.y) <= SAFE.radius + 20) return fail('Construções não são permitidas na Área Safe!');
  if (pondAt(x, y, 10)) return fail('Não dá para construir na água.');
  if (raids.some(r => r.state !== 'cleared' && Math.hypot(x - r.x, y - r.y) < r.r + 60)) return fail('Não é possível construir dentro de uma arena de raid.');
  if (cells.has(cellKey(gx, gy))) return fail('Já existe algo aqui.');
  if (p.structCount >= MAX_STRUCT_PER_PLAYER) return fail(`Limite de ${MAX_STRUCT_PER_PLAYER} construções por jogador.`);
  if (structs.size >= MAX_STRUCT_TOTAL) return fail('O mundo está cheio de construções.');
  const s = { id: 's' + (nextStructId++), type: m.ty, gx, gy, rot: [0, 90, 180, 270].includes(m.rot) ? m.rot : 0, owner: p.id, ownerName: p.name, expires: t + STRUCT_TTL };
  structs.set(s.id, s); cells.set(cellKey(gx, gy), s.id); p.structCount++;
  broadcast({ t: 'sadd', s: structOut(s, t) });
}
function removeStruct(s, refund) {
  structs.delete(s.id); cells.delete(cellKey(s.gx, s.gy));
  const o = players.get(s.owner); if (o) o.structCount = Math.max(0, o.structCount - 1);
  broadcast({ t: 'sdel', id: s.id, owner: s.owner, ty: s.type, refund: !!refund });
}
function handleDemolish(p, m) {
  const s = structs.get(m.id); if (!s) return;
  if (s.owner !== p.id) { send(p, { t: 'berr', why: 'Só o dono pode recolher esta construção.' }); return; }
  removeStruct(s, true);
}

/* ------------------------- LOOP ------------------------- */
let last = now(), tickN = 0, slow = 0;
setInterval(() => {
  const t = now(), dt = Math.min(.2, (t - last) / 1000); last = t; tickN++;
  // construções expiradas
  if (tickN % 20 === 0) for (const s of [...structs.values()]) if (t >= s.expires) removeStruct(s, false);
  // raids: spawn, update, limpeza
  spawnTimer -= dt;
  if (spawnTimer <= 0) { spawnTimer = 75; if (raids.filter(r => r.state !== 'cleared').length < MAX_ACTIVE_RAIDS) spawnRaid(); }
  for (const r of raids) updateRaid(r, dt);
  updateMinions(dt); updateHazardsProjs(dt);
  for (let i = raids.length - 1; i >= 0; i--) {
    const r = raids[i]; let rm = false;
    if (r.state === 'cleared' && t > r.removeAt) rm = true;
    if (r.state === 'idle' && t - r.born > 900000 && !playersIn(r, 900).length) rm = true;
    if (rm) { raids.splice(i, 1); broadcast({ t: 'raids', raids: raids.map(raidOut) }); }
  }
  // desconecta quem ficou mudo
  if (tickN % 200 === 0) for (const p of players.values()) { if (t - p.seen > 45000) wsClose(p.conn.sock, 1001); else wsPing(p.conn.sock); }
  // snapshots
  const list = [...players.values()];
  const live = raids.filter(r => r.state === 'active');
  for (const p of list) {
    const o = [];
    for (const q of list) if (q !== p && near(p, q.x, q.y)) o.push([q.id, q.name, q.cls, q.race, q.hair, q.eye, Math.round(q.x), Math.round(q.y), q.dir, q.mv, q.lvl, q.hp, q.mh, q.pvp ? 1 : 0, q.at, +q.aa.toFixed(2), q.tr]);
    const bs = [];
    for (const r of live) if (near(p, r.boss.x, r.boss.y, AOI + 400)) { const b = r.boss, A = b.atk; bs.push([r.id, Math.round(b.x), Math.round(b.y), Math.round(b.hp), b.maxHp, b.face, b.enr ? 1 : 0, A ? A.kind : '', A && A.phase ? A.phase : '', A && A.ang != null ? +A.ang.toFixed(2) : 0, b.hitT > 0 ? 1 : 0]); }
    const ms = [];
    for (const m of minions.values()) if (near(p, m.x, m.y, AOI)) ms.push([m.id, m.kind, Math.round(m.x), Math.round(m.y), Math.round(m.hp), Math.round(m.maxHp), m.face, +m.m.toFixed(2), m.hitT > 0 ? 1 : 0]);
    wsSend(p.conn.sock, J({ t: 'snap', p: o, b: bs, m: ms, n: list.length }));
  }
}, TICK);

server.listen(PORT, () => {
  console.log('==============================================');
  console.log(' AVENTURIA — servidor global rodando');
  console.log(` http://localhost:${PORT}   (WebSocket no mesmo endereço)`);
  console.log(` Semente do mundo: ${SEED} | Construções duram ${STRUCT_TTL / 1000}s`);
  console.log('==============================================');
  for (let i = 0; i < 5; i++) spawnRaid();
});
process.on('uncaughtException', e => console.error('Erro:', e));
