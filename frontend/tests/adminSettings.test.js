// Task 31: the settings merge for every key this task added -- water,
// filters, inference, cards, performance -- including an old config that
// predates all five, and the three-state inference switch's persistence.
//
// defaults.js now reaches map/water.js (for MARINE_CLASSES) and
// map/severity.js (for DEFAULT_EVENT_FILTER, via utils/format.js and
// map/iconTheme.js) on top of the modules zoomCeiling.test.js/
// tileTint.test.js already taught the loader to resolve extensionlessly.
// map/water.js pulls in map/leafletGlobal.js, which reads `window.L` at
// import time -- the same obstacle those two tests already solve by
// stubbing `window` before the dynamic import below.

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

const { defaultSettings, mergeSettings, SETTINGS_VERSION } = await import("../src/settings/defaults.js");
const { MARINE_CLASSES } = await import("../src/map/water.js");
const { INFERENCE_PRODUCTS, INFERENCE_STATES, DEFAULT_INFERENCE_STATE } = await import(
  "../src/settings/inferenceProducts.js"
);
const { CARD_TYPES, CARD_SECTIONS, orderedCardSections } = await import("../src/settings/cardSections.js");

// A configuration saved by a build before this task -- SETTINGS_VERSION 2,
// with ui.tiles (Task 30) but none of water/filters/inference/cards/
// performance. mergeSettings must not throw on it and must produce the
// shipped default for every one of the five new keys.
function preTask31Config() {
  const stored = defaultSettings();
  delete stored.water;
  delete stored.filters;
  delete stored.inference;
  delete stored.cards;
  delete stored.performance;
  stored.version = 2;
  return stored;
}

test("the settings version was bumped for this task's shape change", () => {
  assert.equal(SETTINGS_VERSION, 3);
});

test("an old config missing all five new keys merges to the shipped defaults", () => {
  const merged = mergeSettings(preTask31Config());
  assert.deepEqual(merged.water, defaultSettings().water);
  assert.deepEqual(merged.filters, defaultSettings().filters);
  assert.deepEqual(merged.inference, defaultSettings().inference);
  assert.deepEqual(merged.cards, defaultSettings().cards);
  assert.deepEqual(merged.performance, defaultSettings().performance);
});

test("mergeSettings(null) still ships every new key", () => {
  const merged = mergeSettings(null);
  assert.ok(merged.water);
  assert.ok(merged.filters);
  assert.ok(merged.inference);
  assert.ok(merged.cards);
  assert.ok(merged.performance);
});

// --- water ------------------------------------------------------------

test("water", async (t) => {
  await t.test("ships one entry per marine class, all visible", () => {
    const water = defaultSettings().water;
    assert.deepEqual(water.hiddenClasses, []);
    assert.ok(MARINE_CLASSES.length > 0);
  });

  await t.test("a real value round-trips", () => {
    const stored = defaultSettings();
    stored.water = {
      hoverFillOpacity: 0.5,
      selectedFillOpacity: 0.6,
      outlineWeight: 2.5,
      hiddenClasses: ["ocean", "sea"],
      showLabels: true,
    };
    const merged = mergeSettings(stored).water;
    assert.equal(merged.hoverFillOpacity, 0.5);
    assert.equal(merged.selectedFillOpacity, 0.6);
    assert.equal(merged.outlineWeight, 2.5);
    assert.deepEqual(merged.hiddenClasses.sort(), ["ocean", "sea"]);
    assert.equal(merged.showLabels, true);
  });

  await t.test("opacity clamps to [0,1] rather than accepting anything", () => {
    const stored = defaultSettings();
    stored.water = { ...stored.water, hoverFillOpacity: 5, selectedFillOpacity: -3 };
    const merged = mergeSettings(stored).water;
    assert.equal(merged.hoverFillOpacity, 1);
    assert.equal(merged.selectedFillOpacity, 0);
  });

  await t.test("an unknown class is dropped rather than stored", () => {
    const stored = defaultSettings();
    stored.water = { ...stored.water, hiddenClasses: ["ocean", "atlantis"] };
    const merged = mergeSettings(stored).water;
    assert.deepEqual(merged.hiddenClasses, ["ocean"]);
  });

  await t.test("a duplicated class is stored once", () => {
    const stored = defaultSettings();
    stored.water = { ...stored.water, hiddenClasses: ["sea", "sea", "sea"] };
    const merged = mergeSettings(stored).water;
    assert.deepEqual(merged.hiddenClasses, ["sea"]);
  });

  await t.test("a non-array hiddenClasses falls back to the shipped empty list", () => {
    const stored = defaultSettings();
    stored.water = { ...stored.water, hiddenClasses: "ocean" };
    const merged = mergeSettings(stored).water;
    assert.deepEqual(merged.hiddenClasses, []);
  });
});

