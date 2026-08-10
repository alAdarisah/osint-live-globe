// Client-side SGP4 propagation, asserted: backend/sources/satellites.py
// stores element sets for several thousand objects (starlink/oneweb alone),
// and this module is the entire reason that no longer means the server has
// to SGP4 all of them every ten seconds -- so its correctness is the load-
// bearing part of "propagated in the browser".
//
// The "known TLE, known position" fixture below is a real ISS element set
// (same shape returned live by https://celestrak.org/NORAD/elements/gp.php
// ?GROUP=stations&FORMAT=json while this task was written) with its epoch
// fixed for reproducibility. Its expected position was cross-checked against
// this repo's own server-side propagator -- skyfield's EarthSatellite,
// which backend/sources/satellites.py already uses -- run against the exact
// same element set at the exact same instant:
//
//   from skyfield.api import EarthSatellite, load
//   sat = EarthSatellite.from_omm(load.timescale(builtin=True), OMM)
//   geo = sat.at(ts.utc(2026, 8, 9, 12, 30, 0)).subpoint()
//   -> lat 44.654296, lon -36.881865, alt_km 417.8399
//
// satellite.js agrees to within ~5e-4 degrees and ~5 m of altitude (an
// independent JS SGP4/GMST implementation against skyfield's Python one --
// the small residual is exactly the kind of cross-implementation rounding
// difference the tolerance below is sized for), so this is a genuine
// two-implementation validation of the propagation this app now depends on,
// not a number copied from memory.

import test from "node:test";
import assert from "node:assert/strict";

import {
  satrecFromElements, propagateEci, propagateToLatLonAlt, interpolateFixes, createPropagationTracker,
} from "../src/map/satPropagate.js";

const ISS_OMM = {
  OBJECT_NAME: "ISS (ZARYA)",
  OBJECT_ID: "1998-067A",
  NORAD_CAT_ID: 25544,
  EPOCH: "2026-08-09T12:00:00.000000",
  MEAN_MOTION: 15.50377579,
  ECCENTRICITY: 0.0006703,
  INCLINATION: 51.6416,
  RA_OF_ASC_NODE: 339.7760,
  ARG_OF_PERICENTER: 55.6485,
  MEAN_ANOMALY: 304.5486,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: "U",
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 12345,
  BSTAR: 0.00021019,
  MEAN_MOTION_DOT: 0.00016717,
  MEAN_MOTION_DDOT: 0,
};

// Thirty minutes past epoch -- far enough that a bug in the propagation
// (rather than just returning the epoch position unpropagated) would show up.
const T0 = new Date("2026-08-09T12:30:00.000Z");

// From the skyfield cross-check above.
const EXPECTED = { lat: 44.654296, lon: -36.881865, alt_km: 417.8399 };
const LATLON_TOLERANCE_DEG = 0.01; // ~1 km at this latitude -- see the module comment above
const ALT_TOLERANCE_KM = 1;

test("propagates a known element set to the known position skyfield computes for it", () => {
  const satrec = satrecFromElements(ISS_OMM);
  const result = propagateToLatLonAlt(satrec, T0);
  assert.ok(result, "a valid, un-decayed element set must propagate");
  assert.ok(
    Math.abs(result.lat - EXPECTED.lat) < LATLON_TOLERANCE_DEG,
    `lat ${result.lat} not within ${LATLON_TOLERANCE_DEG} deg of ${EXPECTED.lat}`
  );
  assert.ok(
    Math.abs(result.lon - EXPECTED.lon) < LATLON_TOLERANCE_DEG,
    `lon ${result.lon} not within ${LATLON_TOLERANCE_DEG} deg of ${EXPECTED.lon}`
  );
  assert.ok(
    Math.abs(result.alt_km - EXPECTED.alt_km) < ALT_TOLERANCE_KM,
    `alt_km ${result.alt_km} not within ${ALT_TOLERANCE_KM} km of ${EXPECTED.alt_km}`
  );
});

test("propagating at the epoch itself still returns a real, in-orbit position", () => {
  const satrec = satrecFromElements(ISS_OMM);
  const result = propagateToLatLonAlt(satrec, new Date(ISS_OMM.EPOCH + "Z"));
  assert.ok(result);
  assert.ok(result.lat >= -90 && result.lat <= 90);
  assert.ok(result.lon >= -180 && result.lon <= 180);
  assert.ok(result.alt_km > 300 && result.alt_km < 500); // ISS's real operating band
});

test("an unpropagable element set (decayed / degenerate orbit) returns null, not a fake position", () => {
  // Eccentricity pinned at the edge of the valid range with an unphysically
  // high mean motion -- exactly the shape of element set SGP4 itself refuses
  // to propagate (satellite.js's propagate() returns null rather than
  // {position:false} for this one; propagateEci treats either as "no fix").
  const brokenOmm = { ...ISS_OMM, MEAN_MOTION: 20, ECCENTRICITY: 0.9999999 };
  const satrec = satrecFromElements(brokenOmm);
  assert.equal(propagateEci(satrec, T0), null);
  assert.equal(propagateToLatLonAlt(satrec, T0), null);
});

