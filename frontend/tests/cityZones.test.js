// City zones and the stack, asserted.
//
// Both are geometry-or-arithmetic with no DOM in them, and both fail silently
// when they are wrong: an over-wide zone merges two towns into one pin and the
// map simply shows one pin, while a layer that falls out of the stack draws
// unfaded on top of everything and looks like a styling choice. Neither produces
// an error.
//
// map/cityZones.js and map/iconTheme.js both import nothing, which is what lets
// this run under `node --test` -- the same constraint scene.test.js documents.

import test from "node:test";
import assert from "node:assert/strict";

import { buildCityZoneIndex, CITY_ZONE_RADIUS_M } from "../src/map/cityZones.js";
import {
  PIN_STACK, WASH_STACK, DEFAULT_STACK, DEFAULT_STACK_FADE_FLOOR, STACK_ALIAS,
  setIconTheme, stackFade, stackZIndex,
} from "../src/map/iconTheme.js";

// A stand-in for decorators.js's cityTier, which cannot be imported here (it
// pulls in Leaflet). Same thresholds; the test is about the index, not the tier.
const TIERS = [
  { key: "mega", min: 5_000_000 },
  { key: "large", min: 1_000_000 },
  { key: "medium", min: 250_000 },
  { key: "town", min: 0 },
];
const tierOf = (city) => TIERS.find((t) => (city.population || 0) >= t.min);
const keyOf = (city) => city.name;

function indexOf(cities, radiusScale = 1) {
  return buildCityZoneIndex(cities, { tierOf, keyOf, radiusScale });
}

// One degree of latitude is ~111km everywhere, so a north-south offset is the
// one displacement that needs no cosine correction to reason about.
const KM = 1 / 111.32;

test("a city zone", async (t) => {
  const kyiv = { name: "Kyiv", lat: 50.45, lon: 30.52, population: 2_900_000 };

  await t.test("contains a point inside its radius", () => {
    const { zoneAt } = indexOf([kyiv]);
    assert.equal(zoneAt(50.45, 30.52)?.key, "Kyiv");
    assert.equal(zoneAt(50.45 + 10 * KM, 30.52)?.key, "Kyiv"); // 10km, inside 15
  });

  await t.test("does not contain a point outside it", () => {
    const { zoneAt } = indexOf([kyiv]);
    assert.equal(zoneAt(50.45 + 20 * KM, 30.52), null); // 20km, outside 15
  });

  // The failure that loses information: two genuinely separate places drawn as
  // one. Worth an explicit case because it is what the conservative small-end
  // radii in CITY_ZONE_RADIUS_M are chosen to prevent.
  await t.test("does not reach a town 20km away", () => {
    const towns = [
      { name: "A", lat: 10, lon: 20, population: 150_000 },
      { name: "B", lat: 10 + 20 * KM, lon: 20, population: 150_000 },
    ];
    const { zoneAt } = indexOf(towns);
    assert.equal(zoneAt(10, 20)?.key, "A");
    assert.equal(zoneAt(10 + 20 * KM, 20)?.key, "B");
  });

  // Nesting is administrative, not two places being near each other, so the
  // larger zone is the one that names the group. GeoNames lists Kyiv's raions as
  // populated places of their own -- Shevchenkivskyi, Obolon, Pechersk and six
  // more, all inside Kyiv's 15km radius -- and under a smallest-wins rule a
  // night of strikes on Kyiv splits into eight groups captioned with
  // neighbourhood names. Regression-guarded because it took a live check over
  // Ukraine to notice, and nothing about it raises an error.
  await t.test("answers with the largest zone when they nest", () => {
    const cities = [
      { name: "Metropolis", lat: 0, lon: 0, population: 9_000_000 },   // 25km
      { name: "Innerburb", lat: 8 * KM, lon: 0, population: 150_000 }, // 5km, inside it
    ];
    const { zoneAt } = indexOf(cities);
    assert.equal(zoneAt(8 * KM, 0)?.key, "Metropolis");
    assert.equal(zoneAt(15 * KM, 0)?.key, "Metropolis");
  });

  // The other half of the same rule: a town far enough out to be its own place
  // never nests in the first place, so largest-wins cannot swallow it. Brovary
  // is the real case -- 109k people, 19.5km from Kyiv, outside its 15km radius.
  await t.test("leaves a town outside the big city's radius alone", () => {
    const cities = [
      { name: "Kyiv", lat: 50.45, lon: 30.52, population: 2_950_000 },  // 15km
      { name: "Brovary", lat: 50.45 + 19.5 * KM, lon: 30.52, population: 109_806 },
    ];
    const { zoneAt } = indexOf(cities);
    assert.equal(zoneAt(50.45 + 19.5 * KM, 30.52)?.key, "Brovary");
    assert.equal(zoneAt(50.45, 30.52)?.key, "Kyiv");
  });

  await t.test("scales with the configured multiplier", () => {
    const far = [50.45 + 20 * KM, 30.52];
    assert.equal(indexOf([kyiv], 1).zoneAt(...far), null);
    assert.equal(indexOf([kyiv], 2).zoneAt(...far)?.key, "Kyiv");
  });

  // A zone spanning a grid cell boundary is the case a naive single-cell lookup
  // gets wrong, and it is invisible when it happens: the point simply reports as
  // being in open country. Cells are 0.5 degrees, so a city at 30.0 has half its
  // radius in the cell below.
  await t.test("is found across a grid cell boundary", () => {
    const onBoundary = { name: "Edge", lat: 30.0, lon: 20.0, population: 9_000_000 };
    const { zoneAt } = indexOf([onBoundary]);
    assert.equal(zoneAt(30.0 - 20 * KM, 20.0)?.key, "Edge");
    assert.equal(zoneAt(30.0 + 20 * KM, 20.0)?.key, "Edge");
  });

  await t.test("ignores cities with no coordinate", () => {
    const { zones, zoneAt } = indexOf([{ name: "Nowhere", population: 500_000 }]);
    assert.equal(zones.length, 0);
    assert.equal(zoneAt(0, 0), null);
    assert.equal(zoneAt(undefined, undefined), null);
  });

  await t.test("takes its radius from the population band", () => {
    const cities = TIERS.map((tier, i) => ({
      name: tier.key, lat: i * 10, lon: 0, population: tier.min,
    }));
    const { zones } = indexOf(cities);
    for (const zone of zones) {
      assert.equal(zone.radiusM, CITY_ZONE_RADIUS_M[zone.key]);
    }
  });
});

