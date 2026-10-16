import '@fontsource/patrick-hand';
import '@fontsource/caveat/700.css';
import { animate } from 'motion';
import { DT, GROUND, H, W, setArenaHeight } from './physics';
import { makeSolid, reshape, inside, bounds as solidBounds, sitsOnGround, SolidKind } from './terrain';
import { Stickman } from './stickman';
import { World, SPIKE_W, newId } from './world';
import { render, theme, Overlay } from './render';
import { bodyFromStroke } from './draw';
import { Vec, clamp } from './math';
import { Brain } from './ai';
import { Hud, drawThreat, drawThoughts } from './hud';
import { loadBrain, saveBrain, saveOnExit } from './persist';
import { Effects } from './effects';
import { Palette, ItemKind } from './palette';
import { Workshop } from './workshop';
import { ICONS } from './icons';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
let th = theme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => (th = theme()));

// ------------------------------------------------------------------ world + fighters

const world = new World();
const hero = new Stickman(W * 0.4, 0, '#2f6fe4', 'Blue');
world.men.push(hero);
const heroBrain = new Brain(hero, W * 0.4);
const ENEMY_KINDS = [
  { name: 'Red', color: '#d64545' },
  { name: 'Green', color: '#2f9e5a' },
  { name: 'Purple', color: '#8e4ec6' },
];
const enemies: Brain[] = [];
const brains = (): Brain[] => [heroBrain, ...enemies];

const fx = new Effects();
const ov: Overlay = { stroke: [], strokeColor: '#c0392b', debug: false, hover: null };
const qs = new URLSearchParams(location.search);
const state = { paused: false, slow: false, manual: qs.has('manual') };
ov.extra = (c) => {
  if (ov.debug && !state.manual) drawThreat(c, heroBrain);
  fx.draw(c, th);
  drawThoughts(c, brains().filter((b) => !(state.manual && b === heroBrain)), th);
};

// ------------------------------------------------------------------ view transform

let scale = 1, offX = 0, offY = 0;
function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  // the arena is always 1600 wide; its height follows the stage so there are no empty bands
  const want = Math.round(clamp((W * r.height) / Math.max(1, r.width), 640, 1400));
  if (Math.abs(want - H) > 2) resizeArena(want);
  scale = Math.min(r.width / W, r.height / H);
  offX = (r.width - W * scale) / 2;
  offY = (r.height - H * scale) / 2;
}

/** Change the arena height, keeping everything at the same distance from the floor. */
function resizeArena(h: number) {
  const dy = h - 80 - GROUND;
  setArenaHeight(h);
  for (const m of world.men) for (const p of m.ps) p.shift(0, dy);
  for (const b of world.bodies) { b.y += dy; b.updateWorld(); }
  for (const c of world.cannons) c.y += dy;
  for (const c of world.clouds) c.y += dy;
  for (const s of world.solids) { s.y += dy; reshape(s); }
}
new ResizeObserver(resize).observe(canvas);
resize();

function toWorld(clientX: number, clientY: number): Vec {
  const r = canvas.getBoundingClientRect();
  return { x: (clientX - r.left - offX) / scale, y: (clientY - r.top - offY) / scale };
}
const inArena = (p: Vec) => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= GROUND + 10;

// ------------------------------------------------------------------ placing items

