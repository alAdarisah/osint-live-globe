// Task 27: the OSM rail-line overlay's classification and styling functions
// (frontend/src/map/decorators.js) -- railwayOsmClass, railwayIsElectrified,
// railwayLineColor, railwayLineBaseWeight and railwayLineDash. Exported pure
// functions over a plain record, flagged in review as untested even though
// nothing about them requires touching Leaflet or the DOM: railwayIsElectrified
// reads a tag value freehand (a case-fold slip would ship silently), and the
// class/colour functions both have a three-way branch where narrow gauge
// deliberately overrides what electrification would otherwise pick.
//
// map/decorators.js pulls in map/leafletGlobal.js (reads `window.L` at module
// scope) and map/svgIcons.js's buildDivIcon (calls L.divIcon), so this stubs
// just enough of window.L to satisfy those imports, the same way
// vesselCard.test.js, laneRender.test.js and adsbCard.test.js do. Nothing here
// touches Leaflet or the DOM otherwise -- only the pure functions are asserted
// on, plus a couple of icon-shape smoke tests for the two new marker
// decorators (decorateRailLive/decorateRailStation) using the same stub.

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

globalThis.window = {
  L: {
    geoJSON: () => ({}),
    divIcon: (opts) => ({ options: opts }),
  },
};

const {
  railwayOsmClass, railwayIsElectrified, railwayLineColor, railwayLineBaseWeight, railwayLineDash,
  RAILWAY_ELECTRIFIED_COLOR, RAILWAY_NONELECTRIFIED_COLOR, RAILWAY_NARROW_GAUGE_COLOR, RAILWAY_ROUTE_COLOR,
  decorateRailLive, decorateRailStation, railLiveStyle, railStationStyle,
} = await import("../src/map/decorators.js");

// --- railwayOsmClass ---------------------------------------------------------

test("railway=narrow_gauge is narrowGauge regardless of usage", () => {
  assert.equal(railwayOsmClass({ railway: "narrow_gauge" }), "narrowGauge");
  assert.equal(railwayOsmClass({ railway: "narrow_gauge", usage: "main" }), "narrowGauge");
});

test("usage=branch is branch", () => {
  assert.equal(railwayOsmClass({ railway: "rail", usage: "branch" }), "branch");
});

test("railway=light_rail reads as branch even with no usage tag", () => {
  assert.equal(railwayOsmClass({ railway: "light_rail" }), "branch");
});

test("railway=rail with usage=main, or no usage at all, is the mainline default", () => {
  assert.equal(railwayOsmClass({ railway: "rail", usage: "main" }), "main");
  assert.equal(railwayOsmClass({ railway: "rail" }), "main");
});

test("narrow_gauge wins over a branch usage tag -- gauge is checked first", () => {
  assert.equal(railwayOsmClass({ railway: "narrow_gauge", usage: "branch" }), "narrowGauge");
});

test("a missing or empty record does not throw", () => {
  assert.equal(railwayOsmClass({}), "main");
  assert.equal(railwayOsmClass(null), "main");
  assert.equal(railwayOsmClass(undefined), "main");
});

// --- railwayIsElectrified ----------------------------------------------------

test("yes, contact_line and rail all read as electrified", () => {
  assert.equal(railwayIsElectrified({ electrified: "yes" }), true);
  assert.equal(railwayIsElectrified({ electrified: "contact_line" }), true);
  assert.equal(railwayIsElectrified({ electrified: "rail" }), true);
});

test("no and anything else read as not electrified", () => {
  assert.equal(railwayIsElectrified({ electrified: "no" }), false);
  assert.equal(railwayIsElectrified({ electrified: "unknown" }), false);
  assert.equal(railwayIsElectrified({ electrified: "planned" }), false);
});

test("an absent electrified tag is not electrified, not unknown -- OSM said nothing, so nothing is asserted", () => {
  assert.equal(railwayIsElectrified({}), false);
  assert.equal(railwayIsElectrified(null), false);
  assert.equal(railwayIsElectrified(undefined), false);
});

