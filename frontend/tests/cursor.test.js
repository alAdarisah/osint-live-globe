// The reticle's state mapping, asserted.
//
// map/cursor.js decides what the reticle should look like by reading the CSS
// cursor the browser would have drawn under the pointer -- one signal that
// already carries every state the map expresses. That read is the whole design:
// `pointer` is set by webglLayer on the map container for a sprite, by CSS on
// every DOM marker, and by Leaflet on its own controls, so a new layer needs no
// registration here and nothing can drift out of step.
//
// The mapping itself is a pure function of that string, which is what makes it
// testable without a DOM. The plumbing around it -- elementFromPoint, the rAF
// loop, the transform write -- is verified in the running app instead.

import test from "node:test";
import assert from "node:assert/strict";

import { reticleStateFor, CURSOR_STYLES, RESTING_RADIUS, TARGET_RADIUS } from "../src/map/cursor.js";

test("the cursor style list", async (t) => {
  await t.test("names the three treatments the panel offers", () => {
    assert.deepEqual(CURSOR_STYLES, ["reticle", "dot", "halo"]);
  });

  await t.test("is what settings/defaults.js validates a stored style against", () => {
    // The <select> in admin/sections/InterfaceSection.jsx, the fallback in
    // mergeSettings and the builder in cursor.js all have to agree on this
    // list. Two of them import it; this asserts the third has not drifted,
    // since a style the builder does not know would render an empty cursor
    // rather than fall back.
    assert.equal(CURSOR_STYLES.includes("reticle"), true, "the default must be in the list");
  });
});

test("the reticle state mapping", async (t) => {
  await t.test("rests with its ticks out over ordinary map", () => {
    const state = reticleStateFor("");
    assert.equal(state.radius, RESTING_RADIUS);
    assert.equal(state.ticks, true);
    assert.equal(state.danger, false);
  });

  await t.test("tightens and retracts its ticks over anything clickable", () => {
    // Every clickable thing on this map resolves to `pointer`: a Pixi sprite
    // (webglLayer writes it on the container), a DOM marker, a Leaflet control.
    for (const cursor of ["pointer"]) {
      const state = reticleStateFor(cursor);
      assert.equal(state.radius, TARGET_RADIUS, `${cursor} should tighten`);
      assert.ok(TARGET_RADIUS < RESTING_RADIUS, "tightening means smaller");
      assert.equal(state.ticks, false, `${cursor} should retract the ticks`);
    }
  });

  await t.test("keeps its ticks while the map is being dragged", () => {
    // A pan is not a target. The ring closes a little so the gesture reads as
    // held, but the ticks stay out -- retracting them would say "there is
    // something here", which is exactly what a drag over empty sea is not.
    const state = reticleStateFor("grabbing");
    assert.equal(state.ticks, true, "a drag should keep the ticks");
    assert.ok(state.radius < RESTING_RADIUS, "a drag should close a little");
    assert.ok(state.radius > TARGET_RADIUS, "a drag is not a target");
  });

  await t.test("rests on `grab`, which is not a drag", () => {
    // Leaflet puts .leaflet-grab on the container permanently, so `grab` is the
    // value under the pointer over ordinary empty map. Reading it as a state
    // left the reticle sitting closed at rest with nowhere to go once a drag
    // actually began -- caught in the browser, not here, which is why it is
    // written down here now.
    assert.equal(reticleStateFor("grab").radius, RESTING_RADIUS);
    assert.equal(reticleStateFor("grab").ticks, true);
  });

  await t.test("goes to the danger colour where a click would be refused", () => {
    const state = reticleStateFor("not-allowed");
    assert.equal(state.danger, true);
  });

  await t.test("treats anything it does not recognise as resting", () => {
    // `auto`, `default`, `crosshair`, `text`, `move`, an empty string from a
    // detached node -- none of them is a state this map needs its own answer
    // for, and inventing one would mean a new cursor value anywhere in the app
    // silently changing how the map reads.
    for (const cursor of ["auto", "default", "crosshair", "text", "move", "zoom-in", undefined, null]) {
      const state = reticleStateFor(cursor);
      assert.equal(state.radius, RESTING_RADIUS, `${cursor} should rest`);
      assert.equal(state.ticks, true);
      assert.equal(state.danger, false);
    }
  });

  await t.test("is a pure function of the string it is given", () => {
    assert.deepEqual(reticleStateFor("pointer"), reticleStateFor("pointer"));
  });
});
