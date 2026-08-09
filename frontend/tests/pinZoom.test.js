// The per-pin-type zoom gate, asserted.
//
// Admin Mode can hold one kind of pin back past its layer's gate -- refineries
// but not nuclear sites, civil airfields but not the ones named military. The
// table that makes that possible (TOKEN_LAYER in map/iconTheme.js) is a hand-
// written mapping from a palette token to a layer key, and both sides of it move
// independently: a new pin type is added to a palette group, a layer is renamed
// in the manifest. Either drift is silent. A token pointing at a layer that no
// longer exists inherits a gate of "no gate"; a pin type missing from the table
// gets no control in the panel at all and nobody finds out, because the panel
// simply renders one fewer row.
//
// map/iconTheme.js has no imports of its own and map/scene.js is deliberately
// dependency-free, so this runs under `node --test` with nothing installed --
// the same constraint scene.test.js documents. map/decorators.js, which holds
// the other half (TOKEN_FOR: which token one *item* resolves to), needs Leaflet
// and cannot be reached from here.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_COLORS,
  DEFAULT_ZOOMS,
  PALETTE_GROUPS,
  TOKEN_LAYER,
  setIconTheme,
  tokenHasSize,
  tokenHasZoom,
  tokenZoom,
  layerHasTokenZoom,
} from "../src/map/iconTheme.js";
import { LAYER_MANIFEST, shippedDrawZoom } from "../src/map/scene.js";

test("the pin-type table", async (t) => {
  await t.test("names only layers the resolver knows about", () => {
    for (const [token, layerKey] of Object.entries(TOKEN_LAYER)) {
      assert.ok(
        layerKey in LAYER_MANIFEST,
        `${token} is gated under "${layerKey}", which is not in LAYER_MANIFEST`
      );
    }
  });

  await t.test("names only tokens the palette offers", () => {
    for (const token of Object.keys(TOKEN_LAYER)) {
      assert.ok(token in DEFAULT_COLORS, `${token} has a layer but no palette entry`);
    }
  });

  // The two questions are asked separately -- "does this token name something
  // with a size" and "does it name something that can be withheld" -- but they
  // have the same answer for the same reason: both are true exactly when the
  // token names a drawn pin rather than a recolouring, a ring, a polyline or a
  // country fill. A token that gained one and not the other would be a pin the
  // panel can shrink but not delay, or the reverse.
  await t.test("covers every token that names a pin, and no others", () => {
    for (const token of Object.keys(DEFAULT_COLORS)) {
      assert.equal(
        tokenHasZoom(token),
        tokenHasSize(token),
        `${token} can be sized ${tokenHasSize(token)} but gated ${tokenHasZoom(token)}`
      );
    }
  });

  await t.test("ships every pin type following its layer", () => {
    assert.deepEqual(Object.keys(DEFAULT_ZOOMS).sort(), Object.keys(TOKEN_LAYER).sort());
    for (const value of Object.values(DEFAULT_ZOOMS)) assert.equal(value, null);
  });

  // Not an aesthetic rule. The panel groups pin types by subject and reads each
  // one's inherited gate through TOKEN_LAYER; a token in a group but not in the
  // table would render a row whose "layer" option inherits from nothing.
  await t.test("reaches every sizable token in every palette group", () => {
    for (const group of PALETTE_GROUPS) {
      for (const token of group.tokens) {
        if (!tokenHasSize(token.id)) continue;
        assert.ok(token.id in TOKEN_LAYER, `${token.id} (${group.label}) has no layer to inherit from`);
      }
    }
  });
});

test("a configured pin zoom", async (t) => {
  t.afterEach(() => setIconTheme({ zooms: {} }));

  await t.test("is read back, rounded and clamped", () => {
    setIconTheme({ zooms: { "infra.nuclear": 8, "infra.refinery": 6.4, "city.town": 99 } });
    assert.equal(tokenZoom("infra.nuclear"), 8);
    assert.equal(tokenZoom("infra.refinery"), 6);
    assert.equal(tokenZoom("city.town"), 18);
  });

  await t.test("is absent for a token left on its layer", () => {
    setIconTheme({ zooms: { "infra.nuclear": 8, "infra.refinery": null } });
    assert.equal(tokenZoom("infra.refinery"), null);
    assert.equal(tokenZoom("ship.tanker"), null);
  });

  await t.test("is refused for anything that is not a pin type", () => {
    setIconTheme({ zooms: { "cable.route": 4, "choropleth.low": 4, nonsense: 4 } });
    assert.equal(tokenZoom("cable.route"), null);
    assert.equal(tokenZoom("choropleth.low"), null);
    assert.equal(tokenZoom("nonsense"), null);
  });

  // The renderers ask this once per layer per pass before deciding whether the
  // per-pin question is worth asking at all, so a false negative here would make
  // a configured gate do nothing at all.
  await t.test("marks its layer, and only its layer", () => {
    setIconTheme({ zooms: { "infra.nuclear": 8 } });
    assert.equal(layerHasTokenZoom("infra"), true);
    assert.equal(layerHasTokenZoom("cities"), false);
    setIconTheme({ zooms: {} });
    assert.equal(layerHasTokenZoom("infra"), false);
  });
});

// The composition rule, restated where it can be checked: the later of the two
// gates wins. pinZoomGate in createMapController.js is the implementation; this
// is the arithmetic it has to keep doing, asserted against the shipped numbers
// so a manifest change that moves a layer past one of its pin types is visible.
test("layer gate and pin gate compose to the later of the two", () => {
  const compose = (layerZ, own) => (own == null ? layerZ : layerZ == null ? own : Math.max(layerZ, own));

  // infra ships at the THEATRE floor; holding its refineries to z8 delays them
  // and leaves the rest of the layer alone.
  const infra = shippedDrawZoom("infra");
  assert.equal(compose(infra, 8), 8);
  assert.equal(compose(infra, null), infra);

  // A pin type may not undercut its layer, however low it is set: below its gate
  // a layer is often not fetched at all.
  assert.equal(compose(infra, 0), infra);

  // satellites ships ungated, so its pin types are the only gate it has.
  assert.equal(shippedDrawZoom("satellites"), null);
  assert.equal(compose(null, 4), 4);
  assert.equal(compose(null, null), null);
});
