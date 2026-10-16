import { DT, GROUND, W, RigidBody, collideBodies, collideBodyWorld } from './physics';
import { Stickman, Sample } from './stickman';
import { bodyFromStroke } from './draw';
import { Solid, collideParticle, collideBody, topAt, TRAMPOLINE_LAUNCH } from './terrain';
import { Vec, clamp, lerp, rand } from './math';

// Placeable arena items. Everything is a list: add, move or remove any of them.
export interface Spikes { id: number; x0: number; x1: number }
export interface Cannon { id: number; x: number; y: number; cd: number; period: number; flash: number }
export interface Cloud { id: number; x: number; y: number; cd: number }
export interface FloatText { x: number; y: number; text: string; t: number; color: string }

/** Things that happened this step, for effects (POW!, dust, shake). Drained by the renderer. */
export type WorldEvent =
  | { type: 'hit'; x: number; y: number; dmg: number; by: 'object' | 'punch' | 'kick' | 'swing' | 'spikes' }
  | { type: 'block'; x: number; y: number; weapon?: boolean }
  | { type: 'fire'; x: number; y: number; dir: number }
  | { type: 'ko'; x: number; y: number }
  | { type: 'erase'; body: RigidBody }
  | { type: 'boing'; x: number; y: number };

/** Impulse (mass * px/s) that starts to hurt, and impulse per point of damage. */
export const HURT_J0 = 700;
export const HURT_PER = 120;
export const SPIKE_W = 110;

let nextId = 1;
export const newId = () => nextId++;

export class World {
  men: Stickman[] = [];
  bodies: RigidBody[] = [];
  spikes: Spikes[] = [];
  cannons: Cannon[] = [];
  clouds: Cloud[] = [];
  solids: Solid[] = [];
  texts: FloatText[] = [];
  events: WorldEvent[] = [];
  time = 0;
  /** Body-id -> last time it hurt each stickman, to avoid multi-hits from one contact. */
  private hitCd = new Map<string, number>();

  step() {
    this.time += DT;
    for (const m of this.men) {
      m.time = this.time;
      m.ground = this.groundFn;
      m.step();
      this.collideManTerrain(m);
    }
    // fast bodies move in slices no longer than ~4 px, testing the stickmen each slice,
    // so a hard throw can't tunnel through a thin limb
    for (const b of this.bodies) {
      const n = Math.min(8, Math.max(1, Math.ceil((b.speed * DT) / 4)));
      for (let k = 0; k < n; k++) {
        b.integrate(DT / n);
        if (n > 1) for (const m of this.men) this.collideManBody(m, b);
      }
    }
    for (let it = 0; it < 2; it++)
      for (let i = 0; i < this.bodies.length; i++)
        for (let k = i + 1; k < this.bodies.length; k++) collideBodies(this.bodies[i], this.bodies[k]);
    for (const b of this.bodies) collideBodyWorld(b);
    for (const s of this.solids) for (const b of this.bodies) collideBody(s, b);
    for (const m of this.men) for (const b of this.bodies) this.collideManBody(m, b);
    for (let i = 0; i < this.men.length; i++)
      for (let k = i + 1; k < this.men.length; k++) this.collideMen(this.men[i], this.men[k]);
    for (const m of this.men) this.spikeCheck(m);
    this.cannonStep();
    this.cloudStep();
    const keep: RigidBody[] = [];
    for (const b of this.bodies) {
      if (b.age < b.life) keep.push(b);
      else this.events.push({ type: 'erase', body: b });
    }
    this.bodies = keep;
  }

  frame(dt: number) {
    for (const t of this.texts) { t.t += dt; t.y -= 30 * dt; }
    this.texts = this.texts.filter((t) => t.t < 1.1);
  }

  addText(p: Vec, text: string, color: string) {
    this.texts.push({ x: p.x, y: p.y, text, t: 0, color });
  }

  // ---------------------------------------------------------------- terrain

  /** Height of the first surface at or just below (x, y): terrain tops, else the floor. */
  surfaceAt(x: number, y: number): number {
    let best = GROUND;
    for (const s of this.solids) {
      const top = topAt(s, x);
      if (top !== null && top >= y - 40 && top < best) best = top;
    }
    return best;
  }
  private groundFn = (x: number, y: number) => this.surfaceAt(x, y);

