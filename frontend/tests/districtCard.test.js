// The admin-1 (state) and admin-2 (district) cards (Task 11), asserted
// headlessly: point-in-polygon clipping against a hand-built shape, the
// month selector's effect on the district's four DISTRICT_METRICS and its
// 24-month trend, and the two paths the whole archive rests on -- a district
// with no record for a month reads as "no record", never as a fabricated
// zero, and a month still in flight reads as loading, never as either.
//
// Same setup as waterCard.test.js: map/popups.js pulls in map/decorators.js
// (Leaflet-backed) at module scope, so this stubs just enough of `window.L`
// to satisfy that import and teaches the loader to resolve the extensionless
// relative imports the way Vite does. Nothing here touches the DOM.

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

const { buildSubdivisionIndex } = await import("../src/map/subdivisions.js");
const { buildDistrictIndex, DISTRICT_METRICS, DISTRICT_NO_RECORD_CAVEAT } = await import("../src/map/districts.js");
const { subdivisionCardSections, districtCardSections } = await import("../src/map/popups.js");

const feature = (properties, geometry) => ({ type: "Feature", properties, geometry });
const square = (minLon, minLat, maxLon, maxLat) => ({
  type: "Polygon",
  coordinates: [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]],
});

// A 10x10-degree state, [0,0] to [10,10].
function makeState(overrides = {}) {
  const props = {
    key: "US-TS", code: "US-TS", name: "Test State", postal: "TS",
    kind: "State", country_code: "USA", country: "United States of America",
    ...overrides,
  };
  const [entry] = buildSubdivisionIndex([feature(props, square(0, 0, 10, 10))]);
  return entry;
}

// A district, [0,0] to [5,5] -- inside the state above, the way a real
// admin-2 district partitions its admin-1 state.
function makeDistrict(overrides = {}) {
  const props = { pcode: "TD001", name: "Test District", admin1: "Test State", country_code: "USA", ...overrides };
  const [entry] = buildDistrictIndex([feature(props, square(0, 0, 5, 5))]);
  return entry;
}

const emptyRaw = () => ({
  events: [], cities: [], adsb: [], ais: [], firms: [], jamming: [],
  osmInfra: [], dams: [], airports: [], ports: [],
  districtCounts: new Map(), districtMonthLoading: false, districtSeries: {},
});

