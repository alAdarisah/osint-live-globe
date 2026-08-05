// The only bridge between React and the imperative map controller. Creates
// the controller once (on mount), mirrors the small slice of its state React
// needs to display into real React state (counts, zoom-gate notes, viewport
// bounds), and exposes an imperative handle (flyToRegion/flyTo/etc.) for
// components like RegionBar and NewsBroadcastPanel to call.
import { useEffect, useRef, useState, useCallback } from "react";
import { createMapController } from "./createMapController";

const COUNT_KEYS = [
  "events", "firms", "gdelt", "countries", "cities", "infra", "jamming", "satellites",
  "aisCivilian", "aisNavy", "aisTanker", "adsbCivilian", "adsbMilitary",
  "infraMilitary", "infraRefinery", "infraLng", "infraPort", "infraDesalination",
  "infraNuclear", "infraFab", "infraPipelineNode", "pipelineRoutes",
];
const EMPTY_COUNTS = Object.fromEntries(
  COUNT_KEYS.flatMap((key) => [[key, 0], [`${key}Total`, 0]])
);
const EMPTY_ZOOM_NOTES = { adsb: false, cities: false, citiesScoped: false, firms: false, events: false, gdelt: false, ais: false, jamming: false };

export function useLeafletMap(containerRef, { theme, onRegionAutoReset, initialLayerVisibility }) {
  const controllerRef = useRef(null);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [zoomNotes, setZoomNotes] = useState(EMPTY_ZOOM_NOTES);
  const [mapBounds, setMapBounds] = useState(null);
  const [ready, setReady] = useState(false);
  const [windStatus, setWindStatus] = useState({ ok: true });
  const [selectedCountry, setSelectedCountry] = useState(null);

  // onRegionAutoReset changes identity across renders (it closes over
  // region state) -- keep the latest one in a ref so the controller (created
  // exactly once) always calls the current version without needing to be
  // recreated every time it changes.
  const onRegionAutoResetRef = useRef(onRegionAutoReset);
  onRegionAutoResetRef.current = onRegionAutoReset;

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const controller = createMapController(
      containerRef.current,
      { theme, layerVisibility: initialLayerVisibility },
      {
        onCountsChange: setCounts,
        onZoomNotesChange: setZoomNotes,
        onBoundsChange: setMapBounds,
        onRegionAutoReset: () => onRegionAutoResetRef.current?.(),
        onWindStatusChange: setWindStatus,
        onCountrySelect: setSelectedCountry,
        onCountryPointChange: (point) => setSelectedCountry((prev) => (prev ? { ...prev, point } : prev)),
      }
    );
    controllerRef.current = controller;
    setReady(true);

    const onResize = () => controller.invalidateSize();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      controller.destroy();
      controllerRef.current = null;
    };
    // Deliberately mount-once: the map/its layers must not be torn down and
    // rebuilt on every render, only on unmount. Later theme changes go
    // through the returned setTheme() instead of recreating the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyData = useCallback((key, data) => {
    controllerRef.current?.applyData(key, data);
  }, []);

  const flyToRegion = useCallback((key, entry) => {
    controllerRef.current?.flyToRegion(key, entry);
  }, []);

  const flyTo = useCallback((lat, lon, minZoom) => {
    controllerRef.current?.flyTo(lat, lon, minZoom);
  }, []);

  const setLayerVisible = useCallback((key, visible) => {
    controllerRef.current?.setLayerVisible(key, visible);
  }, []);

  const setInfraFilter = useCallback((text) => {
    controllerRef.current?.setInfraFilter(text);
  }, []);

  const setEventFilter = useCallback((next) => {
    controllerRef.current?.setEventFilter(next);
  }, []);

  const closeCountryCard = useCallback(() => {
    controllerRef.current?.deselectCountry();
    setSelectedCountry(null);
  }, []);

  useEffect(() => {
    controllerRef.current?.setTheme(theme);
  }, [theme]);

  return {
    ready, counts, zoomNotes, mapBounds, windStatus, selectedCountry,
    applyData, flyToRegion, flyTo, setLayerVisible, setInfraFilter, setEventFilter, closeCountryCard,
  };
}
