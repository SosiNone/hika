# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

HIKA: a sci-fi HUD for exploring Swiss hiking routes (first region: Alpstein), built only on swisstopo / geo.admin.ch open data. The product is about **exploring hiking routes**. Do not add race features (race times, leaderboards, cutoffs); the owner explicitly rejected them. The look is inspired by beastydesign.github.io/scifi, which is "all rights reserved": copy no code or assets from it.

## Commands

```bash
npm run dev                         # Vite dev server (also .claude/launch.json "hika", port 5173)
npm run build                       # tsc --noEmit + vite build -> dist/ (BASE env sets the public path)
npm run typecheck
npm test                            # vitest, test/**/*.test.ts
npx vitest run test/geo.test.ts -t "signpost"   # single file / single test
npm run build:region alpstein       # regenerate public/data/alpstein/ from regions/alpstein.json
npm run check:region alpstein       # sanity checks on the bundle; exits non-zero on failure
```

There is no linter; `tsc` runs with `noUnusedLocals` / `noUnusedParameters`, so unused code fails the build.

The pipeline needs Node ≥ 22.5 for `node:sqlite` (the repo uses Node 24). The first `build:region` downloads about 300 MB into `.cache/` (national GeoPackages, CSVs, tiles, API responses, all cached by URL + body). Reruns take seconds. The generated bundle in `public/data/` **is committed**, so after changing the pipeline, rebuild, run `check:region` and commit the data.

## Architecture

There are two halves joined by a static data bundle:

- **`scripts/`: build-time pipeline (Node, run with tsx).** `build-region.ts` orchestrates `scripts/lib/*` and writes `public/data/<id>/`.
- **`src/`: the browser app.** It only reads that bundle and never calls geo.admin.ch at runtime.

`src/data/types.ts` (`RegionBundle`, `Route`, `Place`, `RegionConfig`) is the contract between them. The pipeline imports from `src/geo/*` and `src/data/types.ts`; keep those modules free of DOM code.

### Bundle format (`public/data/<id>/`)
- `terrain.u16` / `switzerland.u16`: Uint16 **decimetres**, row-major, row 0 = **north** edge, values at cell centres, `0` = no data.
- `trails.bin`: custom layout written by `encodeTrails` (scripts/lib/trails.ts) and read by `decodeTrails` (src/data/load.ts). The two must change together.
- `region.json`: places and routes. Place `e/n` and route `e/n` arrays are **metres relative to the bbox SW corner**; absolute LV95 (EPSG:2056) only appears in `bbox` and `locator`.
- Route ids are `sm-<SchweizMobil id>` (e.g. `sm-951.00`) or `c-<curated id>`. The app reads and writes `#route=<id>` in the URL.

### Pipeline facts that were learned the hard way
- swissALTI3D 2 m COGs (found via STAC) have a single 4 m internal overview. `terrain.ts` reads that overview and box-averages it, so `cell` must be a multiple of 4 that divides 1000.
- Trail class (Wanderweg / Bergwanderweg / Alpinwanderweg) and surface exist only in the swissTLM3D Wanderwege **GeoPackage**. The REST layer only flags Alpinwanderweg. The GeoPackage is read with `node:sqlite` plus the hand-written WKB parser in `gpkg.ts` (no GDAL, no sql.js).
- The geo.admin.ch profile service (`profile.ts`): POST the GeoJSON geometry as the raw body with `sr`/`nb_points` in the query string. It is limited to 5000 points, keeps input vertices and may add extra points, so results are matched back by coordinates.
- SchweizMobil routes (`ch.astra.wanderland`) come back as unordered MultiLineStrings. `chain()` joins them, then the route is oriented by geocoding the "from/to" in the title, then clipped to the bbox.
- Curated hikes in `regions/<id>.json` name their via-points. These resolve through swissNAMES3D (`resolvePlace`, with an optional `kind`) and are routed with Dijkstra on `TrailGraph`, using Swiss hiking time as the edge weight.
- Every route gets DEP/ARR waypoints. Where a route is clipped, the pipeline adds a synthetic "Region edge → …" place.

### Swiss hiking time (`src/geo/hikingTime.ts`)
`PACE` is a table digitised from the official Schweizer Wanderwege isochrone chart (4.2 km/h on the flat, fastest at about −5 %). It is not a rule of thumb; don't replace it with one. Slope comes from altitudes smoothed over about 60 m, and signpost display rounds to 5 min.

Route `stats` are computed in the pipeline (`finishRoute`). The per-sample cumulative series (`km`, `minutes`, `up`, `down`) are re-derived on load (`deriveRoute` in `src/data/load.ts`). Both sides must use the same helpers (`routeClimb` in `src/geo/track.ts`, `cumulativeMinutes`), so the route list and the replay panels show the same numbers. `check:region` fails if the stored climb totals drift from `routeClimb`.

### Rendering (`src/gl/`)
- World space: x = east, y = up, z = **south**, origin at the bbox centre. `TerrainView.world(e, n, alt)` converts bundle coordinates; grid cell `i` sits at `(i + 0.5) * cell`.
- Vertical exaggeration is applied **in the vertex shaders** (`uExag`, `uBase`), so CPU-side geometry (trails, contours, ribbons) stores raw altitudes and never needs rebuilding.
- The point cloud has no vertex buffer. Points come from `gl_VertexID`, which samples an `R16UI` height texture, with jitter, depth-of-field point size and distance fade. Stride 2 applies beyond 16 km camera distance.
- There is no depth test anywhere: points and contours are additive, network and ribbons are blended over them (hologram look). Contours are computed in `contours.worker.ts`. The selected route is a screen-space ribbon.
- Labels, the hiker and the crosshair are drawn on a separate 2D canvas (`src/hud/labels.ts`) by projecting with the frame's view-projection matrix.

### App state and panels
- `Store` (src/state.ts) is a tiny observable. `main.ts` reacts to `routeId` / `hoverRouteId` / `mode` changes via `subscribe`.
- The replay position `store.state.minute` is **mutated directly** in the render loop, without notifying, for performance.
- Each `mount*` function in `src/panels/` builds its DOM once and returns an update callback. `main.ts` polls all of them about every 50 ms, and they rebuild static parts only when the route id changes.
- `main.ts` hard-codes `loadRegion('alpstein')` and `DEFAULT_ROUTE`. A second region needs a selector there, as well as a `regions/<id>.json`.

## Deploy

`.github/workflows/pages.yml` runs `npm test` and `npm run build` with `BASE=/<repo>/`, then publishes `dist/` to GitHub Pages on every push to `main`.
