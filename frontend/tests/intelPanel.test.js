// Task 12: IntelPanel -- the tabbed panel replacing NotableEventsPanel.jsx
// and NewsBroadcastPanel.jsx.
//
// Three things the task brief calls out as needing headless tests: the scope
// filter for each of the five header scopes, the group-by bucketing, and the
// "nothing qualifies" rule. IntelPanel.jsx itself is JSX and cannot be
// imported under this project's plain `node --test` harness, so all three
// live in intelPanelLogic.js -- see that module's own note, and
// placeInfoCardGrouping.js/placeInfoCard.test.js for the same pattern.
//
// Same loader shim and window.L stub as countryCardSections.test.js /
// summaryTiles.test.js: intelPanelLogic.js reuses map/popups.js's
// insideWaterFeature/bboxesOverlap and map/decorators.js's officialsAgeHours,
// and both pull in Leaflet at module scope.

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
});

globalThis.window = { L: { geoJSON: () => ({}) } };

const {
  makeIntelScope, SCOPE_WORLD, SCOPE_VIEWPORT, SCOPE_COUNTRY, SCOPE_REGION, SCOPE_WATER,
  groupItems, groupKeyFor, UNKNOWN_GROUP,
  intelPanelIsEmpty,
  eventsSeverityFloor, windowMaxAgeDays, withinWindowHours,
  selectEventItems, selectEscalationZones, selectNewsItems, selectOfficialsItems,
} = await import("../src/components/intelPanelLogic.js");

const { DEFAULT_EVENT_FILTER } = await import("../src/map/severity.js");

// ---------- scope filter, one of the five per test.test ----------

test("scope: world", async (t) => {
  await t.test("contains everything and is never deliberate", () => {
    const scope = makeIntelScope(SCOPE_WORLD, {});
    assert.equal(scope.deliberate, false);
    assert.equal(scope.contains(0, 0), true);
    assert.equal(scope.contains(89, 179), true);
    assert.equal(scope.intersectsBounds([0, 0, 1, 1]), true);
  });

  await t.test("is the fallback for every kind when its selection is missing", () => {
    assert.equal(makeIntelScope(SCOPE_COUNTRY, {}).deliberate, false);
    assert.equal(makeIntelScope(SCOPE_REGION, {}).deliberate, false);
    assert.equal(makeIntelScope(SCOPE_WATER, {}).deliberate, false);
    assert.equal(makeIntelScope(SCOPE_VIEWPORT, {}).deliberate, false);
    assert.equal(makeIntelScope("not-a-real-scope", {}).kind, SCOPE_WORLD);
  });
});

test("scope: viewport", async (t) => {
  const mapBounds = { south: 10, west: 10, north: 20, east: 20 };

  await t.test("keeps a point inside the padded viewport, drops one outside it", () => {
    const scope = makeIntelScope(SCOPE_VIEWPORT, { mapBounds });
    assert.equal(scope.deliberate, false);
    assert.equal(scope.contains(15, 15), true);
    assert.equal(scope.contains(80, 80), false);
  });

  await t.test("pads by 25%, same margin every other viewport filter in the app applies", () => {
    const scope = makeIntelScope(SCOPE_VIEWPORT, { mapBounds });
    // 2.5 degrees outside the raw box on a 10-degree box -- inside the 25% pad.
    assert.equal(scope.contains(9, 15), true);
    // Far outside even the padded box.
    assert.equal(scope.contains(-10, 15), false);
  });
});

test("scope: selected country", async (t) => {
  await t.test("delegates straight to the country scope's own predicate", () => {
    let calledWith = null;
    const countryScope = {
      active: true,
      label: "Sudan",
      contains: (lat, lon) => { calledWith = [lat, lon]; return lat > 0; },
      intersectsBounds: () => true,
    };
    const scope = makeIntelScope(SCOPE_COUNTRY, { countryScope });
    assert.equal(scope.deliberate, true);
    assert.equal(scope.label, "Sudan");
    assert.equal(scope.contains(5, 30), true);
    assert.deepEqual(calledWith, [5, 30]);
    assert.equal(scope.contains(-5, 30), false);
  });
});

