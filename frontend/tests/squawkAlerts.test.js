// Task 33: SquawkAlertStrip.jsx is JSX and can't be imported by this headless
// suite (node --test, no build step), so this covers its pure logic sibling,
// squawkAlertsLogic.js -- the same split airfieldPanel.test.js/adsbCard.test.js
// already use. squawkAlertsLogic.js imports map/decorators.js (for
// aircraftFlag, and this file separately imports aircraftEmergencyLine/
// squawkEmergencyMeaning/AIRCRAFT_FLAG_NOTE to check the strip's wording is
// the card's own, not a re-composed sentence), so this stubs window.L the
// same way adsbCard.test.js does.
//
// Four things this pins, matching the brief:
//  - the three reserved codes (7500/7600/7700) all register as alerts, and an
//    ordinary squawk does not;
//  - dismissing an entry hides it;
//  - a squawk change re-alerts a dismissed airframe, and restarts its "since
//    when" clock;
//  - the duration formatter's own buckets.

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
  trackEmergencySquawks, dismissAlert, visibleAlerts, formatSquawkDuration,
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
