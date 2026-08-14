// What map/scene.js promises, asserted.
//
// This file exists because the scene resolver is the one place in the frontend
// where a wrong number is both invisible and expensive. A layer drawing at the
// wrong band looks like a judgement call rather than a bug; a fetch gate that
// drifts from its draw gate downloads megabytes nobody can see; and a
// corroborating layer that a camera position can switch on breaks a stated
// principle about what this map asserts unasked. None of those produce an
// error, and none of them are visible in a screenshot.
//
// scene.js is deliberately dependency-free -- no Leaflet, no React, no DOM --
// which is what lets this run under `node --test` with nothing installed.
// Keep it that way: the moment the resolver imports something browser-shaped,
// this suite needs a whole test environment to say the same things.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BANDS,
  bandFor,
  detailForBand,
  floorOf,
  resolveScene,
  shippedDrawZoom,
  sourceQueryFor,
  LAYER_MANIFEST,
  SCENE_APPLY_KEYS,
  UNGATED_FEEDS,
  TRAIL_PARENT,
  FETCH_ALWAYS,
  FETCH_MANUAL,
  AUTO,
  CORROBORATING,
  MANUAL,
} from "../src/map/scene.js";

// DECLUTTER_MIN_ZOOM in createMapController.js: the zoom the placement pass
// starts producing offsets at, and the COUNTRY band floor.
const DECLUTTER_MIN_ZOOM = 6;

test("zoom bands", async (t) => {
  await t.test("cover every zoom the map can reach, in order", () => {
    // The map is created with minZoom 2 (see the L.map call in
    // createMapController.js) and CARTO's basemap runs to 20.
    for (let z = 2; z <= 20; z += 1) {
      assert.ok(BANDS.includes(bandFor(z)), `zoom ${z} resolved to a band that does not exist`);
    }
    assert.equal(bandFor(2), "WORLD");
    assert.equal(bandFor(3), "WORLD");
    assert.equal(bandFor(4), "THEATRE");
    assert.equal(bandFor(6), "COUNTRY");
    assert.equal(bandFor(9), "LOCAL");
    assert.equal(bandFor(12), "SITE");
  });

  await t.test("round fractional zoom, so one pinch gesture cannot flip a band twice", () => {
    // A pinch reports fractional levels while it is in flight. Without the
    // rounding, crossing 5.5 and falling back to 5.4 would resolve the whole
    // scene twice inside a single gesture.
    assert.equal(bandFor(5.4), "THEATRE");
    assert.equal(bandFor(5.6), "COUNTRY");
    assert.equal(bandFor(5.5), bandFor(6), "the halfway point must land on one side and stay there");
  });

  await t.test("clamp below the map's own minimum rather than throwing", () => {
    assert.equal(bandFor(0), "WORLD");
    assert.equal(bandFor(undefined), "WORLD");
    assert.equal(bandFor(NaN), "WORLD");
  });
});

