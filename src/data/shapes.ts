/**
 * The outlines of ranges and areas in regions.json: every border between two areas is one arc,
 * stored once in whole decametres and delta-coded ([e0, n0, de1, dn1, …]), and a ring is a list of
 * arc references (`ArcRings`). Shared by the pipeline, which encodes, and the app, which decodes.
 * Pure, no DOM.
 */
import type { ArcRings } from './types';

const UNIT = 10;

/** One arc of LV95 points (on whole decametres) as its stored form. */
export function encodeArc(pts: [number, number][]): number[] {
  const out: number[] = [];
  let pe = 0, pn = 0;
  for (const [e, n] of pts) {
    const qe = Math.round(e / UNIT), qn = Math.round(n / UNIT);
    out.push(qe - pe, qn - pn);
    pe = qe;
    pn = qn;
  }
  return out;
}

/** An arc's points as a flat [e0, n0, e1, n1, …] LV95 list. */
export function decodeArc(arc: number[]): number[] {
  const out = new Array<number>(arc.length);
  let e = 0, n = 0;
  for (let k = 0; k < arc.length; k += 2) {
    e += arc[k];
    n += arc[k + 1];
    out[k] = e * UNIT;
    out[k + 1] = n * UNIT;
  }
  return out;
}

/**
 * Rings given as arc references, as flat [e0, n0, …] LV95 rings (closed implicitly), the form the
 * locator's border and canton rings take. `arcs` are decoded arcs (`decodeArc`).
 */
export function decodeRings(arcs: number[][], rings: ArcRings): number[][] {
  return rings.map((refs) => {
    const out: number[] = [];
    for (const ref of refs) {
      const arc = ref >= 0 ? arcs[ref] : reversed(arcs[-ref - 1]);
      // Consecutive arcs share their end point.
      for (let k = out.length ? 2 : 0; k < arc.length; k++) out.push(arc[k]);
    }
    if (out.length > 2 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
    return out;
  });
}

function reversed(flat: number[]): number[] {
  const out = new Array<number>(flat.length);
  for (let k = 0; k < flat.length; k += 2) { out[flat.length - 2 - k] = flat[k]; out[flat.length - 1 - k] = flat[k + 1]; }
  return out;
}

/** Whether LV95 (e, n) lies inside flat rings, by the even-odd rule. */
export function insideFlat(rings: number[][], e: number, n: number): boolean {
  let inside = false;
  for (const ring of rings) for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if (yi > n !== yj > n && e < ((xj - xi) * (n - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
