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
import { OSM_INFRA_MIN_ZOOM } from "../map/createMapController";

const BOOT_SOURCES = [
  { key: "countries", label: "Country boundaries" },
  { key: "cities", label: "City index" },
  { key: "events", label: "Conflict & violence events (ACLED + UCDP + GDELT, fused)" },
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
  { key: "events", url: "/api/events", intervalMs: 60000 }, // GDELT-driven (event_fusion.py), same cadence as gdelt below
  { key: "firms", url: "/api/fires", intervalMs: 180000 },
  { key: "gdelt", url: "/api/news", intervalMs: 60000 },
  // Officials & Diplomacy. Slower than news on purpose: its GDELT half moves on
  // the same 15-minute poll as everything else GDELT, and its other half is
  // government press feeds that publish a handful of times a day.
  { key: "officials", url: "/api/officials", intervalMs: 2 * 60000 },
  { key: "countries", url: "/api/countries", intervalMs: 5 * 60000 },
  { key: "cities", url: "/api/cities", intervalMs: 5 * 60000 },
  { key: "ais", url: "/api/ships", intervalMs: 10000 },
  { key: "adsb", url: "/api/aircraft", intervalMs: 20000 },
  { key: "jamming", url: "/api/jamming", intervalMs: 30 * 60000 }, // gpsjam.org itself only updates once/day
  // Earthquakes and volcanic activity. Paced to the faster of its two inputs:
  // USGS refreshes every ~5 minutes and a felt earthquake is the kind of thing
  // a reader expects to appear while they are watching. The volcano half of the
  // same payload only changes weekly (see backend/sources/hazards.py).
  { key: "hazards", url: "/api/hazards", intervalMs: 5 * 60000 },
  // Airfields. Reference data that only refreshes once a day server-side and is
  // browser-cached for an hour (see /api/airports) -- polled at all only so a
  // client left open overnight picks up the new file.
  { key: "airports", url: "/api/airports", intervalMs: 60 * 60000 },
  // AIS gaps and possible ship-to-ship transfers. The backend recomputes these
  // from three days of its own recorded history every 15 minutes, so polling
  // faster would only re-serve the same answer.
  { key: "darkVessels", url: "/api/dark-vessels", intervalMs: 5 * 60000 },
  // Country-level internet outage scores (IODA). Recomputed server-side every
  // 15 minutes over a trailing 24h window -- see backend/sources/outages.py.
  { key: "outages", url: "/api/outages", intervalMs: 5 * 60000 },
  // Orbital launches. The backend refetches every 30 minutes and no faster --
  // Launch Library rate-limits anonymous callers to roughly 15 requests an hour
  // (see backend/sources/launches.py).
  { key: "launches", url: "/api/launches", intervalMs: 10 * 60000 },
  // Displacement and food security. Both publishers update on the order of
  // months; this is polled at all only so a long-lived tab eventually notices.
  { key: "humanitarian", url: "/api/humanitarian", intervalMs: 60 * 60000 },
  // OpenStreetMap infrastructure. Swept server-side once a day over the conflict
  // theatres and browser-cached for an hour, so the interval is only about
  // picking up a new sweep, not about freshness.
  //
  // `minZoom` defers the fetch itself, not just the drawing: this layer is on by
  // default but never drawn above OSM_INFRA_MIN_ZOOM, so on a session that stays
  // at world zoom the megabytes were being fetched, parsed and handed to the map
  // purely to be filtered back out. Nothing else here is gated -- every other
  // source is either small or feeds a panel that reads it at any zoom.
  { key: "osmInfra", url: "/api/osm-infrastructure", intervalMs: 30 * 60000, minZoom: OSM_INFRA_MIN_ZOOM },
  { key: "satellites", url: "/api/satellites", intervalMs: 10000 }, // position, not elements -- see backend/sources/satellites.py
  { key: "conflictStats", url: "/api/conflict-stats", intervalMs: 60 * 60000 }, // HDX file itself only changes weekly -- see backend/sources/hdx_conflict_stats.py
  // Server-side aggregate over a week of history (backend/escalation.py),
  // already cached for 120s there -- polling it faster would just re-serve
  // the same object, and the underlying signal moves on the order of hours.
  { key: "escalation", url: "/api/escalation", intervalMs: 3 * 60000 },
  // UCDP's reviewed record and ACLED's district-level monthly counts. Both are
  // historical by nature -- UCDP's candidate file lags a month or more and the
  // ACLED aggregates run to the end of last month -- so they change on the
  // order of weeks and are polled accordingly. Neither is a live feed and
  // neither is rendered as one.
  { key: "conflictHistory", url: "/api/conflict-history", intervalMs: 6 * 60 * 60000 },
  { key: "conflictDistricts", url: "/api/conflict-districts", intervalMs: 6 * 60 * 60000 },
];

