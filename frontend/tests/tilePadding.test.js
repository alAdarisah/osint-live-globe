// Why the map arrives at the edge when you pan, and what was done about it.
//
// Leaflet asks for exactly the tiles the viewport covers and not one more, so the
// ground you are panning onto is requested at the moment it becomes visible. There
// is always a strip being fetched rather than shown. Measured on the deployment: a
// 1278x1214 pane held 25 tiles for a view that needs exactly 25.
//
// It was never a caching failure. 83 of 83 tile requests on that same page came from
// the browser cache with nothing crossing the network -- the tiles are saved, they
// are just not asked for early.
//
// These are static checks, because the fix is an override of a Leaflet method and
// this suite has no Leaflet: window.L is a stub (see helpers/nodeTestEnv.js), so
// L.TileLayer.extend cannot run here. What can be pinned is that the numbers stay
// deliberate and that the override still targets the one method that matters.

import "./helpers/nodeTestEnv.js";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../src/map/layers.js", import.meta.url)), "utf8",
);

test("the load range is padded by exactly one ring", () => {
  // One ring turns a 5x5 view into 7x7 -- roughly double the tiles on a cold paint,
  // at 9-14 KB each. Two rings would be 9x9, quadruple, for a strip most pans never
  // reach. Zero is the behaviour being fixed.
  const match = SOURCE.match(/export const LOAD_PADDING = (\d+);/);
  assert.ok(match, "LOAD_PADDING is gone");
  assert.equal(Number(match[1]), 1);
});

test("tiles are kept longer than Leaflet's default", () => {
  // keepBuffer decides what is *kept*, never what is asked for -- which is exactly
  // why it is not sufficient on its own and why LOAD_PADDING exists. What it does
  // buy is free: panning back across a boundary stops rebuilding already-decoded
  // images that were discarded a second earlier. Leaflet's default is 2.
  const match = SOURCE.match(/export const KEEP_BUFFER = (\d+);/);
  assert.ok(match, "KEEP_BUFFER is gone");
  assert.ok(Number(match[1]) > 2, "no better than Leaflet's own default");
});

test("the padding hooks the one method that decides what is fetched", () => {
  // Leaflet offers no option for this. _pxBoundsToTileRange is where viewport pixel
  // bounds become a tile range, so it is the only place a wider range can come from.
  assert.match(SOURCE, /_pxBoundsToTileRange\(pixelBounds\)/);
  assert.match(SOURCE, /L\.TileLayer\.prototype\._pxBoundsToTileRange\.call\(this, pixelBounds\)/,
    "the override no longer defers to Leaflet's own implementation");
});

test("a layer with no padding configured behaves exactly as before", () => {
  // The override is on a subclass every tile layer could use, and the imagery and
  // weather layers do not set loadPadding. They must be unaffected.
  assert.match(SOURCE, /const pad = this\.options\.loadPadding \|\| 0;/);
  assert.match(SOURCE, /if \(!pad\) return range;/);
});

test("the world fence still applies to the padded range", () => {
  // A padded range reaches past x=0 and x=2^z-1 at the edges of the world. Leaflet's
  // own _isValidTile checks the layer's `bounds`, which is what stops those becoming
  // the 404-per-pan the option was added for -- so the option has to still be set.
  assert.match(SOURCE, /bounds: WORLD_TILE_BOUNDS/);
  assert.match(SOURCE, /noWrap: true/);
});

test("the basemap is the padded subclass, not a plain tile layer", () => {
  assert.match(SOURCE, /new PaddedTileLayer\(basemapUrlFor\(theme\)/);
  assert.match(SOURCE, /loadPadding: LOAD_PADDING/);
  assert.match(SOURCE, /keepBuffer: KEEP_BUFFER/);
});