  private collideManTerrain(m: Stickman) {
    if (!this.solids.length) return;
    let bounced = false;
    for (const s of this.solids) {
      for (let i = 0; i < m.ps.length; i++) {
        const p = m.ps[i];
        const foot = i === 8 || i === 10;
        const onTop = collideParticle(s, p, foot ? 0.85 : 0.35);
        if (onTop && s.kind === 'trampoline' && !bounced && p.vy > -300) {
          bounced = true;
          m.bounce(-TRAMPOLINE_LAUNCH);
          this.events.push({ type: 'boing', x: p.x, y: p.y });
        }
      }
    }
    // keep bone lengths after the push-outs
    for (const st of m.sticks) st.solve();
  }

  /** Is there a wall between x0 and x1 (at standing height)? */
  wallBetween(x0: number, x1: number): boolean {
    const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
    for (const s of this.solids) {
      if (s.kind !== 'wall') continue;
      if (s.x + 16 > lo && s.x - 16 < hi) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- stickman vs rigid body

  private collideManBody(m: Stickman, b: RigidBody) {
    const bb = m.bounds();
    if (b.x + b.boundR < bb.x0 - 8 || b.x - b.boundR > bb.x1 + 8 || b.y + b.boundR < bb.y0 - 8 || b.y - b.boundR > bb.y1 + 8) return;
    let bestJ = 0, bestS: Sample | null = null, bestP: Vec = { x: 0, y: 0 };
    for (const s of m.samples) {
      for (const c of b.circles) {
        const A = m.ps[s.a], B = m.ps[s.b], t = s.t;
        const px = lerp(A.x, B.x, t), py = lerp(A.y, B.y, t);
        let dx = px - c.wx, dy = py - c.wy;
        const rs = s.r + c.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rs * rs) continue;
        const d = Math.sqrt(d2) || 1e-4;
        dx /= d; dy /= d; // normal from body to stickman
        const pen = rs - d;
        const wa = (1 - t) * (1 - t) * A.invMass, wb = t * t * B.invMass;
        const wTrue = wa + wb;
        // A weapon tip on its own is nearly weightless (it's far out on a light forearm),
        // but it's held by a whole arm and body: give it that weight, swinging even more.
        const ws = s.part === 'weapon' ? (m.action.kind === 'swing' ? 0.03 : 0.1) : wTrue;
        const k = ws / wTrue; // scale the arm's share so the contact point moves the right amount
        // position: split by inverse mass, no velocity change
        const lam = pen / (ws + b.invMass);
        A.shift(dx * lam * k * (1 - t) * A.invMass, dy * lam * k * (1 - t) * A.invMass);
        B.shift(dx * lam * k * t * B.invMass, dy * lam * k * t * B.invMass);
        b.x -= dx * lam * b.invMass; b.y -= dy * lam * b.invMass;
        // velocity impulse
        const cx = c.wx + dx * c.r, cy = c.wy + dy * c.r;
        const rx = cx - b.x, ry = cy - b.y;
        const vb = b.pointVel(rx, ry);
        const vpx = lerp(A.vx, B.vx, t), vpy = lerp(A.vy, B.vy, t);
        const vn = (vpx - vb.x) * dx + (vpy - vb.y) * dy;
        if (vn >= 0) continue;
        const rn = rx * dy - ry * dx;
        const e = s.part === 'weapon' ? 0.6 : 0.2; // a bat sends things flying
        const j = (-(1 + e) * vn) / (ws + b.invMass + rn * rn * b.invInertia);
        A.addVel(dx * j * k * (1 - t) * A.invMass, dy * j * k * (1 - t) * A.invMass);
        B.addVel(dx * j * k * t * B.invMass, dy * j * k * t * B.invMass);
        b.applyImpulse(-dx * j, -dy * j, rx, ry);
        if (s.part !== 'weapon' && j > bestJ) { bestJ = j; bestS = s; bestP = { x: px, y: py }; }
      }
    }
    b.updateWorld();
    if (bestS && bestJ > HURT_J0) {
      const key = `${b.id}:${m.name}`;
      const last = this.hitCd.get(key) ?? -1;
      if (this.time - last < 0.35) return;
      this.hitCd.set(key, this.time);
      let dmg = clamp(((bestJ - HURT_J0) / HURT_PER) * b.sharpness, 0, 45);
      // fending with a weapon: blows to the arm holding it are taken by the weapon
      const fending = m.weapon && (m.action.kind === 'swing' || m.action.kind === 'block');
      if (fending && bestS.part === 'arm') dmg *= 0.1;
      const stun = bestJ > 5500 ? clamp(bestJ / 5000, 0.6, 2) : 0;
      const before = m.health;
      m.hurt(dmg, `body:${b.id}`, bestS.part, stun);
      const lost = before - m.health;
      if (lost >= 1) {
        this.addText({ x: bestP.x, y: bestP.y - 20 }, `-${Math.round(lost)}`, '#d64545');
        this.events.push({ type: 'hit', x: bestP.x, y: bestP.y, dmg: lost, by: 'object' });
        if (!m.alive) this.events.push({ type: 'ko', x: m.head.x, y: m.head.y });
      }
    }
  }

  // ---------------------------------------------------------------- stickman vs stickman

  private collideMen(m: Stickman, o: Stickman) {
    const a = m.bounds(), b = o.bounds();
    if (a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0) return;
    for (const s1 of m.samples) {
      for (const s2 of o.samples) {
        const A1 = m.ps[s1.a], B1 = m.ps[s1.b], A2 = o.ps[s2.a], B2 = o.ps[s2.b];
        const t1 = s1.t, t2 = s2.t;
        const p1x = lerp(A1.x, B1.x, t1), p1y = lerp(A1.y, B1.y, t1);
        const p2x = lerp(A2.x, B2.x, t2), p2y = lerp(A2.y, B2.y, t2);
        let dx = p1x - p2x, dy = p1y - p2y;
        const rs = s1.r + s2.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rs * rs) continue;
        const d = Math.sqrt(d2) || 1e-4;
        dx /= d; dy /= d; // from o to m
        const w1a = (1 - t1) ** 2 * A1.invMass, w1b = t1 * t1 * B1.invMass;
        const w2a = (1 - t2) ** 2 * A2.invMass, w2b = t2 * t2 * B2.invMass;
        const ws = w1a + w1b + w2a + w2b;
        const lam = ((rs - d) / ws) * 0.8;
        A1.shift(dx * lam * (1 - t1) * A1.invMass, dy * lam * (1 - t1) * A1.invMass);
        B1.shift(dx * lam * t1 * B1.invMass, dy * lam * t1 * B1.invMass);
        A2.shift(-dx * lam * (1 - t2) * A2.invMass, -dy * lam * (1 - t2) * A2.invMass);
        B2.shift(-dx * lam * t2 * B2.invMass, -dy * lam * t2 * B2.invMass);
        const vn = (lerp(A1.vx, B1.vx, t1) - lerp(A2.vx, B2.vx, t2)) * dx + (lerp(A1.vy, B1.vy, t1) - lerp(A2.vy, B2.vy, t2)) * dy;
        if (vn >= 0) continue;
        const j = (-1.1 * vn) / ws;
        A1.addVel(dx * j * (1 - t1) * A1.invMass, dy * j * (1 - t1) * A1.invMass);
        B1.addVel(dx * j * t1 * B1.invMass, dy * j * t1 * B1.invMass);
        A2.addVel(-dx * j * (1 - t2) * A2.invMass, -dy * j * (1 - t2) * A2.invMass);
        B2.addVel(-dx * j * t2 * B2.invMass, -dy * j * t2 * B2.invMass);
        if (s1.tip && m.tipActive(s1.tip)) this.strike(m, o, s2, j, { x: p2x, y: p2y }, dx);
        else if (s2.tip && o.tipActive(s2.tip)) this.strike(o, m, s1, j, { x: p1x, y: p1y }, -dx);
      }
    }
  }

