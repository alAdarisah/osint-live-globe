// Task 22: what decorateAdsb now shows beyond a dot and a callsign --
// Identity/Flight now/Flags/Provenance, symmetric to Task 14's ship card (see
// vesselCard.test.js's header for the shared reasoning on why this stubs
// window.L rather than touching Leaflet or the DOM).
//
// Three pure helpers get their own direct coverage because they are exactly
// the kind of thing the brief calls out as easy to get quietly wrong:
// decodeSquawk (the three reserved emergency codes, and nothing else),
// verticalTrend (climb/descend/level derived from the recorded track -- the
// real server track, `{altitude, ts}` points, not a client-side accumulation
// -- including the "insufficient data", "level" and "a gap must not bridge a
// stale fix to a fresh one" cases), and displayLimitedNote (the LADD/PIA
// wording, named as a request rather than an incident).
//
// This file also pins the four review findings from the first pass at this
// task: the vertical trend has to come from the fetched track
// (createMapController.js's loadAircraftTrack), not module-private state;
// the emergency-squawk label may appear more than once on the card only if
// every appearance carries the "not a confirmed incident" caveat; origin_country
// renders unconditionally, independent of whether the ICAO hex lookup has
// resolved; and the classification (military or not) carries a best-effort
// disclaimer in both branches, not just the military one.

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
//
// Points are `{altitude, ts}`, ts in unix seconds -- the real shape
// backend/storage.py's entity_track returns (oldest-first), which is what
// createMapController.js hands decorateAdsb as `track` after fetching
// /api/track/adsb/{icao}.

function track(...pairs) {
  // pairs of [altitude, ts]
  return pairs.map(([altitude, ts]) => ({ altitude, ts }));
}

test("fewer than two altitude fixes is not enough to say anything", () => {
  assert.equal(verticalTrend([]), null);
  assert.equal(verticalTrend(track([1000, 0])), null);
  assert.equal(verticalTrend(undefined), null);
});

test("altitude climbing well past the noise floor reads as climbing", () => {
  assert.equal(verticalTrend(track([1000, 0], [1100, 60], [1400, 120])), "climbing");
});

test("altitude dropping well past the noise floor reads as descending", () => {
  assert.equal(verticalTrend(track([4000, 0], [3800, 60], [3500, 120])), "descending");
});

test("a short track that barely moves reads as level, not a false trend", () => {
  // 15 m of drift across a short track is exactly the kind of barometric
  // jitter a real climb or descent would dwarf -- this is the noise floor.
  assert.equal(verticalTrend(track([1000, 0], [995, 60], [1015, 120])), "level");
});

test("a NaN or missing altitude, or a missing ts, is skipped rather than corrupting the trend", () => {
  const points = [
    { altitude: 1000, ts: 0 },
    { altitude: null, ts: 60 },
    { altitude: 1500, ts: 120 },
    { altitude: 1600, ts: undefined },
  ];
  assert.equal(verticalTrend(points), "climbing");
});

test("out-of-order input is sorted before the trend is derived", () => {
  assert.equal(verticalTrend(track([1400, 120], [1000, 0], [1100, 60])), "climbing");
});

test("a gap in the recorded track does not let a stale fix pair with a fresh one and invent a trend", () => {
  // entity_history only gains a row when the entity moved, so a real track
  // can jump straight from "before a long absence" to "after it". Read whole
  // (first altitude vs. last altitude, ignoring the gap) this track is a
  // steep *descent*, 5000 m down to 1500 m -- but the descent is old, and the
  // aircraft has been *climbing*, contiguously, ever since it reappeared.
  const points = track(
    [5000, 0],     // old fix, long before the gap
    [1000, 60],    // old fix, long before the gap
    // ...a gap of 1340s here, well past VERTICAL_TREND_MAX_GAP_SECONDS...
    [1000, 1400],  // reappears
    [1200, 1460],
    [1500, 1520],  // latest
  );
  assert.equal(verticalTrend(points), "climbing");
});

test("fixes older than the recency window do not count even without a single large gap", () => {
  // Every consecutive gap here is a small, ordinary 60s -- no single jump
  // trips the max-gap check -- but the whole track spans 3000s, well past
  // VERTICAL_TREND_MAX_GAP_SECONDS (1200s). Only the recent portion (a climb)
  // should count, not the older portion (a steep descent) diluting it into a
  // net descent.
  const points = [];
  for (let ts = 0; ts <= 1800; ts += 60) points.push({ altitude: 5000 - (ts / 1800) * 4000, ts }); // 5000 -> 1000
  for (let ts = 1860; ts <= 3000; ts += 60) points.push({ altitude: 1000 + ((ts - 1800) / 1200) * 500, ts }); // 1000 -> 1500
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

test("origin_country renders unconditionally, even when the hex lookup has not resolved anything", () => {
  // icao_blocks.py's registry is a no-op until its own first download lands
  // (see backend/sources/adsb.py's _attach_hex_allocation), so hex_country
  // being absent is an ordinary, common state, not an edge case -- OpenSky's
  // own claim must not disappear along with it.
  const { detail } = decorateAdsb({ ...AIRCRAFT, origin_country: "France", hex_country: undefined, hex_block: undefined, hex_military: undefined }, {});
  assert.match(detail, /Origin country per the feed:.*France/);
  assert.doesNotMatch(detail, /ICAO address allocation/); // icaoHexDetail correctly has nothing to add here
});

test("a missing origin_country says so rather than rendering a blank", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, origin_country: undefined }, {});
  assert.match(detail, /Origin country: not stated by the feed/);
});

