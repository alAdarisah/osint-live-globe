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
  countryCardSections, summarizePowerPlants, bucketAirportsByType, bucketPortsBySize, coverageStateFor,
} = await import("../src/map/popups.js");

const baseProps = { name: "Testland", iso_a2: "TL", iso_a3: "TST", population: 1_000_000 };
const bounds = { south: 0, west: 0, north: 10, east: 10 };

// Real apps never leave fetchCoverage empty for long, but a test bag defaults
// to it -- same as every raw[key] defaulting to [] -- so that omitting it
// entirely (as most tests below do, for feeds coverage isn't the point of)
// exercises the "never fetched" path deliberately, not by accident.
function emptyRaw(overrides = {}) {
  return {
    events: [], gdelt: [], officials: [], conflictStats: {}, escalation: [],
    adsb: [], ais: [], jamming: [], firms: [], infra: [], conflictDistricts: [],
    humanitarian: {}, outages: {}, energyFlows: {}, foodTrade: {},
    osmInfra: [], powerPlants: [], dams: [], airports: [], ports: [], cableLandings: [],
    fetchCoverage: {},
    ...overrides,
  };
}

// A fetchCoverage entry for a feed that has definitely been fetched and
// definitely covers whatever bbox is being tested -- unscoped, so no bbox
// comparison even applies. The shape recordCoverageRef writes on a real
// success (useOsintData.js).
function fetchedUnscoped(at = Date.now()) {
  return { status: "fetched", fetchedAt: at, bbox: null, scoped: false };
}

// The scoped counterpart: fetched, and covering exactly `box` (a
// "south,west,north,east" bbox cell string, matching bboxCell's own format).
function fetchedScopedTo(box, at = Date.now()) {
  return { status: "fetched", fetchedAt: at, bbox: box, scoped: true };
}

