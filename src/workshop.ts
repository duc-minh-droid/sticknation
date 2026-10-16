import { animate } from 'motion';
import type { Weapon } from './stickman';
import type { Vec } from './math';

// Weapon workshop: a small sketch pad. The first point drawn is the grip (where the
// hand holds it). The drawing is turned so it points along the forearm, then scaled
// into arena units; its ink length sets its weight (heavier swings slower, hits harder).

const SCALE = 0.75;     // pad pixels -> arena units
const MIN_LEN = 22, MAX_LEN = 115;

export class Workshop {
  private strokes: Vec[][] = [];
  private ctx: CanvasRenderingContext2D;
  private drawing = false;
  onGive: (w: Weapon) => void = () => {};
  onDrop: () => void = () => {};

  constructor(private pad: HTMLCanvasElement, private give: HTMLButtonElement, erase: HTMLButtonElement, private drop: HTMLButtonElement, private stats: HTMLElement) {
    this.ctx = pad.getContext('2d')!;
    const pos = (e: PointerEvent): Vec => {
      const r = pad.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * pad.width, y: ((e.clientY - r.top) / r.height) * pad.height };
    };
    pad.addEventListener('pointerdown', (e) => {
      pad.setPointerCapture(e.pointerId);
      this.drawing = true;
      this.strokes.push([pos(e)]);
      this.redraw();
    });
    pad.addEventListener('pointermove', (e) => {
      if (!this.drawing) return;
      const s = this.strokes[this.strokes.length - 1];
      const p = pos(e), l = s[s.length - 1];
      if (Math.hypot(p.x - l.x, p.y - l.y) > 2) { s.push(p); this.redraw(); }
    });
    pad.addEventListener('pointerup', () => { this.drawing = false; this.update(); });
    erase.addEventListener('click', () => { this.strokes = []; this.update(); });
    give.addEventListener('click', () => {
      const w = this.build();
      if (!w) return;
      this.onGive(w);
      drop.hidden = false;
      animate(give, { scale: [1, 1.15, 1], rotate: [0, -4, 0] }, { duration: 0.35 });
    });
    drop.addEventListener('click', () => { this.onDrop(); drop.hidden = true; });
    this.update();
  }

  private ink() { return getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#2b2a28'; }

  private redraw() {
    const c = this.ctx;
    c.clearRect(0, 0, this.pad.width, this.pad.height);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = '#8a5a2b';
    c.lineWidth = 5;
    for (const s of this.strokes) {
      c.beginPath();
      s.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.stroke();
    }
    const g = this.strokes[0]?.[0];
    if (g) {
      // grip marker
      c.fillStyle = this.ink();
      c.beginPath(); c.arc(g.x, g.y, 6, 0, Math.PI * 2); c.fill();
      c.font = '15px "Patrick Hand", cursive';
      c.fillText('grip', g.x + 9, g.y - 8);
    }
  }

  /** Show an existing weapon on the pad (e.g. loaded from the saved brain). */
  show(w: Weapon) {
    const k = 1 / SCALE;
    this.strokes = w.strokes.map((s) => s.map((p) => ({ x: 40 + p.x * k, y: this.pad.height / 2 + p.y * k })));
    this.drop.hidden = false;
    this.update();
  }

  private update() {
    this.redraw();
    const w = this.build();
    this.give.disabled = !w;
    this.stats.textContent = w
      ? `length ${Math.round(w.length)} · weight ${w.mass.toFixed(1)} ${w.mass > 3 ? '(heavy: slow but hits hard)' : w.mass < 1.2 ? '(light: fast)' : ''}`
      : this.strokes.length ? 'too small: draw a longer weapon' : 'empty: draw a bat, a sword, a club…';
  }

  /** Turn the sketch into a weapon in the hand's frame (x along the forearm). */
  build(): Weapon | null {
    const all = this.strokes.flat();
    if (all.length < 2) return null;
    const g = this.strokes[0][0];
    let far = g, fd = 0;
    for (const p of all) { const d = Math.hypot(p.x - g.x, p.y - g.y); if (d > fd) { fd = d; far = p; } }
    const len = fd * SCALE;
    if (len < MIN_LEN) return null;
    const k = Math.min(1, MAX_LEN / len) * SCALE;
    const ang = Math.atan2(far.y - g.y, far.x - g.x);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let ink = 0;
    const strokes = this.strokes.map((st) => st.map((p, i) => {
      const dx = (p.x - g.x) * k, dy = (p.y - g.y) * k;
      if (i) ink += Math.hypot(p.x - st[i - 1].x, p.y - st[i - 1].y) * k;
      return { x: dx * c - dy * s, y: dx * s + dy * c };
    }));
    return { strokes, length: fd * k, mass: Math.min(6, 0.4 + ink / 45) };
  }
}
