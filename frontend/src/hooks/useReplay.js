// Drives the bottom timeline bar: owns the scrubbed timestamp, playback,
// and fetching/applying the point-in-time payload from /api/replay. While
// replay is active, App.jsx drops the live pollers' onData calls (see the
// replayActiveRef wiring there) so live data can't clobber whatever moment
// is on screen -- exiting replay calls refetchAllNow() to snap straight
// back to current data instead of waiting out each source's own interval.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson, urlForRegion } from "../api";

const RANGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days, matches backend/history.py's retention
const PLAYBACK_TICK_MS = 200;
const PLAYBACK_STEPS = 300; // full 3-day sweep takes 300 * 200ms = 60s

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

  const fetchAt = useCallback(
    async (ts) => {
      try {
        const data = await fetchJson(urlForRegion(`/api/replay?at=${ts / 1000}`, regionRef.current));
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
  // only the settled position (or a playback tick, which is already spaced
  // PLAYBACK_TICK_MS apart) actually fetches.
  const fetchTimerRef = useRef(null);
  const scrubTo = useCallback(
    (ts) => {
      setReplayAt(ts);
      clearTimeout(fetchTimerRef.current);
      fetchTimerRef.current = setTimeout(() => fetchAt(ts), 120);
    },
    [fetchAt]
  );

  const goLive = useCallback(() => {
    clearTimeout(fetchTimerRef.current);
    setIsPlaying(false);
    setReplayAt(null);
    onExitReplay?.();
  }, [onExitReplay]);

  // Read by the playback interval below so each tick can compute the next
  // position without taking replayAt as an effect dependency (which would
  // tear the interval down and rebuild it every single tick).
  const replayAtRef = useRef(replayAt);
  replayAtRef.current = replayAt;

  // Playback: steps replayAt forward at a fixed cadence until it reaches
  // "now", then hands control back to live data automatically. Fetching is
  // a plain side effect in the interval callback (not inside a setState
  // updater), since updaters can run twice under StrictMode and a network
  // fetch isn't safe to duplicate that way.
  useEffect(() => {
    if (!isPlaying) return undefined;
    const stepMs = RANGE_MS / PLAYBACK_STEPS;
    const id = setInterval(() => {
      const base = replayAtRef.current ?? Date.now() - RANGE_MS;
      const next = base + stepMs;
      if (next >= Date.now()) {
        setIsPlaying(false);
        goLive();
        return;
      }
      setReplayAt(next);
      fetchAt(next);
    }, PLAYBACK_TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  const togglePlay = useCallback(() => {
    setIsPlaying((prev) => {
      if (prev) return false;
      // Starting playback from the live edge -- begin at the oldest point
      // instead of a single tick before "now".
      if (replayAt === null) scrubTo(now - RANGE_MS);
      return true;
    });
  }, [replayAt, now, scrubTo]);

  useEffect(() => () => clearTimeout(fetchTimerRef.current), []);

  const bounds = useMemo(() => ({ min: now - RANGE_MS, max: now }), [now]);

  return {
    isReplaying,
    isPlaying,
    replayAt: replayAt ?? now,
    bounds,
    scrubTo,
    togglePlay,
    goLive,
  };
}
