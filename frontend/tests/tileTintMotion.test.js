// Task 30: the "apply tint only at rest" gate, asserted against a mocked map.
//
// map/tileTintMotion.js is a leaf module (no imports of its own -- it takes
// `map` as a plain parameter rather than reaching for window.L, so it never
// needs the real Leaflet), which is what makes a hand-built stand-in enough:
// the only surface it touches is `.getContainer()`, `.on(events, fn)`,
// `.off(events, fn)`, and a container with a `classList` -- exactly the shape
// L.Map and a real DOM element already have. Firing events through a fake
// `.fire()` rather than driving a real Leaflet map through an actual drag is
// deliberate, not a shortcut: a synthetic pointer gesture cannot reliably
// drive Leaflet's own drag/inertia state machine to a clean moveend (that was
// tried against the running app for task-30-report.md and left the map
// pane's transform stuck mid-drag), where this module's own contract --
// "movestart/zoomstart adds the class while the flag is on, moveend/zoomend
// always removes it, off never adds it, detach cleans up" -- does not depend
// on Leaflet's physics at all and is fully exercised by firing the four named
// events directly.

import test from "node:test";
import assert from "node:assert/strict";

import { attachTileTintMotionGate, setTileTintAtRest } from "../src/map/tileTintMotion.js";

const PANNING_CLASS = "tile-tint-panning";

/** A `.on`/`.off`/`.fire` event bus, shaped like the slice of L.Map this module reads. */
function fakeMap() {
  const listeners = {};
  const classes = new Set();
  return {
    container: {
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
    },
    getContainer() {
      return this.container;
    },
    on(events, fn) {
      for (const event of events.split(" ")) (listeners[event] ||= []).push(fn);
    },
    off(events, fn) {
      for (const event of events.split(" ")) {
        listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
      }
    },
    fire(event) {
      for (const fn of listeners[event] || []) fn();
    },
    listenerCount(event) {
      return (listeners[event] || []).length;
    },
    panning() {
      return classes.has(PANNING_CLASS);
    },
  };
}

test("attachTileTintMotionGate", async (t) => {
  // The flag is module-level (see tileTintMotion.js's own note on why), so
  // each case starts by putting it back to the shipped default -- otherwise
  // an earlier case's setTileTintAtRest(true) would leak into the next one.
  t.beforeEach(() => setTileTintAtRest(false));

  await t.test("off by default: movestart does not add the class", () => {
    const map = fakeMap();
    attachTileTintMotionGate(map);
    map.fire("movestart");
    assert.equal(map.panning(), false);
  });

  await t.test("once enabled, movestart adds the class", () => {
    const map = fakeMap();
    attachTileTintMotionGate(map);
    setTileTintAtRest(true);
    map.fire("movestart");
    assert.equal(map.panning(), true);
  });

  await t.test("moveend always removes the class, regardless of the flag", () => {
    const map = fakeMap();
    attachTileTintMotionGate(map);
    setTileTintAtRest(true);
    map.fire("movestart");
    assert.equal(map.panning(), true);
    map.fire("moveend");
    assert.equal(map.panning(), false);
  });

  await t.test("zoomstart/zoomend are wired the same as movestart/moveend", () => {
    // The same "moveend zoomend" pairing borderEdit.js already relies on
    // (map.on("moveend zoomend", rebuildHandles)) -- a zoom is a move that
    // did not pan, and the gate has to cover it the same way.
    const map = fakeMap();
    attachTileTintMotionGate(map);
    setTileTintAtRest(true);
    map.fire("zoomstart");
    assert.equal(map.panning(), true);
    map.fire("zoomend");
    assert.equal(map.panning(), false);
  });

  await t.test("turning the flag off mid-flight stops the *next* movestart, not the current class", () => {
    const map = fakeMap();
    attachTileTintMotionGate(map);
    setTileTintAtRest(true);
    map.fire("movestart");
    assert.equal(map.panning(), true);
    setTileTintAtRest(false);
    // The gesture already in progress is left alone -- only moveend clears
    // it -- but a fresh movestart no longer adds it.
    map.fire("moveend");
    map.fire("movestart");
    assert.equal(map.panning(), false);
  });

  await t.test("re-enabling after a settled gesture adds the class again on the next movestart", () => {
    const map = fakeMap();
    attachTileTintMotionGate(map);
    setTileTintAtRest(true);
    map.fire("movestart");
    map.fire("moveend");
    assert.equal(map.panning(), false);
    map.fire("movestart");
    assert.equal(map.panning(), true, "the gate is not a one-shot -- it answers to the flag every time");
  });

  await t.test("detach stops listening on both event pairs", () => {
    const map = fakeMap();
    const detach = attachTileTintMotionGate(map);
    setTileTintAtRest(true);
    detach();
    assert.equal(map.listenerCount("movestart"), 0);
    assert.equal(map.listenerCount("zoomstart"), 0);
    assert.equal(map.listenerCount("moveend"), 0);
    assert.equal(map.listenerCount("zoomend"), 0);
    // Off the map entirely now -- firing after detach must not resurrect it.
    map.fire("movestart");
    assert.equal(map.panning(), false);
  });

  await t.test("detach also clears the class if a gesture was mid-flight", () => {
    const map = fakeMap();
    const detach = attachTileTintMotionGate(map);
    setTileTintAtRest(true);
    map.fire("movestart");
    assert.equal(map.panning(), true);
    detach();
    assert.equal(map.panning(), false, "teardown must not leave the tint permanently suppressed");
  });
});
