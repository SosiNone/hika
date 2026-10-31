/**
 * Previews the areas of regions/*.json as build-atlas will cut them: `npm run preview:regions`.
 *
 *   npm run preview:regions                    route counts per range and area, and .cache/regions/preview.svg
 *   npm run preview:regions -- --routes        the SVG also draws every route, in the colour of its home area
 *   npm run preview:regions -- --range <id>    the SVG shows that range only
 *   npm run preview:regions -- --places <id>   huts, lifts, stops, lakes and summits in an area, for curated hikes
 *
 * It needs no atlas: the routes come from Wanderland Schweiz as build-atlas reads them, and the
 * terrain from the download cache (a national build fills it). Curated hikes count in their own area.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { PlaceKind, RegionConfig } from '../src/data/types';
import type { XY } from '../src/geo/track';
import { buildPartition, RANGES, type Partition } from './lib/areas';
import { loadPlaces, resolvePlace } from './lib/names';
import { cellAt, listing, ringPoints, routeShares } from './lib/partition';
import { loadWanderland } from './lib/wanderland';

/** The route counts an area should have: fewer makes a thin list, more a long one. */
const FEW = 12, MANY = 45;
const OUT = '.cache/regions/preview.svg';

const args = process.argv.slice(2);
const value = (name: string) => args[args.indexOf(name) + 1];
const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const configs = readdirSync('regions').filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(`regions/${f}`, 'utf8')) as RegionConfig);
const places = await loadPlaces();
const p = await buildPartition(configs, places, log);
const ids = p.configs.map((c) => c.id);

if (args.includes('--places')) {
  const a = ids.indexOf(value('--places'));
  if (a < 0) throw new Error(`no regions/${value('--places')}.json`);
  const inside = places.filter((q) => p.labels[cellAt(p.grid, q.e, q.n)] === a);
  for (const kind of ['inn', 'lift', 'stop', 'lake', 'summit', 'pass', 'view', 'water'] as PlaceKind[]) {
    const ps = inside.filter((q) => q.kind === kind && !(kind === 'summit' && q.prio < 60) && !(kind === 'stop' && q.prio < 45)).sort((x, y) => y.prio - x.prio || y.alt - x.alt);
    console.log(`${kind === 'stop' ? 'rail stops' : kind} (${ps.length}): ${ps.map((q) => `${q.name} ${q.alt}`).join(' | ')}\n`);
  }
  process.exit(0);
}

log('routes (Wanderland Schweiz)');
const excluded = new Set(p.configs.flatMap((c) => c.excludeRoutes));
const home = new Array<number>(ids.length).fill(0), listed = new Array<number>(ids.length).fill(0);
const lines: { line: XY[]; home: number }[] = [];
let routes = 0, listings = 0;
for (const r of await loadWanderland()) {
  if (excluded.has(r.id) || r.line.length < 2) continue;
  const shares = routeShares(p.grid, p.labels, r.line);
  // build-atlas leaves out routes mostly abroad (MIN_SWISS).
  if ([...shares.metres.values()].reduce((s, m) => s + m, 0) < shares.total / 2) continue;
  const areas = listing(shares, p.configs);
  routes++;
  listings += areas.length;
  home[areas[0]]++;
  for (const a of areas) listed[a]++;
  lines.push({ line: r.line, home: areas[0] });
}
p.configs.forEach((c, a) => { home[a] += c.curated.length; listed[a] += c.curated.length; });
log(`  ${routes} SchweizMobil routes, listed in ${(listings / routes).toFixed(2)} areas on average`);

for (const [r, range] of RANGES.entries()) {
  const members = ids.map((_, a) => a).filter((a) => p.areaRange[a] === r).sort((a, b) => p.configs[a].title.localeCompare(p.configs[b].title, 'de'));
  console.log(`\n${range.title.toUpperCase()} (${range.name}): ${members.length} areas`);
  for (const a of members) {
    const [w, h] = extentKm(p, a), n = listed[a];
    const flag = n < FEW ? `  fewer than ${FEW}` : n > MANY ? `  more than ${MANY}` : '';
    const curated = p.configs[a].curated.length;
    console.log(`  ${ids[a].padEnd(18)} ${p.configs[a].title.padEnd(32)} ${String(Math.round(p.km2[a])).padStart(5)} km²  ${w}×${h} km  ${String(n).padStart(3)} routes (${home[a]} home${curated ? `, ${curated} curated` : ''})  ${Math.round(p.rangeShare[a] * 100)} % in range${p.configs[a].range ? ' (set)' : ''}${flag}`);
  }
}
// A curated hike lists in its own area: its waypoints should lie there (build-atlas resolves them within 5 km of it).
for (const [a, cfg] of p.configs.entries()) for (const hike of cfg.curated) {
  const away = hike.via.flatMap((v) => {
    const q = resolvePlace(places, v.name, v.near ?? p.areaLabels[a], v.kind) ?? resolvePlace(places, v.name, v.near ?? p.areaLabels[a]);
    const at = q ? p.labels[cellAt(p.grid, q.e, q.n)] : -2;
    return at === a ? [] : [`${v.name} ${at === -2 ? 'not found' : `in ${ids[at] ?? 'no area'}`}`];
  });
  if (away.length) log(`curated ${ids[a]}/${hike.id}: ${away.join(', ')}`);
}
for (const x of p.exclaves) log(`exclave: ${ids[x.area]} has a separate part of ${x.km2.toFixed(1)} km² at ${x.at.map(Math.round).join(', ')}`);

