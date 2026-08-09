# Map expansion plan — water, cards, lanes, transport history, admin

Date: 2026-08-09. Branch base: `UI`. Target: `OSINT-Main` via PR per workstream.

This plan covers the fifteen things asked for, plus fifteen further proposals at the end. It is written against the code as it stands today, and every claim about what exists was checked in the tree.

---

## 0. What the codebase already gives us

Read this before scoping anything below; several requested features are half-built already, and two are blocked by a missing dataset rather than by missing code.

### Storage

- Postgres 16, **no PostGIS**. Every spatial test is Python (`backend/regions.py:112`, `backend/proximity.py`) or a float `BETWEEN` in SQL (`backend/escalation.py:74`). Lines and polygons live as nested JSON coordinate arrays inside `reference_snapshots.payload`.
- `entity_latest(kind, entity_id, lat, lon, payload JSONB, updated_at, last_moved_at)` — `backend/storage.py:74`. `payload` is the whole source dict, unschema'd.
- `entity_history(id, kind, entity_id, ts, lat, lon, payload)` — `backend/storage.py:92`. Append-only, written **only when the entity moved** (`storage.py:425`). Retention 3 days (`config.py:342`). Already ~11 GB with global AIS (`config.py:404`). **This is the single most important constraint in the plan: nothing new may scan `entity_history` on the request path.**
- `conflict_events` has 34 columns; 25 of them are written and never read back (`storage.py:456`). The same records are duplicated into `entity_latest` kind `events`, which is what the map actually draws.
- `reference_snapshots(name, payload, updated_at)` — never pruned, one row per document. Country/admin boundaries are one row per ISO3.

### Frontend

- Leaflet 1.9.4 from CDN (`frontend/index.html:27`) plus a hand-rolled PixiJS WebGL layer (`frontend/src/map/webglLayer.js:139`) used for six buckets only: AIS civilian/tanker/navy, ADS-B civilian/military/flagged. Everything else is DOM markers.
- Raster basemap only — CARTO light/dark PNG (`frontend/src/map/layers.js:32`). Theme switching is a URL swap. **There is no vector basemap, so there is no per-feature tile styling; a tint has to be a CSS filter on the tile pane.**
- Three polygon layers, all `interactive: false` with Python-style ray-cast hit testing in `frontend/src/map/countryHitTest.js:273`: countries (pane 350), admin-1 (355), admin-2 (358). `buildShapeIndex` is written to be reused by any new polygon layer (`countryHitTest.js:150`).
- Three line layers sharing one identical render body: pipelines (`createMapController.js:4504`), cables (`:4545`), railways (`:4594`). **A shipping-lane layer is a near-copy of `renderRailways`.**
- **Water does not exist as data.** `frontend/src/map/viewportProfile.js` infers "maritime" by sampling a 7×5 grid and counting how many samples fall outside every country polygon. Sea is the absence of land, and the map's background colour.
- Country card content is built in `frontend/src/map/popups.js:648` (`countryCardSections`) — eleven sections, all already rich. District popup is `frontend/src/map/districts.js:173` and is nearly empty by comparison: name, admin1, pcode, and four ACLED metrics.
- Admin mode is one boolean (`useAppSettings.js:94`) gating `ControlPanel`, `TimelineBar`, `AdminPanel`, border editing, and health polling. `AdminPanel.jsx` has eight sections; adding a layer to `SETTINGS_LAYERS` (`settings/defaults.js:37`) buys size/opacity/zoom dials and colour pickers for free.
- Adding a map layer touches ten files. The recipe is in §Appendix A.

### Collectors

- 40 live source modules. **Three are dormant and unreferenced by any process**: `digitraffic_rail.py` (live train positions, 60 s), `digitraffic_ais.py`, `digitraffic_weathercams.py`. They write kinds `rail_live`, `rail_stations`, `ais_digitraffic`, `weathercam` and have no endpoints.
- `railways.py` already exists and already draws. It is Natural Earth 1:10m linework, clipped to eleven theatre boxes, **with no attributes at all** — no name, operator, gauge or electrification (`railways.py:96`).
- `satellites.py` pulls two CelesTrak groups only: `stations` and `military` (`satellites.py`). Positions are SGP4-propagated every 10 s and never stored.
- `outages.py` is IODA v2 with `entityType=country`. Anything not a country entity is discarded (`outages.py:59`).
- `dark_vessels.py` already finds AIS gaps and STS pairs but **deliberately does not extrapolate** — the pin sits on the last known fix ("Drawn where it went quiet", `dark_vessels.py:230`).

### The three hard truths to design around

1. **AIS carries no cargo manifest.** Ever. The feed gives `ship_type` (a code), `draught`, `destination` (free text the crew typed), and `eta`. "What is this ship carrying" can only ever be an *inference* from ship type class + laden/ballast derived from draught + destination string + port-call history. This plan builds that inference and labels it as one.
2. **ADS-B carries no flight plan.** No origin, no destination, no route. `nearest_airfield` is proximity only. "Where did this plane come from and go" must be derived from our own recorded track (`entity_history`), and is only as good as our 3-day retention and coverage.
3. **The repo's stated ethic is that every pin says what kind of evidence it is** (see the caveats already written into `decorators.js:2436` and `LayersSection.jsx:593`). Every inferred field added below carries an explicit `inferred: true` and a provenance line in the popup. No exceptions.

---

## Workstream W1 — Water bodies as first-class geometry

**Why first:** highlightable water, shipping lanes, and maritime cards all need a water polygon set, and nothing else depends on those three. This unblocks the most downstream work.

### Data

New collector `backend/sources/water_bodies.py`, following the `admin1_boundaries.py` shape.

| Dataset | URL family | Licence | What it gives |
|---|---|---|---|
| `ne_10m_geography_marine_polys` | Natural Earth via the nvkelso GeoJSON mirror already used by `railways.py` | CC0 | ~320 named seas, gulfs, bays, straits, channels, with `name`, `featurecla`, `scalerank` |
| `ne_10m_lakes` + `ne_10m_lakes_historic` | same mirror | CC0 | named lakes with `name`, `admin`, `scalerank` |
| `ne_10m_rivers_lake_centerlines` | same mirror | CC0 | river centrelines, `name`, `scalerank` — optional, phase 2 of this workstream |

Store as `reference_snapshots` rows: `water_marine`, `water_lakes`, `water_rivers`. Thin coordinates with the existing `thin_geometry(..., COORD_PRECISION)` helper used by `admin1_boundaries.py:175`. Refresh cadence 7 days (these datasets are effectively static; `railways.py` already uses 7 d).

