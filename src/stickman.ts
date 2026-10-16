import { Particle, Stick, DT, GROUND, GRAVITY } from './physics';
import { Vec, wrap, clamp, lerp, DEG } from './math';

// ---------------------------------------------------------------------------
// Skeleton
//
//            HEAD (o)
//             |  neck
//   EL0 --- NECK --- EL1          limb 0 = far side (drawn behind)
//   |         |          |        limb 1 = near side (drawn in front)
//  HA0        | spine    HA1
//           PELVIS
//           /    \
//        KN0      KN1
//         |        |
//        FT0      FT1
// ---------------------------------------------------------------------------

export const HEAD = 0, NECK = 1, PELVIS = 2, EL0 = 3, HA0 = 4, EL1 = 5, HA1 = 6, KN0 = 7, FT0 = 8, KN1 = 9, FT1 = 10;
const COUNT = 11;

export const DIM = { neck: 16, spine: 48, upper: 26, fore: 25, thigh: 31, shin: 31, headR: 11 };
const MASS = [5, 9, 12, 2, 1.5, 2, 1.5, 4, 3, 4, 3];
const RADIUS = [DIM.headR, 4, 5, 3.5, 4, 3.5, 4, 4, 4.5, 4, 4.5];
const UPPER_BODY = [NECK, HEAD, EL0, HA0, EL1, HA1];
const SUPPORTED = [PELVIS, ...UPPER_BODY];
const LEG = [[KN0, FT0], [KN1, FT1]];

/** Standing pelvis height above ground (legs are 62 long; keep knees soft). */
const STAND_H = 56;
const WALK_SPEED = 170;
const RUN_SPEED = 330;

/**
 * Joint angle convention, for a stickman FACING RIGHT on a y-down screen:
 *   rel = angle(child bone) - angle(parent bone) + offset, wrapped to (-pi, pi].
 *   hip:      0 = leg straight down along spine; negative = thigh swung forward.
 *   knee:     0 = straight; positive = normal bend (foot goes back).
 *   shoulder: 0 = arm hanging; negative = arm raised forward.
 *   elbow:    0 = straight; negative = normal bend (hand comes forward/up).
 *   neck:     0 = head in line with spine.
 * Facing left mirrors everything: targets and limits are negated.
 */
interface JointDef { name: string; a: number; p: number; c: number; offset: number; min: number; max: number; kp: number; child: number[] }

const JOINTS: JointDef[] = [
  { name: 'hip0', a: NECK, p: PELVIS, c: KN0, offset: 0, min: -130, max: 50, kp: 1.0, child: [KN0, FT0] },
  { name: 'hip1', a: NECK, p: PELVIS, c: KN1, offset: 0, min: -130, max: 50, kp: 1.0, child: [KN1, FT1] },
  { name: 'knee0', a: PELVIS, p: KN0, c: FT0, offset: 0, min: 0, max: 155, kp: 1.0, child: [FT0] },
  { name: 'knee1', a: PELVIS, p: KN1, c: FT1, offset: 0, min: 0, max: 155, kp: 1.0, child: [FT1] },
  { name: 'sh0', a: PELVIS, p: NECK, c: EL0, offset: Math.PI, min: -999, max: 999, kp: 0.6, child: [EL0, HA0] },
  { name: 'sh1', a: PELVIS, p: NECK, c: EL1, offset: Math.PI, min: -999, max: 999, kp: 0.6, child: [EL1, HA1] },
  { name: 'el0', a: NECK, p: EL0, c: HA0, offset: 0, min: -155, max: 5, kp: 0.6, child: [HA0] },
  { name: 'el1', a: NECK, p: EL1, c: HA1, offset: 0, min: -155, max: 5, kp: 0.6, child: [HA1] },
  { name: 'neck', a: PELVIS, p: NECK, c: HEAD, offset: 0, min: -40, max: 40, kp: 0.7, child: [HEAD] },
];
const J = { hip0: 0, hip1: 1, knee0: 2, knee1: 3, sh0: 4, sh1: 5, el0: 6, el1: 7, neck: 8 };

interface Joint extends JointDef { parent: number[]; mc: number; mp: number; target: number; gain: number }

export type Part = 'head' | 'torso' | 'arm' | 'leg' | 'weapon';
export type Tip = 'hand0' | 'hand1' | 'foot0' | 'foot1' | 'weapon';

/**
 * A drawn melee weapon held in the near hand. pts are in the hand's frame: x runs
 * along the forearm past the hand, y is sideways. Physics treats it as a straight
 * extension of the forearm (collision samples beyond the hand); the drawing is cosmetic.
 */
export interface Weapon { strokes: Vec[][]; length: number; mass: number }

