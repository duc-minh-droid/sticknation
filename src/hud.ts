import { animate } from 'motion';
import { Brain, PARAMS, REACTIONS } from './ai';
import { W } from './physics';
import { pencilBox, type Theme } from './render';
import { saveState } from './persist';

// Side panel in plain words, built once and updated in place (so things can animate):
// health, report card, what he's thinking, what he's learned, progress, nerd stats.

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** Set text and give it a little pop if it changed. */
function setText(e: HTMLElement, text: string) {
  if (e.textContent === text) return;
  e.textContent = text;
  animate(e, { scale: [1.18, 1] }, { duration: 0.3 });
}

export class Hud {
  private bars = el('div', 'bars');
  private dodged = el('b'); private dodgedOf = el('span'); private trend = el('span', 'trend');
  private hits = el('div', 'card'); private rounds = el('div', 'card');
  private thought = el('div', 'thought idle');
  private watching = el('p', 'muted');
  private lessons = el('div');
  private chart = el('div');
  private played = el('p', 'muted');
  private nerd = el('div', 'nerd');
  private nerdOpen = false;
  private lastThoughtAt = -1;
  private lessonKey = '';

  constructor(root: HTMLElement) {
    const health = el('div', 'note');
    health.append(el('div', 'tape'), this.bars);
    const report = el('div', 'note', '<div class="tape"></div><h2>Report card</h2>');
    const dodge = el('div', 'card');
    dodge.append(document.createTextNode('Dodged '), this.dodged, this.dodgedOf, this.trend);
    report.append(dodge, this.hits, this.rounds);
    const think = el('div', 'note', '<div class="tape"></div><h2>What he\'s thinking</h2>');
    think.append(this.thought, this.watching);
    const learned = el('div', 'note', '<div class="tape"></div><h2>Things he\'s learned</h2>');
    learned.append(this.lessons);
    const progress = el('div', 'note', '<div class="tape"></div><h2>Progress</h2><p class="sub">% dodged, one bar per minute played</p>');
    progress.append(this.chart, this.played);
    const nerd = el('details');
    nerd.append(el('summary', '', 'nerd stats'), this.nerd);
    nerd.addEventListener('toggle', () => { this.nerdOpen = nerd.open; });
    progress.append(nerd);
    root.append(health, report, think, learned, progress);
  }

