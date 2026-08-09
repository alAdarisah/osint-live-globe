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
import { esc } from "../utils/format";

export function createSubdivisionsLayer(map) {
  // Between the country shapes (350) and the district choropleth (360): a state
  // border is drawn over its own country's fill, and under a district fill,
  // which is the more specific statement of the two.
  if (!map.getPane("subdivisionsPane")) {
    map.createPane("subdivisionsPane").style.zIndex = 355;
  }
  // One constant style, and every state that looks different from its
  // neighbours looks different by CSS class -- hover and selection are toggled
  // on the element by the controller, exactly as they are for countries. Not a
  // style function returning a class per feature: Leaflet applies `className`
  // when it first creates the path and never again, so a class computed in
  // `style` cannot change afterwards. Stroke and fill live in the stylesheet
  // for the same reason the country shapes' do -- a rule there beats the
  // presentation attributes Leaflet sets here, which is what lets the selected
  // outline win.
  const style = {
    className: "subdivision-shape",
    color: "#6fe3ff",
    weight: 1,
    fillColor: "#6fe3ff",
    fillOpacity: 0,
    interactive: false,
  };
  return L.geoJSON(null, { style: () => style, pane: "subdivisionsPane" });
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

/**
 * What a clicked state says.
 *
 * Deliberately short. This popup exists to confirm what was clicked and to name
 * the boundary's source; it is not a country card, and inventing a statistics
 * panel out of a boundary file would be claiming the geometry knows things it
 * does not. The scale is stated because it is the honest caveat: at 1:10m these
 * outlines are generalised to a few hundred metres and should not be read as a
 * cadastral border.
 *
 * `districtCount` is how many districts were drawn inside this state -- non-zero
 * only for the countries with OCHA admin-2 geometry, which is where the next
 * click down leads. Said in the popup because a set of fainter lines appearing
 * inside the state is not, on its own, an instruction to click one.
 */
export function subdivisionPopupHtml(entry, districtCount = 0) {
  const code = entry.code || (entry.postal ? `${entry.country_code}-${entry.postal}` : "");
  // Escaped part by part, then joined: escaping the joined string would escape
  // the separator's own ampersand and print "State &middot; Nigeria" literally.
  const meta = [entry.kind, entry.country].filter(Boolean).map(esc).join(" &middot; ");
  const districts = districtCount
    ? `<div class="meta">${districtCount} district${districtCount === 1 ? "" : "s"} drawn inside
        &mdash; click one for its monthly conflict record.</div>`
    : "";
  return `
    <h3>${esc(entry.name)}</h3>
    <div class="meta">${meta}${code ? ` &middot; ${esc(code)}` : ""}</div>
    ${districts}
    <div class="meta">Boundary: Natural Earth admin-1, 1:10m &mdash; generalised to a few hundred
      metres, so it marks which state a point is in rather than exactly where the line runs.</div>`;
}
