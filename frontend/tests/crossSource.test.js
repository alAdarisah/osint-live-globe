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
  AIRFIELD_MATCH_KM, DAM_MATCH_KM, buildTwinIndex, buildAbsorbedArticles,
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
