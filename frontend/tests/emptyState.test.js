// Task 32: the empty-state sweep. "We looked and found nothing" and "we did
// not look here" have been the same silent blank in seven separate
// components across this plan (Tasks 7, 9, 11, 16, 23, 26, 29) -- each one
// caught by a reviewer, each one fixed locally. This is the inventory's own
// test file: emptyFoldReason (map/popups.js) is the one shared mechanism
// that replaced every local fix, and this asserts both the mechanism itself
// and one case per surface the sweep actually changed.
//
// Same loader shim and window.L stub as countryCardSections.test.js/
// districtCard.test.js/waterCard.test.js -- map/popups.js pulls in
// map/decorators.js (Leaflet-backed) at module scope.

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
  emptyFoldReason, coverageStateFor, countryCardSections, subdivisionCardSections,
  districtCardSections, waterCardSections,
} = await import("../src/map/popups.js");
const { buildSubdivisionIndex } = await import("../src/map/subdivisions.js");
const { buildDistrictIndex } = await import("../src/map/districts.js");
const { buildWaterIndex } = await import("../src/map/water.js");

const bounds = { south: 0, west: 0, north: 10, east: 10 };

function fetchedUnscoped(at = Date.now()) {
  return { status: "fetched", fetchedAt: at, bbox: null, scoped: false };
}

function fetchedScopedTo(box, at = Date.now()) {
  return { status: "fetched", fetchedAt: at, bbox: box, scoped: true };
}

// ---------- the shared mechanism itself -------------------------------------

test("emptyFoldReason -- the shared mechanism every surface in the sweep now asks first", async (t) => {
  const raw = (fetchCoverage) => ({ fetchCoverage });

  await t.test("no bounds at all: 'did not look' -- the count-based callers' own contract", () => {
    const reason = emptyFoldReason(["ais"], null, raw({}));
    assert.match(reason, /no bounding box loaded/i);
    assert.match(reason, /could not be checked/i);
  });

  await t.test("boundsOptional: null bounds does not itself mean 'did not look'", () => {
    // The water/admin card callers whose real containment test does not need
    // bounds (see insideWaterFeature/insideAdminFeature) -- a feed that was
    // genuinely fetched and checked must still read as checked.
    const reason = emptyFoldReason(["ais"], null, raw({ ais: fetchedUnscoped() }), { boundsOptional: true });
    assert.equal(reason, null);
  });

  await t.test("a key with no fetchCoverage entry at all: 'not loaded'", () => {
    const reason = emptyFoldReason(["ais"], bounds, raw({}));
    assert.match(reason, /Not loaded this session/);
  });

  await t.test("fetched, but scoped to a different area: 'scoped elsewhere'", () => {
    const reason = emptyFoldReason(["dams"], bounds, raw({ dams: fetchedScopedTo("40,40,50,50") }));
    assert.match(reason, /different area/);
  });

  await t.test("every key genuinely checked: null -- a real answer, the fold may drop itself", () => {
    const reason = emptyFoldReason(["adsb", "ais"], bounds, raw({ adsb: fetchedUnscoped(), ais: fetchedUnscoped() }));
    assert.equal(reason, null);
  });

  await t.test("several keys, one never loaded and one scoped elsewhere: 'not loaded' wins -- the stronger caveat", () => {
    const reason = emptyFoldReason(
      ["adsb", "ais"], bounds,
      raw({ ais: fetchedScopedTo("40,40,50,50") }) // adsb: no entry at all
    );
    assert.match(reason, /Not loaded this session/);
  });

  await t.test("several keys, all checked but one scoped elsewhere: 'scoped elsewhere', not a false 'checked'", () => {
    const reason = emptyFoldReason(
      ["adsb", "ais"], bounds,
      raw({ adsb: fetchedUnscoped(), ais: fetchedScopedTo("40,40,50,50") })
    );
    assert.match(reason, /different area/);
  });
});

// ---------- country card: buildLivePicture ----------------------------------

