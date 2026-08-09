// Task 8: six fields the backend has collected all along and the country
// card never showed -- UNHCR's returned_refugees/others_of_concern, the
// admin_level precision caveat on food_security/idps, the energy net_series
// sparkline (buildSparkline generalized rather than duplicated), the
// available_from/interval_minutes coverage line, and the outage
// window_start/window_end formatted in the reader's own terms.
//
// buildSparkline and formatOutageWindow are exported and asserted directly,
// per the task brief. The other four fields have no exported builder of
// their own (buildHumanitarian/buildConnectivity/buildEnergy are internal to
// popups.js), so they're asserted through countryCardSections -- the one
// entry point the card actually uses -- against a minimal raw bag.
//
// map/popups.js pulls in map/decorators.js (Leaflet-backed) at module scope,
// same as waterCard.test.js -- this stubs just enough of `window.L` to
// satisfy that import and teaches the loader to resolve the extensionless
// relative imports the way Vite does. Nothing here touches the DOM.

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

globalThis.window = { L: { geoJSON: () => ({}) } };

const { countryCardSections, buildSparkline, formatOutageWindow } = await import("../src/map/popups.js");

const baseProps = { name: "Testland", iso_a2: "TL", iso_a3: "TST", population: 1_000_000 };

function emptyRaw(overrides = {}) {
  return {
    events: [], gdelt: [], officials: [], conflictStats: {}, escalation: [],
    adsb: [], ais: [], jamming: [], firms: [], infra: [], conflictDistricts: [],
    humanitarian: {}, outages: {}, energyFlows: {}, foodTrade: {},
    ...overrides,
  };
}

