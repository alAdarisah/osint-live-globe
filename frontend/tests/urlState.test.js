// Task 35: deep-linkable views (frontend/src/urlState.js).
//
// urlState.js itself touches nothing but plain objects and strings and needs
// no window.L stub, but it imports map/severity.js for DEFAULT_EVENT_FILTER,
// and that module reaches ../utils/format and ./iconTheme through Vite-style
// extensionless specifiers -- fine for the bundled app, not resolvable by
// Node's own loader. Same resolve hook countryCardSections.test.js /
// summaryTiles.test.js / intelPanel.test.js already use for the same reason;
// no window.L stub is needed here, since that chain (format.js, iconTheme.js,
// svgIcons.js) never touches Leaflet the way map/decorators.js or
// map/popups.js do.
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

const { URL_STATE_VERSION, defaultViewState, encodeViewState, decodeViewState } =
  await import("../src/urlState.js");
const { DEFAULT_EVENT_FILTER } = await import("../src/map/severity.js");
const { DEFAULT_VESSEL_FILTER, DEFAULT_AIRCRAFT_FILTER } = await import("../src/utils/entityFilter.js");

// ---------- empty hash --------------------------------------------------

test("decodeViewState: an empty hash yields the default view, no error", () => {
  const { state, error } = decodeViewState("");
  assert.deepEqual(state, defaultViewState());
  assert.equal(error, null);
});

test("decodeViewState: undefined/null/a bare '#' all behave like an empty hash", () => {
  for (const hash of [undefined, null, "#"]) {
    const { state, error } = decodeViewState(hash);
    assert.deepEqual(state, defaultViewState());
    assert.equal(error, null);
  }
});

test("encodeViewState: an all-default view round-trips to the default view", () => {
  const hash = encodeViewState(defaultViewState());
  const { state, error } = decodeViewState(hash);
  assert.deepEqual(state, defaultViewState());
  assert.equal(error, null);
});

// ---------- round trip, field by field -----------------------------------

test("round-trips the camera", () => {
  const view = { ...defaultViewState(), camera: { lat: 48.8566, lon: 2.3522, zoom: 6.5 } };
  const { state, error } = decodeViewState(encodeViewState(view));
  assert.equal(error, null);
  assert.deepEqual(state.camera, { lat: 48.8566, lon: 2.3522, zoom: 6.5 });
});

test("round-trips a sparse layer override table", () => {
  const view = { ...defaultViewState(), layers: { aisTanker: true, jamming: false } };
  const { state } = decodeViewState(encodeViewState(view));
  assert.deepEqual(state.layers, { aisTanker: true, jamming: false });
});

test("round-trips the event filter", () => {
  const eventFilter = { maxAgeDays: 3, minSeverity: 40, showImprecise: true, minConfidence: 0.5 };
  const view = { ...defaultViewState(), filters: { event: eventFilter, vessel: {}, aircraft: {} } };
  const { state } = decodeViewState(encodeViewState(view));
  assert.deepEqual(state.filters.event, eventFilter);
});

test("round-trips the vessel and aircraft filters", () => {
  // Every field set here differs from its own default (DEFAULT_VESSEL_FILTER/
  // DEFAULT_AIRCRAFT_FILTER, entityFilter.js) on purpose -- a field left equal
  // to its default is dropped by design (see the "only the fields that
  // differ..." test below), so asserting a full round trip needs a value
  // that genuinely diverges everywhere.
  const vessel = { text: "MSC", sanctionedOnly: true, watchlistedOnly: true };
  const aircraft = { text: "RCH", militaryOnly: true };
  const view = { ...defaultViewState(), filters: { event: {}, vessel, aircraft } };
  const { state } = decodeViewState(encodeViewState(view));
  assert.deepEqual(state.filters.vessel, vessel);
  assert.deepEqual(state.filters.aircraft, aircraft);
});

test("round-trips a country selection", () => {
  const view = { ...defaultViewState(), selection: { kind: "country", id: "USA" } };
  const { state } = decodeViewState(encodeViewState(view));
  assert.deepEqual(state.selection, { kind: "country", id: "USA" });
});

test("round-trips a water selection", () => {
  const view = { ...defaultViewState(), selection: { kind: "water", id: "black-sea" } };
  const { state } = decodeViewState(encodeViewState(view));
  assert.deepEqual(state.selection, { kind: "water", id: "black-sea" });
});

test("round-trips a replay moment", () => {
  const ts = Date.UTC(2026, 0, 15, 12, 30, 0);
  const view = { ...defaultViewState(), replayAt: ts };
  const { state } = decodeViewState(encodeViewState(view));
  assert.equal(state.replayAt, ts);
});