test("scope: selected region", async (t) => {
  await t.test("contains a point inside the region's own bounds box", () => {
    const region = { label: "Sahel", bounds: [10, -10, 20, 10] };
    const scope = makeIntelScope(SCOPE_REGION, { region });
    assert.equal(scope.deliberate, true);
    assert.equal(scope.label, "Sahel");
    assert.equal(scope.contains(15, 0), true);
    assert.equal(scope.contains(50, 0), false);
  });

  await t.test("intersectsBounds keeps a zone that merely overlaps the region", () => {
    const region = { label: "Sahel", bounds: [10, -10, 20, 10] };
    const scope = makeIntelScope(SCOPE_REGION, { region });
    assert.equal(scope.intersectsBounds([15, 5, 25, 15]), true); // overlapping
    assert.equal(scope.intersectsBounds([30, 30, 40, 40]), false); // nowhere near
  });
});

test("scope: selected water body", async (t) => {
  // A minimal buildWaterIndex-shaped entry: a 4-point box polygon so
  // countryContainsPoint (which insideWaterFeature delegates to) has
  // something real to ray-cast against.
  const entry = {
    id: "w1",
    name: "Test Sea",
    bbox: { minLat: 0, maxLat: 10, minLon: 0, maxLon: 10 },
    polygons: [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]],
    rawBbox: [0, 0, 10, 10],
  };
  const bounds = { south: 0, west: 0, north: 10, east: 10 };

  await t.test("contains a point inside the water polygon", () => {
    const scope = makeIntelScope(SCOPE_WATER, { water: { entry, bounds, label: "Test Sea" } });
    assert.equal(scope.deliberate, true);
    assert.equal(scope.label, "Test Sea");
    assert.equal(scope.contains(5, 5), true);
    assert.equal(scope.contains(50, 50), false);
  });

  await t.test("intersectsBounds uses the feature's antimeridian-aware rawBbox", () => {
    const scope = makeIntelScope(SCOPE_WATER, { water: { entry, bounds, label: "Test Sea" } });
    assert.equal(scope.intersectsBounds([5, 5, 15, 15]), true);
    assert.equal(scope.intersectsBounds([50, 50, 60, 60]), false);
  });
});

// ---------- group-by bucketing ----------

test("group by: none returns no grouping at all", async (t) => {
  await t.test("null, so the caller renders its flat list unchanged", () => {
    assert.equal(groupItems([{ country: "Mali" }], "none", "events"), null);
    assert.equal(groupItems([{ country: "Mali" }], undefined, "events"), null);
  });
});

test("group by: country", async (t) => {
  const items = [
    { country: "Mali", id: 1 },
    { country: "Sudan", id: 2 },
    { country: "Mali", id: 3 },
    { id: 4 }, // no country at all
  ];

  await t.test("buckets by the shared field, largest group first", () => {
    const groups = groupItems(items, "country", "events");
    assert.equal(groups.length, 3);
    assert.equal(groups[0].key, "Mali");
    assert.equal(groups[0].items.length, 2);
  });

  await t.test("a record with no country lands in the shared Unknown bucket, not dropped", () => {
    const groups = groupItems(items, "country", "events");
    const unknown = groups.find((g) => g.key === UNKNOWN_GROUP);
    assert.ok(unknown);
    assert.equal(unknown.items.length, 1);
    assert.equal(unknown.items[0].id, 4);
  });

  await t.test("the Unknown bucket always trails, even when it is the largest", () => {
    const mostlyUnknown = [{ id: 1 }, { id: 2 }, { id: 3 }, { country: "Mali", id: 4 }];
    const groups = groupItems(mostlyUnknown, "country", "events");
    assert.equal(groups[groups.length - 1].key, UNKNOWN_GROUP);
  });
});

