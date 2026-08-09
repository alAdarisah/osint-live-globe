// Seas, lakes and rivers -- the first polygon layer on this map that is not
// an administrative boundary. Follows subdivisions.js's pattern closely: a
// constant-style L.geoJSON, `interactive: false`, hit-tested by the map's own
// ray-cast rather than by the DOM (see countryHitTest.js:1-23 for why a
// full-viewport canvas above these panes would otherwise swallow every
// click), and hover/selection toggled as CSS classes on layer.getElement()
// rather than a re-style -- Leaflet applies a path's `className` once, when
// it is created, and never again.
//
// Geometry from Natural Earth via /api/water; see backend/sources/water_bodies.py
// for what "seas, lakes, rivers" means at 1:10m generalisation and
// backend/app.py's water_endpoint for the stored bbox/antimeridian contract
// every feature carries (not used here -- that contract is for the backend's
// own bbox-overlap filtering of a network request, not this client-side
// ray-cast, which works directly off ring geometry).

import { L } from "./leafletGlobal";
import { buildShapeIndex, countryContainsPoint } from "./countryHitTest";

/**
 * Per-feature style. Marine and lake polygons stay invisible (fillOpacity 0,
 * stroke opacity 0) until hovered or selected -- the same "boundaries only
 * appear via classes" rule createCountriesLayer uses, and for the same
 * reason: filling the whole ocean surface, or outlining all 306 marine
 * polygons, unconditionally at world zoom is exactly the clutter that
 * function's own note warns against.
 *
 * A river is a line, not a fill, and a line nobody can see until they
 * accidentally land on it is not a drawn layer at all -- so it gets the
 * always-visible hairline treatment createRailwaysGroup gives its own
 * linework instead of the hover-reveal treatment above.
 *
 * Deliberately no `color`/`fillColor` baked in here -- earlier revisions read
 * the palette once, at creation time, and a river's always-visible hairline
 * paid for that: an operator changing the outline colour would not reach a
 * river already drawn until the next sync. `.water-shape` in style.css sets
 * `stroke: var(--water-outline)` unconditionally instead, and `.water-hovered`
 * / `.water-selected` set `fill` the same way -- see useAppSettings.js for how
 * those three CSS custom properties are kept in step with the water.fill/
 * water.outline/water.selected palette tokens. Every colour a reader can see
 * on this layer is therefore live, not baked, and this function's only job is
 * the one thing that genuinely has to be decided per feature at creation time:
 * whether it is a line or a fill.
 */
function waterStyle(feature) {
  const geomType = feature?.geometry?.type || "";
  const isLine = geomType === "LineString" || geomType === "MultiLineString";
  return {
    className: "water-shape",
    weight: 1,
    fillOpacity: 0,
    opacity: isLine ? 0.55 : 0,
    interactive: false,
  };
}

export function createWaterLayer(map) {
  // Below countriesPane (350) so land outlines still win over a sea fill --
  // and above the default map panes (tilePane 200, overlayPane 400 sits
  // above this, which is fine: water is paint only, see the module note
  // above about interactive:false).
  if (!map.getPane("waterPane")) {
    map.createPane("waterPane").style.zIndex = 345;
  }
  // Not .addTo(map) here -- water ships MANUAL and off by default (see its
  // LAYER_MANIFEST entry in scene.js), so the control-panel checkbox is what
  // adds it, exactly as createRailwaysGroup leaves railwaysGroup unattached.
  return L.geoJSON(null, { style: waterStyle, pane: "waterPane" });
}

/**
 * Replace the layer's contents wholesale -- the same clear-then-addData
 * technique renderCountries and subdivisions.js use, and for the same
 * reason: a synced array is small enough (306 marine features; a few
 * thousand once lakes and rivers are switched on) that diffing feature by
 * feature buys nothing a full redraw does not already do in one pass.
 */
export function syncWater(layer, features) {
  layer.clearLayers();
  if (features?.length) layer.addData({ type: "FeatureCollection", features });
}

/**
 * A flat hit-test index over the water features currently synced, sorted so
 * the smallest feature containing a point is found first by findWaterAt.
 *
 * Marine polygons genuinely nest -- the Mediterranean contains the Aegean,
 * which contains the Saronic Gulf -- which is what `area_deg2` exists to
 * rank (see water_bodies.py's `_ring_area`/`_bbox_and_area` docstrings).
 * Sorting the whole index by area ascending and taking the first match is
 * the same technique buildCountryIndex uses for enclaves like Lesotho, and
 * it is exact for marine because every marine feature carries a real
 * `area_deg2`.
 *
 * Lakes carry no `area_deg2` at all -- water_bodies.py computes it for
 * marine only, since ranking nested polygons is a marine problem there (see
 * that module's `_build_collection`). Lakes still need *a* tie-break: they
 * nest nine times across 1,355 features, and never more than one level deep.
 *
 * An earlier revision of this function filled the gap with each entry's own
 * bounding-box area -- cheap, but a *different metric* from marine's real
 * ring-shoelace `area_deg2`, and a Task 6 review caught the real risk in
 * that: if a marine polygon and a lake ever nested (a landlocked marine
 * "sea", say, sharing ground with a lake Natural Earth also has drawn), the
 * two size numbers being compared would not mean the same thing, and the
 * smaller-first sort could pick the wrong one for no principled reason.
 * Checked against the live files during that review -- 306 marine features
 * against 1,355 lakes, 2,654 pairs sharing a bounding box, every one tested
 * for one feature's representative point (properly excluding island holes,
 * the way countryContainsPoint does) landing inside the other -- and none of
 * them nest as of that check. That is reassuring, not sufficient: Natural
 * Earth could ship a nesting pair in a future release, exactly the kind of
 * thing this codebase does not treat as ruled out just because today's file
 * does not exercise it (see water_bodies.py's own antimeridian/dedup notes
 * for the same discipline).
 *
 * So the fix is not "trust today's file" but `fallbackAreaDeg2` below: the
 * same shoelace formula water_bodies.py's `_ring_area`/`_bbox_and_area` use
 * for marine's stored `area_deg2`, run here in JS for whatever the backend
 * did not compute it for. Marine's real value and this computed one are the
 * same metric by construction, not by coincidence of today's geography, so
 * the single sort-then-first-match below is correct regardless of whether a
 * marine/lake nesting pair ever exists.
 *
 * Rivers are LineStrings (or MultiLineStrings), and containment by area does
 * not apply to a line at all: buildShapeIndex's own `polygonsOf` returns no
 * polygons for either geometry type, so a river never produces an entry
 * here in the first place. That is not a gap this function works around --
 * "is this point inside the line" is not a question a river can answer, and
 * findWaterAt is a point-in-polygon test. A river is drawn (see waterStyle
 * above) but not click- or hover-resolvable through this index.
 */
