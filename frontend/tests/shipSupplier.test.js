// The ships layer's supplier fallback.
//
// aisstream stopped on 2026-08-06 for days, and again from 2026-08-05: the socket
// connects, the subscription is accepted, and no frame ever arrives. Probed from the
// deployment while writing this -- key present, socket up, subscription sent, then
// "no close frame received or sent" -- and aisstream's own issue tracker carries
// five independent reports of the same thing plus someone offering to buy the
// service. Not a key problem, and not one the proxy path can route around.
//
// Marinesia was written for precisely this and then never wired end to end: the
// collector ran, the health row was published, and nothing served it and nothing
// drew it. So during an outage the ships layer was simply empty.

import test from "node:test";
import assert from "node:assert/strict";

import {
  primaryShipFeedWorking,
  shipFallbackWish,
  shipSupplierReadout,
} from "../src/map/shipSupplier.js";

/** aisstream, exactly as the live deployment reported it during the outage. */
const AIS_DOWN = {
  ais: {
    item_count: 0,
    key_configured: true,
    last_success: null,
    last_error: "the ingest service: no AIS frames received since this process started",
  },
};
const AIS_WORKING = { ais: { item_count: 9711, key_configured: true, last_success: 1, seconds_since_success: 8 } };
const MARINESIA_LIVE = { marinesia: { item_count: 412, key_configured: true, last_success: 1, seconds_since_success: 60 } };
const MARINESIA_NO_KEY = {
  marinesia: {
    item_count: 0,
    key_configured: false,
    last_success: null,
    last_error: "the ingest service: MARINESIA_API_KEY not set in .env",
  },
};

test("delivering means frames, not a healthy-looking socket", () => {
  // The distinction the whole outage turns on. aisstream's plumbing was fine
  // throughout: it connected and accepted every subscription. What it did not do was
  // send anything, and a check on connection state alone would have called that
  // working for eleven days.
  assert.equal(primaryShipFeedWorking(AIS_WORKING), true);
  assert.equal(primaryShipFeedWorking(AIS_DOWN), false);
  assert.equal(primaryShipFeedWorking({}), false);
  assert.equal(primaryShipFeedWorking(null), false);
});

test("the fallback contributes nothing while aisstream is delivering", () => {
  // Empty rather than `{ marinesia: false }`, and the difference matters: an empty
  // wish leaves the layer to the scene resolver, which keeps it off by itself
  // (draw: null), whereas forcing it off would overrule a reader who had switched
  // Marinesia on deliberately.
  assert.deepEqual(shipFallbackWish({ ...AIS_WORKING, ...MARINESIA_LIVE }), {});
});

test("the fallback switches on while aisstream is not", () => {
  assert.deepEqual(shipFallbackWish({ ...AIS_DOWN, ...MARINESIA_LIVE }), { marinesia: true });
});

test("recovery needs no second code path", () => {
  // The behaviour asked for: back to aisstream on its own, with no redeploy. The
  // wish simply stops being contributed, and the resolver puts the layer back to its
  // own default of off. Asserted as the transition, because "it comes back" is the
  // half that is easy to leave untested.
  const during = shipFallbackWish({ ...AIS_DOWN, ...MARINESIA_LIVE });
  const after = shipFallbackWish({ ...AIS_WORKING, ...MARINESIA_LIVE });
  assert.deepEqual(during, { marinesia: true });
  assert.deepEqual(after, {});
});

test("an empty layer is not drawn over an empty layer", () => {
  // Marinesia unconfigured here, or down itself. Switching a layer on that has
  // nothing in it would add a source light and a legend line for no hulls, and would
  // make the map look like it had tried something when it had not.
  assert.deepEqual(shipFallbackWish({ ...AIS_DOWN, ...MARINESIA_NO_KEY }), {});
  assert.deepEqual(shipFallbackWish(AIS_DOWN), {});
});

test("the reader is told which supplier drew the hulls", () => {
  // A thinner feed that does not say it is thinner is the dishonest case. Marinesia
  // advertises ~100k messages a day worldwide; the eight watched chokepoints alone
  // produced ~140k a day through aisstream. A reader looking at a near-empty sea has
  // to be able to tell "no ships here" from "backup feed today".
  const normal = shipSupplierReadout({ ...AIS_WORKING, ...MARINESIA_LIVE });
  assert.equal(normal.key, "ais");
  assert.equal(normal.note, null, "nothing to explain when the real feed is up");

  const fallback = shipSupplierReadout({ ...AIS_DOWN, ...MARINESIA_LIVE });
  assert.equal(fallback.key, "marinesia");
  assert.match(fallback.note, /thinner/);
  assert.match(fallback.label, /Marinesia/);
});

test("neither supplier delivering says so, rather than implying an empty ocean", () => {
  // The state the map was actually in for eleven days. "No ships" and "no supplier"
  // look identical on a map and mean opposite things.
  const none = shipSupplierReadout({ ...AIS_DOWN, ...MARINESIA_NO_KEY });
  assert.equal(none.key, "none");
  assert.match(none.note, /not evidence/);
});

