// The only bridge between React and the imperative map controller. Creates
// the controller once (on mount), mirrors the small slice of its state React
// needs to display into real React state (counts, zoom-gate notes, viewport
// bounds), and exposes an imperative handle (flyToRegion/flyTo/etc.) for
// components like RegionBar and NewsBroadcastPanel to call.
import { useEffect, useRef, useState, useCallback } from "react";
import { createMapController } from "./createMapController";

const COUNT_KEYS = [
  "events", "firms", "gdelt", "officials", "countries", "cities", "infra", "jamming", "satellites",
  "aisCivilian", "aisNavy", "aisTanker", "adsbCivilian", "adsbMilitary",
  "infraMilitary", "infraRefinery", "infraLng", "infraPort", "infraDesalination",
  "infraNuclear", "infraFab", "infraPipelineNode", "pipelineRoutes",
  "gfwGaps", "gfwDetections", "gfwDetMatched", "gfwDetUnmatched",
  "czib", "czibActive", "czibWithdrawn", "floods", "floodsCurrent",
  "ports", "portsOil", "dams", "damsLarge",
];
const EMPTY_COUNTS = Object.fromEntries(
  COUNT_KEYS.flatMap((key) => [[key, 0], [`${key}Total`, 0]])
);
// eventsCapped is a count rather than a flag -- how many events capBySeverity
// kept at the current zoom, 0 when it kept everything. See createMapController.
const EMPTY_ZOOM_NOTES = {
  adsb: false, cities: false, citiesScoped: false, firms: false, events: false, gdelt: false,
  ais: false, jamming: false, officials: false, eventsCapped: 0,
  gfwGaps: false, gfwDetections: false, floods: false, ports: false, dams: false,
};

const NO_BORDER_EDIT = { active: false, countryKey: null, linkMode: true, canUndo: false };