/** Collision points every ~11 units along the weapon, so nothing slips between them. */
function weaponSamples(length: number): Sample[] {
  const n = Math.max(3, Math.ceil(length / 11));
  return Array.from({ length: n }, (_, i): Sample => ({ a: EL1, b: HA1, t: 1 + (length * (i + 1)) / n / DIM.fore, r: 6, part: 'weapon', tip: 'weapon' }));
}
/** Collision sample on a bone: point lerp(a, b, t) with radius r. */
export interface Sample { a: number; b: number; t: number; r: number; part: Part; tip?: Tip }

export const SAMPLES: Sample[] = [
  { a: NECK, b: HEAD, t: 1, r: DIM.headR, part: 'head' },
  { a: NECK, b: PELVIS, t: 0, r: 5, part: 'torso' },
  { a: NECK, b: PELVIS, t: 0.33, r: 6, part: 'torso' },
  { a: NECK, b: PELVIS, t: 0.66, r: 6, part: 'torso' },
  { a: NECK, b: PELVIS, t: 1, r: 6, part: 'torso' },
  { a: NECK, b: EL0, t: 0.6, r: 4, part: 'arm' },
  { a: EL0, b: HA0, t: 0.5, r: 4, part: 'arm' },
  { a: EL0, b: HA0, t: 1, r: 4.5, part: 'arm', tip: 'hand0' },
  { a: NECK, b: EL1, t: 0.6, r: 4, part: 'arm' },
  { a: EL1, b: HA1, t: 0.5, r: 4, part: 'arm' },
  { a: EL1, b: HA1, t: 1, r: 4.5, part: 'arm', tip: 'hand1' },
  { a: PELVIS, b: KN0, t: 0.5, r: 5, part: 'leg' },
  { a: KN0, b: FT0, t: 0.5, r: 4.5, part: 'leg' },
  { a: KN0, b: FT0, t: 1, r: 5, part: 'leg', tip: 'foot0' },
  { a: PELVIS, b: KN1, t: 0.5, r: 5, part: 'leg' },
  { a: KN1, b: FT1, t: 0.5, r: 4.5, part: 'leg' },
  { a: KN1, b: FT1, t: 1, r: 5, part: 'leg', tip: 'foot1' },
];

export type Mode = 'stand' | 'air' | 'down' | 'rise';
export type ActionKind = 'none' | 'punch' | 'kick' | 'duck' | 'block' | 'jump' | 'dodge' | 'swing';

export interface Action { kind: ActionKind; t: number; dur: number; limb: number; target: Vec; dir: number; hit: boolean }

/** High-level commands written by the brain every frame. */
export interface Control { moveX: number; run: boolean; face: number; crouch: number }

interface Gait { plantX: number; swing: boolean; s: number; x0: number; x1: number; dur: number; lift: number }

export interface HurtEvent { time: number; amount: number; source: string; part: Part }

export class Stickman {
  ps: Particle[] = [];
  sticks: Stick[] = [];
  joints: Joint[];
  facing = 1;
  mode: Mode = 'stand';
  modeT = 0;
  downFor = 0;
  /** 0..1: how much the cheat forces (upright torque, pelvis support, drive) apply. */
  balance = 1;
  /** 0..1: muscle tone. */
  tone = 1;
  ctrl: Control = { moveX: 0, run: false, face: 1, crouch: 0 };
  action: Action = { kind: 'none', t: 0, dur: 0, limb: 1, target: { x: 0, y: 0 }, dir: 0, hit: false };
  gait: Gait[];
  vxSmooth = 0;
  lean = 0;
  hipH = STAND_H;
  tiltErrT = 0;
  airT = 0;
  /** World clock, set by World before each step. */
  time = 0;
  health = 100;
  maxHealth = 100;
  koT = 0;
  spikeCd = 0;
  punchArm = 1;
  hurtLog: HurtEvent[] = [];
  dealt = 0;
  flash = 0;
  private moved = { x: 0, y: 0 };
  private holdX: number | null = null;
  weapon: Weapon | null = null;
  /** Height of the surface under (x, y): the floor, or terrain. Set by the world. */
  ground: (x: number, y: number) => number = () => GROUND;
  /** strikes stopped by this stickman's weapon (read by the brain to score parries) */
  parries = 0;
  /** Collision samples: the body's, plus the weapon's when armed. */
  samples: Sample[] = SAMPLES;
  /** IK targets for debug drawing. */
  debugTargets: Vec[] = [];

  constructor(x: number, public team: number, public color: string, public name: string) {
    this.build(x);
    this.joints = JOINTS.map((d) => {
      const child = d.child;
      const parent: number[] = [];
      for (let i = 0; i < COUNT; i++) if (i !== d.p && !child.includes(i)) parent.push(i);
      const mc = child.reduce((s, i) => s + MASS[i], 0);
      const mp = parent.reduce((s, i) => s + MASS[i], 0);
      return { ...d, parent, mc, mp, target: 0, gain: 1 };
    });
    this.gait = [0, 1].map((i) => ({ plantX: this.ps[i ? FT1 : FT0].x, swing: false, s: 0, x0: 0, x1: 0, dur: 0.2, lift: 10 }));
  }