test("the match is case-insensitive -- OSM data is freehand-ish and this must not silently miss a real value", () => {
  assert.equal(railwayIsElectrified({ electrified: "YES" }), true);
  assert.equal(railwayIsElectrified({ electrified: "Contact_Line" }), true);
  assert.equal(railwayIsElectrified({ electrified: "RAIL" }), true);
});

// --- railwayLineColor ---------------------------------------------------------

test("a Natural Earth line (source !== \"osm\") always draws the NE colour, whatever its other fields say", () => {
  assert.equal(railwayLineColor({ source: "ne" }), RAILWAY_ROUTE_COLOR);
  // Even a record carrying OSM-shaped tags but no source="osm" is read as NE --
  // the merge stamps source at collection and this function trusts it.
  assert.equal(railwayLineColor({ electrified: "yes", railway: "rail" }), RAILWAY_ROUTE_COLOR);
});

test("narrow gauge overrides the electrified colour, even when the line is tagged electrified", () => {
  assert.equal(
    railwayLineColor({ source: "osm", railway: "narrow_gauge", electrified: "yes" }),
    RAILWAY_NARROW_GAUGE_COLOR
  );
});

test("an OSM main/branch line picks colour by electrification alone", () => {
  assert.equal(railwayLineColor({ source: "osm", railway: "rail", electrified: "yes" }), RAILWAY_ELECTRIFIED_COLOR);
  assert.equal(railwayLineColor({ source: "osm", railway: "rail" }), RAILWAY_NONELECTRIFIED_COLOR);
  assert.equal(
    railwayLineColor({ source: "osm", railway: "light_rail", electrified: "contact_line" }),
    RAILWAY_ELECTRIFIED_COLOR
  );
});

// --- railwayLineBaseWeight / railwayLineDash ---------------------------------

test("Natural Earth is always the thin hairline weight and the NE dash, regardless of class", () => {
  assert.equal(railwayLineBaseWeight({ source: "ne" }), 1);
  assert.equal(railwayLineDash({ source: "ne" }), "4 4");
});

test("the three OSM classes get their own weight and their own dash", () => {
  const main = { source: "osm", railway: "rail", usage: "main" };
  const branch = { source: "osm", railway: "rail", usage: "branch" };
  const narrow = { source: "osm", railway: "narrow_gauge" };
  assert.equal(railwayLineBaseWeight(main) > railwayLineBaseWeight(branch), true);
  assert.equal(railwayLineDash(main), null); // solid
  assert.notEqual(railwayLineDash(branch), null);
  assert.notEqual(railwayLineDash(narrow), null);
  assert.notEqual(railwayLineDash(branch), railwayLineDash(narrow)); // told apart without a popup
});

// --- icon-shape smoke tests: the two new marker decorators -------------------

test("decorateRailLive builds an icon carrying the train number and Finland-only caveat", () => {
  const d = decorateRailLive({
    id: "2026-08-09:1", train_number: 1, departure_date: "2026-08-09", speed: 120, accuracy: 10,
  });
  assert.match(d.tooltip, /Train 1/);
  assert.match(d.detail, /Finland only/);
  assert.ok(d.icon);
});

test("decorateRailStation builds an icon naming the station and its short code", () => {
  const d = decorateRailStation({
    id: "HKI", name: "Helsinki asema", short_code: "HKI", uic_code: 1, passenger_traffic: true,
  });
  assert.match(d.tooltip, /Helsinki asema/);
  assert.match(d.detail, /HKI/);
  assert.ok(d.icon);
});

test("a station shares the live train's colour but draws smaller and quieter -- see decorateRailStation's own note", () => {
  const train = railLiveStyle();
  const station = railStationStyle();
  assert.equal(station.color, train.color);
  assert.equal(station.token, train.token);
  assert.equal(station.size < train.size, true);
  assert.equal(station.opacity < train.opacity, true);
});
