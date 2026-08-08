// Which copies of the world are on screen, asserted.
//
// The companion to geo.test.js. nearestLon answers "which single copy is the
// camera looking at"; this answers "how many copies can the reader see at once",
// which is the question every layer that draws whole-world geometry has to ask
// before it can stop cutting off at the edge of the primary copy.
//
// Every way it can be wrong is silent, in both directions. Return too few and a
// layer cuts off mid-pan exactly as before. Return too many and the map quietly
// draws thousands of polylines nobody can see -- no error, just a slow map. The
// off-by-one at "exactly one world in view" is the dangerous one, because that
// is the default view and it is where a naive ceil/floor pair returns three
// copies when the truthful answer is one.
//
// utils/geo.js imports nothing, so this runs under `node --test` with no
// bundler, the same constraint geo.test.js and scene.test.js document.

import test from "node:test";
import assert from "node:assert/strict";

import {
  worldCopyOffsets, worldCopyDraws, worldCopyKey, worldCopyPlacer, shiftPathLon,
  MAX_WORLD_COPIES,
} from "../src/utils/geo.js";
import { syncLayerMarkers } from "../src/map/syncLayerMarkers.js";

test("worldCopyOffsets", async (t) => {
  // The default view, and the case a naive implementation gets wrong. A
  // viewport exactly one world wide *touches* the neighbouring copies at its
  // edges but shows no pixel of either, so the honest answer is one copy.
  await t.test("returns one copy for a viewport exactly one world wide", () => {
    assert.deepEqual(worldCopyOffsets(-180, 180, 0), [0]);
  });

  await t.test("returns one copy for any viewport narrower than a world", () => {
    assert.deepEqual(worldCopyOffsets(10, 20, 15), [0]);
    assert.deepEqual(worldCopyOffsets(-60, 100, 20), [0]);
  });

  // Zoomed out far enough that the basemap visibly repeats -- the state that
  // prompted all of this.
  await t.test("returns the neighbouring copies once they are actually in view", () => {
    assert.deepEqual(worldCopyOffsets(-400, 400, 0), [-360, 0, 360]);
    assert.deepEqual(worldCopyOffsets(-200, 200, 0), [-360, 0, 360]);
  });

  // Asymmetric views are the common case during a pan, and drawing a copy that
  // is off screen is pure waste. The camera's copy spans ref +-180, so only a
  // bound that reaches past one of those edges earns a neighbour.
  await t.test("returns only the side that is in view", () => {
    // Camera copy spans [-195, 165]: west reaches past it, east does not.
    assert.deepEqual(worldCopyOffsets(-260, 160, -15), [-360, 0]);
    // Camera copy spans [-165, 195]: the mirror image.
    assert.deepEqual(worldCopyOffsets(-160, 260, 15), [0, 360]);
  });

  // Offsets are relative to the copy the camera is on, not to the prime
  // meridian, because that is the copy nearestLon already placed everything on.
  // A camera three worlds out must still get [-360, 0, 360], not [-1440, ...].
  await t.test("is relative to the camera's copy, not to zero", () => {
    assert.deepEqual(worldCopyOffsets(720 - 400, 720 + 400, 720), [-360, 0, 360]);
    assert.deepEqual(worldCopyOffsets(-900 - 400, -900 + 400, -900), [-360, 0, 360]);
  });

  await t.test("works with the camera sitting on the antimeridian", () => {
    assert.deepEqual(worldCopyOffsets(179 - 400, 179 + 400, 179), [-360, 0, 360]);
    assert.deepEqual(worldCopyOffsets(179 - 100, 179 + 100, 179), [0]);
  });

  // Leaflet's bounds can come back wrapped, with west numerically greater than
  // east (see normalizedLonSpan in map/viewportProfile.js, which documents the
  // same hazard). Read literally that is a negative-width viewport and the loop
  // returns nothing -- a layer that draws nothing at all, which is worse than
  // the bug being fixed.
  await t.test("treats a wrapped bounds as crossing the seam, not as empty", () => {
    assert.deepEqual(worldCopyOffsets(170, -170, 180), [0]);
    assert.ok(worldCopyOffsets(170, -170, 180).length >= 1);
  });

  // A broken zoom or a mid-animation read can hand this an absurd span. It must
  // degrade to a slow-but-finite number of copies rather than trying to build
  // hundreds of worlds of geometry.
  await t.test("caps the number of copies", () => {
    const offsets = worldCopyOffsets(-20000, 20000, 0);
    assert.equal(offsets.length, MAX_WORLD_COPIES);
    // Capped by dropping the outermost copies, so the camera's own copy always
    // survives -- dropping copy 0 would blank the view the reader is looking at.
    assert.ok(offsets.includes(0));
    assert.deepEqual([...offsets].sort((a, b) => a - b), offsets);
  });

  await t.test("falls back to the camera's copy for a non-finite bounds", () => {
    assert.deepEqual(worldCopyOffsets(NaN, 100, 0), [0]);
    assert.deepEqual(worldCopyOffsets(-100, undefined, 0), [0]);
    assert.deepEqual(worldCopyOffsets(-100, 100, NaN), [0]);
  });

  // What the redraw guard compares. Two views showing the same copies must
  // produce the same key, or every pan rebuilds 2000 polylines for nothing.
  await t.test("is stable across a pan that does not change the copy count", () => {
    const a = worldCopyOffsets(-400, 400, 0);
    const b = worldCopyOffsets(-400 + 30, 400 + 30, 30);
    assert.deepEqual(a, b);
  });
});

