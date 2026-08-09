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
});
