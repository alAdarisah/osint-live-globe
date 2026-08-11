// Task 38: CableOutagePanel's own logic -- reading GET /api/cable-outage-risk's
// ranked `coincidences` array into rows, the status-count summary, and the
// "checked, nothing found" wording. cableOutagePanelLogic.js imports nothing,
// so like infraRiskPanel.test.js this needs no window/Leaflet stub.

import test from "node:test";
import assert from "node:assert/strict";

import {
  STATUS_LABEL, coincidenceRows, emptyStateText, hasCableOutageDocument, statusCounts,
} from "../src/components/cableOutagePanelLogic.js";

function coincidence(country_code, overrides = {}) {
  return {
    country_code, country: country_code, current_score: 5_000_000, baseline_score: 1_000_000, ratio: 5.0,
    landings: [{ id: "l1", name: "A Landing", lat: 1, lon: 1 }],
    events: [{ id: "e1", event_type: "violence", country: country_code, first_seen: 1_754_000_000, lat: 1, lon: 1 }],
    provenance: "derived",
    ...overrides,
  };
}

// --- coincidenceRows -------------------------------------------------------

test("coincidenceRows reads the document's own `coincidences` array", () => {
  const doc = { coincidences: [coincidence("EG"), coincidence("FR")] };
  assert.equal(coincidenceRows(doc).length, 2);
});

test("coincidenceRows is empty, not an error, before anything has landed", () => {
  assert.deepEqual(coincidenceRows(null), []);
  assert.deepEqual(coincidenceRows(undefined), []);
  assert.deepEqual(coincidenceRows({}), []);
  assert.deepEqual(coincidenceRows({ coincidences: null }), []);
});

// --- hasCableOutageDocument (fetch-failed vs not-computed vs empty) --------

test("hasCableOutageDocument: a real document (countries_with_landings present, even at 0) is true", () => {
  assert.equal(hasCableOutageDocument({ countries_with_landings: 0, coincidences: [] }), true);
  assert.equal(hasCableOutageDocument({ countries_with_landings: 12, coincidences: [coincidence("EG")] }), true);
});

test("hasCableOutageDocument: GET /api/cable-outage-risk's own \"not computed yet\" {} is false", () => {
  assert.equal(hasCableOutageDocument({}), false);
});

test("hasCableOutageDocument: null, undefined or a non-object is false, not a throw", () => {
  assert.equal(hasCableOutageDocument(null), false);
  assert.equal(hasCableOutageDocument(undefined), false);
  assert.equal(hasCableOutageDocument("not a document"), false);
});

// --- statusCounts ------------------------------------------------------

test("statusCounts reads the document's own status_counts, defaulting every bucket to 0", () => {
  const doc = { status_counts: { spike: 2, no_spike: 5 } };
  assert.deepEqual(statusCounts(doc), { spike: 2, no_spike: 5, insufficient_history: 0, never_observed: 0 });
});

test("statusCounts on a missing document is all zeroes, not a throw", () => {
  assert.deepEqual(statusCounts(null), { spike: 0, no_spike: 0, insufficient_history: 0, never_observed: 0 });
  assert.deepEqual(statusCounts({}), { spike: 0, no_spike: 0, insufficient_history: 0, never_observed: 0 });
});

// --- emptyStateText: "found nothing" must never read like "did not look" ---

test("emptyStateText: no landing-holding country checked at all", () => {
  const text = emptyStateText({ countries_with_landings: 0, status_counts: {} });
  assert.match(text, /has been checked yet/);
});

test("emptyStateText: countries checked, none currently elevated", () => {
  const text = emptyStateText({ countries_with_landings: 8, status_counts: { spike: 0 } });
  assert.match(text, /8 landing-holding countries checked/);
  assert.match(text, /none currently elevated/);
});

test("emptyStateText: some elevated, but nothing matched near their landings", () => {
  const text = emptyStateText({ countries_with_landings: 8, status_counts: { spike: 2 } });
  assert.match(text, /2 landing-holding countries are currently elevated/);
  assert.match(text, /no fused event landed near their cable landings/);
});

test("emptyStateText singularises a single checked country and a single spiking one", () => {
  assert.match(emptyStateText({ countries_with_landings: 1, status_counts: { spike: 0 } }), /1 landing-holding country checked/);
  assert.match(emptyStateText({ countries_with_landings: 1, status_counts: { spike: 1 } }), /1 landing-holding country is currently elevated/);
});

// --- STATUS_LABEL: covers exactly the four states the backend can emit -----

test("STATUS_LABEL covers exactly the four spike-status words backend/refine/cable_outage.py emits", () => {
  assert.deepEqual(Object.keys(STATUS_LABEL).sort(), [
    "insufficient_history", "never_observed", "no_spike", "spike",
  ]);
});

// --- language: STATUS_LABEL never attributes a cable fault to anything -----

const _BANNED_PHRASES = [
  "caused by", "attack", "sabotage", "targeted", "responsible for", "deliberate", "retaliat",
];

test("no banned causal phrase appears in any status label", () => {
  for (const label of Object.values(STATUS_LABEL)) {
    const lowered = label.toLowerCase();
    for (const phrase of _BANNED_PHRASES) {
      assert.ok(!lowered.includes(phrase), `banned phrase "${phrase}" found in "${label}"`);
    }
  }
});
