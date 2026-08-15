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
//
// layerSectionTerms.js's SEARCH_TERMS also pulls in SETTINGS_LAYERS from
// settings/defaults.js, whose own imports are not extension-qualified --
// exactly the obstacle tokenSearchTerms.js's header comment describes.
// helpers/nodeTestEnv.js carries the extensionless-resolution patch and the
// window stub map/water.js's leafletGlobal.js needs (it reads window.L at
// import time and sits on defaults.js's import chain) -- see that file for
// why it must stay the first import here.

import "./helpers/nodeTestEnv.js";

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

// Admin Mode's Layers section is filed under six subject headings, and the
// admin search hides a whole section unless one of its terms matches. A
// heading an operator can read on screen but cannot search for is a control
// that only works if you already knew where it was.
test("group titles are searchable", async (t) => {
  const { LAYER_GROUPS } = await import("../src/settings/layerGroups.js");
  const { SEARCH_TERMS } = await import("../src/components/admin/sections/layerSectionTerms.js");

  for (const group of LAYER_GROUPS) {
    assert.ok(SEARCH_TERMS.includes(group.title), `"${group.title}" is not searchable`);
  }

  // matchesQuery is a plain case-insensitive substring test, so a query only
  // constrains anything if its text is not already a substring of some other
  // term SEARCH_TERMS carries for an unrelated reason. Three of the six group
  // titles fail that test: "space" is a literal substring of "Airspace
  // warnings (EASA CZIB)" (the czib layer's own label), "hazards" of "Natural
  // hazards" (the hazards layer's own label), and "aviation" of "General
  // aviation" (a pin-type label under Aircraft). Querying any of those three
  // would pass even with every group title stripped out of SEARCH_TERMS, so
  // it would not be testing group-title searchability at all -- it would just
  // be re-discovering an unrelated label. The two queries below are the ones
  // left that do not have that problem: "environment" and "sea traffic" occur
  // in SEARCH_TERMS only via "Infrastructure & Environment" and "Air & Sea
  // Traffic" respectively, so each one genuinely depends on its title being
  // present. The exact-membership loop above this block already covers all
  // six titles, including the three that can't be substring-tested here.
  await t.test("and findable by the words an operator would actually type", () => {
    assert.ok(SEARCH_TERMS.some((term) => matchesQuery(term, "sea traffic")));
    assert.ok(SEARCH_TERMS.some((term) => matchesQuery(term, "environment")));
  });
});
