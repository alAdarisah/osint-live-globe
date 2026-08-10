// Task 22: what decorateAdsb now shows beyond a dot and a callsign --
// Identity/Flight now/Flags/Provenance, symmetric to Task 14's ship card (see
// vesselCard.test.js's header for the shared reasoning on why this stubs
// window.L rather than touching Leaflet or the DOM).
//
// Three pure helpers get their own direct coverage because they are exactly
// the kind of thing the brief calls out as easy to get quietly wrong:
// decodeSquawk (the three reserved emergency codes, and nothing else),
// verticalTrend (climb/descend/level derived from a short recorded track,
// including the "insufficient data" and "level" cases), and displayLimitedNote
// (the LADD/PIA wording, named as a request rather than an incident).

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

const { decorateAdsb, decodeSquawk, verticalTrend, displayLimitedNote } = await import("../src/map/decorators.js");

// --- decodeSquawk ------------------------------------------------------------

test("the three reserved emergency squawks decode to their meaning", () => {
  assert.equal(decodeSquawk("7500"), "unlawful interference (hijack)");
  assert.equal(decodeSquawk("7600"), "radio failure");
  assert.equal(decodeSquawk("7700"), "general emergency");
});

test("an ordinary squawk decodes to nothing -- it is not a reserved code", () => {
  assert.equal(decodeSquawk("1200"), null);
  assert.equal(decodeSquawk("2000"), null);
});

test("a missing squawk decodes to nothing rather than throwing", () => {
  assert.equal(decodeSquawk(null), null);
  assert.equal(decodeSquawk(undefined), null);
  assert.equal(decodeSquawk(""), null);
});

// --- verticalTrend -----------------------------------------------------------

function track(...altitudes) {
  return altitudes.map((altitude, i) => ({ altitude, t: i }));
}

test("fewer than two altitude fixes is not enough to say anything", () => {
  assert.equal(verticalTrend([]), null);
  assert.equal(verticalTrend(track(1000)), null);
  assert.equal(verticalTrend(undefined), null);
});

test("altitude climbing well past the noise floor reads as climbing", () => {
  assert.equal(verticalTrend(track(1000, 1100, 1400)), "climbing");
});

test("altitude dropping well past the noise floor reads as descending", () => {
  assert.equal(verticalTrend(track(4000, 3800, 3500)), "descending");
});

test("a short track that barely moves reads as level, not a false trend", () => {
  // 15 m of drift across a short track is exactly the kind of barometric
  // jitter a real climb or descent would dwarf -- this is the noise floor.
  assert.equal(verticalTrend(track(1000, 995, 1015)), "level");
});

test("a NaN or missing altitude in a fix is skipped rather than corrupting the trend", () => {
  const points = [{ altitude: 1000, t: 0 }, { altitude: null, t: 1 }, { altitude: 1500, t: 2 }];
  assert.equal(verticalTrend(points), "climbing");
});

// --- displayLimitedNote -------------------------------------------------------

test("no display_limited flag means no note", () => {
  assert.equal(displayLimitedNote({}), null);
});

test("LADD is worded as a request, names the programme, and does not editorialise", () => {
  const note = displayLimitedNote({ display_limited: "ladd" });
  assert.match(note, /this aircraft's operator has requested limited display/i);
  assert.match(note, /LADD/);
  assert.match(note, /FAA/);
});

test("PIA gets the same requested-display wording with its own programme named", () => {
  const note = displayLimitedNote({ display_limited: "pia" });
  assert.match(note, /this aircraft's operator has requested limited display/i);
  assert.match(note, /PIA/);
});

// --- decorateAdsb: card sections ---------------------------------------------

const AIRCRAFT = {
  icao24: "ae01ce", callsign: "RCH285", lat: 52.4, lon: 0.56,
  altitude: 3200, velocity: 240, heading: 91, on_ground: false,
  category: 4, military: false, callsign_military: false,
  updated: 1_786_000_000,
};

test("the four sections all appear, in order, on an ordinary aircraft", () => {
  const { detail } = decorateAdsb(AIRCRAFT, {});
  const identity = detail.indexOf("Identity");
  const flightNow = detail.indexOf("Flight now");
  const flags = detail.indexOf("Flags");
  const provenance = detail.indexOf("Provenance");
  assert.ok(identity > -1 && flightNow > identity && flags > flightNow && provenance > flags);
});

test("type_code is shown next to type_desc -- backend/sources/adsb.py stores it and nothing read it before", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, type_code: "C17", type_desc: "Boeing C-17A Globemaster III" }, {});
  assert.match(detail, /Boeing C-17A Globemaster III/);
  assert.match(detail, /type code C17/);
});

