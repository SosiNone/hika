import { DatabaseSync } from 'node:sqlite';
import type { BBox, TrailClass } from '../../src/data/types';
import { segmentDistance2 } from '../../src/geo/track';
import { downloadAsset } from './download';
import { clipToBox, parseGpkgLines, type XYZ } from './gpkg';
import { latestItem } from './stac';

export interface TrailLine { id: number; cls: TrailClass; hard: boolean; pts: XYZ[] }

const CLASS: Record<string, TrailClass> = { Wanderweg: 0, Bergwanderweg: 1, Alpinwanderweg: 2 };

/** swissTLM3D hiking trails (the whole signposted network) clipped to `bbox`. */
export async function loadTrails(bbox: BBox): Promise<TrailLine[]> {
  const item = await latestItem('ch.swisstopo.swisstlm3d-wanderwege');
  const asset = Object.values(item.assets).find((a) => a.href.endsWith('.gpkg.zip'))!;
  const [gpkg] = await downloadAsset(asset.href, 'wanderwege', (name) => name.endsWith('.gpkg'));
  const db = new DatabaseSync(gpkg, { readOnly: true });
  const rows = db.prepare(`
    SELECT t.id, t.geom, t.wanderwege, t.belagsart FROM tlm_strassen_strasse t
    JOIN rtree_tlm_strassen_strasse_geom r ON t.id = r.id
    WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?`).all(bbox[0], bbox[2], bbox[1], bbox[3]) as {
    id: number; geom: Uint8Array; wanderwege: string; belagsart: string;
  }[];
  db.close();
  const lines: TrailLine[] = [];
  for (const row of rows) {
    const cls = CLASS[row.wanderwege];
    if (cls === undefined) continue;
    for (const part of parseGpkgLines(row.geom)) for (const pts of clipToBox(part, bbox)) {
      lines.push({ id: row.id, cls, hard: row.belagsart === 'Hart', pts });
    }
  }
  return lines;
}

/** trails.bin: header, vertex offsets, class and surface bytes, then Uint16 metre coordinates from the bbox SW corner. */
export function encodeTrails(lines: TrailLine[], bbox: BBox): Buffer {
  const nLines = lines.length, nVerts = lines.reduce((s, l) => s + l.pts.length, 0);
  const metaBytes = Math.ceil((nLines * 2) / 4) * 4;
  const buf = Buffer.alloc(12 + (nLines + 1) * 4 + metaBytes + nVerts * 4);
  buf.write('HKTR', 0, 'ascii');
  buf.writeUInt32LE(nLines, 4);
  buf.writeUInt32LE(nVerts, 8);
  let off = 12, v = 0;
  for (const l of lines) { buf.writeUInt32LE(v, off); off += 4; v += l.pts.length; }
  buf.writeUInt32LE(v, off); off += 4;
  lines.forEach((l, i) => { buf[off + i] = l.cls; buf[off + nLines + i] = l.hard ? 1 : 0; });
  off += metaBytes;
  for (const l of lines) for (const [e, n] of l.pts) {
    buf.writeUInt16LE(Math.round(e - bbox[0]), off);
    buf.writeUInt16LE(Math.round(n - bbox[1]), off + 2);
    off += 4;
  }
  return buf;
}

/** Bucketed segment index for "which trail is this point on" lookups. */
export class SegmentIndex {
  private buckets = new Map<string, [number, number][]>();
  constructor(private lines: TrailLine[], private size = 100) {
    lines.forEach((l, li) => {
      for (let s = 1; s < l.pts.length; s++) {
        const [ax, ay] = l.pts[s - 1], [bx, by] = l.pts[s];
        for (let gx = Math.floor(Math.min(ax, bx) / size); gx <= Math.floor(Math.max(ax, bx) / size); gx++)
          for (let gy = Math.floor(Math.min(ay, by) / size); gy <= Math.floor(Math.max(ay, by) / size); gy++) {
            const k = `${gx},${gy}`;
            (this.buckets.get(k) ?? this.buckets.set(k, []).get(k)!).push([li, s]);
          }
      }
    });
  }

  /** Nearest trail line within `maxDist` metres, or undefined. */
  nearest(x: number, y: number, maxDist: number): TrailLine | undefined {
    let best: TrailLine | undefined, bestD = maxDist * maxDist;
    const r = Math.ceil(maxDist / this.size), gx = Math.floor(x / this.size), gy = Math.floor(y / this.size);
    for (let i = gx - r; i <= gx + r; i++) for (let j = gy - r; j <= gy + r; j++) {
      for (const [li, s] of this.buckets.get(`${i},${j}`) ?? []) {
        const a = this.lines[li].pts[s - 1], b = this.lines[li].pts[s];
        const [d] = segmentDistance2(x, y, a[0], a[1], b[0], b[1]);
        if (d < bestD) { bestD = d; best = this.lines[li]; }
      }
    }
    return best;
  }
}
