import { DatabaseSync } from 'node:sqlite';
import type { Trails } from '../../src/data/codec';
import type { BBox, TrailClass } from '../../src/data/types';
import { clipToBox, segmentDistance2 } from '../../src/geo/track';
import { downloadAsset } from './download';
import { parseGpkgLines, type XYZ } from './gpkg';
import { latestItem } from './stac';

export interface TrailLine { id: number; cls: TrailClass; hard: boolean; pts: XYZ[] }

const CLASS: Record<string, TrailClass> = { Wanderweg: 0, Bergwanderweg: 1, Alpinwanderweg: 2 };

/** The swissTLM3D Wanderwege GeoPackage, downloaded once into .cache/. */
async function wanderwegeGpkg(): Promise<string> {
  const item = await latestItem('ch.swisstopo.swisstlm3d-wanderwege');
  const asset = Object.values(item.assets).find((a) => a.href.endsWith('.gpkg.zip'))!;
  const [gpkg] = await downloadAsset(asset.href, 'wanderwege', (name) => name.endsWith('.gpkg'));
  return gpkg;
}

/**
 * swissTLM3D hiking trails (the whole signposted network) in `bbox`, clipped to it. With
 * `whole`, line parts are not clipped: a part is kept, ordered by id, when the centre of its
 * extent lies in `bbox` (west and south edges inclusive), so of two boxes that touch, exactly
 * one has it.
 */
export async function loadTrails(bbox: BBox, whole = false): Promise<TrailLine[]> {
  const db = new DatabaseSync(await wanderwegeGpkg(), { readOnly: true });
  const rows = db.prepare(`
    SELECT t.id, t.geom, t.wanderwege, t.belagsart FROM tlm_strassen_strasse t
    JOIN rtree_tlm_strassen_strasse_geom r ON t.id = r.id
    WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?${whole ? ' ORDER BY t.id' : ''}`).all(bbox[0], bbox[2], bbox[1], bbox[3]) as {
    id: number; geom: Uint8Array; wanderwege: string; belagsart: string;
  }[];
  db.close();
  const lines: TrailLine[] = [];
  for (const row of rows) {
    const cls = CLASS[row.wanderwege];
    if (cls === undefined) continue;
    for (const part of parseGpkgLines(row.geom)) {
      if (whole) {
        const es = part.map((p) => p[0]), ns = part.map((p) => p[1]);
        const ce = (Math.min(...es) + Math.max(...es)) / 2, cn = (Math.min(...ns) + Math.max(...ns)) / 2;
        if (part.length > 1 && ce >= bbox[0] && ce < bbox[2] && cn >= bbox[1] && cn < bbox[3]) lines.push({ id: row.id, cls, hard: row.belagsart === 'Hart', pts: part });
        continue;
      }
      for (const pts of clipToBox(part, bbox)) lines.push({ id: row.id, cls, hard: row.belagsart === 'Hart', pts });
    }
  }
  return lines;
}

/**
 * The network as an atlas tile stores it (encoded by `encodeTrails` in src/data/codec.ts): whole
 * metres from the box's SW corner, plus `bias` (TRAIL_BIAS).
 */
export function trailsData(lines: TrailLine[], bbox: BBox, bias = 0): Trails {
  const offsets = new Uint32Array(lines.length + 1), xy = new Uint16Array(lines.reduce((s, l) => s + l.pts.length, 0) * 2);
  let v = 0;
  const at = (x: number) => {
    if (x < 0 || x > 65535) throw new Error(`trail vertex ${x - bias} m off the box corner does not fit in 16 bits`);
    return x;
  };
  lines.forEach((l, i) => {
    offsets[i] = v;
    for (const [e, n] of l.pts) { xy[2 * v] = at(Math.round(e - bbox[0]) + bias); xy[2 * v + 1] = at(Math.round(n - bbox[1]) + bias); v++; }
  });
  offsets[lines.length] = v;
  return { offsets, cls: Uint8Array.from(lines, (l) => l.cls), hard: Uint8Array.from(lines, (l) => (l.hard ? 1 : 0)), xy };
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