export function useLeafletMap(containerRef, { theme, onRegionAutoReset, onBorderRingCommit, initialLayerVisibility }) {
  const controllerRef = useRef(null);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [zoomNotes, setZoomNotes] = useState(EMPTY_ZOOM_NOTES);
  const [mapBounds, setMapBounds] = useState(null);
  // Mirrored purely so the fetch layer can gate a source on it (see
  // useOsintData.js) -- the map itself never reads its zoom back out of React.
  const [zoom, setZoom] = useState(null);
  const [ready, setReady] = useState(false);
  const [windStatus, setWindStatus] = useState({ ok: true });
  // The country whose card is open (null when none is), and the full selection
  // behind it -- one country can be read while several stay highlighted, so
  // these are genuinely two pieces of state rather than one derived from the
  // other. See createMapController's selectCountryEntry.
  const [selectedCountry, setSelectedCountry] = useState(null);
  const [countrySelection, setCountrySelection] = useState([]);
  // What the boundary editor is doing, for the controls that drive it: whether
  // a session is open, on which country, how many handles are drawn and whether
  // there is anything to undo. See map/borderEdit.js.
  const [borderEdit, setBorderEdit] = useState(NO_BORDER_EDIT);
  // { [countryKey]: fingerprint } for the boundaries currently loaded. Mirrored
  // so the admin panel can tell a stored edit that still fits from one made
  // against a geometry the source has since changed.
  const [countryFingerprints, setCountryFingerprints] = useState({});
  // Which metric the country shapes are painted by, and how many of them the
  // metric actually has a value for. The coverage half is not decoration: four
  // of the six metrics know about only part of the world, and a reader looking
  // at a mostly-blank map needs to be told whether that means "no harm here" or
  // "nobody has measured here".
  const [choropleth, setChoropleth] = useState({ metricId: null, covered: 0, total: 0 });
  // What the admin-2 layer is currently showing: which count, which month, and
  // how many districts that month actually has a record for.
  const [districts, setDistricts] = useState({
    metricId: "fatalities", month: null, districts: 0, countries: [],
  });

  // onRegionAutoReset changes identity across renders (it closes over
  // region state) -- keep the latest one in a ref so the controller (created
  // exactly once) always calls the current version without needing to be
  // recreated every time it changes.
  const onRegionAutoResetRef = useRef(onRegionAutoReset);
  onRegionAutoResetRef.current = onRegionAutoReset;
  // Same indirection, same reason: this one closes over the settings writer,
  // which is a new function on every render.
  const onBorderRingCommitRef = useRef(onBorderRingCommit);
  onBorderRingCommitRef.current = onBorderRingCommit;

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const controller = createMapController(
      containerRef.current,
      { theme, layerVisibility: initialLayerVisibility },
      {
        onCountsChange: setCounts,
        onZoomNotesChange: setZoomNotes,
        onBoundsChange: setMapBounds,
        onZoomChange: setZoom,
        onRegionAutoReset: () => onRegionAutoResetRef.current?.(),
        onWindStatusChange: setWindStatus,
        onCountrySelect: setSelectedCountry,
        onCountrySelectionChange: setCountrySelection,
        onCountryPointChange: (point) => setSelectedCountry((prev) => (prev ? { ...prev, point } : prev)),
        onBorderEditChange: (state) => setBorderEdit(state?.active ? state : NO_BORDER_EDIT),
        onCountryFingerprints: setCountryFingerprints,
        onChoroplethChange: setChoropleth,
        onDistrictsChange: setDistricts,
        onBorderRingCommit: (commits) => onBorderRingCommitRef.current?.(commits),
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

  const setAgeReference = useCallback((ts) => {
    controllerRef.current?.setAgeReference(ts);
  }, []);

  const setChoroplethMetric = useCallback((metricId) => {
    controllerRef.current?.setChoroplethMetric(metricId);
  }, []);

  const setDistrictMetric = useCallback((metricId) => {
    controllerRef.current?.setDistrictMetric(metricId);
  }, []);

  const setDistrictMonth = useCallback((month) => {
    controllerRef.current?.setDistrictMonth(month);
  }, []);

  // Closing the card leaves the country highlighted -- the selection is cleared
  // by its own controls (the chips in CountrySelectionBar), never as a side
  // effect of shutting a panel.
  const closeCountryCard = useCallback(() => {
    controllerRef.current?.closeCountryCard();
    setSelectedCountry(null);
  }, []);

  const focusCountry = useCallback((key) => {
    controllerRef.current?.focusCountry(key);
  }, []);

  const deselectCountry = useCallback((key) => {
    controllerRef.current?.deselectCountry(key);
  }, []);

  const clearCountrySelection = useCallback(() => {
    controllerRef.current?.clearCountrySelection();
  }, []);

  const setIconTheme = useCallback((next) => {
    controllerRef.current?.setIconTheme(next);
  }, []);

  const setLayerZoomOverrides = useCallback((next) => {
    controllerRef.current?.setLayerZoomOverrides(next);
  }, []);

  const setImagery = useCallback((key, date) => {
    controllerRef.current?.setImagery(key, date);
  }, []);

  const refreshCountriesNow = useCallback(() => {
    controllerRef.current?.refreshCountriesNow();
  }, []);

  const beginBorderEdit = useCallback(
    (key, options) => !!controllerRef.current?.beginBorderEdit(key, options),
    []
  );

  const endBorderEdit = useCallback(() => {
    controllerRef.current?.endBorderEdit();
  }, []);

  const setBorderLinkMode = useCallback((on) => {
    controllerRef.current?.setBorderLinkMode(on);
  }, []);

  const undoBorderEdit = useCallback(() => controllerRef.current?.undoBorderEdit() ?? false, []);

  useEffect(() => {
    controllerRef.current?.setTheme(theme);
  }, [theme]);

  return {
    ready, counts, zoomNotes, mapBounds, zoom, windStatus, selectedCountry, countrySelection,
    applyData, flyToRegion, flyTo, setLayerVisible, setInfraFilter, setEventFilter, setAgeReference,
    closeCountryCard, focusCountry, deselectCountry, clearCountrySelection,
    setIconTheme, setLayerZoomOverrides, setImagery,
    choropleth, setChoroplethMetric,
    districts, setDistrictMetric, setDistrictMonth,
    borderEdit, countryFingerprints,
    refreshCountriesNow, beginBorderEdit, endBorderEdit, setBorderLinkMode, undoBorderEdit,
  };
}