Add a synthesised `id` per feature (`marine:{scalerank}:{slug(name)}`) because Natural Earth's marine polys have no stable identifier.

### Endpoints

- `GET /api/water?kind=marine|lakes|rivers&bbox=` → GeoJSON FeatureCollection, `max-age=86400`, ETag via the existing `_cached_source_response` (`app.py:311`).

### Frontend

1. New pane `waterPane` at z-index **345** — below `countriesPane` (350) so land outlines still win, above the tiles.
2. `frontend/src/map/water.js`, modelled on `subdivisions.js`: `L.geoJSON(null, { pane: "waterPane", interactive: false })` with `fillOpacity: 0` by default.
3. Hit-testing: build a second shape index with the existing `buildShapeIndex` (`countryHitTest.js:150`) keyed on water features. Extend the click chain in `createMapController.js:4895` with a step between "drill-down" and "country selection": if `findCountryAt` returns null (we are over sea) and a marine polygon contains the point, select the water body.
4. Highlight is CSS-class driven exactly like countries — `.water-hovered`, `.water-selected` in `style.css`, no re-styling of the GeoJSON layer. Selected water body gets a fill wash whose colour is an admin-mode token.
5. `viewportProfile.js` should now consult the water index directly rather than inferring maritime from absence of land. Keep the old sampling as a fallback when the water layer has not loaded — do not delete it.

### Water body card

New `WaterInfoCard`, or better: generalise `CountryInfoCard.jsx` into a `PlaceInfoCard` that takes `{title, subtitle, sections[]}`, and have `countryCardSections`, a new `waterCardSections`, and the district card (W3) all produce the same shape. Sections for water:

| Section | Content | Source |
|---|---|---|
| Profile | Name, class (sea/gulf/strait/bay), bordering countries (computed offline: which country polygons touch the water bbox), approximate area | NE props + one-time offline computation stored in the snapshot |
| Traffic now | Vessels currently inside the polygon by class (tanker/cargo/navy/fishing/other), count and 24 h delta | `raw.ais` filtered by point-in-polygon |
| Dark activity | AIS gaps and STS pairs whose position falls inside | `raw.darkVessels`, `raw.gfwGaps` |
| Chokepoint watch | Whether this body intersects a `config.WATCHED_WATERS` box, and the transit counter from W6 | `config.py:362` |
| Infrastructure | Cable routes crossing, landing points on its shores, ports on its shores | `raw.cables`, `raw.ports` |
| Incidents | Conflict/news events within the polygon in the selected window | `raw.events`, `raw.gdelt` |
| Caveats | AIS coverage caveat, NE 1:10m boundary caveat, "empty water is not evidence of empty water" | static |

**Effort:** collector 1 day, endpoint 0.5, frontend layer + hit test 2 days, card 1.5 days. **Risk:** marine polys overlap each other (the Mediterranean contains the Aegean); pick the smallest-area containing polygon on click, and say so in the card.

---

## Workstream W2 — Country card, second pass

The country card is already the richest thing on the map. The gap is that a lot of collected data never reaches it.

### Fields we already store and never show

| Field | Where stored | Add to section |
|---|---|---|
| `returned_refugees`, `others_of_concern` | `humanitarian` ref (`humanitarian.py:97,99`) | Humanitarian |
| `admin_level` on food security / IDPs | `humanitarian.py:140,172` | Humanitarian — as a precision caveat, which is exactly what it is |
| `net_series` (hourly cross-border flow) | `energy_flows` ref (`energy_flows.py:239`) | Power — render as a 24 h sparkline; `buildSparkline` already exists at `popups.py:255` |
| `available_from`, `interval_minutes` | `energy_flows.py:228,234` | Power — coverage line |
| `window_start`, `window_end` | `outages` ref (`outages.py:76`) | Connectivity — say what window the score covers |
| `num_sources`, `num_articles`, `mention_urls` | gdelt payloads | News section, W4 |

### New sections

1. **Energy** (expanded from "Cross-border electricity"): generation-capacity roll-up from `osm_infra` power plants inside the country (count, total `output_mw` where tagged, breakdown by `source_tag`), dam hydro capacity from `dams` (`power_mw`, `capacity_mcm`), cable landings, then the existing flow block. Explicit coverage caveat: OSM tagging is incomplete and `output_mw` is present on a minority of plants — state the tagged fraction, do not present the sum as national capacity.
2. **Military & security posture**: military airfields and military areas from `osm_infra` (kinds `military_airfield`, `military_area`), curated bases from `backend/infrastructure.py:1228` (`MILITARY_BASES`), military aircraft currently in/near the country from `raw.adsb` where `military` or `military_role`, navy vessels from `raw.ais`, airfield activity for airfields in-country from the `airfield_activity` reference (needs the endpoint that already exists at `/api/airfield-activity`). Sanctioned hulls/tails associated with the country flag.
3. **Transport**: airports by size class, ports by `harbor_size_label` and `oil_terminal`, railway line-km inside the country (computable once W7 gives us attributed rail), border-control crossings from `osm_infra` kind `border_control`.
4. **Sanctions & watchlists**: count of OFAC-designated vessels flagged to this country, OpenSanctions maritime entries by country (`maritime_watchlists.py` already keys `countries`), programmes involved.
5. **Data coverage** (replaces/absorbs "Sources & caveats"): per-source freshness for this country — when each feed last delivered anything inside the bbox, and which feeds have no coverage here at all. This is the honesty section and it should be last but always present.

### Presentation

The card is already eleven `<details>` folds and will become sixteen. Add:

- A **summary strip** at the top: five to seven compact stat tiles (population, events 72 h, fatalities 72 h, connectivity score, refugees, net power, military aircraft) so the card is readable before anything is unfolded.
- Section grouping into three super-folds — *Situation* (conflict, live, events, verified, trend), *Country* (profile, humanitarian, food, energy, transport, military), *Meta* (sanctions, sources, coverage) — with the existing accordion state extended.
- Keep the existing rule that empty sections are dropped entirely (`popups.py:720`).

**Effort:** 3–4 days, mostly `popups.js` and CSS. No backend change except exposing `/api/airfield-activity` to the frontend (endpoint exists, nothing calls it).

---

## Workstream W3 — District and state cards

Today the admin-1 popup shows name/kind/country/code and the admin-2 popup shows four ACLED numbers with a month picker. Both should become full cards using `PlaceInfoCard` from W1.

