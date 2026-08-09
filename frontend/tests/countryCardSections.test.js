// Task 9: four new country-card sections -- energy infrastructure, military
// & security, transport and data coverage (map/popups.js).
//
// Three pieces of arithmetic get their own direct tests per the task brief:
// summarizePowerPlants' tagged-fraction sum (including the all-untagged
// case, where OSM has the sites but not one output figure), the size-class
// bucketing shared by airports and ports, and buildCoverage's "no coverage"
// vs. "not loaded" distinction, exercised through countryCardSections since
// buildCoverage itself is internal. Same loader shim as countryCard.test.js
// -- map/popups.js pulls in map/decorators.js (Leaflet-backed) at module
// scope, so window.L is stubbed just enough to satisfy that import. Nothing
// here touches the DOM.

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
  countryCardSections, summarizePowerPlants, bucketAirportsByType, bucketPortsBySize,
} = await import("../src/map/popups.js");

const baseProps = { name: "Testland", iso_a2: "TL", iso_a3: "TST", population: 1_000_000 };
const bounds = { south: 0, west: 0, north: 10, east: 10 };

function emptyRaw(overrides = {}) {
  return {
    events: [], gdelt: [], officials: [], conflictStats: {}, escalation: [],
    adsb: [], ais: [], jamming: [], firms: [], infra: [], conflictDistricts: [],
    humanitarian: {}, outages: {}, energyFlows: {}, foodTrade: {},
    osmInfra: [], dams: [], airports: [], ports: [], cableLandings: [],
    ...overrides,
  };
}

test("summarizePowerPlants -- the tagged-fraction sum, including all-untagged", async (t) => {
  await t.test("a mix of tagged and untagged plants sums only the tagged ones", () => {
    const plants = [
      { output_mw: 1200, source_tag: "gas" },
      { output_mw: 300, source_tag: "hydro" },
      { output_mw: null, source_tag: "gas" }, // untagged: no output_mw at all
      { source_tag: "solar" }, // untagged: field absent entirely
    ];
    const summary = summarizePowerPlants(plants);
    assert.equal(summary.count, 4);
    assert.equal(summary.taggedCount, 2);
    assert.equal(summary.totalOutputMw, 1500, "sums only the two tagged plants, not all four");
    assert.deepEqual(summary.bySource, [["gas", 2], ["hydro", 1], ["solar", 1]]);
  });

  await t.test("every plant untagged -- the sum is 0, not NaN, and the fraction says so", () => {
    // This is the case the brief calls out by name: OSM has the sites, not
    // the numbers, and the failure this guards against is a 0 MW total being
    // read as "confirmed zero capacity" instead of "nothing to sum".
    const plants = [{ source_tag: "gas" }, { source_tag: "gas" }, { output_mw: undefined }];
    const summary = summarizePowerPlants(plants);
    assert.equal(summary.count, 3);
    assert.equal(summary.taggedCount, 0);
    assert.equal(summary.totalOutputMw, 0);
    assert.equal(Number.isNaN(summary.totalOutputMw), false);
  });

  await t.test("no plants at all", () => {
    assert.deepEqual(summarizePowerPlants([]), { count: 0, taggedCount: 0, totalOutputMw: 0, bySource: [] });
    assert.deepEqual(summarizePowerPlants(null), { count: 0, taggedCount: 0, totalOutputMw: 0, bySource: [] });
  });

  await t.test("output_mw of exactly 0 counts as tagged -- a reported zero is not the same as absent", () => {
    const summary = summarizePowerPlants([{ output_mw: 0, source_tag: "gas" }, { source_tag: "gas" }]);
    assert.equal(summary.taggedCount, 1);
    assert.equal(summary.totalOutputMw, 0);
  });
});

test("bucketAirportsByType / bucketPortsBySize -- size-class bucketing", async (t) => {
  await t.test("airports bucket by OurAirports' own type, dropping unclassified types into their own count", () => {
    const airports = [
      { type: "large_airport" }, { type: "large_airport" }, { type: "medium_airport" },
      { type: "small_airport" }, { type: "heliport" }, // not one of the three served sizes
    ];
    const bucketed = bucketAirportsByType(airports);
    assert.deepEqual(bucketed.counts, { large_airport: 2, medium_airport: 1, small_airport: 1 });
    assert.equal(bucketed.unclassified, 1, "heliport isn't in AIRFIELD_STYLE's size classes");
    assert.equal(bucketed.total, 5);
  });

  await t.test("ports bucket by harbor_size_label, with an unlabelled port counted as unclassified", () => {
    const ports = [
      { harbor_size_label: "Large" }, { harbor_size_label: "Large" },
      { harbor_size_label: "Small" }, { harbor_size_label: null },
    ];
    const bucketed = bucketPortsBySize(ports);
    assert.deepEqual(bucketed.counts, { Large: 2, Small: 1 });
    assert.equal(bucketed.unclassified, 1);
  });

  await t.test("an empty list buckets to nothing, not an error", () => {
    assert.deepEqual(bucketAirportsByType([]), { counts: {}, unclassified: 0, total: 0 });
  });
});

