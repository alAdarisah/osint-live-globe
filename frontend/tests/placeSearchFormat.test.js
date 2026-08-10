// placeSearchFormat.js: the pure formatting/navigation half of the title
// bar's place-search dropdown (Task 34). PlaceSearch.jsx itself is JSX and
// not importable under plain `node --test` (see placeInfoCard.test.js's own
// note) -- these are the parts of it that are plain functions of the
// /api/places response shape, pulled out for exactly that reason.

import test from "node:test";
import assert from "node:assert/strict";

import {
  featureClassLabel,
  nextHighlightedIndex,
  placeResultTitle,
  placeResultSubtitle,
} from "../src/components/placeSearchFormat.js";

test("featureClassLabel", async (t) => {
  await t.test("spells out GeoNames' feature classes", () => {
    assert.equal(featureClassLabel("P"), "populated place");
    assert.equal(featureClassLabel("A"), "administrative area");
  });

  await t.test("falls back to the raw code for one it doesn't know", () => {
    assert.equal(featureClassLabel("Z"), "Z");
  });

  await t.test("falls back to a generic label when there is no code at all", () => {
    assert.equal(featureClassLabel(""), "place");
    assert.equal(featureClassLabel(undefined), "place");
  });
});

test("nextHighlightedIndex", async (t) => {
  await t.test("moving down from nothing highlighted lands on the first result", () => {
    assert.equal(nextHighlightedIndex(-1, 5, 1), 0);
  });

  await t.test("moving up from nothing highlighted lands on the last result", () => {
    assert.equal(nextHighlightedIndex(-1, 5, -1), 4);
  });

  await t.test("moving down past the last result wraps to the first", () => {
    assert.equal(nextHighlightedIndex(4, 5, 1), 0);
  });

  await t.test("moving up past the first result wraps to the last", () => {
    assert.equal(nextHighlightedIndex(0, 5, -1), 4);
  });

  await t.test("an ordinary step just moves by one", () => {
    assert.equal(nextHighlightedIndex(1, 5, 1), 2);
    assert.equal(nextHighlightedIndex(2, 5, -1), 1);
  });

  await t.test("an empty list never has anything highlighted", () => {
    assert.equal(nextHighlightedIndex(-1, 0, 1), -1);
    assert.equal(nextHighlightedIndex(0, 0, -1), -1);
  });
});

test("placeResultTitle", async (t) => {
  await t.test("names the place with its country and admin-1 code", () => {
    assert.equal(
      placeResultTitle({ name: "Kyiv", country_code: "UA", admin1: "30" }),
      "Kyiv (UA-30)"
    );
  });

  await t.test("falls back to just the country code when admin1 is blank", () => {
    assert.equal(placeResultTitle({ name: "Vatican City", country_code: "VA", admin1: "" }), "Vatican City (VA)");
  });

  await t.test("degrades to the bare name when there is no country code either", () => {
    assert.equal(placeResultTitle({ name: "Somewhere", country_code: "", admin1: "" }), "Somewhere");
  });
});

test("placeResultSubtitle", async (t) => {
  await t.test("shows the feature label and the population when there is one", () => {
    assert.equal(
      placeResultSubtitle({ feature_class: "P", population: 2797553 }),
      "populated place · pop. 2,797,553"
    );
  });

  await t.test("omits population rather than printing 'pop. 0' for an unstated figure", () => {
    // cities500 carries real zero-population administrative seats (an
    // administrative division with no census figure attached) -- "pop. 0"
    // would read as a measurement, not as "not stated".
    assert.equal(placeResultSubtitle({ feature_class: "A", population: 0 }), "administrative area");
  });

  await t.test("omits population when it is missing entirely", () => {
    assert.equal(placeResultSubtitle({ feature_class: "P" }), "populated place");
  });
});
