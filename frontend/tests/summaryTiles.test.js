// Task 10: the country card's summary strip and super-folds.
//
// Two pure functions, tested directly per the task brief: summaryTiles (the
// seven stat tiles above the folds, map/popups.js) and groupSections (the
// super-fold grouping helper PlaceInfoCard's optional `groups` prop uses,
// placeInfoCardGrouping.js). Neither touches the DOM, and PlaceInfoCard.jsx
// itself is JSX and cannot be imported under this project's plain
// `node --test` harness -- see placeInfoCard.test.js's own note, and
// placeInfoCardGrouping.js's, for why the grouping logic lives in its own
// plain-JS sibling module rather than inside the component.
//
// Same loader shim and window.L stub as countryCardSections.test.js --
// map/popups.js pulls in map/decorators.js (Leaflet-backed) at module scope.

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

const { summaryTiles, countryCardSections, COUNTRY_CARD_GROUPS } = await import("../src/map/popups.js");
const { groupSections } = await import("../src/components/placeInfoCardGrouping.js");

const baseProps = { name: "Testland", iso_a2: "TL", iso_a3: "TST", population: 1_000_000 };
const bounds = { south: 0, west: 0, north: 10, east: 10 };

// Same defaults countryCardSections.test.js uses, restated here rather than
// imported: each test file in this suite is self-contained.
function emptyRaw(overrides = {}) {
  return {
    events: [], gdelt: [], officials: [], conflictStats: {}, escalation: [],
    adsb: [], ais: [], jamming: [], firms: [], infra: [], conflictDistricts: [],
    humanitarian: {}, outages: {}, energyFlows: {}, foodTrade: {},
    osmInfra: [], dams: [], airports: [], ports: [], cableLandings: [],
    fetchCoverage: {},
    ...overrides,
  };
}

function fetchedUnscoped(at = Date.now()) {
  return { status: "fetched", fetchedAt: at, bbox: null, scoped: false };
}

function fetchedScopedTo(box, at = Date.now()) {
  return { status: "fetched", fetchedAt: at, bbox: box, scoped: true };
}

function tileFor(tiles, key) {
  const found = tiles.find((t) => t.key === key);
  assert.ok(found, `no tile with key "${key}"`);
  return found;
}

const TODAY = new Date().toISOString().slice(0, 10);

test("summaryTiles -- population", async (t) => {
  await t.test("unavailable when the country has no reported population -- a dash, not a zero", () => {
    const tile = tileFor(summaryTiles({ ...baseProps, population: null }, emptyRaw(), bounds), "population");
    assert.equal(tile.unavailable, true);
    assert.equal(tile.value, null);
    assert.match(tile.tooltip, /World Bank/);
  });

  await t.test("available renders the reported figure", () => {
    const tile = tileFor(summaryTiles(baseProps, emptyRaw(), bounds), "population");
    assert.equal(tile.unavailable, false);
    assert.equal(tile.value, "1,000,000");
    assert.equal(tile.tooltip, null);
  });
});

test("summaryTiles -- events/fatalities, 72h", async (t) => {
  await t.test("no bounding box at all: both dash with the same reason", () => {
    const tiles = summaryTiles(baseProps, emptyRaw(), null);
    const events = tileFor(tiles, "events72h");
    const fatalities = tileFor(tiles, "fatalities72h");
    assert.equal(events.unavailable, true);
    assert.match(events.tooltip, /no bounding box/i);
    assert.equal(fatalities.unavailable, true);
    assert.match(fatalities.tooltip, /no bounding box/i);
  });

  await t.test("events feed never fetched this session: dash, not zero", () => {
    const events = tileFor(summaryTiles(baseProps, emptyRaw(), bounds), "events72h");
    assert.equal(events.unavailable, true);
    assert.match(events.tooltip, /Not loaded this session/);
  });

  await t.test("events feed fetched, but scoped to a different area: dash, coverage here is unknown", () => {
    const raw = emptyRaw({ fetchCoverage: { events: fetchedScopedTo("40,40,50,50") } });
    const events = tileFor(summaryTiles(baseProps, raw, bounds), "events72h");
    assert.equal(events.unavailable, true);
    assert.match(events.tooltip, /different area/);
  });

  await t.test("checked and genuinely quiet: a real 0 for both tiles, not a dash", () => {
    const raw = emptyRaw({ fetchCoverage: { events: fetchedUnscoped() } });
    const tiles = summaryTiles(baseProps, raw, bounds);
    const events = tileFor(tiles, "events72h");
    const fatalities = tileFor(tiles, "fatalities72h");
    assert.equal(events.unavailable, false);
    assert.equal(events.value, "0");
    assert.equal(fatalities.unavailable, false);
    assert.equal(fatalities.value, "0");
  });

  await t.test("checked, with a recent event inside bounds: both tiles count it", () => {
    const raw = emptyRaw({
      events: [{ lat: 5, lon: 5, date: TODAY, fatalities: 3 }],
      fetchCoverage: { events: fetchedUnscoped() },
    });
    const tiles = summaryTiles(baseProps, raw, bounds);
    assert.equal(tileFor(tiles, "events72h").value, "1");
    assert.equal(tileFor(tiles, "fatalities72h").value, "3");
  });
});

