// The curated glyph table, asserted against the things it has to stay in step
// with.
//
// GLYPH_CHOICES is hand-authored: for each pin type, the shapes that could
// honestly stand for that thing. Two ways it rots silently, and both would only
// show up as a pin rendering blank on someone's screen:
//
//   * a glyph is renamed or removed from the SVG dict, and a token still offers
//     it. The picker lists a name that resolves to nothing.
//   * a token is renamed in PALETTE_GROUPS, and the table still keys on the old
//     one. The picker quietly stops offering choices for that pin type.
//
// Neither is caught by a build. Both are caught here.

import test from "node:test";
import assert from "node:assert/strict";

import { SVG, GLYPH_CHOICES, shippedGlyph } from "../src/map/svgIcons.js";
import { PALETTE_GROUPS } from "../src/map/iconTheme.js";

const TOKEN_IDS = new Set(PALETTE_GROUPS.flatMap((group) => group.tokens.map((token) => token.id)));

test("the curated glyph table", async (t) => {
  await t.test("offers only glyphs the dict actually draws", () => {
    for (const [token, names] of Object.entries(GLYPH_CHOICES)) {
      for (const name of names) {
        assert.ok(SVG[name], `${token} offers "${name}", which is not in the SVG dict`);
      }
    }
  });

  await t.test("keys only on tokens the palette knows about", () => {
    for (const token of Object.keys(GLYPH_CHOICES)) {
      assert.ok(TOKEN_IDS.has(token), `"${token}" is not a palette token`);
    }
  });

  await t.test("offers no duplicates within a pin type", () => {
    for (const [token, names] of Object.entries(GLYPH_CHOICES)) {
      assert.equal(new Set(names).size, names.length, `${token} lists a glyph twice`);
    }
  });

  await t.test("names a shipped shape first for every pin type", () => {
    for (const token of Object.keys(GLYPH_CHOICES)) {
      const first = shippedGlyph(token);
      assert.ok(first, `${token} has no shipped glyph`);
      assert.equal(first, GLYPH_CHOICES[token][0]);
    }
  });

  await t.test("leaves out the three groups that have no glyph to swap", () => {
    // severity.* colours the conflict pin but does not choose its shape -- that
    // comes from the event's own text. The other three name a recolour, a ring
    // and a polyline. Offering any of them a shape would be offering a control
    // that changes nothing, or worse, one that flattens a distinction.
    for (const token of [
      "severity.critical", "severity.high", "severity.moderate", "severity.low",
      "event.corroborated", "sanctions.designated", "cable.route",
    ]) {
      assert.equal(token in GLYPH_CHOICES, false, `${token} should not be offered a shape`);
    }
  });
});