test("a military role is named and marked best-effort, never stated as confirmed", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, military: true, callsign_military: true, military_role: "tanker" }, {});
  assert.match(detail, /Aerial refueling tanker/);
  assert.match(detail, /best-effort/);
});

test("a non-military classification is marked as a best-effort guess too, not stated as confirmed", () => {
  const { detail } = decorateAdsb(AIRCRAFT, {}); // category 4 -> "commercial", not military
  assert.match(detail, /Classification \(Commercial \/ airline\) is a best-effort guess/);
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

// Isolates the Flight now "Squawk:" row's own markup, so a substring shared
// with the generic reserved-codes list in AIRCRAFT_FLAG_NOTE.emergency (e.g.
// "7700 general emergency" appears there too, as context for all three codes,
// which is not the bug being guarded against) can't be mistaken for the
// specific per-aircraft repetition that is.
function squawkRow(detail) {
  return detail.match(/<div>Squawk:.*?<\/div>/s)?.[0] || "";
}

test("an emergency squawk's decoded label is stated once in the Emergency block with its caveat, and the Squawk row cross-references it instead of repeating it", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, squawk: "7700", emergency_squawk: "general emergency" }, {});
  assert.match(detail, /squawk 7700 &mdash; general emergency/); // the one specific claim about this aircraft
  assert.doesNotMatch(detail, /hijack/i); // this aircraft's code is 7700, not 7500
  assert.match(detail, /occasionally set by mistake/);
  assert.match(detail, /not a confirmed incident/);
  const row = squawkRow(detail);
  assert.match(row, /see Emergency, above/i);
  assert.doesNotMatch(row, /general emergency/); // not repeated here, caveat-free
});

test("a squawk with no backend-computed emergency field is still decoded client-side, once, with the caveat reaching it", () => {
  // Simulates an OpenSky-sourced record, which today carries no
  // emergency_squawk field at all (see backend/sources/adsb.py) -- the
  // client-side decodeSquawk call inside decorateAdsb has to catch this, and
  // the caveat has to reach it the same as any other emergency squawk.
  const { detail } = decorateAdsb({ ...AIRCRAFT, squawk: "7500", emergency_squawk: undefined }, {});
  assert.match(detail, /squawk 7500 &mdash; unlawful interference \(hijack\)/);
  assert.match(detail, /not a confirmed incident/);
  const row = squawkRow(detail);
  assert.match(row, /see Emergency, above/i);
  assert.doesNotMatch(row, /hijack/i);
});

test("no altitude trend row appears at all while the aircraft is on the ground, even if selected", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, icao24: "onground1", on_ground: true }, { selectedIcao: "onground1" });
  assert.doesNotMatch(detail, /Vertical trend/);
});

test("an unselected aircraft carries no vertical trend row at all -- the fetch is per-selection, not per-aircraft", () => {
  const { detail } = decorateAdsb(AIRCRAFT, { selectedIcao: "some-other-aircraft" });
  assert.doesNotMatch(detail, /Vertical trend/);
});

test("a freshly selected aircraft says the track is loading, before the fetch resolves", () => {
  const { detail } = decorateAdsb({ ...AIRCRAFT, icao24: "freshcontact" }, { selectedIcao: "freshcontact" }); // track omitted
  assert.match(detail, /Vertical trend/);
  assert.match(detail, /recorded track loading/);
});

test("a selected aircraft whose track resolved to too little contiguous history says so, not loading", () => {
  const { detail } = decorateAdsb(
    { ...AIRCRAFT, icao24: "sparsetrack" },
    { selectedIcao: "sparsetrack", track: [] }
  );
  assert.match(detail, /not enough recently, contiguously recorded track to say/);
});

test("a selected aircraft with a real climbing track shows the derived trend", () => {
  const { detail } = decorateAdsb(
    { ...AIRCRAFT, icao24: "climbing1" },
    { selectedIcao: "climbing1", track: track([1000, 0], [1200, 60], [1500, 120]) }
  );
  assert.match(detail, /Vertical trend/);
  assert.match(detail, /<b>Climbing<\/b>/);
  assert.match(detail, /derived from this aircraft's recorded track/);
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