test("level of detail", async (t) => {
  await t.test("is the full glyph at every zoom the map can reach", () => {
    // There is one level. A pin on this map states what kind of evidence it is,
    // and that distinction lives in the shape -- a filled circle carries colour,
    // which is severity, and nothing else. The thinning a dot used to do at
    // world zoom is done by the caps below instead, which say so in the panel.
    for (let z = 2; z <= 20; z += 1) {
      assert.equal(detailForBand(bandFor(z)), "glyph", `zoom ${z} should draw the full glyph`);
    }
  });

  await t.test("never changes, so no zoom crossing repaints every marker", () => {
    // A change of detail rewrites the icon HTML string updateMarker diffs, which
    // tears down and rebuilds the DOM of every visible marker. With one level
    // that cost is zero; a second level reappearing without this test noticing
    // would put it back silently.
    const changes = [];
    for (let z = 3; z <= 20; z += 1) {
      if (detailForBand(bandFor(z)) !== detailForBand(bandFor(z - 1))) changes.push(z);
    }
    assert.deepEqual(changes, [], "detail should not change at any zoom");
  });

  await t.test("the COUNTRY floor is still where the placement pass begins", () => {
    // Detail no longer shares this boundary, but DECLUTTER_MIN_ZOOM is still
    // pinned to the band floor: the caps and collapse rules are written per
    // band, and offsets appearing at some other zoom would decouple the two.
    assert.equal(floorOf("COUNTRY"), DECLUTTER_MIN_ZOOM);
  });

  await t.test("does not depend on the viewport profile or the focus", () => {
    // Trivially true while there is one level of detail, and kept anyway --
    // this is the assertion that has to survive, because it is the rule any
    // future reintroduction of a shallow-zoom detail level would break. Both
    // the profile and the focus change on every pan and every click; if either
    // reached the detail level, the icon HTML string would flip continuously
    // and updateMarker's diff would tear down and rebuild every marker's DOM on
    // every move.
    //
    // Checked at every zoom rather than at one, and that is not thoroughness
    // for its own sake: a profile-dependent implementation and a correct one
    // agree everywhere the two happen to return the same level, so a
    // single-band check would pass against one that reads the profile. The bug
    // is only visible where the answers differ.
    const inputs = [
      ["ocean", { profile: { isMaritime: true, hotCountries: [], landFraction: 0, dominantCountries: [] } }],
      ["war", { profile: { isMaritime: false, hotCountries: ["UA"], landFraction: 0.9, dominantCountries: ["UA"] } }],
      ["country focus", { focus: { kind: "country", key: "UA" } }],
      ["pin focus", { focus: { kind: "layer", key: "aisTanker" } }],
      ["admin overrides", { overrides: { cities: 2, osmInfra: 3 } }],
    ];

    for (let zoom = 2; zoom <= 20; zoom += 1) {
      const plain = resolveScene({ zoom });
      for (const [label, extra] of inputs) {
        assert.equal(
          resolveScene({ zoom, ...extra }).detail,
          plain.detail,
          `at zoom ${zoom}, ${label} changed the level of detail`
        );
      }
    }
  });
});

test("shipped draw gates match the band table", async (t) => {
  // The numbers this map argued for, one by one, over its history. Several are
  // not band floors and must not be rounded to one: 7 for airfields because the
  // served slice is ~40k rows, 9 for OSM infrastructure because it is
  // crowd-sourced geometry that only earns its place once a reader is already
  // looking at one town.
  const GATES = {
    events: 3, gdelt: 3, officials: 4, conflictHistory: 6,
    aisTanker: 3, aisCivilian: 4,
    adsbCivilian: 9, adsbDisplayLimited: 9,
    cities: 6, infra: 4, osmInfra: 9,
    hazards: 3, floods: 4, jamming: 5,
    firms: 4, firmsPoints: 6,
    airports: 7, dams: 7, ports: 5, cableLandings: 5,
    gfwGaps: 6, gfwDetections: 6,
    launches: 4,
  };

  await t.test("every gated layer draws from the zoom it says it does", () => {
    for (const [key, zoom] of Object.entries(GATES)) {
      assert.equal(shippedDrawZoom(key), zoom, `${key} draws from the wrong zoom`);
    }
  });

  await t.test("the deliberately ungated layers stay ungated", () => {
    // Each of these is ungated for a stated reason rather than by omission: an
    // aircraft squawking 7500, a designated tanker going dark, and a regulator
    // closing a national airspace are all world-zoom facts, and the boundaries
    // feed is what half the map hangs off.
    //
    // adsbFlagged is the load-bearing one. It stays here even though one of the
    // three statuses it carries -- display-limited -- is now gated by
    // adsbDisplayLimited: a 7500 squawk and an OFAC designation must still
    // reach the world board, and a change that gated the bucket itself rather
    // than the one status inside it would take them off it.
    for (const key of [
      "adsbFlagged", "adsbMilitary", "aisNavy", "czib", "darkVessels",
      "satellites", "countries", "cables", "outagePoints",
    ]) {
      assert.equal(shippedDrawZoom(key), null, `${key} should have no draw gate`);
    }
  });

  await t.test("a fetch gate is never shallower than the gate it serves", () => {
    // A layer may fetch *before* it draws, so a zoom-in is instant. The reverse
    // would mean fetching only after the reader can already see the gap.
    const scene = resolveScene({ zoom: 20 });
    for (const key of SCENE_APPLY_KEYS) {
      const fetchZoom = scene.fetchZoom.get(key);
      const drawZoom = shippedDrawZoom(key);
      if (fetchZoom == null || fetchZoom === Infinity || drawZoom == null) continue;
      assert.ok(
        fetchZoom <= drawZoom,
        `${key} fetches at ${fetchZoom} but draws from ${drawZoom} -- it would draw an empty layer`
      );
    }
  });
});

