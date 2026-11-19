// by gold - train game server (plain HTTP + Server-Sent Events, no extra packages)
const http = require('http'), fs = require('fs'), crypto = require('crypto');
const W = 21, L = 80, SPEED = 0.4, HP = { 1: 3, 2: 4, 3: 5 }, KEY = { 1: 'w', 2: 's', 3: 'i' };
// Small connection layer injected into the page: same interface the game already uses, carried over SSE + POST.
const SHIM = '<script>(function(){function N(url){var self=this,r=new URL(url).searchParams.get("r")||"gold",tok=null,pend=null,sent="",lastT=0;self.readyState=0;' +
  'var es=new EventSource("/sse?r="+encodeURIComponent(r));' +
  'es.onmessage=function(e){var d=JSON.parse(e.data);if(d.t==="hello"){tok=d.c;self.readyState=1;if(self.onopen)self.onopen();return}if(self.onmessage)self.onmessage({data:e.data})};' +
  'es.onerror=function(){self.readyState=0};' +
  'self.send=function(d){pend=d};' +
  'setInterval(function(){var n=Date.now();if(!tok||!pend||pend===sent||n-lastT<1800)return;sent=pend;lastT=n;fetch("/in?c="+tok,{method:"POST",body:"["+pend+"]",keepalive:true}).then(function(x){if(x.status===429)window.BGLIM=Date.now()}).catch(function(){})},150)}' +
  'window.BGNet=N})();</script>';
const page = () => fs.readFileSync(__dirname + '/index.html', 'utf8')
  .replace('new Web' + 'Socket(', 'new BGNet(').replace('<script src="https://cdnjs', SHIM + '<script src="https://cdnjs');
const toks = new Map();
const rooms = new Map(), send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const fr = x => x - Math.floor(x), hs = (x, z, s) => fr(Math.sin(x * 127.1 + z * 311.7 + s * 74.7) * 43758.5453);
function noise(x, z, s) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi, u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hs(xi, zi, s), b = hs(xi + 1, zi, s), c = hs(xi, zi + 1, s), d = hs(xi + 1, zi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, +v || 0));
const spawn = p => { p.x = 9.8 + Math.random() * 1.4; p.z = 1.5 + Math.random() * 1.2; };

