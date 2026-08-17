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
const { SETTINGS_LAYERS, TOGGLEABLE_LAYER_KEYS } = await import("../src/settings/defaults.js");

const ALL_GROUPED = LAYER_GROUPS.flatMap((g) => g.keys);
const SETTINGS_KEYS = SETTINGS_LAYERS.map((l) => l.key);

test("every layer with a dial row is filed in exactly one group", () => {
  const missing = SETTINGS_KEYS.filter((k) => !ALL_GROUPED.includes(k));
  assert.deepEqual(missing, [], "these layers have a dial row but no group to render it under");

  const duplicated = ALL_GROUPED.filter((k, i) => ALL_GROUPED.indexOf(k) !== i);
  assert.deepEqual(duplicated, [], "these layers are filed in more than one group");
});

test("no group names a layer that does not exist", () => {
  // Checked against every key a checkbox can address, not against SETTINGS_LAYERS.
  //
  // Those two used to be the same list and stopped being one when the weather and
  // reference groups were added: eight of their nine keys have no dial row, because
  // six weather layers are raster tile overlays and one is a particle field --
  // nothing with a pin size, a pin colour or a zoom gate to dial -- and `countries`
  // never had a row either. They are real layers a reader can switch on, which is
  // what a group is for.
  //
  // TOGGLEABLE_LAYER_KEYS is the stronger check anyway: it is what the stored wish
  // table is validated against, so a typo here now fails as "this key can never be
  // ticked" rather than as "this key has no dial".
  const unknown = ALL_GROUPED.filter((k) => !TOGGLEABLE_LAYER_KEYS.has(k));
  assert.deepEqual(unknown, [], "these keys are grouped but no checkbox can address them");
});

test("every group has either dial rows or a reader-side home, and says which", () => {
  // The pairing the test above no longer enforces, made explicit instead of
  // implicit. A group with no dial rows is skipped by LayerDialsSection.jsx rather
  // than drawn as an empty heading, so the two lists have to agree on which groups
  // those are -- silently gaining a third would put a heading with nothing under it
  // into Admin Mode, which reads as a section that failed to load.
  const dialless = LAYER_GROUPS
    .filter((group) => !group.keys.some((key) => SETTINGS_KEYS.includes(key)))
    .map((group) => group.id);
  assert.deepEqual(dialless, ["weather"]);
  // Reference is the near miss worth naming: `countries` has no dial row, `cities`
  // does, so the group draws a heading with one row under it rather than being
  // skipped. Remove cities from it and this test still passes while Admin Mode
  // gains an empty heading -- which is what the filter in LayerDialsSection.jsx is
  // there to stop, and why it filters per group rather than by a hardcoded list.
  const reference = LAYER_GROUPS.find((group) => group.id === "reference");
  assert.deepEqual(reference.keys.filter((key) => SETTINGS_KEYS.includes(key)), ["cities"]);
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
test("the reader's group denominators", () => {
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
  // Neither of these two has a reader-side heading to put a denominator on -- the
  // weather checkboxes are in WeatherSection.jsx and reference's are in
  // PlacesSection.jsx -- so what these numbers pin is the pill dropdowns' own row
  // count. Same failure mode: a layer filed here without a checkbox somewhere is a
  // control a reader cannot reach.
  assert.equal(countedKeysFor("weather").length, 7);
  assert.equal(countedKeysFor("reference").length, 2);
});
