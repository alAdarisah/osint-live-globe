// Must be first -- see helpers/nodeTestEnv.js. layerPresentation.js reaches
// into map/decorators.js, whose import chain touches map/leafletGlobal.js and
// reads `window.L` at import time.
import "./helpers/nodeTestEnv.js";

import test from "node:test";
import assert from "node:assert/strict";

import { LAYER_GROUPS, countedKeysFor } from "../src/settings/layerGroups.js";

const { GROUP_PILL, PILL_ORDER, LAYER_ROW, layerRowsFor } =
  await import("../src/settings/layerPresentation.js");

test("every layer the taxonomy counts has something to draw", () => {
  // The failure this catches: a layer filed in layerGroups.js and forgotten
  // here renders as a checkbox with no glyph and no label -- a blank row, which
  // reads as a rendering bug rather than as a missing table entry. Adding a
  // layer is already documented as a two-step job; this makes it a three-step
  // one that fails loudly instead of quietly.
  const missing = [];
  for (const group of LAYER_GROUPS) {
    for (const key of countedKeysFor(group.id)) {
      const row = LAYER_ROW[key];
      if (!row) { missing.push(`${group.id}/${key}: no entry`); continue; }
      if (!row.label) missing.push(`${group.id}/${key}: no label`);
      if (typeof row.svg !== "string" || !row.svg.trim()) missing.push(`${group.id}/${key}: no glyph`);
      if (!("count" in row)) missing.push(`${group.id}/${key}: no count key (use null if it has none)`);
    }
  }
  assert.deepEqual(missing, [], `layerPresentation.js is missing entries:\n${missing.join("\n")}`);
});

test("a group's rows are exactly its counted keys, in taxonomy order", () => {
  // Not a second ordering. layerGroups.js's header records why the reader's
  // drawer authors its own row order by hand -- 1900 lines of JSX that would
  // have to be generated from data otherwise -- and it explicitly says the
  // *table's* key order is display order. The pills read it directly, so they
  // are a third screen consuming the one table rather than a third copy of it.
  for (const group of LAYER_GROUPS) {
    assert.deepEqual(
      layerRowsFor(group.id).map((row) => row.key),
      countedKeysFor(group.id),
      group.id,
    );
  }
});

test("there is one pill per group, and the strip is in the taxonomy's order", () => {
  assert.deepEqual(PILL_ORDER, LAYER_GROUPS.map((group) => group.id));
  for (const group of LAYER_GROUPS) {
    const pill = GROUP_PILL[group.id];
    assert.ok(pill, `no pill for ${group.id}`);
    assert.ok(pill.label, `${group.id} pill has no label`);
    assert.match(pill.dot, /^#[0-9a-f]{6}$/i, `${group.id} pill has no colour`);
  }
  // And no pill for a group that does not exist -- an orphan here would draw a
  // dropdown with nothing in it.
  assert.deepEqual(
    Object.keys(GROUP_PILL).filter((id) => !LAYER_GROUPS.some((g) => g.id === id)),
    [],
  );
});

test("pill labels are short enough to be pills", () => {
  // They sit in a 44px bar alongside the brand, the live badge, three stat
  // blocks and a clock. The full group title still heads the dropdown, so
  // nothing is lost by the handle being short.
  for (const [id, pill] of Object.entries(GROUP_PILL)) {
    assert.ok(pill.label.length <= 10, `${id}: "${pill.label}" is too long for a pill`);
  }
});

test("nothing is offered that the reader draws no checkbox for", () => {
  // gdelt is a sub-ticker of events and cities lives in the Places section;
  // both are in the taxonomy for Admin Mode's dial list only. A pill row for
  // either would be a control the drawer does not have.
  for (const group of LAYER_GROUPS) {
    const keys = layerRowsFor(group.id).map((row) => row.key);
    assert.ok(!keys.includes("gdelt"), `${group.id} offers gdelt`);
    assert.ok(!keys.includes("cities"), `${group.id} offers cities`);
  }
});

test("an unknown group draws nothing rather than throwing", () => {
  assert.deepEqual(layerRowsFor("nope"), []);
});

test("the inferred layers are still labelled as inferences", () => {
  // Dark vessels and the traffic-density wash are both drawn from an absence
  // rather than a report, and the drawer tags them so. A control surface that
  // dropped the tag would be offering an inference as a record.
  assert.equal(LAYER_ROW.darkVessels.inferred, true);
  assert.equal(LAYER_ROW.laneDensity.inferred, true);
});
