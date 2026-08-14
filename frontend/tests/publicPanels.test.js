// The two Admin Mode settings that decide what a reader is shown: which of the
// intel panel's tabs (and the briefing card) the public page carries, and which
// pin layers wait for a country to be selected.
//
// Both are storage-and-validation tests. The drawing half lives in the map
// controller, which needs a real Leaflet map to exercise; what is asserted here
// is the part a hand-edited or imported configuration can break -- that a
// setting survives a round trip, and that a malformed one fails in the safe
// direction rather than the destructive one.

import test from "node:test";
import assert from "node:assert/strict";

import { registerHooks } from "node:module";

// Same loader hook and window stub zoomCeiling.test.js installs, and for the
// same reason: defaults.js reaches iconTheme.js, cursor.js and leafletGlobal
// through its import graph, all written for Vite's extensionless resolution.
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

const { defaultSettings, mergeSettings, COUNTRY_ONLY_LAYERS, INTEL_TAB_KEYS } =
  await import("../src/settings/defaults.js");

const ALL_ON = {
  escalation: true, events: true, news: true, officials: true, briefingCard: true,
};

test("the reader panels", async (t) => {
  await t.test("every tab and the briefing card ship on", () => {
    assert.deepEqual(defaultSettings().publicPanels, ALL_ON);
  });

  await t.test("the tab keys are the ones IntelPanel draws", () => {
    // The three files agree on a key rather than translating between three
    // vocabularies -- App.jsx filters INTEL_TAB_KEYS by this table and hands
    // the result to IntelPanel, which filters its own TABS by it.
    for (const key of INTEL_TAB_KEYS) {
      assert.equal(key in defaultSettings().publicPanels, true, `${key} should be settable`);
    }
  });

  await t.test("survives a round trip", () => {
    const stored = defaultSettings();
    stored.publicPanels.news = false;
    const merged = mergeSettings(stored).publicPanels;
    assert.equal(merged.news, false);
    assert.equal(merged.events, true, "the others are untouched");
    assert.equal(merged.briefingCard, true);
  });

  await t.test("a configuration written before this setting existed keeps every panel", () => {
    // The failure this prevents: an older saved config has no publicPanels key
    // at all, and a missing key must not read as "the operator hid it".
    const stored = defaultSettings();
    delete stored.publicPanels;
    assert.deepEqual(mergeSettings(stored).publicPanels, ALL_ON);
  });

  await t.test("only an explicit false hides a panel", () => {
    for (const value of [undefined, null, 0, "", "no"]) {
      const stored = defaultSettings();
      stored.publicPanels.news = value;
      assert.equal(
        mergeSettings(stored).publicPanels.news,
        true,
        `${JSON.stringify(value)} should leave the tab showing`
      );
    }
  });
});

test("the country gate on a layer", async (t) => {
  await t.test("ships off on every layer", () => {
    const layers = defaultSettings().layers;
    for (const [key, style] of Object.entries(layers)) {
      assert.equal(style.countryOnly, false, `${key} should ship ungated`);
    }
  });

  await t.test("survives a round trip", () => {
    const stored = defaultSettings();
    stored.layers.airports = { ...stored.layers.airports, countryOnly: true };
    assert.equal(mergeSettings(stored).layers.airports.countryOnly, true);
  });

  await t.test("stays independent of the zoom dials", () => {
    const stored = defaultSettings();
    stored.layers.airports = { ...stored.layers.airports, countryOnly: true, minZoom: 5, maxZoom: 11 };
    const merged = mergeSettings(stored).layers.airports;
    assert.equal(merged.countryOnly, true);
    assert.equal(merged.minZoom, 5);
    assert.equal(merged.maxZoom, 11);
  });

  await t.test("anything but a real boolean is dropped rather than coerced", () => {
    // A truthy string is how a hand-edited file says "on" and means "this layer
    // now draws nothing until somebody finds the checkbox" -- too large a
    // consequence for a guess. Same rule layerWish uses.
    for (const bad of ["true", 1, {}, [], "yes"]) {
      const stored = defaultSettings();
      stored.layers.airports = { ...stored.layers.airports, countryOnly: bad };
      assert.equal(
        mergeSettings(stored).layers.airports.countryOnly,
        false,
        `${JSON.stringify(bad)} should leave the layer ungated`
      );
    }
  });

  await t.test("a layer with no pin to clip cannot be gated", () => {
    // Density canvases and polylines have no per-item mark the clip could keep
    // or drop, and cities is already country-scoped by its own renderer. None
    // of them is offered the checkbox, so a file naming one is asking for
    // something the renderers do not implement.
    for (const key of [
      "cities", "firms", "jamming", "laneDensity",
      "cables", "railways", "powerLines", "water", "shippingLanes",
    ]) {
      assert.equal(COUNTRY_ONLY_LAYERS.has(key), false, `${key} should not be on offer`);
      const stored = defaultSettings();
      stored.layers[key] = { ...stored.layers[key], countryOnly: true };
      assert.equal(
        mergeSettings(stored).layers[key].countryOnly,
        false,
        `${key} should stay ungated`
      );
    }
  });

  await t.test("the layers that do draw pins are on offer", () => {
    for (const key of [
      "events", "airports", "osmInfra", "adsbMilitary", "aisTanker",
      // Every satellite layer, bulk WebGL ones included: a satellite is a pin
      // with a real position, and renderSatElementWebgl clips it like any other.
      "satellites", "satNavigation", "satStarlink",
      // Layers that did not exist when this gate was first written.
      "powerPlants", "airDefense", "railLive",
    ]) {
      assert.equal(COUNTRY_ONLY_LAYERS.has(key), true, `${key} should be on offer`);
    }
  });
});
