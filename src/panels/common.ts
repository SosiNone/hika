import type { Region, RouteView } from '../data/load';
import type { RegionSummary } from '../data/types';
import type { TerrainView } from '../gl/terrain';
import type { Playlist } from '../playlist';
import type { Store } from '../state';

export interface Ctx {
  region: Region;
  /** Every region the app offers (public/data/regions.json), the current one included. */
  regions: RegionSummary[];
  /** Opens another region; the page reloads on its `?region=` URL. */
  goToRegion(id: string): void;
  /** Opens the region browser (src/ui/regionBrowser.ts). */
  openRegions(): void;
  store: Store;
  view: TerrainView;
  route(): RouteView;
  /** Sample index of the preview hiker on the selected route. */
  hikerIndex(): number;
  /** Place id -> short label (DEP, P1 … ARR) for the selected route. */
  waypointIds(): Map<string, string>;
  /** The region's routes in play order. */
  playlist: Playlist;
  /** Next (1) or previous (-1) route; previous restarts the current one once it is under way. */
  skip(dir: 1 | -1): void;
}

/** Fills a panel element with the slot/title header and returns its body. */
export function frame(el: HTMLElement, slot: string, title: string, meta = '', scroll = false): { body: HTMLElement; meta: HTMLElement } {
  el.innerHTML = `<div class="panel-head"><span class="slot">${slot}</span><h2>${title}</h2><span class="meta"></span></div><div class="panel-body${scroll ? ' scroll' : ''}"></div>`;
  const m = el.querySelector<HTMLElement>('.meta')!;
  m.textContent = meta;
  return { body: el.querySelector<HTMLElement>('.panel-body')!, meta: m };
}

/** A canvas filling `parent`, re-sized to the device pixel ratio before each draw. */
export function chart(parent: HTMLElement) {
  const canvas = document.createElement('canvas');
  canvas.className = 'fill';
  parent.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  return {
    canvas,
    ctx,
    /** Prepares the canvas and returns its CSS size. */
    begin() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      return { w, h };
    },
  };
}

/** 2502 -> "2 502" (thin-space thousands, as on Swiss maps). */
export const num = (v: number, digits = 0) => v.toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export const hm = (min: number) => `${Math.floor(min / 60)}:${String(Math.floor(min % 60)).padStart(2, '0')}`;

/** The live display palette (src/theme/apply.ts); it changes in place when the scheme does. */
export { palette as COLORS } from '../theme/apply';

export const FONT = (size = 9, weight = 300) => `${weight} ${size}px "IBM Plex Mono", monospace`;

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
