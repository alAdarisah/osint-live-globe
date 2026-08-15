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
// exactly the obstacle tokenSearchTerms.js's header comment describes. The
// registerHooks call below is the same extensionless-resolution patch
// layerGroups.test.js and adminSettings.test.js already carry; the window
// stub is for map/water.js's leafletGlobal.js, which reads window.L at
// import time and sits on defaults.js's import chain.

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

  await t.test("and findable by the words an operator would actually type", () => {
    assert.ok(SEARCH_TERMS.some((term) => matchesQuery(term, "space")));
    assert.ok(SEARCH_TERMS.some((term) => matchesQuery(term, "hazards")));
    assert.ok(SEARCH_TERMS.some((term) => matchesQuery(term, "sea traffic")));
  });
});
