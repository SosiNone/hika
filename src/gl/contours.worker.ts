/// <reference lib="webworker" />
/**
 * Marching squares over the height grid. Input: decimetre heights; output: LINES vertices
 * (grid x, altitude, grid y) plus a weight per vertex (1 = major contour, 0 = minor).
 */
interface Job { heights: Uint16Array; cols: number; rows: number; interval: number; major: number }

self.onmessage = (ev: MessageEvent<Job>) => {
  const { heights, cols, rows, interval, major } = ev.data;
  const pos: number[] = [], weight: number[] = [];
  const h = (i: number, j: number) => heights[j * cols + i] * 0.1;
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const a = h(i, j), b = h(i + 1, j), c = h(i + 1, j + 1), d = h(i, j + 1);
    if (!a || !b || !c || !d) continue;
    const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
    for (let level = Math.ceil(lo / interval) * interval; level < hi; level += interval) {
      // Edge crossings in order top, right, bottom, left.
      const pts: [number, number][] = [];
      const cross = (v0: number, v1: number, x0: number, y0: number, x1: number, y1: number) => {
        if ((v0 < level) !== (v1 < level)) { const t = (level - v0) / (v1 - v0); pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]); }
      };
      cross(a, b, i, j, i + 1, j);
      cross(b, c, i + 1, j, i + 1, j + 1);
      cross(c, d, i + 1, j + 1, i, j + 1);
      cross(d, a, i, j + 1, i, j);
      const w = level % major === 0 ? 1 : 0;
      for (let k = 0; k + 1 < pts.length; k += 2) {
        pos.push(pts[k][0], level, pts[k][1], pts[k + 1][0], level, pts[k + 1][1]);
        weight.push(w, w);
      }
    }
  }
  const p = new Float32Array(pos), w = new Float32Array(weight);
  (self as unknown as Worker).postMessage({ pos: p, weight: w }, [p.buffer, w.buffer]);
};
