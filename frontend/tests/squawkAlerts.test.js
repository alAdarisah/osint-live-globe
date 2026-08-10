// Task 33: SquawkAlertStrip.jsx is JSX and can't be imported by this headless
// suite (node --test, no build step), so this covers its pure logic sibling,
// squawkAlertsLogic.js -- the same split airfieldPanel.test.js/adsbCard.test.js
// already use. squawkAlertsLogic.js imports map/decorators.js (for
// aircraftFlag, and this file separately imports aircraftEmergencyLine/
// squawkEmergencyMeaning/AIRCRAFT_FLAG_NOTE to check the strip's wording is
// the card's own, not a re-composed sentence), so this stubs window.L the
// same way adsbCard.test.js does.
//
// Five things this pins, matching the brief plus the first review pass:
//  - the three reserved codes (7500/7600/7700) all register as alerts, and an
//    ordinary squawk does not;
//  - dismissing an entry hides it;
//  - a squawk change re-alerts a dismissed airframe, and restarts its "since
//    when" clock;
//  - the duration formatter's own buckets;
//  - (review fix) a dismissed squawk that clears and later returns -- even to
//    the identical code -- re-alerts rather than staying silently suppressed,
//    via pruneDismissed; and squawkAnnouncement's screen-reader sentence
//    always carries the caveat, since a live region cannot be trusted to
//    speak a sibling header a reader may never visit.

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

globalThis.window = {
  L: {
    geoJSON: () => ({}),
    divIcon: (opts) => ({ options: opts }),
  },
};

const {
  trackEmergencySquawks, dismissAlert, pruneDismissed, visibleAlerts, formatSquawkDuration,
  alertLabel, squawkAnnouncement,
} = await import("../src/components/squawkAlertsLogic.js");
const { aircraftEmergencyLine, squawkEmergencyMeaning, AIRCRAFT_FLAG_NOTE } = await import("../src/map/decorators.js");

const T0 = 1_700_000_000_000; // an arbitrary fixed instant, in ms

function aircraft(icao24, overrides = {}) {
  return {
    icao24, lat: 51.5, lon: -0.1, callsign: `TEST${icao24.toUpperCase()}`,
    squawk: null, emergency: null, emergency_squawk: null,
    ...overrides,
  };
}

// --- the three reserved codes ------------------------------------------------

test("7500/7600/7700 each register as a tracked, visible alert", () => {
  const a7500 = aircraft("aaa111", { squawk: "7500", emergency_squawk: "unlawful interference (hijack)" });
  const a7600 = aircraft("bbb222", { squawk: "7600", emergency_squawk: "radio failure" });
  const a7700 = aircraft("ccc333", { squawk: "7700", emergency_squawk: "general emergency" });

  const tracked = trackEmergencySquawks({}, [a7500, a7600, a7700], T0);
  assert.deepEqual(Object.keys(tracked).sort(), ["aaa111", "bbb222", "ccc333"]);

  const visible = visibleAlerts(tracked, {});
  assert.equal(visible.length, 3);

  // The strip's own "squawk meaning" text has to be the aircraft card's
  // exact string, not a second sentence -- see decorators.js's
  // aircraftEmergencyLine, which both decorateAdsb and this strip call.
  for (const entry of visible) {
    const line = aircraftEmergencyLine(entry.aircraft);
    assert.equal(line, aircraftEmergencyLine(entry.aircraft)); // stable/pure
    assert.ok(line.includes(entry.aircraft.squawk));
    assert.equal(squawkEmergencyMeaning(entry.aircraft), entry.aircraft.emergency_squawk);
  }
  assert.match(AIRCRAFT_FLAG_NOTE.emergency, /not a confirmed incident/);
});

test("an ordinary squawk is not an alert", () => {
  const routine = aircraft("ddd444", { squawk: "1200" });
  const tracked = trackEmergencySquawks({}, [routine], T0);
  assert.deepEqual(tracked, {});
});

test("a transponder-reported emergency with no matching squawk code still alerts", () => {
  // backend/sources/adsb.py's `emergency` field (readsb's own decode) is an
  // independent signal from the squawk digits -- see aircraftFlag in
  // decorators.js. A record can carry one without the other.
  const item = aircraft("eee555", { emergency: "minfuel" });
  const tracked = trackEmergencySquawks({}, [item], T0);
  assert.ok(tracked.eee555);
});

// --- dismissal ---------------------------------------------------------------

test("dismissing an entry hides it from visibleAlerts", () => {
  const item = aircraft("fff666", { squawk: "7700", emergency_squawk: "general emergency" });
  const tracked = trackEmergencySquawks({}, [item], T0);
  const entry = tracked.fff666;

  let dismissed = {};
  assert.equal(visibleAlerts(tracked, dismissed).length, 1);

  dismissed = dismissAlert(dismissed, entry.icao24, entry.signature);
  assert.equal(visibleAlerts(tracked, dismissed).length, 0);
});