test("group by: event type reads a different field per tab", async (t) => {
  await t.test("events reads event_type, officials reads its CAMEO kind", () => {
    assert.equal(groupKeyFor({ event_type: "Battles" }, "eventType", "events"), "Battles");
    assert.equal(groupKeyFor({ kind: "demand" }, "eventType", "officials"), "demand");
  });

  await t.test("news has no event-type field, so every row falls to Unknown", () => {
    assert.equal(groupKeyFor({ real_title: "x" }, "eventType", "news"), null);
    const groups = groupItems([{ real_title: "a" }, { real_title: "b" }], "eventType", "news");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].key, UNKNOWN_GROUP);
  });
});

test("group by: actor combines both actor fields", async (t) => {
  await t.test("joins actor1/actor2 when both are present", () => {
    assert.equal(groupKeyFor({ actor1: "Army", actor2: "Rebels" }, "actor", "events"), "Army vs Rebels");
  });

  await t.test("falls back to whichever single actor exists, and to null with neither", () => {
    assert.equal(groupKeyFor({ actor1: "Army" }, "actor", "events"), "Army");
    assert.equal(groupKeyFor({}, "actor", "events"), null);
  });
});

test("group by: outlet reads the right field per tab", async (t) => {
  await t.test("news reads source_name, officials reads outlet/government, events reads source", () => {
    assert.equal(groupKeyFor({ source_name: "Reuters" }, "outlet", "news"), "Reuters");
    assert.equal(groupKeyFor({ outlet: "AP" }, "outlet", "officials"), "AP");
    assert.equal(groupKeyFor({ government: "State Dept" }, "outlet", "officials"), "State Dept");
    assert.equal(groupKeyFor({ source: "acled" }, "outlet", "events"), "acled");
  });
});

// ---------- "nothing qualifies" rule ----------

test("nothing qualifies: world scope with every tab empty renders nothing", async (t) => {
  await t.test("true when all four counts are zero and the scope is not deliberate", () => {
    assert.equal(
      intelPanelIsEmpty({ escalation: 0, events: 0, news: 0, officials: 0 }, false),
      true
    );
  });

  await t.test("false the moment any one tab has a row", () => {
    assert.equal(intelPanelIsEmpty({ escalation: 1, events: 0, news: 0, officials: 0 }, false), false);
    assert.equal(intelPanelIsEmpty({ escalation: 0, events: 0, news: 0, officials: 3 }, false), false);
  });
});

test("nothing qualifies: a deliberate scope always renders, even with nothing to show", async (t) => {
  await t.test("a country/region/water pick is a direct question -- 'nothing' is an answer", () => {
    assert.equal(
      intelPanelIsEmpty({ escalation: 0, events: 0, news: 0, officials: 0 }, true),
      false
    );
  });
});

// ---------- preserved behaviour: the severity floor ----------

test("events severity floor: 40 at world/passive scope, 0 once deliberately scoped", async (t) => {
  await t.test("world and viewport (both non-deliberate) keep the 40 floor", () => {
    assert.equal(eventsSeverityFloor(makeIntelScope(SCOPE_WORLD, {})), 40);
    assert.equal(
      eventsSeverityFloor(makeIntelScope(SCOPE_VIEWPORT, { mapBounds: { south: 0, west: 0, north: 1, east: 1 } })),
      40
    );
  });

  await t.test("a deliberate scope (country here) drops the floor to 0", () => {
    const countryScope = { active: true, label: "Sudan", contains: () => true, intersectsBounds: () => true };
    assert.equal(eventsSeverityFloor(makeIntelScope(SCOPE_COUNTRY, { countryScope })), 0);
  });
});

