/**
 * Walking distances over the trail network of a window (`Trails` in src/data/codec.ts):
 * lines of integer-metre vertices that join where they share a vertex, as in the pipeline's
 * `TrailGraph`. The app uses it to show only the trails branching off the selected route.
 */

import { MinHeap } from './heap';

/** A network vertex this close (m) to a route sample counts as on the route. */
const SEED = 20;
/** Bucket size (m) of the seed lookup; at least `SEED`, so the 3 × 3 neighbourhood covers it. */
const CELL = 32;

export class TrailNetwork {
  /** Node of each line vertex (indexed like the `xy` pairs). */
  private vertexNode: Uint32Array;
  private x: Float64Array;
  private y: Float64Array;
  /** Adjacency in CSR form: the edges of node `i` are `to` / `len` [start[i], start[i + 1]). */
  private start: Uint32Array;
  private to: Uint32Array;
  private len: Float32Array;
  /** Nodes bucketed in `CELL` squares, also CSR. */
  private cols: number;
  private rows: number;
  private cellStart: Uint32Array;
  private cellNodes: Uint32Array;

  constructor({ offsets, xy }: { offsets: Uint32Array; xy: Uint16Array }) {
    const ids = new Map<number, number>(), x: number[] = [], y: number[] = [];
    let maxX = 0, maxY = 0;
    this.vertexNode = new Uint32Array(xy.length / 2);
    for (let v = 0; v < xy.length / 2; v++) {
      const e = xy[v * 2], n = xy[v * 2 + 1], key = e * 65536 + n;
      let id = ids.get(key);
      if (id === undefined) {
        id = x.length;
        ids.set(key, id);
        x.push(e);
        y.push(n);
        maxX = Math.max(maxX, e);
        maxY = Math.max(maxY, n);
      }
      this.vertexNode[v] = id;
    }
    this.x = Float64Array.from(x);
    this.y = Float64Array.from(y);
    const nodes = x.length;

    // Edges between consecutive vertices of each line, in both directions.
    const edges = (visit: (a: number, b: number) => void) => {
      for (let l = 0; l + 1 < offsets.length; l++) {
        for (let v = offsets[l] + 1; v < offsets[l + 1]; v++) {
          const a = this.vertexNode[v - 1], b = this.vertexNode[v];
          if (a !== b) { visit(a, b); visit(b, a); }
        }
      }
    };
    this.start = new Uint32Array(nodes + 1);
    edges((a) => this.start[a + 1]++);
    for (let i = 0; i < nodes; i++) this.start[i + 1] += this.start[i];
    this.to = new Uint32Array(this.start[nodes]);
    this.len = new Float32Array(this.start[nodes]);
    const fill = this.start.slice(0, nodes);
    edges((a, b) => {
      this.to[fill[a]] = b;
      this.len[fill[a]++] = Math.hypot(this.x[b] - this.x[a], this.y[b] - this.y[a]);
    });

    this.cols = Math.floor(maxX / CELL) + 1;
    this.rows = Math.floor(maxY / CELL) + 1;
    const cell = (i: number) => Math.floor(this.y[i] / CELL) * this.cols + Math.floor(this.x[i] / CELL);
    this.cellStart = new Uint32Array(this.cols * this.rows + 1);
    for (let i = 0; i < nodes; i++) this.cellStart[cell(i) + 1]++;
    for (let c = 0; c < this.cols * this.rows; c++) this.cellStart[c + 1] += this.cellStart[c];
    this.cellNodes = new Uint32Array(nodes);
    const at = this.cellStart.slice(0, this.cols * this.rows);
    for (let i = 0; i < nodes; i++) this.cellNodes[at[cell(i)]++] = i;
  }

  /**
   * Walking distance (m) along the network from a route given by its samples, for every line
   * vertex, capped at `max`. Vertices within `SEED` of the route start at their offset from it;
   * the search stops at `max`, so only the route's neighbourhood is visited.
   */
  distanceFrom(e: ArrayLike<number>, n: ArrayLike<number>, max: number): Float32Array {
    // Float64, so the keys popped from the heap compare exactly with the stored distances.
    const dist = new Float64Array(this.x.length).fill(max);
    const heap = new MinHeap();
    for (let s = 0; s < e.length; s++) {
      const cx = Math.floor(e[s] / CELL), cy = Math.floor(n[s] / CELL);
      for (let j = Math.max(0, cy - 1); j <= Math.min(this.rows - 1, cy + 1); j++) {
        for (let i = Math.max(0, cx - 1); i <= Math.min(this.cols - 1, cx + 1); i++) {
          const c = j * this.cols + i;
          for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
            const node = this.cellNodes[k], d = Math.hypot(this.x[node] - e[s], this.y[node] - n[s]);
            if (d < SEED && d < dist[node]) { dist[node] = d; heap.push(node, d); }
          }
        }
      }
    }
    while (heap.size) {
      const [u, du] = heap.pop();
      if (du > dist[u]) continue;
      for (let k = this.start[u]; k < this.start[u + 1]; k++) {
        const v = this.to[k], d = du + this.len[k];
        if (d < dist[v]) { dist[v] = d; heap.push(v, d); }
      }
    }
    return Float32Array.from(this.vertexNode, (node) => dist[node]);
  }
}
