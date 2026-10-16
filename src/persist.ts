import { Brain, BrainSave } from './ai';

// Brains live in brains/<name>.json, written by the dev server (vite.config.ts).
// Loaded automatically on start and saved every few seconds, so learning carries on.

const url = (b: Brain) => `/api/brain/${encodeURIComponent(b.me.name)}`;
const lastSaved = new WeakMap<Brain, string>();

export type SaveState = 'new' | 'loaded' | 'saved' | 'error';
export const saveState = new WeakMap<Brain, { state: SaveState; at: number }>();

export async function loadBrain(b: Brain) {
  try {
    const res = await fetch(url(b));
    if (res.status === 404) { saveState.set(b, { state: 'new', at: Date.now() }); return; }
    if (!res.ok) throw new Error(String(res.status));
    b.restore((await res.json()) as BrainSave);
    saveState.set(b, { state: 'loaded', at: Date.now() });
  } catch {
    saveState.set(b, { state: 'error', at: Date.now() });
  }
}

/** Fingerprint of what changes when the brain learns; skip writes when nothing did. */
const fingerprint = (b: Brain) => `${b.net.steps}|${b.gen}|${b.stats.threats}|${b.stats.strikes}`;

export async function saveBrain(b: Brain, force = false) {
  const fp = fingerprint(b);
  if (!force && lastSaved.get(b) === fp) return;
  try {
    const res = await fetch(url(b), { method: 'PUT', body: JSON.stringify(b.serialize()), headers: { 'content-type': 'application/json' } });
    if (!res.ok) throw new Error(String(res.status));
    lastSaved.set(b, fp);
    saveState.set(b, { state: 'saved', at: Date.now() });
  } catch {
    saveState.set(b, { state: 'error', at: Date.now() });
  }
}

/** Last-chance save when the tab closes or reloads. */
export function saveOnExit(brains: () => Brain[]) {
  addEventListener('pagehide', () => {
    for (const b of brains()) {
      if (lastSaved.get(b) === fingerprint(b)) continue;
      navigator.sendBeacon(url(b), new Blob([JSON.stringify(b.serialize())], { type: 'application/json' }));
    }
  });
}
