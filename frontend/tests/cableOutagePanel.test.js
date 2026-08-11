// Task 38: CableOutagePanel's own logic -- reading GET /api/cable-outage-risk's
// ranked `coincidences` array into rows, the status-count summary, and every
// sentence the panel composes. cableOutagePanelLogic.js imports nothing but
// utils/format's fmtNumber, so like infraRiskPanel.test.js this needs no
// window/Leaflet stub.
//
// Task 38 review (Important 1): the panel used to build most of its prose
// inline in JSX, which this suite could not import or assert on at all --
// "today's strings are clean" was not a safety net. Every sentence the panel
// composes now lives in cableOutagePanelLogic.js as a named function, and
// every one of them is exercised here against the banned-phrase list below,
// the same discipline backend/tests/test_cable_outage.py already holds NOTE
// to.

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Every src file in this project uses Vite-style extensionless relative
// imports (cableOutagePanelLogic.js imports "../utils/format"), which
// Node's own resolver cannot follow -- the identical loader shim
// eventDetail.test.js and 25 other test files in this suite already carry.
// registerHooks only affects resolutions that happen *after* it runs, so
// the module under test has to be a dynamic `await import()` below rather
// than a static top-of-file `import` -- a static import is hoisted and
// resolved before this call ever executes, the same reason eventDetail.
// test.js's own import is dynamic too.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
});

const {
  STATUS_LABEL, coincidenceRows, emptyStateText, eventLine, eventSearchLine, eventsHeaderLine,
  hasCableOutageDocument, landingAttributionNote, landingCoverageLine, landingsHeaderLine, scoreLine, statusCounts,
  statusSummaryLine,
} = await import("../src/components/cableOutagePanelLogic.js");

function coincidence(country_code, overrides = {}) {
  return {
    country_code, country: country_code, current_score: 5_000_000, baseline_score: 1_000_000, ratio: 5.0,
    landings: [{ id: "l1", name: "A Landing", lat: 1, lon: 1 }],
    events: [{ id: "e1", event_type: "violence", country: country_code, first_seen: 1_754_000_000, lat: 1, lon: 1 }],
    provenance: "derived",
    ...overrides,
  };
}

const ALL_ZERO_COUNTS = {
  spike: 0, no_spike: 0, insufficient_history: 0, never_observed: 0, not_checkable: 0,
};

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
  assert.deepEqual(statusCounts(doc), { ...ALL_ZERO_COUNTS, spike: 2, no_spike: 5 });
});

test("statusCounts covers not_checkable alongside the other four states", () => {
  const doc = { status_counts: { not_checkable: 3 } };
  assert.deepEqual(statusCounts(doc), { ...ALL_ZERO_COUNTS, not_checkable: 3 });
});

test("statusCounts on a missing document is all zeroes, not a throw", () => {
  assert.deepEqual(statusCounts(null), ALL_ZERO_COUNTS);
  assert.deepEqual(statusCounts({}), ALL_ZERO_COUNTS);
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
  assert.match(text, /no fused event was recorded inside their cable landings/);
});

test("emptyStateText singularises a single checked country and a single spiking one", () => {
  assert.match(emptyStateText({ countries_with_landings: 1, status_counts: { spike: 0 } }), /1 landing-holding country checked/);
  assert.match(emptyStateText({ countries_with_landings: 1, status_counts: { spike: 1 } }), /1 landing-holding country is currently elevated/);
});

// --- STATUS_LABEL: covers exactly the five states the backend can emit -----

test("STATUS_LABEL covers exactly the five spike-status words backend/refine/cable_outage.py emits", () => {
  assert.deepEqual(Object.keys(STATUS_LABEL).sort(), [
    "insufficient_history", "never_observed", "no_spike", "not_checkable", "spike",
  ]);
});

// --- scoreLine -----------------------------------------------------------

test("scoreLine reports the current score alone when there is no ratio yet", () => {
  assert.equal(scoreLine({ current_score: 5_000_000 }), "Outage score 5,000,000");
});