test("countryCardSections -- energy infrastructure: the mandatory OSM tagged-fraction caveat", async (t) => {
  await t.test("plants with a mix of tagged/untagged state the fraction and never call the sum a national total", () => {
    const raw = emptyRaw({
      osmInfra: [
        { id: "osm:way/1", kind: "power_plant", lat: 5, lon: 5, name: "Plant A", output_mw: 800, source_tag: "gas" },
        { id: "osm:way/2", kind: "power_plant", lat: 5, lon: 5, name: "Plant B", source_tag: "hydro" },
        { id: "osm:way/3", kind: "power_plant", lat: 5, lon: 5, name: "Plant C", source_tag: "hydro" },
        // Outside the bbox: must not be counted at all.
        { id: "osm:way/4", kind: "power_plant", lat: 50, lon: 50, name: "Plant D", output_mw: 9999, source_tag: "gas" },
      ],
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const energy = sections.find((s) => s.id === "energy");
    assert.ok(energy, "the section is present once there is a plant in bounds");
    assert.match(energy.html, /1 of 3 plants? tag a\s*\n?\s*generation capacity/s);
    assert.match(energy.html, /800 MW/);
    assert.match(energy.html, /not this country's generation capacity/);
    assert.doesNotMatch(energy.html, /9999/, "the out-of-bounds plant must not contribute to the sum");
  });

  await t.test("every plant in view untagged: no capacity figure is printed at all", () => {
    const raw = emptyRaw({
      osmInfra: [
        { id: "osm:way/1", kind: "power_plant", lat: 5, lon: 5, name: "Plant A", source_tag: "gas" },
        { id: "osm:way/2", kind: "power_plant", lat: 5, lon: 5, name: "Plant B", source_tag: "solar" },
      ],
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const energy = sections.find((s) => s.id === "energy");
    assert.match(energy.html, /None of the 2 plants found here\s+tag an output figure/);
    assert.doesNotMatch(energy.html, /<b>\d[\d.,]* MW<\/b>/, "no capacity number is fabricated when nothing is tagged");
  });

  await t.test("no plants, dams or landings in bounds: the section is dropped", () => {
    const { sections } = countryCardSections(baseProps, emptyRaw(), bounds);
    assert.equal(sections.find((s) => s.id === "energy"), undefined);
  });

  await t.test("Task 8's cross-border 'power' section is untouched by the new 'energy' section", () => {
    const raw = emptyRaw({
      energyFlows: { TL: { country_code: "TL", physical: { net: 0.4, unit: "GW" } } },
      osmInfra: [{ id: "osm:way/1", kind: "power_plant", lat: 5, lon: 5, name: "Plant A", output_mw: 10 }],
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    assert.ok(sections.find((s) => s.id === "power"), "cross-border flow still gets its own fold");
    assert.ok(sections.find((s) => s.id === "energy"), "generation infrastructure is a separate fold beside it");
  });
});

test("countryCardSections -- military: bbox caveat reused verbatim, sanctioned list is flag- not bbox-scoped", async (t) => {
  await t.test("reuses the exact live-section caveat sentence", () => {
    const raw = emptyRaw({
      osmInfra: [{ id: "osm:way/1", kind: "military_airfield", lat: 5, lon: 5, name: "Base One" }],
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const military = sections.find((s) => s.id === "military");
    assert.ok(military);
    assert.match(military.html, /Counted within the area currently loaded\./);
  });

  await t.test("a sanctioned vessel flagged to this country is listed regardless of its current position", () => {
    const raw = emptyRaw({
      ais: [{
        mmsi: 123456789, lat: 50, lon: 50, // far outside the country's bbox
        name: "MV Ghost", sanctions: { flag: "Testland", program: "SDN" },
      }],
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const military = sections.find((s) => s.id === "military");
    assert.ok(military, "the flag match alone is enough to produce a section");
    assert.match(military.html, /MV Ghost/);
    assert.match(military.html, /this list is <b>not<\/b>\s+limited to the area currently\s+loaded/);
  });

  await t.test("a sanctioned vessel flagged to a different country is not listed", () => {
    const raw = emptyRaw({
      ais: [{ mmsi: 1, lat: 5, lon: 5, name: "MV Other", sanctions: { flag: "Nowhereland", program: "SDN" } }],
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    assert.equal(sections.find((s) => s.id === "military"), undefined);
  });

  await t.test("nothing military in view: the section is dropped", () => {
    const { sections } = countryCardSections(baseProps, emptyRaw(), bounds);
    assert.equal(sections.find((s) => s.id === "military"), undefined);
  });
});

test("countryCardSections -- transport: airports/ports bucketed, oil terminals called out", async (t) => {
  await t.test("a port with an oil terminal is called out beside the size breakdown", () => {
    const raw = emptyRaw({
      ports: [{ id: "p1", lat: 5, lon: 5, name: "Port One", harbor_size_label: "Large", oil_terminal: true }],
      airports: [{ id: "a1", lat: 5, lon: 5, name: "Airport One", type: "large_airport" }],
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const transport = sections.find((s) => s.id === "transport");
    assert.ok(transport);
    assert.match(transport.html, /Large \(1\)/);
    assert.match(transport.html, /1<\/b> with an oil terminal/);
  });

  await t.test("nothing in view: the section is dropped", () => {
    const { sections } = countryCardSections(baseProps, emptyRaw(), bounds);
    assert.equal(sections.find((s) => s.id === "transport"), undefined);
  });
});

test("countryCardSections -- data coverage: the honesty section", async (t) => {
  await t.test("always present, even with every feed empty", () => {
    const { sections } = countryCardSections(baseProps, emptyRaw(), bounds);
    const coverage = sections.find((s) => s.id === "coverage");
    assert.ok(coverage, "never dropped, unlike every other section");
    assert.equal(sections[sections.length - 1].id, "coverage", "goes last");
  });

  await t.test("'no coverage' path: a feed present as an empty array reads as checked-and-empty", () => {
    const { sections } = countryCardSections(baseProps, emptyRaw({ ais: [] }), bounds);
    const coverage = sections.find((s) => s.id === "coverage");
    assert.match(coverage.html, /AIS vessel tracking[\s\S]*?No coverage here &mdash; checked, nothing found\./);
  });

  await t.test("'not loaded' path: a feed missing from raw entirely reads as never checked, not empty", () => {
    const raw = emptyRaw();
    delete raw.ais;
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const coverage = sections.find((s) => s.id === "coverage");
    assert.match(coverage.html, /AIS vessel tracking[\s\S]*?Not loaded this session &mdash; not checked\./);
    assert.doesNotMatch(coverage.html.match(/AIS vessel tracking[\s\S]*?<\/div><\/div>/)[0], /No coverage here/);
  });

  await t.test("a feed with a match inside bounds reports when it last delivered", () => {
    const raw = emptyRaw({ ais: [{ mmsi: 1, lat: 5, lon: 5, updated: Date.now() / 1000 - 120 }] });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const coverage = sections.find((s) => s.id === "coverage");
    assert.match(coverage.html, /AIS vessel tracking[\s\S]*?Last delivered 2m ago/);
  });

  await t.test("a reference gazetteer with no delivery time reports a count, not a fabricated timestamp", () => {
    const raw = emptyRaw({ dams: [{ id: "gdw:1", lat: 5, lon: 5, name: "Dam One" }] });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const coverage = sections.find((s) => s.id === "coverage");
    assert.match(coverage.html, /Global Dam Watch[\s\S]*?1 on file here, reference data with no delivery time/);
  });

  await t.test("with no bounds at all, the section says so once rather than per feed", () => {
    const { sections } = countryCardSections(baseProps, emptyRaw(), null);
    const coverage = sections.find((s) => s.id === "coverage");
    assert.ok(coverage);
    assert.match(coverage.html, /no bounding box loaded/);
    assert.match(coverage.html, /did not look here/);
  });

  await t.test("a point outside the bbox does not count as coverage", () => {
    const raw = emptyRaw({ ais: [{ mmsi: 1, lat: 50, lon: 50, updated: Date.now() / 1000 }] });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const coverage = sections.find((s) => s.id === "coverage");
    assert.match(coverage.html, /AIS vessel tracking[\s\S]*?No coverage here/);
  });
});
