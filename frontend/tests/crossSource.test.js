// One thing in two feeds, asserted.
//
// This fails silently in both directions and neither direction produces an
// error. Match too little and the map keeps drawing an air base twice, which is
// what it did. Match too much and a real second airfield disappears -- and
// because the absorbed record is only ever named on the pin that absorbed it,
// an over-eager match is a record no reader can reach.
//
// map/crossSource.js imports nothing, which is what lets this run under
// `node --test` -- the same constraint scene.test.js documents.

import test from "node:test";
import assert from "node:assert/strict";

import {
  AIRFIELD_MATCH_KM, DAM_MATCH_KM, MILITARY_TWIN_MAX_KM,
  buildTwinIndex, buildDeclaredTwinIndex, buildAbsorbedArticles,
  distanceKm, normalizeArticleUrl,
} from "../src/map/crossSource.js";

const byId = (r) => r.id;
const airfields = { radiusKm: AIRFIELD_MATCH_KM, primaryId: byId, secondaryId: byId };

test("distance is symmetric and roughly right", () => {
  // One degree of latitude is ~111 km anywhere.
  assert.ok(Math.abs(distanceKm(0, 0, 1, 0) - 111.32) < 0.01);
  // One degree of longitude at 60N is half of one at the equator.
  assert.ok(Math.abs(distanceKm(60, 0, 60, 1) - 55.66) < 0.5);
  assert.equal(distanceKm(10, 20, 11, 21).toFixed(6), distanceKm(11, 21, 10, 20).toFixed(6));
});

test("the same airfield in both feeds becomes one pin that names the other", () => {
  const ourairports = [{ id: "OAMS", lat: 30.758, lon: 72.283, name: "Rafiqui Air Base" }];
  // The same base as OSM records it: different name, 400 m away.
  const osm = [{ id: "osm:1", lat: 30.7616, lon: 72.283, name: "Rafiqui Air Base" }];
  const { twinOf, absorbed } = buildTwinIndex(ourairports, osm, airfields);
  assert.equal(twinOf.get("OAMS").record.id, "osm:1");
  assert.ok(twinOf.get("OAMS").distanceKm < 0.5);
  assert.ok(absorbed.has("osm:1"));
  assert.equal(absorbed.get("osm:1").primaryKey, "OAMS");
});

test("names in different scripts still match, because matching is by distance", () => {
  const ourairports = [{ id: "RKJM", lat: 34.759, lon: 126.38, name: "Mokpo Air Base" }];
  const osm = [{ id: "osm:2", lat: 34.7593, lon: 126.3803, name: "목포공항" }];
  const { twinOf } = buildTwinIndex(ourairports, osm, airfields);
  assert.equal(twinOf.get("RKJM").record.id, "osm:2");
});

test("a genuinely separate airfield keeps its own pin", () => {
  const ourairports = [{ id: "A", lat: 30.0, lon: 70.0 }];
  // 5.5 km north -- outside the radius, so this is a different place.
  const osm = [{ id: "osm:far", lat: 30.05, lon: 70.0 }];
  const { twinOf, absorbed } = buildTwinIndex(ourairports, osm, airfields);
  assert.equal(twinOf.size, 0);
  assert.equal(absorbed.size, 0);
});

test("a secondary between two primaries is absorbed by the nearer one", () => {
  const primary = [
    { id: "near", lat: 30.0, lon: 70.0 },
    { id: "far", lat: 30.012, lon: 70.0 }, // ~1.3 km away
  ];
  const osm = [{ id: "osm:mid", lat: 30.003, lon: 70.0 }]; // ~330 m from "near"
  const { twinOf, absorbed } = buildTwinIndex(primary, osm, airfields);
  assert.equal(absorbed.get("osm:mid").primaryKey, "near");
  assert.equal(twinOf.has("far"), false);
});

test("two secondaries onto one primary absorb only the nearer -- the other keeps its pin", () => {
  // The rule that keeps this honest: an absorbed record is named on exactly one
  // surviving popup, so a record that would have nowhere to be named is not
  // absorbed at all.
  const primary = [{ id: "base", lat: 30.0, lon: 70.0 }];
  const osm = [
    { id: "osm:close", lat: 30.001, lon: 70.0 },
    { id: "osm:alsoclose", lat: 30.008, lon: 70.0 },
  ];
  const { twinOf, absorbed } = buildTwinIndex(primary, osm, airfields);
  assert.equal(twinOf.get("base").record.id, "osm:close");
  assert.equal(absorbed.size, 1);
  assert.equal(absorbed.has("osm:alsoclose"), false);
});

