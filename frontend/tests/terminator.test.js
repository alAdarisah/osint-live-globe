// Task 46: day/night terminator and illumination maths, asserted against
// Skyfield-generated reference values rather than anything typed from
// memory -- see the global-constraints note this plan enforces on every
// task: a numeric oracle with no reproducible derivation is worthless, and
// four earlier tasks on this branch shipped a wrong constant that looked
// completely plausible until it was checked against a real source.
//
// Every reference value below was produced by this script, run once with:
//
//   "C:/Users/theis/Desktop/Claude Workspace/OSINT/.venv/Scripts/python.exe" gen_terminator_refs.py
//
// -----------------------------------------------------------------------
// import json
// from skyfield.api import Loader, wgs84
// from skyfield import almanac
//
// load = Loader("<any empty directory>")   # caches de421.bsp on first run
// ts = load.timescale()
// eph = load("de421.bsp")                  # JPL DE421 ephemeris, 1899-2053
// earth, sun = eph["earth"], eph["sun"]
//
// def subsolar_point(t):
//     """Standard subsolar-point definition: apparent geocentric
//     declination (equinox of date) is the latitude; longitude comes from
//     Greenwich Apparent Sidereal Time minus apparent right ascension
//     (the Greenwich hour angle), negated and wrapped to [-180, 180]. This
//     is the spherical/geocentric definition a day-night model uses, not
//     skyfield's own WGS84-ellipsoid subpoint() (which reports geodetic
//     latitude, ~0.003 degree different at these instants)."""
//     apparent = earth.at(t).observe(sun).apparent()
//     ra, dec, _ = apparent.radec(epoch="date")
//     gha = (t.gast * 15.0 - ra._degrees) % 360.0
//     sublon = -gha
//     if sublon <= -180.0: sublon += 360.0
//     if sublon > 180.0: sublon -= 360.0
//     return dec.degrees, sublon
//
// # 1) Subsolar point at an arbitrary, non-special UTC instant.
// t1 = ts.utc(2025, 3, 15, 8, 23, 0)
// print(subsolar_point(t1))
// # -> (-1.9868890158168542, 56.46395016218435)
//
// # 2) Exact equinox/solstice instants for 2025, from skyfield's own event
// #    finder (almanac.seasons), not a remembered calendar date.
// times, kinds = almanac.find_discrete(ts.utc(2025, 1, 1), ts.utc(2026, 1, 1), almanac.seasons(eph))
// # kind 0 = spring_equinox, 1 = summer_solstice, 2 = autumn_equinox, 3 = winter_solstice
// for t, k in zip(times, kinds):
//     print(k, t.utc_iso(), subsolar_point(t))
// # -> 0 2025-03-20T09:01:29Z (-0.0001893647080500273, 46.478480833974004)
// # -> 1 2025-06-21T02:42:16Z (23.43833950855874, 139.8776187261695)
// # -> 2 2025-09-22T18:19:20Z (-5.013249515909311e-05, -96.69949096864346)
// # -> 3 2025-12-21T15:03:05Z (-23.438240053774663, -46.209850505956524)
//
// # 3) Sunrise/sunset, London, 2025-06-21 (near the June solstice, no polar
// #    ambiguity), via skyfield's own almanac.sunrise_sunset.
// london = wgs84.latlon(51.5074, -0.1278)
// f = almanac.sunrise_sunset(eph, london)
// times, is_sunrise = almanac.find_discrete(ts.utc(2025, 6, 20, 12), ts.utc(2025, 6, 22, 12), f)
// for t, s in zip(times, is_sunrise): print(t.utc_iso(), bool(s))
// # -> 2025-06-20T20:21:23Z False (previous day's sunset)
// # -> 2025-06-21T03:43:08Z True  (2025-06-21's sunrise)
// # -> 2025-06-21T20:21:35Z False (2025-06-21's sunset)
// # -> 2025-06-22T03:43:23Z True  (next day's sunrise)
//
// # 4) Polar day: Longyearbyen, Svalbard, 2025-06-21 -- zero sunrise/sunset
// #    events in the window, and altitude sampled every 4h stays positive
// #    throughout (minimum 12.04 degrees at hour 0 UTC).
// longyearbyen = wgs84.latlon(78.2232, 15.6267)
// f2 = almanac.sunrise_sunset(eph, longyearbyen)
// times2, _ = almanac.find_discrete(ts.utc(2025, 6, 20, 12), ts.utc(2025, 6, 22, 12), f2)
// print(len(times2))  # -> 0
//
// # 5) Polar night, same place, six months later: also zero sunrise/sunset
// #    events, and altitude sampled every 4h stays negative throughout
// #    (maximum -12.09 degrees at hour 12 UTC).
// times3, _ = almanac.find_discrete(ts.utc(2025, 12, 20, 12), ts.utc(2025, 12, 22, 12), f2)
// print(len(times3))  # -> 0
// for h in range(0, 24, 4):
//     t = ts.utc(2025, 12, 21, h, 0, 0)
//     topocentric = (earth + longyearbyen).at(t).observe(sun).apparent()
//     alt, _az, _d = topocentric.altaz()
//     print(h, alt.degrees)
// # -> 0 -34.70, 4 -25.74, 8 -14.74, 12 -12.09, 16 -20.14, 20 -31.62
// -----------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