test("registration, operator and ICAO hex all appear in Identity", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, registration: "07-7185", operator: "UNITED STATES AIR FORCE" }, {});
  assert.match(detail, /07-7185/);
  assert.match(detail, /UNITED STATES AIR FORCE/);
  assert.match(detail, /ae01ce/);
});

test("the hex allocation country is shown alongside the block, distinct from origin_country", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, hex_country: "US", hex_block: "USAF", origin_country: "United Kingdom" }, {});
  assert.match(detail, /US<\/b>/);
  assert.match(detail, /block USAF/);
  // Both claims survive, unreconciled -- see icaoHexDetail's own comment.
  assert.match(detail, /United Kingdom/);
});

test("a military role is named and marked best-effort, never stated as confirmed", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, military: true, callsign_military: true, military_role: "tanker" }, {});
  assert.match(detail, /Aerial refueling tanker/);
  assert.match(detail, /best-effort/);
});

test("callsign, altitude, speed, heading and squawk all appear in Flight now", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, squawk: "1200" }, {});
  assert.match(detail, /RCH285/);
  assert.match(detail, /3200 m/);
  assert.match(detail, /864 km\/h/); // velocity is m/s on the wire: 240 * 3.6
  assert.match(detail, /91&deg;/);
  assert.match(detail, /1200/);
  assert.match(detail, /no special meaning/);
});

test("an emergency squawk is named, and the wording reads as a code, not an incident", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, squawk: "7700", emergency_squawk: "general emergency" }, {});
  assert.match(detail, /general emergency/);
  assert.doesNotMatch(detail, /hijack/i); // this aircraft's code is 7700, not 7500
  assert.match(detail, /occasionally set by mistake/);
  assert.match(detail, /not a confirmed incident/);
});

test("a squawk with no backend-computed emergency field is still decoded client-side", () => {
  // Simulates an OpenSky-sourced record, which today carries no
  // emergency_squawk field at all (see backend/sources/adsb.py) -- the
  // client-side decodeSquawk call inside decorateAdsb has to catch this.
  const { detail } = decorateAdsb({ ...AIRCRAFT, squawk: "7500", emergency_squawk: undefined }, {});
  assert.match(detail, /unlawful interference \(hijack\)/);
});

test("no altitude trend row appears at all while the aircraft is on the ground", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, icao24: "onground1", on_ground: true }, {});
  assert.doesNotMatch(detail, /Vertical trend/);
});

test("an airborne aircraft with no recorded track yet says so rather than guessing", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, icao24: "freshcontact" }, {});
  assert.match(detail, /Vertical trend/);
  assert.match(detail, /not enough recorded track yet/);
});

test("display_limited renders the requested-display wording in Flags", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, display_limited: "ladd", display_limited_note: "LADD - operator asked for limited public display (FAA programme)" }, {});
  assert.match(detail, /this aircraft's operator has requested limited display/i);
  assert.match(detail, /LADD/);
});

test("an OFAC-designated tail is shown in Flags via the shared sanctionDetail block", () => {
  const { detail } = decorateAdsb({
    ...AIRCRAFT,
    sanctions: { program: "SDGT", listed_as: "Test Aircraft", matched_on: "registration" },
  }, {});
  assert.match(detail, /OFAC-designated/);
  assert.match(detail, /SDGT/);
});

test("an aircraft with no flags at all says so instead of leaving the section silent", () => {
  const { detail } = decorateAdsb(AIRCRAFT, {});
  assert.match(detail, /No flags on this aircraft/);
});

test("Provenance names which upstream(s) supplied the record", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, data_sources: ["OpenSky"] }, {});
  assert.match(detail, /Source: OpenSky \(ADS-B\)/);
});

test("Provenance names both feeds when both contributed", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, data_sources: ["OpenSky", "airplanes.live"] }, {});
  assert.match(detail, /Source: OpenSky \+ airplanes\.live \(ADS-B\)/);
});

test("nearest_airfield is stated as proximity, never as a filed destination", () => {
  const { detail } = decorateAdsb({
    ...AIRCRAFT,
    nearest_airfield: { name: "Test Field", code: "TFD", km: 4.2, military_name: false },
  }, {});
  assert.match(detail, /Test Field/);
  assert.match(detail, /not a filed origin or destination/);
  assert.match(detail, /ADS-B carries no flight plan/);
});
