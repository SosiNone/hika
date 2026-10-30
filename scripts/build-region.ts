/**
 * Builds a region bundle from swisstopo open data: `npm run build:region alpstein`.
 * Reads regions/<id>.json, writes public/data/<id>/ and refreshes public/data/regions.json.
 * Downloads are cached in .cache/. Rebuilding from unchanged data leaves every file as it was.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { encodeGrid, encodeTrails } from '../src/data/codec';
import { BUNDLE_VERSION, type Place, type RegionBundle, type RegionConfig, type Route } from '../src/data/types';
import { polylineLength, type XY } from '../src/geo/track';
import { TrailGraph } from './lib/graph';
import { buildLocator } from './lib/locator';
import { inBox, loadPlaces, resolvePlace } from './lib/names';
import { INDEX_FILE, writeRegionIndex } from './lib/regions';
import { SOURCES } from './lib/sources';
import { finishRoute as sampleRoute, round1, STEP, type RouteContext, type RouteMeta } from './lib/route';
import { buildTerrain, encodeU16, sampleGrid } from './lib/terrain';
import { loadTrails, SegmentIndex, trailsData } from './lib/trails';
import { clipRoute, fetchRoute, listRoutes } from './lib/wanderland';

const id = process.argv[2] ?? 'alpstein';
const cfg = JSON.parse(readFileSync(`regions/${id}.json`, 'utf8')) as RegionConfig;
const out = `public/data/${id}`;
mkdirSync(out, { recursive: true });
const [minE, minN, maxE, maxN] = cfg.bbox;
const centre: [number, number] = [(minE + maxE) / 2, (minN + maxN) / 2];
const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
/** Whether any file differs from what was on disk; only then does `generated` move. */
let changed = false;
const write = (name: string, data: ArrayBufferView | string) => {
  const file = `${out}/${name}`, bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (existsSync(file) && readFileSync(file).equals(bytes)) return;
  writeFileSync(file, bytes);
  changed = true;
};
// Bundle format 1 stored the grid raw; SWISSIMAGE (ortho.jpg) was dropped in 0.13.
for (const old of ['terrain.u16', 'ortho.jpg']) rmSync(`${out}/${old}`, { force: true });

log(`terrain ${cfg.cell} m`);
const grid = await buildTerrain(cfg.bbox, cfg.cell);
let minAlt = Infinity, maxAlt = -Infinity, empty = 0;
for (const v of grid.data) {
  if (Number.isNaN(v)) empty++;
  else { minAlt = Math.min(minAlt, v); maxAlt = Math.max(maxAlt, v); }
}
write('terrain.bin', encodeGrid(encodeU16(grid.data), grid.cols));
log(`  ${grid.cols}×${grid.rows}, ${minAlt.toFixed(0)}–${maxAlt.toFixed(0)} m, ${empty} empty cells`);

log('hiking trails');
const trails = await loadTrails(cfg.bbox);
write('trails.bin', encodeTrails(trailsData(trails, cfg.bbox)));
const trailKm: [number, number, number] = [0, 0, 0];
let hardKm = 0;
for (const t of trails) {
  const km = polylineLength(t.pts.map(([e, n]) => [e, n])) / 1000;
  trailKm[t.cls] += km;
  if (t.hard) hardKm += km;
}
log(`  ${trails.length} lines, ${trailKm.map((k) => k.toFixed(0)).join(' / ')} km (W/B/A), ${hardKm.toFixed(0)} km hard surface`);
const segIndex = new SegmentIndex(trails);

log('places');
const allPlaces = await loadPlaces();
const places = allPlaces.filter((p) => inBox(p, cfg.bbox));
for (const p of places) if (!(p.alt > 0)) p.alt = Math.round(sampleGrid(grid, cfg.bbox, p.e, p.n));
log(`  ${places.length} places in region (${allPlaces.length} nationally)`);

const ctx: RouteContext = { places, segments: segIndex, heightAt: (e, n) => sampleGrid(grid, cfg.bbox, e, n) };

log('official routes (SchweizMobil)');
const routes: Route[] = [];
for (const { id: rid, label } of await listRoutes(cfg.bbox)) {
  if (cfg.excludeRoutes.includes(rid)) continue;
  const r = await fetchRoute(rid);
  const { piece, clipped, insideShare } = clipRoute(r.line, cfg.bbox);
  const insideKm = polylineLength(piece) / 1000;
  if (insideShare < cfg.minInside || insideKm < cfg.minInsideKm) {
    log(`  skip ${rid} ${label} (${(insideShare * 100).toFixed(0)} % / ${insideKm.toFixed(1)} km inside)`);
    continue;
  }
  // Orient along the title: the start should be nearer "from" than "to".
  const from = resolvePlace(allPlaces, r.from, centre), to = resolvePlace(allPlaces, r.to, centre);
  let line = r.line;
  if (from && to) {
    const d = (p: Place, q: XY) => Math.hypot(p.e - q[0], p.n - q[1]);
    const head = line[0], tail = line[line.length - 1];
    if (d(from, head) + d(to, tail) > d(from, tail) + d(to, head)) line = [...line].reverse();
  }
  const clip = line === r.line ? { piece, clipped } : clipRoute(line, cfg.bbox);
  routes.push(await finishRoute({
    id: `sm-${rid}`, number: r.number, name: r.name, from: r.from, to: r.to, source: 'schweizmobil', category: r.category, clipped: clip.clipped,
  }, clip.piece));
  log(`  ${rid} ${r.name} (${r.from} → ${r.to}): ${insideKm.toFixed(1)} km inside${r.gaps > 50 ? `, ${r.gaps.toFixed(0)} m chain gaps` : ''}`);
}

