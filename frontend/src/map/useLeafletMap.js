// The only bridge between React and the imperative map controller. Creates
// the controller once (on mount), mirrors the small slice of its state React
// needs to display into real React state (counts, zoom-gate notes, viewport
// bounds), and exposes an imperative handle (flyToRegion/flyTo/etc.) for
// components like RegionBar and IntelPanel to call.
import { useEffect, useRef, useState, useCallback } from "react";
import { createMapController } from "./createMapController";

const COUNT_KEYS = [
  "events", "firms", "gdelt", "officials", "countries", "cities", "infra", "jamming", "satellites",
  // Task 24: the seven client-propagated satellite layers.
  "satNavigation", "satWeather", "satImaging", "satScience", "satGeo", "satStarlink", "satOneweb",
  "aisCivilian", "aisNavy", "aisTanker", "adsbCivilian", "adsbMilitary",
  "infraMilitary", "infraRefinery", "infraLng", "infraPort", "infraDesalination",
  "infraNuclear", "infraFab", "infraPipelineNode", "pipelineRoutes",
  "gfwGaps", "gfwDetections", "gfwDetMatched", "gfwDetUnmatched",
  "czib", "czibActive", "czibWithdrawn", "floods", "floodsCurrent",
  "ports", "portsOil", "dams", "damsLarge", "deflock", "railways", "water",
  "shippingLanes", "laneDensity",
];
const EMPTY_COUNTS = Object.fromEntries(
  COUNT_KEYS.flatMap((key) => [[key, 0], [`${key}Total`, 0]])
);
// `capped` is not a flag but a map of counts -- { [layerKey]: howManyKept } for
// every layer the band cap is currently thinning. eventsCapped is the same
// number for events alone, kept because the panel still reads it by name. See
// capByRank in createMapController.
const EMPTY_ZOOM_NOTES = {
  adsb: false, cities: false, citiesScoped: false, firms: false, events: false, gdelt: false,
  ais: false, jamming: false, officials: false, capped: {}, eventsCapped: 0,
  gfwGaps: false, gfwDetections: false, floods: false, ports: false, dams: false, deflock: false,
  laneDensity: false,
  // Task 24: navigation/weather/imaging are THEATRE-gated (see map/scene.js
  // and createMapController.js's SAT_ELEMENT_ZOOM_NOTE_KEYS); the other four
  // client-propagated groups are ungated and never report a note.
  satNavigation: false, satWeather: false, satImaging: false,
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
  // Which layers are actually on the map, and which of those the reader has
  // pinned. Mirrored out of the controller rather than held here, because the
  // scene resolver moves layers on and off as the camera moves and a React copy
  // that only ever changed when a checkbox was clicked would drift out of step
  // with the map within one pan. `wish` is the tri-state from
  // createMapController's userLayerWish: a key absent from it is one the
  // resolver is still deciding, which is what the panel renders as
  // indeterminate.
  const [layerState, setLayerState] = useState({ on: {}, wish: {}, bypass: false });
  // What the reader has singled out: {kind:"country"|"layer", key} or null.
  // Mirrored because the fetch layer needs it -- a focused country lifts the
  // fetch gate on that country's feeds however far out the camera is.
  const [focus, setFocus] = useState(null);
  // The country whose card is open (null when none is), and the full selection
  // behind it -- one country can be read while several stay highlighted, so
  // these are genuinely two pieces of state rather than one derived from the
  // other. See createMapController's selectCountryEntry.
  const [selectedCountry, setSelectedCountry] = useState(null);
  const [countrySelection, setCountrySelection] = useState([]);
  // The water body whose card is open, or null -- the water-body counterpart
  // to selectedCountry above. No selection array alongside it: unlike a
  // country, a water body has no chips and no highlight that outlives its
  // card (see createMapController's reportWaterSelection), so one piece of
  // state is the whole of it.
  const [selectedWater, setSelectedWater] = useState(null);
  // The state/district whose card is open, or null -- same shape as
  // selectedWater above (one piece of state apiece, no chip array: neither
  // has a highlight that outlives its card). See createMapController's
  // reportSubdivisionSelection/reportDistrictSelection.
  const [selectedSubdivision, setSelectedSubdivision] = useState(null);
  const [selectedDistrict, setSelectedDistrict] = useState(null);
  // What the boundary editor is doing, for the controls that drive it: whether
  // a session is open, on which country, how many handles are drawn and whether
  // there is anything to undo. See map/borderEdit.js.
  const [borderEdit, setBorderEdit] = useState(NO_BORDER_EDIT);
  // { [countryKey]: fingerprint } for the boundaries currently loaded. Mirrored
  // so the admin panel can tell a stored edit that still fits from one made
  // against a geometry the source has since changed.
  const [countryFingerprints, setCountryFingerprints] = useState({});
  // Which metric the shapes are painted by, which shapes -- "country" or
  // "state" (Task 26) -- that metric applies to, and how many of them the
  // metric actually has a value for. The coverage half is not decoration:
  // most metrics know about only part of the world, and a reader looking at a
  // mostly-blank map needs to be told whether that means "no harm here" or
  // "nobody has measured here".
  const [choropleth, setChoropleth] = useState({ metricId: null, target: "country", covered: 0, total: 0 });

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
        onWaterSelect: setSelectedWater,
        onWaterPointChange: (point) => setSelectedWater((prev) => (prev ? { ...prev, point } : prev)),
        onSubdivisionSelect: setSelectedSubdivision,
        onSubdivisionPointChange: (point) => setSelectedSubdivision((prev) => (prev ? { ...prev, point } : prev)),
        onDistrictSelect: setSelectedDistrict,
        onDistrictPointChange: (point) => setSelectedDistrict((prev) => (prev ? { ...prev, point } : prev)),
        onBorderEditChange: (state) => setBorderEdit(state?.active ? state : NO_BORDER_EDIT),
        onCountryFingerprints: setCountryFingerprints,
        onChoroplethChange: setChoropleth,
        onLayerStateChange: setLayerState,
        onFocusChange: setFocus,
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

  // `visible === null` clears the reader's pin and hands the key back to the
  // scene resolver -- see setLayerWish in createMapController.js.
  const setLayerVisible = useCallback((key, visible) => {
    controllerRef.current?.setLayerVisible(key, visible);
  }, []);

  const setSceneBypass = useCallback((on) => {
    controllerRef.current?.setSceneBypass(on);
  }, []);

  // Leaflet caches the container's size, so anything that changes the map's box
  // without a window resize has to say so. Two callers: opening or closing the
  // control drawer (320px), and entering or leaving Admin Mode (the same 320px,
  // because the drawer only exists there). The controller has always exposed
  // this; it was simply never forwarded, so App's call inside togglePanel's
  // setTimeout was throwing where nothing surfaced it.
  const invalidateSize = useCallback(() => {
    controllerRef.current?.invalidateSize();
  }, []);

  const setInfraFilter = useCallback((text) => {
    controllerRef.current?.setInfraFilter(text);
  }, []);

  const setEventFilter = useCallback((next) => {
    controllerRef.current?.setEventFilter(next);
  }, []);

  const setVesselFilter = useCallback((next) => {
    controllerRef.current?.setVesselFilter(next);
  }, []);

  const setAircraftFilter = useCallback((next) => {
    controllerRef.current?.setAircraftFilter(next);
  }, []);

  const setAgeReference = useCallback((ts) => {
    controllerRef.current?.setAgeReference(ts);
  }, []);

  const setChoroplethMetric = useCallback((metricId) => {
    controllerRef.current?.setChoroplethMetric(metricId);
  }, []);

  // Closing the card leaves the country highlighted -- the selection is cleared
  // by its own controls (the chips in CountrySelectionBar), never as a side
  // effect of shutting a panel.
  const closeCountryCard = useCallback(() => {
    controllerRef.current?.closeCountryCard();
    setSelectedCountry(null);
  }, []);

  // Same shape as closeCountryCard, but closing a water body's card also
  // deselects it -- see createMapController's closeWaterCard for why the two
  // gestures are one here where they are two for a country.
  const closeWaterCard = useCallback(() => {
    controllerRef.current?.closeWaterCard();
    setSelectedWater(null);
  }, []);

  // Same shape again, for the state and district cards -- neither has a
  // selection that outlives its card, so closing is deselecting, same as water.
  const closeSubdivisionCard = useCallback(() => {
    controllerRef.current?.closeSubdivisionCard();
    setSelectedSubdivision(null);
  }, []);

  const closeDistrictCard = useCallback(() => {
    controllerRef.current?.closeDistrictCard();
    setSelectedDistrict(null);
  }, []);

  // The district card's own month <select> (DistrictInfoCard.jsx) calls this;
  // the controller fetches the new month's counts and reports the rebuilt
  // card back through onDistrictSelect itself, so there is nothing to set
  // here beyond forwarding the call.
  const setDistrictMonth = useCallback((month) => {
    controllerRef.current?.setDistrictMonth(month);
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

  const setLayerZoomMaxOverrides = useCallback((next) => {
    controllerRef.current?.setLayerZoomMaxOverrides(next);
  }, []);

  const setLayerWishes = useCallback((next) => {
    controllerRef.current?.setLayerWishes(next);
  }, []);

  const setCityZones = useCallback((next) => {
    controllerRef.current?.setCityZones(next);
  }, []);

  // Null when the record is no longer in the feed -- see recordDetail in
  // createMapController.js. Callers render that as "no longer listed" rather
  // than as an empty card.
  const recordDetail = useCallback((kind, id) => controllerRef.current?.recordDetail(kind, id) ?? null, []);

  // By reference, uncopied -- see recordsFor in createMapController.js for why,
  // and for why the editor's list is a snapshot rather than a live view.
  const recordsFor = useCallback((key) => controllerRef.current?.recordsFor(key) ?? [], []);

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
    selectedWater, closeWaterCard,
    selectedSubdivision, closeSubdivisionCard, selectedDistrict, closeDistrictCard, setDistrictMonth,
    layerState, setSceneBypass, invalidateSize, focus,
    applyData, flyToRegion, flyTo, setLayerVisible, setInfraFilter, setEventFilter,
    setVesselFilter, setAircraftFilter, setAgeReference,
    closeCountryCard, focusCountry, deselectCountry, clearCountrySelection,
    setIconTheme, setLayerZoomOverrides, setLayerZoomMaxOverrides, setLayerWishes, setCityZones, setImagery, recordDetail, recordsFor,
    choropleth, setChoroplethMetric,
    borderEdit, countryFingerprints,
    refreshCountriesNow, beginBorderEdit, endBorderEdit, setBorderLinkMode, undoBorderEdit,
  };
}
