# Map expansion — task plan

Execution plan derived from `docs/plans/2026-08-09-map-expansion.md`. That
document holds the reasoning; this one holds the work. Each task below is one
implementer dispatch.

---

## Global Constraints

These bind every task. A reviewer checks them on every diff.

**Repository shape**

- Backend: Python 3, FastAPI, asyncio. `backend/app.py` is the API,
  `backend/storage.py` is Postgres, `backend/sources/*.py` are collectors,
  `backend/ingest/` and `backend/refine/` are separate processes.
- Frontend: React 18 + Vite, Leaflet 1.9.4 from CDN (`window.L`, re-exported by
  `frontend/src/map/leafletGlobal.js`), PixiJS via npm for the WebGL entity
  layer. No TypeScript. No CSS framework — one hand-written
  `frontend/src/style.css`.
- Postgres 16, **no PostGIS**. Do not add a geometry column, a `ST_*` call, or
  a `CREATE EXTENSION`. Spatial work is plain columns plus Python, matching
  `backend/regions.py` and `backend/proximity.py`.

**Tests**

- Every backend module gets `backend/tests/test_<module>.py`, following the
  existing style: fixtures are recorded upstream payloads, no live network.
- Frontend logic that can be tested headlessly goes in `frontend/tests/*.test.js`
  using `node --test`, matching e.g. `frontend/tests/shapeIndex.test.js`.
- Run backend tests with:
  `"C:/Users/theis/Desktop/Claude Workspace/OSINT/.venv/Scripts/python.exe" -m pytest backend/tests -q`
- Run frontend tests with: `cd frontend && node --test`
- Both suites must be green before a task is reported DONE. Baseline at the
  start of this plan: backend 1200 passed / 3 skipped, frontend 212 passed.

**Provenance and honesty — non-negotiable**

This project's rule is that every pin says what kind of evidence it is. Follow
it exactly:

- Any value we did not receive from a source is **inferred**. Records carrying
  inferred values set `inferred: true` in the payload, and the popup or card
  states the inference and its inputs in plain words.
- Use exactly four words for provenance, consistently: **measured** (an
  instrument reported it), **reported** (a human or organisation stated it),
  **derived** (arithmetic over measured/reported values), **inferred** (a
  judgement from indirect evidence).
- Never present an inference as an observation. Never invent a number that a
  source did not supply. If coverage is partial, say what fraction is covered.
- Every new card section ends with, or contains, its provenance line: source,
  publisher, licence, collection time, and which of the four words applies.

**Performance**

- `entity_history` is roughly 11 GB and grows with global AIS. **No new code may
  query `entity_history` on an HTTP request path.** Derived products are
  computed on a schedule by a refine job and written to their own compact
  table, which the endpoint reads.
- New endpoints go through `_cached_source_response` (`backend/app.py:311`) so
  they inherit ETag and cache-control behaviour, unless they are per-entity
  detail routes, which follow `/api/track/{kind}/{id}` (`backend/app.py:743`).

**Writing style**

- Match the surrounding code: comments explain *why*, in full sentences, and are
  frequent in this codebase. Do not strip existing comments.
- Commit messages: imperative, lower-case after the first word, no `feat:`
  prefixes, and they describe the change in plain language the way the existing
  history does (`git log --oneline` for the house style). End every commit
  message with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- Do not reformat untouched code. Do not rename existing symbols unless the task
  says to.

**Adding a map layer** — the ten touch points, derived from the `railways` and
`deflock` layers. Any task that adds a layer does all of these:

1. `frontend/src/map/scene.js:208` — `LAYER_MANIFEST` entry (draw band, fetch
   band, cap, collapse, disposition; `scoped: true` only if the endpoint takes
   `bbox`).
2. `frontend/src/hooks/useOsintData.js:34` — a `POLL_CONFIG` row, or a one-shot
   boot fetch like railways at `:546`.
3. `frontend/src/map/layers.js` — a factory returning the Leaflet container.
4. `frontend/src/map/svgIcons.js` — the glyph, plus `GLYPH_CHOICES` if pickable.
5. `frontend/src/map/decorators.js` — style plus `decorateX(d, opts)` returning
   `{icon, tooltip, detail, title}`.
6. `frontend/src/map/iconTheme.js` — token in `PALETTE_GROUPS:27`,
   `TOKEN_LAYER:236`, a `PIN_STACK:331` or `WASH_STACK:337` position,
   `STACK_ALIAS:348` if it rides another key.
7. `frontend/src/map/createMapController.js` — group construction `:486`,
   `layerForKey:1840`; point layers also need `ID_FIELD:218`, `DECORATORS:229`,
   `ICON_SIZE_FOR_GLYPH:242`; line layers need a `renderX()` plus dispatch in
   `applyData:5156` and `renderAllLayers:4695`; `counts:2388` / `totals:2410`;
   `COUNT_KEYS` in `frontend/src/map/useLeafletMap.js:9`.
8. `frontend/src/settings/defaults.js:37` — a `SETTINGS_LAYERS` row.
9. `frontend/src/components/controlPanel/LayersSection.jsx:86` — `GROUP_LAYERS`
   entry plus a `LayerCheck` row.
10. `frontend/src/components/admin/sections/shared.jsx:18` — `STACK_LABEL` if
    the stack key differs from the settings key.

**Adding a collector** — follow `backend/sources/railways.py` for a reference
document and `backend/sources/deflock.py` for a point layer. Register in
`_SOURCE_MODULES` (`backend/app.py:61`) for backend-polled sources, or the job
table in `backend/ingest/__init__.py:97` / `backend/refine/__init__.py:58`.
Add poll cadence and any `ENTITY_STALE_AFTER` window to `backend/config.py`.

---

## Task 1: Schema for the three derived tables

Add the three tables the derived products need, plus their storage helpers. No
consumer yet — this task exists so later tasks land on a settled schema.

**File:** `backend/storage.py`

Add to the `_SCHEMA` string (`backend/storage.py:73-234`), in the same style as
the tables already there — a comment above each explaining what it is for and
why it is shaped that way.

```sql
CREATE TABLE IF NOT EXISTS lane_cells (
  cell_key    TEXT PRIMARY KEY,
  lat         DOUBLE PRECISION NOT NULL,
  lon         DOUBLE PRECISION NOT NULL,
  res         DOUBLE PRECISION NOT NULL,
  transits    INTEGER NOT NULL,
  positions   INTEGER NOT NULL,
  by_class    JSONB NOT NULL,
  mean_sin    DOUBLE PRECISION NOT NULL,
  mean_cos    DOUBLE PRECISION NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lane_cells_bbox ON lane_cells (lat, lon);
CREATE INDEX IF NOT EXISTS idx_lane_cells_updated ON lane_cells (updated_at);

CREATE TABLE IF NOT EXISTS vessel_port_calls (
  mmsi        TEXT NOT NULL,
  port_id     TEXT NOT NULL,
  arrived_at  TIMESTAMPTZ NOT NULL,
  departed_at TIMESTAMPTZ,
  draught_in  DOUBLE PRECISION,
  draught_out DOUBLE PRECISION,
  confidence  TEXT NOT NULL,
  PRIMARY KEY (mmsi, port_id, arrived_at)
);
CREATE INDEX IF NOT EXISTS idx_port_calls_mmsi ON vessel_port_calls (mmsi, arrived_at DESC);
CREATE INDEX IF NOT EXISTS idx_port_calls_port ON vessel_port_calls (port_id, arrived_at DESC);

CREATE TABLE IF NOT EXISTS flight_legs (
  icao24       TEXT NOT NULL,
  departed_at  TIMESTAMPTZ NOT NULL,
  arrived_at   TIMESTAMPTZ,
  origin_code  TEXT,
  dest_code    TEXT,
  callsign     TEXT,
  max_alt_ft   INTEGER,
  distance_km  DOUBLE PRECISION,
  confidence   TEXT NOT NULL,
  PRIMARY KEY (icao24, departed_at)
);
CREATE INDEX IF NOT EXISTS idx_flight_legs_icao ON flight_legs (icao24, departed_at DESC);
```

`mean_sin` / `mean_cos` rather than a mean course, because courses are angles
and averaging degrees across 0/360 gives nonsense. Store the summed unit vector
and let the reader take `atan2`.

**Storage helpers** — add beside the existing helpers, each with the same
docstring habits:

- `async def upsert_lane_cells(rows: list[dict]) -> None` — batched upsert on
  `cell_key`, adding `transits`/`positions`/`mean_sin`/`mean_cos` to the stored
  values and merging `by_class` key-wise. Batch at `_BATCH` (`storage.py:58`).
- `async def lane_cells(bbox: tuple | None, min_transits: int = 1) -> list[dict]`
  — read back, bbox-filtered on the plain lat/lon columns.
- `async def decay_lane_cells(factor: float, floor: int) -> int` — multiply
  every counter by `factor`, delete rows whose `transits` falls below `floor`.
  Returns rows deleted.
- `async def record_port_calls(rows: list[dict]) -> None` — upsert; a row with a
  `departed_at` overwrites the open row with the same `(mmsi, port_id,
  arrived_at)`.
