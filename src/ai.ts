import { DT, GROUND, GRAVITY, W } from './physics';
import { Stickman, HEAD, NECK, PELVIS, Weapon } from './stickman';
import { World, HURT_J0, HURT_PER } from './world';
import { Vec, clamp, gauss, rand } from './math';
import { thinkDefense, thinkStrike, lesson } from './explain';
import { PolicyNet, REACTIONS, Reaction, STRIKES, DefenseInput, OffenseInput, DEFENSE_KEYS, DEFENSE_DEFAULTS, OFFENSE_KEYS, OFFENSE_DEFAULTS, Sample, toVec } from './policy';
export { REACTIONS };
export type { Reaction };

// ---------------------------------------------------------------------------
// Brain = rule policy + two adaptation loops:
//  1. Handwired policy (fast): which reaction to a threat and which strike to throw
//     come from a Handwired circuit (policy.ts) that starts as the hand-written rules
//     and is trained by backprop on every outcome (replayed, so old lessons stick).
//  2. Parameter evolution (slow): (1+1)-ES over continuous knobs (reaction lead
//     times, aggression, spacing...). Fitness = damage dealt - damage taken per episode.
// All of it is saved to brains/<name>.json and reloaded, so learning carries on.
// ---------------------------------------------------------------------------


export interface Threat {
  key: string;        // context key
  source: string;     // matches HurtEvent.source
  ttc: number;        // seconds until predicted contact
  height: number;     // contact height above ground
  impact: Vec;        // predicted contact point
  vx: number;         // horizontal velocity of the threat
  path: Vec[];
  input: DefenseInput; // what the policy circuit sees
  dodgeDir: number;    // safest dodge direction given walls and spikes
  what: string;        // plain name: ball, rock, drawing, punch, kick
}

export interface Thought { text: string; at: number; mood: 'think' | 'good' | 'bad' }
export interface Lesson { text: string; at: number }

/** What the brain knows about the whole arena, refreshed every frame. */
export interface Arena {
  objects: number;
  moving: number;
  spikes: { x0: number; x1: number }[];
  cannonsOn: number;
  nextShot: number;   // seconds until the next cannon shot, Infinity if none
  wallLeft: number;   // distance to each wall
  wallRight: number;
  enemy: string;
}

const DODGE_REACH = 190;
/** Pelvis-to-pelvis distance a strike can still land from. */
const REACH = 66;
/** What each move costs even when it works (dodging gives up ground and tempo). */
const COST: Record<Reaction, number> = { duck: 0, jump: 0.1, dodge: 0.2, block: 0.05, ignore: 0, swat: 0 };
/** A scratch (under SCRATCH damage) still counts as fended off, just slightly less good. */
const SCRATCH = 3;
const rewardFor = (r: Reaction, dmg: number) => (dmg >= SCRATCH ? -0.2 - Math.min(1, dmg / 25) : 1 - COST[r] - dmg * 0.05);

/** Carry out a defensive reaction. Shared by the real stickman and imagined copies. */
export function perform(me: Stickman, r: Reaction, t: Threat) {
  const ctrl = me.ctrl;
  switch (r) {
    case 'duck': me.action.kind = 'none'; me.start('duck', { dur: Math.max(0.35, t.ttc + 0.25) }); break;
    case 'jump': ctrl.moveX = 0; me.action.kind = 'none'; me.start('jump'); break;
    case 'dodge': me.action.kind = 'none'; me.start('dodge', { dir: t.dodgeDir }); break;
    case 'block':
      ctrl.face = -Math.sign(t.vx) || me.facing;
      me.facing = ctrl.face;
      me.action.kind = 'none';
      me.start('block', { dur: Math.max(0.3, t.ttc + 0.2) });
      break;
    case 'ignore': break;
    case 'swat': {
      if (!me.weapon) break;
      const face = Math.sign(t.impact.x - me.pelvis.x) || me.facing;
      ctrl.face = face;
      me.facing = face;
      me.action.kind = 'none';
      me.start('swing', { target: t.impact, dir: 1 });
      break;
    }
  }
}

interface Pending { threat: Threat; reaction: Reaction; chosenAt: number; fireAt: number; endAt: number; fired: boolean }

/** A candidate response: a defensive reaction to the most urgent threat, or running one way. */
type Plan = { kind: 'react'; r: Reaction } | { kind: 'run'; dir: number };
/** Planning in progress: candidates are imagined a few per frame against a frozen snapshot. */
interface Planning {
  key: string;
  first: Threat;
  threats: Threat[];
  startedAt: number;
  horizon: number;
  fork: () => { w: World; me: Stickman; foes: Brain[] };
  plans: Plan[];
  total: number[];   // score for everything that happens (decides)
  firstDmg: number[]; // damage from the first threat only (what each reaction is learned from)
  next: number;
}

/** Scripted enemies never learn, so all their imagined copies can share one circuit. */
let sharedNet: PolicyNet | null = null;
const scriptedNet = () => (sharedNet ??= new PolicyNet());
/** Milliseconds of imagining allowed per frame. */
const PLAN_BUDGET_MS = 6;
const RUN_COST = 0.25;
interface StrikePending { x: number[]; a: number; endAt: number; dealt0: number; hurt0: number }

const REPLAY = 800;
const BATCH = 12;
const TRAIN_STEPS = 3;   // backprop steps per frame
const IMPRINT_STEPS = 8; // extra steps on each new outcome