### What we can fill them with from existing data

| Section | Admin-1 | Admin-2 | Source |
|---|---|---|---|
| Profile | name, ISO 3166-2 code, postal, type, parent country | pcode, name, parent admin1 | `admin1_boundaries`, `admin2_boundaries` refs |
| Conflict | events/fatalities in polygon over the selected window, top event types, most severe event | the existing four `DISTRICT_METRICS` + trend across the 24 available months | `raw.events` clipped to polygon; `hapi_conflict` ref (24 months, already per-admin2) |
| Cities | cities inside, largest by population, capital flag | same | `cities` kind |
| Live picture | aircraft, ships (coastal), fires, jamming cells inside the polygon | same | `raw.*` clipped |
| Infrastructure | power plants, dams, airfields, ports, rail stations, border crossings inside | same | `osm_infra`, `dams`, `ports`, `airports` |
| Connectivity | **W5**: sub-national IODA outage score | inherited from admin-1 with a stated inheritance | `outages` ref, extended |
| Coverage | which admin-2 sets exist (only 6 countries have them), NE 1:10m caveat, "no record ≠ reported zero" | same, keep verbatim | static |

Clipping is point-in-polygon against the already-loaded boundary geometry; reuse `buildShapeIndex`. Everything is client-side over data already fetched — **no new endpoint needed** for the conflict/live/infrastructure sections. The only backend work is W5.

The admin-2 month picker (`districts.js:150`, wired at `createMapController.js:4024`) stays and should also drive the trend sparkline.

**Effort:** 2–3 days once `PlaceInfoCard` exists.

---

## Workstream W4 — News and conflict card, reorganised

The complaint is organisation, not content. Today conflict lives in three disconnected places: `NotableEventsPanel` (severity-ranked list + escalation rows), `NewsBroadcastPanel` (GDELT headline ticker), and `ConflictBriefingCard` (region-scoped summary), plus the events section inside the country card.

### Proposal: one `IntelPanel` with tabs

A single draggable panel replacing `NotableEventsPanel` and `NewsBroadcastPanel`, keeping `ConflictBriefingCard` as the region drill-down.

| Tab | Content | Sort |
|---|---|---|
| **Escalation** | the existing escalation rows, plus a delta arrow per region and a 7-day mini-bar | ratio desc |
| **Events** | fused `events` rows — severity chip, headline, place, fatalities, corroboration badge, reliability band | severity decayed by age (`rankScore`, existing) |
| **News** | GDELT rows with `real_title`, outlet badge, outlet count, time | recency |
| **Officials** | the `officials` kind, which today has an endpoint and **no panel at all** — diplomatic/statement events with CAMEO labels | recency |

Cross-cutting controls in the panel header, applied to every tab:

- **Scope**: World / current viewport / selected country / selected region / selected water body (W1).
- **Window**: 6 h / 24 h / 72 h / 7 d — reuse the existing conflict event filter.
- **Minimum severity** and **verification floor** (already exist in `ControlPanel`; move them here so they are reachable outside admin mode).
- **Group by**: none / country / event type / actor / outlet.

### Per-event detail card upgrades

`EventDetailCard` currently renders the decorator's `detail` string. Give fused events a real card:

