// Owns everything about *what data the app has* and *which region it's
// scoped to* -- polling every /api/* source, tracking first-load status for
// the boot screen, and region selection. Deliberately knows nothing about
// Leaflet: every fetched payload is handed off via the onData(key, data)
// callback (wired to the map controller's applyData in App.jsx) rather than
// stored as React state, since most of these sources (FIRMS alone can be
// 100k+ points) would make every poll a wasteful full-tree re-render for no
// UI that actually needs it reactively. GDELT and ACLED are the exceptions
// -- the news broadcast panel and the "Choose Conflict Zone" activity
// ranking need them reactively, and both payloads are small, bounded
// (days-wide) windows, not the FIRMS/cities scale this comment warns about.
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson, urlForRegion } from "../api";

const BOOT_SOURCES = [
  { key: "countries", label: "Country boundaries" },
  { key: "cities", label: "City index" },
  { key: "acled", label: "Conflict & violence data (ACLED/UCDP)" },
  { key: "firms", label: "Thermal anomaly feed (NASA FIRMS)" },
  { key: "gdelt", label: "Global news stream (GDELT)" },
  { key: "ais", label: "Maritime traffic (AIS)" },
  { key: "adsb", label: "Aircraft tracking (ADS-B)" },
  { key: "jamming", label: "GPS/radio jamming (GPSJam)" },
  { key: "satellites", label: "Satellite tracking (CelesTrak)" },
];

// ACLED/FIRMS refresh server-side every 30/15 minutes respectively (see
// backend/config.py) -- polling their large payloads every 60s bought
// nothing but redundant fetch/parse work, since the underlying data was
// still the same one most of the time. 3 minutes still feels current.
const POLL_CONFIG = [
  { key: "acled", url: "/api/conflict", intervalMs: 180000 },
  { key: "firms", url: "/api/fires", intervalMs: 180000 },
  { key: "gdelt", url: "/api/news", intervalMs: 60000 },
  { key: "countries", url: "/api/countries", intervalMs: 5 * 60000 },
  { key: "cities", url: "/api/cities", intervalMs: 5 * 60000 },
  { key: "ais", url: "/api/ships", intervalMs: 10000 },
  { key: "adsb", url: "/api/aircraft", intervalMs: 20000 },
  { key: "jamming", url: "/api/jamming", intervalMs: 30 * 60000 }, // gpsjam.org itself only updates once/day
  { key: "satellites", url: "/api/satellites", intervalMs: 10000 }, // position, not elements -- see backend/sources/satellites.py
];

