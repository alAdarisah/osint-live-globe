// Task 18: the vessel and aircraft filter bars (frontend/src/utils/entityFilter.js).
//
// entityFilter.js touches nothing but plain objects and arrays, so -- like
// mmsi.js -- no window.L stub is needed, just Node's own ESM loader.

import test from "node:test";
import assert from "node:assert/strict";

import {
  matchQuery, matchesVesselFilter, matchesAircraftFilter,
  filterVessels, filterAircraft, DEFAULT_VESSEL_FILTER, DEFAULT_AIRCRAFT_FILTER,
} from "../src/utils/entityFilter.js";

// ---------- matchQuery: wildcard and implicit-prefix matching --------------

test("matchQuery: no wildcard is an implicit, case-insensitive prefix match", () => {
  assert.equal(matchQuery("DLH400", "dlh"), true);
  assert.equal(matchQuery("DLH400", "DLH400"), true);
  assert.equal(matchQuery("DLH400", "LH4"), false); // not a prefix, and no wildcard was given
  assert.equal(matchQuery("DLH400", "DLH4001"), false); // longer than the value
});

test("matchQuery: * matches any run of characters, anchored start and end", () => {
  assert.equal(matchQuery("DLH400", "DLH*"), true);   // trailing wildcard: starts-with
  assert.equal(matchQuery("DLH400", "*400"), true);    // leading wildcard: ends-with
  assert.equal(matchQuery("DLH400", "*H4*"), true);    // both ends: contains
  assert.equal(matchQuery("DLH400", "D*4*0"), true);   // wildcard in the middle
  assert.equal(matchQuery("DLH400", "DLH*99"), false); // the literal tail never appears
});

test("matchQuery: a query with a wildcard is still anchored, not a bare substring test", () => {
  // Without the anchor, "H4*" would also match as a substring; the point of
  // requiring an explicit wildcard is that the reader controls both ends.
  assert.equal(matchQuery("DLH400", "H4*"), false);
});

test("matchQuery: numeric fields (mmsi, imo) are compared as strings", () => {
  assert.equal(matchQuery(367001234, "367"), true);
  assert.equal(matchQuery(367001234, "*1234"), true);
  assert.equal(matchQuery(367001234, "999"), false);
});

test("matchQuery: an empty query matches everything, including a missing field", () => {
  assert.equal(matchQuery("DLH400", ""), true);
  assert.equal(matchQuery("DLH400", "   "), true);
  assert.equal(matchQuery(null, ""), true);
  assert.equal(matchQuery(undefined, ""), true);
});

test("matchQuery: a non-empty query never matches a missing field", () => {
  assert.equal(matchQuery(null, "DLH"), false);
  assert.equal(matchQuery(undefined, "*"), false);
});

test("matchQuery: regex metacharacters in the query are treated literally", () => {
  assert.equal(matchQuery("5B.01", "5B.01"), true);
  assert.equal(matchQuery("5BX01", "5B.01"), false); // "." is not a wildcard here, "*" is
});

// ---------- matchesVesselFilter -------------------------------------------

const ship = (over = {}) => ({
  callsign: "5BXY2", name: "SEA STAR", mmsi: 212345678, imo: 9123456,
  sanctions: null, watchlist: null, ...over,
});

test("matchesVesselFilter: text matches across callsign, name, mmsi and imo", () => {
  assert.equal(matchesVesselFilter(ship(), { text: "5BX" }), true);
  assert.equal(matchesVesselFilter(ship(), { text: "sea star" }), true);
  assert.equal(matchesVesselFilter(ship(), { text: "212345" }), true);
  assert.equal(matchesVesselFilter(ship(), { text: "9123456" }), true);
  assert.equal(matchesVesselFilter(ship(), { text: "NOPE" }), false);
});

test("matchesVesselFilter: the default filter (empty query, no flags) matches everything", () => {
  assert.equal(matchesVesselFilter(ship(), DEFAULT_VESSEL_FILTER), true);
  assert.equal(matchesVesselFilter(ship({ callsign: null, name: null, mmsi: null, imo: null }), DEFAULT_VESSEL_FILTER), true);
});

