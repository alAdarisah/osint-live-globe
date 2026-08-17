// Where an event says it is, and how loosely.
//
// backend/sources/event_fusion.py measures 31.6% of the rows that pass its
// violence gate as placed to a national or regional centroid rather than to a
// locality. Every one of those was being filtered out of both the map and the
// Events tab by `showImprecise: false` -- a default whose only two controls live
// in Admin Mode, so a reader could neither see the rows nor discover that a third
// of the layer was missing.
//
// They are shown now, which puts the weight on the marking: a pin drawn at a
// national centroid with nothing to say so would be worse than hiding it.

import "./helpers/nodeTestEnv.js";

import test from "node:test";
import assert from "node:assert/strict";

const {
  DEFAULT_EVENT_FILTER,
  passesEventFilter,
  isImprecise,
  placementNote,
  IMPRECISE_PRECISIONS,
} = await import("../src/map/severity.js");

const AT_A_LOCALITY = { geo_precision: "locality", geo_radius_km: 15, severity: 50, date: null };
const AT_A_CENTROID = { geo_precision: "country", geo_radius_km: 400, severity: 50, date: null };
const AT_A_REGION = { geo_precision: "region", geo_radius_km: 120, severity: 50, date: null };

test("the shipped default shows centroid-placed events rather than hiding them", () => {
  // The reversal this file exists for. Asserted on the default object itself,
  // not on a filter built in the test, because the default is the decision.
  assert.equal(DEFAULT_EVENT_FILTER.showImprecise, true);
  assert.equal(passesEventFilter(AT_A_CENTROID, DEFAULT_EVENT_FILTER), true);
  assert.equal(passesEventFilter(AT_A_REGION, DEFAULT_EVENT_FILTER), true);
});

test("a reader who turns them off still gets that", () => {
  // The escape hatch has to keep working: showing them by default is a claim
  // about what is useful, not a claim that the distinction does not matter.
  const precise = { ...DEFAULT_EVENT_FILTER, showImprecise: false };
  assert.equal(passesEventFilter(AT_A_CENTROID, precise), false);
  assert.equal(passesEventFilter(AT_A_REGION, precise), false);
  assert.equal(passesEventFilter(AT_A_LOCALITY, precise), true);
});

test("every imprecise placement has words for what it is", () => {
  // A pin the reader can now see needs the list beside it to say what kind of
  // coordinate it has. Silence on any member of IMPRECISE_PRECISIONS would be a
  // row that looks exactly like a located one.
  for (const precision of IMPRECISE_PRECISIONS) {
    const note = placementNote({ geo_precision: precision, geo_radius_km: 400 });
    assert.ok(note && note.trim(), `${precision} has no placement note`);
  }
});

test("the note names the kind of coordinate and how much slack it carries", () => {
  // Both halves matter. The precision says what sort of coordinate it is; the
  // radius is the difference between a 15km locality and a 400km national
  // centroid, which "weakly placed" alone never distinguished.
  const country = placementNote(AT_A_CENTROID);
  assert.match(country, /country/i);
  assert.match(country, /400/);

  const region = placementNote(AT_A_REGION);
  assert.match(region, /region/i);
  assert.match(region, /120/);
});

test("a located event carries no qualifier at all", () => {
  // A caveat on every row is a caveat on none, and it would also make the
  // distinction unreadable in a list where a third of rows genuinely need one.
  assert.equal(placementNote(AT_A_LOCALITY), null);
  assert.equal(isImprecise(AT_A_LOCALITY), false);
  // A row with no geo_precision field is not in IMPRECISE_PRECISIONS, and that is
  // deliberate -- see isImprecise. It is not a claim of precision, it is the
  // absence of a claim, and inventing a caveat for it would be inventing data.
  assert.equal(placementNote({ severity: 50 }), null);
});

test("a missing radius degrades to the kind alone, not to a fake number", () => {
  // Older snapshots (/api/replay serves rows written before geo_radius_km) have
  // the precision and not the radius. Saying "country-level location" is honest;
  // printing "±0 km" or "±NaN km" would not be.
  const note = placementNote({ geo_precision: "country" });
  assert.match(note, /country/i);
  assert.doesNotMatch(note, /0 km|NaN|±/);

  assert.doesNotMatch(placementNote({ geo_precision: "region", geo_radius_km: 0 }), /±/);
  assert.doesNotMatch(placementNote({ geo_precision: "region", geo_radius_km: "wide" }), /±/);
});

test("a sub-10km radius keeps a decimal rather than rounding to a whole number", () => {
  // Same treatment the popup's own "could be up to N km away" gives it: 1.5km
  // rounded to 2km overstates the doubt, and to 1km understates it, on exactly
  // the radii where the difference is a neighbourhood.
  assert.match(placementNote({ geo_precision: "unknown", geo_radius_km: 1.5 }), /1\.5 km/);
  assert.match(placementNote({ geo_precision: "unknown", geo_radius_km: 42 }), /42 km/);
});