test("buildLivePicture (country card, 'live') -- not loaded vs. checked and quiet", async (t) => {
  const baseProps = { name: "Testland", iso_a2: "TL", iso_a3: "TST", population: 1 };
  const CHECKED = {
    adsb: fetchedUnscoped(), ais: fetchedUnscoped(), jamming: fetchedUnscoped(),
    firms: fetchedUnscoped(), infra: fetchedUnscoped(),
  };
  function raw(fetchCoverage) {
    return {
      events: [], gdelt: [], officials: [], conflictStats: {}, escalation: [],
      adsb: [], ais: [], jamming: [], firms: [], infra: [], conflictDistricts: [],
      humanitarian: {}, outages: {}, energyFlows: {}, foodTrade: {},
      osmInfra: [], dams: [], airports: [], ports: [], cableLandings: [],
      fetchCoverage,
    };
  }

  await t.test("never fetched this session: the fold says so instead of silently vanishing", () => {
    const { sections } = countryCardSections(baseProps, raw({}), bounds);
    const live = sections.find((s) => s.id === "live");
    assert.ok(live, "the old behaviour dropped this section entirely here");
    assert.match(live.html, /Not loaded this session/);
  });

  await t.test("checked, and genuinely nothing in bounds: still drops, exactly as before", () => {
    const { sections } = countryCardSections(baseProps, raw(CHECKED), bounds);
    assert.equal(sections.find((s) => s.id === "live"), undefined);
  });

  await t.test("checked, with a military aircraft in bounds: the real count, no reason text", () => {
    const withAircraft = raw(CHECKED);
    withAircraft.adsb = [{ lat: 5, lon: 5, military: true }];
    const { sections } = countryCardSections(baseProps, withAircraft, bounds);
    const live = sections.find((s) => s.id === "live");
    assert.ok(live);
    assert.doesNotMatch(live.html, /Not loaded/);
  });
});

// ---------- country card: buildEnergyInfrastructure, buildMilitary, buildTransport --

test("buildEnergyInfrastructure/buildMilitary/buildTransport (country card) -- the same fix, three more sections", async (t) => {
  const baseProps = { name: "Testland", iso_a2: "TL", iso_a3: "TST", population: 1 };
  function raw(fetchCoverage, overrides = {}) {
    return {
      events: [], gdelt: [], officials: [], conflictStats: {}, escalation: [],
      adsb: [], ais: [], jamming: [], firms: [], infra: [], conflictDistricts: [],
      humanitarian: {}, outages: {}, energyFlows: {}, foodTrade: {},
      osmInfra: [], powerPlants: [], dams: [], airports: [], ports: [], cableLandings: [],
      militaryBases: [], czib: [],
      fetchCoverage,
      ...overrides,
    };
  }

  await t.test("energy infrastructure: never fetched reads as 'not loaded', not as an absent fold", () => {
    const { sections } = countryCardSections(baseProps, raw({}), bounds);
    const energy = sections.find((s) => s.id === "energy");
    assert.ok(energy);
    assert.match(energy.html, /Not loaded this session/);
  });

  await t.test("military: never fetched reads as 'not loaded'", () => {
    const { sections } = countryCardSections(baseProps, raw({}), bounds);
    const military = sections.find((s) => s.id === "military");
    assert.ok(military);
    assert.match(military.html, /Not loaded this session/);
  });

  await t.test("transport: never fetched reads as 'not loaded'", () => {
    const { sections } = countryCardSections(baseProps, raw({}), bounds);
    const transport = sections.find((s) => s.id === "transport");
    assert.ok(transport);
    assert.match(transport.html, /Not loaded this session/);
  });

  await t.test("all three: checked and genuinely empty still drop, unchanged from before this task", () => {
    const CHECKED = {
      osmInfra: fetchedUnscoped(), dams: fetchedUnscoped(), cableLandings: fetchedUnscoped(),
      infra: fetchedUnscoped(), adsb: fetchedUnscoped(), ais: fetchedUnscoped(),
      airports: fetchedUnscoped(), ports: fetchedUnscoped(),
    };
    const { sections } = countryCardSections(baseProps, raw(CHECKED), bounds);
    assert.equal(sections.find((s) => s.id === "energy"), undefined);
    assert.equal(sections.find((s) => s.id === "military"), undefined);
    assert.equal(sections.find((s) => s.id === "transport"), undefined);
  });
});

// ---------- country card: buildConnectivity's MIN_SCORE early return -------

