// Task 44: the play button's own logic, pulled out of hooks/useReplay.js so
// it can be tested headlessly (see frontend/tests/replayPlayback.test.js) --
// the hook itself imports "react" and "../api" through Vite-style
// extensionless specifiers that node --test cannot resolve without the same
// loader hook urlState.test.js/replayAdminTransition.test.js already use,
// and useReplay.js is not JSX so it *could* be imported directly with that
// hook, but the actual decisions below (is this a stutter, how far should a
// degraded step reach, what does the prefetch cache evict) don't need any of
// useReplay's React state or fetch plumbing to be exercised -- keeping them
// here means they don't need it.

// "Animates the last 24 hours" (task-44-brief.md) -- deliberately narrower
// than the scrubber's own 3-day range (hooks/useReplay.js's RANGE_MS, which
// exists to match backend/history.py's retention so a reader can *drag* back
// that far). Play only ever starts a fresh sweep from "24 hours ago", not
// from the scrubber's oldest edge -- a manual scrub can still park anywhere
// in the 3-day range and pressing Play from there plays forward from
// wherever the reader left it, same as it always has.
export const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

// Shipped cadence/step -- exactly what useReplay.js ran at before this task
// made them settings (PLAYBACK_MIN_STEP_MS was 800, and one step per hour
// fell out of RANGE_MS / PLAYBACK_STEPS). Re-derived here as literals rather
// than from the old constants, since the old constants are gone -- this pair
// is now the one source of the shipped cadence, read by both
// settings/defaults.js (the shipped value) and useReplay.js (the fallback
// for a caller that doesn't pass one, e.g. a test).
export const DEFAULT_FRAME_MS = 800;
export const DEFAULT_STEP_MINUTES = 60;

// Range settings/defaults.js clamps a stored or hand-edited value to. Wide
// enough to be a real dial (a slow connection wants a longer frame hold; a
// reader who only cares about the shape of a day wants a coarser step) but
// not so wide a value could make playback silently useless -- a frameMs of 0
// would fire requests as fast as the network could return them (the exact
// failure mode PLAYBACK_MIN_STEP_MS/PLAYBACK_STEPS' own comment in the old
// useReplay.js describes), and a stepMinutes wider than the 24h window would
// make a single step jump past the whole sweep.
export const FRAME_MS_BOUNDS = [200, 5000];
export const STEP_MINUTES_BOUNDS = [5, 360];

// The ceiling the degrade logic below may push stepMinutes to. Four times
// REPLAY_WINDOW_MS's implied hourly default (24 steps at the shipped 60min
// step) -- past this a "sweep" is down to six frames across a whole day,
// which is coarse enough that a further degrade would stop looking like
// playback at all; asking the reader to widen the step themselves, or accept
// a slower sweep, is the more honest answer past this point.
export const MAX_STEP_MINUTES = 360;

// How many frames ahead of the one on screen get prefetched. Small and
// constant, not proportional to anything about the window -- a longer sweep
// just means more *steps*, not a deeper prefetch queue.
export const PREFETCH_DEPTH = 2;

// Bound on concurrent /api/replay requests prefetch alone may hold open,
// separate from (and on top of) the one request the current frame's own step
// is awaiting when it isn't already cached. entity_history is an 11GB table
// pruned to three days and /api/replay is its one sanctioned reader (see
// global-constraints.md) -- prefetching three frames' worth of concurrent
// queries against it defeats the point of prefetching (hiding one round
// trip's latency behind the frame's own dwell time) by turning it into a
// burst of its own. Two lets the *next* frame's fetch start immediately
// after the current one resolves, without ever queuing more than that.
export const PREFETCH_MAX_INFLIGHT = 2;

