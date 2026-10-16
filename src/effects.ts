import type { WorldEvent } from './world';
import type { Theme } from './render';
import { pencil, pencilCircle } from './render';
import { rand } from './math';

// Comic/doodle effects driven by world events: POW bursts, ink splats, dust puffs,
// eraser crumbs, cannon smoke, "aha!" lightbulbs, and screen shake.

interface Fx { kind: 'pow' | 'ink' | 'dust' | 'crumb' | 'smoke' | 'aha' | 'tink'; x: number; y: number; vx: number; vy: number; t: number; life: number; size: number; rot: number; text?: string; color?: string }

const WORDS = { object: ['BONK!', 'THUD!', 'OOF!'], punch: ['POW!', 'BAM!'], kick: ['WHAM!', 'BOOF!'], swing: ['WHACK!', 'THWACK!', 'SMACK!'], spikes: ['OUCH!', 'YOW!'] };

export class Effects {
  fx: Fx[] = [];
  shake = 0;
  private seed = 1;

  add(e: Omit<Fx, 't'>) { this.fx.push({ ...e, t: 0 }); }

  /** Turn world events into effects. */
  consume(events: WorldEvent[], th: Theme) {
    for (const e of events) {
      if (e.type === 'hit') {
        const big = e.dmg >= 12;
        const words = WORDS[e.by];
        if (e.dmg >= 4) this.add({ kind: 'pow', x: e.x + rand(-10, 10), y: e.y - 30, vx: 0, vy: -20, life: 0.65, size: 30 + Math.min(40, e.dmg * 1.6), rot: rand(-0.3, 0.3), text: words[Math.floor(Math.random() * words.length)] });
        for (let i = 0; i < (big ? 14 : 7); i++) {
          const a = rand(0, Math.PI * 2), s = rand(120, 420);
          this.add({ kind: 'ink', x: e.x, y: e.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 100, life: rand(0.3, 0.6), size: rand(2, 5), rot: a, color: th.ink });
        }
        this.shake = Math.max(this.shake, Math.min(14, e.dmg * 0.5));
      } else if (e.type === 'block' && e.weapon) {
        this.add({ kind: 'pow', x: e.x, y: e.y - 26, vx: 0, vy: -20, life: 0.5, size: 34, rot: rand(-0.3, 0.3), text: 'CLANG!' });
        this.add({ kind: 'tink', x: e.x, y: e.y, vx: 0, vy: 0, life: 0.35, size: 18, rot: rand(0, 1), text: '' });
        this.shake = Math.max(this.shake, 4);
      } else if (e.type === 'block') {
        this.add({ kind: 'tink', x: e.x, y: e.y, vx: 0, vy: 0, life: 0.35, size: 18, rot: rand(0, 1), text: 'tink!' });
      } else if (e.type === 'fire') {
        this.add({ kind: 'pow', x: e.x + e.dir * 26, y: e.y - 6, vx: e.dir * 30, vy: -30, life: 0.45, size: 26, rot: rand(-0.2, 0.2), text: 'BOOM' });
        for (let i = 0; i < 6; i++) this.add({ kind: 'smoke', x: e.x + e.dir * 20, y: e.y, vx: e.dir * rand(20, 90), vy: rand(-60, -10), life: rand(0.5, 0.9), size: rand(8, 16), rot: 0 });
        this.shake = Math.max(this.shake, 3);
      } else if (e.type === 'boing') {
        this.add({ kind: 'pow', x: e.x, y: e.y - 20, vx: 0, vy: -40, life: 0.5, size: 28, rot: rand(-0.2, 0.2), text: 'BOING!' });
      } else if (e.type === 'ko') {
        this.add({ kind: 'pow', x: e.x, y: e.y - 50, vx: 0, vy: -15, life: 1.1, size: 54, rot: rand(-0.15, 0.15), text: 'K.O.!' });
        this.shake = Math.max(this.shake, 12);
      } else if (e.type === 'erase') {
        const b = e.body;
        for (let i = 0; i < Math.min(18, 4 + b.circles.length / 3); i++) {
          const c = b.circles[Math.floor(Math.random() * b.circles.length)];
          this.add({ kind: 'crumb', x: c.wx, y: c.wy, vx: rand(-60, 60), vy: rand(-80, 10), life: rand(0.5, 0.9), size: rand(2, 4), rot: rand(0, 3), color: '#e7a1b0' });
        }
      }
    }
    events.length = 0;
  }

  dust(x: number, y: number, n = 8) {
    for (let i = 0; i < n; i++) this.add({ kind: 'dust', x: x + rand(-20, 20), y, vx: rand(-90, 90), vy: rand(-60, -10), life: rand(0.4, 0.7), size: rand(6, 12), rot: 0 });
  }