test("buildSparkline -- generalized over net_series as well as its fatalities default", async (t) => {
  await t.test("no series, or fewer than two points: nothing to chart", () => {
    assert.equal(buildSparkline(null, { readValue: (p) => p.net }), "");
    assert.equal(buildSparkline([], { readValue: (p) => p.net }), "");
    assert.equal(buildSparkline([{ t: "x", net: 1 }], { readValue: (p) => p.net }), "", "one point is not a chart");
  });

  await t.test("a plain {} options object still gets the fatalities default -- readValue isn't shadowed by Object.prototype", () => {
    // buildSparkline used to name this option `valueOf`, which every plain
    // object inherits from Object.prototype -- `{ valueOf = fallback } = {}`
    // then destructures the built-in instead of ever reaching the default,
    // and calling it throws. This is the regression test for that: an empty
    // options object must still fall through to the fatalities reader.
    const html = buildSparkline([{ fatalities: 1 }, { fatalities: 3 }], {});
    assert.match(html, /peak 3/);
  });

  await t.test("a full day of 15-minute intervals draws every point, not just the newest 12", () => {
    // energy_flows.py's parse_exchange keeps the whole window (up to 96
    // 15-minute intervals over 24h) as net_series -- unlike the fatalities
    // default's 12-month cap, nothing here should be silently dropped.
    const series = Array.from({ length: 96 }, (_, i) => ({ t: `t${i}`, net: i % 5 === 0 ? -1 : 1 }));
    const html = buildSparkline(series, {
      count: Infinity,
      readValue: (p) => p.net,
      headingOf: (recent) => `Net position, ${recent.length} intervals (GW, measured)`,
      captionOf: (recent, max) => `${recent[recent.length - 1].t}: peak ${max}`,
    });
    assert.match(html, /Net position, 96 intervals \(GW, measured\)/);
    assert.match(html, /viewBox="0 0 960 26"/, "96 bars at w=8/gap=2 -- 10px per bar");
    assert.match(html, /t95: peak 1/);
  });

  await t.test("a negative value (import) bars the same height as an equal positive one (export)", () => {
    // net can run either sign -- a bar chart anchored to zero has to use
    // magnitude for height or a -1 GW interval would draw as tall as nothing.
    const html = buildSparkline([{ net: -2 }, { net: 2 }], { readValue: (p) => p.net, count: Infinity, captionOf: () => "" });
    const heights = [...html.matchAll(/height="(\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(heights, ["26", "26"]);
  });

  await t.test("a small-magnitude series (fractional GW) is not floored to a max of 1", () => {
    // The divide-by-zero guard used to be a literal max(..., 1), which is
    // meaningless for a unit where every real value is well under 1 -- it
    // compressed every bar in a normal energy window against that floor
    // instead of scaling them to the series' own true peak. peak here must
    // read back that true peak (0.4), not the old floor.
    const html = buildSparkline([{ net: 0.1 }, { net: 0.4 }], {
      count: Infinity,
      readValue: (p) => p.net,
      captionOf: (recent, max) => `peak ${max}`,
    });
    assert.match(html, /peak 0\.4/);
  });

  await t.test("an all-zero series reads back 'peak 0' -- the divide-by-zero guard must not leak into the label", () => {
    // The zero-guard lives in the bar-height division only (see the
    // `divisor` local in buildSparkline). A country whose last twelve months
    // of ACLED fatalities are genuinely all zero -- an ended conflict is the
    // ordinary case, not an edge case -- must still read "peak 0" through
    // the *default* caption, not a leaked Number.EPSILON in scientific
    // notation. This exercises the default captionOf specifically: every
    // other fatalities test above uses non-zero values.
    const html = buildSparkline([
      { month: 6, year: 2026, fatalities: 0 },
      { month: 7, year: 2026, fatalities: 0 },
    ]);
    assert.match(html, /peak 0(?!\.)/, "an integer 0, not 2.220446049250313e-16 or any other non-zero trace");
    assert.doesNotMatch(html, /e-1[0-9]/i, "no epsilon in exponential notation anywhere in the output");
  });

  await t.test("the fatalities default is unchanged by the generalization", () => {
    const html = buildSparkline([
      { month: 6, year: 2026, fatalities: 12 },
      { month: 7, year: 2026, fatalities: 40 },
    ]);
    assert.match(html, /Fatalities, last 2 months \(HDX\/ACLED\)/);
    assert.match(html, /Jul 2026: 40 killed/);
    assert.match(html, /peak 40/);
  });
});

test("formatOutageWindow -- window_start/window_end in the reader's own terms", async (t) => {
  await t.test("a normal 24h window", () => {
    const end = Date.UTC(2026, 7, 9, 14, 0, 0) / 1000;
    const start = end - 24 * 3600;
    assert.equal(formatOutageWindow(start, end), "last 24 hours, to 14:00 UTC");
  });

  await t.test("singular hour is grammatical", () => {
    const end = Date.UTC(2026, 7, 9, 5, 30, 0) / 1000;
    assert.equal(formatOutageWindow(end - 3600, end), "last 1 hour, to 05:30 UTC");
  });

  await t.test("missing or non-numeric input makes no claim rather than printing 'NaN hours'", () => {
    assert.equal(formatOutageWindow(null, null), "");
    assert.equal(formatOutageWindow(undefined, 100), "");
    assert.equal(formatOutageWindow(100, "not a number"), "");
  });
});

test("countryCardSections -- humanitarian: returned refugees, others of concern, admin-level caveat", async (t) => {
  const raw = emptyRaw({
    humanitarian: {
      TST: {
        displacement: {
          country: "Testland", year: 2025, refugees: 1000, asylum_seekers: 200, idps: 300,
          stateless: null, returned_refugees: 0, others_of_concern: 45,
        },
        food_security: {
          population_in_crisis: 5000, reference_period_start: "2025-06-01",
          reference_period_end: "2025-06-30", admin_level: 2,
        },
        idps: { population: 300, reference_period_start: "2025-05-01", admin_level: 0 },
      },
    },
  });
  const { sections } = countryCardSections(baseProps, raw, null);
  const humanitarian = sections.find((s) => s.id === "humanitarian");
  assert.ok(humanitarian, "the section is present once displacement has content");

  await t.test("a reported zero still shows -- not the same as 'not reported'", () => {
    assert.match(humanitarian.html, /0 returned refugees/);
  });

  await t.test("others_of_concern shows beside the other UNHCR figures", () => {
    assert.match(humanitarian.html, /45 others of concern/);
  });

  await t.test("food_security's admin_level 2 reads as a subnational precision caveat, not a bare integer", () => {
    assert.match(humanitarian.html, /a subnational figure, reported at admin level 2/);
  });

  await t.test("idps' admin_level 0 reads as national, and still carries its own provenance word", () => {
    // Same helper as the level-2 case above; the zero branch must not drop
    // "reported" just because "national" already sounds authoritative.
    assert.match(humanitarian.html, /a national figure, reported at admin level 0/);
  });
});

test("countryCardSections -- connectivity: the outage window in hours-and-UTC-clock terms", async (t) => {
  const windowEnd = Date.UTC(2026, 7, 9, 14, 0, 0) / 1000;
  const windowStart = windowEnd - 24 * 3600;
  const raw = emptyRaw({
    outages: {
      TL: {
        country_code: "TL", country: "Testland", score: 5_000_000,
        signals: { "bgp.value": 1 }, event_count: 3,
        window_start: windowStart, window_end: windowEnd,
      },
    },
  });
  const { sections } = countryCardSections(baseProps, raw, null);
  const connectivity = sections.find((s) => s.id === "connectivity");
  assert.ok(connectivity);
  assert.match(connectivity.html, /last 24 hours, to 14:00 UTC/);
});

test("countryCardSections -- power: coverage line and a provenance-labelled net-flow sparkline per half", async (t) => {
  const raw = emptyRaw({
    energyFlows: {
      TL: {
        country_code: "TL", api_code: "tl",
        physical: {
          net: 0.4, unit: "GW", resolution: "PT15M", interval_minutes: 15,
          available_from: "2026-08-06T00:00:00+00:00", available_until: "2026-08-06T00:30:00+00:00",
          measurement: "measured", counterparts: [],
          net_series: [
            { t: "2026-08-06T00:00:00+00:00", net: 0.1 },
            { t: "2026-08-06T00:15:00+00:00", net: -0.2 },
            { t: "2026-08-06T00:30:00+00:00", net: 0.4 },
          ],
        },
        commercial: {
          net: 0.5, unit: "GW", resolution: "PT60M", interval_minutes: 60,
          available_from: "2026-08-06T00:00:00+00:00", available_until: "2026-08-07T00:00:00+00:00",
          measurement: "reported",
          net_series: [
            { t: "2026-08-06T00:00:00+00:00", net: 0.5 },
            { t: "2026-08-06T01:00:00+00:00", net: 0.5 },
          ],
        },
      },
    },
  });
  const { sections } = countryCardSections(baseProps, raw, null);
  const power = sections.find((s) => s.id === "power");
  assert.ok(power);

  await t.test("the coverage line states the publisher's own reported period and resolution", () => {
    assert.match(power.html, /Coverage reported: from 2026-08-06T00:00:00\+00:00 at 15-minute intervals/);
    assert.match(power.html, /Coverage reported: from 2026-08-06T00:00:00\+00:00 at 60-minute intervals/);
  });

  await t.test("the physical sparkline is labelled measured, not reported", () => {
    assert.match(power.html, /Net position, 3 intervals \(GW, measured\)/);
  });

  await t.test("the commercial sparkline is labelled reported, not measured", () => {
    assert.match(power.html, /Net position, 2 intervals \(GW, reported\)/);
  });

  await t.test("each sparkline's caption carries its own peak and latest value", () => {
    assert.match(power.html, /peak 0\.40 GW/);
    assert.match(power.html, /peak 0\.50 GW/);
  });
});

test("countryCardSections -- power: a half missing net_series draws no sparkline, no crash", async (t) => {
  const raw = emptyRaw({
    energyFlows: {
      TL: {
        country_code: "TL", api_code: "tl",
        physical: {
          net: 0.4, unit: "GW", resolution: "PT15M", interval_minutes: 15,
          available_from: "2026-08-06T00:00:00+00:00", measurement: "measured",
          counterparts: [], net_series: [],
        },
        commercial: null,
      },
    },
  });
  const { sections } = countryCardSections(baseProps, raw, null);
  const power = sections.find((s) => s.id === "power");
  assert.ok(power);
  assert.doesNotMatch(power.html, /Net position/);
  assert.match(power.html, /Coverage reported: from 2026-08-06T00:00:00\+00:00 at 15-minute intervals/);
});
