import { Circuit, Wire, Terms } from './vendor/handwired/numeric-ui-core';

// ---------------------------------------------------------------------------
// The brain's decision rules as a Handwired circuit.
//
// The circuit is built from affine sums and ReLUs only, so it is exact and fully
// differentiable. Every rule constant (thresholds, per-situation preferences) is a
// *source cell*, not a baked coefficient: the initial values reproduce the
// hand-written rules exactly, and backprop through the circuit trains them.
//
// Defense head: threat features -> value of each reaction (duck/jump/dodge/block/ignore).
// Offense head: fight features  -> value of each strike (punch/kick).
// ---------------------------------------------------------------------------

export const REACTIONS = ['duck', 'jump', 'dodge', 'block', 'ignore', 'swat'] as const;
export type Reaction = (typeof REACTIONS)[number];
export const STRIKES = ['punch', 'kick', 'swing'] as const;
export type Strike = (typeof STRIKES)[number];

/**
 * Threat inputs. Kind bits are one-hot: exactly one of punch/kick/above/flying is 1.
 * harm = expected damage if it connects (from mass and closing speed), ttc = seconds
 * until contact, cornered = 1 when a wall or spikes block the escape route.
 */
export interface DefenseInput { height: number; speed: number; size: number; punch: number; kick: number; above: number; flying: number; harm: number; ttc: number; cornered: number; armed: number }
/** Fight inputs at the moment a strike is chosen. */
export interface OffenseInput { dist: number; headH: number; ducking: number; blocking: number; airborne: number; attacking: number; armed: number }

export const DEFENSE_KEYS: (keyof DefenseInput)[] = ['height', 'speed', 'size', 'punch', 'kick', 'above', 'flying', 'harm', 'ttc', 'cornered', 'armed'];
/** Values for inputs that older saved samples don't have. */
export const DEFENSE_DEFAULTS: Partial<DefenseInput> = { harm: 20, ttc: 0.5, cornered: 0, armed: 0 };
export const OFFENSE_KEYS: (keyof OffenseInput)[] = ['dist', 'headH', 'ducking', 'blocking', 'airborne', 'attacking', 'armed'];
export const OFFENSE_DEFAULTS: Partial<OffenseInput> = { armed: 0 };

interface Cell { name: string; lo: number; hi: number; init: number; trainable: boolean }

// Situations the defense rules distinguish, in circuit order.
const SITUATIONS = ['enemy punch', 'enemy kick', 'from above', 'high', 'mid', 'low'] as const;

/** Hand-written preferences [duck, jump, dodge, block, ignore] for a small threat, and the change for a big one. */
const RULES: Record<(typeof SITUATIONS)[number], { small: number[]; big: number[] }> = {
  'enemy punch': { small: [0.35, -0.1, 0.3, 0.4, -0.3], big: [0, 0, 0, 0, 0] },
  'enemy kick': { small: [-0.2, 0.3, 0.35, 0.3, -0.3], big: [0, 0, 0, 0, 0] },
  'from above': { small: [-0.3, -0.2, 0.5, 0.2, -0.3], big: [0, 0, 0, 0, 0] },
  high: { small: [0.5, -0.2, 0.3, 0.25, -0.3], big: [0, 0, 0, -0.25, 0] },
  mid: { small: [0.1, 0.15, 0.35, 0.2, -0.3], big: [0, 0, 0.1, -0.3, 0] },
  low: { small: [-0.3, 0.5, 0.3, -0.2, -0.3], big: [0, 0, 0, 0, 0] },
};

/**
 * Common sense, as rules on top of the per-situation ones, [duck, jump, dodge, block, ignore]:
 *  harmless: it can't hurt you, so don't waste a move (ignore it).
 *  heavy:    a block only saves your arms, so don't block things that hit hard; get out of the way.
 *  urgent:   no time left, so only fast moves work (block, duck); jumps and dodges are too slow.
 *  cornered: a wall or spikes behind you, so dodging is a bad idea.
 */
const SENSE: Record<'harmless' | 'heavy' | 'urgent' | 'cornered', number[]> = {
  harmless: [-0.3, -0.4, -0.5, -0.2, 1.0],
  heavy: [0, 0.1, 0.25, -0.6, -0.3],
  urgent: [0.1, -0.4, -0.6, 0.3, 0],
  cornered: [0, -0.1, -1.0, 0.15, 0],
};

