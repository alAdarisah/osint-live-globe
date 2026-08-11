// Task 32 item 4: the units/timezone preference -- one formatter every card
// reads through (utils/format.js) rather than each popup hand-rolling its
// own km/mph conversion. Per the task brief: every conversion asserted in
// both directions at a known value, and the timezone formatter asserted
// across a DST boundary.
//
// utils/format.js is plain JS with no Leaflet/DOM import, so this needs none
// of the window.L stubbing the popups.js-adjacent test files carry.

import test from "node:test";
import assert from "node:assert/strict";

import {
  kmToMiles, milesToKm, kmToNm, nmToKm, metersToFeet, feetToMeters,
  formatDistanceKm, formatSpeedKmh, formatAltitudeM, formatClockAt, UNIT_SYSTEMS,
  setUnitsPreference, preferredUnitsSystem, preferredTimezone,
} from "../src/utils/format.js";

test("kmToMiles / milesToKm -- round trip at a known value", async (t) => {
  await t.test("100km is the textbook 62.137... miles", () => {
    assert.ok(Math.abs(kmToMiles(100) - 62.1371) < 0.001);
  });

  await t.test("the inverse recovers the original km", () => {
    assert.ok(Math.abs(milesToKm(kmToMiles(100)) - 100) < 1e-9);
  });

  await t.test("a mile is exactly 1.609344km by definition -- both directions agree with it", () => {
    assert.equal(kmToMiles(1.609344), 1);
    assert.equal(milesToKm(1), 1.609344);
  });

  await t.test("zero and negative values pass straight through the linear conversion", () => {
    assert.equal(kmToMiles(0), 0);
    assert.ok(kmToMiles(-10) < 0);
  });
});

test("kmToNm / nmToKm -- round trip at a known value", async (t) => {
  await t.test("a nautical mile is exactly 1.852km by definition -- both directions agree with it", () => {
    assert.equal(kmToNm(1.852), 1);
    assert.equal(nmToKm(1), 1.852);
  });

  await t.test("100km is 53.99... nautical miles", () => {
    assert.ok(Math.abs(kmToNm(100) - 53.9957) < 0.001);
  });

  await t.test("the inverse recovers the original km", () => {
    assert.ok(Math.abs(nmToKm(kmToNm(100)) - 100) < 1e-9);
  });
});

test("metersToFeet / feetToMeters -- round trip at a known value", async (t) => {
  await t.test("a foot is exactly 0.3048m by definition -- both directions agree with it", () => {
    assert.equal(metersToFeet(0.3048), 1);
    assert.equal(feetToMeters(1), 0.3048);
  });

  await t.test("10000m (a cruising jetliner) is 32808 feet", () => {
    assert.ok(Math.abs(metersToFeet(10000) - 32808.4) < 1);
  });

  await t.test("the inverse recovers the original metres", () => {
    assert.ok(Math.abs(feetToMeters(metersToFeet(10000)) - 10000) < 1e-6);
  });
});

test("formatDistanceKm -- unit-system dispatch at a known value", async (t) => {
  await t.test("metric prints km", () => {
    assert.equal(formatDistanceKm(100, "metric"), "100.0 km");
  });

  await t.test("imperial converts to miles", () => {
    assert.equal(formatDistanceKm(100, "imperial"), "62.1 mi");
  });

  await t.test("nautical converts to nautical miles", () => {
    assert.equal(formatDistanceKm(100, "nautical"), "54.0 nm");
  });

  await t.test("defaults to metric when no system is given", () => {
    assert.equal(formatDistanceKm(50), "50.0 km");
  });

  await t.test("a non-finite input is 'n/a', never NaN or a blank string", () => {
    assert.equal(formatDistanceKm(null, "imperial"), "n/a");
    assert.equal(formatDistanceKm(undefined, "metric"), "n/a");
    assert.equal(formatDistanceKm(NaN, "nautical"), "n/a");
  });
});

test("formatSpeedKmh -- unit-system dispatch at a known value", async (t) => {
  await t.test("metric prints km/h", () => {
    assert.equal(formatSpeedKmh(37, "metric"), "37 km/h");
  });

  await t.test("imperial converts to mph", () => {
    assert.equal(formatSpeedKmh(100, "imperial"), "62 mph");
  });

  await t.test("nautical converts to knots", () => {
    assert.equal(formatSpeedKmh(100, "nautical"), "54 kn");
  });

  await t.test("a non-finite input is 'n/a'", () => {
    assert.equal(formatSpeedKmh(null, "metric"), "n/a");
  });
});

test("formatAltitudeM -- unit-system dispatch at a known value", async (t) => {
  await t.test("metric prints metres", () => {
    assert.equal(formatAltitudeM(10000, "metric"), "10,000 m");
  });

  await t.test("imperial and nautical both print feet -- the one non-metric answer aviation and maritime readers share", () => {
    assert.equal(formatAltitudeM(10000, "imperial"), "32,808 ft");
    assert.equal(formatAltitudeM(10000, "nautical"), "32,808 ft");
  });

  await t.test("a non-finite input is 'n/a'", () => {
    assert.equal(formatAltitudeM(undefined, "metric"), "n/a");
  });
});

test("UNIT_SYSTEMS -- the three the settings merge validates against", () => {
  assert.deepEqual(UNIT_SYSTEMS, ["metric", "imperial", "nautical"]);
});