// --- filters ------------------------------------------------------------

test("filters", async (t) => {
  await t.test("ships no presets", () => {
    assert.deepEqual(defaultSettings().filters.presets, []);
  });

  await t.test("a well-formed preset round-trips with every sub-filter sanitized", () => {
    const stored = defaultSettings();
    stored.filters = {
      presets: [
        {
          id: "preset-1",
          name: "Sanctioned tankers",
          createdAt: 1700000000000,
          vesselFilter: { text: "tanker", sanctionedOnly: true, watchlistedOnly: false },
          aircraftFilter: { text: "", militaryOnly: true },
          eventFilter: { maxAgeDays: 7, minSeverity: 40, showImprecise: true, minConfidence: 0.5 },
        },
      ],
    };
    const merged = mergeSettings(stored).filters.presets;
    assert.equal(merged.length, 1);
    assert.equal(merged[0].name, "Sanctioned tankers");
    assert.equal(merged[0].vesselFilter.sanctionedOnly, true);
    assert.equal(merged[0].aircraftFilter.militaryOnly, true);
    assert.equal(merged[0].eventFilter.maxAgeDays, 7);
    assert.equal(merged[0].eventFilter.minSeverity, 40);
  });

  await t.test("a preset with no name or no id is dropped, not repaired", () => {
    const stored = defaultSettings();
    stored.filters = {
      presets: [
        { id: "a", name: "" },
        { id: "", name: "no id" },
        { name: "no id at all" },
      ],
    };
    assert.deepEqual(mergeSettings(stored).filters.presets, []);
  });

  await t.test("two presets sharing an id keep only the first", () => {
    const stored = defaultSettings();
    stored.filters = {
      presets: [
        { id: "dup", name: "first" },
        { id: "dup", name: "second" },
      ],
    };
    const merged = mergeSettings(stored).filters.presets;
    assert.equal(merged.length, 1);
    assert.equal(merged[0].name, "first");
  });

  await t.test("a malformed sub-filter falls back to that filter's own shipped default", () => {
    const stored = defaultSettings();
    stored.filters = {
      presets: [{ id: "a", name: "weird", vesselFilter: "not an object", eventFilter: null }],
    };
    const merged = mergeSettings(stored).filters.presets[0];
    assert.equal(merged.vesselFilter.text, "");
    assert.equal(merged.vesselFilter.sanctionedOnly, false);
    assert.equal(merged.eventFilter.showImprecise, false);
  });

  await t.test("a non-array presets list falls back to empty", () => {
    const stored = defaultSettings();
    stored.filters = { presets: "not an array" };
    assert.deepEqual(mergeSettings(stored).filters.presets, []);
  });
});

// --- inference: the three-state switch's persistence --------------------

test("inference mode", async (t) => {
  await t.test("every product defaults to 'labelled'", () => {
    const mode = defaultSettings().inference.mode;
    for (const product of INFERENCE_PRODUCTS) {
      assert.equal(mode[product.key], DEFAULT_INFERENCE_STATE);
    }
  });

  await t.test("each of the three states round-trips for each product", () => {
    for (const product of INFERENCE_PRODUCTS) {
      for (const state of INFERENCE_STATES) {
        const stored = defaultSettings();
        stored.inference = { mode: { [product.key]: state } };
        const merged = mergeSettings(stored).inference.mode;
        assert.equal(merged[product.key], state, `${product.key} -> ${state}`);
        // Every other product is untouched by setting just one.
        for (const other of INFERENCE_PRODUCTS) {
          if (other.key === product.key) continue;
          assert.equal(merged[other.key], DEFAULT_INFERENCE_STATE);
        }
      }
    }
  });

  await t.test("an unrecognised state falls back to labelled rather than being stored", () => {
    const stored = defaultSettings();
    stored.inference = { mode: { [INFERENCE_PRODUCTS[0].key]: "unlabel-it" } };
    const merged = mergeSettings(stored).inference.mode;
    assert.equal(merged[INFERENCE_PRODUCTS[0].key], "labelled");
  });

  await t.test("an unknown product key is dropped, not carried through", () => {
    const stored = defaultSettings();
    stored.inference = { mode: { notARealProduct: "hide" } };
    const merged = mergeSettings(stored).inference.mode;
    assert.equal(merged.notARealProduct, undefined);
  });

  await t.test("a config with no inference key at all still ships every product", () => {
    const stored = defaultSettings();
    delete stored.inference;
    const merged = mergeSettings(stored).inference.mode;
    for (const product of INFERENCE_PRODUCTS) assert.ok(merged[product.key]);
  });
});

// --- cards ----------------------------------------------------------------