/** Strike preferences [punch, kick, swing] per fight feature. */
const STRIKE_RULES: Record<string, number[]> = {
  bias: [0.5, 0.45, -1.0],
  armed: [0, 0, 1.6],          // can only swing when holding something
  ducking: [-0.6, 0.2, 0.1],   // a punch at head height whiffs over a ducking enemy
  blocking: [-0.3, -0.1, 0.2], // a block soaks punches; a weapon reaches over it
  airborne: [-0.3, -0.3, 0],
  attacking: [0.1, -0.1, 0],   // trade fast punches into a windup
  far: [-0.2, 0.15, 0.4],      // kicks and weapons reach further
};

/** Holding a weapon: swatting things away becomes an option (it starts unpreferred). */
const ARMED = { bias: [0, 0, 0, 0, 0, -1.0], armed: [0, 0, 0, 0, 0, 1.3] };
/**
 * Common sense with a weapon, [duck, jump, dodge, block, ignore, swat]:
 *  vs strikes: parry them (swat at the fist/foot) or guard behind the weapon.
 *  vs things flying at you: knock them away.
 */
const ARMED_VS = { enemy: [0, -0.1, 0, 0.35, 0, 0.7], projectile: [0, 0, 0, 0.1, 0, 0.3] };

export interface Sample { x: number[]; a: number; r: number }

export class PolicyNet {
  circuit: Circuit;
  cells: Cell[] = [];
  source: Float32Array;
  defenseOut: Wire[] = [];
  offenseOut: Wire[] = [];
  private index = new Map<string, number>();
  private trainIdx: number[] = [];
  private m: Float32Array;
  private v: Float32Array;
  steps = 0;
  lossEma = 0;

