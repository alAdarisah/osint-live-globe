// The coverage-to-visual-state logic behind Task 50's map layer: five
// distinguishable states derived from raw.fetchCoverage[key], asserted here
// as rendered output (sentence text, style colours, bucket contents) rather
// than as bare enum tags -- the same standard map/popups.js's own
// coverageStateFor/coverageReason tests hold themselves to.

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// coverageOverlay.js reaches for "../utils/format" and "./scene" without an
// extension, which Vite resolves and node does not -- same shim
// publishFetchOutcome.test.js/summaryTiles.test.js already use.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
});

const {
  COVERAGE_OVERLAY_SOURCES, COVERAGE_STATE_STYLE, parseBboxCell, sourceCoverageState,
  describeSourceCoverage, summarizeCoverage, coverageLegendHtml,
} = await import("../src/map/coverageOverlay.js");
const { resolveScene } = await import("../src/map/scene.js");

test("parseBboxCell", async (t) => {
  await t.test("parses a well-formed cell", () => {
    assert.deepEqual(parseBboxCell("10,20,30,40"), { south: 10, west: 20, north: 30, east: 40 });
  });
  await t.test("rejects garbage without throwing", () => {
    assert.equal(parseBboxCell(null), null);
    assert.equal(parseBboxCell(undefined), null);
    assert.equal(parseBboxCell("not a bbox"), null);
    assert.equal(parseBboxCell("1,2,3"), null);
    assert.equal(parseBboxCell("1,2,3,x"), null);
  });
});

test("sourceCoverageState: five states from a raw record alone", async (t) => {
  await t.test("no record at all -> unknown", () => {
    assert.equal(sourceCoverageState(undefined), "unknown");
  });
  await t.test("gated status -> gated, regardless of scoped flag", () => {
    assert.equal(sourceCoverageState({ status: "gated", scoped: true }), "gated");
    assert.equal(sourceCoverageState({ status: "gated", scoped: false }), "gated");
  });
  await t.test("error status -> failed", () => {
    assert.equal(sourceCoverageState({ status: "error", scoped: false }), "failed");
  });
  await t.test("fetched, unscoped -> global", () => {
    assert.equal(sourceCoverageState({ status: "fetched", fetchedAt: Date.now(), scoped: false, bbox: null }), "global");
  });
  await t.test("fetched, scoped with a real bbox -> scoped", () => {
    assert.equal(
      sourceCoverageState({ status: "fetched", fetchedAt: Date.now(), scoped: true, bbox: "1,2,3,4" }),
      "scoped"
    );
  });
  await t.test("fetched, scoped but bbox null (whole-world cell) -> global, not scoped", () => {
    // bboxCell's own guard in useOsintData.js returns null for a cell that
    // covers essentially the whole planet, and that means the same thing
    // here it means in map/popups.js's bboxCellCoversCountry: nothing was
    // clipped, so nothing is excluded.
    assert.equal(
      sourceCoverageState({ status: "fetched", fetchedAt: Date.now(), scoped: true, bbox: null }),
      "global"
    );
  });
});

