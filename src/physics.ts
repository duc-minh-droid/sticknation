import { Vec, clamp } from './math';

// World units are pixels of a fixed 1600x900 arena; time in seconds.
export const W = 1600;
/** Arena height follows the screen's shape (setArenaHeight); the floor sits 80 above the bottom. */
export let H = 900;
export let GROUND = 820;
export function setArenaHeight(h: number) {
  H = h;
  GROUND = h - 80;
}
export const GRAVITY = 1800;
export const DT = 1 / 120;
const MAX_STEP = 3000 * DT;

/** Verlet point mass. Velocity is implicit: (x - px) / DT. */
export class Particle {
  px: number;
  py: number;
  invMass: number;
  grounded = false;

  constructor(public x: number, public y: number, public mass: number, public radius: number) {
    this.px = x;
    this.py = y;
    this.invMass = 1 / mass;
  }

  get vx() { return (this.x - this.px) / DT; }
  get vy() { return (this.y - this.py) / DT; }

  addVel(vx: number, vy: number) {
    this.px -= vx * DT;
    this.py -= vy * DT;
  }

  setVel(vx: number, vy: number) {
    this.px = this.x - vx * DT;
    this.py = this.y - vy * DT;
  }

  /** Move without changing velocity. */
  shift(dx: number, dy: number) {
    this.x += dx; this.y += dy;
    this.px += dx; this.py += dy;
  }

  integrate(damping: number) {
    // clamp to 3000 px/s so a bad contact can never blow the rig apart
    const vx = clamp((this.x - this.px) * damping, -MAX_STEP, MAX_STEP);
    const vy = clamp((this.y - this.py) * damping, -MAX_STEP, MAX_STEP);
    this.px = this.x;
    this.py = this.y;
    this.x += vx;
    this.y += vy + GRAVITY * DT * DT;
  }

  /** Ground and side walls. Friction 0..1 removes that fraction of tangential velocity per contact. */
  collideWorld(friction: number) {
    const r = this.radius;
    // touching (within half a pixel) counts as contact, so resting feet keep friction
    this.grounded = this.y + r >= GROUND - 0.5;
    if (this.y + r > GROUND) {
      this.y = GROUND - r;
      const vx = this.x - this.px;
      this.px = this.x - vx * (1 - friction);
      if (this.py < this.y) this.py = this.y; // no downward velocity left
      this.grounded = true;
    }
    // ceiling: the arena is closed, nothing leaves the screen
    if (this.y - r < 0) { this.y = r; if (this.py > this.y) this.py = this.y; }
    if (this.x - r < 0) { this.x = r; if (this.px < this.x) this.px = this.x; }
    if (this.x + r > W) { this.x = W - r; if (this.px > this.x) this.px = this.x; }
  }
}

export class Stick {
  constructor(public a: Particle, public b: Particle, public len: number) {}

  solve() {
    const a = this.a, b = this.b;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    const w = a.invMass + b.invMass;
    const k = (d - this.len) / (d * w);
    a.x += dx * k * a.invMass; a.y += dy * k * a.invMass;
    b.x -= dx * k * b.invMass; b.y -= dy * k * b.invMass;
  }
}

export interface Circle { lx: number; ly: number; r: number; wx: number; wy: number }

let nextBodyId = 1;

export type BodyKind = 'drawn' | 'ball' | 'rock';

/** Rigid body made of circles; drawn shapes, cannonballs, rocks. Velocities in px/s. */
export class RigidBody {
  id = nextBodyId++;
  vx = 0; vy = 0; w = 0;
  angle = 0;
  mass: number; invMass: number;
  inertia: number; invInertia: number;
  circles: Circle[];
  /** Outline in local coords for rendering. */
  outline: Vec[];
  closed: boolean;
  boundR: number;
  age = 0;
  life = Infinity;
  color: string;
  /** Extra damage multiplier for pointy drawings (thin + fast). */
  sharpness: number;

  constructor(public x: number, public y: number, circles: { x: number; y: number; r: number }[], outline: Vec[], closed: boolean, public kind: BodyKind, color: string) {
    // centre of mass (circle mass ~ area)
    let m = 0, cx = 0, cy = 0;
    for (const c of circles) { const cm = c.r * c.r; m += cm; cx += c.x * cm; cy += c.y * cm; }
    cx /= m; cy /= m;
    this.x = cx; this.y = cy;
    const density = 0.012;
    this.mass = m * Math.PI * density;
    this.invMass = 1 / this.mass;
    let I = 0, br = 0;
    this.circles = circles.map((c) => {
      const lx = c.x - cx, ly = c.y - cy;
      const cm = c.r * c.r * Math.PI * density;
      I += cm * (lx * lx + ly * ly + 0.5 * c.r * c.r);
      br = Math.max(br, Math.hypot(lx, ly) + c.r);
      return { lx, ly, r: c.r, wx: c.x, wy: c.y };
    });
    this.inertia = I;
    this.invInertia = 1 / I;
    this.boundR = br;
    this.outline = outline.map((p) => ({ x: p.x - cx, y: p.y - cy }));
    this.closed = closed;
    this.color = color;
    // thin, elongated shapes hurt more (spears, blades)
    const area = circles.length;
    this.sharpness = closed ? 1 : clamp(br / (6 * Math.sqrt(area)), 1, 1.5);
    this.updateWorld();
  }

