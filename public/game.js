'use strict';
/* ============================================================
   MINE STAR — Minesweeper with normal (1pt) + heavy (2pt) mines
   ============================================================ */

// ---------- Helpers ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => `${t.toFixed(1)}s`;
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

// ---------- Config ----------
const SIZES = {
  small:  { cols: 9,  rows: 9,  normal: 8,  heavy: 4,  label: 'Small',  par: 120 },
  medium: { cols: 16, rows: 16, normal: 30, heavy: 15, label: 'Medium', par: 420 },
  large:  { cols: 30, rows: 16, normal: 66, heavy: 33, label: 'Large',  par: 900 },
};
const totalPointsOf = (cfg) => cfg.normal * 1 + cfg.heavy * 2;

// ---------- State ----------
const G = {
  screen: 'start', // start | playing | paused | won | lost
  size: 'small',
  cols: 9, rows: 9, total: 81,
  cells: [], // {mine:0|1|2, revealed, flag:0|1|2, adj, el}
  firstDone: false,
  elapsed: 0, timerId: null, stamp: 0,
  safeRevealed: 0, totalSafe: 0,
  placedN: 0, placedH: 0,
  combo: 1, maxCombo: 1, comboBonus: 0, lastRevealAt: 0, comboHideId: null,
  hintsUsed: 0,
  mode: 'dig', // dig | flag1 | flag2
  cursor: 0,
  muted: localStorage.getItem('mineStar_muted') === '1',
  name: localStorage.getItem('mineStar_name') || '',
  lbType: 'local',
  winLbType: 'local',
  lastLocalId: null, lastGlobalId: null, savedSize: null,
  suppressClick: false,
  misflagToastAt: 0,
};

// ---------- Sound engine (procedural WebAudio) ----------
const Sound = {
  ctx: null,
  ensure() {
    if (this.ctx || G.muted) return this.ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch { this.ctx = null; }
    return this.ctx;
  },
  tone(freq, dur = 0.08, type = 'sine', vol = 0.16, slideTo = null, delay = 0) {
    if (G.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  },
  noise(dur = 0.4, vol = 0.3, cutoff = 900, delay = 0) {
    if (G.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(t);
  },
  play(name, opt = {}) {
    if (G.muted) return;
    switch (name) {
      case 'click': this.tone(660, 0.05, 'triangle', 0.1); break;
      case 'reveal': {
        const base = 420 + Math.min(600, (opt.combo || 1) * 90) + Math.min(300, (opt.count || 1) * 12);
        this.tone(base, 0.09, 'sine', 0.14, base * 1.5);
        this.tone(base * 2, 0.06, 'triangle', 0.05, null, 0.03);
        break;
      }
      case 'flag1': this.tone(520, 0.09, 'square', 0.07, 780); break;
      case 'flag2': this.tone(392, 0.1, 'square', 0.08, 784); this.tone(784, 0.12, 'sine', 0.1, 1175, 0.05); break;
      case 'unflag': this.tone(500, 0.08, 'sine', 0.1, 260); break;
      case 'chord': this.tone(300, 0.12, 'sawtooth', 0.06, 900); this.noise(0.12, 0.08, 2400); break;
      case 'explosion':
        this.noise(0.7, 0.5, 700);
        this.tone(160, 0.6, 'sawtooth', 0.25, 38);
        this.tone(90, 0.8, 'sine', 0.3, 30, 0.05);
        break;
      case 'win':
        [523, 659, 784, 1046, 1318].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.14, null, i * 0.09));
        this.noise(0.5, 0.06, 6000, 0.4);
        break;
      case 'hint': this.tone(880, 0.15, 'sine', 0.12, 1320); break;
      case 'bad': this.tone(220, 0.18, 'square', 0.08, 110); break;
      case 'pause': this.tone(440, 0.1, 'sine', 0.1, 330); break;
      case 'start':
        this.tone(262, 0.12, 'triangle', 0.12);
        this.tone(392, 0.12, 'triangle', 0.12, null, 0.08);
        this.tone(523, 0.18, 'triangle', 0.14, null, 0.16);
        break;
      case 'tick': this.tone(1200, 0.03, 'sine', 0.04); break;
    }
  },
};

