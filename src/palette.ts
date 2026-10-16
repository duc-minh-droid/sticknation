import rough from 'roughjs';
import { animate } from 'motion';

// The item grid under the arena. Drag a card into the arena to place that item.
// While an existing item is being dragged, the grid turns into a "drop to remove" zone.

export type ItemKind = 'spikes' | 'cannon' | 'cloud' | 'enemy' | 'ramp' | 'platform' | 'wall' | 'trampoline';

const ITEMS: { kind: ItemKind; label: string; note?: string }[] = [
  { kind: 'enemy', label: 'Enemy' },
  { kind: 'cannon', label: 'Cannon' },
  { kind: 'spikes', label: 'Spikes' },
  { kind: 'cloud', label: 'Rain cloud' },
  { kind: 'ramp', label: 'Ramp', note: '2×click flips' },
  { kind: 'platform', label: 'Platform' },
  { kind: 'wall', label: 'Wall' },
  { kind: 'trampoline', label: 'Trampoline' },
];

function icon(kind: ItemKind, canvas: HTMLCanvasElement, ink: string) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 72 * dpr; canvas.height = 46 * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const rc = rough.canvas(canvas);
  const o = { stroke: ink, strokeWidth: 1.8, roughness: 1.3, seed: 7 };
  switch (kind) {
    case 'spikes':
      rc.polygon([[6, 40], [16, 14], [26, 40], [36, 14], [46, 40], [56, 14], [66, 40]], { ...o, fill: '#9aa3ad', fillStyle: 'zigzag', hachureGap: 3 });
      break;
    case 'cannon':
      rc.rectangle(22, 10, 40, 16, { ...o, fill: ink, fillStyle: 'cross-hatch', hachureGap: 4 });
      rc.circle(26, 30, 24, { ...o, fill: '#fff', fillStyle: 'solid' });
      break;
    case 'cloud':
      rc.path('M 12 26 C 4 26 4 12 16 13 C 16 2 34 0 38 10 C 44 0 64 4 62 16 C 72 16 72 28 62 28 Z', { ...o, fill: '#c9d3df', fillStyle: 'hachure', hachureGap: 4 });
      for (let i = 0; i < 4; i++) rc.line(20 + i * 12, 33, 17 + i * 12, 42, { ...o, stroke: '#5b8bd0' });
      break;
    case 'enemy':
      rc.circle(36, 9, 13, { ...o, stroke: '#d64545' });
      rc.line(36, 16, 36, 30, { ...o, stroke: '#d64545', strokeWidth: 2.4 });
      rc.linearPath([[24, 26], [36, 19], [48, 14]], { ...o, stroke: '#d64545', strokeWidth: 2.4 });
      rc.linearPath([[28, 44], [36, 30], [44, 44]], { ...o, stroke: '#d64545', strokeWidth: 2.4 });
      break;
    case 'ramp':
      rc.polygon([[6, 42], [66, 42], [66, 8]], { ...o, fill: '#d9b38c', fillStyle: 'hachure', hachureGap: 4 });
      break;
    case 'platform':
      rc.rectangle(6, 16, 60, 10, { ...o, fill: '#d9b38c', fillStyle: 'cross-hatch', hachureGap: 4 });
      rc.line(14, 26, 14, 40, { ...o, stroke: '#a39d90' });
      rc.line(58, 26, 58, 40, { ...o, stroke: '#a39d90' });
      break;
    case 'wall':
      rc.rectangle(28, 4, 16, 38, { ...o, fill: '#b9a38c', fillStyle: 'cross-hatch', hachureGap: 4 });
      break;
    case 'trampoline':
      rc.rectangle(10, 20, 52, 7, { ...o, fill: '#5b8bd0', fillStyle: 'solid' });
      rc.linearPath([[16, 27], [20, 33], [14, 38], [20, 43]], o);
      rc.linearPath([[56, 27], [52, 33], [58, 38], [52, 43]], o);
      break;
  }
}

export interface PaletteHooks {
  /** A card was dropped at this screen point; return true if it was placed. */
  drop(kind: ItemKind, clientX: number, clientY: number): boolean;
  /** Live preview while dragging a card over the arena (null when off the arena). */
  preview(kind: ItemKind | null, clientX: number, clientY: number): void;
}

export class Palette {
  el: HTMLElement;
  constructor(el: HTMLElement, private hooks: PaletteHooks) {
    this.el = el;
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#2b2a28';
    for (const it of ITEMS) {
      const card = document.createElement('div');
      card.className = 'item';
      card.dataset.kind = it.kind;
      card.title = `Drag into the arena to add ${it.label.toLowerCase()}`;
      const cv = document.createElement('canvas');
      icon(it.kind, cv, ink);
      card.append(cv, Object.assign(document.createElement('span'), { textContent: it.label }));
      if (it.note) card.append(Object.assign(document.createElement('small'), { textContent: it.note }));
      card.addEventListener('pointerdown', (e) => this.startDrag(e, card, it.kind));
      el.append(card);
    }
  }

  private startDrag(e: PointerEvent, card: HTMLElement, kind: ItemKind) {
    e.preventDefault();
    const r = card.getBoundingClientRect();
    const ghost = card.cloneNode(true) as HTMLElement;
    // cloned canvases lose their drawing: copy pixels
    const src = card.querySelector('canvas')!, dst = ghost.querySelector('canvas')!;
    dst.width = src.width; dst.height = src.height;
    dst.getContext('2d')!.drawImage(src, 0, 0);
    ghost.classList.add('ghost');
    ghost.style.width = `${r.width}px`;
    ghost.style.left = `${r.left}px`;
    ghost.style.top = `${r.top}px`;
    document.body.append(ghost);
    const offX = e.clientX - r.left, offY = e.clientY - r.top;
    animate(ghost, { rotate: [0, -6], scale: [1, 1.12] }, { duration: 0.18 });
    const move = (ev: PointerEvent) => {
      ghost.style.left = `${ev.clientX - offX}px`;
      ghost.style.top = `${ev.clientY - offY}px`;
      this.hooks.preview(kind, ev.clientX, ev.clientY);
    };
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      this.hooks.preview(null, 0, 0);
      if (this.hooks.drop(kind, ev.clientX, ev.clientY)) {
        animate(ghost, { scale: [1.12, 0.2], opacity: [0.9, 0] }, { duration: 0.2 }).then(() => ghost.remove());
      } else {
        // fly back home
        const nr = card.getBoundingClientRect();
        animate(ghost, { left: `${nr.left}px`, top: `${nr.top}px`, rotate: 0, scale: 1 }, { type: 'spring', bounce: 0.35, duration: 0.45 }).then(() => ghost.remove());
      }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  /** Show the remove zone while an arena item is dragged; hot when the pointer is over it. */
  trash(active: boolean, clientX = 0, clientY = 0): boolean {
    const r = this.el.getBoundingClientRect();
    const hot = active && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    this.el.classList.toggle('trash-hint', active);
    this.el.classList.toggle('trash-hot', hot);
    return hot;
  }

  wiggle(kind: ItemKind) {
    const card = this.el.querySelector<HTMLElement>(`.item[data-kind="${kind}"]`);
    if (card) animate(card, { rotate: [0, -8, 7, -4, 0] }, { duration: 0.4 });
  }
}
