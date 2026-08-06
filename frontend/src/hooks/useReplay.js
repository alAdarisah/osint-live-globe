// Drives the bottom timeline bar: owns the scrubbed timestamp, playback,
// and fetching/applying the point-in-time payload from /api/replay. While
// replay is active, App.jsx drops the live pollers' onData calls (see the
// replayActiveRef wiring there) so live data can't clobber whatever moment
// is on screen -- exiting replay calls refetchAllNow() to snap straight
// back to current data instead of waiting out each source's own interval.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson, urlForRegion } from "../api";

const RANGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days, matches backend/history.py's retention
// Floor on how long one step takes, not a fixed tick rate: a step that
// fetched and redrew faster than this waits out the remainder, a slower one
// just takes what it takes. Playback stays watchable whether the snapshot
// came back in 10ms (warm cache, quiet region) or took most of a second
// (cold, and redrawing ~49k FIRMS points).
const PLAYBACK_MIN_STEP_MS = 800;
const PLAYBACK_STEPS = RANGE_MS / (60 * 60 * 1000); // one step per hour, so a sweep runs ~60s

export function useReplay({ applyData, currentRegionKey, onExitReplay }) {
  const [now, setNow] = useState(() => Date.now());
  // null == live (not scrubbed back); otherwise a specific past timestamp.
  const [replayAt, setReplayAt] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const regionRef = useRef(currentRegionKey);
  regionRef.current = currentRegionKey;

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
  const fetchAt = useCallback(
    async (ts) => {
      const seq = ++fetchSeqRef.current;
      try {
        const data = await fetchJson(urlForRegion(`/api/replay?at=${ts / 1000}`, regionRef.current));
        if (seq !== fetchSeqRef.current) return; // superseded while in flight
        applyData("events", data.events);
        applyData("firms", data.firms);
        applyData("gdelt", data.gdelt);
        applyData("ais", data.ais);
        applyData("adsb", data.adsb);
      } catch (err) {
        console.warn("Failed to fetch replay snapshot:", err);
      }
    },
    [applyData]
  );

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
      seekTo(ts);
    },
    [seekTo]
  );

  const goLive = useCallback(() => {
    clearTimeout(fetchTimerRef.current);
    fetchSeqRef.current += 1; // a late replay snapshot must not repaint over live data
    setIsPlaying(false);
    setReplayAt(null);
    onExitReplay?.();
  }, [onExitReplay]);

  // Read by the playback loop below so each step can compute the next
  // position, and reach the current fetch/goLive, without taking any of them
  // as effect dependencies (which would tear the loop down and restart it).
  const replayAtRef = useRef(replayAt);
  replayAtRef.current = replayAt;
  const fetchAtRef = useRef(fetchAt);
  fetchAtRef.current = fetchAt;
  const goLiveRef = useRef(goLive);
  goLiveRef.current = goLive;

  // Playback: steps replayAt forward until it reaches "now", then hands
  // control back to live data automatically. Each step *awaits* its snapshot
  // and only then schedules the next one, so there is never more than one
  // /api/replay request in flight. A plain setInterval fired a request every
  // tick regardless of whether the previous one had returned, which piled up
  // out-of-order responses and re-rendered the heavy layers (FIRMS is ~49k
  // points) faster than the map could draw them -- playback froze the tab
  // instead of playing. Steps run in an effect body rather than a setState
  // updater, since updaters can run twice under StrictMode and a network
  // fetch isn't safe to duplicate that way.
  useEffect(() => {
    if (!isPlaying) return undefined;
    const stepMs = RANGE_MS / PLAYBACK_STEPS;
    let cancelled = false;
    let timer = null;

    const step = async () => {
      const startedAt = Date.now();
      const base = replayAtRef.current ?? startedAt - RANGE_MS;
      const next = base + stepMs;
      if (next >= Date.now()) {
        goLiveRef.current();
        return;
      }
      clearTimeout(fetchTimerRef.current); // playback supersedes a pending scrub fetch
      setReplayAt(next);
      replayAtRef.current = next; // the next step runs before React re-renders on a slow fetch
      await fetchAtRef.current(next);
      if (cancelled) return;
      timer = setTimeout(step, Math.max(0, PLAYBACK_MIN_STEP_MS - (Date.now() - startedAt)));
    };

    timer = setTimeout(step, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isPlaying]);

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    // Starting playback from the live edge -- begin at the oldest point
    // instead of a single step before "now".
    if (replayAt === null) seekTo(now - RANGE_MS);
    setIsPlaying(true);
  }, [isPlaying, replayAt, now, seekTo]);

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
  };
}
