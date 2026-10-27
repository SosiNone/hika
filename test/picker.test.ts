import { describe, expect, it } from 'vitest';
import { RoutePicker } from '../src/gl/picker';

/** A stand-in for the map canvas, 10 px from the left and 20 px from the top of the page. */
function stage(): HTMLElement {
  return Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 300 }) }) as unknown as HTMLElement;
}

/** Dispatches a pointer event at client coordinates. */
function send(el: HTMLElement, type: string, pointerType: 'mouse' | 'touch', x: number, y: number, id = 1) {
  el.dispatchEvent(Object.assign(new Event(type), { pointerId: id, pointerType, clientX: x, clientY: y }));
}

/** Route "a" lies left of x = 100 on the canvas, "b" up to x = 200, nothing beyond. */
function picker() {
  const picks: { x: number; y: number; radius: number }[] = [], selected: string[] = [], hovered: (string | null)[] = [];
  let shift = 0;
  const el = stage();
  const p = new RoutePicker(
    el,
    (x, y, radius) => {
      picks.push({ x, y, radius });
      x += shift;
      return x < 100 ? 'a' : x < 200 ? 'b' : null;
    },
    (id) => selected.push(id),
    (id) => hovered.push(id),
  );
  // Moves the map under the pointer, as the idle orbit or a fly-to does.
  const turn = (dx: number) => { shift = dx; };
  return { p, el, picks, selected, hovered, turn };
}

describe('RoutePicker', () => {
  it('hovers the route under a resting mouse, picked on the next frame, and clears it on leave', () => {
    const { p, el, picks, hovered } = picker();
    send(el, 'pointermove', 'mouse', 60, 70);
    expect(hovered).toEqual([]);
    p.frame(0, false);
    expect(picks).toEqual([{ x: 50, y: 50, radius: 14 }]);
    send(el, 'pointermove', 'mouse', 160, 70);
    send(el, 'pointermove', 'mouse', 170, 70);
    p.frame(16, false);
    expect(picks).toHaveLength(2);
    send(el, 'pointerleave', 'mouse', 500, 70);
    p.frame(32, false);
    expect(hovered).toEqual(['a', 'b', null]);
  });

  it('drops the hover while a drag orbits or pans, and picks again on release', () => {
    const { p, el, hovered, selected } = picker();
    send(el, 'pointermove', 'mouse', 60, 70);
    p.frame(0, false);
    send(el, 'pointerdown', 'mouse', 60, 70);
    // A click's jitter keeps it.
    send(el, 'pointermove', 'mouse', 62, 71);
    expect(hovered).toEqual(['a']);
    send(el, 'pointermove', 'mouse', 160, 70);
    expect(hovered).toEqual(['a', null]);
    // The pointer is over "b" now, but a held button picks nothing.
    send(el, 'pointermove', 'mouse', 170, 70);
    p.frame(500, false);
    expect(hovered).toEqual(['a', null]);
    send(el, 'pointerup', 'mouse', 170, 70);
    expect(selected).toEqual([]);
    p.frame(516, false);
    expect(hovered).toEqual(['a', null, 'b']);
  });

  it('follows the map turning under a resting mouse, but not during a fly-to', () => {
    const { p, el, picks, hovered, turn } = picker();
    send(el, 'pointermove', 'mouse', 60, 70);
    p.frame(0, false);
    turn(100);
    p.frame(50, false);
    expect(picks).toHaveLength(1);
    p.frame(150, true);
    expect(picks).toHaveLength(1);
    p.frame(160, false);
    expect(hovered).toEqual(['a', 'b']);
  });

  it('selects on a click or a tap, not on a drag or a pinch', () => {
    const { el, picks, selected } = picker();
    send(el, 'pointerdown', 'mouse', 60, 70);
    send(el, 'pointerup', 'mouse', 63, 70);
    // A finger gets more slack and a wider radius.
    send(el, 'pointerdown', 'touch', 160, 70, 2);
    send(el, 'pointerup', 'touch', 168, 70, 2);
    expect(picks.map((q) => q.radius)).toEqual([14, 24]);
    send(el, 'pointerdown', 'mouse', 60, 70);
    send(el, 'pointerup', 'mouse', 66, 70);
    // A drag that ends where it began turned the map: no click.
    send(el, 'pointerdown', 'touch', 60, 70, 5);
    send(el, 'pointermove', 'touch', 120, 70, 5);
    send(el, 'pointermove', 'touch', 60, 70, 5);
    send(el, 'pointerup', 'touch', 60, 70, 5);
    send(el, 'pointerdown', 'touch', 60, 70, 3);
    send(el, 'pointerdown', 'touch', 160, 70, 4);
    send(el, 'pointerup', 'touch', 160, 70, 4);
    send(el, 'pointerup', 'touch', 60, 70, 3);
    expect(selected).toEqual(['a', 'b']);
  });

  it('never hovers with a finger', () => {
    const { p, el, hovered } = picker();
    send(el, 'pointerdown', 'touch', 60, 70);
    send(el, 'pointermove', 'touch', 60, 70);
    send(el, 'pointerup', 'touch', 60, 70);
    send(el, 'pointerleave', 'touch', 60, 70);
    p.frame(0, false);
    expect(hovered).toEqual([]);
  });
});
