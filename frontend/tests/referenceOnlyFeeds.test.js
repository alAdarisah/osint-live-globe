// The pairing that navalPresence fell through, and the pairing pipelinesTruncatedRegions
// and militaryBases fell through after it -- asserted as one invariant instead of a
// hand-copied list.
//
// A feed that reaches createMapController.js's applyData without an explicit branch has
// exactly two ways to survive the fall-through to its `renderMarkerLayer(key)` catch-all
// (which iterates its argument and throws "markerMap is not iterable" on a plain object or
// a string array):
//
//   * it has a DECORATORS entry, so renderMarkerLayer knows how to draw it; or
//   * it is named in scene.js's REFERENCE_ONLY_FEEDS, so applyData's dispatch stops at it
//     instead of ever reaching the catch-all.
//
// Task 29 added navalPresence to POLL_CONFIG and to neither list. Task 36 added chokepoints
// and hit the identical wall. The Critical this file was rewritten for is a third instance,
// worse than the first two: the one-shot /api/infrastructure fetch (useOsintData.js) landed
// pipelinesTruncatedRegions and militaryBases without adding either to REFERENCE_ONLY_FEEDS,
// and because publishFetchOutcome publishes its tuples in order and pipelinesTruncatedRegions
// is tuple 2 of 5, the throw on that tuple stopped tuples 3-5 ("pipelines", "shippingLanes",
// "militaryBases") from ever publishing at all -- pipeline routes and the ten shipping
// corridors drew nothing for the whole session.
//
// The old version of this file iterated `for (const key of REFERENCE_ONLY_FEEDS)`, which is
// structurally blind to a feed missing from *both* lists: nothing was ever asked "does this
// key exist at all in either list", because the loop's only source of keys was one of the two
// lists it was checking. This version instead builds the universe of keys that can actually
// reach applyData -- the real POLL_CONFIG, plus the real one-shot boot-fetch call sites in
// useOsintData.js, read out of that file's own source text the same way editableSources.test.js
// already reads createMapController.js's ID_FIELD table -- and checks every one of them against
// the real DECORATORS/REFERENCE_ONLY_FEEDS/dispatch-chain/SAT-group tables, also read from source
// rather than copied by hand. A hand-copied list is how this class of bug keeps recurring.
//
// Confirmed to fail against the pre-fix scene.js (pipelinesTruncatedRegions and militaryBases
// were the only two keys the sweep below found unaccounted for) before REFERENCE_ONLY_FEEDS was
// corrected.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// createMapController.js cannot be imported under `node --test`: it pulls in
// map/leafletGlobal.js (reads `window.L` at module scope, throws if absent) and
// map/layers.js (calls `L.latLngBounds` at module scope), and beyond those two
// there is a webgl entity layer behind it -- there is no window.L stub cheap
// enough to satisfy the whole import chain the way the small Leaflet stubs in
// waterCard.test.js/districtCard.test.js satisfy map/decorators.js alone. So,
// same technique editableSources.test.js already uses for this exact file: read
// the source text and parse the tables out of it.
const controllerSrc = readFileSync(new URL("../src/map/createMapController.js", import.meta.url), "utf8");
const hookSrc = readFileSync(new URL("../src/hooks/useOsintData.js", import.meta.url), "utf8");

/** The `const DECORATORS = { key: decorateFn, ... };` table -- every key
 *  renderMarkerLayer's generic catch-all knows how to draw. */
function decoratorKeys() {
  const block = controllerSrc.match(/const DECORATORS = \{([\s\S]*?)\n\};/)[1];
  return new Set([...block.matchAll(/(\w+): decorate\w+/g)].map((m) => m[1]));
}

/** The `const SAT_ELEMENT_CELESTRAK_GROUP = { key: "group", ... };` table --
 *  applyData's `key in SAT_ELEMENT_CELESTRAK_GROUP` branch handles these
 *  before ever reaching the terminal dispatch chain below. */
function satGroupKeys() {
  const block = controllerSrc.match(/const SAT_ELEMENT_CELESTRAK_GROUP = \{([\s\S]*?)\n\};/)[1];
  return new Set([...block.matchAll(/(\w+): "\w+"/g)].map((m) => m[1]));
}

/**
 * The terminal `if (key === "countries") renderCountries(); else if (...) ...
 * else renderMarkerLayer(key);` chain inside applyData -- the actual dispatch
 * a key falls through if nothing here, DECORATORS, REFERENCE_ONLY_FEEDS or
 * SAT_ELEMENT_CELESTRAK_GROUP claims it first.
 *
 * Deliberately scoped to just this chain rather than the whole applyData
 * function body: applyData also has preliminary side-effect guards earlier
 * (`if (key === "adsb") { ... }`, `if (key === "events" || key === "gdelt")
 * eventsDataVersion += 1`, etc.) that do NOT stop a key reaching the terminal
 * chain below -- events/gdelt/officials/airports/dams/adsb all trigger one of
 * those guards and *still* fall through to the catch-all, surviving only
 * because they also have DECORATORS entries. A regex over the whole function
 * would wrongly credit a key with "explicit handling" for tripping a
 * preliminary guard alone, which is exactly the kind of false safety net that
 * let the Critical this file was rewritten for go unnoticed.
 */
function terminalDispatchKeys() {
  const block = controllerSrc.match(
    /(if \(key === "countries"\) renderCountries\(\);[\s\S]*?else renderMarkerLayer\(key\);)/
  )[1];
  return new Set([...block.matchAll(/key === "(\w+)"/g)].map((m) => m[1]));
}

