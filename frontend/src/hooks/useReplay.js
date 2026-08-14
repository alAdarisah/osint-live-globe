// Drives the bottom timeline bar: owns the scrubbed timestamp, playback,
// and fetching/applying the point-in-time payload from /api/replay. While
// replay is active, App.jsx drops the live pollers' onData calls (see the
// replayActiveRef wiring there) so live data can't clobber whatever moment
// is on screen -- exiting replay calls refetchAllNow() to snap straight
// back to current data instead of waiting out each source's own interval.
//
// Task 44 added three things on top of what was already here (the play
// button itself, and the 3-day scrubber range, both shipped by an earlier
// task): frame cadence and step size as settings rather than bare constants,
// prefetch of the next frames with an observable degrade instead of a
// silent stutter, and a per-kind availability check so the scrubber can say
// which of the five replayed kinds actually have history rather than
// showing an empty layer that looks the same as "nothing happened". The
// actual decision logic for all three lives in ../replay/playback.js and
// ../replay/availability.js, pure modules with their own headless test
// coverage -- this file is the React wiring around them.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson, urlForRegion } from "../api";
import {
  REPLAY_WINDOW_MS, DEFAULT_FRAME_MS, DEFAULT_STEP_MINUTES,
  PREFETCH_DEPTH, PREFETCH_MAX_INFLIGHT, isStutter, nextDegradeState, createFrameCache,
} from "../replay/playback";
import { REPLAY_KINDS } from "../replay/availability";

const RANGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days, matches backend/history.py's retention

/**
 * Whether leaving Admin Mode should snap replay back to live -- true only on
 * a genuine "was on, now off" transition, never merely because Admin Mode
 * happens to be off right now.
 *
 * Task 35 review (Critical 2): App.jsx seeds a restored deep link's replay
 * moment straight into useReplay's initial state, so `isReplaying` can be
 * true on the very first render while `adminMode` is (as it is for most
 * visitors, by default) false. A predicate that only checked "not admin mode
 * and replaying" could not tell that apart from an admin who had just
 * switched Admin Mode off mid-replay -- and fired `goLive()` on mount for
 * the first case as readily as the second, silently discarding the very
 * moment a share link exists to hand a non-admin reader. The two need
 * different answers: the first should keep showing the restored moment
 * (nothing to exit -- the transition never happened), the second should go
 * live.
 *
 * `prevAdminMode` is the *previous* render's value, not the current one --
 * the caller (App.jsx) tracks it in a ref mutated inside the same effect
 * that calls this, since only the caller knows what "previous" means across
 * renders. A pure predicate rather than inline in that effect so the one
 * seam this bug actually lived in has a headless test, even though the
 * effect wiring around it does not.
 *
 * Task 44 note: play/pause state has the identical exposure -- a restored
 * deep link never carries `isPlaying` (see urlState.js's own module doc for
 * why playback state is not serialized at all), so this predicate's
 * "replaying" check alone is enough to cover it too. Nothing here needed to
 * change; recorded so the next reader doesn't have to re-derive it.
 */
export function shouldExitReplayOnAdminModeChange(prevAdminMode, adminMode, isReplaying) {
  return !!prevAdminMode && !adminMode && !!isReplaying;
}

