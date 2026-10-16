import rough from 'roughjs';
import type { Drawable, Options } from 'roughjs/bin/core';
import type { RoughCanvas } from 'roughjs/bin/canvas';
import { GROUND, H, W, RigidBody } from './physics';
import { Stickman, HEAD, NECK, PELVIS, EL0, HA0, EL1, HA1, KN0, FT0, KN1, FT1, DIM } from './stickman';
import { World, Cannon, Cloud, Spikes } from './world';
import { Vec } from './math';
import { Solid, shape } from './terrain';

// ---------------------------------------------------------------------------
// Notebook-doodle renderer: ruled paper, pencil strokes that "boil" (redrawn with a
// new wobble a few times a second, like hand-drawn animation), rough.js for props.
// ---------------------------------------------------------------------------

export interface Theme {
  dark: boolean;
  paper: string; ink: string; rule: string; margin: string; muted: string; graphite: string; ground: string;
}

/** The notebook is always white paper (light mode), whatever the system setting. */
export function theme(): Theme {
  const dark = false;
  return dark
    ? { dark, paper: '#1f2126', ink: '#ebe6da', rule: '#2c323d', margin: '#5a3438', muted: '#8d8a82', graphite: '#b9b4a8', ground: '#2a2c31' }
    : { dark, paper: '#fbf8ef', ink: '#2b2a28', rule: '#dbe5f1', margin: '#f0b9b9', muted: '#a39d90', graphite: '#55524c', ground: '#efe9dc' };
}

export interface Overlay {
  stroke: Vec[];
  strokeColor: string;
  debug: boolean;
  /** placed item under the mouse (highlighted) */
  hover: { kind: string; id: number } | null;
  extra?: (ctx: CanvasRenderingContext2D) => void;
}

// ------------------------------------------------------------------ seeded wobble

let boil = 0; // changes ~7x a second: every pencil line gets a fresh wobble

function hash(n: number) {
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n ^= n >>> 4;
  n = Math.imul(n, 0x27d4eb2d);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967295;
}
const jit = (seed: number, k: number, amp: number) => (hash(seed * 7919 + k * 104729 + boil * 31) - 0.5) * 2 * amp;

/** A pencil line: a slightly bowed main stroke plus a lighter second pass. */
export function pencil(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, seed: number, width: number, color: string) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const amp = Math.min(1.6, len * 0.035);
  const base = ctx.globalAlpha;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  for (let pass = 0; pass < 2; pass++) {
    const bow = jit(seed, pass, amp);
    const e0 = jit(seed, pass + 5, 0.8), e1 = jit(seed, pass + 9, 0.8);
    ctx.globalAlpha = base * (pass ? 0.45 : 1);
    ctx.lineWidth = pass ? width * 0.55 : width;
    ctx.beginPath();
    ctx.moveTo(ax + nx * e0, ay + ny * e0);
    ctx.quadraticCurveTo((ax + bx) / 2 + nx * bow * 2, (ay + by) / 2 + ny * bow * 2, bx + nx * e1, by + ny * e1);
    ctx.stroke();
  }
  ctx.globalAlpha = base;
}

/** A hand-drawn circle: a slightly open loop that overshoots its start. */
export function pencilCircle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, seed: number, width: number, color: string, fill?: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  const start = jit(seed, 1, Math.PI);
  const pts = 14;
  ctx.beginPath();
  for (let i = 0; i <= pts + 1; i++) {
    const a = start + (i / pts) * Math.PI * 2;
    const rr = r + jit(seed, i + 3, r * 0.06);
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  ctx.stroke();
}

/** Sketchy rounded box (speech bubbles, labels). */
export function pencilBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, seed: number, color: string, fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 10);
  ctx.fill();
  const r = 8;
  const c = [[x + r, y], [x + w - r, y], [x + w, y + r], [x + w, y + h - r], [x + w - r, y + h], [x + r, y + h], [x, y + h - r], [x, y + r]];
  for (let i = 0; i < 8; i += 2) pencil(ctx, c[i][0], c[i][1], c[i + 1][0], c[i + 1][1], seed + i, 2, color);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.moveTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.moveTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.moveTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.stroke();
}