  updateWorld() {
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    for (const k of this.circles) {
      k.wx = this.x + k.lx * c - k.ly * s;
      k.wy = this.y + k.lx * s + k.ly * c;
    }
  }

  toWorld(lx: number, ly: number): Vec {
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    return { x: this.x + lx * c - ly * s, y: this.y + lx * s + ly * c };
  }

  toLocal(wx: number, wy: number): Vec {
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    const dx = wx - this.x, dy = wy - this.y;
    return { x: dx * c + dy * s, y: -dx * s + dy * c };
  }

  pointVel(rx: number, ry: number): Vec {
    return { x: this.vx - this.w * ry, y: this.vy + this.w * rx };
  }

  applyImpulse(jx: number, jy: number, rx: number, ry: number) {
    this.vx += jx * this.invMass;
    this.vy += jy * this.invMass;
    this.w += (rx * jy - ry * jx) * this.invInertia;
  }

  integrate(dt: number) {
    this.age += dt;
    this.vy += GRAVITY * dt;
    this.vx *= 0.9995; this.vy *= 0.9995; this.w *= 0.998;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.angle += this.w * dt;
    this.updateWorld();
  }

  get speed() { return Math.hypot(this.vx, this.vy); }

  /** Independent copy (same id, so damage sources still match). */
  clone(): RigidBody {
    const c = Object.assign(Object.create(RigidBody.prototype) as RigidBody, this);
    c.circles = this.circles.map((k) => ({ ...k }));
    return c;
  }
}

/** Resolve a contact between a body point (offset r from COM) and an immovable surface with normal n (pointing into the body). */
export function impulseVsStatic(b: RigidBody, rx: number, ry: number, nx: number, ny: number, restitution: number, mu: number) {
  const v = b.pointVel(rx, ry);
  const vn = v.x * nx + v.y * ny;
  if (vn >= 0) return 0;
  const rn = rx * ny - ry * nx;
  const e = vn < -120 ? restitution : 0;
  const j = (-(1 + e) * vn) / (b.invMass + rn * rn * b.invInertia);
  b.applyImpulse(nx * j, ny * j, rx, ry);
  const tx = -ny, ty = nx;
  const v2 = b.pointVel(rx, ry);
  const vt = v2.x * tx + v2.y * ty;
  const rt = rx * ty - ry * tx;
  let jt = -vt / (b.invMass + rt * rt * b.invInertia);
  jt = clamp(jt, -mu * j, mu * j);
  b.applyImpulse(tx * jt, ty * jt, rx, ry);
  return j;
}

export function collideBodyWorld(b: RigidBody) {
  let touching = false;
  const hits: { rx: number; ry: number; pen: number }[] = [];
  for (const c of b.circles) {
    const pen = c.wy + c.r - GROUND;
    if (pen > -0.5) touching = true;
    if (pen > 0) {
      hits.push({ rx: c.wx - b.x, ry: GROUND - b.y, pen });
      impulseVsStatic(b, c.wx - b.x, GROUND - b.y, 0, -1, 0.25, 0.55);
    }
  }
  // position: per-contact pseudo-impulses, so an uneven landing also levels the body
  for (const h of hits) pushOut(b, h.rx, h.ry, 0, -1, h.pen / hits.length);
  let lift = 0;
  for (const c of b.circles) lift = Math.max(lift, c.wy + c.r - GROUND - 1.5);
  if (lift > 0) b.y -= lift; // hard floor for deep penetrations
  let push = 0;
  for (const c of b.circles) {
    if (c.wx - c.r < 0) { push = Math.max(push, c.r - c.wx); impulseVsStatic(b, c.wx - b.x, c.wy - b.y, 1, 0, 0.3, 0.3); }
    if (c.wx + c.r > W) { push = Math.min(push, W - c.wx - c.r); impulseVsStatic(b, c.wx - b.x, c.wy - b.y, -1, 0, 0.3, 0.3); }
  }
  b.x += push;
  let drop = 0;
  for (const c of b.circles) {
    if (c.wy - c.r < 0) { drop = Math.max(drop, c.r - c.wy); impulseVsStatic(b, c.wx - b.x, c.wy - b.y, 0, 1, 0.3, 0.3); }
  }
  b.y += drop;
  if (touching) settle(b, 0.993);
  b.updateWorld();
}