test("scoreLine appends the ratio and baseline when both are present", () => {
  const text = scoreLine({ current_score: 5_000_000, baseline_score: 1_000_000, ratio: 5.0 });
  assert.match(text, /Outage score 5,000,000/);
  assert.match(text, /5\.0x its own recent peak of 1,000,000/);
});

test("scoreLine on a missing entry is not a throw", () => {
  assert.doesNotThrow(() => scoreLine({}));
  assert.doesNotThrow(() => scoreLine(undefined));
});

// --- landingsHeaderLine / eventsHeaderLine / eventLine ----------------------

test("landingsHeaderLine singularises a count of one", () => {
  assert.equal(landingsHeaderLine(1), "1 cable landing recorded in this country:");
  assert.equal(landingsHeaderLine(3), "3 cable landings recorded in this country:");
  assert.equal(landingsHeaderLine(0), "0 cable landings recorded in this country:");
});

test("eventsHeaderLine singularises a count of one and never says a landing was landed on", () => {
  assert.equal(eventsHeaderLine(1), "1 event recorded inside a cable landing's own search radius in this window:");
  assert.match(eventsHeaderLine(2), /^2 events recorded inside/);
});

test("eventLine reports the event's own type and place with no bridge word", () => {
  assert.equal(eventLine({ event_type: "violence", country: "Egypt" }), "violence recorded in Egypt");
});

test("eventLine falls back to neutral wording for a missing type or place", () => {
  assert.equal(eventLine({}), "event recorded in an unspecified location");
  assert.equal(eventLine(undefined), "event recorded in an unspecified location");
});

// --- landingAttributionNote --------------------------------------------
//
// Task 38 review (Important 1): a snapped landing has to be distinguishable
// from a genuinely contained one *at the landing itself*, not only via the
// aggregate landings_snapped count landingCoverageLine already reports.

test("landingAttributionNote is empty for a directly contained landing", () => {
  assert.equal(landingAttributionNote({ attribution: "contained" }), "");
  assert.equal(landingAttributionNote({}), "");
  assert.equal(landingAttributionNote(null), "");
});

test("landingAttributionNote reports the snap distance when the backend supplied one", () => {
  const text = landingAttributionNote({ attribution: "snapped", snap_distance_km: 4.2 });
  assert.match(text, /~4\.2km/);
  assert.match(text, /outside the border/);
});

test("landingAttributionNote degrades gracefully with no distance figure", () => {
  const text = landingAttributionNote({ attribution: "snapped" });
  assert.equal(text, " -- attributed by nearest coastline, outside the border");
});

// --- statusSummaryLine / eventSearchLine / landingCoverageLine -------------

test("statusSummaryLine reports every one of the five status counts", () => {
  const doc = {
    countries_with_landings: 10,
    status_counts: { spike: 1, no_spike: 4, insufficient_history: 3, never_observed: 1, not_checkable: 1 },
  };
  const text = statusSummaryLine(doc);
  assert.match(text, /^10 countries with a recorded cable landing checked this pass/);
  for (const label of Object.values(STATUS_LABEL)) assert.ok(text.includes(label), `missing "${label}" in "${text}"`);
});

test("eventSearchLine reports the searched vs without-radius split", () => {
  const text = eventSearchLine({ event_window_hours: 24, events_searched: 12, events_without_radius: 3 });
  assert.match(text, /Last 24h: 12 fused events had a stated uncertainty radius/);
  assert.match(text, /3 had none and could not be/);
});

test("landingCoverageLine reports matched, snapped, unmatched, unattributed and planned-excluded counts", () => {
  const doc = {
    landing_stats: {
      landings_total: 100, landings_matched: 90, landings_snapped: 30, landings_unmatched: 5,
      landings_unattributed: 4, landings_planned_excluded: 1,
    },
  };
  const text = landingCoverageLine(doc);
  assert.match(text, /90 of 100 cable landings/);
  assert.match(text, /30 needed the snap/);
  assert.match(text, /5 could not be placed in any country at all/);
  assert.match(text, /4 of the matched landings sit/);
  assert.match(text, /1 are planned landings excluded/);
});