function place(kind: ItemKind, p: Vec): boolean {
  if (!inArena(p)) return false;
  const x = clamp(p.x, 30, W - 30);
  switch (kind) {
    case 'spikes': {
      const x0 = clamp(p.x - SPIKE_W / 2, 0, W - SPIKE_W);
      world.spikes.push({ id: newId(), x0, x1: x0 + SPIKE_W });
      fx.dust(x0 + SPIKE_W / 2, GROUND, 10);
      break;
    }
    case 'cannon':
      world.cannons.push({ id: newId(), x, y: clamp(p.y, 40, GROUND - 22), cd: 1.2, period: 2.8, flash: 0 });
      fx.dust(x, clamp(p.y, 40, GROUND - 22) + 20, 6);
      break;
    case 'cloud':
      world.clouds.push({ id: newId(), x, y: clamp(p.y, 50, GROUND - 260), cd: 0.8 });
      break;
    case 'enemy': {
      const kindIdx = ENEMY_KINDS.findIndex((k) => !enemies.some((e) => e.me.name === k.name));
      if (kindIdx < 0) { palette.wiggle('enemy'); return false; }
      const k = ENEMY_KINDS[kindIdx];
      const m = new Stickman(x, 1 + kindIdx, k.color, k.name);
      // appear right at the cursor (drops from there if it's in the air)
      m.teleport(x, Math.min(p.y, world.surfaceAt(x, p.y) - 56));
      m.facing = Math.sign(hero.pelvis.x - x) || -1;
      world.men.push(m);
      const b = new Brain(m, x);
      b.scripted();
      enemies.push(b);
      fx.dust(x, GROUND, 12);
      break;
    }
    case 'ramp':
    case 'platform':
    case 'wall':
    case 'trampoline': {
      const y = sitsOnGround(kind) ? GROUND : clamp(p.y, 140, GROUND - 70);
      // ramps rise toward the middle of the arena by default
      world.solids.push(makeSolid(newId(), kind as SolidKind, clamp(x, 140, W - 140), y, kind === 'ramp' && x > W / 2 ? -1 : 1));
      fx.dust(x, y, 10);
      break;
    }
  }
  return true;
}

type Held = { kind: 'man' | 'cannon' | 'cloud' | 'spikes' | 'solid'; id: number; dx: number; dy: number };

/** What placed item (if any) is under this arena point. id = man index or item id. */
function itemAt(p: Vec): Held | null {
  for (let i = world.men.length - 1; i >= 0; i--) {
    const b = world.men[i].bounds();
    if (p.x > b.x0 - 10 && p.x < b.x1 + 10 && p.y > b.y0 - 14 && p.y < b.y1 + 6) return { kind: 'man', id: i, dx: world.men[i].pelvis.x - p.x, dy: world.men[i].pelvis.y - p.y };
  }
  for (const c of world.cannons) if (Math.abs(p.x - c.x) < 36 && Math.abs(p.y - c.y) < 30) return { kind: 'cannon', id: c.id, dx: c.x - p.x, dy: c.y - p.y };
  for (const c of world.clouds) if (Math.abs(p.x - c.x) < 66 && Math.abs(p.y - c.y) < 36) return { kind: 'cloud', id: c.id, dx: c.x - p.x, dy: c.y - p.y };
  for (const z of world.spikes) if (p.x > z.x0 - 4 && p.x < z.x1 + 4 && p.y > GROUND - 44 && p.y < GROUND + 16) return { kind: 'spikes', id: z.id, dx: z.x0 - p.x, dy: 0 };
  for (const s of world.solids) {
    const b = solidBounds(s);
    const near = p.x > b.x0 - 6 && p.x < b.x1 + 6 && p.y > b.y0 - 6 && p.y < b.y1 + 6;
    if (near && (inside(s, p.x, p.y) || b.y1 - b.y0 < 30)) return { kind: 'solid', id: s.id, dx: s.x - p.x, dy: s.y - p.y };
  }
  return null;
}

function moveHeld(h: Held, p: Vec) {
  const x = clamp(p.x + h.dx, 20, W - 20);
  if (h.kind === 'man') {
    const m = world.men[h.id];
    if (!m) return;
    // follows the cursor, in the air too; lets go and falls on release
    m.teleport(x, Math.min(p.y + h.dy, world.surfaceAt(x, p.y + h.dy) - 56));
    const b = brains().find((bb) => bb.me === m);
    if (b) b.home = x;
  } else if (h.kind === 'cannon') {
    const c = world.cannons.find((k) => k.id === h.id);
    if (c) { c.x = x; c.y = clamp(p.y + h.dy, 40, GROUND - 22); }
  } else if (h.kind === 'cloud') {
    const c = world.clouds.find((k) => k.id === h.id);
    if (c) { c.x = x; c.y = clamp(p.y + h.dy, 50, GROUND - 260); }
  } else if (h.kind === 'solid') {
    const s = world.solids.find((k) => k.id === h.id);
    if (!s) return;
    s.x = clamp(p.x + h.dx, 140, W - 140);
    // ground pieces stay on the floor; platforms float wherever you put them
    s.y = sitsOnGround(s.kind) ? GROUND : clamp(p.y + h.dy, 140, GROUND - 70);
    reshape(s);
  } else {
    const z = world.spikes.find((k) => k.id === h.id);
    if (z) { z.x0 = clamp(p.x + h.dx, 0, W - SPIKE_W); z.x1 = z.x0 + SPIKE_W; }
  }
}

