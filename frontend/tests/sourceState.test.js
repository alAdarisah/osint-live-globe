// Is a source healthy, judged against its own cadence rather than against one
// number for all of them.
//
// The HUD read "Sources 26/57" on a deployment where a single source was actually
// broken. Two copies of the same predicate -- one in the status strip, one in the
// admin drawer, identical by hand -- compared every source's age against a flat
// 1800 seconds. Only 24 of the 57 poll that fast. The rest run on one-hour to
// seven-day intervals, so each was green for half an hour after a successful fetch
// and red for the remainder of its own correct schedule, and the drawer said
// "railways: failing" about a weekly reference set that had fetched successfully
// three hours earlier with no error at all.

import test from "node:test";
import assert from "node:assert/strict";

import {
  sourceState,
  staleAfter,
  sourceStateLabel,
  sourceLatenessNote,
  SOURCE_OK,
  SOURCE_WARN,
  SOURCE_ERR,
  SOURCE_WAITING,
  SOURCE_STATE_ORDER,
  MIN_STALE_SECONDS,
  STALE_MULTIPLIER,
} from "../src/utils/sourceState.js";

const HOUR = 3600;
const DAY = 24 * HOUR;

test("a weekly source three hours old is fine, and used not to be", () => {
  // The exact case that produced the wrong headline. railways fetches every seven
  // days; three hours later it is not late by any measure that means anything.
  const weekly = { expected_every: 7 * DAY, last_success: 1, seconds_since_success: 3 * HOUR };
  assert.equal(sourceState(weekly), SOURCE_OK);
  // And under the old flat rule it would not have been.
  assert.ok(weekly.seconds_since_success > MIN_STALE_SECONDS);
});

test("a fast source really is late an hour on", () => {
  // The other half: relaxing the rule must not make everything green. gdelt polls
  // every fifteen minutes, so an hour of silence is a genuine problem.
  const fast = { expected_every: 900, last_success: 1, seconds_since_success: HOUR };
  assert.equal(sourceState(fast), SOURCE_ERR);
});

test("a single missed poll is not an outage", () => {
  // Anything faster than the floor gets the floor, so a 10-second source is not
  // called late at 25 seconds. Sources that poll every few seconds would otherwise
  // flicker red on any ordinary hiccup.
  assert.equal(staleAfter({ expected_every: 10 }), MIN_STALE_SECONDS);
  assert.equal(sourceState({ expected_every: 10, last_success: 1, seconds_since_success: 25 }), SOURCE_OK);
});

test("the window is the cadence times the backend's own multiplier", () => {
  // Kept in step with config.INGEST_STALE_MULTIPLIER deliberately: a source the API
  // is about to describe as frozen must not still be green here.
  assert.equal(staleAfter({ expected_every: 6 * HOUR }), 6 * HOUR * STALE_MULTIPLIER);
  assert.equal(STALE_MULTIPLIER, 2.5);
});

test("no cadence known falls back to the flat window rather than to nothing", () => {
  // A source whose cadence has not been measured yet is where every source used to
  // be. The fallback has to be the old behaviour, not an exemption.
  assert.equal(staleAfter({}), MIN_STALE_SECONDS);
  assert.equal(staleAfter({ expected_every: null }), MIN_STALE_SECONDS);
  assert.equal(staleAfter({ expected_every: 0 }), MIN_STALE_SECONDS);
  assert.equal(staleAfter({ expected_every: "6h" }), MIN_STALE_SECONDS);
  assert.equal(sourceState({ last_success: 1, seconds_since_success: 60 }), SOURCE_OK);
});

test("a credential this deployment has not set is amber, not red", () => {
  // Unreachable until backend/mirror.py stopped hardcoding key_configured=true for
  // every mirrored source. marinesia sat red on the live deployment for exactly
  // that reason -- the same colour as a collector that had genuinely broken, when
  // in fact nothing was wrong and nobody had anything to fix.
  const unconfigured = {
    key_configured: false,
    last_success: null,
    last_error: "the ingest service: MARINESIA_API_KEY not set in .env",
  };
  assert.equal(sourceState(unconfigured), SOURCE_WARN);
  assert.match(sourceStateLabel(SOURCE_WARN), /not configured/);
});

test("an error outranks not knowing the cadence", () => {
  // A source carrying an error has been asked and answered badly, whatever else is
  // unknown about it. Treating that as "no report yet" would hide a real outage
  // behind the gentlest of the four states.
  const broken = { key_configured: true, last_success: null, last_error: "timeout" };
  assert.equal(sourceState(broken), SOURCE_ERR);
});

test("never asked is not the same as failed", () => {
  // A first fetch still in flight, and the weather proxy, which has no schedule at
  // all and answers on demand. Both used to render as failures.
  assert.equal(sourceState({ key_configured: true, last_success: null }), SOURCE_WAITING);
  assert.equal(sourceState({}), SOURCE_WAITING);
  assert.equal(sourceState(null), SOURCE_WAITING);
  assert.match(sourceStateLabel(SOURCE_WAITING), /no report yet/);

  // But a source with a *known* cadence that has never reported is overdue by that
  // cadence, and is a failure.
  assert.equal(sourceState({ expected_every: 900, last_success: null }), SOURCE_ERR);
});

test("the four states sort worst first", () => {
  // A strip with room for five dots out of fifty-seven must spend them on the ones
  // worth seeing.
  const sorted = [SOURCE_OK, SOURCE_WAITING, SOURCE_WARN, SOURCE_ERR]
    .sort((a, b) => SOURCE_STATE_ORDER[a] - SOURCE_STATE_ORDER[b]);
  assert.deepEqual(sorted, [SOURCE_ERR, SOURCE_WARN, SOURCE_WAITING, SOURCE_OK]);
});

test("lateness is stated against the source's own interval", () => {
  // The sentence that replaced "failing". A number without its yardstick is what
  // made the old tooltip wrong even when the colour happened to be right.
  const weekly = { expected_every: 7 * DAY, last_success: 1, seconds_since_success: 3 * HOUR };
  assert.match(sourceLatenessNote(weekly), /within its usual/);

  const late = { expected_every: 900, last_success: 1, seconds_since_success: 4 * HOUR };
  assert.match(sourceLatenessNote(late), /usually reports within/);

  // Nothing to compare: no sentence, rather than one built from a missing number.
  assert.equal(sourceLatenessNote({ last_success: null }), null);
  assert.equal(sourceLatenessNote({}), null);
});