  update(hero: Brain, enemies: Brain[]) {
    const me = hero.me, st = hero.stats;
    // ---- health bars
    const who = [hero, ...enemies];
    if (this.bars.children.length !== who.length) {
      this.bars.innerHTML = who.map(() => '<div class="who"><b></b><div class="hp"><i></i></div><span></span></div>').join('');
    }
    who.forEach((b, i) => {
      const row = this.bars.children[i] as HTMLElement;
      const name = row.querySelector('b')!;
      name.textContent = b.me.name; name.style.color = b.me.color;
      const bar = row.querySelector('i')!;
      bar.style.width = `${b.me.health}%`; bar.style.background = b.me.color;
      row.querySelector('span')!.textContent = b.me.alive ? `${Math.round(b.me.health)}` : 'K.O.';
    });

    // ---- report card
    const last = st.recent.slice(-10), prev = st.recent.slice(-20, -10);
    if (!last.length) { setText(this.dodged, '—'); this.dodgedOf.textContent = ' throw something at him!'; this.trend.textContent = ''; }
    else {
      setText(this.dodged, String(sum(last)));
      this.dodgedOf.textContent = ` of the last ${last.length}`;
      let t = '', c = 'trend';
      if (prev.length >= 5) {
        const d = sum(last) / last.length - sum(prev) / prev.length;
        if (d > 0.05) { t = '↑ getting better'; c += ' up'; } else if (d < -0.05) { t = '↓ slipping'; c += ' down'; } else t = '→ steady';
      }
      this.trend.textContent = t; this.trend.className = c;
    }
    const hits = st.strikeRecent.slice(-10);
    this.hits.hidden = !hits.length;
    if (hits.length) this.hits.innerHTML = `Hits landed: <b>${sum(hits)}</b> of the last ${hits.length}`;
    this.rounds.hidden = !enemies.length && st.wins + st.losses === 0;
    this.rounds.innerHTML = `Rounds: <b>${st.wins}</b> won · ${st.losses} lost`;

    // ---- thinking
    const th = hero.thought;
    const fresh = th !== null && me.time - th.at < 4;
    if (fresh && th!.at !== this.lastThoughtAt) {
      this.lastThoughtAt = th!.at;
      this.thought.textContent = th!.text;
      this.thought.className = `thought ${th!.mood}`;
      animate(this.thought, { scale: [0.92, 1.03, 1], rotate: [-1.5, 0.6, 0] }, { duration: 0.35 });
    } else if (!fresh && !this.thought.classList.contains('idle')) {
      this.thought.textContent = 'Waiting for something to happen…';
      this.thought.className = 'thought idle';
    }
    const ar = hero.arena;
    const sees = [
      `${ar.objects} object${ar.objects === 1 ? '' : 's'}${ar.moving ? ` (${ar.moving} flying)` : ''}`,
      ar.spikes.length ? `${ar.spikes.length} spike trap${ar.spikes.length > 1 ? 's' : ''}` : '',
      ar.cannonsOn ? `${ar.cannonsOn} cannon${ar.cannonsOn > 1 ? 's' : ''} (next shot ${ar.nextShot.toFixed(1)}s)` : '',
      enemies.length ? `${enemies.length} enem${enemies.length > 1 ? 'ies' : 'y'}` : '',
      me.weapon ? 'holding a weapon' : '',
    ].filter(Boolean).join(' · ');
    this.watching.textContent = `Keeping an eye on: ${sees}`;

    // ---- lessons (newest slides in)
    const key = hero.lessons.map((l) => l.text + l.at).join('|');
    if (key !== this.lessonKey) {
      const animateFirst = this.lessonKey !== '' && hero.lessons.length > 0;
      this.lessonKey = key;
      this.lessons.innerHTML = hero.lessons.length
        ? hero.lessons.slice(0, 5).map((l) => `<div class="lesson">${esc(l.text)}</div>`).join('')
        : '<p class="muted">Nothing yet. He\'s running on his starting instincts.</p>';
      const first = this.lessons.firstElementChild as HTMLElement | null;
      if (animateFirst && first) animate(first, { opacity: [0, 1], x: [-24, 0] }, { type: 'spring', bounce: 0.4, duration: 0.5 });
    }

    // ---- progress
    this.chart.innerHTML = progressChart(st.minutes);
    const ss = saveState.get(hero);
    const saved = !ss ? 'loading brain…' : ss.state === 'error' ? 'save failed!' : ss.state === 'new' ? 'new brain' : `saved to brains/${me.name}.json`;
    this.played.textContent = `${Math.round(st.playTime / 60)} min played · ${st.threats} things thrown · ${saved}`;

    if (this.nerdOpen) this.nerd.innerHTML = nerdStats(hero);
  }
}

function progressChart(minutes: { n: number; ok: number }[]): string {
  const pts = minutes.map((m, i) => ({ i, pct: m.n >= 2 ? m.ok / m.n : -1 })).filter((p) => p.pct >= 0).slice(-30);
  if (pts.length < 2) return '<p class="muted">Fills in as he plays.</p>';
  const w = 290, h = 60, bw = w / pts.length;
  const bars = pts.map((p, k) => {
    const bh = Math.max(3, p.pct * h);
    const col = p.pct >= 0.8 ? 'var(--good)' : p.pct >= 0.5 ? '#d9a21b' : 'var(--bad)';
    return `<rect x="${(k * bw + 1.5).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${Math.max(1, bw - 3).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${col}" stroke="var(--ink)" stroke-width="1.2"><title>minute ${p.i + 1}: ${Math.round(p.pct * 100)}%</title></rect>`;
  }).join('');
  const a = Math.round(pts[0].pct * 100), b = Math.round(pts[pts.length - 1].pct * 100);
  return `<svg width="100%" viewBox="0 0 ${w} ${h + 2}" style="display:block">${bars}</svg>
    <div class="muted" style="display:flex;justify-content:space-between"><span>first: ${a}%</span><span>now: ${b}%</span></div>`;
}

