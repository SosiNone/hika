import { lookAt, multiply, perspective, type Mat4 } from './glkit';

/** Orbit camera around a target: drag to orbit, wheel to zoom, right-drag / shift-drag to pan. */
export class OrbitCamera {
  az = -0.5;
  el = 0.62;
  dist = 26000;
  target = [0, 600, 0];
  fov = (34 * Math.PI) / 180;
  private home: { az: number; el: number; dist: number; target: number[] };
  private goal: { az: number; el: number; dist: number; target: number[] } | null = null;

  constructor(private minDist = 1500, private maxDist = 60000) {
    this.home = this.snapshot();
  }

  snapshot() { return { az: this.az, el: this.el, dist: this.dist, target: [...this.target] }; }
  setHome() { this.home = this.snapshot(); }
  reset() { this.flyTo(this.home); }
  flyTo(goal: Partial<{ az: number; el: number; dist: number; target: number[] }>) { this.goal = { ...this.snapshot(), ...goal }; }

  /** Eases toward a fly-to goal; returns true while moving. */
  update(dt: number): boolean {
    if (!this.goal) return false;
    const k = 1 - Math.exp(-dt * 4);
    const g = this.goal;
    const dAz = Math.atan2(Math.sin(g.az - this.az), Math.cos(g.az - this.az));
    this.az += dAz * k;
    this.el += (g.el - this.el) * k;
    this.dist += (g.dist - this.dist) * k;
    this.target = this.target.map((v, i) => v + (g.target[i] - v) * k);
    if (Math.abs(dAz) < 1e-3 && Math.abs(g.dist - this.dist) < 1 && Math.hypot(...this.target.map((v, i) => v - g.target[i])) < 1) this.goal = null;
    return true;
  }

  eye(): number[] {
    const c = Math.cos(this.el);
    return [this.target[0] + this.dist * c * Math.sin(this.az), this.target[1] + this.dist * Math.sin(this.el), this.target[2] + this.dist * c * Math.cos(this.az)];
  }

  viewProj(aspect: number): Mat4 {
    return multiply(perspective(this.fov, aspect, Math.max(10, this.dist * 0.02), this.dist * 6), lookAt(this.eye(), this.target));
  }

  attach(el: HTMLElement, onChange: () => void) {
    let last: { x: number; y: number; pan: boolean } | null = null;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      last = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      this.goal = null;
    });
    el.addEventListener('pointermove', (e) => {
      if (!last) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      if (last.pan) {
        const s = this.dist / el.clientHeight;
        const ca = Math.cos(this.az), sa = Math.sin(this.az);
        // Grab-style pan: the ground under the cursor follows the pointer.
        this.target[0] += (-dx * ca - dy * sa) * s;
        this.target[2] += (dx * sa - dy * ca) * s;
      } else {
        this.az -= dx * 0.005;
        this.el = Math.min(1.45, Math.max(0.08, this.el + dy * 0.004));
      }
      last = { ...last, x: e.clientX, y: e.clientY };
      onChange();
    });
    const end = () => { last = null; el.classList.remove('dragging'); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.goal = null;
      this.dist = Math.min(this.maxDist, Math.max(this.minDist, this.dist * Math.exp(e.deltaY * 0.0012)));
      onChange();
    }, { passive: false });
    el.addEventListener('dblclick', () => { this.reset(); onChange(); });
  }
}