  private strike(att: Stickman, vic: Stickman, s: Sample, j: number, at: Vec, nx: number) {
    att.action.hit = true;
    const kind = att.action.kind;
    if (s.part === 'weapon') {
      // parried: the strike lands on the weapon, the attacker bounces off
      for (const p of att.ps) p.addVel(nx * 220, -60);
      for (const p of vic.ps) p.addVel(-nx * 60, 0);
      vic.parries++;
      this.addText({ x: at.x, y: at.y - 18 }, 'parry!', '#5b7fb5');
      this.events.push({ type: 'block', x: at.x, y: at.y, weapon: true });
      return;
    }
    const swing = kind === 'swing';
    const cap = kind === 'kick' ? 20 : swing ? 16 + Math.min(14, att.weapon ? att.weapon.mass * 2 : 0) : 14;
    const dmg = clamp((j - 150) / 70, 3, cap);
    const before = vic.health;
    const blocked = vic.blocking && s.part === 'arm';
    vic.hurt(dmg, `man:${att.name}:${kind}`, s.part, dmg > 13 && !vic.blocking ? 0.5 : 0);
    const lost = before - vic.health;
    att.dealt += lost;
    // knockback toward the victim's side
    const push = (kind === 'kick' ? 260 : swing ? 300 : 160) * (vic.blocking ? 0.4 : 1);
    for (const p of vic.ps) p.addVel(-nx * push, -40);
    if (blocked) {
      this.addText({ x: at.x, y: at.y - 18 }, 'block', '#5b7fb5');
      this.events.push({ type: 'block', x: at.x, y: at.y });
    } else {
      this.addText({ x: at.x, y: at.y - 18 }, `-${Math.round(lost)}`, '#c97a1d');
      this.events.push({ type: 'hit', x: at.x, y: at.y, dmg: lost, by: kind === 'kick' ? 'kick' : swing ? 'swing' : 'punch' });
    }
    if (!vic.alive) this.events.push({ type: 'ko', x: vic.head.x, y: vic.head.y });
  }

