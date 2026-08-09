// Water hit-testing, asserted: smallest-containing-polygon selection over
// nested marine polygons, a miss, a boundary point, and the antimeridian.
//
// map/water.js pulls in map/decorators.js for its palette-driven colours,
// which (like every marker decorator) imports map/leafletGlobal.js and reads
// `window.L` at module scope -- so, exactly as webglHitTest.test.js documents
// for the same reason, this file stubs just enough of `window.L` to satisfy
// that import and teaches the loader to resolve water.js's extensionless
// relative imports the way Vite does. Nothing here calls into Leaflet: only
// the pure hit-test functions (buildWaterIndex, findWaterAt) and the popup
// string builder (waterPopupHtml) are exercised.

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
});

globalThis.window = { L: { geoJSON: () => ({}) } };

const { buildWaterIndex, findWaterAt, waterPopupHtml } = await import("../src/map/water.js");

const feature = (properties, geometry) => ({ type: "Feature", properties, geometry });

const square = (minLon, minLat, maxLon, maxLat) => ({
  type: "Polygon",
  coordinates: [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]],
});

test("smallest-containing marine polygon wins when two nest", () => {
  // The Mediterranean/Aegean shape this is standing in for: a big sea with a
  // named gulf entirely inside it, each carrying its own area_deg2 exactly as
  // water_bodies.py stores it for marine features.
  const outer = feature(
    { id: "marine:1", name: "Big Sea", class: "sea", area_deg2: 100 },
    square(-5, -5, 5, 5)
  );
  const inner = feature(
    { id: "marine:2", name: "Little Gulf", class: "gulf", area_deg2: 10 },
    square(-1, -1, 1, 1)
  );
  const index = buildWaterIndex([outer, inner]);

  // Sorted smallest-area-first, so the gulf is checked (and matches) before
  // the sea it sits inside.
  assert.deepEqual(index.map((e) => e.id), ["marine:2", "marine:1"]);

  const insideBoth = findWaterAt(index, 0, 0);
  assert.equal(insideBoth.id, "marine:2", "the smaller, nested gulf wins over the sea around it");

  const insideOuterOnly = findWaterAt(index, 3, 3);
  assert.equal(insideOuterOnly.id, "marine:1", "outside the gulf, the sea still answers");
});

test("a point in neither feature returns null", () => {
  const index = buildWaterIndex([
    feature({ id: "marine:1", name: "Big Sea", class: "sea", area_deg2: 100 }, square(-5, -5, 5, 5)),
  ]);
  assert.equal(findWaterAt(index, 8, 8), null);
});

test("a point exactly on the inner shape's edge falls through to the outer one", () => {
  // The tie-break this states: nesting is resolved by checking the smaller
  // shape first (see buildWaterIndex's sort), but a point sitting exactly on
  // that smaller shape's own boundary is not treated as "inside" it -- the
  // even-odd ray-cast in countryHitTest.js's pointInRing is a half-open test
  // (`lon < intersectionX`, not `<=`), so a point on this square's right edge
  // (lon === 1, the edge's own x) never crosses it. That is not special-cased
  // for water; it is the same rule every polygon layer on this map already
  // uses, restated here because a shared edge is exactly where it is worth
  // pinning down which feature answers for it. The point is a genuine
  // interior point of the outer sea, which is why the outer sea is what
  // findWaterAt returns rather than nothing.
  const outer = feature({ id: "marine:1", name: "Big Sea", class: "sea", area_deg2: 100 }, square(-5, -5, 5, 5));
  const inner = feature({ id: "marine:2", name: "Little Gulf", class: "gulf", area_deg2: 10 }, square(-1, -1, 1, 1));
  const index = buildWaterIndex([outer, inner]);

  const onInnerEdge = findWaterAt(index, 0, 1);
  assert.equal(onInnerEdge.id, "marine:1", "the point sits on the gulf's own edge, not inside it");
});

test("lakes with no area_deg2 fall back to their own bounding-box area", () => {
  // Lakes carry no area_deg2 at all (see water_bodies.py -- it is computed
  // for marine only), so buildWaterIndex's fallback -- each entry's own
  // bbox area -- is what breaks a nesting tie for them. Kept simple on
  // purpose: lakes nest at most one level deep across the real dataset, so
  // there is only ever one comparison to make, and a bbox is already sitting
  // on every buildShapeIndex entry with nothing further to compute.
  const outerLake = feature({ id: "lake:1", name: "Great Lake", class: "lake" }, square(-5, -5, 5, 5));
  const innerLake = feature({ id: "lake:2", name: "Island Pond", class: "lake" }, square(-1, -1, 1, 1));
  const index = buildWaterIndex([outerLake, innerLake]);
  assert.deepEqual(index.map((e) => e.id), ["lake:2", "lake:1"]);
  assert.equal(findWaterAt(index, 0, 0).id, "lake:2");
});

test("a river (a line, not a polygon) never produces a hit-testable entry", () => {
  // Containment by area does not apply to a line -- buildShapeIndex's own
  // polygonsOf returns no polygons for a LineString, so a river is drawn
  // (see water.js's waterStyle) but never resolvable by findWaterAt.
  const river = feature(
    { id: "river:5:nile", name: "Nile", class: "river" },
    { type: "LineString", coordinates: [[30, 0], [31, 5], [32, 10]] }
  );
  const index = buildWaterIndex([river]);
  assert.equal(index.length, 0);
  assert.equal(findWaterAt(index, 5, 31), null);
});

test("antimeridian: a wrapped marine MultiPolygon resolves on both sides of the seam", () => {
  // The Bering Sea shape water_bodies.py describes: two disjoint parts, one
  // just west of +180 and one just east of -180, each a well-formed simple
  // polygon in its own right (Natural Earth splits the feature at the seam
  // rather than shipping coordinates that wrap) -- consistent with Task 5's
  // antimeridian handling in backend/app.py's _water_bbox_overlaps.
  const bering = feature(
    { id: "marine:bering", name: "Bering Sea", class: "sea", area_deg2: 40, antimeridian: true },
    {
      type: "MultiPolygon",
      coordinates: [
        [[[170, 50], [180, 50], [180, 60], [170, 60], [170, 50]]],
        [[[-180, 50], [-170, 50], [-170, 60], [-180, 60], [-180, 50]]],
      ],
    }
  );
  const index = buildWaterIndex([bering]);
  assert.equal(index[0].antimeridian, true);

  assert.equal(findWaterAt(index, 55, 175)?.id, "marine:bering", "east of the seam");
  assert.equal(findWaterAt(index, 55, -175)?.id, "marine:bering", "west of the seam");
  assert.equal(findWaterAt(index, 55, 0), null, "nowhere near either part");
});

test("waterPopupHtml names the feature and its class", () => {
  const html = waterPopupHtml({ name: "Aegean Sea", class: "sea" });
  assert.match(html, /Aegean Sea/);
  assert.match(html, /Sea/);
  assert.match(html, /Natural Earth/);
});

test("waterPopupHtml falls back to the class label when a feature is unnamed", () => {
  const html = waterPopupHtml({ name: "", class: "gulf" });
  assert.match(html, /Gulf/);
});