test("matching works at high latitude, where a lon/lat grid stops finding pairs", () => {
  // 70N, where a degree of longitude is 38 km. A pair 500 m apart in longitude
  // is 0.013 degrees, well over the 0.018-degree band a 2 km cell would use --
  // this is the case a square-cell index silently misses.
  const primary = [{ id: "north", lat: 69.98, lon: 20.0 }];
  const osm = [{ id: "osm:north", lat: 69.98, lon: 20.013 }];
  const { absorbed } = buildTwinIndex(primary, osm, airfields);
  assert.equal(absorbed.get("osm:north").primaryKey, "north");
});

test("records with no usable coordinates are skipped, not crashed on", () => {
  const primary = [{ id: "ok", lat: 30, lon: 70 }, { id: "bad", lat: null, lon: undefined }];
  const osm = [{ id: "osm:bad", lat: "not a number", lon: 70 }, { id: "osm:ok", lat: 30.001, lon: 70 }];
  const { absorbed } = buildTwinIndex(primary, osm, airfields);
  assert.deepEqual([...absorbed.keys()], ["osm:ok"]);
});

test("a dam and its powerhouse pair on the tighter radius", () => {
  const dams = [{ id: "gdw:1", lat: 41.9, lon: 126.0, name: "Baishan" }];
  const plants = [{ id: "osm:9", lat: 41.9026, lon: 126.0, name: "白山水电站", output_mw: 1500 }];
  const options = { radiusKm: DAM_MATCH_KM, primaryId: byId, secondaryId: byId };
  assert.equal(buildTwinIndex(dams, plants, options).twinOf.get("gdw:1").record.output_mw, 1500);
  // 1.5 km apart is two structures, not one.
  const distant = [{ id: "osm:10", lat: 41.9135, lon: 126.0 }];
  assert.equal(buildTwinIndex(dams, distant, options).absorbed.size, 0);
});

test("article URLs normalise to what identifies the article", () => {
  const canonical = "npr.org/2026/08/07/nx-s1-5924914/senate-passes-russia-sanctions";
  assert.equal(normalizeArticleUrl("https://www.npr.org/2026/08/07/nx-s1-5924914/senate-passes-russia-sanctions"), canonical);
  assert.equal(normalizeArticleUrl("http://NPR.org/2026/08/07/nx-s1-5924914/senate-passes-russia-sanctions/"), canonical);
  assert.equal(normalizeArticleUrl("https://npr.org/2026/08/07/nx-s1-5924914/senate-passes-russia-sanctions?utm_source=x&fbclid=y#top"), canonical);
  // A query that identifies the article is kept, because plenty of sites still
  // serve one that way.
  assert.equal(normalizeArticleUrl("https://example.com/news?id=42"), "example.com/news?id=42");
  // Nothing usable returns "", which callers must not treat as a key.
  for (const bad of ["", "   ", null, undefined, 42, "not a url", "ftp://example.com/x"]) {
    assert.equal(normalizeArticleUrl(bad), "");
  }
});

test("an article absorbed under one GDELT id is caught under its siblings' URL", () => {
  // The live failure this exists for: GDELT emits one event row per actor pair,
  // so Officials absorbs id 111 and names it, and the News layer then draws id
  // 222 -- the same article, the same headline, a second pin.
  const officials = [{
    id: "gdelt:111",
    coverage_event_ids: ["111"],
    url: "https://www.example.com/article?utm_source=feed",
  }];
  const { ids, urls } = buildAbsorbedArticles([[], officials]);
  assert.ok(ids.has("111"));
  assert.equal(urls.has(normalizeArticleUrl("https://example.com/article/")), true);
  assert.equal(ids.has("222"), false);
});

test("a record with neither coverage ids nor a URL contributes nothing", () => {
  const { ids, urls } = buildAbsorbedArticles([[{ id: "x" }], null, undefined]);
  assert.equal(ids.size, 0);
  assert.equal(urls.size, 0);
});

// ---------- curated military bases against OpenStreetMap ----------
//
// The pair this module was written for and was never pointed at. A curated base is
// named in English and rides the `infra` layer; OSM's record of the same
// installation is named in the local script and rides `osmInfra`; nothing matched
// them, so a reader in Israel got two pins for one base.
//
// Matched by declaration rather than by distance, which is the opposite of the
// airfield rule ten lines up, so these tests are mostly about why: `military_area`
// is dense enough that nearest-neighbour is wrong about half the time, and each
// wrong answer erases a distinct place rather than deduplicating one.

const PALMACHIM = { id: "palmachim_ab", type: "military", lat: 31.89, lon: 34.69,
  osm_twin: "osm:way/292210998" };
const PALMACHIM_OSM = { id: "osm:way/292210998", kind: "military_area",
  name: "בסיס חיל האוויר פלמחים", lat: 31.8996, lon: 34.6825 };

const declared = {
  declaredId: (d) => d.osm_twin,
  primaryId: (d) => d.id,
  secondaryId: (d) => d.id,
  maxKm: MILITARY_TWIN_MAX_KM,
};

