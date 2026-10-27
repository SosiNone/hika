import { lookAt, multiply, perspective, type Mat4 } from './glkit';

type Pose = { az: number; el: number; dist: number; target: number[] };

/**
 * Orbit camera around a target: drag to orbit, wheel to zoom, right-drag / shift-drag to pan. On a
 * touch screen one finger orbits, two fingers pinch to zoom and drag to pan, and a double tap resets.
 * Left alone, it slowly circles the target; any interaction pauses that until the pointer has been still for `resume` seconds.
 */
export class OrbitCamera {
  az = -0.5;
  el = 0.62;
  dist = 26000;
  target = [0, 600, 0];
  /** Vertical field of view of a view at least `minAspect` wide. */
  fov = (34 * Math.PI) / 180;
  /** A narrower view (a phone held upright) widens its vertical field instead, to keep this one's horizontal field. */
  minAspect = 1.2;
  /** Idle orbit speed in rad/s (0 = off); one turn takes about 2.5 min. */
  spin = 0.04;
  /** Seconds without interaction before the idle orbit resumes. */
  resume = 4;
  /** True once the user pans or zooms; cleared by the next fly-to. */
  framed = false;
  private home: Pose;
  // A goal without `az` leaves the azimuth free, so the idle orbit keeps turning during the flight.
  private goal: (Omit<Pose, 'az'> & { az?: number }) | null = null;
  private held = false;
  private still = Infinity;
  private spinGain = 0;

  constructor(private minDist = 1500, private maxDist = 60000) {
    this.home = this.snapshot();
  }

  snapshot(): Pose { return { az: this.az, el: this.el, dist: this.dist, target: [...this.target] }; }
  setHome() { this.home = this.snapshot(); }
  reset() { this.flyTo(this.home); }
  flyTo(goal: Partial<Pose>) {
    const { az: _, ...rest } = this.snapshot();
    this.framed = false;
    this.goal = { ...rest, ...goal };
  }

  /** Marks user interaction: pauses the idle orbit. */
  touch() { this.still = 0; }

  /** Eases toward a fly-to goal and advances the idle orbit; returns true while flying. */
  update(dt: number): boolean {
    this.still += dt;
    const idle = !this.held && this.still > this.resume && this.goal?.az === undefined;
    this.spinGain += ((idle ? 1 : 0) - this.spinGain) * (1 - Math.exp(-dt * 1.2));
    this.az += this.spin * this.spinGain * dt;
    if (!this.goal) return false;
    const k = 1 - Math.exp(-dt * 4);
    const g = this.goal;
    const dAz = g.az === undefined ? 0 : Math.atan2(Math.sin(g.az - this.az), Math.cos(g.az - this.az));
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

  /** Horizontal field of view of a view `aspect` wide: the same for every view narrower than `minAspect`. */
  hfov(aspect: number): number {
    return 2 * Math.atan(Math.tan(this.fov / 2) * Math.max(aspect, this.minAspect));
  }

  viewProj(aspect: number): Mat4 {
    const fov = 2 * Math.atan(Math.tan(this.hfov(aspect) / 2) / aspect);
    return multiply(perspective(fov, aspect, Math.max(10, this.dist * 0.02), this.dist * 6), lookAt(this.eye(), this.target));
  }

  attach(el: HTMLElement, onChange: () => void) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) this.spin = 0;
    // The pointers that are down, at their last position: one orbits (or pans, on a right or
    // shift drag), two pinch and pan.
    const down = new Map<number, { x: number; y: number }>();
    let pan = false;
    let press = { x: 0, y: 0 }, lastTap = { t: -Infinity, x: 0, y: 0 };
    const pair = () => {
      const [a, b] = [...down.values()];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, span: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
    };
    // Grab-style pan: the ground under the pointer follows it.
    const panBy = (dx: number, dy: number) => {
      const s = this.dist / el.clientHeight;
      const ca = Math.cos(this.az), sa = Math.sin(this.az);
      this.target[0] += (-dx * ca - dy * sa) * s;
      this.target[2] += (dx * sa - dy * ca) * s;
      this.framed = true;
    };
    const zoomBy = (f: number) => {
      this.dist = Math.min(this.maxDist, Math.max(this.minDist, this.dist * f));
      this.framed = true;
    };
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      if (down.size >= 2) return;
      // A gesture that ever had two pointers is no tap.
      press = down.size ? { x: NaN, y: NaN } : { x: e.clientX, y: e.clientY };
      down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      pan = e.button === 2 || e.shiftKey;
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      this.goal = null;
      this.held = true;
      this.touch();
    });
    el.addEventListener('pointermove', (e) => {
      const last = down.get(e.pointerId);
      if (!last) return;
      const before = down.size === 2 ? pair() : null;
      down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (before) {
        const after = pair();
        zoomBy(before.span / after.span);
        panBy(after.x - before.x, after.y - before.y);
      } else if (pan) panBy(e.clientX - last.x, e.clientY - last.y);
      else {
        this.az -= (e.clientX - last.x) * 0.005;
        this.el = Math.min(1.45, Math.max(0.08, this.el + (e.clientY - last.y) * 0.004));
      }
      onChange();
    });
    const end = (e: PointerEvent) => {
      if (!down.delete(e.pointerId) || down.size) return;
      this.held = false;
      this.touch();
      el.classList.remove('dragging');
    };
    el.addEventListener('pointerup', (e) => {
      // Not every touch browser sends dblclick, so a double tap is caught here.
      if (e.pointerType === 'touch' && down.size === 1 && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 10) {
        if (e.timeStamp - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
          lastTap = { t: -Infinity, x: 0, y: 0 };
          this.reset();
          onChange();
        } else lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
      }
      end(e);
    });
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.goal = null;
      this.touch();
      zoomBy(Math.exp(e.deltaY * 0.0012));
      onChange();
    }, { passive: false });
    el.addEventListener('dblclick', () => { this.reset(); this.touch(); onChange(); });
  }
}
