// Two AIS networks reach this map, and every pin has to say which one heard it.
//
// This suite exists because the failure it guards against is silent and looks
// like data. aisstream is a global aggregator; Fintraffic's Digitraffic network
// is ~900 hulls in Finnish and Baltic waters. If a Digitraffic pin carried
// aisstream's attribution -- or no coverage caveat -- a reader would take an
// empty Mediterranean as an empty Mediterranean, when in fact no receiver in
// that layer was ever listening to it. That is the reading error the
// dark-vessel layer exists to prevent, arriving through a popup instead.
//
// map/aisNetwork.js is deliberately dependency-free for this reason, exactly as
// scene.js is: map/decorators.js, which pastes these facts into the popup
// markup, imports Leaflet and cannot be reached from `node --test`. Keep the
// facts on this side of that line.

import test from "node:test";
import assert from "node:assert/strict";

import { AIS_NETWORKS, AISSTREAM_NETWORK, aisNetwork, shipPingSeconds } from "../src/map/aisNetwork.js";
import { LAYER_MANIFEST } from "../src/map/scene.js";

// A Digitraffic record, shaped as backend/sources/digitraffic_ais.py serves it:
// `source`/`publisher`/`license` on every row, and the position report's own
// timestamp under `time` rather than `updated`.
const digitraffic = {
  mmsi: 230949000,
  lat: 61.47,
  lon: 27.28,
  time: 1786438520.53,
  source: "digitraffic",
  publisher: "Fintraffic / digitraffic.fi",
  license: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY",
  name: "HELGA",
  ship_type: 70,
};

// An aisstream record: no `source` field at all -- the absence is what
// identifies it -- and its timestamp under `updated`.
const aisstream = {
  mmsi: 636019825,
  lat: 26.1,
  lon: 56.3,
  updated: 1786438000.0,
  name: "EXAMPLE TRADER",
  ship_type: 80,
};

test("which network heard a hull", async (t) => {
  await t.test("names Fintraffic for a Digitraffic record", () => {
    assert.equal(aisNetwork(digitraffic).label, "Fintraffic / digitraffic.fi");
  });

  await t.test("names aisstream for a record that states no source", () => {
    assert.equal(aisNetwork(aisstream).label, "aisstream.io");
    assert.equal(aisNetwork(aisstream), AISSTREAM_NETWORK);
  });

  await t.test("falls back to aisstream rather than to nothing", () => {
    // Never null: the popup pastes .label straight into markup, so a missing
    // network would render the word "undefined" as an attribution.
    for (const record of [undefined, null, {}, { source: "some-future-feed" }]) {
      assert.equal(aisNetwork(record), AISSTREAM_NETWORK);
    }
  });

  await t.test("states the coverage limit on Digitraffic and only there", () => {
    // The load-bearing sentence: without it an absence outside the Baltic reads
    // as an observation rather than as a network that was never there.
    assert.match(AIS_NETWORKS.digitraffic.coverage, /Finnish and Baltic waters only/);
    assert.equal(AISSTREAM_NETWORK.coverage, null);
  });
});

test("when a hull last reported", async (t) => {
  await t.test("reads Digitraffic's `time` field", () => {
    // The specific regression: reading only `updated` made every Digitraffic
    // pin say the feed had stated no time, for a time the feed did state.
    assert.equal(shipPingSeconds(digitraffic), 1786438520.53);
  });

  await t.test("reads aisstream's `updated` field", () => {
    assert.equal(shipPingSeconds(aisstream), 1786438000.0);
  });

  await t.test("prefers `updated` when a record somehow carries both", () => {
    assert.equal(shipPingSeconds({ updated: 10, time: 20 }), 10);
  });

  await t.test("returns nothing usable when neither field is present", () => {
    // Not zero, and not now: the popup has a third branch for this and it says
    // "not stated by the feed", which is neither stale nor live.
    assert.ok(!Number.isFinite(shipPingSeconds({ mmsi: 1 })));
    assert.ok(!Number.isFinite(shipPingSeconds({ updated: null, time: null })));
  });
});

test("the Digitraffic layer in the scene manifest", async (t) => {
  await t.test("is a layer the manifest knows about", () => {
    // A layer key the manifest has never heard of falls through to "fetch
    // always" with a warning nobody reads -- see UNGATED_FEEDS' note.
    assert.ok(LAYER_MANIFEST.aisDigitraffic, "aisDigitraffic is missing from LAYER_MANIFEST");
  });

  await t.test("draws no shallower than the civilian ships it sits beside", () => {
    // ~900 hulls packed into one sea is a smear at world zoom, same as the
    // aisstream civilian bucket it shares a band with.
    assert.equal(LAYER_MANIFEST.aisDigitraffic.draw.band, "THEATRE");
    assert.equal(LAYER_MANIFEST.aisDigitraffic.draw.band, LAYER_MANIFEST.aisCivilian.draw.band);
  });

  await t.test("declares a cap", () => {
    assert.ok(LAYER_MANIFEST.aisDigitraffic.cap, "an uncapped ship layer is a smear, not a layer");
  });
});