test("landingCoverageLine no longer claims attribution is by name", () => {
  // Task 38 review (Important 2): attribution moved from a name join to a
  // geometric one -- the copy must not still claim the old mechanism.
  const text = landingCoverageLine({ landing_stats: {} });
  assert.ok(!text.toLowerCase().includes("by name"));
});

// --- language: nothing this panel composes attributes a fault to anything --
//
// Task 38 review (Important 1): the brief's own five words are the easy
// ones. The realistic regression is a softer bridge word implying a link
// between the outage and an event without ever saying "caused" -- the same
// widened list backend/tests/test_cable_outage.py now checks NOTE against,
// kept in step here by hand since the two run in different languages.
const _BANNED_PHRASES = [
  "caused by", "was caused", "has caused",
  "attack", "attacking", "attacked",
  "sabotage", "sabotaged", "sabotaging",
  "targeted", "targeting", "target of",
  "responsible for",
  "to blame", "blamed on",
  "retaliat",
  "culprit",
  "linked to", "a link between", "in the wake of", "prompted by", "triggered by",
  "in response to", "tied to", "resulted in", "resulting in", "led to",
  "due to", "because of", "amid", "following", "coincides with", "suspected",
];

function assertClean(text, label) {
  const lowered = String(text).toLowerCase();
  for (const phrase of _BANNED_PHRASES) {
    assert.ok(!lowered.includes(phrase), `banned phrase "${phrase}" found in ${label}: "${text}"`);
  }
}

test("no banned causal phrase appears in any status label", () => {
  for (const [key, label] of Object.entries(STATUS_LABEL)) assertClean(label, `STATUS_LABEL.${key}`);
});

test("no banned causal phrase appears in emptyStateText, across every branch", () => {
  assertClean(emptyStateText({ countries_with_landings: 0 }), "emptyStateText(no countries)");
  assertClean(emptyStateText({ countries_with_landings: 5, status_counts: { spike: 0 } }), "emptyStateText(quiet)");
  assertClean(emptyStateText({ countries_with_landings: 5, status_counts: { spike: 2 } }), "emptyStateText(spiking, no coincidence)");
});

test("no banned causal phrase appears in scoreLine, landingsHeaderLine, eventsHeaderLine, eventLine or landingAttributionNote", () => {
  assertClean(scoreLine({ current_score: 5_000_000, baseline_score: 1_000_000, ratio: 5.0 }), "scoreLine");
  assertClean(landingsHeaderLine(3), "landingsHeaderLine");
  assertClean(eventsHeaderLine(3), "eventsHeaderLine");
  assertClean(eventLine({ event_type: "violence", country: "Egypt" }), "eventLine");
  assertClean(landingAttributionNote({ attribution: "snapped", snap_distance_km: 4.2 }), "landingAttributionNote");
});

test("no banned causal phrase appears in statusSummaryLine, eventSearchLine or landingCoverageLine", () => {
  assertClean(statusSummaryLine({
    countries_with_landings: 10,
    status_counts: { spike: 1, no_spike: 4, insufficient_history: 3, never_observed: 1, not_checkable: 1 },
  }), "statusSummaryLine");
  assertClean(eventSearchLine({ event_window_hours: 24, events_searched: 12, events_without_radius: 3 }), "eventSearchLine");
  assertClean(landingCoverageLine({
    landing_stats: {
      landings_total: 100, landings_matched: 90, landings_snapped: 30, landings_unmatched: 5,
      landings_unattributed: 4, landings_planned_excluded: 1,
    },
  }), "landingCoverageLine");
});

test("the banned phrase list actually catches a reintroduced bridge word", () => {
  // A guard on the guard, mirroring the backend suite's identical test: if
  // _BANNED_PHRASES were ever emptied, this is what would stop catching it.
  const poisoned = "The outage score coincides with a nearby event in the wake of the incident.";
  assert.ok(_BANNED_PHRASES.some((phrase) => poisoned.toLowerCase().includes(phrase)));
});
