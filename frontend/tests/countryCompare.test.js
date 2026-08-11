// Task 40: the comparison table's own pure module (countryCompareLogic.js).
//
// Three things get their own direct coverage per the task brief: row
// alignment when one of the compared countries has nothing for a given
// metric (population/refugees below), the missing-data rendering -- a real
// value including a real 0 must never look like any of the three reasons a
// cell can be empty, and the three reasons must never look like each other
// either -- and the three-country layout, including what happens with a
// fourth country in the selection.
//
// Same loader shim as countryCardSections.test.js: countryCompareLogic.js
// imports map/popups.js (for itemsInBounds/coverageStateFor/
// recentConflictStats, reused rather than re-derived a second time -- see
// this module's own header note on why) and map/decorators.js
// (classifyAircraft/classifyShip), and decorators.js pulls in map/
// leafletGlobal.js at module scope, so window.L is stubbed just enough to
// satisfy that import. Nothing here touches the DOM.

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
  buildCountryComparison, buildComparisonRow, selectCompareCountries,
  truncationNote, needMoreCountriesNote, CELL_STATUS, COMPARE_METRICS,
  COMPARE_COVERAGE_CAVEAT, MIN_COMPARE_COUNTRIES, MAX_COMPARE_COUNTRIES,
} = await import("../src/components/countryCompareLogic.js");

const BOUNDS = { south: 0, west: 0, north: 10, east: 10 };

