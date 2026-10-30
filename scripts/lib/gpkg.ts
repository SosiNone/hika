
export type XYZ = [number, number, number];

/**
 * Parses a GeoPackage geometry blob (GP header + WKB) into its line parts.
 * Supports (Multi)LineString and (Multi)Polygon (as rings), with or without Z.
 */
export function parseGpkgLines(blob: Uint8Array): XYZ[][] {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (blob[0] !== 0x47 || blob[1] !== 0x50) throw new Error('not a GeoPackage geometry');
  const flags = blob[3];
  const envelopeBytes = [0, 32, 48, 48, 64][(flags >> 1) & 7];
  return readWkb(view, 8 + envelopeBytes).lines;
}

/** Polygon rings work the same way: (Multi)Polygon parts come back as closed rings. */
export const parseGpkgRings = parseGpkgLines;

function readWkb(view: DataView, offset: number): { lines: XYZ[][]; end: number } {
  const le = view.getUint8(offset) === 1;
  let type = view.getUint32(offset + 1, le);
  let hasZ = false;
  if (type & 0x80000000) { hasZ = true; type &= 0xffff; }           // EWKB Z flag
  if (type > 1000) { hasZ = Math.floor(type / 1000) % 2 === 1; type %= 1000; } // ISO WKB 1002 etc.
  let p = offset + 5;
  const dims = hasZ ? 3 : 2;
  if (type === 2) {
    const n = view.getUint32(p, le); p += 4;
    const line: XYZ[] = [];
    for (let i = 0; i < n; i++, p += 8 * dims) line.push([view.getFloat64(p, le), view.getFloat64(p + 8, le), hasZ ? view.getFloat64(p + 16, le) : NaN]);
    return { lines: [line], end: p };
  }
  if (type === 3) {
    const rings = view.getUint32(p, le); p += 4;
    const lines: XYZ[][] = [];
    for (let r = 0; r < rings; r++) {
      const n = view.getUint32(p, le); p += 4;
      const ring: XYZ[] = [];
      for (let i = 0; i < n; i++, p += 8 * dims) ring.push([view.getFloat64(p, le), view.getFloat64(p + 8, le), hasZ ? view.getFloat64(p + 16, le) : NaN]);
      lines.push(ring);
    }
    return { lines, end: p };
  }
  if (type === 5 || type === 6) {
    const parts = view.getUint32(p, le); p += 4;
    const lines: XYZ[][] = [];
    for (let k = 0; k < parts; k++) { const r = readWkb(view, p); lines.push(...r.lines); p = r.end; }
    return { lines, end: p };
  }
  throw new Error(`unsupported WKB type ${type}`);
}