function removeHeld(h: Held): boolean {
  if (h.kind === 'man') {
    const m = world.men[h.id];
    if (!m || m === hero) return false; // the hero stays
    const b = enemies.find((e) => e.me === m);
    if (b) enemies.splice(enemies.indexOf(b), 1);
    world.men.splice(h.id, 1);
    fx.dust(m.pelvis.x, GROUND, 14);
    return true;
  }
  if (h.kind === 'cannon') world.cannons = world.cannons.filter((k) => k.id !== h.id);
  if (h.kind === 'cloud') world.clouds = world.clouds.filter((k) => k.id !== h.id);
  if (h.kind === 'spikes') world.spikes = world.spikes.filter((k) => k.id !== h.id);
  if (h.kind === 'solid') world.solids = world.solids.filter((k) => k.id !== h.id);
  return true;
}

// ------------------------------------------------------------------ arena input: draw, or drag placed items

const COLORS = ['#c0392b', '#8e44ad', '#16a085', '#d35400', '#2c3e50', '#b8860b'];
let colorIdx = 0;
/** Seconds a drawing lives before it's erased. */
const DRAWN_LIFE = 3.5;
let drawing = false;
let strokeTimes: number[] = [];
let held: Held | null = null;
const hint = document.getElementById('hint')!;
hint.innerHTML = `${ICONS.pencil}<span>draw anything · flick to throw it</span>`;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
// double-click a ramp to flip which way it rises
canvas.addEventListener('dblclick', (e) => {
  const h = itemAt(toWorld(e.clientX, e.clientY));
  const s = h?.kind === 'solid' ? world.solids.find((k) => k.id === h.id) : null;
  if (s && s.kind === 'ramp') { s.flip = -s.flip; reshape(s); fx.dust(s.x, s.y, 6); }
});
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = toWorld(e.clientX, e.clientY);
  held = itemAt(p);
  if (held) { canvas.classList.add('grabbing'); return; }
  drawing = true;
  ov.strokeColor = COLORS[colorIdx % COLORS.length];
  ov.stroke = [p];
  strokeTimes = [performance.now()];
});
canvas.addEventListener('pointermove', (e) => {
  const p = toWorld(e.clientX, e.clientY);
  if (held) {
    moveHeld(held, p);
    palette.trash(!(held.kind === 'man' && world.men[held.id] === hero), e.clientX, e.clientY);
    return;
  }
  if (drawing) {
    const last = ov.stroke[ov.stroke.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) > 2) { ov.stroke.push(p); strokeTimes.push(performance.now()); }
    return;
  }
  // hover: highlight draggable items
  const h = itemAt(p);
  ov.hover = h ? { kind: h.kind, id: h.id } : null;
  canvas.classList.toggle('grab', !!h);
});
canvas.addEventListener('pointerleave', () => { if (!held && !drawing) { ov.hover = null; canvas.classList.remove('grab'); } });
canvas.addEventListener('pointerup', (e) => {
  if (held) {
    const hot = palette.trash(!(held.kind === 'man' && world.men[held.id] === hero), e.clientX, e.clientY);
    if (hot) {
      const kind: ItemKind = held.kind === 'man' ? 'enemy' : held.kind === 'solid' ? (world.solids.find((s) => s.id === held!.id)?.kind ?? 'ramp') : held.kind;
      if (removeHeld(held)) palette.wiggle(kind);
    }
    palette.trash(false);
    held = null;
    canvas.classList.remove('grabbing');
    return;
  }
  if (!drawing) return;
  drawing = false;
  const b = bodyFromStroke(ov.stroke, COLORS[colorIdx++ % COLORS.length]);
  if (b) {
    // flick: velocity of the last ~70ms of the stroke becomes the throw
    const now = performance.now();
    let i = strokeTimes.length - 1;
    while (i > 0 && now - strokeTimes[i] < 70) i--;
    const dt = (now - strokeTimes[i]) / 1000;
    const a = ov.stroke[i], z = ov.stroke[ov.stroke.length - 1];
    if (dt > 0.01 && now - strokeTimes[strokeTimes.length - 1] < 60) {
      const k = clamp(1 / dt, 0, 60);
      b.vx = clamp((z.x - a.x) * k, -1600, 1600);
      b.vy = clamp((z.y - a.y) * k, -1600, 1600);
    }
    b.life = DRAWN_LIFE;
    world.bodies.push(b);
    hint.style.opacity = '0';
  }
  ov.stroke = [];
});

