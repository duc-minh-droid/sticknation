import type { Threat } from './ai';
import type { Reaction } from './policy';

// Plain-English wording for what the brain sees, decides and learns.

const DO: Record<Reaction, string> = { duck: 'duck', jump: 'jump', dodge: 'dodge', block: 'block', ignore: 'ignore it', swat: 'whack it' };
const DOING: Record<Reaction, string> = { duck: 'ducking', jump: 'jumping', dodge: 'dodging', block: 'blocking', ignore: 'ignoring it', swat: 'whacking it' };
const LESSON_DO: Record<Reaction, string> = { duck: 'Duck under', jump: 'Jump over', dodge: 'Dodge', block: 'Block', ignore: 'Ignore', swat: 'Whack away' };

function where(t: Threat) {
  if (t.input.above) return 'falling on me';
  return t.height > 95 ? '→ my head' : t.height > 45 ? '→ my body' : '→ my feet';
}

/** e.g. "Big rock falling on me → dodge! (only dodging works)" */
export function thinkDefense(t: Threat, r: Reaction, imagined: number[] | null, reactions: readonly Reaction[]): string {
  const big = t.input.size > 22 ? 'Big ' : '';
  const name = t.what === 'punch' ? 'Punch' : t.what === 'kick' ? 'Kick' : `${big}${big ? t.what : t.what[0].toUpperCase() + t.what.slice(1)}`;
  const head = t.what === 'punch' || t.what === 'kick' ? `${name}!` : `${name} ${where(t)}`;
  let why = '';
  if (imagined) {
    const ok = imagined.filter((v) => v > 0).length;
    if (ok === 0) why = 'nothing works, brace';
    else if (ok === 1 && imagined[reactions.indexOf(r)] > 0) why = `only ${DOING[r]} works`;
  }
  if (!why) {
    if (r === 'ignore' && t.input.harm < 3) why = "it can't hurt me";
    else if (t.input.cornered && r !== 'dodge') why = 'no room behind me';
    else if (t.input.harm > 18 && r !== 'block' && r !== 'ignore') why = 'too heavy to block';
    else if (t.input.speed > 650 && (r === 'jump' || r === 'duck')) why = 'too fast to outrun';
  }
  return `${head} → ${DO[r]}!${why ? ` (${why})` : ''}`;
}

export function thinkStrike(kind: 'punch' | 'kick' | 'swing', o: { ducking: number; blocking: number; airborne: number; attacking: number; dist: number }): string {
  const why = kind === 'swing' && o.dist > 66 ? 'out of fist range' : o.ducking ? "he's ducking" : o.blocking ? "he's blocking" : o.attacking ? 'beat him to it' : o.airborne ? "he's in the air" : '';
  const word = kind === 'swing' ? 'Swing' : kind === 'kick' ? 'Kick' : 'Punch';
  return `${word}!${why ? ` (${why})` : ''}`;
}

/** "small fast high" -> "fast things at my head" */
export function situation(key: string): string {
  if (key === 'enemy punch') return 'punches';
  if (key === 'enemy kick') return 'kicks';
  const big = key.startsWith('big') ? 'big ' : '';
  if (key.endsWith('from above')) return `${big}things falling on me`;
  const fast = key.includes(' fast ') ? 'fast ' : 'slow ';
  const at = key.endsWith('high') ? 'at my head' : key.endsWith('mid') ? 'at my body' : 'at my feet';
  return `${fast}${big}things ${at}`;
}

export function lesson(key: string, now: Reaction, before: Reaction, failed: boolean): string {
  return `${LESSON_DO[now]} ${situation(key)}${failed ? ` (${DOING[before]} got me hit)` : ''}`;
}