test("summaryTiles -- connectivity", async (t) => {
  await t.test("outages feed never fetched this session: dash", () => {
    const tile = tileFor(summaryTiles(baseProps, emptyRaw(), bounds), "connectivity");
    assert.equal(tile.unavailable, true);
    assert.match(tile.tooltip, /Not loaded this session/);
  });

  await t.test("fetched, no anomaly on file for this country: dash with its own reason, not the coverage wording", () => {
    const raw = emptyRaw({ fetchCoverage: { outages: fetchedUnscoped() } }); // outages: {} -- no TL entry
    const tile = tileFor(summaryTiles(baseProps, raw, bounds), "connectivity");
    assert.equal(tile.unavailable, true);
    assert.match(tile.tooltip, /No disruption detected/);
    assert.doesNotMatch(tile.tooltip, /Not loaded/);
  });

  await t.test("fetched, with an outage on file: the composite score", () => {
    const raw = emptyRaw({
      outages: { TL: { score: 2_500_000, signals: {}, window_start: 0, window_end: 3600 } },
      fetchCoverage: { outages: fetchedUnscoped() },
    });
    const tile = tileFor(summaryTiles(baseProps, raw, bounds), "connectivity");
    assert.equal(tile.unavailable, false);
    assert.equal(tile.value, "2,500,000");
  });
});

test("summaryTiles -- refugees", async (t) => {
  await t.test("this shape has no ISO3 code: dash, cannot even attempt the match", () => {
    const tile = tileFor(summaryTiles({ ...baseProps, iso_a3: null }, emptyRaw(), bounds), "refugees");
    assert.equal(tile.unavailable, true);
    assert.match(tile.tooltip, /ISO3/);
  });

  await t.test("humanitarian feed never fetched this session: dash", () => {
    const tile = tileFor(summaryTiles(baseProps, emptyRaw(), bounds), "refugees");
    assert.equal(tile.unavailable, true);
    assert.match(tile.tooltip, /Not loaded this session/);
  });

  await t.test("fetched, but UNHCR has no displacement record for this country: dash with its own reason", () => {
    const raw = emptyRaw({ fetchCoverage: { humanitarian: fetchedUnscoped() } });
    const tile = tileFor(summaryTiles(baseProps, raw, bounds), "refugees");
    assert.equal(tile.unavailable, true);
    assert.match(tile.tooltip, /UNHCR has not reported/);
  });

  await t.test("fetched, with a reported figure: the real number", () => {
    const raw = emptyRaw({
      humanitarian: { TST: { displacement: { refugees: 42000, year: 2025 } } },
      fetchCoverage: { humanitarian: fetchedUnscoped() },
    });
    const tile = tileFor(summaryTiles(baseProps, raw, bounds), "refugees");
    assert.equal(tile.unavailable, false);
    assert.equal(tile.value, "42,000");
  });

  await t.test("fetched, and UNHCR reports exactly zero: a real 0, not a dash", () => {
    const raw = emptyRaw({
      humanitarian: { TST: { displacement: { refugees: 0, year: 2025 } } },
      fetchCoverage: { humanitarian: fetchedUnscoped() },
    });
    const tile = tileFor(summaryTiles(baseProps, raw, bounds), "refugees");
    assert.equal(tile.unavailable, false);
    assert.equal(tile.value, "0");
  });
});

