// The choropleth's state target (Task 26): metricsForTarget's filtering, the
// admin-1 join regionOutageFor performs, and the new state-level outage
// metric's rank ramp -- end to end through buildChoropleth, the same entry
// point the map controller calls.
//
// Same setup as districtCard.test.js: map/choropleth.js pulls in map/popups.js,
// which pulls in map/decorators.js (Leaflet-backed) at module scope, so this
// stubs just enough of `window.L` to satisfy that import and teaches the
// loader to resolve the extensionless relative imports the way Vite does.
// Nothing here touches the DOM.

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

globalThis.window = { L: { geoJSON: () => ({}) } };

const {
  CHOROPLETH_METRICS, metricsForTarget, metricById, buildChoropleth,
} = await import("../src/map/choropleth.js");
const { regionOutageFor } = await import("../src/map/popups.js");

// One country, ISO2 DZ / ISO3 DZA, carrying both codes the way
// backend/sources/countries.py's features do.
const countryFeature = (iso2, iso3) => ({
  type: "Feature",
  properties: { iso_a2: iso2, iso_a3: iso3, name: "Testland" },
});

const stateFeature = (code, countryCode, name) => ({
  type: "Feature",
  properties: { code, country_code: countryCode, name },
});

function rawWith(outagesRegions, countries = [countryFeature("DZ", "DZA")]) {
  return { countries: { type: "FeatureCollection", features: countries }, outagesRegions };
}

test("metricsForTarget", async (t) => {
  await t.test("defaults to country metrics, excluding the state one", () => {
    const ids = metricsForTarget("country").map((m) => m.id);
    assert.ok(ids.includes("outages"));
    assert.ok(!ids.includes("state_outages"));
    // Every metric that predates Task 26 has no explicit target and must
    // still be reachable through the default.
    assert.equal(metricsForTarget("country").length, CHOROPLETH_METRICS.length - 1);
  });

  await t.test("the state target offers only the state metric", () => {
    const metrics = metricsForTarget("state");
    assert.deepEqual(metrics.map((m) => m.id), ["state_outages"]);
  });

  await t.test("an unrecognised target falls back to country", () => {
    assert.equal(metricsForTarget(undefined).length, metricsForTarget("country").length);
  });
});

test("regionOutageFor", async (t) => {
  await t.test("joins a state's ISO3 to the ISO2-keyed region payload", () => {
    const raw = rawWith({
      DZ: { "DZ-23": { matched: "exact", region_code: "DZ-23", score: 5e9, signals: {}, country_code: "DZ" } },
    });
    const record = regionOutageFor({ code: "DZ-23", country_code: "DZA" }, raw);
    assert.ok(record);
    assert.equal(record.score, 5e9);
  });

  await t.test("an unmatched record never resolves -- there is no shape it is the record of", () => {
    const raw = rawWith({
      DZ: { 906: { matched: "unmatched", region_code: null, score: 5e9, signals: {}, country_code: "DZ" } },
    });
    // Even a state feature that happens to carry no code at all must not
    // accidentally match an unmatched record keyed by IODA's bare entity code.
    assert.equal(regionOutageFor({ code: "", country_code: "DZA" }, raw), null);
  });

  await t.test("no lookup at all for the country is a clean miss, not a throw", () => {
    assert.equal(regionOutageFor({ code: "DZ-23", country_code: "DZA" }, rawWith({})), null);
  });
});

test("buildChoropleth over the state target", async (t) => {
  const raw = rawWith({
    DZ: {
      "DZ-23": { matched: "exact", region_code: "DZ-23", score: 9e9, signals: {}, country_code: "DZ" },
      "DZ-07": { matched: "fuzzy", region_code: "DZ-07", score: 1e9, signals: {}, country_code: "DZ" },
      1286: { matched: "unmatched", region_code: null, score: 5e9, signals: {}, country_code: "DZ" },
    },
  });
  const features = [
    stateFeature("DZ-23", "DZA", "Annaba"),
    stateFeature("DZ-07", "DZA", "Sirdaryo"),
    // A third state IODA never scored at all -- must stay unpainted, not zero.
    stateFeature("DZ-99", "DZA", "Quiet Province"),
  ];

  await t.test("only matched regions get a value; the unmatched one and the unscored one do not", () => {
    const result = buildChoropleth("state_outages", features, raw);
    assert.equal(result.metric.id, "state_outages");
    assert.equal(result.covered, 2);
    assert.equal(result.total, 3);
    assert.ok(result.styleFor(features[0].properties));
    assert.ok(result.styleFor(features[1].properties));
    assert.equal(result.styleFor(features[2].properties), null);
  });

  await t.test("ranked, not scaled -- the higher score paints the stronger fill", () => {
    const result = buildChoropleth("state_outages", features, raw);
    const high = result.styleFor(features[0].properties); // 9e9
    const low = result.styleFor(features[1].properties); // 1e9
    assert.ok(high.fillOpacity > low.fillOpacity);
  });

  await t.test("no features at all is the empty result, not a throw", () => {
    const result = buildChoropleth("state_outages", [], raw);
    assert.equal(result.metric, null);
    assert.equal(result.covered, 0);
    assert.equal(result.total, 0);
  });
});

test("the state metric formats and describes itself like every other one", () => {
  const metric = metricById("state_outages");
  assert.ok(metric.note.includes("IODA"));
  assert.equal(metric.format(1.23e9), "IODA score 1.23e+9");
});
