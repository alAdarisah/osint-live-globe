// The pairing that navalPresence fell through, asserted.
//
// A feed that arrives as a whole reference document rather than an array of
// points has to be named in two unrelated places, and nothing connected them:
//
//   * createMapController.js's REFERENCE_ONLY_FEEDS, so applyData's dispatch
//     stops at it instead of reaching its `renderMarkerLayer(key)` catch-all,
//     which iterates its argument and throws on an object;
//   * scene.js's UNGATED_FEEDS, so a feed with no LAYER_MANIFEST entry is a
//     declared exception rather than a silent fall-through to "fetch always".
//
// Task 29 added navalPresence to POLL_CONFIG and to neither list. Every poll
// from then on threw inside applyData, was swallowed by useOsintData.js's
// per-poll try/catch into a console warning, and skipped the tail of applyData
// -- so an open country or water card kept whatever naval-presence numbers it
// was built with for the rest of the session. Task 36 added chokepoints and hit
// the identical wall, which is what surfaced the older one.
//
// Two feeds, two tasks, same omission: that is a missing test, not bad luck.
//
// Both lists live in scene.js, which is dependency-free. POLL_CONFIG does not:
// it comes from useOsintData.js, a React hook module. That import is why these
// assertions are here rather than in scene.test.js, whose own header promises
// that suite pulls in no React and no DOM.

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// useOsintData.js reaches for "../api" without an extension, which Vite
// resolves and node does not. Same shim publishFetchOutcome.test.js already
// uses to import that module.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
});

const { REFERENCE_ONLY_FEEDS, UNGATED_FEEDS, LAYER_MANIFEST } = await import("../src/map/scene.js");
const { POLL_CONFIG } = await import("../src/hooks/useOsintData.js");

const POLLED_KEYS = new Set(POLL_CONFIG.map((entry) => entry.key));

test("reference-only feeds are wired consistently", async (t) => {
  await t.test("every polled reference-only feed is also ungated", () => {
    // The direction that actually bites. UNGATED_FEEDS legitimately holds keys
    // that are not reference-only (outages has a derived point layer; ais and
    // adsb are one payload split across three toggles), so the reverse
    // containment is not an invariant and is not asserted.
    for (const key of REFERENCE_ONLY_FEEDS) {
      if (!POLLED_KEYS.has(key)) continue; // fetchCoverage is published internally, never polled
      assert.ok(
        UNGATED_FEEDS.has(key),
        `${key} is a polled reference-only feed but is missing from scene.js's UNGATED_FEEDS, `
          + "so it has no manifest entry and no declared exception either"
      );
    }
  });

  await t.test("no reference-only feed has a layer manifest entry", () => {
    // A manifest entry means the scene resolver believes there is something to
    // draw. If one of these ever gets one, either it grew a real layer -- in
    // which case it does not belong in REFERENCE_ONLY_FEEDS any more and
    // applyData should be rendering it -- or the entry is a mistake that will
    // gate the fetch of a document no zoom level can draw.
    for (const key of REFERENCE_ONLY_FEEDS) {
      assert.equal(
        LAYER_MANIFEST[key],
        undefined,
        `${key} is handled as a reference document by applyData but has a LAYER_MANIFEST entry`
      );
    }
  });

  await t.test("the two feeds this test was written for are covered", () => {
    // Named explicitly rather than left to the loops above: both of these were
    // absent once, and a future edit that drops one from REFERENCE_ONLY_FEEDS
    // would make the loops vacuously pass for it.
    for (const key of ["navalPresence", "chokepoints"]) {
      assert.ok(REFERENCE_ONLY_FEEDS.has(key), `${key} missing from REFERENCE_ONLY_FEEDS`);
      assert.ok(UNGATED_FEEDS.has(key), `${key} missing from UNGATED_FEEDS`);
      assert.ok(POLLED_KEYS.has(key), `${key} missing from POLL_CONFIG`);
    }
  });
});
