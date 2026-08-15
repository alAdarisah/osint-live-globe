// Task 29: the airfield-activity panel's own logic -- the sort and the
// military-share arithmetic the brief calls out by name. airfieldPanelLogic.js
// imports nothing, so unlike intelPanel.test.js this needs no window/Leaflet
// stub.

import test from "node:test";
import assert from "node:assert/strict";

import {
  airfieldActivityEmptyMessage, airfieldRows, militaryShare, sortAirfields, trafficTrend, AIRFIELD_SORT_KEYS,
} from "../src/components/airfieldPanelLogic.js";

function entry(code, overrides = {}) {
  return { code, name: `Airfield ${code}`, military_field: false, aircraft: 0, military_aircraft: 0, ...overrides };
}

// --- airfieldRows -------------------------------------------------------

test("airfieldRows turns the {code: entry} document into a plain array", () => {
  const activity = { AAA: entry("AAA"), BBB: entry("BBB") };
  const rows = airfieldRows(activity);
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.code)), new Set(["AAA", "BBB"]));
});

test("airfieldRows is empty, not an error, before anything has landed", () => {
  assert.deepEqual(airfieldRows(null), []);
  assert.deepEqual(airfieldRows(undefined), []);
  assert.deepEqual(airfieldRows({}), []);
});

// --- militaryShare -------------------------------------------------------

test("militaryShare is the military fraction of a field's own traffic", () => {
  assert.equal(militaryShare(entry("A", { aircraft: 4, military_aircraft: 1 })), 0.25);
  assert.equal(militaryShare(entry("A", { aircraft: 60, military_aircraft: 59 })), 59 / 60);
});

test("militaryShare is null, not zero, for a field with no traffic at all", () => {
  // 0/0 is "nothing observed here", not "0% military" -- the two read
  // completely differently in a panel and must never be conflated.
  assert.equal(militaryShare(entry("A", { aircraft: 0, military_aircraft: 0 })), null);
});

test("militaryShare treats a missing military_aircraft as zero, not a crash", () => {
  assert.equal(militaryShare({ code: "A", aircraft: 10 }), 0);
});

// --- sortAirfields ---------------------------------------------------------

test("sorts by total movements, busiest first by default", () => {
  const rows = [entry("A", { aircraft: 5 }), entry("B", { aircraft: 60 }), entry("C", { aircraft: 20 })];
  const sorted = sortAirfields(rows, "aircraft");
  assert.deepEqual(sorted.map((r) => r.code), ["B", "C", "A"]);
});

test("sorts ascending when asked", () => {
  const rows = [entry("A", { aircraft: 5 }), entry("B", { aircraft: 60 }), entry("C", { aircraft: 20 })];
  const sorted = sortAirfields(rows, "aircraft", "asc");
  assert.deepEqual(sorted.map((r) => r.code), ["A", "C", "B"]);
});

test("sorts by military share, not by raw military count", () => {
  // A training field with two dozen movements, every one military, must
  // outrank a busy civil hub whose military traffic is a rounding error --
  // this is the whole point of the "military share" axis, per the brief.
  const rows = [
    entry("BUSY_CIVIL", { aircraft: 500, military_aircraft: 5 }),
    entry("TRAINING", { aircraft: 24, military_aircraft: 24 }),
  ];
  const sorted = sortAirfields(rows, "militaryShare");
  assert.deepEqual(sorted.map((r) => r.code), ["TRAINING", "BUSY_CIVIL"]);
});

test("a field with no traffic at all sorts below every field with a real military share", () => {
  const rows = [
    entry("QUIET", { aircraft: 0, military_aircraft: 0 }),
    entry("SOME", { aircraft: 10, military_aircraft: 1 }),
  ];
  const sorted = sortAirfields(rows, "militaryShare", "desc");
  assert.deepEqual(sorted.map((r) => r.code), ["SOME", "QUIET"]);
});

test("ties on the sorted figure break on the airfield code", () => {
  const rows = [entry("ZZZ", { aircraft: 10 }), entry("AAA", { aircraft: 10 })];
  const sorted = sortAirfields(rows, "aircraft");
  assert.deepEqual(sorted.map((r) => r.code), ["AAA", "ZZZ"]);
});

test("sorting never mutates the array it was given", () => {
  const rows = [entry("A", { aircraft: 1 }), entry("B", { aircraft: 2 })];
  const original = [...rows];
  sortAirfields(rows, "aircraft");
  assert.deepEqual(rows, original);
});

test("an unknown sort key falls back to total movements rather than throwing", () => {
  const rows = [entry("A", { aircraft: 5 }), entry("B", { aircraft: 60 })];
  const sorted = sortAirfields(rows, "not_a_real_key");
  assert.deepEqual(sorted.map((r) => r.code), ["B", "A"]);
});

test("AIRFIELD_SORT_KEYS lists every axis the panel can sort by", () => {
  assert.ok(AIRFIELD_SORT_KEYS.includes("aircraft"));
  assert.ok(AIRFIELD_SORT_KEYS.includes("militaryShare"));
});

// --- trafficTrend ------------------------------------------------------

test("trend is up when the second half of the window is busier", () => {
  assert.equal(trafficTrend([1, 1, 1, 1, 5, 5, 5, 5]), "up");
});

test("trend is down when the second half of the window is quieter", () => {
  assert.equal(trafficTrend([5, 5, 5, 5, 1, 1, 1, 1]), "down");
});

test("trend is flat when both halves match", () => {
  assert.equal(trafficTrend([2, 2, 2, 2]), "flat");
});

test("trend is flat, not up or down, for a field with no movements at all", () => {
  assert.equal(trafficTrend([0, 0, 0, 0]), "flat");
});

test("trend is null without at least two hourly buckets to compare", () => {
  assert.equal(trafficTrend([]), null);
  assert.equal(trafficTrend([5]), null);
  assert.equal(trafficTrend(null), null);
});

// --- airfieldActivityEmptyMessage ---------------------------------------
//
// GET /api/airfield-activity's own empty `{}` conflates "no database",
// "the refine process has not written a pass yet" and "a pass ran and found
// no field with any traffic" (see storage.airfield_activity/the endpoint's
// own docstring) -- unlike ChokepointPanel/InfraRiskPanel's documents, which
// always carry a wrapper key (`boxes`/`events_searched`) that survives an
// otherwise-empty result. This module has no way to tell those apart, so the
// message has to say so honestly rather than assert either specific reading.

test("airfieldActivityEmptyMessage does not claim to know which of the two situations this is", () => {
  const msg = airfieldActivityEmptyMessage();
  assert.match(msg, /No airfield movements recorded/);
  assert.match(msg, /or the refine process has not written a pass yet/);
});
