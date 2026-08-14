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
  eventsSeverityFloor, windowMaxAgeDays, withinWindowHours, WINDOW_OPTIONS,
  selectEventItems, selectEscalationZones, selectNewsItems, selectOfficialsItems,
  escalationMiniBarTitle, eventReliabilityTooltip, intelRecordRef,
  escalationEmptyMessage, eventsEmptyMessage, newsEmptyMessage, officialsEmptyMessage,
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

  // maxAgeDays: null is passesEventFilter's own "no window" value -- it is
  // not what any WINDOW_OPTIONS entry produces any more (see the
  // "cross-tab consistency" test below and windowMaxAgeDays' own note), but
  // it is still a real, reachable eventFilter state (DEFAULT_EVENT_FILTER's
  // own shipped default, before IntelPanel's mount effect overwrites it) and
  // this asserts what it does when it occurs.
  await t.test("maxAgeDays: null keeps both -- DEFAULT_EVENT_FILTER's own 'no window' value", () => {
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

  await t.test("7 days is a real 7-day span, not unbounded", () => {
    // Review round 2 (Important): a round-1 fix mapped the widest option to
    // null ("no cap") so it would reproduce DEFAULT_EVENT_FILTER.maxAgeDays'
    // own shipped default -- but withinWindowHours (News/Officials) has no
    // "widest option means unbounded" rule of its own, so that made "7d"
    // mean a real 7 days in two tabs and an unbounded lookback in the third,
    // silently, in the panel's own default state. One label, one span,
    // everywhere -- see this function's own note on why null is gone.
    assert.equal(windowMaxAgeDays(168), 6);
  });

  await t.test("a non-finite hour count still means no cap -- there is no hours value to round", () => {
    assert.equal(windowMaxAgeDays(NaN), null);
    assert.equal(windowMaxAgeDays(undefined), null);
  });
});