// ------------------------------------------------------------------ rough.js props (cached, a few boil frames each)

const gen = rough.generator();
const cache = new Map<string, Drawable[][]>();
const BOIL_FRAMES = 3;

function hashStr(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

function cached(key: string, make: (seed: number) => Drawable[]): Drawable[] {
  let frames = cache.get(key);
  if (!frames) {
    frames = [];
    for (let i = 0; i < BOIL_FRAMES; i++) frames.push(make(1 + i * 977 + (hashStr(key) % 1000)));
    cache.set(key, frames);
    if (cache.size > 400) cache.delete(cache.keys().next().value!);
  }
  return frames[boil % BOIL_FRAMES];
}

let rc: RoughCanvas | null = null;
function drawAll(ds: Drawable[]) { for (const d of ds) rc!.draw(d); }

/** rough.js drawings for UI icons (palette cards). */
export { gen as roughGen };

// ------------------------------------------------------------------ main render

export function render(ctx: CanvasRenderingContext2D, world: World, ov: Overlay, th: Theme, time: number) {
  if (!rc) rc = rough.canvas(ctx.canvas);
  boil = Math.floor(time * 7);
  paper(ctx, th);
  groundAndRules(ctx, th);

  for (const s of world.solids) drawSolid(ctx, s, th, ov.hover?.kind === 'solid' && ov.hover.id === s.id);
  for (const z of world.spikes) drawSpikes(ctx, z, th, ov.hover?.kind === 'spikes' && ov.hover.id === z.id);
  for (const c of world.clouds) drawCloud(ctx, c, th, ov.hover?.kind === 'cloud' && ov.hover.id === c.id);
  for (const b of world.bodies) drawBody(ctx, b, th);
  const hero = world.men[0];
  for (const c of world.cannons) drawCannon(ctx, c, hero ? hero.chest : { x: W / 2, y: GROUND - 80 }, th, ov.hover?.kind === 'cannon' && ov.hover.id === c.id);
  world.men.forEach((m, i) => drawMan(ctx, m, th, ov.debug, ov.hover?.kind === 'man' && ov.hover.id === i));

  for (const t of world.texts) {
    ctx.globalAlpha = Math.max(0, 1 - t.t);
    ctx.fillStyle = t.color;
    ctx.font = `bold ${22 + (1 - Math.min(1, t.t * 4)) * 8}px "Patrick Hand", cursive`;
    ctx.textAlign = 'center';
    ctx.fillText(t.text, t.x, t.y);
  }
  ctx.globalAlpha = 1;

  if (ov.stroke.length > 1) {
    ctx.globalAlpha = 0.85;
    for (let i = 1; i < ov.stroke.length; i++) {
      const a = ov.stroke[i - 1], b = ov.stroke[i];
      pencil(ctx, a.x, a.y, b.x, b.y, i, 6, ov.strokeColor);
    }
    ctx.globalAlpha = 1;
  }
  ov.extra?.(ctx);
}

function paper(ctx: CanvasRenderingContext2D, th: Theme) {
  ctx.fillStyle = th.paper;
  ctx.fillRect(0, 0, W, H);
  // ruled lines + margin, like a school notebook
  ctx.strokeStyle = th.rule;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let y = 70; y < GROUND; y += 42) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
  ctx.strokeStyle = th.margin;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(86, 0); ctx.lineTo(86, GROUND); ctx.stroke();
}

