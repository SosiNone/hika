import { nextWaypoint, type Region, type RouteView } from '../data/load';
import type { Place, PlaceKind } from '../data/types';
import { project } from '../gl/glkit';
import type { RenderInfo, TerrainView } from '../gl/terrain';
import { hm } from '../panels/common';
import { palette as C } from '../theme/apply';

export const GLYPH: Record<PlaceKind, string> = {
  summit: '▲', pass: '⌒', lake: '≈', inn: '⌂', stop: '◉', lift: '⇡', view: '◎', water: '⁞', cave: '◖', village: '□', ridge: '∧',
};

const FONT = '400 10px "IBM Plex Mono", monospace';
const STRONG = '500 10px "IBM Plex Mono", monospace';
const SMALL = '400 9px "IBM Plex Mono", monospace';
const TAG = '500 9px "IBM Plex Mono", monospace';
/** Metres of track either side of the hiker that set its heading arrow. */
const HEADING_SPAN = 60;
/** Time constant (s) of the heading arrow's low-pass filter. */
const HEADING_TAU = 0.15;

interface Rect { x: number; y: number; w: number; h: number }
interface Screen { x: number; y: number; w: number }
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Snaps to the pixel centre so 1 px strokes stay crisp. */
const px = (v: number) => Math.round(v) + 0.5;

/** Where a route waypoint stands relative to the preview hiker. */
type WaypointState = 'passed' | 'next' | 'ahead';

/**
 * 2D overlay on top of the terrain: place labels on leader lines with priority-based
 * collision culling, the selected route's waypoint markers, and the preview hiker.
 */
export class LabelLayer {
  private ctx: CanvasRenderingContext2D;
  private candidates: Place[];
  /** Under `prefers-reduced-motion` the markers hold still. */
  private still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** Filtered screen angle of the hiker's heading arrow, see `smoothHeading`. */
  private heading: { angle: number; t: number; route: RouteView } | null = null;

  constructor(private canvas: HTMLCanvasElement, private region: Region, private view: TerrainView) {
    this.ctx = canvas.getContext('2d')!;
    const keep: Partial<Record<PlaceKind, number>> = { summit: 60, pass: 60, lake: 50, inn: 99, stop: 45, lift: 99, view: 55 };
    this.candidates = region.bundle.places.filter((p) => p.prio >= (keep[p.kind] ?? 999)).sort((a, b) => b.prio - a.prio);
  }

  /** `t` is the frame time in seconds; it only drives the marker animation. */
  draw(info: RenderInfo, t: number, route: RouteView | null, hikerIndex: number | null, hoverIndex: number | null, waypointIds: Map<string, string>) {
    const { ctx, canvas } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const a = this.still ? 0 : t;
    const taken: Rect[] = [{ x: 0, y: 0, w: W, h: 104 }, { x: W - 150, y: 90, w: 150, h: H - 130 }, { x: 0, y: H - 34, w: W, h: 34 }];
    const at = (e: number, n: number, alt: number) => {
      const [x, y, z] = this.view.world(e, n, alt);
      return project(info.vp, x, y, z, W, H);
    };
    const next = route && hikerIndex !== null ? nextWaypoint(route, hikerIndex) : 0;
    // The hiker's callout is drawn last but claims its space first, so no label hides under it.
    const top = route && hikerIndex !== null ? at(route.e[hikerIndex], route.n[hikerIndex], route.alt[hikerIndex]) : null;
    const callout = route && top && top.w > 0 ? this.callout(top, route, hikerIndex!, next < 0, W) : null;
    if (callout) taken.push({ x: callout.x - 2, y: callout.y - 2, w: callout.w + 4, h: callout.h + 4 });

    // Route waypoints first: they win every collision.
    if (route) {
      const now = hikerIndex === null ? 0 : route.minutes[hikerIndex];
      route.waypoints.forEach((wp, k) => {
        const p = this.region.places.get(wp.place);
        if (!p) return;
        const i = Math.min(route.e.length - 1, Math.round((wp.km * 1000) / route.step));
        const s = at(route.e[i], route.n[i], route.alt[i]);
        if (s.w <= 0) return;
        const id = waypointIds.get(wp.place) ?? '';
        const state: WaypointState = next < 0 || k < next ? 'passed' : k === next ? 'next' : 'ahead';
        const end = k === 0 || k === route.waypoints.length - 1;
        const sub = state === 'passed' ? `✓ T+${hm(wp.time)}`
          : state === 'next' ? `NEXT · ETA ${hm(Math.max(0, wp.time - now))}`
          : `${Math.round(p.alt || wp.alt)} M · T+${hm(wp.time)}`;
        this.marker(s.x, s.y, state, end, a);
        // A waypoint label that would collide shrinks to its ID tag instead of disappearing.
        if (!this.waypoint(s.x, s.y, 34, id, p.name.toUpperCase(), sub, state, taken, W)) this.waypoint(s.x, s.y, 16, id, '', '', state, taken, W, true);
      });
    }
    for (const p of this.candidates) {
      const s = at(p.e, p.n, p.alt || this.view.heightAt(p.e, p.n));
      if (s.w <= 0 || s.x < 0 || s.y < 0 || s.x > W || s.y > H) continue;
      const sub = p.kind === 'summit' || p.kind === 'pass' ? `${p.alt} M` : '';
      this.label(s.x, s.y, p.kind === 'summit' ? 22 : 14, `${GLYPH[p.kind]} ${p.name.toUpperCase()}`, sub, taken, W);
    }

    if (route && top && callout) {
      const i = hikerIndex!, last = route.e.length - 1;
      const ground = at(route.e[i], route.n[i], this.region.bundle.grid.minAlt);
      // Direction of travel over HEADING_SPAN metres either side, so it also holds at the ends
      // and does not follow every kink of the track.
      const k = Math.max(2, Math.round(HEADING_SPAN / route.step));
      const [b, f] = [Math.max(0, i - k), Math.min(last, i + k)].map((j) => at(route.e[j], route.n[j], route.alt[j]));
      const target = b.w > 0 && f.w > 0 && Math.hypot(f.x - b.x, f.y - b.y) > 1 ? Math.atan2(f.y - b.y, f.x - b.x) : null;
      this.hiker(top, ground, this.smoothHeading(target, route, t), route, i, next < 0, a, callout);
    }
    // Last, so the hover readout stays on top of the hiker's callout.
    if (route && hoverIndex !== null) this.crosshair(at(route.e[hoverIndex], route.n[hoverIndex], route.alt[hoverIndex]), route.alt[hoverIndex], route.km[hoverIndex]);
  }