- Headline, CAMEO sentence, event family, date/time with reporting lag.
- **Corroboration block**: which datasets agree (`corroborated_by`), how many outlets (`outlet_count`, `verified_outlets`), the `coverage[]` list of up to 8 headlines with links — this is stored today and only partially shown.
- **Reliability block**: score, band, and the `reliability_reasons[]` array in plain language. Stored (`reliability.py:289`), never displayed in full.
- **Geolocation block**: `geo_verdict`, `geo_confidence`, `geo_radius_km`, `geo_text_place`, and if the point was moved, `original_lat/lon` with "moved from" note. All stored, none shown.
- **Nearby**: infrastructure within the uncertainty radius (dams, plants, cables, airfields) — feeds idea #8 below.
- Actions: locate, copy permalink (needs W-idea #12), open source URL.

**Effort:** 4–5 days. Largest single UI change in the plan. Do it after W2 so `PlaceInfoCard` conventions are settled.

---

## Workstream W5 — Sub-national power outages

IODA v2 supports `entityType=region` and `entityType=asn`, not just `country`. `outages.py:59` currently discards everything that is not a country.

### Backend

1. Extend `outages.py`: a second pass with `entityType=region`, keeping `entityCode`, the region name, the parent country ISO2, and the same `score`/`signals`/`event_count`/`window` fields.
2. IODA region codes are Natural Earth / GeoNames derived. Build a mapping table from IODA region name + parent ISO2 to our admin-1 `code` (ISO 3166-2) at collect time, with a fuzzy-name fallback and an explicit `matched: exact|fuzzy|unmatched` field. Unmatched regions are kept in the payload but not drawn — never silently dropped.
3. Store as `reference_snapshots['outages_regions']`: `{ISO2: {region_code: {...}}}`.
4. Also add ASN-level for the top ISPs of countries currently scoring above the floor — useful in the country card, cheap to fetch.
5. `GET /api/outages/regions` (and keep `/api/outages` unchanged).

### Frontend

- District/state card gets a **Connectivity** section (W3) with score, signals, window, and the match quality.
- New choropleth metric on the admin-1 layer: paint states by outage score. The choropleth machinery (`map/choropleth.js:394`) is currently wired to countries only; extend `PlacesSection.jsx`'s "Paint countries by" into "Paint by" with a target selector (countries / states).
- A small outage badge marker at the admin-1 centroid when a region is scoring, so an outage is visible without opening a card. Gate it behind zoom band and the layer system like everything else.

**Effort:** collector 1.5 days (the code mapping is the fiddly part), frontend 1.5 days.

---

## Workstream W6 — Shipping lanes

There is no authoritative free global shipping-lane polygon/line dataset that we can legally redistribute and that is worth drawing. Two honest options; do **both**, in order.

### 6a. Derived lane density from our own AIS (primary)

This is the right answer: it is our own data, it is defensible, and it says exactly what it is — "where we have seen ships".

1. New refine job `backend/refine/lane_density.py`, running hourly.
2. Aggregate `entity_history` for kind `ais` into a fixed grid: 0.05° cells globally, or 0.02° inside `WATCHED_WATERS`. Per cell store `transits` (distinct MMSI), `positions`, and a class split (tanker / cargo / fishing / navy / other from `ship_type`), plus mean course to allow directional rendering.
3. **Do not scan history on request.** Write to a new table:

   ```sql
   CREATE TABLE IF NOT EXISTS lane_cells (
     cell_key   TEXT PRIMARY KEY,       -- "{lat_idx}:{lon_idx}:{res}"
     lat        DOUBLE PRECISION NOT NULL,
     lon        DOUBLE PRECISION NOT NULL,
     res        DOUBLE PRECISION NOT NULL,
     window_days INTEGER NOT NULL,
     transits   INTEGER NOT NULL,
     positions  INTEGER NOT NULL,
     by_class   JSONB NOT NULL,
     mean_course DOUBLE PRECISION,
     updated_at TIMESTAMPTZ NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_lane_cells_bbox ON lane_cells (lat, lon);
   ```

   Owned by `pg-schema-keeper`. Rolling 30-day accumulation: each hourly run adds the last hour and decays old counts, so we are not limited by the 3-day history retention.
4. `GET /api/lanes?bbox=&res=` → cells above a traffic floor.
5. Render as a canvas wash (like FIRMS/jamming heat, `layers.js:212`) or as thinned polylines derived by connecting high-density cells along `mean_course`. Start with the wash — it is honest about being density, not a route.

### 6b. Curated named corridors (secondary, immediate)

A small hand-maintained set of the corridors people actually name — Suez approach, Bab-el-Mandeb, Hormuz, Malacca, Taiwan Strait, Bosphorus, Panama approach, Gibraltar, Danish straits, Cape route — as `[[lat,lon],...]` polylines in a Python literal beside `infrastructure.PIPELINE_ROUTES` (`infrastructure.py:1148`), each with name, typical annual transits (cited, with source and year in the payload), and the chokepoint bbox it corresponds to.

Rendered exactly like `renderRailways` (`createMapController.js:4594`) — a near-copy. Popup carries the citation. **Labelled "schematic corridor, not a surveyed route".**

**Effort:** 6a is 3 days (refine job + table + endpoint + wash layer); 6b is 1 day.

---

## Workstream W7 — Railways, upgraded

Railways already draw. What is missing is that the lines are anonymous NE 1:10m linework clipped to eleven boxes, with no name, operator, gauge or electrification, and no stations on the same layer.

1. Extend `railways.py` with an OSM/Overpass pass for the theatre boxes (`osm_infra.py` already has a working Overpass client with pacing and caps): `railway=rail|light_rail|narrow_gauge`, capturing `name`, `operator`, `gauge`, `electrified`, `usage` (main/branch), `service`.
2. Keep NE as the global fallback layer and OSM as the detailed overlay; the payload gains `source: "ne"|"osm"` per line so provenance is per-feature, and the popup states which.
3. Render classes: main line vs branch vs narrow gauge get different weight/dash; electrified vs not gets a colour token. All four become admin-mode colour tokens.
4. Bring `osm_infra`'s existing rail points (`railway_station|halt|yard|border`) onto the same layer group as a sub-ticker, so a railway toggle gives you the whole network rather than lines alone.
5. **Revive `digitraffic_rail.py`** (dormant, 60 s live train positions + stations, Finland only) as a live sub-layer — a small, high-value demo of "railways as live infrastructure" that costs almost nothing since the module already exists and just needs registering in the ingest job table and an endpoint.

**Effort:** 2.5 days.

---

## Workstream W8 — Ship cards, callsign filter, cargo inference, voyage history

### 8a. Ship card content

Everything below is already collected and mostly not shown:

| Field | Status |
|---|---|
| `imo`, `callsign` | collected, shown |
| `length_m`, `beam_m` | **collected, never read by anything** (`ais.py:185,187`) |
| `draught` | collected; series exists in history |
| `destination`, `eta` | collected — the ETA is a raw `{month, day, hour, minute}` dict deliberately not converted (`ais.py:98`) |
| `nav_status`, `ship_type`, `speed`, `course`, `heading` | collected, shown |
| `sanctions` (OFAC), `watchlist` (OpenSanctions) | collected, shown |
| `gfw_prior` (past AIS-disabling events) | collected in `gfw_vessel_priors`, only used internally |

New card sections: **Identity** (name, MMSI, IMO, callsign, flag from MMSI MID, dimensions, type), **Voyage** (destination as typed, ETA rendered with an explicit "as entered by crew, unverified" flag, nav status, speed/course), **Behaviour** (24 h track summary — distance, mean speed, stops, current laden state), **History** (port calls, W8c), **Flags** (sanctions, watchlist, GFW prior disabling count), **Provenance**.

### 8b. Cargo — inference, honestly labelled

There is no manifest in AIS. Build `backend/refine/vessel_profile.py` producing per-MMSI:

- **Cargo class** from `ship_type` code → the IMO/ITU class table (tanker: crude/product/chemical/LNG/LPG; cargo: bulk/container/general/vehicle/reefer; fishing; passenger; tug; naval; other). Deterministic, cite the AIS type code table.
- **Laden vs ballast** from the draught series: compare current `draught` against the hull's observed max and min over the retained window. Above ~85 % of observed max → likely laden; below ~55 % → likely ballast; between → unknown. This is a real and widely used inference and the field carries `inferred: true`, the two reference draughts, and the sample count.
- **Implied trade** from port-call history: last loading-region port + current destination string, e.g. "last called Ras Tanura, destination reported SIKKA" → "crude, Gulf to India, inferred from port calls". Presented as a sentence with every input visible.
- **Never** display a tonnage or commodity we did not receive. The card says "Cargo is not broadcast by AIS. What follows is inferred from vessel class, draught and port calls."

### 8c. Voyage / port-call history

Do **not** query `entity_history` on request. New table, owned by `pg-schema-keeper`:

```sql
CREATE TABLE IF NOT EXISTS vessel_port_calls (
  mmsi        TEXT NOT NULL,
  port_id     TEXT NOT NULL,
  arrived_at  TIMESTAMPTZ NOT NULL,
  departed_at TIMESTAMPTZ,
  draught_in  DOUBLE PRECISION,
  draught_out DOUBLE PRECISION,
  confidence  TEXT NOT NULL,          -- exact|proximity|inferred
  PRIMARY KEY (mmsi, port_id, arrived_at)
);
CREATE INDEX IF NOT EXISTS idx_port_calls_mmsi ON vessel_port_calls (mmsi, arrived_at DESC);
CREATE INDEX IF NOT EXISTS idx_port_calls_port ON vessel_port_calls (port_id, arrived_at DESC);
```

Detector in the same refine job: a call is speed ≤ 0.5 kn for ≥ 1 h within N km of an indexed port from `ports.py` (WPI) — the exact machinery `dark_vessels.py:328` already uses for STS exclusion, inverted. Retention 180 days (cheap: one row per call, not per position).

Endpoint `GET /api/vessel/{mmsi}` → identity, profile, last 20 port calls, current inference. Fetched on click, alongside the existing `/api/track/ais/{mmsi}` call (`createMapController.js:2030`).

Also fixes the reverse view: **port cards** gain "recent arrivals/departures", which is new and valuable.

### 8d. Callsign filter

The ask is a filter on call signs. Build it as a general **vessel filter bar** in the AIS layer controls:

- Free-text match on callsign, name, MMSI, IMO — prefix and wildcard (`OZ*`).
- Callsign **prefix grouping**: the ITU callsign prefix is a flag-state indicator, so offer "filter by callsign prefix" with the country resolved and shown. Same table can be used to display flag on the card.
- Combine with existing class filters (tanker/navy/civilian) and sanctions/watchlist flags.
- Implementation: filtering happens client-side against the already-loaded `raw.ais` (the WebGL layer takes an item list — `webglLayer.js:566` — so filtering is just passing a shorter list), plus an optional `callsign=` server param on `/api/ships` for when the global feed is large.

**Effort:** card 2 days, cargo/profile refine job 2.5 days, port calls table + detector 2.5 days, filter bar 1.5 days.

---

## Workstream W9 — Aircraft cards and flight history

Symmetric with W8 and constrained the same way.

### Card content (all already collected, much unshown)

`icao24`, `callsign`, `registration`, `type_code` (**never read**), `type_desc`, `operator`, `category`, `military`, `military_role`, `squawk`, `emergency`/`emergency_squawk`, `origin_country`, `hex_country`/`hex_block` (ICAO allocation block → real registration country), `nearest_airfield`, `sanctions` (tail match), `display_limited` (LADD/PIA privacy programmes — worth surfacing as "this aircraft's owner has requested limited display").

New sections: **Identity** (registration, type, operator, ICAO hex + allocating country, military role), **Flight now** (callsign, altitude, speed, heading, vertical trend from the track, squawk with emergency decoding), **Route** (below), **Behaviour** (loiter/orbit detection, altitude profile sparkline), **Flags** (sanctions, LADD/PIA, emergency), **Provenance**.

### Route and history — derived

New refine job `backend/refine/flight_legs.py` and table:

```sql
CREATE TABLE IF NOT EXISTS flight_legs (
  icao24       TEXT NOT NULL,
  departed_at  TIMESTAMPTZ NOT NULL,
  arrived_at   TIMESTAMPTZ,
  origin_code  TEXT,
  dest_code    TEXT,
  callsign     TEXT,
  max_alt_ft   INTEGER,
  distance_km  DOUBLE PRECISION,
  confidence   TEXT NOT NULL,        -- observed_both|observed_one|inferred
  PRIMARY KEY (icao24, departed_at)
);
CREATE INDEX IF NOT EXISTS idx_flight_legs_icao ON flight_legs (icao24, departed_at DESC);
CREATE INDEX IF NOT EXISTS idx_flight_legs_ports ON flight_legs (origin_code, dest_code, departed_at DESC);
```

A leg opens when `on_ground` goes false (or altitude climbs from below 1500 ft near an airfield) and closes on the reverse; `origin_code`/`dest_code` come from `nearest_airfield` at those moments. Confidence records whether we actually saw both ends or only one. Retention 90 days.

`GET /api/aircraft/{icao24}` → identity, last 20 legs, current inference. The card states plainly: "no flight plan is broadcast; origin and destination are inferred from where we saw this airframe on the ground."

**Cargo for aircraft** is the same honesty problem, weaker: type class (freighter designators like `-F`, `B77L`, `A332F`), operator (a known cargo carrier), and route. Present as "aircraft class suggests freight" and nothing stronger.

Also: an **aircraft filter bar** matching W8d — callsign / registration / hex / operator / type / squawk / military-only.

**Effort:** 4 days.

---

## Workstream W10 — Dark-ship position approximation

`dark_vessels.py` currently draws the last known fix and refuses to guess. The ask is to show where the ship *could* be. Do it as an uncertainty region, not a fake pin — this keeps the honesty ethic and is genuinely more informative than a point.

### Model

For a vessel dark for `t` hours from last fix `(lat0, lon0)` with last known `course c` and `speed v`:

1. **Reachability disc**: radius `r_max = v_max × t`, where `v_max` is the hull's observed 95th-percentile speed over the retained history (fall back to a class default by `ship_type` when we have too few samples). This is the outer bound — the vessel cannot be outside it.
2. **Course-weighted lobe**: a dead-reckoned centre at `(lat0, lon0) + c × v × t`, with along-track spread from the observed speed variance and cross-track spread growing as `k√t`. Render as a set of nested confidence contours (50 % / 80 % / 95 %).
3. **Land masking**: intersect with the water polygons from W1 — a ship cannot be on land. This is the single biggest accuracy win and is only possible because W1 exists. Optionally mask by depth later if we add bathymetry.
4. **Destination prior**: if the vessel declared a `destination` that resolves to an indexed port, bias the lobe toward the great-circle to that port. Weight it low and say it is being used — the destination field is crew-typed and often stale.
5. **Resume evidence**: when the vessel reappears, store the actual resume point against the prediction so the model can be scored. Show "our last prediction for this hull was N km off" on the card — self-auditing, and unusual enough to be a selling point.

Fields added to the `ais_gap` record: `reach_radius_km`, `dr_lat`, `dr_lon`, `contours` (three GeoJSON polygons), `speed_basis`, `masked_by_land: true`, `prediction_scored`. All under `inferred: true`, which the record already carries.

### Rendering

The uncertainty pane already exists (`uncertaintyPane`, z 380, no pointer events, `layers.js:397`) and already draws `L.circle` for event geolocation uncertainty (`renderEventUncertainty:2916`). Extend it to polygons. Dark-ship contours draw there, in a distinct colour token, with the last-known pin on top.

Also worth doing: the same treatment for `gfw_gaps` records, which carry `resumed_lat/lon` and `distance_from_shore_km` already.

**Effort:** 3 days, of which 1 is the land mask.

---

## Workstream W11 — More satellites

`satellites.py` fetches CelesTrak groups `stations` + `military` and propagates with skyfield every 10 s.

### Groups to add, with volume noted

| Group | Approx objects | Default state |
|---|---|---|
| `stations` (current) | ~10 | on |
| `military` (current) | ~120 | on |
| `gps-ops`, `galileo`, `glo-ops`, `beidou` | ~120 total | on, one "navigation" toggle |
| `weather`, `noaa`, `goes` | ~80 | on, "weather" toggle |
| `resource`, `sarsat`, `spire`, `planet` (Earth observation / imaging) | ~400 | on at zoom, "imaging" toggle — this is the intelligence-relevant one |
| `science` | ~120 | off by default |
| `geo` (geostationary) | ~600 | off by default |
| `starlink`, `oneweb` | ~7000+ | off by default, hard-gated, and warned about |
| `active` | ~11 000 | **never** — do not offer |

Implementation notes:

- Propagating 8000 objects every 10 s in Python will not hold. Change the loop to propagate **only the enabled groups**, and drive the position cadence from group size: small groups every 10 s, large groups every 60 s with client-side interpolation. Better still, move propagation to the client for large groups — ship the TLEs (`satellite_elements` is already stored) and let the browser propagate with `satellite.js`; this scales to Starlink and removes the server cost entirely. Recommend the client-side path.
- Per-satellite card: NORAD ID, international designator, group, altitude, velocity, inclination, period, apogee/perigee, launch date, operator/country (CelesTrak GP fields carry most of this and we currently discard all but four fields).
- **Ground track**: draw the next and previous 90 minutes of sub-satellite point as a polyline. Trivial once propagation exists, and it is what makes a satellite pin useful.
- **Visibility footprint**: the circle of Earth within line of sight at the current altitude — one `L.circle`, radius from altitude. For imaging satellites this answers "is it overhead right now", which is the actual question.
- **Overpass prediction for a selected place**: given a selected country/water body/point, list the next passes of enabled imaging satellites in the next 24 h. Skyfield does this directly.
- `GET /api/satellites/elements?groups=` for the client-side path; keep `/api/satellites` for the server-propagated small groups.

**Effort:** 3 days server-side, +2 if we do the client-side propagation (recommended).

---

## Workstream W12 — Tile tint in admin mode

Raster tiles, so this is a CSS filter on the tile pane. It works well and is cheap.

1. Admin panel section **Basemap** with: `Tint colour` (colour well), `Tint strength` 0–1, `Saturation` 0–2, `Brightness` 0.3–1.7, `Contrast` 0.5–1.5, `Invert` toggle, and a `Blur` 0–3 px for a "de-emphasise the basemap" look.
2. Implementation: set CSS custom properties on `<html>` from `useAppSettings.js:263` (the mechanism already exists for accent/text scale) and apply
   `filter: saturate(var(--tile-sat)) brightness(var(--tile-bright)) contrast(var(--tile-contrast)) hue-rotate(var(--tile-hue))` to `.leaflet-tile-pane`.
3. The colour tint itself is best done as an overlay rather than `hue-rotate`: a full-pane `::after` with the tint colour and `mix-blend-mode: multiply|screen|overlay` at the chosen strength. Blend mode should be a picker, since multiply suits dark themes and screen suits light.
4. Apply the same filter stack, independently, to the **imagery** pane (GIBS) and the **weather** panes — a separate set of dials per tile layer, because tinting the basemap and tinting a satellite mosaic are different jobs.
5. Presets: "Default", "Muted", "High contrast", "Night", "Amber", "Print" — one click each, then editable.
6. Persist in `settings.ui.tiles` and include in the exported config.

**Effort:** 1.5 days. Watch performance: filters on the tile pane force compositing; test on a low-end machine and offer "apply tint only at rest" if panning gets rough.

---

## Workstream W13 — Admin mode, brought up to date

Every workstream above adds admin surface. Rather than bolt each on, restructure once.

### New and changed sections

1. **Basemap & tiles** (W12) — new.
2. **Layers** — gains rows for `water`, `lanes`, `laneDensity`, `railwaysOsm`, `railLive`, `satellites{Nav,Weather,Imaging,Science,Geo,Comms}`, `outageRegions`, `darkVesselContours`, `portCalls`. Each needs a `SETTINGS_LAYERS` row (`settings/defaults.js:37`), a `PIN_STACK`/`WASH_STACK` position, and a `GROUP_LAYERS` entry.
3. **Water** — new section: fill opacity, outline weight, label visibility, which classes to draw (seas/gulfs/straits/lakes/rivers), highlight colour.
4. **Filters** — new section collecting the vessel and aircraft filter bars (W8d/W9), the conflict event filter (currently buried in `ControlPanel`), and saved filter presets.
5. **Inference** — new section, and an important one: a switch per inferred product (laden/ballast, cargo class, dark-ship contours, flight legs, lane density) with three states — *hide*, *show labelled*, *show*. Default *show labelled*. Plus the thresholds behind each (draught percentages, gap hours, speed floor, port radius) as numeric fields, so a user can see and change what the inference is doing. This is the section that makes the honesty ethic operable rather than decorative.
6. **Data** (`DataEditor.jsx`) — extend `EDITABLE_SOURCES` / `EDITABLE_FIELDS` to the new kinds; add `UNEDITABLE_SOURCES` reasons for derived products (you cannot hand-edit a density grid).
7. **Cards** — new section: which sections appear on each card type, their order, and default fold state. As the country card grows to sixteen sections this stops being cosmetic.
8. **Performance** — new section: WebGL sprite cap, satellite propagation cadence, poll interval multiplier, "pause background polling when tab hidden", history/track point budget. Today these are constants scattered across the map controller.
9. **Health** (`SourceStatusSection`) — add the derived jobs (lane density, port calls, flight legs, vessel profile) as first-class health rows, plus last-run and row-count per refine job. Requires those jobs to write `source_health` rows, which is a one-liner each.
10. **Config** — unchanged, but the exported JSON grows; bump `settings.version` and add a `mergeSettings` migration entry (`defaults.js:484`).

### Structural changes

- The admin panel is 821 lines and will roughly double. Split into one file per section under `components/admin/sections/`, with `AdminPanel.jsx` reduced to composition. Do this **before** adding sections, not after.
- Add a search box over all admin controls — with ~15 sections, finding a dial matters.
- The three-state layer checkbox (`LayerCheck.jsx`) pattern should extend to the new inference switch rather than a new idiom.

**Effort:** 2 days for the split, 3–4 days for the new sections spread across the other workstreams.

---

## Workstream W14 — Energy and military infrastructure depth

Beyond the country-card sections in W2.

### Energy

- **Power plants**: `osm_infra` already collects `power_plant` with `output_mw` and `source_tag`. Give them their own layer (today they are lumped into `osmInfra`), glyph by fuel type (nuclear/coal/gas/hydro/wind/solar/biomass), size by capacity. Card: name, operator, fuel, capacity, commissioning year where tagged, OSM link, nearest grid substation.
- **Substations and transmission lines**: add `power=substation` and `power=line`/`power=cable` to the Overpass query. Transmission lines give us the grid as linework — the same `renderRailways` path again — and make the cross-border flow data in `energy_flows` legible on the map rather than only in a card.
- **Dams**: already rich (`dams.py` has 20+ fields, most unshown). Card gets height, capacity, catchment, river, main use, power, year, quality rank, and the GDW/GRanD identifiers with links. Add a **downstream population at risk** line only if we later add a hydrological dataset — do not fake it.
- **Refineries, terminals, LNG**: extend Overpass with `man_made=petroleum_well`, `industrial=refinery`, `man_made=storage_tank` in theatre boxes, plus the curated sites already in `infrastructure.INFRA_SITES`.
- **Pipelines**: already drawn from a Python literal (`infrastructure.py:1148`). Add `man_made=pipeline` from OSM for theatre boxes to get real geometry with `substance` (gas/oil/water) tags, and colour by substance.
- **Grid stress view**: combine `energy_flows` net position, IODA outage score (W5), and plant outage news mentions into one country-level "grid" section with a 24 h sparkline.

### Military

- **Bases**: merge the curated `MILITARY_BASES` literal (`infrastructure.py:1228`) with OSM `military=base|naval_base|airfield|training_area|barracks|danger_area`, keeping provenance per site. Card: name, branch, operator country, type, area, nearest settlement, recent air activity from `airfield_activity`, recent conflict events within radius.
- **Airfield activity is already computed and has an endpoint that nothing calls** (`/api/airfield-activity`, `airfield_activity.py`). Surface it: per-airfield 24 h movement count, military share, trend, top aircraft types. This is a strong feature sitting unused.
- **Naval presence**: navy-class AIS contacts aggregated per water body (W1) and per port, with a 7-day trend. "Three naval hulls in the Red Sea, up from one last week" is exactly the kind of line the map should be able to state.
- **Air defence and radar sites**: OSM `military=bunker`, `man_made=radar_station`, `military=checkpoint`. Coverage is patchy and politically sensitive; include with an explicit completeness caveat and keep the layer off by default.
- **Exercise and closure notices**: `czib.py` (EASA conflict-zone bulletins) already collects these at country precision. Cross-reference them with airspace and show as an overlay on the military section.
- **NOTAMs** are the obvious missing piece; there is no free global feed with a usable licence. Note it as out of scope rather than half-doing it.

**Effort:** 4–5 days, mostly Overpass query extension and card work.

---

## Workstream W15 — Cross-cutting "things a user should know"

Small items, high value, mostly plumbing that already exists.

1. **Last-updated per layer, visible.** Every layer row in the control panel shows how stale its data is. `source_health` has this; the frontend polls it only in admin mode.
2. **Coverage honesty overlay.** A toggle that shades the areas each feed actually looked at — `WATCHED_WATERS` for dark-vessel inference, theatre boxes for railways/dams, the six countries with admin-2, GFW's satellite footprint. The caveat text for this already exists in three popups; make it a map layer.
3. **Provenance footer on every card**: source, licence, publisher, collection time, and whether the value is measured, reported, or inferred. Standardise the four words.
4. **Unit and timezone preference** (metric/imperial/nautical, UTC/local/browser) in settings, applied by a single formatter in `utils/format.js`.
5. **Empty-state honesty.** When a layer has zero items in view, say which of "we looked and found nothing" or "we did not look here" applies. The scene resolver knows which.

---

# Sequencing

| Phase | Workstreams | Why this order |
|---|---|---|
| **P0** — foundations (1 week) | W13 admin split (no new sections), `PlaceInfoCard` extraction from `CountryInfoCard`, schema additions (`lane_cells`, `vessel_port_calls`, `flight_legs`) | Every later workstream lands on these; doing them first avoids three rewrites |
| **P1** — water (1 week) | W1 | Unblocks lanes, maritime cards, dark-ship land masking |
| **P2** — cards (1.5 weeks) | W2, W3, W4 | Biggest visible payoff, no new collectors needed except W5 |
| **P3** — maritime (1.5 weeks) | W8, W6, W10 | Ship depth, lanes, dark ships — all AIS-derived, share the refine job |
| **P4** — air and space (1 week) | W9, W11 | Symmetric to P3 |
| **P5** — infrastructure (1.5 weeks) | W5, W7, W14 | Overpass-heavy, independent of the above |
| **P6** — polish (1 week) | W12, W13 new sections, W15 | Tint and admin catch-up land last, once there is something to configure |

Roughly 8–9 weeks of focused work. Each phase is independently shippable and independently revertible.

## Testing

Follow the existing pattern — one `backend/tests/test_<module>.py` per new collector, fixtures from recorded upstream responses. Specifically required:

- `test_water_bodies.py` — parse, thin, id stability, overlapping-polygon selection.
- `test_lane_density.py` — cell keying, decay arithmetic, class split, no history scan on the request path.
- `test_vessel_profile.py` — laden/ballast thresholds including the "not enough samples" path; cargo class mapping table.
- `test_port_calls.py` — arrival/departure detection, the moored-at-anchor false positive, dedupe on re-entry.
- `test_flight_legs.py` — leg open/close, single-ended legs, confidence labelling.
- `test_dark_reach.py` — reachability radius, land masking, and the prediction-scoring loop.
- `test_outages_regions.py` — region code mapping including the unmatched path.
- Frontend: extend the existing `frontend/tests` for the water hit-test and the filter bars.

## Risks

| Risk | Mitigation |
|---|---|
| `entity_history` is 11 GB and growing; three new derived jobs read it | All three read incrementally on a schedule and write compact tables. Nothing derived is computed on request. Add a row-count and duration metric per job. |
| Satellite propagation cost at 8000 objects | Client-side propagation from stored TLEs; hard-gate the mega-constellations off. |
| Country card at 16 sections becomes unreadable | Summary stat strip + three super-folds + admin control over section order and defaults. |
| Inferred fields get mistaken for observations | The Inference admin section, the four-word provenance vocabulary, and `inferred: true` on every derived record. Non-negotiable. |
| Tile filters hurt pan/zoom performance | Measure; offer "apply at rest only". |
| Overpass rate limits with a much larger query set | Reuse `osm_infra.py`'s existing pacing and per-feature caps; stagger the new queries across the 24 h sweep. |
| Water polygon overlap and NE coastline coarseness at high zoom | Smallest-containing-polygon rule; state the 1:10m limitation in the card, as the subdivision popup already does. |

---

# Fifteen further ideas

Ordered by value-per-day. All are implementable against data we already collect.

1. **Emergency squawk feed.** `adsb.py` already decodes 7500 (hijack), 7600 (radio failure), 7700 (general emergency) into `emergency_squawk` and nothing surfaces it. A live alert strip plus a map flash. Half a day, and it is the single highest-signal thing in the ADS-B payload.

2. **Airfield activity panel.** `/api/airfield-activity` exists and has no consumer. A sortable table of airfields by 24 h movements and military share, click to fly. One day.

3. **Named-place search.** The `gazetteer_places` kind holds GeoNames cities500 (~200k places) purely as an internal geocoding index with no endpoint. Add `GET /api/places?q=` and a search box: type a town name anywhere on Earth and fly there. One to two days, huge usability gain.

4. **Deep-linkable views.** Encode camera, layers, filters, selection and time into the URL hash; a "copy link" button on every card. Makes the map shareable and makes bug reports reproducible. One to two days.

5. **Chokepoint transit counters.** Once W6a's grid exists, count distinct hulls crossing each `WATCHED_WATERS` box per day, by class, with a 30-day trend. "Hormuz: 41 tankers today, 30-day mean 48." One day on top of W6.

6. **Infrastructure-at-risk proximity alerts.** For every conflict event, find dams, power plants, cable landings, airfields and ports within the event's own uncertainty radius, and show them on the event card and as a ranked panel. `proximity.py` already exists. Two days, and it is genuinely novel analysis.

7. **Cable fault ↔ outage correlation.** When a country's IODA score spikes and it has cable landings, check for concurrent events near those landings and flag the coincidence — explicitly as a coincidence, not a cause. Two days.

8. **Jamming ↔ aircraft behaviour cross-check.** GPS jamming cells and ADS-B tracks are both collected. Flag aircraft whose reported position jitters or jumps while inside a jamming cell. Corroborates the jamming layer with independent evidence. Two to three days.

9. **Country comparison mode.** Multi-select already exists (`countrySelection`). Render two or three country cards side by side with the numeric rows diffed. One to two days.

10. **Sanctions watchboard.** A panel listing every OFAC/OpenSanctions-matched vessel and aircraft currently visible, with last seen, current position, and flags. The matching is already done per-entity; this just aggregates it. One day.

11. **Alert rules engine.** The `alerts` table and webhook path already exist for source health. Extend to user rules: "any navy vessel enters this polygon", "any 7700 squawk in this region", "outage score above X in this country". Draw the geofence on the map. Three to four days.

12. **Viewport export.** Download everything currently in view as GeoJSON or CSV with a provenance header naming every source, licence and collection time. Two days, and it makes the map a research tool rather than a viewer.

13. **Time-lapse for any layer.** `/api/replay` exists for five kinds. Generalise it and give the timeline scrubber a play button that animates the last 24 h of ships, aircraft, fires or events. Two to three days.

14. **Weather layers that already work.** Four of the five proxied OWM tile layers (`wind_new`, `precipitation_new`, `temp_new`, `pressure_new`) are allowed by the backend and unreachable from the UI. Add four checkboxes. Two hours.

15. **Terminator and illumination.** Draw the day/night line and, for a selected point, sunrise/sunset and current sun elevation. Essential context for interpreting imagery and thermal detections, and skyfield is already a dependency. Half a day.

**Runners-up, noted but not counted:** revive `digitraffic_weathercams.py` (dormant, gives real roadside imagery); expose `/api/conflict` (the raw pre-fusion layer, currently unused by the frontend) as an admin-only "show me what fusion did" comparison; a keyboard command palette; per-source cost/quota dashboard.

---

# Appendix A — adding a map layer, current recipe

Derived from the `railways` and `deflock` layers. Ten touch points:

1. `map/scene.js:208` — `LAYER_MANIFEST` entry (draw band, fetch band, cap, collapse, disposition, `scoped: true` if the endpoint takes `bbox`).
2. `hooks/useOsintData.js:34` — a `POLL_CONFIG` row, or a one-shot boot fetch like railways at `:546`.
3. `map/layers.js` — a factory returning the Leaflet container.
4. `map/svgIcons.js` — the glyph, plus `GLYPH_CHOICES` if it should be pickable.
5. `map/decorators.js` — style + a `decorateX(d, opts)` returning `{icon, tooltip, detail, title}`.
6. `map/iconTheme.js` — token in `PALETTE_GROUPS:27`, `TOKEN_LAYER:236`, a `PIN_STACK:331` or `WASH_STACK:337` position, `STACK_ALIAS:348` if it rides another key.
7. `map/createMapController.js` — group construction `:486`, `layerForKey:1840`, then either `ID_FIELD:218`/`DECORATORS:229`/`ICON_SIZE_FOR_GLYPH:242` for point layers or a `renderX()` plus dispatch in `applyData:5156` and `renderAllLayers:4695` for lines; `counts:2388`/`totals:2410`; `COUNT_KEYS` in `map/useLeafletMap.js:9`.
8. `settings/defaults.js:37` — a `SETTINGS_LAYERS` row (buys all the admin dials).
9. `components/controlPanel/LayersSection.jsx:86` — `GROUP_LAYERS` entry and a `LayerCheck` row.
10. `components/admin/sections/shared.jsx:18` — `STACK_LABEL` if the stack key differs.

# Appendix B — schema additions summary

Owned by `pg-schema-keeper`. No PostGIS; keep the plain-column + JSONB idiom.

- `lane_cells` (W6a) — traffic density grid, rolling 30 d.
- `vessel_port_calls` (W8c) — one row per call, 180 d.
- `flight_legs` (W9) — one row per leg, 90 d.
- `reference_snapshots` new names: `water_marine`, `water_lakes`, `water_rivers`, `outages_regions`, `railways_osm`, `shipping_corridors`.
- No change to `entity_latest` / `entity_history` / `conflict_events`.