import {
  subsolarPoint, sunElevation, sunriseSunset, elevationCrossings, nightPolygonRings,
  SUNRISE_SUNSET_THRESHOLD_DEG, CIVIL_TWILIGHT_DEG, ASTRONOMICAL_TWILIGHT_DEG,
} from "../src/map/solarMath.js";

// map/popups.js's own imports are extensionless ("./decorators", not
// "./decorators.js"), which Node's ESM loader refuses outright -- Vite
// resolves it at build/dev time, plain `node --test` does not. Same loader
// shim tests/countryCardSections.test.js and tests/countryCard.test.js
// already use for the identical reason: rewrite a bare relative specifier
// to add ".js" before Node tries to resolve it.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
});

// popups.js pulls in map/decorators.js at module scope, which reads
// window.L (Leaflet) -- stubbed just enough to satisfy that import, same as
// the two test files above. Nothing in the sun-section tests below touches
// the DOM or a real map.
globalThis.window = { L: { geoJSON: () => ({}) } };

const { buildSunSectionForPoint } = await import("../src/map/popups.js");

// This module's algorithm is the standard "low precision" solar position
// formula, good to roughly 0.01 degree near the current epoch -- not full
// ephemeris precision. Measured against the Skyfield values above, every
// declination/longitude check below lands within ~0.01 degree, so 0.05 is a
// generous tolerance that still fails hard on a real formula bug (a wrong
// sign or a dropped term is off by whole degrees, not hundredths).
const POSITION_TOLERANCE_DEG = 0.05;
// Sunrise/sunset measured within ~2 seconds of Skyfield's own
// almanac.sunrise_sunset; 90 seconds is generous headroom.
const TIME_TOLERANCE_MS = 90_000;

