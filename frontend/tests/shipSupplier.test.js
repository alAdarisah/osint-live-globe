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
