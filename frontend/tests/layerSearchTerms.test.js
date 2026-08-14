// The Layers section's search coverage of individual pin types, asserted.
//
// LayerDialsSection.jsx itself is not importable here -- it is JSX, and this
// suite runs under plain `node --test` with no build step (see
// adminSearch.test.js for the same constraint). Past bug: its SEARCH_TERMS
// covered the section title, the four generic dial names and every layer's
// own name, but not the labels of the pin-type rows it actually renders
// (IconField, one per palette token) -- so a reader typing "helicopter" to
// find the helicopter pin's colour got a blank panel instead, one fold away
// from the control they wanted. ALL_TOKEN_LABELS is what closes that gap;
// this pins it down so it cannot reopen silently.

import test from "node:test";
import assert from "node:assert/strict";

import { matchesQuery } from "../src/components/admin/sections/adminSearch.js";
import { ALL_TOKEN_LABELS } from "../src/components/admin/sections/tokenSearchTerms.js";

test("ALL_TOKEN_LABELS", async (t) => {
  await t.test("includes a real pin type's label", () => {
    assert.ok(ALL_TOKEN_LABELS.includes("Helicopter"));
  });

  await t.test("is what a search box would need to find it", () => {
    assert.ok(ALL_TOKEN_LABELS.some((label) => matchesQuery(label, "helicopter")));
    assert.ok(ALL_TOKEN_LABELS.some((label) => matchesQuery(label, "OFAC")));
  });
});