- `async def port_calls_for(mmsi: str, limit: int = 20) -> list[dict]`
- `async def port_calls_at(port_id: str, limit: int = 50) -> list[dict]`
- `async def open_port_call(mmsi: str) -> dict | None` — the most recent call
  with `departed_at IS NULL`.
- `async def record_flight_legs(rows: list[dict]) -> None`
- `async def flight_legs_for(icao24: str, limit: int = 20) -> list[dict]`
- `async def open_flight_leg(icao24: str) -> dict | None`

**Retention** — extend the retention loop (`backend/storage.py:1286-1320`) with:
`vessel_port_calls` older than `PORT_CALL_RETENTION_DAYS` (new in
`backend/config.py`, default 180), `flight_legs` older than
`FLIGHT_LEG_RETENTION_DAYS` (default 90). `lane_cells` is not time-pruned here;
its decay is the pruning and belongs to its own job.

**Config** — add `PORT_CALL_RETENTION_DAYS` and `FLIGHT_LEG_RETENTION_DAYS` to
`backend/config.py` beside the other retention settings, with comments saying
why those numbers.

**Tests** — extend `backend/tests/test_storage_schema.py` with the three new
tables and their indexes. Add `backend/tests/test_derived_tables.py` covering:
lane cell upsert accumulation (two upserts of the same cell sum, `by_class`
merges key-wise), the circular-mean round trip through `mean_sin`/`mean_cos`,
decay below the floor deleting the row, port-call open-then-close, and
`flight_legs_for` ordering. Use whatever fake/in-memory Postgres the existing
storage tests use — read `backend/tests/conftest.py` first and match it.

**Verify:** backend suite green.

---

## Task 2: Extract PlaceInfoCard from CountryInfoCard

Three later tasks need a card that is not about a country. Generalise the one
that exists, with no behaviour change to the country card.

**Read first:** `frontend/src/components/CountryInfoCard.jsx` (137 lines),
`frontend/src/hooks/useDraggablePanel.js`, and how `App.jsx:555-737` mounts it.

**Do:**

1. New `frontend/src/components/PlaceInfoCard.jsx` holding everything currently
   in `CountryInfoCard` that is not country-specific: the drag/anchor behaviour
   (anchor to a live screen point until dragged, then detach), the
   `<details>` accordion with persisted open state, the delegated row-click
   handler that reads `data-event-kind` / `data-event-id`, the close button, and
   Escape handling.

   Props: `{ place, onClose, onOpenRecord, accordionKey, defaultOpen, footer,
   headerExtra }` where `place` is
   `{ id, title, subtitle, point, sections: [{id, title, html}] }`.

2. `CountryInfoCard.jsx` becomes a thin wrapper: it maps the existing `country`
   prop onto `place`, passes `accordionKey="osint-country-card-accordion"` and
   `defaultOpen={{profile: true, conflict: true}}`, and supplies the border-edit
   button through `headerExtra`. Its external props and behaviour do not change.

3. Do not change `frontend/src/map/popups.js` in this task.

**Tests:** add `frontend/tests/placeInfoCard.test.js` covering the pure parts
you can reach without a DOM — if the accordion default/merge logic or the
section-drop rule is extractable into a small exported helper, extract it and
test it. Do not fake a DOM; if nothing is headlessly testable, say so in the
report rather than writing a test that asserts nothing.

**Verify:** frontend suite green; the country card still renders and drags
identically (state the manual check you did in the report).

---

## Task 3: Split AdminPanel into per-section files

`frontend/src/components/admin/AdminPanel.jsx` is 821 lines and this plan roughly
doubles it. Split first, add later. **Behaviour must not change.**

**Do:**

1. Create `frontend/src/components/admin/sections/` and move each `PanelGroup`
   into its own file, one export per file: `IconsSection.jsx`, `StackSection.jsx`,
   `LayersSection.jsx` (the admin one — name it `LayerDialsSection.jsx` to avoid
   colliding with the control-panel `LayersSection`), `CityZonesSection.jsx`,
   `DataSection.jsx`, `BordersSection.jsx`, `InterfaceSection.jsx`,
   `ConfigSection.jsx`.
2. Shared helpers used by more than one section (`STACK_LABEL`, `ADOPTED_BY`,
   `EXTRA_TOKENS_UNDER`, `perPinDials`, `glyphChoicesFor`, the small field
   components `IconField` / `SharedColours` / `PinTypesNote` / `SyncBadge`) move
   to `frontend/src/components/admin/sections/shared.jsx`.
3. `AdminPanel.jsx` keeps: the accordion state, the section ordering, the
   panel-level buttons, and the composition. Target under 200 lines.
4. Add a search box in the admin panel header that filters visible sections by
   matching section title and control label, case-insensitive. Sections with no
   match are hidden while the box is non-empty. Clearing restores everything.
   Keep it simple — a `matchesQuery(label, query)` helper and a wrapper that
   hides non-matching rows.

**Tests:** `frontend/tests/adminSearch.test.js` for `matchesQuery` — exact,
substring, case-insensitive, empty query matches everything, whitespace-only
query matches everything.

**Verify:** frontend suite green. Every admin control that existed before still
exists and still writes the same settings key. List the eight sections and
confirm each in the report.

---

## Task 4: Water bodies collector

**New file:** `backend/sources/water_bodies.py`. Model it on
`backend/sources/railways.py` (reference-document collector, slow refresh,
theatre-aware) and `backend/sources/admin1_boundaries.py` (GeoJSON thinning).

**Upstream** — the same nvkelso Natural Earth GeoJSON mirror `railways.py`
already uses. Three datasets:

| Snapshot name | Dataset | What it gives |
|---|---|---|
| `water_marine` | `ne_10m_geography_marine_polys` | named seas, gulfs, bays, straits, channels — `name`, `featurecla`, `scalerank` |
| `water_lakes` | `ne_10m_lakes` | named lakes — `name`, `admin`, `scalerank` |
| `water_rivers` | `ne_10m_rivers_lake_centerlines` | river centrelines — `name`, `featurecla`, `scalerank` |

**Do:**

- Fetch each, parse to a FeatureCollection, thin coordinates with the same
  helper `admin1_boundaries.py` uses, and store one `reference_snapshots` row
  per dataset.
- Natural Earth marine polys have no stable id. Synthesise
  `id = "marine:{scalerank}:{slug(name)}"`, and where `name` is missing use the
  `featurecla` plus a running index; slug is lowercase, non-alphanumerics
  collapsed to `-`. Same shape for lakes (`lake:`) and rivers (`river:`).
- Compute and store, per marine feature: `bbox` as `[south, west, north, east]`
  and `area_deg2` (shoelace on the outer ring, in square degrees — this is for
  ranking overlapping polygons, not for display; name it so that is obvious and
  say in a comment that it is not an area in km²).
- Store `class` normalised from `featurecla` to one of: `ocean`, `sea`, `gulf`,
  `bay`, `strait`, `channel`, `sound`, `lake`, `river`, `other`.
- Refresh cadence 7 days, following `railways.py`. Add
  `WATER_POLL_INTERVAL` to `backend/config.py` (default `7 * 86400`).
- Register in `_SOURCE_MODULES` (`backend/app.py:61`).
- Attribution: Natural Earth, public domain (CC0). Carry `attribution`,
  `publisher` and `provenance` in the snapshot the way `railways.py` does,
  including the 1:10m scale caveat.

**Tests:** `backend/tests/test_water_bodies.py` — parsing a recorded fixture
(hand-write a small FeatureCollection; do not download in the test), id
synthesis including the missing-name path, id stability across two runs, class
normalisation of every `featurecla` value you map, bbox and `area_deg2`
correctness on a known square, and coordinate thinning preserving ring closure.

**Verify:** backend suite green.

---

## Task 5: Water endpoint

**File:** `backend/app.py`

Add `GET /api/water` with query params `kind` (one of `marine`, `lakes`,
`rivers`; default `marine`) and optional `bbox`. Serve through
`_cached_source_response` with `max_age=86400`, following `/api/cables`
(`backend/app.py:652`) and `/api/railways` (`:662`).

Bbox filtering uses each feature's stored `bbox` — a cheap rectangle overlap
test, no polygon maths. Reject an unknown `kind` with 400 and a message naming
the three valid values, matching how `/api/district-boundaries`
(`backend/app.py:418`) rejects a bad country code.

**Tests:** extend `backend/tests` with `test_water_endpoint.py` — the three
kinds, the 400 path, bbox filtering including a feature that straddles the
antimeridian (state in the test what the expected behaviour is and why).

**Verify:** backend suite green.

---

## Task 6: Water layer on the map

Make water a drawn, hoverable, clickable layer. This is the first polygon layer
that is not an administrative boundary.

**Read first:** `frontend/src/map/subdivisions.js` (the closest existing
pattern), `frontend/src/map/countryHitTest.js` (especially the comment at
`:1-23` explaining why polygons are `interactive: false`), and
`frontend/src/map/layers.js:347` for the countries layer.

