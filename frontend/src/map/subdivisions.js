// States and provinces -- the layer that appears when a country is selected.
//
// Selecting the United States used to hand the reader one shape covering nine
// million square kilometres. That answers "which country" and stops; almost
// everything reported about the place is reported by state, and the state is
// the outline a reader already has in their head. So the moment a country with
// stored admin-1 geometry is selected, its internal borders are drawn, and each
// one is clickable in its own right.
//
// Tied to the country selection rather than given a checkbox in the layers
// panel, because it is not a layer in the sense the others are: subdivisions of
// a country nobody has selected are lines with nothing to say. Selecting the
// country *is* the request for them, and deselecting it is the request to stop
// -- which is also why nothing here is persisted in settings.
//
// Geometry from Natural Earth via /api/admin1-boundaries; see
// backend/sources/admin1_boundaries.py for why that source and not OCHA's.
//
// Hit-testing follows the same arrangement as the countries and the districts:
// the shapes are drawn `interactive: false` and clicks are resolved against the
// geometry from the map's own handler, so a state's fill can never swallow a
// click meant for a pin standing on it. See countryHitTest.js for the full
// reason that has to be done this way.

import { L } from "./leafletGlobal";
import { buildShapeIndex, countryContainsPoint } from "./countryHitTest";

/**
 * @param getFill  (properties) => {fillColor, fillOpacity} | null, the state
 *   choropleth's own styleFor (see map/choropleth.js). Same contract as
 *   createCountriesLayer's getFill in layers.js -- null leaves the shape
 *   unpainted, which is how an unmeasured state stays visually distinct from
 *   one measured at zero. Defaulted, so a caller that wants no fill (every
 *   caller until Task 26 generalised the choropleth to a target) can omit it.
 */
export function createSubdivisionsLayer(map, getFill = () => null) {
  // Between the country shapes (350) and the district choropleth (360): a state
  // border is drawn over its own country's fill, and under a district fill,
  // which is the more specific statement of the two.
  if (!map.getPane("subdivisionsPane")) {
    map.createPane("subdivisionsPane").style.zIndex = 355;
  }
  // Stroke and the CSS-toggled classes (.hovered, .subdivision-selected) still
  // live in the stylesheet and still win over whatever is set here, exactly as
  // the long comment above used to say -- fillColor/fillOpacity are the only
  // things a metric may move, the same restriction createCountriesLayer's own
  // countryStyle places on itself, and for the same reason: a metric that could
  // reach the stroke or the interactive flag could break hover, selection or
  // hit-testing from a dropdown.
  function subdivisionStyle(feature) {
    const fill = feature && feature.properties ? getFill(feature.properties) : null;
    return {
      className: "subdivision-shape",
      color: "#6fe3ff",
      weight: 1,
      fillColor: (fill && fill.fillColor) || "#6fe3ff",
      fillOpacity: fill ? fill.fillOpacity : 0,
      interactive: false,
    };
  }
  return L.geoJSON(null, { style: subdivisionStyle, pane: "subdivisionsPane" });
}

/**
 * A stable identity for one subdivision.
 *
 * `key` is assigned by the collector and is the one field guaranteed unique
 * within a country -- ISO 3166-2 is not, because Natural Earth gives a capital
 * cut out of its surrounding region the region's own code (see _assign_keys in
 * backend/sources/admin1_boundaries.py). Selecting on the code alone highlighted
 * Lima the province and Lima the city together.
 *
 * The fallbacks are for geometry stored before that field existed: the code,
 * then country plus name for the handful of Chinese and Indonesian entries that
 * publish no code at all. Dropping those instead would leave holes in an
 * otherwise complete country, and a hole is indistinguishable from sea.
 */
export function subdivisionKeyOf(props) {
  return props.key || props.code || `${props.country_code || "??"}:${props.name || ""}`;
}

export function buildSubdivisionIndex(features) {
  return buildShapeIndex(features, (props) => ({
    key: subdivisionKeyOf(props),
    code: props.code || "",
    name: props.name || "",
    postal: props.postal || "",
    kind: props.kind || "",
    country_code: props.country_code || "",
    country: props.country || "",
  }));
}

/**
 * The subdivision containing this point, or null.
 *
 * A flat first-match scan, like the districts': states partition their country
 * rather than nest inside one another, so no ordering is needed to make the
 * answer the specific one. Restricted to the countries whose subdivisions are
 * currently drawn, so a click cannot select a state of a country nobody
 * selected -- the index holds every country loaded this session, and those stay
 * loaded after they are deselected.
 */
export function findSubdivisionAt(index, lat, lon, countryCodes = null) {
  for (const entry of index) {
    if (countryCodes && !countryCodes.has(entry.country_code)) continue;
    if (countryContainsPoint(entry, lat, lon)) return entry;
  }
  return null;
}

// The 1:10m scale caveat -- kept as its own constant, verbatim, so the card's
// coverage fold (map/popups.js's buildAdminCoverage) can never say something
// subtly different about this limitation than the sentence that used to live
// in this module's own popup. Same discipline water.js's WATER_SCALE_CAVEAT
// follows, for the same reason: one sentence, one place it is actually
// written, every caller quotes it.
//
// The scale is stated because it is the honest caveat: at 1:10m these outlines
// are generalised to a few hundred metres and should not be read as a
// cadastral border.
export const SUBDIVISION_SCALE_CAVEAT =
  "Boundary: Natural Earth admin-1, 1:10m &mdash; generalised to a few hundred metres, so it marks " +
  "which state a point is in rather than exactly where the line runs.";
