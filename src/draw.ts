import { RigidBody } from './physics';
import { Vec } from './math';

const SPACING = 7;
const STROKE_R = 5;

function resample(pts: Vec[], step: number): Vec[] {
  if (pts.length === 0) return [];
  const out: Vec[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    let d = step - carry;
    while (d <= seg) {
      const t = d / seg;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      d += step;
    }
    carry = seg - (d - step);
  }
  return out;
}

function inside(poly: Vec[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/** Turn a freehand stroke into a rigid body. Closed loops get filled (heavier). */
export function bodyFromStroke(stroke: Vec[], color: string): RigidBody | null {
  const pts = resample(stroke, SPACING);
  if (pts.length === 0) return null;
  let len = 0;
  for (let i = 1; i < stroke.length; i++) len += Math.hypot(stroke[i].x - stroke[i - 1].x, stroke[i].y - stroke[i - 1].y);
  if (len < 12) {
    const p = stroke[0];
    return new RigidBody(p.x, p.y, [{ x: p.x, y: p.y, r: 9 }], [], true, 'rock', color);
  }
  const first = pts[0], last = pts[pts.length - 1];
  const closed = len > 80 && Math.hypot(first.x - last.x, first.y - last.y) < 30;
  const circles = pts.map((p) => ({ x: p.x, y: p.y, r: STROKE_R }));
  if (closed) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    for (let y = y0 + 10; y < y1; y += 13)
      for (let x = x0 + 10; x < x1; x += 13)
        if (inside(pts, x, y)) circles.push({ x, y, r: 7 });
  }
  return new RigidBody(0, 0, circles, pts, closed, 'drawn', color);
}
