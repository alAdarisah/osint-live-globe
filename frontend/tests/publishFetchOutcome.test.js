// Fix round 2 on Task 9's coverage section: the ordering invariant between
// recording a feed's fetch coverage and publishing its data.
//
// useOsintData.js's poller (and its two one-shot fetches, cables/cableLandings
// and infrastructure/pipelines) used to call onDataRef.current(key, data)
// -- which synchronously runs the map controller's applyData, which for a
// key in COUNTRY_CARD_FEEDS synchronously rebuilds an open country card --
// *before* recording that fetch in raw.fetchCoverage. That left a window,
// on exactly the refresh the coverage section exists to get right (a gated
// feed's first delivery while a card is open), where the card rendered fresh
// data next to a coverage line still reading "not loaded" -- the same class
// of false claim the coverage fix itself was written to prevent, reintroduced
// by call order.
//
// publishFetchOutcome is the extracted fix: record coverage, then publish.
// It cannot be exercised end to end here -- the hook it's called from is a
// real React effect with real timers and a real DOM-backed applyData, and
// this project's test setup (node --test, no jsdom/React-testing-library) has
// no harness for that (no other *.test.js here touches a hook or a component).
// So this test asserts the invariant at the one seam that is plain,
// synchronous JS: whatever order the two publishers are actually called in,
// by whichever real caller, coverage is recorded before any data reaches
// onData.
//
// useOsintData.js imports React (useCallback/useEffect/useMemo/useRef/
// useState) at module scope for the hook itself, but publishFetchOutcome
// uses none of them -- it's a plain function, so importing just this export
// does not require rendering anything, the same way countryCard.test.js
// imports map/popups.js (which imports Leaflet-backed decorators.js) without
// touching a DOM, just a window.L stub for the parts that need one at import
// time. useOsintData.js needs no such stub -- nothing in it touches the DOM
// at module scope.

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

const { publishFetchOutcome } = await import("../src/hooks/useOsintData.js");

test("publishFetchOutcome -- coverage is always recorded before data is published", async (t) => {
  await t.test("single data publish (the generic poller's shape): coverage first, data second", () => {
    const calls = [];
    const recordCoverage = (key, patch) => calls.push(["coverage", key, patch]);
    const onData = (key, data) => calls.push(["data", key, data]);

    publishFetchOutcome(recordCoverage, onData, "osmInfra", { status: "fetched", fetchedAt: 123 }, [
      ["osmInfra", [{ id: 1 }]],
    ]);

    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], "coverage", "the coverage write happens first");
    assert.equal(calls[1][0], "data", "the data publish happens second");
    assert.deepEqual(calls[0], ["coverage", "osmInfra", { status: "fetched", fetchedAt: 123 }]);
    assert.deepEqual(calls[1], ["data", "osmInfra", [{ id: 1 }]]);
  });

  await t.test("two data publishes under one coverage key (the cables/cableLandings and infra/pipelines shape): coverage still first, both data publishes after", () => {
    const calls = [];
    const recordCoverage = (key, patch) => calls.push(["coverage", key, patch]);
    const onData = (key, data) => calls.push(["data", key, data]);

    publishFetchOutcome(
      recordCoverage, onData, "cableLandings",
      { status: "fetched", fetchedAt: 456, bbox: null, scoped: false },
      [["cables", ["route1"]], ["cableLandings", ["landing1"]]]
    );

    assert.equal(calls.length, 3);
    assert.equal(calls[0][0], "coverage", "coverage for the single tracked key is written before either data slot lands");
    assert.equal(calls[0][1], "cableLandings");
    assert.deepEqual(calls.slice(1).map((c) => c[1]), ["cables", "cableLandings"], "both data slots still publish, in the order given");
  });

  await t.test("if a caller's onData synchronously reads back what recordCoverage just wrote (the exact race this fixes), it sees the new value, never the old one", () => {
    // Stands in for applyData's synchronous refreshFocusedCountryCard: a
    // consumer that, inside onData, immediately reads whatever recordCoverage
    // most recently wrote for this key. Before the fix this would have
    // observed the *previous* coverage state (or none at all on a first
    // fetch), because onData ran first.
    let coverageStore = {};
    const recordCoverage = (key, patch) => {
      coverageStore = { ...coverageStore, [key]: { ...coverageStore[key], ...patch } };
    };
    let observedDuringOnData = null;
    const onData = (key) => {
      observedDuringOnData = coverageStore[key];
    };

    assert.equal(coverageStore.dams, undefined, "nothing recorded yet -- this key has never been fetched");
    publishFetchOutcome(recordCoverage, onData, "dams", { status: "fetched", fetchedAt: 789 }, [["dams", []]]);
    assert.deepEqual(observedDuringOnData, { status: "fetched", fetchedAt: 789 }, "onData saw the fresh coverage record, not 'not loaded'");
  });
});
