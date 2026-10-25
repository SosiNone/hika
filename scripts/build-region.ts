/**
 * Builds a region bundle from swisstopo open data: `npm run build:region alpstein`.
 * Reads regions/<id>.json, writes public/data/<id>/ and refreshes public/data/regions.json.
 * Downloads are cached in .cache/.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { OFF_NETWORK, type Place, type RegionBundle, type RegionConfig, type Route, type Waypoint } from '../src/data/types';
import { cumulativeMinutes, MAX_SLOPE, smoothAltitudes } from '../src/geo/hikingTime';
import { polylineLength, resample, routeClimb, type XY } from '../src/geo/track';
import { TrailGraph } from './lib/graph';
import { buildLocator } from './lib/locator';
import { inBox, loadPlaces, resolvePlace } from './lib/names';
import { buildOrtho } from './lib/ortho';
import { profileHeights } from './lib/profile';
import { INDEX_FILE, writeRegionIndex } from './lib/regions';
import { buildTerrain, encodeU16, sampleGrid } from './lib/terrain';
import { encodeTrails, loadTrails, SegmentIndex, type TrailLine } from './lib/trails';
import { clipRoute, fetchRoute, listRoutes } from './lib/wanderland';

const STEP = 10;

const id = process.argv[2] ?? 'alpstein';
const cfg = JSON.parse(readFileSync(`regions/${id}.json`, 'utf8')) as RegionConfig;
const out = `public/data/${id}`;
mkdirSync(out, { recursive: true });
const [minE, minN, maxE, maxN] = cfg.bbox;
const centre: [number, number] = [(minE + maxE) / 2, (minN + maxN) / 2];
const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

log(`terrain ${cfg.cell} m`);
const grid = await buildTerrain(cfg.bbox, cfg.cell);
let minAlt = Infinity, maxAlt = -Infinity, empty = 0;
for (const v of grid.data) {
  if (Number.isNaN(v)) empty++;
  else { minAlt = Math.min(minAlt, v); maxAlt = Math.max(maxAlt, v); }
}
writeFileSync(`${out}/terrain.u16`, encodeU16(grid.data));
log(`  ${grid.cols}×${grid.rows}, ${minAlt.toFixed(0)}–${maxAlt.toFixed(0)} m, ${empty} empty cells`);

log('orthophoto');
const ortho = await buildOrtho(cfg.bbox, cfg.orthoZoom, cfg.orthoWidth);
writeFileSync(`${out}/ortho.jpg`, ortho.jpeg);
log(`  ${ortho.width}×${ortho.height}, ${(ortho.jpeg.length / 1024).toFixed(0)} KB`);

log('hiking trails');
const trails = await loadTrails(cfg.bbox);
writeFileSync(`${out}/trails.bin`, encodeTrails(trails, cfg.bbox));
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
writeFileSync(`${out}/switzerland.u16`, encodeU16(heights));

const bundle: RegionBundle = {
  version: 1,
  id: cfg.id,
  title: cfg.title,
  subtitle: cfg.subtitle,
  cantons: cfg.cantons,
  bbox: cfg.bbox,
  grid: { cols: grid.cols, rows: grid.rows, cell: grid.cell, minAlt: Math.round(minAlt), maxAlt: Math.round(maxAlt) },
  ortho: { file: 'ortho.jpg', width: ortho.width, height: ortho.height },
  trails: { file: 'trails.bin', lines: trails.length, vertices: trails.reduce((s, t) => s + t.pts.length, 0), km: trailKm.map(round1) as [number, number, number], hardKm: round1(hardKm) },
  places: places.map((p) => ({ ...p, e: Math.round(p.e - minE), n: Math.round(p.n - minN) })),
  routes,
  locator: { file: 'switzerland.u16', ...locator },
  sources: [
    { name: 'swissALTI3D', owner: 'swisstopo', url: 'https://www.swisstopo.admin.ch/en/height-model-swissalti3d' },
    { name: 'SWISSIMAGE 10 cm', owner: 'swisstopo', url: 'https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10' },
    { name: 'swissTLM3D Wanderwege', owner: 'swisstopo', url: 'https://www.swisstopo.admin.ch/en/landscape-model-swisstlm3d' },
    { name: 'swissNAMES3D', owner: 'swisstopo', url: 'https://www.swisstopo.admin.ch/en/landscape-model-swissnames3d' },
    { name: 'swissBOUNDARIES3D', owner: 'swisstopo', url: 'https://www.swisstopo.admin.ch/en/landscape-model-swissboundaries3d' },
    { name: 'Wanderland Schweiz', owner: 'SchweizMobil / ASTRA', url: 'https://www.schweizmobil.ch/en/hiking-in-switzerland' },
    { name: 'Profile service (DTM2)', owner: 'geo.admin.ch', url: 'https://api3.geo.admin.ch/services/sdiservices.html#profile' },
  ],
  generated: new Date().toISOString(),
};
writeFileSync(`${out}/region.json`, JSON.stringify(bundle));
log(`wrote ${out}/region.json: ${routes.length} routes, ${places.length} places`);
log(`wrote ${INDEX_FILE}: ${writeRegionIndex().regions.map((r) => r.id).join(', ')}`);

function round1(v: number) { return Math.round(v * 10) / 10; }

/** Samples a route every STEP metres and derives heights, trail class, stats and waypoints. */
async function finishRoute(meta: Omit<Route, 'step' | 'e' | 'n' | 'alt' | 'cls' | 'surf' | 'stats' | 'waypoints'>, line: XY[], viaIds: string[] = []): Promise<Route> {
  const pts = resample(line, STEP);
  const alt = (await profileHeights(pts)).map((h, i) => (Number.isNaN(h) ? sampleGrid(grid, cfg.bbox, pts[i][0], pts[i][1]) : h));
  const cls: number[] = [], surf: number[] = [];
  for (const [e, n] of pts) {
    const t: TrailLine | undefined = segIndex.nearest(e, n, 15);
    cls.push(t ? t.cls : OFF_NETWORK);
    surf.push(t?.hard ? 1 : 0);
  }
  const minutes = cumulativeMinutes(alt, STEP);
  const back = cumulativeMinutes([...alt].reverse(), STEP);
  const smooth = smoothAltitudes(alt, 3);
  const climbed = routeClimb(alt);
  const up = climbed.up[climbed.up.length - 1], down = climbed.down[climbed.down.length - 1];
  const classKm: [number, number, number, number] = [0, 0, 0, 0];
  let hard = 0, steep = 0;
  for (let i = 1; i < pts.length; i++) {
    const km = STEP / 1000;
    classKm[cls[i] === OFF_NETWORK ? 3 : cls[i]] += km;
    if (surf[i]) hard += km;
    if (Math.abs(smooth[i] - smooth[i - 1]) / STEP * 100 > MAX_SLOPE) steep += km;
  }
  const km = ((pts.length - 1) * STEP) / 1000;
  return {
    ...meta,
    step: STEP,
    e: pts.map(([e]) => round1(e - minE)),
    n: pts.map(([, n]) => round1(n - minN)),
    alt: alt.map(round1),
    cls,
    surf,
    stats: {
      km: round1(km), up: Math.round(up), down: Math.round(down),
      time: Math.round(minutes[minutes.length - 1]), timeBack: Math.round(back[back.length - 1]),
      minAlt: Math.round(Math.min(...alt)), maxAlt: Math.round(Math.max(...alt)),
      classKm: classKm.map(round1) as [number, number, number, number], hardKm: round1(hard), steepKm: round1(steep),
    },
    waypoints: waypointsAlong(pts, alt, minutes, viaIds, meta),
  };
}