// ---------- the recovery path, end to end ----------
//
// "Make sure that when AIS comes back everything works as it should" is the half of
// a fallback that is easy to leave untested, because the failure is silent in the
// good direction: the backup feed simply stays on, quietly drawing a thin picture
// over a working one, and nothing errors.
//
// So this drives the real scene resolver rather than asserting the wish alone. The
// wish is only half the mechanism -- the other half is that withdrawing a key from
// the wish table actually turns the layer off, which depends on `marinesia` being in
// SCENE_APPLY_KEYS (createMapController's applyLayerWishes leaves those to the
// resolver and sets every other key explicitly).

const { resolveScene, SCENE_APPLY_KEYS, LAYER_MANIFEST, MANUAL } = await import("../src/map/scene.js");

/**
 * Whether the layer ends up drawn, by the rule createMapController's applyScene
 * actually applies:
 *
 *   const wish = userLayerWish[key];
 *   let want = wish === undefined ? scene.active.has(key) : wish;
 *
 * Restated here because applyScene lives in a 9,000-line module that needs Leaflet
 * and a DOM, and because the rule is the whole mechanism: the resolver decides only
 * when nobody has wished, and a wish -- from the fallback or from the reader --
 * beats it either way. Asserting resolveScene alone would test the wrong half, and
 * did on the first pass: it reports what the *camera* wants, not what is drawn.
 */
function wouldDraw(wishes, sceneContext = { zoom: 6 }) {
  const wish = wishes.marinesia;
  return wish === undefined ? resolveScene(sceneContext).active.has("marinesia") : wish;
}

test("the resolver, not the fallback, is what owns the layer when nobody wishes", () => {
  // If marinesia were outside SCENE_APPLY_KEYS, applyLayerWishes would set it from
  // whatever keys are *present* in the table -- and a withdrawn key is not present,
  // so nothing would ever turn it back off. It would stay on for the rest of the
  // session after aisstream recovered.
  assert.ok(
    SCENE_APPLY_KEYS.includes("marinesia"),
    "marinesia must be resolver-owned, or a withdrawn fallback never switches off",
  );
});

test("nothing but an explicit wish can switch the fallback on", () => {
  // MANUAL, and this is the test that changed it. It was CORROBORATING first, and
  // isCorroborationOpen opens every corroborating layer the moment a country is
  // focused -- so after aisstream recovered, the first click on a country would have
  // drawn the backup feed alongside the live one. A country focus is the single most
  // ordinary thing a reader does on this map.
  assert.equal(LAYER_MANIFEST.marinesia.disposition, MANUAL);
  assert.equal(LAYER_MANIFEST.marinesia.draw, null);

  const focus = { kind: "country", key: "UKR", bounds: [40, 20, 55, 45] };
  for (const ctx of [
    { zoom: 2 }, { zoom: 6 }, { zoom: 9 }, { zoom: 14 },
    { zoom: 6, focus }, { zoom: 12, focus },
  ]) {
    assert.ok(
      !resolveScene(ctx).active.has("marinesia"),
      `switched itself on at ${JSON.stringify(ctx)}`,
    );
  }
});

test("the outage draws it, and recovery stops drawing it", () => {
  // The whole transition, through the rule that decides.
  assert.equal(wouldDraw(shipFallbackWish({ ...AIS_DOWN, ...MARINESIA_LIVE })), true,
    "the fallback did not reach the map");
  assert.equal(wouldDraw(shipFallbackWish({ ...AIS_WORKING, ...MARINESIA_LIVE })), false,
    "the fallback outlived the outage");
});

test("recovery holds with a country focused, which is where it would have failed", () => {
  const focus = { kind: "country", key: "UKR", bounds: [40, 20, 55, 45] };
  const recovered = shipFallbackWish({ ...AIS_WORKING, ...MARINESIA_LIVE });
  assert.equal(wouldDraw(recovered, { zoom: 6, focus }), false);
  assert.equal(wouldDraw(recovered, { zoom: 12, focus }), false);
});

test("a reader who asked for it keeps it after aisstream returns", () => {
  // App.jsx applies layerOverride *after* the fallback's contribution, so a reader's
  // own tick is what is left rather than being overruled by recovery.
  const wishes = { ...shipFallbackWish({ ...AIS_WORKING, ...MARINESIA_LIVE }), marinesia: true };
  assert.equal(wouldDraw(wishes), true);

  // And a reader who switched it off during the outage stays off.
  const refused = { ...shipFallbackWish({ ...AIS_DOWN, ...MARINESIA_LIVE }), marinesia: false };
  assert.equal(wouldDraw(refused), false);
});

test("the primary layers are untouched by any of this", () => {
  // aisstream's own buckets have to come back on their own, with no fallback
  // involvement: they are AUTO layers with real draw bands, and nothing here should
  // have changed that.
  // AUTO is the property that matters: they come back by themselves when frames
  // resume, with nothing to switch and nobody to ask. Deliberately not asserting a
  // draw band -- aisNavy has none on purpose, because a warship broadcasting AIS at
  // all is the rare thing on the layer and is worth seeing before you have zoomed in
  // looking for it.
  for (const key of ["aisCivilian", "aisTanker", "aisNavy"]) {
    assert.ok(LAYER_MANIFEST[key], `${key} left the manifest`);
    assert.notEqual(LAYER_MANIFEST[key].disposition, MANUAL, `${key} must not need a tick`);
  }

  // And the fallback is the only vessel layer that does need one, so recovery cannot
  // leave a second supplier drawing beside the first.
  assert.equal(LAYER_MANIFEST.marinesia.disposition, MANUAL);
});
