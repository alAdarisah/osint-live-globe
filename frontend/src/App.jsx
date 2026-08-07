// Top-level orchestrator. Wires the map (useLeafletMap), the data/region
// layer (useOsintData), and a handful of small standalone hooks (theme,
// clock, health, viewport) together, then hands their state down to plain
// presentational components. No component below this one talks to the
// network or to Leaflet directly -- see src/map/ and src/hooks/ for that.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLeafletMap } from "./map/useLeafletMap";
import { useOsintData } from "./hooks/useOsintData";
import { useReplay } from "./hooks/useReplay";
import { useTheme } from "./hooks/useTheme";
import { useHealth } from "./hooks/useHealth";
import { useIsMobileViewport } from "./hooks/useIsMobileViewport";
import { useAppSettings } from "./hooks/useAppSettings";
import { applyOverrides } from "./settings/applyOverrides";
import { applyBorderOverrides, staleBorderKeys } from "./settings/borderOverrides";
import { DEFAULT_EVENT_FILTER } from "./map/severity";
import { makeCountryScope } from "./map/countryScope";
import { boundsContainsPoint } from "./utils/geo";
import { fetchJson } from "./api";

import LoadingScreen from "./components/LoadingScreen";
import MapView from "./components/MapView";
import TitleBar from "./components/TitleBar";
import RegionBar from "./components/RegionBar";
import NewsBroadcastPanel from "./components/NewsBroadcastPanel";
import NotableEventsPanel from "./components/NotableEventsPanel";
import ConflictBriefingCard from "./components/ConflictBriefingCard";
import PanelToggle from "./components/PanelToggle";
import ControlPanel from "./components/controlPanel/ControlPanel";
import TimelineBar from "./components/TimelineBar";
import Attribution from "./components/Attribution";
import CountryInfoCard from "./components/CountryInfoCard";
import CountrySelectionBar from "./components/CountrySelectionBar";
import BorderEditBar from "./components/BorderEditBar";
import AdminPanel from "./components/admin/AdminPanel";

// "Tickers" (the layer checkboxes) default off except critical
// infrastructure, satellites, and the military-only halves of ADS-B/AIS --
// everything else is opt-in rather than cluttering the map on first load.
const DEFAULT_LAYER_VISIBILITY = {
  events: true, conflictHistory: false, firms: false, aisCivilian: false, aisTanker: true, aisTankerTrails: true, aisNavy: true, gdelt: true, officials: true,
  adsbCivilian: false, adsbMilitary: true, adsbMilitaryTrails: true,
  countries: true, cities: true, infra: true, jamming: true, satellites: true, satellitesTrails: true,
  satellitesMilitary: true,
  precip: false, clouds: false, windArrows: false,
  // Off by default: most days nothing in it bears on the conflict picture, and
  // an M3.1 tremor competing with a strike for the eye is exactly the clutter
  // the rest of these defaults avoid.
  hazards: false,
  // On by default and deliberately: this is the layer that shows an aircraft
  // squawking 7500 or one whose operator asked not to be listed. Both are rare,
  // both are the point, and neither should need to be switched on to be seen.
  adsbFlagged: true,
  // Off: 40k airfields is reference material you go looking for.
  airports: false,
  // Off, and this one on principle rather than for clutter: every pin in it is
  // an inference drawn from an absence, and that should be something a reader
  // chooses to look at rather than something the map asserts at them.
  darkVessels: false,
  // Off: 718 cable routes is a dense mesh over every ocean, and it is reference
  // material for a specific question rather than something to watch.
  cables: false,
  // Off: a few dozen pads, and not what this map is primarily for.
  launches: false,
  // On, but only ever at close range (OSM_INFRA_MIN_ZOOM in
  // createMapController.js): it is crowd-sourced geometry sitting next to a
  // list whose coordinates a person checked, so it stays off the overview
  // entirely and only fills in once a reader has zoomed into one place, where
  // its provenance is stated on every pin.
  osmInfra: true,
  // Off: a reviewed monthly archive for six countries, which is something a
  // reader goes looking for rather than something the map should assert
  // alongside live pins -- and it is the one layer here whose newest data is
  // weeks old by construction.
  districts: false,
  // Off on principle, the same principle darkVessels is off for: the record is
  // an inference about intent. That the inference is Global Fishing Watch's
  // rather than this app's does not change what kind of claim it is -- and
  // every event on it is five or more days old, so it could never be a live
  // layer even if it wanted to be.
  gfwGaps: false,
  // Off for a different reason: these are measurements, and good ones. But a
  // radar return several weeks old drawn at world zoom beside live AIS is
  // exactly the confusion this layer risks, so it appears because a reader
  // asked for it. Also gated hard by zoom, on both the draw and the fetch.
  gfwDetections: false,
  // Off: a standing regulatory advisory is reference for a specific question,
  // the same footing as the cable routes above, not something to watch.
  czib: false,
  // Off, matching its sibling hazards layer above for the same reason.
  floods: false,
  // Off: a harbour gazetteer is reference material, not a feed. Nothing in it
  // is an event and nothing in it is current.
  ports: false,
  // Off: same, and the popup's whole content is structure-scale detail that
  // means nothing until a reader is already looking at one place.
  dams: false,
};

