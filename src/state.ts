import type { Display } from './theme/tokens';

/** Tiny observable store shared by the terrain view and the panels. */
export interface AppState {
  routeId: string;
  /** The selected route is walked the other way (to → from). */
  reversed: boolean;
  /** Route hovered in the list or on the map (highlighted but not selected). */
  hoverRouteId: string | null;
  /** Sample index hovered on the profile / map, or null. */
  hoverIndex: number | null;
  /** Preview position in hiking minutes along the selected route. */
  minute: number;
  playing: boolean;
  /** Preview speed: real seconds per hiking hour. */
  secondsPerHour: number;
  /** Loop the selected route instead of moving on to the next one in the playlist. */
  repeat: boolean;
  /** Walk the playlist in a random order (see src/playlist.ts). */
  shuffle: boolean;
  mode: 'mono' | 'natural';
  /** Dark or light scheme (see src/theme). */
  display: Display;
}

type Listener = (s: AppState, prev: AppState) => void;

export class Store {
  private listeners = new Set<Listener>();
  constructor(public state: AppState) {}

  set(patch: Partial<AppState>) {
    const prev = this.state;
    this.state = { ...prev, ...patch };
    for (const l of this.listeners) l(this.state, prev);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