function groundAndRules(ctx: CanvasRenderingContext2D, th: Theme) {
  ctx.fillStyle = th.ground;
  ctx.fillRect(0, GROUND, W, H - GROUND);
  drawAll(cached(`ground:${th.dark}:${GROUND}`, (seed) => [
    gen.rectangle(-10, GROUND + 4, W + 20, H - GROUND, { seed, stroke: 'none', fill: th.graphite, fillStyle: 'hachure', hachureGap: 14, hachureAngle: -50, fillWeight: 0.7, roughness: 1.4 }),
    gen.line(0, GROUND, W, GROUND, { seed, stroke: th.ink, strokeWidth: 3, roughness: 1.3, bowing: 0.6 }),
  ]));
}

const SOLID_FILL: Record<Solid['kind'], [string, string]> = {
  ramp: ['#d9b38c', 'hachure'], platform: ['#d9b38c', 'cross-hatch'], wall: ['#b9a38c', 'cross-hatch'], trampoline: ['#5b8bd0', 'solid'],
};

function drawSolid(ctx: CanvasRenderingContext2D, s: Solid, th: Theme, hot: boolean) {
  ctx.save();
  ctx.translate(s.x, s.y);
  glow(ctx, hot);
  const [fill, style] = SOLID_FILL[s.kind];
  drawAll(cached(`solid:${s.kind}:${s.flip}`, (seed) => {
    const pts = shape(s.kind, 0, 0, s.flip).map((p) => [p.x, p.y] as [number, number]);
    const out = [gen.polygon(pts, { seed, stroke: th.ink, strokeWidth: 2.2, fill, fillStyle: style, hachureGap: 7, fillWeight: 1, roughness: 1.2 })];
    if (s.kind === 'trampoline') {
      // springy legs
      for (const lx of [-50, 50]) out.push(gen.linearPath([[lx, 0], [lx + 8, -6], [lx - 8, -12], [lx, -18]], { seed, stroke: th.ink, strokeWidth: 2 }));
    }
    return out;
  }));
  ctx.restore();
}

function glow(ctx: CanvasRenderingContext2D, on: boolean) {
  if (on) { ctx.shadowColor = '#f2a93b'; ctx.shadowBlur = 16; }
}

function drawSpikes(ctx: CanvasRenderingContext2D, z: Spikes, th: Theme, hot: boolean) {
  const w = z.x1 - z.x0;
  ctx.save();
  ctx.translate(z.x0, GROUND);
  glow(ctx, hot);
  drawAll(cached(`spikes:${Math.round(w)}:${th.dark}`, (seed) => {
    const n = Math.max(2, Math.round(w / 16)), sw = w / n;
    const pts: [number, number][] = [[0, 0]];
    for (let i = 0; i < n; i++) { pts.push([i * sw + sw / 2, -26]); pts.push([(i + 1) * sw, 0]); }
    return [gen.polygon(pts, { seed, stroke: th.ink, strokeWidth: 2, fill: '#9aa3ad', fillStyle: 'zigzag', hachureGap: 4, roughness: 1.2 })];
  }));
  ctx.restore();
}

function drawCannon(ctx: CanvasRenderingContext2D, c: Cannon, target: Vec, th: Theme, hot: boolean) {
  const dir = Math.sign(target.x - c.x) || 1;
  const ang = Math.atan2(target.y - c.y, Math.abs(target.x - c.x));
  ctx.save();
  ctx.translate(c.x, c.y);
  glow(ctx, hot);
  ctx.scale(dir, 1);
  // barrel (recoils when it fires)
  ctx.save();
  ctx.rotate(Math.max(-0.9, Math.min(0.6, ang)));
  ctx.translate(-c.flash * 40, 0);
  drawAll(cached(`barrel:${th.dark}`, (seed) => [gen.rectangle(-14, -11, 50, 22, { seed, stroke: th.ink, strokeWidth: 2.2, fill: th.graphite, fillStyle: 'cross-hatch', hachureGap: 5, roughness: 1.1 })]));
  ctx.restore();
  drawAll(cached(`wheel:${th.dark}`, (seed) => [
    gen.circle(-4, 14, 30, { seed, stroke: th.ink, strokeWidth: 2.2, fill: th.paper, fillStyle: 'solid', roughness: 1.2 }),
    gen.line(-4, 0, -4, 28, { seed, stroke: th.ink, strokeWidth: 1.4 }),
    gen.line(-18, 14, 10, 14, { seed, stroke: th.ink, strokeWidth: 1.4 }),
  ]));
  ctx.restore();
}

