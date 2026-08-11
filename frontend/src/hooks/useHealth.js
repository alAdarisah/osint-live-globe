import { useEffect, useRef, useState } from "react";
import { fetchJson } from "../api";

// Task 32 item 1: the interval used once nothing needs it snappier than
// that. Admin Mode's Source status fold wants to feel live while an operator
// is staring at it (15s, unchanged); an ordinary reader's session now polls
// too -- every layer row's freshness badge reads through this same state --
// but nobody is watching a clock tick down, so four times a minute would
// just be 240 requests an hour spent on precision nobody can see. 60s is
// "cheaply", the word this task's own brief uses.
const FAST_POLL_MS = 15000;
const BACKGROUND_POLL_MS = 60000;

/**
 * Per-source health.
 *
 * Task 32 item 1: this used to poll only when `enabled` (Admin Mode) was
 * true, because the only reader was the Source status fold -- an ordinary
 * session never asked, so it never fetched /api/health at all. The "last
 * updated per layer" freshness badge (LayerCheck.jsx, via HealthContext)
 * needs the same data on every session, not only Admin Mode's, so this now
 * polls unconditionally. `fast` keeps Admin Mode's own 15s cadence exactly
 * as it was; every other session gets the same feed at a quarter of the
 * request rate, which is what "poll it always, cheaply" (the brief's own
 * words) means in practice.
 *
 * @param {boolean} [fast]  true in Admin Mode, for the Source status fold's
 *   own responsiveness. Changing it does not tear down and restart the
 *   poll loop -- the running timer just picks up the new interval on its
 *   next tick, via the ref below, the same "read at schedule time" pattern
 *   useOsintData.js's own pollers use for their band-dependent cadence.
 */
export function useHealth(fast = false) {
  const [health, setHealth] = useState({});
  const fastRef = useRef(fast);
  fastRef.current = fast;

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let firstLoadDone = false;

    function intervalNow() {
      return fastRef.current ? FAST_POLL_MS : BACKGROUND_POLL_MS;
    }

    async function poll() {
      if (document.hidden && firstLoadDone) {
        if (!cancelled) timer = setTimeout(poll, intervalNow());
        return;
      }
      firstLoadDone = true;
      try {
        const data = await fetchJson("/api/health");
        if (!cancelled) setHealth(data);
      } catch (err) {
        console.warn("Health poll failed:", err);
      } finally {
        if (!cancelled) timer = setTimeout(poll, intervalNow());
      }
    }
    poll();

    function onVisibilityChange() {
      if (!document.hidden) {
        clearTimeout(timer);
        poll();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearTimeout(timer);
    };
  }, []);

  const owmConfigured = !!(health.owm_weather && health.owm_weather.key_configured);
  return { health, owmConfigured };
}