test("the FIRMS fetch gate", async (t) => {
  // Measured against the running backend before this gate existed: the unclipped
  // feed is 184,770 records and 28.2 MB of JSON, and a WORLD viewport is the
  // whole world, so the layer's `scoped` bbox clipped nothing at the one band
  // where the layer also draws nothing. Every reader parsed all of it, every
  // three minutes, from the moment the map opened.
  //
  // These four assertions are the whole trade, and each one is load-bearing: the
  // saving is the first, the reason it is safe is the second and third, and the
  // fourth is the promise the second must not quietly grow into.
  await t.test("a world view does not fetch the global thermal feed", () => {
    const world = resolveScene({ zoom: 3 });
    assert.equal(world.fetchZoom.get("firms"), floorOf("THEATRE"));
    assert.ok(!world.active.has("firms"), "firms drew at a band it does not fetch at");
  });

  await t.test("a focused country fetches its fires however far out the camera is", () => {
    // What keeps the "active fires" rows in buildLivePicture and buildAdminLive:
    // the fetch carries that country's bounds (see bboxCell in useOsintData.js),
    // so the rows count the country rather than the planet -- 435 kB over
    // Ukraine against 28.2 MB.
    const focused = resolveScene({ zoom: 3, focus: { kind: "country", key: "UA" } });
    assert.equal(focused.fetchZoom.get("firms"), null);
  });

  await t.test("a focus does not put the heat canvas on a world view", () => {
    // FOCUS_FETCH_ONLY rather than FOCUS_PROMOTE. A promotion would lift the
    // draw band too, which is the thing the layer's own entry argues against: a
    // global thermal feed at world zoom is mostly agricultural burning.
    const focused = resolveScene({ zoom: 3, focus: { kind: "country", key: "UA" } });
    assert.equal(focused.drawZoom.get("firms"), floorOf("THEATRE"));
    assert.ok(!focused.active.has("firms"), "a country focus painted fires over the world board");
  });

  await t.test("the gate opens exactly where the layer starts drawing", () => {
    const theatre = resolveScene({ zoom: floorOf("THEATRE") });
    assert.equal(theatre.fetchZoom.get("firms"), floorOf("THEATRE"));
    assert.ok(theatre.active.has("firms"), "firms fetches at a band it does not draw at");
  });
});

test("the two on-demand line documents", async (t) => {
  // railways and powerLines are 20.4 MB and 20.7 MB of JSON respectively, and
  // both were fetched at boot for every reader. These assertions are what makes
  // the lazy fetch in useOsintData.js's ONE_SHOT correct rather than merely
  // cheaper: nothing but an explicit act can put either layer on the map, so
  // nothing but an explicit act needs to pay for its geometry.
  for (const key of ["railways", "powerLines"]) {
    await t.test(`${key} is reachable only by an explicit act`, () => {
      assert.equal(LAYER_MANIFEST[key].disposition, MANUAL, `${key} is no longer admin-only`);
      assert.equal(LAYER_MANIFEST[key].fetch, FETCH_MANUAL, `${key} is no longer fetch-manual`);

      // Neither a deep camera, nor a war under it, nor a country focus may
      // activate it -- the three things that move every other layer.
      const deep = resolveScene({ zoom: 12 });
      const hot = resolveScene({
        zoom: 12,
        profile: { isMaritime: false, hotCountries: ["UA"], landFraction: 0.9, dominantCountries: ["UA"] },
      });
      const focused = resolveScene({ zoom: 12, focus: { kind: "country", key: "UA" } });
      for (const [label, scene] of [["a deep camera", deep], ["a war view", hot], ["a country focus", focused]]) {
        assert.ok(!scene.active.has(key), `${label} switched ${key} on by itself`);
        assert.equal(scene.fetchZoom.get(key), Infinity, `${label} lifted ${key}'s fetch gate`);
      }
    });
  }
});

