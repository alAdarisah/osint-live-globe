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
  PREFETCH_DEPTH, PREFETCH_MAX_INFLIGHT, PLAYBACK_CACHE_MAX,
  STUTTER_STREAK_LIMIT, RECOVERY_STREAK_LIMIT,
  stutterThresholdMs, isStutter, nextPlaybackStep, createFrameCache,
} from "../src/replay/playback.js";

// A frame-outcome helper so each test below reads as "this happened, then
// this" rather than repeating the same five-field object literal -- default
// streaks/configuredMinutes match the common case (nothing degraded yet,
// configured at 60) and each test overrides only what it's exercising.
function outcome(overrides) {
  return nextPlaybackStep({
    stepMinutes: 60,
    configuredMinutes: 60,
    stutterStreak: 0,
    goodStreak: 0,
    stuttered: false,
    ...overrides,
  });
}

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

// --- nextPlaybackStep: degrading -----------------------------------------

test("a single stuttering frame does not degrade -- STUTTER_STREAK_LIMIT in a row are required", () => {
  assert.ok(STUTTER_STREAK_LIMIT >= 2); // a lone blip must not trip this
  const result = outcome({ stuttered: true, stutterStreak: 0 });
  assert.equal(result.changed, false);
  assert.equal(result.stepMinutes, 60);
  assert.equal(result.stutterStreak, 1);
});

test("STUTTER_STREAK_LIMIT consecutive stutters double the step and reset both streaks", () => {
  const result = outcome({ stuttered: true, stutterStreak: STUTTER_STREAK_LIMIT - 1, goodStreak: 0 });
  assert.equal(result.changed, true);
  assert.equal(result.stepMinutes, 120);
  assert.equal(result.stutterStreak, 0);
  assert.equal(result.goodStreak, 0);
});

test("the degrade is capped at MAX_STEP_MINUTES, and reports no further change once capped", () => {
  const atCap = outcome({
    stepMinutes: MAX_STEP_MINUTES, configuredMinutes: 60, stuttered: true, stutterStreak: STUTTER_STREAK_LIMIT - 1,
  });
  assert.equal(atCap.stepMinutes, MAX_STEP_MINUTES);
  assert.equal(atCap.changed, false); // doubled === already-was, so nothing actually changed
  const nearCap = outcome({
    stepMinutes: MAX_STEP_MINUTES - 10, configuredMinutes: 60,
    stuttered: true, stutterStreak: STUTTER_STREAK_LIMIT - 1,
  });
  assert.equal(nearCap.stepMinutes, MAX_STEP_MINUTES); // clamps rather than overshoots
});

test("a stutter streak below the limit is passed straight through, and an on-time frame resets it", () => {
  const stillBuilding = outcome({ stuttered: true, stutterStreak: STUTTER_STREAK_LIMIT - 2 });
  assert.equal(stillBuilding.stepMinutes, 60);
  assert.equal(stillBuilding.stutterStreak, STUTTER_STREAK_LIMIT - 1);
  assert.equal(stillBuilding.changed, false);

  // The very next frame arrives on time -- review fix (Task 44): stuttered
  // and goodStreak are mutually exclusive, so an on-time frame must zero the
  // stutter streak rather than let it carry over into a later bad patch.
  const recovered = outcome({ stuttered: false, stutterStreak: STUTTER_STREAK_LIMIT - 1 });
  assert.equal(recovered.stutterStreak, 0);
});

// --- nextPlaybackStep: recovering (review fix, Task 44) -------------------
//
// The first version of this only ever coarsened -- nothing let a degraded
// sweep recover once conditions improved, so one bad patch early in a
// 24-hour sweep left the rest of it coarser than configured long after the
// network had recovered. These tests are the fix.

test("an on-time frame with nothing degraded does not touch stepMinutes at all", () => {
  const result = outcome({ stepMinutes: 60, configuredMinutes: 60, stuttered: false, goodStreak: 3 });
  assert.equal(result.stepMinutes, 60);
  assert.equal(result.changed, false);
  // Nothing to recover from -- the good streak resets rather than climbing
  // forever toward a threshold that would never fire anything.
  assert.equal(result.goodStreak, 0);
});

test("a single on-time frame after a degrade does not recover -- RECOVERY_STREAK_LIMIT in a row are required", () => {
  assert.ok(RECOVERY_STREAK_LIMIT > STUTTER_STREAK_LIMIT); // recovering is deliberately slower than degrading
  const result = outcome({ stepMinutes: 120, configuredMinutes: 60, stuttered: false, goodStreak: 0 });
  assert.equal(result.changed, false);
  assert.equal(result.stepMinutes, 120);
  assert.equal(result.goodStreak, 1);
});

test("RECOVERY_STREAK_LIMIT consecutive on-time frames halve the step and reset both streaks", () => {
  const result = outcome({
    stepMinutes: 120, configuredMinutes: 60, stuttered: false, goodStreak: RECOVERY_STREAK_LIMIT - 1,
  });
  assert.equal(result.changed, true);
  assert.equal(result.stepMinutes, 60);
  assert.equal(result.stutterStreak, 0);
  assert.equal(result.goodStreak, 0);
});

test("recovery never undercuts configuredMinutes, even from an odd degraded value", () => {
  // 90 is what a degrade could leave stepMinutes at if configuredMinutes
  // itself was ever changed mid-sweep (configuredStepMinutesRef in
  // useReplay.js tracks a live settings change) -- halving must clamp to
  // the floor rather than dip under it.
  const result = outcome({
    stepMinutes: 90, configuredMinutes: 60, stuttered: false, goodStreak: RECOVERY_STREAK_LIMIT - 1,
  });
  assert.equal(result.stepMinutes, 60);
});

test("a full round trip: degrade to 120, then recover all the way back to 60", () => {
  // nextPlaybackStep's return value deliberately doesn't echo back
  // configuredMinutes (it's an input, not a piece of state the function
  // owns) -- useReplay.js's own loop re-supplies it from
  // configuredStepMinutesRef.current on every call, which is what this
  // constant models here.
  const configuredMinutes = 60;
  let s = { stepMinutes: 60, stutterStreak: 0, goodStreak: 0 };
  for (let i = 0; i < STUTTER_STREAK_LIMIT; i++) {
    s = nextPlaybackStep({ ...s, configuredMinutes, stuttered: true });
  }
  assert.equal(s.stepMinutes, 120);

  for (let i = 0; i < RECOVERY_STREAK_LIMIT; i++) {
    s = nextPlaybackStep({ ...s, configuredMinutes, stuttered: false });
  }
  assert.equal(s.stepMinutes, 60);
});

test("a stutter mid-recovery resets the good streak back to zero, not just pauses it", () => {
  const configuredMinutes = 60;
  const degraded = outcome({ stuttered: true, stutterStreak: STUTTER_STREAK_LIMIT - 1 });
  assert.equal(degraded.stepMinutes, 120);

  let s = nextPlaybackStep({ ...degraded, configuredMinutes, stuttered: false }); // goodStreak: 1
  assert.equal(s.goodStreak, 1);
  s = nextPlaybackStep({ ...s, configuredMinutes, stuttered: true }); // a fresh stutter
  assert.equal(s.goodStreak, 0);
  assert.equal(s.stepMinutes, 120); // one stutter alone doesn't degrade further
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
