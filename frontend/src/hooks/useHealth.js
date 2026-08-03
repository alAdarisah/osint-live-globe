import { useEffect, useState } from "react";
import { fetchJson } from "../api";

export function useHealth() {
  const [health, setHealth] = useState({});

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function poll() {
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

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const owmConfigured = !!(health.owm_weather && health.owm_weather.key_configured);
  return { health, owmConfigured };
}