  /**
   * Low-pass filters the heading arrow's screen angle (exponential, time constant HEADING_TAU,
   * along the shorter way round). It snaps on a new route or when the heading was lost.
   */
  private smoothHeading(target: number | null, route: RouteView, t: number): number | null {
    const h = this.heading;
    if (target === null || !h || h.route !== route) {
      this.heading = target === null ? null : { angle: target, t, route };
      return target;
    }
    const diff = Math.atan2(Math.sin(target - h.angle), Math.cos(target - h.angle));
    h.angle += diff * (1 - Math.exp(-Math.max(0, t - h.t) / HEADING_TAU));
    h.t = t;
    return h.angle;
  }

  /** Layout of the hiker's telemetry callout, flipped left where it would run under the right-hand column. */
  private callout(top: Screen, route: RouteView, i: number, arrived: boolean, W: number) {
    const total = route.km[route.km.length - 1];
    const rows = [
      `HIKA ▸ ${arrived ? 'ARRIVED' : 'TRACKING'}`,
      `KM ${route.km[i].toFixed(1)} / ${total.toFixed(1)}  T+${hm(route.minutes[i])}`,
      `ALT ${Math.round(route.alt[i])} M  D+ ${Math.round(route.up[i])}`,
    ];
    this.ctx.font = FONT;
    const w = Math.ceil(Math.max(...rows.map((r) => this.ctx.measureText(r).width), 100)) + 14, h = 50;
    const x = px(top.x), y = px(top.y);
    const flip = x + 26 + w > W - 150;
    return { x: flip ? x - 26 - w : x + 26, y: Math.round(y - 16 - h / 2) + 0.5, w, h, flip, rows, total };
  }

  /** Claims a rect in the collision list; returns false when it overlaps something already drawn. */
  private claim(rect: Rect, taken: Rect[], force: boolean): boolean {
    if (!force && taken.some((r) => overlaps(r, rect))) return false;
    taken.push(rect);
    return true;
  }