// Same shape emptyRaw() takes in countryCardSections.test.js -- every raw[key]
// this module can read defaults to empty/absent, so a test that wants "not
// loaded" gets it by construction rather than by accident.
function emptyRaw(overrides = {}) {
  return {
    events: [], adsb: [], ais: [], firms: [], humanitarian: {},
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

// Every feed this module reads, marked fetched and covering BOUNDS -- the
// baseline for a test that wants every row to actually resolve to a real
// value rather than "not checked yet", so only the field under test is left
// to vary.
function fullCoverage() {
  return {
    events: fetchedUnscoped(), adsb: fetchedUnscoped(), ais: fetchedUnscoped(),
    firms: fetchedUnscoped(), humanitarian: fetchedUnscoped(),
  };
}

function country(overrides = {}) {
  return {
    key: "TL", name: "Testland", bounds: BOUNDS,
    props: { iso_a3: "TST" },
    ...overrides,
  };
}

function rowById(rows, id) {
  return rows.find((r) => r.id === id);
}

// --- row alignment when one country lacks a section --------------------

test("a metric one country has no record for still produces a row with a cell per country -- never dropped", () => {
  const a = country({ key: "A", name: "Aland", props: { iso_a3: "AAA", population: 1_000_000 } });
  const b = country({ key: "B", name: "Beeland", props: { iso_a3: "BBB" } }); // no population field at all
  const raw = emptyRaw({ fetchCoverage: fullCoverage() });

  const { rows, countries } = buildCountryComparison([a, b], raw);

  assert.equal(countries.length, 2, "both countries are still in the table");
  const pop = rowById(rows, "population");
  assert.ok(pop, "the population row is present even though one country has nothing to show for it");
  assert.equal(pop.cells.length, 2, "one cell per country -- the row stays aligned");
  assert.equal(pop.cells[0].status, CELL_STATUS.VALUE);
  assert.equal(pop.cells[0].value, 1_000_000);
  assert.equal(pop.cells[1].status, CELL_STATUS.NOT_COLLECTED, "missing, not a fabricated zero");
  assert.equal(pop.cells[1].value, null);
  assert.equal(pop.comparable, false, "a row with any non-value cell cannot be fairly compared");
  assert.equal(pop.differs, false, "differs is never claimed when one side could not even be checked");
});

test("row alignment holds across every metric, not just the one under test -- same country count, same cell count, in order", () => {
  const a = country({ key: "A", name: "Aland" });
  const b = country({ key: "B", name: "Beeland" });
  const { rows } = buildCountryComparison([a, b], emptyRaw());
  assert.equal(rows.length, COMPARE_METRICS.length, "every configured metric produces exactly one row");
  for (const row of rows) {
    assert.equal(row.cells.length, 2, `row ${row.id} has one cell per country`);
  }
});

// --- missing-data rendering: the four states must never collapse into each other ---

test("a real, checked zero renders as CELL_STATUS.VALUE with value 0 -- not as any of the three empty states", () => {
  const a = country({ props: { iso_a3: "TST" } });
  // events fetched and covers this bbox, but the feed itself is empty --
  // recentConflictStats' own honest "checked, nothing found" answer.
  const raw = emptyRaw({ events: [], fetchCoverage: { events: fetchedUnscoped() } });
  const { rows } = buildCountryComparison([a, country({ key: "B", name: "Beeland" })], raw);
  const events = rowById(rows, "conflictEvents72h");
  assert.equal(events.cells[0].status, CELL_STATUS.VALUE);
  assert.equal(events.cells[0].value, 0, "a real zero, not dropped and not confused with 'not checked'");
  assert.equal(events.cells[0].formatted, "0");
});

test("CELL_STATUS.NOT_COLLECTED: the source is loaded and covers this country, but never reported this field", () => {
  const a = country({ props: { iso_a3: "TST", hdi: null } });
  const { rows } = buildCountryComparison([a, country({ key: "B", name: "Beeland" })], emptyRaw());
  const hdi = rowById(rows, "hdi");
  assert.equal(hdi.cells[0].status, CELL_STATUS.NOT_COLLECTED);
  assert.match(hdi.cells[0].reason, /UNDP/);
});

test("CELL_STATUS.NOT_LOADED: this session has not fetched the feed at all yet", () => {
  const a = country({ props: { iso_a3: "TST" } });
  // fetchCoverage carries nothing for "adsb" -- coverageStateFor reads that
  // as "not_loaded", the same as the country card's own coverage table does.
  const { rows } = buildCountryComparison([a, country({ key: "B", name: "Beeland" })], emptyRaw());
  const aircraft = rowById(rows, "militaryAircraft");
  assert.equal(aircraft.cells[0].status, CELL_STATUS.NOT_LOADED);
  assert.match(aircraft.cells[0].reason, /not been fetched/);
});

test("CELL_STATUS.NOT_LOADED also covers 'fetched, but for a different area', worded differently from 'never fetched'", () => {
  const a = country({ props: { iso_a3: "TST" } });
  const raw = emptyRaw({ fetchCoverage: { ais: fetchedScopedTo("40,40,50,50") } }); // nowhere near BOUNDS
  const { rows } = buildCountryComparison([a, country({ key: "B", name: "Beeland" })], raw);
  const navy = rowById(rows, "navyVessels");
  assert.equal(navy.cells[0].status, CELL_STATUS.NOT_LOADED);
  assert.match(navy.cells[0].reason, /different area/);
});

test("CELL_STATUS.NOT_LOADED when the country's own boundary bbox has not resolved yet, rather than a false zero", () => {
  const a = country({ bounds: null, props: { iso_a3: "TST" } });
  const raw = emptyRaw({ fetchCoverage: fullCoverage() });
  const { rows } = buildCountryComparison([a, country({ key: "B", name: "Beeland" })], raw);
  const fires = rowById(rows, "fires");
  assert.equal(fires.cells[0].status, CELL_STATUS.NOT_LOADED);
  assert.equal(fires.cells[0].value, null, "a missing boundary must never read as a checked zero");
});

test("CELL_STATUS.NOT_APPLICABLE: refugees cannot even be looked up for a shape with no ISO3 code", () => {
  const a = country({ props: {} }); // no iso_a3 at all -- e.g. a Natural Earth "-99" territory
  const raw = emptyRaw({ fetchCoverage: fullCoverage(), humanitarian: { TST: { displacement: { refugees: 5000 } } } });
  const { rows } = buildCountryComparison([a, country({ key: "B", name: "Beeland" })], raw);
  const refugees = rowById(rows, "refugeesOrigin");
  assert.equal(refugees.cells[0].status, CELL_STATUS.NOT_APPLICABLE);
  assert.match(refugees.cells[0].reason, /ISO3/);
});

test("refugees NOT_COLLECTED vs NOT_APPLICABLE: a country *with* an ISO3 code UNHCR simply never reported on", () => {
  const a = country({ props: { iso_a3: "ZZZ" } }); // has a code, just not one UNHCR's record covers
  const raw = emptyRaw({ fetchCoverage: fullCoverage(), humanitarian: { TST: { displacement: { refugees: 5000 } } } });
  const { rows } = buildCountryComparison([a, country({ key: "B", name: "Beeland" })], raw);
  const refugees = rowById(rows, "refugeesOrigin");
  assert.equal(refugees.cells[0].status, CELL_STATUS.NOT_COLLECTED, "a real gap in the source, not a structural non-match");
});

test("the four states never format the same way -- VALUE always carries a formatted string, every other status never does", () => {
  const a = country({ props: { iso_a3: "TST", population: 42 } });
  const b = country({ key: "B", name: "Beeland", props: {} }); // triggers NOT_APPLICABLE on refugees
  const raw = emptyRaw(); // triggers NOT_LOADED everywhere else
  const { rows } = buildCountryComparison([a, b], raw);
  for (const row of rows) {
    for (const c of row.cells) {
      if (c.status === CELL_STATUS.VALUE) {
        assert.ok(typeof c.formatted === "string" && c.formatted.length > 0, `${row.id}: a value cell must format`);
      } else {
        assert.equal(c.formatted, null, `${row.id}: a ${c.status} cell must never carry a formatted value`);
        assert.ok(c.reason, `${row.id}: a ${c.status} cell must say why`);
      }
    }
  }
});

test("HDI formats to three decimals, matching the country card's own convention", () => {
  const a = country({ props: { iso_a3: "TST", hdi: 0.8 } });
  const { rows } = buildCountryComparison([a, country({ key: "B", name: "Beeland" })], emptyRaw());
  assert.equal(rowById(rows, "hdi").cells[0].formatted, "0.800");
});

// --- differs: a boolean, never a ranking --------------------------------

test("differs is true only when every cell in the row is a real value and they are not all equal", () => {
  const a = country({ props: { iso_a3: "TST", population: 100 } });
  const b = country({ key: "B", name: "Beeland", props: { iso_a3: "BBB", population: 400 } });
  const { rows } = buildCountryComparison([a, b], emptyRaw());
  const pop = rowById(rows, "population");
  assert.equal(pop.comparable, true);
  assert.equal(pop.differs, true);
});

test("differs is false when the real values happen to be equal", () => {
  const a = country({ props: { iso_a3: "TST", population: 100 } });
  const b = country({ key: "B", name: "Beeland", props: { iso_a3: "BBB", population: 100 } });
  const { rows } = buildCountryComparison([a, b], emptyRaw());
  assert.equal(rowById(rows, "population").differs, false);
});

test("differs never fires when a cell is missing, however different the other real value looks", () => {
  // A must not read as "more/less" than B on a row where B was simply never
  // checked -- see this module's own note on the ranking-by-coverage trap.
  const a = country({ props: { iso_a3: "TST", population: 999_999_999 } });
  const b = country({ key: "B", name: "Beeland", props: {} }); // no population field
  const { rows } = buildCountryComparison([a, b], emptyRaw());
  const pop = rowById(rows, "population");
  assert.equal(pop.comparable, false);
  assert.equal(pop.differs, false);
});

// --- three-country layout ------------------------------------------------

test("three selected countries: every row carries exactly three cells, in selection order", () => {
  const a = country({ key: "A", name: "Aland", props: { iso_a3: "AAA", population: 1 } });
  const b = country({ key: "B", name: "Beeland", props: { iso_a3: "BBB", population: 2 } });
  const c = country({ key: "C", name: "Ceeland", props: { iso_a3: "CCC", population: 3 } });
  const { countries, rows } = buildCountryComparison([a, b, c], emptyRaw());
  assert.deepEqual(countries.map((x) => x.key), ["A", "B", "C"]);
  const pop = rowById(rows, "population");
  assert.equal(pop.cells.length, 3);
  assert.deepEqual(pop.cells.map((cell) => cell.value), [1, 2, 3]);
});

test("a fourth selected country is not silently dropped or squeezed in -- the table caps at three and says who was left out", () => {
  const list = ["A", "B", "C", "D", "E"].map((key) => country({ key, name: `${key}land`, props: { iso_a3: key.repeat(3) } }));
  const { countries, omittedNames } = buildCountryComparison(list, emptyRaw());
  assert.equal(countries.length, MAX_COMPARE_COUNTRIES);
  assert.deepEqual(countries.map((c) => c.key), ["A", "B", "C"], "the first three, in the order given, not re-sorted");
  assert.deepEqual(omittedNames, ["Dland", "Eland"]);
  assert.match(truncationNote(omittedNames), /Dland/);
  assert.match(truncationNote(omittedNames), /Eland/);
});

test("truncationNote is null when nothing was trimmed", () => {
  assert.equal(truncationNote([]), null);
  assert.equal(truncationNote(null), null);
});

test("selectCompareCountries never reorders or duplicates -- a plain cap", () => {
  const list = [{ key: "A" }, { key: "B" }, { key: "C" }, { key: "D" }];
  const { countries, omitted } = selectCompareCountries(list);
  assert.deepEqual(countries.map((c) => c.key), ["A", "B", "C"]);
  assert.deepEqual(omitted.map((c) => c.key), ["D"]);
});

test("selectCompareCountries with two -- the minimum -- omits nothing", () => {
  const { countries, omitted } = selectCompareCountries([{ key: "A" }, { key: "B" }]);
  assert.equal(countries.length, 2);
  assert.deepEqual(omitted, []);
});

test("needMoreCountriesNote reads differently at zero/one than the generic 'select two' plural implies", () => {
  assert.match(needMoreCountriesNote(1), /one more/);
  assert.match(needMoreCountriesNote(0), new RegExp(String(MIN_COMPARE_COUNTRIES)));
});

// --- the on-screen coverage caveat is a real, non-empty sentence ---------

test("COMPARE_COVERAGE_CAVEAT exists and says coverage, not the countries, is what's being compared", () => {
  assert.ok(COMPARE_COVERAGE_CAVEAT.length > 40);
  assert.match(COMPARE_COVERAGE_CAVEAT, /not the countries themselves|not a ranking|does not know/i);
});

// --- buildComparisonRow direct, for a single metric in isolation ---------

test("buildComparisonRow: a metric computed for zero countries is still a well-formed (vacuous) row", () => {
  const metric = COMPARE_METRICS[0];
  const row = buildComparisonRow(metric, [], emptyRaw());
  assert.deepEqual(row.cells, []);
  assert.equal(row.comparable, true, "vacuously true over an empty set -- no cell contradicts VALUE-ness");
  assert.equal(row.differs, false, "a set of zero values cannot differ");
});
