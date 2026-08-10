// Task 30: tile tint -- the filter-string builder, the preset table, and the
// settings merge/migration that has to leave an old config (one saved before
// this key existed) on the shipped defaults.
//
// map/tileTint.js is a leaf module (no imports of its own -- see its own
// header note), so it can be imported directly here the way cursor.js and
// iconTheme.js already are in cursor.test.js/splitTokens.test.js.
// settings/defaults.js cannot be: it reaches map/iconTheme and map/scene
// through extensionless specifiers only Vite resolves (see
// editableSources.test.js's own note), so its merge/migration wiring is
// checked out of the source text instead, the same technique that file and
// splitTokens.test.js already use.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BLEND_MODES,
  DEFAULT_TILE_DIAL,
  TILE_TINT_PRESETS,
  TILE_TINT_PRESET_ORDER,
  buildTileFilter,
  mergeTileDial,
} from "../src/map/tileTint.js";

const defaults = readFileSync(new URL("../src/settings/defaults.js", import.meta.url), "utf8");

test("buildTileFilter", async (t) => {
  await t.test("the shipped default is the untouched string, not a no-op filter", () => {
    // "none" rather than "saturate(1) brightness(1) contrast(1) blur(0px)" --
    // every preset and every fresh config starts here, and it should cost the
    // browser nothing to paint.
    assert.equal(buildTileFilter(DEFAULT_TILE_DIAL), "none");
    assert.equal(buildTileFilter({}), "none");
  });

  await t.test("every dial past its default appears, at the extreme end of its range", () => {
    assert.equal(
      buildTileFilter({ saturate: 2, brightness: 1.7, contrast: 1.5, invert: true, blur: 3 }),
      "saturate(2) brightness(1.7) contrast(1.5) invert(1) blur(3px)"
    );
  });

  await t.test("at the other extreme", () => {
    assert.equal(
      buildTileFilter({ saturate: 0, brightness: 0.3, contrast: 0.5, invert: false, blur: 0 }),
      "saturate(0) brightness(0.3) contrast(0.5)"
    );
  });

  await t.test("only the fields that moved appear, in filter order", () => {
    assert.equal(buildTileFilter({ ...DEFAULT_TILE_DIAL, blur: 1.5 }), "blur(1.5px)");
    assert.equal(buildTileFilter({ ...DEFAULT_TILE_DIAL, contrast: 1.2 }), "contrast(1.2)");
    assert.equal(
      buildTileFilter({ ...DEFAULT_TILE_DIAL, saturate: 0.5, blur: 2 }),
      "saturate(0.5) blur(2px)"
    );
  });

  await t.test("tintColor/tintStrength/blendMode never appear -- they are the ::after, not the filter", () => {
    const withTint = buildTileFilter({ ...DEFAULT_TILE_DIAL, tintColor: "#ff0000", tintStrength: 1 });
    assert.equal(withTint, "none");
  });
});

