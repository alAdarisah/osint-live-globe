// Task 44: frontend/src/replay/availability.js -- the per-kind availability
// wording the scrubber shows, and specifically the "refused" state that
// exists only on the frontend side of the wire to name the known asymmetry
// task-44a-report.md flagged (the backend refuses ?kind=events outright
// because its configured 7-day window exceeds the 3-day retention ceiling,
// even though the legacy no-kind bundle still replays events fine). The
// plan's central rule for this task is that a kind with no rows must read
// as "no data", never as "nothing happened" -- these tests check that every
// one of the three backend states, plus this frontend-only fourth and fifth,
// says something distinct and honest.

import test from "node:test";
import assert from "node:assert/strict";

import {
  REPLAY_KINDS, kindLabel, kindStatusBadge, describeKindAvailability,
  describeAvailabilityLoading, describePlaybackDegraded,
} from "../src/replay/availability.js";

test("REPLAY_KINDS matches exactly the five kinds the legacy bundle replays", () => {
  const keys = REPLAY_KINDS.map((k) => k.key).sort();
  assert.deepEqual(keys, ["adsb", "ais", "events", "firms", "gdelt"]);
});

test("every kind has a non-empty, distinct label", () => {
  const labels = REPLAY_KINDS.map((k) => k.label);
  assert.equal(new Set(labels).size, labels.length);
  for (const label of labels) assert.ok(label && label.length > 0);
});

test("kindLabel falls back to the raw key for something REPLAY_KINDS doesn't list", () => {
  assert.equal(kindLabel("ais"), "Ships (AIS)");
  assert.equal(kindLabel("mystery_kind"), "mystery_kind");
});

test("each status has its own short badge word, and unknown/undefined status reads as still checking", () => {
  assert.equal(kindStatusBadge("ok"), "history");
  assert.equal(kindStatusBadge("no_history"), "no data");
  assert.equal(kindStatusBadge("unavailable"), "unavailable");
  assert.equal(kindStatusBadge("refused"), "config limit");
  assert.equal(kindStatusBadge("error"), "check failed");
  assert.equal(kindStatusBadge(undefined), "checking…");
  // Every real status gets a distinct word -- collapsing any two of these
  // would be exactly the "no rows reads the same as nothing happened" bug
  // this task exists to avoid.
  const words = ["ok", "no_history", "unavailable", "refused", "error"].map(kindStatusBadge);
  assert.equal(new Set(words).size, words.length);
});

test("no_history reads as 'no data', explicitly not as 'nothing happened'", () => {
  const sentence = describeKindAvailability("ais", "no_history");
  assert.match(sentence, /no data/i);
  assert.doesNotMatch(sentence, /nothing happened/i);
});

test("unavailable says the database could not be reached -- not the same claim as no_history", () => {
  const sentence = describeKindAvailability("adsb", "unavailable");
  assert.match(sentence, /database could not be reached/i);
  assert.notEqual(sentence, describeKindAvailability("adsb", "no_history"));
});

test("refused names the actual asymmetry: the legacy bundle still serves it, only the per-kind check is refused", () => {
  const sentence = describeKindAvailability("events", "refused");
  assert.match(sentence, /window/i);
  assert.match(sentence, /live map.*still serves it/i);
  // Must not claim the database is down (that's "unavailable"'s claim) or
  // that the kind has no data (that's "no_history"'s claim) -- refused is a
  // config-shape fact, distinct from both.
  assert.doesNotMatch(sentence, /database could not be reached/i);
  assert.doesNotMatch(sentence, /never recorded a row/i);
});

test("error is distinguished from a real backend answer -- the check itself didn't complete", () => {
  const sentence = describeKindAvailability("gdelt", "error");
  assert.match(sentence, /check itself failed/i);
});

test("every REPLAY_KINDS entry produces a distinct sentence per status, and includes its own label", () => {
  for (const { key, label } of REPLAY_KINDS) {
    for (const status of ["ok", "no_history", "unavailable", "refused", "error", undefined]) {
      const sentence = describeKindAvailability(key, status);
      assert.ok(sentence.startsWith(label), `expected "${sentence}" to start with "${label}"`);
    }
  }
});

test("describeAvailabilityLoading is null once nothing is pending", () => {
  assert.equal(describeAvailabilityLoading(0, 5), null);
});

test("describeAvailabilityLoading names how many are left", () => {
  const msg = describeAvailabilityLoading(2, 5);
  assert.match(msg, /2 left/);
  assert.match(msg, /5 kinds/);
});

test("describePlaybackDegraded is null when the current step matches configured", () => {
  assert.equal(describePlaybackDegraded(60, 60), null);
  assert.equal(describePlaybackDegraded(60, 30), null); // finer, not coarser, is never "degraded"
});

test("describePlaybackDegraded names both the configured and the actual step once they diverge", () => {
  const msg = describePlaybackDegraded(60, 120);
  assert.match(msg, /120min/);
  assert.match(msg, /60min/);
});