test("buildConnectivity (country card) -- known instance 1: a quiet country score no longer hides a scored region", async (t) => {
  const baseProps = { name: "Testland", iso_a2: "TL", iso_a3: "TST", population: 1 };
  function raw(overrides) {
    return {
      events: [], gdelt: [], officials: [], conflictStats: {}, escalation: [],
      adsb: [], ais: [], jamming: [], firms: [], infra: [], conflictDistricts: [],
      humanitarian: {}, outages: {}, energyFlows: {}, foodTrade: {},
      fetchCoverage: { outages: fetchedUnscoped() },
      ...overrides,
    };
  }

  await t.test("no country-level outage, and IODA scored no regions here either: the fold drops, as before", () => {
    const { sections } = countryCardSections(baseProps, raw({ outages: {}, outagesRegions: {} }), bounds);
    assert.equal(sections.find((s) => s.id === "connectivity"), undefined);
  });

  await t.test("no country-level outage (under IODA's reporting floor), but regions here did score: says so, not silent", () => {
    // Before the fix: outageFor(props, raw) returns null the moment TL has
    // no entry in raw.outages, and buildConnectivity returned "" right there
    // -- regionSummary was never even computed, so a reader had no way to
    // learn that IODA had, in fact, scored something here.
    const withRegions = raw({
      outages: {}, // TL's own aggregate score is under the floor -- absent
      outagesRegions: {
        TL: {
          "TL-01": { matched: "exact", region_code: "TL-01", score: 5e9, signals: {}, country_code: "TL" },
          999: { matched: "unmatched", region_code: null, score: 2e9, signals: {}, country_code: "TL" },
        },
      },
    });
    const { sections } = countryCardSections(baseProps, withRegions, bounds);
    const connectivity = sections.find((s) => s.id === "connectivity");
    assert.ok(connectivity, "the sub-national tally now earns the fold on its own");
    assert.match(connectivity.html, /No national-level internet disruption detected/);
    assert.match(connectivity.html, /2 region\(s\) here/);
    assert.match(connectivity.html, /1 matched/);
    assert.match(connectivity.html, /1 could not be matched to one and are not drawn/);
  });

  await t.test("a real country-level outage still renders exactly as before -- the fix only reaches the null-outage path", () => {
    const withOutage = raw({
      outages: { TL: { country_code: "TL", score: 5_000_000, signals: {}, window_start: 0, window_end: 3600 } },
      outagesRegions: {},
    });
    const { sections } = countryCardSections(baseProps, withOutage, bounds);
    const connectivity = sections.find((s) => s.id === "connectivity");
    assert.match(connectivity.html, /IODA composite score: 5,000,000/);
    assert.doesNotMatch(connectivity.html, /No national-level/);
  });

  // Task 32 review (Important 1): the first version of this fix fell back to
  // `outage ? outage.country_code : null`, which is null for every "-99"
  // shape (Natural Earth's own quirk for France/Norway/Kosovo -- see
  // outageFor's own docstring) the moment that country's aggregate score is
  // under the floor, since `outage` itself never resolves without a raw.
  // outages entry to name-match against. ISO2_BY_ISO3 (already in this file,
  // already used by energyRecordFor and buildAdminConnectivity) is the fix.
  await t.test("a '-99' country (France/Norway/Kosovo's Natural Earth quirk) under the reporting floor still gets its region tally", () => {
    const franceProps = { name: "France", iso_a2: "-99", iso_a3: "FRA", population: 1 };
    const withRegionsNo99 = raw({
      outages: {}, // France's own aggregate score is under the floor -- absent
      outagesRegions: {
        FR: {
          "FR-A": { matched: "exact", region_code: "FR-A", score: 5e9, signals: {}, country_code: "FR" },
        },
      },
    });
    const { sections } = countryCardSections(franceProps, withRegionsNo99, bounds);
    const connectivity = sections.find((s) => s.id === "connectivity");
    assert.ok(connectivity, "ISO2_BY_ISO3's FRA -> FR resolves even with no outage record to read country_code off");
    assert.match(connectivity.html, /No national-level internet disruption detected/);
    assert.match(connectivity.html, /1 region\(s\) here/);
  });

  await t.test("a '-99' country with neither a national score nor any region-level reporting still drops cleanly", () => {
    const franceProps = { name: "France", iso_a2: "-99", iso_a3: "FRA", population: 1 };
    const { sections } = countryCardSections(franceProps, raw({ outages: {}, outagesRegions: {} }), bounds);
    assert.equal(sections.find((s) => s.id === "connectivity"), undefined);
  });
});

