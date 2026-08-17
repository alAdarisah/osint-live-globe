// The grouping table's completeness, asserted.
//
// Admin Mode's layer list is rendered by walking LAYER_GROUPS rather than
// SETTINGS_LAYERS, so a layer missing from the table is a layer with no
// heading to render under -- which, in a grouped list, means a dial an
// operator cannot find at all. That is a silent failure: the row does not
// error, it simply is not there. This is the test that makes adding a layer
// without filing it a red build instead.

import "./helpers/nodeTestEnv.js";

import test from "node:test";
import assert from "node:assert/strict";

const { LAYER_GROUPS, NOT_COUNTED_IN_READER, countedKeysFor } = await import("../src/settings/layerGroups.js");
const { SETTINGS_LAYERS } = await import("../src/settings/defaults.js");

const ALL_GROUPED = LAYER_GROUPS.flatMap((g) => g.keys);
const SETTINGS_KEYS = SETTINGS_LAYERS.map((l) => l.key);

test("every layer with a dial row is filed in exactly one group", () => {
  const missing = SETTINGS_KEYS.filter((k) => !ALL_GROUPED.includes(k));
  assert.deepEqual(missing, [], "these layers have a dial row but no group to render it under");

  const duplicated = ALL_GROUPED.filter((k, i) => ALL_GROUPED.indexOf(k) !== i);
  assert.deepEqual(duplicated, [], "these layers are filed in more than one group");
});

test("no group names a layer that does not exist", () => {
  const unknown = ALL_GROUPED.filter((k) => !SETTINGS_KEYS.includes(k));
  assert.deepEqual(unknown, [], "these keys are grouped but have no SETTINGS_LAYERS row");
});

test("group ids and titles are unique", () => {
  const ids = LAYER_GROUPS.map((g) => g.id);
  const titles = LAYER_GROUPS.map((g) => g.title);
  assert.equal(new Set(ids).size, ids.length, "two groups share an id");
  assert.equal(new Set(titles).size, titles.length, "two groups share a title");
});

test("NOT_COUNTED_IN_READER names only real, grouped layers", () => {
  for (const key of NOT_COUNTED_IN_READER) {
    assert.ok(SETTINGS_KEYS.includes(key), `${key} is not a layer`);
    assert.ok(ALL_GROUPED.includes(key), `${key} is not in any group`);
  }
});

// The reader's group headings show "n of m" where m is the number of
// checkboxes under them. Two layers are filed in groups here but have no
// checkbox there, so m has to exclude them -- otherwise a heading reads 3/4
// while showing three rows, and the missing one is unfindable because it does
// not exist.
test("countedKeysFor drops the layers the reader does not draw as rows", () => {
  const conflict = countedKeysFor("conflict");
  assert.ok(!conflict.includes("gdelt"), "gdelt is a sub-row, not a counted layer");
  assert.deepEqual(conflict, ["events", "conflictHistory", "officials"]);

  const ground = countedKeysFor("ground");
  assert.ok(!ground.includes("cities"), "cities lives in the Places section");
});

test("countedKeysFor leaves a group with no exceptions untouched", () => {
  assert.deepEqual(countedKeysFor("hazards"), ["hazards", "floods"]);
  assert.deepEqual(countedKeysFor("nosuchgroup"), []);
});

// The reader's six headings are hand-written JSX rows in LayersSection.jsx --
// only the "n/m" denominator comes from this module (see groupCount there).
// SETTINGS_LAYERS is walked by the *other* completeness test above, which
// forces every new layer key into some group -- so an admin-only layer added
// without a matching reader checkbox does not fail that test, it just quietly
// changes one of these six numbers, and a heading like "3/20" ships sitting
// above 19 checkboxes with a fully green suite.
//
// Pinning the six numbers as a fixture turns that silent drift into a failing
// test: if one of these goes red, it means a layer was added to (or removed
// from) a group, and the fix is not to update the number here -- it is to go
// add (or remove) the matching checkbox in LayersSection.jsx first, then
// update this fixture to match what the reader now actually draws.
test("the reader's six group denominators", () => {
  assert.equal(countedKeysFor("conflict").length, 3);
  // 11 since the ships layer gained its fallback supplier: marinesia is its own
  // layer rather than a fourth bucket inside aisstream's, for the reason
  // marinesia.py's header gives -- merging feeds of very different density would
  // make "the ships layer" mean something different depending on which supplier
  // was up.
  assert.equal(countedKeysFor("traffic").length, 11);
  assert.equal(countedKeysFor("ground").length, 19);
  assert.equal(countedKeysFor("airspace").length, 1);
  assert.equal(countedKeysFor("hazards").length, 2);
  assert.equal(countedKeysFor("space").length, 9);
});
