import './styles/hud.css';
import { indexAtMinute, loadRegion, loadRegionIndex, reverseRoute, type Region, type RouteView } from './data/load';
import type { RegionSummary } from './data/types';
import { project } from './gl/glkit';
import { RoutePicker } from './gl/picker';
import { TerrainView, type TrailMode } from './gl/terrain';
import { LabelLayer } from './hud/labels';
import { mountCumulative, mountGradient, mountProfile } from './panels/charts';
import type { Ctx } from './panels/common';
import { mountPreview, mountRoutes, mountTrailClass, mountWaypoints } from './panels/left';
import { mountLocator, mountLog, mountTerrainStats } from './panels/right';
import { Playlist } from './playlist';
import { pickRegion, regionHref } from './regions';
import { Store } from './state';
import { applyDisplay, loadDisplay, palette, saveDisplay } from './theme/apply';
import { mountDisplaySwitch, mountRegionPicker, renderTickers, showVersion, startClock } from './ui/chrome';
import { mountRegionBrowser } from './ui/regionBrowser';

// Before the region loads, so the boot screen already wears the chosen scheme.
const initialDisplay = loadDisplay();
applyDisplay(initialDisplay);
showVersion(document.getElementById('version') as HTMLAnchorElement);

async function boot() {
  const bootEl = document.getElementById('boot')!;
  try {
    const { regions } = await loadRegionIndex();
    const summary = pickRegion(regions, location.search);
    if (!summary) throw new Error('data/regions.json lists no regions');
    bootEl.textContent = `LOADING ${summary.title.toUpperCase()}…`;
    document.title = `HIKA · ${summary.title}`;
    const region = await loadRegion(summary.id);
    start(region, summary, regions);
    bootEl.classList.add('done');
    setTimeout(() => bootEl.remove(), 700);
  } catch (err) {
    bootEl.classList.add('error');
    bootEl.textContent = `Could not start: ${(err as Error).message}`;
    throw err;
  }
}