export function useOsintData({ onData, flyToRegion }) {
  const [regions, setRegions] = useState({});
  const [currentRegionKey, setCurrentRegionKey] = useState(null); // null == world/unscoped
  const [currentRegionLabel, setCurrentRegionLabel] = useState("World");
  const [gdeltRaw, setGdeltRaw] = useState([]);
  const [acledRaw, setAcledRaw] = useState([]);
  const [bootSources, setBootSources] = useState(() => BOOT_SOURCES.map((s) => ({ ...s, status: "pending" })));

  // Read by poller ticks so a region switch is picked up on the very next
  // tick without having to tear down and recreate every poller.
  const currentRegionKeyRef = useRef(null);
  currentRegionKeyRef.current = currentRegionKey;

  const regionsRef = useRef({});

  // `onData` is a fresh inline function from App.jsx on every render (it
  // closes over `mapApi`) -- reading it through a ref, rather than putting
  // it in the effect's dependency array, is what actually makes the
  // pollers-registration effect below mount-once like its own comments say.
  // With `onData` in the deps, every App re-render (which happens on nearly
  // every poll, since reportCounts/reportZoomNotes flow into React state)
  // tore down and re-registered all 9 pollers, cancelling whichever fetches
  // hadn't resolved yet -- the short-interval sources (satellites, AIS) lost
  // that race almost every time and could go long stretches never actually
  // delivering data, even though every individual fetch succeeded.
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  // Each entry is a zero-arg fn that re-runs that source's fetch immediately
  // (cancelling its own pending scheduled tick first) -- see registerPoller
  // below. refetchAllNow calls every one of them, which is what makes a
  // region switch feel instant instead of waiting up to intervalMs.
  const tickersRef = useRef([]);

  const refetchAllNow = useCallback(() => {
    tickersRef.current.forEach((tick) => tick());
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timeouts = [];

    function markSourceLoaded(key, ok) {
      setBootSources((prev) =>
        prev.map((s) => (s.key === key && s.status === "pending" ? { ...s, status: ok ? "ok" : "warn" } : s))
      );
    }

    function registerPoller(key, url, intervalMs, onSuccess) {
      let timer = null;
      let firstLoadReported = false;
      async function tick() {
        if (timer) clearTimeout(timer);
        if (document.hidden && firstLoadReported) {
          // Nobody's looking at a backgrounded tab -- skip the network
          // round-trip and just re-check next interval. The visibilitychange
          // listener below calls refetchAllNow() the instant the tab comes
          // back, so this never shows stale data, just skips fetching while
          // it can't be seen. The very first load always goes through even
          // if the tab happens to start backgrounded, so the boot screen
          // can't hang waiting for data that never arrives.
          timer = setTimeout(tick, intervalMs);
          return;
        }
        try {
          const data = await fetchJson(urlForRegion(url, currentRegionKeyRef.current));
          if (cancelled) return;
          onSuccess?.(data);
          onDataRef.current(key, data);
          if (!firstLoadReported) {
            firstLoadReported = true;
            markSourceLoaded(key, true);
          }
        } catch (err) {
          console.warn(`Failed to fetch ${key}:`, err);
          if (!firstLoadReported) {
            firstLoadReported = true;
            markSourceLoaded(key, false);
          }
        } finally {
          if (!cancelled) timer = setTimeout(tick, intervalMs);
        }
      }
      timeouts.push(() => clearTimeout(timer));
      tickersRef.current.push(tick);
      tick();
    }

    const REACTIVE_SETTERS = { gdelt: setGdeltRaw, acled: setAcledRaw };
    for (const src of POLL_CONFIG) {
      registerPoller(src.key, src.url, src.intervalMs, REACTIVE_SETTERS[src.key]);
    }

    // Static for the process lifetime -- fetched once, not part of the
    // regular poll cycle.
    fetchJson("/api/regions")
      .then((data) => {
        if (cancelled) return;
        regionsRef.current = data;
        setRegions(data);
      })
      .catch((err) => console.warn("Failed to load regions:", err));

    // Critical-infrastructure reference sites + pipeline routes -- also
    // static for the process lifetime, fetched once as one payload
    // ({sites, pipelines}, see backend/infrastructure.py) and split into two
    // onData calls so each has its own raw slot, same as every other source
    // (see onData/mapApi.applyData in App.jsx). This endpoint is cached by
    // the browser for 24h (see its Cache-Control in backend/app.py) --
    // a still-cached response from before pipelines existed would just be
    // the old bare sites array, so both shapes are handled rather than
    // assuming every cached copy already matches the current one.
    fetchJson("/api/infrastructure")
      .then((data) => {
        if (cancelled) return;
        const isLegacyArray = Array.isArray(data);
        onDataRef.current("infra", (isLegacyArray ? data : data.sites) || []);
        onDataRef.current("pipelines", (isLegacyArray ? [] : data.pipelines) || []);
      })
      .catch((err) => console.warn("Failed to load infrastructure sites:", err));

    function onVisibilityChange() {
      if (!document.hidden) refetchAllNow();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      timeouts.forEach((clear) => clear());
      tickersRef.current = [];
    };
    // Deliberately mount-once: pollers read the live region via
    // currentRegionKeyRef (and the latest onData via onDataRef) rather than
    // being recreated per region change or per App render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectRegion = useCallback(
    (key) => {
      const entry = key === "world" ? null : regionsRef.current[key];
      const label = entry ? entry.label : "World";
      const newRegionKey = entry ? key : null;
      // Updated synchronously (not just via the state-mirroring assignment
      // above the effect) because refetchAllNow() below runs the pollers'
      // fetches *in this same call stack* -- React doesn't re-render
      // between setCurrentRegionKey and refetchAllNow, so without this the
      // pollers would still read the *previous* region for this round.
      currentRegionKeyRef.current = newRegionKey;
      setCurrentRegionKey(newRegionKey);
      setCurrentRegionLabel(label);
      flyToRegion(key, entry);
      refetchAllNow();
    },
    [flyToRegion, refetchAllNow]
  );

  // Called by the map controller (via useLeafletMap's onRegionAutoReset)
  // when the user pans away from a selected region on their own -- see
  // createMapController.js's moveend handler for why that has to snap back
  // to unscoped data.
  const resetRegionToWorld = useCallback(() => {
    currentRegionKeyRef.current = null; // see the comment in selectRegion
    setCurrentRegionKey(null);
    setCurrentRegionLabel("World");
    refetchAllNow();
  }, [refetchAllNow]);

  return {
    regions,
    currentRegionKey,
    currentRegionLabel,
    selectRegion,
    resetRegionToWorld,
    gdeltRaw,
    acledRaw,
    bootSources,
    // Exposed for useReplay.js: leaving replay mode needs one immediate
    // refetch of every live source instead of waiting out each poller's own
    // interval, same reasoning selectRegion/resetRegionToWorld already rely
    // on above.
    refetchAllNow,
  };
}
