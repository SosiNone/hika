import { segmentMinutes } from '../../src/geo/hikingTime';
import { MinHeap } from '../../src/geo/heap';
import type { XY } from '../../src/geo/track';
import type { TrailLine } from './trails';

/**
 * Routable trail network: every vertex is a node (shared vertices join lines), and edges are
 * weighted by Swiss hiking time in each direction using the swissTLM3D vertex heights, so the
 * shortest path is the quickest one for a hiker rather than the shortest on the map.
 */
export class TrailGraph {
  readonly x: number[] = [];
  readonly y: number[] = [];
  private adj: { to: number; min: number }[][] = [];
  private ids = new Map<string, number>();
  private z = new Map<number, number>();

  constructor(lines: TrailLine[]) {
    for (const l of lines) {
      let prev = -1;
      for (const [e, n, z] of l.pts) {
        const id = this.node(e, n);
        if (prev >= 0 && prev !== id) {
          const [pe, pn, pz] = [this.x[prev], this.y[prev], this.z.get(prev) ?? z];
          const h = Math.hypot(e - pe, n - pn), dz = Number.isNaN(z) || Number.isNaN(pz) ? 0 : z - pz;
          this.adj[prev].push({ to: id, min: segmentMinutes(h, dz) });
          this.adj[id].push({ to: prev, min: segmentMinutes(h, -dz) });
        }
        this.z.set(id, z);
        prev = id;
      }
    }
  }

  private node(e: number, n: number): number {
    const key = `${Math.round(e * 2)},${Math.round(n * 2)}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.x.length;
      this.ids.set(key, id);
      this.x.push(e);
      this.y.push(n);
      this.adj.push([]);
    }
    return id;
  }

  /** Closest node to a point, or -1 beyond `maxDist`. */
  nearestNode(e: number, n: number, maxDist: number): number {
    let best = -1, bd = maxDist;
    for (let i = 0; i < this.x.length; i++) {
      const d = Math.hypot(this.x[i] - e, this.y[i] - n);
      if (d < bd && this.adj[i].length) { bd = d; best = i; }
    }
    return best;
  }

  /** Quickest path between two nodes as coordinates, or null when they are not connected. */
  route(from: number, to: number): XY[] | null {
    const dist = new Float64Array(this.x.length).fill(Infinity);
    const prev = new Int32Array(this.x.length).fill(-1);
    const heap = new MinHeap();
    dist[from] = 0;
    heap.push(from, 0);
    while (heap.size) {
      const [u, du] = heap.pop();
      if (u === to) break;
      if (du > dist[u]) continue;
      for (const { to: v, min } of this.adj[u]) {
        const nd = du + min;
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; heap.push(v, nd); }
      }
    }
    if (dist[to] === Infinity) return null;
    const path: XY[] = [];
    for (let v = to; v !== -1; v = prev[v]) path.push([this.x[v], this.y[v]]);
    return path.reverse();
  }
}
