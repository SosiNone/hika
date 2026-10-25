import type { Region, RouteView } from '../data/load';
import type { Place, PlaceKind } from '../data/types';
import { project } from '../gl/glkit';
import type { RenderInfo, TerrainView } from '../gl/terrain';
import { palette as C } from '../theme/apply';

export const GLYPH: Record<PlaceKind, string> = {
  summit: '▲', pass: '⌒', lake: '≈', inn: '⌂', stop: '◉', lift: '⇡', view: '◎', water: '⁞', cave: '◖', village: '□', ridge: '∧',
};

const FONT = '400 10px "IBM Plex Mono", monospace';
const STRONG = '500 10px "IBM Plex Mono", monospace';
const SMALL = '400 9px "IBM Plex Mono", monospace';

interface Rect { x: number; y: number; w: number; h: number }
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * 2D overlay on top of the terrain: place labels on leader lines with priority-based
 * collision culling, the selected route's waypoint IDs, and the preview hiker.
 */
export class LabelLayer {
  private ctx: CanvasRenderingContext2D;
  private candidates: Place[];

  constructor(private canvas: HTMLCanvasElement, private region: Region, private view: TerrainView) {
    this.ctx = canvas.getContext('2d')!;
    const keep: Partial<Record<PlaceKind, number>> = { summit: 60, pass: 60, lake: 50, inn: 99, stop: 45, lift: 99, view: 55 };
    this.candidates = region.bundle.places.filter((p) => p.prio >= (keep[p.kind] ?? 999)).sort((a, b) => b.prio - a.prio);
  }

  draw(info: RenderInfo, route: RouteView | null, hikerIndex: number | null, hoverIndex: number | null, waypointIds: Map<string, string>) {
    const { ctx, canvas } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const taken: Rect[] = [{ x: 0, y: 0, w: W, h: 104 }, { x: W - 150, y: 90, w: 150, h: H - 130 }, { x: 0, y: H - 34, w: W, h: 34 }];
    const at = (e: number, n: number, alt: number) => {
      const [x, y, z] = this.view.world(e, n, alt);
      return project(info.vp, x, y, z, W, H);
    };

    // Route waypoints first: they win every collision.
    if (route) {
      for (const wp of route.waypoints) {
        const p = this.region.places.get(wp.place);
        if (!p) continue;
        const i = Math.min(route.e.length - 1, Math.round((wp.km * 1000) / route.step));
        const s = at(route.e[i], route.n[i], route.alt[i]);
        if (s.w <= 0) continue;
        const id = waypointIds.get(wp.place) ?? '';
        // A waypoint label that would collide shrinks to its ID instead of disappearing.
        if (!this.label(s.x, s.y, 34, `${id} ${p.name.toUpperCase()}`, `${Math.round(p.alt || wp.alt)} M`, true, taken, W)) this.label(s.x, s.y, 16, id, '', true, taken, W, true);
      }
    }
    for (const p of this.candidates) {
      const s = at(p.e, p.n, p.alt || this.view.heightAt(p.e, p.n));
      if (s.w <= 0 || s.x < 0 || s.y < 0 || s.x > W || s.y > H) continue;
      const sub = p.kind === 'summit' || p.kind === 'pass' ? `${p.alt} M` : '';
      this.label(s.x, s.y, p.kind === 'summit' ? 22 : 14, `${GLYPH[p.kind]} ${p.name.toUpperCase()}`, sub, false, taken, W);
    }

    if (route && hoverIndex !== null) this.crosshair(at(route.e[hoverIndex], route.n[hoverIndex], route.alt[hoverIndex]), route.alt[hoverIndex]);
    if (route && hikerIndex !== null) {
      const i = hikerIndex;
      const top = at(route.e[i], route.n[i], route.alt[i]);
      const ground = at(route.e[i], route.n[i], this.region.bundle.grid.minAlt);
      if (top.w > 0) this.hiker(top, ground, route, i);
    }
  }

  /** Draws a label on a leader line; returns false when it was skipped for overlapping. */
  private label(x: number, y: number, lift: number, text: string, sub: string, strong: boolean, taken: Rect[], W: number, force = false): boolean {
    const { ctx } = this;
    ctx.font = strong ? STRONG : FONT;
    const tw = Math.max(ctx.measureText(text).width, sub ? ctx.measureText(sub).width : 0);
    const left = x + 4 + tw > W - 150 ? x - 6 - tw : x + 5;
    const rect = { x: Math.min(left, x) - 2, y: y - lift - (sub ? 22 : 12), w: tw + 10, h: lift + (sub ? 24 : 14) };
    if (!force && taken.some((r) => overlaps(r, rect))) return false;
    taken.push(rect);
    // Leader line and anchor dot, each on a halo of the background colour.
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y);
    ctx.lineTo(x + 0.5, y - lift);
    ctx.strokeStyle = C.bgA(0.7);
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = strong ? C.ac(0.85) : C.ink(0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 0.5, y, strong ? 2.5 : 1.8, 0, Math.PI * 2);
    ctx.strokeStyle = C.bgA(0.85);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = strong ? C.accent : C.text;
    ctx.fill();
    ctx.textBaseline = 'alphabetic';
    this.text(text, left, y - lift - (sub ? 10 : 0), strong ? C.accentTint : C.text);
    if (sub) {
      ctx.font = SMALL;
      this.text(sub, left, y - lift + 1, strong ? C.ac(0.9) : C.text2);
    }
    return true;
  }

  /** Text on a halo of the background colour, so it stays legible over the point cloud and trails. */
  private text(s: string, x: number, y: number, fill: string) {
    const { ctx } = this;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = C.bgA(0.85);
    ctx.strokeText(s, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(s, x, y);
  }

  private crosshair(s: { x: number; y: number; w: number }, alt: number) {
    if (s.w <= 0) return;
    const { ctx } = this;
    ctx.strokeStyle = C.ink(0.8);
    ctx.lineWidth = 1;
    ctx.strokeRect(s.x - 5.5, s.y - 5.5, 11, 11);
    ctx.font = SMALL;
    this.text(`${Math.round(alt)} M`, s.x + 9, s.y + 3, C.text);
  }

  private hiker(top: { x: number; y: number }, ground: { x: number; y: number }, route: RouteView, i: number) {
    const { ctx } = this;
    ctx.strokeStyle = C.ac(0.45);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(ground.x, ground.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.accent;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y - 7);
    ctx.lineTo(top.x + 5, top.y);
    ctx.lineTo(top.x, top.y + 7);
    ctx.lineTo(top.x - 5, top.y);
    ctx.closePath();
    ctx.fill();
    const box = `H1 · KM ${route.km[i].toFixed(1)}`;
    ctx.font = FONT;
    const w = ctx.measureText(box).width + 12;
    ctx.fillStyle = C.bgA(0.85);
    ctx.fillRect(top.x + 12, top.y - 26, w, 30);
    ctx.strokeStyle = C.accent;
    ctx.strokeRect(top.x + 12.5, top.y - 25.5, w - 1, 29);
    ctx.fillStyle = C.accent;
    ctx.fillText(box, top.x + 18, top.y - 13);
    ctx.font = SMALL;
    ctx.fillStyle = C.ac(0.75);
    ctx.fillText(`${Math.round(route.alt[i])} M · D+ ${Math.round(route.up[i])}`, top.x + 18, top.y - 1);
  }
}
