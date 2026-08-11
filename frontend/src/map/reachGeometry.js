// What to draw for a dark-ship reachability record, without Leaflet.
//
// backend/sources/dark_vessels.py's ais_gap records carry `contours` (three
// nested GeoJSON polygons, see that module's docstring for the model) and,
// like gfw_gaps' ais_disabling records, a resumed_lat/resumed_lon once the
// gap has closed. Both are drawn in the shared uncertaintyPane (see
// createMapController.js's renderReachGeometry) -- this module only decides
// *what* the shapes are, in plain lat/lon, so that decision can be tested
// headlessly (see reachGeometry.test.js) the same way severity.js and
// collapse.js keep their own "what" apart from the Leaflet "how".

/**
 * The two ends of the went-dark -> resumed line, or null if the record does
 * not carry a usable resumption point. Both `ais_gap` and `ais_disabling`
 * records have one once their gap has closed -- see the modules that build
 * each.
 */
export function reachLineEnds(item) {
  if (!item) return null;
  const { lat, lon, resumed_lat: rLat, resumed_lon: rLon } = item;
  if (![lat, lon, rLat, rLon].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return [[lat, lon], [rLat, rLon]];
}

/**
 * The record's contour bands as plain [lat, lon] rings, tagged with the
 * percentile each one is. Only `ais_gap` records carry `contours` at all --
 * everything else returns an empty list rather than a guess.
 */
export function reachContourRings(item) {
  const contours = Array.isArray(item?.contours) ? item.contours : [];
  const rings = [];
  for (const contour of contours) {
    const raw = contour?.geometry?.coordinates?.[0];
    if (!Array.isArray(raw) || raw.length < 4) continue;
    const points = raw
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map(([lon, lat]) => [lat, lon]);
    if (points.length < 4) continue;
    rings.push({ percentile: contour?.properties?.percentile ?? null, points });
  }
  return rings;
}

/** Whether this record has anything at all worth drawing in the pane. */
export function reachOnScreen(item) {
  return reachLineEnds(item) !== null || reachContourRings(item).length > 0;
}