// ---------- Starfield background ----------
const Starfield = {
  cv: null, cx: null, stars: [], shoot: null, w: 0, h: 0,
  init() {
    this.cv = $('#starfield');
    this.cx = this.cv.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
    const N = Math.min(220, Math.floor((this.w * this.h) / 9000));
    this.stars = Array.from({ length: N }, () => ({
      x: Math.random() * this.w, y: Math.random() * this.h,
      r: Math.random() * 1.6 + 0.3,
      tw: Math.random() * Math.PI * 2,
      sp: Math.random() * 0.35 + 0.08,
      hue: [200, 220, 260, 45][Math.floor(Math.random() * 4)],
    }));
    requestAnimationFrame((t) => this.loop(t));
  },
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = window.innerWidth; this.h = window.innerHeight;
    this.cv.width = this.w * dpr; this.cv.height = this.h * dpr;
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    FX.resize();
  },
  loop(t) {
    const { cx, w, h } = this;
    cx.clearRect(0, 0, w, h);
    const time = t / 1000;
    for (const s of this.stars) {
      s.y += s.sp;
      if (s.y > h + 4) { s.y = -4; s.x = Math.random() * w; }
      const a = 0.35 + 0.65 * Math.abs(Math.sin(time * 1.4 + s.tw));
      cx.globalAlpha = a;
      cx.fillStyle = `hsl(${s.hue} 90% 80%)`;
      cx.beginPath();
      cx.arc(s.x, s.y, s.r, 0, 7);
      cx.fill();
    }
    cx.globalAlpha = 1;
    // occasional shooting star
    if (!this.shoot && Math.random() < 0.004) {
      this.shoot = { x: Math.random() * w * 0.7, y: Math.random() * h * 0.3, vx: 7 + Math.random() * 5, vy: 3 + Math.random() * 2, life: 1 };
    }
    if (this.shoot) {
      const sh = this.shoot;
      sh.x += sh.vx; sh.y += sh.vy; sh.life -= 0.03;
      if (sh.life <= 0 || sh.x > w) this.shoot = null;
      else {
        const grad = cx.createLinearGradient(sh.x, sh.y, sh.x - sh.vx * 8, sh.y - sh.vy * 8);
        grad.addColorStop(0, `rgba(255,255,255,${0.9 * sh.life})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        cx.strokeStyle = grad; cx.lineWidth = 2;
        cx.beginPath(); cx.moveTo(sh.x, sh.y); cx.lineTo(sh.x - sh.vx * 8, sh.y - sh.vy * 8); cx.stroke();
      }
    }
    requestAnimationFrame((tt) => this.loop(tt));
  },
};

// ---------- FX particle layer ----------
const FX = {
  cv: null, cx: null, parts: [], w: 0, h: 0,
  init() {
    this.cv = $('#fx');
    this.cx = this.cv.getContext('2d');
    this.resize();
    requestAnimationFrame((t) => this.loop(t));
  },
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = window.innerWidth; this.h = window.innerHeight;
    if (!this.cv) return;
    this.cv.width = this.w * dpr; this.cv.height = this.h * dpr;
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },
  cellCenter(idx) {
    const c = G.cells[idx];
    if (!c || !c.el) return { x: this.w / 2, y: this.h / 2 };
    const r = c.el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  },
  push(p) {
    if (this.parts.length > 650) this.parts.splice(0, this.parts.length - 650);
    this.parts.push(p);
  },
  sparks(x, y, color = '#7dd3fc', n = 10, power = 3) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.5 + Math.random()) * power;
      this.push({ kind: 'dot', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1, g: 0.12, life: 1, decay: 0.02 + Math.random() * 0.03, r: 1.5 + Math.random() * 2.5, color });
    }
  },
  ring(x, y, color = '#22d3ee') {
    this.push({ kind: 'ring', x, y, r: 4, vr: 3.2, life: 1, decay: 0.06, color, lw: 3 });
  },
  debris(x, y, n = 46) {
    const colors = ['#f87171', '#fb923c', '#fbbf24', '#fef3c7', '#c084fc'];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 7;
      this.push({ kind: 'dot', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2, g: 0.18, life: 1, decay: 0.008 + Math.random() * 0.02, r: 2 + Math.random() * 3.5, color: colors[i % colors.length] });
    }
    this.push({ kind: 'flash', x, y, r: 10, vr: 9, life: 1, decay: 0.09, color: '255,180,80' });
    this.push({ kind: 'ring', x, y, r: 6, vr: 6, life: 1, decay: 0.045, color: '#fb923c', lw: 4 });
  },
  confetti(n = 160) {
    const colors = ['#22d3ee', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#f8fafc'];
    for (let i = 0; i < n; i++) {
      this.push({
        kind: 'conf', x: Math.random() * this.w, y: -20 - Math.random() * this.h * 0.4,
        vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 3.5,
        w: 5 + Math.random() * 6, h: 8 + Math.random() * 8,
        rot: Math.random() * 7, vr: (Math.random() - 0.5) * 0.3,
        life: 1, decay: 0.003 + Math.random() * 0.004, color: colors[i % colors.length],
      });
    }
  },
  loop() {
    const { cx, w, h } = this;
    cx.clearRect(0, 0, w, h);
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= p.decay;
      if (p.life <= 0) { this.parts.splice(i, 1); continue; }
      if (p.kind === 'dot') {
        p.vy += p.g; p.x += p.vx; p.y += p.vy;
        cx.globalAlpha = Math.max(0, p.life);
        cx.fillStyle = p.color;
        cx.beginPath(); cx.arc(p.x, p.y, p.r * p.life + 0.4, 0, 7); cx.fill();
      } else if (p.kind === 'ring') {
        p.r += p.vr; p.vr *= 0.96;
        cx.globalAlpha = Math.max(0, p.life);
        cx.strokeStyle = p.color; cx.lineWidth = p.lw * p.life + 0.5;
        cx.beginPath(); cx.arc(p.x, p.y, p.r, 0, 7); cx.stroke();
      } else if (p.kind === 'flash') {
        p.r += p.vr;
        cx.globalAlpha = Math.max(0, p.life) * 0.8;
        const g = cx.createRadialGradient(p.x, p.y, 2, p.x, p.y, p.r * 2);
        g.addColorStop(0, `rgba(${p.color},0.9)`);
        g.addColorStop(1, `rgba(${p.color},0)`);
        cx.fillStyle = g;
        cx.beginPath(); cx.arc(p.x, p.y, p.r * 2, 0, 7); cx.fill();
      } else if (p.kind === 'conf') {
        p.x += p.vx + Math.sin(p.y * 0.02) * 1.2; p.y += p.vy; p.rot += p.vr;
        if (p.y > h + 30) { this.parts.splice(i, 1); continue; }
        cx.globalAlpha = Math.min(1, p.life * 1.5);
        cx.save();
        cx.translate(p.x, p.y); cx.rotate(p.rot);
        cx.fillStyle = p.color;
        cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * (0.4 + 0.6 * Math.abs(Math.sin(p.rot * 2))));
        cx.restore();
      }
    }
    cx.globalAlpha = 1;
    requestAnimationFrame(() => this.loop());
  },
};

// ---------- Toasts & floaters ----------
function toast(msg, type = '', ms = 2400) {
  const box = $('#toasts');
  while (box.children.length >= 3) box.firstChild.remove();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}
function floater(x, y, text, cls = '') {
  const box = $('#floaters');
  if (box.children.length > 24) box.firstChild.remove();
  const el = document.createElement('div');
  el.className = `floater ${cls}`;
  el.textContent = text;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  box.appendChild(el);
  setTimeout(() => el.remove(), 1050);
}
function flashScreen(kind = '') {
  const f = $('#flash');
  f.className = kind;
  // force reflow so repeated flashes retrigger
  void f.offsetWidth;
  f.classList.add('on');
  setTimeout(() => f.classList.remove('on'), kind === 'gold' ? 350 : 220);
}
function shakeBoard(hard = false) {
  const sh = $('#boardShake');
  document.documentElement.style.setProperty('--shake', hard ? '10px' : '6px');
  sh.classList.remove('shaking', 'shake-hard');
  void sh.offsetWidth;
  sh.classList.add(hard ? 'shake-hard' : 'shaking');
  setTimeout(() => sh.classList.remove('shaking', 'shake-hard'), hard ? 650 : 500);
}

// ---------- Leaderboards ----------
const LocalLB = {
  key: 'mineStar_local_v1',
  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.key) || '{}');
      return { small: raw.small || [], medium: raw.medium || [], large: raw.large || [] };
    } catch { return { small: [], medium: [], large: [] }; }
  },
  saveAll(data) { localStorage.setItem(this.key, JSON.stringify(data)); },
  list(size) { return this.load()[size] || []; },
  add(entry) {
    const all = this.load();
    entry.id = 'L' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    all[entry.size].push(entry);
    all[entry.size].sort((a, b) => a.time - b.time || b.score - a.score);
    all[entry.size] = all[entry.size].slice(0, 50);
    this.saveAll(all);
    return { entry, rank: all[entry.size].findIndex((e) => e.id === entry.id) + 1 };
  },
  rename(id, size, name) {
    const all = this.load();
    const e = (all[size] || []).find((x) => x.id === id);
    if (e) { e.name = name; this.saveAll(all); }
  },
};

const GlobalLB = {
  cache: { small: null, medium: null, large: null },
  async list(size, force = false) {
    if (this.cache[size] && !force) return this.cache[size];
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 7000);
    try {
      const res = await fetch(`/api/scores?size=${size}&limit=20`, { signal: ctrl.signal });
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      this.cache[size] = data.scores || [];
      return this.cache[size];
    } finally { clearTimeout(to); }
  },
  async add(entry) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 7000);
    try {
      const res = await fetch('/api/scores', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: entry.name, size: entry.size, time: entry.time, score: entry.score }),
      });
      if (!res.ok) throw new Error('post failed');
      const saved = await res.json();
      this.cache[entry.size] = null;
      return saved;
    } finally { clearTimeout(to); }
  },
  async rename(id, name) {
    try {
      await fetch(`/api/scores/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    } catch { /* best-effort */ }
  },
};

function lbRowHTML(e, i, meId) {
  const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
  return `<div class="lb-row r${i + 1} ${e.id === meId ? 'me' : ''}">
    <span class="rank">${medal}</span>
    <span class="nm">${esc(e.name)}</span>
    <span class="sc">${fmtInt(e.score)}✨</span>
    <span class="tm">${fmtTime(Number(e.time))}</span>
  </div>`;
}
async function renderStartLB() {
  const box = $('#startLeaderboard');
  $('#lbSub').textContent = `${SIZES[G.size].label} • sorted by fastest time`;
  if (G.lbType === 'local') {
    const list = LocalLB.list(G.size).slice(0, 10);
    box.innerHTML = list.length
      ? list.map((e, i) => lbRowHTML(e, i)).join('')
      : `<div class="lb-empty">No local records yet. Be the first legend of this sector. 🚀</div>`;
  } else {
    box.innerHTML = `<div class="lb-empty">Contacting mission control… 🛰</div>`;
    try {
      const list = await GlobalLB.list(G.size, true);
      if (G.lbType !== 'global') return; // user switched away
      box.innerHTML = list.length
        ? list.slice(0, 10).map((e, i) => lbRowHTML(e, i)).join('')
        : `<div class="lb-empty">No global records yet. Your run could be #1. 🌍</div>`;
    } catch {
      if (G.lbType !== 'global') return;
      box.innerHTML = `<div class="lb-empty">⚠️ Global leaderboard offline. Check your connection and hit ↻.</div>`;
    }
  }
}
async function renderWinLB() {
  const box = $('#winLeaderboard');
  const size = G.savedSize || G.size;
  if (G.winLbType === 'local') {
    const list = LocalLB.list(size).slice(0, 5);
    box.innerHTML = list.length ? list.map((e, i) => lbRowHTML(e, i, G.lastLocalId)).join('') : `<div class="lb-empty">No records.</div>`;
  } else {
    box.innerHTML = `<div class="lb-empty">Contacting mission control… 🛰</div>`;
    try {
      const list = await GlobalLB.list(size, true);
      box.innerHTML = list.length ? list.slice(0, 5).map((e, i) => lbRowHTML(e, i, G.lastGlobalId)).join('') : `<div class="lb-empty">No global records yet.</div>`;
    } catch {
      box.innerHTML = `<div class="lb-empty">⚠️ Global leaderboard offline.</div>`;
    }
  }
}

// ---------- Board core ----------
const boardEl = () => $('#board');
const idx = (r, c) => r * G.cols + c;
const inB = (r, c) => r >= 0 && r < G.rows && c >= 0 && c < G.cols;

function neighbors(i) {
  const r = Math.floor(i / G.cols), c = i % G.cols;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    if (inB(r + dr, c + dc)) out.push(idx(r + dr, c + dc));
  }
  return out;
}