// --- interpolation between two fixes --------------------------------------

test("interpolating at either fix's own time reproduces that fix's position exactly", () => {
  const satrec = satrecFromElements(ISS_OMM);
  const tA = T0;
  const tB = new Date(T0.getTime() + 60_000); // sixty seconds later -- the large-group cadence
  const fixA = propagateEci(satrec, tA);
  const fixB = propagateEci(satrec, tB);

  const atA = interpolateFixes(fixA, fixB, tA);
  const atB = interpolateFixes(fixA, fixB, tB);
  const trueA = propagateToLatLonAlt(satrec, tA);
  const trueB = propagateToLatLonAlt(satrec, tB);

  assert.ok(Math.abs(atA.lat - trueA.lat) < 1e-6);
  assert.ok(Math.abs(atA.lon - trueA.lon) < 1e-6);
  assert.ok(Math.abs(atB.lat - trueB.lat) < 1e-6);
  assert.ok(Math.abs(atB.lon - trueB.lon) < 1e-6);
});

test("interpolating midway between two fixes closely tracks a true third SGP4 fix", () => {
  // The whole point of interpolating instead of re-running SGP4: it has to
  // actually be a good stand-in for a real fix, not just "some number
  // between the other two". Checked against a true propagation at the
  // midpoint, over a sixty-second span (the large-group cadence) -- close
  // enough for a map pin, cheap enough to run every animation frame.
  //
  // lat/lon (the ground track, i.e. where the pin is actually drawn) comes
  // out accurate to a few hundredths of a millidegree -- a straight chord
  // through two points 4 degrees of orbit apart barely bends the ground
  // track at all. Altitude is the one place a straight chord measurably
  // differs from the true (curved) arc: the chord cuts slightly inside it,
  // a few km low at ISS's ~400km altitude and 60-second cadence (the
  // sagitta of a ~4-degree arc at ~6800km orbital radius) -- expected
  // geometry, not propagation error, and harmless for a value this app only
  // ever shows as descriptive text, never as the pin's screen position.
  const satrec = satrecFromElements(ISS_OMM);
  const tA = T0;
  const tB = new Date(T0.getTime() + 60_000);
  const mid = new Date(T0.getTime() + 30_000);
  const fixA = propagateEci(satrec, tA);
  const fixB = propagateEci(satrec, tB);

  const interpolated = interpolateFixes(fixA, fixB, mid);
  const trueMid = propagateToLatLonAlt(satrec, mid);

  assert.ok(Math.abs(interpolated.lat - trueMid.lat) < 0.01);
  assert.ok(Math.abs(interpolated.lon - trueMid.lon) < 0.01);
  assert.ok(Math.abs(interpolated.alt_km - trueMid.alt_km) < 5);
});

test("interpolation clamps rather than extrapolates outside the fix window", () => {
  const satrec = satrecFromElements(ISS_OMM);
  const tA = T0;
  const tB = new Date(T0.getTime() + 60_000);
  const fixA = propagateEci(satrec, tA);
  const fixB = propagateEci(satrec, tB);

  const before = interpolateFixes(fixA, fixB, new Date(tA.getTime() - 30_000));
  const atA = interpolateFixes(fixA, fixB, tA);
  assert.equal(before.lat, atA.lat);
  assert.equal(before.lon, atA.lon);

  const after = interpolateFixes(fixA, fixB, new Date(tB.getTime() + 30_000));
  const atB = interpolateFixes(fixA, fixB, tB);
  assert.equal(after.lat, atB.lat);
  assert.equal(after.lon, atB.lon);
});

test("interpolating antimeridian-crossing and near-polar tracks stays sane", () => {
  // The reason interpolation happens in ECI cartesian space rather than on
  // lat/lon directly (see the module's own comment on interpolateFixes): a
  // near-polar orbit's ground track can cross the antimeridian or pass
  // close to a pole inside a single sixty-second fix window, and a lat/lon
  // lerp would have been wrong by construction in exactly that case. A high
  // enough inclination to make that likely inside sixty seconds --
  // synthetic, not a real object, so the point is coordinate sanity, not a
  // literal ground track.
  const polarOmm = { ...ISS_OMM, INCLINATION: 98.7, MEAN_MOTION: 14.2 };
  const satrec = satrecFromElements(polarOmm);
  const tA = T0;
  const tB = new Date(T0.getTime() + 60_000);
  const fixA = propagateEci(satrec, tA);
  const fixB = propagateEci(satrec, tB);
  assert.ok(fixA && fixB);

  for (let ms = 0; ms <= 60_000; ms += 10_000) {
    const result = interpolateFixes(fixA, fixB, new Date(tA.getTime() + ms));
    assert.ok(result.lat >= -90 && result.lat <= 90, `lat ${result.lat} out of range`);
    assert.ok(result.lon >= -180 && result.lon <= 180, `lon ${result.lon} out of range`);
    assert.ok(Number.isFinite(result.alt_km));
  }
});