  constructor() {
    // ---- declare every source cell first (inputs, then trainable rule constants)
    const add = (name: string, lo: number, hi: number, init: number, trainable: boolean) => {
      this.index.set(name, this.cells.length);
      this.cells.push({ name, lo, hi, init, trainable });
    };
    add('in.height', 0, 400, 0, false);
    add('in.speed', 0, 4000, 0, false);
    add('in.size', 0, 300, 0, false);
    for (const k of ['punch', 'kick', 'above', 'flying']) add(`in.${k}`, 0, 1, 0, false);
    add('in.harm', 0, 100, 0, false);
    add('in.ttc', 0, 2, 0, false);
    add('in.cornered', 0, 1, 0, false);
    add('in.armed', 0, 1, 0, false);
    add('in.dist', 0, 1600, 0, false);
    add('in.headH', 0, 300, 0, false);
    for (const k of ['ducking', 'blocking', 'airborne', 'attacking']) add(`in.${k}`, 0, 1, 0, false);
    add('in.o.armed', 0, 1, 0, false);

    add('t.high', 40, 200, 95, true);
    add('t.low', 10, 120, 45, true);
    add('t.big', 4, 120, 22, true);
    add('t.fast', 100, 2500, 650, true);
    add('t.far', 30, 200, 85, true);
    add('t.harm', 0, 40, 3, true);
    add('t.urgent', 0.02, 1, 0.2, true);
    add('t.heavy', 5, 60, 18, true);
    (Object.keys(SENSE) as (keyof typeof SENSE)[]).forEach((k) => REACTIONS.forEach((r, i) => add(`c.${k}.${r}`, -5, 5, SENSE[k][i] ?? 0, true)));
    SITUATIONS.forEach((s) => REACTIONS.forEach((r, i) => {
      add(`w.${s}.${r}`, -5, 5, RULES[s].small[i] ?? 0, true);
      add(`wb.${s}.${r}`, -5, 5, RULES[s].big[i] ?? 0, true);
    }));
    // fast threats: you can't outrun them with a backstep, go over or under instead
    const FAST = [0.05, 0.15, -0.4, 0, 0];
    REACTIONS.forEach((r, i) => add(`wf.${r}`, -5, 5, FAST[i] ?? 0, true));
    REACTIONS.forEach((r, i) => { add(`b.${r}`, -5, 5, ARMED.bias[i], true); add(`wa.${r}`, -5, 5, ARMED.armed[i], true); });
    REACTIONS.forEach((r, i) => { add(`wae.${r}`, -5, 5, ARMED_VS.enemy[i], true); add(`wap.${r}`, -5, 5, ARMED_VS.projectile[i], true); });
    Object.keys(STRIKE_RULES).forEach((k) => STRIKES.forEach((s, i) => add(`s.${k}.${s}`, -5, 5, STRIKE_RULES[k][i], true)));

    const c = new Circuit(this.cells.length);
    this.circuit = c;
    this.cells.forEach((cell, i) => c.assumeRange(c.source(i), cell.lo, cell.hi));
    this.source = new Float32Array(this.cells.map((k) => k.init));
    this.trainIdx = this.cells.flatMap((k, i) => (k.trainable ? [i] : []));
    this.m = new Float32Array(this.cells.length);
    this.v = new Float32Array(this.cells.length);

    const S = (name: string) => c.source(this.index.get(name)!);
    const relu = (terms: Terms, bias: number) => c.reglu([], 1, terms, bias);
    // ramp: 0 below t - w/2, 1 above t + w/2, linear between (two ReLUs). Gradient reaches t.
    const ramp = (x: Wire, t: Wire, w: number) => {
      const a = relu([[x, 1 / w], [t, -1 / w]], 0.5);
      const b = relu([[x, 1 / w], [t, -1 / w]], -0.5);
      return c.affine([[a, 1], [b, -1]]);
    };

    // ---- defense head
    const height = S('in.height');
    const high = ramp(height, S('t.high'), 16);
    const notLow = ramp(height, S('t.low'), 16);
    const mid = c.affine([[notLow, 1], [high, -1]]);
    const low = c.affine([[notLow, -1]], 1);
    const flying = S('in.flying');
    const big = ramp(S('in.size'), S('t.big'), 6);
    const fast = ramp(S('in.speed'), S('t.fast'), 150);
    const situation: Wire[] = [
      S('in.punch'),
      S('in.kick'),
      S('in.above'),
      c.multiply(flying, high),
      c.multiply(flying, mid),
      c.multiply(flying, low),
    ];
    const bigSituation = situation.map((m) => c.multiply(m, big));
    const armedVsEnemy = c.multiply(S('in.armed'), c.affine([[S('in.punch'), 1], [S('in.kick'), 1]]));
    const armedVsThing = c.multiply(S('in.armed'), c.affine([[S('in.flying'), 1], [S('in.above'), 1]]));
    const sense: Record<keyof typeof SENSE, Wire> = {
      harmless: c.affine([[ramp(S('in.harm'), S('t.harm'), 4), -1]], 1),
      heavy: ramp(S('in.harm'), S('t.heavy'), 10),
      urgent: c.affine([[ramp(S('in.ttc'), S('t.urgent'), 0.1), -1]], 1),
      cornered: S('in.cornered'),
    };
    REACTIONS.forEach((r) => {
      const terms: [Wire, number][] = [];
      SITUATIONS.forEach((s, k) => {
        terms.push([c.multiply(S(`w.${s}.${r}`), situation[k]), 1]);
        terms.push([c.multiply(S(`wb.${s}.${r}`), bigSituation[k]), 1]);
      });
      terms.push([c.multiply(S(`wf.${r}`), fast), 1]);
      for (const k of Object.keys(SENSE) as (keyof typeof SENSE)[]) terms.push([c.multiply(S(`c.${k}.${r}`), sense[k]), 1]);
      terms.push([S(`b.${r}`), 1]);
      terms.push([c.multiply(S(`wa.${r}`), S('in.armed')), 1]);
      terms.push([c.multiply(S(`wae.${r}`), armedVsEnemy), 1]);
      terms.push([c.multiply(S(`wap.${r}`), armedVsThing), 1]);
      this.defenseOut.push(c.affine(terms));
    });

    // ---- offense head
    const far = ramp(S('in.dist'), S('t.far'), 30);
    const feats: Record<string, Wire | null> = {
      bias: null,
      ducking: S('in.ducking'),
      blocking: S('in.blocking'),
      airborne: S('in.airborne'),
      attacking: S('in.attacking'),
      armed: S('in.o.armed'),
      far,
    };
    STRIKES.forEach((s) => {
      const terms: [Wire, number][] = [];
      for (const k of Object.keys(STRIKE_RULES)) {
        const f = feats[k];
        terms.push([f ? c.multiply(S(`s.${k}.${s}`), f) : S(`s.${k}.${s}`), 1]);
      }
      this.offenseOut.push(c.affine(terms));
    });
  }

  get opCount() { return this.circuit.operations.length; }
  get weightCount() { return this.trainIdx.length; }