test("formatClockAt -- the timezone formatter, including across a DST boundary", async (t) => {
  // A moment with a known UTC reading: 2026-08-09 14:00:00 UTC (a summer
  // date, deliberately -- the DST-boundary test below needs winter and
  // summer instants to actually differ).
  const AUG_9_1400_UTC = Date.UTC(2026, 7, 9, 14, 0, 0) / 1000;

  await t.test("utc: the fixed-offset reading, independent of any zone", () => {
    assert.equal(formatClockAt(AUG_9_1400_UTC, "utc"), "2026-08-09 14:00 UTC");
  });

  await t.test("a non-finite timestamp is the empty string, not a crash", () => {
    assert.equal(formatClockAt(null, "utc"), "");
    assert.equal(formatClockAt(undefined, "utc"), "");
    assert.equal(formatClockAt(NaN, "browser"), "");
  });

  await t.test("an explicit IANA zone reads the same instant in that zone's local time and offset", () => {
    // New York is UTC-4 in August (Eastern Daylight Time).
    assert.equal(formatClockAt(AUG_9_1400_UTC, "America/New_York"), "2026-08-09 10:00 GMT-4");
  });

  await t.test("an unrecognised zone name falls back to the UTC reading rather than throwing", () => {
    assert.equal(formatClockAt(AUG_9_1400_UTC, "Not/A_Real_Zone"), "2026-08-09 14:00 UTC");
  });

  // --- the DST boundary itself ---------------------------------------------
  //
  // America/New_York moves from EST (UTC-5) to EDT (UTC-4) at 2 a.m. local
  // time on the second Sunday in March -- 2026-03-08 07:00 UTC. Two instants
  // a day either side of it (March 7 and March 9, both 07:00 UTC, comfortably
  // clear of the transition instant itself) must read back with different
  // UTC offsets, which is exactly the case a formatter that only knew a
  // fixed offset -- or that cached one -- would get wrong.
  await t.test("the same wall-clock hour reads a different offset either side of the March DST transition", () => {
    const beforeTransition = Date.UTC(2026, 2, 7, 7, 0, 0) / 1000; // Mar 7 2026, 07:00 UTC -- still EST
    const afterTransition = Date.UTC(2026, 2, 9, 7, 0, 0) / 1000;  // Mar 9 2026, 07:00 UTC -- now EDT
    const before = formatClockAt(beforeTransition, "America/New_York");
    const after = formatClockAt(afterTransition, "America/New_York");
    assert.equal(before, "2026-03-07 02:00 GMT-5");
    assert.equal(after, "2026-03-09 03:00 GMT-4");
    assert.notEqual(
      before.slice(-6), after.slice(-6),
      "the printed UTC offset itself must move across the transition, not just the local hour"
    );
  });

  await t.test("browser: resolves through Intl's own default zone rather than throwing", () => {
    // Cannot assert a specific offset here -- the test runner's own TZ is
    // whatever the environment sets -- so this only proves the "browser"
    // branch resolves to *some* valid zone and produces the same shape
    // formatClockAt always does, rather than silently falling through to UTC.
    const result = formatClockAt(AUG_9_1400_UTC, "browser");
    assert.match(result, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (UTC|GMT[+-]\d+(:\d{2})?)$/);
  });
});

// ---------- setUnitsPreference: the module-level store map/decorators.js's
// call sites read through, so the preference is applied without a settings
// object threaded through every one of them (mirrors map/iconTheme.js's own
// setIconTheme/palette pattern) -----------------------------------------
//
// Run last and cleaned up in a `finally`, since these tests are the only
// ones in this file that mutate the shared module state every other test
// above relies on defaulting to metric/utc.
test("setUnitsPreference / preferredUnitsSystem / preferredTimezone -- the store every decorator call site reads", async (t) => {
  try {
    await t.test("starts at the shipped default", () => {
      assert.equal(preferredUnitsSystem(), "metric");
      assert.equal(preferredTimezone(), "utc");
    });

    await t.test("a valid system/timezone pair is applied", () => {
      setUnitsPreference({ system: "nautical", timezone: "browser" });
      assert.equal(preferredUnitsSystem(), "nautical");
      assert.equal(preferredTimezone(), "browser");
    });

    await t.test("formatters with no explicit system/timezone now read the applied preference", () => {
      // This is the fix for the review finding that item 4 was scaffolding
      // with no call sites: map/decorators.js calls these exact three-
      // argument-omitted forms, and this proves omitting the argument reaches
      // the preference just set above, not a hard-coded "metric".
      assert.equal(formatDistanceKm(1.852), "1.0 nm");
      assert.equal(formatSpeedKmh(1.852), "1 kn");
    });

    await t.test("an invalid system is rejected, leaving the previous one in force", () => {
      setUnitsPreference({ system: "furlongs", timezone: "utc" });
      assert.equal(preferredUnitsSystem(), "nautical", "the bad value did not overwrite the good one");
      assert.equal(preferredTimezone(), "utc", "the valid timezone in the same call still applied");
    });

    await t.test("a missing/malformed argument leaves whatever was already set, rather than resetting", () => {
      setUnitsPreference(undefined);
      assert.equal(preferredUnitsSystem(), "nautical");
      setUnitsPreference({});
      assert.equal(preferredUnitsSystem(), "nautical");
      assert.equal(preferredTimezone(), "utc");
    });
  } finally {
    setUnitsPreference({ system: "metric", timezone: "utc" });
  }
});
