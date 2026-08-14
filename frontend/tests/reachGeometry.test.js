// What createMapController.js's renderReachGeometry draws, decided headlessly.
//
// reachGeometry.js imports nothing beyond plain JS, which is what lets this
// run under `node --test` with no bundler and no Leaflet -- the same
// constraint shapeIndex.test.js documents for countryHitTest.js.

import test from "node:test";
import assert from "node:assert/strict";

import { reachLineEnds, reachContourRings, reachOnScreen } from "../src/map/reachGeometry.js";

function gapRecord(overrides = {}) {
  return {
    lat: 26.0, lon: 56.0,
    resumed_lat: 26.3, resumed_lon: 56.4,
    contours: [
      {
        properties: { percentile: 50 },
        geometry: { type: "Polygon", coordinates: [[[56.0, 26.0], [56.1, 26.0], [56.1, 26.1], [56.0, 26.1], [56.0, 26.0]]] },
      },
    ],
    ...overrides,
  };
}

test("the went-dark -> resumed line is both ends, lat/lon in that order", () => {
  assert.deepEqual(reachLineEnds(gapRecord()), [[26.0, 56.0], [26.3, 56.4]]);
});

test("no resumption point yields no line", () => {
  assert.equal(reachLineEnds(gapRecord({ resumed_lat: undefined, resumed_lon: undefined })), null);
  assert.equal(reachLineEnds(null), null);
  assert.equal(reachLineEnds({ lat: 1, lon: 2, resumed_lat: "not a number", resumed_lon: 3 }), null);
});

test("a contour ring is flipped from GeoJSON's [lon, lat] to [lat, lon]", () => {
  const [ring] = reachContourRings(gapRecord());
  assert.equal(ring.percentile, 50);
  assert.deepEqual(ring.points[0], [26.0, 56.0]);
  assert.deepEqual(ring.points[2], [26.1, 56.1]);
});

test("a record with no contours (gfw_gaps, or an sts_pair) yields no rings", () => {
  assert.deepEqual(reachContourRings({ lat: 1, lon: 2 }), []);
  assert.deepEqual(reachContourRings({ contours: [] }), []);
});

test("a degenerate ring (fewer than 3 real vertices) is dropped rather than drawn", () => {
  const item = {
    contours: [{ properties: { percentile: 50 }, geometry: { type: "Polygon", coordinates: [[[56.0, 26.0], [56.1, 26.1]]] } }],
  };
  assert.deepEqual(reachContourRings(item), []);
});

test("on-screen is true with either a line, contours, or both -- false with neither", () => {
  assert.equal(reachOnScreen(gapRecord()), true);
  assert.equal(reachOnScreen(gapRecord({ contours: [] })), true); // line alone
  assert.equal(reachOnScreen({ lat: 1, lon: 2, contours: gapRecord().contours }), true); // contours alone
  assert.equal(reachOnScreen({ lat: 1, lon: 2 }), false);
});
