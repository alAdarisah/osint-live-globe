// The admin search box's matching rule, asserted.
//
// AdminPanel.jsx and every sections/*.jsx file are not importable here -- they
// are JSX, and this suite runs under plain `node --test` with no build step
// (see placeInfoCard.test.js for the same constraint). matchesQuery is the one
// piece of the search box that is a pure function of two strings, pulled out
// into adminSearch.js for exactly this reason.

import test from "node:test";
import assert from "node:assert/strict";

import { matchesQuery } from "../src/components/admin/sections/adminSearch.js";

test("matchesQuery", async (t) => {
  await t.test("exact match", () => {
    assert.equal(matchesQuery("Icon size", "Icon size"), true);
  });

  await t.test("substring match", () => {
    assert.equal(matchesQuery("Icon size", "size"), true);
    assert.equal(matchesQuery("Icon size", "xyz"), false);
  });

  await t.test("case-insensitive", () => {
    assert.equal(matchesQuery("Icon size", "ICON"), true);
    assert.equal(matchesQuery("ICON SIZE", "icon"), true);
  });

  await t.test("empty query matches everything", () => {
    assert.equal(matchesQuery("Icon size", ""), true);
    assert.equal(matchesQuery("", ""), true);
  });

  await t.test("whitespace-only query matches everything", () => {
    assert.equal(matchesQuery("Icon size", "   "), true);
    assert.equal(matchesQuery("Icon size", "\t\n"), true);
  });
});
