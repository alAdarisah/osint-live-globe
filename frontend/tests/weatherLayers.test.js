// Task 45: the four OWM tile layers this map never asked for before -- wind,
// precipitation, temperature and pressure -- alongside clouds_new, which
// already shipped. map/weatherLayers.js imports nothing (see its own header
// note), so it loads directly here the way map/countryHitTest.js does in
// shapeIndex.test.js.

import test from "node:test";
import assert from "node:assert/strict";

import { OWM_WEATHER_LAYERS, owmTileUrl, isOwmLayerDisabled } from "../src/map/weatherLayers.js";

// backend/app.py:_WEATHER_LAYERS is the allow-list the backend route actually
// enforces (weather_tile 404s anything outside it). This is that same set,
// copied here rather than imported (the frontend cannot import Python) so a
// registry entry drifting from what the backend will actually serve fails a
// test instead of failing silently as a 404 in production.
const BACKEND_ALLOW_LIST = new Set(["clouds_new", "wind_new", "precipitation_new", "temp_new", "pressure_new"]);

test("the registry has exactly the five layer ids the backend allows", () => {
  const owmIds = OWM_WEATHER_LAYERS.map((entry) => entry.owmId);
  assert.equal(owmIds.length, 5);
  assert.equal(new Set(owmIds).size, 5, "no duplicate owmId entries");
  for (const id of owmIds) assert.ok(BACKEND_ALLOW_LIST.has(id), `${id} is not in the backend's allow-list`);
  for (const id of BACKEND_ALLOW_LIST) assert.ok(owmIds.includes(id), `${id} from the backend allow-list is missing here`);
});

test("every registry entry has a distinct key, a label and a color", () => {
  const keys = OWM_WEATHER_LAYERS.map((entry) => entry.key);
  assert.equal(new Set(keys).size, keys.length, "no duplicate layer keys");
  for (const entry of OWM_WEATHER_LAYERS) {
    assert.equal(typeof entry.label, "string");
    assert.ok(entry.label.length > 0);
    assert.equal(typeof entry.color, "string");
    assert.ok(entry.color.startsWith("#"));
  }
});

test("clouds kept its pre-existing key so wishes/wiring saved under it still resolve", () => {
  const clouds = OWM_WEATHER_LAYERS.find((entry) => entry.owmId === "clouds_new");
  assert.equal(clouds.key, "clouds");
});

test("owmTileUrl builds the same path shape for every registered layer", () => {
  for (const { owmId } of OWM_WEATHER_LAYERS) {
    assert.equal(owmTileUrl(owmId), `/api/weather/tile/${owmId}/{z}/{x}/{y}.png`);
  }
});

test("owmTileUrl leaves Leaflet's own {z}/{x}/{y} placeholders unexpanded", () => {
  const url = owmTileUrl("wind_new");
  assert.ok(url.includes("{z}") && url.includes("{x}") && url.includes("{y}"));
});

test("every OWM-backed layer is disabled when no key is configured", () => {
  for (const { key } of OWM_WEATHER_LAYERS) {
    assert.equal(isOwmLayerDisabled(key, false), true, `${key} should be disabled with no OWM key`);
    assert.equal(isOwmLayerDisabled(key, true), false, `${key} should be enabled once a key is configured`);
  }
});

test("layers that don't touch OWM are never disabled by the OWM key state", () => {
  // RainViewer's precipitation radar and the Open-Meteo wind-arrow field
  // share the Weather section with the five OWM tiles but need no OWM key --
  // a reader with no key configured should still be able to use both.
  assert.equal(isOwmLayerDisabled("precip", false), false);
  assert.equal(isOwmLayerDisabled("windArrows", false), false);
  assert.equal(isOwmLayerDisabled("precip", true), false);
  assert.equal(isOwmLayerDisabled("windArrows", true), false);
});

test("an unknown key is never reported disabled", () => {
  assert.equal(isOwmLayerDisabled("notALayer", false), false);
});