**Do:**

1. New pane `waterPane` at z-index **345**, created beside the others in
   `frontend/src/map/layers.js`. Below `countriesPane` (350) so land outlines
   still win.
2. New `frontend/src/map/water.js`: `createWaterLayer()` returning
   `L.geoJSON(null, { pane: "waterPane", interactive: false })` with
   `fillOpacity: 0` by default, plus `syncWater(layer, features)` and a
   `waterPopupHtml` for the tooltip. Hover and selection are CSS classes
   (`.water-hovered`, `.water-selected`) toggled on `layer.getElement()`, exactly
   as `subdivisions.js` does — never a re-style.
3. Hit testing: build a second index with the existing `buildShapeIndex`
   (`frontend/src/map/countryHitTest.js:150`) over water features, and add
   `findWaterAt(index, lat, lon)` that returns the **smallest** `area_deg2`
   containing feature, because marine polygons nest (the Mediterranean contains
   the Aegean).
4. Wire into the click chain in `frontend/src/map/createMapController.js:4895`
   between the drill-down step (`:4924`) and country selection (`:4951`): if
   `findCountryAt` returns null and a water feature contains the point, select
   the water body. Selecting the already-selected one deselects. Hover follows
   the same rAF-throttled path as countries (`:5005`).
5. `viewportProfile.js`: when the water index is loaded, decide `isMaritime`
   from it directly instead of from absence-of-land. Keep the sampling fallback
   for when it is not loaded — do not delete it.
6. All ten layer touch points from the Global Constraints, layer key `water`,
   settings row, control-panel row under a sensible group, colour tokens for
   fill, outline, and selected fill.
7. Fetch: one-shot boot fetch like railways (`useOsintData.js:546`), `marine`
   only for now; lakes and rivers ride the same layer key behind sub-toggles
   that default off.

**Tests:** `frontend/tests/waterHitTest.test.js` — smallest-containing-polygon
selection with two nested squares, a point in neither, a point on a shared edge
(state the tie-break and test it), and antimeridian handling consistent with
Task 5.

**Verify:** frontend suite green. Report what you saw when you clicked a sea.

---

## Task 7: Water body card

**Read first:** `frontend/src/map/popups.js:648` (`countryCardSections`) — this
task writes its sibling, and the shape must match exactly so `PlaceInfoCard`
renders both.

**Do:** add `waterCardSections(feature, raw, bounds)` to
`frontend/src/map/popups.js`, returning the same `[{id, title, html}]` array,
dropping empty sections the way `countryCardSections` does at `:720`. Sections:

