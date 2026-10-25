import sharp from 'sharp';
import type { BBox } from '../../src/data/types';
import { fetchCached, mapLimit } from './http';

const ORIGIN_E = 2_420_000, ORIGIN_N = 1_350_000, TILE_PX = 256;
/** Metres per pixel of the geo.admin.ch EPSG:2056 WMTS tile matrix set, by zoom level. */
const RESOLUTIONS = [4000, 3750, 3500, 3250, 3000, 2750, 2500, 2250, 2000, 1750, 1500, 1250, 1000, 750, 650, 500, 250, 100, 50, 20, 10, 5, 2.5, 2, 1.5, 1, 0.5, 0.25, 0.1];

const tileUrl = (z: number, col: number, row: number) =>
  `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/2056/${z}/${col}/${row}.jpeg`;

/** Stitches SWISSIMAGE tiles over `bbox` and returns a JPEG `width` pixels wide (north up). */
export async function buildOrtho(bbox: BBox, zoom: number, width: number): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const res = RESOLUTIONS[zoom];
  const [minE, minN, maxE, maxN] = bbox;
  const span = TILE_PX * res;
  const c0 = Math.floor((minE - ORIGIN_E) / span), c1 = Math.floor((maxE - ORIGIN_E - 1e-6) / span);
  const r0 = Math.floor((ORIGIN_N - maxN) / span), r1 = Math.floor((ORIGIN_N - minN - 1e-6) / span);
  const tiles: { col: number; row: number }[] = [];
  for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) tiles.push({ col, row });
  console.log(`  SWISSIMAGE: ${tiles.length} tiles at ${res} m/px`);

  const images = await mapLimit(tiles, 6, async (t) => fetchCached(tileUrl(zoom, t.col, t.row)), 'ortho tiles', 100);
  const mosaicW = (c1 - c0 + 1) * TILE_PX, mosaicH = (r1 - r0 + 1) * TILE_PX;
  const mosaic = await sharp({ create: { width: mosaicW, height: mosaicH, channels: 3, background: '#000' } })
    .composite(tiles.map((t, i) => ({ input: images[i], left: (t.col - c0) * TILE_PX, top: (t.row - r0) * TILE_PX })))
    .raw()
    .toBuffer();

  // Crop the mosaic to the bbox, then scale to the requested width.
  const left = Math.round((minE - (ORIGIN_E + c0 * span)) / res), top = Math.round((ORIGIN_N - r0 * span - maxN) / res);
  const cropW = Math.round((maxE - minE) / res), cropH = Math.round((maxN - minN) / res);
  const height = Math.round((width * cropH) / cropW);
  const jpeg = await sharp(mosaic, { raw: { width: mosaicW, height: mosaicH, channels: 3 } })
    .extract({ left, top, width: cropW, height: cropH })
    .resize(width, height)
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return { jpeg, width, height };
}