mkdirSync('.cache/regions', { recursive: true });
writeFileSync(OUT, svg(p, args.includes('--routes') ? lines : [], value('--range')));
log(`wrote ${OUT}`);

/** Width and height of an area's extent, whole km. */
function extentKm(p: Partition, a: number): [number, number] {
  const pts = p.areaRings[a].flatMap((refs) => ringPoints(p.arcs, refs));
  const es = pts.map(([e]) => e), ns = pts.map(([, n]) => n);
  return [Math.round((Math.max(...es) - Math.min(...es)) / 1000), Math.round((Math.max(...ns) - Math.min(...ns)) / 1000)];
}

/** The partition as an SVG map, one pixel per raster cell: areas tinted by range, range borders bold. */
function svg(p: Partition, routes: { line: XY[]; home: number }[], only?: string): string {
  const [minE, , , maxN] = p.grid.bbox, s = p.grid.cell;
  const x = (e: number) => ((e - minE) / s).toFixed(1), y = (n: number) => ((maxN - n) / s).toFixed(1);
  const path = (rings: number[][]) => rings.map((refs) => `M${ringPoints(p.arcs, refs).map(([e, n]) => `${x(e)},${y(n)}`).join('L')}Z`).join('');
  const hue = (r: number) => (r * 360) / RANGES.length;
  const rank = new Array<number>(ids.length);
  RANGES.forEach((_, r) => ids.map((_, a) => a).filter((a) => p.areaRange[a] === r).forEach((a, k) => (rank[a] = k)));
  let view = `0 0 ${p.grid.cols} ${p.grid.rows}`;
  if (only) {
    const r = RANGES.findIndex((range) => range.id === only);
    if (r < 0) throw new Error(`no range ${only}`);
    const pts = p.rangeRings[r].flatMap((refs) => ringPoints(p.arcs, refs));
    const xs = pts.map(([e]) => (e - minE) / s), ys = pts.map(([, n]) => (maxN - n) / s);
    view = `${Math.min(...xs) - 20} ${Math.min(...ys) - 20} ${Math.max(...xs) - Math.min(...xs) + 40} ${Math.max(...ys) - Math.min(...ys) + 40}`;
  }
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" font-family="sans-serif">`, '<rect x="-1000" y="-1000" width="5000" height="5000" fill="#f4f4f0"/>'];
  ids.forEach((id, a) => {
    const r = p.areaRange[a];
    out.push(`<path d="${path(p.areaRings[a])}" fill="hsl(${hue(r)} 45% ${62 + (rank[a] % 4) * 7}%)" fill-rule="evenodd" stroke="#fff" stroke-width="0.8"><title>${id}: ${esc(p.configs[a].title)}, ${listed[a]} routes</title></path>`);
  });
  for (const { line, home: a } of routes) {
    out.push(`<polyline points="${line.filter((_, k) => k % 4 === 0 || k === line.length - 1).map(([e, n]) => `${x(e)},${y(n)}`).join(' ')}" fill="none" stroke="hsl(${hue(p.areaRange[a])} 70% 25%)" stroke-width="0.6" opacity="0.7"/>`);
  }
  RANGES.forEach((_, r) => out.push(`<path d="${path(p.rangeRings[r])}" fill="none" fill-rule="evenodd" stroke="#222" stroke-width="2"/>`));
  RANGES.forEach((range, r) => {
    const [e, n] = p.rangeLabels[r];
    out.push(`<text x="${x(e)}" y="${y(n)}" font-size="22" font-weight="bold" fill="#000" opacity="0.25" text-anchor="middle">${esc(range.title.toUpperCase())}</text>`);
  });
  for (const { area, at: [e, n] } of p.exclaves) {
    out.push(`<circle cx="${x(e)}" cy="${y(n)}" r="6" fill="none" stroke="#b00" stroke-width="2"/><text x="${x(e) + 8}" y="${y(n)}" font-size="8" fill="#b00">part of ${ids[area]}</text>`);
  }
  ids.forEach((id, a) => {
    const [e, n] = p.areaLabels[a];
    const flag = listed[a] < FEW || listed[a] > MANY ? ' fill="#b00"' : '';
    out.push(`<text x="${x(e)}" y="${y(n)}" font-size="9" text-anchor="middle"${flag}>${id}<tspan x="${x(e)}" dy="10">${listed[a]}</tspan></text>`);
  });
  out.push('</svg>');
  return out.join('\n');
}
