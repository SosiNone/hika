# AGENTS.md

This file provides guidance to coding agents (Claude Code and others) working in this repository.

## What this is

HIKA: a sci-fi HUD for exploring Swiss hiking routes, built only on swisstopo / geo.admin.ch open data. The product is about **exploring hiking routes**. Do not add race features (race times, leaderboards, cutoffs); the owner explicitly rejected them. The look is inspired by beastydesign.github.io/scifi, which is "all rights reserved": copy no code or assets from it.

## Work

- Bump the version to your own judgement.
- Follow open source best practices and maintain professional grade software.
- Use [tasks](https://taskfile.dev/) to abstract out common commands for the end user. `Taskfile.yml` wraps the npm scripts in `package.json`; when adding a script, add a matching task with a `desc`.

## Architecture

There are three parts, joined by a static data store, the **atlas**:

- **`scripts/`: the build-time pipeline (Node, run with tsx).** `build-atlas.ts` orchestrates `scripts/lib/*` and writes the atlas from swisstopo / geo.admin.ch open data. It writes to `.atlas/v3/` (gitignored), or to a checkout of the data repo (`task atlas ATLAS=../hika-data/v3`). `check-atlas.ts` validates it.
- **The data repo, [SosiNone/hika-data](https://github.com/SosiNone/hika-data).** It holds the built atlas and nothing else, and GitHub Pages serves it at `https://sosinone.github.io/hika-data/v3/`, the same origin as the app. Data refreshes and new regions ship from there, without an app release.
- **`src/`: the browser app.** It only reads the atlas and never calls geo.admin.ch at runtime. Builds read the published atlas. `task dev` serves `.atlas/v3/` under `/data/v3/` when one is built, else it also reads the published atlas. `DATA_URL` overrides both (`vite.config.ts`).

`src/data/types.ts` (`AtlasManifest`, `Route`, `CatalogueEntry`, `RegionSummary`, `RegionConfig`) is the contract between them, with `src/data/codec.ts` (byte layouts) and `src/data/tiles.ts` (the tile grid, windows, stitching). The pipeline imports from `src/geo/*` and `src/data/*` except `load.ts`; keep those modules free of DOM code.

`docs/data-coverage.md` tracks which data is in the atlas, which of it the app shows, and what the sources offer beyond that. Update it when you add a source, an atlas field or a panel.

### Atlas format (`v3/`)
- Everything is in absolute LV95 (EPSG:2056) metres. `manifest.json` `format` is the atlas format (`ATLAS_FORMAT` in `src/data/types.ts`, now 3). The app refuses any other format. A new format goes in a new `v4/` next to `v3/` in hika-data, until the app release that reads it is live.
- **Tiles** (`src/data/tiles.ts`) are 5 km squares keyed by their south-west corner in km (`2735_1225`). `manifest.json` lists the tiles that exist (tiles with no data at all, abroad, are left out), and each has three files:
  - `terrain/<key>.bin`: 250 × 250 cells of 20 m, Uint16 **decimetres**, row-major, row 0 = **north** edge, values at cell centres, `0` = no data. swissALTI3D ends at the national border (and leaves out Lake Constance), so windows that reach abroad have `0` cells there. They are skipped, never drawn as 0 m: the point shader and the contour worker drop any cell with a `0` corner, and `TerrainView.heightAt` interpolates over the corners that have data.
  - `trails/<key>.bin`: each swissTLM3D line stored whole, unclipped, in the tile that holds the centre of its extent, so no line is cut at a tile edge. Vertices are whole metres from the tile's SW corner plus `TRAIL_BIAS`.
  - `places/<key>.json`: the swissNAMES3D places in the tile, one per line.
- `routes/<id>.bin` (`encodeRoute`, magic `HKR3`): one whole route, never clipped, with the places its waypoints name. Route ids are `sm-<SchweizMobil id>` (e.g. `sm-951.00`) or `c-<curated id>`, unique across the atlas (`check:atlas`). The app reads and writes `#route=<id>` in the URL, plus `&reverse=1` when the hike is walked to → from.
- `catalogue.json`: every route's meta, stats, bbox, a 24-point altitude sparkline and the regions that list it, one per line. The app loads it at boot.
- `regions.json` (`RegionIndex` version 3): the regions (see Regions), one per line, with the facts the region browser shows. `scripts/lib/regions.ts` derives it from `regions/<id>.json`, the catalogue and the tiles.
- `locator.json` and `switzerland.u16`, the coarse national relief (raw Uint16 decimetres), stored once.
- `src/data/codec.ts` is the one module the pipeline encodes with and the app decodes with:
  - Terrain stores gradient-predictor residuals, trails per-line vertex deltas (`HKT2`), routes per-sample deltas.
  - All store 16-bit values modulo 2^16, with the low-byte plane before the high-byte plane.
  - They are deliberately **not compressed** in the file. Git's zlib and the GitHub Pages gzip roughly halve them, and a small upstream change stays a small change that git can delta.
- Rebuilds are reproducible. `build-atlas` rewrites only files whose bytes changed, removes tile and route files no longer in the atlas, and keeps `generated` when nothing changed, so rebuilding unchanged data leaves the data repo clean. Don't add anything that varies per run (timestamps, random order).

### Windows
- The app shows one **window** of the atlas at a time: `loadWindow` (`src/data/load.ts`) fetches the tiles that cover it, stitches them (`stitchGrid`) and clips the trail lines to it. Decoded tiles are kept for the page, and neighbouring windows share most of theirs.
- `routeWindow` is a route's extent plus 2 km (`WINDOW_MARGIN`), on whole km. When the route is opened from a region, it is joined with the region's box, as long as that needs no more than `WINDOW_MAX_TILES` (6 × 6). Regions don't sit on the tile grid, so a cap on area would let a 27 × 27 km window take 7 × 7 tiles.
- One window can't hold a region's routes: whole routes reach far beyond the boxes (that would be 29–49 km, Lucerne 49 × 46 km). So when the selected route leaves the window (`covers`), `main.ts` loads its window and `TerrainView.load` swaps it in place. A later choice of route overrides a window still loading. Hovering a route, and the finish of one that will move on, prefetch the next window.
- `check:atlas` requires every window, a route's own and the one joined with each region that lists it, to cost under 3 MB gzipped, including the atlas-wide files and the region's routes (a region bundle with its imagery cost 2.3–2.5 MB).

### Pipeline facts that were learned the hard way
- swissALTI3D 2 m COGs (found via STAC) have a single 4 m internal overview. `terrain.ts` reads that overview and box-averages it, so `cell` must be a multiple of 4 that divides 1000.
- Trail class (Wanderweg / Bergwanderweg / Alpinwanderweg) and surface exist only in the swissTLM3D Wanderwege **GeoPackage**. The REST layer only flags Alpinwanderweg. The GeoPackage is read with `node:sqlite` plus the hand-written WKB parser in `gpkg.ts` (no GDAL, no sql.js).
- The geo.admin.ch profile service (`profile.ts`): POST the GeoJSON geometry as the raw body with `sr`/`nb_points` in the query string. It is limited to 5000 points, keeps input vertices and may add extra points, so results are matched back by coordinates.
- The `identify` service returns at most 200 results per request, so `listRoutes` pages with `offset`. Switzerland has 976 SchweizMobil routes and stages: 193 national, 404 regional and 379 local.
- SchweizMobil routes (`ch.astra.wanderland`) come back as unordered MultiLineStrings. `chain()` joins them, then the route is oriented by geocoding the "from/to" in the title, near the route's own midpoint. Routes are kept whole; a route any region excludes (`excludeRoutes`, e.g. 974.00 in Liechtenstein, where there is no terrain) is left out of the atlas.
- Curated hikes in `regions/<id>.json` name their via-points. These resolve through swissNAMES3D (`resolvePlace`, with an optional `kind`) and are routed with Dijkstra on `TrailGraph`, using Swiss hiking time as the edge weight, over the trails within 5 km of the region.
- Every route gets DEP/ARR waypoints: the nearest named place, else a place named after the route's end.
- `finishRoute` (`scripts/lib/route.ts`) samples, heights, classifies and times every route.
- **Fair use.** The geo.admin.ch REST services (api3, and the STAC API on data.geo.admin.ch) allow 40 requests a minute under the FSDI terms, so `fetchCached` (`scripts/lib/http.ts`) spaces requests that miss the cache 1.5 s apart. File downloads (the swissALTI3D COGs, the GeoPackages) are the download service those terms send bulk use to. A first national build therefore takes hours, and later builds hit the cache. Don't remove the pacing.
- **Footprint.** `build-atlas` covers every region box plus the windows of every route a region lists. For the 17 regions that is 799 tiles (19,975 km², about half of Switzerland, 783 with data) and 127 MB, because whole routes reach far beyond the boxes. The whole country should come to about 260 MB. `--region <id>` builds one region's footprint (the atlas in the output directory then holds just that), and `--dry-run` only measures it.
- `check:atlas` checks:
  - that tiles decode, and every line and place sits in its tile;
  - coverage: no 1 km block missing well inside the border, and under 1 % empty cells inside Switzerland;
  - every route (`routeProblems`): lengths, altitudes, times, climb drift, waypoints, and terrain under every sample inside Switzerland;
  - that the catalogue matches the route files;
  - `regions.json` against `regions/` and the catalogue, and that no two regions overlap;
  - the window budget.

### Swiss hiking time (`src/geo/hikingTime.ts`)
`PACE` is a table digitised from the official Schweizer Wanderwege isochrone chart (4.2 km/h on the flat, fastest at about −5 %). It is not a rule of thumb; don't replace it with one. Slope comes from altitudes smoothed over about 60 m, and signpost display rounds to 5 min.

Route `stats` are computed in the pipeline (`finishRoute`). The per-sample cumulative series (`km`, `minutes`, `up`, `down`) are re-derived on load (`deriveRoute` in `src/data/load.ts`). `reverseRoute` builds the to → from view from the same samples and helpers (time = `timeBack`); `main.ts` caches it, so panels can cache on the route object rather than its id. Both sides must use the same helpers (`routeClimb` in `src/geo/track.ts`, `cumulativeMinutes`), so the route list and the preview panels show the same numbers. `check:atlas` fails if the stored climb totals drift from `routeClimb`.

### Rendering (`src/gl/`)
- World space: x = east, y = up, z = **south**, origin at the centre of the window shown. `TerrainView.world(e, n, alt)`, `ground` and `heightAt` take LV95, like every route and place in the app; the window's trails are stored in metres from its corner. Grid cell `i` sits at `(i + 0.5) * cell`. `TerrainView.load(window)` swaps the window in place: it moves the camera with the origin (`OrbitCamera.shift`), so it stays over the same ground, and makes the new window's overview the home (double-click).
- Vertical exaggeration is applied **in the vertex shaders** (`uExag`, `uBase`), so CPU-side geometry (trails, contours, ribbons) stores raw altitudes and never needs rebuilding.
- The point cloud has no vertex buffer and one colour mode: the owner dropped the SWISSIMAGE mode in 0.13, because orthophotos would add about 95 MB to national data for a mode few used. Points come from `gl_VertexID`, which samples an `R16UI` height texture, with jitter, depth-of-field point size and distance fade. Stride 2 applies beyond 16 km camera distance.
- The scene has no depth test: points and contours are additive, network and ribbons are blended over them (hologram look). The one exception is inside a route ribbon, where the depth buffer only decides which of its overlapping segments owns a pixel (see below). Contours are computed in `contours.worker.ts`.
- The trail network is instanced: one screen-space quad per segment, so its width holds at any DPR (`GL_LINES` is always 1 device pixel). Like a printed map, it is drawn twice: first a casing in the background colour that clears the point cloud underneath, then the class colours. The selected route is a screen-space ribbon coloured per segment by trail class (`uByClass`, off-network segments in `gl.hover`) with its own casing, wider than the network, so it reads above it even where it runs on top of a trail of the same class. The owner found an accent outline around it and wider ribbons too heavy. Ribbons are instanced too, but each segment is a capsule (round ends), so segments meet in round joins. They are drawn opaque, and each fragment writes its distance from its segment as depth, so the nearest segment owns every pixel: segments are often shorter than the ribbon is wide, and without that, overlapping antialiased edges would double up. A hovered route is the same, a little thinner. Both ribbons narrow to about half their width as the camera pulls back from 4 to 16 km (`RIBBON_SHRINK`), because full-width ribbons swamp the overview.
- The owner found the full network overwhelming, so by default only the trails branching off the selected route are drawn. `TerrainView.trailMode` is `'auto'`, `'all'` or `'off'`, and is cycled by the TRAILS button in the stage toolbar. In `'auto'` the network fades with walking distance along the trails from the selected route (fully shown within 300 m, gone by 5 km, `NETWORK_REACH`), at any zoom. `TrailNetwork` (src/geo/network.ts) computes that distance per vertex with a multi-source Dijkstra when the route changes; it feeds the per-instance `aNear` attribute. A newly selected route loads its trails: a front runs out along them to 5 km in 1.8 s (`LOAD`), with a short head in the accent that dims with the reach, while the trails of the route before (`aPrev`) fade out over 0.4 s (`UNLOAD`). The fragment shader takes the walking distance from whichever end of a segment is nearer, so the front sweeps along long segments too. Switching TRAILS to AUTO loads them again. None of it moves under `prefers-reduced-motion`.
- `OrbitCamera` (src/gl/camera.ts) slowly circles its target when left alone (`spin`, off under `prefers-reduced-motion`). Any drag, wheel or double-click pauses it until the pointer has been still for `resume` seconds. A `flyTo` without `az` leaves the azimuth free so the orbit keeps turning; one with `az` (reset) pauses it. Once the user pans or zooms (`framed`), the playlist moving on by itself keeps their view; choosing a route (list, map, skip) or double-clicking flies again.
- On touch screens the map takes every gesture (`touch-action: none` on `#terrain`, so the page scrolls around it): one finger orbits, two fingers pinch to zoom and drag to pan, and a double tap resets (caught in `attach`, as not every touch browser sends `dblclick`). A tap selects a route with more slack than a click (10 px of movement, 24 px pick radius), and a gesture that ever had two fingers is never a tap (`RoutePicker`, below). A view narrower than `minAspect` (1.2:1, a phone held upright) widens its vertical field instead of losing the sides, so fly-to framing and the home view need no per-device distances. `test/camera.test.ts` covers the gestures and the field of view.
- `RoutePicker` (src/gl/picker.ts) picks routes on the map with `pickRoute` in `main.ts`, the nearest route sample within the pick radius. A click or tap selects that route. A resting mouse hovers it, the same hover ribbon as the route list, with a pointer cursor, so the map shows what a click would select. Not while a drag orbits or pans: the hover clears once a press moves like a drag (4 px) and comes back on release. The hover is picked in the render loop, on the frame after the mouse moves and every 100 ms while it rests, so it follows the idle orbit, but not during a fly-to, which would flash every route it sweeps past. Hover ribbons are cached per route view (`TerrainView.ribbonOf`). `test/picker.test.ts` covers it.
- A scan line sweeps the terrain between the grid's lowest and highest altitude (`scanAlt` in `render`). The stage's altitude meter (`.alt-meter`, built in `mountStageOverlay`) follows it.
- Labels, the hiker and the crosshair are drawn on a separate 2D canvas (`src/hud/labels.ts`) by projecting with the frame's view-projection matrix. Text, leader lines and markers are drawn without a halo or outline (the owner found outlined marks too heavy); they sit on the background between the sparse points, which is why `test/theme.test.ts` checks label colours against `bg`. Only the hiker callout and the hover readout get a background plate. Route waypoints are kept subtle, like the pins of the hud-console-framework demo: a level ring on the ground around the track (sized by camera distance, so it keeps its screen size but lies flat), a thin leader up to a small hollow circle, and the plain ID and name beside it. They show passed / next / ahead relative to the preview hiker; only the next one takes the accent, and its ring breathes (`nextWaypoint` in `src/data/load.ts`, shared with the waypoints panel). The hiker is a filled arrowhead (`pointer` in `src/hud/pointer.ts`, the same shape the charts use) aimed over ±60 m of track and low-pass filtered in time (`smoothHeading`), with a sonar ping and a telemetry callout; the ping stops under `prefers-reduced-motion`. Hovering the elevation profile puts the same arrowhead, outlined, on the map. Like the ribbons, these markers (hiker, ping, hover arrowhead, waypoint pins and rings) shrink to under half their size as the camera pulls back from 4 to 40 km (`MARKER_SHRINK`, handed to the label layer as `RenderInfo.markers`); text keeps its size.

### Theming (`src/theme/`)
- One visual language, **paperlab** (flat greys ported from LosEcher/hud-console-framework, with a glacier-cyan accent), in two **schemes**: dark (the default, `DEFAULT_DISPLAY`) and light. The owner chose to drop the theme (accent) and style layers and the old teal `phosphor` look. Don't bring back a theme or style picker.
- `tokens.ts` is pure data (`SCHEMES`, `TRAILS`) plus `resolve()`. The saved choice (localStorage) is overridden by `?scheme=`; `?region=` picks the region and the hash belongs to `#route=`.
- `apply.ts` sets the CSS variables and mutates the shared `palette` (re-exported as `COLORS` in `panels/common.ts`). Canvas and WebGL code reads `palette` / `palette.gl` and never hard-codes a colour; inline HTML uses `var(--…)`. The `:root` values in `hud.css` mirror the default display for the first paint.
- The light scheme draws the terrain with premultiplied over-blending (`gl.blend: 'over'`), because additive light washes out on paper.
- Trail-class colours (`TRAILS`) are the official Swiss signpost colours. They are adjusted only for contrast per scheme and never follow the accent. The owner wants the accent to stay clear of them: `test/theme.test.ts` checks contrast for both schemes and requires the accent to keep its distance from every trail colour, also for red-green colour-blind viewers. That rules out reds, oranges, yellows, blues and violets.

### App state and panels
- `Store` (src/state.ts) is a tiny observable. `main.ts` reacts to `routeId` / `hoverRouteId` / `display` changes via `subscribe`.
- The preview position `store.state.minute` is **mutated directly** in the render loop, without notifying, for performance.
- Panel A (Route player) plays the region's routes as a playlist (`Playlist` in `src/playlist.ts`, in the route list's `CATEGORY_ORDER`). `ctx.skip(±1)` changes route; "previous" first rewinds a route that has played for over 2 s. At the finish the loop holds 2.5 s, then repeats the route (`repeat`) or moves on. `shuffle` walks a random queue that starts at the current route. Space and ← / → are handled on `window` unless a control has focus.
- Each `mount*` function in `src/panels/` builds its DOM once and returns an update callback. `main.ts` polls all of them about every 50 ms, and they rebuild static parts only when the route id changes.
- Small screens are handled in `hud.css` alone; `index.html` keeps the desktop column structure:
  - Up to 1100 px the page scrolls: the map first, then the profile and gradient side by side, then the panels two by two.
  - Up to 640 px (phones) `.col` and `.row-bottom` become `display: contents`, so `order` can put the route player straight under the map, then the profile, waypoints and routes, then the other panels.
  - `(pointer: coarse)` enlarges the controls a finger has to hit, and `(hover: none)` swaps the map's mouse hints for touch hints.
  - Hover-only behaviour stays mouse-only (the route list's and the map's hover ribbon check `pointerType`). The elevation profile takes pointer events, so a finger dragged along it scrubs the hiker while vertical swipes still scroll.

### Regions
- Regions are curated entry points into the atlas: a box, a title, the SchweizMobil routes it lists (by `minInside`/`minInsideKm`), curated hikes and a default route. They carry no data of their own, so the same route can be on several regions' lists.
- The app boots from the atlas (`loadAtlas`): `pickRegion` (src/regions.ts) takes `?region=<id>`, else `DEFAULT_REGION` (`alpstein`, so links from before regions existed still open the right hike), else the first region. The route comes from `#route=`, else the region's `defaultRoute`. A `#route=` that another region lists opens that region and corrects `?region=`.
- One region is shown at a time, with all its route files loaded (`loadRoutes`). Switching (`ctx.goToRegion`) is a page load of the `?region=` URL (`regionHref` keeps `?scheme=` and drops the hash), so the back button returns to the previous region. The region button is the brand subtitle in the top bar (`mountRegionPicker`, a button once there are two regions).
- The region browser (`src/ui/regionBrowser.ts`) is a native `<dialog>`, opened by the region button, the G key and the expand button on the locator (G). It holds a large map and a list of the regions filtered by `filterRegions` (title, subtitle, canton code or name, ignoring accents). The map and the list share one active region, and ↑ / ↓ / Enter work in the filter. A click opens a region. On touch, a tap on the map first picks the region and a tap on its list entry opens it. The filter is only autofocused on a fine pointer, so a phone keyboard doesn't cover the list. On phones the dialog is full screen.
  - It is the locator tile (G) grown, so it has the same title ("Switzerland") and the same map at the same angle. However it is opened, it grows out of the tile, and every way of closing it (✕, Escape, the backdrop, the current region) shrinks it back via `shut()`. This is a view transition (`morph`): the tile and the dialog take turns holding the view-transition name `region-browser`, so the browser animates one box between them while their pictures cross-fade, and their map canvases hold `region-browser-map`, so the map moves on its own from the tile's body to the browser's map pane (styled in `hud.css`). Only one element may hold a name at a time, or the transition aborts. The browser draws the map at the tile's sway angle, and the tile holds that angle (`Sway.held`) while the browser is open, so the map neither turns while it grows nor when it shrinks back. It doesn't straighten: turning the browser's large relief would redraw it every frame, too slow for the transition at 2× pixel density. With the tile scrolled off screen (phones), the browser zooms in and out on its own, as one picture. Without the View Transitions API, or under `prefers-reduced-motion`, it opens and closes at once.
- The locator (G) and the browser draw the same map, `SwissMap` (`src/hud/switzerland.ts`), with one projection (`TILT`) and one `Sway` (created in `main.ts`):
  - The national relief is a point cloud. Lakes are solid patches, found by `lakeCells` (`src/geo/relief.ts`) from the flat cells of `switzerland.u16`.
  - The border, canton borders and region boxes are draped on the relief (`reliefAt`, altitudes smoothed along the line), so a box sits on the mountains it covers.
  - Boxes have a background casing, like the trail network. Hit tests take the nearest box centre (`hitRegion`), because neighbouring regions touch.
  - The current region has a wedge showing the 3D camera's footprint (`cameraCone`, using `OrbitCamera.hfov`).
  - The locator sways, but not under the pointer, while a region is picked, or under `prefers-reduced-motion`. On touch its first tap names a region and shows an OPEN button, because opening is a page load.
- Lingering on a region (200 ms) in either map or the list calls `prefetchRegion`. It adds `<link rel="prefetch">` for the tiles of the window the region opens with and for its route files, skipped under Save-Data.
- `regions.json` carries each region's facts for the browser: `classics`, `trailKm`, `hardKm` and `alt`.
- Regions are 24 × 19 km boxes, which keeps a window joined with one within the budget. Zermatt is 27 km wide, to take in Saas-Fee: with the Matterhorn pinning its west edge, it would otherwise have too few SchweizMobil routes. Regions don't overlap, and `check:atlas` fails if two do. They were chosen with `scripts/scout-regions.ts` (`task regions:scout`):
  - It scores boxes on a 1 km grid built from the cached national data (trail km per class from the Wanderwege R-tree, swissNAMES3D huts, summits, lakes, lifts, rail stops), with the weights in `scripts/lib/scout.ts`.
  - With no arguments, it ranks the best boxes that overlap no `regions/*.json`. `--at E,N[,E,N …]` places the best box near an anchor while keeping the listed points inside. `--places <id>` lists the places in a box, for writing curated hikes.
  - Pure ranking favours Graubünden, which signposts most of its network as Bergwanderweg, so the 17 regions were anchored on well-known hiking areas and placed by `--at`.
- To add a region:
  1. Scout a box.
  2. Write `regions/<id>.json` (bbox, `defaultRoute`, curated hikes) and commit it here.
  3. Run `task atlas ATLAS=../hika-data/v3` in a checkout next to hika-data.
  4. Commit the changed atlas in hika-data. Its Pages deploy publishes it; the app needs no release.

  A box may reach abroad: `check:atlas` only fails on missing data *inside* Switzerland. Curated hikes should add something SchweizMobil doesn't already have, so check the build log's route list first.

## Licences and attribution

The code is MIT (`LICENSE`). The data keeps its owners' terms, which every place that shows or ships it must follow:
- **swisstopo** (swissALTI3D, swissTLM3D, swissNAMES3D, swissBOUNDARIES3D) is free geodata (OGD): any use, including commercial, with "©swisstopo" credited on every representation and distribution.
- **Wanderland Schweiz** (`ch.astra.wanderland`, licensor FEDRO, with SchweizMobil and the cantons) is opendata.swiss "open use, must provide the source": credit the author and title, with a link to the dataset.
- The **FSDI** terms (geo.admin.ch) add the fair-use limit (see the pipeline facts), and ask that processed data be published under our own name: hika-data's README does that.

Where they are credited:
- `scripts/lib/sources.ts` lists the sources with their dataset links and terms; it goes into the atlas's `manifest.json`.
- The app's footer credits ©swisstopo and Wanderland Schweiz © FEDRO, with links.
- `NOTICE.md` has the data credits and third-party notices. The build emits `NOTICE.txt` beside the site, with `LICENSE`, `NOTICE.md` and the IBM Plex Mono licence (the SIL OFL asks that the font's licence travel with it). The footer's LICENCES link opens it.
- hika-data's README and LICENSE repeat the credits for anyone who reuses the files.

When you add a source, add it to `sources.ts`, `NOTICE.md`, hika-data's README and, if the app shows it, the footer.

## Deploy

`.github/workflows/pages.yml` deploys on release tags (`v*`, plus manual `workflow_dispatch`), not on pushes to `main`. It fails unless the tag equals `v` + the `package.json` version, runs the same checks as CI, builds with `BASE=/<repo>/` and publishes `dist/` to GitHub Pages. Release from `main` with `task release BUMP=<patch|minor|major>` (`npm version` + `git push --follow-tags`); the `create-release` skill in `.claude/skills/` walks through the whole flow. `.github/workflows/ci.yml` runs `typecheck`, `test` and `build` on pull requests and on every branch push (tags don't trigger it).

The atlas deploys separately from hika-data: a push to its `main` publishes it with its own Pages workflow, after `check:atlas` (run from a checkout of this repo). An app release that reads a new atlas format must wait until that format is published.