function fitBoard() {
  const cfg = SIZES[G.size];
  const scroll = $('#boardScroll');
  const availW = Math.min(window.innerWidth - 44, 1180);
  const availH = Math.max(220, window.innerHeight - 250);
  let cell = Math.floor(Math.min((availW - 28) / cfg.cols, (availH - 28) / cfg.rows, 42));
  cell = clamp(cell, 24, 42);
  // Large boards on small screens: keep cells tappable, allow scroll
  if (cfg.cols >= 30 && window.innerWidth < 700) cell = Math.max(cell, 27);
  if (cfg.cols >= 16 && window.innerWidth < 420) cell = Math.max(cell, 24);
  document.documentElement.style.setProperty('--cell', `${cell}px`);
  scroll.style.justifyContent = (cell * cfg.cols > scroll.clientWidth - 20) ? 'flex-start' : 'center';
}

function newGame(size) {
  G.size = size;
  const cfg = SIZES[size];
  G.cols = cfg.cols; G.rows = cfg.rows; G.total = cfg.cols * cfg.rows;
  G.cells = Array.from({ length: G.total }, () => ({ mine: 0, revealed: false, flag: 0, adj: 0, el: null }));
  G.firstDone = false;
  G.elapsed = 0; G.safeRevealed = 0;
  G.totalSafe = G.total - cfg.normal - cfg.heavy;
  G.placedN = 0; G.placedH = 0;
  G.combo = 1; G.maxCombo = 1; G.comboBonus = 0; G.lastRevealAt = 0;
  G.hintsUsed = 0;
  G.lastLocalId = null; G.lastGlobalId = null; G.savedSize = null;
  G.cursor = idx(Math.floor(G.rows / 2), Math.floor(G.cols / 2));
  stopTimer();

  // Build DOM
  const b = boardEl();
  b.innerHTML = '';
  b.style.gridTemplateColumns = `repeat(${G.cols}, var(--cell))`;
  b.setAttribute('aria-label', `${cfg.label} minefield, ${G.cols} by ${G.rows}`);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < G.total; i++) {
    const d = document.createElement('div');
    d.className = 'cell unrevealed';
    d.dataset.i = i;
    d.setAttribute('role', 'gridcell');
    d.setAttribute('aria-label', `Sector ${Math.floor(i / G.cols) + 1},${(i % G.cols) + 1} unrevealed`);
    G.cells[i].el = d;
    frag.appendChild(d);
  }
  b.appendChild(frag);
  $('#boardShake').classList.remove('won');
  $('#boardScroll').classList.remove('lost');

  fitBoard();
  setMode('dig');
  updateHUD();
  paintCursor();
  showScreen('playing');

  // Coach tip for first seconds of fun
  const seen = localStorage.getItem('mineStar_seen');
  const coach = $('#coachBar');
  if (!seen) {
    coach.classList.remove('hidden');
    $('#coachText').textContent = '👆 Tap any sector to scan — first scan is always safe. Numbers = total mine points nearby (💜 counts as 2)!';
  } else if (Math.random() < 0.35) {
    coach.classList.remove('hidden');
    const tips = [
      '⚡ Click an uncovered number to chord-blast its neighbors when flags match.',
      '💜 Heavy mines are worth 2 points — flag with two right-clicks.',
      '🔥 Chain fast scans to build a combo multiplier.',
      '💡 Press H for a hint if you get stuck (+5s).',
    ];
    $('#coachText').textContent = tips[Math.floor(Math.random() * tips.length)];
  } else {
    coach.classList.add('hidden');
  }
  localStorage.setItem('mineStar_seen', '1');
  Sound.play('start');
}

