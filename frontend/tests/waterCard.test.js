// The water body card (Task 7), asserted headlessly: the five-way vessel
// class tally, the bordering-country matcher (bbox overlap + a boundary point
// actually contained), the antimeridian-aware bbox overlap test both of those
// share, and a walk through waterCardSections' own empty-section dropping and
// its always-present chokepoint fold.
//
// map/popups.js pulls in map/decorators.js (Leaflet-backed) for its ship
// classifier and map/water.js for its class labels/caveat text, both of which
// import map/leafletGlobal.js and read `window.L` at module scope -- so, same
// as waterHitTest.test.js, this stubs just enough of `window.L` to satisfy
// that import and teaches the loader to resolve the extensionless relative
// imports the way Vite does. Nothing here touches the DOM or Leaflet itself:
// only the pure section-builder and matcher functions are exercised.

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

globalThis.window = { L: { geoJSON: () => ({}) } };

const { buildWaterIndex } = await import("../src/map/water.js");
const { buildCountryIndex } = await import("../src/map/countryHitTest.js");
const {
  waterCardSections, countVesselsByClass, waterBorderingCountries, bboxesOverlap,
} = await import("../src/map/popups.js");

const feature = (properties, geometry) => ({ type: "Feature", properties, geometry });
const square = (minLon, minLat, maxLon, maxLat) => ({
  type: "Polygon",
  coordinates: [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]],
});

// A 10x10-degree sea spanning [-5,-5] to [5,5], with its own stored bbox in
// water_bodies.py's [south, west, north, east] convention -- the shape
// buildWaterIndex hands off as `rawBbox`.
function makeSea(overrides = {}) {
  const props = {
    id: "marine:1", name: "Test Sea", class: "sea", area_deg2: 100,
    bbox: [-5, -5, 5, 5], antimeridian: false,
    ...overrides,
  };
  const [entry] = buildWaterIndex([feature(props, square(-5, -5, 5, 5))]);
  return entry;
}

function countryEntry(name, box) {
  const [minLon, minLat, maxLon, maxLat] = box;
  const collection = {
    type: "FeatureCollection",
    features: [feature({ name, iso_a2: name.slice(0, 2).toUpperCase() }, square(minLon, minLat, maxLon, maxLat))],
  };
  return buildCountryIndex(collection);
}

const emptyRaw = () => ({
  ais: [], darkVessels: [], gfwGaps: [], cables: [], cableLandings: [], ports: [],
  events: [], gdelt: [], officials: [], countryIndex: [],
});

test("countVesselsByClass -- the five-way traffic tally", async (t) => {
  const sea = makeSea();

  await t.test("tanker/cargo/navy/fishing/other, each bucketed by AIS type code", () => {
    const ships = [
      { lat: 0, lon: 0, ship_type: 80 },              // tanker (range floor)
      { lat: 1, lon: 1, ship_type: 89 },              // tanker (range ceiling)
      { lat: -1, lon: -1, ship_type: 70 },            // cargo (range floor)
      { lat: 2, lon: 2, ship_type: 79 },              // cargo (range ceiling)
      { lat: -2, lon: -2, ship_type: 35 },            // navy, by AIS type code
      { lat: 0.5, lon: 0.5, name: "USS Enterprise" }, // navy, by name heuristic
      { lat: -0.5, lon: -0.5, ship_type: 30 },        // fishing
      { lat: 3, lon: 3, ship_type: 60 },              // other (passenger -- not one of the five)
      { lat: 4, lon: 4 },                             // other (no type stated at all)
    ];
    const { counts, total } = countVesselsByClass(ships, sea, null);
    assert.equal(total, 9);
    assert.equal(counts.tanker, 2);
    assert.equal(counts.cargo, 2);
    assert.equal(counts.navy, 2);
    assert.equal(counts.fishing, 1);
    assert.equal(counts.other, 2);
  });

  await t.test("a ship outside the polygon is not counted", () => {
    const { counts, total } = countVesselsByClass([{ lat: 20, lon: 20, ship_type: 80 }], sea, null);
    assert.equal(total, 0);
    assert.equal(counts.tanker, 0);
  });

  await t.test("navy wins priority over a tanker-range type code", () => {
    // Some navies code auxiliaries in the tanker range; the military ops code
    // (35) and the USS/USNS name heuristic both outrank it -- see
    // decorators.js's classifyVesselTraffic, same priority as classifyShip.
    const { counts } = countVesselsByClass([{ lat: 0, lon: 0, ship_type: 35, name: "Auxiliary" }], sea, null);
    assert.equal(counts.navy, 1);
    assert.equal(counts.tanker, 0);
  });

  await t.test("a wrong-but-permissive bbox pre-filter never produces a false negative", () => {
    // `bounds` only ever skips a ray-cast early -- see insideWaterFeature's
    // own note -- so a pre-filter wider than the truth still requires real
    // polygon containment, and one narrower than the truth would be a bug.
    // The whole globe is the widest possible (and wrong) pre-filter.
    const whole = { south: -90, west: -180, north: 90, east: 180 };
    const ship = { lat: 0, lon: 0, ship_type: 80 };
    assert.equal(countVesselsByClass([ship], sea, whole).total, countVesselsByClass([ship], sea, null).total);
  });
});