function drawCloud(ctx: CanvasRenderingContext2D, c: Cloud, th: Theme, hot: boolean) {
  ctx.save();
  ctx.translate(c.x, c.y);
  glow(ctx, hot);
  drawAll(cached(`cloud:${th.dark}`, (seed) => [
    gen.path('M -58 14 C -74 12 -72 -14 -50 -12 C -50 -34 -18 -38 -8 -22 C 4 -42 40 -36 40 -14 C 62 -18 70 10 52 14 Z', { seed, stroke: th.ink, strokeWidth: 2.2, fill: th.dark ? '#59606b' : '#c9d3df', fillStyle: 'hachure', hachureGap: 6, roughness: 1.4 }),
  ]));
  // little rain dashes
  ctx.shadowBlur = 0;
  ctx.strokeStyle = th.dark ? '#8fb6e8' : '#5b8bd0';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const x = -40 + i * 20, y = 22 + ((boil * 6 + i * 9) % 22);
    ctx.moveTo(x, y); ctx.lineTo(x - 3, y + 8);
  }
  ctx.stroke();
  ctx.restore();
}

function drawBody(ctx: CanvasRenderingContext2D, b: RigidBody, th: Theme) {
  ctx.save();
  // drawings get "erased" at the end: fade + slight shrink
  const FADE = 0.8;
  const left = b.life - b.age;
  const fade = left < FADE ? Math.max(0, left / FADE) : 1;
  ctx.globalAlpha = fade;
  ctx.translate(b.x, b.y);
  ctx.rotate(b.angle);
  if (fade < 1) ctx.scale(0.85 + 0.15 * fade, 0.85 + 0.15 * fade);
  if (b.kind === 'ball') {
    const r = b.circles[0].r;
    drawAll(cached(`ball:${Math.round(r)}:${th.dark}`, (seed) => [gen.circle(0, 0, r * 2, { seed, stroke: th.ink, strokeWidth: 2, fill: th.graphite, fillStyle: 'cross-hatch', hachureGap: Math.max(3, r / 3), roughness: 1.3 })]));
  } else {
    const o = b.outline;
    if (o.length > 1) {
      if (b.closed) {
        drawAll(cached(`fill:${b.id}`, (seed) => [gen.polygon(o.map((p) => [p.x, p.y] as [number, number]), { seed, stroke: 'none', fill: b.color, fillStyle: 'hachure', hachureGap: 6, fillWeight: 1.2, roughness: 1.4 } as Options)]));
      }
      for (let i = 1; i < o.length; i++) pencil(ctx, o[i - 1].x, o[i - 1].y, o[i].x, o[i].y, b.id * 100 + i, 6, b.color);
    } else {
      for (const c of b.circles) pencilCircle(ctx, c.lx, c.ly, c.r, b.id, 2.5, th.ink, b.color);
    }
  }
  ctx.restore();
}