// ------------------------------------------------------------------ item grid under the arena

const palette = new Palette(document.getElementById('palette')!, {
  drop: (kind, cx, cy) => place(kind, toWorld(cx, cy)),
  preview: () => {},
});

// ------------------------------------------------------------------ weapon workshop

const workshop = new Workshop(
  document.getElementById('pad') as HTMLCanvasElement,
  document.getElementById('giveBtn') as HTMLButtonElement,
  document.getElementById('eraseBtn') as HTMLButtonElement,
  document.getElementById('dropBtn') as HTMLButtonElement,
  document.getElementById('padStats')!,
);
workshop.onGive = (w) => {
  hero.equip(w);
  heroBrain.thought = { text: 'Ooh, a new toy!', at: hero.time, mood: 'good' };
  void saveBrain(heroBrain, true);
};
workshop.onDrop = () => {
  hero.equip(null);
  heroBrain.thought = { text: 'Hey! I was using that.', at: hero.time, mood: 'bad' };
  void saveBrain(heroBrain, true);
};
void loadBrain(heroBrain).then(() => {
  if (hero.weapon) workshop.show(hero.weapon);
  lessonAt = heroBrain.lessons[0]?.at ?? -1; // only lessons learned from now on get a lightbulb
});

// ------------------------------------------------------------------ keyboard (manual control)

const keys = new Set<string>();
addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  keys.add(e.code);
  if (e.code === 'KeyP') togglePause();
  if (e.code === 'KeyG') ov.debug = !ov.debug;
  if (!state.manual) return;
  const f = hero.facing;
  const head = { x: hero.pelvis.x + 90 * f, y: hero.ps[1].y };
  if (e.code === 'KeyW') hero.start('jump');
  if (e.code === 'KeyJ') hero.start('punch', { target: head });
  if (e.code === 'KeyK') hero.start('kick', { target: { x: hero.pelvis.x + 70 * f, y: hero.pelvis.y - 10 } });
  if (e.code === 'KeyF' && hero.weapon) hero.start('swing', { target: { x: hero.pelvis.x + 90 * f, y: hero.ps[1].y + 20 } });
  if (e.code === 'KeyL') hero.start('block');
  if (e.code === 'KeyS') hero.start('duck');
  if (e.code === 'Space') { e.preventDefault(); hero.start('dodge', { dir: -f }); }
});
addEventListener('keyup', (e) => keys.delete(e.code));

function manualControl() {
  const l = keys.has('KeyA') || keys.has('ArrowLeft');
  const r = keys.has('KeyD') || keys.has('ArrowRight');
  const mx = (r ? 1 : 0) - (l ? 1 : 0);
  hero.ctrl.moveX = mx;
  hero.ctrl.run = keys.has('ShiftLeft') || keys.has('ShiftRight');
  if (mx !== 0) hero.ctrl.face = mx;
}

// ------------------------------------------------------------------ header controls

const controls = document.getElementById('controls')!;
const label = (icon: string, text: string) => `${icon}<span>${text}</span>`;
function button(html: string, title: string, onClick: (b: HTMLButtonElement) => void, on = false) {
  const b = document.createElement('button');
  b.className = 'sketch';
  b.innerHTML = html;
  b.title = title;
  b.classList.toggle('on', on);
  b.onclick = () => { onClick(b); animate(b, { rotate: [0, -5, 4, 0] }, { duration: 0.3 }); };
  controls.appendChild(b);
  return b;
}
const pauseBtn = button(label(ICONS.pause, 'Pause'), 'Pause (P)', () => togglePause());
function togglePause() {
  state.paused = !state.paused;
  pauseBtn.classList.toggle('on', state.paused);
  pauseBtn.innerHTML = state.paused ? label(ICONS.play, 'Play') : label(ICONS.pause, 'Pause');
}
button(label(ICONS.snail, 'Slow-mo'), 'Quarter speed', (b) => { state.slow = !state.slow; b.classList.toggle('on', state.slow); });
button(label(ICONS.eraser, 'Reset'), 'Clear the arena: drawings, rocks, traps, terrain, cannons, clouds and enemies (brains are kept)', () => resetArena());

