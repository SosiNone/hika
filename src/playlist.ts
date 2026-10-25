import type { Route, RouteCategory } from './data/types';

/** Order of the route groups, shared by the route list (D) and the preview playlist (A). */
export const CATEGORY_ORDER: RouteCategory[] = ['classic', 'national', 'regional', 'local'];

/**
 * The region's routes as a playlist: grouped like the route list, region order within a group,
 * wrapping at both ends. Shuffle walks a random queue that starts at the current route, so
 * stepping back returns to the routes already played.
 */
export class Playlist {
  private readonly order: string[];
  ids: string[];

  constructor(routes: Pick<Route, 'id' | 'category'>[]) {
    this.order = CATEGORY_ORDER.flatMap((cat) => routes.filter((r) => r.category === cat).map((r) => r.id));
    this.ids = this.order;
  }

  /** 1-based position of `id` in the current queue (0 if absent). */
  position(id: string): number {
    return this.ids.indexOf(id) + 1;
  }

  /** The route before (-1) or after (1) `id`. */
  step(id: string, dir: 1 | -1): string {
    const n = this.ids.length, i = this.ids.indexOf(id);
    return this.ids[(((i < 0 ? 0 : i + dir) % n) + n) % n];
  }

  setShuffle(on: boolean, current: string, rand: () => number = Math.random) {
    if (!on) {
      this.ids = this.order;
      return;
    }
    const rest = this.order.filter((id) => id !== current);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    this.ids = this.order.includes(current) ? [current, ...rest] : rest;
  }
}