// ---------- Important 2: buildGridStress had the identical defect ---------

test("buildGridStress (country card, 'gridStress') -- Important 2: the same floor-hides-regions defect, one fold over", async (t) => {
  const baseProps = { name: "Testland", iso_a2: "TL", iso_a3: "TST", population: 1 };
  const PHYSICAL = {
    country_code: "TL",
    physical: { net: 0.4, unit: "GW", interval_minutes: 15, net_series: [{ t: "a", net: 0.1 }, { t: "b", net: 0.4 }] },
  };
  function raw(overrides) {
    return {
      events: [], gdelt: [], officials: [], conflictStats: {}, escalation: [],
      adsb: [], ais: [], jamming: [], firms: [], infra: [], conflictDistricts: [],
      humanitarian: {}, outages: {}, energyFlows: {}, foodTrade: {},
      fetchCoverage: { outages: fetchedUnscoped() },
      ...overrides,
    };
  }

  await t.test("physical flow exists (so the section renders) but the national IODA score is under the floor: the tally used to vanish silently", () => {
    // Before the fix: `const regionSummary = outage ? regionMatchSummary(outage.country_code, raw) : null;`
    // -- with no `outage` record, regionSummary was never computed even
    // though the section itself was already on screen for the physical
    // exchange figure, and a reader had no way to learn IODA had scored
    // this country's regions at all.
    const withRegions = raw({
      energyFlows: { TL: PHYSICAL },
      outages: {}, // under the floor -- absent
      outagesRegions: {
        TL: {
          "TL-01": { matched: "exact", region_code: "TL-01", score: 5e9, signals: {}, country_code: "TL" },
          999: { matched: "unmatched", region_code: null, score: 2e9, signals: {}, country_code: "TL" },
        },
      },
    });
    const { sections } = countryCardSections(baseProps, withRegions, bounds);
    const gridStress = sections.find((s) => s.id === "gridStress");
    assert.ok(gridStress, "the physical net-exchange figure alone already earns this section");
    assert.match(gridStress.html, /\+0\.40 GW/, "the exchange figure is unaffected by the fix");
    assert.match(gridStress.html, /1 of 2 IODA-scored/, "the sub-national tally no longer silently drops");
  });

  await t.test("a '-99' country (France/Norway/Kosovo) with physical flow and a scored-but-under-floor national score: same fix applies here too", () => {
    const franceProps = { name: "France", iso_a2: "-99", iso_a3: "FRA", population: 1 };
    const withRegions = raw({
      energyFlows: { FR: { ...PHYSICAL, country_code: "FR" } },
      outages: {},
      outagesRegions: {
        FR: { "FR-A": { matched: "exact", region_code: "FR-A", score: 5e9, signals: {}, country_code: "FR" } },
      },
    });
    const { sections } = countryCardSections(franceProps, withRegions, bounds);
    const gridStress = sections.find((s) => s.id === "gridStress");
    assert.ok(gridStress);
    assert.match(gridStress.html, /1 of 1 IODA-scored/);
  });

  await t.test("neither physical flow nor outage nor region data: the section still drops, unchanged from before this fix", () => {
    const { sections } = countryCardSections(baseProps, raw({ outages: {}, outagesRegions: {} }), bounds);
    assert.equal(sections.find((s) => s.id === "gridStress"), undefined);
  });

  await t.test("a real outage score (not under the floor) still renders its own tally exactly as before", () => {
    const withOutage = raw({
      energyFlows: { TL: PHYSICAL },
      outages: { TL: { country_code: "TL", score: 42, window_start: 0, window_end: 3600, signals: {} } },
      outagesRegions: {
        TL: { "TL-01": { matched: "exact", region_code: "TL-01", score: 5e9, signals: {}, country_code: "TL" } },
      },
    });
    const { sections } = countryCardSections(baseProps, withOutage, bounds);
    const gridStress = sections.find((s) => s.id === "gridStress");
    assert.match(gridStress.html, /IODA outage score/);
    assert.match(gridStress.html, /1 of 1 IODA-scored/);
  });
});

// ---------- admin (state/district) cards: cities, live, infrastructure -----

