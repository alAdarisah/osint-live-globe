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
import { waterFillColor, waterOutlineColor } from "./decorators";
import { esc } from "../utils/format";

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
 * The colours themselves come from the palette (water.fill/water.outline),
 * so an operator's choice reaches the map without a resync -- but only for
 * this baked, at-creation-time value. The hover/selected CSS classes below
 * read the *same* tokens through CSS custom properties useAppSettings.js
 * pushes onto <html>, which is what lets a colour change reach an
 * already-hovered or already-selected shape without ever calling setStyle.
 */
function waterStyle(feature) {
  const geomType = feature?.geometry?.type || "";
  const isLine = geomType === "LineString" || geomType === "MultiLineString";
  return {
    className: "water-shape",
    color: waterOutlineColor(),
    weight: 1,
    fillColor: waterFillColor(),
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
 * marine only, since ranking nested polygons is a marine problem (see that
 * module's `_build_collection`). Lakes still need *a* tie-break: they nest
 * nine times across 1,355 features, and never more than one level deep. The
 * choice here is each entry's own bounding-box area
 * (`(maxLat-minLat)*(maxLon-minLon)`), computed below rather than a true
 * ring area, for two reasons: buildShapeIndex already puts a bbox on every
 * entry with nothing further to compute, and one level of nesting means
 * there is only ever one comparison to make -- a bbox is already the right
 * answer to "which of these two is bigger" that often. A real ring-area
 * function would earn its cost only if lakes nested more deeply or more
 * often than they do.
 *
 * A marine `area_deg2` and a lake's bbox-area approximation are never
 * compared against each other in practice -- nothing in this dataset nests a
 * marine polygon inside a lake or a lake inside a sea -- so the two
 * tie-break bases only ever have to rank correctly within their own kind,
 * which they do.
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
  }));
  for (const entry of entries) {
    if (!Number.isFinite(entry.area_deg2)) {
      const b = entry.bbox;
      entry.area_deg2 = (b.maxLat - b.minLat) * (b.maxLon - b.minLon);
    }
  }
  entries.sort((a, b) => a.area_deg2 - b.area_deg2);
  return entries;
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

const CLASS_LABEL = {
  ocean: "Ocean", sea: "Sea", gulf: "Gulf", bay: "Bay", strait: "Strait",
  channel: "Channel", sound: "Sound", lake: "Lake", river: "River", other: "Water",
};

/**
 * What a clicked water body says. Deliberately as short as
 * subdivisionPopupHtml -- this confirms what was clicked and names the
 * source and its scale caveat; Task 7 gives it a full card.
 */
export function waterPopupHtml(entry) {
  const label = CLASS_LABEL[entry.class] || "Water";
  return `
    <h3>${esc(entry.name || label)}</h3>
    <div class="meta">${esc(label)}</div>
    <div class="meta">Boundary: Natural Earth 1:10m &mdash; generalised, schematic geometry, not
      aligned to any higher-resolution coastline or shoreline.</div>`;
}
