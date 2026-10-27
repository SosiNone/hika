import { DatabaseSync } from 'node:sqlite';
import type { BBox, Locator } from '../../src/data/types';
import { insideRings, simplify, type XY } from '../../src/geo/track';
import { downloadAsset } from './download';
import { parseGpkgRings } from './gpkg';
import { fetchCached, mapLimit } from './http';
import { latestItem } from './stac';

/** Switzerland in LV95, the extent of the locator relief. */
export const CH_BBOX: BBox = [2_484_000, 1_074_000, 2_836_000, 1_298_000];
const PROFILE = 'https://api3.geo.admin.ch/rest/services/profile.json';

/**
 * Inputs for the Switzerland locator panel: a coarse national relief sampled row by row through
 * the profile service (no bulk terrain download needed) and simplified swissBOUNDARIES3D borders.
 */
export async function buildLocator(cell: number): Promise<{ locator: Omit<Locator, 'file'>; heights: Float32Array }> {
  const { border, cantons } = await loadBoundaries();
  const [minE, minN, maxE, maxN] = CH_BBOX;
  const cols = (maxE - minE) / cell, rows = (maxN - minN) / cell;
  const heights = new Float32Array(cols * rows).fill(NaN);
  const rowIdx = Array.from({ length: rows }, (_, j) => j);
  await mapLimit(rowIdx, 6, async (j) => {
    const n = maxN - (j + 0.5) * cell;
    const e0 = minE + cell / 2, e1 = maxE - cell / 2;
    const geom = JSON.stringify({ type: 'LineString', coordinates: [[e0, n], [e1, n]] });
    const res = JSON.parse((await fetchCached(`${PROFILE}?sr=2056&nb_points=${cols}`, { method: 'POST', body: geom, headers: { 'content-type': 'application/json' } })).toString('utf8')) as { easting: number; alts: { DTM2?: number; COMB?: number } }[];
    for (const p of res) {
      const i = Math.round((p.easting - e0) / cell);
      const h = p.alts.DTM2 ?? p.alts.COMB;
      if (i >= 0 && i < cols && h != null && insideRings(border, p.easting, n)) heights[j * cols + i] = h;
    }
  }, 'locator rows', 25);
  return { locator: { bbox: CH_BBOX, cols, rows, cell, border: border.map(flat), cantons: cantons.map(flat) }, heights };
}

const flat = (ring: XY[]) => ring.flatMap(([e, n]) => [Math.round(e), Math.round(n)]);

/** National border (Switzerland only) and canton outlines from swissBOUNDARIES3D, simplified to 400 m. */
export async function loadBoundaries(): Promise<{ border: XY[][]; cantons: XY[][] }> {
  const item = await latestItem('ch.swisstopo.swissboundaries3d');
  const asset = Object.values(item.assets).find((a) => a.href.endsWith('.gpkg.zip'))!;
  const [gpkg] = await downloadAsset(asset.href, 'swissboundaries3d', (n) => n.endsWith('.gpkg'));
  const db = new DatabaseSync(gpkg, { readOnly: true });
  const tables = (db.prepare("SELECT table_name FROM gpkg_contents WHERE data_type = 'features'").all() as { table_name: string }[]).map((t) => t.table_name);
  const read = (pattern: RegExp, where = '') => {
    const table = tables.find((t) => pattern.test(t));
    if (!table) throw new Error(`no table like ${pattern} in ${tables.join(', ')}`);
    const rows = db.prepare(`SELECT geom FROM "${table}" ${where}`).all() as { geom: Uint8Array }[];
    return rows.flatMap((r) => parseGpkgRings(r.geom)).map((ring) => ring.map(([e, n]) => [e, n] as XY));
  };
  // Liechtenstein shares the dataset; the locator shows Switzerland only.
  const border = read(/landesgebiet/i, "WHERE icc = 'CH'").filter((r) => r.length > 50).map((r) => simplify(r, 400));
  const cantons = read(/kantonsgebiet/i).filter((r) => r.length > 50).map((r) => simplify(r, 400));
  db.close();
  return { border, cantons };
}