test("dismissing one airframe does not hide another's alert", () => {
  const a = aircraft("aaa000", { squawk: "7500", emergency_squawk: "unlawful interference (hijack)" });
  const b = aircraft("bbb000", { squawk: "7600", emergency_squawk: "radio failure" });
  const tracked = trackEmergencySquawks({}, [a, b], T0);
  const dismissed = dismissAlert({}, "aaa000", tracked.aaa000.signature);
  const visible = visibleAlerts(tracked, dismissed);
  assert.deepEqual(visible.map((e) => e.icao24), ["bbb000"]);
});

// --- re-alerting after a squawk change ---------------------------------------

test("a squawk change re-alerts a dismissed airframe and restarts its clock", () => {
  const t1 = T0;
  const t2 = T0 + 5 * 60_000; // five minutes later

  let tracked = trackEmergencySquawks({}, [
    aircraft("ggg777", { squawk: "7500", emergency_squawk: "unlawful interference (hijack)" }),
  ], t1);
  let dismissed = dismissAlert({}, "ggg777", tracked.ggg777.signature);
  assert.equal(visibleAlerts(tracked, dismissed).length, 0);

  // Next poll: the same airframe is now squawking 7700 instead.
  tracked = trackEmergencySquawks(tracked, [
    aircraft("ggg777", { squawk: "7700", emergency_squawk: "general emergency" }),
  ], t2);

  const visible = visibleAlerts(tracked, dismissed);
  assert.equal(visible.length, 1, "a changed squawk must re-alert even though the airframe was dismissed");
  assert.equal(visible[0].firstSeenMs, t2, "the \"since when\" clock restarts on a squawk change");
});

test("an unchanged squawk keeps its original firstSeenMs and stays dismissed", () => {
  const t1 = T0;
  const t2 = T0 + 5 * 60_000;

  let tracked = trackEmergencySquawks({}, [
    aircraft("hhh888", { squawk: "7600", emergency_squawk: "radio failure" }),
  ], t1);
  const dismissed = dismissAlert({}, "hhh888", tracked.hhh888.signature);

  // Next poll: still squawking 7600 -- nothing changed.
  tracked = trackEmergencySquawks(tracked, [
    aircraft("hhh888", { squawk: "7600", emergency_squawk: "radio failure" }),
  ], t2);

  assert.equal(tracked.hhh888.firstSeenMs, t1, "an unchanged squawk must not restart the clock");
  assert.equal(visibleAlerts(tracked, dismissed).length, 0, "an unchanged squawk must stay dismissed");
});

test("an airframe dropped from the feed (squawk cleared) is dropped from tracking", () => {
  let tracked = trackEmergencySquawks({}, [
    aircraft("iii999", { squawk: "7700", emergency_squawk: "general emergency" }),
  ], T0);
  assert.ok(tracked.iii999);

  // Next poll: the aircraft is either gone from the feed or has cleared its
  // squawk -- either way it no longer belongs in the tracked set.
  tracked = trackEmergencySquawks(tracked, [], T0 + 60_000);
  assert.deepEqual(tracked, {});
});

// --- review fix: a dismissed squawk that clears and returns re-alerts -------
//
// The bug the first review pass caught: `dismissed` was never pruned when an
// airframe left `tracked`, so X squawks 7500, is dismissed, clears to a
// routine code (or drops out of the feed), and is later set back to 7500 --
// exactly what an accidentally-set 7500 looks like -- and the stale
// dismissal, matching on an identical signature, silently ate the new alert.
// pruneDismissed (called with the fresh `tracked` every time it is
// recomputed -- see SquawkAlertStrip.jsx) is the fix: a dismissal cannot
// outlive the tracking episode it was recorded against.

test("a dismissed squawk that clears and later returns to the identical code re-alerts", () => {
  const t1 = T0;
  const t2 = T0 + 60_000; // one minute later: the airframe clears its squawk
  const t3 = T0 + 5 * 60_000; // five minutes later: it squawks 7500 again

  // Poll 1: X squawks 7500 and the reader dismisses it.
  let tracked = trackEmergencySquawks({}, [
    aircraft("xxx111", { squawk: "7500", emergency_squawk: "unlawful interference (hijack)" }),
  ], t1);
  let dismissed = dismissAlert({}, "xxx111", tracked.xxx111.signature);
  assert.equal(visibleAlerts(tracked, dismissed).length, 0);

  // Poll 2: X clears its squawk (a routine 1200, or simply drops off the
  // feed) -- this is where the strip itself calls pruneDismissed every time
  // `tracked` is recomputed, not only when something is still tracked.
  tracked = trackEmergencySquawks(tracked, [aircraft("xxx111", { squawk: "1200" })], t2);
  assert.equal(tracked.xxx111, undefined, "a routine squawk is no longer tracked");
  dismissed = pruneDismissed(dismissed, tracked);
  assert.deepEqual(dismissed, {}, "the stale dismissal must not survive the episode ending");

  // Poll 3: X squawks 7500 again -- the identical code, which is exactly
  // what an accidentally re-set transponder looks like.
  tracked = trackEmergencySquawks(tracked, [
    aircraft("xxx111", { squawk: "7500", emergency_squawk: "unlawful interference (hijack)" }),
  ], t3);
  dismissed = pruneDismissed(dismissed, tracked);

  const visible = visibleAlerts(tracked, dismissed);
  assert.equal(visible.length, 1, "the return to 7500 must re-alert, not stay silently suppressed");
  assert.equal(visible[0].firstSeenMs, t3);
});