/**
 * Places a hiker passes: summits, passes, inns, stops, viewpoints and lakes near the route,
 * thinned so that within 250 m along the route only the most important one is kept.
 */
function waypointsAlong(pts: XY[], alt: number[], minutes: Float64Array, viaIds: string[], meta: Pick<Route, 'id' | 'from' | 'to' | 'clipped'>): Waypoint[] {
  const reach: Partial<Record<Place['kind'], number>> = { summit: 60, pass: 60, inn: 80, stop: 80, lift: 80, view: 60, lake: 350, water: 60, cave: 40, village: 120 };
  const hits: { p: Place; i: number }[] = [];
  for (const p of places) {
    const max = reach[p.kind];
    if (max === undefined || (p.kind === 'village' && p.prio < 30)) continue;
    let bi = -1, bd = max;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - p.e, pts[i][1] - p.n);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi >= 0) hits.push({ p, i: bi });
  }
  const forced = new Set(viaIds);
  hits.sort((a, b) => Number(forced.has(b.p.id)) - Number(forced.has(a.p.id)) || b.p.prio - a.p.prio);
  const kept: { p: Place; i: number }[] = [];
  for (const h of hits) if (forced.has(h.p.id) || !kept.some((k) => Math.abs(k.i - h.i) * STEP < 250)) kept.push(h);
  kept.sort((a, b) => a.i - b.i);
  // Every route gets a departure and an arrival: the nearest named place, or a marker at the region edge.
  for (const end of [0, 1] as const) {
    const i = end ? pts.length - 1 : 0;
    const have = end ? kept[kept.length - 1] : kept[0];
    if (have && Math.abs(have.i - i) * STEP <= 300) continue;
    const [e, n] = pts[i];
    const near = meta.clipped[end] ? undefined : places
      .map((p) => ({ p, d: Math.hypot(p.e - e, p.n - n) }))
      .filter((x) => x.d < 600)
      .sort((a, b) => a.d - b.d)[0]?.p;
    const towards = end ? meta.to : meta.from;
    const p = near ?? { id: `${meta.id}-${end ? 'end' : 'start'}`, name: meta.clipped[end] ? `Region edge → ${towards}` : towards, kind: 'village' as const, e, n, alt: Math.round(alt[i]), prio: 0 };
    if (!near) places.push(p);
    if (end) kept.push({ p, i }); else kept.unshift({ p, i });
  }
  return kept.map(({ p, i }) => ({ place: p.id, km: round1((i * STEP) / 1000), alt: Math.round(alt[i]), time: Math.round(minutes[i]) }));
}

