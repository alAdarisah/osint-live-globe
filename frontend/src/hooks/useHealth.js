import { useEffect, useState } from "react";
import { fetchJson } from "../api";

export function useHealth() {
  const [health, setHealth] = useState({});

  useEffect(() => {
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
  }, []);

  const owmConfigured = !!(health.owm_weather && health.owm_weather.key_configured);
  return { health, owmConfigured };
}