  private build(x: number) {
    const g = GROUND;
    const pelvisY = g - STAND_H;
    const pos: Vec[] = [];
    pos[PELVIS] = { x, y: pelvisY };
    pos[NECK] = { x, y: pelvisY - DIM.spine };
    pos[HEAD] = { x, y: pos[NECK].y - DIM.neck };
    pos[EL0] = { x: x - 4, y: pos[NECK].y + DIM.upper };
    pos[HA0] = { x: x + 8, y: pos[EL0].y + DIM.fore - 4 };
    pos[EL1] = { x: x + 4, y: pos[NECK].y + DIM.upper };
    pos[HA1] = { x: x + 14, y: pos[EL1].y + DIM.fore - 6 };
    pos[KN0] = { x: x - 6, y: pelvisY + DIM.thigh - 1 };
    pos[FT0] = { x: x - 10, y: g - RADIUS[FT0] };
    pos[KN1] = { x: x + 8, y: pelvisY + DIM.thigh - 1 };
    pos[FT1] = { x: x + 10, y: g - RADIUS[FT1] };
    this.ps = pos.map((p, i) => new Particle(p.x, p.y, MASS[i], RADIUS[i]));
    const link = (a: number, b: number, len: number) => this.sticks.push(new Stick(this.ps[a], this.ps[b], len));
    link(NECK, HEAD, DIM.neck);
    link(NECK, PELVIS, DIM.spine);
    link(NECK, EL0, DIM.upper); link(EL0, HA0, DIM.fore);
    link(NECK, EL1, DIM.upper); link(EL1, HA1, DIM.fore);
    link(PELVIS, KN0, DIM.thigh); link(KN0, FT0, DIM.shin);
    link(PELVIS, KN1, DIM.thigh); link(KN1, FT1, DIM.shin);
  }

  /** Arm (or disarm with null). The weapon's weight goes into the hand, so heavy ones swing slower. */
  equip(w: Weapon | null) {
    this.weapon = w;
    const hand = this.ps[HA1];
    hand.mass = MASS[HA1] + (w ? w.mass : 0);
    hand.invMass = 1 / hand.mass;
    this.samples = w
      ? [...SAMPLES, ...weaponSamples(w.length)]
      : SAMPLES;
  }

  /** Independent copy of the full simulation state (for imagining outcomes). */
  clone(): Stickman {
    const c = new Stickman(this.pelvis.x, this.team, this.color, this.name);
    c.equip(this.weapon);
    c.ps.forEach((p, i) => {
      const q = this.ps[i];
      p.x = q.x; p.y = q.y; p.px = q.px; p.py = q.py; p.grounded = q.grounded;
    });
    c.facing = this.facing; c.mode = this.mode; c.modeT = this.modeT; c.downFor = this.downFor;
    c.balance = this.balance; c.tone = this.tone;
    c.ctrl = { ...this.ctrl };
    c.action = { ...this.action, target: { ...this.action.target } };
    c.gait = this.gait.map((g) => ({ ...g }));
    c.vxSmooth = this.vxSmooth; c.lean = this.lean; c.hipH = this.hipH; c.tiltErrT = this.tiltErrT; c.airT = this.airT;
    c.time = this.time; c.health = this.health; c.koT = this.koT; c.spikeCd = this.spikeCd; c.punchArm = this.punchArm;
    c.holdX = this.holdX;
    return c;
  }

  // ------------------------------------------------------------------ queries

