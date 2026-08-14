// Task 25: the pure geometry behind a satellite card's ground track and
// visibility footprint. No Leaflet and no DOM in this file on purpose --
// the same "pure function first" split satPropagate.js already draws
// between propagation arithmetic (testable with node --test, no browser)
// and the map wiring that calls it (createMapController.js, which turns
// this module's plain arrays into L.polyline/L.circle).
//
// Everything here is derived, not measured: a ground track is SGP4
// propagation replayed across a two-hour window around "now", and a
// footprint is arithmetic over one instant's altitude. Both inherit the
// same accuracy ceiling a live position does -- an element set hours old
// propagates well, one weeks old does not -- so a caller drawing either of
// these should say how old the underlying element set's epoch is (see
// decorators.js's epochAgeHours), not present the line/circle as a
// measurement.

import { propagateToLatLonAlt } from "./satPropagate.js";

// Earth's mean radius, WGS84 -- matches backend/sources/proximity.py's
// EARTH_RADIUS_KM and backend/sources/sat_passes.py's own copy of this same
// formula (footprint_radius_km), kept in step by hand since there is no
// module shared between a Python process and a browser bundle. The same
// discipline backend/app.py's _matches_callsign_query documents for its own
// client-side twin.
export const EARTH_RADIUS_KM = 6371.0088;

/**
 * Great-circle radius (km) of the ground within line of sight of a
 * satellite at `altKm` altitude.
 *
 * The standard spherical-horizon formula: R * acos(R / (R + h)), where R is
 * Earth's radius and h is the satellite's altitude above it. This is the
 * radius of the visibility *cap* -- the largest circle centred on the
 * sub-satellite point from which the satellite could, geometrically, be
 * seen at zero elevation (an idealised horizon with no terrain, atmosphere,
 * or minimum-elevation floor, unlike backend/sources/sat_passes.py's
 * PASS_MIN_ELEVATION_DEG, which is a stricter, practical cutoff for a real
 * pass prediction rather than this card's "how far could this satellite
 * possibly be seen" circle).
 */
export function footprintRadiusKm(altKm) {
  if (!Number.isFinite(altKm) || altKm <= 0) return 0;
  return EARTH_RADIUS_KM * Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altKm));
}

/**
 * `points` (an array of [lat, lon] pairs, lon always in [-180, 180] -- what
 * satellite.js's degreesLong returns, see satPropagate.js's
 * eciToLatLonAlt), split into one array per segment wherever the path
 * crosses the antimeridian.
 *
 * A ground track is drawn as an ordinary L.polyline, on the map's one
 * primary copy of the world (unlike a marker, which createMapController.js
 * redraws once per visible copy via drawLatLng/worldCopies -- a short,
 * selection-only line has no need for that). Leaflet draws a polyline as
 * straight segments between its given points in whatever coordinate space
 * they are given in, with no awareness that longitude wraps -- so hand it
 * a track that goes ...179, -179... and it draws a line all the way across
 * the map, the wrong way round the globe, instead of a short hop over the
 * seam. Splitting into separate polylines at the crossing is the fix: two
 * short segments, one ending at the +180 edge and the next starting at the
 * -180 edge, with no line drawn between them.
 *
 * Unlike utils/geo.js's unwrapPath (which keeps a single path continuous by
 * shifting each point onto the copy of the world nearest the one before
 * it -- the right answer for a marker's own placement, or a path meant to
 * be shifted onto a *different* on-screen copy by shiftPathLon), this
 * function is for a path drawn on its own single copy: there is nothing to
 * shift it onto, so the seam has to be cut instead.
 *
 * The crossing point itself is interpolated (linearly, in lat) rather than
 * just cut, so each segment reaches all the way to its edge of the map
 * instead of stopping short of it -- a ground track that visibly stopped a
 * few pixels before 180 degrees would look like missing data rather than
 * the map's own repeating edge.
 */
export function splitAtAntimeridian(points) {
  if (!points || points.length === 0) return [];
  const segments = [];
  let current = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [lat0, lon0] = current[current.length - 1];
    const [lat1, lon1] = points[i];
    const delta = lon1 - lon0;
    if (Math.abs(delta) > 180) {
      // A jump bigger than half the world in one sample step is the seam,
      // not real motion -- no orbit moves that fast in longitude between
      // consecutive ground-track samples (see groundTrackPoints' stepMin).
      const goingEast = delta < 0; // lon1 reads smaller only because it wrapped past +180
      const edgeFrom = goingEast ? 180 : -180;
      const edgeTo = goingEast ? -180 : 180;
      // Put lon1 back on the same continuous line as lon0 so the crossing
      // fraction can be read off a straight interpolation between them.
      const unwrappedLon1 = goingEast ? lon1 + 360 : lon1 - 360;
      const span = unwrappedLon1 - lon0;
      const frac = span === 0 ? 0 : (edgeFrom - lon0) / span;
      const crossingLat = lat0 + (lat1 - lat0) * frac;
      current.push([crossingLat, edgeFrom]);
      segments.push(current);
      current = [[crossingLat, edgeTo], [lat1, lon1]];
    } else {
      current.push([lat1, lon1]);
    }
  }
  segments.push(current);
  return segments;
}

/**
 * The sub-satellite point at each sample between `beforeMin` minutes before
 * `centerDate` and `afterMin` minutes after it, `stepMin` apart -- the raw
 * material for a ground track, before antimeridian splitting.
 *
 * `satrec` propagates equally well backwards and forwards from its own
 * epoch (SGP4 has no notion of "the past" or "the future", only an offset
 * from epoch), so the "previous 90 minutes" half of the brief's window is
 * exactly as real a propagation as the "next 90 minutes" half -- neither is
 * a measurement, both are the same arithmetic run at a different offset.
 *
 * A sample the propagator cannot resolve (decayed, or briefly unpropagable)
 * is skipped rather than breaking the whole track -- see
 * satPropagate.js's propagateToLatLonAlt, which already returns null for
 * exactly that case.
 */
export function groundTrackPoints(satrec, centerDate, { beforeMin = 90, afterMin = 90, stepMin = 1 } = {}) {
  const points = [];
  const centerMs = centerDate.getTime();
  for (let m = -beforeMin; m <= afterMin; m += stepMin) {
    const fix = propagateToLatLonAlt(satrec, new Date(centerMs + m * 60_000));
    if (fix) points.push([fix.lat, fix.lon]);
  }
  return points;
}

/** groundTrackPoints, already split at the antimeridian -- what
 *  createMapController.js actually draws, one L.polyline per segment. */
export function groundTrackSegments(satrec, centerDate, options) {
  return splitAtAntimeridian(groundTrackPoints(satrec, centerDate, options));
}