function start(region: Region, summary: RegionSummary, regions: RegionSummary[]) {
  const hash = new URLSearchParams(location.hash.slice(1));
  const fromHash = hash.get('route');
  const store = new Store({
    routeId: region.routes.some((r) => r.id === fromHash) ? fromHash! : region.routes.find((r) => r.id === summary.defaultRoute)?.id ?? region.routes[0].id,
    reversed: region.routes.some((r) => r.id === fromHash) && hash.get('reverse') === '1',
    hoverRouteId: null,
    hoverIndex: null,
    minute: 0,
    playing: true,
    secondsPerHour: 3,
    repeat: false,
    shuffle: false,
    mode: 'mono',
    display: initialDisplay,
  });
  const byId = new Map(region.routes.map((r) => [r.id, r]));
  // Reversed views are derived on first use and kept, so panels can cache on the route object.
  const reversedById = new Map<string, RouteView>();
  const route = () => {
    const { routeId, reversed } = store.state;
    if (!reversed) return byId.get(routeId)!;
    if (!reversedById.has(routeId)) reversedById.set(routeId, reverseRoute(byId.get(routeId)!));
    return reversedById.get(routeId)!;
  };
  let ids = waypointIds(route());
  const playlist = new Playlist(region.routes);
  /** When the preview, held at the finish, moves on (0 = not holding). */
  let holdUntil = 0;
  /** Set while the playlist moves on by itself, so a view the user framed is kept. */
  let autoAdvance = false;
  const skip = (dir: 1 | -1) => {
    const s = store.state;
    // Like a music player: "previous" first rewinds a route that has played for over 2 s.
    if (dir < 0 && (s.minute / 60) * s.secondsPerHour > 2) store.set({ minute: 0, playing: true });
    else store.set({ routeId: playlist.step(s.routeId, dir), reversed: false, minute: 0, playing: true });
  };

  const canvas = document.getElementById('terrain') as HTMLCanvasElement;
  const view = new TerrainView(canvas, region);
  view.palette = palette.gl;
  const labels = new LabelLayer(document.getElementById('terrain-hud') as HTMLCanvasElement, region, view);
  // A region is a different bundle, so switching is a page load: the back button returns to the last one.
  const goToRegion = (id: string) => { if (id !== region.bundle.id) location.assign(regionHref(id, location.href)); };
  const browser = mountRegionBrowser(region, regions, view, goToRegion);
  const openRegions = () => browser.open();
  const ctx: Ctx = { region, regions, goToRegion, openRegions, store, view, route, hikerIndex: () => indexAtMinute(route(), store.state.minute), waypointIds: () => ids, playlist, skip };
  mountRegionPicker(document.getElementById('brand-sub')!, regions, summary, openRegions);
  const overlay = mountStageOverlay(region, store, view);

  const panels = [
    mountPreview(document.getElementById('p-preview')!, ctx),
    mountWaypoints(document.getElementById('p-waypoints')!, ctx),
    mountTrailClass(document.getElementById('p-class')!, ctx),
    mountRoutes(document.getElementById('p-routes')!, ctx),
    mountProfile(document.getElementById('p-profile')!, ctx),
    mountGradient(document.getElementById('p-gradient')!, ctx),
    mountLocator(document.getElementById('p-locator')!, ctx),
    mountCumulative(document.getElementById('p-cumulative')!, ctx),
    mountTerrainStats(document.getElementById('p-terrainstats')!, ctx),
    mountLog(document.getElementById('p-log')!, ctx),
  ];

  const selectRoute = (r: RouteView, fly = true) => {
    ids = waypointIds(r);
    view.setRoute(r);
    renderTickers(region, r, ids);
    if (fly && !(autoAdvance && view.camera.framed)) flyToRoute(view, r);
    history.replaceState(null, '', `#route=${r.id}${store.state.reversed ? '&reverse=1' : ''}`);
  };
  selectRoute(route());
  store.subscribe((s, prev) => {
    // Reversing keeps the route's footprint, so the camera stays put.
    if (s.routeId !== prev.routeId || s.reversed !== prev.reversed) {
      selectRoute(route(), s.routeId !== prev.routeId);
      holdUntil = 0;
    }
    if (s.shuffle !== prev.shuffle) playlist.setShuffle(s.shuffle, s.routeId);
    // The selected route is never ghosted, also when it becomes or stops being the hovered one.
    if (s.hoverRouteId !== prev.hoverRouteId || s.routeId !== prev.routeId) {
      const hover = s.hoverRouteId && s.hoverRouteId !== s.routeId ? byId.get(s.hoverRouteId)! : null;
      view.setHover(hover);
      canvas.classList.toggle('over-route', hover !== null);
    }
    if (s.mode !== prev.mode) view.mode = s.mode === 'natural' ? 1 : 0;
    if (s.display !== prev.display) {
      applyDisplay(s.display);
      saveDisplay(s.display);
      view.palette = palette.gl;
    }
  });

  // Click or tap on the map selects the nearest route under the pointer; a resting mouse hovers it.
  const picker = new RoutePicker(
    canvas,
    (x, y, radius) => pickRoute(region, view, lastVp, x, y, canvas.clientWidth, canvas.clientHeight, radius),
    (id) => { if (id !== store.state.routeId) store.set({ routeId: id, reversed: false, minute: 0, playing: true }); },
    (id) => store.set({ hoverRouteId: id }),
  );
  view.camera.attach(canvas, () => {});
  window.addEventListener('hashchange', () => {
    const hash = new URLSearchParams(location.hash.slice(1));
    const id = hash.get('route'), reversed = hash.get('reverse') === '1';
    if (id && byId.has(id) && (id !== store.state.routeId || reversed !== store.state.reversed)) store.set({ routeId: id, reversed, minute: 0, playing: true });
  });

  // Space plays / pauses, ← / → change route, G opens the region browser. Focused controls and an
  // open dialog keep their own keys.
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const t = e.target as HTMLElement;
    if (t.isContentEditable || /^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(t.tagName) || t.closest?.('dialog')) return;
    const action: Record<string, () => void> = {
      ' ': () => store.set({ playing: !store.state.playing }),
      MediaPlayPause: () => store.set({ playing: !store.state.playing }),
      ArrowLeft: () => skip(-1),
      MediaTrackPrevious: () => skip(-1),
      ArrowRight: () => skip(1),
      MediaTrackNext: () => skip(1),
      g: openRegions,
      G: openRegions,
    };
    if (!action[e.key]) return;
    e.preventDefault();
    action[e.key]();
  });

  startClock(region);
  mountDisplaySwitch(document.getElementById('display')!, store);

  let last = performance.now(), lastPanels = 0;
  let lastVp = view.camera.viewProj(1);
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    const s = store.state, r = route();
    const total = r.minutes[r.minutes.length - 1];
    if (s.playing) {
      // Advance silently (panels poll the state); hold 2.5 s at the finish, then loop the route
      // (repeat) or play the next one.
      if (s.minute < total) store.state.minute = Math.min(total, s.minute + (dt * 60) / s.secondsPerHour);
      else if (!holdUntil) holdUntil = now + 2500;
      else if (now > holdUntil) {
        holdUntil = 0;
        if (s.repeat) store.state.minute = 0;
        else {
          autoAdvance = true;
          skip(1);
          autoAdvance = false;
        }
      }
    }
    const hiker = indexAtMinute(r, store.state.minute);
    const info = view.render(t, dt);
    lastVp = info.vp;
    picker.frame(now, view.camera.flying);
    labels.draw(info, t, r, hiker, store.state.hoverIndex, ids);
    overlay(info, r, hiker);
    if (now - lastPanels > 50) {
      lastPanels = now;
      for (const p of panels) p(t);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

/** DEP, P1 … Pn, ARR for the waypoints of a route. */
function waypointIds(r: RouteView): Map<string, string> {
  const m = new Map<string, string>();
  r.waypoints.forEach((w, i) => m.set(w.place, i === 0 ? 'DEP' : i === r.waypoints.length - 1 ? 'ARR' : `P${i}`));
  return m;
}

function flyToRoute(view: TerrainView, r: RouteView) {
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity, maxA = 0;
  for (let i = 0; i < r.e.length; i++) {
    minE = Math.min(minE, r.e[i]); maxE = Math.max(maxE, r.e[i]);
    minN = Math.min(minN, r.n[i]); maxN = Math.max(maxN, r.n[i]);
    maxA = Math.max(maxA, r.alt[i]);
  }
  const [x, , z] = view.world((minE + maxE) / 2, (minN + maxN) / 2, 0);
  const extent = Math.max(maxE - minE, maxN - minN, 3000);
  view.camera.flyTo({ target: [x, (maxA - view.base) * view.exaggeration * 0.45, z], dist: Math.min(42000, extent * 1.9 + 4000) });
}

function pickRoute(region: Region, view: TerrainView, vp: Float32Array, x: number, y: number, w: number, h: number, radius: number): string | null {
  let best: string | null = null, bd = radius;
  for (const r of region.routes) {
    for (let i = 0; i < r.e.length; i += 3) {
      const [wx, wy, wz] = view.world(r.e[i], r.n[i], r.alt[i] + 6);
      const s = project(vp, wx, wy, wz, w, h);
      if (s.w <= 0) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) { bd = d; best = r.id; }
    }
  }
  return best;
}

