/**
 * Byte layouts of the atlas files (format 3): terrain and trail tiles and route files. Shared by
 * the pipeline (encode) and the app (decode) so the two cannot drift apart.
 *
 * All of them store 16-bit values as residuals from a predictor, modulo 2^16, with all low bytes before
 * all high bytes. The residuals are small and the high-byte plane is nearly constant, so git's
 * zlib and the web server's gzip shrink the files by about half. They are deliberately left
 * uncompressed, so a small data change stays a small change in the file and git can delta it.
 */

import type { AtlasRoute } from './types';

/** Trail network as the app uses it. */
export interface Trails {
  offsets: Uint32Array;
  cls: Uint8Array;
  hard: Uint8Array;
  /** Uint16 metre pairs (e, n): from a tile's south-west corner plus TRAIL_BIAS, or from a window's corner. */
  xy: Uint16Array;
}

const TRAILS_MAGIC = 'HKT2';
const ROUTE_MAGIC = 'HKR3';

/** Gradient predictor (left + up − upper-left), falling back to up in the first column and left in the first row. */
function predict(h: Uint16Array, i: number, cols: number): number {
  const x = i % cols;
  if (i < cols) return x ? h[i - 1] : 0;
  if (!x) return h[i - cols];
  return h[i - 1] + h[i - cols] - h[i - cols - 1];
}

/** terrain.bin from a row-major Uint16 grid. */
export function encodeGrid(h: Uint16Array, cols: number): Uint8Array {
  const r = new Uint16Array(h.length);
  for (let i = 0; i < h.length; i++) r[i] = (h[i] - predict(h, i, cols)) & 0xffff;
  return toPlanes(r);
}

export function decodeGrid(bytes: Uint8Array, cols: number, rows: number): Uint16Array {
  if (bytes.length !== cols * rows * 2) throw new Error(`terrain: ${bytes.length} bytes for a ${cols} × ${rows} grid`);
  const r = fromPlanes(bytes), h = new Uint16Array(r.length);
  for (let i = 0; i < h.length; i++) h[i] = (r[i] + predict(h, i, cols)) & 0xffff;
  return h;
}

/**
 * trails.bin: 'HKT2', line and vertex counts (Uint32), vertex offsets per line (Uint32), class and
 * surface bytes padded to 4, then the (e, n) pairs as deltas from the line's previous vertex (the
 * first vertex as is), in byte planes.
 */
export function encodeTrails({ offsets, cls, hard, xy }: Trails): Uint8Array {
  const nLines = cls.length, nVerts = xy.length / 2, meta = Math.ceil((nLines * 2) / 4) * 4;
  const d = new Uint16Array(xy.length);
  for (let l = 0; l < nLines; l++) for (let v = offsets[l]; v < offsets[l + 1]; v++) {
    for (const c of [0, 1]) d[2 * v + c] = (xy[2 * v + c] - (v > offsets[l] ? xy[2 * v + c - 2] : 0)) & 0xffff;
  }
  const out = new Uint8Array(12 + (nLines + 1) * 4 + meta + nVerts * 4), view = new DataView(out.buffer);
  for (let k = 0; k < 4; k++) out[k] = TRAILS_MAGIC.charCodeAt(k);
  view.setUint32(4, nLines, true);
  view.setUint32(8, nVerts, true);
  offsets.forEach((o, k) => view.setUint32(12 + k * 4, o, true));
  const metaStart = 12 + (nLines + 1) * 4;
  out.set(cls, metaStart);
  out.set(hard, metaStart + nLines);
  out.set(toPlanes(d), metaStart + meta);
  return out;
}