test("subdivisionCardSections -- polygon clipping against a hand-built state", async (t) => {
  const state = makeState(); // [0,0]..[10,10]

  await t.test("a city inside the polygon is counted; one outside is not", () => {
    const raw = {
      ...emptyRaw(),
      cities: [
        { name: "Innerville", lat: 5, lon: 5, population: 1000, is_capital: false },
        { name: "Outerville", lat: 50, lon: 50, population: 999999, is_capital: false },
      ],
    };
    const { sections } = subdivisionCardSections(state, raw, null);
    const cities = sections.find((s) => s.id === "cities");
    assert.ok(cities, "at least one city inside makes the fold appear");
    assert.match(cities.html, /Innerville/);
    assert.doesNotMatch(cities.html, /Outerville/);
    assert.match(cities.html, /cstat-v">1<\/span><span class="cstat-l">cities/);
  });

  await t.test("no city lands inside at all -- the fold is dropped, not rendered empty", () => {
    const raw = { ...emptyRaw(), cities: [{ name: "Faraway", lat: 80, lon: 80, population: 1 }] };
    const { sections } = subdivisionCardSections(state, raw, null);
    assert.ok(!sections.some((s) => s.id === "cities"));
  });

  await t.test("live picture: aircraft/ships/fires/jamming, each clipped to the polygon", () => {
    const raw = {
      ...emptyRaw(),
      adsb: [{ lat: 1, lon: 1 }, { lat: 90, lon: 90 }],
      ais: [{ lat: 2, lon: 2 }],
      firms: [{ lat: 90, lon: 90 }],
      jamming: [{ lat: 3, lon: 3 }, { lat: 4, lon: 4 }],
    };
    const { sections } = subdivisionCardSections(state, raw, null);
    const live = sections.find((s) => s.id === "live");
    assert.ok(live);
    assert.match(live.html, /cstat-v">1<\/span><span class="cstat-l">aircraft/, "one of two aircraft is inside");
    assert.match(live.html, /cstat-v">1<\/span><span class="cstat-l">ships/);
    assert.match(live.html, /cstat-v">2<\/span><span class="cstat-l">GPS jamming cells/);
    // firms had one point, but it landed outside the polygon -- the whole
    // fold still renders (aircraft/ships/jamming have something to say), so
    // this proves the per-feed clipping is independent, not an all-or-nothing gate.
    assert.doesNotMatch(live.html, /cstat-v">1<\/span><span class="cstat-l">active fires/);
  });

  await t.test("infrastructure: power plants, dams, airfields, ports, rail, crossings inside only", () => {
    const raw = {
      ...emptyRaw(),
      osmInfra: [
        { lat: 1, lon: 1, kind: "power_plant", output_mw: 50 },
        { lat: 90, lon: 90, kind: "power_plant", output_mw: 999 }, // outside
        { lat: 2, lon: 2, kind: "railway_station" },
        { lat: 3, lon: 3, kind: "border_control" },
      ],
      dams: [{ lat: 1, lon: 1, power_mw: 10 }],
      airports: [{ lat: 1, lon: 1, type: "small_airport" }],
      ports: [{ lat: 1, lon: 1 }],
    };
    const { sections } = subdivisionCardSections(state, raw, null);
    const infra = sections.find((s) => s.id === "infrastructure");
    assert.ok(infra);
    assert.match(infra.html, /cstat-v">1<\/span><span class="cstat-l">power plants/);
    assert.match(infra.html, /cstat-v">1<\/span><span class="cstat-l">dams/);
    assert.match(infra.html, /cstat-v">1<\/span><span class="cstat-l">airfields/);
    assert.match(infra.html, /cstat-v">1<\/span><span class="cstat-l">ports/);
    assert.match(infra.html, /cstat-v">1<\/span><span class="cstat-l">rail stops/);
    assert.match(infra.html, /cstat-v">1<\/span><span class="cstat-l">border crossings/);
    assert.doesNotMatch(infra.html, />999</, "the outside power plant's own MW never enters the sum");
  });
});

test("subdivisionCardSections -- conflict fold: 72h events/fatalities/top types/most severe, clipped", async (t) => {
  const state = makeState();
  const today = new Date().toISOString().slice(0, 10);

  await t.test("events inside the polygon in the last 72h are tallied; one outside is not", () => {
    const raw = {
      ...emptyRaw(),
      events: [
        { lat: 1, lon: 1, date: today, fatalities: 2, event_type: "Battles", severity: 40 },
        { lat: 2, lon: 2, date: today, fatalities: 1, event_type: "Battles", severity: 90 },
        { lat: 90, lon: 90, date: today, fatalities: 100, event_type: "Battles", severity: 99 }, // outside
      ],
    };
    const { sections } = subdivisionCardSections(state, raw, null);
    const conflict = sections.find((s) => s.id === "conflict");
    assert.match(conflict.html, /cstat-v">2<\/span><span class="cstat-l">events/);
    assert.match(conflict.html, /cstat-v">3<\/span><span class="cstat-l">killed/, "2 + 1 -- the outside event's 100 is excluded");
    assert.match(conflict.html, /Most severe: Battles.*90\/100/);
    assert.match(conflict.html, /Top event types: Battles \(2\)/);
  });

  await t.test("a quiet state says so in words, and never drops the fold", () => {
    const { sections } = subdivisionCardSections(state, emptyRaw(), null);
    const conflict = sections.find((s) => s.id === "conflict");
    assert.ok(conflict, "the conflict fold survives even with nothing to report");
    assert.match(conflict.html, /No conflict events matched inside this state in the last 72h/);
  });

  await t.test("an event older than 72h is excluded from the window", () => {
    const old = new Date(Date.now() - 100 * 3600 * 1000).toISOString().slice(0, 10);
    const raw = { ...emptyRaw(), events: [{ lat: 1, lon: 1, date: old, fatalities: 5, event_type: "Battles" }] };
    const { sections } = subdivisionCardSections(state, raw, null);
    const conflict = sections.find((s) => s.id === "conflict");
    assert.match(conflict.html, /No conflict events matched/);
  });
});

test("subdivisionCardSections -- profile and coverage", async (t) => {
  const state = makeState();

  await t.test("profile carries name, ISO 3166-2 code, kind and parent country", () => {
    const { title, sections } = subdivisionCardSections(state, emptyRaw(), null);
    assert.equal(title, "Test State");
    const profile = sections.find((s) => s.id === "profile");
    assert.match(profile.html, /Test State/);
    assert.match(profile.html, /US-TS/);
    assert.match(profile.html, /State/);
    assert.match(profile.html, /United States of America/);
  });

  await t.test("coverage: the six admin-2 countries and both caveats, verbatim", () => {
    const { sections } = subdivisionCardSections(state, emptyRaw(), null);
    const coverage = sections.find((s) => s.id === "coverage");
    assert.ok(coverage, "coverage never drops, even with nothing else to say");
    for (const name of ["Afghanistan", "Venezuela", "Yemen", "Sudan", "Democratic Republic of the Congo", "Ukraine"]) {
      assert.ok(coverage.html.includes(name), `${name} is named as one of the six`);
    }
    assert.ok(
      coverage.html.includes("Boundary: Natural Earth admin-1, 1:10m &mdash; generalised to a few hundred metres"),
      "the Natural Earth 1:10m caveat survives verbatim"
    );
    assert.ok(coverage.html.includes(DISTRICT_NO_RECORD_CAVEAT), "the 'not a reported zero' clause survives verbatim");
  });
});

test("districtCardSections -- the month selector's effect on the four DISTRICT_METRICS", async (t) => {
  const district = makeDistrict();

  await t.test("the selected month's own record drives every metric row", () => {
    const counts = new Map([
      ["TD001", { month: "2026-01", fatalities: 3, political_violence: 2, civilian_targeting: 1, demonstration: 0 }],
    ]);
    const raw = { ...emptyRaw(), districtCounts: counts };
    const { sections } = districtCardSections(district, raw, null, "2026-01");
    const conflict = sections.find((s) => s.id === "conflict");
    assert.match(conflict.html, /Reviewed record for <b>2026-01<\/b>/);
    for (const m of DISTRICT_METRICS) {
      assert.ok(conflict.html.includes(m.label), `${m.label} row is present`);
    }
    assert.match(conflict.html, /<b>3<\/b>/, "the fatalities value from the selected month's record");
  });

  await t.test("switching months to one with no row for this pcode reads as no record, not zero", () => {
    const counts = new Map([
      ["OTHER-PCODE", { month: "2026-02", fatalities: 9, political_violence: 1, civilian_targeting: 0, demonstration: 0 }],
    ]);
    const raw = { ...emptyRaw(), districtCounts: counts };
    const { sections } = districtCardSections(district, raw, null, "2026-02");
    const conflict = sections.find((s) => s.id === "conflict");
    assert.match(conflict.html, /No record for 2026-02/);
    assert.doesNotMatch(conflict.html, /<b>9<\/b>/, "another district's record never leaks into this one's card");
  });

  await t.test("DISTRICT_METRICS itself carries deaths and the three ACLED event-type buckets", () => {
    assert.deepEqual(
      DISTRICT_METRICS.map((m) => m.id),
      ["fatalities", "political_violence", "civilian_targeting", "demonstration"]
    );
  });
});

test("districtCardSections -- the 24-month trend, built from this district's own archive slice", async (t) => {
  const district = makeDistrict(); // pcode TD001, country_code USA

  await t.test("a district's own series across months draws the sparkline; another district's rows do not leak in", () => {
    const series = [
      { admin2_code: "TD001", month: "2025-01", fatalities: 1 },
      { admin2_code: "TD001", month: "2025-02", fatalities: 5 },
      { admin2_code: "OTHER", month: "2025-02", fatalities: 99 },
    ];
    const raw = { ...emptyRaw(), districtSeries: { USA: series } };
    const { sections } = districtCardSections(district, raw, null, null);
    const conflict = sections.find((s) => s.id === "conflict");
    assert.match(conflict.html, /class="cspark"/, "buildSparkline's own chart element");
    assert.match(conflict.html, /peak 5/);
    assert.doesNotMatch(conflict.html, /99/, "OTHER's 99 fatalities never enters this district's own peak");
  });

  await t.test("fewer than two months of series data omits the sparkline, not an error", () => {
    const raw = { ...emptyRaw(), districtSeries: { USA: [{ admin2_code: "TD001", month: "2025-01", fatalities: 1 }] } };
    const { sections } = districtCardSections(district, raw, null, null);
    const conflict = sections.find((s) => s.id === "conflict");
    assert.doesNotMatch(conflict.html, /class="cspark"/);
  });

  await t.test("no series fetched yet for this country -- the record and the no-record path still work", () => {
    const { sections } = districtCardSections(district, emptyRaw(), null, null);
    assert.ok(sections.find((s) => s.id === "conflict"), "the conflict fold does not depend on the series arriving");
  });
});

test("districtCardSections -- the empty-district path: no record, and loading kept apart from it", async (t) => {
  const district = makeDistrict();

  await t.test("an entirely empty raw bag still returns profile, conflict and coverage; optional folds drop", () => {
    const { title, sections } = districtCardSections(district, emptyRaw(), null, null);
    assert.equal(title, "Test District");
    const ids = sections.map((s) => s.id);
    assert.deepEqual(ids.filter((id) => ["profile", "conflict", "coverage"].includes(id)).sort(),
      ["conflict", "coverage", "profile"]);
    assert.ok(!ids.includes("cities"));
    assert.ok(!ids.includes("live"));
    assert.ok(!ids.includes("infrastructure"));
  });

  await t.test("no month selected yet: 'No record for the archive', never a fabricated zero", () => {
    const { sections } = districtCardSections(district, emptyRaw(), null, null);
    const conflict = sections.find((s) => s.id === "conflict");
    assert.match(conflict.html, /No record for the archive/);
    assert.ok(conflict.html.includes(DISTRICT_NO_RECORD_CAVEAT));
    assert.doesNotMatch(conflict.html, /district-loading/);
  });

  await t.test("a month whose counts are still in flight reads as loading, not as no record", () => {
    const raw = { ...emptyRaw(), districtMonthLoading: true };
    const { sections } = districtCardSections(district, raw, null, "2026-03");
    const conflict = sections.find((s) => s.id === "conflict");
    assert.match(conflict.html, /district-loading/);
    assert.match(conflict.html, /Loading 2026-03/);
    assert.doesNotMatch(conflict.html, /No record for/);
  });

  await t.test("profile carries pcode, name and parent admin1", () => {
    const { sections } = districtCardSections(district, emptyRaw(), null, null);
    const profile = sections.find((s) => s.id === "profile");
    assert.match(profile.html, /Test District/);
    assert.match(profile.html, /Test State/);
    assert.match(profile.html, /TD001/);
  });
});
