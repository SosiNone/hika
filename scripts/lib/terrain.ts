import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fromUrl } from 'geotiff';
import { CELL, TILE as ATLAS_TILE, TILE_CELLS, tileKey } from '../../src/data/tiles';
import type { BBox } from '../../src/data/types';
import { mapLimit, withSlot } from './http';
import { stacItems } from './stac';

const TILE = 1000;
const CACHE = '.cache/alti';

export interface Grid { cols: number; rows: number; cell: number; data: Float32Array }

/**
 * Mosaics swissALTI3D 2 m COG tiles into a `cell`-metre grid over `bbox` (row 0 = north edge).
 * Each 1 km tile is box-averaged from its internal 4 m overview, so only a few HTTP range
 * requests are needed per tile. Cells without data are NaN.
 */
export async function buildTerrain(bbox: BBox, cell: number, quiet = false): Promise<Grid> {
  const [minE, minN, maxE, maxN] = bbox;
  if (TILE % cell !== 0 || cell % 4 !== 0) throw new Error(`cell must divide ${TILE} and be a multiple of 4 m`);
  const cols = (maxE - minE) / cell, rows = (maxN - minN) / cell;
  const data = new Float32Array(cols * rows).fill(NaN);

  const newest = new Map<string, { year: number; href: string }>();
  for (const item of await stacItems('ch.swisstopo.swissalti3d', bbox)) {
    const m = /_(\d{4})_(\d{4})-(\d{4})$/.exec(item.id);
    const asset = Object.values(item.assets).find((a) => a.gsd === 2 && a.type.includes('geotiff'));
    if (!m || !asset) continue;
    const key = `${m[2]}-${m[3]}`, year = +m[1];
    if ((newest.get(key)?.year ?? 0) < year) newest.set(key, { year, href: asset.href });
  }
  const tiles = [...newest.entries()]
    .map(([key, v]) => ({ key, e: +key.split('-')[0] * TILE, n: +key.split('-')[1] * TILE, ...v }))
    .filter((t) => t.e < maxE && t.e + TILE > minE && t.n < maxN && t.n + TILE > minN);
  if (!quiet) console.log(`  swissALTI3D: ${tiles.length} tiles`);

  const per = TILE / cell;
  mkdirSync(CACHE, { recursive: true });
  await mapLimit(tiles, 8, async (t) => {
    const block = await tileBlock(t.href, `${CACHE}/${t.key}_${t.year}_${cell}.f32`, per);
    for (let j = 0; j < per; j++) {
      const row = Math.round((maxN - (t.n + TILE)) / cell) + j;
      if (row < 0 || row >= rows) continue;
      for (let i = 0; i < per; i++) {
        const col = Math.round((t.e - minE) / cell) + i;
        if (col >= 0 && col < cols) data[row * cols + col] = block[j * per + i];
      }
    }
  }, quiet ? undefined : 'terrain tiles', 100);
  return { cols, rows, cell, data };
}

/** One tile averaged down to per×per cells, cached on disk. */
async function tileBlock(href: string, cacheFile: string, per: number): Promise<Float32Array> {
  if (existsSync(cacheFile)) return new Float32Array(readFileSync(cacheFile).buffer.slice(0));
  const raster = await withSlot(async () => {
    const tiff = await fromUrl(href);
    const image = await tiff.getImage((await tiff.getImageCount()) > 1 ? 1 : 0);
    const [band] = (await image.readRasters({ interleave: false })) as unknown as Float32Array[];
    return { band, size: image.getWidth(), nodata: image.getGDALNoData() };
  });
  const k = raster.size / per;
  const out = new Float32Array(per * per);
  for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) {
    let sum = 0, n = 0;
    for (let y = j * k; y < (j + 1) * k; y++) for (let x = i * k; x < (i + 1) * k; x++) {
      const v = raster.band[y * raster.size + x];
      if (v !== raster.nodata && v > -1000) { sum += v; n++; }
    }
    out[j * per + i] = n ? sum / n : NaN;
  }
  writeFileSync(cacheFile, Buffer.from(out.buffer));
  return out;
}

/** Bilinear height at an LV95 point, or NaN outside the grid. */
export function sampleGrid(g: Grid, bbox: BBox, e: number, n: number): number {
  const x = (e - bbox[0]) / g.cell - 0.5, y = (bbox[3] - n) / g.cell - 0.5;
  const i = Math.floor(x), j = Math.floor(y);
  if (i < 0 || j < 0 || i >= g.cols - 1 || j >= g.rows - 1) return NaN;
  const fx = x - i, fy = y - j, d = g.data, c = g.cols;
  const top = d[j * c + i] * (1 - fx) + d[j * c + i + 1] * fx;
  const bottom = d[(j + 1) * c + i] * (1 - fx) + d[(j + 1) * c + i + 1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * Bilinear height (m) at an LV95 point from atlas terrain tiles (keyed by `tileKey`, Uint16
 * decimetres, row 0 north, 0 = no data), over the corners that have data; NaN where none do.
 */
export function sampleTiles(tiles: Map<string, Uint16Array>, e: number, n: number): number {
  // Global cell (a, b) has its centre at ((a + 0.5) · CELL, (b + 0.5) · CELL), b counting north.
  const x = e / CELL - 0.5, y = n / CELL - 0.5;
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  let sum = 0, weight = 0;
  for (const [a, b, w] of [[i, j, (1 - fx) * (1 - fy)], [i + 1, j, fx * (1 - fy)], [i, j + 1, (1 - fx) * fy], [i + 1, j + 1, fx * fy]]) {
    const ta = Math.floor(a / TILE_CELLS), tb = Math.floor(b / TILE_CELLS);
    const h = tiles.get(tileKey(ta * ATLAS_TILE, tb * ATLAS_TILE));
    const v = h?.[(TILE_CELLS - 1 - (b - tb * TILE_CELLS)) * TILE_CELLS + (a - ta * TILE_CELLS)];
    if (v) { sum += v * 0.1 * w; weight += w; }
  }
  return weight > 0 ? sum / weight : NaN;
}

/** Encodes heights as Uint16 decimetres (0 = no data); good to 6553 m, enough for the Alps. */
export function encodeU16(data: Float32Array): Uint16Array {
  const out = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Number.isNaN(data[i]) ? 0 : Math.max(1, Math.min(65535, Math.round(data[i] * 10)));
  return out;
}
