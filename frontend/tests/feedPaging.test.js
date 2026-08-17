// What replaced the four item caps.
//
// The caps were 6 events (8 scoped), 8 news, 8 officials, and they had no test at
// all -- `grep NEWS_MAX_ITEMS tests/` found nothing -- which is part of why they
// survived the panel becoming a full-height rail. The backend was serving 334
// news rows and 530 events to a browser that rendered eight and six.

import test from "node:test";
import assert from "node:assert/strict";

import {
  FEED_PAGE_SIZE,
  visibleCount,
  hasMore,
  feedCountReadout,
  pagingResetKey,
} from "../src/components/feed/feedPaging.js";

test("the first page is what mounts, however long the list is", () => {
  assert.equal(visibleCount(530, 1), FEED_PAGE_SIZE);
  assert.equal(visibleCount(334, 1), FEED_PAGE_SIZE);
  // A list shorter than a page is not padded to one.
  assert.equal(visibleCount(6, 1), 6);
  assert.equal(visibleCount(0, 1), 0);
});

test("each revealed page adds one page's worth, and never overshoots the list", () => {
  assert.equal(visibleCount(530, 2), FEED_PAGE_SIZE * 2);
  assert.equal(visibleCount(530, 3), FEED_PAGE_SIZE * 3);
  assert.equal(visibleCount(45, 2), 45, "clamped to the real length");
  assert.equal(visibleCount(45, 99), 45);
});

test("nonsense inputs degrade to something renderable", () => {
  // These arrive from a list length and a counter, so neither should ever be
  // strange -- but a NaN page count that produced NaN rows would render an empty
  // tab that looks exactly like a dead feed.
  assert.equal(visibleCount(NaN, 1), 0);
  assert.equal(visibleCount(100, NaN), FEED_PAGE_SIZE);
  assert.equal(visibleCount(100, 0), FEED_PAGE_SIZE);
  assert.equal(visibleCount(100, -5), FEED_PAGE_SIZE);
  assert.equal(visibleCount(-3, 1), 0);
});

test("there is more to reveal until there is not", () => {
  assert.equal(hasMore(530, 1), true);
  assert.equal(hasMore(FEED_PAGE_SIZE, 1), false, "an exact page is complete");
  assert.equal(hasMore(FEED_PAGE_SIZE + 1, 1), true);
  assert.equal(hasMore(0, 1), false);
  assert.equal(hasMore(80, 2), false);
});

test("the tab count reports the total, not the page size", () => {
  // The bug this replaces: the badge was the length of the array *after* the
  // selector sliced it, so a tab with 334 articles behind it read "8". A number
  // that looks like a total and is a page size is worse than no number, because a
  // reader has no way to tell.
  const partial = feedCountReadout(334, 1);
  assert.equal(partial.text, `${FEED_PAGE_SIZE} / 334`);
  assert.match(partial.title, /334/);

  const complete = feedCountReadout(334, 99);
  assert.equal(complete.text, "334", "no 334 / 334");
  assert.match(complete.title, /all shown/);
});

test("a genuine zero says zero, and says why elsewhere", () => {
  // The one count that is allowed to be a bare 0: nothing matched. The tab body
  // carries the sentence that distinguishes "looked and found nothing" from "did
  // not look" (escalationEmptyMessage and its four siblings), so this only has to
  // avoid claiming otherwise.
  const none = feedCountReadout(0, 1);
  assert.equal(none.text, "0");
  assert.match(none.title, /Nothing/);
  assert.equal(feedCountReadout(undefined, 1).text, "0");
});

test("the reveal resets on what the reader chose, not on what arrived", () => {
  // The whole point of keying the reset. The rail refetches every 60 seconds, and
  // a reset on new data would drag a reader who had scrolled to row 300 back to
  // the top once a minute.
  const base = { tab: "news", scopeKind: "world", windowHours: 72, chip: "all" };
  assert.equal(pagingResetKey(base), pagingResetKey({ ...base }));

  for (const change of [
    { tab: "events" },
    { scopeKind: "country" },
    { windowHours: 24 },
    { chip: "strikes" },
  ]) {
    assert.notEqual(
      pagingResetKey({ ...base, ...change }),
      pagingResetKey(base),
      `${JSON.stringify(change)} must reset the reveal`,
    );
  }
});

test("an unbounded window and a missing one are the same key, not different ones", () => {
  // windowHours is null for "All available", and a null that stringified to ""
  // would collide with an absent value. It resolves to "all" instead, so the two
  // readings of "no cap" cannot produce two different keys and a spurious reset.
  assert.equal(
    pagingResetKey({ tab: "news", scopeKind: "world", windowHours: null, chip: "all" }),
    pagingResetKey({ tab: "news", scopeKind: "world", chip: "all" }),
  );
});
