// The shared hit-test index, asserted.
//
// buildShapeIndex now backs three layers -- countries, districts and admin-1
// subdivisions -- and every click and hover on the map goes through the
// bounding box it builds. A wrong box fails silently in the worst way: the
// shape is still drawn, still looks clickable, and simply does not answer,
// which is indistinguishable from "nothing there".
//
// map/countryHitTest.js imports nothing, which is what lets this run under
// `node --test` -- the same constraint scene.test.js documents.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildShapeIndex, countryContainsPoint, findCountryAt, buildCountryIndex,
  representativePointOf,
} from "../src/map/countryHitTest.js";

const square = (x, y, size = 2) => ({
  type: "Polygon",
  coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]],
});

const feature = (properties, geometry) => ({ type: "Feature", properties, geometry });

test("carries the caller's fields through and computes a box per shape", () => {
  const index = buildShapeIndex(
    [feature({ code: "US-TX", name: "Texas" }, square(-100, 30))],
    (props) => ({ key: props.code, name: props.name })
  );
  assert.equal(index.length, 1);
  assert.equal(index[0].key, "US-TX");
  assert.equal(index[0].name, "Texas");
  assert.deepEqual(index[0].bbox, { minLat: 30, maxLat: 32, minLon: -100, maxLon: -98 });
});

test("spans every part of a multipolygon", () => {
  // Alaska's shape is the reason this matters: a box built from the first
  // polygon alone leaves the rest of the state unclickable.
  const [entry] = buildShapeIndex([feature({}, {
    type: "MultiPolygon",
    coordinates: [square(0, 0).coordinates, square(10, 10).coordinates],
  })]);
  assert.deepEqual(entry.bbox, { minLat: 0, maxLat: 12, minLon: 0, maxLon: 12 });
  assert.equal(countryContainsPoint(entry, 11, 11), true);
  assert.equal(countryContainsPoint(entry, 5, 5), false);  // between the two parts
});

test("skips features with no usable geometry rather than indexing a hole", () => {
  const index = buildShapeIndex([
    feature({ key: "a" }, null),
    feature({ key: "b" }, { type: "Point", coordinates: [1, 2] }),
    feature({ key: "c" }, square(0, 0)),
  ], (props) => ({ key: props.key }));
  assert.deepEqual(index.map((e) => e.key), ["c"]);
});

test("a hole in a shape is outside it", () => {
  const [entry] = buildShapeIndex([feature({}, {
    type: "Polygon",
    coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
    ],
  })]);
  assert.equal(countryContainsPoint(entry, 1, 1), true);
  assert.equal(countryContainsPoint(entry, 5, 5), false);
});

// The district-into-state assignment the drill-down runs (assignDistrictStates
// in createMapController.js) is these two functions in sequence: a point known
// to be inside the child, then the parent containing that point. It is done in
// geometry because the two sources name the same province differently -- OCHA's
// district records agree with Natural Earth's province name for 325 of
// Afghanistan's 401 districts, so a name join would drop the other 76.
test("a concave shape's representative point is inside it, and inside its parent", () => {
  // An L, whose bounding-box centre is in the notch -- outside the shape, and
  // for a real district (one wrapped round a river bend) in the neighbouring
  // one. Taking the bbox centre would file it under the wrong province.
  const bend = {
    type: "Polygon",
    coordinates: [[[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6], [0, 0]]],
  };
  const [child] = buildShapeIndex([feature({ pcode: "AF0101" }, bend)]);
  assert.deepEqual(child.bbox, { minLat: 0, maxLat: 6, minLon: 0, maxLon: 6 });
  assert.equal(countryContainsPoint(child, 3, 3), false);  // the bbox centre

  const point = representativePointOf(child);
  assert.equal(countryContainsPoint(child, point.lat, point.lon), true);

  const parents = buildShapeIndex([
    feature({ key: "AF-KAB" }, square(0, 0, 8)),
    feature({ key: "AF-PAR" }, square(20, 20, 8)),
  ], (props) => ({ key: props.key }));
  const parent = parents.find((p) => countryContainsPoint(p, point.lat, point.lon));
  assert.equal(parent.key, "AF-KAB");
});

test("a shape outside every parent gets no parent rather than the nearest one", () => {
  // Ukraine's Crimean raions in practice: OCHA files them under Ukraine and
  // Natural Earth files Crimea under Russia, so they sit inside no Ukrainian
  // province. Unassigned is the honest answer -- they stay reachable through
  // the archive layer instead of being filed under a province they are not in.
  const [orphan] = buildShapeIndex([feature({}, square(50, 50))]);
  const point = representativePointOf(orphan);
  const parents = buildShapeIndex([feature({ key: "UA-01" }, square(0, 0, 8))],
    (props) => ({ key: props.key }));
  assert.equal(parents.some((p) => countryContainsPoint(p, point.lat, point.lon)), false);
});

test("the country index still answers with the smallest shape containing the point", () => {
  // The one thing buildCountryIndex adds on top: an enclave wholly inside
  // another country has to win the tie, or it can never be selected.
  const index = buildCountryIndex({
    features: [
      feature({ iso_a2: "ZA", name: "South Africa" }, square(20, -30, 10)),
      feature({ iso_a2: "LS", name: "Lesotho" }, square(27, -30, 1)),
    ],
  });
  assert.equal(findCountryAt(index, -29.5, 27.5).key, "LS");
  assert.equal(findCountryAt(index, -25, 22).key, "ZA");
  assert.equal(findCountryAt(index, 40, 40), null);
});
