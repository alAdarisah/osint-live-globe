// Sprite hit-testing, asserted against a CSS-scaled canvas.
//
// map/webglLayer.js resolves clicks and hovers itself (the canvas is
// pointer-events:none, so the browser never hit-tests it) by subtracting the
// canvas's screen position from the pointer's client coordinates. For the whole
// duration of a zoom gesture the canvas carries a CSS `scale()` from
// _onAnimZoom, so that subtraction alone lands in the wrong coordinate space:
// the rect is scaled, the sprite positions are not. The error is proportional
// to the distance from the canvas origin -- half a viewport at the centre of a
// single wheel step -- which is what made a click mid-zoom select an entity
// nowhere near the pointer.
//
// webglLayer.js reads `window.L` at import time (see leafletGlobal.js) and
// extends L.Layer at module scope, so this file stubs just enough of Leaflet to
// capture the prototype literal and call one method on a hand-made `this`. No
// DOM, no Pixi, no packages -- the same "runs under bare `node --test`"
// constraint the other tests in this directory document.

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// src/ is written for Vite, which resolves extensionless relative imports;
// node does not. webglLayer.js has exactly one of them ("./leafletGlobal"), so
// rather than change source for a test's benefit, teach this process to add the
// extension. Scoped to this file and undone by nothing else -- the other tests
// here import modules that have no imports of their own and need none of it.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
});

let prototype = null;

globalThis.window = {
  L: {
    Layer: {
      extend(proto) {
        prototype = proto;
        return function EntityWebglLayerStub() {};
      },
    },
    // Leaflet's own helper for exactly this problem: rect.width / offsetWidth,
    // falling back to 1 when the element has no layout.
    DomUtil: {
      getScale(element) {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.width / element.offsetWidth || 1,
          y: rect.height / element.offsetHeight || 1,
          boundingClientRect: rect,
        };
      },
    },
  },
};

await import("../src/map/webglLayer.js");

const LAYOUT_WIDTH = 1200;
const LAYOUT_HEIGHT = 800;

/**
 * A layer holding one 20px sprite at canvas-local (600, 400), on a canvas whose
 * on-screen box is `rect`. At rest that box is the viewport itself; mid-zoom it
 * is the scaled, translated box _onAnimZoom produces.
 */
function layerWithOneSpriteAtCentre(rect) {
  const entry = {
    container: { visible: true, position: { x: 600, y: 400 } },
    sprite: { visible: true, width: 20 },
    item: { mmsi: 1 },
  };
  return {
    _canvas: {
      getBoundingClientRect: () => rect,
      offsetWidth: LAYOUT_WIDTH,
      offsetHeight: LAYOUT_HEIGHT,
    },
    _buckets: new Map([["aisNavy", new Map([[1, entry]])]]),
    _visibleBuckets: new Set(["aisNavy"]),
    _optsByBucket: new Map([["aisNavy", { onSelect() {} }]]),
  };
}

function hitAt(layer, clientX, clientY) {
  return prototype._hitTestAt.call(layer, clientX, clientY);
}

test("sprite hit-testing", async (t) => {
  await t.test("finds the sprite under the pointer on an untransformed canvas", () => {
    const layer = layerWithOneSpriteAtCentre({
      left: 0, top: 0, width: LAYOUT_WIDTH, height: LAYOUT_HEIGHT,
    });
    assert.ok(hitAt(layer, 600, 400), "the sprite is drawn at (600, 400)");
    assert.equal(hitAt(layer, 0, 0), null, "nothing is drawn in the corner");
  });

  await t.test("follows the sprite through a zoom animation's CSS scale", () => {
    // One wheel step in, centre held: setTransform(canvas, (-600, -400), 2).
    // The sprite at canvas-local (600, 400) is therefore still drawn at screen
    // (600, 400) -- -600 + 600 * 2.
    const layer = layerWithOneSpriteAtCentre({
      left: -600, top: -400, width: LAYOUT_WIDTH * 2, height: LAYOUT_HEIGHT * 2,
    });
    assert.ok(hitAt(layer, 600, 400), "the sprite is still drawn at (600, 400)");
    assert.equal(
      hitAt(layer, 0, 0),
      null,
      "the top-left corner is 600px of empty map away from it"
    );
  });

  await t.test("follows the sprite through a zoom-out animation too", () => {
    // One wheel step out: setTransform(canvas, (300, 200), 0.5), so the sprite
    // is drawn at 300 + 600 * 0.5.
    const layer = layerWithOneSpriteAtCentre({
      left: 300, top: 200, width: LAYOUT_WIDTH * 0.5, height: LAYOUT_HEIGHT * 0.5,
    });
    assert.ok(hitAt(layer, 600, 400), "the sprite is drawn at (600, 400)");
    assert.equal(hitAt(layer, 900, 600), null, "and not at its unscaled offset");
  });
});