// Review round 2's own suggestion: "for each Window option, the cutoff the
// Events tab applies and the cutoff News and Officials apply describe the
// same span" -- this is the test that would have caught the null-at-168 bug,
// end to end through the real select* functions rather than only through
// windowMaxAgeDays in isolation.
test("cross-tab consistency: every Window option bounds every tab the same way", async (t) => {
  const scope = makeIntelScope(SCOPE_WORLD, {});
  const tenDaysAgoMs = Date.now() - 10 * 86400000;
  const tenDaysAgoDate = new Date(tenDaysAgoMs).toISOString().slice(0, 10);
  // GDELT's own "YYYYMMDDHHMMSS" packed format (see utils/format.js's
  // parseGdeltDateAdded), built by hand here rather than imported so this
  // test does not depend on the formatter it is partly exercising.
  function gdeltDateAdded(ms) {
    const d = new Date(ms);
    const p2 = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
      `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
  }

  for (const { hours, label } of WINDOW_OPTIONS) {
    await t.test(`"${label}" excludes a ten-day-old record in every tab -- none of the four means unbounded`, () => {
      const maxAgeDays = windowMaxAgeDays(hours);
      // The regression this test exists to catch, made explicit: a
      // WINDOW_OPTIONS entry is never allowed to translate to "no day cap at
      // all" for the Events tab, because none of them means that for the
      // other two.
      assert.ok(Number.isFinite(maxAgeDays), `"${label}" must be a real, finite day cap`);

      const events = [{ id: "old", severity: 90, date: tenDaysAgoDate, lat: 1, lon: 1 }];
      const eventsOut = selectEventItems(events, {
        scope, eventFilter: { ...DEFAULT_EVENT_FILTER, maxAgeDays },
      });
      assert.equal(eventsOut.length, 0, `Events must drop a 10-day-old record under "${label}"`);

      const news = [{ real_title: "x", date_added: gdeltDateAdded(tenDaysAgoMs), source_url: "u", lat: 1, lon: 1 }];
      const newsOut = selectNewsItems(news, { scope, windowHours: hours });
      assert.equal(newsOut.length, 0, `News must drop a 10-day-old record under "${label}"`);

      const officials = [{ id: "o", kind: "meeting", published_at: Math.floor(tenDaysAgoMs / 1000), lat: 1, lon: 1 }];
      const officialsOut = selectOfficialsItems(officials, { scope, windowHours: hours });
      assert.equal(officialsOut.length, 0, `Officials must drop a 10-day-old record under "${label}"`);
    });
  }
});

// Review round 3: the test above only asserts a floor (a ten-day-old record
// is outside every option's span regardless of exactly where that span's
// edge falls), so an off-by-one -- 168h mapping to 5 instead of 6, say, or
// any re-divergence between windowMaxAgeDays and withinWindowHours -- would
// pass it untouched. This asserts the edge itself: a record just inside a
// window's span is kept by every tab, and one just outside is dropped by
// every tab, which is what actually proves the two functions describe the
// same span rather than merely agreeing that ten days is "too old" either
// way.
//
// Scoped to 72h and 168h, matching windowMaxAgeDays' own comment: those are
// the two options that divide evenly by 24, so ceil(hours/24)-1 reproduces
// the real hour count exactly. 6h and 24h both collapse to "today" in
// day-granular terms and cannot be made to agree with an hour-granular
// cutoff -- ageDays is a calendar-day difference (map/severity.js), so
// Events can admit a record up to roughly eighteen hours staler than News
// and Officials would at either of those two options. That gap is inherent
// to day-granular event data and predates this control entirely; it is
// excluded here rather than asserted away.
test("boundary consistency: at the two day-aligned Window options, every tab agrees on the edge", async (t) => {
  const scope = makeIntelScope(SCOPE_WORLD, {});
  // 24h divides evenly by 24 too, but it is one of the two options this test
  // deliberately excludes (see the block comment above) -- "day-aligned" here
  // means "a whole number of days greater than one", not merely divisible.
  const DAY_ALIGNED_OPTIONS = WINDOW_OPTIONS.filter((o) => o.hours % 24 === 0 && o.hours > 24);
  // A guard on the fixture itself: if WINDOW_OPTIONS ever changes shape,
  // this test should fail loudly rather than silently stop covering
  // anything.
  assert.deepEqual(DAY_ALIGNED_OPTIONS.map((o) => o.hours), [72, 168]);

  function daysAgoDateString(days) {
    const now = new Date();
    const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
    return cutoff.toISOString().slice(0, 10);
  }
  // Same hand-built GDELT packed format as the test above, for the same
  // reason (not depending on the formatter this is partly exercising).
  function gdeltDateAdded(ms) {
    const d = new Date(ms);
    const p2 = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
      `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
  }

  for (const { hours, label } of DAY_ALIGNED_OPTIONS) {
    const maxAgeDays = windowMaxAgeDays(hours);
    const eventFilter = { ...DEFAULT_EVENT_FILTER, maxAgeDays };

    await t.test(`"${label}": a record just inside the span is kept by Events, News and Officials alike`, () => {
      // Events: exactly at the day-granular boundary (ageDays === maxAgeDays
      // is inclusive -- passesEventFilter only drops age > maxAgeDays).
      const events = [{ id: "in", severity: 90, date: daysAgoDateString(maxAgeDays), lat: 1, lon: 1 }];
      assert.equal(selectEventItems(events, { scope, eventFilter }).length, 1, `Events must keep it under "${label}"`);

      // News/Officials: one hour short of the real cutoff.
      const insideMs = Date.now() - (hours - 1) * 3600000;
      const news = [{ real_title: "x", date_added: gdeltDateAdded(insideMs), source_url: "u", lat: 1, lon: 1 }];
      assert.equal(selectNewsItems(news, { scope, windowHours: hours }).length, 1, `News must keep it under "${label}"`);

      const officials = [{ id: "o", kind: "meeting", published_at: Math.floor(insideMs / 1000), lat: 1, lon: 1 }];
      assert.equal(
        selectOfficialsItems(officials, { scope, windowHours: hours }).length, 1,
        `Officials must keep it under "${label}"`
      );
    });

    await t.test(`"${label}": a record just outside the span is dropped by Events, News and Officials alike`, () => {
      // Events: one calendar day past the boundary.
      const events = [{ id: "out", severity: 90, date: daysAgoDateString(maxAgeDays + 1), lat: 1, lon: 1 }];
      assert.equal(selectEventItems(events, { scope, eventFilter }).length, 0, `Events must drop it under "${label}"`);

      // News/Officials: one hour past the real cutoff.
      const outsideMs = Date.now() - (hours + 1) * 3600000;
      const news = [{ real_title: "x", date_added: gdeltDateAdded(outsideMs), source_url: "u", lat: 1, lon: 1 }];
      assert.equal(selectNewsItems(news, { scope, windowHours: hours }).length, 0, `News must drop it under "${label}"`);

      const officials = [{ id: "o", kind: "meeting", published_at: Math.floor(outsideMs / 1000), lat: 1, lon: 1 }];
      assert.equal(
        selectOfficialsItems(officials, { scope, windowHours: hours }).length, 0,
        `Officials must drop it under "${label}"`
      );
    });
  }
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

// ---------- opening a row's own record detail card ----------
//
// intelRecordRef is what a panel row's onClick calls to find out which kind
// and id App.jsx's openRecordDetail(kind, id) should open -- the same card a
// map pin or a country-card row already opens. Three shapes, matching the
// task brief's own three cases: a row that resolves to a real record, a row
// whose tab has no card at all, and a row whose own record has aged out of
// the feed by the time it might be clicked.

test("intelRecordRef: a normal row resolves to the map's own kind and id", async (t) => {
  await t.test("events reads id, and maps to recordDetail's own 'events' kind", () => {
    assert.deepEqual(intelRecordRef({ id: 42, severity: 80 }, "events"), { kind: "events", id: "42" });
  });

  await t.test("news reads event_id, not id, and maps to recordDetail's 'gdelt' kind", () => {
    assert.deepEqual(
      intelRecordRef({ event_id: "gd-1", real_title: "x" }, "news"),
      { kind: "gdelt", id: "gd-1" }
    );
  });

  await t.test("officials reads id, and maps to recordDetail's own 'officials' kind", () => {
    assert.deepEqual(intelRecordRef({ id: "off-9", kind: "meeting" }, "officials"), { kind: "officials", id: "off-9" });
  });
});

test("intelRecordRef: a row kind that has no card at all", async (t) => {
  await t.test("Escalation never resolves, whatever fields a zone carries -- a zone is a region " +
    "aggregate, not a fused record with an id recordDetail's own tables know", () => {
    assert.equal(intelRecordRef({ id: "zone-1", region: "sahel" }, "escalation"), null);
  });

  await t.test("an unrecognised tab kind resolves to nothing either, rather than guessing", () => {
    assert.equal(intelRecordRef({ id: "x" }, "not-a-real-tab"), null);
  });
});

test("intelRecordRef: a row with no id of its own cannot be opened", async (t) => {
  await t.test("a News row missing event_id -- the same gap its own rowKey already falls back to " +
    "source_url for (see IntelPanel.jsx's TabList call for the News tab)", () => {
    assert.equal(intelRecordRef({ real_title: "x", source_url: "u" }, "news"), null);
  });

  await t.test("an empty-string id counts as no id, not a real one", () => {
    assert.equal(intelRecordRef({ id: "" }, "events"), null);
  });

  await t.test("no item at all", () => {
    assert.equal(intelRecordRef(null, "events"), null);
  });
});

// Task brief's third case: "a row whose event has aged out". The check that
// actually answers that -- is this id still in the live feed right now -- is
// recordDetail's own lookup inside createMapController.js, run fresh at
// click time and already wired to say so honestly rather than open an empty
// card or do nothing (see App.jsx's openRecordDetail). intelRecordRef takes
// no raw feed and does not re-run that check: it only resolves *which* id to
// hand recordDetail. This test pins that boundary -- a row for a record that
// has since aged out of eventsRaw still resolves to a normal ref here, the
// same as any other row for its tab, because whether the id is still live is
// not this function's question to answer. Re-deciding it here too, against
// IntelPanel's own eventsRaw/gdeltRaw/officialsRaw props (plain React state,
// updated on a different tick than the map controller's own internal `raw`
// that recordDetail reads), would be exactly the two-independent-opinions
// bug Task 12's review caught for eventFilter.maxAgeDays -- see
// windowMaxAgeDays' own note above.
test("intelRecordRef: an aged-out record still resolves -- staleness is recordDetail's call, not resolution's", async (t) => {
  await t.test("an events row whose id is absent from every currently-held feed still resolves normally", () => {
    // A row shaped exactly like one selectEventItems could have returned a
    // moment ago, for a record the (hypothetical) current eventsRaw no
    // longer carries at all -- aged out of the window, or dropped by a
    // reload between render and click.
    const staleRow = { id: "aged-1", severity: 90, weaklyPlaced: false };
    assert.deepEqual(intelRecordRef(staleRow, "events"), { kind: "events", id: "aged-1" });
  });

  await t.test("the same holds for News and Officials rows", () => {
    assert.deepEqual(intelRecordRef({ event_id: "aged-2", real_title: "x" }, "news"), { kind: "gdelt", id: "aged-2" });
    assert.deepEqual(intelRecordRef({ id: "aged-3", kind: "demand" }, "officials"), { kind: "officials", id: "aged-3" });
  });
});

// ---------- user-visible strings ----------
//
// IntelPanel.jsx is JSX and this headless suite cannot import it -- every
// sentence the panel shows a reader has to live in intelPanelLogic.js
// instead so it can be pinned here, the same discipline this module's other
// exports already follow.

test("escalationMiniBarTitle states both figures and the flat-baseline caveat", () => {
  const title = escalationMiniBarTitle({ current: 12, baseline_per_day: 4 });
  assert.match(title, /12 events in the last 24h/);
  assert.match(title, /4\/day baseline/);
  assert.match(title, /trailing 7 days/);
  assert.match(title, /no day-by-day history behind this yet/);
});

test("eventReliabilityTooltip prints the record's own score when it has one", () => {
  const tooltip = eventReliabilityTooltip({ reliability: 72 }, { min: 50 });
  assert.match(tooltip, /Reliability 72\/100/);
  assert.match(tooltip, /who is behind this report/);
});

test("eventReliabilityTooltip falls back to the band's own floor for an unscored record", () => {
  const tooltip = eventReliabilityTooltip({ reliability: null }, { min: 30 });
  assert.match(tooltip, /Reliability 30\/100/);
});

test("escalationEmptyMessage names the place for a deliberate scope, and speaks generally for World", () => {
  assert.equal(
    escalationEmptyMessage({ deliberate: true, label: "Ukraine" }),
    "No zone inside Ukraine is currently running above its own baseline."
  );
  assert.equal(
    escalationEmptyMessage({ deliberate: false, label: "World" }),
    "No region is currently running above its own 7-day baseline."
  );
});

test("eventsEmptyMessage points a deliberate scope at the window/scope controls, and World at the significance floor", () => {
  const scoped = eventsEmptyMessage({ deliberate: true, label: "Yemen" });
  assert.match(scoped, /No recorded conflict activity in Yemen/);
  assert.match(scoped, /Widen the window, or clear the scope/);

  const world = eventsEmptyMessage({ deliberate: false, label: "World" });
  assert.match(world, /Nothing clears the significance bar/);
});

test("newsEmptyMessage names the place for a deliberate scope, and speaks generally for World", () => {
  assert.equal(newsEmptyMessage({ deliberate: true, label: "Taiwan Strait" }), "No recent headlines for Taiwan Strait.");
  assert.equal(newsEmptyMessage({ deliberate: false, label: "World" }), "No recent headlines for this area.");
});

test("officialsEmptyMessage names the place for a deliberate scope, and speaks generally for World", () => {
  assert.equal(
    officialsEmptyMessage({ deliberate: true, label: "Red Sea" }),
    "No diplomatic activity recorded for Red Sea."
  );
  assert.equal(
    officialsEmptyMessage({ deliberate: false, label: "World" }),
    "No diplomatic activity in the current window."
  );
});
