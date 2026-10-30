import { nextWaypoint, type Region, type RouteView, type TerrainWindow } from '../data/load';
import type { Place, PlaceKind } from '../data/types';
import { project } from '../gl/glkit';
import type { RenderInfo, TerrainView } from '../gl/terrain';
import { hm } from '../panels/common';
import { pointer } from './pointer';
import { palette as C } from '../theme/apply';

export const GLYPH: Record<PlaceKind, string> = {
  summit: '▲', pass: '⌒', lake: '≈', inn: '⌂', stop: '◉', lift: '⇡', view: '◎', water: '⁞', cave: '◖', village: '□', ridge: '∧',
};

const FONT = '400 10px "IBM Plex Mono", monospace';
const STRONG = '500 10px "IBM Plex Mono", monospace';
const SMALL = '400 9px "IBM Plex Mono", monospace';
/** Radius of a waypoint's ground ring, as a fraction of its distance from the camera. */
const RING = 0.022;
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
/** A waypoint pin's colours: only the next one takes the accent, passed ones fade back. */
const tone = (state: WaypointState) =>
  state === 'next' ? { stroke: C.ac(0.6), mark: C.accent, name: C.accentTint, sub: C.accent }
  : state === 'ahead' ? { stroke: C.ink(0.45), mark: C.text, name: C.text, sub: C.text2 }
  : { stroke: C.ink(0.25), mark: C.text3, name: C.text3, sub: C.text3 };

/**
 * 2D overlay on top of the terrain: place labels on leader lines with priority-based
 * collision culling, the selected route's waypoint markers, and the preview hiker.
 */
export class LabelLayer {
  private ctx: CanvasRenderingContext2D;
  /** The places worth a label in the view's window, best first; picked again when the window changes. */
  private candidates: Place[] = [];
  private candidatesOf: TerrainWindow | null = null;
  /** Under `prefers-reduced-motion` the markers hold still. */
  private still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** Filtered screen angle of the hiker's heading arrow, see `smoothHeading`. */
  private heading: { angle: number; t: number; route: RouteView } | null = null;

  constructor(private canvas: HTMLCanvasElement, private region: Region, private view: TerrainView) {
    this.ctx = canvas.getContext('2d')!;
  }