  get pelvis() { return this.ps[PELVIS]; }
  get head() { return this.ps[HEAD]; }
  get alive() { return this.koT <= 0; }
  get chest(): Vec {
    const n = this.ps[NECK], p = this.ps[PELVIS];
    return { x: (n.x + p.x) / 2, y: (n.y + p.y) / 2 };
  }
  get footDown() {
    const a = this.ps[FT0], b = this.ps[FT1];
    return a.y >= this.ground(a.x, a.y) - a.radius - 2 || b.y >= this.ground(b.x, b.y) - b.radius - 2;
  }
  get busy() { return this.action.kind !== 'none'; }
  get blocking() { return this.action.kind === 'block'; }
  sampleWorld(s: Sample): Vec {
    const a = this.ps[s.a], b = this.ps[s.b];
    return { x: lerp(a.x, b.x, s.t), y: lerp(a.y, b.y, s.t) };
  }
  /** Bounding box of the body for broadphase. */
  bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of this.ps) {
      x0 = Math.min(x0, p.x - p.radius); x1 = Math.max(x1, p.x + p.radius);
      y0 = Math.min(y0, p.y - p.radius); y1 = Math.max(y1, p.y + p.radius);
    }
    return { x0, y0, x1, y1 };
  }
  /** Whether an attack tip is currently a live hitbox. */
  tipActive(tip: Tip): boolean {
    const a = this.action;
    if (a.hit) return false;
    if (a.kind === 'punch') return tip === (a.limb ? 'hand1' : 'hand0') && a.t > 0.07 && a.t < 0.2;
    if (a.kind === 'kick') return tip === (a.limb ? 'foot1' : 'foot0') && a.t > 0.12 && a.t < 0.28;
    if (a.kind === 'swing') return (tip === 'weapon' || tip === 'hand1') && a.t > (a.dir === 1 ? 0.05 : 0.12) && a.t < (a.dir === 1 ? 0.38 : 0.32);
    return false;
  }

  // ------------------------------------------------------------------ actions

  canAct() { return this.mode === 'stand' && this.alive; }

  start(kind: ActionKind, opts: { target?: Vec; dir?: number; dur?: number } = {}): boolean {
    if (!this.canAct()) return false;
    if (this.busy && kind !== 'jump' && kind !== 'dodge') return false;
    const durs: Record<ActionKind, number> = { none: 0, punch: 0.34, kick: 0.46, duck: 0.5, block: 0.45, jump: 0.35, dodge: 0.4, swing: 0.48 };
    const a = this.action;
    a.kind = kind; a.t = 0; a.dur = opts.dur ?? durs[kind]; a.hit = false;
    a.target = opts.target ?? { x: this.pelvis.x + 60 * this.facing, y: this.ps[NECK].y };
    a.dir = opts.dir ?? -this.facing;
    if (kind === 'punch') { a.limb = this.weapon ? 0 : this.punchArm; this.punchArm ^= 1; }
    if (kind === 'swing') { a.limb = 1; a.dir = opts.dir ?? 0; }
    if (kind === 'kick') a.limb = 1;
    if (kind === 'jump') this.launch(this.ctrl.moveX * 220, -760);
    if (kind === 'dodge') this.launch(a.dir * 470, -330);
    return true;
  }

  private launch(vx: number, vy: number) {
    for (const p of this.ps) p.addVel(vx, vy);
    this.setMode('air');
  }

  hurt(amount: number, source: string, part: Part, stunImpulse = 0) {
    if (!this.alive) return;
    const mul = part === 'head' ? 1.5 : part === 'torso' ? 1 : part === 'arm' ? (this.blocking ? 0.2 : 0.6) : 0.75;
    const dmg = amount * mul;
    if (dmg < 0.5) return;
    this.health -= dmg;
    this.flash = 0.15;
    this.hurtLog.push({ time: this.time, amount: dmg, source, part });
    if (this.health <= 0) { this.health = 0; this.koT = 3; this.knockDown(3); return; }
    if (stunImpulse > 0) this.knockDown(stunImpulse);
  }

  knockDown(seconds: number) {
    this.setMode('down');
    this.downFor = Math.max(this.downFor, seconds);
    this.action.kind = 'none';
  }

  /** Launched straight up (trampoline). */
  bounce(vy: number) {
    for (const p of this.ps) p.setVel(p.vx * 0.8, vy);
    if (this.mode === 'stand' || this.mode === 'rise') this.setMode('air');
  }

  /** Pick up and put down somewhere else (keeps health). */
  teleport(x: number, y = this.pelvis.y) {
    const dx = x - this.pelvis.x, dy = y - this.pelvis.y;
    for (const p of this.ps) { p.shift(dx, dy); p.px = p.x; p.py = p.y; }
    this.holdX = null;
    this.replant();
  }

  respawn(x: number) {
    const dx = x - this.pelvis.x;
    for (const p of this.ps) p.shift(dx, 0);
    this.replant();
    this.health = this.maxHealth;
    this.koT = 0;
  }

  private setMode(m: Mode) {
    if (this.mode === m) return;
    this.holdX = null;
    this.mode = m;
    this.modeT = 0;
    if (m === 'stand') this.replant();
  }

  private replant() {
    for (let i = 0; i < 2; i++) {
      const g = this.gait[i];
      g.plantX = this.ps[LEG[i][1]].x;
      g.swing = false;
    }
  }

  // ------------------------------------------------------------------ simulation

  step() {
    const ps = this.ps;
    this.modeT += DT;
    this.flash = Math.max(0, this.flash - DT);
    this.spikeCd = Math.max(0, this.spikeCd - DT);
    if (this.koT > 0) this.koT -= DT;

    for (const p of ps) p.integrate(0.9985);
    this.updateMode();
    this.updateAction();
    this.computeTargets();
    for (const j of this.joints) this.muscle(j);
    this.applyBalance();

    for (let it = 0; it < 8; it++) for (const s of this.sticks) s.solve();
    const planted = this.mode === 'stand';
    for (let i = 0; i < COUNT; i++) {
      const isFoot = i === FT0 || i === FT1;
      const swing = (i === FT0 && this.gait[0].swing) || (i === FT1 && this.gait[1].swing);
      ps[i].collideWorld(isFoot && planted && !swing ? 0.9 : isFoot ? 0.5 : 0.35);
    }
    for (const j of this.joints) this.limit(j);
    for (let it = 0; it < 3; it++) for (const s of this.sticks) s.solve();
  }

  private updateMode() {
    const down = this.footDown;
    if (this.mode === 'down') {
      this.balance = 0;
      this.tone = 0.06;
      this.downFor -= DT;
      if (this.downFor <= 0 && this.koT <= 0) this.setMode('rise');
      return;
    }
    if (this.mode === 'rise') {
      const k = clamp(this.modeT / 0.9, 0, 1);
      this.balance = k * k;
      this.tone = 0.2 + 0.8 * k;
      if (k >= 1) this.setMode(down ? 'stand' : 'air');
      return;
    }
    // tilt watchdog: too far off upright for too long -> fall over
    const spine = Math.atan2(this.ps[NECK].y - this.ps[PELVIS].y, this.ps[NECK].x - this.ps[PELVIS].x);
    const tilt = Math.abs(wrap(spine + Math.PI / 2));
    this.tiltErrT = tilt > 70 * DEG ? this.tiltErrT + DT : 0;
    if (this.tiltErrT > 0.25) { this.knockDown(0.9); return; }

    if (this.mode === 'air') {
      this.balance = 0.45;
      this.tone = 0.9;
      this.airT += DT;
      if (down && this.modeT > 0.06 && this.pelvis.vy > -50) {
        if (tilt > 60 * DEG) this.knockDown(0.6);
        else this.setMode('stand');
      }
      return;
    }
    // stand
    this.balance = 1;
    this.tone = 1;
    this.airT = down ? 0 : this.airT + DT;
    if (this.airT > 0.12) this.setMode('air');
    if (!this.busy && this.ctrl.face !== 0) this.facing = this.ctrl.face > 0 ? 1 : -1;
  }

  private updateAction() {
    const a = this.action;
    if (a.kind === 'none') return;
    a.t += DT;
    if (a.t >= a.dur || this.mode === 'down') a.kind = 'none';
  }

  // ---------------------------------------------------------------- targets / IK

  private computeTargets() {
    const ps = this.ps, f = this.facing;
    const a = this.action;
    this.debugTargets.length = 0;
    for (const j of this.joints) j.gain = 1;

    this.vxSmooth = lerp(this.vxSmooth, this.pelvis.vx, 0.08);
    let crouch = this.ctrl.crouch;
    let lean = clamp(this.vxSmooth / RUN_SPEED, -1, 1) * f * 10;

    if (a.kind === 'duck') { crouch = 0.9; lean = 48; }
    if (a.kind === 'block') { crouch = Math.max(crouch, 0.25); lean = 6; }
    if (a.kind === 'punch') lean = a.t < 0.08 ? -4 : 16;
    if (a.kind === 'kick') lean = a.t < 0.12 ? -6 : -22;
    if (a.kind === 'dodge') lean = -25 * a.dir * f;
    if (a.kind === 'swing') lean = a.t < 0.12 ? -10 : 20;
    lean += crouch * 18;
    this.lean = lerp(this.lean, lean, 0.15);
    this.hipH = lerp(this.hipH, STAND_H - 24 * crouch, 0.2);

    const neck = ps[NECK];
    // ---- legs
    if (this.mode === 'stand' || this.mode === 'rise') {
      this.updateGait(crouch);
      for (let i = 0; i < 2; i++) {
        const g = this.gait[i];
        let tx: number, ty: number;
        if (a.kind === 'kick' && i === a.limb && this.mode === 'stand') {
          const p = this.pelvis;
          if (a.t < 0.12) { tx = p.x + 10 * f; ty = p.y + 26; }
          else if (a.t < 0.3) { tx = a.target.x; ty = a.target.y; }
          else { tx = g.plantX; ty = p.y + 45; }
          this.joints[J.hip0 + i].gain = 1.8;
          this.joints[J.knee0 + i].gain = 1.8;
        } else if (g.swing) {
          const s = g.s;
          const e = s * s * (3 - 2 * s);
          tx = lerp(g.x0, g.x1, e);
          ty = this.ground(tx, this.pelvis.y + 30) - RADIUS[FT0] - Math.sin(Math.PI * s) * g.lift;
        } else {
          tx = g.plantX;
          ty = this.ground(tx, this.pelvis.y + 30) - RADIUS[FT0];
        }
        this.legIK(i, tx, ty);
      }
    } else if (this.mode === 'air') {
      // tuck: near leg forward, far leg trailing
      this.setPose(J.hip0, -25); this.setPose(J.knee0, 60);
      this.setPose(J.hip1, -55); this.setPose(J.knee1, 85);
    } else {
      for (const j of this.joints) j.target = this.currentRel(j);
    }

    // ---- arms (targets relative to the neck, in facing space)
    if (this.mode === 'down') return;
    let h0: Vec, h1: Vec;
    const walkSwing = Math.sin(this.time * 9) * clamp(Math.abs(this.vxSmooth) / RUN_SPEED, 0, 1);
    if (this.mode === 'air') {
      h0 = { x: -14, y: -6 }; h1 = { x: 20, y: -12 };
    } else if (a.kind === 'block' && this.weapon) {
      // guard with the weapon: held up in front like a shield
      h0 = { x: 14, y: -10 }; h1 = { x: 18, y: 14 };
      this.armGain(2.2);
    } else if (a.kind === 'block') {
      h0 = { x: 16, y: -14 }; h1 = { x: 24, y: 2 };
      this.armGain(2.2);
    } else if (a.kind === 'duck') {
      h0 = { x: 14, y: -16 }; h1 = { x: 20, y: -8 };
    } else if (a.kind === 'dodge') {
      h0 = { x: 18, y: -12 }; h1 = { x: 24, y: 4 };
    } else {
      // guard: fists up, near fist leading
      // guard: fists by the chin, elbows tucked; arms swing when moving
      h0 = { x: 9 - walkSwing * 12, y: 6 + Math.abs(walkSwing) * 6 };
      h1 = { x: 16 + walkSwing * 12, y: -3 + Math.abs(walkSwing) * 6 };
    }
    const hand = [h0, h1].map((h) => ({ x: neck.x + h.x * f, y: neck.y + h.y }));
    if (a.kind === 'punch') {
      const i = a.limb;
      if (a.t < 0.07) hand[i] = { x: neck.x - 6 * f, y: neck.y + 14 };
      else if (a.t < 0.22) {
        // overreach the target so the arm snaps fully straight
        const dx = a.target.x - neck.x, dy = a.target.y - neck.y;
        const d = Math.hypot(dx, dy) || 1;
        hand[i] = { x: neck.x + (dx / d) * 70, y: neck.y + (dy / d) * 70 };
        this.joints[J.sh0 + i].gain = 3.2;
        this.joints[J.el0 + i].gain = 3.2;
      }
    }
    if (a.kind === 'swing' && a.dir === 1) {
      // fend off: bring the weapon up across the incoming thing's path, then thrust it out
      const ty = clamp(a.target.y - neck.y, -45, 55);
      if (a.t < 0.1) hand[1] = { x: neck.x + 14 * f, y: neck.y + ty + 18 };
      else if (a.t < 0.36) {
        hand[1] = { x: neck.x + 34 * f, y: neck.y + ty + 6 };
        this.joints[J.sh1].gain = 4;
        this.joints[J.el1].gain = 4;
      }
    } else if (a.kind === 'swing') {
      // overhead windup, then a hard chop down and forward through the target
      if (a.t < 0.12) hand[1] = { x: neck.x - 4 * f, y: neck.y - 40 };
      else if (a.t < 0.32) {
        const dx = a.target.x - neck.x, dy = a.target.y - neck.y;
        const d = Math.hypot(dx, dy) || 1;
        hand[1] = { x: neck.x + (dx / d) * 60, y: neck.y + (dy / d) * 60 + 10 };
        this.joints[J.sh1].gain = 3.5;
        this.joints[J.el1].gain = 3.5;
      }
    }
    for (let i = 0; i < 2; i++) this.armIK(i, hand[i].x, hand[i].y);
    // keep the head level-ish while leaning
    this.joints[J.neck].target = -this.lean * DEG * 0.6 * f;
  }

  private armGain(g: number) {
    for (const k of [J.sh0, J.sh1, J.el0, J.el1]) this.joints[k].gain = g;
  }

  private updateGait(crouch: number) {
    const f = this.facing;
    const p = this.pelvis;
    const kicking = this.action.kind === 'kick';
    const speed = Math.abs(this.vxSmooth);
    // stance: near foot forward, far foot back; wider when crouched
    const half = 11 + crouch * 6;
    const center = p.x + this.vxSmooth * 0.11;
    let swinging = false;
    for (let i = 0; i < 2; i++) {
      const g = this.gait[i];
      if (!g.swing) {
        const foot = this.ps[LEG[i][1]];
        if (Math.abs(foot.x - g.plantX) > 28) g.plantX = foot.x; // got shoved: accept where the foot is
        continue;
      }
      swinging = true;
      g.s += DT / g.dur;
      if (g.s >= 1) { g.swing = false; g.plantX = g.x1; }
    }
    if (swinging || kicking || this.mode !== 'stand') return;
    let best = -1, bestErr = 0;
    for (let i = 0; i < 2; i++) {
      const want = center + (i ? half : -half) * f;
      const err = Math.abs(want - this.gait[i].plantX);
      if (err > bestErr) { bestErr = err; best = i; }
    }
    if (best < 0 || bestErr < 14 + speed * 0.04) return;
    const g = this.gait[best];
    const want = center + (best ? half : -half) * f + this.vxSmooth * 0.1;
    g.swing = true;
    g.s = 0;
    g.x0 = this.ps[LEG[best][1]].x;
    g.x1 = clamp(want, g.x0 - 70, g.x0 + 70);
    g.dur = clamp(0.24 - speed * 0.00018, 0.14, 0.24);
    g.lift = 9 + speed * 0.025;
  }

  /** Two-bone IK. Returns world angles for both bones. bend = sign of the joint bend. */
  private ik(px: number, py: number, tx: number, ty: number, l1: number, l2: number, bend: number) {
    let dx = tx - px, dy = ty - py;
    const d0 = Math.hypot(dx, dy) || 1e-3;
    const d = clamp(d0, Math.abs(l1 - l2) + 1, l1 + l2 - 0.05);
    dx *= d / d0; dy *= d / d0;
    const base = Math.atan2(dy, dx);
    const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
    const a1 = base + bend * Math.acos(cosA);
    const kx = px + Math.cos(a1) * l1, ky = py + Math.sin(a1) * l1;
    const a2 = Math.atan2(py + dy - ky, px + dx - kx);
    return { a1, a2 };
  }

  private legIK(i: number, tx: number, ty: number) {
    const ps = this.ps, p = ps[PELVIS], n = ps[NECK];
    this.debugTargets.push({ x: tx, y: ty });
    const { a1, a2 } = this.ik(p.x, p.y, tx, ty, DIM.thigh, DIM.shin, -this.facing);
    const spineDown = Math.atan2(p.y - n.y, p.x - n.x);
    this.joints[J.hip0 + i].target = wrap(a1 - spineDown);
    this.joints[J.knee0 + i].target = wrap(a2 - a1);
  }

  private armIK(i: number, tx: number, ty: number) {
    const ps = this.ps, p = ps[PELVIS], n = ps[NECK];
    this.debugTargets.push({ x: tx, y: ty });
    const { a1, a2 } = this.ik(n.x, n.y, tx, ty, DIM.upper, DIM.fore, this.facing);
    const spineUp = Math.atan2(n.y - p.y, n.x - p.x);
    this.joints[J.sh0 + i].target = wrap(a1 - spineUp + Math.PI);
    this.joints[J.el0 + i].target = wrap(a2 - a1);
  }

  /** Set a joint target from a facing-right angle in degrees. */
  private setPose(j: number, deg: number) { this.joints[j].target = deg * DEG * this.facing; }

  private relOf(j: Joint, prev: boolean) {
    const a = this.ps[j.a], p = this.ps[j.p], c = this.ps[j.c];
    if (prev) return wrap(Math.atan2(c.py - p.py, c.px - p.px) - Math.atan2(p.py - a.py, p.px - a.px) + j.offset);
    return wrap(Math.atan2(c.y - p.y, c.x - p.x) - Math.atan2(p.y - a.y, p.x - a.x) + j.offset);
  }
  private currentRel(j: Joint) { return this.relOf(j, false); }

  private limits(j: Joint): [number, number] {
    return this.facing > 0 ? [j.min * DEG, j.max * DEG] : [-j.max * DEG, -j.min * DEG];
  }

  // ---------------------------------------------------------------- muscles

  /**
   * Rotate a set of particles about a pivot. withPrev keeps their velocity unchanged.
   * Accumulates the mass-weighted displacement into this.moved for momentum bookkeeping.
   */
  private rotate(set: number[], pivot: Particle, ang: number, withPrev: boolean) {
    if (ang === 0) return;
    const c = Math.cos(ang), s = Math.sin(ang);
    for (const i of set) {
      const q = this.ps[i];
      const dx = q.x - pivot.x, dy = q.y - pivot.y;
      const nx = pivot.x + dx * c - dy * s, ny = pivot.y + dx * s + dy * c;
      this.moved.x += (nx - q.x) * MASS[i];
      this.moved.y += (ny - q.y) * MASS[i];
      q.x = nx;
      q.y = ny;
      if (withPrev) {
        const ex = q.px - pivot.px, ey = q.py - pivot.py;
        q.px = pivot.px + ex * c - ey * s;
        q.py = pivot.py + ex * s + ey * c;
      }
    }
  }

  /**
   * PD muscle: rotates child and parent subtrees about the joint pivot in opposite
   * directions, split by mass so the pair conserves momentum. Bone lengths are untouched.
   */
  private muscle(j: Joint) {
    const g = this.tone * j.gain;
    if (g <= 0) return;
    let target = j.target;
    if (j.min > -900) { const [lo, hi] = this.limits(j); target = clamp(target, lo, hi); }
    const rel = this.relOf(j, false);
    const vel = wrap(rel - this.relOf(j, true));
    const kp = Math.min(0.12 * j.kp * g, 0.5);
    const kd = Math.min(0.32 * Math.sqrt(g), 0.8);
    const d = clamp(kp * wrap(target - rel) - kd * vel, -0.3, 0.3);
    const p = this.ps[j.p];
    const tot = j.mc + j.mp;
    this.moved.x = this.moved.y = 0;
    this.rotate(j.child, p, d * (j.mp / tot), false);
    this.rotate(j.parent, p, -d * (j.mc / tot), false);
    this.conserve(false);
  }

  /**
   * Muscles are internal forces: they must not move the centre of mass. Undo the net
   * displacement of the last rotations with a uniform shift (withPrev: keep velocities).
   */
  private conserve(withPrev: boolean) {
    // planted feet are held by ground friction: the ground takes their share
    let m = 0;
    for (let i = 0; i < COUNT; i++) if (!this.anchored(i)) m += MASS[i];
    const sx = -this.moved.x / m, sy = -this.moved.y / m;
    for (let i = 0; i < COUNT; i++) {
      if (this.anchored(i)) continue;
      const q = this.ps[i];
      q.x += sx; q.y += sy;
      if (withPrev) { q.px += sx; q.py += sy; }
    }
  }

  private anchored(i: number) {
    if (this.mode !== 'stand') return false;
    if (i === FT0) return !this.gait[0].swing && this.ps[FT0].grounded;
    if (i === FT1) return !this.gait[1].swing && this.ps[FT1].grounded;
    return false;
  }

  private limit(j: Joint) {
    if (j.min < -900) return;
    const [lo, hi] = this.limits(j);
    const rel = this.relOf(j, false);
    let over = 0;
    if (rel < lo) over = lo - rel; else if (rel > hi) over = hi - rel;
    if (over === 0) return;
    const p = this.ps[j.p];
    const tot = j.mc + j.mp;
    this.moved.x = this.moved.y = 0;
    this.rotate(j.child, p, over * (j.mp / tot), true);
    this.rotate(j.parent, p, -over * (j.mc / tot), true);
    this.conserve(true);
  }

  /**
   * Balance "cheats" common to active ragdolls: an upright torque on the upper body,
   * pelvis height support while a foot is down, and a horizontal drive.
   */
  private applyBalance() {
    const b = this.balance;
    if (b <= 0) return;
    const ps = this.ps, p = ps[PELVIS], n = ps[NECK];
    const f = this.facing;

    // upright torque about the pelvis
    const target = -Math.PI / 2 + this.lean * DEG * f;
    const ang = Math.atan2(n.y - p.y, n.x - p.x);
    const angPrev = Math.atan2(n.py - p.py, n.px - p.px);
    const e = wrap(target - ang), v = wrap(ang - angPrev);
    const d = clamp((0.16 * e - 0.45 * v) * b, -0.25, 0.25);
    // the legs push on the ground to make this torque: no net force on the body
    this.moved.x = this.moved.y = 0;
    this.rotate(UPPER_BODY, p, d, false);
    this.conserve(false);

    const support = this.footDown || (this.mode === 'rise' && p.y > this.ground(p.x, p.y) - 90);
    if (support && this.mode !== 'air') {
      // pelvis height: the legs "carry" the upper body. Cancel its gravity and blend the
      // group's vertical velocity toward a spring on pelvis height.
      // stand on whatever is under the feet (floor, ramp, platform)
      const fa = ps[FT0], fb = ps[FT1];
      const under = Math.min(this.ground(fa.x, fa.y), this.ground(fb.x, fb.y));
      const ty = Math.min(under, this.ground(p.x, p.y + 30)) - this.hipH;
      const vyT = clamp((ty - p.y) * 12, -450, 450);
      let m = 0, vy = 0;
      for (const i of SUPPORTED) { m += MASS[i]; vy += ps[i].vy * MASS[i]; }
      vy /= m;
      const dv = (vyT - vy) * 0.3 * b - GRAVITY * DT * b;
      for (const i of SUPPORTED) ps[i].addVel(0, dv);
      // horizontal drive on the upper body; feet catch up by stepping
      let want = this.ctrl.moveX * (this.ctrl.run ? RUN_SPEED : WALK_SPEED);
      // standing still: hold the spot instead of slowly creeping
      if (this.ctrl.moveX === 0) {
        if (this.holdX === null) this.holdX = p.x;
        want = clamp((this.holdX - p.x) * 4, -80, 80);
      } else this.holdX = null;
      if (this.action.kind === 'punch' && this.action.t > 0.07 && this.action.t < 0.2) want = f * 140;
      if (this.action.kind === 'duck' || this.action.kind === 'kick') want *= 0.3;
      // drive the whole body's momentum (not single points) toward the wanted speed
      let mf = 0, mv = 0;
      for (let i = 0; i < COUNT; i++) if (!this.anchored(i)) { mf += MASS[i]; mv += ps[i].vx * MASS[i]; }
      const dvx = (want - mv / mf) * 0.1 * b;
      for (let i = 0; i < COUNT; i++) if (!this.anchored(i)) ps[i].addVel(dvx, 0);
    }
  }
}