test("selectEventItems applies the floor end to end", async (t) => {
  const events = [
    { id: "a", severity: 45, date: "2020-01-01", lat: 1, lon: 1 },
    { id: "b", severity: 10, date: "2020-01-01", lat: 1, lon: 1 },
  ];

  await t.test("at world scope the sub-40 event is dropped", () => {
    const scope = makeIntelScope(SCOPE_WORLD, {});
    const out = selectEventItems(events, { scope, eventFilter: DEFAULT_EVENT_FILTER });
    assert.deepEqual(out.map((e) => e.id), ["a"]);
  });

  await t.test("a deliberately-scoped country keeps the sub-40 event too", () => {
    const countryScope = { active: true, label: "X", contains: () => true, intersectsBounds: () => true };
    const scope = makeIntelScope(SCOPE_COUNTRY, { countryScope });
    const out = selectEventItems(events, { scope, eventFilter: DEFAULT_EVENT_FILTER });
    assert.deepEqual(new Set(out.map((e) => e.id)), new Set(["a", "b"]));
  });
});

// Review fix (Minor 5): nothing previously asserted that the verification
// floor marks a weakly-placed event rather than dropping it -- the whole
// point of the "dims, doesn't filter" design (see selectEventItems' own
// docstring), and easy to silently break by swapping a `continue` back in.
test("selectEventItems marks weaklyPlaced rather than dropping the record", async (t) => {
  const scope = makeIntelScope(SCOPE_WORLD, {});
  const events = [
    { id: "a", severity: 90, date: "2020-01-01", lat: 1, lon: 1, geo_confidence: 10 }, // below the floor
    { id: "b", severity: 90, date: "2020-01-01", lat: 1, lon: 1, geo_confidence: 90 }, // well-placed
    { id: "c", severity: 90, date: "2020-01-01", lat: 1, lon: 1 }, // never scored at all
  ];
  const out = selectEventItems(events, { scope, eventFilter: DEFAULT_EVENT_FILTER });
  const byId = Object.fromEntries(out.map((e) => [e.id, e]));

  await t.test("a weakly-placed event stays in the list, flagged rather than excluded", () => {
    assert.ok(byId.a, "event a must not be dropped");
    assert.equal(byId.a.weaklyPlaced, true);
  });

  await t.test("a well-placed event is not flagged", () => {
    assert.equal(byId.b.weaklyPlaced, false);
  });

  await t.test("an unscored event is not flagged either -- absence is not weakness", () => {
    assert.equal(byId.c.weaklyPlaced, false);
  });
});

// Review fix (Important 3 / Minor 5): there used to be two independent
// day-count checks inside selectEventItems -- one against
// eventFilter.maxAgeDays (via passesEventFilter) and one against the panel's
// own windowHours -- that could disagree. Window is now the only source of
// eventFilter.maxAgeDays (IntelPanel.jsx pushes it there), and
// selectEventItems checks nothing else, so this is the one interaction left
// to assert: that maxAgeDays alone gates the tab correctly at both ends of
// the control's range.
test("selectEventItems honours eventFilter.maxAgeDays as the one Window gate", async (t) => {
  const today = new Date().toISOString().slice(0, 10);
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const events = [
    { id: "today", severity: 90, date: today, lat: 1, lon: 1 },
    { id: "old", severity: 90, date: tenDaysAgo, lat: 1, lon: 1 },
  ];
  const scope = makeIntelScope(SCOPE_WORLD, {});

  await t.test("maxAgeDays: 0 -- Window's 'today only' -- drops the older event", () => {
    const filter = { ...DEFAULT_EVENT_FILTER, maxAgeDays: 0 };
    const out = selectEventItems(events, { scope, eventFilter: filter });
    assert.deepEqual(out.map((e) => e.id), ["today"]);
  });

  await t.test("maxAgeDays: null -- Window's widest option -- keeps both", () => {
    const out = selectEventItems(events, { scope, eventFilter: DEFAULT_EVENT_FILTER });
    assert.deepEqual(new Set(out.map((e) => e.id)), new Set(["today", "old"]));
  });
});

// ---------- window ----------