export function useReplay({
  applyData,
  currentRegionKey,
  onExitReplay,
  initialReplayAt = null,
  // Task 44: settings/defaults.js's `replay.frameMs`/`replay.stepMinutes`,
  // with the exact values useReplay.js ran at as bare constants before this
  // task as the fallback -- a caller that doesn't pass these (a test, or
  // App.jsx before Admin Mode's settings have loaded) gets the same cadence
  // this hook always had.
  frameMs = DEFAULT_FRAME_MS,
  stepMinutes = DEFAULT_STEP_MINUTES,
}) {
  const [now, setNow] = useState(() => Date.now());
  // null == live (not scrubbed back); otherwise a specific past timestamp.
  // Task 35: a restored deep link starts scrubbed back rather than live --
  // seeded straight into the initial state (a state initializer, not an
  // effect) so the very first render already reads as replaying, instead of
  // painting live data for one frame and then jumping back.
  const [replayAt, setReplayAt] = useState(initialReplayAt);
  const [isPlaying, setIsPlaying] = useState(false);

  // Task 44: the step size playback is actually running at, in minutes.
  // Starts at (and, whenever playback is not running, tracks) the configured
  // `stepMinutes` -- the sync effect below keeps it there while paused/live
  // so a settings change is picked up by the next play, and the playback
  // effect is the only thing that moves it away from that while a sweep is
  // actually running (see nextDegradeState in replay/playback.js).
  const [playbackStep, setPlaybackStep] = useState(stepMinutes);
  // True only on the step where a degrade just happened, for a UI note
  // ("Slowed to Xmin steps") -- not reset when playback stops, so pausing or
  // reaching the live edge mid-degrade still explains why the sweep looked
  // coarser than configured right up to that point. Reset by the sync
  // effect the next time playback is *not* running and settings still match
  // what shipped, i.e. once nothing is left to explain.
  const [playbackDegraded, setPlaybackDegraded] = useState(false);

  // Task 44: which of REPLAY_KINDS actually has history -- see
  // ../replay/availability.js for what each status means and why "events"
  // gets a "refused" state distinct from "unavailable". null means "not
  // checked for this replay session yet" (also what a fresh goLive() resets
  // it to); {} means the check is in flight; otherwise
  // {[kind]: "ok"|"no_history"|"unavailable"|"refused"|"error"}.
  //
  // kind_has_history (what /api/replay?kind= ultimately answers with) is
  // not scoped to a moment or a window -- it is a plain "has this kind ever
  // written a row", so re-running the check on every frame of a sweep would
  // just be REPLAY_KINDS.length more requests per step for an answer that
  // cannot have changed since the sweep started. Checked once per replay
  // session instead (the effect below, keyed on "replaying and not yet
  // checked"), which is a fixed REPLAY_KINDS.length (five) requests
  // regardless of how long playback runs -- unlike the per-frame bundle
  // fetch and its prefetch, this does not scale with the sweep at all.
  const [kindAvailability, setKindAvailability] = useState(null);

  const regionRef = useRef(currentRegionKey);
  regionRef.current = currentRegionKey;

  const frameMsRef = useRef(frameMs);
  frameMsRef.current = frameMs;

  // "now" only needs to be fresh enough to keep the slider's right edge
  // accurate -- once a minute is plenty and avoids re-rendering every second
  // like the title bar's clock does.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  const isReplaying = replayAt !== null;

  // Every snapshot request takes a ticket, and only the newest ticket is
  // allowed to paint. Without this, a slow /api/replay response for an older
  // timestamp can land *after* a newer one (or after "Live" has already
  // restored current data) and quietly repaint the map with the wrong
  // moment. Bumped by scrubTo/goLive too, so leaving replay cancels whatever
  // was still in flight.
  const fetchSeqRef = useRef(0);

  // Raw fetch, no ticket, no apply -- the piece the playback loop's prefetch
  // below needs on its own, since a prefetched frame is decoded well before
  // anyone knows whether it will still be the current frame by the time its
  // turn comes.
  const fetchReplayPayload = useCallback(
    (ts) => fetchJson(urlForRegion(`/api/replay?at=${ts / 1000}`, regionRef.current)),
    []
  );
  const fetchReplayPayloadRef = useRef(fetchReplayPayload);
  fetchReplayPayloadRef.current = fetchReplayPayload;

  const applyReplayPayload = useCallback(
    (data) => {
      applyData("events", data.events);
      applyData("firms", data.firms);
      applyData("gdelt", data.gdelt);
      applyData("ais", data.ais);
      applyData("adsb", data.adsb);
    },
    [applyData]
  );
  const applyReplayPayloadRef = useRef(applyReplayPayload);
  applyReplayPayloadRef.current = applyReplayPayload;

  const fetchAt = useCallback(
    async (ts) => {
      const seq = ++fetchSeqRef.current;
      try {
        const data = await fetchReplayPayload(ts);
        if (seq !== fetchSeqRef.current) return; // superseded while in flight
        applyReplayPayload(data);
      } catch (err) {
        console.warn("Failed to fetch replay snapshot:", err);
      }
    },
    [fetchReplayPayload, applyReplayPayload]
  );

  // Task 35: a restored deep link seeded replayAt above but has not actually
  // fetched that moment's snapshot yet -- seekTo's own fetch is debounced for
  // a scrub gesture, which there is none of here, so this issues the one
  // fetch directly, once, on mount. Deliberately not in seekTo/scrubTo's own
  // path: those exist for the *scrubber*, and folding a "first paint" case
  // into a debounced, ticket-guarded function built for a drag gesture would
  // be exactly the kind of one function serving two unrelated callers this
  // codebase avoids elsewhere (see onEventFilterChange's own note in App.jsx
  // for the general shape of that argument).
  useEffect(() => {
    if (initialReplayAt != null) fetchAt(initialReplayAt);
    // Mount-only by design -- see the comment above. fetchAt/initialReplayAt
    // are not expected to change identity in a way that should re-fire this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Task 44: the prefetch cache and its in-flight tracker, one each per hook
  // instance (i.e. per map). See replay/playback.js's own comments on
  // createFrameCache/PLAYBACK_CACHE_MAX for the memory bound and
  // PREFETCH_MAX_INFLIGHT for the concurrency bound. Cleared -- not just left
  // to age out -- on any jump that makes the queued frames stop being useful:
  // a manual scrub (scrubTo below), leaving replay (goLive below), or a
  // region change (the effect just below), since every cached entry's own
  // fetch is a region-scoped URL.
  const cacheRef = useRef(null);
  if (!cacheRef.current) cacheRef.current = createFrameCache();
  const inflightRef = useRef(new Set());

  useEffect(() => {
    cacheRef.current.clear();
  }, [currentRegionKey]);

  // Debounced so dragging the slider doesn't fire a request per pixel --
  // only the settled position actually fetches. Playback doesn't come
  // through here; it awaits each snapshot itself (see below).
  const fetchTimerRef = useRef(null);
  const seekTo = useCallback(
    (ts) => {
      setReplayAt(ts);
      clearTimeout(fetchTimerRef.current);
      fetchTimerRef.current = setTimeout(() => fetchAt(ts), 120);
    },
    [fetchAt]
  );

  // The slider's own handler. Grabbing the scrubber stops playback: otherwise
  // each playback step writes replayAt back and yanks the thumb out from
  // under the cursor mid-drag.
  const scrubTo = useCallback(
    (ts) => {
      setIsPlaying(false);
      fetchSeqRef.current += 1; // discard any snapshot still in flight
      cacheRef.current.clear(); // a manual jump makes every prefetched frame stale
      seekTo(ts);
    },
    [seekTo]
  );

  const goLive = useCallback(() => {
    clearTimeout(fetchTimerRef.current);
    fetchSeqRef.current += 1; // a late replay snapshot must not repaint over live data
    cacheRef.current.clear();
    setIsPlaying(false);
    setReplayAt(null);
    setKindAvailability(null); // next replay session re-checks from scratch
    onExitReplay?.();
  }, [onExitReplay]);

  // Read by the playback loop below so each step can compute the next
  // position, and reach the current fetch/goLive, without taking any of them
  // as effect dependencies (which would tear the loop down and restart it).
  const replayAtRef = useRef(replayAt);
  replayAtRef.current = replayAt;
  const goLiveRef = useRef(goLive);
  goLiveRef.current = goLive;

  // Playback: steps replayAt forward until it reaches "now", then hands
  // control back to live data automatically. Each step *awaits* its snapshot
  // (or takes one already sitting in the prefetch cache) and only then
  // schedules the next one, so there is never more than one *displayed*
  // frame's fetch outstanding at a time -- a plain setInterval fired a
  // request every tick regardless of whether the previous one had returned,
  // which piled up out-of-order responses and re-rendered the heavy layers
  // (FIRMS is ~49k points) faster than the map could draw them. Prefetch
  // below adds up to PREFETCH_MAX_INFLIGHT *more* requests on top of that one,
  // for frames not yet on screen -- see that constant's own comment for why
  // that is bounded rather than proportional to the sweep.
  //
  // Steps run in an effect body rather than a setState updater, since
  // updaters can run twice under StrictMode and a network fetch isn't safe
  // to duplicate that way.
  useEffect(() => {
    if (!isPlaying) return undefined;
    let cancelled = false;
    let timer = null;
    const cache = cacheRef.current;
    const inflight = inflightRef.current;
    // Local, not React state, for the same reason replayAtRef exists: this
    // loop must not tear down and rebuild (which would drop whatever fetch
    // was in flight) every time a degrade nudges the step size. `playbackStep`
    // seeds it; setPlaybackStep below keeps the *displayed* value in sync for
    // TimelineBar without the loop itself depending on the state.
    let stepMinutesLocal = playbackStep;
    let stutterStreak = 0;

    // Fetches one frame ahead of time and parks it in the cache, bounded by
    // PREFETCH_MAX_INFLIGHT concurrent prefetches -- a full queue simply
    // skips prefetching this round rather than queuing, since the next
    // step's own fallback fetch (below) covers a frame that never got
    // prefetched anyway.
    const prefetch = (ts) => {
      if (ts >= Date.now()) return; // nothing to prefetch past the live edge
      if (cache.has(ts)) return;
      if (inflight.size >= PREFETCH_MAX_INFLIGHT) return;
      inflight.add(ts);
      cache.set(ts, { status: "pending" });
      fetchReplayPayloadRef
        .current(ts)
        .then((data) => {
          if (!cancelled) cache.set(ts, { status: "ready", data });
        })
        .catch((err) => {
          if (!cancelled) cache.set(ts, { status: "error", error: err });
        })
        .finally(() => inflight.delete(ts));
    };

    const step = async () => {
      const startedAt = Date.now();
      const base = replayAtRef.current ?? startedAt - REPLAY_WINDOW_MS;
      const stepMs = stepMinutesLocal * 60000;
      const next = base + stepMs;
      if (next >= Date.now()) {
        goLiveRef.current();
        return;
      }
      clearTimeout(fetchTimerRef.current); // playback supersedes a pending scrub fetch
      setReplayAt(next);
      replayAtRef.current = next; // the next step runs before React re-renders on a slow fetch

      // Queue the next PREFETCH_DEPTH frames before waiting on this one's own
      // data, so their network round trip overlaps this frame's remaining
      // dwell time instead of only starting once it has already elapsed.
      for (let i = 1; i <= PREFETCH_DEPTH; i++) prefetch(next + stepMs * i);

      const cached = cache.get(next);
      const fetchStartedAt = Date.now();
      let data = null;
      if (cached?.status === "ready") {
        data = cached.data;
      } else {
        // Not prefetched in time (the first frame of a run, or prefetch
        // hasn't caught up) -- fetch it directly, same as before prefetching
        // existed.
        try {
          data = await fetchReplayPayloadRef.current(next);
        } catch (err) {
          console.warn("Failed to fetch replay snapshot:", err);
        }
      }
      const latencyMs = Date.now() - fetchStartedAt;
      if (cancelled) return;
      if (data) applyReplayPayloadRef.current(data);

      // Stuttering, defined concretely (replay/playback.js's
      // stutterThresholdMs): this frame's own fetch took longer than 1.5x the
      // configured frame hold to arrive. Two in a row -- not one, an ordinary
      // network blip is not a trend -- degrades the step size, which is
      // published to state (below) so the UI can say so rather than the
      // sweep just quietly thinning out.
      stutterStreak = isStutter(latencyMs, frameMsRef.current) ? stutterStreak + 1 : 0;
      const degrade = nextDegradeState(stepMinutesLocal, stutterStreak);
      stutterStreak = degrade.streak;
      if (degrade.stepMinutes !== stepMinutesLocal) {
        stepMinutesLocal = degrade.stepMinutes;
        setPlaybackStep(stepMinutesLocal);
        setPlaybackDegraded(true);
      }

      timer = setTimeout(step, Math.max(0, frameMsRef.current - (Date.now() - startedAt)));
    };

    timer = setTimeout(step, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // playbackStep only seeds the loop's local variable above -- see that
    // variable's own comment for why the loop must not restart every time a
    // degrade changes it (or every time the settings value it started from
    // changes mid-sweep, which the sync effect below only applies once
    // playback stops anyway).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    // Starting playback from the live edge -- begin 24 hours back rather than
    // at the scrubber's own 3-day edge (task-44-brief.md: "a play button that
    // animates the last 24 hours"). The slider itself still spans the full
    // 3-day range so a manual scrub can reach further back; Play's own sweep
    // is deliberately narrower. Resuming from a paused, already-scrubbed
    // position (replayAt not null) plays forward from wherever that is,
    // unchanged.
    if (replayAt === null) seekTo(now - REPLAY_WINDOW_MS);
    setIsPlaying(true);
  }, [isPlaying, replayAt, now, seekTo]);

  // Keeps the *displayed* step size matched to settings whenever playback
  // isn't actually running -- picks up a settings change for the next play,
  // and clears a stale "degraded" note once there is nothing left running
  // that it could be describing.
  useEffect(() => {
    if (isPlaying) return;
    setPlaybackStep(stepMinutes);
    setPlaybackDegraded(false);
  }, [stepMinutes, isPlaying]);

  // Task 44's per-kind availability check -- one batch of REPLAY_KINDS.length
  // requests per replay session. Guarded by a ref, not by kindAvailability
  // state itself: an earlier version of this gated on `kindAvailability !==
  // null` with `kindAvailability` in the effect's own dependency array, and
  // setting the in-flight `{}` marker from inside that same effect changed
  // its own dependency on every run -- React tore the effect down (flipping
  // that instance's `cancelled` to true) and rebuilt it immediately, so the
  // fetch that was already in flight could never apply its result once it
  // resolved. Caught live against this worktree's dev backend: every kind
  // sat at "checking…" forever instead of settling into a real state. A ref
  // isn't a render dependency, so setting kindAvailability inside the effect
  // no longer retriggers it.
  const availabilityRequestedRef = useRef(false);

  const fetchKindAvailability = useCallback(async () => {
    const region = regionRef.current;
    const at = Date.now() / 1000;
    const results = {};
    await Promise.all(
      REPLAY_KINDS.map(async ({ key }) => {
        try {
          const data = await fetchJson(urlForRegion(`/api/replay?kind=${key}&at=${at}`, region));
          // A 200 that isn't one of the three states backend/app.py's kind
          // mode actually returns (task-44a-report.md's own contract) is not
          // a fourth honest answer -- it's a response that didn't answer the
          // question this asked, e.g. a backend process serving the
          // pre-generalisation legacy bundle regardless of `?kind=` (this
          // was caught live in exactly that shape: a shared dev backend
          // that had not been restarted onto the commit adding `kind`
          // support still returns the five-layer bundle, with no `status`
          // field at all, for any `kind` value including a nonsense one).
          // Left as "checking…" forever would be a silent failure that
          // looks like patience; "error" says plainly that this could not
          // be confirmed.
          const known = new Set(["ok", "no_history", "unavailable"]);
          results[key] = known.has(data?.status) ? data.status : "error";
        } catch (err) {
          // REPLAY_KINDS only names real, known kinds, so a 400 here in
          // practice always means the backend's window-ceiling refusal (see
          // replay/availability.js's own note on the "refused" state, and
          // task-44a-report.md's "events" asymmetry) rather than an unknown
          // kind. Anything else -- a 5xx, a network failure -- is a check
          // that simply didn't complete, not a statement the backend made.
          results[key] = /:\s*400\b/.test(String(err?.message)) ? "refused" : "error";
        }
      })
    );
    return results;
  }, []);

  useEffect(() => {
    if (!isReplaying || availabilityRequestedRef.current) return undefined;
    availabilityRequestedRef.current = true;
    let cancelled = false;
    setKindAvailability({}); // in-flight marker, distinct from null ("not checked yet")
    fetchKindAvailability().then((results) => {
      if (!cancelled) setKindAvailability(results);
    });
    return () => {
      cancelled = true;
      // Un-claim the ticket whenever this instance's own result never
      // landed (isReplaying flipping back to false -- goLive already resets
      // kindAvailability itself, this just keeps the two in sync -- or
      // React's Strict Mode mount/cleanup/remount pass). A remount that
      // genuinely still wants an answer (isReplaying still true) gets to
      // ask again instead of being left pointed at a request that can never
      // apply.
      availabilityRequestedRef.current = false;
    };
  }, [isReplaying, fetchKindAvailability]);

  useEffect(() => () => clearTimeout(fetchTimerRef.current), []);

  const bounds = useMemo(() => ({ min: now - RANGE_MS, max: now }), [now]);

  // `now` advances every minute while replayAt doesn't, so a position parked
  // near the old edge eventually falls outside the slider's range -- clamp so
  // the thumb and the label never disagree with each other.
  const clampedReplayAt = replayAt === null ? now : Math.min(Math.max(replayAt, bounds.min), bounds.max);

  return {
    isReplaying,
    isPlaying,
    replayAt: clampedReplayAt,
    bounds,
    scrubTo,
    togglePlay,
    goLive,
    // Task 44: the play button's own settings-derived state, for TimelineBar.
    configuredStepMinutes: stepMinutes,
    playbackStepMinutes: playbackStep,
    playbackDegraded,
    kindAvailability,
  };
}
