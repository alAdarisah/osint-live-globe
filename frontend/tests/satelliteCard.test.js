// Task 25: the satellite card's epoch-age honesty (never shown before this
// task, and the brief is explicit that it matters), and the overpass
// popup satellitePassesCardHtml builds from GET /api/satellites/passes.
//
// map/decorators.js pulls in map/leafletGlobal.js (reads `window.L` at
// module scope) and map/svgIcons.js's buildDivIcon (calls L.divIcon), so
// this stubs just enough of window.L to satisfy those imports, the same
// way vesselCard.test.js/adsbCard.test.js do.

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

const { decorateSatellite, decorateSatElement, epochAgeHours, epochAgeLabel, satellitePassesCardHtml } =
  await import("../src/map/decorators.js");

// --- epochAgeHours -----------------------------------------------------------

test("epoch age in hours, against a fixed now", () => {
  const now = Date.parse("2026-08-10T12:00:00Z");
  assert.equal(epochAgeHours("2026-08-10T09:00:00.000000", now), 3);
  assert.equal(epochAgeHours("2026-08-08T12:00:00.000000", now), 48);
});

test("a missing or unparsable epoch is null, not NaN or a thrown error", () => {
  assert.equal(epochAgeHours(null), null);
  assert.equal(epochAgeHours(undefined), null);
  assert.equal(epochAgeHours(""), null);
  assert.equal(epochAgeHours("not a date"), null);
});

test("a CelesTrak epoch with no trailing Z is still read as UTC, not local time", () => {
  const now = Date.parse("2026-08-10T12:00:00Z");
  // CelesTrak's own EPOCH field carries no offset at all -- if this were
  // parsed as local time instead of UTC, the answer would silently depend
  // on the machine running the test.
  assert.equal(epochAgeHours("2026-08-10T09:00:00.000000", now), 3);
});

// --- epochAgeLabel ------------------------------------------------------------

test("under an hour reads in minutes", () => {
  assert.equal(epochAgeLabel(0.5), "30 min old");
});

test("under two days reads in hours, with no caveat below the aging threshold", () => {
  const label = epochAgeLabel(5);
  assert.match(label, /^5\.0 h old$/);
});

test("a day or more old is called out as aging", () => {
  assert.match(epochAgeLabel(30), /aging/);
});

test("a week or more old is called out as stale, with the overpass caveat named explicitly", () => {
  const label = epochAgeLabel(24 * 8);
  assert.match(label, /stale/);
  assert.match(label, /overpass prediction/);
});

test("an unknown age says so rather than printing NaN", () => {
  assert.equal(epochAgeLabel(null), "element set age unknown");
  assert.equal(epochAgeLabel(NaN), "element set age unknown");
});

// --- the card shows the epoch age it never used to (the brief's own point) ---

test("decorateSatellite's card states the element set epoch and its age", () => {
  const now = Date.now();
  const freshEpoch = new Date(now - 2 * 3_600_000).toISOString().replace("Z", "");
  const d = decorateSatellite({
    norad_id: 25544, name: "ISS (ZARYA)", group: "stations", alt_km: 420, velocity_km_s: 7.66,
    intl_designator: "1998-067A", launch_year: 1998, inclination_deg: 51.6, period_min: 92.7,
    apogee_km: 424, perigee_km: 414, epoch: freshEpoch,
  });
  assert.match(d.detail, /Element set epoch/);
  assert.match(d.detail, /2\.0 h old/);
  assert.match(d.detail, /Velocity: 7\.66 km\/s/);
  assert.match(d.detail, /International designator: 1998-067A/);
  assert.match(d.detail, /Visibility footprint/);
  // stations/military carry no client-side orbital elements -- see
  // decorateSatellite's own note -- so the card says the ground track is
  // not available here, rather than silently omitting any mention of it.
  assert.match(d.detail, /ground track cannot be drawn client-side/);
});