/** Lifetime counters; persisted. */
export interface Stats {
  threats: number; defended: number; strikes: number; landed: number; sessions: number;
  /** last 50 defence outcomes (1 = no damage) */
  recent: number[];
  /** last 30 strike outcomes (1 = landed) */
  strikeRecent: number[];
  wins: number; losses: number;
  /** seconds of play, all sessions */
  playTime: number;
  /** per minute of play: threats seen and defended */
  minutes: { n: number; ok: number }[];
}
const freshStats = (): Stats => ({ threats: 0, defended: 0, strikes: 0, landed: 0, sessions: 1, recent: [], strikeRecent: [], wins: 0, losses: 0, playTime: 0, minutes: [] });

/** Everything that is saved to disk for one brain. */
export interface BrainSave {
  version: 1;
  name: string;
  savedAt: string;
  weights: Record<string, number>;
  trainSteps: number;
  es: { params: Params; parent: Params; parentFit: number; sigma: number; gen: number; accepted: number; fitHistory: number[] };
  visits: [string, number][];
  contexts: [string, DefenseInput][];
  replayDefense: Sample[];
  replayOffense: Sample[];
  stats: Stats;
  lessons?: Lesson[];
  bestByCtx?: Record<string, Reaction>;
  weapon?: Weapon | null;
}

export interface ParamSpec { key: string; lo: number; hi: number; init: number; label: string }
export const PARAMS: ParamSpec[] = [
  { key: 'leadDuck', lo: 0.05, hi: 0.6, init: 0.22, label: 'duck lead (s)' },
  { key: 'leadJump', lo: 0.05, hi: 0.6, init: 0.2, label: 'jump lead (s)' },
  { key: 'leadDodge', lo: 0.05, hi: 0.7, init: 0.3, label: 'dodge lead (s)' },
  { key: 'leadBlock', lo: 0.03, hi: 0.5, init: 0.18, label: 'block lead (s)' },
  { key: 'leadSwat', lo: 0.05, hi: 0.5, init: 0.2, label: 'swat lead (s)' },
  { key: 'aggression', lo: 0, hi: 1, init: 0.6, label: 'aggression' },
  { key: 'range', lo: 35, hi: 80, init: 55, label: 'attack range' },
  { key: 'tempo', lo: 0.3, hi: 2, init: 0.9, label: 'attack cooldown' },
  { key: 'retreatHp', lo: 0, hi: 0.8, init: 0.25, label: 'retreat at hp' },
];
type Params = Record<string, number>;

const EPISODE = 4;

export interface LogLine { t: number; text: string; good: boolean | null }

export class Brain {
  params: Params = {};
  parent: Params = {};
  parentFit = 0;
  sigma = 0.25;
  gen = 0;
  accepted = 0;
  epStart = 0;
  epDealt0 = 0;
  epHurt0 = 0;
  fitHistory: number[] = [];
  net: PolicyNet;
  replayDefense: Sample[] = [];
  replayOffense: Sample[] = [];
  /** context label -> last circuit input seen for it (for the HUD) */
  contexts = new Map<string, DefenseInput>();
  visits = new Map<string, number>();
  strikePending: StrikePending | null = null;
  stats: Stats = freshStats();
  thought: Thought | null = null;
  lessons: Lesson[] = [];
  /** current favourite reaction per situation, to notice when it changes */
  bestByCtx: Record<string, Reaction> = {};
  private lastFail: Record<string, Reaction> = {};
  private koSeen = { me: false, enemy: false };
  /** Set whenever something worth saving changed. */
  dirty = false;
  pending: Pending | null = null;
  log: LogLine[] = [];
  threat: Threat | null = null;
  threats: Threat[] = [];
  planning: Planning | null = null;
  private planKey = '';
  /** Reactions that were carried out, waiting to see how they went (learned from). */
  private outcomes: Pending[] = [];
  /** A run-away plan in progress. */
  runAway: { dir: number; until: number } | null = null;
  /** Simulate reactions before choosing (uses the physics engine as a world model). */
  imagination = true;
  /** Enemies: fixed hand-written rules, no learning, no imagination, nothing saved. */
  isScripted = false;
  scripted() {
    this.isScripted = true;
    this.learning = false;
    this.imagination = false;
    // a plain brawler: keeps pressing in, never backs off, attacks at a steady pace
    this.params = { ...this.params, aggression: 1, retreatHp: 0, range: 55, tempo: 1 };
  }
  private epFought = false;
  lastImagined = '';
  arena: Arena = { objects: 0, moving: 0, spikes: [], cannonsOn: 0, nextShot: Infinity, wallLeft: 0, wallRight: 0, enemy: 'none' };
  attackCd = 0;
  approachRoll = 1;
  approachT = 0;
  totalHurt = 0;
  lastThink = 0;
  learning = true;

  constructor(public me: Stickman, public home: number, net?: PolicyNet) {
    this.net = net ?? new PolicyNet();
    for (const p of PARAMS) this.params[p.key] = p.init;
    this.parent = { ...this.params };
  }

  // ------------------------------------------------------------- perception

