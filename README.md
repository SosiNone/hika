<div align="center">

# HIKA · Swiss trail console

**A sci-fi HUD for exploring Swiss hiking routes, built entirely on swisstopo open data.**

[![CI](https://github.com/SosiNone/hika/actions/workflows/ci.yml/badge.svg)](https://github.com/SosiNone/hika/actions/workflows/ci.yml)
[![Deploy](https://github.com/SosiNone/hika/actions/workflows/pages.yml/badge.svg)](https://github.com/SosiNone/hika/actions/workflows/pages.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Data: swisstopo](https://img.shields.io/badge/data-swisstopo%20OGD-c8102e.svg)](NOTICE.md)

### [▶ Open the live console](https://sosinone.github.io/hika/)

[![HIKA showing the Brülisau – Fählensee – Zwinglipass – Wildhaus hike in the Alpstein](docs/hero.webp)](https://sosinone.github.io/hika/#route=c-bruelisau-wildhaus)

</div>

HIKA covers two regions so far, the **Alpstein** (Säntis, Seealpsee, Hoher Kasten) and the
**Jungfrau** region (Eiger, Grindelwald, Lauterbrunnen). Each one is its signposted trail network
rendered as a 3D point cloud, every SchweizMobil route that crosses it, and a few classic hikes routed
on the trail graph. Pick a route and HIKA previews it with a hiker marker, signpost times and live
instruments.

## Features

- **Holographic terrain.** swissALTI3D elevation as a point cloud with depth-of-field and contour
  lines, an optional SWISSIMAGE overlay and adjustable vertical exaggeration.
- **The whole trail network.** Every Wanderweg, Bergwanderweg and Alpinwanderweg from swissTLM3D,
  drawn in the official signpost colours, with over 1 100 named summits, passes, inns, stops and
  lakes from swissNAMES3D. By default only the trails branching off the selected route show,
  fading out over 5 km along each branch; the TRAILS button switches the whole network on
  or off.
- **Two regions, 44 routes.** 36 SchweizMobil "Wanderland" stages, from the Via Alpina to the Eiger
  Trail, and 8 curated classics, such as Säntis – Lisengrat – Meglisalp and Mürren – Schilthorn. Switch
  region with the picker under the HIKA logo, or click a region's box on the Switzerland locator.
- **Route player.** A hiker walks the route at signpost pace, past each waypoint with its distance,
  altitude and expected time. The region's routes play like a playlist: previous / next, repeat,
  shuffle, and the next route starts when the hiker arrives (Space and ← / → work too).
- **Instruments.** Elevation profile, climb and descent per km, cumulative climb and descent, slope histogram,
  aspect rose, trail-class breakdown, a Switzerland locator and today's sunrise and sunset.
- **Real Swiss hiking times,** from a pace table digitised from the official Schweizer Wanderwege
  chart (see [Hiking time](#hiking-time)).
- **Shareable.** Every route has its own link, e.g.
  [`?region=jungfrau#route=sm-353.00`](https://sosinone.github.io/hika/?region=jungfrau#route=sm-353.00)
  for the Eiger Trail. Links without `?region=` open the Alpstein.
- **No backend.** The app reads a static data bundle and never calls geo.admin.ch at runtime.

### Controls

| Input | Action |
|---|---|
| Drag | Orbit |
| Right-drag | Pan |
| Wheel | Zoom |
| Click | Select route |
| Double-click | Reset camera |

## Dark and light

[![HIKA in the light scheme](docs/light.webp)](https://sosinone.github.io/hika/?scheme=light#route=sm-951.00)

HIKA has one look, paperlab: flat greys with a glacier-cyan accent, in a dark scheme (the default) and
a light one. The footer switches between them, a URL can set one with `?scheme=light`, and a choice
made in the footer is remembered in the browser.

## Quick start

Requires Node 24 and [Task](https://taskfile.dev/installation/).

```bash
git clone https://github.com/SosiNone/hika.git
cd hika
task dev
```

`task` lists every command. Each one wraps an npm script in `package.json`, so `npm run <script>`
works too.

The generated region bundles are committed under `public/data/<id>/`, so the app runs without
rebuilding data.

## How it works

A build-time pipeline in `scripts/` downloads swisstopo and geo.admin.ch data and writes a compact
bundle to `public/data/<id>/`. The browser app in `src/` only reads that bundle and renders it with
WebGL 2.

### Rebuild the data

```bash
task region REGION=alpstein
```

`task region:build` and `task region:check` run the two steps on their own, and `task regions:check`
validates every region.

`regions/<id>.json` defines a region: LV95 bbox, grid cell, default route, curated hikes (waypoint
names resolved through swissNAMES3D) and routes to exclude. The pipeline caches downloads in `.cache/`
(about 300 MB on first run, mostly the national trail and names datasets) and takes about 30 s
afterwards. Each build also refreshes `public/data/regions.json`, the list of regions the app offers,
so adding a region is a new `regions/<id>.json` plus `task region REGION=<id>`.

| Step | Source | Output |
|---|---|---|
| Terrain | swissALTI3D 2 m COGs via STAC, box-averaged from the 4 m overview | `terrain.u16` (decimetres, row 0 = north) |
| Colour | SWISSIMAGE WMTS, 10 m/px | `ortho.jpg` |
| Trails | swissTLM3D Wanderwege GeoPackage (class, surface) | `trails.bin` |
| Places | swissNAMES3D (summits, passes, inns, stops, lakes …) | `region.json` |
| Routes | SchweizMobil "Wanderland" layer (identify + find), chained and clipped | `region.json` |
| Classics | Dijkstra on the trail graph, weighted by Swiss hiking time | `region.json` |
| Heights | geo.admin.ch profile service (DTM2) every 10 m | `region.json` |
| Locator | profile-service rows over CH + swissBOUNDARIES3D | `switzerland.u16`, `region.json` |

[`docs/data-coverage.md`](docs/data-coverage.md) maps every piece of that data to where the app
shows it, and lists what is downloaded but dropped or not used yet.

### Hiking time

Times follow the Schweizer Wanderwege signpost method (4.2 km/h on the flat, slope-dependent pace).
Its polynomial coefficients are not published, so `src/geo/hikingTime.ts` carries a pace table
digitised from the official isochrone chart (ASTRA *Signalisation Wanderwege*, 2008, p. 66).
Signpost-style times are rounded to 5 minutes.

## Development

```bash
task check
```

This runs the type-checker and the unit tests (`task test` for the tests alone).
`.github/workflows/ci.yml` runs the type-checker, the tests, the region check and the build on
pull requests and on every branch push.

[AGENTS.md](AGENTS.md) describes the architecture in depth: the bundle format, the rendering
pipeline, theming and the pipeline details that were learned the hard way.

### Deploy

Releases are deployed, not every commit. `.github/workflows/pages.yml` builds and publishes to
GitHub Pages when a `v*` tag is pushed (it can also be run by hand from the Actions tab). The
tag must match the `version` in `package.json`. From `main`, run:

```bash
task release BUMP=patch
```

This runs the checks, then `npm version` (commit + `vX.Y.Z` tag) and `git push --follow-tags`.

Enable Pages → "GitHub Actions" in the repository settings, and allow `v*` tags under
Settings → Environments → `github-pages` → Deployment branches and tags.

## Credits

HIKA would not exist without two sci-fi console projects:

- **[beastydesign · Diagonale des Fous](https://beastydesign.github.io/scifi/)**: the original race
  console for La Réunion. Its point-cloud terrain, instrument panels and overall visual language are
  what this project set out to recreate for Switzerland. Its code is all rights reserved, so HIKA is
  an independent re-implementation and copies none of its code or assets.
- **[LosEcher · hud-console-framework](https://github.com/LosEcher/hud-console-framework)** (MIT):
  an open re-creation of that style with design tokens, a single accent colour and corner-bracket
  panels, which showed how to structure the look as reusable tokens. HIKA's paperlab greys
  are ported from it.

## Licence

The code is released under the [MIT licence](LICENSE).

The bundled data in `public/data/` and the screenshots in `docs/` are not covered by it. Geodata
© swisstopo, free to use with attribution (opendata.swiss terms "BY"). Routes © SchweizMobil / ASTRA.
See [NOTICE.md](NOTICE.md).
