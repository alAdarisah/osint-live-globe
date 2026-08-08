import { useEffect, useState } from "react";
import { fetchJson } from "../api";

/**
 * Per-source health, polled every 15s.
 *
 * @param {boolean} enabled  whether anything is going to render this. The only
 *   reader is the Source status fold of the control panel, which is Admin
 *   Mode-only, so an ordinary reader's session would otherwise poll /api/health
 *   240 times an hour to fill a state nothing displays. Off by default for the
 *   same reason: a caller that wants health has to say so.
 */
export function useHealth(enabled = false) {
  const [health, setHealth] = useState({});

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer = null;
    let firstLoadDone = false;

    async function poll() {
      if (document.hidden && firstLoadDone) {
        if (!cancelled) timer = setTimeout(poll, 15000);
        return;
      }
      firstLoadDone = true;
      try {
        const data = await fetchJson("/api/health");
        if (!cancelled) setHealth(data);
      } catch (err) {
        console.warn("Health poll failed:", err);
      } finally {
        if (!cancelled) timer = setTimeout(poll, 15000);
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
  }, [enabled]);

  const owmConfigured = !!(health.owm_weather && health.owm_weather.key_configured);
  return { health, owmConfigured };
}
