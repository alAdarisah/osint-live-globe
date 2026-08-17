import test from "node:test";
import assert from "node:assert/strict";

import {
  pillCount,
  nextOpenCategory,
  resetTargets,
  groupHasWishes,
} from "../src/components/chrome/categoryPillsLogic.js";
import { countedKeysFor, LAYER_GROUPS } from "../src/settings/layerGroups.js";

test("a pill counts exactly the keys its group's drawer heading counts", () => {
  // The pill badge and the drawer's "n/m" are two renderings of one fact. They
  // are computed from countedKeysFor for that reason -- a pill that counted
  // group.keys directly would include gdelt and cities, which the reader draws
  // no top-level checkbox for, and report a number larger than the rows visible
  // underneath it.
  for (const group of LAYER_GROUPS) {
    const keys = countedKeysFor(group.id);
    const allOn = Object.fromEntries(group.keys.map((key) => [key, true]));
    assert.deepEqual(pillCount(group.id, allOn), { on: keys.length, total: keys.length }, group.id);
  }
});

test("an uncounted key cannot inflate a pill", () => {
  // gdelt is filed under conflict for Admin Mode's dial list but drawn as a
  // sub-ticker of events, so switching it on must not move the badge.
  const before = pillCount("conflict", { events: true });
  const after = pillCount("conflict", { events: true, gdelt: true });
  assert.deepEqual(before, after);
});

test("counting is off what the map draws, not off what was wished for", () => {
  // layerState.on, not the wish table. A layer pinned on and held back by its
  // own zoom gate is not a layer on screen.
  assert.equal(pillCount("hazards", {}).on, 0);
  assert.equal(pillCount("hazards", { hazards: true, floods: false }).on, 1);
});

test("an unknown group reports nothing rather than throwing", () => {
  // Same posture countedKeysFor takes: a pill that reports 0/0 is a smaller
  // failure than a bar that will not render.
  assert.deepEqual(pillCount("nope", { events: true }), { on: 0, total: 0 });
});

test("only one dropdown is open at a time, and the open one toggles shut", () => {
  assert.equal(nextOpenCategory(null, "conflict"), "conflict");
  assert.equal(nextOpenCategory("conflict", "traffic"), "traffic");
  assert.equal(nextOpenCategory("conflict", "conflict"), null);
});

test("Reset hands layers back to the resolver, and never ticks them all on", () => {
  // The design prototype's Reset re-checks every box. On a tri-state control
  // that is not a reset at all -- the neutral state is "nobody has decided",
  // which is what an untouched map is, and ticking all forty layers would be
  // the most opinionated thing a reader could do to it.
  const wish = { events: true, aisNavy: false, satellites: true };
  assert.deepEqual(resetTargets(wish).sort(), ["aisNavy", "events", "satellites"]);

  // Including the keys pinned *off*: those are overrides too, and leaving them
  // behind would make Reset mean "clear the ticks I can see".
  assert.ok(resetTargets(wish).includes("aisNavy"));

  // Nothing overridden, nothing to do.
  assert.deepEqual(resetTargets({}), []);
  assert.deepEqual(resetTargets(null), []);
  assert.deepEqual(resetTargets(undefined), []);
});

test("a group reports whether it holds a decision of its own", () => {
  assert.equal(groupHasWishes("conflict", { events: true }), true);
  // Pinned off still counts as a decision.
  assert.equal(groupHasWishes("conflict", { officials: false }), true);
  // A wish for a layer in another group does not.
  assert.equal(groupHasWishes("conflict", { satellites: true }), false);
  assert.equal(groupHasWishes("conflict", {}), false);
  assert.equal(groupHasWishes("conflict", undefined), false);
});