| id | Title | Content |
|---|---|---|
| `profile` | Water body | name, class, bordering countries (compute from country polygons whose bbox overlaps this feature's bbox and which contain a point on its boundary), the 1:10m Natural Earth caveat |
| `traffic` | Traffic now | vessels inside the polygon by class (tanker / cargo / navy / fishing / other from `ship_type`), each with a count; total; and the AIS coverage caveat verbatim from `decorators.js:1779` |
| `dark` | Dark activity | AIS gaps and STS pairs inside, from `raw.darkVessels` and `raw.gfwGaps`, with counts and the most recent three |
| `chokepoint` | Chokepoint watch | whether this body overlaps a watched-waters box, and what that means for the dark-vessel layer |
| `infrastructure` | Infrastructure | cable routes crossing, landing points and ports on its shores |
| `incidents` | Incidents | conflict and news events inside the polygon in the active window |
| `sources` | Sources & caveats | provenance line for every source used above, plus "empty water on this layer is not evidence of empty water" |

Wire selection from Task 6 to render this through `PlaceInfoCard` in `App.jsx`,
alongside the country card, with its own accordion key.

**Tests:** whatever section builders you can export and test headlessly —
the class-counting and the point-in-bbox country matcher at minimum, in
`frontend/tests/waterCard.test.js`.

**Verify:** frontend suite green.

---

## Task 8: Country card — surface what is already stored

Six fields are collected and never displayed. Show them, in the sections that
already exist. **No new sections in this task.**

**File:** `frontend/src/map/popups.js`

| Field | Stored at | Section | How to show it |
|---|---|---|---|
| `returned_refugees` | `humanitarian.py:97` | `humanitarian` (`popups.js:353`) | a row beside the other UNHCR figures |
| `others_of_concern` | `humanitarian.py:99` | `humanitarian` | same |
| `admin_level` on `food_security` and `idps` | `humanitarian.py:140,172` | `humanitarian` | a precision caveat — "reported at admin level N", which is what it is |
| `net_series` | `energy_flows.py:239` | `power` (`popups.js:496`) | a 24-hour sparkline using the existing `buildSparkline` at `popups.py:255`; label the axis and say the unit |
| `available_from`, `interval_minutes` | `energy_flows.py:228,234` | `power` | a coverage line: what period the publisher offers and at what resolution |
| `window_start`, `window_end` | `outages.py:76` | `connectivity` (`popups.js:461`) | say what window the score covers, in the reader's terms ("last 24 hours, to 14:00 UTC") |

Every added row carries its provenance word (all of these are **reported** by
their publisher except the sparkline, which is **measured** for physical flow
and **reported** for commercial — the payload already distinguishes them).

**Tests:** extend or add `frontend/tests/countryCard.test.js` for the sparkline
builder over `net_series` (empty series, one point, a full day) and the window
formatter.

**Verify:** frontend suite green.

---

## Task 9: Country card — four new sections

**File:** `frontend/src/map/popups.js`, following the existing `buildX(...)`
convention.

1. **`energy` — Energy** (expand the existing `power` section, or add beside it
   and rename; your call, state which in the report). Adds: power plants inside
   the country from `raw.osmInfra` where `kind === "power_plant"` — count, total
   `output_mw` where tagged, breakdown by `source_tag`; dams from `raw.dams` —
   count, total `power_mw`, total `capacity_mcm`; cable landings on its coast.
   **Required caveat:** OSM tagging is incomplete and `output_mw` is present on a
   minority of plants — state the tagged fraction explicitly and do not present
   the sum as national capacity.
2. **`military` — Military & security.** Military airfields and areas from
   `raw.osmInfra`, curated bases from `raw.infra`, military aircraft currently
   in or near the country from `raw.adsb` (`military` or `military_role`), navy
   vessels from `raw.ais`, sanctioned hulls and tails associated with this
   flag. Each with the bbox caveat the `live` section already carries.
3. **`transport` — Transport.** Airports by size class from `raw.airports`,
   ports by `harbor_size_label` with `oil_terminal` called out, border-control
   crossings from `raw.osmInfra`, rail stations from `raw.osmInfra`.
4. **`coverage` — Data coverage.** For each feed the card used: when it last
   delivered anything inside this country's bbox, or "no coverage here". This
   is the honesty section; it is always present, never dropped when empty, and
   it goes last.

Register all four in the section order and in the accordion defaults (closed).

**Tests:** `frontend/tests/countryCardSections.test.js` — the tagged-fraction
arithmetic including the all-untagged case, the size-class bucketing, and the
coverage section's "no coverage" path.

**Verify:** frontend suite green.

---

## Task 10: Country card — summary strip and super-folds

The card now has sixteen sections. Make it readable.

**Files:** `frontend/src/map/popups.js`, `frontend/src/components/PlaceInfoCard.jsx`,
`frontend/src/style.css`.

1. **Summary strip**: a row of compact stat tiles above the folds — population,
   events 72 h, fatalities 72 h, connectivity score, refugees, net power,
   military aircraft. A tile whose value is unavailable renders as a dash with a
   tooltip saying why, never as zero. Tiles are built by a new
   `summaryTiles(props, raw, bounds)` in `popups.js` and passed to
   `PlaceInfoCard` as a new optional `summary` prop.
2. **Super-folds**: group sections into *Situation* (conflict, live, events,
   verified, trend), *Country* (profile, humanitarian, food, energy, transport,
   military), *Meta* (sanctions, sources, coverage). `PlaceInfoCard` gains an
   optional `groups: [{id, title, sectionIds}]` prop; without it, it renders a
   flat list exactly as now, so the water card is unaffected.
3. Persist super-fold open state in the same accordion key, under a namespaced
   prefix so it cannot collide with section ids.
4. Style the strip in `style.css` alongside the existing card styles. It must
   read in both themes and must not scroll horizontally — wrap.

**Tests:** `frontend/tests/summaryTiles.test.js` — the unavailable-value dash
path for each tile, and the grouping helper's behaviour when a section id
appears in no group (it must still render, at the end, not vanish).

**Verify:** frontend suite green.

---

## Task 11: District and state cards

Both admin-1 and admin-2 currently get a thin Leaflet popup. Give them real
cards through `PlaceInfoCard`.

**Read first:** `frontend/src/map/subdivisions.js:119`
(`subdivisionPopupHtml`), `frontend/src/map/districts.js:173`
(`districtPopupHtml`, including its month `<select>` at `:150` and the wiring at
`createMapController.js:4024`).

**Do:** add `subdivisionCardSections(props, raw, bounds)` and
`districtCardSections(props, raw, bounds, month)` to `popups.js`, same shape as
the others. Clipping is point-in-polygon against the already-loaded boundary
geometry via `buildShapeIndex` — **no new endpoint, no new fetch**.

| Section | Admin-1 | Admin-2 |
|---|---|---|
| profile | name, ISO 3166-2 code, postal, type, parent country | pcode, name, parent admin1, country |
| conflict | events and fatalities in polygon over the active window, top event types, most severe | the four existing `DISTRICT_METRICS` plus a 24-month trend sparkline from `hapi_conflict` |
| cities | cities inside, largest by population, capital flag | same |
| live | aircraft, ships, fires, jamming cells inside | same |
| infrastructure | power plants, dams, airfields, ports, rail stations, border crossings inside | same |
| coverage | which admin-2 sets exist at all (six countries), the NE 1:10m caveat, "no record is not a reported zero" verbatim | same |

Keep the month `<select>` and have it drive the district sparkline too. Replace
the Leaflet popups with the cards; the map click behaviour that selects them
does not change.

**Tests:** `frontend/tests/districtCard.test.js` — polygon clipping counts
against a hand-built geometry, the month selector's effect on the metrics, and
the empty-district path.

**Verify:** frontend suite green.

---

## Task 12: IntelPanel — one panel, four tabs

Replace two panels with one. `ConflictBriefingCard` stays as it is.

**Read first:** `frontend/src/components/NotableEventsPanel.jsx` (249 lines),
`frontend/src/components/NewsBroadcastPanel.jsx` (144 lines), and how `App.jsx`
mounts both.

**Do:** new `frontend/src/components/IntelPanel.jsx` with four tabs:

| Tab | Rows | Sort |
|---|---|---|
| Escalation | the existing escalation rows, plus a 7-day mini-bar per region | ratio desc |
| Events | fused `events` — severity chip, headline, place, fatalities, corroboration badge, reliability band | existing `rankScore` (severity decayed by age) |
| News | GDELT rows with `real_title` — outlet badge, outlet count, time | recency |
| Officials | the `officials` kind, which today has an endpoint and no panel at all — CAMEO label, actors, outlet, time | recency |

Header controls, applied to every tab:

- **Scope**: World / viewport / selected country / selected region / selected
  water body (Task 6).
- **Window**: 6 h / 24 h / 72 h / 7 d.
- **Minimum severity** and **verification floor** — move these out of
  `ControlPanel` so they are reachable outside admin mode. The admin panel keeps
  a pointer to where they now live.
- **Group by**: none / country / event type / actor / outlet.

Preserve the behaviours worth keeping: the severity floor of 40 world / 0 when
a country is scoped, the "renders nothing when nothing qualifies and nothing is
scoped" rule, the self-ticking "updated Ns ago", auto-opening on a new country
selection, and the locate buttons.

Delete `NotableEventsPanel.jsx` and `NewsBroadcastPanel.jsx` once nothing
imports them. Migrate their persisted panel-position keys so a user's existing
placement is not lost — or, if that is not cleanly possible, say so in the
report and pick a sensible default.

**Tests:** `frontend/tests/intelPanel.test.js` — the scope filter for each of
the five scopes, the group-by bucketing, and the "nothing qualifies" rule.

**Verify:** frontend suite green.

---

## Task 13: Event detail card

**File:** `frontend/src/components/EventDetailCard.jsx` plus the detail builder.

Today this renders the decorator's `detail` string. Fused events carry far more
than that string shows, all of it already stored. Build a real card for
`kind === "events"`; other kinds keep the current behaviour.

Blocks:

- **Header** — headline, CAMEO sentence, event family, date and time, and the
  reporting lag (`date_added` minus `date`).
- **Corroboration** — `corroborated_by` (which datasets agree), `outlet_count`,
  `verified_outlets`, and the `coverage[]` list of up to eight headlines with
  links.
- **Reliability** — `reliability` score, `reliability_band`, and every entry of
  `reliability_reasons[]` rendered in plain language.
- **Geolocation** — `geo_verdict`, `geo_confidence`, `geo_radius_km`,
  `geo_text_place`; and when the point was moved, `original_lat`/`original_lon`
  with an explicit "moved from" line saying why.
- **Nearby** — infrastructure within the event's own uncertainty radius: dams,
  power plants, cable landings, airfields, ports. Use the existing
  `uncertaintyRadiusMetres` (`frontend/src/map/severity.js:169`) as the radius.
- **Actions** — locate, open source URL.

Every block states its provenance word.

**Tests:** `frontend/tests/eventDetail.test.js` — the reporting-lag formatter
(including a negative lag, which happens), the "moved from" path, and the
nearby-infrastructure radius filter.

**Verify:** frontend suite green.

---

## Task 14: Ship card depth

**File:** `frontend/src/map/decorators.js` (`decorateAis`).

Show what AIS already gives us and we currently discard.

Sections in the popup detail:

- **Identity** — name, MMSI, IMO, callsign, **flag from the MMSI MID** (add a
  `frontend/src/utils/mmsi.js` with the ITU MID→country table and
  `flagForMmsi(mmsi)`), dimensions from `length_m` × `beam_m` (both stored,
  neither ever read — `ais.py:185,187`), ship type with its AIS type code shown
  alongside the label.
- **Voyage** — `destination` **as typed by the crew**, flagged unverified;
  `eta` rendered from its `{month, day, hour, minute}` dict with an explicit
  note that AIS ETA carries no year and is crew-entered; `nav_status`, speed,
  course, heading.
- **Flags** — OFAC `sanctions`, OpenSanctions `watchlist`, and the GFW prior
  disabling count where present.

Do not add cargo or laden state in this task — that is Task 16.

**Tests:** `frontend/tests/mmsi.test.js` — MID lookup for a spread of prefixes,
an unallocated MID, a malformed MMSI, and the 8-digit and 9-digit forms.
`frontend/tests/aisEta.test.js` — the ETA renderer including the
month-13/day-0 "not available" encoding AIS actually uses.

**Verify:** frontend suite green.

---

## Task 15: Vessel port-call detector

**New file:** `backend/refine/port_calls.py`, run from the refine process
(`backend/refine/__init__.py:58`).

A port call is: speed ≤ 0.5 kn for ≥ 1 hour, within N km of an indexed port.
The machinery is the inverse of the STS-pair port exclusion already written in
`backend/sources/dark_vessels.py:328` — read that first and reuse its port index.

**Do:**

- Read AIS positions from `entity_history` **incrementally** — track a
  high-water mark in `reference_snapshots` (name `port_calls_cursor`) so each
  run reads only what arrived since the last one. This job may read
  `entity_history`; it runs on a schedule, never on a request.
- Open a call when the dwell condition is first met; record `draught_in` from
  the last position before arrival. Close it when the vessel moves away and
  exceeds 1.0 kn for 30 minutes; record `draught_out` and `departed_at`.
- `confidence`: `exact` when the vessel was inside the port's own radius,
  `proximity` when within the wider radius, `inferred` when the dwell was
  detected but the nearest port is beyond the proximity radius (in which case
  `port_id` is the nearest port and the card must say so).
- Guard the obvious false positive: a vessel anchored offshore in a designated
  anchorage is not alongside. You cannot distinguish these from AIS alone — so
  do not claim to. Record the distance to the port and let the card state it.
- Cadence `PORT_CALL_INTERVAL` in `backend/config.py`, default 900 s.
- Write `source_health` rows so the job appears in the health panel.

**Tests:** `backend/tests/test_port_calls.py` — dwell detection at the
boundaries (exactly 1 hour, 59 minutes), the departure rule, re-entry within the
same hour not creating a second call, the cursor advancing and not
re-processing, and each of the three confidence values.

**Verify:** backend suite green.

---

## Task 16: Vessel profile — cargo class and laden state

**New file:** `backend/refine/vessel_profile.py`, run from the refine process.

**This is an inference. It must be labelled as one everywhere it appears.**

- **Cargo class** from the AIS `ship_type` code, via the ITU/IMO type table:
  tanker (crude / product / chemical / LNG / LPG), cargo (bulk / container /
  general / vehicle / reefer), fishing, passenger, tug, naval, other. This part
  is deterministic — provenance word **derived**, and cite the type-code table
  in a comment.
- **Laden vs ballast** from the draught series in `entity_history`: compare the
  current `draught` against the hull's observed max and min over the retained
  window. Above 85 % of observed max → `laden`; below 55 % → `ballast`; between
  → `unknown`. Fewer than 5 distinct draught samples → `unknown` with reason
  `insufficient_samples`. Provenance word **inferred**. Carry
  `draught_max_seen`, `draught_min_seen`, `sample_count`, and the two thresholds
  in the record so the card can show the working.
- **Implied trade** — last port call's country/region (from Task 15) plus the
  current `destination` string, expressed as a sentence with every input
  visible. Never assert a commodity.
- Store as `reference_snapshots` name `vessel_profiles`, keyed by MMSI, capped
  at the most recently seen 20 000 hulls with the cap stated in a comment.
- Thresholds live in `backend/config.py` as named constants, because Task 33
  exposes them in the admin panel.

**Tests:** `backend/tests/test_vessel_profile.py` — every type-code branch
including unmapped codes, the three laden verdicts at their exact boundaries,
the insufficient-samples path, and that no commodity string is ever emitted.

**Verify:** backend suite green.

---

## Task 17: Vessel detail endpoint and card wiring

**Files:** `backend/app.py`, `frontend/src/map/createMapController.js`,
`frontend/src/map/decorators.js`, `frontend/src/api.js`.

- `GET /api/vessel/{mmsi}` → `{identity, profile, port_calls, open_call}`.
  Reads `vessel_profiles`, `vessel_port_calls` and `entity_latest` — never
  `entity_history`. Follow the per-entity route style of
  `/api/track/{kind}/{id}` (`backend/app.py:743`), including its 404 shape.
- Frontend: on ship select (`createMapController.js:2064`), fetch this alongside
  the existing `/api/track/ais/{mmsi}` call and fill two new popup sections —
  **Cargo (inferred)** and **Port calls**, the latter a table of the last ten
  with date, port, country, dwell, draught in/out, and confidence.
- The cargo section opens with the sentence: AIS does not broadcast cargo; what
  follows is inferred from vessel class, draught and port calls. Show the
  thresholds and the sample count.
- Loading and failure states: the popup must render its other sections while
  this is in flight, and must say "unavailable" rather than silently omitting
  if the fetch fails.

Also: give **port cards** (`decoratePort`, `decorators.js:1763`) a "recent
arrivals and departures" section from `port_calls_at`, via a `port_id` variant
of the same endpoint or a query param — your choice, state it in the report.

**Tests:** `backend/tests/test_vessel_endpoint.py` — the 404, the shape, and
that the handler makes no `entity_history` query (assert on the queries issued,
following whatever pattern `backend/tests/test_persistence_coverage.py` uses).

**Verify:** both suites green.

---

## Task 18: Vessel and aircraft filter bars

**Files:** `frontend/src/components/controlPanel/LayersSection.jsx` (or a new
`FilterBar.jsx` used by both), `frontend/src/map/createMapController.js`,
`backend/app.py`.

**Vessel filter**, on the AIS layer:

- Free text matching `callsign`, `name`, `mmsi`, `imo`, with `*` as a wildcard
  and implicit prefix matching.
- **Callsign prefix grouping** — the ITU callsign prefix is a flag indicator;
  offer filtering by prefix with the resolved country shown beside it. Reuse
  the table from Task 14 where the two overlap, or add a callsign-prefix table
  next to it.
- Combines with the existing class filters and the sanctions/watchlist flags.
- Implementation is client-side: the WebGL layer takes an item list
  (`webglLayer.js:566`), so filtering is passing a shorter list. Also add an
  optional `callsign=` parameter to `/api/ships` for when the global feed is
  large, and say in a comment which one is authoritative.

**Aircraft filter**, on the ADS-B layer: callsign, registration, ICAO hex,
operator, type code, squawk, and a military-only toggle.

Both bars show the match count against the total, and clear in one click.

**Tests:** `frontend/tests/entityFilter.test.js` — wildcard and prefix matching,
case-insensitivity, the empty query matching everything, a query matching
nothing, and that filtering never mutates the source array.

**Verify:** both suites green.

---

## Task 19: Lane density job

**New file:** `backend/refine/lane_density.py`, run from the refine process.

Build the traffic grid that Task 20 draws. This is our own data about where we
have seen ships — say exactly that, everywhere.

- Read AIS positions from `entity_history` incrementally, with a cursor in
  `reference_snapshots` (`lane_density_cursor`), same discipline as Task 15.
- Grid: 0.05° cells globally, 0.02° inside `config.WATCHED_WATERS`. `cell_key`
  encodes the resolution so the two never collide.
- Per cell accumulate: `positions`, `transits` (distinct MMSI in the run),
  `by_class` (the Task 16 cargo classes), and the summed unit course vector into
  `mean_sin`/`mean_cos`.
- After each run, apply decay: `decay_lane_cells(factor, floor)` with a factor
  chosen so a cell's contribution halves in about 30 days at the configured
  cadence — compute the factor from the cadence rather than hard-coding a
  number, and show the arithmetic in a comment.
- Cadence `LANE_DENSITY_INTERVAL` in `backend/config.py`, default 3600 s.
- `GET /api/lanes?bbox=&min_transits=` in `backend/app.py`, reading `lane_cells`
  only.
- Write `source_health` rows.

**Tests:** `backend/tests/test_lane_density.py` — cell keying at both
resolutions and that they cannot collide, the circular mean over courses
straddling 0°/360°, distinct-MMSI counting, the decay factor derivation, and the
cursor discipline.

**Verify:** backend suite green.

---

## Task 20: Shipping lanes on the map

Two layers, because they are two different claims.

**20a — density wash.** Layer key `laneDensity`. Renders `/api/lanes` as a
canvas wash in the style of the FIRMS/jamming heat layers
(`frontend/src/map/layers.js:212`), intensity from `transits`. Legend states
plainly that this is where **we** have seen ships, over the last 30 days, and
that absence means absence of observation.

**20b — named corridors.** Layer key `shippingLanes`. A curated set of the
corridors people actually name, as `[[lat, lon], ...]` polylines in a Python
literal beside `PIPELINE_ROUTES` (`backend/infrastructure.py:1148`): Suez
approach, Bab-el-Mandeb, Hormuz, Malacca, Taiwan Strait, Bosphorus, Panama
approach, Gibraltar, Danish straits, Cape of Good Hope route. Each carries
`name`, `note`, and where a transit figure is included, the **publisher, figure,
unit and year** — no uncited numbers. Served from `/api/infrastructure`
alongside the pipelines.

Rendered by a near-copy of `renderRailways`
(`frontend/src/map/createMapController.js:4594`). The popup says "schematic
corridor, not a surveyed route".

Both layers get all ten touch points.

**Tests:** `frontend/tests/laneRender.test.js` for the density-to-intensity
mapping and its clamping; `backend/tests/test_shipping_corridors.py` asserting
every corridor has a name, ≥ 2 points, coordinates in range, and that any
`transits` figure carries publisher, unit and year.

**Verify:** both suites green.

---

## Task 21: Dark-ship reachability

Where could a vessel be, now that it has been dark for `t` hours? Answer with a
region, never a fake pin.

**File:** `backend/sources/dark_vessels.py` (extend; read its existing
`ais_gap` builder at `:221` first — the pin stays where it went quiet).

Add to each `ais_gap` record:

- `reach_radius_km` — `v_max × t`, where `v_max` is the hull's observed 95th
  percentile speed over the retained window, falling back to a per-`ship_type`
  class default when there are too few samples. Record which was used in
  `speed_basis`.
- `dr_lat`, `dr_lon` — dead-reckoned position from the last fix along the last
  known course at the last known speed.
- `contours` — three GeoJSON polygons at 50 %, 80 % and 95 %. Along-track spread
  from observed speed variance; cross-track spread growing as `k√t`. State the
  model in a module comment, with its assumptions listed.
- **Land masking** — subtract land. Use the water polygons from Task 4: a
  contour vertex that falls on land is pulled back to the water boundary. This
  is the single largest accuracy gain and the reason Task 4 comes first. Set
  `masked_by_land: true` when masking changed the shape.
- **Destination prior** — when the vessel's declared `destination` resolves to
  an indexed port, bias the lobe toward the great circle to it, weighted low.
  Set `destination_prior_used` with the port and the weight.
- **Scoring** — when the vessel reappears, store the error between the last
  prediction and the actual resume point on the record
  (`prediction_error_km`, `prediction_scored_at`). Show it on the card. A model
  that reports its own accuracy is worth more than one that does not.

Every field above lives under the record's existing `inferred: true`.

**Frontend:** render the contours in the existing `uncertaintyPane`
(`frontend/src/map/layers.js:397`, z 380, no pointer events), which already
draws `L.circle` for event uncertainty at `createMapController.js:2916` —
extend it to polygons. Distinct colour token. Last-known pin draws on top.
Same treatment for `gfw_gaps` records, which already carry `resumed_lat/lon` and
`distance_from_shore_km`.

**Tests:** `backend/tests/test_dark_reach.py` — radius arithmetic, the
class-default fallback, contour nesting (50 % inside 80 % inside 95 %), land
masking against a hand-built coastline, the destination prior's effect and its
weight bound, and the scoring path.

**Verify:** both suites green.

---

## Task 22: Aircraft card depth

**File:** `frontend/src/map/decorators.js` (`decorateAdsb`).

Sections:

- **Identity** — registration, `type_code` (stored, never read — `adsb.py:393`)
  with `type_desc`, operator, ICAO hex plus the allocating country from
  `hex_country`/`hex_block`, military role.
- **Flight now** — callsign, altitude, speed, heading, vertical trend derived
  from the recorded track, squawk with the emergency codes decoded.
- **Flags** — OFAC tail match, `display_limited` rendered as "this aircraft's
  operator has requested limited display" with the programme named, emergency
  squawk.
- **Provenance** — which of OpenSky and airplanes.live supplied this record, and
  that `nearest_airfield` is proximity, not a filed destination.

**Tests:** `frontend/tests/adsbCard.test.js` — squawk decoding for 7500/7600/7700
and a normal code, the vertical-trend derivation from a short track including
the level case, and the limited-display wording.

**Verify:** frontend suite green.

---

## Task 23: Flight legs

**New file:** `backend/refine/flight_legs.py`, refine process. Symmetric with
Task 15.

- Incremental read of `entity_history` for `adsb`, cursor in
  `reference_snapshots` (`flight_legs_cursor`).
- A leg opens when `on_ground` goes false, or when altitude climbs through
  1500 ft within 10 km of a known airfield. It closes on the reverse.
  `origin_code` and `dest_code` come from `nearest_airfield` at those moments.
- `confidence`: `observed_both` when we saw both ends, `observed_one` when we
  saw one, `inferred` when neither end was observed and the leg is bounded by
  the retention window instead.
- `max_alt_ft`, `distance_km` (great-circle sum over the recorded track).
- `GET /api/aircraft/{icao24}` → identity, last 20 legs, current leg. Reads
  `flight_legs` and `entity_latest` only.
- Frontend: a **Route** section on the aircraft card, opening with the sentence
  that ADS-B broadcasts no flight plan and that origin and destination are
  inferred from where we saw this airframe on the ground.
- **Aircraft cargo**: type class (freighter designators) plus operator plus
  route, phrased as "aircraft class suggests freight" and nothing stronger.
- Cadence `FLIGHT_LEG_INTERVAL`, default 900 s. `source_health` rows.

**Tests:** `backend/tests/test_flight_legs.py` — leg open and close, the
altitude-threshold path, single-ended legs, the confidence values, distance
arithmetic against a known pair of points, and cursor discipline.

**Verify:** both suites green.

---

## Task 24: More satellites

**File:** `backend/sources/satellites.py`, plus `backend/app.py`.

Today: two CelesTrak groups (`stations`, `military`), SGP4-propagated
server-side every 10 s.

**Do:**

1. Add groups, each behind its own layer toggle: `gps-ops`, `galileo`,
   `glo-ops`, `beidou` (one "navigation" toggle); `weather`, `noaa`, `goes`
   ("weather"); `resource`, `sarsat`, `spire`, `planet` ("imaging"); `science`
   (default off); `geo` (default off); `starlink`, `oneweb` (default off, hard
   gated, with a warning in the control panel about the object count). **Do not
   offer the `active` group** — 11 000 objects, and there is no view in which it
   helps.
2. **Move propagation to the client** for everything except `stations` and
   `military`. Add `GET /api/satellites/elements?groups=` serving the stored
   OMM element sets, and propagate in the browser with `satellite.js`
   (add the npm dependency). The server cannot SGP4 eight thousand objects every
   ten seconds; the browser can, once, per frame budget. Keep `/api/satellites`
   for the two small server-propagated groups so nothing regresses.
3. Per-group cadence: small groups 10 s, large groups 60 s with client-side
   interpolation between fixes.
4. Carry the CelesTrak GP fields we currently discard: international designator,
   inclination, period, apogee, perigee, epoch, and the launch date where the
   element set has it.

**Tests:** `backend/tests/test_satellites.py` (extend) — group registry
including that `active` is absent, the elements endpoint's group filter, and the
per-group cadence selection. `frontend/tests/satPropagate.test.js` — the
client-side propagation against a known TLE and a known position, and the
interpolation between two fixes.

**Verify:** both suites green.

---

## Task 25: Satellite card, ground track, footprint, overpasses

**Files:** `frontend/src/map/decorators.js`, `frontend/src/map/createMapController.js`,
`backend/app.py`.

- **Card**: NORAD id, international designator, group, altitude, velocity,
  inclination, period, apogee/perigee, launch date, operator/country, epoch age
  (how old the element set is — this matters and is never shown).
- **Ground track**: the sub-satellite point for the previous and next 90 minutes
  as a polyline, drawn on selection. Handle the antimeridian by splitting the
  path, the way `frontend/src/utils/geo.js` already handles world copies.
- **Visibility footprint**: the circle of Earth within line of sight at the
  current altitude — one `L.circle`, radius from altitude by the standard
  spherical formula, stated in a comment.
- **Overpass prediction**: for the currently selected country, water body or
  point, list the next passes of enabled imaging satellites within 24 hours.
  Compute server-side with skyfield (already a dependency) at
  `GET /api/satellites/passes?lat=&lon=&hours=&groups=`; cap the work and say
  what the cap is.

**Tests:** `backend/tests/test_sat_passes.py` — a known satellite over a known
point against a precomputed answer, the no-passes case, and the cap.
`frontend/tests/groundTrack.test.js` — antimeridian splitting.

**Verify:** both suites green.

---

## Task 26: Sub-national outages

**Files:** `backend/sources/outages.py`, `backend/app.py`, frontend district card
and choropleth.

IODA v2 serves `entityType=region` and `entityType=asn`; `outages.py:59`
discards everything that is not a country.

**Do:**

1. Second pass with `entityType=region`, keeping `entityCode`, region name,
   parent ISO2, `score`, `signals`, `event_count`, `window_start`, `window_end`.
2. Map IODA region names to our admin-1 ISO 3166-2 codes at collect time. Exact
   match first, then a normalised-name match, then unmatched. Carry
   `matched: "exact" | "fuzzy" | "unmatched"` on every record. **Unmatched
   regions are kept in the payload and simply not drawn — never silently
   dropped.**
3. ASN-level for the top ISPs of countries currently above the score floor.
4. Store as `reference_snapshots` name `outages_regions`, shape
   `{ISO2: {region_code: {...}}}`. `GET /api/outages/regions`. `/api/outages`
   is unchanged.
5. District/state card gains a **Connectivity** section (Task 11 leaves room)
   showing score, signals, window, and the match quality.
6. Extend the choropleth: `frontend/src/components/controlPanel/PlacesSection.jsx`
   currently offers "Paint countries by"; make it "Paint by" with a target
   selector (countries / states) and add an outage-score metric for states.
   `frontend/src/map/choropleth.js` is wired to countries only — generalise it.
7. A small badge marker at the admin-1 centroid when a region is scoring, so an
   outage is visible without opening a card. Zoom-gated like everything else.

**Tests:** `backend/tests/test_outages_regions.py` — the three match qualities,
that unmatched records survive into the payload, and the ASN pass.
`frontend/tests/choropleth.test.js` (extend) — the state target and the new
metric's ramp.

**Verify:** both suites green.

---

## Task 27: Railways, upgraded

**Files:** `backend/sources/railways.py`, `backend/sources/osm_infra.py`,
frontend rail rendering.

Today: Natural Earth 1:10m linework, clipped to eleven theatre boxes, **no
attributes at all** (`railways.py:96`).

**Do:**

1. Add an Overpass pass for the theatre boxes — reuse `osm_infra.py`'s existing
   Overpass client, pacing and caps. Query `railway=rail|light_rail|narrow_gauge`
   capturing `name`, `operator`, `gauge`, `electrified`, `usage`, `service`.
2. Keep NE as the global fallback and OSM as the detailed overlay. Every line
   carries `source: "ne" | "osm"` so provenance is per-feature, and the popup
   says which.
3. Render classes: main line, branch, narrow gauge get distinct weight and dash;
   electrified vs not is a colour token. Four new tokens in the admin palette.
4. Bring `osm_infra`'s existing rail points (`railway_station|halt|yard|border`)
   onto the same layer group as a sub-ticker, so one toggle gives the whole
   network.
5. Wire `digitraffic_rail`'s live train positions (already collected, endpoint
   `/api/rail-live` already exists) as a live sub-layer of the same group.