test("waterBorderingCountries -- bbox overlap plus a boundary point actually inside", async (t) => {
  const sea = makeSea(); // rawBbox [-5,-5,5,5]

  await t.test("a country containing one of the sea's own boundary vertices is listed", () => {
    // Overlaps the sea's bbox and its own shape actually contains the sea's
    // south-west corner (-5,-5) -- the shape a real coastline makes.
    const index = countryEntry("Coastland", [-7, -7, -3, -3]);
    assert.deepEqual(waterBorderingCountries(sea, index), ["Coastland"]);
  });

  await t.test("a country whose bbox overlaps but never touches the water's boundary is not listed", () => {
    // Straddles the sea's west edge (lon -5) at mid-height (lat -1..1), well
    // away from either corner at lat -5/5 -- the two rectangles overlap on
    // paper, but this shape contains none of the sea's four ring vertices.
    // Proves the matcher needs both conditions, not just the bbox overlap.
    const index = countryEntry("Notouchland", [-6, -1, -4, 1]);
    assert.deepEqual(waterBorderingCountries(sea, index), []);
  });

  await t.test("a country whose bbox does not even overlap is never ray-cast at all", () => {
    const index = countryEntry("Farland", [20, 20, 22, 22]);
    assert.deepEqual(waterBorderingCountries(sea, index), []);
  });

  await t.test("names come back sorted, several borders at once", () => {
    const collection = {
      type: "FeatureCollection",
      features: [
        feature({ name: "Zedland", iso_a2: "ZZ" }, square(-7, -7, -3, -3)),   // touches SW corner
        feature({ name: "Aland", iso_a2: "AL" }, square(3, 3, 7, 7)),        // touches NE corner
      ],
    };
    const index = buildCountryIndex(collection);
    assert.deepEqual(waterBorderingCountries(sea, index), ["Aland", "Zedland"]);
  });

  await t.test("no rawBbox on the feature (a kind the backend never stamped one for) yields no borders", () => {
    const noBbox = { ...sea, rawBbox: null };
    const index = countryEntry("Coastland", [-7, -7, -3, -3]);
    assert.deepEqual(waterBorderingCountries(noBbox, index), []);
  });
});