test("matchesVesselFilter: sanctionedOnly and watchlistedOnly gate on presence, not content", () => {
  const clean = ship();
  const sanctioned = ship({ sanctions: { program: "UKRAINE-EO13662" } });
  const watchlisted = ship({ watchlist: { list: "OpenSanctions" } });

  assert.equal(matchesVesselFilter(clean, { text: "", sanctionedOnly: true }), false);
  assert.equal(matchesVesselFilter(sanctioned, { text: "", sanctionedOnly: true }), true);
  assert.equal(matchesVesselFilter(clean, { text: "", watchlistedOnly: true }), false);
  assert.equal(matchesVesselFilter(watchlisted, { text: "", watchlistedOnly: true }), true);
});

test("matchesVesselFilter: flags and text combine with AND, not OR", () => {
  const sanctionedButWrongName = ship({ name: "OTHER", sanctions: { program: "X" } });
  assert.equal(
    matchesVesselFilter(sanctionedButWrongName, { text: "SEA STAR", sanctionedOnly: true }),
    false
  );
});

// ---------- matchesAircraftFilter -------------------------------------------

const aircraft = (over = {}) => ({
  callsign: "RCH271", registration: "N512JT", icao24: "ae1234",
  operator: "US Air Force", type_code: "C17", squawk: "1200",
  military: false, callsign_military: true, ...over,
});

test("matchesAircraftFilter: text matches across every field the brief lists", () => {
  assert.equal(matchesAircraftFilter(aircraft(), { text: "rch" }), true);
  assert.equal(matchesAircraftFilter(aircraft(), { text: "N512JT" }), true);
  assert.equal(matchesAircraftFilter(aircraft(), { text: "ae1234" }), true);
  assert.equal(matchesAircraftFilter(aircraft(), { text: "*air force" }), true);
  assert.equal(matchesAircraftFilter(aircraft(), { text: "C17" }), true);
  assert.equal(matchesAircraftFilter(aircraft(), { text: "1200" }), true);
  assert.equal(matchesAircraftFilter(aircraft(), { text: "DLH" }), false);
});

test("matchesAircraftFilter: the default filter matches everything", () => {
  assert.equal(matchesAircraftFilter(aircraft(), DEFAULT_AIRCRAFT_FILTER), true);
});

test("matchesAircraftFilter: militaryOnly accepts either military signal", () => {
  assert.equal(matchesAircraftFilter(aircraft({ military: true, callsign_military: false }), { militaryOnly: true }), true);
  assert.equal(matchesAircraftFilter(aircraft({ military: false, callsign_military: true }), { militaryOnly: true }), true);
  assert.equal(
    matchesAircraftFilter(aircraft({ military: false, callsign_military: false }), { militaryOnly: true }),
    false
  );
});

// ---------- filterVessels / filterAircraft: non-mutation and edge cases ----

test("filterVessels: an empty query matches every item", () => {
  const items = [ship({ mmsi: 1 }), ship({ mmsi: 2 }), ship({ mmsi: 3 })];
  assert.deepEqual(filterVessels(items, DEFAULT_VESSEL_FILTER), items);
});

test("filterVessels: a query matching nothing returns an empty array, not the original", () => {
  const items = [ship({ mmsi: 1 }), ship({ mmsi: 2 })];
  const result = filterVessels(items, { text: "NO-SUCH-CALLSIGN" });
  assert.deepEqual(result, []);
});

test("filterVessels never mutates the source array or its items", () => {
  const items = [ship({ mmsi: 1, name: "A" }), ship({ mmsi: 2, name: "B" }), ship({ mmsi: 3, name: "C" })];
  const snapshot = JSON.parse(JSON.stringify(items));
  const result = filterVessels(items, { text: "B" });

  assert.deepEqual(items, snapshot, "the source array's contents must be unchanged");
  assert.notEqual(result, items, "filtering must return a new array, not the same reference");
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "B");
  assert.equal(result[0], items[1], "surviving items are the same objects, not copies");
});

test("filterAircraft never mutates the source array", () => {
  const items = [
    aircraft({ icao24: "a", military: false, callsign_military: false }),
    aircraft({ icao24: "b", military: true, callsign_military: false }),
  ];
  const snapshot = JSON.parse(JSON.stringify(items));
  const result = filterAircraft(items, { militaryOnly: true });

  assert.deepEqual(items, snapshot);
  assert.notEqual(result, items);
  assert.equal(result.length, 1);
  assert.equal(result[0].icao24, "b");
});
