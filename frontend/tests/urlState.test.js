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
//
// Also covers the review's Criticals/Important findings that trace back to a
// pure function this module exports specifically so the App.jsx seam they
// live in (React state, effects, the map controller -- none of it
// importable under this project's plain node --test harness) has *some*
// headless coverage: applyLayerOverrideChange (Criticals 1 and 3, the
// share-link-leaking-admin-config bug and the frozen-override-fighting-the-
// checkbox bug) and describeUrlStateNotice (Important 2's recipient side).
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

const {
  URL_STATE_VERSION, defaultViewState, encodeViewState, decodeViewState,
  applyLayerOverrideChange, omittedSelectionNote, describeUrlStateNotice,
} = await import("../src/urlState.js");
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

test("round-trips the event filter, except maxAgeDays", () => {
  // Review fix (Important 1): maxAgeDays is IntelPanel.jsx's own field --
  // it pushes windowMaxAgeDays(windowHours) into eventFilter unconditionally
  // on mount, so a value restored here would be silently overwritten within
  // the same render (this format does not carry IntelPanel's window, so it
  // cannot keep maxAgeDays in sync with it either). It must never round-trip,
  // even though it is present in DEFAULT_EVENT_FILTER and differs from
  // default here.
  const eventFilter = { maxAgeDays: 3, minSeverity: 40, showImprecise: true, minConfidence: 0.5 };
  const view = { ...defaultViewState(), filters: { event: eventFilter, vessel: {}, aircraft: {} } };
  const { state } = decodeViewState(encodeViewState(view));
  assert.deepEqual(state.filters.event, { minSeverity: 40, showImprecise: true, minConfidence: 0.5 });
  assert.ok(!("maxAgeDays" in state.filters.event));
});