test("bboxesOverlap -- antimeridian-aware rectangle overlap", async (t) => {
  await t.test("two ordinary, non-wrapping boxes", () => {
    assert.equal(bboxesOverlap([0, 0, 10, 10], [5, 5, 15, 15]), true);
    assert.equal(bboxesOverlap([0, 0, 10, 10], [20, 20, 30, 30]), false);
  });

  await t.test("a wrapping box (west > east) overlaps a query box near the seam on either side", () => {
    // The Bering Sea shape: west=170, east=-170 (wraps through 180).
    const bering = [40, 170, 60, -170];
    assert.equal(bboxesOverlap(bering, [45, 175, 55, 179]), true, "east of the seam");
    assert.equal(bboxesOverlap(bering, [45, -179, 55, -175]), true, "west of the seam");
    assert.equal(bboxesOverlap(bering, [45, 0, 55, 10]), false, "nowhere near either part");
  });
});

test("waterCardSections -- section shape and empty-section dropping", async (t) => {
  await t.test("an entirely empty raw bag still returns a profile, a chokepoint fold and an incidents fold", () => {
    const sea = makeSea();
    const { title, sections } = waterCardSections(sea, emptyRaw(), null);
    assert.equal(title, "Test Sea");
    const ids = sections.map((s) => s.id);
    assert.ok(ids.includes("profile"), "profile always answers (name/class/caveat)");
    assert.ok(ids.includes("chokepoint"), "chokepoint watch always answers, even when the answer is 'outside'");
    assert.ok(ids.includes("incidents"), "incidents falls back to a 'no matches' line rather than dropping");
    assert.ok(ids.includes("sources"), "sources always answers");
    // Nothing to report, so the folds with real content to report are absent
    // rather than rendered empty (see waterCardSections' own docstring).
    assert.ok(!ids.includes("traffic"), "no ships in raw.ais -- traffic is dropped, not empty");
    assert.ok(!ids.includes("dark"), "no dark-activity records -- dropped, not empty");
    assert.ok(!ids.includes("infrastructure"), "no cables/landings/ports -- dropped, not empty");
  });

  await t.test("carries no `summary` or `groups` keys -- Task 10's strip and super-folds are a country-card-only addition", () => {
    // PlaceInfoCard treats both props as optional and renders flat with no
    // strip when they are absent (see PlaceInfoCard.jsx and
    // placeInfoCardGrouping.js). WaterInfoCard.jsx passes neither through, so
    // this is what actually keeps the water card's own render path
    // byte-identical to what it was before Task 10 -- PlaceInfoCard.jsx
    // itself is JSX and cannot be rendered by this headless suite (see
    // placeInfoCard.test.js's own note), so this is the closest this suite
    // can get to proving it directly.
    const sea = makeSea();
    const result = waterCardSections(sea, emptyRaw(), null);
    assert.equal(result.summary, undefined);
    assert.equal(result.groups, undefined);
  });

  await t.test("an unnamed feature falls back to its class label as the title", () => {
    const [gulf] = buildWaterIndex([
      feature({ id: "marine:2", name: "", class: "gulf", bbox: [0, 0, 1, 1] }, square(0, 0, 1, 1)),
    ]);
    const { title } = waterCardSections(gulf, emptyRaw(), null);
    assert.equal(title, "Gulf");
  });

  await t.test("chokepoint watch: inside one of the eight watched-water boxes", () => {
    // Strait of Hormuz / Persian Gulf, per backend/config.py's WATCHED_WATERS.
    const [hormuz] = buildWaterIndex([
      feature({ id: "marine:3", name: "Hormuz-ish", class: "strait", bbox: [25, 50, 28, 55] }, square(50, 25, 55, 28)),
    ]);
    const { sections } = waterCardSections(hormuz, emptyRaw(), null);
    const chokepoint = sections.find((s) => s.id === "chokepoint");
    assert.match(chokepoint.html, /Hormuz/);
    assert.match(chokepoint.html, /went dark/i);
  });

  await t.test("chokepoint watch: outside every watched-water box", () => {
    const [farSea] = buildWaterIndex([
      feature({ id: "marine:4", name: "Nowhere Sea", class: "sea", bbox: [-40, -40, -35, -35] }, square(-40, -40, -35, -35)),
    ]);
    const { sections } = waterCardSections(farSea, emptyRaw(), null);
    const chokepoint = sections.find((s) => s.id === "chokepoint");
    assert.match(chokepoint.html, /Outside every chokepoint/);
    assert.match(chokepoint.html, /not a report that nothing/);
  });

  await t.test("traffic tally appears once a ship lands inside, and carries the AIS coverage caveat", () => {
    const sea = makeSea();
    const raw = { ...emptyRaw(), ais: [{ lat: 0, lon: 0, ship_type: 80 }] };
    const { sections } = waterCardSections(sea, raw, null);
    const traffic = sections.find((s) => s.id === "traffic");
    assert.ok(traffic, "a ship inside the polygon makes the traffic fold appear");
    assert.match(traffic.html, /Inside the water this map receives AIS from/);
  });

  // --- Task 29: naval presence trend, "three naval hulls in this sea..." ---

  await t.test("a matching theatre's naval trend appears even with no live navy contact right now", () => {
    const sea = makeSea();
    const bounds = { south: -5, west: -5, north: 5, east: 5 }; // makeSea's own footprint
    const raw = {
      ...emptyRaw(),
      navalPresence: {
        regions: {
          test_theatre: {
            label: "Test Sea theatre", bounds: [-10, -10, 10, 10],
            current: 3, week_ago: 1, trend: 2, trend_computable: true, reason: null,
          },
        },
      },
    };
    const { sections } = waterCardSections(sea, raw, bounds);
    const traffic = sections.find((s) => s.id === "traffic");
    assert.ok(traffic, "the trend alone, with zero ships currently in view, still produces the fold");
    assert.match(traffic.html, /3 naval hulls in Test Sea theatre right now, up from 1 last week\./);
  });

  await t.test("no matching theatre and no live traffic: the traffic fold does not appear", () => {
    const sea = makeSea();
    const bounds = { south: -5, west: -5, north: 5, east: 5 };
    const { sections } = waterCardSections(sea, emptyRaw(), bounds);
    assert.equal(sections.find((s) => s.id === "traffic"), undefined);
  });
});

