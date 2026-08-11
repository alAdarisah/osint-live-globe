// Which markers are actually new.
//
// "New" cannot mean "newly constructed": renderMarkerLayer rebuilds markers as
// the viewport moves, so a flash hung off construction would fire on every pan
// and would mean nothing. It has to mean new to the data.

import test from "node:test";
import assert from "node:assert/strict";

import { newArrivals } from "../src/map/arrivals.js";

const items = (...ids) => ids.map((id) => ({ id }));

test("seeding flashes nothing", () => {
  // First load is several hundred events at once. Flashing them would be a
  // firework display over a conflict map.
  const { ids, arrived } = newArrivals(null, items("a", "b", "c"), "id");
  assert.deepEqual([...arrived], []);
  assert.deepEqual([...ids].sort(), ["a", "b", "c"]);
});

test("only the ids absent last time arrive", () => {
  const first = newArrivals(null, items("a", "b"), "id");
  const second = newArrivals(first.ids, items("a", "b", "c", "d"), "id");
  assert.deepEqual([...second.arrived].sort(), ["c", "d"]);
});

test("an unchanged payload produces no arrivals", () => {
  const first = newArrivals(null, items("a", "b"), "id");
  const again = newArrivals(first.ids, items("a", "b"), "id");
  assert.deepEqual([...again.arrived], []);
});

test("the id set tracks removals so a returning event flashes again", () => {
  // A record dropping out of the feed and coming back later genuinely is news
  // arriving twice, which is the honest reading.
  const first = newArrivals(null, items("a", "b"), "id");
  const gone = newArrivals(first.ids, items("a"), "id");
  assert.deepEqual([...gone.ids], ["a"]);
  const back = newArrivals(gone.ids, items("a", "b"), "id");
  assert.deepEqual([...back.arrived], ["b"]);
});

test("items with no id are ignored rather than crashing the render", () => {
  const { ids, arrived } = newArrivals(new Set(["a"]), [{ id: "a" }, {}, { id: null }], "id");
  assert.deepEqual([...ids], ["a"]);
  assert.deepEqual([...arrived], []);
});

test("an empty payload clears the set without flashing", () => {
  const first = newArrivals(null, items("a"), "id");
  const empty = newArrivals(first.ids, [], "id");
  assert.deepEqual([...empty.ids], []);
  assert.deepEqual([...empty.arrived], []);
});

test("an id that changes type re-reads as a new record", () => {
  // Documents a real sharp edge rather than blessing it: Set membership is
  // SameValueZero, so a payload that starts serialising ids as strings would
  // flash every pin in the layer at once. If that ever happens the fix belongs
  // upstream in the feed, not in a coercion here -- but it should be a known
  // failure rather than a mystery.
  const first = newArrivals(null, [{ id: 5 }], "id");
  const retyped = newArrivals(first.ids, [{ id: "5" }], "id");
  assert.deepEqual([...retyped.arrived], ["5"]);
});