/**
 * @param onData      called with every payload, after `transform`
 * @param flyToRegion the map's own region fly-to
 * @param transform   (key, data) => data. Admin Mode's record overrides are
 *   applied here, between the fetch and everything downstream, so the map and
 *   the panels can never be looking at differently-edited copies of one feed
 *   (see settings/applyOverrides.js).
 * @param zoom        the map's current zoom, or null before the map reports one.
 *   Read only by the POLL_CONFIG `minZoom` gate below -- this hook still knows
 *   nothing about Leaflet, just about how deep the reader has gone.
 * @param zoomOverrides Admin Mode's per-layer zoom gates, the same object the
 *   map controller is given (see setLayerZoomOverrides in App.jsx). Honoured
 *   here too, so lowering a gate in the admin panel actually fetches the layer
 *   at the zoom it now claims to draw at.
 */
export function useOsintData({ onData, flyToRegion, transform, zoom = null, zoomOverrides }) {
  const [regions, setRegions] = useState({});
  const [currentRegionKey, setCurrentRegionKey] = useState(null); // null == world/unscoped
  const [currentRegionLabel, setCurrentRegionLabel] = useState("World");
  const [gdeltRaw, setGdeltRaw] = useState([]);
  const [eventsRaw, setEventsRaw] = useState([]);
  // Reactive like gdelt/events, and for the same two reasons: the country card
  // reads it, and Admin Mode's data editor can only list a feed the app is
  // actually holding. The payload is one bounded day of diplomatic items.
  const [officialsRaw, setOfficialsRaw] = useState([]);
  // Regions running above their own baseline (backend/escalation.py).
  // Reactive like gdelt/events because a panel renders it directly.
  const [escalation, setEscalation] = useState([]);
  // Only the cut-off date, not the rows: the UCDP payload is thousands of
  // records that only the map needs, but the date has to reach the control
  // panel so the layer can state its own staleness.
  const [conflictHistoryAsOf, setConflictHistoryAsOf] = useState(null);
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

  // Same ref treatment, same reason: `transform` closes over the current
  // settings and changes identity whenever they do, and the pollers must not
  // be torn down for that.
  const transformRef = useRef(transform);
  transformRef.current = transform;

  // Each value is a zero-arg fn that re-runs that source's fetch immediately
  // (cancelling its own pending scheduled tick first) -- see registerPoller
  // below. refetchAllNow calls every one of them, which is what makes a
  // region switch feel instant instead of waiting up to intervalMs. Keyed
  // rather than a flat list because the zoom gate below has to reach one
  // specific source's tick the moment its gate opens.
  const tickersRef = useRef(new Map());

  const refetchAllNow = useCallback(() => {
    tickersRef.current.forEach((tick) => tick());
  }, []);

  // Read inside tick(), which is registered once and must see the current
  // values rather than the ones from the render that created it -- the same
  // ref treatment onData/transform get above.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const zoomOverridesRef = useRef(zoomOverrides);
  zoomOverridesRef.current = zoomOverrides;

  // The zoom a gated source starts fetching at: Admin Mode's override for that
  // layer when it has one, the shipped gate otherwise. Mirrors minZoomFor in
  // createMapController.js, which decides the same thing for the drawing.
  const gateFor = useCallback((key, shipped) => {
    const override = zoomOverridesRef.current?.[key];
    return Number.isFinite(override) ? override : shipped;
  }, []);

  // The last payload each source delivered, exactly as the server sent it.
  // Holding it costs nothing extra -- the map controller keeps the same objects
  // alive in its own `raw` -- and it is what lets an Admin Mode edit show up
  // immediately instead of at the next poll, without re-fetching feeds that
  // have not changed. Re-running the transform from the *fetched* payload
  // rather than the previous transformed one is what makes unhiding a record
  // possible: an override is a view of the source, not an edit to it.
  const fetchedRef = useRef({});
  const reapplyTransformRef = useRef(() => {});
  const reapplyTransform = useCallback((keys) => reapplyTransformRef.current(keys), []);

  useEffect(() => {
    let cancelled = false;
    const timeouts = [];

    function markSourceLoaded(key, ok) {
      setBootSources((prev) =>
        prev.map((s) => (s.key === key && s.status === "pending" ? { ...s, status: ok ? "ok" : "warn" } : s))
      );
    }

    function registerPoller(key, url, intervalMs, minZoom, onSuccess) {
      let timer = null;
      let firstLoadReported = false;
      async function tick() {
        if (timer) clearTimeout(timer);
        if (minZoom != null) {
          const zoomNow = zoomRef.current;
          if (zoomNow == null || zoomNow < gateFor(key, minZoom)) {
            // Above the gate this source is not drawn at all, so fetching it
            // would be work nobody can see. Kept on the interval rather than
            // dropped: the zoom effect below fires the moment the reader gets
            // deep enough, so this timer is only the fallback.
            timer = setTimeout(tick, intervalMs);
            return;
          }
        }
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
          const fetched = await fetchJson(urlForRegion(url, currentRegionKeyRef.current));
          if (cancelled) return;
          fetchedRef.current[key] = fetched;
          const data = transformRef.current ? transformRef.current(key, fetched) : fetched;
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
      tickersRef.current.set(key, tick);
      tick();
    }

    const REACTIVE_SETTERS = {
      gdelt: setGdeltRaw,
      events: setEventsRaw,
      officials: setOfficialsRaw,
      escalation: setEscalation,
      conflictHistory: (rows) =>
        setConflictHistoryAsOf((rows && rows.length && rows[0].as_of) || null),
    };
    for (const src of POLL_CONFIG) {
      registerPoller(src.key, src.url, src.intervalMs, src.minZoom ?? null, REACTIVE_SETTERS[src.key]);
    }

    // Defined inside the effect so it can see REACTIVE_SETTERS, and reached
    // from outside through a ref for the same reason the pollers are: this
    // effect mounts once.
    reapplyTransformRef.current = (keys) => {
      const wanted = keys || Object.keys(fetchedRef.current);
      for (const key of wanted) {
        const fetched = fetchedRef.current[key];
        if (fetched === undefined) continue;
        const data = transformRef.current ? transformRef.current(key, fetched) : fetched;
        REACTIVE_SETTERS[key]?.(data);
        onDataRef.current(key, data);
      }
    };

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
    // Submarine cables: routes and landing points arrive as one payload and are
    // split into two raw slots, exactly as /api/infrastructure is below. Also
    // fetched once rather than polled -- new cables land a few times a year.
    fetchJson("/api/cables")
      .then((data) => {
        if (cancelled) return;
        onDataRef.current("cables", data?.cables || []);
        onDataRef.current("cableLandings", data?.landings || []);
      })
      .catch((err) => console.warn("Failed to load submarine cables:", err));

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
      tickersRef.current = new Map();
    };
    // Deliberately mount-once: pollers read the live region via
    // currentRegionKeyRef (and the latest onData via onDataRef) rather than
    // being recreated per region change or per App render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A gated source's first fetch, the moment the reader is deep enough for it
  // to be drawn -- without this it would wait out the rest of its interval
  // (half an hour, for osmInfra) staring at data it is now allowed to have.
  // Only the first: once fetched, the source is back on its normal cadence and
  // re-fetching on every zoom step past the gate would be pointless traffic.
  useEffect(() => {
    if (zoom == null) return;
    for (const src of POLL_CONFIG) {
      if (src.minZoom == null) continue;
      if (zoom < gateFor(src.key, src.minZoom)) continue;
      if (fetchedRef.current[src.key] !== undefined) continue;
      tickersRef.current.get(src.key)?.();
    }
  }, [zoom, zoomOverrides, gateFor]);

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
    eventsRaw,
    officialsRaw,
    escalation,
    conflictHistoryAsOf,
    bootSources,
    // Exposed for useReplay.js: leaving replay mode needs one immediate
    // refetch of every live source instead of waiting out each poller's own
    // interval, same reasoning selectRegion/resetRegionToWorld already rely
    // on above.
    refetchAllNow,
    // Exposed for Admin Mode: re-runs the override transform over the payloads
    // already in hand, so an edit lands on the map as it is typed.
    reapplyTransform,
  };
}