function placeMines(safeIdx) {
  const cfg = SIZES[G.size];
  const forbidden = new Set([safeIdx, ...neighbors(safeIdx)]);
  const pool = [];
  for (let i = 0; i < G.total; i++) if (!forbidden.has(i)) pool.push(i);
  // shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  for (let k = 0; k < cfg.normal; k++) G.cells[pool[k]].mine = 1;
  for (let k = 0; k < cfg.heavy; k++) G.cells[pool[cfg.normal + k]].mine = 2;
  // adjacency = SUM of mine points
  for (let i = 0; i < G.total; i++) {
    let s = 0;
    for (const n of neighbors(i)) s += G.cells[n].mine;
    G.cells[i].adj = s;
  }
}

function startTimer() {
  stopTimer();
  G.stamp = performance.now();
  G.timerId = setInterval(() => {
    G.elapsed = (performance.now() - G.stamp) / 1000 + G._accum;
    $('#timeText').textContent = fmtTime(G.elapsed);
    $('#scoreText').textContent = fmtInt(computeScore());
  }, 100);
}
function stopTimer() {
  if (G.timerId) { clearInterval(G.timerId); G.timerId = null; }
}
function freezeElapsed() {
  if (G.timerId) {
    G.elapsed = (performance.now() - G.stamp) / 1000 + G._accum;
    stopTimer();
    G._accum = G.elapsed;
  }
}
G._accum = 0;

function computeScore() {
  const cfg = SIZES[G.size];
  const mult = G.size === 'small' ? 1 : G.size === 'medium' ? 1.6 : 2.2;
  const correct = countCorrectFlags();
  const base = G.safeRevealed * 10 + correct * 45 + G.comboBonus + totalPointsOf(cfg) * 8;
  const penalty = Math.floor(G.elapsed) * (G.size === 'small' ? 2 : 3);
  return Math.max(0, Math.round((base - penalty) * mult));
}
function finalScore() {
  const cfg = SIZES[G.size];
  const timeBonus = Math.max(0, Math.round((cfg.par - G.elapsed) * (G.size === 'small' ? 12 : G.size === 'medium' ? 8 : 6)));
  const hintPenalty = G.hintsUsed * 150;
  return Math.max(100, computeScore() + timeBonus - hintPenalty);
}
function countCorrectFlags() {
  let n = 0;
  for (const c of G.cells) if (c.mine && c.flag === c.mine) n++;
  return n;
}

// ---------- Reveal / flag / chord ----------
function paintCell(i) {
  const c = G.cells[i], el = c.el;
  if (c.revealed) {
    el.className = 'cell revealed' + (c.adj === 0 ? ' zero' : '');
    if (c.adj > 0 && !c.mine) {
      const cls = c.adj <= 10 ? `n${c.adj}` : 'nbig';
      el.innerHTML = `<span class="${cls}">${c.adj}</span>`;
    } else el.textContent = '';
    el.setAttribute('aria-label', `Sector revealed, ${c.adj} points nearby`);
    return;
  }
  let cls = 'cell unrevealed';
  if (c.flag === 1) cls += ' flag1';
  if (c.flag === 2) cls += ' flag2';
  el.className = cls + (i === G.cursor && (G.screen === 'playing') ? ' cursor' : '');
  el.innerHTML = c.flag === 1 ? `<span class="flag">🚩</span>` : c.flag === 2 ? `<span class="flag">💜</span>` : '';
  el.setAttribute('aria-label', `Sector unrevealed${c.flag === 1 ? ', flagged normal' : c.flag === 2 ? ', flagged heavy' : ''}`);
}

