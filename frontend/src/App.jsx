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
import { EDITABLE_SOURCES } from "./settings/defaults";
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
import EventDetailCard from "./components/EventDetailCard";
import CountrySelectionBar from "./components/CountrySelectionBar";
import BorderEditBar from "./components/BorderEditBar";
import AdminPanel from "./components/admin/AdminPanel";

// What a layer's checkbox starts as used to be decided here, by a table of
// forty booleans with a paragraph of justification each. Those arguments were
// good, and they have not been thrown away -- they have moved into
// map/scene.js, next to the zoom gate and the fetch gate for the same layer,
// where they now express a rule the resolver applies rather than a single
// global answer a reader had to correct by hand.
//
// Two things are left here because they are genuinely not the resolver's
// business. Both are sub-tickers of a parent layer rather than layers, and
// both are on because the thing they annotate is on.
const DEFAULT_LAYER_VISIBILITY = {
  satellitesMilitary: true,
  // Trails are drawn wherever their parent is drawn (see TRAIL_PARENT in
  // scene.js); this is only the reader's own preference for having them at all.
  aisTankerTrails: true, adsbMilitaryTrails: true, satellitesTrails: true,
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

  // The control drawer is an operator's instrument, so it exists only in Admin
  // Mode now. A reader gets a map: what is drawn is decided by how far in they
  // are, by what the camera is over and by what they click (see map/scene.js),
  // which is the same set of decisions the thirty-four checkboxes used to ask
  // them to make before they had seen anything.
  //
  // Derived rather than stored, so `#map.panel-open` (style.css) can never be
  // set for a reader and the 320px shift it applies needs no separate guard.
  // The preference underneath survives leaving and re-entering Admin Mode.
  const [panelOpenPref, setPanelOpenPref] = useState(() => !isMobileViewport);
  const panelOpen = adminMode && panelOpenPref;

  // useLeafletMap and useOsintData each need something the *other* produces
  // (the map needs to tell data-land about an auto-reset; data-land needs
  // the map's flyToRegion/applyData) -- broken via one ref-indirection
  // instead of merging the two hooks into one, so each still reads as a
  // single, focused concern to `git blame`/skim.
  const regionAutoResetRef = useRef(() => {});
  // The two shipped sub-ticker defaults with Admin Mode's saved layer states on
  // top. One object for both consumers below -- the map's construction and the
  // effect that replays it -- because the controller tracks which keys it is
  // answerable for, and handing it a shorter table on the second call would read
  // as "the reader has withdrawn these" rather than as "these are unchanged".
  const layerWishes = useMemo(
    () => ({ ...DEFAULT_LAYER_VISIBILITY, ...settings.layerWish }),
    [settings.layerWish]
  );
  const mapApi = useLeafletMap(mapContainerRef, {
    theme,
    onRegionAutoReset: () => regionAutoResetRef.current(),
    // The editor commits whole rings as they are dragged; persisting them is
    // the settings layer's job, exactly as it is for a record edit.
    onBorderRingCommit: actions.setBorderRings,
    // Read at mount only (useLeafletMap builds the map once), and that is enough
    // for the common case: useAppSettings seeds itself from localStorage
    // synchronously, so a saved layer state is in hand before the first paint
    // rather than applied a frame later as a visible flicker. The effect below
    // is what covers the rest -- the backend's copy landing after the cache, an
    // imported file, a reset.
    initialLayerVisibility: layerWishes,
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
    // Clicking a country is a request for that country's whole picture, so its
    // feeds start fetching regardless of how far out the camera is -- and a
    // change of subject re-ticks them rather than leaving the previous
    // country's payload in place (see the scope signature in useOsintData.js).
    focus: mapApi.focus,
    // Drives the snapped bbox the heavy sources are clipped to. The viewport
    // rather than the zoom, because the same zoom over the Pacific and over
    // Ukraine are different questions.
    mapBounds: mapApi.mapBounds,
  });
  regionAutoResetRef.current = dataApi.resetRegionToWorld;

  const replayApi = useReplay({
    applyData: mapApi.applyData,
    currentRegionKey: dataApi.currentRegionKey,
    onExitReplay: dataApi.refetchAllNow,
  });
  replayActiveRef.current = replayApi.isReplaying;

  // Source-health polling is for the panel that displays it, and that panel is
  // now admin-only -- so a reader's session stops making the request entirely
  // rather than fetching a status nothing will render.
  const { health, owmConfigured } = useHealth(adminMode);

  // Entering or leaving Admin Mode moves the map's left edge by 320px, and
  // Leaflet caches the container size. Without this the projection stays keyed
  // to the old width until something else triggers a resize, which shows up as
  // clicks landing a third of a screen away from where they were aimed. Same
  // 230ms the panel's own CSS transition takes -- see togglePanel below.
  useEffect(() => {
    const timer = setTimeout(() => mapApi.invalidateSize(), 230);
    return () => clearTimeout(timer);
  }, [adminMode, mapApi.invalidateSize]);

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
      zooms: settings.icons.zooms,
      layers: settings.layers,
      // useAppSettings pushes these into the module-level theme too, and that is
      // not enough on its own: a module-level change repaints nothing, which is
      // the whole reason this effect exists. The stack has to be named here as
      // well or reordering a layer would update the panel and leave the map
      // showing the previous order until something else happened to redraw it.
      stack: settings.layerStack,
      stackFadeFloor: settings.ui.stackFadeFloor,
    });
  }, [
    settings.icons, settings.layers, settings.layerStack, settings.ui.stackFadeFloor,
    mapApi.setIconTheme,
  ]);

  useEffect(() => {
    mapApi.setLayerZoomOverrides(layerZoomOverrides);
  }, [layerZoomOverrides, mapApi.setLayerZoomOverrides]);

  // The saved layer states, replayed whenever the configuration itself is
  // replaced rather than only at mount: the backend's copy landing on top of the
  // local cache, an imported file, a reset. A no-op in the ordinary case, since
  // the click that changed this had already told the map directly.
  useEffect(() => {
    mapApi.setLayerWishes(layerWishes);
  }, [layerWishes, mapApi.setLayerWishes]);

  useEffect(() => {
    mapApi.setCityZones(settings.cityZones);
  }, [settings.cityZones, mapApi.setCityZones]);

  // Record edits apply to the payloads already in hand rather than waiting for
  // the next poll, which for news is a minute away, for the officials feed two,
  // and for the reference feeds hours -- long enough that an edit would look
  // like it had not worked.
  //
  // Driven off EDITABLE_SOURCES rather than a hand-written list. It was three
  // names here for as long as only three feeds were editable, and when the
  // editor grew to eighteen this was exactly the kind of second list that gets
  // left behind: every new source would have saved its edit correctly, shown
  // "1 edited" in the panel, and changed nothing on screen until its next poll.
  useEffect(() => {
    dataApi.reapplyTransform(EDITABLE_SOURCES.map((s) => s.key));
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

  // What the checkboxes show is what is actually on the map, mirrored out of
  // the controller (see reportLayerState there). It used to be a React copy
  // that only changed when a checkbox was clicked, which was fine while a
  // click was the only thing that could change a layer -- the scene resolver
  // now moves layers as the camera moves, and a copy like that would be wrong
  // within one pan.
  const layerVisibility = mapApi.layerState.on;
  // Saved, not just applied. The control drawer exists only in Admin Mode (see
  // panelOpen above), so a checkbox here is an operator deciding what this
  // deployment shows rather than a reader adjusting their own view for a
  // minute -- and a decision like that surviving a reload is the whole reason
  // the drawer is behind Admin Mode in the first place.
  //
  // Both calls, and in this order: the map is imperative and answers now, while
  // the settings write is debounced on its way to data/admin_config.json. Going
  // through the settings alone would make every click wait on a React round
  // trip to reach the map.
  const onToggleLayer = useCallback(
    (key, visible) => {
      mapApi.setLayerVisible(key, visible);
      actions.setLayerWish(key, visible);
    },
    [mapApi.setLayerVisible, actions]
  );

  // One record, opened from a row in the country card. Held as resolved HTML
  // rather than as {kind, id}: the body is the map's own pin detail (see
  // recordDetail in createMapController.js), and re-resolving it on every render
  // would rebuild that string on every pan for a card that has not changed.
  const [recordDetail, setRecordDetail] = useState(null);
  const openRecordDetail = useCallback(
    (kind, id) => {
      const found = mapApi.recordDetail(kind, id);
      if (!found) {
        // The row was rendered from an earlier poll and the record has since
        // left the feed. Saying so beats an empty card or a silent no-op.
        setRecordDetail({
          title: "No longer listed",
          html: '<p class="meta">This record is no longer in the feed &mdash; it may have aged out of the '
            + "window, or been edited or hidden in Admin Mode since this list was drawn.</p>",
        });
        return;
      }
      setRecordDetail({
        ...found,
        // Only when the record actually has one; a country-scoped row need not.
        onLocate: Number.isFinite(found.lat) && Number.isFinite(found.lon)
          ? () => mapApi.flyTo(found.lat, found.lon, 8)
          : null,
      });
    },
    [mapApi.recordDetail, mapApi.flyTo]
  );

  // Drives the ConflictBriefingCard popup -- null hides it. Only conflict
  // zones (not "world") get one; cleared on going back to World, either by
  // hand or via the map's own pan-away auto-reset (see the effect below).
  const [briefingZone, setBriefingZone] = useState(null);

  // Picking a zone used to have to force the countries and cities layers on,
  // because both defaulted off and the highlight/scope logic inside the
  // controller had nothing to draw onto. The resolver decides that now, so the
  // forcing is gone -- and with it the awkwardness of a zone pick silently
  // overriding a choice the reader had made.
  const onSelectRegion = useCallback(
    (key) => {
      dataApi.selectRegion(key);
      setBriefingZone(key === "world" ? null : { key, ...dataApi.regions[key] });
    },
    [dataApi.selectRegion, dataApi.regions]
  );

  // The map snaps back to unscoped "World" data on its own when the user
  // pans away from a selected zone (see createMapController.js's moveend
  // handler) -- without this, the briefing card would keep showing a zone
  // that's no longer actually selected.
  useEffect(() => {
    if (!dataApi.currentRegionKey) setBriefingZone(null);
  }, [dataApi.currentRegionKey]);

  // There was, briefly, a second half to that auto-reset: the camera settling
  // inside exactly one zone's bbox would *select* that zone, so a reader who
  // never touched a control still got server-side scoping, the per-region row
  // limits and the briefing card. It was written on the assumption that the
  // region bar had gone away for readers, and it is deleted because the bar
  // did not: it is the one control that lives outside Admin Mode.
  //
  // The two cannot coexist, and not for a reason a guard could fix. The bar
  // makes a choice the instant it is clicked; mapBounds only moves on moveend,
  // at the *end* of the flight that choice starts. So every explicit pick was
  // judged against where the camera still was, and re-selected from under the
  // reader -- "World" over Ukraine snapped straight back to Ukraine, and one
  // zone picked while looking at another reverted to the one on screen. The
  // camera, already flying, was pulled back mid-flight, which is what "stuck"
  // looked like. Only Admin Mode escaped, by the guard that assumed the bar
  // was there.
  //
  // Nor is stale state the whole of it. "World while looking at Ukraine" is a
  // state the auto-select cannot represent at all: an explicit World is a null
  // key, indistinguishable from never having chosen, so it would be overruled
  // however fresh the bounds were. A reader asking for unscoped data while
  // still looking at a theatre is a perfectly ordinary thing to want.
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
    setPanelOpenPref((prev) => {
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

  // Same reasoning, and it became necessary the moment the timeline went behind
  // the gate: leaving Admin Mode mid-replay would take the scrubber off screen
  // while the map stayed frozen on a snapshot from hours ago, with every live
  // feed still suppressed and nothing left to press to get back. The map goes
  // live with the control that drives it.
  useEffect(() => {
    if (!adminMode && replayApi.isReplaying) replayApi.goLive();
  }, [adminMode, replayApi.isReplaying, replayApi.goLive]);

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

      {/* Outside Admin Mode, deliberately, and the only thing that is.
          Picking a theatre is not an operator's adjustment to how the map
          behaves -- it is the reader saying which part of the world they came
          here for, and it is the one control that answers a question about the
          world rather than about the map. Everything else on screen belongs to
          Admin Mode; this is the reader's way in. */}
      <RegionBar
        regions={dataApi.regions}
        currentRegionKey={dataApi.currentRegionKey}
        onSelect={onSelectRegion}
        regionActivity={regionActivity}
      />

      {/* Everything from here down is Admin Mode's.
          
          The line is the same one the control drawer was already drawn on: a
          reader gets the map, and what the map shows is decided by how far in
          they are, what the camera is over and what they click (see
          map/scene.js). These panels are the operator's instruments -- a ticker
          of every headline in view, a ranked board of what is worst right now, a
          replay scrubber over recorded history. Each is a second reading of data
          the map is already drawing, which is exactly what an operator wants and
          exactly what makes a first look cluttered.

          The three cards below this block are not gated with them, on purpose:
          a country card, a record's detail and the boundary-editing bar all open
          in *response to a click*. Nothing appears unasked, so there is nothing
          to gate. */}
      {adminMode && (
        <>
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
        </>
      )}

      {/* The drawer and its handle are the operator's instrument panel: layer
          toggles, per-layer counts and totals, the zoom-gate notes, the source
          health lights, the imagery product and the district month. Every one
          of those answers a question about how the map is behaving rather than
          about the world, which is why they go together and why they go here.

          The event filter goes with them for a subtler reason. Severity,
          verification state and age are claim-*quality* dimensions, and no
          camera position can infer "show me only the corroborated ones" -- so
          it is the one control zoom and clicks genuinely cannot replace. A
          reader still gets all of it, because the map already says it without a
          control: severity sets the colour, an imprecise event is drawn smaller
          and ringed, low confidence dims the pin, and the uncertainty circle is
          drawn at its real radius. Filtering the doubtful ones *away* is an
          analyst's act, and that is what belongs behind this gate. */}
      {adminMode && (
        <>
          <PanelToggle open={panelOpen} onToggle={togglePanel} />
          <ControlPanel
            open={panelOpen}
            counts={mapApi.counts}
            zoomNotes={mapApi.zoomNotes}
            layerVisibility={layerVisibility}
            layerWish={mapApi.layerState.wish}
            sceneBypass={mapApi.layerState.bypass}
            onSceneBypassChange={mapApi.setSceneBypass}
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
        </>
      )}

      {/* Scrubbing the map back through recorded history is the most operator-
          shaped control on it: it replaces every live feed with a snapshot, and
          a reader who found it by accident would be looking at a map that had
          quietly stopped being live. */}
      {adminMode && (
        <TimelineBar
          isReplaying={replayApi.isReplaying}
          isPlaying={replayApi.isPlaying}
          replayAt={replayApi.replayAt}
          bounds={replayApi.bounds}
          onScrub={replayApi.scrubTo}
          onTogglePlay={replayApi.togglePlay}
          onGoLive={replayApi.goLive}
        />
      )}

      <Attribution />

      <CountryInfoCard
        country={mapApi.selectedCountry}
        onClose={mapApi.closeCountryCard}
        borderEdit={borderEditProps}
        onOpenRecord={openRecordDetail}
      />

      <EventDetailCard detail={recordDetail} onClose={() => setRecordDetail(null)} />

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
          recordsFor={mapApi.recordsFor}
          staleBorders={staleBorders}
          onClose={toggleAdminMode}
        />
      )}
    </>
  );
}
