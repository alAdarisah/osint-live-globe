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
import { DEFAULT_VESSEL_FILTER, DEFAULT_AIRCRAFT_FILTER } from "./utils/entityFilter";
import { makeCountryScope } from "./map/countryScope";
import { boundsContainsPoint } from "./utils/geo";
import { decodeViewState, encodeViewState } from "./urlState";

import LoadingScreen from "./components/LoadingScreen";
import MapView from "./components/MapView";
import TitleBar from "./components/TitleBar";
import RegionBar from "./components/RegionBar";
import SquawkAlertStrip from "./components/SquawkAlertStrip";
import IntelPanel from "./components/IntelPanel";
import AirfieldActivityPanel from "./components/AirfieldActivityPanel";
import ConflictBriefingCard from "./components/ConflictBriefingCard";
import PanelToggle from "./components/PanelToggle";
import ControlPanel from "./components/controlPanel/ControlPanel";
import TimelineBar from "./components/TimelineBar";
import Attribution from "./components/Attribution";
import CountryInfoCard from "./components/CountryInfoCard";
import WaterInfoCard from "./components/WaterInfoCard";
import SubdivisionInfoCard from "./components/SubdivisionInfoCard";
import DistrictInfoCard from "./components/DistrictInfoCard";
import EventDetailCard from "./components/EventDetailCard";
import CountrySelectionBar from "./components/CountrySelectionBar";
import BorderEditBar from "./components/BorderEditBar";
import AdminPanel from "./components/admin/AdminPanel";
import UrlStateNotice from "./components/UrlStateNotice";

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

// Task 35: how long a restored deep link's country/water selection keeps
// trying before giving up. Countries are a boot source (LoadingScreen waits
// on them) but water is a one-shot fetch off that list -- a link opened on a
// slow connection can genuinely land before either has arrived, so this
// retries rather than making one attempt at mount and calling it done. Not
// indefinite: a key that is never going to resolve (a stale link, a body the
// source has since dropped) should stop trying rather than poll forever.
const SELECTION_RESTORE_ATTEMPTS = 8;
const SELECTION_RESTORE_INTERVAL_MS = 500;

