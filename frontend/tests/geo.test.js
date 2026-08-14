// Longitude wrapping, asserted.
//
// This is four lines of arithmetic holding up seamless horizontal panning, and
// every way it can be wrong is silent. Pick the wrong copy of the world and a
// layer simply draws nothing, or draws a trail 20,000 km across the map, or
// puts a ship a world to the left of the camera. None of that raises an error,
// and none of it is visible unless you happen to pan across the antimeridian --
// which is the one part of the map nobody checks.
//
// utils/geo.js imports nothing, so this runs under `node --test` with no
// bundler, the same constraint scene.test.js documents.

import test from "node:test";
import assert from "node:assert/strict";

import {
  nearestLon, unwrapPath, boundsContainsPoint, padBounds, pathExtent, extentInView,
} from "../src/utils/geo.js";

test("nearestLon", async (t) => {
  await t.test("leaves a longitude already nearest the camera alone", () => {
    assert.equal(nearestLon(10, 0), 10);
    assert.equal(nearestLon(-170, -179), -170);
    assert.equal(nearestLon(0, 0), 0);
  });

  // The case the whole thing exists for: the camera is just east of the
  // antimeridian, and a point stored just west of it is 2 degrees away, not 358.
  await t.test("brings a point across the antimeridian to the near copy", () => {
    assert.equal(nearestLon(-179, 179), 181);
    assert.equal(nearestLon(179, -179), -181);
  });

  await t.test("handles a camera several worlds out", () => {
    assert.equal(nearestLon(0, 720), 720);
    assert.equal(nearestLon(10, -350), 10 - 360);
  });

  // Exactly half a world away is a tie. Either copy is equally correct and the
  // only thing that matters is that it answers rather than looping or throwing.
  await t.test("answers for a point exactly opposite the camera", () => {
    const answer = nearestLon(0, 180);
    assert.ok(Number.isFinite(answer));
    assert.ok(Math.abs(answer - 180) <= 180);
  });

  await t.test("passes a missing coordinate straight through", () => {
    assert.equal(nearestLon(undefined, 0), undefined);
    assert.equal(nearestLon(NaN, 0) !== nearestLon(NaN, 0), true); // NaN, unchanged
    assert.equal(nearestLon(10, undefined), 10);
  });
});

test("unwrapPath", async (t) => {
  await t.test("leaves a path that never crosses the seam alone", () => {
    const path = [[0, 10], [0, 11], [0, 12]];
    assert.deepEqual(unwrapPath(path, 11), path);
  });

  // A tanker steaming east past 180. Drawn from the raw points this is a
  // 359-degree jump straight back across the map; unwrapped it is half a degree
  // in the direction it was already going.
  await t.test("keeps a track going in the direction it was travelling", () => {
    const raw = [[50, 179.5], [50, 179.9], [50, -179.7], [50, -179.3]];
    const path = unwrapPath(raw, 179.5);
    const steps = path.slice(1).map(([, lon], i) => lon - path[i][1]);
    for (const step of steps) assert.ok(Math.abs(step) < 1, `jumped ${step} degrees`);
    assert.deepEqual(path.map(([, lon]) => Number(lon.toFixed(1))), [179.5, 179.9, 180.3, 180.7]);
  });

  await t.test("anchors the first point to the camera", () => {
    // Camera east of the seam; a track stored west of it is drawn on the copy
    // being looked at rather than a world away.
    const path = unwrapPath([[0, -179], [0, -178]], 179);
    assert.deepEqual(path, [[0, 181], [0, 182]]);
  });

  await t.test("survives an empty or single-point track", () => {
    assert.deepEqual(unwrapPath([], 0), []);
    assert.deepEqual(unwrapPath([[1, 2]], 0), [[1, 2]]);
  });
});