function revealCell(i, viaChord = false) {
  if (G.screen !== 'playing') return;
  const c = G.cells[i];
  if (c.revealed || c.flag) return;

  if (!G.firstDone) {
    placeMines(i);
    G.firstDone = true;
    G._accum = 0; G.elapsed = 0;
    startTimer();
    toast('🛰 First scan free — good luck, Pilot!', '', 1800);
  }
  if (c.mine) { loseGame(i); return; }

  // Flood fill
  const queue = [i];
  const revealedNow = [];
  const seen = new Set([i]);
  while (queue.length) {
    const j = queue.pop();
    const cell = G.cells[j];
    if (cell.revealed || cell.flag || cell.mine) continue;
    cell.revealed = true;
    revealedNow.push(j);
    G.safeRevealed++;
    if (cell.adj === 0) {
      for (const n of neighbors(j)) {
        if (!seen.has(n) && !G.cells[n].revealed && !G.cells[n].flag) { seen.add(n); queue.push(n); }
      }
    }
  }
  // Combo
  const now = performance.now();
  if (now - G.lastRevealAt < 1600) {
    G.combo = Math.min(8, G.combo + 1);
  } else G.combo = 1;
  G.maxCombo = Math.max(G.maxCombo, G.combo);
  G.lastRevealAt = now;
  const gained = revealedNow.length * 10 * G.combo;
  G.comboBonus += revealedNow.length * 4 * (G.combo - 1);

  // Paint with stagger for juice
  revealedNow.forEach((j, k) => {
    setTimeout(() => {
      paintCell(j);
      if (k % 3 === 0) {
        const { x, y } = FX.cellCenter(j);
        FX.sparks(x, y, G.combo >= 3 ? '#fbbf24' : '#7dd3fc', G.combo >= 3 ? 8 : 4, 2.2);
      }
    }, Math.min(260, k * 12));
  });

  const { x, y } = FX.cellCenter(i);
  if (revealedNow.length >= 6 || G.combo >= 3) {
    floater(x, y - 10, `+${fmtInt(gained)}${G.combo >= 2 ? `  🔥x${G.combo}` : ''}`, G.combo >= 2 ? 'combo-f' : '');
    if (G.combo >= 4) { shakeBoard(false); }
  }
  Sound.play('reveal', { combo: G.combo, count: revealedNow.length });
  updateHUD();
  checkWin();
}

function cycleFlag(i) {
  if (G.screen !== 'playing') return;
  const c = G.cells[i];
  if (c.revealed) return;
  if (!G.firstDone) {
    // allow pre-flagging? classic needs mines placed; place with a far safe guess
    placeMines(-1); // no forbidden (safeIdx -1 matches nothing)
    G.firstDone = true;
    G._accum = 0; G.elapsed = 0;
    startTimer();
  }
  const before = c.flag;
  c.flag = (c.flag + 1) % 3;
  if (before === 1) G.placedN--; else if (before === 2) G.placedH--;
  if (c.flag === 1) G.placedN++; else if (c.flag === 2) G.placedH++;
  paintCell(i);
  const { x, y } = FX.cellCenter(i);
  if (c.flag === 1) { Sound.play('flag1'); FX.ring(x, y, '#fb923c'); FX.sparks(x, y, '#fb923c', 8, 2.4); floater(x, y - 8, '🚩 1pt', 'info'); }
  else if (c.flag === 2) { Sound.play('flag2'); FX.ring(x, y, '#c084fc'); FX.sparks(x, y, '#c084fc', 12, 2.8); floater(x, y - 8, '💜 2pt', 'info'); }
  else Sound.play('unflag');
  updateHUD();
  checkWin();
}

function setFlag(i, val) {
  if (G.screen !== 'playing') return;
  const c = G.cells[i];
  if (c.revealed) return;
  if (c.flag === val) { // toggle off
    if (val === 1) G.placedN--; else G.placedH--;
    c.flag = 0;
    Sound.play('unflag');
  } else {
    if (!G.firstDone) { placeMines(-1); G.firstDone = true; G._accum = 0; G.elapsed = 0; startTimer(); }
    if (c.flag === 1) G.placedN--; else if (c.flag === 2) G.placedH--;
    c.flag = val;
    if (val === 1) { G.placedN++; Sound.play('flag1'); } else { G.placedH++; Sound.play('flag2'); }
    const { x, y } = FX.cellCenter(i);
    FX.ring(x, y, val === 1 ? '#fb923c' : '#c084fc');
  }
  paintCell(i);
  updateHUD();
  checkWin();
}

function chordCell(i) {
  if (G.screen !== 'playing') return;
  const c = G.cells[i];
  if (!c.revealed || c.adj === 0) return;
  const ns = neighbors(i);
  let pts = 0, unflagged = [];
  for (const n of ns) {
    pts += G.cells[n].flag; // flag value == points (1 or 2)
    if (!G.cells[n].revealed && !G.cells[n].flag) unflagged.push(n);
  }
  if (!unflagged.length) return;
  if (pts !== c.adj) {
    Sound.play('bad');
    const { x, y } = FX.cellCenter(i);
    floater(x, y - 8, `needs ${c.adj}pts`, 'info');
    shakeBoard(false);
    return;
  }
  Sound.play('chord');
  // If any flag is wrong and neighbor is mine unflagged -> explosion (classic behavior)
  for (const n of unflagged) {
    if (G.cells[n].mine) { revealCell(n, true); return; }
  }
  unflagged.forEach((n, k) => setTimeout(() => revealCell(n, true), k * 30));
}

// ---------- Win / lose ----------
function checkWin() {
  if (G.screen !== 'playing') return;
  if (G.safeRevealed !== G.totalSafe) return;
  // all safe scanned — now check flag accuracy
  let wrong = 0, missing = 0;
  for (const c of G.cells) {
    if (c.mine && c.flag !== c.mine) { c.flag ? wrong++ : missing++; }
    if (!c.mine && c.flag) wrong++;
  }
  if (wrong || missing) {
    const now = performance.now();
    if (now - G.misflagToastAt > 5000) {
      G.misflagToastAt = now;
      toast(`🔎 All safe sectors scanned! ${wrong + missing} mine flag${wrong + missing > 1 ? 's' : ''} still wrong — match 🚩/💜 types.`, 'gold', 3200);
      Sound.play('hint');
    }
    return;
  }
  winGame();
}