/**
 * Every key useOsintData.js's one-shot boot-time effect publishes outside
 * POLL_CONFIG -- cables/cableLandings, railways, powerLines, water, and the
 * five tuples riding /api/infrastructure -- read out of the real call sites
 * rather than hand-copied:
 *
 *   * `onDataRef.current("key", ...)` -- a direct single-key publish
 *     (railways, powerLines, water), plus recordCoverage's own
 *     `onDataRef.current("fetchCoverage", ...)`.
 *   * `["key", <expr referencing data>]` -- a publishFetchOutcome tuple
 *     (the cables and infrastructure fetches, which each split one response
 *     across several raw slots). Restricted to tuples whose second element
 *     visibly reads the fetched `data` so this does not also pick up an
 *     unrelated same-shaped array literal elsewhere in the file (this file
 *     has exactly one such false-positive shape: `new Set(["pending",
 *     "deferred"])`, whose second element is a string literal, not `data`).
 */
function oneShotPublishKeys() {
  const direct = [...hookSrc.matchAll(/onDataRef\.current\("(\w+)"/g)].map((m) => m[1]);
  const tupled = [...hookSrc.matchAll(/\["(\w+)",\s*(?:data\b|\(isLegacyArray)/g)].map((m) => m[1]);
  return new Set([...direct, ...tupled]);
}

const DECORATOR_KEYS = decoratorKeys();
const SAT_GROUP_KEYS = satGroupKeys();
const TERMINAL_DISPATCH_KEYS = terminalDispatchKeys();
const ONE_SHOT_KEYS = oneShotPublishKeys();

// Every key that can actually land in applyData: the real POLL_CONFIG plus the
// real one-shot boot fetches. Not UNGATED_FEEDS -- that set is scene.js's own
// declared exceptions to a *different* rule (the fetch-gate warning), and
// several of its members (chokepoints, jamCrosscheck...) are legitimately
// polled while others in this universe (railways, water...) are legitimately
// not, so it is neither a superset nor a subset of what belongs here.
const ALL_APPLY_DATA_KEYS = new Set([...POLLED_KEYS, ...ONE_SHOT_KEYS]);

test("the parser found something -- guards the regexes above", () => {
  // A formatting change that stopped one of these matching would otherwise
  // turn every assertion below into a vacuous pass over an empty universe.
  assert.ok(DECORATOR_KEYS.size >= 20, `only parsed ${DECORATOR_KEYS.size} DECORATORS entries`);
  assert.ok(SAT_GROUP_KEYS.size >= 7, `only parsed ${SAT_GROUP_KEYS.size} SAT_ELEMENT_CELESTRAK_GROUP entries`);
  assert.ok(TERMINAL_DISPATCH_KEYS.size >= 15, `only parsed ${TERMINAL_DISPATCH_KEYS.size} terminal dispatch keys`);
  assert.ok(ONE_SHOT_KEYS.size >= 8, `only parsed ${ONE_SHOT_KEYS.size} one-shot publish keys`);
  assert.ok(POLLED_KEYS.size >= 30, `only parsed ${POLLED_KEYS.size} POLL_CONFIG keys`);
});

test("every key applyData can receive survives its dispatch without throwing", async (t) => {
  await t.test("is decorated, explicitly dispatched, a sat-element group, or reference-only", () => {
    const unaccounted = [...ALL_APPLY_DATA_KEYS].filter((key) =>
      !DECORATOR_KEYS.has(key)
      && !TERMINAL_DISPATCH_KEYS.has(key)
      && !SAT_GROUP_KEYS.has(key)
      && !REFERENCE_ONLY_FEEDS.has(key)
    );
    assert.deepEqual(
      unaccounted,
      [],
      `these keys reach applyData with no DECORATORS entry, no explicit dispatch branch, and no `
        + `REFERENCE_ONLY_FEEDS entry -- each one throws "markerMap is not iterable" the first time it `
        + `polls or lands: ${unaccounted.join(", ")}`
    );
  });

  // Named explicitly, on top of the sweep above, for the same reason the old
  // version of this file named navalPresence/chokepoints: a future edit that
  // moved one of these three back out of REFERENCE_ONLY_FEEDS while also
  // (coincidentally) giving it a DECORATORS entry or a dispatch branch would
  // make the loop above vacuously pass for it.
  await t.test("the three feeds this file has been rewritten for are all covered", () => {
    for (const key of ["navalPresence", "chokepoints", "pipelinesTruncatedRegions", "militaryBases"]) {
      const covered = DECORATOR_KEYS.has(key) || TERMINAL_DISPATCH_KEYS.has(key)
        || SAT_GROUP_KEYS.has(key) || REFERENCE_ONLY_FEEDS.has(key);
      assert.ok(covered, `${key} is not decorated, dispatched, or reference-only`);
    }
  });
});

test("reference-only feeds are wired consistently", async (t) => {
  await t.test("every polled reference-only feed is also ungated", () => {
    // The direction that actually bites. UNGATED_FEEDS legitimately holds keys
    // that are not reference-only (outages has a derived point layer; ais and
    // adsb are one payload split across three toggles), so the reverse
    // containment is not an invariant and is not asserted.
    for (const key of REFERENCE_ONLY_FEEDS) {
      if (!POLLED_KEYS.has(key)) continue; // fetchCoverage/pipelinesTruncatedRegions/militaryBases are one-shot, never polled
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
});