test("shiftPathLon", async (t) => {
  await t.test("moves longitude only, never latitude", () => {
    assert.deepEqual(shiftPathLon([[10, 20], [11, 21]], 360), [[10, 380], [11, 381]]);
    assert.deepEqual(shiftPathLon([[10, 20]], -360), [[10, -340]]);
  });

  // The camera's own copy is the common case and must not allocate a second array
  // per path -- with 718 cables re-drawn on every copy change, that is the
  // difference between one pass over the data and two.
  await t.test("returns the same array for the camera's own copy", () => {
    const path = [[1, 2], [3, 4]];
    assert.equal(shiftPathLon(path, 0), path);
  });
});

test("worldCopyKey", async (t) => {
  await t.test("gives each copy of a record its own key", () => {
    const keys = [-360, 0, 360].map((c) => worldCopyKey(42, c));
    assert.equal(new Set(keys).size, 3);
  });

  // The reason the copy is keyed first and the primary copy is not left bare. A
  // record whose id happens to look like another record's copy key must not collide
  // -- one marker would silently overwrite the other and a pin would vanish.
  await t.test("cannot be impersonated by a record id", () => {
    assert.notEqual(worldCopyKey("c1|x", 0), worldCopyKey("x", 360));
    assert.notEqual(worldCopyKey("c0|x", 360), worldCopyKey("x", 0));
  });

  // cityKey builds "name|country|lat|lon" composites, so ids containing the
  // separator are not hypothetical. Injectivity must survive them.
  await t.test("stays injective for ids containing the separator", () => {
    const ids = ["Springfield|US|39.8|-89.6", "Springfield|US|39.8", "x"];
    const keys = new Set();
    for (const id of ids) for (const copy of [-360, 0, 360]) keys.add(worldCopyKey(id, copy));
    assert.equal(keys.size, ids.length * 3);
  });

  // Numbers and the strings of those numbers are distinct records nowhere in this
  // app, so collapsing them is harmless -- but it must be *deliberate*, not a
  // surprise, hence the assertion.
  await t.test("keys a numeric id and its string form alike", () => {
    assert.equal(worldCopyKey(42, 360), worldCopyKey("42", 360));
  });
});

test("worldCopyDraws", async (t) => {
  const items = [{ id: "a" }, { id: "b" }];

  await t.test("draws each record once when only one copy is in view", () => {
    assert.deepEqual(worldCopyDraws(items, [0]), [
      { item: items[0], copy: 0 },
      { item: items[1], copy: 0 },
    ]);
  });

  await t.test("draws each record on every copy in view", () => {
    const draws = worldCopyDraws(items, [-360, 0, 360]);
    assert.equal(draws.length, 6);
    assert.deepEqual(draws.map((d) => d.copy), [-360, 0, 360, -360, 0, 360]);
  });

  // The record must arrive at the renderer untouched: popups, tooltips, clicks and
  // every count read it, and shifting its stored coordinate to move a *drawing*
  // would corrupt all four.
  await t.test("never copies or mutates the record", () => {
    const draws = worldCopyDraws(items, [-360, 0, 360]);
    for (const d of draws) assert.ok(d.item === items[0] || d.item === items[1]);
    assert.deepEqual(items, [{ id: "a" }, { id: "b" }]);
  });

  await t.test("survives an empty list", () => {
    assert.deepEqual(worldCopyDraws([], [-360, 0, 360]), []);
  });
});

