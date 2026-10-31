import { loadDetailRelief, prefetchRegion, type Atlas, type Region } from '../data/load';
import type { CatalogueEntry, RangeSummary, RegionSummary } from '../data/types';
import { formatDuration } from '../geo/hikingTime';
import type { TerrainView } from '../gl/terrain';
import { cameraCone, hitTarget, rangeDetail, regionDetail, SwissMap, type Sway, type Target } from '../hud/switzerland';
import { chart, esc, num } from '../panels/common';
import { filterRegions, filterRoutes } from '../regions';

/** Route results shown at most; the count says how many more match. */
const MAX_ROUTES = 40;

/** The view-transition names the tile and the browser hand between them (styled in hud.css): the frame, and the map in it. */
const MORPH = 'region-browser', MORPH_MAP = 'region-browser-map';

/** Whether at least half of `el` is in the viewport. */
function onScreen(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.right > 0 && r.left < innerWidth && Math.min(r.bottom, innerHeight) - Math.max(r.top, 0) > r.height / 2;
}

/**
 * The region browser: a dialog with a large map of Switzerland and a list beside it, in two levels.
 * On the whole country, the map and the list show the mountain ranges; choosing one zooms the map
 * into it, and the list shows its areas (back, or Escape, zooms out again). The filter searches the
 * areas of every range (by name, place, official name in any language, canton or range), listed
 * under their ranges, and from two characters on every route in the atlas, listed below them; when
 * the areas found all lie in one range, the map zooms into it. The map and the list share one active
 * entry; hovering either or moving with ↑ / ↓ in the filter sets it, and lingering on an area warms
 * the cache. An active route is pinned on the map. A click opens an area (`go`) or a route (`open`);
 * on a touch screen a tap on the map first picks the area, and a tap on its list entry (or the same
 * area again) opens it.
 *
 * It is the locator panel (G), `tile`, grown: the same title, and the same map at the same angle
 * (`sway`). A view transition grows the tile into the browser while the two cross-fade, with the
 * map moving on its own from the tile's body to the browser's map pane, and closing shrinks it
 * back. With the tile scrolled off screen it zooms in and out on its own. Without view transitions,
 * or under prefers-reduced-motion, it opens and closes at once.
 */