test("the pipeline cap", async (t) => {
  // Task 28 changed what this layer is without changing how it drew. It was ten
  // hand-written schematic routes; it became those ten plus 16,739 real OSM
  // ways, still drawn one Leaflet polyline per route per world copy with a
  // tooltip and a popup bound to each -- ~50,000 SVG paths at THEATRE band with
  // three copies in view, for a layer that is on by default.
  await t.test("is a cap holder, not a layer anyone can toggle", () => {
    // The lines ride infraLayer's own group, so this entry must never become a
    // checkbox -- the same arrangement firmsPoints and airfieldActivity have.
    assert.equal(LAYER_MANIFEST.pipelines.virtual, true);
    assert.ok(!SCENE_APPLY_KEYS.includes("pipelines"));
    assert.equal(LAYER_MANIFEST.pipelines.draw, undefined, "infra decides whether pipelines draw");
  });

  await t.test("tightens as the camera pulls back", () => {
    // The question narrows as the reader goes in, so the allowance widens. The
    // ordering is the assertion: a cap that did not rise with the band would
    // thin a town view as hard as a theatre one.
    assert.equal(resolveScene({ zoom: 4 }).caps.get("pipelines"), 600);
    assert.equal(resolveScene({ zoom: 6 }).caps.get("pipelines"), 1500);
    assert.equal(resolveScene({ zoom: 9 }).caps.get("pipelines"), 3000);
    assert.equal(resolveScene({ zoom: 14 }).caps.get("pipelines"), 3000);
  });

  await t.test("ranks by how much pipeline a record carries", () => {
    // Vertex count is the closest thing the record holds to "how much of this
    // is there" -- a trunk line runs to hundreds of points, a yard stub to two
    // or three. Not kilometres, and nothing claims it is.
    const { rank } = LAYER_MANIFEST.pipelines;
    assert.ok(rank({ path: new Array(400) }) > rank({ path: new Array(3) }));
    assert.equal(rank({}), 0, "a record with no path must not outrank a real one");
    assert.equal(rank({ path: "not an array" }), 0);
  });
});

test("disposition", async (t) => {
  await t.test("the camera alone never switches on a corroborating layer", () => {
    // The principle this exists to protect: a pin that is an inference drawn
    // from an absence must be something a reader chooses to look at, not
    // something the map asserts at them. A promotion moves a band; it must
    // never move a disposition, or a camera position becomes the choosing.
    const maritime = resolveScene({
      zoom: 7,
      profile: { isMaritime: true, hotCountries: [], landFraction: 0.05, dominantCountries: [] },
    });
    const hot = resolveScene({
      zoom: 7,
      profile: { isMaritime: false, hotCountries: ["UA"], landFraction: 0.9, dominantCountries: ["UA"] },
    });

    for (const key of SCENE_APPLY_KEYS) {
      if (LAYER_MANIFEST[key].disposition !== CORROBORATING) continue;
      assert.ok(!maritime.active.has(key), `${key} activated on an ocean view alone`);
      assert.ok(!hot.active.has(key), `${key} activated on a war view alone`);
    }
  });

  await t.test("focusing a country opens them", () => {
    const focused = resolveScene({ zoom: 7, focus: { kind: "country", key: "UA" } });
    for (const key of ["darkVessels", "gfwGaps", "gfwDetections", "ports", "dams", "airports"]) {
      assert.ok(focused.active.has(key), `${key} should be reachable by focusing a country`);
    }
  });

  await t.test("clicking a pin opens what that pin corroborates, and nothing else", () => {
    const tanker = resolveScene({ zoom: 7, focus: { kind: "layer", key: "aisTanker" } });
    // A dark-vessel gap is a claim about this class of hull, so the tanker is
    // the thing that should reach it.
    assert.ok(tanker.active.has("darkVessels"), "a tanker should reach the dark-vessel record");
    assert.ok(tanker.active.has("gfwGaps"), "a tanker should reach the AIS disabling record");
    // A dam is not.
    assert.ok(!tanker.active.has("dams"), "a tanker should not reach dams");
  });

  await t.test("manual layers are never switched on by anything but an admin", () => {
    for (const key of ["precip", "clouds", "windArrows"]) {
      assert.equal(LAYER_MANIFEST[key].disposition, MANUAL);
      const anything = resolveScene({
        zoom: 12,
        focus: { kind: "country", key: "UA" },
        profile: { isMaritime: true, hotCountries: ["UA"], landFraction: 0, dominantCountries: ["UA"] },
      });
      assert.ok(!anything.active.has(key), `${key} is manual and must stay off`);
    }
  });
});