// Unchanged behaviour, guarded because nearestLon landed in the same file and
// these two are what the React side filters on.
test("plain-object bounds helpers", () => {
  const bounds = { south: 0, west: 0, north: 10, east: 10 };
  assert.equal(boundsContainsPoint(bounds, 5, 5), true);
  assert.equal(boundsContainsPoint(bounds, 5, 11), false);
  assert.deepEqual(padBounds(bounds, 0.5), { south: -5, west: -5, north: 15, east: 15 });
});

// The line counterpart to boundsContainsPoint, added when the pipeline layer
// stopped drawing all 16,749 of its routes on every pan (see renderPipelines).
// The failure these guard against is the one the layer's own comment warns
// about: filter a line the way you filter a point and you delete the long trunk
// routes, which are the ones worth keeping.
test("pathExtent", async (t) => {
  await t.test("is the box the path fits in", () => {
    assert.deepEqual(
      pathExtent([[10, 20], [-5, 40], [3, -8]]),
      { south: -5, west: -8, north: 10, east: 40 }
    );
  });

  await t.test("ignores points that are not finite coordinates", () => {
    assert.deepEqual(
      pathExtent([[10, 20], [NaN, 5], [null, null], [12, 22]]),
      { south: 10, west: 20, north: 12, east: 22 }
    );
  });

  await t.test("is null when there is nothing usable, not an empty box", () => {
    // A degenerate box would compare as "outside the view" by arithmetic
    // accident. Null makes the rejection deliberate.
    assert.equal(pathExtent([]), null);
    assert.equal(pathExtent([[NaN, NaN]]), null);
    assert.equal(pathExtent(undefined), null);
  });

  await t.test("describes a line across the antimeridian as a continuous span", () => {
    // The failure this exists for: plain min/max over these four longitudes
    // gives west -175, east 175 -- the whole world except the twenty degrees the
    // route is actually in, which is precisely inverted. Unwrapping gives the
    // real span, and it is allowed to run past 180.
    assert.deepEqual(
      pathExtent([[5, 170], [5, 175], [5, -175], [5, -170]]),
      { south: 5, west: 170, north: 5, east: 190 }
    );
  });
});

test("extentInView", async (t) => {
  const view = { south: 0, west: 0, north: 10, east: 10 };

  await t.test("keeps a line crossing the view with both ends outside it", () => {
    // The whole reason this is not a per-vertex test: neither endpoint is in
    // view, and the line runs straight through the middle of it.
    assert.equal(extentInView({ south: 5, west: -20, north: 5, east: 30 }, view, 5), true);
  });

  await t.test("keeps a line that merely touches an edge", () => {
    assert.equal(extentInView({ south: 10, west: 10, north: 12, east: 12 }, view, 5), true);
  });

  await t.test("drops one that is nowhere near", () => {
    assert.equal(extentInView({ south: 40, west: 40, north: 41, east: 41 }, view, 5), false);
    assert.equal(extentInView({ south: 4, west: 40, north: 6, east: 41 }, view, 5), false);
  });

  await t.test("drops a line with no usable geometry", () => {
    assert.equal(extentInView(null, view, 5), false);
  });

  await t.test("finds a line on the copy of the world the camera is on", () => {
    // Camera panned east past the antimeridian: the view box is expressed in
    // longitudes beyond 180, and a route stored at -179 belongs in it.
    const eastOfSeam = { south: 0, west: 175, north: 10, east: 190 };
    assert.equal(extentInView({ south: 4, west: -179, north: 6, east: -178 }, eastOfSeam, 182), true);
  });

  await t.test("keeps a seam-crossing route the camera is sitting on", () => {
    // The pair to pathExtent's own seam case, and the reason the two have to be
    // used together: fed the extent pathExtent actually produces, the route is
    // found. Fed a discontinuous one (west 170, east -170) it would not be --
    // the midpoint of that box is 0, a hemisphere from where the line is.
    const onSeam = { south: 0, west: 170, north: 10, east: 190 };
    const extent = pathExtent([[5, 170], [5, 175], [5, -175], [5, -170]]);
    assert.equal(extentInView(extent, onSeam, 180), true);
  });
});