/** Stage chrome inside the terrain panel: title, camera readout, toggles, status, LV95 column, altitude meter. */
function mountStageOverlay(region: Region, store: Store, view: TerrainView) {
  const stage = document.getElementById('p-terrain')!;
  const el = document.createElement('div');
  el.className = 'stage-overlay';
  // Mouse and keyboard hints, or touch hints on a touch screen (hud.css picks one).
  const hints = (items: string[]) => items.map((h) => `<span>${h}</span>`).join('');
  el.innerHTML = `
    <div class="stage-head"><span class="slot">01</span><span class="title">${region.bundle.title.toUpperCase()} — HIKING NETWORK</span></div>
    <div class="stage-readout" data-k="cam"></div>
    <div class="stage-toggles"><div class="seg" role="group" aria-label="Colour mode"><button data-mode="mono" aria-pressed="true">MONO</button><button data-mode="natural" aria-pressed="false">SWISSIMAGE</button></div>
      <button class="btn" data-k="vert">VERT ×1.5</button>
      <button class="btn" data-k="trails"></button></div>
    <div class="stage-route" data-k="route"></div>
    <div class="coords" data-k="coords"></div>
    <div class="alt-meter" data-k="meter" aria-hidden="true"></div>
    <div class="stage-hints">${hints(['DRAG · ORBIT', 'RIGHT-DRAG · PAN', 'WHEEL · ZOOM', 'CLICK · SELECT ROUTE', 'DBL-CLICK · RESET', 'SPACE · PLAY', '←/→ · ROUTE', 'G · REGIONS'])}</div>
    <div class="stage-hints touch">${hints(['DRAG · ORBIT', 'PINCH · ZOOM', 'TWO FINGERS · PAN', 'TAP · SELECT ROUTE', 'DOUBLE-TAP · RESET'])}</div>
    <div class="stage-status" data-k="status"></div>`;
  stage.appendChild(el);
  const q = (k: string) => el.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
  el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
    b.onclick = () => {
      store.set({ mode: b.dataset.mode as 'mono' | 'natural' });
      el.querySelectorAll('[data-mode]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
    };
  });
  const exags = [1, 1.5, 2, 3];
  q('vert').onclick = () => {
    view.exaggeration = exags[(exags.indexOf(view.exaggeration) + 1) % exags.length];
    q('vert').textContent = `VERT ×${view.exaggeration}`;
  };
  const trailModes: [TrailMode, string][] = [
    ['auto', 'Trail network: the trails branching off the selected route'],
    ['all', 'Trail network: always shown'],
    ['off', 'Trail network: hidden, the selected route only'],
  ];
  const showTrailMode = () => {
    q('trails').textContent = `TRAILS ${view.trailMode.toUpperCase()}`;
    q('trails').title = trailModes.find(([m]) => m === view.trailMode)![1];
  };
  q('trails').onclick = () => {
    view.trailMode = trailModes[(trailModes.findIndex(([m]) => m === view.trailMode) + 1) % trailModes.length][0];
    showTrailMode();
  };
  showTrailMode();
  const { grid } = region.bundle;
  // Altitude meter: a scale in round 500 m steps, a band over the range the scan sweeps, and a
  // marker that follows the scan line.
  const lo = Math.floor(grid.minAlt / 500) * 500, hi = Math.ceil(grid.maxAlt / 500) * 500;
  const pct = (alt: number) => `${((alt - lo) / (hi - lo)) * 100}%`;
  const ticks: string[] = [];
  for (let a = lo; a <= hi; a += 100) {
    ticks.push(a % 500 ? `<i style="bottom:${pct(a)}"></i>` : `<i class="major" style="bottom:${pct(a)}"></i><span style="bottom:${pct(a)}">${a}</span>`);
  }
  q('meter').innerHTML = `<b class="range" style="bottom:${pct(grid.minAlt)};top:calc(100% - ${pct(grid.maxAlt)})"></b>${ticks.join('')}<div class="mark">▸<s></s><em></em></div>`;
  const mark = q('meter').querySelector<HTMLElement>('.mark')!, markValue = mark.querySelector('em')!;
  let lastIdx = -1;
  return (info: { focus: number; scanAlt: number; fps: number; points: number }, r: RouteView, hiker: number) => {
    const c = view.camera;
    const deg = (v: number) => ((((v * 180) / Math.PI) % 360) + 360) % 360;
    q('cam').textContent = `CAM AZ ${deg(c.az).toFixed(1).padStart(5)}°  EL ${deg(c.el).toFixed(1)}°  R ${(c.dist / 1000).toFixed(1)} KM\nFOCUS ${(info.focus / 1000).toFixed(1)} KM  VERT ×${view.exaggeration}  GRID ${grid.cell} M`;
    mark.style.bottom = pct(info.scanAlt);
    markValue.textContent = String(Math.round(info.scanAlt));
    q('route').textContent = `${r.number ? `ROUTE ${r.number}` : '★ CLASSIC'} · ${r.name.toUpperCase()}${store.state.reversed ? ' · REVERSED' : ''}`;
    q('status').textContent = `SCAN ALT ${Math.round(info.scanAlt)} M   HIKA T+${Math.floor(r.minutes[hiker] / 60)}:${String(Math.floor(r.minutes[hiker] % 60)).padStart(2, '0')}\nPTS ${info.points.toLocaleString('en').replace(/,/g, ' ')}   ${Math.round(info.fps)} FPS`;
    if (hiker !== lastIdx) {
      lastIdx = hiker;
      const [e0, n0] = [region.bundle.bbox[0], region.bundle.bbox[1]];
      const rows: string[] = [];
      for (let k = -14; k <= 14; k++) {
        const i = Math.min(r.e.length - 1, Math.max(0, hiker + k * 4));
        const line = `${Math.round(e0 + r.e[i])} ${Math.round(n0 + r.n[i])} ${String(Math.round(r.alt[i])).padStart(4)} ${r.km[i].toFixed(1).padStart(4)}`;
        rows.push(k === 0 ? `<div class="now">▸ ${line}</div>` : `<div>${line}</div>`);
      }
      q('coords').innerHTML = rows.join('');
    }
  };
}

boot();