  private enemyOf(world: World): Stickman | null {
    let best: Stickman | null = null, bd = Infinity;
    for (const m of world.men) {
      if (m === this.me || m.team === this.me.team || !m.alive) continue;
      const d = Math.abs(m.pelvis.x - this.me.pelvis.x);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

  /** A knockout ends a round: count wins and losses against an enemy. */
  private countRounds(world: World) {
    const foe = world.men.find((m) => m !== this.me && m.team !== this.me.team);
    if (!foe) return;
    const meOut = !this.me.alive, foeOut = !foe.alive;
    if (meOut && !this.koSeen.me) { this.stats.losses++; this.think_(world, 'Knocked out…', 'bad'); }
    if (foeOut && !this.koSeen.enemy) { this.stats.wins++; this.think_(world, 'Knocked him out!', 'good'); }
    this.koSeen = { me: meOut, enemy: foeOut };
  }

  /** Everything in the arena: walls, traps, cannons, objects, the enemy. */
  private scan(world: World, enemy: Stickman | null) {
    const cx = this.me.pelvis.x;
    let moving = 0, next = Infinity, on = 0;
    for (const b of world.bodies) if (b.speed > 60) moving++;
    for (const c of world.cannons) { on++; next = Math.min(next, c.cd); }
    this.arena = {
      objects: world.bodies.length,
      moving,
      spikes: world.spikes.map((z) => ({ x0: z.x0, x1: z.x1 })),
      cannonsOn: on,
      nextShot: next,
      wallLeft: cx,
      wallRight: W - cx,
      enemy: enemy ? `${enemy.name} ${Math.round(Math.abs(enemy.pelvis.x - cx))}px ${enemy.mode}${enemy.busy ? ' ' + enemy.action.kind : ''}` : 'none',
    };
  }

  /** Can I dodge this way without hitting a wall or landing in spikes? */
  private dodgeClear(world: World, dir: number) {
    const cx = this.me.pelvis.x;
    const land = cx + dir * DODGE_REACH;
    if (land < 40 || land > W - 40) return false;
    if (world.wallBetween(cx, land)) return false;
    for (const z of world.spikes) {
      const lo = Math.min(cx, land), hi = Math.max(cx, land);
      if (z.x1 > lo - 20 && z.x0 < hi + 20) return false;
    }
    return true;
  }

  /** Pick a dodge direction: preferred if clear, else the other one; cornered if the safe options are gone. */
  private escape(world: World, preferred: number, eitherWay: boolean) {
    if (this.dodgeClear(world, preferred)) return { dir: preferred, cornered: 0 };
    if (this.dodgeClear(world, -preferred)) return { dir: -preferred, cornered: eitherWay ? 0 : 1 };
    return { dir: preferred, cornered: 1 };
  }

  /** Every incoming threat: thrown things on a collision course and enemy strikes about to land. Most urgent first. */
  private perceiveAll(world: World): Threat[] {
    const me = this.me;
    const cx = me.pelvis.x;
    const topY = Math.min(me.ps[HEAD].y - 11, GROUND - 140);
    const out: Threat[] = [];
    for (const b of world.bodies) {
      const dx = b.x - cx;
      if (Math.abs(dx) > 900) continue;
      const sp = b.speed;
      if (sp < 140) continue;
      const r = b.boundR;
      const path: Vec[] = [];
      let hit: { t: number; p: Vec } | null = null;
      for (let t = 0; t <= 1.1; t += 1 / 60) {
        const x = b.x + b.vx * t;
        let y = b.y + b.vy * t + 0.5 * GRAVITY * t * t;
        if (y > GROUND - r) y = GROUND - r;
        path.push({ x, y });
        // body as a vertical capsule from feet to head top, half-width 12
        const ex = Math.max(0, Math.abs(x - cx) - 12);
        const ey = y < topY ? topY - y : 0;
        if (Math.hypot(ex, ey) < r + 4) { hit = { t, p: { x, y } }; break; }
      }
      if (!hit) continue;
      const height = GROUND - hit.p.y;
      const hb = height > 95 ? 'high' : height > 45 ? 'mid' : 'low';
      const above = b.vy > 250 && Math.abs(b.vx) < Math.abs(b.vy) * 0.8 && height > 80;
      const size = r > 22 ? 'big' : 'small';
      const fast = sp > 650 ? 'fast' : 'slow';
      const key = above ? `${size} from above` : `${size} ${fast} ${hb}`;
      // expected damage: impulse from closing speed and mass, same formula the world uses
      const vAt = Math.hypot(b.vx - me.pelvis.vx, b.vy + GRAVITY * hit.t);
      const jEst = (1.2 * vAt) / (0.066 + b.invMass);
      const harm = clamp(((jEst - HURT_J0) / HURT_PER) * b.sharpness, 0, 45);
      const away = Math.sign(cx - hit.p.x) || -Math.sign(b.vx) || -me.facing;
      const preferred = above ? away : Math.abs(b.vx) > 200 ? Math.sign(b.vx) : away;
      const esc = this.escape(world, preferred, above);
      const input: DefenseInput = { height, speed: sp, size: r, punch: 0, kick: 0, above: above ? 1 : 0, flying: above ? 0 : 1, harm, ttc: hit.t, cornered: esc.cornered, armed: me.weapon ? 1 : 0 };
      const what = b.kind === 'ball' ? 'cannonball' : b.kind === 'rock' ? 'rock' : 'drawing';
      out.push({ key, source: `body:${b.id}`, ttc: hit.t, height, impact: hit.p, vx: b.vx, path, input, dodgeDir: esc.dir, what });
    }
    for (const enemy of world.men) {
      if (enemy === me || enemy.team === me.team || !enemy.alive || enemy.mode !== 'stand') continue;
      const a = enemy.action;
      const dist = Math.abs(enemy.pelvis.x - cx);
      const facingMe = Math.sign(cx - enemy.pelvis.x) === enemy.facing;
      if (!((a.kind === 'punch' || a.kind === 'kick' || a.kind === 'swing') && facingMe && dist < 130 + (enemy.weapon ? enemy.weapon.length : 0))) continue;
      const windup = a.kind === 'kick' ? 0.12 : a.kind === 'swing' ? 0.12 : 0.07;
      if (a.t >= windup + 0.03) continue;
      const ttc = Math.max(0, windup - a.t) + 0.04;
      const height = a.kind === 'kick' ? 50 : GROUND - a.target.y;
      const esc = this.escape(world, enemy.facing, false);
      const kind = a.kind === 'kick' ? 'kick' : 'punch';
      const input: DefenseInput = { height, speed: 0, size: 0, punch: kind === 'punch' ? 1 : 0, kick: kind === 'kick' ? 1 : 0, above: 0, flying: 0, harm: kind === 'kick' ? 15 : 10, ttc, cornered: esc.cornered, armed: me.weapon ? 1 : 0 };
      out.push({ key: `enemy ${kind}`, source: `man:${enemy.name}:${a.kind}`, ttc, height, impact: { x: cx, y: GROUND - height }, vx: enemy.facing * 300, path: [], input, dodgeDir: esc.dir, what: kind });
    }
    return out.sort((p, q) => p.ttc - q.ttc);
  }

  // ------------------------------------------------------------- handwired policy

  private explore(key: string) {
    const n = this.visits.get(key) ?? 0;
    return this.learning ? Math.max(0.03, 0.25 / (1 + n * 0.8)) : 0;
  }

  /**
   * Imagination with everything at once: freeze a copy of the arena (all flying things,
   * all enemies with their fixed logic, cannons about to fire) and replay the next second
   * or so once per candidate plan. Candidates: each reaction to the most urgent threat,
   * plus running left or right. Scored on ALL damage taken, so a move that dodges one
   * thing into another loses.
   */
  private startPlanning(world: World, threats: Threat[], key: string) {
    const first = threats[0];
    const near = (x: number) => Math.abs(x - this.me.pelvis.x) < 900;
    const bodies = world.bodies.filter((b) => (b.speed > 60 && near(b.x)) || threats.some((t) => t.source === `body:${b.id}`)).map((b) => b.clone());
    const me0 = this.me.clone();
    const foes = world.men.filter((m) => m !== this.me && m.team !== this.me.team && near(m.pelvis.x));
    const foes0 = foes.map((m) => ({ m: m.clone(), cd: 0, brain: world.men.indexOf(m) }));
    const cannons = world.cannons.map((c) => ({ ...c }));
    const time = world.time, spikes = world.spikes.map((z) => ({ ...z })), solids = world.solids;
    const fork = () => {
      const w = new World();
      w.time = time;
      w.spikes = spikes;
      w.solids = solids;
      w.cannons = cannons.map((c) => ({ ...c }));
      const me = me0.clone();
      me.ctrl = { moveX: 0, run: false, face: me.facing, crouch: 0 };
      w.men.push(me);
      const brains: Brain[] = [];
      for (const f of foes0) {
        const m = f.m.clone();
        w.men.push(m);
        const b = new Brain(m, m.pelvis.x, scriptedNet());
        b.scripted();
        brains.push(b);
      }
      for (const b of bodies) w.bodies.push(b.clone());
      return { w, me, foes: brains };
    };
    const plans: Plan[] = REACTIONS.filter((r) => r !== 'swat' || this.me.weapon).map((r): Plan => ({ kind: 'react', r }));
    for (const dir of [-1, 1]) if (this.dodgeClear(world, dir)) plans.push({ kind: 'run', dir });
    const horizon = clamp(Math.max(...threats.map((t) => t.ttc)) + 0.45, 0.6, 1.4);
    this.planning = { key, first, threats, startedAt: time, horizon, fork, plans, total: [], firstDmg: [], next: 0 };
  }

  /** Imagine some candidates (within the frame budget). Returns true once all are scored. */
  private stepPlanning(): boolean {
    const pl = this.planning!;
    const t0 = performance.now();
    while (pl.next < pl.plans.length) {
      const plan = pl.plans[pl.next];
      const { w, me, foes } = pl.fork();
      const fireAt = plan.kind === 'react' ? Math.max(0, pl.first.ttc - this.lead(plan.r)) : 0;
      const hp0 = me.health;
      let fired = false, k = 0;
      for (let s = 0; s < pl.horizon; s += DT, k++) {
        if (plan.kind === 'react') {
          if (!fired && s >= fireAt && me.canAct()) { fired = true; perform(me, plan.r, pl.first); }
        } else { me.ctrl.moveX = plan.dir; me.ctrl.run = true; me.ctrl.face = plan.dir; }
        if (k % 2 === 0) for (const b of foes) b.think(w, DT * 2);
        w.step();
      }
      const dmg = hp0 - me.health;
      const firstDmg = me.hurtLog.filter((e) => e.source === pl.first.source).reduce((a, e) => a + e.amount, 0);
      pl.total.push(plan.kind === 'react' ? rewardFor(plan.r, dmg) : rewardFor('ignore', dmg) - RUN_COST);
      pl.firstDmg.push(firstDmg);
      pl.next++;
      if (performance.now() - t0 > PLAN_BUDGET_MS) break;
    }
    return pl.next >= pl.plans.length;
  }

  /** All candidates imagined: pick the best, learn from every imagined outcome, act. */
  private finishPlanning(world: World) {
    const pl = this.planning!;
    this.planning = null;
    const t = pl.first;
    this.contexts.set(t.key, t.input);
    const v = this.net.defense(t.input);
    let bi = 0;
    const val = (i: number) => (pl.plans[i].kind === 'react' ? v[REACTIONS.indexOf((pl.plans[i] as { r: Reaction }).r)] : -9);
    for (let i = 1; i < pl.plans.length; i++) {
      if (pl.total[i] > pl.total[bi] + 1e-6 || (Math.abs(pl.total[i] - pl.total[bi]) < 1e-6 && val(i) > val(bi))) bi = i;
    }
    // what each reaction did about the most urgent threat is a lesson, whatever else happened
    const scores: number[] = REACTIONS.map(() => -1);
    pl.plans.forEach((p, i) => {
      if (p.kind !== 'react') return;
      const a = REACTIONS.indexOf(p.r);
      scores[a] = rewardFor(p.r, pl.firstDmg[i]);
      if (this.learning) this.remember(this.replayDefense, { x: toVec(DEFENSE_KEYS, t.input), a, r: scores[a] }, true, 3);
    });
    this.noticeLesson(t.key, t.input);
    const best = pl.plans[bi];
    const n = pl.threats.length;
    this.lastImagined = pl.plans.map((p, i) => `${p.kind === 'react' ? p.r : p.dir > 0 ? 'run→' : '←run'}${pl.total[i] > 0 ? '✓' : '✗'}`).join(' ');
    this.addLog(world, `imagined ${n > 1 ? `${n} threats` : t.key}: ${this.lastImagined}`, null);
    if (best.kind === 'run') {
      if (this.pending && !this.pending.fired) this.pending = null;
      this.runAway = { dir: best.dir, until: world.time + pl.horizon };
      this.think_(world, `${n > 1 ? `${n} things coming` : 'Too much'} → run ${best.dir > 0 ? 'right' : 'left'}!`, 'think');
      return;
    }
    this.runAway = null;
    if (this.pending?.fired && this.me.busy) return; // already mid-move; next plan will pick up
    const r = best.r;
    const elapsed = world.time - pl.startedAt; // planning may have taken a few frames
    this.pending = { threat: t, reaction: r, chosenAt: pl.startedAt, fireAt: pl.startedAt + Math.max(0, t.ttc - this.lead(r)), endAt: pl.startedAt + t.ttc + 0.45, fired: false };
    const text = thinkDefense(t, r, scores, REACTIONS);
    this.think_(world, n > 1 && elapsed >= 0 ? `${text.replace(/!.*$/, '!')} (${n} incoming)` : text, 'think');
  }

  /** Quick choice from the circuit alone (no imagining): scripted enemies, or imagination off. */
  private choose(world: World, t: Threat): Reaction {
    this.contexts.set(t.key, t.input);
    this.lastImagined = '';
    let r: Reaction;
    const allowed = REACTIONS.filter((x) => x !== 'swat' || this.me.weapon);
    if (Math.random() < this.explore(t.key)) r = allowed.filter((x) => x !== 'ignore')[Math.floor(Math.random() * (allowed.length - 1))];
    else {
      const v = this.net.defense(t.input);
      r = allowed.reduce((best, x) => (v[REACTIONS.indexOf(x)] > v[REACTIONS.indexOf(best)] ? x : best), allowed[0]);
    }
    this.think_(world, thinkDefense(t, r, null, REACTIONS), 'think');
    return r;
  }

  private think_(world: World, text: string, mood: Thought['mood']) {
    this.thought = { text, at: world.time, mood };
  }

  /** After learning about a situation: if the favourite reaction changed, that's a lesson. */
  private noticeLesson(key: string, input: DefenseInput) {
    const v = this.net.defense(input);
    let bi = 0;
    for (let i = 1; i < v.length; i++) if (v[i] > v[bi]) bi = i;
    const now = REACTIONS[bi];
    const before = this.bestByCtx[key];
    this.bestByCtx[key] = now;
    if (!before || before === now) return;
    this.lessons.unshift({ text: lesson(key, now, before, this.lastFail[key] === before), at: this.stats.playTime });
    if (this.lessons.length > 8) this.lessons.pop();
  }

  /** Pick punch / kick / swing. Only what can reach is allowed (fists and feet don't reach as far as a weapon). */
  private chooseStrike(world: World, o: OffenseInput): number {
    const allowed = [0, 1, 2].filter((i) => (i === 2 ? !!this.me.weapon : o.dist < REACH));
    if (!allowed.length) return -1;
    let a: number;
    if (this.isScripted) {
      // fixed enemy logic: kick a ducking target, punch a high one, otherwise mix it up
      a = o.ducking && allowed.includes(1) ? 1 : allowed[Math.random() < 0.35 && allowed.includes(1) ? allowed.indexOf(1) : 0];
    } else if (this.learning && Math.random() < 0.12) a = allowed[Math.floor(Math.random() * allowed.length)];
    else { const v = this.net.offense(o); a = allowed.reduce((b, i) => (v[i] > v[b] ? i : b), allowed[0]); }
    this.think_(world, thinkStrike(STRIKES[a], o), 'think');
    return a;
  }

  /** Where to fight from: the tuned range, but never beyond what my best strike reaches. */
  private strikeRange() {
    const extra = this.me.weapon ? this.me.weapon.length * 0.9 : 0;
    return Math.min(this.params.range + extra, REACH + extra);
  }

  private remember(buf: Sample[], s: Sample, defense: boolean, imprint = IMPRINT_STEPS) {
    buf.push(s);
    // one-shot: drill the new outcome in right away so the very next choice reflects it
    if (this.learning) for (let k = 0; k < imprint; k++) this.net.train(defense ? [s] : [], defense ? [] : [s]);
    if (buf.length > REPLAY) buf.splice(0, buf.length - REPLAY);
    this.dirty = true;
  }

  /**
   * Backprop steps every frame on replayed experience, weighted hard toward the newest
   * outcomes (3 of 4 picks from the last 20): fast adaptation over generality, by design.
   */
  private learn() {
    if (!this.learning) return;
    const pick = (buf: Sample[]) => {
      const out: Sample[] = [];
      if (!buf.length) return out;
      for (let i = 0; i < BATCH; i++) {
        const lo = i % 4 !== 0 ? Math.max(0, buf.length - 20) : 0;
        out.push(buf[lo + Math.floor(Math.random() * (buf.length - lo))]);
      }
      return out;
    };
    if (!this.replayDefense.length && !this.replayOffense.length) return;
    for (let k = 0; k < TRAIN_STEPS; k++) this.net.train(pick(this.replayDefense), pick(this.replayOffense));
  }

  table() {
    return [...this.contexts.entries()].map(([key, input]) => ({ key, v: this.net.defense(input), n: this.visits.get(key) ?? 0 }));
  }

  private lead(r: Reaction): number {
    const p = this.params;
    return r === 'duck' ? p.leadDuck : r === 'jump' ? p.leadJump : r === 'dodge' ? p.leadDodge : r === 'block' ? p.leadBlock : r === 'swat' ? p.leadSwat : 0;
  }

  private resolve(world: World) {
    const due = this.outcomes.filter((pd) => world.time >= pd.endAt);
    if (!due.length) return;
    this.outcomes = this.outcomes.filter((pd) => world.time < pd.endAt);
    for (const pd of due) this.resolveOne(world, pd);
  }

  private resolveOne(world: World, pd: Pending) {
    const dmg = this.me.hurtLog.filter((e) => e.time >= pd.chosenAt - 0.01 && e.source === pd.threat.source).reduce((s, e) => s + e.amount, 0);
    const ok = dmg < SCRATCH;
    // a clean escape is worth 1, minus what the move costs (dodging gives up ground and tempo)
    const reward = rewardFor(pd.reaction, dmg);
    // punish back: a defended enemy strike opens a counter window
    if (ok && pd.threat.key.startsWith('enemy')) this.attackCd = Math.min(this.attackCd, 0);
    const key = pd.threat.key;
    this.remember(this.replayDefense, { x: toVec(DEFENSE_KEYS, pd.threat.input), a: REACTIONS.indexOf(pd.reaction), r: reward }, true);
    this.visits.set(key, (this.visits.get(key) ?? 0) + 1);
    this.stats.threats++;
    if (ok) this.stats.defended++;
    this.stats.recent.push(ok ? 1 : 0);
    if (this.stats.recent.length > 50) this.stats.recent.shift();
    const minute = Math.floor(this.stats.playTime / 60);
    while (this.stats.minutes.length <= minute) this.stats.minutes.push({ n: 0, ok: 0 });
    this.stats.minutes[minute].n++;
    if (ok) this.stats.minutes[minute].ok++;
    if (this.stats.minutes.length > 240) this.stats.minutes.splice(0, this.stats.minutes.length - 240);
    if (!ok) this.lastFail[key] = pd.reaction;
    this.noticeLesson(key, pd.threat.input);
    this.think_(world, ok ? (pd.reaction === 'ignore' ? 'No problem.' : 'Phew!') : `Ouch! −${Math.round(dmg)}`, ok ? 'good' : 'bad');
    this.addLog(world, `${key} → ${pd.reaction} ${ok ? '✓' : `✗ -${Math.round(dmg)}`}`, ok);
  }

  /** Score a finished strike: damage landed is good, eating a counter is bad, a whiff is mildly bad. */
  private resolveStrike(world: World) {
    const sp = this.strikePending;
    if (!sp || world.time < sp.endAt) return;
    this.strikePending = null;
    const dealt = this.me.dealt - sp.dealt0;
    const taken = this.totalHurt - sp.hurt0;
    const r = clamp((dealt > 0 ? 0.4 + dealt / 20 : -0.25) - taken / 20, -1, 1);
    this.remember(this.replayOffense, { x: sp.x, a: sp.a, r }, false);
    this.stats.strikes++;
    if (dealt > 0) this.stats.landed++;
    this.stats.strikeRecent.push(dealt > 0 ? 1 : 0);
    if (this.stats.strikeRecent.length > 30) this.stats.strikeRecent.shift();
    if (dealt > 0) this.think_(world, 'Got him!', 'good');
  }

  // ------------------------------------------------------------- save / load

  serialize(): BrainSave {
    return {
      version: 1,
      name: this.me.name,
      savedAt: new Date().toISOString(),
      weights: this.net.weights(),
      trainSteps: this.net.steps,
      es: { params: this.params, parent: this.parent, parentFit: this.parentFit, sigma: this.sigma, gen: this.gen, accepted: this.accepted, fitHistory: this.fitHistory },
      visits: [...this.visits.entries()],
      contexts: [...this.contexts.entries()],
      replayDefense: this.replayDefense,
      replayOffense: this.replayOffense,
      stats: this.stats,
      lessons: this.lessons,
      bestByCtx: this.bestByCtx,
      weapon: this.me.weapon,
    };
  }

  restore(d: BrainSave) {
    if (d.version !== 1) return;
    this.net.load(d.weights ?? {}, d.trainSteps ?? 0);
    const known = (o: Params | undefined) => {
      const out: Params = {};
      for (const p of PARAMS) out[p.key] = clamp(typeof o?.[p.key] === 'number' ? o[p.key] : p.init, p.lo, p.hi);
      return out;
    };
    if (d.es) {
      this.params = known(d.es.params);
      this.parent = known(d.es.parent);
      this.parentFit = d.es.parentFit ?? 0;
      this.sigma = d.es.sigma ?? this.sigma;
      this.gen = d.es.gen ?? 0;
      this.accepted = d.es.accepted ?? 0;
      this.fitHistory = d.es.fitHistory ?? [];
    }
    this.visits = new Map(d.visits ?? []);
    this.contexts = new Map(d.contexts ?? []);
    // samples saved before an input existed get that input's neutral default
    const pad = (s: Sample) => (s.x.length >= DEFENSE_KEYS.length ? s : { ...s, x: DEFENSE_KEYS.map((k, i) => (i < s.x.length ? s.x[i] : DEFENSE_DEFAULTS[k] ?? 0)) });
    this.replayDefense = (d.replayDefense ?? []).slice(-REPLAY).map(pad);
    for (const [k, v] of this.contexts) this.contexts.set(k, { ...DEFENSE_DEFAULTS, ...v } as DefenseInput);
    const padO = (s: Sample) => (s.x.length >= OFFENSE_KEYS.length ? s : { ...s, x: OFFENSE_KEYS.map((k, i) => (i < s.x.length ? s.x[i] : OFFENSE_DEFAULTS[k] ?? 0)) });
    this.replayOffense = (d.replayOffense ?? []).slice(-REPLAY).map(padO);
    if (d.stats) this.stats = { ...freshStats(), ...d.stats, sessions: (d.stats.sessions ?? 0) + 1 };
    this.lessons = d.lessons ?? [];
    if (d.weapon && Array.isArray(d.weapon.strokes)) this.me.equip(d.weapon);
    this.bestByCtx = d.bestByCtx ?? {};
  }

  addLog(world: World, text: string, good: boolean | null) {
    this.log.unshift({ t: world.time, text, good });
    if (this.log.length > 14) this.log.pop();
  }

  // ------------------------------------------------------------- parameter evolution

  private episode(world: World) {
    if (world.time - this.epStart < EPISODE) return;
    const me = this.me;
    const hurt = this.totalHurt - this.epHurt0;
    const dealt = me.dealt - this.epDealt0;
    this.epStart = world.time;
    this.epHurt0 = this.totalHurt;
    this.epDealt0 = me.dealt;
    const fought = this.epFought;
    this.epFought = false;
    // only fights say anything about fight settings; thrown objects are handled by imagination
    if (!fought || hurt + dealt < 1 || !this.learning) return;
    const fit = dealt - 1.2 * hurt;
    this.gen++;
    this.fitHistory.push(fit);
    if (this.fitHistory.length > 40) this.fitHistory.shift();
    if (this.gen === 1 || fit >= this.parentFit) {
      this.parent = { ...this.params };
      this.parentFit = this.gen === 1 ? fit : fit * 0.5 + this.parentFit * 0.5;
      if (this.gen > 1) { this.accepted++; this.sigma = Math.min(0.35, this.sigma * 1.25); }
    } else {
      this.sigma = Math.max(0.03, this.sigma * 0.85);
      // parent fitness was probably lucky: let it drift toward what we see
      this.parentFit = this.parentFit * 0.85 + fit * 0.15;
    }
    // next candidate
    for (const p of PARAMS) {
      const span = p.hi - p.lo;
      this.params[p.key] = clamp(this.parent[p.key] + gauss() * this.sigma * span, p.lo, p.hi);
    }
  }

  // ------------------------------------------------------------- policy

  think(world: World, dt: number) {
    const me = this.me;
    const ctrl = me.ctrl;
    for (const e of me.hurtLog) if (e.time > this.lastThink) this.totalHurt += e.amount;
    this.lastThink = world.time;
    this.stats.playTime += dt;
    me.hurtLog = me.hurtLog.filter((e) => e.time > world.time - 3);
    this.resolve(world);
    this.resolveStrike(world);
    this.episode(world);
    this.learn();
    this.attackCd -= dt;
    if (!me.alive) { ctrl.moveX = 0; return; }

    const enemy = this.enemyOf(world);
    this.scan(world, enemy);
    this.countRounds(world);
    if (enemy) this.epFought = true;
    const threats = this.perceiveAll(world);
    this.threats = threats;
    const threat = threats[0] ?? null;
    this.threat = threat;
    const p = this.params;
    const cx = me.pelvis.x;

    // -------- reactions: (re)plan whenever the set of incoming threats changes
    const soon = threats.filter((t) => t.ttc < 0.9);
    const key = soon.map((t) => t.source).join('|');
    const committed = this.pending?.fired && me.busy; // mid-move: can't change now
    // a new plan is only started once the previous one is finished, and the current
    // plan keeps running meanwhile (threats change nearly every frame under heavy fire)
    if (key !== this.planKey && !committed && !this.planning) {
      this.planKey = key;
      if (soon.length) {
        if (this.imagination) this.startPlanning(world, soon, key);
        else {
          if (this.pending && !this.pending.fired) this.pending = null;
          const r = this.choose(world, soon[0]);
          this.pending = { threat: soon[0], reaction: r, chosenAt: world.time, fireAt: world.time + Math.max(0, soon[0].ttc - this.lead(r)), endAt: world.time + soon[0].ttc + 0.45, fired: false };
        }
      }
    }
    if (this.planning && this.stepPlanning()) this.finishPlanning(world);
    const pd = this.pending;
    if (pd && !pd.fired && world.time >= pd.fireAt && me.canAct()) {
      // refresh the prediction if it is the same threat
      const t = threats.find((x) => x.source === pd.threat.source) ?? pd.threat;
      pd.fired = true;
      perform(me, pd.reaction, t);
      this.outcomes.push(pd);
    }
    if (pd && pd.fired && !me.busy && world.time > pd.endAt) this.pending = null;
    const reacting = pd !== null && pd.fired && me.busy;
    const running = this.runAway !== null && world.time < this.runAway.until;

    // -------- movement & attacks
    let move = 0;
    let face = ctrl.face;
    if (enemy) {
      const dx = enemy.pelvis.x - cx;
      const dist = Math.abs(dx);
      face = Math.sign(dx) || face;
      this.approachT -= dt;
      if (this.approachT <= 0) { this.approachT = rand(0.4, 0.9); this.approachRoll = Math.random(); }
      const lowHp = me.health < p.retreatHp * me.maxHealth && enemy.health > me.health;
      if (lowHp && dist < 220 && cx > 60 && cx < W - 60) move = -Math.sign(dx);
      else if (dist > this.strikeRange() - 5) move = this.approachRoll < p.aggression ? Math.sign(dx) : 0;
      else if (dist < this.strikeRange() - 25) move = -Math.sign(dx) * 0.6;
      ctrl.run = dist > 320;
      // common sense: never swing from beyond arm/leg reach, whatever the tuned range says
      if (!reacting && dist < this.strikeRange() && this.attackCd <= 0 && enemy.mode !== 'down' && me.canAct() && !me.busy) {
        const ea = enemy.action.kind;
        const o: OffenseInput = {
          dist,
          headH: GROUND - enemy.ps[HEAD].y,
          ducking: ea === 'duck' ? 1 : 0,
          blocking: ea === 'block' ? 1 : 0,
          airborne: enemy.mode === 'air' ? 1 : 0,
          attacking: ea === 'punch' || ea === 'kick' || ea === 'swing' ? 1 : 0,
          armed: me.weapon ? 1 : 0,
        };
        const a = this.chooseStrike(world, o);
        const kick = a === 1;
        const kind = (['punch', 'kick', 'swing'] as const)[a];
        const tgt = kick
          ? { x: enemy.pelvis.x, y: (enemy.ps[NECK].y + enemy.ps[PELVIS].y) / 2 + 8 }
          : { x: enemy.ps[HEAD].x, y: enemy.ps[HEAD].y + 4 };
        if (a >= 0 && me.start(kind, { target: tgt })) {
          this.attackCd = rand(0.5, 1.1) * p.tempo;
          this.strikePending = { x: toVec(OFFENSE_KEYS, o), a, endAt: world.time + (kick || kind === 'swing' ? 0.6 : 0.5), dealt0: me.dealt, hurt0: this.totalHurt };
        }
      }
    } else {
      const dx = (this.arena.cannonsOn ? W / 2 : this.home) - cx;
      move = Math.abs(dx) > 40 ? Math.sign(dx) : 0;
      ctrl.run = false;
      if (threat) face = Math.sign(threat.impact.x - cx) || -Math.sign(threat.vx) || face;
    }

    // -------- spikes: don't walk in; hop over when chasing
    if (move !== 0) {
      const ahead = cx + move * 45;
      const z = world.inSpikes(ahead, 10);
      if (z && !world.inSpikes(cx)) {
        if (enemy && Math.abs(enemy.pelvis.x - cx) > 60 && z.x1 - z.x0 < 180 && me.canAct() && !me.busy) {
          ctrl.moveX = move;
          ctrl.run = true;
          me.start('jump');
        } else move = 0;
      }
    }
    const inZ = world.inSpikes(cx);
    if (inZ && me.canAct()) { move = cx - inZ.x0 < inZ.x1 - cx ? -1 : 1; me.start('jump'); }

    // brace (stand still) once a reaction is planned, so it plays out as imagined
    const braced = (pd !== null && !pd.fired) || (this.planning !== null && this.threats.length > 0 && this.threats[0].ttc < 0.5);
    ctrl.moveX = (reacting && me.action.kind !== 'dodge') || braced ? 0 : move;
    ctrl.face = face;
    if (running) {
      ctrl.moveX = this.runAway!.dir;
      ctrl.run = true;
      ctrl.face = this.runAway!.dir;
    } else this.runAway = null;
  }
}