test("admin bypass reaches the pre-resolver behaviour exactly", async (t) => {
  // The panel's job is diagnosis, and an empty layer has four possible causes.
  // Without a way to defeat the resolver an operator can only tell three of
  // them apart -- so "the same as before, at the shipped numbers" has to be a
  // state they can actually reach.
  const bypassed = resolveScene({
    zoom: 3,
    bypass: true,
    focus: { kind: "layer", key: "events" },
    profile: { isMaritime: true, hotCountries: ["UA"], landFraction: 0, dominantCountries: [] },
  });

  await t.test("every non-manual layer is eligible", () => {
    for (const key of SCENE_APPLY_KEYS) {
      if (LAYER_MANIFEST[key].disposition === MANUAL) continue;
      assert.ok(bypassed.active.has(key), `${key} should be eligible under bypass`);
    }
  });

  await t.test("gates return to their shipped numbers, not any the camera promoted", () => {
    for (const key of SCENE_APPLY_KEYS) {
      assert.equal(
        bypassed.drawZoom.get(key),
        shippedDrawZoom(key),
        `${key} should be back at its shipped gate under bypass`
      );
    }
  });

  await t.test("caps are lifted", () => {
    for (const key of SCENE_APPLY_KEYS) {
      assert.equal(bypassed.caps.get(key), Infinity, `${key} should be uncapped under bypass`);
    }
  });
});

test("caps", async (t) => {
  await t.test("step by band and carry downward", () => {
    // A cap declared at COUNTRY holds at LOCAL and SITE too: the deepest band
    // that declares one wins, so a layer does not silently become uncapped the
    // moment a reader zooms past the last row in its table.
    assert.equal(resolveScene({ zoom: 3 }).caps.get("events"), 150);
    assert.equal(resolveScene({ zoom: 5 }).caps.get("events"), 400);
    assert.equal(resolveScene({ zoom: 7 }).caps.get("events"), 900);
    assert.equal(resolveScene({ zoom: 12 }).caps.get("events"), 900);
  });

  await t.test("a layer with no cap is uncapped", () => {
    assert.equal(resolveScene({ zoom: 3 }).caps.get("czib"), Infinity);
    assert.equal(resolveScene({ zoom: 3 }).caps.get("countries"), Infinity);
  });

  await t.test("no cap is declared for a band its layer cannot draw in", () => {
    // A cap shallower than the gate is a rule for a zoom the layer never
    // reaches, which makes it look enforced while doing nothing. That is
    // exactly what happened to adsbCivilian: it carried cap.COUNTRY long after
    // its gate had moved past COUNTRY, so the number read as a live limit and
    // capped nobody.
    for (const [key, entry] of Object.entries(LAYER_MANIFEST)) {
      if (!entry.cap || !entry.draw) continue;
      const drawIndex = BANDS.indexOf(entry.draw.band);
      for (const band of Object.keys(entry.cap)) {
        assert.ok(
          BANDS.indexOf(band) >= drawIndex,
          `${key} caps at ${band} but does not draw until ${entry.draw.band}`
        );
      }
    }
  });

  await t.test("a promotion cannot lift a layer past its shallowest cap", () => {
    // A promotion moves the band a layer draws at; it must not move it out of
    // the reach of every cap its author wrote. aisCivilian is declared at
    // THEATRE and a maritime view promotes it to WORLD -- which used to find no
    // cap at all and draw the whole merchant fleet at world zoom.
    const promoted = resolveScene({
      zoom: 3,
      profile: { isMaritime: true, hotCountries: [], landFraction: 0.02, dominantCountries: [] },
    });
    assert.equal(
      promoted.caps.get("aisCivilian"),
      LAYER_MANIFEST.aisCivilian.cap.THEATRE,
      "a layer promoted shallower than every declared cap should take the shallowest one"
    );
  });

  await t.test("events is capped but never collapsed", () => {
    // Capping removes the least significant and says so in the panel, which is
    // a stated editorial act. Collapsing would merge two incident reports into
    // one pin and thereby assert they were one event -- a claim nothing in the
    // feed supports.
    assert.ok(LAYER_MANIFEST.events.cap, "events should be capped");
    assert.equal(LAYER_MANIFEST.events.collapse, null, "events must never collapse");
  });
});