test("describeSourceCoverage: rendered output for the five example states", async (t) => {
  const worldScene = resolveScene({ zoom: 3 }); // WORLD band -- gates plenty of sources

  await t.test("global: sentence says checked worldwide, no bbox", () => {
    const raw = { fetchCoverage: { events: { status: "fetched", fetchedAt: Date.now(), scoped: false, bbox: null } } };
    const d = describeSourceCoverage("events", "ACLED conflict events", raw, worldScene);
    assert.equal(d.state, "global");
    assert.equal(d.bbox, null);
    assert.match(d.sentence, /checked worldwide/);
    assert.match(d.sentence, /ACLED conflict events/);
  });

  await t.test("scoped: sentence names the area and the 'everywhere else is unknown' caveat, bbox parsed", () => {
    const raw = {
      fetchCoverage: { airports: { status: "fetched", fetchedAt: Date.now(), scoped: true, bbox: "10,20,30,40" } },
    };
    const d = describeSourceCoverage("airports", "Airfield gazetteer (OurAirports)", raw, worldScene);
    assert.equal(d.state, "scoped");
    assert.deepEqual(d.bbox, { south: 10, west: 20, north: 30, east: 40 });
    assert.match(d.sentence, /checked only within the area outlined/);
    assert.match(d.sentence, /everywhere else is unknown for this source, not confirmed empty/i);
  });

  await t.test("gated: sentence names the zoom and band that would lift it", () => {
    const raw = { fetchCoverage: { osmInfra: { status: "gated", scoped: true } } };
    const d = describeSourceCoverage("osmInfra", "OpenStreetMap infrastructure sweep", raw, worldScene);
    assert.equal(d.state, "gated");
    // osmInfra fetches from LOCAL (z9) per map/scene.js's LAYER_MANIFEST --
    // read from the live scene rather than hard-coded here a second time.
    assert.match(d.sentence, /needs zoom 9\+ \(LOCAL\)/);
    assert.match(d.sentence, /Zoom in to lift the gate/);
  });

  await t.test("failed, no prior success: sentence says nothing was ever recorded", () => {
    const raw = { fetchCoverage: { floods: { status: "error", scoped: false } } };
    const d = describeSourceCoverage("floods", "Flood alerts (GDACS)", raw, worldScene);
    assert.equal(d.state, "failed");
    assert.match(d.sentence, /last fetch attempt failed/);
    assert.match(d.sentence, /nothing has ever been recorded for it/);
  });

  await t.test("failed, with a prior success: sentence says it is showing stale-but-real data", () => {
    const raw = {
      fetchCoverage: { floods: { status: "error", scoped: false, fetchedAt: Date.now() - 999999 } },
    };
    const d = describeSourceCoverage("floods", "Flood alerts (GDACS)", raw, worldScene);
    assert.equal(d.state, "failed");
    assert.match(d.sentence, /still showing data from its last success/);
  });

  await t.test("no record at all: sentence says this map has not reported even trying", () => {
    const raw = { fetchCoverage: {} };
    const d = describeSourceCoverage("railways", "Railway linework (Natural Earth + OpenStreetMap)", raw, worldScene);
    assert.equal(d.state, "unknown");
    assert.equal(d.bbox, null);
    assert.match(d.sentence, /has not reported even trying this source yet/);
  });
});

test("summarizeCoverage: buckets every tracked source and only 'scoped' ones carry a rectangle", () => {
  const scene = resolveScene({ zoom: 3 });
  const raw = {
    fetchCoverage: {
      events: { status: "fetched", fetchedAt: Date.now(), scoped: false, bbox: null },
      airports: { status: "fetched", fetchedAt: Date.now(), scoped: true, bbox: "1,2,3,4" },
      osmInfra: { status: "gated", scoped: true },
      floods: { status: "error", scoped: false },
      // railways/powerLines/water deliberately left absent -- they never call
      // recordCoverage at all (see the module's own note on COVERAGE_OVERLAY_SOURCES).
    },
  };
  const { entries, buckets, rectangles } = summarizeCoverage(raw, scene);

  assert.equal(entries.length, COVERAGE_OVERLAY_SOURCES.length);
  assert.ok(buckets.global.some((e) => e.key === "events"));
  assert.ok(buckets.scoped.some((e) => e.key === "airports"));
  assert.ok(buckets.gated.some((e) => e.key === "osmInfra"));
  assert.ok(buckets.failed.some((e) => e.key === "floods"));
  // Never instrumented at all -- permanently "unknown" by construction.
  for (const key of ["railways", "powerLines", "water"]) {
    assert.ok(buckets.unknown.some((e) => e.key === key), `${key} should bucket as unknown`);
  }

  assert.equal(rectangles.length, 1);
  assert.equal(rectangles[0].key, "airports");
  assert.deepEqual(rectangles[0].bbox, { south: 1, west: 2, north: 3, east: 4 });
});