export function mountRegionBrowser(atlas: Atlas, region: Region, view: TerrainView, go: (id: string) => void, open: (routeId: string) => void, tile: HTMLElement, sway: Sway) {
  const current = region.summary.id, regions = atlas.regions, ranges = atlas.ranges, routes = [...atlas.catalogue.values()];
  const areaById = new Map(regions.map((r) => [r.id, r])), rangeById = new Map(ranges.map((g) => [g.id, g]));
  // Areas listed under their ranges, in the ranges' order.
  const grouped = ranges.flatMap((g) => regions.filter((r) => r.range === g.id));
  const dialog = document.createElement('dialog');
  dialog.className = 'region-browser';
  dialog.setAttribute('aria-labelledby', 'rb-title rb-meta');
  dialog.innerHTML = `
    <div class="panel-head"><span class="slot">G</span><button class="btn rb-back" data-k="back" hidden aria-label="Back to Switzerland">‹ CH</button><h2 id="rb-title">Switzerland</h2><span class="meta" id="rb-meta"></span><button class="btn icon" data-k="close" aria-label="Close"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg></button></div>
    <div class="rb-body">
      <div class="rb-map"></div>
      <div class="rb-side">
        <input class="rb-filter" type="search" role="combobox" aria-expanded="true" aria-controls="rb-list" aria-autocomplete="list" aria-label="Search areas by name, place, canton or range, and routes by name, number or place" placeholder="SEARCH · AREA, ROUTE, PLACE, CANTON" autocomplete="off" spellcheck="false">
        <div class="rb-empty" role="status" hidden>NOTHING MATCHES</div>
        <div class="rb-list" id="rb-list" role="listbox" aria-label="Ranges, areas and routes">${ranges.map((g) => rangeItem(g, regions)).join('')}${ranges.map((g) => `<div class="rb-group" data-range="${esc(g.id)}" hidden>${esc(g.title.toUpperCase())}</div>${regions.filter((r) => r.range === g.id).map(item).join('')}`).join('')}<div class="rb-routes" role="group" aria-label="Routes"></div></div>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  const q = <T extends HTMLElement>(s: string) => dialog.querySelector<T>(s)!;
  const meta = q('.meta'), title = q('#rb-title'), back = q<HTMLButtonElement>('[data-k="back"]'), empty = q('.rb-empty');
  const filter = q<HTMLInputElement>('.rb-filter'), list = q('.rb-list'), close = q<HTMLButtonElement>('[data-k="close"]');
  const routeList = q('.rb-routes');
  /** Every option by key: `g:` and a range's id, an area's id, or `r:` and a route's id for the route results shown. */
  const items = new Map([...list.querySelectorAll<HTMLElement>('[role="option"]')].map((el) => [el.dataset.key!, el]));
  const headers = new Map([...list.querySelectorAll<HTMLElement>('.rb-group[data-range]')].map((el) => [el.dataset.range!, el]));
  /** The route behind a key, or undefined. */
  const routeOf = (key: string | null) => (key?.startsWith('r:') ? atlas.catalogue.get(key.slice(2)) : undefined);
  /** The range or area a key lights up on the map: a route lights up its home area. */
  const shapeOf = (key: string | null) => (key ? (key.startsWith('g:') ? key.slice(2) : routeOf(key)?.regions[0] ?? (key.startsWith('r:') ? null : key)) : null);
  for (const key of [current, `g:${region.summary.range}`]) {
    items.get(key)?.classList.add('current');
    items.get(key)?.querySelector('.rb-line')!.insertAdjacentHTML('beforeend', '<em>CURRENT</em>');
  }
  const ch = chart(q('.rb-map'));
  const map = new SwissMap(atlas.locator, atlas.swiss, atlas.index, current);
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** The range zoomed into, or null for the whole country. */
  let focus: string | null = null;
  let matchIds: Set<string> | null = null, active: string | null = null, picked: string | null = null, mapHover: string | null = null;
  let targets: Target[] = [], pointerType = 'mouse', dwell = 0, frame = 0;
  // `shown` is the state asked for, which a view transition reaches a frame or two later.
  let shown = false, named: HTMLElement[] = [], morphing: ViewTransition | null = null;

  /**
   * Gives the transition's names to `el` (the tile or the dialog) alone, and with `withMap` the map
   * name to its map: two elements holding a name would abort the transition.
   */
  const name = (el: HTMLElement | null, withMap: boolean) => {
    for (const n of named) n.style.viewTransitionName = '';
    const map = withMap ? el?.querySelector<HTMLElement>('canvas.fill') : null;
    named = [el, map].filter((n): n is HTMLElement => !!n);
    if (el) el.style.viewTransitionName = MORPH;
    if (map) map.style.viewTransitionName = MORPH_MAP;
  };
  /**
   * Runs `update` (open or close) as a view transition in which `from` becomes `to`. When both are
   * there, their maps morph on their own; with one alone, it zooms as one picture.
   */
  const morph = (from: HTMLElement | null, to: HTMLElement | null, update: () => void): Promise<unknown> => {
    if (still || !document.startViewTransition) { update(); return Promise.resolve(); }
    const withMap = !!from && !!to;
    name(from, withMap);
    const vt = document.startViewTransition(() => { update(); name(to, withMap); });
    morphing = vt;
    // A newer transition skips this one and takes the names over.
    const done = () => { if (morphing === vt) { name(null, false); morphing = null; } };
    vt.finished.then(done, done);
    return vt.finished.catch(() => {});
  };
  /** The tile to grow from or shrink back into, while it is on screen. */
  const anchor = () => (onScreen(tile) ? tile : null);

  /** Closes the browser, shrinking it back into the tile, which shows the whole country. */
  const shut = () => {
    if (!shown) return;
    shown = false;
    focus = null;
    draw(performance.now(), false);
    morph(dialog, anchor(), () => dialog.close());
  };
  /** Zooms into a range, or (null) out to the whole country. */
  const zoomTo = (id: string | null) => {
    if (id === focus) return;
    focus = id;
    picked = null;
    applyFilter(false);
  };
  /** Zooms into a range, opens an area (the current one just closes the browser) or opens a route. */
  const choose = (key: string) => {
    const r = routeOf(key);
    if (r) { shut(); open(r.id); } else if (key.startsWith('g:')) zoomTo(key.slice(2)); else if (key === current) shut(); else go(key);
  };
  const setActive = (key: string | null, scroll = false) => {
    if (key === active) return;
    if (active) items.get(active)?.setAttribute('aria-selected', 'false');
    active = key;
    clearTimeout(dwell);
    if (!key) { filter.removeAttribute('aria-activedescendant'); return; }
    const el = items.get(key)!;
    el.setAttribute('aria-selected', 'true');
    filter.setAttribute('aria-activedescendant', el.id);
    if (scroll) el.scrollIntoView({ block: 'nearest' });
    // Lingering warms the cache for an area, or for the area a route opens in.
    const warm = key.startsWith('g:') ? null : routeOf(key)?.regions[0] ?? (key.startsWith('r:') ? null : key);
    if (warm && warm !== current) dwell = window.setTimeout(() => prefetchRegion(atlas, warm), 200);
  };
  /** The options shown, in list order. */
  const shownKeys = () => [...list.querySelectorAll<HTMLElement>('[role="option"]:not([hidden])')].map((el) => el.dataset.key!);
  /**
   * Shows what the level and the filter ask for: the ranges, a range's areas, or the areas the
   * filter finds under their ranges and the routes it finds. A search whose areas all lie in one
   * range zooms into it (`follow`, not when the user zoomed by hand).
   */
  const applyFilter = (follow = true) => {
    const query = filter.value.trim();
    const matches = query ? filterRegions(grouped, query, ranges) : [];
    const keep = new Set(matches.map((r) => r.id));
    matchIds = query ? keep : null;
    if (follow && query) {
      const inRanges = new Set(matches.map((r) => r.range));
      focus = inRanges.size === 1 ? [...inRanges][0] : null;
    }
    for (const g of ranges) {
      items.get(`g:${g.id}`)!.hidden = !!query || focus !== null;
      headers.get(g.id)!.hidden = !query || !matches.some((r) => r.range === g.id);
    }
    for (const r of regions) items.get(r.id)!.hidden = query ? !keep.has(r.id) : focus !== r.range;
    // Routes, once the filter has two characters: the first MAX_ROUTES, and how many match.
    for (const key of [...items.keys()]) if (key.startsWith('r:')) items.delete(key);
    const found = query.length >= 2 ? filterRoutes(routes, query) : [];
    routeList.innerHTML = found.length ? `<div class="rb-group">ROUTES · ${found.length > MAX_ROUTES ? `${MAX_ROUTES} OF ` : ''}${found.length}</div>${found.slice(0, MAX_ROUTES).map((r) => routeItem(r, areaById)).join('')}` : '';
    for (const el of routeList.querySelectorAll<HTMLElement>('[role="option"]')) items.set(el.dataset.key!, el);
    // The active route's option was rebuilt: mark it again.
    if (active) items.get(active)?.setAttribute('aria-selected', 'true');
    empty.hidden = !query || matches.length > 0 || found.length > 0;
    const g = focus ? rangeById.get(focus)! : null;
    title.textContent = g ? g.title : 'Switzerland';
    back.hidden = !g;
    meta.textContent = query
      ? `${matches.length} / ${regions.length} AREAS${found.length ? ` · ${found.length} ROUTES` : ''}`
      : g ? rangeDetail(g) : `${ranges.length} RANGES · ${regions.length} AREAS`;
    const keys = shownKeys();
    if (!active || !keys.includes(active)) setActive(keys.find((k) => k === current || k === `g:${region.summary.range}`) ?? keys[0] ?? null, true);
    if (picked && !keys.includes(picked)) picked = null;
  };

  // The list: hover sets the active entry (with a mouse), a click or tap chooses it.
  list.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const key = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]')?.dataset.key;
    if (key) setActive(key);
  });
  list.addEventListener('click', (e) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]')?.dataset.key;
    if (key) choose(key);
  });
  filter.addEventListener('input', () => applyFilter());
  filter.addEventListener('keydown', (e) => {
    const keys = shownKeys(), k = active ? keys.indexOf(active) : -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = keys[Math.max(0, Math.min(keys.length - 1, k + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) setActive(next, true);
    } else if (e.key === 'Enter' && active) {
      e.preventDefault();
      choose(active);
    }
  });
  back.onclick = () => {
    filter.value = '';
    zoomTo(null);
  };

  // The map: hover lights up a range or an area; a click zooms into a range or opens an area (a
  // tap picks the area first, as opening it is a page load).
  const keyOf = (t: Target) => (t.kind === 'range' ? `g:${t.id}` : t.id);
  const at = (e: MouseEvent) => {
    const r = ch.canvas.getBoundingClientRect();
    return hitTarget(targets, e.clientX - r.left, e.clientY - r.top, pointerType === 'mouse' ? 4 : 12);
  };
  ch.canvas.addEventListener('pointerdown', (e) => { pointerType = e.pointerType; });
  ch.canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const t = at(e);
    ch.canvas.style.cursor = t ? 'pointer' : '';
    mapHover = t?.id ?? null;
    // Another range, behind the one zoomed into, lights up on the map only.
    if (t && !items.get(keyOf(t))?.hidden) setActive(keyOf(t), true);
  });
  ch.canvas.addEventListener('pointerleave', () => { mapHover = null; });
  ch.canvas.addEventListener('click', (e) => {
    const t = at(e);
    if (!t) { picked = null; return; }
    if (t.kind === 'range') { if (t.id !== focus) { filter.value = ''; zoomTo(t.id); } return; }
    if (pointerType === 'mouse' || t.id === picked) choose(t.id);
    else {
      picked = t.id;
      setActive(t.id, true);
      if (t.id !== current) prefetchRegion(atlas, t.id);
    }
  });

  close.onclick = shut;
  // A click on the backdrop closes the dialog: it lands on the dialog element, outside its box.
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) shut();
  });
  // Escape clears the filter, then zooms out, then shrinks the browser back (unless the browser
  // won't let the page hold the close: then it just closes).
  dialog.addEventListener('cancel', (e) => {
    if (!e.cancelable) return;
    e.preventDefault();
    if (filter.value) { filter.value = ''; applyFilter(); }
    else if (focus) zoomTo(null);
    else shut();
  });
  dialog.addEventListener('close', () => {
    shown = false;
    cancelAnimationFrame(frame);
    frame = 0;
    // The tile held its angle behind the browser; from there it sways on.
    sway.held = false;
  });
  // Back from the next area may restore this page from the bfcache with the browser still open.
  window.addEventListener('pageshow', () => { if (dialog.open) dialog.close(); });

  const draw = (now: number, animate = !still) => {
    const { w, h } = ch.begin(), route = routeOf(active);
    targets = map.draw(ch.ctx, w, h, {
      theta: still ? 0 : sway.theta,
      labels: 'all',
      focus,
      animate,
      hover: mapHover ?? shapeOf(active),
      // An active route is pinned at its middle.
      mark: route ? [(route.bbox[0] + route.bbox[2]) / 2, (route.bbox[1] + route.bbox[3]) / 2] : null,
      selected: picked,
      pulse: still ? undefined : now / 1000,
      cone: cameraCone(view),
      detail: (t) => (t.kind === 'area' ? regionDetail(areaById.get(t.id)!) : rangeDetail(rangeById.get(t.id)!)),
      match: matchIds,
    });
  };
  const loop = (now: number) => {
    draw(now);
    frame = requestAnimationFrame(loop);
  };

  return {
    /** Opens the browser on the whole country, and with `range` zooms into it once open. */
    open(range?: string) {
      if (shown) return;
      shown = true;
      // The finer relief for zooming in, fetched once.
      const fine = atlas.locator.detail;
      if (fine) loadDetailRelief(atlas).then((h) => { if (h) map.setDetail({ bbox: atlas.locator.bbox, cols: fine.cols, rows: fine.rows, cell: fine.cell }, h); });
      const grown = morph(anchor(), dialog, () => {
        // The tile holds its angle behind the browser, which draws the map at it.
        sway.held = true;
        filter.value = '';
        picked = null;
        focus = null;
        // A finger gets the list, not a keyboard popping up over it.
        const finePointer = matchMedia('(pointer: fine)').matches;
        filter.autofocus = finePointer;
        close.autofocus = !finePointer;
        dialog.showModal();
        setActive(null);
        applyFilter(false);
        // Drawn now, so the transition's picture of the browser already has the map.
        draw(performance.now(), false);
        frame = requestAnimationFrame(loop);
        // The rows tick in one after another, like the log.
        if (!still) [...items.values()].filter((el) => !el.hidden).forEach((el, k) => el.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 120 + Math.min(k, 12) * 20, easing: 'ease-out', fill: 'backwards' }));
      });
      // It grows out of the tile on the whole country, as the tile shows it, then zooms in.
      if (range && rangeById.has(range)) grown.then(() => { if (shown) zoomTo(range); });
    },
  };
}

/** The trail-class bar and the facts line of a range or an area. */
function facts(routes: number, classics: number, [w, b, a]: number[], alt: [number, number]): string {
  const bar = [['wander', w], ['berg', b], ['alpin', a]].map(([c, km]) => `<i style="flex:${km};background:var(--${c})"></i>`).join('');
  return `<div class="rb-facts"><span>${routes} ROUTES${classics ? ` · ${classics} CLASSICS` : ''} · ${num(w + b + a)} KM</span><span>${num(alt[0])}–${num(alt[1])} M</span></div>
    <div class="rb-classes" title="Trails: ${num(w)} km Wanderweg · ${num(b)} km Bergwanderweg · ${num(a)} km Alpinwanderweg">${bar}</div>`;
}

/** One range in the list: name, its areas, its official names, and the facts of its areas together. */
function rangeItem(g: RangeSummary, regions: RegionSummary[]): string {
  const mine = regions.filter((r) => r.range === g.id);
  const km = [0, 1, 2].map((k) => mine.reduce((s, r) => s + r.trailKm[k], 0));
  const alt: [number, number] = [Math.min(...mine.map((r) => r.alt[0])), Math.max(...mine.map((r) => r.alt[1]))];
  return `<div class="rb-item rb-range" role="option" id="rb-g-${esc(g.id)}" data-key="g:${esc(g.id)}" aria-selected="false">
    <div class="rb-line"><b>${esc(g.title.toUpperCase())}</b><span>${g.areas.length} AREAS ›</span></div>
    <div class="rb-sub">${esc(g.names.join(' · '))}</div>
    ${facts(g.routes, mine.reduce((s, r) => s + r.classics, 0), km, alt)}
  </div>`;
}

/** One area in the list: name, cantons, places, route counts, altitude range and the trail classes. */
function item(r: RegionSummary): string {
  return `<div class="rb-item" role="option" id="rb-${esc(r.id)}" data-key="${esc(r.id)}" aria-selected="false" hidden>
    <div class="rb-line"><b>${esc(r.title.toUpperCase())}</b><span>${esc(r.cantons.join(' / '))}</span></div>
    <div class="rb-sub">${esc(r.subtitle)}</div>
    ${facts(r.routes, r.classics, r.trailKm, r.alt)}
  </div>`;
}

/** One route in the search results: number, name, its home area, its ends and its length. */
function routeItem(r: CatalogueEntry, areas: Map<string, RegionSummary>): string {
  const where = areas.get(r.regions[0])?.title ?? '';
  return `<div class="rb-item rb-route" role="option" id="rb-r-${esc(r.id)}" data-key="r:${esc(r.id)}" aria-selected="false">
    <div class="rb-line"><b>${esc(r.number ?? '★')} · ${esc(r.name.toUpperCase())}</b><span>${esc(where.toUpperCase())}</span></div>
    <div class="rb-sub">${esc(r.from)} → ${esc(r.to)}</div>
    <div class="rb-facts"><span>${r.stats.km.toFixed(1)} KM · ↑${num(r.stats.up)} ↓${num(r.stats.down)} · ${formatDuration(r.stats.time, true)}</span><span>${r.category.toUpperCase()}</span></div>
  </div>`;
}