export function decodeTrails(buf: ArrayBuffer): Trails {
  const bytes = new Uint8Array(buf), view = new DataView(buf);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== TRAILS_MAGIC) throw new Error(`trails: expected ${TRAILS_MAGIC}, found ${magic}`);
  const nLines = view.getUint32(4, true), nVerts = view.getUint32(8, true);
  const offsets = new Uint32Array(buf, 12, nLines + 1);
  const metaStart = 12 + (nLines + 1) * 4;
  const cls = bytes.subarray(metaStart, metaStart + nLines);
  const hard = bytes.subarray(metaStart + nLines, metaStart + 2 * nLines);
  const xyStart = metaStart + Math.ceil((nLines * 2) / 4) * 4;
  const xy = fromPlanes(bytes.subarray(xyStart, xyStart + nVerts * 4));
  for (let l = 0; l < nLines; l++) for (let v = offsets[l] + 1; v < offsets[l + 1]; v++) {
    xy[2 * v] = (xy[2 * v] + xy[2 * v - 2]) & 0xffff;
    xy[2 * v + 1] = (xy[2 * v + 1] + xy[2 * v - 1]) & 0xffff;
  }
  return { offsets, cls, hard, xy };
}

/**
 * routes/<id>.bin: 'HKR3', the byte length of a UTF-8 JSON head (Uint32), the head (everything
 * but the samples, plus the sample count and the first sample's e, n and alt in decimetres), then
 * per sample: e, n and alt in decimetres as deltas from the sample before (signed 16-bit, so
 * samples must be under 3.2 km apart), in byte planes, then the class and surface bytes.
 */
export function encodeRoute(r: AtlasRoute): Uint8Array {
  const { e, n, alt, cls, surf, ...head } = r;
  const count = e.length;
  if ([n, alt, cls, surf].some((a) => a.length !== count)) throw new Error(`${r.id}: sample arrays differ in length`);
  const dm = (v: number[]) => v.map((x) => Math.round(x * 10));
  const [E, N, A] = [dm(e), dm(n), dm(alt)];
  const json = new TextEncoder().encode(JSON.stringify({ ...head, samples: count, origin: [E[0] ?? 0, N[0] ?? 0, A[0] ?? 0] }));
  const deltas = (v: number[]) => Uint16Array.from(v, (x, i) => {
    const d = i ? x - v[i - 1] : 0;
    if (d < -32768 || d > 32767) throw new Error(`${r.id}: samples ${i - 1} and ${i} are too far apart`);
    return d & 0xffff;
  });
  const out = new Uint8Array(8 + json.length + count * 8), view = new DataView(out.buffer);
  for (let k = 0; k < 4; k++) out[k] = ROUTE_MAGIC.charCodeAt(k);
  view.setUint32(4, json.length, true);
  out.set(json, 8);
  let p = 8 + json.length;
  for (const plane of [deltas(E), deltas(N), deltas(A)]) { out.set(toPlanes(plane), p); p += count * 2; }
  out.set(cls, p);
  out.set(surf, p + count);
  return out;
}

export function decodeRoute(buf: ArrayBuffer): AtlasRoute {
  const bytes = new Uint8Array(buf), view = new DataView(buf);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== ROUTE_MAGIC) throw new Error(`route: expected ${ROUTE_MAGIC}, found ${magic}`);
  const len = view.getUint32(4, true);
  const { samples: count, origin, ...head } = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len))) as Omit<AtlasRoute, 'e' | 'n' | 'alt' | 'cls' | 'surf'> & { samples: number; origin: [number, number, number] };
  let p = 8 + len;
  const plane = (first: number) => {
    const d = fromPlanes(bytes.subarray(p, p + count * 2)), out = new Array<number>(count);
    p += count * 2;
    // Deltas are signed: shift the sign bit of each 16-bit value up and back.
    for (let i = 0, v = first; i < count; i++) { v += (d[i] << 16) >> 16; out[i] = v / 10; }
    return out;
  };
  const [e, n, alt] = [plane(origin[0]), plane(origin[1]), plane(origin[2])];
  return { ...head, e, n, alt, cls: Array.from(bytes.subarray(p, p + count)), surf: Array.from(bytes.subarray(p + count, p + 2 * count)) };
}

/** All low bytes, then all high bytes. */
function toPlanes(v: Uint16Array): Uint8Array {
  const n = v.length, out = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) { out[i] = v[i] & 0xff; out[n + i] = v[i] >> 8; }
  return out;
}

function fromPlanes(b: Uint8Array): Uint16Array {
  const n = b.length / 2, out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = b[i] | (b[n + i] << 8);
  return out;
}