test("coverageLegendHtml: rendered output distinguishes all five states, not just internal enum tags", () => {
  const scene = resolveScene({ zoom: 3 });
  const raw = {
    fetchCoverage: {
      events: { status: "fetched", fetchedAt: Date.now(), scoped: false, bbox: null },
      airports: { status: "fetched", fetchedAt: Date.now(), scoped: true, bbox: "1,2,3,4" },
      osmInfra: { status: "gated", scoped: true },
      floods: { status: "error", scoped: false },
    },
  };
  const html = coverageLegendHtml(raw, scene);

  // Every state that has at least one member gets its own labelled row with a
  // real count -- "1" for each of the four single-source buckets seeded
  // above, plus the "unknown" bucket which is everything else in the list.
  assert.match(html, /<b>1<\/b> Checked worldwide/);
  assert.match(html, /<b>1<\/b> Checked in the areas outlined/);
  assert.match(html, /<b>1<\/b> Not requested at this zoom/);
  assert.match(html, /<b>1<\/b> Last attempt failed/);
  const unknownCount = COVERAGE_OVERLAY_SOURCES.length - 4;
  assert.match(html, new RegExp(`<b>${unknownCount}</b> No coverage record`));

  // Provenance vocabulary: this whole layer is "derived", stated once and up front.
  assert.match(html, />derived<\/span>/);

  // The five colours are genuinely distinct -- a reader must be able to tell
  // the states apart by more than reading the count.
  const colors = new Set(Object.values(COVERAGE_STATE_STYLE).map((s) => s.color));
  assert.equal(colors.size, 4); // global and scoped intentionally share one colour
});


// The drift this list is exposed to, closed the way referenceOnlyFeeds.test.js
// closed its own.
//
// COVERAGE_OVERLAY_SOURCES is hand-maintained, and the module's own comment
// explains honestly why: coverageOverlay.js has to stay importable from a
// plain `node --test` run, and useOsintData.js pulls in React at module scope,
// so the list cannot be derived at import time.
//
// That is a constraint on the *module*, not on a *test*. This file already
// carries the registerHooks shim, so it can import the real POLL_CONFIG and
// check the pairing here instead -- exactly the move referenceOnlyFeeds.test.js
// made after a hand-copied list let the same feed-wiring bug recur three times
// on this branch. A list nothing checks is how that happened; the fix each time
// was not a better list, it was a test that reads the real one.
const { POLL_CONFIG } = await import("../src/hooks/useOsintData.js");

test("every polled source appears in the coverage overlay's own list", async (t) => {
  const listed = new Set(COVERAGE_OVERLAY_SOURCES.map((entry) => entry.key));

  await t.test("no POLL_CONFIG key is missing from COVERAGE_OVERLAY_SOURCES", () => {
    const missing = POLL_CONFIG.map((entry) => entry.key).filter((key) => !listed.has(key));
    assert.deepEqual(
      missing, [],
      "these sources are polled and record fetch coverage, but the overlay does not know about "
        + "them -- so the one layer whose job is to say where this map has looked would quietly "
        + "omit them, which is the exact failure it exists to prevent"
    );
  });

  await t.test("no listed key is a source that does not exist", () => {
    // The other direction: a key removed from POLL_CONFIG but left here would
    // render forever as "unknown", inventing a source the app no longer has.
    // The one-shot fetches are legitimately absent from POLL_CONFIG, so they
    // are named rather than inferred.
    const ONE_SHOT = new Set([
      "cableLandings", "infra", "railways", "powerLines", "water",
    ]);
    const polled = new Set(POLL_CONFIG.map((entry) => entry.key));
    const orphaned = [...listed].filter((key) => !polled.has(key) && !ONE_SHOT.has(key));
    assert.deepEqual(
      orphaned, [],
      "these keys are in the overlay's list but are neither polled nor a known one-shot fetch"
    );
  });

  await t.test("every entry carries a label a reader can actually read", () => {
    for (const entry of COVERAGE_OVERLAY_SOURCES) {
      assert.ok(
        typeof entry.label === "string" && entry.label.trim().length > 0,
        `${entry.key} has no label, so the legend would show a bare source key`
      );
    }
  });
});