/** Wipe the arena back to just Blue. Learned brains stay saved. */
function resetArena() {
  for (const b of world.bodies) world.events.push({ type: 'erase', body: b });
  world.bodies = [];
  for (const z of world.spikes) fx.dust((z.x0 + z.x1) / 2, GROUND, 6);
  for (const c of world.cannons) fx.dust(c.x, c.y, 6);
  for (const c of world.clouds) fx.dust(c.x, c.y, 6);
  world.spikes = [];
  world.cannons = [];
  world.clouds = [];
  for (const s of world.solids) fx.dust(s.x, s.y, 6);
  world.solids = [];
  for (const e of enemies) fx.dust(e.me.pelvis.x, GROUND, 10);
  world.men = [hero];
  enemies.length = 0;
  hero.respawn(W * 0.4);
  heroBrain.home = W * 0.4;
  ov.stroke = [];
  drawing = false;
}
button(label(ICONS.brain, 'Learning'), 'Let the AI keep learning', (b) => { heroBrain.learning = !heroBrain.learning; b.classList.toggle('on', heroBrain.learning); }, true);
button(label(ICONS.joystick, 'Drive Blue'), 'Control Blue yourself: A/D move, W jump, S duck, J punch, K kick, F swing, L block, Space dodge', (b) => { state.manual = !state.manual; b.classList.toggle('on', state.manual); }, state.manual);

// ------------------------------------------------------------------ panel + saving

const hud = new Hud(document.getElementById('hud')!);
// only Blue learns, so only Blue's brain is saved; enemies run on fixed logic
setInterval(() => void saveBrain(heroBrain), 5000);
saveOnExit(() => [heroBrain]);
let hudT = 0;
let lessonAt: number | null = null; // null until the saved brain has loaded

// ------------------------------------------------------------------ loop

function tick(dt: number) {
  if (state.manual) manualControl();
  for (const b of brains()) if (!(state.manual && b === heroBrain)) b.think(world, dt);
  acc += dt;
  while (acc >= DT) { world.step(); acc -= DT; }
  world.frame(dt);
  fx.consume(world.events, th);
  // Blue gets back up; a knocked-out enemy is gone for good (drag in a new one)
  if (hero.koT <= 0 && hero.health <= 0) hero.respawn(heroBrain.home);
  for (const b of [...enemies]) {
    if (b.me.koT > 0 || b.me.health > 0) continue;
    enemies.splice(enemies.indexOf(b), 1);
    world.men = world.men.filter((m) => m !== b.me);
    fx.dust(b.me.pelvis.x, b.me.pelvis.y, 16);
  }
  // a new lesson: lightbulb over his head
  const newest = heroBrain.lessons[0]?.at ?? -1;
  if (lessonAt !== null && newest !== lessonAt && newest >= 0) fx.aha(hero.head.x + 18, hero.head.y - 40);
  if (lessonAt !== null) lessonAt = newest;
}

let last = performance.now();
let acc = 0;
function frame(now: number) {
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (state.slow) dt *= 0.25;
  if (!state.paused) tick(dt);
  fx.step(state.paused ? 0 : dt);
  hudT -= dt;
  if (hudT <= 0) { hudT = 0.2; hud.update(heroBrain, enemies); }

  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = th.paper;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const sh = fx.offset();
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (offX + sh.x * scale), dpr * (offY + sh.y * scale));
  render(ctx, world, ov, th, now / 1000);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------ testing aid
/** Fast-forward the game synchronously. onFrame runs before each 1/60 s frame. */
function sim(seconds: number, onFrame?: (t: number) => void) {
  for (let t = 0; t < seconds; t += 1 / 60) { onFrame?.(t); tick(1 / 60); }
  hud.update(heroBrain, enemies);
}
(window as unknown as { game: unknown }).game = { world, hero, heroBrain, enemies, state, sim, brains, place, fx };