export function buildWaterIndex(features) {
  const entries = buildShapeIndex(features, (props) => ({
    id: props.id,
    name: props.name || "",
    class: props.class || "other",
    antimeridian: !!props.antimeridian,
    area_deg2: props.area_deg2,
    // The feature's own stored [south, west, north, east] (water_bodies.py's
    // _bbox; west > east means it wraps the antimeridian), kept under its own
    // key rather than `bbox` -- buildShapeIndex writes that key itself, from
    // the geometry, as {minLat,maxLat,minLon,maxLon} for this module's own
    // hit-testing, and a naive spread here would just be overwritten by it.
    // The two are different metrics for different jobs: `bbox` is a cheap
    // reject before a real ray-cast and tolerates being wrong-but-permissive
    // for an antimeridian-wrapping feature (see buildWaterIndex's own
    // docstring above); `rawBbox` is what Task 7's card uses for the
    // rectangle-overlap tests -- bordering countries, chokepoint overlap --
    // where a naive min/max would be wrong outright for the handful of
    // marine features that actually wrap (the Bering Sea, the Pacific...).
    rawBbox: Array.isArray(props.bbox) ? props.bbox : null,
  }));
  for (const entry of entries) {
    if (!Number.isFinite(entry.area_deg2)) entry.area_deg2 = fallbackAreaDeg2(entry.polygons);
  }
  entries.sort((a, b) => a.area_deg2 - b.area_deg2);
  return entries;
}

/**
 * The shoelace formula over one ring, in square degrees -- identical to
 * water_bodies.py's `_ring_area` (and to countryHitTest.js's own `ringArea`,
 * kept separate here rather than imported since neither module has another
 * reason to depend on the other, the same call `_walk_lonlat` makes in the
 * backend). Not a true area in km^2 for the same reason the backend's
 * docstring gives: nothing here corrects for a degree of longitude covering
 * less ground at high latitude than at the equator. It only has to rank two
 * shapes against each other, and it does.
 */
function shoelaceArea(ring) {
  let total = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    total += x1 * y2 - x2 * y1;
  }
  return Math.abs(total) / 2;
}

/**
 * `area_deg2`, computed the way water_bodies.py computes it for marine --
 * the outer ring's shoelace area, summed across every part of a
 * MultiPolygon -- for whichever kind the backend did not already compute it
 * for. See buildWaterIndex's docstring for why this replaced a
 * bounding-box approximation: the two size numbers a nesting tie-break
 * compares have to be the same metric, not merely both plausible.
 */
function fallbackAreaDeg2(polygons) {
  let area = 0;
  for (const rings of polygons) {
    const outer = rings[0];
    if (outer) area += shoelaceArea(outer);
  }
  return area;
}

/**
 * The smallest water body containing this point, or null. Same first-match-
 * wins technique findCountryAt uses, over an index already sorted smallest
 * first by buildWaterIndex -- see findCountryAt's own note on why that
 * ordering is what makes an enclave (there, Lesotho; here, the Saronic Gulf
 * inside the Aegean inside the Mediterranean) resolve to the specific one.
 */
export function findWaterAt(index, lat, lon) {
  for (const entry of index) {
    if (countryContainsPoint(entry, lat, lon)) return entry;
  }
  return null;
}

// Exported for map/popups.js's waterCardSections (Task 7's card), which
// labels the same `class` enum in its own "Water body" fold.
export const CLASS_LABEL = {
  ocean: "Ocean", sea: "Sea", gulf: "Gulf", bay: "Bay", strait: "Strait",
  channel: "Channel", sound: "Sound", lake: "Lake", river: "River", other: "Water",
};

// The 1:10m scale caveat, verbatim in the full card's profile fold
// (map/popups.js's buildWaterProfile) -- kept as its own constant so a future
// second caller can never say something subtly different about the same
// limitation than the first one does.
export const WATER_SCALE_CAVEAT =
  '<div class="meta">Boundary: Natural Earth 1:10m &mdash; generalised, schematic geometry, not ' +
  "aligned to any higher-resolution coastline or shoreline.</div>";