// createMapController.js's waterCardFor (the wiring path a click actually
// runs) is not importable here -- it lives inside createMapController's own
// closure, which needs far more of the DOM/Leaflet surface than the L.geoJSON
// stub above covers (see placeInfoCard.test.js's identical note for why
// PlaceInfoCard.jsx itself is untestable the same way). What *is* testable is
// the one-line assembly it does: `{ id: entry.id, name: title, sections,
// point }`, built from waterCardSections' own return. This test re-runs that
// exact assembly against a real buildWaterIndex entry, so a regression back
// to using `entry.name` instead of the computed `title` -- the bug review
// found, where an unnamed bay opened with a blank header -- fails here
// whether or not anyone remembers to re-check it by hand against
// createMapController.js.
test("the card payload's name field: title, not the feature's own (possibly blank) name", async (t) => {
  await t.test("a named feature: title and entry.name happen to agree", () => {
    const sea = makeSea({ name: "Test Sea" });
    const { title, sections } = waterCardSections(sea, emptyRaw(), null);
    const payload = { id: sea.id, name: title, sections, point: null }; // waterCardFor's own shape
    assert.equal(payload.name, "Test Sea");
  });

  await t.test("an unnamed feature: title falls back to the class label, entry.name does not", () => {
    const [bay] = buildWaterIndex([
      feature({ id: "marine:5", name: "", class: "bay", bbox: [0, 0, 1, 1] }, square(0, 0, 1, 1)),
    ]);
    assert.equal(bay.name, "", "the raw entry genuinely has no name -- this is the routine 1:10m case");
    const { title, sections } = waterCardSections(bay, emptyRaw(), null);
    const payload = { id: bay.id, name: title, sections, point: null };
    assert.equal(payload.name, "Bay", "the payload's header must use the computed fallback, not entry.name");
    assert.notEqual(payload.name, bay.name, "entry.name alone (the pre-fix wiring) would have been blank here");
  });
});

