// Task 25: map/groundTrack.js -- footprintRadiusKm, and the piece the
// brief calls out by name, antimeridian splitting. A ground track is drawn
// as one or more L.polyline segments (see createMapController.js), and a
// path that crosses +-180 degrees without being cut there draws a line the
// wrong way round the entire map instead of a short hop over the seam --
// splitAtAntimeridian is the fix, and this file is its coverage.

import test from "node:test";
import assert from "node:assert/strict";

import { footprintRadiusKm, splitAtAntimeridian, groundTrackPoints, groundTrackSegments } from "../src/map/groundTrack.js";
import { satrecFromElements } from "../src/map/satPropagate.js";

// --- footprintRadiusKm -------------------------------------------------------

test("footprint radius is zero at zero or negative altitude", () => {
  assert.equal(footprintRadiusKm(0), 0);
  assert.equal(footprintRadiusKm(-10), 0);
  assert.equal(footprintRadiusKm(NaN), 0);
  assert.equal(footprintRadiusKm(undefined), 0);
});

test("footprint radius grows with altitude", () => {
  const leo = footprintRadiusKm(400); // ISS-ish
  const meo = footprintRadiusKm(20200); // GPS-ish
  const geo = footprintRadiusKm(35786);
  assert.ok(leo > 0);
  assert.ok(meo > leo);
  assert.ok(geo > meo);
});

test("footprint radius matches the standard spherical-horizon formula at a known altitude", () => {
  // R * acos(R / (R + h)) at h=400km, R=6371.0088km -- computed independently
  // (not copied from the implementation) to cross-check the formula, the
  // same discipline satPropagate.test.js applies against skyfield.
  const R = 6371.0088;
  const h = 400;
  const expected = R * Math.acos(R / (R + h));
  assert.ok(Math.abs(footprintRadiusKm(h) - expected) < 1e-6);
});

// --- splitAtAntimeridian -----------------------------------------------------

test("a path that never crosses the seam is one unbroken segment", () => {
  const points = [
    [10, 170],
    [11, 175],
    [12, 178],
  ];
  const segments = splitAtAntimeridian(points);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0], points);
});

test("empty and single-point paths are handled without throwing", () => {
  assert.deepEqual(splitAtAntimeridian([]), []);
  assert.deepEqual(splitAtAntimeridian([[5, 5]]), [[[5, 5]]]);
});

test("an eastward crossing (179 -> -179) splits into two segments meeting at the +-180 edges", () => {
  const points = [
    [0, 179],
    [1, -179], // wrapped past +180
    [2, -170],
  ];
  const segments = splitAtAntimeridian(points);
  assert.equal(segments.length, 2);

  const first = segments[0];
  const second = segments[1];
  // The first segment ends exactly at the +180 edge...
  assert.equal(first[first.length - 1][1], 180);
  // ...and the second begins exactly at the -180 edge, on the same latitude
  // (a cut, not a gap or a jump).
  assert.equal(second[0][1], -180);
  assert.equal(first[first.length - 1][0], second[0][0]);
  // The crossing latitude is between the two real samples that bracket it
  // (0 and 1), not outside that range.
  const crossingLat = first[first.length - 1][0];
  assert.ok(crossingLat > 0 && crossingLat < 1);
  // Every real input point still appears somewhere in the output, in order.
  assert.deepEqual(first[0], [0, 179]);
  assert.deepEqual(second[1], [1, -179]);
  assert.deepEqual(second[2], [2, -170]);
});

test("a westward crossing (-179 -> 179) splits the other way, at the same two edges", () => {
  const points = [
    [5, -179],
    [6, 179], // wrapped past -180
  ];
  const segments = splitAtAntimeridian(points);
  assert.equal(segments.length, 2);
  assert.equal(segments[0][segments[0].length - 1][1], -180);
  assert.equal(segments[1][0][1], 180);
});

test("a path with two crossings splits into three segments", () => {
  const points = [
    [0, 170],
    [1, -175], // crossing 1, eastward
    [2, -160],
    [3, 175], // crossing 2, westward
    [4, 160],
  ];
  const segments = splitAtAntimeridian(points);
  assert.equal(segments.length, 3);
});

test("a large longitude delta that is not really a crossing (a big real jump under 180 degrees) is not split", () => {
  // 170 to -170 is a 340-degree delta the long way but only a 20-degree
  // delta the short way through the seam -- this IS a real crossing and
  // must split. Contrast: 90 to -90 is a 180-degree delta either way, which
  // this module treats as not a crossing (strictly greater than 180 is the
  // trigger), matching a satellite that legitimately covered a wide swath
  // in one sample without touching the seam at all.
  const points = [
    [0, 90],
    [1, -90],
  ];
  const segments = splitAtAntimeridian(points);
  assert.equal(segments.length, 1);
});

// --- groundTrackPoints / groundTrackSegments, against a real propagated orbit ---
//
// Same ISS element set satPropagate.test.js validates against skyfield --
// reused here rather than a second hand-built fixture, so this test is
// exercising the real propagation path, not a stand-in for it.

const ISS_OMM = {
  OBJECT_NAME: "ISS (ZARYA)",
  OBJECT_ID: "1998-067A",
  NORAD_CAT_ID: 25544,
  EPOCH: "2026-08-09T12:00:00.000000",
  MEAN_MOTION: 15.50377579,
  ECCENTRICITY: 0.0006703,
  INCLINATION: 51.6416,
  RA_OF_ASC_NODE: 339.7760,
  ARG_OF_PERICENTER: 55.6485,
  MEAN_ANOMALY: 304.5486,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: "U",
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 12345,
  BSTAR: 0.00021019,
  MEAN_MOTION_DOT: 0.00016717,
  MEAN_MOTION_DDOT: 0,
};
const T0 = new Date("2026-08-09T12:30:00.000Z");

test("groundTrackPoints covers the full previous/next window at the requested step", () => {
  const satrec = satrecFromElements(ISS_OMM);
  const points = groundTrackPoints(satrec, T0, { beforeMin: 90, afterMin: 90, stepMin: 1 });
  // 90 before + 90 after + the center sample itself, one per minute.
  assert.equal(points.length, 181);
  for (const [lat, lon] of points) {
    assert.ok(lat >= -90 && lat <= 90);
    assert.ok(lon >= -180 && lon <= 180);
  }
});

test("groundTrackSegments splits ISS's real +-90-minute track at the antimeridian", () => {
  // ISS orbits roughly every 92 minutes, so a 3-hour window is a little
  // over two full orbits -- with its ground track sweeping west a
  // significant distance each pass, it is expected (not a fluke of this
  // particular window) to cross +-180 more than once.
  const satrec = satrecFromElements(ISS_OMM);
  const segments = groundTrackSegments(satrec, T0, { beforeMin: 90, afterMin: 90, stepMin: 1 });
  assert.ok(segments.length >= 2, `expected at least one antimeridian crossing, got ${segments.length} segment(s)`);
  // Every segment for real is non-empty and every point is a valid lat/lon.
  for (const segment of segments) {
    assert.ok(segment.length > 0);
    for (const [lat, lon] of segment) {
      assert.ok(lat >= -90 && lat <= 90);
      assert.ok(lon >= -180 && lon <= 180);
    }
  }
});
