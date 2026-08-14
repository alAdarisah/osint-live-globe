// Task 44: the play button's prefetch/degrade/cache logic
// (frontend/src/replay/playback.js), pulled out of hooks/useReplay.js
// specifically so it has headless coverage -- see that module's own doc
// comment for why. No React, no fetch, no JSX: every function here is a
// plain, pure decision a caller (the playback effect) makes about numbers
// and a small in-memory map.

import test from "node:test";
import assert from "node:assert/strict";

import {
  REPLAY_WINDOW_MS, DEFAULT_FRAME_MS, DEFAULT_STEP_MINUTES,
  FRAME_MS_BOUNDS, STEP_MINUTES_BOUNDS, MAX_STEP_MINUTES,
  PREFETCH_DEPTH, PREFETCH_MAX_INFLIGHT, PLAYBACK_CACHE_MAX, STUTTER_STREAK_LIMIT,
  stutterThresholdMs, isStutter, nextDegradeState, createFrameCache,
} from "../src/replay/playback.js";

test("REPLAY_WINDOW_MS is exactly 24 hours, per task-44-brief.md's own wording", () => {
  assert.equal(REPLAY_WINDOW_MS, 24 * 60 * 60 * 1000);
});

test("the shipped defaults sit inside their own bounds", () => {
  assert.ok(DEFAULT_FRAME_MS >= FRAME_MS_BOUNDS[0] && DEFAULT_FRAME_MS <= FRAME_MS_BOUNDS[1]);
  assert.ok(DEFAULT_STEP_MINUTES >= STEP_MINUTES_BOUNDS[0] && DEFAULT_STEP_MINUTES <= STEP_MINUTES_BOUNDS[1]);
  assert.ok(DEFAULT_STEP_MINUTES <= MAX_STEP_MINUTES);
});

test("the concurrency and cache bounds are small, stated constants -- not accidentally 0 or unbounded", () => {
  assert.ok(PREFETCH_DEPTH >= 1 && PREFETCH_DEPTH <= 5);
  assert.ok(PREFETCH_MAX_INFLIGHT >= 1 && PREFETCH_MAX_INFLIGHT <= 5);
  assert.ok(PLAYBACK_CACHE_MAX >= PREFETCH_DEPTH); // must fit at least the frames it's asked to hold
  assert.ok(Number.isFinite(PLAYBACK_CACHE_MAX));
});

test("stutterThresholdMs is 1.5x frameMs, floored so a tiny frameMs can't make ordinary latency count", () => {
  assert.equal(stutterThresholdMs(2000), 3000);
  // FRAME_MS_BOUNDS' own floor (200ms) would give a 300ms threshold without
  // the floor -- ordinary network latency, not a stutter. The floor exists
  // so a reader who cranks frameMs all the way down doesn't get a scrubber
  // that reports "slowed" on every single frame.
  assert.equal(stutterThresholdMs(200), 1200);
  assert.equal(stutterThresholdMs(800), 1200); // shipped default: 1.5x800=1200, floor makes no difference here
});

test("isStutter is a strict > against the threshold, not >=", () => {
  assert.equal(isStutter(1200, 800), false); // exactly at threshold: not yet a stutter
  assert.equal(isStutter(1201, 800), true);
  assert.equal(isStutter(500, 800), false);
});

test("a single slow frame does not degrade -- STUTTER_STREAK_LIMIT frames in a row are required", () => {
  assert.ok(STUTTER_STREAK_LIMIT >= 2); // a lone blip must not trip this
  const one = nextDegradeState(60, 1);
  assert.equal(one.degraded, false);
  assert.equal(one.stepMinutes, 60);
});

test("STUTTER_STREAK_LIMIT consecutive stutters double the step and reset the streak", () => {
  const result = nextDegradeState(60, STUTTER_STREAK_LIMIT);
  assert.equal(result.degraded, true);
  assert.equal(result.stepMinutes, 120);
  assert.equal(result.streak, 0);
});

test("the degrade is capped at MAX_STEP_MINUTES, and reports no further change once capped", () => {
  const atCap = nextDegradeState(MAX_STEP_MINUTES, STUTTER_STREAK_LIMIT);
  assert.equal(atCap.stepMinutes, MAX_STEP_MINUTES);
  assert.equal(atCap.degraded, false); // doubled === already-was, so nothing actually changed
  const nearCap = nextDegradeState(MAX_STEP_MINUTES - 10, STUTTER_STREAK_LIMIT);
  assert.equal(nearCap.stepMinutes, MAX_STEP_MINUTES); // clamps rather than overshoots
});

test("a below-threshold streak that never reaches the limit is passed straight through", () => {
  const result = nextDegradeState(90, STUTTER_STREAK_LIMIT - 1);
  assert.equal(result.stepMinutes, 90);
  assert.equal(result.streak, STUTTER_STREAK_LIMIT - 1);
  assert.equal(result.degraded, false);
});

// --- createFrameCache -------------------------------------------------

test("a cached frame can be set and read back", () => {
  const cache = createFrameCache(4);
  cache.set(1000, { status: "ready", data: { a: 1 } });
  assert.deepEqual(cache.get(1000), { status: "ready", data: { a: 1 } });
  assert.equal(cache.has(1000), true);
  assert.equal(cache.has(2000), false);
});

test("the cache evicts the oldest entry once it exceeds maxSize", () => {
  const cache = createFrameCache(2);
  cache.set(1, "a");
  cache.set(2, "b");
  cache.set(3, "c"); // pushes out 1
  assert.equal(cache.has(1), false);
  assert.equal(cache.has(2), true);
  assert.equal(cache.has(3), true);
  assert.equal(cache.size(), 2);
});

test("re-setting an existing key refreshes its recency instead of counting as a new entry", () => {
  const cache = createFrameCache(2);
  cache.set(1, "pending");
  cache.set(2, "b");
  cache.set(1, "ready"); // 1 is now the most-recently-touched, not the oldest
  cache.set(3, "c"); // must evict 2, not 1
  assert.equal(cache.has(1), true);
  assert.equal(cache.get(1), "ready");
  assert.equal(cache.has(2), false);
});

test("clear empties the cache entirely", () => {
  const cache = createFrameCache(4);
  cache.set(1, "a");
  cache.set(2, "b");
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.has(1), false);
});

test("delete removes a single entry without disturbing the rest", () => {
  const cache = createFrameCache(4);
  cache.set(1, "a");
  cache.set(2, "b");
  cache.delete(1);
  assert.equal(cache.has(1), false);
  assert.equal(cache.has(2), true);
});

test("the default maxSize is PLAYBACK_CACHE_MAX", () => {
  const cache = createFrameCache();
  for (let i = 0; i < PLAYBACK_CACHE_MAX + 3; i++) cache.set(i, i);
  assert.equal(cache.size(), PLAYBACK_CACHE_MAX);
});