// What the heat layers feed leaflet.heat. The failure that matters here is
// quantitative rather than visual: cull too little and FIRMS hands the heat layer
// three times 100k points on every pan; cull too much and the blur ends before the
// basemap does, which is the original complaint wearing a different hat.
test("worldCopyPlacer", async (t) => {
  // A three-copy viewport: barely wider than one world, centred on 0.
  const wide = { south: -60, north: 60, west: -197, east: 197 };
  const offsets = [-360, 0, 360];

  const placements = (placer, lat, lon) => {
    const out = [];
    placer(lat, lon, (drawLon, copy) => out.push({ drawLon: Math.round(drawLon), copy }));
    return out;
  };

  // The heart of the culling. A point near the middle of the world is on screen
  // once: its other copies are ~360 degrees away, far outside a 394-degree window.
  await t.test("draws a mid-world point once, not three times", () => {
    const p = placements(worldCopyPlacer(wide, 0, offsets), 10, 20);
    assert.deepEqual(p, [{ drawLon: 20, copy: 0 }]);
  });

  // A point near the antimeridian is the one that genuinely appears twice, because
  // the viewport's edges reach past +-180 into the neighbouring copies.
  await t.test("draws a point near the seam on both copies that show it", () => {
    const p = placements(worldCopyPlacer(wide, 0, offsets), 10, 175);
    assert.deepEqual(p.map((x) => x.copy).sort((a, b) => a - b), [-360, 0]);
    assert.deepEqual(p.map((x) => x.drawLon).sort((a, b) => a - b), [-185, 175]);
  });

  await t.test("rejects a point outside the latitude band once, whatever the copies", () => {
    let calls = 0;
    worldCopyPlacer(wide, 0, offsets)(80, 20, () => { calls += 1; });
    assert.equal(calls, 0);
  });

  await t.test("rejects a missing coordinate rather than placing NaN", () => {
    let calls = 0;
    const placer = worldCopyPlacer(wide, 0, offsets);
    placer(undefined, 20, () => { calls += 1; });
    placer(10, null, () => { calls += 1; });
    placer(NaN, NaN, () => { calls += 1; });
    assert.equal(calls, 0);
  });

  // Single-copy viewport: the overwhelmingly common case, and it must behave exactly
  // as the un-copied code did -- one placement, at the camera-relative longitude.
  await t.test("places once, on the camera's copy, when only one copy is in view", () => {
    const narrow = { south: -10, north: 10, west: 160, east: 200 };
    // Camera east of the seam; the record is stored just west of it.
    const p = placements(worldCopyPlacer(narrow, 180, [0]), 0, -175);
    assert.deepEqual(p, [{ drawLon: 185, copy: 0 }]);
  });

  // The whole point of the exercise: repeating must not multiply the workload.
  // 1000 records over a three-copy viewport must stay far below 3000 placements.
  await t.test("keeps the total near the single-copy cost", () => {
    const placer = worldCopyPlacer(wide, 0, offsets);
    let total = 0;
    for (let i = 0; i < 1000; i++) {
      const lon = -180 + (360 * i) / 1000;
      placer(0, lon, () => { total += 1; });
    }
    // 394 degrees of window over 360 degrees of data: ~9% duplicated, not 200%.
    assert.ok(total >= 1000, `every record must be drawn at least once, got ${total}`);
    assert.ok(total < 1200, `expected near-1000 placements, got ${total}`);
  });

  // The regression this guards is the one that actually happened. Padding the
  // longitude proportionally (0.25 of the span, as viewportFilter does) is harmless
  // while the viewport is narrower than the world and ruinous once it is not: on the
  // real FIRMS feed a ~98-degree margin each side turned 225k points into 362k
  // placements. The window must stay near the viewport, not scale with it.
  await t.test("does not duplicate the world when the margin is capped", () => {
    // What worldCopyPlacements builds at three copies: ~394-degree viewport, 15
    // degrees of margin each side rather than a quarter of the span.
    const capped = { south: -60, north: 60, west: -197 - 15, east: 197 + 15 };
    const uncapped = { south: -60, north: 60, west: -197 - 98, east: 197 + 98 };
    const count = (bounds) => {
      const placer = worldCopyPlacer(bounds, 0, offsets);
      let total = 0;
      for (let i = 0; i < 1000; i++) placer(0, -180 + (360 * i) / 1000, () => { total += 1; });
      return total;
    };
    const cappedTotal = count(capped);
    const uncappedTotal = count(uncapped);
    assert.ok(cappedTotal < 1250, `capped margin should stay near 1000, got ${cappedTotal}`);
    assert.ok(
      uncappedTotal > cappedTotal + 300,
      `the uncapped margin is what this guards against; got ${uncappedTotal} vs ${cappedTotal}`
    );
  });
});

