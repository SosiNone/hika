/** Finds the route nearest a point on the map, in CSS pixels from its top left, within `radius`. */
export type PickRoute = (x: number, y: number, radius: number) => string | null;

/** How far a press may move and still count as a click (mouse) or a tap, in CSS pixels. */
const SLOP = { mouse: 4, touch: 10 };
/** Pick radius in CSS pixels: a finger gets more slack than a mouse. */
const RADIUS = { mouse: 14, touch: 24 };
/** A resting mouse picks again this often (ms), so the hover follows the idle orbit. */
const REPICK = 100;

/**
 * Route picking on the map. A click or tap (not a drag, not a pinch) selects the route under the
 * pointer. A mouse resting on the map hovers the route a click would select, as hovering the route
 * list does, but not while a drag orbits or pans: the hover clears once a press moves like a drag,
 * and comes back when the button is released.
 */
export class RoutePicker {
  /** The mouse over the map with no button down, in client pixels; null otherwise. */
  private at: { x: number; y: number } | null = null;
  private moved = false;
  private picked = -Infinity;
  private hovered: string | null = null;

  constructor(private el: HTMLElement, private pick: PickRoute, private select: (id: string) => void, private hover: (id: string | null) => void) {
    // The press that may become a click: only the first of a gesture, so a pinch is never one.
    let down: { x: number; y: number; id: number } | null = null, pressed = 0;
    const slop = (e: PointerEvent) => e.pointerType === 'mouse' ? SLOP.mouse : SLOP.touch;
    el.addEventListener('pointerdown', (e) => {
      down = pressed++ ? null : { x: e.clientX, y: e.clientY, id: e.pointerId };
      // Keep the hover through a click, but stop picking: the map may turn under a held button.
      this.at = null;
    });
    el.addEventListener('pointermove', (e) => {
      if (pressed) {
        // A press that moved like a drag is no click, even if it ends where it began.
        if (down?.id === e.pointerId && Math.hypot(e.clientX - down.x, e.clientY - down.y) > slop(e)) down = null;
        if (!down && e.pointerType === 'mouse') this.setHover(null);
      } else if (e.pointerType === 'mouse') {
        this.at = { x: e.clientX, y: e.clientY };
        this.moved = true;
      }
    });
    el.addEventListener('pointerup', (e) => {
      pressed = Math.max(0, pressed - 1);
      if (e.pointerType === 'mouse' && !pressed) {
        this.at = { x: e.clientX, y: e.clientY };
        this.moved = true;
      }
      if (down?.id !== e.pointerId || Math.hypot(e.clientX - down.x, e.clientY - down.y) > slop(e)) return;
      const hit = this.pickAt(e.clientX, e.clientY, e.pointerType === 'mouse' ? RADIUS.mouse : RADIUS.touch);
      if (hit) this.select(hit);
    });
    el.addEventListener('pointercancel', () => { pressed = Math.max(0, pressed - 1); down = null; });
    el.addEventListener('pointerleave', () => {
      this.at = null;
      this.setHover(null);
    });
  }

  /**
   * Runs in the render loop, after the frame `pick` reads is drawn. The hover is picked on the
   * frame after the mouse moves, and every 100 ms while it rests, but not while the camera flies
   * (it would flash every route it sweeps past).
   */
  frame(now: number, flying: boolean) {
    if (!this.at || !(this.moved || (!flying && now - this.picked > REPICK))) return;
    this.moved = false;
    this.picked = now;
    this.setHover(this.pickAt(this.at.x, this.at.y, RADIUS.mouse));
  }

  private pickAt(x: number, y: number, radius: number): string | null {
    const rect = this.el.getBoundingClientRect();
    return this.pick(x - rect.left, y - rect.top, radius);
  }

  private setHover(id: string | null) {
    if (id === this.hovered) return;
    this.hovered = id;
    this.hover(id);
  }
}