test("summarizePowerPlants -- the tagged-fraction sum, including all-untagged", async (t) => {
  await t.test("a mix of tagged and untagged plants sums only the tagged ones", () => {
    // Every real record carries both the raw OSM tag and the backend's own
    // normalised `fuel` (osm_infra.py's _fuel_category) -- both are given
    // here, including a case where they visibly disagree (`source_tag:
    // "natural gas"` vs. `fuel: "gas"`), the same review finding
    // (Important 1) that moved bySource's grouping key from the former to
    // the latter: three raw spellings of "gas" must read as one bucket.
    const plants = [
      { output_mw: 1200, source_tag: "gas", fuel: "gas" },
      { output_mw: 300, source_tag: "hydro", fuel: "hydro" },
      { output_mw: null, source_tag: "natural gas", fuel: "gas" }, // untagged: no output_mw at all
      { source_tag: "solar", fuel: "solar" }, // untagged: field absent entirely
    ];
    const summary = summarizePowerPlants(plants);
    assert.equal(summary.count, 4);
    assert.equal(summary.taggedCount, 2);
    assert.equal(summary.totalOutputMw, 1500, "sums only the two tagged plants, not all four");
    assert.deepEqual(summary.byFuel, [["gas", 2], ["hydro", 1], ["solar", 1]],
      "two raw tag spellings of gas ('gas', 'natural gas') collapse to one bucket via the normalised fuel");
  });

  await t.test("every plant untagged -- the sum is 0, not NaN, and the fraction says so", () => {
    // This is the case the brief calls out by name: OSM has the sites, not
    // the numbers, and the failure this guards against is a 0 MW total being
    // read as "confirmed zero capacity" instead of "nothing to sum".
    const plants = [{ fuel: "gas" }, { fuel: "gas" }, { output_mw: undefined, fuel: "gas" }];
    const summary = summarizePowerPlants(plants);
    assert.equal(summary.count, 3);
    assert.equal(summary.taggedCount, 0);
    assert.equal(summary.totalOutputMw, 0);
    assert.equal(Number.isNaN(summary.totalOutputMw), false);
  });

  await t.test("no plants at all", () => {
    assert.deepEqual(summarizePowerPlants([]), { count: 0, taggedCount: 0, totalOutputMw: 0, byFuel: [] });
    assert.deepEqual(summarizePowerPlants(null), { count: 0, taggedCount: 0, totalOutputMw: 0, byFuel: [] });
  });

  await t.test("output_mw of exactly 0 counts as tagged -- a reported zero is not the same as absent", () => {
    const summary = summarizePowerPlants([{ output_mw: 0, fuel: "gas" }, { fuel: "gas" }]);
    assert.equal(summary.taggedCount, 1);
    assert.equal(summary.totalOutputMw, 0);
  });

  await t.test("a plant missing `fuel` entirely (an older cached record) buckets as unclassified, not crashes", () => {
    const summary = summarizePowerPlants([{ output_mw: 5, source_tag: "gas" }]);
    assert.equal(summary.count, 1);
    assert.deepEqual(summary.byFuel, [], "no fuel field to group on -- tallyBy's unclassified bucket, not a fabricated one");
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
    // Task 28: power plants moved off raw.osmInfra onto their own
    // raw.powerPlants array (see createMapController.js's applyData split).
    const raw = emptyRaw({
      powerPlants: [
        { id: "osm:way/1", kind: "power_plant", lat: 5, lon: 5, name: "Plant A", output_mw: 800, source_tag: "gas", fuel: "gas" },
        { id: "osm:way/2", kind: "power_plant", lat: 5, lon: 5, name: "Plant B", source_tag: "hydro", fuel: "hydro" },
        { id: "osm:way/3", kind: "power_plant", lat: 5, lon: 5, name: "Plant C", source_tag: "hydro", fuel: "hydro" },
        // Outside the bbox: must not be counted at all.
        { id: "osm:way/4", kind: "power_plant", lat: 50, lon: 50, name: "Plant D", output_mw: 9999, source_tag: "gas", fuel: "gas" },
      ],
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const energy = sections.find((s) => s.id === "energy");
    assert.ok(energy, "the section is present once there is a plant in bounds");
    assert.match(energy.html, /1 of 3 plants? tag a\s*\n?\s*generation capacity/s);
    assert.match(energy.html, /800 MW/);
    assert.match(energy.html, /not this country's generation capacity/);
    assert.doesNotMatch(energy.html, /9999/, "the out-of-bounds plant must not contribute to the sum");
    // Review fix (Task 28, Important 1): "By fuel" groups on the normalised
    // fuel, shown with its display label, not the raw OSM tag text.
    assert.match(energy.html, /By fuel: Hydro \(2\), Gas \(1\)/);
  });

  await t.test("every plant in view untagged: no capacity figure is printed at all", () => {
    const raw = emptyRaw({
      powerPlants: [
        { id: "osm:way/1", kind: "power_plant", lat: 5, lon: 5, name: "Plant A", source_tag: "gas", fuel: "gas" },
        { id: "osm:way/2", kind: "power_plant", lat: 5, lon: 5, name: "Plant B", source_tag: "solar", fuel: "solar" },
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
      energyFlows: {
        TL: {
          country_code: "TL",
          physical: {
            net: 0.4, unit: "GW", resolution: "PT15M", interval_minutes: 15,
            available_from: "2026-08-06T00:00:00+00:00", measurement: "measured", counterparts: [],
            net_series: [{ t: "a", net: 0.1 }, { t: "b", net: 0.4 }],
          },
        },
      },
      powerPlants: [{ id: "osm:way/1", kind: "power_plant", lat: 5, lon: 5, name: "Plant A", output_mw: 10 }],
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const power = sections.find((s) => s.id === "power");
    const energy = sections.find((s) => s.id === "energy");
    assert.ok(power, "cross-border flow still gets its own fold");
    assert.ok(energy, "generation infrastructure is a separate fold beside it");
    // Not just "the section exists" -- the actual Task 8 content (the
    // net-flow sparkline and its coverage line) has to still be there,
    // unchanged, or "untouched" is an unverified claim.
    assert.match(power.html, /Net position, 2 intervals \(GW, measured\)/, "the net_series sparkline still renders");
    assert.match(power.html, /Coverage reported: from 2026-08-06T00:00:00\+00:00 at 15-minute intervals/, "the coverage line still renders");
    assert.doesNotMatch(power.html, /Plant A|power plants \(OSM\)/, "the new infrastructure content stays out of 'power'");
  });
});

test("countryCardSections -- energy infrastructure: Task 28 additions (substations, refineries/terminals/storage)", async (t) => {
  await t.test("substations are counted from the generic OSM infrastructure layer", () => {
    const raw = emptyRaw({
      osmInfra: [
        { id: "osm:way/1", kind: "power_substation", lat: 5, lon: 5, name: "Sub A" },
        // Outside the bbox: must not be counted.
        { id: "osm:way/2", kind: "power_substation", lat: 50, lon: 50, name: "Sub B" },
      ],
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const energy = sections.find((s) => s.id === "energy");
    assert.ok(energy, "a substation alone is enough to earn the section");
    assert.match(energy.html, /substations \(OSM\)[\s\S]*1/);
  });

  await t.test("curated and OSM refineries/terminals/storage are counted and listed separately, never summed", () => {
    const raw = emptyRaw({
      infra: [{ id: "curated_1", type: "refinery", lat: 5, lon: 5, name: "Curated Refinery" }],
      osmInfra: [
        { id: "osm:way/1", kind: "refinery", lat: 5, lon: 5, name: "OSM Refinery" },
        { id: "osm:way/2", kind: "storage_tank", lat: 5, lon: 5, name: "Tank A" },
      ],
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const energy = sections.find((s) => s.id === "energy");
    assert.ok(energy);
    assert.match(energy.html, /Refineries, terminals/);
    assert.match(energy.html, /Curated Refinery/);
    assert.match(energy.html, /1 curated/);
    assert.match(energy.html, /2 from OpenStreetMap/);
    assert.match(energy.html, /kept apart rather than summed/);
  });

  await t.test("a curated port that is not energy-related (no refinery/lng_terminal/port type match) is excluded", () => {
    const raw = emptyRaw({ infra: [{ id: "x", type: "fab", lat: 5, lon: 5, name: "Some Fab" }] });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    assert.equal(sections.find((s) => s.id === "energy"), undefined);
  });
});

test("countryCardSections -- grid stress (Task 28): net exchange and outage score together", async (t) => {
  await t.test("both signals present: shown side by side, never combined into one number", () => {
    const raw = emptyRaw({
      energyFlows: {
        TL: {
          country_code: "TL",
          physical: {
            net: 0.4, unit: "GW", resolution: "PT15M", interval_minutes: 15,
            net_series: [{ t: "a", net: 0.1 }, { t: "b", net: 0.4 }],
          },
        },
      },
      outages: { TL: { country_code: "TL", score: 42, window_start: 0, window_end: 3600, signals: {} } },
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const gridStress = sections.find((s) => s.id === "gridStress");
    assert.ok(gridStress, "both an exchange figure and an outage score are present");
    assert.match(gridStress.html, /\+0\.40 GW/);
    assert.match(gridStress.html, /42/);
    assert.match(gridStress.html, /IODA outage score/);
    assert.match(gridStress.html, /never combined|not a causal claim/);
  });

  await t.test("neither signal present: the section is dropped", () => {
    const { sections } = countryCardSections(baseProps, emptyRaw(), bounds);
    assert.equal(sections.find((s) => s.id === "gridStress"), undefined);
  });

  await t.test("only the outage score: the exchange side says so rather than staying silent", () => {
    const raw = emptyRaw({
      outages: { TL: { country_code: "TL", score: 10, window_start: 0, window_end: 3600, signals: {} } },
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const gridStress = sections.find((s) => s.id === "gridStress");
    assert.ok(gridStress);
    assert.match(gridStress.html, /No cross-border electricity data published/);
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

  await t.test("carries the bbox-load caveat, same as military and live -- airports/ports are itemsInBounds counts too", () => {
    const raw = emptyRaw({
      airports: [{ id: "a1", lat: 5, lon: 5, name: "Airport One", type: "large_airport" }],
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const transport = sections.find((s) => s.id === "transport");
    assert.ok(transport);
    assert.match(transport.html, /Counted within the area currently loaded\./);
  });

  await t.test("nothing in view: the section is dropped", () => {
    const { sections } = countryCardSections(baseProps, emptyRaw(), bounds);
    assert.equal(sections.find((s) => s.id === "transport"), undefined);
  });
});

test("coverageStateFor -- the three states a feed's coverage can be in", async (t) => {
  await t.test("no entry in raw.fetchCoverage at all: never fetched", () => {
    assert.equal(coverageStateFor("ais", bounds, emptyRaw()), "not_loaded");
  });

  await t.test("an entry with fetchedAt still null (recorded as gated, never yet succeeded): never fetched", () => {
    const raw = emptyRaw({ fetchCoverage: { ais: { status: "gated", scoped: true } } });
    assert.equal(coverageStateFor("ais", bounds, raw), "not_loaded");
  });

  await t.test("fetched, unscoped: checked, regardless of any bbox", () => {
    const raw = emptyRaw({ fetchCoverage: { events: fetchedUnscoped() } });
    assert.equal(coverageStateFor("events", bounds, raw), "checked");
  });

  await t.test("fetched, scoped, but bbox is null (the 'essentially the whole world' case): checked", () => {
    const raw = emptyRaw({ fetchCoverage: { osmInfra: { status: "fetched", fetchedAt: Date.now(), bbox: null, scoped: true } } });
    assert.equal(coverageStateFor("osmInfra", bounds, raw), "checked");
  });

  await t.test("fetched, scoped, bbox covers this country: checked", () => {
    const raw = emptyRaw({ fetchCoverage: { dams: fetchedScopedTo("-5,-5,15,15") } });
    assert.equal(coverageStateFor("dams", bounds, raw), "checked");
  });

  await t.test("fetched, scoped, bbox is a different area entirely: scoped_elsewhere, not checked", () => {
    // This is the exact scenario the Critical review finding described:
    // dams/airports/ports/osmInfra are all zoom-gated and not promoted by a
    // country focus, so clicking a country from world view can easily leave
    // their last fetch scoped to wherever the camera used to be.
    const raw = emptyRaw({ fetchCoverage: { airports: fetchedScopedTo("40,40,50,50") } });
    assert.equal(coverageStateFor("airports", bounds, raw), "scoped_elsewhere");
  });

  await t.test("fetched, scoped, bbox misses by less than the rounding tolerance: still checked", () => {
    // bboxCell rounds to 2 decimal places (useOsintData.js) -- a fetch scoped
    // to exactly this country's own bounds must not read as "elsewhere"
    // purely from that rounding.
    const raw = emptyRaw({ fetchCoverage: { ports: fetchedScopedTo("0.03,0.03,9.97,9.97") } });
    assert.equal(coverageStateFor("ports", bounds, raw), "checked");
  });
});

test("countryCardSections -- data coverage: the honesty section", async (t) => {
  await t.test("always present, even with every feed's coverage unknown", () => {
    const { sections } = countryCardSections(baseProps, emptyRaw(), bounds);
    const coverage = sections.find((s) => s.id === "coverage");
    assert.ok(coverage, "never dropped, unlike every other section");
    assert.equal(sections[sections.length - 1].id, "coverage", "goes last");
  });

  await t.test("'not loaded' path: no fetchCoverage entry reads as never checked -- not as 'checked and empty'", () => {
    // This is the state the running app is actually in for a gated, scoped
    // feed (osmInfra/dams/airports/ports) the moment a country is clicked
    // straight from world view: raw.ais is still `[]` from construction, but
    // nothing has fetched it yet. The old version of this test used
    // `delete raw.ais`, a shape the real app can never produce -- fixed per
    // the Task 9 review.
    const raw = emptyRaw({ ais: [] }); // present, empty, and never fetched
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const coverage = sections.find((s) => s.id === "coverage");
    assert.match(coverage.html, /AIS vessel tracking[\s\S]*?Not loaded this session &mdash; not checked\./);
    assert.doesNotMatch(coverage.html.match(/AIS vessel tracking[\s\S]*?<\/div><\/div>/)[0], /No coverage here/);
  });

  await t.test("'scoped elsewhere' path: fetched, but not for an area covering this country", () => {
    const raw = emptyRaw({
      airports: [], // present and empty -- but that is not the point being tested
      fetchCoverage: { airports: fetchedScopedTo("40,40,50,50") },
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const coverage = sections.find((s) => s.id === "coverage");
    assert.match(coverage.html, /OurAirports gazetteer[\s\S]*?Fetched, but for a different area &mdash; coverage here is unknown, not zero\./);
  });

  await t.test("'no coverage' path: fetched, covers this country, and nothing is in bounds", () => {
    const raw = emptyRaw({ ais: [], fetchCoverage: { ais: fetchedUnscoped() } });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const coverage = sections.find((s) => s.id === "coverage");
    assert.match(coverage.html, /AIS vessel tracking[\s\S]*?No coverage here &mdash; checked, nothing found\./);
  });

  await t.test("a covered feed with a match inside bounds reports when it last delivered", () => {
    const raw = emptyRaw({
      ais: [{ mmsi: 1, lat: 5, lon: 5, updated: Date.now() / 1000 - 120 }],
      fetchCoverage: { ais: fetchedUnscoped() },
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const coverage = sections.find((s) => s.id === "coverage");
    assert.match(coverage.html, /AIS vessel tracking[\s\S]*?Last delivered 2m ago/);
  });

  await t.test("a covered reference gazetteer with no delivery time reports a count, not a fabricated timestamp", () => {
    const raw = emptyRaw({
      dams: [{ id: "gdw:1", lat: 5, lon: 5, name: "Dam One" }],
      fetchCoverage: { dams: fetchedScopedTo("-5,-5,15,15") },
    });
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

  await t.test("a covered feed with a point outside the bbox does not count as coverage", () => {
    const raw = emptyRaw({
      ais: [{ mmsi: 1, lat: 50, lon: 50, updated: Date.now() / 1000 }],
      fetchCoverage: { ais: fetchedUnscoped() },
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const coverage = sections.find((s) => s.id === "coverage");
    assert.match(coverage.html, /AIS vessel tracking[\s\S]*?No coverage here/);
  });

  await t.test("cableLandings is one of the feeds reported on (Important 3: every feed the card used)", () => {
    const { sections } = countryCardSections(baseProps, emptyRaw(), bounds);
    const coverage = sections.find((s) => s.id === "coverage");
    assert.match(coverage.html, /Submarine cable landings \(TeleGeography\)/);
  });
});