test("the layer stack", async (t) => {
  t.afterEach(() => setIconTheme({ stack: DEFAULT_STACK, stackFadeFloor: DEFAULT_STACK_FADE_FLOOR }));

  await t.test("fades from the top of a group to its floor", () => {
    assert.equal(stackFade(PIN_STACK[0]), 1);
    assert.equal(
      Number(stackFade(PIN_STACK[PIN_STACK.length - 1]).toFixed(4)),
      DEFAULT_STACK_FADE_FLOOR
    );
  });

  // The washes are the background tier by construction -- canvases under every
  // pin -- so depth-fading them as well is a second mechanism saying what being
  // a canvas already says, and the two multiply. FIRMS proved it: shipped
  // deliberately faint at 0.3, bottom of the wash stack for another 0.55, drawn
  // at 0.165, which made its opacity slider look like a dead control.
  await t.test("never fades a wash, wherever it sits", () => {
    for (const key of WASH_STACK) assert.equal(stackFade(key), 1, key);
  });

  await t.test("switches the fade off at a floor of 1", () => {
    setIconTheme({ stackFadeFloor: 1 });
    for (const key of PIN_STACK) assert.equal(stackFade(key), 1);
  });

  await t.test("draws an earlier layer over a later one", () => {
    assert.ok(stackZIndex(PIN_STACK[0]) > stackZIndex(PIN_STACK[1]));
  });

  // The stride has to clear the per-icon size term applyStacking subtracts, or a
  // large icon sinks below a small one in the layer beneath it.
  await t.test("separates adjacent layers by more than any icon size", () => {
    const gap = stackZIndex(PIN_STACK[0]) - stackZIndex(PIN_STACK[1]);
    assert.ok(gap > 200, `layers are only ${gap} apart`);
  });

  await t.test("gives the keys that ride another layer that layer's place", () => {
    for (const [rider, host] of Object.entries(STACK_ALIAS)) {
      assert.equal(stackZIndex(rider), stackZIndex(host), `${rider} should ride ${host}`);
      assert.equal(stackFade(rider), stackFade(host));
    }
  });

  // The repair that matters: a stored order missing a layer must not leave that
  // layer rankless, which reads as unfaded and on top -- the one outcome a stack
  // is supposed to make impossible.
  await t.test("appends layers a stored order has never heard of", () => {
    setIconTheme({ stack: { pins: [PIN_STACK[3]], washes: [] } });
    assert.equal(stackFade(PIN_STACK[3]), 1, "the stored entry leads");
    for (const key of PIN_STACK) {
      assert.ok(stackFade(key) <= 1 && stackFade(key) >= DEFAULT_STACK_FADE_FLOOR, key);
      assert.ok(stackZIndex(key) > 0, `${key} has no place in the stack`);
    }
  });

  await t.test("drops keys it does not recognise", () => {
    setIconTheme({ stack: { pins: ["nonsense", ...PIN_STACK], washes: WASH_STACK } });
    assert.equal(stackZIndex("nonsense"), 0);
    assert.equal(stackFade(PIN_STACK[0]), 1, "the real layers close the gap");
  });

  await t.test("leaves the substrate unranked and unfaded", () => {
    assert.equal(stackFade("countries"), 1);
    assert.equal(stackZIndex("countries"), 0);
  });

  // Cities carry a graduated fade of their own (0.45 for a town, see CITY_TIERS),
  // so their depth fade multiplies with it. At the foot of the stack that put a
  // town at 25% and a capital at 55% -- two mechanisms both saying "recede".
  // Guarded because the compounding is invisible in either table on its own.
  await t.test("draws cities over the reference layers they give meaning to", () => {
    for (const key of ["infra", "osmInfra", "airports", "ports", "dams", "cables"]) {
      assert.ok(
        stackZIndex("cities") > stackZIndex(key),
        `cities should draw over ${key}`
      );
    }
    assert.ok(stackFade("cities") > 0.7, `cities fade is ${stackFade("cities")}`);
    // Still under everything that reports an event: a place is what those are
    // read against, not something that covers them.
    assert.ok(stackZIndex("cities") < stackZIndex("events"));
    assert.ok(stackZIndex("cities") < stackZIndex("czib"));
  });
});