test("a hand-crafted hash cannot smuggle maxAgeDays back into the event filter either", () => {
  const hash = `v${URL_STATE_VERSION}.${encodeURIComponent(JSON.stringify({ ef: { maxAgeDays: 3, minSeverity: 40 } }))}`;
  const { state, error } = decodeViewState(hash);
  assert.equal(error, null);
  assert.deepEqual(state.filters.event, { minSeverity: 40 });
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

test("round-trips every field at once (except maxAgeDays, which never round-trips)", () => {
  // Same rule as the tests above: every filter field set here differs from
  // its own default, so nothing is silently dropped as "already the
  // default" and the round trip can be asserted against the exact input --
  // except maxAgeDays, deliberately absent from the input's own event filter
  // for the same reason the dedicated test above gives it its own case.
  const view = {
    camera: { lat: -33.8688, lon: 151.2093, zoom: 9 },
    layers: { railLive: true, deflock: false },
    filters: {
      event: { minSeverity: 10, showImprecise: true, minConfidence: 30 },
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

test("a hash truncated to just the version token, with no dot at all, is malformed -- not a valid empty hash", () => {
  // Review fix (Minor): a real encoded hash always has a dot -- encodeViewState
  // always appends at least "%7B%7D" after it, even for an empty payload --
  // so "v1" on its own can only be a truncation, not a deliberate hash-less
  // load. It used to read as the latter (an empty body, no error).
  const { state, error } = decodeViewState(`v${URL_STATE_VERSION}`);
  assert.deepEqual(state, defaultViewState());
  assert.equal(error, "malformed");
});

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

// ---------- applyLayerOverrideChange (Criticals 1 and 3) -------------------
//
// The reducer behind App.jsx's layerOverride state -- the actual seam both
// findings trace back to. See its own doc comment in urlState.js for the
// full story; these tests are the regression coverage for each half.

test("applyLayerOverrideChange: seeded from a link, a checkbox toggle updates (not just clears) the key", () => {
  // Critical 3: opening a link carrying cables:false, then ticking Submarine
  // cables on, must make the map draw cables -- not leave a frozen `false`
  // permanently outranking the checkbox for the rest of the tab.
  const seeded = { cables: false };
  const afterToggleOn = applyLayerOverrideChange(seeded, "cables", true);
  assert.deepEqual(afterToggleOn, { cables: true });
  // And toggling it back off updates it again, rather than being stuck.
  const afterToggleOff = applyLayerOverrideChange(afterToggleOn, "cables", false);
  assert.deepEqual(afterToggleOff, { cables: false });
});

test("applyLayerOverrideChange: a share link built from the result carries the reader's latest choice, not the link's original one", () => {
  // Critical 1 (the other half): once a reader has toggled a key, a
  // follow-up "Copy link" (which reads this same map, per App.jsx's
  // buildShareUrl) must carry what they chose, not what the original link
  // that opened this tab said.
  const seeded = { cables: false };
  const afterToggle = applyLayerOverrideChange(seeded, "cables", true);
  const hash = encodeViewState({ ...defaultViewState(), layers: afterToggle });
  const { state } = decodeViewState(hash);
  assert.deepEqual(state.layers, { cables: true });
});

test("applyLayerOverrideChange: null/undefined hands the key back to the resolver by removing it, not by writing null", () => {
  const seeded = { cables: false, jamming: true };
  const afterReset = applyLayerOverrideChange(seeded, "cables", null);
  assert.deepEqual(afterReset, { jamming: true });
  assert.ok(!("cables" in afterReset));
});

test("applyLayerOverrideChange: a no-op change returns the same reference (no gratuitous re-renders)", () => {
  const seeded = { cables: true };
  assert.equal(applyLayerOverrideChange(seeded, "cables", true), seeded);
  const empty = {};
  assert.equal(applyLayerOverrideChange(empty, "cables", null), empty);
});

test("applyLayerOverrideChange: never mutates its input", () => {
  const seeded = { cables: false };
  const snapshot = { ...seeded };
  applyLayerOverrideChange(seeded, "cables", true);
  applyLayerOverrideChange(seeded, "jamming", null);
  assert.deepEqual(seeded, snapshot);
});

// ---------- omittedSelectionNote (Important 2, sharer side) ----------------

test("omittedSelectionNote: nothing to say for a plain single selection", () => {
  assert.equal(omittedSelectionNote({ countrySelectionCount: 1 }), null);
  assert.equal(omittedSelectionNote({}), null);
});

test("omittedSelectionNote: names a multi-country selection", () => {
  const note = omittedSelectionNote({ countrySelectionCount: 3 });
  assert.match(note, /3 selected countries/);
});

test("omittedSelectionNote: names an open subdivision, district, and record independently", () => {
  assert.match(omittedSelectionNote({ hasSubdivision: true }), /state\/province card/);
  assert.match(omittedSelectionNote({ hasDistrict: true }), /district card/);
  assert.match(omittedSelectionNote({ hasOpenRecord: true }), /open record/);
});

test("omittedSelectionNote: lists every omission at once", () => {
  const note = omittedSelectionNote({
    countrySelectionCount: 2, hasSubdivision: true, hasDistrict: true, hasOpenRecord: true,
  });
  for (const fragment of ["2 selected countries", "state/province card", "district card", "open record"]) {
    assert.ok(note.includes(fragment), `expected note to mention "${fragment}": ${note}`);
  }
});

// ---------- describeUrlStateNotice (Important 2, recipient side) -----------

test("describeUrlStateNotice: an unknown-version error always wins, tone warn", () => {
  const content = describeUrlStateNotice({ state: defaultViewState(), error: "unknown-version" });
  assert.equal(content.tone, "warn");
  assert.match(content.message, /no longer matches this one/);
});

test("describeUrlStateNotice: a malformed error, tone warn, distinct wording", () => {
  const content = describeUrlStateNotice({ state: defaultViewState(), error: "malformed" });
  assert.equal(content.tone, "warn");
  assert.match(content.message, /incomplete or altered/);
});

test("describeUrlStateNotice: nothing to say for a plain hash-less visit", () => {
  assert.equal(describeUrlStateNotice({ state: defaultViewState(), error: null }), null);
});

test("describeUrlStateNotice: a real followed link gets the one-time limits reminder, tone info", () => {
  const state = { ...defaultViewState(), camera: { lat: 1, lon: 2, zoom: 3 } };
  const content = describeUrlStateNotice({ state, error: null });
  assert.equal(content.tone, "info");
  assert.match(content.message, /does not carry a multi-country selection/);
});

test("describeUrlStateNotice: fires for each kind of restored state on its own (selection, layers, filters, replay)", () => {
  const base = defaultViewState();
  const cases = [
    { ...base, selection: { kind: "country", id: "US" } },
    { ...base, layers: { cables: true } },
    { ...base, filters: { event: { minSeverity: 10 }, vessel: {}, aircraft: {} } },
    { ...base, replayAt: Date.now() },
  ];
  for (const state of cases) {
    const content = describeUrlStateNotice({ state, error: null });
    assert.equal(content?.tone, "info", `expected an info notice for ${JSON.stringify(state)}`);
  }
});
