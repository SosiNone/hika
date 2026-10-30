/**
 * Temporary, for the move to the atlas (AGENTS.md, "Atlas"): checks the atlas against the region
 * bundles it will replace. `npm run compare:atlas` (or `-- <dir>`). Remove it with the bundles.
 * - Terrain stitched over each region's box must be byte-identical to its terrain.bin.
 * - SchweizMobil routes a bundle has whole (not clipped) must start at the same point and keep
 *   their stats (km exact, climb and times within 1).
 * Clipped routes, now whole, and curated hikes, now routed on the trails around their region, are
 * reported for review but don't fail.
 */
import { existsSync, readFileSync } from 'node:fs';
import { decodeGrid, decodeRoute, encodeGrid } from '../src/data/codec';
import { stitchGrid, TILE_CELLS } from '../src/data/tiles';
import type { RegionBundle, RouteStats } from '../src/data/types';
import { builtRegions, DATA_DIR } from './lib/regions';

const DIR = process.argv[2] ?? `${DATA_DIR}/v3`;
let failed = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };
const tiles = new Map<string, Uint16Array | undefined>();
const tile = (key: string) => {
  if (!tiles.has(key)) {
    const file = `${DIR}/terrain/${key}.bin`;
    tiles.set(key, existsSync(file) ? decodeGrid(readFileSync(file), TILE_CELLS, TILE_CELLS) : undefined);
  }
  return tiles.get(key);
};
const statsDiff = (a: RouteStats, b: RouteStats) =>
  `${a.km} → ${b.km} km, ↑${a.up} → ${b.up}, ↓${a.down} → ${b.down}, ${a.time} → ${b.time} min`;

for (const id of builtRegions()) {
  console.log(`\n${id}`);
  const b = JSON.parse(readFileSync(`${DATA_DIR}/${id}/region.json`, 'utf8')) as RegionBundle;
  const g = stitchGrid(b.bbox, tile);
  const same = Buffer.from(encodeGrid(g.heights, g.cols)).equals(readFileSync(`${DATA_DIR}/${id}/${b.grid.file}`));
  check(same, `terrain over ${b.bbox.join(',')} is byte-identical to ${b.grid.file}`);
  const [minE, minN] = b.bbox;
  for (const r of b.routes) {
    const file = `${DIR}/routes/${r.id}.bin`;
    if (!existsSync(file)) { check(false, `${r.id}: not in the atlas`); continue; }
    const buf = readFileSync(file);
    const a = decodeRoute(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    const s = r.stats, t = a.stats;
    if (r.source === 'schweizmobil' && !r.clipped[0] && !r.clipped[1]) {
      const start = Math.hypot(a.e[0] - (r.e[0] + minE), a.n[0] - (r.n[0] + minN));
      const near = (x: number, y: number) => Math.abs(x - y) <= 1;
      check(start < 1 && s.km === t.km && near(s.up, t.up) && near(s.down, t.down) && near(s.time, t.time) && near(s.timeBack, t.timeBack),
        `${r.id.padEnd(16)} whole in both: ${statsDiff(s, t)}${start < 1 ? '' : `, starts ${start.toFixed(0)} m apart`}`);
    } else {
      console.log(`     ${r.id.padEnd(16)} ${r.source === 'curated' ? 'curated' : `clipped ${r.clipped.map((c) => (c ? '✂' : '·')).join('')}`}: ${statsDiff(s, t)}`);
    }
  }
}

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