// The gate and the tick are two controls in one panel, and they used to cancel
// each other. A wish beat the zoom gate outright, so "Shows from zoom" did
// nothing for any ticked layer -- and for the corroborating layers, which are
// only reachable *by* ticking them, it could never do anything at all.
//
// The resolver itself is not where the fix lives (applyScene in
// createMapController.js is), so what is pinned here is the property that made
// the bug unreachable by accident: these layers are never active on their own,
// so a reader can only ever see them wished-on, so the wish path is the only
// path their gate is ever evaluated on.
test("the layers whose zoom gate is only ever seen through a tick", async (t) => {
  const { LAYER_MANIFEST, resolveScene } = await import("../src/map/scene.js");

  const corroborating = Object.entries(LAYER_MANIFEST)
    .filter(([, entry]) => entry.disposition === "corroborating")
    .map(([key]) => key);

  await t.test("are never switched on by the resolver alone", () => {
    assert.ok(corroborating.includes("cables"), "cables should be corroborating");
    // No focus: nothing the reader has clicked, so nothing corroborates anything.
    const scene = resolveScene({ zoom: 12, profile: null, focus: null });
    for (const key of corroborating) {
      assert.ok(
        !scene.active.has(key),
        `${key} activated with no reader gesture -- its gate would then be reachable without a tick`
      );
    }
  });

  await t.test("still take an admin zoom override in the resolved scene", () => {
    // The override reaching drawZoom is what applyScene's wish branch reads.
    const scene = resolveScene({ zoom: 12, overrides: { cables: 6 }, focus: { kind: "country", key: "UA" } });
    assert.equal(scene.drawZoom.get("cables"), 6, "an explicit gate must survive into the scene");
  });
});

// The gate a pinned layer answers to is the one the panel is showing.
//
// This had a dead spot at exactly the value most likely to be picked. The
// slider's default position *is* the layer's shipped gate, and landing on it
// stores "no override" -- that is how reset-to-default works. An earlier fix
// applied the gate only when an override was stored, so a control reading "z4"
// let FIRMS draw at z3, and every layer had the same hole at its own number.
test("a layer's effective gate", async (t) => {
  const { shippedDrawZoom } = await import("../src/map/scene.js");

  // What applyScene does for a pinned layer, as arithmetic.
  const gateFor = (override, key) =>
    (Number.isFinite(override) ? override : shippedDrawZoom(key));

  await t.test("falls back to the shipped number when nothing is stored", () => {
    assert.equal(shippedDrawZoom("firms"), 4, "FIRMS' shipped gate moved -- update the case below");
    assert.equal(gateFor(null, "firms"), 4, "storing null must not mean 'no gate'");
    assert.equal(gateFor(undefined, "firms"), 4);
  });

  await t.test("prefers an explicit override", () => {
    assert.equal(gateFor(9, "firms"), 9);
    assert.equal(gateFor(0, "firms"), 0, "zero is a real gate -- 'any zoom' -- not a missing one");
  });

  // The layers that genuinely have no gate must stay ungated, or pinning one on
  // would withhold it for ever: there is no zoom that clears a null.
  await t.test("stays absent for a layer that ships ungated", () => {
    for (const key of ["cables", "aisNavy", "adsbFlagged", "czib", "darkVessels", "satellites"]) {
      assert.equal(shippedDrawZoom(key), null, `${key} should ship ungated`);
      assert.equal(gateFor(null, key), null);
    }
  });
});