test("windowMaxAgeDays rounds an hour count up to whole days", async (t) => {
  await t.test("6h and 24h both mean 'today only'", () => {
    assert.equal(windowMaxAgeDays(6), 0);
    assert.equal(windowMaxAgeDays(24), 0);
  });

  await t.test("72h keeps today plus the two days before it", () => {
    assert.equal(windowMaxAgeDays(72), 2);
  });

  await t.test("the widest option (7 days) means no cap, not literally 6", () => {
    // Review fix (Important 3): the widest Window option has to reproduce
    // DEFAULT_EVENT_FILTER.maxAgeDays' own shipped default (null, "no
    // window") now that this is the *only* control writing maxAgeDays --
    // mapping it to a literal 6 would silently narrow the map's Conflict &
    // Violence layer below what it showed before this control existed.
    assert.equal(windowMaxAgeDays(168), null);
    assert.equal(windowMaxAgeDays(500), null);
  });

  await t.test("a non-finite hour count also means no cap", () => {
    assert.equal(windowMaxAgeDays(NaN), null);
    assert.equal(windowMaxAgeDays(undefined), null);
  });
});

test("withinWindowHours keeps a record this app cannot date", async (t) => {
  await t.test("NaN age passes rather than being silently dropped", () => {
    assert.equal(withinWindowHours(NaN, 24), true);
  });

  await t.test("a finite age is compared normally", () => {
    assert.equal(withinWindowHours(10, 24), true);
    assert.equal(withinWindowHours(30, 24), false);
  });
});

// ---------- escalation zones: scope by overlap, sorted by ratio ----------

test("selectEscalationZones sorts ratio desc and scopes by overlap", async (t) => {
  const zones = [
    { region: "a", ratio: 2, bounds: [0, 0, 10, 10] },
    { region: "b", ratio: 5, bounds: [20, 20, 30, 30] },
  ];

  await t.test("world keeps every zone, ranked by ratio", () => {
    const out = selectEscalationZones(zones, makeIntelScope(SCOPE_WORLD, {}));
    assert.deepEqual(out.map((z) => z.region), ["b", "a"]);
  });

  await t.test("a region scope drops a zone that does not overlap it", () => {
    const scope = makeIntelScope(SCOPE_REGION, { region: { label: "R", bounds: [0, 0, 10, 10] } });
    const out = selectEscalationZones(zones, scope);
    assert.deepEqual(out.map((z) => z.region), ["a"]);
  });

  await t.test("Current view scopes escalation too, even though it is not 'deliberate'", () => {
    const scope = makeIntelScope(SCOPE_VIEWPORT, { mapBounds: { south: 0, west: 0, north: 10, east: 10 } });
    const out = selectEscalationZones(zones, scope);
    assert.deepEqual(out.map((z) => z.region), ["a"]);
  });
});

// ---------- news and officials: recency plus dedup ----------

test("selectNewsItems dedupes by source_url and sorts by recency", async (t) => {
  const scope = makeIntelScope(SCOPE_WORLD, {});
  const items = [
    { real_title: "Old", date_added: "20200101000000", source_url: "u1", lat: 0, lon: 0 },
    { real_title: "New", date_added: "20200103000000", source_url: "u2", lat: 0, lon: 0 },
    { real_title: "Dup", date_added: "20200102000000", source_url: "u2", lat: 0, lon: 0 },
    { real_title: "", date_added: "20200104000000", source_url: "u3", lat: 0, lon: 0 }, // no real title
  ];
  const out = selectNewsItems(items, { scope, windowHours: null });
  assert.deepEqual(out.map((i) => i.source_url), ["u2", "u1"]);
});

test("selectOfficialsItems sorts most recent first", async (t) => {
  const scope = makeIntelScope(SCOPE_WORLD, {});
  const items = [
    { kind: "meeting", published_at: 100, lat: 0, lon: 0 },
    { kind: "demand", published_at: 300, lat: 0, lon: 0 },
    { kind: "statement", published_at: 200, lat: 0, lon: 0 },
  ];
  const out = selectOfficialsItems(items, { scope, windowHours: null });
  assert.deepEqual(out.map((i) => i.published_at), [300, 200, 100]);
});