log('curated hikes (routed on the trail graph)');
const graph = new TrailGraph(trails);
for (const hike of cfg.curated) {
  const stops = hike.via.map((v) => {
    const p = resolvePlace(places, v.name, v.near ?? centre, v.kind) ?? resolvePlace(places, v.name, v.near ?? centre);
    if (!p) throw new Error(`${hike.id}: cannot resolve "${v.name}"`);
    const node = graph.nearestNode(p.e, p.n, 600);
    if (node < 0) throw new Error(`${hike.id}: "${v.name}" is not near a trail`);
    return { place: p, node };
  });
  let line: XY[] = [];
  for (let i = 1; i < stops.length; i++) {
    const leg = graph.route(stops[i - 1].node, stops[i].node);
    if (!leg) throw new Error(`${hike.id}: no trail between ${stops[i - 1].place.name} and ${stops[i].place.name}`);
    line = line.concat(i === 1 ? leg : leg.slice(1));
  }
  const [first, last] = [stops[0].place, stops[stops.length - 1].place];
  routes.push(await finishRoute({
    id: `c-${hike.id}`, number: null, name: hike.name, from: first.name, to: last.name, source: 'curated', category: 'classic', clipped: [false, false],
  }, line, stops.map((s) => s.place.id)));
  log(`  ${hike.name}: ${(polylineLength(line) / 1000).toFixed(1)} km via ${stops.map((s) => s.place.name).join(' → ')}`);
}

log('Switzerland locator');
const { locator, heights } = await buildLocator(2000);
write('switzerland.u16', encodeU16(heights));

const bundle: RegionBundle = {
  version: BUNDLE_VERSION,
  id: cfg.id,
  title: cfg.title,
  subtitle: cfg.subtitle,
  cantons: cfg.cantons,
  bbox: cfg.bbox,
  grid: { file: 'terrain.bin', cols: grid.cols, rows: grid.rows, cell: grid.cell, minAlt: Math.round(minAlt), maxAlt: Math.round(maxAlt) },
  trails: { file: 'trails.bin', lines: trails.length, vertices: trails.reduce((s, t) => s + t.pts.length, 0), km: trailKm.map(round1) as [number, number, number], hardKm: round1(hardKm) },
  places: places.map((p) => ({ ...p, e: Math.round(p.e - minE), n: Math.round(p.n - minN) })),
  routes,
  locator: { file: 'switzerland.u16', ...locator },
  sources: SOURCES,
  generated: new Date().toISOString(),
};
// Unchanged data keeps its build time, so the rebuild leaves region.json byte-identical too and
// adds nothing to git.
const previous = existsSync(`${out}/region.json`) ? (JSON.parse(readFileSync(`${out}/region.json`, 'utf8')) as RegionBundle) : null;
const sameData = previous && JSON.stringify({ ...previous, generated: '' }) === JSON.stringify({ ...bundle, generated: '' });
if (!changed && sameData) bundle.generated = previous.generated;
write('region.json', JSON.stringify(bundle));
log(`${changed ? 'wrote' : 'unchanged:'} ${out}: ${routes.length} routes, ${places.length} places`);
// Another region's config can be ahead of its bundle (a new defaultRoute, say): that must not fail
// this build. check:region still fails on a stale index.
try {
  log(`wrote ${INDEX_FILE}: ${writeRegionIndex().regions.map((r) => r.id).join(', ')}`);
} catch (err) {
  log(`${INDEX_FILE} not updated: ${(err as Error).message}; run \`npm run index:regions\` once that is fixed`);
}

/** A route as the bundle stores it: samples in metres from the bbox SW corner. */
async function finishRoute(meta: RouteMeta, line: XY[], viaIds: string[] = []): Promise<Route> {
  const { pts, alt, cls, surf, stats, waypoints } = await sampleRoute(meta, line, ctx, viaIds);
  return {
    ...meta,
    step: STEP,
    e: pts.map(([e]) => round1(e - minE)),
    n: pts.map(([, n]) => round1(n - minN)),
    alt: alt.map(round1),
    cls,
    surf,
    stats,
    waypoints,
  };
}