test("decorateSatElement's card states a ground track is drawn while the card is open, when available", () => {
  const item = {
    norad_id: 44714, name: "TestSat", lat: 1, lon: 2, alt_km: 550,
    epoch: new Date(Date.now() - 30 * 3_600_000).toISOString().replace("Z", ""),
  };
  const withTrack = decorateSatElement(item, "satImaging", { groundTrackAvailable: true, velocityKmS: 7.5 });
  assert.match(withTrack.detail, /Ground track \(previous\/next 90 min\) drawn/);
  assert.match(withTrack.detail, /aging/); // 30h old

  const withoutTrack = decorateSatElement(item, "satImaging", { groundTrackAvailable: false });
  assert.doesNotMatch(withoutTrack.detail, /Ground track \(previous\/next 90 min\) drawn/);
});

// --- satellitePassesCardHtml ---------------------------------------------------

test("loading state says so, with the place name in the header", () => {
  const html = satellitePassesCardHtml({ status: "loading" }, "France");
  assert.match(html, /Checking/);
  assert.match(html, /France/);
});

test("a fetch failure says the service could not be reached, not nothing", () => {
  const html = satellitePassesCardHtml({ status: "error" }, "France");
  assert.match(html, /Could not reach/);
});

test("no passes states the search window and elevation floor, plus coverage", () => {
  const html = satellitePassesCardHtml(
    {
      status: "ready",
      data: {
        passes: [], min_elevation_deg: 10, hours: 24,
        satellites_total: 40, satellites_reachable: 12, satellites_considered: 12, satellites_capped: false,
      },
    },
    "the Baltic Sea"
  );
  assert.match(html, /No passes above 10.{0,10}elevation in the next 24 hours/);
  assert.match(html, /Checked all 12/);
  assert.doesNotMatch(html, /capped/);
});

test("a capped search says so and states both counts", () => {
  const html = satellitePassesCardHtml(
    {
      status: "ready",
      data: {
        passes: [], min_elevation_deg: 10, hours: 24,
        satellites_total: 900, satellites_reachable: 500, satellites_considered: 200, satellites_capped: true,
      },
    },
    null
  );
  assert.match(html, /Checked the closest 200 of 500/);
  assert.match(html, /this location/); // no label given
});

test("a real pass lists the satellite, timing, elevation, duration and its own element-set age", () => {
  const html = satellitePassesCardHtml(
    {
      status: "ready",
      data: {
        passes: [
          {
            norad_id: 25544, name: "ISS (ZARYA)",
            rise: new Date(Date.now() + 10 * 60_000).toISOString(),
            culminate: new Date(Date.now() + 12 * 60_000).toISOString(),
            set: new Date(Date.now() + 14 * 60_000).toISOString(),
            max_elevation_deg: 42.5, duration_s: 240,
            epoch: new Date(Date.now() - 3 * 3_600_000).toISOString().replace("Z", ""),
          },
        ],
        min_elevation_deg: 10, hours: 24,
        satellites_total: 40, satellites_reachable: 12, satellites_considered: 12, satellites_capped: false,
        passes_truncated: false,
      },
    },
    "France"
  );
  assert.match(html, /ISS \(ZARYA\)/);
  assert.match(html, /in 10 min/);
  assert.match(html, /up to 4[23]&deg;/); // rounds to 42 or 43
  assert.match(html, /240s/);
  assert.match(html, /element set 3\.0 h old/);
  assert.match(html, /Derived/);
});

test("a truncated pass list says more were found beyond what is shown", () => {
  const html = satellitePassesCardHtml(
    {
      status: "ready",
      data: {
        passes: [
          {
            norad_id: 1, name: "A", rise: new Date().toISOString(), culminate: new Date().toISOString(),
            set: new Date().toISOString(), max_elevation_deg: 20, duration_s: 100, epoch: null,
          },
        ],
        min_elevation_deg: 10, hours: 24, satellites_total: 1, satellites_reachable: 1,
        satellites_considered: 1, satellites_capped: false, passes_truncated: true,
      },
    },
    "France"
  );
  assert.match(html, /More passes were found/);
});
