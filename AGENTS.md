# AGENTS.md

This file provides guidance to coding agents (Claude Code and others) working in this repository.

## What this is

HIKA: a sci-fi HUD for exploring Swiss hiking routes, built only on swisstopo / geo.admin.ch open data. The product is about **exploring hiking routes**. Do not add race features (race times, leaderboards, cutoffs); the owner explicitly rejected them. The look is inspired by beastydesign.github.io/scifi, which is "all rights reserved": copy no code or assets from it.

## Work

- Bump the version to your own judgement.
- Follow open source best practices and maintain professional grade software.
- Use [tasks](https://taskfile.dev/) to abstract out common commands for the end user. `Taskfile.yml` wraps the npm scripts in `package.json`; when adding a script, add a matching task with a `desc`.

## Architecture

There are two halves joined by a static data bundle:

- **`scripts/`: build-time pipeline (Node, run with tsx).** `build-region.ts` orchestrates `scripts/lib/*`, writes `public/data/<id>/` and refreshes the region index `public/data/regions.json`.
- **`src/`: the browser app.** It only reads that bundle and never calls geo.admin.ch at runtime.

`src/data/types.ts` (`RegionBundle`, `Route`, `Place`, `RegionConfig`) is the contract between them. The pipeline imports from `src/geo/*` and `src/data/types.ts`; keep those modules free of DOM code.

`docs/data-coverage.md` tracks which data is in the bundle, which of it the app shows, and what the sources offer beyond that. Update it when you add a source, a bundle field or a panel.

### Bundle format (`public/data/<id>/`)
- `region.json` `version` is the bundle format (`BUNDLE_VERSION` in `src/data/types.ts`, now 2). The app refuses any other version and says to rebuild.
- **Height grid** (`grid.file`, `terrain.bin`): Uint16 **decimetres**, row-major, row 0 = **north** edge, values at cell centres, `0` = no data. swissALTI3D ends at the national border, so a region that reaches abroad (Zermatt, Aletsch) has `0` cells there. They are skipped, never drawn as 0 m: the point shader and the contour worker drop any cell with a `0` corner, and `TerrainView.heightAt` interpolates over the corners that have data.
- `terrain.bin` and `trails.bin` are delta-encoded by `src/data/codec.ts`, the one module the pipeline encodes with and the app decodes with:
  - The terrain stores gradient-predictor residuals; the trails store per-line vertex deltas (magic `HKT2`).
  - Both store 16-bit values modulo 2^16, with the low-byte plane before the high-byte plane.
  - They are deliberately **not compressed** in the file. Git's zlib and the GitHub Pages gzip roughly halve them, and a small upstream change stays a small change that git can delta.
- `switzerland.u16`: the coarse national relief, raw Uint16 decimetres, the same file in every bundle (git stores it once).
- Rebuilds are reproducible. `build-region` rewrites only files whose bytes changed and keeps `generated` when nothing did, so rebuilding unchanged data leaves git clean. Don't add anything that varies per run (timestamps, random order) to a bundle.
- `region.json`: places and routes. Place `e/n` and route `e/n` arrays are **metres relative to the bbox SW corner**; absolute LV95 (EPSG:2056) only appears in `bbox` and `locator`.
- Route ids are `sm-<SchweizMobil id>` (e.g. `sm-951.00`) or `c-<curated id>`. The app reads and writes `#route=<id>` in the URL, plus `&reverse=1` when the hike is walked to → from. Ids are only unique within a region: neighbouring regions can share a clipped SchweizMobil route.
- `public/data/regions.json` (`RegionIndex`) lists every built region with its title, cantons, bbox and `defaultRoute`. `scripts/lib/regions.ts` derives it from the bundles plus `defaultRoute` from `regions/<id>.json`; `build-region` rewrites it, `npm run index:regions` rewrites it on its own, and `check:region` fails when it is stale.

### Pipeline facts that were learned the hard way
- swissALTI3D 2 m COGs (found via STAC) have a single 4 m internal overview. `terrain.ts` reads that overview and box-averages it, so `cell` must be a multiple of 4 that divides 1000.
- Trail class (Wanderweg / Bergwanderweg / Alpinwanderweg) and surface exist only in the swissTLM3D Wanderwege **GeoPackage**. The REST layer only flags Alpinwanderweg. The GeoPackage is read with `node:sqlite` plus the hand-written WKB parser in `gpkg.ts` (no GDAL, no sql.js).
- The geo.admin.ch profile service (`profile.ts`): POST the GeoJSON geometry as the raw body with `sr`/`nb_points` in the query string. It is limited to 5000 points, keeps input vertices and may add extra points, so results are matched back by coordinates.
- SchweizMobil routes (`ch.astra.wanderland`) come back as unordered MultiLineStrings. `chain()` joins them, then the route is oriented by geocoding the "from/to" in the title, then clipped to the bbox.
- Curated hikes in `regions/<id>.json` name their via-points. These resolve through swissNAMES3D (`resolvePlace`, with an optional `kind`) and are routed with Dijkstra on `TrailGraph`, using Swiss hiking time as the edge weight.
- Every route gets DEP/ARR waypoints. Where a route is clipped, the pipeline adds a synthetic "Region edge → …" place.

### Swiss hiking time (`src/geo/hikingTime.ts`)
`PACE` is a table digitised from the official Schweizer Wanderwege isochrone chart (4.2 km/h on the flat, fastest at about −5 %). It is not a rule of thumb; don't replace it with one. Slope comes from altitudes smoothed over about 60 m, and signpost display rounds to 5 min.

Route `stats` are computed in the pipeline (`finishRoute`). The per-sample cumulative series (`km`, `minutes`, `up`, `down`) are re-derived on load (`deriveRoute` in `src/data/load.ts`). `reverseRoute` builds the to → from view from the same samples and helpers (time = `timeBack`); `main.ts` caches it, so panels can cache on the route object rather than its id. Both sides must use the same helpers (`routeClimb` in `src/geo/track.ts`, `cumulativeMinutes`), so the route list and the preview panels show the same numbers. `check:region` fails if the stored climb totals drift from `routeClimb`.

### Rendering (`src/gl/`)
- World space: x = east, y = up, z = **south**, origin at the bbox centre. `TerrainView.world(e, n, alt)` converts bundle coordinates; grid cell `i` sits at `(i + 0.5) * cell`.
- Vertical exaggeration is applied **in the vertex shaders** (`uExag`, `uBase`), so CPU-side geometry (trails, contours, ribbons) stores raw altitudes and never needs rebuilding.
- The point cloud has no vertex buffer. Points come from `gl_VertexID`, which samples an `R16UI` height texture, with jitter, depth-of-field point size and distance fade. Stride 2 applies beyond 16 km camera distance.
- The scene has no depth test: points and contours are additive, network and ribbons are blended over them (hologram look). The one exception is inside a route ribbon, where the depth buffer only decides which of its overlapping segments owns a pixel (see below). Contours are computed in `contours.worker.ts`.
- The trail network is instanced: one screen-space quad per segment, so its width holds at any DPR (`GL_LINES` is always 1 device pixel). Like a printed map, it is drawn twice: first a casing in the background colour that clears the point cloud underneath, then the class colours. The selected route is a screen-space ribbon coloured per segment by trail class (`uByClass`, off-network segments in `gl.hover`) with its own casing, wider than the network, so it reads above it even where it runs on top of a trail of the same class. The owner found an accent outline around it and wider ribbons too heavy. Ribbons are instanced too, but each segment is a capsule (round ends), so segments meet in round joins. They are drawn opaque, and each fragment writes its distance from its segment as depth, so the nearest segment owns every pixel: segments are often shorter than the ribbon is wide, and without that, overlapping antialiased edges would double up. A hovered route is the same, a little thinner. Both ribbons narrow to about half their width as the camera pulls back from 4 to 16 km (`RIBBON_SHRINK`), because full-width ribbons swamp the overview.
- The owner found the full network overwhelming, so by default only the trails branching off the selected route are drawn. `TerrainView.trailMode` is `'auto'`, `'all'` or `'off'`, and is cycled by the TRAILS button in the stage toolbar. In `'auto'` the network fades with walking distance along the trails from the selected route (fully shown within 300 m, gone by 5 km, `NETWORK_REACH`), at any zoom. `TrailNetwork` (src/geo/network.ts) computes that distance per vertex with a multi-source Dijkstra when the route changes; it feeds the per-instance `aNear` attribute, and the reach grows out from a newly selected route over 0.8 s (not under `prefers-reduced-motion`).
- `OrbitCamera` (src/gl/camera.ts) slowly circles its target when left alone (`spin`, off under `prefers-reduced-motion`). Any drag, wheel or double-click pauses it until the pointer has been still for `resume` seconds. A `flyTo` without `az` leaves the azimuth free so the orbit keeps turning; one with `az` (reset) pauses it. Once the user pans or zooms (`framed`), the playlist moving on by itself keeps their view; choosing a route (list, map, skip) or double-clicking flies again.
- On touch screens the map takes every gesture (`touch-action: none` on `#terrain`, so the page scrolls around it): one finger orbits, two fingers pinch to zoom and drag to pan, and a double tap resets (caught in `attach`, as not every touch browser sends `dblclick`). A tap selects a route with more slack than a click (10 px of movement, 24 px pick radius), and a gesture that ever had two fingers is never a tap. A view narrower than `minAspect` (1.2:1, a phone held upright) widens its vertical field instead of losing the sides, so fly-to framing and the home view need no per-device distances. `test/camera.test.ts` covers the gestures and the field of view.
- A scan line sweeps the terrain between the grid's lowest and highest altitude (`scanAlt` in `render`). The stage's altitude meter (`.alt-meter`, built in `mountStageOverlay`) follows it.
- Labels, the hiker and the crosshair are drawn on a separate 2D canvas (`src/hud/labels.ts`) by projecting with the frame's view-projection matrix. Text, leader lines and markers are drawn without a halo or outline (the owner found outlined marks too heavy); they sit on the background between the sparse points, which is why `test/theme.test.ts` checks label colours against `bg`. Only the hiker callout and the hover readout get a background plate. Route waypoints are kept subtle, like the pins of the hud-console-framework demo: a level ring on the ground around the track (sized by camera distance, so it keeps its screen size but lies flat), a thin leader up to a small hollow circle, and the plain ID and name beside it. They show passed / next / ahead relative to the preview hiker; only the next one takes the accent, and its ring breathes (`nextWaypoint` in `src/data/load.ts`, shared with the waypoints panel). The hiker is a filled arrowhead (`pointer` in `src/hud/pointer.ts`, the same shape the charts use) aimed over ±60 m of track and low-pass filtered in time (`smoothHeading`), with a sonar ping and a telemetry callout; the ping stops under `prefers-reduced-motion`. Hovering the elevation profile puts the same arrowhead, outlined, on the map. Like the ribbons, these markers (hiker, ping, hover arrowhead, waypoint pins and rings) shrink to under half their size as the camera pulls back from 4 to 40 km (`MARKER_SHRINK`, handed to the label layer as `RenderInfo.markers`); text keeps its size.

### Theming (`src/theme/`)
- One visual language, **paperlab** (flat greys ported from LosEcher/hud-console-framework, with a glacier-cyan accent), in two **schemes**: dark (the default, `DEFAULT_DISPLAY`) and light. The owner chose to drop the theme (accent) and style layers and the old teal `phosphor` look. Don't bring back a theme or style picker.
- `tokens.ts` is pure data (`SCHEMES`, `TRAILS`) plus `resolve()`. The saved choice (localStorage) is overridden by `?scheme=`; `?region=` picks the region and the hash belongs to `#route=`.
- `apply.ts` sets the CSS variables and mutates the shared `palette` (re-exported as `COLORS` in `panels/common.ts`). Canvas and WebGL code reads `palette` / `palette.gl` and never hard-codes a colour; inline HTML uses `var(--…)`. The `:root` values in `hud.css` mirror the default display for the first paint.
- The light scheme draws the terrain with premultiplied over-blending (`gl.blend: 'over'`), because additive light washes out on paper.
- Trail-class colours (`TRAILS`) are the official Swiss signpost colours. They are adjusted only for contrast per scheme and never follow the accent. The owner wants the accent to stay clear of them: `test/theme.test.ts` checks contrast for both schemes and requires the accent to keep its distance from every trail colour, also for red-green colour-blind viewers. That rules out reds, oranges, yellows, blues and violets.

### App state and panels
- `Store` (src/state.ts) is a tiny observable. `main.ts` reacts to `routeId` / `hoverRouteId` / `mode` changes via `subscribe`.
- The preview position `store.state.minute` is **mutated directly** in the render loop, without notifying, for performance.
- Panel A (Route player) plays the region's routes as a playlist (`Playlist` in `src/playlist.ts`, in the route list's `CATEGORY_ORDER`). `ctx.skip(±1)` changes route; "previous" first rewinds a route that has played for over 2 s. At the finish the loop holds 2.5 s, then repeats the route (`repeat`) or moves on. `shuffle` walks a random queue that starts at the current route. Space and ← / → are handled on `window` unless a control has focus.
- Each `mount*` function in `src/panels/` builds its DOM once and returns an update callback. `main.ts` polls all of them about every 50 ms, and they rebuild static parts only when the route id changes.
- Small screens are handled in `hud.css` alone; `index.html` keeps the desktop column structure:
  - Up to 1100 px the page scrolls: the map first, then the profile and gradient side by side, then the panels two by two.
  - Up to 640 px (phones) `.col` and `.row-bottom` become `display: contents`, so `order` can put the route player straight under the map, then the profile, waypoints and routes, then the other panels.
  - `(pointer: coarse)` enlarges the controls a finger has to hit, and `(hover: none)` swaps the map's mouse hints for touch hints.
  - Hover-only behaviour stays mouse-only (the route list's hover ribbon checks `pointerType`). The elevation profile takes pointer events, so a finger dragged along it scrubs the hiker while vertical swipes still scroll.

### Regions
- The app boots from `regions.json`: `pickRegion` (src/regions.ts) takes `?region=<id>`, else `DEFAULT_REGION` (`alpstein`, so links from before regions existed still open the right hike), else the first region. The route comes from `#route=`, else the region's `defaultRoute`.
- One region is loaded at a time. Switching (`ctx.goToRegion`) is a page load of the `?region=` URL (`regionHref` keeps `?scheme=` and drops the hash), so nothing has to be torn down and the back button returns to the previous region. The region button is the brand subtitle in the top bar (`mountRegionPicker`, a button once there are two regions).
- The region browser (`src/ui/regionBrowser.ts`) is a native `<dialog>`, opened by the region button, the G key and the expand button on the locator (G). It holds a large map and a list of the regions filtered by `filterRegions` (title, subtitle, canton code or name, ignoring accents). The map and the list share one active region, and ↑ / ↓ / Enter work in the filter. A click opens a region. On touch, a tap on the map first picks the region and a tap on its list entry opens it. The filter is only autofocused on a fine pointer, so a phone keyboard doesn't cover the list. On phones the dialog is full screen.
- The locator (G) and the browser draw the same map, `SwissMap` (`src/hud/switzerland.ts`):
  - The national relief is a point cloud. Lakes are solid patches, found by `lakeCells` (`src/geo/relief.ts`) from the flat cells of `switzerland.u16`.
  - The border, canton borders and region boxes are draped on the relief (`reliefAt`, altitudes smoothed along the line), so a box sits on the mountains it covers.
  - Boxes have a background casing, like the trail network. Hit tests take the nearest box centre (`hitRegion`), because neighbouring regions touch.
  - The current region has a wedge showing the 3D camera's footprint (`cameraCone`, using `OrbitCamera.hfov`).
  - The locator sways, but not under the pointer, while a region is picked, or under `prefers-reduced-motion`. On touch its first tap names a region and shows an OPEN button, because opening is a page load.
- Lingering on a region (200 ms) in either map or the list calls `prefetchRegion`. It fetches `region.json` and adds `<link rel="prefetch">` for the bundle's files, skipped under Save-Data.
- `regions.json` (`RegionIndex` version 2) also carries each region's facts for the browser: `classics`, `trailKm` and `alt`.
- Regions are 24 × 19 km boxes, which keeps a bundle under its 6 MB budget at 20 m cells. Zermatt is 27 km wide, to take in Saas-Fee: with the Matterhorn pinning its west edge, it would otherwise have too few SchweizMobil routes. Regions don't overlap, and `check:region` fails if two do. They were chosen with `scripts/scout-regions.ts` (`task regions:scout`):
  - It scores boxes on a 1 km grid built from the cached national data (trail km per class from the Wanderwege R-tree, swissNAMES3D huts, summits, lakes, lifts, rail stops), with the weights in `scripts/lib/scout.ts`.
  - With no arguments, it ranks the best boxes that overlap no `regions/*.json`. `--at E,N[,E,N …]` places the best box near an anchor while keeping the listed points inside. `--places <id>` lists the places in a box, for writing curated hikes.
  - Pure ranking favours Graubünden, which signposts most of its network as Bergwanderweg, so the 17 regions were anchored on well-known hiking areas and placed by `--at`.
- To add a region:
  1. Scout a box.
  2. Write `regions/<id>.json` (bbox, `cell`, `defaultRoute`, curated hikes).
  3. Run `task region REGION=<id>`.
  4. Commit `public/data/<id>/` with the updated `regions.json`.

  A box may reach abroad: `check:region` only fails when over 1 % of the cells *inside* Switzerland are empty (`emptyCells` in `scripts/lib/coverage.ts`). Curated hikes should add something SchweizMobil doesn't already have, so check the build log's route list first.

## Deploy

`.github/workflows/pages.yml` deploys on release tags (`v*`, plus manual `workflow_dispatch`), not on pushes to `main`. It fails unless the tag equals `v` + the `package.json` version, runs the same checks as CI, builds with `BASE=/<repo>/` and publishes `dist/` to GitHub Pages. Release from `main` with `task release BUMP=<patch|minor|major>` (`npm version` + `git push --follow-tags`); the `create-release` skill in `.claude/skills/` walks through the whole flow. `.github/workflows/ci.yml` runs `typecheck`, `test`, `check:region` (every region) and `build` on pull requests and on every branch push (tags don't trigger it).