function winGame() {
  G.screen = 'won';
  freezeElapsed();
  $('#boardShake').classList.add('won');
  flashScreen('gold');
  FX.confetti(200);
  setTimeout(() => FX.confetti(120), 600);
  Sound.play('win');
  // sparkle wave across board
  G.cells.forEach((c, k) => {
    if (c.mine) setTimeout(() => {
      const { x, y } = FX.cellCenter(k);
      FX.sparks(x, y, c.mine === 2 ? '#c084fc' : '#fb923c', 6, 2.5);
    }, k * 2);
  });

  const score = finalScore();
  const flavors = [
    'Flawless navigation, Pilot.', 'Mission control is applauding. 👏',
    'That was poetry in motion. ✨', 'Speedy AND precise. Legendary. 🏆',
    'The stars themselves salute you. ⭐',
  ];
  $('#winTime').textContent = fmtTime(G.elapsed);
  $('#winScore').textContent = fmtInt(score);
  $('#winCombo').textContent = 'x' + G.maxCombo;
  $('#winSize').textContent = SIZES[G.size].label;
  $('#winFlavor').textContent = flavors[Math.floor(Math.random() * flavors.length)];
  $('#winName').value = G.name;
  $('#saveState').textContent = '💾 Saving…';
  $('#winRanks').innerHTML = '';

  setTimeout(() => { showScreen('won'); }, 900);
  saveWin(score);
}

async function saveWin(score) {
  const entry = { name: G.name || 'Pilot', size: G.size, time: Math.round(G.elapsed * 10) / 10, score, date: new Date().toISOString() };
  G.savedSize = G.size;
  // Local (instant)
  const { entry: savedLocal, rank: localRank } = LocalLB.add({ ...entry });
  G.lastLocalId = savedLocal.id;
  // Global (async)
  let globalRank = null;
  try {
    const saved = await GlobalLB.add(entry);
    G.lastGlobalId = saved.id;
    globalRank = saved.rank;
  } catch { G.lastGlobalId = null; }
  $('#saveState').textContent = '💾 Saved!';
  $('#winRanks').innerHTML =
    `<span class="rank-pill">🏆 Local #${localRank}</span>` +
    (globalRank ? `<span class="rank-pill global">🌍 Global #${globalRank}</span>` : `<span class="rank-pill global">🌍 global offline</span>`);
  renderWinLB();
}

function loseGame(hitIdx) {
  G.screen = 'lost';
  freezeElapsed();
  const hit = G.cells[hitIdx];
  hit.revealed = true;
  paintCell(hitIdx);
  hit.el.innerHTML = `<span class="mine-ico">${hit.mine === 2 ? '💜' : '💥'}</span>`;
  hit.el.classList.add('mine-hit');

  const { x, y } = FX.cellCenter(hitIdx);
  FX.debris(x, y, 60);
  flashScreen('');
  shakeBoard(true);
  Sound.play('explosion');
  if (navigator.vibrate) navigator.vibrate([80, 40, 120]);

  // Reveal mines with stagger
  const mines = [];
  G.cells.forEach((c, k) => { if (c.mine && k !== hitIdx) mines.push(k); });
  mines.forEach((k, n) => {
    setTimeout(() => {
      if (G.screen !== 'lost') return;
      const c = G.cells[k];
      c.revealed = true;
      const el = c.el;
      el.className = 'cell revealed';
      el.innerHTML = `<span class="mine-ico">${c.mine === 2 ? '💜' : '🟠'}</span>`;
      if (n % 4 === 0) {
        const p = FX.cellCenter(k);
        FX.sparks(p.x, p.y, '#f87171', 5, 2.5);
      }
      if (n % 9 === 0) Sound.noise(0.15, 0.1, 500);
    }, 120 + n * 28);
  });
  // Mark wrong flags
  G.cells.forEach((c) => {
    if (!c.mine && c.flag) {
      setTimeout(() => c.el.classList.add('mine-wrong'), 500);
    }
  });
  $('#boardScroll').classList.add('lost');

  const pct = Math.round((G.safeRevealed / Math.max(1, G.totalSafe)) * 100);
  $('#loseTime').textContent = fmtTime(G.elapsed);
  $('#loseScanned').textContent = pct + '%';
  $('#loseFlags').textContent = `${countCorrectFlags()}/${SIZES[G.size].normal + SIZES[G.size].heavy}`;
  $('#loseScore').textContent = fmtInt(computeScore());
  $('#loseFlavor').textContent = hit.mine === 2
    ? 'You hit a 💜 heavy mine (2pts). Double ouch.'
    : 'You hit a 🟠 normal mine. So close!';
  setTimeout(() => { if (G.screen === 'lost') showScreen('lost'); }, 1250);
}

// ---------- Pause ----------
function pauseGame() {
  if (G.screen !== 'playing') return;
  G.screen = 'paused';
  freezeElapsed();
  $('#pauseTime').textContent = fmtTime(G.elapsed);
  $('#pauseScore').textContent = fmtInt(computeScore());
  $('#pauseScanned').textContent = Math.round((G.safeRevealed / Math.max(1, G.totalSafe)) * 100) + '%';
  showScreen('paused');
  Sound.play('pause');
}
function resumeGame() {
  if (G.screen !== 'paused') return;
  G.screen = 'playing';
  G._accum = G.elapsed;
  G.stamp = performance.now();
  startTimer();
  showScreen('playing');
  Sound.play('click');
}

// ---------- Hint ----------
function giveHint() {
  if (G.screen !== 'playing') return;
  // find unrevealed safe cell adjacent to a revealed one
  const cands = [];
  for (let i = 0; i < G.total; i++) {
    const c = G.cells[i];
    if (c.revealed || c.flag || c.mine) continue;
    if (!G.firstDone) { cands.push(i); continue; }
    if (neighbors(i).some((n) => G.cells[n].revealed)) cands.push(i);
  }
  const pool = cands.length ? cands : G.cells.map((c, i) => (!c.revealed && !c.flag && !c.mine ? i : -1)).filter((i) => i >= 0);
  if (!pool.length) { toast('No safe hint available — trust your flags! 🤔', 'gold'); return; }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const el = G.cells[pick].el;
  el.classList.add('hint-pulse');
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  setTimeout(() => el.classList.remove('hint-pulse'), 3200);
  // +5s penalty
  G.hintsUsed++;
  G.elapsed += 5;
  G._accum = (G._accum || 0) + 5;
  $('#timeText').textContent = fmtTime(G.elapsed);
  const { x, y } = FX.cellCenter(pick);
  FX.ring(x, y, '#fbbf24');
  floater(x, y - 10, '+5s 💡', 'info');
  Sound.play('hint');
  toast('💡 Hint highlighted (+5s penalty)', 'gold', 1800);
}