**Tests:** `backend/tests/test_railways.py` (extend) — the OSM parse including
each tag, the NE/OSM merge keeping both provenances, and the theatre clip.

**Verify:** both suites green.

---

## Task 28: Energy infrastructure depth

**Files:** `backend/sources/osm_infra.py`, `backend/infrastructure.py`,
`frontend/src/map/decorators.js`, `frontend/src/map/popups.js`.

1. **Power plants** get their own layer key rather than riding `osmInfra`.
   Glyph by fuel from `source_tag` (nuclear / coal / gas / hydro / wind / solar /
   biomass / other), size by `output_mw` where tagged. Card: name, operator,
   fuel, capacity, commissioning year where tagged, OSM link.
2. **Substations and transmission lines** — add `power=substation` and
   `power=line` / `power=cable` to the Overpass query. Lines render through the
   same polyline path as railways. This is what makes the cross-border flow
   numbers legible on the map instead of only in a card.
3. **Dams** — surface the twenty-odd fields `dams.py` already collects and the
   card ignores: height, capacity, catchment, river, main use, power, year,
   quality rank, GDW/GRanD identifiers with links. Do **not** add downstream
   population at risk; we have no hydrological dataset and will not fake one.
4. **Refineries, terminals, storage** — extend Overpass with
   `industrial=refinery`, `man_made=storage_tank`, `man_made=petroleum_well`
   inside the theatre boxes, merged with the curated `INFRA_SITES`.