function nerdStats(hero: Brain): string {
  const net = hero.net;
  const row = (k: string, v: string) => `<div class="row"><span class="k">${esc(k)}</span><span>${esc(v)}</span></div>`;
  let h = row('circuit', `${net.opCount} ops · ${net.weightCount} weights`) + row('backprop steps', `${net.steps} · loss ${net.lossEma.toFixed(3)}`);
  const drift = net.drift().filter((d) => Math.abs(d.now - d.init) > 0.05).sort((a, b) => Math.abs(b.now - b.init) - Math.abs(a.now - a.init)).slice(0, 6);
  for (const d of drift) h += row(d.name, `${d.init.toFixed(2)} → ${d.now.toFixed(2)}`);
  h += '<br>';
  for (const r of hero.table().sort((a, b) => b.n - a.n).slice(0, 8)) {
    let bi = 0;
    for (let i = 1; i < r.v.length; i++) if (r.v[i] > r.v[bi]) bi = i;
    h += row(`${r.key} (${r.n})`, `${REACTIONS[bi]} ${r.v[bi].toFixed(2)}`);
  }
  h += '<br>' + PARAMS.map((p) => row(p.label, hero.params[p.key].toFixed(2))).join('');
  h += row('evolution', `gen ${hero.gen} · kept ${hero.accepted} · σ ${hero.sigma.toFixed(2)}`);
  return h;
}

// ------------------------------------------------------------------ canvas overlays

/** Doodled speech bubble over each stickman with his latest thought (pops in). */
export function drawThoughts(ctx: CanvasRenderingContext2D, brains: Brain[], th: Theme) {
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  for (const b of brains) {
    const t = b.thought;
    if (!t) continue;
    const age = b.me.time - t.at;
    const life = t.mood === 'think' ? 1.7 : 1.1;
    if (age > life || age < 0) continue;
    const pop = age < 0.14 ? 0.6 + 0.45 * Math.sin((age / 0.14) * Math.PI * 0.6) : 1;
    const alpha = Math.min(1, (life - age) / 0.3);
    const head = b.me.ps[0];
    const top = Math.min(...b.me.ps.map((p) => p.y)) - 48;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '20px "Patrick Hand", cursive';
    const tw = ctx.measureText(t.text).width;
    const bw = tw + 24, bh = 34;
    const x = Math.min(W - bw / 2 - 8, Math.max(bw / 2 + 8, head.x));
    let y = Math.max(bh + 6, top);
    // stack above any bubble already drawn here instead of overlapping it
    for (let tries = 0; tries < 4; tries++) {
      const hit = placed.find((r) => x - bw / 2 < r.x1 && x + bw / 2 > r.x0 && y - bh < r.y1 && y > r.y0);
      if (!hit) break;
      y = hit.y0 - 8;
    }
    placed.push({ x0: x - bw / 2, x1: x + bw / 2, y0: y - bh, y1: y + 10 });
    ctx.translate(x, y);
    ctx.scale(pop, pop);
    const edge = t.mood === 'good' ? '#2a9d5c' : t.mood === 'bad' ? '#d64545' : th.ink;
    pencilBox(ctx, -bw / 2, -bh, bw, bh, b.me.team * 50 + 3, edge, th.paper);
    // tail toward the head
    const tx = Math.min(bw / 2 - 14, Math.max(-bw / 2 + 14, head.x - x));
    ctx.fillStyle = th.paper;
    ctx.beginPath(); ctx.moveTo(tx - 7, -1); ctx.lineTo(tx - 2, 10); ctx.lineTo(tx + 7, -1); ctx.fill();
    ctx.strokeStyle = edge; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(tx - 7, 0); ctx.lineTo(tx - 2, 10); ctx.lineTo(tx + 7, 0); ctx.stroke();
    ctx.fillStyle = edge;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.text, 0, -bh / 2 + 1);
    ctx.restore();
  }
}

export function drawThreat(ctx: CanvasRenderingContext2D, b: Brain) {
  const t = b.threat;
  if (!t) return;
  ctx.strokeStyle = '#e0a02099';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  t.path.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = '#e0a020';
  ctx.beginPath(); ctx.arc(t.impact.x, t.impact.y, 9, 0, Math.PI * 2); ctx.stroke();
}
