/**
 * Sanity checks for generated bundles: `npm run check:region` checks every built region,
 * `npm run check:region alpstein` only the regions named. Either way public/data/regions.json
 * must match the bundles. Exits non-zero when a check fails, so it can guard CI or a rebuild.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { RegionBundle } from '../src/data/types';
import { routeClimb } from '../src/geo/track';
import { buildRegionIndex, builtRegions, DATA_DIR, formatIndex, INDEX_FILE } from './lib/regions';

let failed = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };

const ids = process.argv.length > 2 ? process.argv.slice(2) : builtRegions();
check(ids.length > 0, `${ids.length} region(s) to check in ${DATA_DIR}`);
for (const id of ids) checkRegion(id);

console.log(`\n${INDEX_FILE}`);
try {
  const index = buildRegionIndex();
  const fresh = existsSync(INDEX_FILE) && readFileSync(INDEX_FILE, 'utf8') === formatIndex(index);
  check(fresh, `lists ${index.regions.map((r) => r.id).join(', ')}${fresh ? '' : ': out of date, run `npm run index:regions`'}`);
} catch (err) {
  check(false, (err as Error).message);
}

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }

function checkRegion(id: string) {
  console.log(`\n${id}`);
  const dir = `${DATA_DIR}/${id}`;
  const b = JSON.parse(readFileSync(`${dir}/region.json`, 'utf8')) as RegionBundle;
  const heights = new Uint16Array(readFileSync(`${dir}/terrain.u16`).buffer.slice(0));
  check(b.id === id && existsSync(`regions/${id}.json`), `bundle id ${b.id}, config regions/${id}.json`);

  const { cols, rows, cell } = b.grid;
  check(heights.length === cols * rows, `terrain is ${cols}×${rows} (${heights.length} cells)`);
  check((b.bbox[2] - b.bbox[0]) / cell === cols && (b.bbox[3] - b.bbox[1]) / cell === rows, `grid matches bbox at ${cell} m`);
  let max = 0, empty = 0;
  for (const h of heights) { if (!h) empty++; else max = Math.max(max, h / 10); }
  check(empty / heights.length < 0.01, `${empty} empty terrain cells`);

  const summit = b.places.filter((p) => p.kind === 'summit').sort((x, y) => y.alt - x.alt)[0];
  check(Math.abs(max - summit.alt) < 30, `terrain max ${max.toFixed(0)} m vs highest summit ${summit.name} ${summit.alt} m (20 m cells average the top)`);

  const official = b.routes.filter((r) => r.source === 'schweizmobil');
  check(official.length >= 8, `${official.length} official routes, ${b.routes.length - official.length} curated`);
  for (const r of b.routes) {
    const n = r.e.length;
    const lengthsOk = [r.n, r.alt, r.cls, r.surf].every((a) => a.length === n);
    const altOk = r.alt.every((a) => a > 200 && a < 4700);
    const stepKm = ((n - 1) * r.step) / 1000;
    const timeOk = r.stats.time > stepKm * 9 && r.stats.time < stepKm * 60; // between 6.7 and 1 km/h
    // The app re-derives climb on load; the stored totals must match what it will show.
    const { up, down } = routeClimb(r.alt);
    const climbOk = Math.abs(up[n - 1] - r.stats.up) <= 1 && Math.abs(down[n - 1] - r.stats.down) <= 1;
    check(lengthsOk && altOk && timeOk && climbOk && r.waypoints.length >= 2, `${(r.number ?? r.id).padEnd(32)} ${r.stats.km.toFixed(1).padStart(5)} km ↑${r.stats.up} ↓${r.stats.down} ${r.stats.time} min, ${r.waypoints.length} waypoints`);
  }

  const size = ['region.json', 'terrain.u16', 'trails.bin', 'ortho.jpg', b.locator.file].reduce((s, f) => s + statSync(`${dir}/${f}`).size, 0);
  check(size < 6 * 1024 * 1024, `bundle ${(size / 1024 / 1024).toFixed(1)} MB (budget 6 MB)`);
}