const feature = (properties, geometry) => ({ type: "Feature", properties, geometry });
const square = (minLon, minLat, maxLon, maxLat) => ({
  type: "Polygon",
  coordinates: [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]],
});

function makeState(overrides = {}) {
  const props = {
    key: "US-TS", code: "US-TS", name: "Test State", postal: "TS",
    kind: "State", country_code: "USA", country: "United States of America",
    ...overrides,
  };
  const [entry] = buildSubdivisionIndex([feature(props, square(0, 0, 10, 10))]);
  return entry;
}

function adminEmptyRaw(fetchCoverage) {
  return {
    events: [], cities: [], adsb: [], ais: [], firms: [], jamming: [],
    osmInfra: [], railwayPoints: [], dams: [], airports: [], ports: [],
    districtCounts: new Map(), districtMonthLoading: false, districtSeries: {},
    fetchCoverage,
  };
}

test("buildAdminCities/buildAdminLive/buildAdminInfrastructure (state card) -- not loaded vs. checked and quiet", async (t) => {
  const state = makeState();

  await t.test("cities: feed never fetched -- says so, does not vanish", () => {
    const { sections } = subdivisionCardSections(state, adminEmptyRaw({}), null);
    const cities = sections.find((s) => s.id === "cities");
    assert.ok(cities);
    assert.match(cities.html, /Not loaded this session/);
  });

  await t.test("cities: checked, and genuinely no city inside -- drops, as before", () => {
    const raw = adminEmptyRaw({ cities: fetchedUnscoped() });
    raw.cities = [{ name: "Faraway", lat: 80, lon: 80, population: 1 }]; // outside the state's 0..10 square
    const { sections } = subdivisionCardSections(state, raw, null);
    assert.equal(sections.find((s) => s.id === "cities"), undefined);
  });

  await t.test("live picture: feeds never fetched -- says so", () => {
    const { sections } = subdivisionCardSections(state, adminEmptyRaw({}), null);
    const live = sections.find((s) => s.id === "live");
    assert.ok(live);
    assert.match(live.html, /Not loaded this session/);
  });

  await t.test("infrastructure: feeds never fetched -- says so", () => {
    const { sections } = subdivisionCardSections(state, adminEmptyRaw({}), null);
    const infra = sections.find((s) => s.id === "infrastructure");
    assert.ok(infra);
    assert.match(infra.html, /Not loaded this session/);
  });

  await t.test("all three: checked and genuinely empty still drop, unchanged from before this task", () => {
    const CHECKED = {
      cities: fetchedUnscoped(), adsb: fetchedUnscoped(), ais: fetchedUnscoped(),
      firms: fetchedUnscoped(), jamming: fetchedUnscoped(), osmInfra: fetchedUnscoped(),
      dams: fetchedUnscoped(), airports: fetchedUnscoped(), ports: fetchedUnscoped(),
    };
    const { sections } = subdivisionCardSections(state, adminEmptyRaw(CHECKED), null);
    assert.equal(sections.find((s) => s.id === "cities"), undefined);
    assert.equal(sections.find((s) => s.id === "live"), undefined);
    assert.equal(sections.find((s) => s.id === "infrastructure"), undefined);
  });

  await t.test("district card shares the identical fix (same builder functions)", () => {
    const [district] = buildDistrictIndex([
      feature({ pcode: "TD001", name: "Test District", admin1: "Test State", country_code: "USA" }, square(0, 0, 5, 5)),
    ]);
    const { sections } = districtCardSections(district, adminEmptyRaw({}), null, null);
    const live = sections.find((s) => s.id === "live");
    assert.ok(live);
    assert.match(live.html, /Not loaded this session/);
  });
});

// ---------- admin connectivity: the unmatched-region case -------------------

