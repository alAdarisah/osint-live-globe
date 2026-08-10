// Task 18: countryForCallsign (frontend/src/utils/callsignPrefix.js), the
// callsign-prefix resolver behind the vessel filter bar's "resolved country
// shown beside it" feature.
//
// callsignPrefix.js touches nothing but plain strings, so -- like mmsi.js --
// no window.L stub is needed.

import test from "node:test";
import assert from "node:assert/strict";

import { countryForCallsign } from "../src/utils/callsignPrefix.js";

test("countryForCallsign: a spread of real flag-of-convenience prefixes resolve correctly", () => {
  assert.equal(countryForCallsign("9V1234"), "Singapore");
  assert.equal(countryForCallsign("A8XY"), "Liberia");
  assert.equal(countryForCallsign("3EAB12"), "Panama");
  assert.equal(countryForCallsign("5BCD"), "Cyprus");
  assert.equal(countryForCallsign("H3AB"), "Panama");
  assert.equal(countryForCallsign("V7ABC"), "Marshall Islands");
});

test("countryForCallsign: whole-letter blocks with no sub-range resolve on the first character alone", () => {
  assert.equal(countryForCallsign("WABC123"), "United States");
  assert.equal(countryForCallsign("KABC123"), "United States");
  assert.equal(countryForCallsign("GABCD"), "United Kingdom");
  assert.equal(countryForCallsign("BABCD"), "China");
});

test("countryForCallsign: a three-character series is matched ahead of the shorter series it sits inside", () => {
  // SSA-SSM (Egypt) and SSN-SSZ (Sudan) are both three-character sub-ranges
  // of the two-character "S*" territory that also holds SU (Egypt, a
  // different series) and SV-SZ (Greece) -- the longer series must win over
  // any shorter one that happens to share its lead-in.
  assert.equal(countryForCallsign("SSA123"), "Egypt");
  assert.equal(countryForCallsign("SSZ123"), "Sudan");
  assert.equal(countryForCallsign("SU100"), "Egypt");
});

test("countryForCallsign: case-insensitive, and punctuation/whitespace is stripped before matching", () => {
  assert.equal(countryForCallsign("9v1234"), "Singapore");
  assert.equal(countryForCallsign(" 9V-1234 "), "Singapore");
  assert.equal(countryForCallsign("9V*"), "Singapore"); // a filter-box wildcard, not a real character
});

test("countryForCallsign: a smaller territory's carve-out inside a larger country's block wins over that block", () => {
  // Taiwan's BM-BQ and BU-BX sit inside China's plain "B" block. A first pass
  // over the source table dropped both carve-outs and resolved every B-series
  // callsign to China -- this is the regression test for that.
  assert.equal(countryForCallsign("BV1234"), "Taiwan");  // in BU-BX
  assert.equal(countryForCallsign("BM100"), "Taiwan");   // in BM-BQ, the low end
  assert.equal(countryForCallsign("BX999"), "Taiwan");   // in BU-BX, the high end
  assert.equal(countryForCallsign("BR100"), "China");    // between the two Taiwan ranges
  assert.equal(countryForCallsign("BABCD"), "China");    // outside both ranges entirely

  // Liechtenstein's HB0, HB3Y and HBL sit inside Switzerland's plain "HB"
  // block -- three specific series, not one contiguous range.
  assert.equal(countryForCallsign("HB0123"), "Liechtenstein");
  assert.equal(countryForCallsign("HB3Y1"), "Liechtenstein");
  assert.equal(countryForCallsign("HBL12"), "Liechtenstein");
  assert.equal(countryForCallsign("HB9AB"), "Switzerland"); // outside all three carve-outs
});

test("countryForCallsign: a prefix outside every series, or too short to have one, resolves to null rather than a guess", () => {
  assert.equal(countryForCallsign("1ABCD"), null); // ITU never allocated a series starting with a bare "1"
  assert.equal(countryForCallsign("SS9"), null);    // "SS" + a digit falls in neither SSA-SSM nor SSN-SSZ
  assert.equal(countryForCallsign(""), null);
  assert.equal(countryForCallsign(null), null);
  assert.equal(countryForCallsign(undefined), null);
});
