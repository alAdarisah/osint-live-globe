// Task 20a: laneDensityIntensity (frontend/src/map/decorators.js), the
// density-to-intensity mapping the AIS traffic wash feeds leaflet.heat.
//
// The brief's own open question was how to scale an unbounded `sightings`
// count (backend/refine/lane_density.py's own docstring: a hull sitting
// still for a month racks up roughly the hit count a busy strait crossed
// once an hour would) without letting a single loiterer paint its cell at
// the same strength as real, distinct traffic. This file pins the answer:
// a log-scaled, clamped-to-[0,1] curve, monotonic, and never letting a
// merely-large count reach the ceiling only a genuinely saturated cell
// should.
//
// map/decorators.js pulls in map/leafletGlobal.js (reads `window.L` at
// module scope) and map/svgIcons.js's buildDivIcon (calls L.divIcon), so
// this stubs just enough of window.L to satisfy those imports, the same way
// vesselCard.test.js and pinZoom.test.js do. Nothing here touches Leaflet or
// the DOM otherwise -- only the pure function is asserted on.

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

const { laneDensityIntensity, LANE_DENSITY_CAP } = await import("../src/map/decorators.js");

test("laneDensityIntensity: zero sightings is zero intensity", () => {
  assert.equal(laneDensityIntensity(0), 0);
});

test("laneDensityIntensity: negative or non-numeric sightings clamp to zero rather than throw", () => {
  assert.equal(laneDensityIntensity(-5), 0);
  assert.equal(laneDensityIntensity(null), 0);
  assert.equal(laneDensityIntensity(undefined), 0);
  assert.equal(laneDensityIntensity(NaN), 0);
  assert.equal(laneDensityIntensity("not a number"), 0);
});

test("laneDensityIntensity: a cell exactly at the cap reads as fully lit", () => {
  assert.equal(laneDensityIntensity(LANE_DENSITY_CAP), 1);
});

test("laneDensityIntensity: well past the cap still clamps to 1, never overshoots", () => {
  // The loiterer case the brief called out: ~720 hourly passes over 30 days
  // (lane_density.py's own arithmetic) is comfortably past the shipped cap.
  assert.equal(laneDensityIntensity(720), 1);
  assert.equal(laneDensityIntensity(1_000_000), 1);
});

test("laneDensityIntensity: monotonically increasing below the cap", () => {
  const low = laneDensityIntensity(2);
  const mid = laneDensityIntensity(50);
  const high = laneDensityIntensity(300);
  assert.ok(low > 0, "a couple of sightings should register as more than nothing");
  assert.ok(low < mid, `${low} should be less than ${mid}`);
  assert.ok(mid < high, `${mid} should be less than ${high}`);
  assert.ok(high < 1, `${high} should stay under the ceiling before the cap`);
});

test("laneDensityIntensity: the log scale compresses a busy strait and a loiterer toward each other, but never equates them below the cap", () => {
  // A strait genuinely crossed once an hour for a week (168 distinct-feeling
  // hits) versus a hull that sat still and racked up the same raw number --
  // this function cannot tell those two apart (nothing can, from the count
  // alone; that is the whole point of naming the field `sightings` and not
  // `transits`). What it must do is avoid a *linear* read of that number,
  // which would make 168 look 84x "busier" than 2. The log curve narrows
  // that gap sharply without collapsing it to nothing before the cap.
  const rare = laneDensityIntensity(2);
  const busy = laneDensityIntensity(168);
  const linearRatio = 168 / 2;
  const logRatio = busy / rare;
  assert.ok(logRatio < linearRatio, "log scaling must compress the ratio versus a linear read");
  assert.ok(busy > rare, "168 sightings must still read as more than 2");
});

test("laneDensityIntensity: a custom cap changes where the curve saturates", () => {
  assert.equal(laneDensityIntensity(50, 50), 1);
  assert.ok(laneDensityIntensity(50, 500) < 1);
});

test("laneDensityIntensity: a degenerate cap (<=1) never divides by zero or goes negative", () => {
  assert.equal(laneDensityIntensity(10, 1), 1);
  assert.equal(laneDensityIntensity(10, 0), 1);
  assert.equal(laneDensityIntensity(10, -5), 1);
});