test("buildAdminConnectivity (state/district card) -- known instance from the brief's own inventory", async (t) => {
  const state = makeState(); // country_code: USA
  const usCountryFeature = {
    type: "Feature",
    properties: { iso_a2: "US", iso_a3: "USA", name: "United States of America" },
  };

  function raw(overrides) {
    return {
      // adminOutageRecord (what buildAdminConnectivity actually reads for a
      // state/district) is fed entirely by raw.outagesRegions, not
      // raw.outages -- a separate POLL_CONFIG row with its own fetchCoverage
      // entry (see popups.js's own fix note on this fold). Both are marked
      // fetched here so the sub-tests below exercise the region tally itself
      // rather than a coverage state neither of them is about; the "never
      // fetched" sub-test overrides fetchCoverage wholesale to get back to
      // that state on purpose.
      ...adminEmptyRaw({ outages: fetchedUnscoped(), outagesRegions: fetchedUnscoped() }),
      countries: { features: [usCountryFeature] },
      ...overrides,
    };
  }

  await t.test("outagesRegions feed never fetched: says so rather than a bare absent fold", () => {
    const { sections } = subdivisionCardSections(state, raw({ fetchCoverage: {} }), null);
    const connectivity = sections.find((s) => s.id === "connectivity");
    assert.ok(connectivity);
    assert.match(connectivity.html, /Not loaded this session/);
  });

  await t.test("no IODA region-level reporting for this country at all: drops, exactly as before", () => {
    const { sections } = subdivisionCardSections(state, raw({ outagesRegions: {} }), null);
    assert.equal(sections.find((s) => s.id === "connectivity"), undefined);
  });

  await t.test("IODA scored regions in this country, but none matched to THIS state: says so, not silent", () => {
    // Before the fix: adminOutageRecord(props, raw) returns null the moment
    // no outagesRegions entry has region_code === "US-TS" -- indistinguishable
    // from IODA never having scored anywhere near this country at all.
    const withOtherRegion = raw({
      outagesRegions: {
        US: {
          "US-OTHER": { matched: "exact", region_code: "US-OTHER", score: 5e9, signals: {}, country_code: "US" },
        },
      },
    });
    const { sections } = subdivisionCardSections(state, withOtherRegion, null);
    const connectivity = sections.find((s) => s.id === "connectivity");
    assert.ok(connectivity, "the country-wide tally now earns the fold even though this exact state has no match");
    assert.match(connectivity.html, /none matched to this exact boundary/);
    assert.match(connectivity.html, /1 matched to some\s+other state or province here/);
  });

  await t.test("this state's own region matched: renders the real outage record, unaffected by the fix", () => {
    const matched = raw({
      outagesRegions: {
        US: {
          "US-TS": { matched: "exact", region_code: "US-TS", score: 5e9, signals: {}, country_code: "US" },
        },
      },
    });
    const { sections } = subdivisionCardSections(state, matched, null);
    const connectivity = sections.find((s) => s.id === "connectivity");
    assert.match(connectivity.html, /IODA composite score: 5,000,000,000/);
    assert.doesNotMatch(connectivity.html, /none matched to this exact boundary/);
  });
});

// ---------- water card: buildWaterTraffic, buildWaterInfrastructure --------

function makeSea(overrides = {}) {
  const props = {
    id: "marine:1", name: "Test Sea", class: "sea", area_deg2: 100,
    bbox: [-5, -5, 5, 5], antimeridian: false,
    ...overrides,
  };
  const [entry] = buildWaterIndex([feature(props, square(-5, -5, 5, 5))]);
  return entry;
}