export default function App() {
  const mapContainerRef = useRef(null);
  const { theme, toggleTheme } = useTheme();
  const isMobileViewport = useIsMobileViewport();

  // Task 35: decoded once, synchronously, from whatever hash the page loaded
  // with -- a state initializer rather than an effect, so every piece of
  // state below that a link can seed (the filters, the layer wishes fed to
  // useLeafletMap's construction, useReplay's own initial replayAt) already
  // reflects it on the very first render, instead of painting the default
  // view for one frame and then snapping to the linked one. The camera and
  // the country/water selection restore later, from effects further down,
  // because both need something that does not exist yet at this point in the
  // render (the map itself; loaded reference data) -- see the two effects
  // near mapApi's construction below.
  const [urlState] = useState(() => decodeViewState(window.location.hash));
  // decodeViewState never throws and always hands back a usable default view
  // -- which is exactly the silent-failure mode the brief warns against if
  // nothing says so out loud. UrlStateNotice (rendered below) is that
  // something; this just tracks whether the reader has dismissed it.
  const [urlNoticeDismissed, setUrlNoticeDismissed] = useState(false);

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
  // Task 35's own layer overrides ride last -- a restored link's layer state
  // outranks whatever this browser's Admin Mode settings say for this
  // session, the same way a URL parameter usually outranks a saved
  // preference elsewhere. They are folded in here, at the merge every other
  // consumer already reads, rather than pushed through actions.setLayerWish:
  // that function persists to the shared admin_config.json, and a link a
  // reader opens must never rewrite this deployment's configuration for
  // everyone else who visits it.
  const layerWishes = useMemo(
    () => ({ ...DEFAULT_LAYER_VISIBILITY, ...settings.layerWish, ...urlState.state.layers }),
    [settings.layerWish, urlState.state.layers]
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

  // The ceilings, kept apart from the floors above because they are not the
  // resolver's business and no fetch gate agrees with them -- see
  // setLayerZoomMaxOverrides in map/createMapController.js.
  const layerZoomMaxOverrides = useMemo(() => {
    const ceilings = {};
    for (const [key, layer] of Object.entries(settings.layers)) {
      if (Number.isFinite(layer.maxZoom)) ceilings[key] = layer.maxZoom;
    }
    return ceilings;
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
    // Task 31's Performance section -- see useOsintData.js's own intervalNow
    // for where the multiplier is applied and its "backgrounded tab" branch
    // for where pausePollingWhenHidden replaces what used to be an
    // unconditional skip.
    pollIntervalMultiplier: settings.performance.pollIntervalMultiplier,
    pausePollingWhenHidden: settings.performance.pausePollingWhenHidden,
  });
  regionAutoResetRef.current = dataApi.resetRegionToWorld;

  const replayApi = useReplay({
    applyData: mapApi.applyData,
    currentRegionKey: dataApi.currentRegionKey,
    onExitReplay: dataApi.refetchAllNow,
    // Task 35: a restored deep link opens already scrubbed back, not live.
    initialReplayAt: urlState.state.replayAt,
  });
  replayActiveRef.current = replayApi.isReplaying;

  // Task 32 item 1: polls unconditionally now -- every layer row's freshness
  // badge (LayerCheck.jsx, via HealthContext just below) reads this, not
  // only the Source status fold, which stays Admin Mode-only. `adminMode`
  // still controls the cadence: 15s while that fold is actually on screen
  // wanting to feel live, 60s ("cheaply", per this task's own brief)
  // otherwise -- see useHealth's own note.
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

  useEffect(() => {
    mapApi.setLayerZoomMaxOverrides(layerZoomMaxOverrides);
  }, [layerZoomMaxOverrides, mapApi.setLayerZoomMaxOverrides]);

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

  // Task 35: seeded from the decoded link's sparse diff on top of the
  // shipped default, the same "base, then only what differs" shape
  // urlState.js itself stores these as.
  const [eventFilter, setEventFilter] = useState(
    () => ({ ...DEFAULT_EVENT_FILTER, ...urlState.state.filters.event })
  );
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

  // The vessel and aircraft filter bars (Task 18, LayersSection.jsx). Same
  // shape as eventFilter just above, and for the same reason: the map
  // controller is the only thing that can actually decide which ships/
  // aircraft draw, but the state has to live in exactly one place or a
  // second copy could disagree with it -- the failure Task 12 spent two
  // review rounds fixing for the conflict-event filters. Held here, synced
  // to the map from an effect (not from inside the setter -- see the
  // eventFilter effect above for why), and read back for the filter bar's
  // own "N / total" figure from mapApi.counts.vesselFilterMatch/
  // aircraftFilterMatch.
  const [vesselFilter, setVesselFilter] = useState(
    () => ({ ...DEFAULT_VESSEL_FILTER, ...urlState.state.filters.vessel })
  );
  const [aircraftFilter, setAircraftFilter] = useState(
    () => ({ ...DEFAULT_AIRCRAFT_FILTER, ...urlState.state.filters.aircraft })
  );
  const onVesselFilterChange = useCallback(
    (patch) => setVesselFilter((prev) => ({ ...prev, ...patch })),
    []
  );
  const onAircraftFilterChange = useCallback(
    (patch) => setAircraftFilter((prev) => ({ ...prev, ...patch })),
    []
  );
  useEffect(() => {
    mapApi.setVesselFilter(vesselFilter);
  }, [vesselFilter, mapApi.setVesselFilter]);
  useEffect(() => {
    mapApi.setAircraftFilter(aircraftFilter);
  }, [aircraftFilter, mapApi.setAircraftFilter]);

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

  // Task 34's place search picks its own zoom per result (a town versus an
  // administrative division -- see PlaceSearch.jsx's pick()), unlike
  // onLocateNewsItem above which always flies to the same fixed zoom, so
  // this passes it through rather than hard-coding a second value here.
  const onLocatePlace = useCallback(
    (lat, lon, zoom) => mapApi.flyTo(lat, lon, zoom),
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

  // --- Task 35: deep-linkable views --------------------------------------
  //
  // Layers, filters and replay were folded into their own state's initial
  // value above (layerWishes, eventFilter/vesselFilter/aircraftFilter,
  // useReplay's initialReplayAt) -- they need no effect of their own. Camera
  // and selection do, because each needs something that only exists after
  // mount: the map itself, and (for selection) reference data that is still
  // arriving.

  // The camera restores exactly once, the instant the map is ready to accept
  // it -- not on every mapApi.ready re-render (it only ever flips false to
  // true once) and not repeated the way selection is below, since the map
  // itself is not something that "hasn't arrived yet": mapApi.ready already
  // means it is sitting there waiting for a setView call.
  const cameraRestoredRef = useRef(false);
  useEffect(() => {
    if (cameraRestoredRef.current || !mapApi.ready) return;
    cameraRestoredRef.current = true;
    const camera = urlState.state.camera;
    if (camera) mapApi.setCamera(camera.lat, camera.lon, camera.zoom);
  }, [mapApi.ready, mapApi.setCamera, urlState.state.camera]);

  // The one selection a link carries (see urlState.js for why only country
  // and water qualify). Both are reference layers, but neither is guaranteed
  // to have landed the instant the map reports ready -- countries are a boot
  // source LoadingScreen waits on, water is a one-shot fetch that is not --
  // so this retries a handful of times rather than making one attempt and
  // giving up. A key that never resolves (a stale link, a body the source
  // has since dropped) stops trying after SELECTION_RESTORE_ATTEMPTS rather
  // than polling forever.
  useEffect(() => {
    const selection = urlState.state.selection;
    if (!mapApi.ready || !selection) return undefined;
    let cancelled = false;
    let attempts = 0;
    let timer = null;
    const attempt = () => {
      if (cancelled) return;
      attempts += 1;
      const found = selection.kind === "country"
        ? mapApi.selectCountryByKey(selection.id)
        : mapApi.selectWaterById(selection.id);
      if (found || attempts >= SELECTION_RESTORE_ATTEMPTS) return;
      timer = setTimeout(attempt, SELECTION_RESTORE_INTERVAL_MS);
    };
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Mount-once (gated on mapApi.ready flipping true): urlState.state.selection
    // is a fixed object for the life of this session, and the callbacks are
    // stable useCallbacks -- re-running this on their identity would be a
    // no-op at best and a restarted retry sequence at worst.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapApi.ready]);

  // What every "Copy link" button (the title bar, every info/detail card)
  // actually copies -- read live at click time, not memoised, so the link
  // always matches whatever is on screen the moment the button is pressed.
  // See urlState.js's own module doc for exactly what this does and does not
  // capture, and why.
  const buildShareUrl = useCallback(() => {
    // Session-only URL layer overrides ride on top of the persisted admin
    // wishes, same precedence layerWishes above already applies -- so a link
    // copied without ever touching a layer checkbox still carries whatever
    // layer state the *opened* link asked for, not just this browser's own
    // saved configuration.
    const layers = { ...settings.layerWish, ...urlState.state.layers };
    // A country and a nearby water body can be selected at once (see
    // PlaceInfoCard's own note on why); country wins when both are open,
    // since a click on a country is the more deliberate of the two gestures
    // and this only carries one selection at all -- see urlState.js.
    const selection = mapApi.selectedCountry
      ? { kind: "country", id: mapApi.selectedCountry.key }
      : mapApi.selectedWater
        ? { kind: "water", id: mapApi.selectedWater.id }
        : null;
    const hash = encodeViewState({
      camera: mapApi.getCamera(),
      layers,
      filters: { event: eventFilter, vessel: vesselFilter, aircraft: aircraftFilter },
      selection,
      replayAt: replayApi.isReplaying ? replayApi.replayAt : null,
    });
    return `${window.location.origin}${window.location.pathname}${window.location.search}#${hash}`;
  }, [
    settings.layerWish, mapApi, eventFilter, vesselFilter, aircraftFilter,
    replayApi.isReplaying, replayApi.replayAt,
  ]);

  return (
    <>
      <LoadingScreen sources={dataApi.bootSources} />

      <MapView containerRef={mapContainerRef} panelOpen={panelOpen} />

      {/* Task 35: says so, once, if the link this page loaded with could not
          be read -- see decodeViewState's own contract for why that needs a
          visible signal rather than just quietly falling back. */}
      <UrlStateNotice
        error={urlNoticeDismissed ? null : urlState.error}
        onDismiss={() => setUrlNoticeDismissed(true)}
      />

      <TitleBar
        theme={theme}
        onToggleTheme={toggleTheme}
        adminMode={adminMode}
        onToggleAdminMode={toggleAdminMode}
        onLocatePlace={onLocatePlace}
        getShareUrl={buildShareUrl}
      />

      {/* The reader's way in. Picking a theatre is not an operator's adjustment
          to how the map behaves -- it is the reader saying which part of the
          world they came here for, and it is the one *control* on this screen
          that answers a question about the world rather than about the map. */}
      <RegionBar
        regions={dataApi.regions}
        currentRegionKey={dataApi.currentRegionKey}
        onSelect={onSelectRegion}
        regionActivity={regionActivity}
      />

      {/* Task 33: a live strip of every aircraft currently squawking an
          emergency code. Sits below RegionBar, above the map and every panel
          below -- it renders nothing at all when no aircraft is squawking
          (see SquawkAlertStrip's own note), so it never competes with
          IntelPanel/AirfieldActivityPanel for space on an ordinary day.
          Clicking an entry reuses the same selection path a marker click
          already uses (mapApi.selectAircraftByIcao -> createMapController's
          selectAircraft), so the popup/highlight/trail behave identically. */}
      <SquawkAlertStrip
        aircraft={mapApi.emergencySquawks}
        onSelect={mapApi.selectAircraftByIcao}
        panelOpen={panelOpen}
      />

      {/* The reading panel, and it is the reader's rather than the operator's.

          It was gated with the instruments for a while, on the argument that
          it is a second reading of data the map is already drawing and so
          costs a first look its clarity. That argument was wrong about which
          question it answers. The control drawer, the replay scrubber and the
          configuration panel are all about *the map* -- what is drawn, from what
          zoom, out of which recorded moment. This is about the world: what is
          happening in view right now, and which of it matters most. A reader
          who has come to a conflict map wants exactly that, and the map alone
          cannot say "this is the worst thing on screen" -- it can only draw the
          pin brighter and hope the eye lands on it.

          Task 12 merged what used to be two panels (a news ticker and a
          notable-activity board) into this one, four-tab panel -- Escalation,
          Events, News, Officials -- so there is one place to look, one set of
          scope/window/severity/group-by controls, and one Minimum
          severity/verification floor that this panel and the map both read off
          `eventFilter` rather than two independent copies that could drift
          apart. See IntelPanel.jsx for the rest. */}
      <IntelPanel
        eventsRaw={dataApi.eventsRaw}
        gdeltRaw={dataApi.gdeltRaw}
        officialsRaw={dataApi.officialsRaw}
        escalation={dataApi.escalation}
        eventFilter={eventFilter}
        onEventFilterChange={onEventFilterChange}
        mapBounds={mapApi.mapBounds}
        regions={dataApi.regions}
        currentRegionKey={dataApi.currentRegionKey}
        countryScope={countryScope}
        water={mapApi.selectedWater}
        onLocate={onLocateNewsItem}
        isMobile={isMobileViewport}
      />

      {/* Task 29: /api/airfield-activity has existed since before this plan
          and nothing in the frontend called it -- see AirfieldActivityPanel.jsx's
          own module note. Self-contained (fetches its own two documents rather
          than riding useOsintData's poller table), so mounting it is this one
          line. */}
      <AirfieldActivityPanel onLocate={onLocateNewsItem} isMobile={isMobileViewport} />

      {/* Opened by picking a theatre in the RegionBar above, which is a public
          control -- so gating this behind Admin Mode meant a reader could make
          the gesture and get nothing back. It follows the two panels out for
          that reason rather than as a separate decision: it is the same
          "what is happening here" question, asked of one zone. */}
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

      {/* The drawer and its handle are the operator's instrument panel: layer
          toggles, per-layer counts and totals, the zoom-gate notes, the source
          health lights, the imagery product and the district month. Every one
          of those answers a question about how the map is behaving rather than
          about the world, which is why they go together and why they go here.

          Show approximate locations is what is left of the event filter here:
          it changes what the *map* draws, which is this drawer's business.
          Window, Minimum severity and the verification floor used to be here
          too, on the argument that age/severity/verification state are claim-
          *quality* dimensions an analyst opts into filtering. Task 12 moved
          all three up into IntelPanel's own header -- they are exactly the
          axes a reader curating "what matters" wants without first finding
          Admin Mode -- and they still write into this same `eventFilter`
          object, not a second copy: Window in particular used to be a genuine
          second control (this drawer's own select set `maxAgeDays` directly,
          independently of IntelPanel's), which is exactly the two-copies
          problem this paragraph's last sentence warns about, and is why it
          moved rather than merely being duplicated up there too. See
          LayersSection.jsx's own note at the spot the three controls used to
          sit. */}
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
            vesselFilter={vesselFilter}
            onVesselFilterChange={onVesselFilterChange}
            aircraftFilter={aircraftFilter}
            onAircraftFilterChange={onAircraftFilterChange}
            imageryKey={imageryKey}
            imageryDate={imageryDate}
            onImageryChange={setImageryKey}
            choropleth={mapApi.choropleth}
            onChoroplethChange={mapApi.setChoroplethMetric}
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
        cardSettings={settings.cards}
        getShareUrl={buildShareUrl}
      />

      <WaterInfoCard
        water={mapApi.selectedWater}
        onClose={mapApi.closeWaterCard}
        onOpenRecord={openRecordDetail}
        cardSettings={settings.cards}
        getShareUrl={buildShareUrl}
      />

      <SubdivisionInfoCard
        subdivision={mapApi.selectedSubdivision}
        onClose={mapApi.closeSubdivisionCard}
        onOpenRecord={openRecordDetail}
        cardSettings={settings.cards}
        getShareUrl={buildShareUrl}
      />

      <DistrictInfoCard
        district={mapApi.selectedDistrict}
        onClose={mapApi.closeDistrictCard}
        onOpenRecord={openRecordDetail}
        onMonthChange={mapApi.setDistrictMonth}
        cardSettings={settings.cards}
        getShareUrl={buildShareUrl}
      />

      <EventDetailCard
        detail={recordDetail}
        onClose={() => setRecordDetail(null)}
        getShareUrl={buildShareUrl}
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
          recordsFor={mapApi.recordsFor}
          staleBorders={staleBorders}
          onClose={toggleAdminMode}
          eventFilter={eventFilter}
          onEventFilterChange={onEventFilterChange}
          vesselFilter={vesselFilter}
          onVesselFilterChange={onVesselFilterChange}
          aircraftFilter={aircraftFilter}
          onAircraftFilterChange={onAircraftFilterChange}
        />
      )}
    </>
  );
}
