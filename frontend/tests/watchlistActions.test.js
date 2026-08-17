// Must be first -- watchlistActions.js imports the map controller for its
// ID_FIELD table, and that chain reads window.L at import time.
import "./helpers/nodeTestEnv.js";

import test from "node:test";
import assert from "node:assert/strict";

const { watchEntryForMarker } = await import("../src/map/watchlistActions.js");

/** A marker shaped the way the controller builds them. */
const marker = (className, item) => ({ _icon: { className }, _item: item });

test("a marker is named by the layer class the controller already stamps on it", () => {
  // `layer-<key>` exists for the emphasis mechanism and is therefore already
  // guaranteed correct for every marker that has one -- which is why this reads
  // it rather than tracking the feed a second way.
  const entry = watchEntryForMarker(
    marker("entity-marker layer-events", { id: "acled-1", title: "Artillery, Kupiansk", lat: 49.7, lon: 37.6 }),
  );
  assert.deepEqual(entry, {
    kind: "events", id: "acled-1", label: "Artillery, Kupiansk", lat: 49.7, lon: 37.6,
  });
});

test("each feed's own id field is the one used", () => {
  // The same table recordDetail resolves against, so a pinned row reopens
  // exactly the card its popup came from.
  assert.equal(watchEntryForMarker(marker("layer-ais", { mmsi: 273123456 })).id, "273123456");
  assert.equal(watchEntryForMarker(marker("layer-adsb", { icao24: "3c6444" })).id, "3c6444");
  assert.equal(watchEntryForMarker(marker("layer-gdelt", { event_id: "g-9" })).id, "g-9");
});

test("a marker that cannot be named gets no button rather than a broken one", () => {
  // Country shapes, cable routes, coverage rectangles and clusters are all
  // legitimately un-pinnable. Offering a button that cannot resolve later is
  // worse than offering none.
  assert.equal(watchEntryForMarker(null), null);
  assert.equal(watchEntryForMarker({}), null, "no item");
  assert.equal(watchEntryForMarker(marker("leaflet-marker-icon", { id: "x" })), null, "no layer class");
  assert.equal(watchEntryForMarker(marker("layer-notAFeed", { id: "x" })), null, "unknown feed");
  assert.equal(watchEntryForMarker(marker("layer-events", {})), null, "no id");
  assert.equal(watchEntryForMarker(marker("layer-events", { id: "" })), null, "empty id");
});

test("the label follows whatever the feed actually calls the thing", () => {
  assert.equal(watchEntryForMarker(marker("layer-adsb", { icao24: "a", callsign: "RCH421" })).label, "RCH421");
  assert.equal(watchEntryForMarker(marker("layer-ais", { mmsi: 1, shipname: "ATLANTIC" })).label, "ATLANTIC");
  assert.equal(watchEntryForMarker(marker("layer-gdelt", { event_id: "g", real_title: "Port hit" })).label, "Port hit");
  // A record with nothing name-shaped still gets something a reader can tell
  // apart from its neighbours.
  assert.equal(watchEntryForMarker(marker("layer-events", { id: "42" })).label, "events 42");
});

test("a runaway label is trimmed rather than stored whole", () => {
  const long = "x".repeat(400);
  assert.equal(watchEntryForMarker(marker("layer-events", { id: "1", title: long })).label.length, 120);
});

test("a record with no position keeps null coordinates", () => {
  // Not 0,0 -- see utils/watchlist.js. The row simply does not offer to fly to
  // it.
  const entry = watchEntryForMarker(marker("layer-events", { id: "1" }));
  assert.equal(entry.lat, null);
  assert.equal(entry.lon, null);
});

test("the class is matched as a whole word", () => {
  // `layer-events` must not be found inside `layer-eventsomething`, and the
  // class list carries several other `layer-`-prefixed names.
  assert.equal(watchEntryForMarker(marker("layer-eventsExtra", { id: "1" })), null);
  assert.equal(watchEntryForMarker(marker("military-marker layer-adsb selected", { icao24: "a" })).kind, "adsb");
});