test("buildWaterTraffic/buildWaterInfrastructure (water card) -- not loaded vs. checked and quiet", async (t) => {
  const sea = makeSea();
  function waterRaw(fetchCoverage) {
    return {
      ais: [], darkVessels: [], gfwGaps: [], cables: [], cableLandings: [], ports: [],
      events: [], gdelt: [], officials: [], countryIndex: [],
      fetchCoverage,
    };
  }

  await t.test("traffic: AIS never fetched -- says so, not a dropped fold", () => {
    const { sections } = waterCardSections(sea, waterRaw({}), null);
    const traffic = sections.find((s) => s.id === "traffic");
    assert.ok(traffic);
    assert.match(traffic.html, /Not loaded this session/);
  });

  await t.test("infrastructure: cables/ports never fetched -- says so", () => {
    const { sections } = waterCardSections(sea, waterRaw({}), null);
    const infra = sections.find((s) => s.id === "infrastructure");
    assert.ok(infra);
    assert.match(infra.html, /Not loaded this session/);
  });

  await t.test("both: checked and genuinely quiet still drop, unchanged from before this task", () => {
    // navalPresence added: buildWaterTraffic also reads it (navalPresenceRegion)
    // and now checks its coverage too -- see popups.js's own fix note on why
    // the traffic fold used to only ask about "ais" -- so it has to be marked
    // fetched here as well, or this becomes the "not loaded" case instead of
    // "checked and quiet".
    const CHECKED = {
      ais: fetchedUnscoped(), cableLandings: fetchedUnscoped(), ports: fetchedUnscoped(),
      navalPresence: fetchedUnscoped(),
    };
    const { sections } = waterCardSections(sea, waterRaw(CHECKED), null);
    assert.equal(sections.find((s) => s.id === "traffic"), undefined);
    assert.equal(sections.find((s) => s.id === "infrastructure"), undefined);
  });

  await t.test("bounds is null (a water body with no stored bbox) but the feed was fetched: still reads as checked", () => {
    // insideWaterFeature does not need bounds for the real containment test
    // (it is a pre-filter only) -- a missing bounds must not itself read as
    // "did not look" for the water card the way it correctly does for a
    // country's count-based folds. See emptyFoldReason's own boundsOptional.
    // navalPresence marked fetched too -- see the "checked and genuinely
    // quiet" case just above for why buildWaterTraffic now checks it as well.
    const raw = waterRaw({ ais: fetchedUnscoped(), navalPresence: fetchedUnscoped() });
    raw.ais = [{ lat: 90, lon: 90, ship_type: 80 }]; // real data, well outside the sea's polygon
    const { sections } = waterCardSections(sea, raw, null);
    assert.equal(sections.find((s) => s.id === "traffic"), undefined, "checked and empty, not 'did not look'");
  });
});

// ---------- known instance 2: the refused ambiguous military base match ----

test("militaryBaseRows (country card, 'military') -- ambiguous_match is not the same silence as no match", async (t) => {
  const baseProps = { name: "Testland", iso_a2: "TL", iso_a3: "TST", population: 1 };
  function raw(militaryBases) {
    return {
      events: [], gdelt: [], officials: [], conflictStats: {}, escalation: [],
      adsb: [], ais: [], jamming: [], firms: [], infra: [], conflictDistricts: [],
      humanitarian: {}, outages: {}, energyFlows: {}, foodTrade: {},
      osmInfra: [], dams: [], airports: [], ports: [], cableLandings: [], czib: [],
      militaryBases,
      fetchCoverage: { osmInfra: fetchedUnscoped(), infra: fetchedUnscoped(), adsb: fetchedUnscoped(), ais: fetchedUnscoped() },
    };
  }

  await t.test("a refused ambiguous match names itself as ambiguous, not as absent", () => {
    // Matches backend/infrastructure.py's own shape: merge_military_bases
    // stamps `ambiguous_match: true` on an OSM site refused a curated match
    // because more than one curated site sat within range -- see
    // test_military_merge.py's own test_an_ambiguous_refusal_is_flagged...
    const bases = [{
      id: "osm:way/1", source: "osm", kind: "military_base", lat: 5, lon: 5,
      name: "Some Base", ambiguous_match: true,
    }];
    const { sections } = countryCardSections(baseProps, raw(bases), bounds);
    const military = sections.find((s) => s.id === "military");
    assert.ok(military);
    assert.match(military.html, /more than one curated site within 5km, match refused/);
  });

  await t.test("an ordinary unmatched OSM site (no curated site nearby at all) carries no ambiguity claim", () => {
    const bases = [{
      id: "osm:way/2", source: "osm", kind: "military_base", lat: 5, lon: 5, name: "Some Other Base",
    }];
    const { sections } = countryCardSections(baseProps, raw(bases), bounds);
    const military = sections.find((s) => s.id === "military");
    assert.doesNotMatch(military.html, /match refused/);
  });
});

// ---------- coverageStateFor is the one truth every above surface shares ---

test("coverageStateFor -- unaffected by this sweep, and every surface above answers to it consistently", async (t) => {
  await t.test("the same three states buildCoverage's own table has always used", () => {
    const raw = { fetchCoverage: { a: fetchedUnscoped(), b: fetchedScopedTo("40,40,50,50") } };
    assert.equal(coverageStateFor("a", bounds, raw), "checked");
    assert.equal(coverageStateFor("b", bounds, raw), "scoped_elsewhere");
    assert.equal(coverageStateFor("c", bounds, raw), "not_loaded");
  });
});