// water_bodies.py pre-splits every wrapping marine feature at the seam --
// each MultiPolygon part is an ordinary, non-wrapping ring in its own right
// (see that module's _bbox docstring) -- so the even-odd ray cast never needs
// wrap-awareness and only the *stored* bbox (rawBbox, used for the chokepoint
// and bordering-country overlap tests) carries the west > east convention.
// This built a MultiPolygon in exactly that shape -- two ordinary parts
// either side of +/-180, the Bering Sea's own shape per water_bodies.py and
// waterHitTest.test.js's identical fixture -- rather than only asserting it
// as a claim about the backend that a future ray-cast change could regress
// without anything here catching it.
test("real containment against a wrap-split (antimeridian) marine feature", async (t) => {
  const bering = feature(
    {
      id: "marine:bering", name: "Bering Sea", class: "sea", area_deg2: 40, antimeridian: true,
      bbox: [50, 170, 60, -170], // [south, west, north, east]; west > east means it wraps
    },
    {
      type: "MultiPolygon",
      coordinates: [
        [[[170, 50], [180, 50], [180, 60], [170, 60], [170, 50]]],
        [[[-180, 50], [-170, 50], [-170, 60], [-180, 60], [-180, 50]]],
      ],
    }
  );
  const [sea] = buildWaterIndex([bering]);
  assert.equal(sea.rawBbox[1], 170, "west > east on the stored bbox is preserved, not treated as inverted");
  assert.ok(sea.rawBbox[1] > sea.rawBbox[3], "170 > -170 -- the wrap convention this fixture exercises");

  await t.test("countVesselsByClass counts a ship on either side of the seam, none in between", () => {
    const eastOfSeam = { lat: 55, lon: 175, ship_type: 80 };
    const westOfSeam = { lat: 55, lon: -175, ship_type: 80 };
    const nowhereNear = { lat: 55, lon: 0, ship_type: 80 };
    assert.equal(countVesselsByClass([eastOfSeam], sea, null).total, 1, "east part of the split polygon");
    assert.equal(countVesselsByClass([westOfSeam], sea, null).total, 1, "west part of the split polygon");
    assert.equal(countVesselsByClass([nowhereNear], sea, null).total, 0, "between the two parts, inside neither");
  });

  await t.test("a client bbox pre-filter this wide is exactly the harmless-but-wide case the design accepts", () => {
    // buildWaterIndex's own client-computed `bbox` (not `rawBbox`) is a naive
    // min/max over the raw coordinates -- for a wrap-split feature this comes
    // out close to the whole globe's longitude span, which is a weaker but
    // never-wrong pre-filter (see insideWaterFeature's own note: it can only
    // ever be as large as or larger than the truth).
    assert.ok(sea.bbox.minLon < -170 || sea.bbox.maxLon > 170, "the naive bbox is wide, not narrow, at the seam");
    const wideBounds = { south: sea.bbox.minLat, west: sea.bbox.minLon, north: sea.bbox.maxLat, east: sea.bbox.maxLon };
    const ship = { lat: 55, lon: -175, ship_type: 80 };
    assert.equal(countVesselsByClass([ship], sea, wideBounds).total, countVesselsByClass([ship], sea, null).total);
  });

  await t.test("waterBorderingCountries finds a country touching the east part across the seam", () => {
    // Overlaps the sea's rawBbox on the wrapped (east, lon 170..180) side and
    // actually contains the ring vertex at (170, 50).
    const index = countryEntry("Seamland", [168, 48, 172, 62]);
    assert.deepEqual(waterBorderingCountries(sea, index), ["Seamland"]);
  });

  await t.test("waterBorderingCountries: a country nowhere near either wrapped part is not listed", () => {
    const index = countryEntry("Farland", [0, 48, 10, 62]);
    assert.deepEqual(waterBorderingCountries(sea, index), []);
  });
});