test("admin per-layer zoom overrides", async (t) => {
  await t.test("beat the shipped gate outright", () => {
    // What makes the override a diagnostic rather than a suggestion.
    const scene = resolveScene({ zoom: 3, overrides: { osmInfra: 4, airports: 2 } });
    assert.equal(scene.drawZoom.get("osmInfra"), 4);
    assert.equal(scene.drawZoom.get("airports"), 2);
  });

  await t.test("beat a promotion too", () => {
    const scene = resolveScene({
      zoom: 7,
      overrides: { cities: 11 },
      focus: { kind: "country", key: "UA" },
    });
    assert.equal(scene.drawZoom.get("cities"), 11, "the override must win over the focus promotion");
  });

  await t.test("apply to the layers whose gate used to be a bare constant", () => {
    // FIRMS points, jamming, cities and civilian ADS-B all compared against a
    // hard-coded number, which meant the admin panel's zoom slider silently did
    // nothing to them.
    for (const key of ["firmsPoints", "jamming", "cities", "adsbCivilian"]) {
      const scene = resolveScene({ zoom: 3, overrides: { [key]: 8 } });
      assert.equal(scene.drawZoom.get(key), 8, `${key} should honour an admin override`);
    }
  });
});

test("the ADS-B class filter", async (t) => {
  // /api/aircraft is the largest payload the API serves. Below the zoom where
  // ordinary traffic and display-limited airframes start drawing, the client
  // asks for only the aircraft it can draw -- measured live, 6,632,400 bytes
  // down to 333,151. What must never happen is asking for the thin slice at a
  // zoom that draws either of those groups: they would simply be absent, with
  // no error and no empty layer to notice.
  const queryAt = (zoom, extra = {}) =>
    sourceQueryFor("adsb", resolveScene({ zoom, ...extra }), zoom);

  await t.test("asks for the thin slice only where neither group draws", () => {
    for (let z = 2; z <= 20; z += 1) {
      const drawsEither = z >= shippedDrawZoom("adsbCivilian") || z >= shippedDrawZoom("adsbDisplayLimited");
      assert.equal(
        queryAt(z),
        drawsEither ? null : "civilian=0",
        `at zoom ${z} the ADS-B fetch asked for the wrong slice`
      );
    }
  });

  await t.test("stops asking as soon as either group draws", () => {
    // Either, not both: the two gates happen to be the same number today, and
    // moving one of them alone must not strand its aircraft off the map.
    const scene = resolveScene({ zoom: 3, overrides: { adsbDisplayLimited: 2 } });
    assert.equal(
      sourceQueryFor("adsb", scene, 3),
      null,
      "display-limited drawing at world zoom should pull the whole feed back"
    );
  });

  await t.test("an admin zoom override is the escape hatch", () => {
    // The panel's job is diagnosis, and "the feed is thin because the resolver
    // asked for it thin" has to be a state an operator can leave. Dropping
    // either gate below the current zoom restores the full payload, through
    // machinery that already existed rather than a switch of its own.
    assert.equal(queryAt(3, { overrides: { adsbCivilian: 2 } }), null);
  });

  await t.test("no other source carries one", () => {
    for (const key of SCENE_APPLY_KEYS) {
      if (key === "adsb") continue;
      assert.equal(
        sourceQueryFor(key, resolveScene({ zoom: 3 }), 3),
        null,
        `${key} should not be sending a class filter`
      );
    }
  });
});

