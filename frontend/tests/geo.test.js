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

import { nearestLon, unwrapPath, boundsContainsPoint, padBounds } from "../src/utils/geo.js";

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