  aha(x: number, y: number) {
    this.add({ kind: 'aha', x, y, vx: 0, vy: -25, life: 1.4, size: 1, rot: 0, text: 'aha!' });
  }

  step(dt: number) {
    for (const f of this.fx) {
      f.t += dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      if (f.kind === 'ink' || f.kind === 'crumb') f.vy += 900 * dt;
      if (f.kind === 'dust' || f.kind === 'smoke') { f.vx *= 0.94; f.vy *= 0.94; }
    }
    this.fx = this.fx.filter((f) => f.t < f.life);
    this.shake *= Math.pow(0.0015, dt);
    if (this.shake < 0.2) this.shake = 0;
  }

  /** Camera offset for screen shake. */
  offset() {
    return this.shake ? { x: rand(-1, 1) * this.shake, y: rand(-1, 1) * this.shake } : { x: 0, y: 0 };
  }

  draw(ctx: CanvasRenderingContext2D, th: Theme) {
    for (const f of this.fx) {
      const k = f.t / f.life;
      ctx.save();
      ctx.translate(f.x, f.y);
      switch (f.kind) {
        case 'pow': {
          // spring pop: overshoot then settle, fade at the end
          const pop = k < 0.25 ? easeOutBack(k / 0.25) : 1;
          ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
          ctx.rotate(f.rot);
          ctx.scale(pop, pop);
          star(ctx, f.size, this.seed + Math.floor(f.x), th);
          ctx.fillStyle = th.ink;
          ctx.font = `bold ${Math.round(f.size * 0.55)}px "Patrick Hand", cursive`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(f.text!, 0, 2);
          break;
        }
        case 'tink': {
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = '#5b7fb5';
          ctx.lineWidth = 2;
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2 + f.rot, r0 = 6 + k * 10, r1 = 12 + k * 16;
            ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.stroke();
          }
          ctx.fillStyle = '#5b7fb5';
          ctx.font = 'bold 16px "Patrick Hand", cursive';
          ctx.textAlign = 'center';
          ctx.fillText(f.text!, 0, -22 - k * 10);
          break;
        }
        case 'ink':
          ctx.globalAlpha = 1 - k;
          ctx.rotate(Math.atan2(f.vy, f.vx));
          ctx.fillStyle = f.color!;
          ctx.beginPath(); ctx.ellipse(0, 0, f.size * 1.8, f.size * 0.7, 0, 0, Math.PI * 2); ctx.fill();
          break;
        case 'crumb':
          ctx.globalAlpha = 1 - k;
          ctx.rotate(f.rot + k * 6);
          ctx.fillStyle = f.color!;
          ctx.fillRect(-f.size, -f.size / 2, f.size * 2, f.size);
          break;
        case 'dust':
        case 'smoke':
          ctx.globalAlpha = (1 - k) * 0.7;
          pencilCircle(ctx, 0, 0, f.size * (0.6 + k), 900 + Math.floor(f.vx), 1.5, th.muted);
          break;
        case 'aha': {
          const pop = k < 0.2 ? easeOutBack(k / 0.2) : 1;
          ctx.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1;
          ctx.scale(pop, pop);
          // lightbulb doodle
          pencilCircle(ctx, 0, -10, 11, 77, 2.4, th.ink, '#ffe680');
          pencil(ctx, -5, 2, 5, 2, 78, 2.4, th.ink);
          pencil(ctx, -4, 6, 4, 6, 79, 2.4, th.ink);
          for (let i = 0; i < 5; i++) {
            const a = -Math.PI / 2 + (i - 2) * 0.55;
            pencil(ctx, Math.cos(a) * 16, -10 + Math.sin(a) * 16, Math.cos(a) * 23, -10 + Math.sin(a) * 23, 80 + i, 2, '#e8b21c');
          }
          ctx.fillStyle = th.ink;
          ctx.font = 'bold 18px "Patrick Hand", cursive';
          ctx.textAlign = 'left';
          ctx.fillText(f.text!, 18, -6);
          break;
        }
      }
      ctx.restore();
    }
  }
}

function easeOutBack(x: number) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

/** Jagged comic star, yellow highlighter fill with a pencil outline. */
function star(ctx: CanvasRenderingContext2D, size: number, seed: number, th: Theme) {
  const n = 11;
  const pts: [number, number][] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2;
    const r = (i % 2 ? size * 0.6 : size) * (0.88 + ((seed * (i + 3)) % 7) / 40);
    pts.push([Math.cos(a) * r * 1.25, Math.sin(a) * r * 0.8]);
  }
  ctx.fillStyle = th.dark ? '#c99a1a' : '#ffe24d';
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    pencil(ctx, a[0], a[1], b[0], b[1], seed + i, 2.2, th.ink);
  }
}