export default function App() {
  const mapContainerRef = useRef(null);
  const { theme, toggleTheme } = useTheme();
  const isMobileViewport = useIsMobileViewport();

  // Admin Mode's configuration. Read here rather than in a context because
  // three separate consumers need it in three different forms -- the map wants
  // an icon theme, the fetch layer wants a record-override function, and the
  // admin panel wants the object itself.
  const { settings, adminMode, toggleAdminMode, actions, sync, borderNotice } = useAppSettings();

  // Panel starts open on desktop, but an 85vw-wide open drawer would cover
  // most of a small screen on first load, so it starts closed on phones
  // (see the mobile media query in style.css, where the panel becomes an
  // overlay instead of pushing the map).
  const [panelOpen, setPanelOpen] = useState(() => !isMobileViewport);

  // useLeafletMap and useOsintData each need something the *other* produces
  // (the map needs to tell data-land about an auto-reset; data-land needs
  // the map's flyToRegion/applyData) -- broken via one ref-indirection
  // instead of merging the two hooks into one, so each still reads as a
  // single, focused concern to `git blame`/skim.
  const regionAutoResetRef = useRef(() => {});
  const mapApi = useLeafletMap(mapContainerRef, {
    theme,
    onRegionAutoReset: () => regionAutoResetRef.current(),
    // The editor commits whole rings as they are dragged; persisting them is
    // the settings layer's job, exactly as it is for a record edit.
    onBorderRingCommit: actions.setBorderRings,
    initialLayerVisibility: DEFAULT_LAYER_VISIBILITY,
  });

  // While the replay timeline is scrubbed back, live poller ticks must not
  // overwrite whatever past moment is on screen -- this ref (rather than a
  // useOsintData prop) is the gate, so useOsintData itself stays unaware
  // replay even exists. Cheap ref instead of state since flipping it never
  // needs to trigger a re-render on its own.
  const replayActiveRef = useRef(false);
  // Admin Mode's per-layer zoom gates. Computed here rather than inside the
  // effect that pushes them to the map, because the fetch layer needs the same
  // object: a source whose drawing is gated on zoom has its *fetch* gated on
  // the same number (see POLL_CONFIG's minZoom in useOsintData.js), and the two
  // must agree about an override.
  const layerZoomOverrides = useMemo(() => {
    const overrides = {};
    for (const [key, layer] of Object.entries(settings.layers)) {
      if (Number.isFinite(layer.minZoom)) overrides[key] = layer.minZoom;
    }
    return overrides;
  }, [settings.layers]);

  const dataApi = useOsintData({
    onData: (key, data) => {
      if (!replayActiveRef.current) mapApi.applyData(key, data);
    },
    flyToRegion: mapApi.flyToRegion,
    // Two override passes, because the countries feed is a FeatureCollection
    // rather than an array of records and applyOverrides deliberately passes
    // anything that is not an array straight through.
    transform: useCallback(
      (key, data) =>
        key === "countries"
          ? applyBorderOverrides(data, settings.borders)
          : applyOverrides(key, data, settings.data),
      [settings.data, settings.borders]
    ),
    zoom: mapApi.zoom,
    zoomOverrides: layerZoomOverrides,
  });
  regionAutoResetRef.current = dataApi.resetRegionToWorld;

  const replayApi = useReplay({
    applyData: mapApi.applyData,
    currentRegionKey: dataApi.currentRegionKey,
    onExitReplay: dataApi.refetchAllNow,
  });
  replayActiveRef.current = replayApi.isReplaying;

  const { health, owmConfigured } = useHealth();

  // --- NASA GIBS satellite imagery ---------------------------------------
  //
  // Which imagery product is under the map, and for which day. The date is not
  // a separate control: it follows the replay scrubber, so scrubbing back three
  // days changes the imagery along with every other layer instead of leaving
  // today's satellite pass sitting under a three-day-old conflict picture.
  const [imageryKey, setImageryKey] = useState(null);
  const imageryDate = useMemo(() => {
    const at = replayApi.replayAt ?? Date.now();
    // GIBS is keyed by UTC day, and its same-day coverage is partial (each
    // product is built as the satellite's passes come down, a few hours behind).
    return new Date(at).toISOString().slice(0, 10);
  }, [replayApi.replayAt]);

  useEffect(() => {
    mapApi.setImagery(imageryKey, imageryDate);
  }, [imageryKey, imageryDate, mapApi.setImagery]);

  // Event ages follow the scrubber for the same reason the imagery date does.
  // /api/replay serves the state of the world at a past moment, but the conflict
  // filter measures age against the wall clock -- so without this, scrubbing
  // back two days made every event in the snapshot "two days old" and the
  // window filtered out the very data the backend had just returned. null hands
  // the controller back to Date.now() the moment replay ends.
  useEffect(() => {
    mapApi.setAgeReference(replayApi.isReplaying ? replayApi.replayAt : null);
  }, [replayApi.isReplaying, replayApi.replayAt, mapApi.setAgeReference]);

  // --- Admin Mode, pushed into the map ---------------------------------
  //
  // useAppSettings already writes the palette into map/iconTheme.js, but a
  // module-level palette change repaints nothing on its own -- these three
  // effects are what make a settings change visible.
  useEffect(() => {
    mapApi.setIconTheme({
      scale: settings.icons.scale,
      colors: settings.icons.colors,
      layers: settings.layers,
    });
  }, [settings.icons, settings.layers, mapApi.setIconTheme]);

  useEffect(() => {
    mapApi.setLayerZoomOverrides(layerZoomOverrides);
  }, [layerZoomOverrides, mapApi.setLayerZoomOverrides]);

  // Record edits apply to the payloads already in hand rather than waiting for
  // the next poll, which for news is a minute away and for the officials feed
  // two -- long enough that an edit would look like it had not worked.
  useEffect(() => {
    dataApi.reapplyTransform(["events", "gdelt", "officials"]);
  }, [settings.data, dataApi.reapplyTransform]);

  // The same idea for boundaries, but it takes two calls rather than one.
  // reapplyTransform pushes the re-merged FeatureCollection into the map, and
  // renderCountries then declines to redraw it: its fingerprint is the feature
  // count plus the ISO list, which a moved vertex does not change (the reason
  // is written out at createMapController.js:1774). So the forced repaint has
  // to follow, not lead. Both are no-ops while an edit session owns the
  // geometry -- see the guards in applyData and refreshCountriesNow.
  useEffect(() => {
    dataApi.reapplyTransform(["countries"]);
    mapApi.refreshCountriesNow();
  }, [settings.borders, dataApi.reapplyTransform, mapApi.refreshCountriesNow]);

  // Ranks conflict zones by how much is currently happening in each, so the
  // "Choose Conflict Zone" menu (see RegionBar.jsx) lists the hottest first
  // instead of alphabetically/arbitrarily. Bounds-contains check mirrors
  // backend/regions.py's own _in_bounds -- no new endpoint needed, just the
  // region bounds (already fetched) plus the ACLED/GDELT data already
  // reactive in state for the news panel.
  const regionActivity = useMemo(() => {
    const scores = {};
    for (const [key, entry] of Object.entries(dataApi.regions)) {
      if (!entry.bounds) continue; // "world" has no bounds -- not a rankable zone
      const [south, west, north, east] = entry.bounds;
      const bounds = { south, west, north, east };
      let score = 0;
      for (const e of dataApi.eventsRaw) {
        if (typeof e.lat !== "number" || typeof e.lon !== "number") continue;
        if (!boundsContainsPoint(bounds, e.lat, e.lon)) continue;
        score += 1 + (e.fatalities || 0) * 2;
      }
      for (const e of dataApi.gdeltRaw) {
        if (typeof e.lat !== "number" || typeof e.lon !== "number") continue;
        if (!boundsContainsPoint(bounds, e.lat, e.lon)) continue;
        score += e.mentions || 0;
      }
      scores[key] = score;
    }
    return scores;
  }, [dataApi.regions, dataApi.eventsRaw, dataApi.gdeltRaw]);

  const [layerVisibility, setLayerVisibility] = useState(DEFAULT_LAYER_VISIBILITY);
  const onToggleLayer = useCallback(
    (key, visible) => {
      setLayerVisibility((prev) => ({ ...prev, [key]: visible }));
      mapApi.setLayerVisible(key, visible);
    },
    [mapApi.setLayerVisible]
  );

  // Picking a conflict zone already drives country-highlight + cities-scope
  // logic inside createMapController.js (activeConflictZoneBounds/
  // citiesEnabled), but that's wasted if the countries/cities layers
  // themselves are still switched off (both default off -- see
  // DEFAULT_LAYER_VISIBILITY). Force them on here so a zone pick actually
  // shows the highlighted countries + their cities without a second manual
  // toggle in the panel; going back to "World" leaves the user's own choice
  // alone rather than yanking the layers back off.
  // Drives the ConflictBriefingCard popup -- null hides it. Only conflict
  // zones (not "world") get one; cleared on going back to World, either by
  // hand or via the map's own pan-away auto-reset (see the effect below).
  const [briefingZone, setBriefingZone] = useState(null);

  const onSelectRegion = useCallback(
    (key) => {
      dataApi.selectRegion(key);
      if (key !== "world") {
        setLayerVisibility((prev) => {
          const next = { ...prev };
          if (!prev.countries) { next.countries = true; mapApi.setLayerVisible("countries", true); }
          if (!prev.cities) { next.cities = true; mapApi.setLayerVisible("cities", true); }
          return next;
        });
        setBriefingZone({ key, ...dataApi.regions[key] });
      } else {
        setBriefingZone(null);
      }
    },
    [dataApi.selectRegion, dataApi.regions, mapApi.setLayerVisible]
  );

  // The map snaps back to unscoped "World" data on its own when the user
  // pans away from a selected zone (see createMapController.js's moveend
  // handler) -- without this, the briefing card would keep showing a zone
  // that's no longer actually selected.
  useEffect(() => {
    if (!dataApi.currentRegionKey) setBriefingZone(null);
  }, [dataApi.currentRegionKey]);

  const [infraFilterText, setInfraFilterText] = useState("");

  // The cut-off date of the UCDP record, surfaced in the layer's own label so
  // the lag is stated where the layer is switched on, not buried in a popup.
  const historyAsOf = dataApi.conflictHistoryAsOf;

  // What the user has asked the conflict layer to show. Held in React rather
  // than only inside the map controller because the notable-events panel and
  // the zone briefing read the same feed and have to agree with the map about
  // what is in scope; the predicate they all apply lives in map/severity.js.

  const [eventFilter, setEventFilter] = useState(DEFAULT_EVENT_FILTER);
  // The map is told in an effect rather than from inside the state updater.
  // An updater runs during render, and mapApi.setEventFilter redraws the layer
  // synchronously, which reaches reportCounts/reportZoomNotes and so sets state
  // on another component mid-render -- and StrictMode double-invokes updaters,
  // so the redraw ran twice per change. Same reasoning useReplay.js records for
  // keeping its fetch out of one.
  const onEventFilterChange = useCallback(
    (patch) => setEventFilter((prev) => ({ ...prev, ...patch })),
    []
  );
  useEffect(() => {
    mapApi.setEventFilter(eventFilter);
  }, [eventFilter, mapApi.setEventFilter]);

  // Which months the district archive holds. Fetched once rather than polled:
  // HAPI publishes a new month roughly monthly, and its own endpoint exists so
  // that finding out what is in the archive does not mean downloading it (see
  // /api/conflict-district-months). The newest month is selected on arrival so
  // the layer has something to draw the first time it is switched on.
  const [districtMonths, setDistrictMonths] = useState([]);
  useEffect(() => {
    let cancelled = false;
    fetchJson("/api/conflict-district-months")
      .then((months) => {
        if (cancelled || !Array.isArray(months) || !months.length) return;
        setDistrictMonths(months);
        mapApi.setDistrictMonth(months[0]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [mapApi.setDistrictMonth]);
  const onInfraFilterChange = useCallback(
    (text) => {
      setInfraFilterText(text);
      mapApi.setInfraFilter(text);
    },
    [mapApi.setInfraFilter]
  );

  const togglePanel = useCallback(() => {
    setPanelOpen((prev) => {
      const next = !prev;
      setTimeout(() => mapApi.invalidateSize(), 230); // after the CSS transition finishes
      return next;
    });
  }, [mapApi.invalidateSize]);

  const onLocateNewsItem = useCallback(
    (lat, lon) => mapApi.flyTo(lat, lon, 7),
    [mapApi.flyTo]
  );

  // Clicking a country narrows the two read-out panels to that country. The
  // map keeps drawing everything -- this scopes what is *said*, not what is
  // fetched or painted, so dropping the selection restores the world view with
  // no refetch. Inactive (and therefore a no-op predicate) when nothing is
  // selected, which is why both panels can apply it unconditionally.
  const countryScope = useMemo(
    () => makeCountryScope(mapApi.countrySelection),
    [mapApi.countrySelection]
  );

  // Border edits made against a geometry the source no longer serves. Computed
  // only while the admin panel is open, because it is the only thing that can
  // report them and the check walks every feature.
  const staleBorders = useMemo(
    () => (adminMode ? staleBorderKeys(mapApi.countryFingerprints, settings.borders) : []),
    [adminMode, mapApi.countryFingerprints, settings.borders]
  );

  // --- boundary editing --------------------------------------------------
  //
  // Offered only in Admin Mode, and only over the whole world. Under a conflict
  // zone the backend serves a bbox subset of countries (see regions.py's
  // filter_geojson), so a neighbour outside the zone is not loaded, cannot be
  // moved with its partner, and would leave a seam nobody can see because the
  // country it belongs to is not on screen. Refusing is one boolean; the
  // alternative is silent corruption.
  const borderEditBlockedReason = dataApi.currentRegionKey
    ? "Editing a boundary needs the whole world loaded, so both sides of it can move together. Switch back to World first."
    : null;

  const beginBorderEdit = useCallback(() => {
    const key = mapApi.selectedCountry?.key;
    if (key) mapApi.beginBorderEdit(key);
  }, [mapApi.selectedCountry, mapApi.beginBorderEdit]);

  const borderEditProps = useMemo(
    () => ({
      offered: adminMode,
      active: mapApi.borderEdit.active,
      blockedReason: borderEditBlockedReason,
      onBegin: beginBorderEdit,
      onEnd: mapApi.endBorderEdit,
    }),
    [adminMode, mapApi.borderEdit.active, borderEditBlockedReason, beginBorderEdit, mapApi.endBorderEdit]
  );

  // Escape and undo, on the document because the gesture they belong to happens
  // on the map, which has no focus of its own. Leaflet's own keyboard handler
  // binds the arrows and +/- on the container and neither of these, so there is
  // nothing to fight over.
  useEffect(() => {
    if (!mapApi.borderEdit.active) return undefined;
    function onKeyDown(event) {
      // The admin panel is full of text inputs; Escape and Ctrl+Z inside one of
      // them belong to the field, not to the map.
      const target = event.target;
      if (target?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        mapApi.endBorderEdit();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        mapApi.undoBorderEdit();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mapApi.borderEdit.active, mapApi.endBorderEdit, mapApi.undoBorderEdit]);

  // A region change swaps the whole feature set under the working geometry, so
  // the session cannot survive one.
  useEffect(() => {
    if (mapApi.borderEdit.active && dataApi.currentRegionKey) mapApi.endBorderEdit();
  }, [dataApi.currentRegionKey, mapApi.borderEdit.active, mapApi.endBorderEdit]);

  // Leaving Admin Mode has to close an open session, or the handles outlive the
  // only thing that was meant to gate them.
  useEffect(() => {
    if (!adminMode && mapApi.borderEdit.active) mapApi.endBorderEdit();
  }, [adminMode, mapApi.borderEdit.active, mapApi.endBorderEdit]);

  return (
    <>
      <LoadingScreen sources={dataApi.bootSources} />

      <MapView containerRef={mapContainerRef} panelOpen={panelOpen} />

      <TitleBar
        theme={theme}
        onToggleTheme={toggleTheme}
        adminMode={adminMode}
        onToggleAdminMode={toggleAdminMode}
      />

      <RegionBar
        regions={dataApi.regions}
        currentRegionKey={dataApi.currentRegionKey}
        onSelect={onSelectRegion}
        regionActivity={regionActivity}
      />

      <NewsBroadcastPanel
        gdeltRaw={dataApi.gdeltRaw}
        mapBounds={mapApi.mapBounds}
        regionLabel={dataApi.currentRegionLabel}
        countryScope={countryScope}
        onLocate={onLocateNewsItem}
      />

      {briefingZone && (
        <ConflictBriefingCard
          zone={briefingZone}
          eventsRaw={dataApi.eventsRaw}
          eventFilter={eventFilter}
          gdeltRaw={dataApi.gdeltRaw}
          onClose={() => setBriefingZone(null)}
          onLocate={onLocateNewsItem}
        />
      )}

      {/* Ranks the same /api/events data the map draws, through the same
          filter, so the two can't disagree. Renders nothing when no event
          clears its severity floor. */}
      <NotableEventsPanel
        eventsRaw={dataApi.eventsRaw}
        eventFilter={eventFilter}
        escalation={dataApi.escalation}
        countryScope={countryScope}
        onLocate={onLocateNewsItem}
        isMobile={isMobileViewport}
      />

      <PanelToggle open={panelOpen} onToggle={togglePanel} />

      <ControlPanel
        open={panelOpen}
        counts={mapApi.counts}
        zoomNotes={mapApi.zoomNotes}
        layerVisibility={layerVisibility}
        onToggleLayer={onToggleLayer}
        health={health}
        owmConfigured={owmConfigured}
        windStatus={mapApi.windStatus}
        infraFilterText={infraFilterText}
        eventFilter={eventFilter}
        historyAsOf={historyAsOf}
        onEventFilterChange={onEventFilterChange}
        onInfraFilterChange={onInfraFilterChange}
        imageryKey={imageryKey}
        imageryDate={imageryDate}
        onImageryChange={setImageryKey}
        choropleth={mapApi.choropleth}
        onChoroplethChange={mapApi.setChoroplethMetric}
        districts={mapApi.districts}
        districtMonths={districtMonths}
        onDistrictMetricChange={mapApi.setDistrictMetric}
        onDistrictMonthChange={mapApi.setDistrictMonth}
      />

      <TimelineBar
        isReplaying={replayApi.isReplaying}
        isPlaying={replayApi.isPlaying}
        replayAt={replayApi.replayAt}
        bounds={replayApi.bounds}
        onScrub={replayApi.scrubTo}
        onTogglePlay={replayApi.togglePlay}
        onGoLive={replayApi.goLive}
      />

      <Attribution />

      <CountryInfoCard
        country={mapApi.selectedCountry}
        onClose={mapApi.closeCountryCard}
        borderEdit={borderEditProps}
      />

      <BorderEditBar
        state={mapApi.borderEdit}
        countryName={
          mapApi.countrySelection.find((c) => c.key === mapApi.borderEdit.countryKey)?.name ?? null
        }
        onEnd={mapApi.endBorderEdit}
        onUndo={mapApi.undoBorderEdit}
        onToggleLink={mapApi.setBorderLinkMode}
        notice={borderNotice}
        onDismissNotice={actions.clearBorderNotice}
      />

      <CountrySelectionBar
        selection={mapApi.countrySelection}
        focusedKey={mapApi.selectedCountry?.key ?? null}
        onFocus={mapApi.focusCountry}
        onRemove={mapApi.deselectCountry}
        onClear={mapApi.clearCountrySelection}
      />

      {/* The only place any of this is editable, and it exists only while Admin
          Mode is on -- see AdminPanel.jsx on why that is the whole guard. */}
      {adminMode && (
        <AdminPanel
          settings={settings}
          actions={actions}
          sync={sync}
          sources={{
            events: dataApi.eventsRaw,
            gdelt: dataApi.gdeltRaw,
            officials: dataApi.officialsRaw,
          }}
          staleBorders={staleBorders}
          onClose={toggleAdminMode}
        />
      )}
    </>
  );
}