function assertCloseDeg(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: got ${actual}, expected ${expected} +/- ${tolerance}`
  );
}

function assertCloseTime(actual, expectedIso, message) {
  assert.ok(actual instanceof Date, `${message}: expected a Date, got ${actual}`);
  const delta = Math.abs(actual.getTime() - Date.parse(expectedIso));
  assert.ok(delta <= TIME_TOLERANCE_MS, `${message}: got ${actual.toISOString()}, expected ~${expectedIso} (off by ${delta}ms)`);
}

// --- subsolar point at a known UTC instant, against Skyfield -------------

test("subsolar point at an arbitrary UTC instant matches Skyfield", () => {
  const point = subsolarPoint(new Date("2025-03-15T08:23:00Z"));
  assertCloseDeg(point.lat, -1.9868890158168542, POSITION_TOLERANCE_DEG, "subsolar latitude");
  assertCloseDeg(point.lon, 56.46395016218435, POSITION_TOLERANCE_DEG, "subsolar longitude");
});

test("subsolar latitude at the 2025 equinoxes is within a few hundredths of a degree of zero", () => {
  // Skyfield's own almanac.seasons event times, not a remembered calendar
  // date -- see this file's header script.
  assertCloseDeg(
    subsolarPoint(new Date("2025-03-20T09:01:29Z")).lat,
    -0.0001893647080500273,
    POSITION_TOLERANCE_DEG,
    "spring equinox subsolar latitude"
  );
  assertCloseDeg(
    subsolarPoint(new Date("2025-09-22T18:19:20Z")).lat,
    -5.013249515909311e-5,
    POSITION_TOLERANCE_DEG,
    "autumn equinox subsolar latitude"
  );
});

test("subsolar latitude at the 2025 solstices matches Skyfield's declination", () => {
  assertCloseDeg(
    subsolarPoint(new Date("2025-06-21T02:42:16Z")).lat,
    23.43833950855874,
    POSITION_TOLERANCE_DEG,
    "June solstice subsolar latitude"
  );
  assertCloseDeg(
    subsolarPoint(new Date("2025-12-21T15:03:05Z")).lat,
    -23.438240053774663,
    POSITION_TOLERANCE_DEG,
    "December solstice subsolar latitude"
  );
});

// --- the terminator polygon at an equinox and at a solstice --------------
//
// Two independent checks per instant: every point the ring produces is
// internally consistent (sunElevation() at that exact [lat, lon] equals the
// threshold the ring was built for, closing the loop between the closed-form
// solve and the elevation function everything else in this module reads),
// and the ring's own extreme latitude lands where real astronomy says it
// should, given the Skyfield-verified declination for that instant.

test("terminator ring at the spring equinox is self-consistent and nearly pole-to-pole", () => {
  const t = new Date("2025-03-20T09:01:29Z"); // Skyfield's own spring-equinox instant
  const rings = nightPolygonRings(t, 0, 5);
  assert.equal(rings.length, 1, "the plain terminator is one ring spanning the whole globe");

  let maxElevationError = 0;
  let extremeLat = 0;
  for (const [lat, lon] of rings[0]) {
    if (Math.abs(lat) >= 89.99) continue; // the two pole-hugging closing points, not real crossings
    maxElevationError = Math.max(maxElevationError, Math.abs(sunElevation(lat, lon, t) - 0));
    extremeLat = Math.max(extremeLat, Math.abs(lat));
  }
  assert.ok(maxElevationError < 1e-6, `ring points should sit at elevation 0, worst error ${maxElevationError}`);
  // At an equinox the terminator is close to the meridian pair it becomes
  // exactly at declination 0 -- points reach almost to the poles rather than
  // stopping at some intermediate latitude.
  assert.ok(extremeLat > 85, `equinox terminator should run close to the poles, got ${extremeLat}`);
});

test("terminator ring at the June solstice is self-consistent and reaches the polar circle", () => {
  const t = new Date("2025-06-21T02:42:16Z"); // Skyfield's own June-solstice instant
  const declinationDeg = 23.43833950855874; // Skyfield's value, checked above
  const rings = nightPolygonRings(t, 0, 5);
  assert.equal(rings.length, 1);

  let maxElevationError = 0;
  let extremeLat = 0;
  for (const [lat, lon] of rings[0]) {
    if (Math.abs(lat) >= 89.99) continue;
    maxElevationError = Math.max(maxElevationError, Math.abs(sunElevation(lat, lon, t) - 0));
    extremeLat = Math.max(extremeLat, Math.abs(lat));
  }
  assert.ok(maxElevationError < 1e-6, `ring points should sit at elevation 0, worst error ${maxElevationError}`);
  // At a solstice the terminator's extreme latitude is the polar circle,
  // 90 - |declination| -- the boundary of that hemisphere's polar day/night.
  // Derived from the Skyfield-checked declination above, not recalled.
  assertCloseDeg(extremeLat, 90 - declinationDeg, POSITION_TOLERANCE_DEG, "solstice terminator extreme latitude");
});

test("twilight band rings stay self-consistent (civil and astronomical, near solstice)", () => {
  const t = new Date("2025-06-21T02:42:16Z");
  for (const threshold of [CIVIL_TWILIGHT_DEG, ASTRONOMICAL_TWILIGHT_DEG]) {
    const rings = nightPolygonRings(t, threshold, 5);
    assert.ok(rings.length >= 1, `threshold ${threshold} should still produce at least one ring`);
    for (const ring of rings) {
      for (const [lat, lon] of ring) {
        if (Math.abs(lat) >= 89.99) continue;
        const error = Math.abs(sunElevation(lat, lon, t) - threshold);
        assert.ok(error < 1e-6, `threshold ${threshold} ring point off by ${error}`);
      }
    }
  }
});

// --- sunrise/sunset for a known place and date, against Skyfield ---------

test("sunrise and sunset for London on 2025-06-21 match Skyfield", () => {
  const result = sunriseSunset(new Date("2025-06-21T12:00:00Z"), 51.5074, -0.1278);
  assert.equal(result.alwaysAbove, false);
  assert.equal(result.alwaysBelow, false);
  assertCloseTime(result.rise, "2025-06-21T03:43:08Z", "London sunrise");
  assertCloseTime(result.set, "2025-06-21T20:21:35Z", "London sunset");
});

// --- the polar ruling: "no sunrise" must say why, not just come back empty ---

test("polar day at Longyearbyen reports alwaysAbove, not a missing rise/set", () => {
  // Skyfield found zero sunrise/sunset events in this window and every
  // sampled altitude across the day was positive (see this file's header) --
  // the sun genuinely never sets here on this date, and that has to come
  // back as a distinct, positive fact rather than as null rise/set that
  // looks identical to "the computation did not find anything".
  const result = sunriseSunset(new Date("2025-06-21T12:00:00Z"), 78.2232, 15.6267);
  assert.equal(result.rise, null);
  assert.equal(result.set, null);
  assert.equal(result.alwaysAbove, true, "the sun should never dip below the horizon this day");
  assert.equal(result.alwaysBelow, false);
});

test("polar night is distinguishable from polar day, not the same 'always' flag", () => {
  // The same place, six months later: Skyfield found zero sunrise/sunset
  // events again, but every sampled altitude across the day is negative
  // this time (max -12.09 degrees at 12:00 UTC -- see this file's header) --
  // the mirror image of the June case above, and it must report the
  // opposite flag, not the same "no crossing found" answer.
  const result = sunriseSunset(new Date("2025-12-21T12:00:00Z"), 78.2232, 15.6267);
  assert.equal(result.rise, null);
  assert.equal(result.set, null);
  assert.equal(result.alwaysBelow, true, "the sun should stay below the horizon all day in December here");
  assert.equal(result.alwaysAbove, false);
});

// --- current sun elevation: a direct, spot-checkable sanity property -----

test("sun elevation at the subsolar point is ~90 degrees, and its antipode is ~-90", () => {
  const t = new Date("2025-06-21T02:42:16Z");
  const point = subsolarPoint(t);
  assertCloseDeg(sunElevation(point.lat, point.lon, t), 90, 0.1, "elevation directly under the sun");
  const antipodeLon = point.lon > 0 ? point.lon - 180 : point.lon + 180;
  assertCloseDeg(sunElevation(-point.lat, antipodeLon, t), -90, 0.1, "elevation at the antisolar point");
});

test("elevationCrossings agrees with sunriseSunset for the same threshold", () => {
  const t = new Date("2025-06-21T12:00:00Z");
  const viaWrapper = sunriseSunset(t, 51.5074, -0.1278);
  const viaGeneric = elevationCrossings(t, 51.5074, -0.1278, SUNRISE_SUNSET_THRESHOLD_DEG);
  assert.equal(viaWrapper.rise.getTime(), viaGeneric.rise.getTime());
  assert.equal(viaWrapper.set.getTime(), viaGeneric.set.getTime());
});

// --- regression: every ring point is a real, self-consistent latitude, ---
// --- all year round ---------------------------------------------------
//
// nightPolygonRings solves R*sin(lat + phi) = C for lat by picking between
// two supplementary-angle branches (see solveRingLatitude's own docstring
// in solarMath.js) -- and manually driving the running dev server for this
// task caught two bad versions of that solve in a row, neither of which the
// equinox/solstice-only tests above happened to exercise:
//
//   1. Trying only the first branch unconditionally produced a latitude of
//      -118 degrees for a real astronomical-twilight ring on an ordinary
//      mid-August instant -- not a latitude at all.
//   2. The first fix clamped an out-of-range branch back into [-90, 90]
//      instead of recognising "neither branch is in range" as a legitimate
//      "no crossing here" -- which produced a *plausible-looking* wrong
//      ring: 82 points all exactly at -90, when only the two deliberate
//      pole-hugging closing points were supposed to be there.
//
// Both failed the way this map's own rules warn about most: Leaflet does
// not reject an invalid or merely-wrong coordinate with an error, so
// neither bug crashed anything, and a range check alone (`-90 <= lat <=
// 90`) would have passed bug 2 outright -- -90 is a real latitude, just the
// wrong one for 80 of those 82 points. So this checks two independent
// things at every point, over a full year at every threshold rather than
// only the handful of instants the tests above already cover: the latitude
// is in range, AND sunElevation() at that exact [lat, lon] actually equals
// the threshold the ring claims to be for (skipping the two closing points
// nightPolygonRings deliberately places at the pole, which are not
// threshold crossings and are not claimed to be).
test("every point nightPolygonRings ever returns is a real, self-consistent latitude, across a full year", () => {
  const thresholds = [0, CIVIL_TWILIGHT_DEG, -12, ASTRONOMICAL_TWILIGHT_DEG];
  let checked = 0;
  for (let day = 0; day < 365; day += 3) {
    const t = new Date(Date.UTC(2025, 0, 1, 6, 0, 0) + day * 86400000);
    for (const threshold of thresholds) {
      const rings = nightPolygonRings(t, threshold, 10); // coarser step: this is a breadth sweep, not a precision check
      for (const ring of rings) {
        for (const [lat, lon] of ring) {
          checked++;
          assert.ok(
            Number.isFinite(lat) && lat >= -90 && lat <= 90,
            `nightPolygonRings(${t.toISOString()}, ${threshold}) produced an invalid latitude ${lat} at longitude ${lon}`
          );
          assert.ok(Number.isFinite(lon) && lon >= -180 && lon <= 180, `invalid longitude ${lon}`);
          // The two pole-hugging closing points every ring carries (see
          // nightPolygonRings' own docstring) are the only ones deliberately
          // not on the threshold itself -- they sit at exactly +-90, which
          // no real crossing this coarse a longitude step ever lands on
          // exactly. Everything else must be a real crossing, or it is not
          // really tracing the boundary it claims to.
          if (Math.abs(lat) >= 89.999) continue;
          const elevation = sunElevation(lat, lon, t);
          assert.ok(
            Math.abs(elevation - threshold) < 1e-6,
            `nightPolygonRings(${t.toISOString()}, ${threshold}) point [${lat}, ${lon}] has elevation ${elevation}, not ${threshold}`
          );
        }
      }
    }
  }
  // A sanity floor on the sweep itself -- if this ever drops to 0 the loop
  // above stopped exercising anything and the test would pass for the wrong
  // reason (nothing to check, not "everything checked was valid").
  assert.ok(checked > 10_000, `expected a substantial sweep, only checked ${checked} points`);
});

// --- the country/water card's "Sun position" fold: rendered wording, -----
// --- not just the maths behind it -----------------------------------
//
// Review fix: popups.js's buildSunSection branches between polar day, polar
// night and the ordinary sunrise/sunset case, and nothing reached those
// branches as *rendered text* -- solarMath.js's own alwaysAbove/alwaysBelow
// flags were tested above, but a future edit could transpose which flag
// produces which sentence (or swap "does not set" for "does not rise") and
// every test in this file would stay green, because none of them look at
// the string a reader actually sees. These three do, using the same
// Longyearbyen point and instants (mid-June polar day, mid-December polar
// night, both confirmed against Skyfield earlier in this file) plus an
// ordinary mid-latitude case for the normal branch.

test("sun section wording: polar day says the sun does not set, not the polar-night sentence", () => {
  const html = buildSunSectionForPoint(78.2232, 15.6267, new Date("2025-06-21T12:00:00Z"));
  assert.match(html, /does not set today.*polar day/s);
  assert.doesNotMatch(html, /does not rise/);
  assert.doesNotMatch(html, /polar night/);
  assert.doesNotMatch(html, /Sunrise \d/);
});

test("sun section wording: polar night says the sun does not rise, not the polar-day sentence", () => {
  const html = buildSunSectionForPoint(78.2232, 15.6267, new Date("2025-12-21T12:00:00Z"));
  assert.match(html, /does not rise today.*polar night/s);
  assert.doesNotMatch(html, /does not set/);
  assert.doesNotMatch(html, /polar day/);
  assert.doesNotMatch(html, /Sunrise \d/);
});

test("sun section wording: an ordinary mid-latitude day states a real sunrise and sunset, not a polar sentence", () => {
  // London, the same place/date already checked against Skyfield above --
  // sunrise ~03:43 UTC, sunset ~20:21 UTC.
  const html = buildSunSectionForPoint(51.5074, -0.1278, new Date("2025-06-21T12:00:00Z"));
  assert.match(html, /Sunrise \d\d:\d\d UTC, sunset \d\d:\d\d UTC/);
  assert.doesNotMatch(html, /polar day/);
  assert.doesNotMatch(html, /polar night/);
  assert.doesNotMatch(html, /does not set/);
  assert.doesNotMatch(html, /does not rise/);
  // The elevation line and the provenance line are both present too --
  // this fold is three lines, not just the rise/set sentence.
  assert.match(html, /Sun elevation right now/);
  assert.match(html, /Derived: arithmetic/);
});