// The two pieces above are only correct together: the expansion decides what to
// draw and the key decides what the diff considers "the same thing". This drives
// syncLayerMarkers exactly as syncAcrossWorldCopies does in createMapController.js,
// because the failure that matters is a keying one -- a marker map keyed per record
// would hold one entry, draw one copy, and tear it down and rebuild it on every
// pass while the other copies leaked.
test("marker sync across world copies", async (t) => {
  function harness() {
    const layers = new Set();
    const group = { addLayer: (m) => layers.add(m), removeLayer: (m) => layers.delete(m) };
    const markerMap = new Map();
    let built = 0;
    const sync = (items, offsets) =>
      syncLayerMarkers(
        markerMap,
        group,
        worldCopyDraws(items, offsets),
        (d) => worldCopyKey(d.item.id, d.copy),
        (d) => { built += 1; return { id: d.item.id, copy: d.copy, updates: 0 }; },
        (marker, d) => { marker.copy = d.copy; marker.updates += 1; }
      );
    return { layers, markerMap, sync, builtCount: () => built };
  }

  await t.test("draws one marker per record per copy", () => {
    const h = harness();
    h.sync([{ id: "a" }, { id: "b" }], [-360, 0, 360]);
    assert.equal(h.layers.size, 6);
    assert.equal(h.markerMap.size, 6);
  });

  await t.test("builds nothing on a second pass over the same copies", () => {
    const h = harness();
    const items = [{ id: "a" }, { id: "b" }];
    h.sync(items, [-360, 0, 360]);
    const afterFirst = h.builtCount();
    h.sync(items, [-360, 0, 360]);
    assert.equal(h.builtCount(), afterFirst, "a pan within the same copies must not rebuild markers");
    for (const marker of h.markerMap.values()) assert.equal(marker.updates, 1);
  });

  // The leak this guards: zoom back in and the copies that left the screen have to
  // be torn down. Keyed per record they would never be reachable to remove.
  await t.test("tears down the copies that leave the screen", () => {
    const h = harness();
    const items = [{ id: "a" }, { id: "b" }];
    h.sync(items, [-360, 0, 360]);
    h.sync(items, [0]);
    assert.equal(h.layers.size, 2);
    assert.equal(h.markerMap.size, 2);
    for (const marker of h.markerMap.values()) assert.equal(marker.copy, 0);
  });

  // Zooming out must not disturb what the reader is already looking at: the two new
  // copies appear, and the marker under the camera is the same object it was.
  await t.test("keeps the primary copy's marker across a copy-count change", () => {
    const h = harness();
    const items = [{ id: "a" }];
    h.sync(items, [0]);
    const primaryKey = worldCopyKey("a", 0);
    const primary = h.markerMap.get(primaryKey);
    assert.ok(primary, "primary copy should be keyed by worldCopyKey(id, 0)");
    h.sync(items, [-360, 0, 360]);
    assert.equal(h.markerMap.get(primaryKey), primary, "the camera's own marker must survive, not be rebuilt");
    assert.equal(h.layers.size, 3);
  });
});
