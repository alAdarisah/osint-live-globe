// Must be first -- feedItemLogic.js imports map/svgIcons.js for the chip
// glyphs, and that chain reads window.L at import time.
import "./helpers/nodeTestEnv.js";

import test from "node:test";
import assert from "node:assert/strict";

const {
  ACTIVITY_CHIPS, ACTIVITY_MAX_ITEMS,
  activityCategory, filterByChip, activityTimestamp, selectActivityItems, activityEmptyMessage,
} = await import("../src/components/feed/feedItemLogic.js");

test("the chip row leads with All and every other chip carries a glyph", () => {
  assert.equal(ACTIVITY_CHIPS[0].key, "all");
  for (const chip of ACTIVITY_CHIPS.slice(1)) {
    assert.ok(chip.glyph && chip.glyph.trim(), `${chip.key} has no glyph`);
    assert.ok(chip.label, `${chip.key} has no label`);
  }
  assert.equal(new Set(ACTIVITY_CHIPS.map((c) => c.key)).size, ACTIVITY_CHIPS.length);
});

test("each chip category is reachable from real event wording", () => {
  assert.equal(activityCategory({ event_type: "Air/drone strike" }), "strike");
  assert.equal(activityCategory({ event_type: "Shelling/artillery/missile attack" }), "strike");
  assert.equal(activityCategory({ event_type: "Explosions", sub_event_type: "Remote explosive/landmine/IED" }), "explosion");
  assert.equal(activityCategory({ event_type: "Naval clash at the port" }), "naval");
  assert.equal(activityCategory({ event_type: "Helicopter incursion" }), "air");
  assert.equal(activityCategory({ event_type: "Armed clash" }), "ground");
});

test("a record this cannot place is not forced into a bucket", () => {
  // Filing an unrecognised type under the biggest bucket would be inventing a
  // fact about it. Null means "no honest claim" and the row shows under All.
  assert.equal(activityCategory({ event_type: "Strategic developments" }), null);
  assert.equal(activityCategory({}), null);
  assert.equal(activityCategory(null), null);
  // News and officials rows are not conflict events and are never categorised.
  assert.equal(activityCategory({ feed: "news", event_type: "Armed clash" }), null);
  assert.equal(activityCategory({ feed: "officials", event_type: "Armed clash" }), null);
});

test("All keeps everything, including what could not be categorised", () => {
  const items = [
    { id: 1, event_type: "Air strike" },
    { id: 2, event_type: "Strategic developments" },
    { id: 3, feed: "news" },
  ];
  assert.equal(filterByChip(items, "all").length, 3);
  assert.equal(filterByChip(items, null).length, 3);
  assert.deepEqual(filterByChip(items, "strike").map((i) => i.id), [1]);
  assert.deepEqual(filterByChip(items, "naval"), []);
  assert.deepEqual(filterByChip(null, "strike"), []);
});

test("a timestamp is read from whichever convention the feed uses", () => {
  // Three feeds, three shapes -- and the point of the merge is that they end up
  // on one axis.
  assert.equal(activityTimestamp({ published_at: 1755300000 }), 1755300000000);
  assert.equal(activityTimestamp({ date_added: "20260814093000" }), Date.UTC(2026, 7, 14, 9, 30, 0));
  assert.equal(activityTimestamp({ date: "2026-08-14" }), Date.UTC(2026, 7, 14));
  assert.equal(activityTimestamp({}), null);
  assert.equal(activityTimestamp(null), null);
  assert.equal(activityTimestamp({ date_added: "not a date!!" }), null);
});

test("the stream is one merged list, most recent first", () => {
  const out = selectActivityItems({
    events: [{ id: "e", date: "2026-08-10" }],
    news: [{ id: "n", date_added: "20260814120000" }],
    officials: [{ id: "o", published_at: Date.UTC(2026, 7, 12) / 1000 }],
  });
  assert.deepEqual(out.map((i) => i.id), ["n", "o", "e"]);
  // Each row remembers which feed it came from, so it can be drawn in its own
  // idiom and so the chip filter knows what it has no claim about.
  assert.deepEqual(out.map((i) => i.feed), ["news", "officials", "events"]);
});

test("an undateable record sorts last rather than disappearing", () => {
  // Same rule passesEventFilter applies to a dateless event: state the gap,
  // never drop the record over it.
  const out = selectActivityItems({
    events: [{ id: "dated", date: "2026-08-10" }, { id: "undated" }],
  });
  assert.deepEqual(out.map((i) => i.id), ["dated", "undated"]);
  assert.equal(out.length, 2);
});

test("the stream is capped, and the cap keeps the newest", () => {
  const events = Array.from({ length: ACTIVITY_MAX_ITEMS + 50 }, (_, i) => ({
    id: `e${i}`,
    published_at: 1000 + i,
  }));
  const out = selectActivityItems({ events });
  assert.equal(out.length, ACTIVITY_MAX_ITEMS);
  assert.equal(out[0].id, `e${ACTIVITY_MAX_ITEMS + 49}`);
});

test("an empty stream still says something, scoped or not", () => {
  assert.match(activityEmptyMessage({ deliberate: true, label: "Sudan" }), /Sudan/);
  assert.match(activityEmptyMessage({ deliberate: false }), /current window/);
  assert.ok(activityEmptyMessage(undefined));
});

test("no input at all is an empty stream, not a crash", () => {
  assert.deepEqual(selectActivityItems(), []);
  assert.deepEqual(selectActivityItems({}), []);
});
