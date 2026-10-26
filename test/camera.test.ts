import { beforeAll, describe, expect, it } from 'vitest';
import { OrbitCamera } from '../src/gl/camera';
import { project } from '../src/gl/glkit';

beforeAll(() => {
  // attach() asks for prefers-reduced-motion.
  globalThis.matchMedia ??= (() => ({ matches: false })) as unknown as typeof matchMedia;
});

/** A stand-in for the map canvas that takes the listeners attach() adds. */
function stage(): HTMLElement {
  return Object.assign(new EventTarget(), { clientHeight: 500, setPointerCapture() {}, classList: { add() {}, remove() {} } }) as unknown as HTMLElement;
}

let clock = 0;
/** Dispatches a touch pointer event, 50 ms after the previous one. */
function touch(el: HTMLElement, type: string, id: number, x: number, y: number) {
  const e = Object.assign(new Event(type), { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, button: 0, shiftKey: false });
  Object.defineProperty(e, 'timeStamp', { value: (clock += 50) });
  el.dispatchEvent(e);
}

function attached() {
  const camera = new OrbitCamera(), el = stage();
  camera.spin = 0;
  camera.attach(el, () => {});
  return { camera, el };
}

/** Screen position, in normalised device coordinates, of a point beside or above the target. */
function ndc(camera: OrbitCamera, aspect: number, dx: number, dy: number) {
  const [x, y, z] = camera.target;
  const s = project(camera.viewProj(aspect), x + dx, y + dy, z, 2, 2);
  return { x: s.x - 1, y: 1 - s.y };
}

describe('OrbitCamera', () => {
  it('keeps the horizontal field of a 1.2:1 view on narrower views', () => {
    const camera = new OrbitCamera();
    camera.az = 0;
    const wide = ndc(camera, 1.2, 1000, 0).x;
    for (const aspect of [0.45, 0.8, 1]) expect(ndc(camera, aspect, 1000, 0).x).toBeCloseTo(wide, 6);
    // Wider views keep the vertical field and see more to the sides.
    expect(ndc(camera, 2, 0, 1000).y).toBeCloseTo(ndc(camera, 1.2, 0, 1000).y, 6);
    expect(ndc(camera, 2, 1000, 0).x).toBeLessThan(wide);
  });

  it('orbits with one finger', () => {
    const { camera, el } = attached();
    const { az, dist } = camera;
    touch(el, 'pointerdown', 1, 100, 200);
    touch(el, 'pointermove', 1, 200, 200);
    touch(el, 'pointerup', 1, 200, 200);
    expect(camera.az).toBeCloseTo(az - 0.5, 6);
    expect(camera.dist).toBe(dist);
    expect(camera.framed).toBe(false);
  });

  it('pinches to zoom and pans with two fingers, without orbiting', () => {
    const { camera, el } = attached();
    const { az, dist } = camera;
    touch(el, 'pointerdown', 1, 100, 200);
    touch(el, 'pointerdown', 2, 200, 200);
    touch(el, 'pointermove', 2, 300, 200);
    expect(camera.dist).toBeCloseTo(dist / 2, 6);
    const target = [...camera.target];
    touch(el, 'pointermove', 1, 100, 260);
    touch(el, 'pointermove', 2, 300, 260);
    expect(camera.dist).toBeCloseTo(dist / 2, 6);
    expect(camera.az).toBe(az);
    expect(Math.hypot(camera.target[0] - target[0], camera.target[2] - target[2])).toBeGreaterThan(0);
    expect(camera.framed).toBe(true);
  });

  it('resets on a double tap, but not on a tap after a pinch', () => {
    const { camera, el } = attached();
    const home = camera.dist;
    const settle = () => { for (let k = 0; k < 400; k++) camera.update(1 / 60); };
    // A pinch whose first finger never moved, lifted last, then one tap: no double tap.
    touch(el, 'pointerdown', 1, 100, 200);
    touch(el, 'pointerdown', 2, 200, 200);
    touch(el, 'pointermove', 2, 300, 200);
    touch(el, 'pointerup', 2, 300, 200);
    touch(el, 'pointerup', 1, 100, 200);
    touch(el, 'pointerdown', 3, 100, 200);
    touch(el, 'pointerup', 3, 100, 200);
    settle();
    expect(camera.dist).toBeCloseTo(home / 2, 6);
    // Two quick taps in one place fly home.
    touch(el, 'pointerdown', 4, 150, 150);
    touch(el, 'pointerup', 4, 150, 150);
    touch(el, 'pointerdown', 5, 152, 151);
    touch(el, 'pointerup', 5, 152, 151);
    settle();
    // A flight ends within 1 m of its goal.
    expect(Math.abs(camera.dist - home)).toBeLessThan(1);
  });
});
