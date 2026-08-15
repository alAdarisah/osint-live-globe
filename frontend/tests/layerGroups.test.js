// The grouping table's completeness, asserted.
//
// Admin Mode's layer list is rendered by walking LAYER_GROUPS rather than
// SETTINGS_LAYERS, so a layer missing from the table is a layer with no
// heading to render under -- which, in a grouped list, means a dial an
// operator cannot find at all. That is a silent failure: the row does not
// error, it simply is not there. This is the test that makes adding a layer
// without filing it a red build instead.

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

globalThis.window = {
  L: { Layer: { extend: () => ({}) }, DomUtil: {} },
  matchMedia: () => ({ matches: false }),
};

const { LAYER_GROUPS, NOT_COUNTED_IN_READER, layerGroupOf } = await import("../src/settings/layerGroups.js");
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

// The group id "hazards" and the layer key "hazards" are the same string, and
// that is fine: headings key off `grp-<id>` and rows off `adm-layer-<key>`, so
// the two never share a namespace. Asserted so nobody "fixes" the collision by
// renaming one of them and breaking the other's DOM id.
test("a group id may equal a layer key -- they are different namespaces", () => {
  assert.ok(LAYER_GROUPS.some((g) => g.id === "hazards"));
  assert.ok(SETTINGS_KEYS.includes("hazards"));
});

test("NOT_COUNTED_IN_READER names only real, grouped layers", () => {
  for (const key of NOT_COUNTED_IN_READER) {
    assert.ok(SETTINGS_KEYS.includes(key), `${key} is not a layer`);
    assert.ok(ALL_GROUPED.includes(key), `${key} is not in any group`);
  }
});

test("layerGroupOf answers with the group id, or null for an unknown key", () => {
  assert.equal(layerGroupOf("aisDigitraffic"), "traffic");
  assert.equal(layerGroupOf("cities"), "ground");
  assert.equal(layerGroupOf("gdelt"), "conflict");
  assert.equal(layerGroupOf("nosuchlayer"), null);
});