test("the preset table", async (t) => {
  await t.test("offers exactly the six named in the brief, in that order", () => {
    assert.deepEqual(
      TILE_TINT_PRESET_ORDER.map((key) => TILE_TINT_PRESETS[key].label),
      ["Default", "Muted", "High contrast", "Night", "Amber", "Print"]
    );
  });

  await t.test("every order entry resolves to a real preset", () => {
    for (const key of TILE_TINT_PRESET_ORDER) {
      assert.ok(TILE_TINT_PRESETS[key], `${key} is in the order but not in the table`);
    }
    assert.equal(TILE_TINT_PRESET_ORDER.length, Object.keys(TILE_TINT_PRESETS).length);
  });

  await t.test("Default really is the untouched dial", () => {
    assert.deepEqual(TILE_TINT_PRESETS.default.dial, DEFAULT_TILE_DIAL);
  });

  await t.test("every preset's dial is a value mergeTileDial would accept unchanged", () => {
    // A preset that mergeTileDial would clamp or reject is a preset a reader
    // could click and then watch quietly change on the next reload.
    for (const [key, { dial }] of Object.entries(TILE_TINT_PRESETS)) {
      assert.deepEqual(mergeTileDial(dial), dial, `${key}'s dial does not round-trip through mergeTileDial`);
      assert.ok(BLEND_MODES.includes(dial.blendMode), `${key}: ${dial.blendMode} is not an offered blend mode`);
      assert.match(dial.tintColor, /^#[0-9a-f]{6}$/i, `${key}: ${dial.tintColor} is not a 6-digit hex colour`);
    }
  });
});

test("mergeTileDial", async (t) => {
  await t.test("a config that predates this key -- undefined, null, or the wrong type -- lands on the shipped default", () => {
    // This is the exact call mergeSettings makes when `stored.ui.tiles` (or
    // one of its three targets) is missing, which is what loading an old
    // saved configuration looks like.
    assert.deepEqual(mergeTileDial(undefined), DEFAULT_TILE_DIAL);
    assert.deepEqual(mergeTileDial(null), DEFAULT_TILE_DIAL);
    assert.deepEqual(mergeTileDial("not an object"), DEFAULT_TILE_DIAL);
    assert.deepEqual(mergeTileDial(42), DEFAULT_TILE_DIAL);
  });

  await t.test("an empty object also lands on the shipped default, field by field", () => {
    assert.deepEqual(mergeTileDial({}), DEFAULT_TILE_DIAL);
  });

  await t.test("a fully valid dial passes through untouched", () => {
    const dial = {
      tintColor: "#ff9500",
      tintStrength: 0.4,
      blendMode: "screen",
      saturate: 1.3,
      brightness: 0.9,
      contrast: 1.1,
      invert: true,
      blur: 1.5,
    };
    assert.deepEqual(mergeTileDial(dial), dial);
  });

  await t.test("numbers past the ceiling clamp down to it", () => {
    const merged = mergeTileDial({
      tintStrength: 5,
      saturate: 99,
      brightness: 99,
      contrast: 50,
      blur: 999,
    });
    assert.equal(merged.tintStrength, 1);
    assert.equal(merged.saturate, 2);
    assert.equal(merged.brightness, 1.7);
    assert.equal(merged.contrast, 1.5);
    assert.equal(merged.blur, 3);
  });

  await t.test("numbers past the floor clamp up to it", () => {
    const merged = mergeTileDial({ tintStrength: -5, saturate: -1, brightness: 0, contrast: 0, blur: -5 });
    assert.equal(merged.tintStrength, 0);
    assert.equal(merged.saturate, 0);
    assert.equal(merged.brightness, 0.3);
    assert.equal(merged.contrast, 0.5);
    assert.equal(merged.blur, 0);
  });

  await t.test("a colour that is not a 6-digit hex string is dropped, not passed through", () => {
    assert.equal(mergeTileDial({ tintColor: "red" }).tintColor, DEFAULT_TILE_DIAL.tintColor);
    assert.equal(mergeTileDial({ tintColor: "#fff" }).tintColor, DEFAULT_TILE_DIAL.tintColor);
    assert.equal(mergeTileDial({ tintColor: "javascript:alert(1)" }).tintColor, DEFAULT_TILE_DIAL.tintColor);
    // Case-insensitive is fine -- the colour picker only ever emits lower case,
    // but a hand-edited file might not.
    assert.equal(mergeTileDial({ tintColor: "#FF9500" }).tintColor, "#FF9500");
  });

  await t.test("a blend mode not in BLEND_MODES falls back rather than being stored", () => {
    assert.equal(mergeTileDial({ blendMode: "difference" }).blendMode, "multiply");
    assert.equal(mergeTileDial({ blendMode: "hue-rotate" }).blendMode, "multiply");
  });

  await t.test("invert only turns on for a real boolean true, not any truthy value", () => {
    assert.equal(mergeTileDial({ invert: true }).invert, true);
    assert.equal(mergeTileDial({ invert: "yes" }).invert, false);
    assert.equal(mergeTileDial({ invert: 1 }).invert, false);
  });
});

test("defaults.js wires the migration in, not just the shape", async (t) => {
  await t.test("the settings version was bumped for this key", () => {
    assert.match(defaults, /export const SETTINGS_VERSION = 2;/);
  });

  await t.test("defaultSettings() ships every dial inert", () => {
    assert.match(defaults, /tiles: \{/);
    assert.match(defaults, /basemap: \{ \.\.\.DEFAULT_TILE_DIAL \}/);
    assert.match(defaults, /imagery: \{ \.\.\.DEFAULT_TILE_DIAL \}/);
    assert.match(defaults, /weather: \{ \.\.\.DEFAULT_TILE_DIAL \}/);
  });

  await t.test("mergeSettings only touches ui.tiles when the stored config actually has one", () => {
    // This is the guard that makes an old config (no `ui.tiles` key at all)
    // load cleanly: isPlainObject fails, the branch is skipped entirely, and
    // base.ui.tiles is left exactly as defaultSettings() built it above.
    assert.match(defaults, /if \(isPlainObject\(stored\.ui\.tiles\)\) \{/);
  });

  await t.test("mergeSettings validates all three targets through mergeTileDial", () => {
    for (const target of ["basemap", "imagery", "weather"]) {
      assert.match(
        defaults,
        new RegExp(`base\\.ui\\.tiles\\.${target} = mergeTileDial\\(stored\\.ui\\.tiles\\.${target}\\)`),
        `${target} is not validated through mergeTileDial`
      );
    }
  });

  await t.test("imports the dial helpers from map/tileTint rather than redefining them", () => {
    assert.match(defaults, /import \{ DEFAULT_TILE_DIAL, mergeTileDial \} from "\.\.\/map\/tileTint";/);
  });
});