test("cards", async (t) => {
  await t.test("ships nothing hidden, no order override, no defaultOpen override", () => {
    const cards = defaultSettings().cards;
    for (const { key } of CARD_TYPES) {
      assert.deepEqual(cards.hidden[key], []);
      assert.deepEqual(cards.order[key], []);
      assert.deepEqual(cards.defaultOpen[key], {});
    }
  });

  await t.test("a hidden section round-trips, an unknown one is dropped", () => {
    const stored = defaultSettings();
    const [cardType] = CARD_TYPES;
    const realId = CARD_SECTIONS[cardType.key][0].id;
    stored.cards.hidden[cardType.key] = [realId, "not-a-real-section"];
    const merged = mergeSettings(stored).cards.hidden[cardType.key];
    assert.deepEqual(merged, [realId]);
  });

  await t.test("orderedCardSections repairs a stored order missing a shipped id", () => {
    const cardType = "water";
    const shipped = CARD_SECTIONS[cardType].map((s) => s.id);
    const partial = shipped.slice(1); // drop the first id, as if it were added after this order was saved
    const result = orderedCardSections(cardType, partial);
    assert.deepEqual(result.slice(0, partial.length), partial);
    assert.equal(result[result.length - 1], shipped[0]);
    assert.equal(new Set(result).size, shipped.length);
  });

  await t.test("orderedCardSections falls back to the shipped order when nothing is stored", () => {
    const cardType = "district";
    assert.deepEqual(orderedCardSections(cardType, []), CARD_SECTIONS[cardType].map((s) => s.id));
    assert.deepEqual(orderedCardSections(cardType, null), CARD_SECTIONS[cardType].map((s) => s.id));
  });

  await t.test("a defaultOpen override round-trips only for known ids and boolean values", () => {
    const stored = defaultSettings();
    const cardType = "subdivision";
    const realId = CARD_SECTIONS[cardType][0].id;
    stored.cards.defaultOpen[cardType] = { [realId]: true, bogus: true, [CARD_SECTIONS[cardType][1].id]: "not a bool" };
    const merged = mergeSettings(stored).cards.defaultOpen[cardType];
    assert.deepEqual(merged, { [realId]: true });
  });
});

// --- performance ------------------------------------------------------------

test("performance", async (t) => {
  await t.test("every value ships as the map's own pre-Task-31 behaviour", () => {
    const perf = defaultSettings().performance;
    assert.equal(perf.shipTrailPoints, 300);
    assert.equal(perf.aircraftTrailPoints, 400);
    assert.equal(perf.satelliteTrailPoints, 36);
    assert.equal(perf.tankerTrailPoints, 60);
    assert.equal(perf.satSmallCadenceMs, 10_000);
    assert.equal(perf.satLargeCadenceMs, 60_000);
    assert.equal(perf.webglSpriteCap, null, "no cap by default -- there was none before this task");
    assert.equal(perf.pollIntervalMultiplier, 1);
    assert.equal(perf.pausePollingWhenHidden, true, "matches the prior unconditional skip");
  });

  await t.test("a real value round-trips", () => {
    const stored = defaultSettings();
    stored.performance = { ...stored.performance, shipTrailPoints: 500, pollIntervalMultiplier: 2, webglSpriteCap: 400 };
    const merged = mergeSettings(stored).performance;
    assert.equal(merged.shipTrailPoints, 500);
    assert.equal(merged.pollIntervalMultiplier, 2);
    assert.equal(merged.webglSpriteCap, 400);
  });

  await t.test("webglSpriteCap: null is a real, meaningful value, not a malformed one", () => {
    const stored = defaultSettings();
    stored.performance = { ...stored.performance, webglSpriteCap: 400 };
    let merged = mergeSettings(stored).performance;
    assert.equal(merged.webglSpriteCap, 400);
    stored.performance.webglSpriteCap = null;
    merged = mergeSettings(stored).performance;
    assert.equal(merged.webglSpriteCap, null);
  });

  await t.test("pausePollingWhenHidden stays on unless explicitly turned off", () => {
    const stored = defaultSettings();
    stored.performance = { ...stored.performance, pausePollingWhenHidden: false };
    assert.equal(mergeSettings(stored).performance.pausePollingWhenHidden, false);
    delete stored.performance.pausePollingWhenHidden;
    assert.equal(mergeSettings(stored).performance.pausePollingWhenHidden, true);
  });

  await t.test("a malformed number falls back to the shipped default rather than NaN", () => {
    const stored = defaultSettings();
    stored.performance = { ...stored.performance, shipTrailPoints: "lots", satLargeCadenceMs: null };
    const merged = mergeSettings(stored).performance;
    assert.equal(merged.shipTrailPoints, 300);
    assert.equal(merged.satLargeCadenceMs, 60_000);
  });
});