5. **Pipelines** — add `man_made=pipeline` from OSM for the theatre boxes to get
   real geometry with `substance` tags, colour by substance, keeping the curated
   `PIPELINE_ROUTES` as the fallback with its provenance intact.
6. **Grid stress** section on the country card combining `energy_flows` net
   position, the outage score from Task 26, and a 24-hour sparkline.

Every one of these carries the OSM completeness caveat with the tagged fraction.

**Tests:** `backend/tests/test_osm_infra.py` (extend) — each new tag's parse, the
fuel normalisation including unmapped values, and the caps.

**Verify:** both suites green.

---

## Task 29: Military infrastructure depth

**Files:** `backend/infrastructure.py`, `backend/sources/osm_infra.py`,
`backend/app.py`, `frontend/src/components/`, `frontend/src/map/popups.js`.

1. **Bases** — merge the curated `MILITARY_BASES` literal
   (`backend/infrastructure.py:1228`) with OSM
   `military=base|naval_base|airfield|training_area|barracks|danger_area`,
   keeping provenance per site rather than blending them. Card: name, branch,
   operator country, type, area, nearest settlement, recent air activity, recent
   conflict events within radius.
2. **Airfield activity panel** — `/api/airfield-activity` exists
   (`backend/app.py:980`) and **nothing in the frontend calls it**. Build the
   panel: a sortable table of airfields by 24-hour movements and military share,
   with trend and top aircraft types, click to fly.