// ---------- HUD / screens / modes ----------
function updateHUD() {
  const cfg = SIZES[G.size];
  const ptsTotal = totalPointsOf(cfg);
  const ptsPlaced = G.placedN * 1 + G.placedH * 2;
  $('#pointsLeft').textContent = ptsTotal - ptsPlaced;
  $('#normLeft').textContent = cfg.normal - G.placedN;
  $('#heavyLeft').textContent = cfg.heavy - G.placedH;
  $('#pointsLeft').style.color = (ptsTotal - ptsPlaced) < 0 ? 'var(--danger)' : '';
  $('#timeText').textContent = fmtTime(G.elapsed);
  $('#scoreText').textContent = fmtInt(computeScore());
  $('#sizeBadge').textContent = cfg.label.toUpperCase();
  // combo badge
  const cb = $('#statCombo');
  if (G.combo >= 2 && G.screen === 'playing') {
    cb.classList.remove('hidden');
    $('#comboText').textContent = 'x' + G.combo;
    clearTimeout(G.comboHideId);
    G.comboHideId = setTimeout(() => cb.classList.add('hidden'), 1700);
  } else cb.classList.add('hidden');
}

function showScreen(which) {
  G.screen = which === 'playing' && G.screen === 'paused' ? 'paused' : (which === 'playing' ? 'playing' : which);
  // map: playing -> no overlay; paused/won/lost/start -> overlays
  $('#screenStart').classList.toggle('hidden', which !== 'start');
  $('#screenPause').classList.toggle('hidden', which !== 'paused');
  $('#screenWin').classList.toggle('hidden', which !== 'won');
  $('#screenLose').classList.toggle('hidden', which !== 'lost');
  const inGame = which === 'playing' || which === 'paused';
  $('#hud').classList.toggle('hidden', !inGame && which !== 'won' && which !== 'lost');
  $('#boardWrap').classList.toggle('hidden', which === 'start');
  if (which === 'start') { stopTimer(); renderStartLB(); }
  if (which === 'playing') { $('#hud').classList.remove('hidden'); }
}

function setMode(m) {
  G.mode = m;
  $$('#modeSwitch .mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
}

function paintCursor() {
  $$('#board .cell.cursor').forEach((el) => el.classList.remove('cursor'));
  if (G.screen !== 'playing' && G.screen !== 'paused') return;
  const c = G.cells[G.cursor];
  if (c && c.el && !c.revealed) c.el.classList.add('cursor');
}

function moveCursor(dr, dc) {
  let r = Math.floor(G.cursor / G.cols) + dr;
  let c = (G.cursor % G.cols) + dc;
  r = clamp(r, 0, G.rows - 1); c = clamp(c, 0, G.cols - 1);
  G.cursor = idx(r, c);
  $$('#board .cell').forEach((el, i) => {
    el.classList.toggle('cursor', i === G.cursor && !G.cells[i].revealed);
  });
  const el = G.cells[G.cursor].el;
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------- Input: mouse / touch ----------
function bindBoard() {
  const b = boardEl();
  b.addEventListener('click', (e) => {
    if (G.suppressClick) { G.suppressClick = false; return; }
    const t = e.target.closest('.cell');
    if (!t) return;
    const i = Number(t.dataset.i);
    G.cursor = i; paintCursor();
    Sound.ensure();
    handlePrimary(i);
  });
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const t = e.target.closest('.cell');
    if (!t) return;
    const i = Number(t.dataset.i);
    G.cursor = i; paintCursor();
    Sound.ensure();
    cycleFlag(i);
    if (navigator.vibrate) navigator.vibrate(15);
  });
  // Long-press for touch
  let lpTimer = null, lpFired = false, touchMoved = false, sx = 0, sy = 0;
  b.addEventListener('touchstart', (e) => {
    Sound.ensure();
    if (e.touches.length !== 1) { clearTimeout(lpTimer); return; }
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY;
    touchMoved = false; lpFired = false;
    const cell = e.target.closest('.cell');
    const i = cell ? Number(cell.dataset.i) : -1;
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      if (touchMoved || i < 0) return;
      lpFired = true;
      G.suppressClick = true;
      G.cursor = i; paintCursor();
      cycleFlag(i);
      if (navigator.vibrate) navigator.vibrate(30);
      const { x, y } = FX.cellCenter(i);
      FX.ring(x, y, '#fbbf24');
    }, 420);
  }, { passive: true });
  b.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (Math.hypot(t.clientX - sx, t.clientY - sy) > 12) { touchMoved = true; clearTimeout(lpTimer); }
  }, { passive: true });
  b.addEventListener('touchend', () => { clearTimeout(lpTimer); }, { passive: true });
  b.addEventListener('touchcancel', () => { clearTimeout(lpTimer); }, { passive: true });
  // Prevent double-tap zoom / callout
  b.addEventListener('dblclick', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());
}

function handlePrimary(i) {
  const c = G.cells[i];
  if (G.mode === 'flag1') { setFlag(i, 1); return; }
  if (G.mode === 'flag2') { setFlag(i, 2); return; }
  if (c.revealed) { chordCell(i); return; }
  if (c.flag) {
    // tapping a flag in dig mode removes? No — hint to use flags. Cycle instead for speed.
    cycleFlag(i);
    return;
  }
  revealCell(i);
}