  private setInputs(d: DefenseInput | null, o: OffenseInput | null) {
    const put = (name: string, v: number) => {
      const i = this.index.get(name)!;
      const k = this.cells[i];
      this.source[i] = fit(v, k);
    };
    for (const k of DEFENSE_KEYS) put(`in.${k}`, d ? d[k] : 0);
    for (const k of OFFENSE_KEYS) put(k === 'armed' ? 'in.o.armed' : `in.${k}`, o ? o[k] : 0);
  }

  defense(d: DefenseInput): number[] {
    this.setInputs(d, null);
    const v = this.circuit.evaluateReference(this.source);
    return this.defenseOut.map((w) => v[w]);
  }

  offense(o: OffenseInput): number[] {
    this.setInputs(null, o);
    const v = this.circuit.evaluateReference(this.source);
    return this.offenseOut.map((w) => v[w]);
  }

  /**
   * One Adam step on a minibatch. Loss per sample = 0.5 (Q(x, a) - r)^2, i.e. learn
   * how good each choice turned out in situations like this one.
   */
  train(defense: Sample[], offense: Sample[], lr = 0.05) {
    const n = defense.length + offense.length;
    if (n === 0) return;
    const grad = new Float64Array(this.cells.length);
    let loss = 0;
    const width = this.circuit.sourceSize + this.circuit.operations.length;
    const run = (s: Sample, isDefense: boolean) => {
      if (isDefense) this.setInputs(fromVec(DEFENSE_KEYS, s.x) as unknown as DefenseInput, null);
      else this.setInputs(null, fromVec(OFFENSE_KEYS, s.x) as unknown as OffenseInput);
      const values = this.circuit.evaluateReference(this.source);
      const out = (isDefense ? this.defenseOut : this.offenseOut)[s.a];
      const err = values[out] - s.r;
      loss += 0.5 * err * err;
      const og = new Float32Array(width);
      og[out] = err;
      const g = this.circuit.backpropagateReference(values, og);
      for (const i of this.trainIdx) grad[i] += g[i];
    };
    for (const s of defense) run(s, true);
    for (const s of offense) run(s, false);
    this.steps++;
    const b1 = 0.9, b2 = 0.999;
    for (const i of this.trainIdx) {
      const k = this.cells[i];
      // thresholds live on a much bigger scale than preference weights
      const scale = k.name.startsWith('t.') ? (k.hi - k.lo) * 0.05 : 1;
      const g = grad[i] / n;
      this.m[i] = b1 * this.m[i] + (1 - b1) * g;
      this.v[i] = b2 * this.v[i] + (1 - b2) * g * g;
      const mh = this.m[i] / (1 - b1 ** this.steps), vh = this.v[i] / (1 - b2 ** this.steps);
      const next = this.source[i] - lr * scale * (mh / (Math.sqrt(vh) + 1e-8));
      this.source[i] = fit(next, k);
    }
    this.lossEma = this.steps === 1 ? loss / n : this.lossEma * 0.98 + (loss / n) * 0.02;
  }

  /** Trainable values by name (stable across code changes that add cells). */
  weights(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const i of this.trainIdx) out[this.cells[i].name] = this.source[i];
    return out;
  }

  load(w: Record<string, number>, steps = 0) {
    for (const i of this.trainIdx) {
      const k = this.cells[i];
      const v = w[k.name];
      if (typeof v === 'number' && Number.isFinite(v)) this.source[i] = fit(v, k);
    }
    this.steps = steps;
    this.m.fill(0);
    this.v.fill(0);
  }

  /** How far each trained value has moved from the hand-written rule. */
  drift(): { name: string; init: number; now: number }[] {
    return this.trainIdx.map((i) => ({ name: this.cells[i].name, init: this.cells[i].init, now: this.source[i] }));
  }
}

/** Clamp into a cell's declared range so it still holds after FP32 rounding (Handwired checks). */
function fit(v: number, k: Cell): number {
  let f = Math.fround(Math.min(k.hi, Math.max(k.lo, v)));
  if (f < k.lo) f = Math.fround(k.lo + Math.abs(k.lo) * 1e-6 + 1e-7);
  if (f > k.hi) f = Math.fround(k.hi - Math.abs(k.hi) * 1e-6 - 1e-7);
  return f;
}

export function toVec<T extends object>(keys: (keyof T)[], o: T): number[] {
  return keys.map((k) => o[k] as number);
}
function fromVec(keys: string[], x: number[]): Record<string, number> {
  const o: Record<string, number> = {};
  keys.forEach((k, i) => (o[k] = x[i]));
  return o;
}
