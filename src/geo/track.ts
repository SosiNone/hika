/** Polyline helpers shared by the data pipeline and the app. Coordinates are planar metres (LV95). */

import { smoothAltitudes } from './hikingTime';

export type XY = [number, number];

export function polylineLength(pts: XY[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return len;
}

/** Samples `pts` every `step` metres; the last sample sits exactly on the final vertex. */
export function resample(pts: XY[], step: number): XY[] {
  const out: XY[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    let d = step - carry;
    while (d <= seg) {
      const t = d / seg;
      out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
      d += step;
    }
    carry = seg - (d - step);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > step * 0.25) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/**
 * Total ascent and descent with a hysteresis threshold, which ignores terrain-model noise
 * the way a barometric altimeter does.
 */
export function climb(alt: ArrayLike<number>, threshold = 3): { up: number; down: number } {
  let up = 0, down = 0, ref = alt[0];
  for (let i = 1; i < alt.length; i++) {
    const d = alt[i] - ref;
    if (d >= threshold) { up += d; ref = alt[i]; }
    else if (d <= -threshold) { down -= d; ref = alt[i]; }
  }
  return { up, down };
}

/** Cumulative ascent / descent per sample (same hysteresis as `climb`). */
export function cumulativeClimb(alt: ArrayLike<number>, threshold = 3): { up: Float64Array; down: Float64Array } {
  const up = new Float64Array(alt.length), down = new Float64Array(alt.length);
  let ref = alt[0];
  for (let i = 1; i < alt.length; i++) {
    up[i] = up[i - 1];
    down[i] = down[i - 1];
    const d = alt[i] - ref;
    if (d >= threshold) { up[i] += d; ref = alt[i]; }
    else if (d <= -threshold) { down[i] -= d; ref = alt[i]; }
  }
  return { up, down };
}

/**
 * The one climb rule for everything the UI shows: altitudes smoothed over ±3 samples, then a
 * 3 m hysteresis. The pipeline's route stats and the app's per-sample series both use it, so
 * the route list and the preview panels agree.
 */
export function routeClimb(alt: ArrayLike<number>): { up: Float64Array; down: Float64Array } {
  return cumulativeClimb(smoothAltitudes(alt, 3), 3);
}

/** Squared distance from p to segment ab and the parameter t of the closest point. */
export function segmentDistance2(px: number, py: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const x = ax + dx * t - px, y = ay + dy * t - py;
  return [x * x + y * y, t];
}

/** Whether (x, y) lies inside a set of rings, by the even-odd rule (holes and islands both work). */
export function insideRings(rings: XY[][], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Douglas–Peucker simplification. */
export function simplify(pts: XY[], tolerance: number): XY[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [d] = segmentDistance2(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Splits a polyline into the pieces inside an axis-aligned box (Liang–Barsky per segment). */
export function clipToBox<T extends number[]>(line: T[], [minX, minY, maxX, maxY]: [number, number, number, number]): T[][] {
  const pieces: T[][] = [];
  let cur: T[] = [];
  const lerp = (a: T, b: T, t: number) => a.map((v, i) => v + (b[i] - v) * t) as T;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, a[0] - minX], [dx, maxX - a[0]], [-dy, a[1] - minY], [dy, maxY - a[1]]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { if (cur.length > 1) pieces.push(cur); cur = []; continue; }
    const start = t0 > 0 ? lerp(a, b, t0) : a;
    const end = t1 < 1 ? lerp(a, b, t1) : b;
    if (cur.length === 0 || t0 > 0) { if (cur.length > 1) pieces.push(cur); cur = [start]; }
    cur.push(end);
    if (t1 < 1) { pieces.push(cur); cur = []; }
  }
  if (cur.length > 1) pieces.push(cur);
  return pieces;
}
