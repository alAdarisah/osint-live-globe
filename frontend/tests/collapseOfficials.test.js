// The diplomacy layer's collapse key, asserted against the three ways a record
// ends up on a position it shares with others.
//
// A record in this layer rarely has a position of its own. It has one of:
//
//   capital      the backend snapped a country-level report to the capital
//                (backend/sources/capitals.py)
//   institution  a press release carries its issuer's address, not a location
//   locality     GDELT geocoded a mention of a city to that city's centroid
//
// All three are synthetic and all three are shared, so all three pile up
// exactly. The key used to name only the first two, via `anchor.id`; the third
// fell into collapseByKey's null branch, which means "do not group", and stacked
// on one pixel at every zoom. Six live records sat on Moscow's centroid and
// three on Riyadh's when this was written.
//
// map/collapse.js has no imports, so this runs under bare `node --test` like
// scene.test.js and pinZoom.test.js.

import test from "node:test";
import assert from "node:assert/strict";

import { collapseByKey, collapseHeadsByProximity, officialsKey } from "../src/map/collapse.js";

/** A record shaped like /api/officials returns them. */
function record(id, { anchor = null, lat = null, lon = null } = {}) {
  return { id, anchor: anchor ? { id: anchor } : null, lat, lon };
}

// The real coordinates the live feed piles records onto.
const MOSCOW = { lat: 55.7522, lon: 37.6156 };
const RIYADH = { lat: 24.6408, lon: 46.7728 };
const UN_HQ = { lat: 40.7489, lon: -73.968 };

test("the diplomacy collapse key", async (t) => {
  await t.test("prefers the anchor when the record has one", () => {
    assert.equal(
      officialsKey(record("a", { anchor: "capital:IR", lat: 35.6944, lon: 51.4215 })),
      "capital:IR"
    );
    assert.equal(
      officialsKey(record("b", { anchor: "institution:un_press", ...UN_HQ })),
      "institution:un_press"
    );
  });

  await t.test("falls back to the exact drawn position when it has none", () => {
    const a = officialsKey(record("a", MOSCOW));
    const b = officialsKey(record("b", MOSCOW));
    assert.equal(a, b, "two records on one centroid stand on the same position");
    assert.notEqual(a, null);
  });

  await t.test("does not merge two genuinely different places", () => {
    assert.notEqual(officialsKey(record("a", MOSCOW)), officialsKey(record("b", RIYADH)));
  });

  await t.test("cannot collide with an anchor id", () => {
    // A namespaced key, so a feed that ever emits an anchor id shaped like a
    // coordinate pair cannot be grouped with records standing on that point.
    assert.notEqual(officialsKey(record("a", MOSCOW)), `${MOSCOW.lat},${MOSCOW.lon}`);
  });

  await t.test("declines to group a record with no position at all", () => {
    assert.equal(officialsKey(record("a")), null);
    assert.equal(officialsKey(record("b", { lat: 10 })), null, "half a coordinate is no position");
  });
});

test("collapsing the live pile-ups", async (t) => {
  const rank = (item) => Number(item.id.slice(1));

  await t.test("groups the six records on Moscow's centroid into one head", () => {
    const items = [1, 2, 3, 4, 5, 6].map((n) => record(`m${n}`, MOSCOW));
    const out = collapseByKey(items, officialsKey, rank);
    assert.equal(out.length, 1);
    assert.equal(out[0].collapsedCount, 6);
    assert.equal(out[0].collapsed.length, 6, "every member is kept, none is dropped");
  });

  await t.test("leaves a locality nothing else shares untouched", () => {
    const items = [record("m1", MOSCOW), record("r1", RIYADH), record("u1", { lat: 1, lon: 2 })];
    const out = collapseByKey(items, officialsKey, rank);
    assert.equal(out.length, 3);
    assert.equal(out.every((item) => item.collapsedCount === undefined), true);
  });

  await t.test("thins what is left over when two piles land on one pixel", () => {
    // Below DECLUTTER_MIN_ZOOM no spiral runs, so two exact piles a few pixels
    // apart -- un_press and un_news share a building, and at z4 a whole city is
    // one pixel -- have nothing to separate them. A second, spatial pass groups
    // them, and the head has to stand for every underlying record rather than
    // for the two heads it absorbed.
    const press = [1, 2, 3, 4].map((n) => record(`p${n}`, { anchor: "institution:un_press", ...UN_HQ }));
    const news = [1, 2, 3].map((n) => record(`n${n}`, { anchor: "institution:un_news", ...UN_HQ }));
    const byKey = collapseByKey([...press, ...news], officialsKey, rank);
    assert.equal(byKey.length, 2, "two anchors, two heads");

    const at = new Map([["institution:un_press", { x: 100, y: 100 }], ["institution:un_news", { x: 104, y: 103 }]]);
    const out = collapseHeadsByProximity(byKey, (h) => at.get(h.anchor.id), rank, 14);

    assert.equal(out.length, 1, "one pin where two piles shared a pixel");
    assert.equal(out[0].collapsedCount, 7, "it stands for all seven records, not for two heads");
    assert.deepEqual(
      out[0].collapsed.map((r) => r.id).sort(),
      ["n1", "n2", "n3", "p1", "p2", "p3", "p4"]
    );
  });

  await t.test("leaves heads that are far apart alone, members intact", () => {
    const press = [1, 2, 3, 4].map((n) => record(`p${n}`, { anchor: "institution:un_press", ...UN_HQ }));
    const moscow = [1, 2].map((n) => record(`m${n}`, MOSCOW));
    const byKey = collapseByKey([...press, ...moscow], officialsKey, rank);
    const at = new Map([["institution:un_press", { x: 100, y: 100 }], [`at:${MOSCOW.lat},${MOSCOW.lon}`, { x: 900, y: 500 }]]);
    const out = collapseHeadsByProximity(byKey, (h) => at.get(officialsKey(h)), rank, 14);

    assert.equal(out.length, 2);
    assert.deepEqual(out.map((h) => h.collapsedCount).sort(), [2, 4], "each keeps its own members");
  });

  await t.test("keeps anchored and unanchored piles separate", () => {
    const items = [
      ...[1, 2, 3].map((n) => record(`u${n}`, { anchor: "institution:un_press", ...UN_HQ })),
      ...[1, 2].map((n) => record(`m${n}`, MOSCOW)),
    ];
    const out = collapseByKey(items, officialsKey, rank);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((item) => item.collapsedCount).sort(), [2, 3]);
  });
});