class Room {
  constructor(code) { this.code = code; this.ps = new Map(); this.nid = 1; this.idle = Date.now(); this.reset(); }
  reset() { this.stock = { w: 4, s: 0, i: 4, r: 6 }; this.level = 1; this.speed = SPEED; this.state = 'play'; this.timer = 0; this.gen(); }
  gen() {
    const t = new Uint8Array(W * L), s1 = Math.random() * 99, s2 = Math.random() * 99, s3 = Math.random() * 99;
    for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) {
      let v = 0;
      const f = noise(x / 3.5, z / 3.5, s1), g = noise(x / 5, z / 5, s2), h = noise(x / 6, z / 6, s3);
      if (h > 0.68) v = 4;
      else if (Math.random() < Math.max(0, Math.min(0.75, (f - 0.45) * 2.2)) + 0.03) v = 1;
      else if (g > 0.62 && Math.random() < 0.3) v = 2;
      else if (Math.random() < 0.035) v = 3;
      if ((x >= 5 && x <= 15 && z < 30) || z >= 74) v = 0;
      t[z * W + x] = v;
    }
    const sx = 6 + Math.floor(Math.random() * 9); t[77 * W + sx] = 6;
    const put = (x, z, v) => { if (x !== 10) t[z * W + x] = v; };
    for (const z of [8, 12, 16, 20, 24, 28]) { put(6, z, 1); put(14, z + 1, 1); put(8, z + 2, 1); }
    put(7, 10, 3); put(13, 14, 3); put(7, 18, 3); put(13, 22, 3); put(6, 14, 2); put(14, 18, 2); put(6, 22, 2); put(14, 26, 3);
    this.path = []; for (let z = 0; z < 30; z++) { this.path.push([10, z]); t[z * W + 10] = 5; }
    this.t = t; this.hp = new Map(); this.p = 2; this.grace = 15; this.st = [sx, 77];
  }
  at(x, z) { return x < 0 || z < 0 || x >= W || z >= L ? 4 : this.t[z * W + x]; }
  posAt(q) {
    const n = this.path.length; let i = Math.floor(q), f = q - i;
    if (q < 0) { i = 0; f = q; } if (i >= n - 1) { i = n - 2; f = 1; }
    const a = this.path[i], b = this.path[i + 1];
    return { x: a[0] + 0.5 + (b[0] - a[0]) * f, z: a[1] + 0.5 + (b[1] - a[1]) * f };
  }
  cand(px, pz) {
    const n = this.path.length, e = this.path[n - 1], pr = this.path[n - 2], dx = e[0] - pr[0], dz = e[1] - pr[1];
    let best = null, bd = 1e9;
    for (const [ax, az] of [[dx, dz], [dz, -dx], [-dz, dx]]) {
      const x = e[0] + ax, z = e[1] + az, v = this.at(x, z);
      if (v !== 0 && v !== 6) continue;
      const d = Math.hypot(x + 0.5 - px, z + 0.5 - pz); if (d < bd) { bd = d; best = [x, z]; }
    }
    return best;
  }
  target(pl) {
    let best = null, bs = 9; const px = pl.x, pz = pl.z, s = this.stock;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const tx = Math.floor(px) + dx, tz = Math.floor(pz) + dz, v = this.at(tx, tz);
      if (v >= 1 && v <= 3) { const d = Math.hypot(tx + 0.5 - px, tz + 0.5 - pz) / 1.7; if (d < 1 && d < bs) { bs = d; best = { k: 'hit', x: tx, z: tz }; } }
    }
    const wg = this.posAt(this.p - 2.2);
    if (s.w > 0 && s.i > 0) { const d = Math.hypot(wg.x - px, wg.z - pz) / 3; if (d < 1 && d < bs) { bs = d; best = { k: 'craft' }; } }
    if (s.r > 0) {
      const e = this.path[this.path.length - 1], d = Math.hypot(e[0] + 0.5 - px, e[1] + 0.5 - pz) / 3;
      if (d < 1 && d < bs) { const g = this.cand(px, pz); if (g) { bs = d; best = { k: 'rail', gx: g[0], gz: g[1] }; } }
    }
    return best;
  }
  act(pl) {
    if (this.state !== 'play') return;
    const t = this.target(pl); if (!t) return;
    if (t.k === 'hit') {
      const i = t.z * W + t.x, v = this.t[i], h = (this.hp.get(i) ?? HP[v]) - 1;
      if (h <= 0) { this.t[i] = 0; this.hp.delete(i); this.stock[KEY[v]]++; this.bc({ t: 'tile', x: t.x, z: t.z, v: 0 }); }
      else this.hp.set(i, h);
    } else if (t.k === 'craft') { this.stock.w--; this.stock.i--; this.stock.r += 2; }
    else {
      this.stock.r--; const i = t.gz * W + t.gx; if (this.t[i] === 0) this.t[i] = 5;
      this.path.push([t.gx, t.gz]); this.bc({ t: 'rail', x: t.gx, z: t.gz });
    }
  }
  msg(pl, m) {
    if (m.t === 'in') {
      pl.x = clamp(m.x, 0, W); pl.z = clamp(m.z, 0, L); pl.r = clamp(m.r, -7, 7);
      pl.vx = clamp(m.vx, -4, 4); pl.vz = clamp(m.vz, -4, 4); pl.c = (m.c | 0) & 3;
      pl.hold = !!m.h; pl.hseen = Date.now();
    }
  }
  world(pl) { return { t: 'world', lv: this.level, tiles: Array.from(this.t).join(''), path: this.path, st: this.st, you: [pl.x, pl.z] }; }
  bc(o) { for (const p of this.ps.values()) send(p.ws, o); }
  tick(dt) {
    if (this.state === 'play') {
      if (this.grace > 0) this.grace -= dt; else this.p += this.speed * dt;
      const n = this.path.length;
      if (this.p >= n - 1) {
        this.p = n - 1; const e = this.path[n - 1];
        if (this.t[e[1] * W + e[0]] === 6) { this.state = 'station'; this.timer = 5; } else { this.state = 'over'; this.timer = 8; }
      }
    } else {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.state === 'over') { this.stock = { w: 4, s: 0, i: 4, r: 6 }; this.level = 1; } else this.level++;
        this.gen(); this.state = 'play';
        for (const p of this.ps.values()) { spawn(p); send(p.ws, this.world(p)); }
      }
    }
    const now = Date.now();
    for (const p of this.ps.values()) {
      if (now - p.hseen < 2400) { p.x = clamp(p.x + p.vx * dt, 0, W); p.z = clamp(p.z + p.vz * dt, 0, L); }
      if (p.hold && now - p.hseen > 3500) p.hold = false;
      if (p.hold && now - p.last >= 300) { p.last = now; this.act(p); }
    }
    const c = { t: 's', p: +this.p.toFixed(2), v: this.speed, st: this.state, g: Math.ceil(Math.max(0, this.grace)), tm: Math.ceil(Math.max(0, this.timer)), k: this.stock,
      pl: [...this.ps.values()].map(p => [p.id, +p.x.toFixed(2), +p.z.toFixed(2), +p.r.toFixed(2), p.c]) };
    for (const p of this.ps.values()) send(p.ws, { ...c, me: p.id });
  }
}