test("round-trips every field at once", () => {
  // Same rule as the test above: every filter field set here differs from
  // its own default, so nothing is silently dropped as "already the
  // default" and the round trip can be asserted against the exact input.
  const view = {
    camera: { lat: -33.8688, lon: 151.2093, zoom: 9 },
    layers: { railLive: true, deflock: false },
    filters: {
      event: { maxAgeDays: 7, minSeverity: 10, showImprecise: true, minConfidence: 30 },
      vessel: { text: "IMO9", sanctionedOnly: true, watchlistedOnly: true },
      aircraft: { text: "MIL1", militaryOnly: true },
    },
    selection: { kind: "country", id: "UKR" },
    replayAt: Date.UTC(2026, 5, 1),
  };
  const { state, error } = decodeViewState(encodeViewState(view));
  assert.equal(error, null);
  assert.deepEqual(state, view);
});

// ---------- versioning ----------------------------------------------------

test("the encoded hash always leads with the current version token", () => {
  const hash = encodeViewState(defaultViewState());
  assert.match(hash, new RegExp(`^v${URL_STATE_VERSION}\\.`));
});

test("an unknown version is rejected cleanly: default view, error set, nothing thrown", () => {
  const hash = `v${URL_STATE_VERSION + 1}.${encodeURIComponent(JSON.stringify({ c: [1, 2, 3] }))}`;
  const { state, error } = decodeViewState(hash);
  assert.deepEqual(state, defaultViewState());
  assert.equal(error, "unknown-version");
});

test("a version token that isn't 'v<number>' at all is also rejected cleanly", () => {
  const { state, error } = decodeViewState("notaversion.somebody-elses-fragment");
  assert.deepEqual(state, defaultViewState());
  assert.equal(error, "malformed");
});

// ---------- damaged input never throws ------------------------------------

test("a truncated hash does not throw, and falls back to the default view", () => {
  const full = encodeViewState({
    ...defaultViewState(),
    camera: { lat: 10, lon: 20, zoom: 4 },
    selection: { kind: "country", id: "USA" },
  });
  // Cut off mid-payload, the way a chat client or email footer might.
  const truncated = full.slice(0, Math.floor(full.length * 0.6));
  assert.doesNotThrow(() => decodeViewState(truncated));
  const { state, error } = decodeViewState(truncated);
  assert.deepEqual(state, defaultViewState());
  assert.equal(error, "malformed");
});

test("a hash with valid JSON but garbage field types does not throw, and drops only the bad fields", () => {
  const bogus = `v${URL_STATE_VERSION}.${encodeURIComponent(JSON.stringify({
    c: ["not", "a", "number"],
    l: { ok: true, bad: "not-a-boolean" },
    ef: { minSeverity: "high" }, // wrong type -- dropped, not coerced
    s: ["spaceship", "USS Enterprise"], // not a supported selection kind
  }))}`;
  assert.doesNotThrow(() => decodeViewState(bogus));
  const { state, error } = decodeViewState(bogus);
  assert.equal(error, null); // the hash itself parsed fine; individual fields were just invalid
  assert.equal(state.camera, null);
  assert.deepEqual(state.layers, { ok: true });
  assert.deepEqual(state.filters.event, {});
  assert.equal(state.selection, null);
});

test("non-JSON garbage after a valid version token does not throw", () => {
  assert.doesNotThrow(() => decodeViewState(`v${URL_STATE_VERSION}.%%%not-json%%%`));
  const { state, error } = decodeViewState(`v${URL_STATE_VERSION}.%%%not-json%%%`);
  assert.deepEqual(state, defaultViewState());
  assert.equal(error, "malformed");
});

test("a leading '#' is accepted the same as a bare hash", () => {
  const hash = encodeViewState({ ...defaultViewState(), selection: { kind: "water", id: "42" } });
  const { state: withHash } = decodeViewState(`#${hash}`);
  const { state: withoutHash } = decodeViewState(hash);
  assert.deepEqual(withHash, withoutHash);
});

// ---------- sparseness / compactness --------------------------------------

test("an all-default view encodes to an empty payload after the version token", () => {
  const hash = encodeViewState(defaultViewState());
  assert.equal(hash, `v${URL_STATE_VERSION}.%7B%7D`); // encodeURIComponent(JSON.stringify({}))
});

test("only the fields that differ from default are written out", () => {
  const view = { ...defaultViewState(), filters: { event: { minSeverity: 20 }, vessel: {}, aircraft: {} } };
  const hash = encodeViewState(view);
  const decoded = decodeURIComponent(hash.split(".")[1]);
  const payload = JSON.parse(decoded);
  assert.deepEqual(payload, { ef: { minSeverity: 20 } });
});

// ---------- defaults referenced, not duplicated ---------------------------

test("defaultViewState's filters are empty diffs against this app's own shipped defaults", () => {
  // Not a tautology: this asserts urlState.js treats DEFAULT_EVENT_FILTER/
  // DEFAULT_VESSEL_FILTER/DEFAULT_AIRCRAFT_FILTER as *the* baseline, so a
  // link that matches the shipped defaults costs nothing in the URL.
  const view = {
    ...defaultViewState(),
    filters: { event: { ...DEFAULT_EVENT_FILTER }, vessel: { ...DEFAULT_VESSEL_FILTER }, aircraft: { ...DEFAULT_AIRCRAFT_FILTER } },
  };
  const hash = encodeViewState(view);
  assert.equal(hash, `v${URL_STATE_VERSION}.%7B%7D`);
});