// ---------- Input: keyboard ----------
function bindKeys() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea';
    if (typing) {
      if (e.key === 'Enter') {
        if (document.activeElement === $('#inputName')) $('#btnStart').click();
        else if (document.activeElement === $('#winName')) $('#btnWinAgain').click();
        e.target.blur();
      }
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    const k = e.key.toLowerCase();
    // Global
    if (k === 'm') { toggleSound(); return; }
    if (G.screen === 'start') {
      if (e.key === 'Enter') { $('#btnStart').click(); }
      if (k === '1' || k === '2' || k === '3') {
        selectSize(['small', 'medium', 'large'][Number(k) - 1]);
      }
      return;
    }
    if (G.screen === 'won' || G.screen === 'lost') {
      if (k === 'r' || e.key === 'Enter') { e.preventDefault(); newGame(G.size); }
      if (e.key === 'Escape') goMenu();
      return;
    }
    if (k === 'p' || e.key === 'Escape') {
      if (G.screen === 'playing') pauseGame();
      else if (G.screen === 'paused') resumeGame();
      return;
    }
    if (G.screen === 'paused') {
      if (k === 'r') newGame(G.size);
      return;
    }
    // playing
    switch (e.key) {
      case 'ArrowUp': case 'w': case 'W': e.preventDefault(); moveCursor(-1, 0); break;
      case 'ArrowDown': case 's': case 'S': e.preventDefault(); moveCursor(1, 0); break;
      case 'ArrowLeft': case 'a': case 'A': e.preventDefault(); moveCursor(0, -1); break;
      case 'ArrowRight': case 'd': case 'D': e.preventDefault(); moveCursor(0, 1); break;
      case ' ': case 'Enter': e.preventDefault(); Sound.ensure(); handlePrimary(G.cursor); break;
      case 'f': case 'F': cycleFlag(G.cursor); break;
      case 'c': case 'C': chordCell(G.cursor); break;
      case 'h': case 'H': giveHint(); break;
      case 'r': case 'R': newGame(G.size); break;
      case 'q': case 'Q': case 'v': case 'V': case 'Tab':
        e.preventDefault();
        setMode(G.mode === 'dig' ? 'flag1' : G.mode === 'flag1' ? 'flag2' : 'dig');
        toast(`Mode: ${G.mode === 'dig' ? '⛏️ Dig' : G.mode === 'flag1' ? '🚩 Flag 1pt' : '💜 Flag 2pt'}`, '', 1200);
        break;
      case '1': setFlag(G.cursor, 1); break;
      case '2': setFlag(G.cursor, 2); break;
    }
  });
}

// ---------- Menu / wiring ----------
function selectSize(size) {
  G.size = size;
  $$('#sizeCards .size-card').forEach((b) => b.classList.toggle('selected', b.dataset.size === size));
  renderStartLB();
  Sound.play('click');
}
function goMenu() {
  stopTimer();
  G.screen = 'start';
  showScreen('start');
}
function toggleSound() {
  G.muted = !G.muted;
  localStorage.setItem('mineStar_muted', G.muted ? '1' : '0');
  $('#btnSound').textContent = G.muted ? '🔇' : '🔊';
  if (!G.muted) { Sound.ctx = null; Sound.play('click'); }
  toast(G.muted ? '🔇 Sound off' : '🔊 Sound on', '', 1200);
}

function bindUI() {
  $('#btnStart').addEventListener('click', () => {
    Sound.ensure();
    G.name = $('#inputName').value.trim().slice(0, 14) || G.name || 'Pilot';
    localStorage.setItem('mineStar_name', G.name);
    newGame(G.size);
  });
  $$('#sizeCards .size-card').forEach((b) => b.addEventListener('click', () => selectSize(b.dataset.size)));
  $$('#lbTypeTabs .lb-tab').forEach((b) => b.addEventListener('click', () => {
    G.lbType = b.dataset.lb;
    $$('#lbTypeTabs .lb-tab').forEach((x) => x.classList.toggle('active', x === b));
    renderStartLB();
    Sound.play('click');
  }));
  $('#btnLbRefresh').addEventListener('click', () => { GlobalLB.cache[G.size] = null; renderStartLB(); Sound.play('click'); });

  $('#btnMenu').addEventListener('click', goMenu);
  $('#btnPause').addEventListener('click', () => (G.screen === 'playing' ? pauseGame() : resumeGame()));
  $('#btnRestart').addEventListener('click', () => { Sound.play('click'); newGame(G.size); });
  $('#btnSound').addEventListener('click', toggleSound);
  $('#btnHint').addEventListener('click', giveHint);
  $('#coachClose').addEventListener('click', () => $('#coachBar').classList.add('hidden'));
  $$('#modeSwitch .mode-btn').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); Sound.play('click'); }));

  $('#btnResume').addEventListener('click', resumeGame);
  $('#btnPauseRestart').addEventListener('click', () => newGame(G.size));
  $('#btnPauseMenu').addEventListener('click', goMenu);

  $('#btnWinAgain').addEventListener('click', () => newGame(G.size));
  $('#btnWinMenu').addEventListener('click', goMenu);
  $('#btnLoseAgain').addEventListener('click', () => newGame(G.size));
  $('#btnLoseMenu').addEventListener('click', goMenu);
  $$('#winLbTabs .lb-tab').forEach((b) => b.addEventListener('click', () => {
    G.winLbType = b.dataset.lb;
    $$('#winLbTabs .lb-tab').forEach((x) => x.classList.toggle('active', x === b));
    renderWinLB();
  }));

  // Rename after save (updates local instantly, global best-effort)
  let renameT = null;
  $('#winName').addEventListener('input', (e) => {
    const v = e.target.value.trim().slice(0, 14) || 'Pilot';
    G.name = v;
    localStorage.setItem('mineStar_name', v);
    $('#saveState').textContent = '✏️ typing…';
    clearTimeout(renameT);
    renameT = setTimeout(() => {
      if (G.lastLocalId && G.savedSize) LocalLB.rename(G.lastLocalId, G.savedSize, v);
      if (G.lastGlobalId) GlobalLB.rename(G.lastGlobalId, v);
      $('#saveState').textContent = '💾 Saved!';
      renderWinLB();
    }, 700);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && G.screen === 'playing') pauseGame();
  });
  window.addEventListener('resize', () => { if (G.screen !== 'start') fitBoard(); });
  window.addEventListener('pointerdown', () => Sound.ensure(), { once: true });
}

// ---------- Boot ----------
function boot() {
  Starfield.init();
  FX.init();
  $('#btnSound').textContent = G.muted ? '🔇' : '🔊';
  $('#inputName').value = G.name;
  $('#inputName').placeholder = 'e.g. ' + ['NovaPilot', 'StarFox', 'Vega', 'Comet', 'Lyra'][Math.floor(Math.random() * 5)];
  bindUI();
  bindBoard();
  bindKeys();
  showScreen('start');
}
document.addEventListener('DOMContentLoaded', boot);