const srv = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/healthz') return r.end('ok');
  if (u.pathname === '/sse') {
    const code = (u.searchParams.get('r') || 'gold').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'gold';
    let room = rooms.get(code); if (!room) { room = new Room(code); rooms.set(code, room); }
    if (room.ps.size >= 8) { r.writeHead(503); return r.end(); }
    r.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const ws = { readyState: 1, send: s => { try { r.write('data: ' + s + '\n\n'); } catch (e) {} } };
    const pl = { id: room.nid++, ws, x: 10, z: 6, r: 0, vx: 0, vz: 0, c: 0, hold: false, hseen: 0, last: 0 }; spawn(pl); room.ps.set(pl.id, pl);
    const tok = crypto.randomBytes(8).toString('hex'); toks.set(tok, { room, pl, res: r });
    r.write('retry: 5000\n\n');
    ws.send(JSON.stringify({ t: 'hello', c: tok }));
    ws.send(JSON.stringify(room.world(pl)));
    q.on('close', () => { ws.readyState = 0; room.ps.delete(pl.id); room.idle = Date.now(); toks.delete(tok); });
    return;
  }
  if (u.pathname === '/in' && q.method === 'POST') {
    const e = toks.get(u.searchParams.get('c')); let b = '';
    q.on('data', d => { b += d; if (b.length > 1e5) q.destroy(); });
    q.on('end', () => {
      if (e) { try { for (const m of JSON.parse(b)) e.room.msg(e.pl, m); } catch (x) {} }
      r.writeHead(e ? 204 : 410); r.end();
    });
    return;
  }
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  r.end(page());
});
let last = Date.now();
setInterval(() => {
  const n = Date.now(), dt = Math.min((n - last) / 1000, 0.2); last = n;
  for (const [c, r] of rooms) { if (!r.ps.size) { if (n - r.idle > 6e5) rooms.delete(c); continue; } r.tick(dt); }
}, 66);
setInterval(() => { for (const e of toks.values()) { try { e.res.write(': ping\n\n'); } catch (x) {} } }, 15000);
srv.listen(process.env.PORT || 3000, () => console.log('by gold train server up'));