test("manifest integrity", async (t) => {
  await t.test("every entry declares a disposition the resolver understands", () => {
    for (const [key, entry] of Object.entries(LAYER_MANIFEST)) {
      assert.ok(
        [AUTO, CORROBORATING, MANUAL].includes(entry.disposition),
        `${key} has an unrecognised disposition: ${entry.disposition}`
      );
    }
  });

  await t.test("every band and cap band named actually exists", () => {
    for (const [key, entry] of Object.entries(LAYER_MANIFEST)) {
      if (entry.draw) {
        assert.ok(BANDS.includes(entry.draw.band), `${key} draws at a band that does not exist`);
      }
      if (typeof entry.fetch === "string" && entry.fetch !== FETCH_ALWAYS && entry.fetch !== FETCH_MANUAL) {
        assert.ok(BANDS.includes(entry.fetch), `${key} fetches at a band that does not exist`);
      }
      for (const band of Object.keys(entry.cap || {})) {
        assert.ok(BANDS.includes(band), `${key} caps at a band that does not exist: ${band}`);
      }
    }
  });

  await t.test("every collapse rule is one the renderer implements", () => {
    for (const [key, entry] of Object.entries(LAYER_MANIFEST)) {
      if (!entry.collapse) continue;
      assert.ok(
        ["proximity", "key"].includes(entry.collapse.mode),
        `${key} declares a collapse mode nothing implements: ${entry.collapse.mode}`
      );
    }
  });

  await t.test("a rank is a function wherever one is declared", () => {
    for (const [key, entry] of Object.entries(LAYER_MANIFEST)) {
      if (entry.rank === undefined) continue;
      assert.equal(typeof entry.rank, "function", `${key}'s rank should be a function`);
    }
  });

  await t.test("virtual entries are excluded from the keys the map applies", () => {
    // firmsPoints and airfieldActivity are gates, not layers -- there is no
    // Leaflet layer behind either, so setLayerVisible must never be called with
    // them.
    for (const [key, entry] of Object.entries(LAYER_MANIFEST)) {
      if (!entry.virtual) continue;
      assert.ok(!SCENE_APPLY_KEYS.includes(key), `${key} is virtual and must not be applied to the map`);
    }
    assert.ok(!SCENE_APPLY_KEYS.includes("cableLandings"), "cableLandings has no toggle of its own");
  });

  await t.test("every trail names a parent that exists", () => {
    for (const [trail, parent] of Object.entries(TRAIL_PARENT)) {
      assert.ok(LAYER_MANIFEST[parent], `${trail} points at a parent that is not in the manifest: ${parent}`);
    }
  });

  await t.test("a trail is drawn wherever its parent is", () => {
    const scene = resolveScene({ zoom: 12 });
    for (const [trail, parent] of Object.entries(TRAIL_PARENT)) {
      assert.equal(
        scene.active.has(trail),
        scene.active.has(parent),
        `${trail} should follow ${parent} exactly`
      );
    }
  });

  await t.test("the ungated feed list names no layer that has a gate", () => {
    // UNGATED_FEEDS is what stops "no manifest entry" silently meaning "poll it
    // at every zoom" -- the hole airfieldActivity sat in. A key appearing in
    // both places would reopen it.
    for (const key of UNGATED_FEEDS) {
      const entry = LAYER_MANIFEST[key];
      if (!entry) continue;
      assert.equal(
        entry.fetch,
        FETCH_ALWAYS,
        `${key} is listed as ungated but its manifest entry gates the fetch`
      );
    }
  });
});