3. **Naval presence** — navy-class AIS contacts aggregated per water body
   (Task 6) and per port, with a 7-day trend. The map should be able to state
   "three naval hulls in this sea, up from one last week" — and to say when the
   trend is not computable because coverage changed.
4. **Air defence and radar** — OSM `military=bunker`, `man_made=radar_station`,
   `military=checkpoint`. Coverage is patchy; layer defaults off and carries an
   explicit completeness caveat.
5. **Airspace closures** — `czib.py` already collects EASA conflict-zone
   bulletins at country precision. Cross-reference them into the military
   section of the country card.

NOTAMs are out of scope: no free global feed with a usable licence. Say so in a
comment where a reader would expect them.

**Tests:** `backend/tests/test_military_merge.py` — the curated/OSM merge keeping
both provenances and not double-counting a site present in both.
`frontend/tests/airfieldPanel.test.js` — the sort and the military-share
arithmetic.

**Verify:** both suites green.

---

## Task 30: Tile tint

**Files:** `frontend/src/components/admin/sections/` (new `BasemapSection.jsx`),
`frontend/src/hooks/useAppSettings.js`, `frontend/src/settings/defaults.js`,
`frontend/src/style.css`.

The basemap is raster, so this is a CSS filter on the tile pane — there is no
vector style to change.

1. Controls: tint colour, tint strength 0–1, blend mode (multiply / screen /
   overlay / soft-light), saturation 0–2, brightness 0.3–1.7, contrast 0.5–1.5,
   invert toggle, blur 0–3 px.
2. Apply by setting CSS custom properties on `<html>` from
   `useAppSettings.js:263` — the mechanism already exists for accent and text
   scale — and a rule applying
   `filter: saturate(…) brightness(…) contrast(…) blur(…)` to
   `.leaflet-tile-pane`. The colour tint is a full-pane `::after` with the tint
   colour and the chosen `mix-blend-mode`, not `hue-rotate`.
3. **Independent dial sets** for basemap, imagery (GIBS) and weather panes.
   Tinting a road map and tinting a satellite mosaic are different jobs.
4. Presets: Default, Muted, High contrast, Night, Amber, Print. One click each,
   then editable.
5. Persist under `settings.ui.tiles`, include in the exported config, and add a
   `mergeSettings` migration entry (`frontend/src/settings/defaults.js:484`) with
   a version bump.
6. Measure the cost. If panning degrades, add an "apply tint only at rest"
   option and say in the report what you measured.

**Tests:** `frontend/tests/tileTint.test.js` — the filter-string builder for
default and extreme values, the preset table, and the settings merge/migration
including an old config without the key.

**Verify:** frontend suite green.

---

## Task 31: Admin mode catch-up

Everything the other tasks added needs its dials. Task 3 already split the
panel; this fills it.

**Do:**

1. **Layer rows** for every key added by this plan: `water`, `laneDensity`,
   `shippingLanes`, `railwaysOsm`, `railLive`, `railStations`, `powerPlants`,
   `transmission`, `pipelinesOsm`, `militarySites`, `airDefence`,
   `outageRegions`, `darkReach`, `weathercams`, `aisDigitraffic`, and the
   satellite groups. Each needs its `SETTINGS_LAYERS` row, stack position,
   `GROUP_LAYERS` entry and control-panel row.
2. **Water section** — fill opacity, outline weight, which classes to draw,
   highlight colour, label visibility.
3. **Filters section** — collects the vessel and aircraft filter bars (Task 18)
   and the conflict event filter, plus saved filter presets.
4. **Inference section** — the important one. Per inferred product (laden and
   ballast, cargo class, dark-ship contours, flight legs, lane density, port
   calls) a three-state switch: *hide*, *show labelled*, *show*, defaulting to
   *show labelled*. Below each, the thresholds behind it as numeric fields —
   the draught percentages, the gap hours, the dwell speed floor, the port
   radius, the decay factor. Reuse the tri-state idiom from
   `LayerCheck.jsx`; do not invent a second one.
5. **Cards section** — which sections appear on each card type, their order, and
   default fold state.
6. **Performance section** — WebGL sprite cap, satellite propagation cadence,
   poll-interval multiplier, pause polling when the tab is hidden, track point
   budget. These are constants scattered through
   `frontend/src/map/createMapController.js` today; lift them to settings with
   their current values as defaults.
7. **Health** — the derived jobs (lane density, port calls, flight legs, vessel
   profile) become first-class rows in `SourceStatusSection`, with last run and
   row count.

**Tests:** `frontend/tests/adminSettings.test.js` — the settings merge for every
new key, including an old config that predates them all, and the three-state
inference switch's persistence.

**Verify:** frontend suite green.

---

## Task 32: Cross-cutting honesty features

**Files:** across the frontend.

1. **Last-updated per layer** — every layer row in the control panel shows how
   stale its data is. `source_health` has this; the frontend polls it only in
   admin mode today (`App.jsx:178`). Poll it always, cheaply.
2. **Coverage overlay** — a toggle shading the areas each feed actually looked
   at: `WATCHED_WATERS` for dark-vessel inference, the theatre boxes for
   railways and dams, the six countries with admin-2, GFW's satellite footprint.
   The caveat text for this already exists in three popups; this makes it a
   layer.
3. **Provenance footer** on every card: source, licence, publisher, collection
   time, and which of the four words applies.
4. **Units and timezone** preference — metric / imperial / nautical, and UTC /
   local / browser — in settings, applied by one formatter in
   `frontend/src/utils/format.js`. Every card reads through it.
5. **Empty-state honesty** — when a layer has zero items in view, say which of
   "we looked and found nothing" or "we did not look here" applies. The scene
   resolver knows which.

**This last item is the most important thing in the task, and it is a sweep, not
a feature.** Confusing "found nothing" with "did not look" has been the single
most repeated defect across this whole plan — caught and fixed separately in
Tasks 7, 9, 11, 16, 23 and 26, each time in a different component, each time by a
reviewer rather than by the code. Fixing it once more in one more place is not
what this task is for.

So: before writing anything, **enumerate every surface that can render an empty
or absent result** — card sections, folds, layer counts, badges, panel lists,
summary tiles — and classify each as already-honest, silently-empty, or
wrongly-claiming. Put that inventory in the report; it is the main deliverable.
Then fix the silently-empty ones through **one shared mechanism**, so the seventh
occurrence cannot happen in a component nobody thought to check.

The pieces already exist and must be reused rather than re-invented:
`coverageStateFor` and `coverageReason` in `frontend/src/map/popups.js`,
`raw.fetchCoverage[key]` carrying `{status, fetchedAt, bbox}` written by
`publishFetchOutcome` before the data publishes, and the scene resolver's own
knowledge of whether a layer's fetch gate has lifted at this zoom. Known
silently-empty surfaces to start the inventory from, all found during review:
`buildAdminLive`, `buildAdminCities`, `buildAdminInfrastructure`,
`buildLivePicture`, `buildWaterTraffic`, `buildWaterInfrastructure`, and
`buildAdminConnectivity`'s unmatched-region case.

**Tests:** `frontend/tests/units.test.js` — every conversion in both directions
at a known value, and the timezone formatter across a DST boundary.
`frontend/tests/emptyState.test.js` — both messages selected correctly, and one
case per surface in the inventory that the sweep changed.