// Bound on how many decoded frames the prefetch cache holds at once --
// PREFETCH_DEPTH frames ahead, the one currently on screen, and one spare so
// an eviction never has to race a fetch that just landed. Each entry is one
// full /api/replay bundle payload (events/firms/gdelt/ais/adsb, region-
// filtered) -- the same shape and, per frame, the same order of magnitude
// applyData already holds for the *live* layers, so four of them cached at
// once costs at most what four ordinary polls already would.
export const PLAYBACK_CACHE_MAX = PREFETCH_DEPTH + 2;

// How many consecutive stuttering frames it takes before playback degrades
// to a coarser step. Not 1: a single slow frame is ordinary network jitter
// (a GC pause, a Wi-Fi hiccup) and doubling the step size after every jitter
// would make playback jumpier, not smoother. Two in a row is a trend rather
// than a blip.
export const STUTTER_STREAK_LIMIT = 2;

/**
 * The frame-arrival threshold that defines "stuttering", stated as a
 * concrete number rather than a feeling: a frame whose fetch-plus-apply
 * takes longer than 1.5x the configured frame hold (floored at 1.2s so a
 * very short frameMs setting -- 200ms is FRAME_MS_BOUNDS' own floor -- can't
 * make ordinary latency count as a stutter). At the shipped 800ms frameMs
 * that is 1.2s: a step that is supposed to be on screen for 800ms but takes
 * over a second to even arrive is the "stuttered instead of played" case
 * PLAYBACK_MIN_STEP_MS's original comment in useReplay.js worried about --
 * requests piling up faster than the map can draw them.
 */
export function stutterThresholdMs(frameMs) {
  return Math.max(frameMs * 1.5, 1200);
}

/** Whether one frame's own arrival latency counts as a stutter. */
export function isStutter(latencyMs, frameMs) {
  return latencyMs > stutterThresholdMs(frameMs);
}

/**
 * The step-degrade decision for one frame's outcome.
 *
 * @param {number} stepMinutes the step size playback is currently running at
 *   (already possibly degraded from whatever settings configured).
 * @param {number} consecutiveStutters how many frames in a row (including
 *   this one, if it stuttered) have missed the threshold.
 * @returns {{stepMinutes: number, streak: number, degraded: boolean}}
 *   `stepMinutes` is unchanged unless the streak just reached the limit, in
 *   which case it doubles (capped at MAX_STEP_MINUTES) and `streak` resets
 *   to 0 so three-in-a-row doesn't double twice for one bad patch. `degraded`
 *   is true exactly on the step where a change happened -- the caller uses
 *   it to know when to tell the reader, not to mean "currently coarser than
 *   shipped" (the caller's own state already tracks that across calls).
 */
export function nextDegradeState(stepMinutes, consecutiveStutters) {
  if (consecutiveStutters < STUTTER_STREAK_LIMIT) {
    return { stepMinutes, streak: consecutiveStutters, degraded: false };
  }
  const doubled = Math.min(stepMinutes * 2, MAX_STEP_MINUTES);
  return { stepMinutes: doubled, streak: 0, degraded: doubled !== stepMinutes };
}

/**
 * A small LRU-by-insertion-order cache for prefetched frame payloads, keyed
 * by the timestamp (ms) the frame was requested for. Bounded to
 * PLAYBACK_CACHE_MAX entries (see that constant's own comment for the
 * memory bound this implies) -- eviction is oldest-first, same rule and same
 * reasoning as api.js's own etagCache.
 *
 * Entries carry a status so a caller can tell "still in flight" from "ready"
 * from "the fetch itself failed" without a second map: {status: "pending"}
 * while prefetch is awaiting the network, {status: "ready", data} once it
 * resolves, {status: "error", error} if it rejects.
 */
export function createFrameCache(maxSize = PLAYBACK_CACHE_MAX) {
  const entries = new Map();
  return {
    get(ts) {
      return entries.get(ts);
    },
    has(ts) {
      return entries.has(ts);
    },
    set(ts, value) {
      entries.delete(ts); // re-insert so a re-set (pending -> ready) refreshes recency too
      entries.set(ts, value);
      while (entries.size > maxSize) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
      }
    },
    delete(ts) {
      entries.delete(ts);
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}
