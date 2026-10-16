# Stick Nation

A notebook-doodle stickman sandbox where a physics-driven stickman **learns to survive whatever you throw at him** — things you draw, cannons, rain, spikes, terrain and enemy fighters. His decision-making runs on a [Handwired](https://github.com/chenglou/handwired) circuit that starts out as hand-written rules and keeps training itself from experience, and his brain is saved to disk so he keeps getting better across sessions.

Everything is drawn like pencil on ruled paper: lines "boil" like hand-drawn animation, hits pop with comic POW!/WHAM! bursts, and he tells you what he's thinking in speech bubbles.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173. Requires Node 18+ (developed on Node 24).

The dev server is also what saves the AI: brains are written to `brains/<name>.json` through a small endpoint in `vite.config.ts`, so run it with `npm run dev` (a static build plays fine but won't save learning).

## How to play

- **Draw anywhere in the arena** to create an object. A quick flick at the end of the stroke throws it. Closed shapes are filled and heavier. Drawings get erased after a few seconds.
- **Drag items from the grid under the arena** into the scene: enemy, cannon, spikes, rain cloud, ramp, platform, wall, trampoline.
- **Drag placed items** to move them (enemies can be dropped from mid-air). Drag them back onto the grid to remove them. Double-click a ramp to flip it.
- **Zoom:** scroll to zoom toward the cursor (or the + / − / fit buttons); right- or middle-drag to pan.
- **Abilities** (side panel) — pick one:
  - **Base:** he carries a stick. *Swing* is quick; *heavy swing* has a slow windup but breaks blocks and parries. Draw your own weapon on the pad (start where he holds it) to replace the stick — longer ink = heavier, slower, harder-hitting. He also uses the weapon to parry punches and swat away projectiles.
  - **Telekinesis:** no stick. He grabs the newest of your drawings in reach (not ones you're throwing at him), keeps it floating beside him, **shields** with it, and **slams** it into enemies from range. Draw a new one and he swaps to it. Held drawings aren't erased, and his own drawing never hurts him.
- **Header:** Pause (P), Slow-mo, Reset (clears the arena; his brain is kept), Learning on/off, Drive Blue.
- **Drive Blue** (manual): A/D move, Shift run, W jump, S duck, J punch, K kick, F swing, H heavy swing, L block, Space dodge.

The side panel explains him in plain words: a report card (dodges, hits, rounds), his stats, what he's thinking, the lessons he's learned, and a progress chart per minute played. *Nerd stats* at the bottom shows the circuit internals.

### Stats and growth

Blue has six stats — **swing speed, power, reflexes, agility, toughness, balance** — that change how his body actually moves (faster actions, longer jumps, harder hits, less damage, harder to knock over). He earns a small boost by **learning well**: a new lesson (at most every 30 s), 10 clean defences in a row, or winning a round. Boosts shrink as a stat climbs (max +60%). Every 8 levels in total he **grows 6% bigger** (up to 1.5×): longer reach, more weight. His stats are inputs to his decision circuit and his imagined copy has them too, so the AI plans with what his body can do now.

## How the AI works

Blue's brain (`src/ai.ts`) has three layers:

1. **Perception and common sense.** He predicts the flight path of every object and every enemy strike, and knows the whole arena (walls, spikes, cannons and when they fire next, terrain, enemies). Built-in common sense: ignore things that can't hurt, don't block heavy hits, you can't outrun a fast projectile, don't dodge into a wall or spikes, never swing from out of reach.
2. **Imagination (planning).** When threats are coming he freezes a copy of the arena — every flying object, every enemy running its fixed logic, cannons about to fire — and replays the next second or so once per option: duck, jump, dodge, block, ignore, swat (if armed), shield (with telekinesis), run left, run right. He picks the option that takes the least total damage, and re-plans as new threats arrive. The planner is spread over frames so it doesn't stutter.
3. **Learning.**
   - A **Handwired circuit** (`src/policy.ts`, 471 ops built from affine sums and ReLUs, 240 trainable weights) scores reactions to each kind of threat and chooses punch / kick / swing / heavy swing / slam. Its weights are initialised so it computes the hand-written rules *exactly*, then it trains by backpropagation on every real and imagined outcome. Training is tuned to generalise: a modest learning rate, a long replay memory sampled mostly uniformly, and a gentle pull back toward the starting rules so one odd outcome can't rewrite what he knows.
   - A **(1+1) evolution strategy** tunes his continuous fighting knobs (reaction timing, aggression, spacing, tempo) from fight results.
   - Everything — weights, experience, stats, lessons, his ability and weapon — is saved to `brains/Blue.json` and reloaded on start.

Enemies are deliberately simple: hard-coded brawlers that press in and attack, with no learning and no thought bubbles. Place as many as you like; they all gang up on Blue. Because their logic is fixed, Blue's imagination can predict them exactly. A knocked-out enemy is gone until you drag in a new one.

## Physics

Custom 2D engine (`src/physics.ts`, `src/stickman.ts`, `src/world.ts`, `src/terrain.ts`):

- **Stickman:** an 11-point Verlet ragdoll with PD "muscles" on 9 joints (with anatomical limits), two-bone IK for legs and arms, a stepping gait, and balance assists. Muscles conserve momentum, so he only moves by pushing on the ground. He goes limp when knocked down and gets back up.
- **Objects:** rigid bodies made of circles with impulse-based contacts, friction, rolling resistance and resting stabilisation. Fast objects are swept in small slices so they can't tunnel through limbs.
- **Terrain:** convex polygons that stickmen stand and walk on (ramps, platforms, walls, trampolines).
- **Arena:** always 1600 wide; its height follows your window so the whole stage is used.

## Project layout

| Path | What's in it |
|---|---|
| `src/main.ts` | App wiring: arena input (draw / drag items), item grid, workshop, loop, saving |
| `src/stickman.ts` | Ragdoll rig, muscles, IK, gait, actions (punch, kick, swing, block, duck, jump, dodge) |
| `src/physics.ts` | Particles, sticks, rigid bodies, contacts |
| `src/world.ts` | Arena: collisions, damage, cannons, clouds, spikes, events |
| `src/terrain.ts` | Ramps, platforms, walls, trampolines |
| `src/ai.ts` | Brain: perception, imagination planner, learning, save/load |
| `src/policy.ts` | The Handwired policy circuit and its trainer |
| `src/explain.ts` | Plain-English thoughts and lessons |
| `src/render.ts`, `src/effects.ts` | Doodle renderer and comic effects |
| `src/hud.ts`, `src/palette.ts`, `src/workshop.ts`, `src/icons.ts`, `src/style.css` | UI |
| `src/vendor/handwired/` | Vendored Handwired core (MIT) |
| `vite.config.ts` | Dev server + brain save endpoint |

## Credits

- [Handwired](https://github.com/chenglou/handwired) by Cheng Lou — the circuit builder, evaluator and backprop (vendored, MIT).
- [rough.js](https://roughjs.com/) for sketchy shapes, [Motion](https://motion.dev/) for UI animation.
- Fonts: [Patrick Hand](https://fonts.google.com/specimen/Patrick+Hand) and [Caveat](https://fonts.google.com/specimen/Caveat) via Fontsource.