test("a curated base absorbs the OpenStreetMap record it names", () => {
  const { twinOf, absorbed } = buildDeclaredTwinIndex([PALMACHIM], [PALMACHIM_OSM], declared);
  assert.equal(absorbed.size, 1, "the OSM pin should be suppressed");
  assert.equal(absorbed.get("osm:way/292210998").primaryKey, "palmachim_ab");
  // The surviving pin carries the absorbed record, which is what lets the popup
  // print the Hebrew name beside the English one -- one pin, both names.
  assert.equal(twinOf.get("palmachim_ab").record.id, "osm:way/292210998");
  assert.match(twinOf.get("palmachim_ab").record.name, /פלמחים/);
});

test("the nearer OSM record does not win -- only the declared one does", () => {
  // The measured failure, in miniature. Novorossiysk's nearest `military_area` is a
  // gatehouse tagged "КПП" at 2.1 km; the base's own polygon is at 4.0 km. Distance
  // matching absorbs the gate and leaves the base drawn twice, which is both
  // duplicates kept and a distinct place lost.
  const base = { id: "novorossiysk_naval", type: "military", lat: 44.71, lon: 37.78,
    osm_twin: "osm:way/233225970" };
  const gate = { id: "osm:way/410012782", kind: "military_area", name: "КПП",
    lat: 44.729, lon: 37.782 };
  const real = { id: "osm:way/233225970", kind: "military_area",
    name: "Новороссийская военно-морская база",
    lat: 44.674, lon: 37.79 };
  assert.ok(
    distanceKm(base.lat, base.lon, gate.lat, gate.lon)
      < distanceKm(base.lat, base.lon, real.lat, real.lon),
    "the fixture has to have the wrong record nearer, or this proves nothing",
  );
  const { twinOf, absorbed } = buildDeclaredTwinIndex([base], [gate, real], declared);
  assert.equal(twinOf.get("novorossiysk_naval").record.id, "osm:way/233225970");
  assert.ok(!absorbed.has("osm:way/410012782"), "the gatehouse keeps its own pin");
});

test("a base that declares nothing absorbs nothing", () => {
  // Most of the curated list, and correct: OSM has no polygon for them. The
  // fallback has to be "draw as before", never "guess".
  const { twinOf, absorbed } = buildDeclaredTwinIndex(
    [{ id: "al_udeid_ab", type: "military", lat: 25.12, lon: 51.32 }],
    [{ id: "osm:way/1", kind: "military_barracks", name: "A7", lat: 25.13, lon: 51.33 }],
    declared,
  );
  assert.equal(twinOf.size, 0);
  assert.equal(absorbed.size, 0);
});

test("a declared id that is not in this payload is silently no match", () => {
  // The OSM sweep is per-theatre and viewport-filtered, so an id naming a record
  // outside the current payload is the common case, not an error.
  const { twinOf, absorbed } = buildDeclaredTwinIndex([PALMACHIM], [], declared);
  assert.equal(twinOf.size, 0);
  assert.equal(absorbed.size, 0);
});

test("a declared pair further apart than the sanity bound is refused", () => {
  // A mistyped id would otherwise merge two places on different continents, and
  // the popup would assert they are one installation. Drawing one pin twice is the
  // lesser wrong.
  const far = { ...PALMACHIM_OSM, lat: 52.5, lon: 13.4 };
  const { twinOf, absorbed } = buildDeclaredTwinIndex([PALMACHIM], [far], declared);
  assert.equal(twinOf.size, 0);
  assert.equal(absorbed.size, 0);
});

test("the bound clears the widest genuine pair with room to spare", () => {
  // Camp Arifjan's OSM polygon centre is 4.22 km from the curated point, the widest
  // measured genuine pair; Novorossiysk is 4.04. A bound tuned down to the tail
  // would start refusing real merges as OSM polygons get redrawn.
  assert.ok(MILITARY_TWIN_MAX_KM > 4.22, "would refuse Camp Arifjan");
  assert.ok(MILITARY_TWIN_MAX_KM <= 10, "wide enough to merge genuinely separate bases");
});

test("two bases naming one OSM record leave it absorbed once", () => {
  // A curation mistake rather than a data condition, but silently absorbing twice
  // would let the second claim overwrite the first, and then whichever pin was
  // suppressed depends on array order.
  const a = { ...PALMACHIM, id: "base_a" };
  const b = { ...PALMACHIM, id: "base_b" };
  const { twinOf, absorbed } = buildDeclaredTwinIndex([a, b], [PALMACHIM_OSM], declared);
  assert.equal(absorbed.size, 1);
  assert.equal(absorbed.get("osm:way/292210998").primaryKey, "base_a");
  assert.equal(twinOf.size, 1);
});