test("summaryTiles -- net power", async (t) => {
  await t.test("energyFlows feed never fetched this session: dash", () => {
    const tile = tileFor(summaryTiles(baseProps, emptyRaw(), bounds), "netPower");
    assert.equal(tile.unavailable, true);
    assert.match(tile.tooltip, /Not loaded this session/);
  });

  await t.test("fetched, no bidding-zone record for this country: dash with its own reason", () => {
    const raw = emptyRaw({ fetchCoverage: { energyFlows: fetchedUnscoped() } });
    const tile = tileFor(summaryTiles(baseProps, raw, bounds), "netPower");
    assert.equal(tile.unavailable, true);
    assert.match(tile.tooltip, /No cross-border flow published/);
  });

  await t.test("fetched, with a measured physical net: preferred over the scheduled figure", () => {
    const raw = emptyRaw({
      energyFlows: { TL: { physical: { net: 0.4, unit: "GW" }, commercial: { net: 0.9, unit: "GW" } } },
      fetchCoverage: { energyFlows: fetchedUnscoped() },
    });
    const tile = tileFor(summaryTiles(baseProps, raw, bounds), "netPower");
    assert.equal(tile.unavailable, false);
    assert.equal(tile.value, "+0.40 GW, measured");
  });

  await t.test("fetched, only a scheduled commercial net: falls back and says so", () => {
    const raw = emptyRaw({
      energyFlows: { TL: { commercial: { net: -0.2, unit: "GW" } } },
      fetchCoverage: { energyFlows: fetchedUnscoped() },
    });
    const tile = tileFor(summaryTiles(baseProps, raw, bounds), "netPower");
    assert.equal(tile.unavailable, false);
    assert.equal(tile.value, "-0.20 GW, scheduled");
  });
});

test("summaryTiles -- military aircraft", async (t) => {
  await t.test("no bounding box at all: dash", () => {
    const tile = tileFor(summaryTiles(baseProps, emptyRaw(), null), "militaryAircraft");
    assert.equal(tile.unavailable, true);
    assert.match(tile.tooltip, /no bounding box/i);
  });

  await t.test("adsb feed never fetched this session: dash, not zero", () => {
    const tile = tileFor(summaryTiles(baseProps, emptyRaw(), bounds), "militaryAircraft");
    assert.equal(tile.unavailable, true);
    assert.match(tile.tooltip, /Not loaded this session/);
  });

  await t.test("adsb fetched, but scoped to a different area: dash", () => {
    const raw = emptyRaw({ fetchCoverage: { adsb: fetchedScopedTo("40,40,50,50") } });
    const tile = tileFor(summaryTiles(baseProps, raw, bounds), "militaryAircraft");
    assert.equal(tile.unavailable, true);
    assert.match(tile.tooltip, /different area/);
  });

  await t.test("checked, nothing military in bounds: a real 0", () => {
    const raw = emptyRaw({ fetchCoverage: { adsb: fetchedUnscoped() } });
    const tile = tileFor(summaryTiles(baseProps, raw, bounds), "militaryAircraft");
    assert.equal(tile.unavailable, false);
    assert.equal(tile.value, "0");
  });

  await t.test("checked, with a military aircraft in bounds: counts it", () => {
    const raw = emptyRaw({
      adsb: [{ lat: 5, lon: 5, military: true }],
      fetchCoverage: { adsb: fetchedUnscoped() },
    });
    const tile = tileFor(summaryTiles(baseProps, raw, bounds), "militaryAircraft");
    assert.equal(tile.unavailable, false);
    assert.equal(tile.value, "1");
  });
});