test("pruneDismissed drops only dismissals whose airframe has left tracked", () => {
  const tracked = trackEmergencySquawks({}, [
    aircraft("yyy222", { squawk: "7600", emergency_squawk: "radio failure" }),
  ], T0);
  const dismissed = { yyy222: tracked.yyy222.signature, zzz333: "some-earlier-signature" };

  const pruned = pruneDismissed(dismissed, tracked);
  assert.deepEqual(pruned, { yyy222: tracked.yyy222.signature });
});

test("pruneDismissed tolerates a missing/null tracked or dismissed argument", () => {
  assert.deepEqual(pruneDismissed(null, {}), {});
  assert.deepEqual(pruneDismissed({ a: "x" }, null), {});
  assert.deepEqual(pruneDismissed(undefined, undefined), {});
});

// --- the duration formatter ---------------------------------------------------

test("formatSquawkDuration buckets by minute, then hour, then day", () => {
  assert.equal(formatSquawkDuration(0), "<1m");
  assert.equal(formatSquawkDuration(59), "<1m");
  assert.equal(formatSquawkDuration(60), "1m");
  assert.equal(formatSquawkDuration(90), "1m");
  assert.equal(formatSquawkDuration(3599), "59m");
  assert.equal(formatSquawkDuration(3600), "1h");
  assert.equal(formatSquawkDuration(3660), "1h 1m");
  assert.equal(formatSquawkDuration(7200), "2h");
  assert.equal(formatSquawkDuration(86399), "23h 59m");
  assert.equal(formatSquawkDuration(86400), "1d");
  assert.equal(formatSquawkDuration(90000), "1d 1h");
});

test("formatSquawkDuration never throws on bad input", () => {
  assert.equal(formatSquawkDuration(-5), "just now");
  assert.equal(formatSquawkDuration(NaN), "just now");
  assert.equal(formatSquawkDuration(undefined), "just now");
});

// --- alertLabel ----------------------------------------------------------------

test("alertLabel prefers callsign, then registration, then icao24", () => {
  const withCallsign = trackEmergencySquawks({}, [
    aircraft("lab111", { squawk: "7700", emergency_squawk: "general emergency", callsign: "BAW123", registration: "G-ABCD" }),
  ], T0);
  assert.equal(alertLabel(withCallsign.lab111), "BAW123");

  const noCallsign = trackEmergencySquawks({}, [
    aircraft("lab222", { squawk: "7700", emergency_squawk: "general emergency", callsign: null, registration: "G-EFGH" }),
  ], T0);
  assert.equal(alertLabel(noCallsign.lab222), "G-EFGH");

  const neither = trackEmergencySquawks({}, [
    aircraft("lab333", { squawk: "7700", emergency_squawk: "general emergency", callsign: null, registration: null }),
  ], T0);
  assert.equal(alertLabel(neither.lab333), "lab333");
});

// --- squawkAnnouncement (review fix: Important 2) -------------------------------
//
// The visible strip states AIRCRAFT_FLAG_NOTE.emergency's caveat once, in its
// header -- correct for a sighted reader who sees the header and every row
// together. A live region cannot rely on that: several screen readers
// announce only the node that was actually inserted, so squawkAnnouncement
// builds one self-contained sentence per fresh alert with the caveat folded
// in directly, rather than depending on a sibling node the reader may never
// hear.

test("squawkAnnouncement carries both the squawk meaning and the caveat, in plain text", () => {
  const tracked = trackEmergencySquawks({}, [
    aircraft("ann111", {
      squawk: "7500", emergency_squawk: "unlawful interference (hijack)", callsign: "TESTANN111",
    }),
  ], T0);
  const text = squawkAnnouncement(tracked.ann111);

  assert.match(text, /TESTANN111/);
  assert.match(text, /unlawful interference \(hijack\)/);
  assert.match(text, /not a confirmed incident/, "the caveat must be in the same utterance as the squawk meaning");
  // Plain text for speech, not the markup aircraftEmergencyLine/
  // AIRCRAFT_FLAG_NOTE were built for -- no leftover HTML entities.
  assert.ok(!text.includes("&mdash;"), "HTML entities must be unescaped for a speech announcement");
  assert.ok(text.includes("—") || text.includes("-"), "the em dash should still read as a dash, not vanish");
});

test("squawkAnnouncement is stable and self-contained across all three codes", () => {
  for (const [squawk, meaning] of [
    ["7500", "unlawful interference (hijack)"],
    ["7600", "radio failure"],
    ["7700", "general emergency"],
  ]) {
    const tracked = trackEmergencySquawks({}, [
      aircraft(`code${squawk}`, { squawk, emergency_squawk: meaning }),
    ], T0);
    const entry = tracked[`code${squawk}`];
    const text = squawkAnnouncement(entry);
    assert.match(text, new RegExp(meaning.replace(/[()]/g, "\\$&")));
    assert.match(text, /not a confirmed incident/);
  }
});