/** Stickman in pencil. Far limbs lighter, a weapon in the near hand, KO stars when out. */
export function drawMan(ctx: CanvasRenderingContext2D, m: Stickman, th: Theme, debug: boolean, hot = false) {
  const ps = m.ps;
  const ink = m.flash > 0 ? '#e0443b' : m.color;
  const seed = m.team * 1000 + 7;
  ctx.save();
  glow(ctx, hot);
  const bone = (a: number, b: number, w: number, k: number) => pencil(ctx, ps[a].x, ps[a].y, ps[b].x, ps[b].y, seed + k, w, ink);
  ctx.globalAlpha = m.alive ? 0.5 : 0.3;
  bone(NECK, EL0, 4.5, 1); bone(EL0, HA0, 4.5, 2);
  bone(PELVIS, KN0, 4.5, 3); bone(KN0, FT0, 4.5, 4);
  ctx.globalAlpha = m.alive ? 1 : 0.55;
  bone(PELVIS, NECK, 5.5, 5);
  const h = ps[HEAD];
  pencilCircle(ctx, h.x, h.y, DIM.headR, seed + 6, 3.8, ink, th.paper);
  // eyes look the way he faces; X's when knocked out
  ctx.fillStyle = ink;
  if (m.alive) {
    ctx.beginPath(); ctx.arc(h.x + m.facing * 4.5, h.y - 2, 1.7, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(h.x + m.facing * 0.5, h.y - 2, 1.4, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.lineWidth = 1.5; ctx.strokeStyle = ink;
    for (const ox of [-3.5, 3]) {
      ctx.beginPath();
      ctx.moveTo(h.x + ox - 2, h.y - 4); ctx.lineTo(h.x + ox + 2, h.y);
      ctx.moveTo(h.x + ox + 2, h.y - 4); ctx.lineTo(h.x + ox - 2, h.y);
      ctx.stroke();
    }
  }
  bone(NECK, EL1, 5, 7); bone(EL1, HA1, 5, 8);
  bone(PELVIS, KN1, 5, 9); bone(KN1, FT1, 5, 10);
  if (m.weapon) drawWeapon(ctx, m, th);
  ctx.restore();

  // health: a hand-drawn bar
  const top = Math.min(...ps.map((p) => p.y)) - DIM.headR - 22;
  const cx = ps[PELVIS].x;
  ctx.fillStyle = m.health > 35 ? m.color : '#e0443b';
  ctx.globalAlpha = 0.75;
  ctx.fillRect(cx - 25, top + 1, 50 * (m.health / m.maxHealth), 4);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = th.ink;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(cx - 26, top, 52, 6);
  if (!m.alive) {
    // KO: stars circling the head
    const t = m.time * 4;
    ctx.fillStyle = '#e8b21c';
    ctx.font = '18px "Patrick Hand", cursive';
    ctx.textAlign = 'center';
    for (let i = 0; i < 3; i++) {
      const a = t + (i * Math.PI * 2) / 3;
      ctx.fillText('★', h.x + Math.cos(a) * 18, h.y - 18 + Math.sin(a) * 6);
    }
  }
  if (debug) {
    ctx.fillStyle = '#20b070';
    for (const t of m.debugTargets) { ctx.beginPath(); ctx.arc(t.x, t.y, 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = th.muted;
    ctx.font = '14px "Patrick Hand", cursive';
    ctx.textAlign = 'center';
    ctx.fillText(`${m.mode}${m.busy ? ' / ' + m.action.kind : ''}`, cx, top - 8);
  }
}

function drawWeapon(ctx: CanvasRenderingContext2D, m: Stickman, th: Theme) {
  const w = m.weapon!;
  const e = m.ps[EL1], h = m.ps[HA1];
  const ang = Math.atan2(h.y - e.y, h.x - e.x);
  ctx.save();
  ctx.translate(h.x, h.y);
  ctx.rotate(ang);
  ctx.globalAlpha = 1;
  let k = 0;
  for (const s of w.strokes) for (let i = 1; i < s.length; i++) pencil(ctx, s[i - 1].x, s[i - 1].y, s[i].x, s[i].y, 300 + k++, 4, th.dark ? '#d9a35f' : '#8a5a2b');
  // swoosh lines while the swing is live
  if (m.action.kind === 'swing' && m.action.t > 0.1 && m.action.t < 0.3) {
    ctx.strokeStyle = th.muted;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 2;
    for (let k = 1; k <= 3; k++) {
      ctx.beginPath();
      ctx.arc(0, 0, w.length * (0.55 + k * 0.15), -0.9 - k * 0.12, -0.2);
      ctx.stroke();
    }
  }
  ctx.restore();
}