test("groupSections -- PlaceInfoCard's super-fold grouping helper", async (t) => {
  const sections = [
    { id: "a", title: "A", html: "<p>a</p>" },
    { id: "b", title: "B", html: "<p>b</p>" },
    { id: "c", title: "C", html: "<p>c</p>" },
  ];

  await t.test("no groups prop at all: every section renders flat, in its original order -- unchanged from today", () => {
    const expected = sections.map((section) => ({ kind: "section", section }));
    assert.deepEqual(groupSections(sections, undefined), expected);
    assert.deepEqual(groupSections(sections, []), expected);
  });

  await t.test("a section id that appears in no group still renders, at the end, not vanished", () => {
    // This is the exact failure mode the task brief calls out: a later task
    // adding a sixteenth section and forgetting to add its id to the
    // grouping table must lose nothing, only its neat grouping.
    const groups = [
      { id: "first", title: "First", sectionIds: ["a"] },
      { id: "second", title: "Second", sectionIds: ["b"] },
    ];
    assert.deepEqual(groupSections(sections, groups), [
      { kind: "group", id: "first", title: "First", sections: [sections[0]] },
      { kind: "group", id: "second", title: "Second", sections: [sections[1]] },
      { kind: "section", section: sections[2] },
    ]);
  });

  await t.test("a group whose sectionIds match nothing present is skipped, not rendered as an empty fold", () => {
    const groups = [
      { id: "ghost", title: "Ghost", sectionIds: ["nope", "also-nope"] },
      { id: "real", title: "Real", sectionIds: ["a"] },
    ];
    const items = groupSections(sections, groups);
    assert.equal(items.some((item) => item.kind === "group" && item.id === "ghost"), false);
    assert.deepEqual(items[0], { kind: "group", id: "real", title: "Real", sections: [sections[0]] });
    // b and c both fall through ungrouped, after the one real group.
    assert.deepEqual(items.slice(1), [
      { kind: "section", section: sections[1] },
      { kind: "section", section: sections[2] },
    ]);
  });

  await t.test("a section id listed in two groups is only ever rendered once, by the first group that claims it", () => {
    const groups = [
      { id: "first", title: "First", sectionIds: ["a", "b"] },
      { id: "second", title: "Second", sectionIds: ["b"] },
    ];
    const items = groupSections(sections, groups);
    assert.deepEqual(items[0], { kind: "group", id: "first", title: "First", sections: [sections[0], sections[1]] });
    // "second" is left claiming nothing, so it is dropped rather than
    // rendered as an empty fold -- same rule as the "ghost" case above.
    assert.equal(items.some((item) => item.kind === "group" && item.id === "second"), false);
  });

  await t.test("a section id repeated within one group's own sectionIds is only ever rendered once", () => {
    // The cross-group duplicate above exercises `claimed` carrying state
    // *between* groups; this exercises the narrower case a single map+filter
    // pass over one group's own list can miss -- a group naming the same id
    // twice must not place the same section object into its own `sections`
    // array twice, which would hand React two <details> with the same key.
    const groups = [{ id: "first", title: "First", sectionIds: ["a", "a", "b"] }];
    const items = groupSections(sections, groups);
    assert.deepEqual(items, [
      { kind: "group", id: "first", title: "First", sections: [sections[0], sections[1]] },
      { kind: "section", section: sections[2] },
    ]);
  });
});

test("countryCardSections -- COUNTRY_CARD_GROUPS drops nothing when applied through groupSections", async (t) => {
  await t.test("every section id the card actually produces is still rendered somewhere after grouping", () => {
    const raw = emptyRaw({
      events: [{ lat: 5, lon: 5, date: TODAY, fatalities: 1 }],
    });
    const { sections, groups } = countryCardSections(baseProps, raw, bounds);
    const items = groupSections(sections, groups);
    const renderedIds = items.flatMap((item) => (item.kind === "group" ? item.sections : [item.section])).map((s) => s.id);
    assert.deepEqual(new Set(renderedIds), new Set(sections.map((s) => s.id)));
  });

  // The test above proves COUNTRY_CARD_GROUPS currently accounts for every
  // real section id -- which, by construction, means it can never exercise
  // groupSections' own fallback branch: with nothing left unclaimed, the
  // "still renders, at the end" guarantee is unverified on anything but
  // synthetic a/b/c fixtures. This closes that gap using the *real* table
  // and *real* card output, with one section injected that COUNTRY_CARD_GROUPS
  // was never told about -- the actual failure mode the fallback exists for
  // is a later task adding a section and forgetting this table, not a
  // hand-written test fixture.
  await t.test("a section id real countryCardSections output has, but the real COUNTRY_CARD_GROUPS doesn't name, still renders at the end", () => {
    const raw = emptyRaw({
      events: [{ lat: 5, lon: 5, date: TODAY, fatalities: 1 }],
    });
    const { sections } = countryCardSections(baseProps, raw, bounds);
    const orphan = { id: "totallyNewSection", title: "Totally New", html: "<p>new</p>" };
    const withOrphan = [...sections, orphan];

    // COUNTRY_CARD_GROUPS itself, unmodified -- not a copy with the orphan's
    // id added to some group, which would just be testing the fixture back
    // to itself.
    const items = groupSections(withOrphan, COUNTRY_CARD_GROUPS);

    assert.deepEqual(items[items.length - 1], { kind: "section", section: orphan },
      "an id no real group claims falls through to the standalone tail, last");
    const renderedIds = items.flatMap((item) => (item.kind === "group" ? item.sections : [item.section])).map((s) => s.id);
    assert.deepEqual(new Set(renderedIds), new Set(withOrphan.map((s) => s.id)),
      "nothing about the real fifteen sections was disturbed by the sixteenth");
  });
});