  private labelled(): Place[] {
    const win = this.view.win;
    if (this.candidatesOf !== win) {
      const keep: Partial<Record<PlaceKind, number>> = { summit: 60, pass: 60, lake: 50, inn: 99, stop: 45, lift: 99, view: 55 };
      this.candidates = win.places.filter((p) => p.prio >= (keep[p.kind] ?? 999)).sort((a, b) => b.prio - a.prio);
      this.candidatesOf = win;
    }
    return this.candidates;
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
        const breathe = state === 'next' ? 1 + 0.12 * (1 - Math.cos(a * 2.4)) : 1;
        this.ring(at, route.e[i], route.n[i], route.alt[i], info.eye, tone(state).stroke, breathe * info.markers);
        // A waypoint label that would collide shrinks to its ID instead of disappearing.
        if (!this.waypoint(s.x, s.y, 34, id, p.name.toUpperCase(), sub, state, end, info.markers, taken, W)) this.waypoint(s.x, s.y, 16, id, '', '', state, end, info.markers, taken, W, true);
      });
    }
    for (const p of this.labelled()) {
      const s = at(p.e, p.n, p.alt || this.view.heightAt(p.e, p.n));
      if (s.w <= 0 || s.x < 0 || s.y < 0 || s.x > W || s.y > H) continue;
      const sub = p.kind === 'summit' || p.kind === 'pass' ? `${p.alt} M` : '';
      this.label(s.x, s.y, p.kind === 'summit' ? 22 : 14, `${GLYPH[p.kind]} ${p.name.toUpperCase()}`, sub, taken, W);
    }

    // Screen direction of travel at sample i, over HEADING_SPAN metres either side, so it also
    // holds at the ends and does not follow every kink of the track.
    const screenHeading = (route: RouteView, i: number) => {
      const k = Math.max(2, Math.round(HEADING_SPAN / route.step)), last = route.e.length - 1;
      const [b, f] = [Math.max(0, i - k), Math.min(last, i + k)].map((j) => at(route.e[j], route.n[j], route.alt[j]));
      return b.w > 0 && f.w > 0 && Math.hypot(f.x - b.x, f.y - b.y) > 1 ? Math.atan2(f.y - b.y, f.x - b.x) : null;
    };
    if (route && top && callout) {
      const i = hikerIndex!;
      const ground = at(route.e[i], route.n[i], this.view.win.grid.minAlt);
      this.hiker(top, ground, this.smoothHeading(screenHeading(route, i), route, t), route, i, a, info.markers, callout);
    }
    // Last, so the hover readout stays on top of the hiker's callout.
    if (route && hoverIndex !== null) this.hoverMark(at(route.e[hoverIndex], route.n[hoverIndex], route.alt[hoverIndex]), screenHeading(route, hoverIndex), route.alt[hoverIndex], route.km[hoverIndex], info.markers);
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
      `ALT ${Math.round(route.alt[i])} M  ↑${Math.round(route.up[i])} M`,
    ];
    this.ctx.font = FONT;
    const w = Math.ceil(Math.max(...rows.map((r) => this.ctx.measureText(r).width), 100)) + 14, h = 50;
    const x = px(top.x), y = px(top.y);
    // Right of the hiker, clear of the LV95 column; left where it would reach that and fits; on
    // screen either way (a phone's map is narrower than two callouts).
    const flip = x + 26 + w > W - 150 && x - 26 - w >= 0;
    return { x: flip ? x - 26 - w : Math.max(4, Math.min(W - w - 4, x + 26)), y: Math.round(y - 16 - h / 2) + 0.5, w, h, flip, rows, total };
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
   * A route waypoint's pin and label: a straight leader up from the ground to a small hollow
   * circle (larger at DEP/ARR), the ID and name beside it and a status line below. `zoom` (see
   * `RenderInfo.markers`) shrinks the circle, by its square root so it stays hollow. Returns
   * false when it was skipped for overlapping.
   */
  private waypoint(x: number, y: number, lift: number, id: string, name: string, sub: string, state: WaypointState, end: boolean, zoom: number, taken: Rect[], W: number, force = false): boolean {
    const { ctx } = this;
    ctx.font = STRONG;
    const idW = ctx.measureText(id).width;
    ctx.font = FONT;
    const rowW = idW + (name ? ctx.measureText(name).width + 5 : 0);
    ctx.font = SMALL;
    const tw = Math.max(rowW, sub ? ctx.measureText(sub).width : 0);
    const m = Math.sqrt(zoom), r = (end ? 5 : 3.5) * m;
    const ax = px(x), cy = px(y - lift);
    const flip = x + 10 + tw > W - 150;
    const left = Math.round(flip ? ax - 10 - tw : ax + 10);
    const x0 = Math.min(left, ax - r) - 2, x1 = Math.max(left + tw, ax + r) + 2, top = cy - 12, bottom = Math.max(y + 4, cy + 11);
    if (!this.claim({ x: x0, y: top, w: x1 - x0, h: bottom - top }, taken, force)) return false;

    const c = tone(state);
    ctx.beginPath();
    ctx.moveTo(ax, y);
    ctx.lineTo(ax, cy + r);
    ctx.moveTo(ax + r, cy);
    ctx.arc(ax, cy, r, 0, Math.PI * 2);
    this.stroke(c.stroke);
    ctx.beginPath();
    ctx.arc(ax, cy, 1.6 * m, 0, Math.PI * 2);
    ctx.fillStyle = c.mark;
    ctx.fill();

    ctx.textBaseline = 'alphabetic';
    const rx = flip ? left + tw - rowW : left, base = sub ? cy - 3 : cy + 3.5;
    ctx.font = STRONG;
    this.text(id, rx, base, c.mark);
    if (name) {
      ctx.font = FONT;
      this.text(name, rx + idW + 5, base, c.name);
    }
    if (sub) {
      ctx.font = SMALL;
      const sw = ctx.measureText(sub).width;
      this.text(sub, flip ? left + tw - sw : left, cy + 9, c.sub);
    }
    return true;
  }

  /**
   * A waypoint's ground ring: a level circle around the track, projected so it lies flat on the
   * terrain. Its radius grows with the camera distance, so it keeps about the same size on screen
   * before `scale` (which carries the zoom, `RenderInfo.markers`) shrinks it.
   */
  private ring(at: (e: number, n: number, alt: number) => Screen, e: number, n: number, alt: number, eye: number[], color: string, scale: number) {
    const { ctx } = this;
    const [x, y, z] = this.view.world(e, n, alt);
    const r = Math.hypot(x - eye[0], y - eye[1], z - eye[2]) * RING * scale;
    ctx.beginPath();
    let open = false;
    for (let k = 0; k <= 32; k++) {
      const q = (k / 32) * Math.PI * 2, s = at(e + Math.cos(q) * r, n + Math.sin(q) * r, alt);
      if (s.w <= 0) { open = false; continue; }
      if (open) ctx.lineTo(s.x, s.y);
      else ctx.moveTo(s.x, s.y);
      open = true;
    }
    this.stroke(color);
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

  /** The profile-chart hover point: an outlined arrowhead along the track, like the chart's hover cursor. */
  private hoverMark(s: Screen, heading: number | null, alt: number, km: number, zoom: number) {
    if (s.w <= 0) return;
    const { ctx } = this;
    const x = px(s.x), y = px(s.y);
    pointer(ctx, x, y, heading ?? -Math.PI / 2, C.ink(0.85), false, 1.5 * zoom);
    // On a plate, since it can land on the hiker's callout.
    const readout = `${Math.round(alt)} M · KM ${km.toFixed(1)}`;
    ctx.font = SMALL;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.bgA(0.85);
    ctx.fillRect(x + 12, y - 7, ctx.measureText(readout).width + 6, 13);
    ctx.fillStyle = C.text;
    ctx.fillText(readout, x + 15, y + 3);
  }

  /**
   * The preview hiker: a filled arrowhead along the track (the charts' pointer) with a sonar ping,
   * an altitude stake down to the region floor, and a telemetry callout on an elbow leader. The
   * arrowhead and ping shrink with `zoom` (`RenderInfo.markers`); the callout keeps its size.
   */
  private hiker(top: Screen, ground: Screen, heading: number | null, route: RouteView, i: number, a: number, zoom: number, box: ReturnType<LabelLayer['callout']>) {
    const { ctx } = this;
    const x = px(top.x), y = px(top.y);
    const TAU = Math.PI * 2;

    ctx.strokeStyle = C.ac(0.45);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x, y + 12 * zoom);
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
      ctx.arc(x, y, (6 + 20 * f) * zoom, 0, TAU);
      ctx.lineWidth = 1;
      ctx.strokeStyle = C.ac(0.6 * (1 - f));
      ctx.stroke();
    }

    // Keeps pointing the last way walked after arrival; straight up if the track is off screen.
    pointer(ctx, x, y, heading ?? -Math.PI / 2, C.accent, true, 1.8 * zoom);

    // Telemetry callout on an elbow leader.
    const { x: bx, y: by, w, h, rows, total } = box;
    const sx = box.flip ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(x + sx * 11 * zoom, y - 11 * zoom);
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
