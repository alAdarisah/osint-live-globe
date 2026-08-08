// One palette token per drawn shape, and the way back for configs that predate
// the rule.
//
// The bug this file exists for: a token is what the admin panel renders one row
// from, and it is what a colour, a size, a zoom range and a *shape* are stored
// under. So when several style rows that draw different glyphs shared one token,
// the panel offered one control for all of them -- and the shape picker was
// actively destructive, since choosing a glyph for "Airfield" flattened the
// large/medium/small runway layouts onto whichever one was picked. Four families
// were in that state: city bands, civil airfield tiers, the two OSM military
// kinds and the four OSM railway node kinds.
//
// Two things have to hold from here on, and neither is caught by a build:
//
//   * no two style rows drawing different glyphs may share a token, or the
//     control silently covers more than its label says
//   * every token a style row names must exist in the palette, or the row is a
//     pin nobody can configure at all
//
// map/decorators.js needs Leaflet and cannot be imported under `node --test`, so
// its style tables are read out of the source text -- the same technique, and
// the same reasoning, as editableSources.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PALETTE_GROUPS, TOKEN_LAYER, SPLIT_TOKENS, DEFAULT_COLORS } from "../src/map/iconTheme.js";
import { GLYPH_CHOICES, shippedGlyph } from "../src/map/svgIcons.js";

const decorators = readFileSync(new URL("../src/map/decorators.js", import.meta.url), "utf8");
const defaults = readFileSync(new URL("../src/settings/defaults.js", import.meta.url), "utf8");

const TOKEN_IDS = new Set(PALETTE_GROUPS.flatMap((group) => group.tokens.map((t) => t.id)));

/**
 * Every `svg: SVG.x ... token: "y"` pair in the style tables, as {glyph, token}.
 *
 * Both on one line, which every style row in decorators.js is written as. The
 * handful of sites that resolve a glyph from a variable (`svg: tier.svg`) are
 * not matched and do not need to be: the table the variable came from is.
 */
function styleRows() {
  return [...decorators.matchAll(/svg: SVG\.(\w+),[^\n]*?token: "([\w.]+)"/g)].map(
    ([, glyph, token]) => ({ glyph, token })
  );
}

test("a palette token names exactly one shape", async (t) => {
  await t.test("no two style rows with different glyphs share a token", () => {
    const glyphsByToken = new Map();
    for (const { glyph, token } of styleRows()) {
      if (!glyphsByToken.has(token)) glyphsByToken.set(token, new Set());
      glyphsByToken.get(token).add(glyph);
    }
    for (const [token, glyphs] of glyphsByToken) {
      assert.equal(
        glyphs.size,
        1,
        `${token} is drawn as ${[...glyphs].join(" and ")} -- one control, more than one shape`
      );
    }
  });

  await t.test("every token a style row names is in the palette", () => {
    for (const { token } of styleRows()) {
      assert.ok(TOKEN_IDS.has(token), `decorators.js draws "${token}", which the palette does not offer`);
    }
  });

  // The picker lists the shipped shape first and stores null for it (see
  // GlyphPicker in components/admin/fields.jsx), so "first in the list" and
  // "what the map draws untouched" have to be the same glyph -- otherwise the
  // row reads as modified the moment it is opened, and resetting it changes the
  // pin.
  await t.test("each token's glyph list leads with the shape its row draws", () => {
    for (const { glyph, token } of styleRows()) {
      if (!(token in GLYPH_CHOICES)) continue;
      assert.equal(shippedGlyph(token), glyph, `${token} draws ${glyph} but offers ${shippedGlyph(token)} first`);
    }
  });
});

test("the retired shared tokens", async (t) => {
  await t.test("are gone from the palette", () => {
    for (const legacy of Object.keys(SPLIT_TOKENS)) {
      assert.equal(legacy in DEFAULT_COLORS, false, `${legacy} was split but is still offered`);
      assert.equal(legacy in GLYPH_CHOICES, false, `${legacy} was split but still has a glyph list`);
    }
  });

  await t.test("were replaced by real, gateable pin types", () => {
    for (const [legacy, replacements] of Object.entries(SPLIT_TOKENS)) {
      assert.ok(replacements.length > 1, `${legacy} was "split" into ${replacements.length}`);
      for (const token of replacements) {
        assert.ok(TOKEN_IDS.has(token), `${legacy} -> ${token}, which the palette does not offer`);
        assert.ok(token in TOKEN_LAYER, `${legacy} -> ${token}, which has no layer to inherit a gate from`);
      }
    }
  });

  // The migration is what stops the split from silently resetting whatever an
  // operator had already set on one of these families: the loaders drop any key
  // the current build does not know, so a stored "airfield.civil" would just
  // vanish. Asserted against the source text because settings/defaults.js
  // cannot be imported here (see editableSources.test.js).
  await t.test("are carried into a stored config by every loader that can take them", () => {
    for (const field of ["colors", "sizes", "zooms", "zoomMaxes"]) {
      assert.match(
        defaults,
        new RegExp(`expandSplitTokens\\(stored\\.icons\\.${field}\\)`),
        `icons.${field} is not fanned out, so a pre-split config loses it`
      );
    }
    // Deliberately not the glyphs -- see SPLIT_TOKENS in map/iconTheme.js.
    assert.equal(defaults.includes("expandSplitTokens(stored.icons.glyphs)"), false);
  });
});