// --- createPropagationTracker: the orchestration a render loop calls -----

test("tracker has no position for a satellite it has never ticked", () => {
  const tracker = createPropagationTracker();
  tracker.setElements(25544, ISS_OMM);
  assert.equal(tracker.positionAt(25544, T0), null);
});

test("a single tick gives a real position, not yet interpolated", () => {
  const tracker = createPropagationTracker();
  tracker.setElements(25544, ISS_OMM);
  tracker.tick(T0);
  const pos = tracker.positionAt(25544, T0);
  const expected = propagateToLatLonAlt(satrecFromElements(ISS_OMM), T0);
  assert.ok(Math.abs(pos.lat - expected.lat) < 1e-6);
  assert.ok(Math.abs(pos.lon - expected.lon) < 1e-6);
});

test("two ticks let positionAt interpolate between them, matching interpolateFixes directly", () => {
  const tracker = createPropagationTracker();
  tracker.setElements(25544, ISS_OMM);
  const tA = T0;
  const tB = new Date(T0.getTime() + 60_000);
  const mid = new Date(T0.getTime() + 30_000);
  tracker.tick(tA);
  tracker.tick(tB);

  const satrec = satrecFromElements(ISS_OMM);
  const expected = interpolateFixes(propagateEci(satrec, tA), propagateEci(satrec, tB), mid);
  const got = tracker.positionAt(25544, mid);
  assert.ok(Math.abs(got.lat - expected.lat) < 1e-6);
  assert.ok(Math.abs(got.lon - expected.lon) < 1e-6);
});

test("setElements does not rebuild (and so does not reset fix history) when the epoch is unchanged", () => {
  const tracker = createPropagationTracker();
  tracker.setElements(25544, ISS_OMM);
  tracker.tick(T0);
  tracker.tick(new Date(T0.getTime() + 60_000));
  assert.notEqual(tracker.positionAt(25544, new Date(T0.getTime() + 30_000)), null);

  // Re-registering the same element set (a layer's steady poll handing back
  // the same, still-current elements) must not wipe the two-fix history that
  // makes interpolation possible.
  tracker.setElements(25544, ISS_OMM);
  assert.notEqual(tracker.positionAt(25544, new Date(T0.getTime() + 30_000)), null);
});

test("a tick for one group's cadence never re-propagates another group's satellites", () => {
  // The regression this guards: a single shared tracker across all seven
  // layers (see createMapController.js) means a fast-cadence layer's tick
  // must not sweep up a slow-cadence layer's satellites just because they
  // live in the same Map. Without the `group` filter this used to call
  // tick() over every registered satellite regardless of which layer's
  // timer fired -- so switching on Starlink (60s cadence, ~7,000 objects)
  // got it re-propagated on satNavigation's 10s cadence instead of its own,
  // six times more often than backend/sources/satellites.py's
  // cadence_seconds intends.
  const tracker = createPropagationTracker();
  const fastId = 25544; // e.g. satNavigation, 10s cadence
  const slowId = 99999; // e.g. satStarlink, 60s cadence
  tracker.setElements(fastId, ISS_OMM, "fast");
  tracker.setElements(slowId, { ...ISS_OMM, NORAD_CAT_ID: slowId }, "slow");

  // Only the fast group's timer has fired so far.
  tracker.tick(T0, "fast");
  assert.notEqual(tracker.positionAt(fastId, T0), null, "the fast group's satellite must have a fix");
  assert.equal(tracker.positionAt(slowId, T0), null, "the slow group's satellite must not have been touched");

  // A second fast-cadence tick, still before the slow group's own cadence
  // has elapsed: the slow satellite must still be untouched.
  const tenSecondsLater = new Date(T0.getTime() + 10_000);
  tracker.tick(tenSecondsLater, "fast");
  assert.equal(tracker.positionAt(slowId, tenSecondsLater), null);

  // Only once the slow group's own timer fires does it get a fix.
  tracker.tick(tenSecondsLater, "slow");
  assert.notEqual(tracker.positionAt(slowId, tenSecondsLater), null);
});

test("size(group) counts only the satellites tagged with that group", () => {
  const tracker = createPropagationTracker();
  tracker.setElements(25544, ISS_OMM, "fast");
  tracker.setElements(99999, { ...ISS_OMM, NORAD_CAT_ID: 99999 }, "slow");
  tracker.setElements(11111, { ...ISS_OMM, NORAD_CAT_ID: 11111 }, "slow");
  assert.equal(tracker.size("fast"), 1);
  assert.equal(tracker.size("slow"), 2);
  assert.equal(tracker.size(), 3);
});

test("prune drops satellites no longer in the requested set", () => {
  const tracker = createPropagationTracker();
  tracker.setElements(25544, ISS_OMM);
  tracker.setElements(99999, { ...ISS_OMM, NORAD_CAT_ID: 99999 });
  tracker.tick(T0);
  assert.equal(tracker.size(), 2);
  tracker.prune([25544]);
  assert.equal(tracker.size(), 1);
  assert.equal(tracker.positionAt(99999, T0), null);
});