  /** Draws a place label on a leader line; returns false when it was skipped for overlapping. */
  private label(x: number, y: number, lift: number, text: string, sub: string, taken: Rect[], W: number): boolean {
    const { ctx } = this;
    ctx.font = FONT;
    const tw = Math.max(ctx.measureText(text).width, sub ? ctx.measureText(sub).width : 0);
    const left = x + 4 + tw > W - 150 ? x - 6 - tw : x + 5;
    if (!this.claim({ x: Math.min(left, x) - 2, y: y - lift - (sub ? 22 : 12), w: tw + 10, h: lift + (sub ? 24 : 14) }, taken, false)) return false;
    // Leader line and anchor dot.
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y);
    ctx.lineTo(x + 0.5, y - lift);
    this.stroke(C.ink(0.55));
    ctx.beginPath();
    ctx.arc(x + 0.5, y, 1.8, 0, Math.PI * 2);
    ctx.fillStyle = C.text;
    ctx.fill();
    ctx.textBaseline = 'alphabetic';
    this.text(text, left, y - lift - (sub ? 10 : 0), C.text);
    if (sub) {
      ctx.font = SMALL;
      this.text(sub, left, y - lift + 1, C.text2);
    }
    return true;
  }

  /**
   * A route waypoint's label: a dog-leg leader up to an inverted ID tag, the name beside it
   * and a status line below. Returns false when it was skipped for overlapping.
   */
  private waypoint(x: number, y: number, lift: number, id: string, name: string, sub: string, state: WaypointState, taken: Rect[], W: number, force = false): boolean {
    const { ctx } = this;
    ctx.font = TAG;
    const tagW = Math.ceil(ctx.measureText(id).width) + 6;
    ctx.font = STRONG;
    const nameW = name ? ctx.measureText(name).width + 4 : 0;
    ctx.font = SMALL;
    const tw = Math.max(tagW + nameW, sub ? ctx.measureText(sub).width : 0);
    const flip = x + 12 + tw > W - 150;
    const ax = px(x), ky = px(y - lift), kx = ax + (flip ? -6 : 6);
    const left = Math.round(flip ? kx - 3 - tw : kx + 3);
    const top = ky - 8;
    const x0 = Math.min(left, ax) - 2, x1 = Math.max(left + tw, ax) + 2, bottom = Math.max(y + 4, top + (sub ? 24 : 13));
    if (!this.claim({ x: x0, y: top - 2, w: x1 - x0, h: bottom - top + 2 }, taken, force)) return false;

    const dim = state === 'passed';
    const line = dim ? C.ac(0.4) : C.ac(0.85);
    ctx.beginPath();
    ctx.moveTo(ax, y - 6);
    ctx.lineTo(ax, ky);
    ctx.lineTo(kx, ky);
    this.stroke(line);
    ctx.fillStyle = line;
    ctx.fillRect(kx - (flip ? 0 : 2), ky - 1.5, 2, 3);

    // The ID tag: background-coloured caps on an accent plate.
    const tagX = flip ? left + tw - tagW : left;
    ctx.fillStyle = dim ? C.ac(0.45) : C.accent;
    ctx.fillRect(tagX, top, tagW, 11);
    ctx.font = TAG;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.bg;
    ctx.fillText(id, tagX + 3, top + 8.5);
    if (name) {
      ctx.font = STRONG;
      this.text(name, flip ? tagX - nameW : tagX + tagW + 4, top + 9, dim ? C.text2 : C.accentTint);
    }
    if (sub) {
      ctx.font = SMALL;
      const sw = ctx.measureText(sub).width;
      this.text(sub, flip ? left + tw - sw : left, top + 21, dim ? C.text3 : state === 'next' ? C.accent : C.ac(0.9));
    }
    return true;
  }

  /** The waypoint's ground marker: a diamond, doubled with ticks at DEP/ARR, bracketed when next. */
  private marker(x: number, y: number, state: WaypointState, end: boolean, a: number) {
    const { ctx } = this;
    const cx = px(x), cy = px(y);
    const color = state === 'passed' ? C.ac(0.45) : C.accent;
    const diamond = (r: number) => {
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath();
    };
    ctx.beginPath();
    diamond(4);
    if (end) {
      diamond(7);
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) { ctx.moveTo(cx + dx * 7, cy + dy * 7); ctx.lineTo(cx + dx * 10, cy + dy * 10); }
    }
    this.stroke(color);
    if (state === 'passed') {
      ctx.beginPath();
      diamond(4);
      ctx.fillStyle = C.ac(0.3);
      ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.fillRect(cx - 1, cy - 1, 2, 2);
    if (state === 'next') {
      const h = Math.round((end ? 11 : 8) * (1 + 0.125 * (1 - Math.cos(a * 2.4))));
      this.brackets(cx - h, cy - h, 2 * h, 2 * h, 3, C.accent);
    }
  }

  /** Four L-shaped corners of a box, like the panel frames. */
  private brackets(x: number, y: number, w: number, h: number, len: number, color: string) {
    const { ctx } = this;
    ctx.beginPath();
    for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
      ctx.moveTo(cx + dx * len, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * len);
    }
    this.stroke(color);
  }

  /** Strokes the current path. No halo: the owner found outlined marks too heavy. */
  private stroke(color: string, width = 1) {
    const { ctx } = this;
    ctx.lineJoin = 'miter';
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  /** Plain text, without a halo, like the strokes. */
  private text(s: string, x: number, y: number, fill: string) {
    this.ctx.fillStyle = fill;
    this.ctx.fillText(s, x, y);
  }

  /** The profile-chart hover point: a gapped crosshair in a bracket box. */
  private crosshair(s: Screen, alt: number, km: number) {
    if (s.w <= 0) return;
    const { ctx } = this;
    const x = px(s.x), y = px(s.y);
    ctx.beginPath();
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) { ctx.moveTo(x + dx * 3, y + dy * 3); ctx.lineTo(x + dx * 9, y + dy * 9); }
    this.stroke(C.ink(0.85));
    this.brackets(x - 6, y - 6, 12, 12, 3, C.ink(0.55));
    // On a plate, since it can land on the hiker's callout.
    const readout = `${Math.round(alt)} M · KM ${km.toFixed(1)}`;
    ctx.font = SMALL;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.bgA(0.85);
    ctx.fillRect(x + 10, y - 7, ctx.measureText(readout).width + 6, 13);
    ctx.fillStyle = C.text;
    ctx.fillText(readout, x + 13, y + 3);
  }

  /**
   * The preview hiker: a rotating reticle with a sonar ping and a heading chevron, an altitude
   * stake down to the region floor, and a telemetry callout on an elbow leader.
   */
  private hiker(top: Screen, ground: Screen, heading: number | null, route: RouteView, i: number, arrived: boolean, a: number, box: ReturnType<LabelLayer['callout']>) {
    const { ctx } = this;
    const x = px(top.x), y = px(top.y);
    const TAU = Math.PI * 2;

    ctx.strokeStyle = C.ac(0.45);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x, y + 12);
    ctx.lineTo(ground.x, ground.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (ground.w > 0) {
      ctx.beginPath();
      ctx.moveTo(px(ground.x) - 4, px(ground.y));
      ctx.lineTo(px(ground.x) + 4, px(ground.y));
      this.stroke(C.ac(0.6));
    }

    if (!this.still) {
      const f = (a / 2) % 1;
      ctx.beginPath();
      ctx.arc(x, y, 6 + 20 * f, 0, TAU);
      ctx.lineWidth = 1;
      ctx.strokeStyle = C.ac(0.6 * (1 - f));
      ctx.stroke();
    }

    // Outer ring in four arcs, slowly turning; fixed ticks point at the centre.
    const rot = a * 0.35;
    ctx.beginPath();
    for (let q = 0; q < 4; q++) {
      const s = rot + (q * TAU) / 4 + 0.3;
      ctx.moveTo(x + Math.cos(s) * 11, y + Math.sin(s) * 11);
      ctx.arc(x, y, 11, s, s + TAU / 4 - 0.6);
    }
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) { ctx.moveTo(x + dx * 8, y + dy * 8); ctx.lineTo(x + dx * 5, y + dy * 5); }
    this.stroke(C.accent, 1.25);
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, TAU);
    ctx.fillStyle = C.accent;
    ctx.fill();

    if (heading !== null && !arrived) {
      const along = (d: number, side: number) => [x + Math.cos(heading) * d - Math.sin(heading) * side, y + Math.sin(heading) * d + Math.cos(heading) * side];
      ctx.beginPath();
      for (const [d, side] of [[19, 0], [14, 4], [15.5, 0], [14, -4]]) { const [cx, cy] = along(d, side); ctx.lineTo(cx, cy); }
      ctx.closePath();
      ctx.fillStyle = C.accent;
      ctx.fill();
    }

    // Telemetry callout on an elbow leader.
    const { x: bx, y: by, w, h, rows, total } = box;
    const sx = box.flip ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(x + sx * 9, y - 9);
    ctx.lineTo(x + sx * 16, y - 16);
    ctx.lineTo(x + sx * 26, y - 16);
    this.stroke(C.ac(0.85));

    ctx.fillStyle = C.bgA(0.85);
    ctx.fillRect(bx, by, w, h);
    this.brackets(bx, by, w, h, 5, C.accent);
    ctx.textBaseline = 'alphabetic';
    ctx.font = STRONG;
    ctx.fillStyle = C.accent;
    ctx.fillText(rows[0], bx + 7, by + 13);
    ctx.font = FONT;
    ctx.fillStyle = C.text;
    ctx.fillText(rows[1], bx + 7, by + 26);
    ctx.font = SMALL;
    ctx.fillStyle = C.text2;
    ctx.fillText(rows[2], bx + 7, by + 37);

    // Progress along the route, with a pip per waypoint.
    const bar = { x: bx + 7, y: by + h - 7, w: w - 14 };
    ctx.fillStyle = C.ink(0.25);
    ctx.fillRect(bar.x, bar.y, bar.w, 1);
    ctx.fillStyle = C.accent;
    ctx.fillRect(bar.x, bar.y - 0.5, Math.round(bar.w * (total ? route.km[i] / total : 0)), 2);
    ctx.fillStyle = C.ink(0.6);
    for (const wp of route.waypoints) ctx.fillRect(Math.round(bar.x + bar.w * (total ? Math.min(1, wp.km / total) : 0)) - 0.5, bar.y - 2, 1, 5);
  }
}
