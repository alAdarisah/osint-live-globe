// The zoom ceiling, at both levels it exists.
//
// The map has always had a floor -- "shows from zoom N", per layer and per pin
// type -- and nothing anywhere expressed the other end. LAYER_MANIFEST's
// `draw: null` means ungated, and ungated only ever meant "no floor", which is
// why satellites followed the camera all the way down to a street.
//
// These assert the storage and validation half: that a ceiling survives a round
// trip through mergeSettings, and that a malformed one falls back to "no
// ceiling" rather than to zero -- which would be a ceiling of z0 and would hide
// the layer everywhere.

import test from "node:test";
import assert from "node:assert/strict";

import { registerHooks } from "node:module";

// defaults.js reaches iconTheme.js and cursor.js, both written for Vite's
// extensionless resolution. Same hook webglHitTest.test.js installs, and for the
// same reason: teach the loader rather than change source for a test's benefit.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
});

// iconTheme.js reads no globals at import time, but cursor.js and leafletGlobal
// do, and defaults.js pulls both in through the import graph.
globalThis.window = {
  L: { Layer: { extend: () => ({}) }, DomUtil: {} },
  matchMedia: () => ({ matches: false }),
};

const { defaultSettings, mergeSettings } = await import("../src/settings/defaults.js");

test("the layer zoom ceiling", async (t) => {
  await t.test("ships as null, meaning no ceiling", () => {
    const layers = defaultSettings().layers;
    const [firstKey] = Object.keys(layers);
    assert.equal(layers[firstKey].maxZoom, null);
    assert.equal(layers[firstKey].minZoom, null, "the floor is still its own dial");
  });

  await t.test("survives a round trip", () => {
    const stored = defaultSettings();
    stored.layers.satellites = { ...stored.layers.satellites, maxZoom: 6 };
    assert.equal(mergeSettings(stored).layers.satellites.maxZoom, 6);
  });

  await t.test("keeps the floor and the ceiling independent", () => {
    const stored = defaultSettings();
    stored.layers.satellites = { ...stored.layers.satellites, minZoom: 2, maxZoom: 6 };
    const merged = mergeSettings(stored).layers.satellites;
    assert.equal(merged.minZoom, 2);
    assert.equal(merged.maxZoom, 6);
  });

  await t.test("falls back to no ceiling rather than to zero", () => {
    // The distinction that matters: 0 is a legitimate zoom, so coercing a
    // malformed value to it would hide the layer at every zoom instead of at
    // none -- a silent blackout rather than a no-op.
    for (const bad of ["6", null, undefined, NaN, {}, []]) {
      const stored = defaultSettings();
      stored.layers.satellites = { ...stored.layers.satellites, maxZoom: bad };
      assert.equal(
        mergeSettings(stored).layers.satellites.maxZoom,
        null,
        `${JSON.stringify(bad)} should mean no ceiling`
      );
    }
  });
});

test("the pin-type zoom ceiling", async (t) => {
  await t.test("ships a table shaped like the floor's", () => {
    const icons = defaultSettings().icons;
    assert.deepEqual(Object.keys(icons.zoomMaxes).sort(), Object.keys(icons.zooms).sort());
  });

  await t.test("survives a round trip and stays separate from the floor", () => {
    const stored = defaultSettings();
    const [token] = Object.keys(stored.icons.zoomMaxes);
    stored.icons.zoomMaxes[token] = 9;
    stored.icons.zooms[token] = 4;
    const merged = mergeSettings(stored).icons;
    assert.equal(merged.zoomMaxes[token], 9);
    assert.equal(merged.zooms[token], 4);
  });

  await t.test("drops a token this build does not have", () => {
    const stored = defaultSettings();
    stored.icons.zoomMaxes["not.a.real.token"] = 5;
    const merged = mergeSettings(stored).icons;
    assert.equal("not.a.real.token" in merged.zoomMaxes, false);
  });
});