**Verify:** frontend suite green.

---

## Task 33: Emergency squawk alerts

`backend/sources/adsb.py` already decodes 7500 (hijack), 7600 (radio failure)
and 7700 (general emergency) into `emergency_squawk`, and nothing surfaces it.

**Do:** a live alert strip above the map listing current emergency squawks —
callsign, registration, type, squawk meaning, position, how long it has been
squawking. Clicking flies to it and selects it. The aircraft's map sprite gets a
distinct highlight while the squawk is live. Dismissing an entry hides that
airframe's alert until its squawk changes.

7500 is rare and often a mis-set transponder; the strip must say so rather than
announcing a hijacking.

**Tests:** `frontend/tests/squawkAlerts.test.js` — the three codes, the
dismissal behaviour, re-alerting after a squawk change, and the duration
formatter.

**Verify:** frontend suite green.

---

## Task 34: Place search

`gazetteer_places` holds GeoNames cities500 (~200 000 places) purely as an
internal geocoding index, with no endpoint.

**Do:** `GET /api/places?q=&limit=` in `backend/app.py` — prefix and substring
match on name and on the stored alternates (`gazetteer_alternates`), ranked by
population then by match quality. Cap the result set and say what the cap is.

Frontend: a search box in the title bar. Type a place, pick a result, fly to it.
Results show name, country, admin-1, population, and feature class. Keyboard
navigable: arrow keys and Enter.

**Tests:** `backend/tests/test_places_endpoint.py` — ranking, the alternates
match, diacritic-insensitive matching, an empty query, and the cap.

**Verify:** both suites green.

---

## Task 35: Deep-linkable views

Encode camera (zoom, centre), enabled layers, active filters, selection and
replay time into the URL hash. Restore from it on load. A "copy link" button on
every card and in the title bar.

Keep the encoding compact and versioned — a short scheme with a leading version
token, so a future change can reject or migrate old links rather than
misinterpreting them. Do not put anything user-identifying in the URL.

**Tests:** `frontend/tests/urlState.test.js` — round-trip for every field, an
unknown version rejected cleanly, a truncated hash not throwing, and that an
empty hash yields the default view.

**Verify:** frontend suite green.

---

## Task 36: Chokepoint transit counters

On top of Task 19's grid: count distinct hulls crossing each
`config.WATCHED_WATERS` box per day, by cargo class, with a 30-day trend.

Backend: a small addition to `backend/refine/lane_density.py` writing
`reference_snapshots` name `chokepoint_transits`, plus
`GET /api/chokepoints`. Frontend: a panel, and a section on the water card
(Task 7) when the water body overlaps a watched box.

State the coverage caveat: this counts hulls **we saw**, and the AIS feed's
reach is not uniform.

**Tests:** `backend/tests/test_chokepoints.py` — distinct-hull counting across a
day boundary, a hull crossing twice, and the trend when a day has no data (which
must not read as zero traffic).

**Verify:** both suites green.

---

## Task 37: Infrastructure at risk

For every conflict event, find the dams, power plants, cable landings, airfields
and ports within the event's own uncertainty radius. Show them on the event
detail card (Task 13 leaves the block) and as a ranked panel: infrastructure
with the most nearby events in the active window.

`backend/proximity.py` already exists — read it first and reuse it.

Proximity is not causation and the panel must say so.

**Tests:** `backend/tests/test_infra_risk.py` — the radius filter, an event with
no uncertainty radius, and the ranking including ties.

**Verify:** both suites green.

---

## Task 38: Cable and outage correlation

When a country's IODA score spikes and it has cable landings, check for
concurrent events near those landings and flag the coincidence.

**It is a coincidence, not a cause, and every string in this feature says so.**
The card shows: the score change, the landings, any events near them in the
window, and an explicit line that submarine-cable faults are usually anchors and
dredging rather than anything deliberate.

**Tests:** `backend/tests/test_cable_outage.py` — the co-occurrence window, a
spike with no landings, landings with no spike, and that no causal language
appears in the emitted strings (assert on the text).

**Verify:** both suites green.

---

## Task 39: Jamming and aircraft cross-check

GPS jamming cells (`jamming.py`, gpsjam.org) and ADS-B tracks are both
collected. Flag aircraft whose reported position jumps or jitters implausibly
while inside a jamming cell — an independent corroboration of the jamming layer.

Define "implausible" explicitly: a position delta implying a speed above the
airframe's plausible maximum, or a reversal inconsistent with the reported
heading. Put the thresholds in config and expose them in the Inference section
(Task 31).

Show on the jamming cell popup ("N aircraft showed position anomalies here in
the last 24 h") and on the aircraft card.

**Tests:** `backend/tests/test_jam_crosscheck.py` — a clean track producing no
flag, an implausible jump producing one, a jump outside any cell not being
attributed to jamming, and the threshold boundaries.

**Verify:** both suites green.

---

## Task 40: Country comparison

Multi-select already exists (`countrySelection` in `App.jsx`). Add a comparison
view: two or three country cards side by side with numeric rows aligned and
differences highlighted. Rows where one country has no data show the gap, not a
zero.

Entry point: a "Compare" button on the country selection bar when two or more
countries are selected.

**Tests:** `frontend/tests/countryCompare.test.js` — row alignment when one card
lacks a section, the missing-data rendering, and the three-country layout.

**Verify:** frontend suite green.

---

## Task 41: Sanctions watchboard

A panel listing every OFAC- and OpenSanctions-matched vessel and aircraft
currently visible: name, identifier, programme, what it matched on, last seen,
current position, and a locate button. The matching is already done per entity
(`sanctions.py`, `maritime_watchlists.py`); this aggregates it.

State the matching rule that already exists in the code: vessels are matched on
IMO, MMSI and callsign and **never on name**, because names collide. Show
`matched_on` per row.

**Tests:** `frontend/tests/sanctionsBoard.test.js` — aggregation across both
entity kinds, the matched-on display, and the empty state.

**Verify:** frontend suite green.

---

## Task 42: Alert rules

The `alerts` table and its webhook path already exist for source health
(`backend/storage.py:222`, `cacheworker/__main__.py:120`). Extend to user rules.

A rule is: a geofence (draw it on the map, or pick a country / region / water
body), a layer, and a condition — entity enters, count exceeds N, score above X,
squawk equals Y. Rules live in the admin config. Firing shows a toast and, when
a webhook is configured, posts to it, reusing the existing de-duplication so a
rule that stays true does not fire repeatedly.

**Tests:** `backend/tests/test_alert_rules.py` — each condition type, the
de-duplication, a rule that resolves and re-fires, and geofence containment.

**Verify:** both suites green.

---

## Task 43: Viewport export

Download everything currently in view as GeoJSON or CSV, with a provenance
header naming every source, its licence, and its collection time. Layer
selection is part of the dialog. Large exports warn before running.

The header is the point — an export without provenance is the exact failure this
project's caveats exist to prevent.

**Tests:** `frontend/tests/export.test.js` — the GeoJSON shape, CSV escaping
including commas and quotes in place names, the provenance header's
completeness, and the empty-selection path.

**Verify:** frontend suite green.

---

## Task 44: Time-lapse replay

`/api/replay` (`backend/app.py:1038`) serves five kinds at a timestamp.
Generalise it to any kind with history, and give the timeline scrubber
(`TimelineBar`) a play button that animates the last 24 hours.

Frame cadence and step size are settings. Playback prefetches the next frames
and degrades to a coarser step rather than stuttering. The scrubber shows which
kinds actually have history for the window — a kind with no rows must read as
"no data" and not as "nothing happened".

**Tests:** `backend/tests/test_replay_endpoint.py` (extend) — the generalised
kind parameter, a kind with no history, and the window clamp.

**Verify:** both suites green.

---

## Task 45: The four unreachable weather layers

`backend/app.py:1179` allows five OWM tile layers; the frontend requests only
`clouds_new` (`frontend/src/map/layers.js:144`). Add `wind_new`,
`precipitation_new`, `temp_new` and `pressure_new` as four more checkboxes in
`WeatherSection.jsx`, each its own tile layer with its own opacity dial, sharing
the existing no-key disabled state.

Smallest task in the plan. Do not gold-plate it.

**Tests:** `frontend/tests/weatherLayers.test.js` — the layer registry, the
URL builder for each, and the disabled state when no key is configured.

**Verify:** frontend suite green.

---

## Task 46: Terminator and illumination

Draw the day/night line, and for a selected point show sunrise, sunset and
current sun elevation. Skyfield is already a dependency server-side; on the
client, compute it directly — the solar position maths is short and does not
need a library.

The terminator is a polygon in its own pane below the country outlines,
refreshed on a timer. Twilight bands (civil, nautical, astronomical) are a
sub-toggle, default off.

Essential context for reading thermal detections and imagery, which is why it is
here and not decoration.

**Tests:** `frontend/tests/terminator.test.js` — the subsolar point at a known
UTC instant against a published value, the terminator polygon at an equinox and
at a solstice, and sunrise/sunset for a known place and date.

**Verify:** frontend suite green.