  // ---------------------------------------------------------------- traps

  private spikeCheck(m: Stickman) {
    if (m.spikeCd > 0) return;
    for (const z of this.spikes) {
      for (const p of m.ps) {
        if (p.x > z.x0 && p.x < z.x1 && p.y + p.radius > GROUND - 22) {
          m.spikeCd = 0.6;
          const before = m.health;
          m.hurt(14, 'spikes', 'leg', 0.4);
          for (const q of m.ps) q.addVel(0, -620);
          this.addText({ x: p.x, y: p.y - 30 }, `-${Math.round(before - m.health)}`, '#d64545');
          this.events.push({ type: 'hit', x: p.x, y: p.y, dmg: before - m.health, by: 'spikes' });
          return;
        }
      }
    }
  }

  inSpikes(x: number, margin = 0): Spikes | null {
    for (const z of this.spikes) if (x > z.x0 - margin && x < z.x1 + margin) return z;
    return null;
  }

  /** Cannons aim at the first stickman (the hero) from wherever they were placed. */
  private cannonStep() {
    const hero = this.men[0];
    for (const c of this.cannons) {
      c.flash = Math.max(0, c.flash - DT);
      c.cd -= DT;
      if (c.cd > 0 || !hero || !hero.alive) continue;
      c.cd = c.period * rand(0.7, 1.3);
      // aim with a ballistic solution at a random body height (sometimes a lob)
      const tgt = hero.ps[[0, 1, 2, 7, 9][Math.floor(Math.random() * 5)]];
      const dist = Math.abs(tgt.x - c.x);
      if (dist < 60) continue;
      const T = clamp(dist / 1300, 0.3, 0.9) * rand(0.85, 1.25);
      const dir = Math.sign(tgt.x - c.x) || 1;
      const mx = c.x + dir * 30;
      const vx = (tgt.x - mx) / T;
      const vy = (tgt.y - c.y - 0.5 * 1800 * T * T) / T;
      this.spawnBall(mx, c.y, vx, vy, rand(9, 15));
      c.flash = 0.15;
      this.events.push({ type: 'fire', x: mx, y: c.y, dir });
    }
  }

  /** Rain clouds drop balls and rocks right below themselves. */
  private cloudStep() {
    for (const c of this.clouds) {
      c.cd -= DT;
      if (c.cd > 0) continue;
      c.cd = rand(0.7, 1.5);
      const x = clamp(c.x + rand(-50, 50), 30, W - 30);
      const y = c.y + 34;
      if (Math.random() < 0.5) this.spawnBall(x, y, rand(-60, 60), rand(0, 120), rand(9, 22));
      else {
        const n = 7, r = rand(12, 26), pts: Vec[] = [];
        for (let i = 0; i <= n; i++) {
          const a = (i / n) * Math.PI * 2, rr = r * rand(0.7, 1.15);
          pts.push({ x: x + Math.cos(a) * rr, y: y + r + Math.sin(a) * rr });
        }
        pts[n] = pts[0];
        const b = bodyFromStroke(pts, '#8a8579');
        if (b) { b.kind = 'rock'; b.vy = rand(0, 120); b.w = rand(-3, 3); b.life = 8; this.bodies.push(b); }
      }
    }
  }

  spawnBall(x: number, y: number, vx: number, vy: number, r: number) {
    const b = new RigidBody(x, y, [{ x, y, r }], [], true, 'ball', '#444');
    b.vx = vx; b.vy = vy;
    b.life = 6;
    this.bodies.push(b);
    return b;
  }
}
