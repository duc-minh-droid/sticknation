import { DT, Particle, RigidBody, impulseVsStatic } from './physics';
import type { Vec } from './math';

// Static terrain you can place: ramps, platforms, walls, trampolines. Each is a convex
// polygon. Particles (stickmen) and rigid bodies (drawings, balls) collide with it, and
// stickmen can stand and walk on its top surfaces.

export type SolidKind = 'ramp' | 'platform' | 'wall' | 'trampoline';
export interface Solid { id: number; kind: SolidKind; x: number; y: number; flip: number; pts: Vec[] }

/** Shape for a kind, anchored at (x, y): bottom-centre for ground pieces, centre for platforms. */
export function shape(kind: SolidKind, x: number, y: number, flip: number): Vec[] {
  switch (kind) {
    case 'ramp': return flip > 0
      ? [{ x: x - 130, y }, { x: x + 130, y }, { x: x + 130, y: y - 120 }]
      : [{ x: x - 130, y }, { x: x + 130, y }, { x: x - 130, y: y - 120 }];
    case 'platform': return rect(x - 110, y - 9, 220, 18);
    case 'wall': return rect(x - 16, y - 170, 32, 170);
    case 'trampoline': return rect(x - 65, y - 22, 130, 22);
  }
}
const rect = (x: number, y: number, w: number, h: number): Vec[] => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

export const sitsOnGround = (k: SolidKind) => k !== 'platform';

export function makeSolid(id: number, kind: SolidKind, x: number, y: number, flip = 1): Solid {
  return { id, kind, x, y, flip, pts: shape(kind, x, y, flip) };
}
export function reshape(s: Solid) { s.pts = shape(s.kind, s.x, s.y, s.flip); }

export function bounds(s: Solid) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of s.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
}

export function inside(s: Solid, x: number, y: number) {
  let c = false;
  const pts = s.pts;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/** Top surface height of a solid at x (smallest y where a vertical line enters it), or null. */
export function topAt(s: Solid, x: number): number | null {
  let top: number | null = null;
  const pts = s.pts;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if ((x < Math.min(a.x, b.x)) || (x > Math.max(a.x, b.x)) || a.x === b.x) continue;
    const y = a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y);
    if (top === null || y < top) top = y;
  }
  return top;
}

/**
 * Circle vs convex polygon: returns the push-out normal (pointing out of the solid) and
 * depth, or null when not touching.
 */
export function contact(s: Solid, cx: number, cy: number, r: number): { nx: number; ny: number; depth: number } | null {
  const pts = s.pts;
  const isIn = inside(s, cx, cy);
  let best = Infinity, bx = 0, by = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    const len2 = ex * ex + ey * ey;
    let t = ((cx - a.x) * ex + (cy - a.y) * ey) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + ex * t, py = a.y + ey * t;
    const d = Math.hypot(cx - px, cy - py);
    if (d < best) { best = d; bx = px; by = py; }
  }
  if (!isIn && best >= r) return null;
  let nx = cx - bx, ny = cy - by;
  const l = Math.hypot(nx, ny) || 1;
  nx /= l; ny /= l;
  if (isIn) { nx = -nx; ny = -ny; }
  return { nx, ny, depth: isIn ? best + r : r - best };
}

/** Push a particle out of the solid, with friction; marks it grounded on up-facing surfaces. */
export function collideParticle(s: Solid, p: Particle, friction: number): boolean {
  const c = contact(s, p.x, p.y, p.radius);
  if (!c) return false;
  p.x += c.nx * c.depth;
  p.y += c.ny * c.depth;
  // velocity: remove the into-surface part and some of the sliding part
  let vx = p.x - p.px, vy = p.y - p.py;
  const vn = vx * c.nx + vy * c.ny;
  if (vn < 0) { vx -= vn * c.nx; vy -= vn * c.ny; }
  const tx = -c.ny, ty = c.nx;
  const vt = vx * tx + vy * ty;
  vx -= vt * tx * friction; vy -= vt * ty * friction;
  p.px = p.x - vx; p.py = p.y - vy;
  if (c.ny < -0.5) p.grounded = true;
  return c.ny < -0.5;
}

/** Rigid body vs solid. Trampolines are extra bouncy. */
export function collideBody(s: Solid, b: RigidBody) {
  let hit = false;
  for (const k of b.circles) {
    const c = contact(s, k.wx, k.wy, k.r);
    if (!c) continue;
    hit = true;
    const bounce = s.kind === 'trampoline' && c.ny < -0.5 ? 1.0 : 0.25;
    // impulse at the contact point (not the circle centre) so friction makes things roll
    impulseVsStatic(b, k.wx - c.nx * k.r - b.x, k.wy - c.ny * k.r - b.y, c.nx, c.ny, bounce, 0.5);
    b.x += c.nx * c.depth * 0.8;
    b.y += c.ny * c.depth * 0.8;
    if (bounce >= 1) b.vy = Math.min(b.vy, -900);
    b.updateWorld();
  }
  return hit;
}

export const TRAMPOLINE_LAUNCH = 1050; // px/s upward
export { DT };