/**
 * Rolling resistance while in contact, and a strong brake once nearly still so resting
 * piles settle instead of jittering forever.
 */
function settle(b: RigidBody, k: number) {
  b.vx *= k; b.w *= k;
  if (Math.hypot(b.vx, b.vy) < 14 && Math.abs(b.w) < 0.3) { b.vx *= 0.85; b.vy *= 0.85; b.w *= 0.85; }
}

interface Contact { nx: number; ny: number; pen: number; px: number; py: number }

/**
 * Positional correction at a contact point (Box2D-style "pseudo-impulse"): moves and
 * rotates the body so the point leaves the surface. other = the other body, if any.
 */
function pushOut(b: RigidBody, rx: number, ry: number, nx: number, ny: number, pen: number) {
  const c = pen - 0.25;
  if (c <= 0) return;
  const rn = rx * ny - ry * nx;
  const lam = (0.8 * c) / (b.invMass + rn * rn * b.invInertia);
  b.x += nx * lam * b.invMass; b.y += ny * lam * b.invMass; b.angle += rn * lam * b.invInertia;
}

export function collideBodies(a: RigidBody, b: RigidBody) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const rr = a.boundR + b.boundR;
  if (dx * dx + dy * dy > rr * rr) return;
  // gather every overlapping circle pair first, then resolve once: correcting per pair
  // over-pushes multi-circle shapes and makes piles explode
  const contacts: Contact[] = [];
  for (const ca of a.circles) {
    for (const cb of b.circles) {
      const ex = ca.wx - cb.wx, ey = ca.wy - cb.wy;
      const d2 = ex * ex + ey * ey, rs = ca.r + cb.r;
      if (d2 >= rs * rs) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const nx = ex / d, ny = ey / d; // from b to a
      contacts.push({ nx, ny, pen: rs - d, px: cb.wx + nx * cb.r, py: cb.wy + ny * cb.r });
    }
  }
  if (!contacts.length) return;
  const wsum = a.invMass + b.invMass;
  // position: push apart along the averaged normal by the deepest overlap
  let nx = 0, ny = 0, pen = 0;
  for (const c of contacts) { nx += c.nx * c.pen; ny += c.ny * c.pen; pen = Math.max(pen, c.pen); }
  const nl = Math.hypot(nx, ny) || 1;
  nx /= nl; ny /= nl;
  const corr = Math.max(0, pen - 0.3) * 0.8;
  a.x += nx * corr * (a.invMass / wsum); a.y += ny * corr * (a.invMass / wsum);
  b.x -= nx * corr * (b.invMass / wsum); b.y -= ny * corr * (b.invMass / wsum);
  // velocity: sequential impulses with friction
  for (const c of contacts) {
    const rax = c.px - a.x, ray = c.py - a.y, rbx = c.px - b.x, rby = c.py - b.y;
    const va = a.pointVel(rax, ray), vb = b.pointVel(rbx, rby);
    const rvx = va.x - vb.x, rvy = va.y - vb.y;
    const vn = rvx * c.nx + rvy * c.ny;
    if (vn >= 0) continue;
    const e = vn < -150 ? 0.2 : 0;
    const ran = rax * c.ny - ray * c.nx, rbn = rbx * c.ny - rby * c.nx;
    const j = (-(1 + e) * vn) / (wsum + ran * ran * a.invInertia + rbn * rbn * b.invInertia);
    a.applyImpulse(c.nx * j, c.ny * j, rax, ray);
    b.applyImpulse(-c.nx * j, -c.ny * j, rbx, rby);
    const tx = -c.ny, ty = c.nx;
    const va2 = a.pointVel(rax, ray), vb2 = b.pointVel(rbx, rby);
    const vt = (va2.x - vb2.x) * tx + (va2.y - vb2.y) * ty;
    const rat = rax * ty - ray * tx, rbt = rbx * ty - rby * tx;
    let jt = -vt / (wsum + rat * rat * a.invInertia + rbt * rbt * b.invInertia);
    jt = clamp(jt, -0.5 * j, 0.5 * j);
    a.applyImpulse(tx * jt, ty * jt, rax, ray);
    b.applyImpulse(-tx * jt, -ty * jt, rbx, rby);
  }
  settle(a, 0.998);
  settle(b, 0.998);
  a.updateWorld();
  b.updateWorld();
}
