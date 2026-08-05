// The imperative core of the map. Leaflet (plus markercluster/heat/velocity)
// is a stateful, DOM-owning library -- forcing every layer through React's
// render cycle would mean fighting it for the parts (canvas rendering,
// marker diffing, clustering) that were already carefully tuned for
// performance elsewhere in this app. So instead: this controller owns the
// Leaflet map and all its layers, and reports the small slice of state React
// actually needs to display (counts, zoom-gate notes, viewport bounds) via
// callbacks. useLeafletMap.js is the only place that touches this file
// directly; everything else talks to the map through that hook.
//
// Sectioned to mirror how the logic used to read as one long script:
// layers -> selection/trails -> per-source renderers -> event wiring.

import { L } from "./leafletGlobal";
import { isImprecise, ageHours, ageHoursFromDateAdded, NEWS_WINDOW_HOURS } from "./severity";
import {
  createBaseLayer,
  basemapUrlFor,
  createWeatherLayers,
  createFirmsLayers,
  createJammingLayers,
  createJammingPingGroup,
  createCablesGroup,
  createImageryLayer,
  gibsUrlFor,
  GIBS_LAYERS,
  createEntityClusterGroups,
  createCountriesLayer,
  createCitiesGroup,
  createInfraGroup,
  createPipelinesGroup,
  createSatelliteGroup,
  createTrailLayers,
  createWindFlowLayer,
} from "./layers";
import {
  decorateEvent,
  decorateHistoricalEvent,
  decorateGdelt,
  decorateAis,
  decorateAdsb,
  decorateInfra,
  decorateSatellite,
  isMilitarySatellite,
  classifyAircraft,
  classifyShip,
  SHIP_STYLE,
  AIRCRAFT_STYLE,
  MILITARY_ROLE_STYLE,
  satelliteStyle,
  decorateOfficials,
  eventIconSize,
  gdeltIconSize,
  officialsAgeHours,
  officialsIconSize,
  historicalIconSize,
  infraIconSize,
  decorateCity,
  cityTier,
  cityTierRank,
  pipelineRouteColor,
  decorateHazard,
  hazardIconSize,
  aircraftFlagBucket,
  isFlaggedAircraft,
  withAircraftFlag,
  isSanctioned,
  withSanctionRing,
  AIRCRAFT_FLAG_STYLE,
  decorateAirport,
  airportIconSize,
  decorateDarkVessel,
  darkVesselIconSize,
  decorateCableLanding,
  cableLandingIconSize,
  cableRouteColor,
  decorateLaunch,
  launchIconSize,
  decorateOsmInfra,
  osmInfraIconSize,
} from "./decorators";
import { setIconTheme, themedStyle } from "./iconTheme";
import { placeAll } from "./declutter";
import { collapseByProximity, collapseByKey, COLLAPSE_MAX_ZOOM } from "./collapse";
import { buildCountryIndex, findCountryAt } from "./countryHitTest";
import { countryCardSections, cityPopupHtml, normalizeCountryName } from "./popups";
import { updateTrails, renderTrailLayer } from "./trails";
import { syncLayerMarkers } from "./syncLayerMarkers";
import { createEntityWebglLayer } from "./webglLayer";
import { esc, fmtNumber, fmtFrp, fmtConfidence, fmtFirmsDateTime, haversineKm } from "../utils/format";
import { boundsContainsPoint } from "../utils/geo";
import { fetchJson } from "../api";

// A nearby ACLED/GDELT event within this radius flags an infrastructure
// site as a "hot zone" and triggers its flare animation -- same radius
// class as the city popup's own event-matching (see popups.js), just a bit
// wider since infra strikes are often geocoded to the nearest city/province
// rather than the facility itself.
const INFRA_HOT_RADIUS_KM = 75;

// A country crossing either threshold (matched by name against the current
// ACLED feed, same normalizeCountryName matching the country popup already
// uses) is flagged as an active war and gets the country-hot flare.
const WAR_FATALITY_THRESHOLD = 25;
const WAR_EVENT_COUNT_THRESHOLD = 8;

// No clustering anywhere (see layers.js) -- instead every point layer hides
// below its own MIN_ZOOM and shows its ...ZoomNote, so world zoom stays
// clean by construction rather than by grouping markers into bubbles. The
// map's own initial view is zoom 3 (see L.map(...).setView below), so
// ACLED/GDELT/AIS start hidden by default and appear one zoom step in.
const ADSB_MIN_ZOOM = 5;
const CITIES_MIN_ZOOM = 5;
const EVENTS_MIN_ZOOM = 3;
const GDELT_MIN_ZOOM = 3;
const AIS_MIN_ZOOM = 3;
// AIS has its own dedicated renderAisLayer (civilian/Navy split, like ADS-B's
// civilian/military split) so it isn't part of this generic lookup.
const OFFICIALS_MIN_ZOOM = 3;
const HAZARDS_MIN_ZOOM = 3;
const AIRPORTS_MIN_ZOOM = 7;
// 1,922 landing points, most of them within a few km of another one. The routes
// themselves have no gate -- a cable is only legible as a whole line.
const CABLE_LANDINGS_MIN_ZOOM = 5;
// Thousands of features across the conflict theatres, and every one of them is
// context rather than an event -- gated a step deeper than the curated
// infrastructure layer, which has no gate at all.
const OSM_INFRA_MIN_ZOOM = 6;
const MARKER_LAYER_MIN_ZOOM = {
  events: EVENTS_MIN_ZOOM, gdelt: GDELT_MIN_ZOOM, conflictHistory: 4,
  officials: OFFICIALS_MIN_ZOOM, hazards: HAZARDS_MIN_ZOOM,
  // Hard gate: the served slice is still ~40k airfields worldwide, which below
  // this zoom is a texture rather than a layer.
  airports: AIRPORTS_MIN_ZOOM, cableLandings: CABLE_LANDINGS_MIN_ZOOM,
  osmInfra: OSM_INFRA_MIN_ZOOM,
  // Deliberately absent: darkVessels has no zoom gate. There are only ever a
  // handful worldwide, and "somewhere a designated tanker went dark" is exactly
  // the thing worth seeing at world zoom.
};
// Gates only the interactive per-point FIRMS layer -- the heat layer itself
// always stays on regardless of zoom.
const FIRMS_DETAIL_MIN_ZOOM = 5;

const SHIP_TRAIL_MAX_POINTS = 60;
const AIRCRAFT_TRAIL_MAX_POINTS = 90;
// Satellites poll every 10s (see useOsintData.js's POLL_CONFIG) -- 36 points
// is a several-minute trailing arc, same "grows from app-open" cold start as
// ship/aircraft trails.
const SATELLITE_TRAIL_MAX_POINTS = 36;
// Tankers poll on the same cadence as the rest of AIS -- same "several
// polls back" length as ship trails, not satellites' longer arc.
const TANKER_TRAIL_MAX_POINTS = 60;

const ID_FIELD = {
  events: "id", gdelt: "event_id", ais: "mmsi", adsb: "icao24", conflictHistory: "id",
  officials: "id", hazards: "id", airports: "id", darkVessels: "id", cableLandings: "id",
  launches: "id", osmInfra: "id",
};
const DECORATORS = {
  events: decorateEvent, ais: decorateAis, gdelt: decorateGdelt, adsb: decorateAdsb,
  conflictHistory: decorateHistoricalEvent, officials: decorateOfficials,
  hazards: decorateHazard, airports: decorateAirport, darkVessels: decorateDarkVessel,
  cableLandings: decorateCableLanding, launches: decorateLaunch,
  osmInfra: decorateOsmInfra,
};
// The placement pass has to know how much room each icon needs before any of
// them are drawn, so the size formulas live in decorators.js and are read from
// both places rather than restated here.
const ICON_SIZE_FOR = {
  events: eventIconSize, gdelt: gdeltIconSize, conflictHistory: historicalIconSize,
  officials: officialsIconSize, hazards: hazardIconSize, airports: airportIconSize,
  darkVessels: darkVesselIconSize, cableLandings: cableLandingIconSize,
  launches: launchIconSize, osmInfra: osmInfraIconSize,
};

const REGION_FLY_DURATION = 1.2;

// Which incoming feeds are worth rebuilding an open country card for. See
// refreshFocusedCountryCard for why the fast-moving vehicle feeds are not here.
const COUNTRY_CARD_FEEDS = new Set([
  "events", "gdelt", "officials", "escalation", "conflictStats", "conflictDistricts",
  "outages", "humanitarian",
]);

// leaflet.heat's setLatLngs() always calls its own redraw(), which
// dereferences `this._map._animating` with no null check -- harmless when
// the heat layer is actually on the map, but a hard crash otherwise, and
// FIRMS/jamming now both default to *off* (see DEFAULT_LAYER_VISIBILITY in
// App.jsx) so this path is exercised on every poll while either stays
// toggled off. `_latlngs` is assigned before redraw() runs (a comma
// expression inside the library), so the data itself is never lost --
// swallowing this specific redraw failure just skips the pointless paint
// attempt; the layer draws correctly from that same data once re-added.
function safeHeatSetLatLngs(heatLayer, points) {
  try {
    heatLayer.setLatLngs(points);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
  }
}

function boundsToPlainObject(bounds) {
  return {
    south: bounds.getSouth(),
    west: bounds.getWest(),
    north: bounds.getNorth(),
    east: bounds.getEast(),
  };
}

/**
 * @param {HTMLElement} container - the empty <div> to mount the Leaflet map into
 * @param {object} initial - { theme }
 * @param {object} callbacks - { onCountsChange, onZoomNotesChange, onBoundsChange, onRegionAutoReset }
 */
export function createMapController(container, initial, callbacks) {
  const map = L.map(container, { worldCopyJump: true, minZoom: 2, zoomControl: true }).setView([20, 15], 3);
  const baseLayer = createBaseLayer(map, initial.theme);
  const weatherLayers = createWeatherLayers(map);
  const { firmsHeat, firmsPointsLayer, firmsLayer, firmsCanvasRenderer } = createFirmsLayers(map);
  const { jammingHeat, jammingPointsLayer, jammingLayer, jammingCanvasRenderer } = createJammingLayers(map);
  const jammingPingGroup = createJammingPingGroup();
  const jammingLayerWithPing = L.layerGroup([jammingLayer, jammingPingGroup]).addTo(map);
  const { groups } = createEntityClusterGroups(map);
  const citiesGroup = createCitiesGroup(map);
  const infraGroup = createInfraGroup();
  const pipelinesGroup = createPipelinesGroup();
  const infraLayer = L.layerGroup([infraGroup, pipelinesGroup]).addTo(map);
  // Routes and landing points share one toggle, same as infra wraps its sites
  // and its pipelines: a cable and the place it comes ashore are one fact, and
  // being able to hide half of it helps nobody. NOT added to the map here --
  // the layer is off by default (see DEFAULT_LAYER_VISIBILITY in App.jsx).
  const cablesGroup = createCablesGroup();
  const cablesLayer = L.layerGroup([cablesGroup, groups.cableLandings]);
  // NASA GIBS imagery. Not added to the map until a reader picks a layer.
  const imageryLayer = createImageryLayer(map);
  let imageryKey = null;   // null == off; otherwise a key of GIBS_LAYERS
  let imageryDate = null;  // "YYYY-MM-DD", UTC
  const satelliteGroup = createSatelliteGroup();
  const { shipTrailsLayer, aircraftTrailsLayer, satelliteTrailsLayer, tankerTrailsLayer, militaryTrailsLayer } =
    createTrailLayers(map);
  satelliteGroup.addTo(map);
  const windFlowLayer = createWindFlowLayer(map);
  // GPU-batched sprite rendering for AIS/ADS-B markers (see webglLayer.js) --
  // replaces the L.marker+L.divIcon path buildMarker/updateMarker below still
  // use for every other point layer. One shared Pixi canvas covers all five
  // ais/aisNavy/aisTanker/adsb/adsbMilitary buckets (added to the map once,
  // always on) since toggling five separate WebGL contexts on/off would cost
  // more than it saves -- setLayerVisible below calls entityWebglLayer's own
  // per-bucket setVisible instead of map.addLayer/removeLayer for these keys.
  const entityWebglLayer = createEntityWebglLayer(map);

  // ---------- state that used to be top-level `let`s in app.js ----------
  // All internal to the controller: nothing outside the map needs to know
  // which aircraft is selected, so it never needs to be React state.
  const raw = {
    events: [], firms: [], ais: [], gdelt: [], adsb: [], officials: [],
    countries: { features: [] }, cities: [], infra: [], pipelines: [], jamming: [], satellites: [],
    conflictStats: {},
    // Not live: UCDP's reviewed record (a month or more behind) and ACLED's
    // district-level monthly counts. Held here so country cards can show the
    // verified numbers next to the live picture, each labelled for what it is.
    conflictHistory: [], conflictDistricts: [], escalation: [],
    // Earthquakes (USGS, ~5min) and volcanic activity (Smithsonian GVP, weekly)
    // in one array, each row carrying its own `kind` -- see hazards.py.
    hazards: [],
    // Reference, not a feed: the OurAirports index (see airports.py). Also the
    // only layer here whose *backend* copy is larger than the served one -- the
    // wider set answers "nearest airfield" inside ADS-B popups and never
    // reaches the browser.
    airports: [],
    // Derived from our own recorded AIS history, not fetched (see
    // backend/sources/dark_vessels.py). Every row is an inference.
    darkVessels: [],
    // Orbital launches at their pads, upcoming and just-flown.
    launches: [],
    // OpenStreetMap-derived infrastructure. Kept in its own slot rather than
    // appended to `infra`, because the curated list promises human-checked
    // coordinates and this does not (see backend/sources/osm_infra.py).
    osmInfra: [],
    // Submarine cable routes (lines) and their landing points (markers), plus
    // IODA's country-keyed internet-outage scores. `outages` is a dict, not an
    // array -- it is a country-scoped measure and has no points of its own.
    cables: [], cableLandings: [], outages: {},
    // Country-keyed humanitarian aggregates (ISO3), read by the country card
    // only -- see backend/sources/humanitarian.py for why none of it is drawn.
    humanitarian: {},
  };
  // ais/aisNavy/aisTanker/adsb/adsbMilitary are no longer here -- their
  // markers live inside entityWebglLayer's own per-bucket entry maps now
  // (see webglLayer.js's updateEntities), not as L.marker instances.
  const markersByKey = {
    events: new Map(), gdelt: new Map(), cities: new Map(), infra: new Map(), satellites: new Map(),
    conflictHistory: new Map(), officials: new Map(), hazards: new Map(), airports: new Map(), darkVessels: new Map(),
    cableLandings: new Map(), launches: new Map(), osmInfra: new Map(),
  };
  const shipTrails = new Map();
  const aircraftTrails = new Map();
  const satelliteTrails = new Map();
  const tankerTrails = new Map();
  const militaryTrails = new Map();
  let selectedIcao = null;
  let selectedMmsi = null;
  let countryNameByIso2 = {};
  let currentRegionKey = null; // for flyToRegion's "world" special-case only
  let regionFlightActive = false;
  let regionFlightTimer = null;
  let windRefreshTimer = null;
  let moveEndWindTimer = null;
  let precipRefreshTimer = null;

  // ---------- cities gate + country selection/highlight ----------
  // Cities only render once the user has opted into a scope (clicking a
  // country, or picking a conflict zone from the Region bar) -- world-zoom
  // city dots by default were just clutter with nothing to say about them.
  // The selection/activeConflictZoneBounds double as *which* countries get the
  // `.country-selected` highlight, so both features share one state.
  //
  // A *set* rather than one iso code: comparing two theatres side by side is
  // the thing this map is for, and that was impossible while selecting Ukraine
  // silently dropped Russia. Plain click replaces the selection, ctrl/meta/shift
  // click adds to it (see the map click handler), and nothing else clears it --
  // panning away, picking a region, closing the card all leave it standing,
  // because a highlight that vanishes on the next pan is not a selection.
  let citiesEnabled = false;
  const selectedCountryKeys = new Set();
  // Which of the selected countries the info card is currently showing. Only
  // this one gets its screen anchor tracked across pan/zoom.
  let focusedCountryKey = null;
  let focusedCountryLayer = null;
  let activeConflictZoneBounds = null; // {south,west,north,east} or null

  // Viewport-pixel anchor for the country info card (see CountryInfoCard.jsx)
  // -- it renders as a widget popping out of the clicked country rather than
  // a fixed corner panel, so it needs to track the shape's on-screen position
  // as the user pans/zooms while it's open (see the "move zoom" handler near
  // the bottom of this function).
  function countryAnchorPoint(layer) {
    const center = layer.getBounds().getCenter();
    const pt = map.latLngToContainerPoint(center);
    const rect = container.getBoundingClientRect();
    return { x: rect.left + pt.x, y: rect.top + pt.y };
  }

  // Mirrors the map's actual add/remove state for "satellites" so
  // renderSatellites can skip work (not just hide the result) while
  // switched off.
  let satellitesVisible = true;
  // Same mirror for "countries": the shapes no longer carry their own click
  // handlers (see countryHitTest.js), so the map-level hit-test has to know
  // whether the layer is actually on before it selects anything.
  let countriesVisible = true;
  // These three mirror their own dedicated "*Trails" sub-ticker toggle (see
  // LayersSection.jsx's "Show ... trails" rows and the matching keys in
  // setLayerVisible below) -- entityWebglLayer/renderSatellites keep
  // updating the underlying markers regardless, so each render function
  // needs its own flag to know whether it's worth building trail polylines
  // at all, and each trail track is otherwise independent of whether the
  // parent marker layer itself is shown.
  let tankerTrailsVisible = true;
  let militaryTrailsVisible = true;
  let satellitesTrailsVisible = true;
  // Sub-ticker under "Satellites": hides just the CelesTrak "military" group
  // (see decorators.js's SATELLITE_STYLE) while leaving stations on, so the
  // layer can be narrowed to the ISS/Tiangong-style objects without turning
  // the whole thing off. Filters the pool renderSatellites works from, so
  // both the markers and their orbital trails follow it.
  let satellitesMilitaryVisible = true;

  // News is a sub-ticker of Conflict & Violence, not a layer of its own (see
  // LayersSection.jsx): it draws only when both its own checkbox and its
  // parent's are on, so the two halves are tracked separately and combined by
  // syncNewsLayer. Initialised from the caller's defaults rather than assumed
  // true, because the initial-visibility sweep at the bottom of this function
  // walks the keys in object order and either one can arrive first.
  let eventsVisible = initial.layerVisibility?.events !== false;
  let newsVisible = initial.layerVisibility?.gdelt !== false;

  // Free-text name filter for critical infrastructure/military bases (see
  // setInfraFilter in the public API and the search input in
  // LayersSection.jsx) -- scoped to just this one layer, not a global
  // cross-layer search.
  let infraNameFilter = "";

  // Admin Mode's per-layer zoom gates, keyed the same way the layer toggles
  // are. An absent (or null) entry means "use the shipped gate", so resetting
  // one is deleting an entry rather than restoring a remembered number.
  let layerZoomOverrides = {};

  function minZoomFor(key, shipped) {
    const override = layerZoomOverrides[key];
    return Number.isFinite(override) ? override : shipped;
  }

  // ---------- conflict-event filters ----------
  //
  // What the user asked to see. Applied per item in renderMarkerLayer through
  // LAYER_ITEM_FILTER rather than by special-casing "events" inside the generic
  // loop, so adding a filter to another layer later is a table entry.
  let eventFilter = { maxAgeHours: 72, minSeverity: 0, showImprecise: true };

  function passesEventFilter(item) {
    if (!eventFilter.showImprecise && isImprecise(item)) return false;
    if ((item.severity || 0) < eventFilter.minSeverity) return false;
    if (eventFilter.maxAgeHours != null) {
      const age = ageHours(item);
      // An event we can't date is kept: hiding it would silently drop data on
      // the basis of a missing field rather than of anything the user chose.
      if (Number.isFinite(age) && age > eventFilter.maxAgeHours) return false;
    }
    return true;
  }

  // ---------- news filter ----------
  //
  // News ids that already have a pin of their own -- because a fused conflict
  // record absorbed the headline (event_fusion._coverage_for) or an Officials &
  // Diplomacy record did (officials.py). Drawing them again would put a second
  // marker on top of the first for the same story.
  //
  // The backend used to solve this by deleting those items from /api/news
  // outright, which removed the duplicate marker by removing the article: it
  // then appeared nowhere, not even on the pin that had absorbed it. Now the
  // absorbing record carries the headline *and* names the id, so the feed stays
  // complete (the news panel and the country card both read it unfiltered) and
  // only the redundant marker is suppressed.
  //
  // Built from the full raw arrays rather than from what is currently visible:
  // a conflict pin cut by capBySeverity at world zoom must not cause its news
  // counterpart to blink back into existence.
  let mergedNewsIds = new Set();

  function rebuildMergedNewsIds() {
    const ids = new Set();
    for (const source of [raw.events, raw.officials]) {
      for (const record of source || []) {
        for (const id of record.coverage_event_ids || []) ids.add(id);
      }
    }
    mergedNewsIds = ids;
  }

  function passesNewsFilter(item) {
    if (mergedNewsIds.has(item.event_id)) return false;
    const age = ageHoursFromDateAdded(item.date_added);
    // Undated items are kept, matching passesEventFilter: hiding one would be
    // dropping data on a missing field rather than on anything the user chose.
    return !(Number.isFinite(age) && age > NEWS_WINDOW_HOURS);
  }

  // Diplomacy gets the same hard cutoff news has, on the same window. Until now
  // officials only faded with age (see newsAgeOpacity in decorators.js) and
  // never dropped, so a backgrounded tab or a stalled poller kept yesterday's
  // statements on screen at 30% opacity indefinitely -- readable, clickable and
  // wrong. Fading answers "how fresh is this"; it was never an answer to "is
  // this still current".
  function passesOfficialsFilter(item) {
    const age = officialsAgeHours(item);
    // Undated items are kept, matching the other two filters: hiding one would
    // be dropping data on a missing field rather than on anything a user chose.
    return !(Number.isFinite(age) && age > NEWS_WINDOW_HOURS);
  }

  const LAYER_ITEM_FILTER = {
    events: passesEventFilter,
    gdelt: passesNewsFilter,
    officials: passesOfficialsFilter,
  };

  // At world zoom the map should read as "where is the significant activity",
  // not as an undifferentiated smear. A rank-based cap rather than an absolute
  // severity floor, deliberately: severity is calibrated against real data
  // where a single-outlet report scores in the 20s, so a fixed threshold like
  // "hide anything under 55" would empty the map entirely on a quiet day. A cap
  // adapts -- it only ever removes the least significant events, and only once
  // there are more than can be read at once.
  const ZOOM_MARKER_CAP = [
    { maxZoom: 3, cap: 150 },
    { maxZoom: 5, cap: 400 },
    { maxZoom: 7, cap: 900 },
  ];

  function capBySeverity(items, zoom) {
    const rule = ZOOM_MARKER_CAP.find((r) => zoom <= r.maxZoom);
    if (!rule || items.length <= rule.cap) return items;
    return [...items].sort((a, b) => (b.severity || 0) - (a.severity || 0)).slice(0, rule.cap);
  }

  // News is the one layer that groups rather than merely spreading out -- see
  // collapse.js for why it earns the exception. Reach decides which story
  // becomes the visible head, decayed by age so a busy city shows what broke
  // most recently rather than whatever was biggest yesterday.
  function newsRank(item) {
    const hours = ageHoursFromDateAdded(item.date_added);
    const reach = (item.mentions || 0) + 1;
    return Number.isFinite(hours) ? reach * 0.5 ** (hours / 6) : reach;
  }

  function collapseNews(items, zoom) {
    if (zoom > COLLAPSE_MAX_ZOOM) return items;
    return collapseByProximity(
      items,
      // The same projection registerPlacement uses, so what collapse considers
      // "on top of each other" is what the reader actually sees.
      (item) => map.latLngToLayerPoint([item.lat, item.lon]),
      newsRank
    );
  }

  // Diplomacy groups too, but on an exact anchor rather than on pixels -- see
  // collapseByKey. Every record the backend snapped to a given capital, and
  // every press release from a given institution, shares one coordinate by
  // construction, so "are these on top of each other" has an exact answer and
  // does not need to be measured.
  //
  // Must be above DECLUTTER_MIN_ZOOM. Expanded members share an *exact*
  // LatLng, so every one of them collides and depends on the declutter spiral
  // to be reachable at all; expanding below the zoom at which that spiral runs
  // would produce an unclickable stack.
  const OFFICIALS_EXPAND_MIN_ZOOM = 8;

  // declutter.js gives up after MAX_TRIES ring positions. A group larger than
  // that cannot be fully spread, and the leftovers would sit invisibly on the
  // true point -- so an oversized hub stays collapsed at every zoom rather than
  // pretending to expand.
  const DECLUTTER_CAPACITY = 40;

  // Mirrors officials._rank: reach, decayed by age, with primary sources
  // weighted up. Recency-first is the point -- a capital's hub should show what
  // was said today, not whatever was most widely carried yesterday.
  function officialsRank(item) {
    const hours = officialsAgeHours(item);
    const reach = (item.outlet_count || 0) + 2 + (item.origin === "official_feed" ? 4 : 0);
    return Number.isFinite(hours) ? reach * 0.5 ** (hours / 6) : reach;
  }

  function collapseOfficials(items, zoom) {
    const collapsed = collapseByKey(items, (item) => item.anchor?.id ?? null, officialsRank);
    if (zoom < OFFICIALS_EXPAND_MIN_ZOOM) return collapsed;
    // Zoomed in: hand every member back as its own marker, except where the
    // group is too big for the spiral to place.
    return collapsed.flatMap((item) =>
      item.collapsedCount > DECLUTTER_CAPACITY ? [item] : (item.collapsed || [item])
    );
  }

  // ---------- country/city popups ----------

  // Country click drives a persistent React info card (see CountryInfoCard.jsx/
  // onCountrySelect) that stays open across pan/zoom and toggles closed on a
  // second click of the same country, rather than a Leaflet popup (which
  // auto-panned the map and closed the moment you clicked elsewhere).
  //
  // The shapes themselves are pure paint now (pointer-events: none in
  // style.css) and carry no click/hover handlers -- hit-testing runs off the
  // map's own click/mousemove against the geometry instead. See
  // countryHitTest.js for why: an interactive full-viewport L.Canvas renderer
  // sitting above the countries pane made every country unclickable from the
  // first zoom-in onwards, and no pane ordering fixes that without breaking
  // marker clicks instead.
  const countriesLayer = createCountriesLayer(map);
  let countryIndex = [];          // see buildCountryIndex -- smallest-area-first
  let layerByCountryKey = new Map();
  let hoveredCountryKey = null;

  function countryLayerFor(key) {
    return key == null ? null : layerByCountryKey.get(key) || null;
  }

  // Same shape as updateCountryWarFlare below: iterate the already-rendered
  // countriesLayer and toggle a CSS class per feature, rather than rebuilding
  // anything -- cheap enough to re-run on every selection change.
  //
  // Two classes, because a multi-selection has to say which country the open
  // card belongs to: `.country-selected` is every member, `.country-focused`
  // is the one being read.
  function updateCountryHighlights() {
    countriesLayer.eachLayer((layer) => {
      const props = layer.feature?.properties;
      if (!props) return;
      const key = countryKeyOfProps(props);
      let selected = key != null && selectedCountryKeys.has(key);
      const focused = key != null && key === focusedCountryKey;
      if (!selected && activeConflictZoneBounds) {
        const center = layer.getBounds().getCenter();
        selected = boundsContainsPoint(activeConflictZoneBounds, center.lat, center.lng);
      }
      const el = layer.getElement?.();
      if (el) {
        el.classList.toggle("country-selected", !!selected);
        el.classList.toggle("country-focused", focused);
      }
    });
  }

  // The same fallback buildCountryIndex uses for its `key`, restated here
  // because this side only ever has the raw GeoJSON properties. Territories
  // with no ISO code ("-99" in Natural Earth) key on their name so their shapes
  // still select and highlight.
  function countryKeyOfProps(props) {
    if (props.iso_a2 && props.iso_a2 !== "-99") return props.iso_a2;
    return props.name || null;
  }

  /** The card payload for one country index entry, built from current data. */
  function countryCardFor(entry) {
    const layer = countryLayerFor(entry.key);
    // The country's own bbox drives every "inside this country" count in the
    // card (see popups.js).
    const { sections } = countryCardSections(
      entry.props,
      raw,
      layer ? boundsToPlainObject(layer.getBounds()) : null
    );
    return {
      key: entry.key,
      iso: entry.iso,
      name: entry.name,
      sections,
      point: layer ? countryAnchorPoint(layer) : null,
    };
  }

  /**
   * Rebuild the open card against data that has just landed.
   *
   * Only for the feeds the card actually reports on, and deliberately not for
   * AIS/ADS-B/FIRMS: those poll every 10-20 seconds, and re-rendering the card
   * that often to move a "military aircraft" tally by one would fight anyone
   * trying to read or select text in it. Their numbers refresh on the next
   * conflict/news poll instead.
   */
  function refreshFocusedCountryCard() {
    if (!focusedCountryKey) return;
    const entry = countryEntryFor(focusedCountryKey);
    if (entry) callbacks.onCountrySelect?.(countryCardFor(entry));
  }

  function countryEntryFor(key) {
    return key == null ? null : countryIndex.find((e) => e.key === key) || null;
  }

  /** Tell React which countries are selected, in click order. */
  function reportCountrySelection() {
    callbacks.onCountrySelectionChange?.(
      [...selectedCountryKeys].map((key) => {
        const entry = countryEntryFor(key);
        return { key, iso: entry?.iso ?? null, name: entry?.name || key };
      })
    );
  }

  /** Open (or close) the card on one already-selected country. */
  function focusCountry(key) {
    const entry = countryEntryFor(key);
    focusedCountryKey = entry ? key : null;
    focusedCountryLayer = entry ? countryLayerFor(key) : null;
    callbacks.onCountrySelect?.(entry ? countryCardFor(entry) : null);
    updateCountryHighlights();
  }

  /**
   * @param entry     a country index entry, or null
   * @param additive  ctrl/meta/shift was held -- add to the selection instead
   *                  of replacing it
   */
  function selectCountryEntry(entry, additive = false) {
    const key = entry?.key ?? null;
    if (key == null) return false;

    if (selectedCountryKeys.has(key)) {
      // Clicking a selected country again deselects it, additive or not: it is
      // the only gesture that reads as "not this one" without hunting for a
      // control, and it is what this map has always done for a single country.
      selectedCountryKeys.delete(key);
      if (!additive && selectedCountryKeys.size > 1) {
        // A plain click on one member of a multi-selection means "just this
        // one", so a second plain click on it can only mean "none" -- keeping
        // the others would make the first click look like it did nothing.
        selectedCountryKeys.clear();
      }
    } else {
      if (!additive) selectedCountryKeys.clear();
      selectedCountryKeys.add(key);
    }

    citiesEnabled = selectedCountryKeys.size > 0 || !!activeConflictZoneBounds;
    // The card follows the last country touched; if that one was just removed,
    // it falls back to whatever is still selected rather than closing outright.
    const nextFocus = selectedCountryKeys.has(key)
      ? key
      : [...selectedCountryKeys][selectedCountryKeys.size - 1] ?? null;

    renderCities();
    focusCountry(nextFocus);
    reportCountrySelection();
    return true;
  }

  function setHoveredCountry(key) {
    if (key === hoveredCountryKey) return;
    const previous = countryLayerFor(hoveredCountryKey)?.getElement?.();
    if (previous) previous.classList.remove("hovered");
    hoveredCountryKey = key;
    const next = countryLayerFor(key)?.getElement?.();
    if (next) next.classList.add("hovered");
  }

  function layerForKey(key) {
    if (key === "firms") return firmsLayer;
    if (key === "countries") return countriesLayer;
    if (key === "cities") return citiesGroup;
    if (key === "infra") return infraLayer; // wraps infraGroup + pipelinesGroup together
    if (key === "cables") return cablesLayer; // wraps cablesGroup + the landing-point markers
    if (key === "windArrows") return windFlowLayer;
    if (key === "precip") return weatherLayers.precip;
    if (key === "clouds") return weatherLayers.clouds;
    if (key === "jamming") return jammingLayerWithPing;
    if (key === "satellites") return satelliteGroup;
    return groups[key];
  }

  // The five AIS/ADS-B bucket keys route through entityWebglLayer's own
  // per-bucket visibility instead of a Leaflet layerForKey lookup -- see the
  // comment where entityWebglLayer is created above.
  const WEBGL_BUCKET_KEYS = new Set([
    "adsbCivilian", "adsbMilitary", "adsbFlagged", "aisCivilian", "aisNavy", "aisTanker",
  ]);

  // Each entry: the trail flag it drives, the trail layer to add/remove, the
  // trail Map to clear, and the render fn to catch up with once switched
  // back on -- one dedicated sub-ticker each (see LayersSection.jsx's "Show
  // ... trails" rows), independent of the parent marker layer's own toggle.
  const TRAIL_TOGGLES = {
    aisTankerTrails: { setFlag: (v) => (tankerTrailsVisible = v), layer: () => tankerTrailsLayer, trails: () => tankerTrails, catchUp: renderAisLayer },
    adsbMilitaryTrails: { setFlag: (v) => (militaryTrailsVisible = v), layer: () => militaryTrailsLayer, trails: () => militaryTrails, catchUp: renderAdsbLayer },
    satellitesTrails: { setFlag: (v) => (satellitesTrailsVisible = v), layer: () => satelliteTrailsLayer, trails: () => satelliteTrails, catchUp: renderSatellites },
  };

  // Which layer keys are currently on the map. Read by settlePlacement so a
  // hidden layer's icons don't shove visible ones around: renderMarkerLayer
  // keeps building markers into a layerGroup that has been removed from the
  // map, and those markers are real but invisible.
  const layerOnMap = {};

  // The news group's real state is the AND of its own sub-ticker and the
  // Conflict & Violence parent it now hangs off. layerOnMap gets that combined
  // answer rather than the raw checkbox, so settlePlacement doesn't reserve
  // room for pins that aren't on the map.
  function syncNewsLayer() {
    const show = eventsVisible && newsVisible;
    layerOnMap.gdelt = show;
    if (show) map.addLayer(groups.gdelt);
    else map.removeLayer(groups.gdelt);
  }

  function setLayerVisible(key, visible) {
    layerOnMap[key] = visible;

    // The landing-point markers live inside the combined "cables" layer and
    // have no toggle of their own, but the placement pass keys off the layer
    // name each marker was registered under -- without this they would be
    // treated as permanently hidden and take up no room, so visible pins would
    // be free to sit on top of them.
    if (key === "cables") layerOnMap.cableLandings = visible;

    if (key === "gdelt") {
      newsVisible = visible;
      syncNewsLayer();
      return;
    }
    // Not a layer of its own -- a filter on the satellites layer's pool, so
    // it re-renders in place instead of going through layerForKey (which has
    // nothing to add/remove for this key).
    if (key === "satellitesMilitary") {
      satellitesMilitaryVisible = visible;
      renderSatellites();
      return;
    }

    const trailToggle = TRAIL_TOGGLES[key];
    if (trailToggle) {
      trailToggle.setFlag(visible);
      if (visible) {
        map.addLayer(trailToggle.layer());
        trailToggle.catchUp(); // draw the history accumulated while it was hidden
      } else {
        map.removeLayer(trailToggle.layer());
        trailToggle.layer().clearLayers(); // don't leave a stale trail sitting under the (now-hidden) markers
        // Deliberately NOT trailToggle.trails().clear(): the position history
        // is the expensive thing here (it can only be built up one poll at a
        // time -- neither AIS nor ADS-B nor CelesTrak serves past positions),
        // and throwing it away meant switching the ticker off and back on
        // restarted every trail from a single point. Only the drawn polylines
        // are transient; the history keeps accumulating while hidden (see the
        // updateTrails calls in renderAisLayer/renderAdsbLayer/renderSatellites,
        // which run unconditionally now) so the layer comes back at full length.
      }
      return;
    }

    if (WEBGL_BUCKET_KEYS.has(key)) {
      entityWebglLayer.setVisible(key, visible);
      return;
    }

    const layer = layerForKey(key);
    if (!layer) return;
    if (visible) map.addLayer(layer);
    else map.removeLayer(layer);

    // Parent of the news sub-ticker: switching the conflict layer off takes
    // the headlines with it, switching it back on restores whatever the
    // sub-ticker itself was left set to.
    if (key === "events") {
      eventsVisible = visible;
      syncNewsLayer();
    }

    if (key === "countries") {
      countriesVisible = visible;
      if (!visible) setHoveredCountry(null);
    }

    if (key === "satellites") {
      satellitesVisible = visible;
      if (visible) {
        renderSatellites(); // was skipped entirely while off -- catch up now
        if (satellitesTrailsVisible) map.addLayer(satelliteTrailsLayer);
      } else {
        map.removeLayer(satelliteTrailsLayer); // parent off overrides the trail sub-ticker
        satelliteTrailsLayer.clearLayers();
      }
    }
  }

  // ---------- selection + trails ----------
  // AIS/ADS-B markers are Pixi sprites now (see entityWebglLayer), which
  // have no Leaflet bindPopup/marker.on("click") of their own -- these two
  // functions are what webglLayer.js's onSelect callback (wired below, in
  // renderAisLayer/renderAdsbLayer) calls instead, reproducing the same
  // toggle-select/seed-trail/open-popup/re-decorate behavior the old
  // marker-based handlers gave for free.

  function selectAircraft(item) {
    selectedIcao = selectedIcao === item.icao24 ? null : item.icao24;
    if (selectedIcao) {
      // Seed the trail right away instead of waiting for the next scheduled
      // poll -- otherwise the trail stayed empty until then, which just
      // looked like flight history didn't work.
      updateTrails(aircraftTrails, raw.adsb, "icao24", AIRCRAFT_TRAIL_MAX_POINTS, selectedIcao);
      const d = decorateAdsb(item, { selectedIcao });
      L.popup({ maxWidth: 320 }).setLatLng([item.lat, item.lon]).setContent(d.detail).openOn(map);
    } else {
      aircraftTrails.clear();
      map.closePopup();
    }
    renderAdsbLayer(); // re-decorate every visible aircraft so the highlight moves
  }

  function selectShip(item) {
    selectedMmsi = selectedMmsi === item.mmsi ? null : item.mmsi;
    if (selectedMmsi) {
      updateTrails(shipTrails, raw.ais, "mmsi", SHIP_TRAIL_MAX_POINTS, selectedMmsi);
      const d = decorateAis(item, { selectedMmsi });
      L.popup({ maxWidth: 320 }).setLatLng([item.lat, item.lon]).setContent(d.detail).openOn(map);
    } else {
      shipTrails.clear();
      map.closePopup();
    }
    renderMarkerLayer("ais");
  }

  // Popup/tooltip content is bound as a *function*, not a string, so Leaflet
  // only builds that HTML when the thing is actually opened or hovered. At
  // most one popup and one tooltip exist at a time, but the old eager
  // binding rebuilt the full detail+tooltip markup for every marker on every
  // render -- ~400 markers' worth of string building and DOM writes per pan,
  // for content nobody was looking at. buildCityMarker already used this
  // lazy form; this brings the rest of the point layers in line.
  //
  // The function reads marker._item rather than closing over `item`, because
  // the marker outlives any single render (see syncLayerMarkers' diffing) --
  // updateMarker refreshes _item in place, so an open popup always reflects
  // the entity's current data rather than whatever it held when created.
  // A smaller icon is drawn in front of a bigger one, so a 13px pin can never
  // end up completely buried under a 31px neighbour with no way to click it.
  // Leaflet's own default orders markers by latitude, which says nothing about
  // which of two overlapping icons the user can actually reach.
  function applyStacking(marker, size) {
    marker.setZIndexOffset(-Math.round(size));
  }

  function buildMarker(key, item, decorate, sizeOf) {
    const id = item[ID_FIELD[key]];
    const d = decorate(item, { offset: offsetFor(key, id) });
    const marker = L.marker([item.lat, item.lon], { icon: d.icon });
    marker._item = item;
    marker._iconHtml = d.icon.options.html;
    applyStacking(marker, sizeOf(item));
    marker.bindPopup(() => decorate(marker._item, { selectedIcao, selectedMmsi }).detail, { maxWidth: 320 });
    marker.bindTooltip(() => decorate(marker._item, { selectedIcao, selectedMmsi }).tooltip, {
      className: "map-tooltip",
      direction: "top",
    });
    return marker;
  }

  function updateMarker(marker, item, decorate, key, sizeOf) {
    const id = item[ID_FIELD[key]];
    const d = decorate(item, { selectedIcao, selectedMmsi, offset: offsetFor(key, id) });
    marker._item = item;
    marker.setLatLng([item.lat, item.lon]);
    applyStacking(marker, sizeOf(item));
    // setIcon tears down and recreates the marker's DOM element, so doing it
    // unconditionally meant every pan re-created hundreds of icons that were
    // pixel-identical. The generated html string is a complete description
    // of the icon (glyph, colour, size, rotation, declutter offset -- see
    // svgIcons.js's buildDivIcon), so comparing it is an exact, cheap change
    // test.
    if (marker._iconHtml !== d.icon.options.html) {
      marker.setIcon(d.icon);
      marker._iconHtml = d.icon.options.html;
    }
  }

  // ---------- per-source renderers ----------
  // Every renderer filters to the current viewport (with a margin so panning
  // feels smooth) rather than drawing globally-cached data that isn't on
  // screen -- both a real perf win given FIRMS/ADS-B/cities volumes, and
  // literally "only show what you're looking at."

  const counts = {
    events: 0, firms: 0, gdelt: 0, officials: 0, countries: 0, cities: 0, infra: 0, jamming: 0,
    satellites: 0, aisCivilian: 0, aisNavy: 0, aisTanker: 0, adsbCivilian: 0, adsbMilitary: 0,
    infraMilitary: 0, infraRefinery: 0, infraLng: 0, infraPort: 0, infraDesalination: 0,
    infraNuclear: 0, infraFab: 0, infraPipelineNode: 0, pipelineRoutes: 0,
    hazards: 0, hazardsQuake: 0, hazardsVolcano: 0,
    adsbFlagged: 0, adsbEmergency: 0, adsbHidden: 0, airports: 0,
    aisSanctioned: 0, adsbSanctioned: 0,
    darkVessels: 0, darkGaps: 0, darkSts: 0,
    cables: 0, cableLandings: 0, launches: 0, launchesUpcoming: 0,
    osmInfra: 0, osmMilitary: 0, osmPower: 0, osmBorder: 0,
  };
  // Total number loaded from the backend for each layer, independent of the
  // current viewport/zoom filtering that `counts` reflects -- shown in the
  // UI as the "(total)" figure next to the live on-screen tick.
  const totals = {
    events: 0, firms: 0, gdelt: 0, officials: 0, countries: 0, cities: 0, infra: 0, jamming: 0,
    satellites: 0, aisCivilian: 0, aisNavy: 0, aisTanker: 0, adsbCivilian: 0, adsbMilitary: 0,
    infraMilitary: 0, infraRefinery: 0, infraLng: 0, infraPort: 0, infraDesalination: 0,
    infraNuclear: 0, infraFab: 0, infraPipelineNode: 0, pipelineRoutes: 0,
    hazards: 0, hazardsQuake: 0, hazardsVolcano: 0,
    adsbFlagged: 0, adsbEmergency: 0, adsbHidden: 0, airports: 0,
    aisSanctioned: 0, adsbSanctioned: 0,
    darkVessels: 0, darkGaps: 0, darkSts: 0,
    cables: 0, cableLandings: 0, launches: 0, launchesUpcoming: 0,
    osmInfra: 0, osmMilitary: 0, osmPower: 0, osmBorder: 0,
  };
  // backend/infrastructure.py site "type" -> the counts/totals key it rolls
  // up into, so Critical Infrastructure can show a per-type sub-ticker (see
  // LayersSection.jsx) instead of just one lumped count.
  const INFRA_TYPE_COUNT_KEY = {
    military: "infraMilitary", refinery: "infraRefinery", lng_terminal: "infraLng",
    port: "infraPort", desalination: "infraDesalination", nuclear: "infraNuclear",
    fab: "infraFab", pipeline: "infraPipelineNode",
  };
  const zoomNotes = {
    adsb: false, cities: false, firms: false, events: false, gdelt: false, ais: false, jamming: false,
    officials: false, hazards: false, airports: false, cableLandings: false, osmInfra: false,
  };

  // Layers that report a breakdown as well as a total, so the control panel can
  // show a sub-ticker per category without a bespoke render function (the way
  // INFRA_TYPE_COUNT_KEY does for infrastructure). Each entry maps an item to
  // the counts key it rolls up into, or null to roll up into nothing.
  const LAYER_SUBCOUNT_KEY = {
    hazards: {
      keys: ["hazardsQuake", "hazardsVolcano"],
      of: (item) => (item.kind === "volcano" ? "hazardsVolcano" : "hazardsQuake"),
    },
    darkVessels: {
      keys: ["darkGaps", "darkSts"],
      of: (item) => (item.kind === "sts_pair" ? "darkSts" : "darkGaps"),
    },
    osmInfra: {
      keys: ["osmMilitary", "osmPower", "osmBorder"],
      of: (item) => {
        if (item.kind === "power_plant") return "osmPower";
        if (item.kind === "border_control") return "osmBorder";
        return "osmMilitary"; // airfields and areas roll up together
      },
    },
    launches: {
      keys: ["launchesUpcoming"],
      // Flown launches roll up into nothing: the sub-ticker answers "how many
      // are still to come", and counting the past ones there would answer a
      // question nobody asked.
      of: (item) => (item.upcoming ? "launchesUpcoming" : null),
    },
  };
  function reportCounts() {
    const totalsSuffixed = {};
    for (const key of Object.keys(totals)) totalsSuffixed[`${key}Total`] = totals[key];
    callbacks.onCountsChange?.({ ...counts, ...totalsSuffixed });
  }
  function reportZoomNotes() { callbacks.onZoomNotesChange?.({ ...zoomNotes }); }

  // ---------- cross-layer icon placement ----------
  //
  // One pass over every visible icon of every layer, so that two things a few
  // pixels apart both stay clickable. See declutter.js for the algorithm and
  // for what the previous per-layer version got wrong.
  //
  // Only applied once zoomed in. A screen-space nudge necessarily changes as
  // the projection scales, so applying it at every zoom made pins appear to
  // slide whenever the user zoomed; the trade taken here is that crowding is
  // accepted at world zoom (where individual pins are not readable anyway) and
  // everything is separated -- and therefore reachable -- once zoomed in.
  const DECLUTTER_MIN_ZOOM = 6;

  // Who keeps its true position when two icons want the same pixel. Higher
  // wins. Conflict events outrank everything because their position *is* the
  // claim being made; cities are lowest because a city dot is context, and its
  // real position is already labelled by the basemap underneath it.
  const LAYER_PLACEMENT_PRIORITY = {
    // Above conflict events, and it is the only thing on this map that is: an
    // aircraft squawking 7500 is both rare and the single most time-critical
    // marker the map can draw, so it never gets nudged off its own position.
    adsbFlagged: 110,
    // Just under conflict events: a dark-vessel pin marks a place something was
    // last seen, which is a real position, but it is an inference about it.
    darkVessels: 95,
    events: 100, infra: 80, satellites: 70, aisNavy: 65, adsbMilitary: 65,
    // Above news: several officials pins sit on a capital's coordinate by
    // construction (a press release has no location of its own), so they are
    // the ones that most need to keep their true point rather than being
    // pushed off it by whatever news happens to share the pixel.
    // A hazard's coordinate is an instrument solution (a USGS epicentre) or a
    // volcano's own summit, so it is a measured position rather than an
    // editorial one -- above news and the historical record, below the live
    // conflict layer this map is primarily for.
    aisTanker: 50, officials: 45, hazards: 42, gdelt: 40, conflictHistory: 30, aisCivilian: 20,
    // Below cities: an airfield is background context for the aircraft above
    // it, and it is the one layer here that is allowed to be nudged by anything.
    // Below the curated infrastructure it sits alongside: where the two
    // disagree about the same site, the hand-checked coordinate keeps its pixel.
    adsbCivilian: 20, cities: 10, airports: 5, cableLandings: 15, osmInfra: 25,
  };

  // Buckets that share one render function, so a settle pass triggered by any
  // of them redraws the group once rather than once per bucket.
  // Which counts/totals key each flagged-aircraft bucket rolls up into, read
  // straight off the same table the legend draws from so a bucket added there
  // cannot silently stop being counted here.
  const AIRCRAFT_FLAG_COUNT_KEY = Object.fromEntries(
    Object.entries(AIRCRAFT_FLAG_STYLE).map(([bucket, style]) => [bucket, style.countKey])
  );

  const REDRAW_GROUP = {
    aisCivilian: "ais", aisTanker: "ais", aisNavy: "ais",
    adsbCivilian: "adsb", adsbMilitary: "adsb", adsbFlagged: "adsb",
  };

  // Layer keys are plain identifiers, so splitting a uid on its FIRST "::"
  // always recovers the layer even when the item id contains one itself.
  const SEP = "::";
  const placementInput = new Map(); // layerKey -> [{id, lat, lon, size}]
  let placementOffsets = new Map(); // `${layerKey}\0${id}` -> {dx, dy}
  let settleSuspended = 0;

  function offsetFor(layerKey, id) {
    return placementOffsets.get(`${layerKey}${SEP}${id}`);
  }

  function registerPlacement(layerKey, entries) {
    placementInput.set(layerKey, entries);
  }

  // The WebGL buckets take their offsets as one Map per bucket rather than a
  // per-item lookup, since updateEntities already walks the whole bucket.
  function registerVehiclePlacement(bucketKey, items, idOf, sizeOf) {
    registerPlacement(
      bucketKey,
      items.map((item) => ({ id: idOf(item), lat: item.lat, lon: item.lon, size: sizeOf(item) }))
    );
  }

  // Built from the registered entries rather than by parsing uids back apart,
  // so an id keeps its original type -- MMSIs and NORAD ids arrive as numbers,
  // and the sprite lookup on the other side keys on the raw value.
  function offsetsForBucket(bucketKey) {
    const out = new Map();
    for (const entry of placementInput.get(bucketKey) || []) {
      const off = placementOffsets.get(`${bucketKey}${SEP}${entry.id}`);
      if (off) out.set(entry.id, off);
    }
    return out;
  }

  function redrawLayerGroup(group) {
    if (group === "events" || group === "gdelt" || group === "conflictHistory") renderMarkerLayer(group);
    else if (group === "infra") renderInfra();
    else if (group === "satellites") renderSatellites();
    else if (group === "cities") renderCities();
    else if (group === "ais") renderAisLayer();
    else if (group === "adsb") renderAdsbLayer();
  }

  // Recomputes every offset, then redraws only the layers whose offsets
  // actually changed. Suppressed while a redraw is in flight (a renderer
  // re-registers its own input, which would otherwise recurse) and while
  // renderAll is mid-pass, so a full render settles exactly once at the end
  // instead of once per layer against half-stale input.
  function settlePlacement() {
    if (settleSuspended) return;
    const spread = map.getZoom() >= DECLUTTER_MIN_ZOOM;
    let next = new Map();
    if (spread) {
      const items = [];
      for (const [layerKey, entries] of placementInput) {
        if (layerOnMap[layerKey] === false) continue; // hidden layers take up no room
        const priority = LAYER_PLACEMENT_PRIORITY[layerKey] ?? 0;
        for (const entry of entries) {
          const p = map.latLngToLayerPoint([entry.lat, entry.lon]);
          // A layer may rank its own items (cities do, by population tier) --
          // otherwise everything in it ties and the winner falls to the uid
          // tie-break, which would let a 100k town hold its ground and push a
          // megacity off its real position.
          items.push({
            uid: `${layerKey}${SEP}${entry.id}`,
            x: p.x,
            y: p.y,
            r: entry.size / 2,
            priority: entry.priority ?? priority,
          });
        }
      }
      next = placeAll(items);
    }

    const dirty = new Set();
    const markDirty = (uid) => {
      const layerKey = uid.slice(0, uid.indexOf(SEP));
      dirty.add(REDRAW_GROUP[layerKey] || layerKey);
    };
    for (const [uid, off] of next) {
      const prev = placementOffsets.get(uid);
      if (!prev || prev.dx !== off.dx || prev.dy !== off.dy) markDirty(uid);
    }
    for (const uid of placementOffsets.keys()) if (!next.has(uid)) markDirty(uid);
    placementOffsets = next;
    if (!dirty.size) return;

    settleSuspended += 1;
    try {
      for (const group of dirty) redrawLayerGroup(group);
    } finally {
      settleSuspended -= 1;
    }
  }

  function renderMarkerLayer(key) {
    if (key === "adsb") {
      renderAdsbLayer();
      return;
    }
    if (key === "ais") {
      renderAisLayer();
      return;
    }
    const group = groups[key];
    const decorate = DECORATORS[key];
    const sizeOf = ICON_SIZE_FOR[key];
    const bounds = map.getBounds().pad(0.25);
    const idField = ID_FIELD[key];
    const minZoom = minZoomFor(key, MARKER_LAYER_MIN_ZOOM[key]);
    const belowMinZoom = minZoom != null && map.getZoom() < minZoom;
    if (minZoom != null) {
      zoomNotes[key] = belowMinZoom;
      reportZoomNotes();
    }
    const itemFilter = LAYER_ITEM_FILTER[key];
    let visible = [];
    if (!belowMinZoom) {
      for (const item of raw[key]) {
        if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;
        if (!bounds.contains([item.lat, item.lon])) continue;
        if (itemFilter && !itemFilter(item)) continue;
        visible.push(item);
      }
    }
    if (key === "events") visible = capBySeverity(visible, map.getZoom());
    if (key === "gdelt") visible = collapseNews(visible, map.getZoom());
    if (key === "officials") visible = collapseOfficials(visible, map.getZoom());
    registerPlacement(
      key,
      visible.map((item) => ({ id: item[idField], lat: item.lat, lon: item.lon, size: sizeOf(item) }))
    );
    syncLayerMarkers(
      markersByKey[key],
      group,
      visible,
      (item) => item[idField],
      (item) => buildMarker(key, item, decorate, sizeOf),
      (marker, item) => updateMarker(marker, item, decorate, key, sizeOf)
    );
    counts[key] = visible.length;
    totals[key] = raw[key].length;
    const subcount = LAYER_SUBCOUNT_KEY[key];
    if (subcount) {
      for (const bucket of subcount.keys) {
        counts[bucket] = 0;
        totals[bucket] = 0;
      }
      // `of` may return null -- a layer is allowed to have items that belong in
      // none of its sub-tickers (a flown launch, say).
      for (const item of visible) {
        const bucket = subcount.of(item);
        if (bucket) counts[bucket] += 1;
      }
      for (const item of raw[key]) {
        const bucket = subcount.of(item);
        if (bucket) totals[bucket] += 1;
      }
    }
    reportCounts();
    settlePlacement();
  }

  // Navy/MSC ships (USS/USNS) always render, ignoring the AIS zoom gate,
  // same exemption renderAdsbLayer already gives military aircraft.
  function renderAisLayer() {
    const decorate = DECORATORS.ais;
    const bounds = map.getBounds().pad(0.25);
    // Civilian and tanker share a shipped gate but read it separately, so an
    // Admin Mode override on one does not silently move the other.
    const zoom = map.getZoom();
    const belowAisMinZoom = zoom < minZoomFor("aisCivilian", AIS_MIN_ZOOM);
    const belowTankerMinZoom = zoom < minZoomFor("aisTanker", AIS_MIN_ZOOM);
    zoomNotes.ais = belowAisMinZoom;
    reportZoomNotes();

    // Tankers get their own ticker/layer (see createTankerAisGroup) instead
    // of being mixed into "Civilian Ships" -- three-way split on the same
    // classifyShip() decorators.js already uses to pick the marker icon/color.
    const civilianVisible = [];
    const tankerVisible = [];
    const navyVisible = [];
    for (const item of raw.ais) {
      if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;
      if (!bounds.contains([item.lat, item.lon])) continue;
      const type = classifyShip(item);
      if (type === "navy") {
        navyVisible.push(item);
      } else if (type === "tanker") {
        if (!belowTankerMinZoom) tankerVisible.push(item);
      } else if (!belowAisMinZoom) {
        civilianVisible.push(item);
      }
    }

    // If the selected ship is no longer in the feed at all (out of AIS
    // range / stopped reporting), drop the selection so the highlight/trail
    // don't linger on a marker that no longer exists -- same as ADS-B.
    if (selectedMmsi && !raw.ais.some((s) => s.mmsi === selectedMmsi)) {
      selectedMmsi = null;
      shipTrails.clear();
    }

    const idFn = (item) => item.mmsi;
    const headingFn = (item) => (Number.isFinite(item.heading) && item.heading !== 511 ? item.heading : item.course);
    const tooltipFn = (item) => decorate(item, { selectedMmsi }).tooltip;
    const isSelectedFn = (item) => item.mmsi === selectedMmsi;
    // Resolved once per render rather than per ship: the theme cannot change
    // mid-pass, and these three objects are handed to every sprite in their
    // bucket (see map/iconTheme.js on why the shipped constants are not read
    // directly at a drawing site).
    // One resolved style per class, plus a per-ship function that swaps in the
    // designation ring. It has to be per-ship rather than per-class: an
    // OFAC-listed hull is a handful of vessels inside a bucket of thousands,
    // and webglLayer's texture cache keys on name|color|size, so the ringed
    // variant simply resolves to its own texture (see withSanctionRing).
    const civilianShipStyle = themedStyle(SHIP_STYLE.other, "aisCivilian");
    const tankerShipStyle = themedStyle(SHIP_STYLE.tanker, "aisTanker");
    const navyShipStyle = themedStyle(SHIP_STYLE.navy, "aisNavy");
    const shipStyleFor = (base) => (item) => (isSanctioned(item) ? withSanctionRing(base) : base);
    const civilianStyleFn = shipStyleFor(civilianShipStyle);
    const tankerStyleFn = shipStyleFor(tankerShipStyle);
    const navyStyleFn = shipStyleFor(navyShipStyle);
    registerVehiclePlacement("aisCivilian", civilianVisible, idFn, (item) => civilianStyleFn(item).size);
    registerVehiclePlacement("aisTanker", tankerVisible, idFn, (item) => tankerStyleFn(item).size);
    registerVehiclePlacement("aisNavy", navyVisible, idFn, (item) => navyStyleFn(item).size);
    entityWebglLayer.updateEntities("aisCivilian", civilianVisible, {
      idField: idFn, heading: headingFn, style: civilianStyleFn,
      isSelected: isSelectedFn, onSelect: selectShip, getTooltip: tooltipFn,
      offsets: offsetsForBucket("aisCivilian"),
    });
    entityWebglLayer.updateEntities("aisTanker", tankerVisible, {
      idField: idFn, heading: headingFn, style: tankerStyleFn,
      isSelected: isSelectedFn, onSelect: selectShip, getTooltip: tooltipFn,
      offsets: offsetsForBucket("aisTanker"),
    });
    entityWebglLayer.updateEntities("aisNavy", navyVisible, {
      idField: idFn, heading: headingFn, style: navyStyleFn,
      isSelected: isSelectedFn, onSelect: selectShip, getTooltip: tooltipFn,
      offsets: offsetsForBucket("aisNavy"),
    });

    counts.aisCivilian = civilianVisible.length;
    counts.aisTanker = tankerVisible.length;
    counts.aisNavy = navyVisible.length;
    // Cuts across all three classes rather than being one of them: a designated
    // hull is most often an ordinary cargo ship, and the question "how many
    // listed vessels can I see" is asked of the whole feed at once.
    counts.aisSanctioned = [...civilianVisible, ...tankerVisible, ...navyVisible].filter(isSanctioned).length;
    totals.aisCivilian = 0;
    totals.aisTanker = 0;
    totals.aisNavy = 0;
    totals.aisSanctioned = 0;
    for (const item of raw.ais) {
      const type = classifyShip(item);
      if (isSanctioned(item)) totals.aisSanctioned += 1;
      if (type === "navy") totals.aisNavy += 1;
      else if (type === "tanker") totals.aisTanker += 1;
      else totals.aisCivilian += 1;
    }
    reportCounts();
    settlePlacement();
    // Extend the selected ship's trail on every render, not just at the
    // moment it was clicked. updateTrails appends at most one point per
    // call, so seeding it once in selectShip() left the trail permanently
    // one point long -- and renderTrailLayer skips anything under two
    // points, so a selected ship's trail could never draw at all.
    if (selectedMmsi) updateTrails(shipTrails, raw.ais, "mmsi", SHIP_TRAIL_MAX_POINTS, selectedMmsi);
    renderTrailLayer(shipTrailsLayer, shipTrails, "#35c2ff", selectedMmsi ? new Set([selectedMmsi]) : new Set());

    // Every on-screen tanker gets a trail, not just a selected one -- same
    // "the path itself is the point" reasoning as renderSatellites, just
    // scoped to the current viewport (tankerVisible) since the global tanker
    // fleet is far bigger than the ~46 curated satellites and isn't worth
    // tracking off-screen.
    //
    // Accumulation runs even while the sub-ticker is off, and only the drawing
    // is gated: a position history can only ever be built one poll at a time,
    // so pausing it would punch a hole in the track that switching the ticker
    // back on could never fill (see setLayerVisible's trail branch).
    updateTrails(tankerTrails, tankerVisible, "mmsi", TANKER_TRAIL_MAX_POINTS, undefined);
    if (tankerTrailsVisible) {
      renderTrailLayer(tankerTrailsLayer, tankerTrails, "#ffb347", new Set(tankerTrails.keys()), {
        maxOpacity: 0.35,
        dashArray: "2 5",
      });
    }
  }

  // Military aircraft get their own always-on, never-clustered group so they
  // stay individually visible at any zoom; everyone else keeps the existing
  // clustered/zoom-gated behavior.
  function renderAdsbLayer() {
    const decorate = DECORATORS.adsb;
    const bounds = map.getBounds().pad(0.25);
    const belowAdsbMinZoom = map.getZoom() < minZoomFor("adsbCivilian", ADSB_MIN_ZOOM);
    zoomNotes.adsb = belowAdsbMinZoom;
    reportZoomNotes();

    const civilianVisible = [];
    const militaryVisible = [];
    // Aircraft squawking an emergency code, or listed under LADD/PIA, get their
    // own bucket rather than staying in whichever class they belong to. Two
    // reasons, and both are about not losing the signal: civilian aircraft are
    // off by default, so a 7700 on an airliner would be invisible; and the
    // bucket has no zoom gate, because "somewhere in the world an aircraft is
    // squawking 7500" is worth seeing at world zoom.
    const flaggedVisible = [];
    for (const item of raw.adsb) {
      if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;
      if (!bounds.contains([item.lat, item.lon])) continue;
      if (isFlaggedAircraft(item)) {
        flaggedVisible.push(item);
      } else if (classifyAircraft(item) === "military") {
        militaryVisible.push(item);
      } else if (!belowAdsbMinZoom) {
        civilianVisible.push(item);
      }
    }

    // If the selected aircraft is no longer in the feed at all (out of
    // ADS-B range / stopped reporting), drop the selection so the
    // highlight/trail don't linger on a marker that no longer exists.
    if (selectedIcao && !raw.adsb.some((a) => a.icao24 === selectedIcao)) {
      selectedIcao = null;
      aircraftTrails.clear();
    }

    const idFn = (item) => item.icao24;
    const tooltipFn = (item) => decorate(item, { selectedIcao }).tooltip;
    const isSelectedFn = (item) => item.icao24 === selectedIcao;
    // Themed here rather than at the sprite: webglLayer's texture cache keys on
    // name|color|size, so a recoloured or rescaled style simply resolves to a
    // different texture with no invalidation needed (see map/iconTheme.js).
    const civilianStyle = (item) => themedStyle(AIRCRAFT_STYLE[classifyAircraft(item)], "adsbCivilian");
    const militaryStyle = (item) =>
      themedStyle((item.military_role && MILITARY_ROLE_STYLE[item.military_role]) || AIRCRAFT_STYLE.military, "adsbMilitary");
    // The airframe glyph an aircraft would otherwise have, wearing its status
    // ring -- so a flagged tanker still reads as a tanker (see
    // withAircraftFlag). Themed through its own layer key so the flagged bucket
    // can be scaled independently of the two it draws from.
    const flaggedStyle = (item) =>
      withAircraftFlag(
        themedStyle(
          classifyAircraft(item) === "military"
            ? (item.military_role && MILITARY_ROLE_STYLE[item.military_role]) || AIRCRAFT_STYLE.military
            : AIRCRAFT_STYLE[classifyAircraft(item)],
          "adsbFlagged"
        ),
        item
      );
    registerVehiclePlacement("adsbCivilian", civilianVisible, idFn, (item) => civilianStyle(item).size);
    registerVehiclePlacement("adsbMilitary", militaryVisible, idFn, (item) => militaryStyle(item).size);
    registerVehiclePlacement("adsbFlagged", flaggedVisible, idFn, (item) => flaggedStyle(item).size);
    entityWebglLayer.updateEntities("adsbCivilian", civilianVisible, {
      idField: idFn, heading: (item) => item.heading, style: civilianStyle,
      isSelected: isSelectedFn, onSelect: selectAircraft, getTooltip: tooltipFn,
      offsets: offsetsForBucket("adsbCivilian"),
    });
    entityWebglLayer.updateEntities("adsbMilitary", militaryVisible, {
      idField: idFn, heading: (item) => item.heading, style: militaryStyle,
      isSelected: isSelectedFn, onSelect: selectAircraft, getTooltip: tooltipFn,
      offsets: offsetsForBucket("adsbMilitary"),
    });
    entityWebglLayer.updateEntities("adsbFlagged", flaggedVisible, {
      idField: idFn, heading: (item) => item.heading, style: flaggedStyle,
      isSelected: isSelectedFn, onSelect: selectAircraft, getTooltip: tooltipFn,
      offsets: offsetsForBucket("adsbFlagged"),
    });

    counts.adsbCivilian = civilianVisible.length;
    counts.adsbMilitary = militaryVisible.length;
    counts.adsbFlagged = flaggedVisible.length;
    // Exclusive buckets, resolved by one function so the sub-ticker counts
    // always sum to the layer's own count (see aircraftFlagBucket).
    counts.adsbSanctioned = 0;
    counts.adsbEmergency = 0;
    counts.adsbHidden = 0;
    for (const item of flaggedVisible) counts[AIRCRAFT_FLAG_COUNT_KEY[aircraftFlagBucket(item)]] += 1;
    totals.adsbCivilian = 0;
    totals.adsbMilitary = 0;
    totals.adsbFlagged = 0;
    totals.adsbEmergency = 0;
    totals.adsbHidden = 0;
    totals.adsbSanctioned = 0;
    for (const item of raw.adsb) {
      const bucket = aircraftFlagBucket(item);
      if (bucket) {
        totals.adsbFlagged += 1;
        totals[AIRCRAFT_FLAG_COUNT_KEY[bucket]] += 1;
      } else if (classifyAircraft(item) === "military") totals.adsbMilitary += 1;
      else totals.adsbCivilian += 1;
    }
    reportCounts();
    settlePlacement();
    // Same per-render accumulation the selected ship needs -- see the note
    // in renderAisLayer.
    if (selectedIcao) updateTrails(aircraftTrails, raw.adsb, "icao24", AIRCRAFT_TRAIL_MAX_POINTS, selectedIcao);
    renderTrailLayer(aircraftTrailsLayer, aircraftTrails, "#d8b9ff", selectedIcao ? new Set([selectedIcao]) : new Set());

    // Every on-screen military aircraft gets a trail, not just a selected
    // one -- same "the path itself is the point" reasoning as tanker/
    // satellite trails above. Accumulates regardless of the sub-ticker; only
    // the drawing is gated (see renderAisLayer's note).
    updateTrails(militaryTrails, militaryVisible, "icao24", AIRCRAFT_TRAIL_MAX_POINTS, undefined);
    if (militaryTrailsVisible) {
      renderTrailLayer(militaryTrailsLayer, militaryTrails, "#ff4d4d", new Set(militaryTrails.keys()), {
        maxOpacity: 0.35,
        dashArray: "2 5",
      });
    }
  }

  function renderFirms() {
    const bounds = map.getBounds().pad(0.25);
    const visible = raw.firms.filter(
      (d) => typeof d.lat === "number" && typeof d.lon === "number" && bounds.contains([d.lat, d.lon])
    );
    // Always on, any zoom -- leaflet.heat draws this as one canvas
    // regardless of point count, so it stays cheap even with tens of
    // thousands visible.
    safeHeatSetLatLngs(firmsHeat, visible.map((d) => [d.lat, d.lon, Math.min((d.frp ? Number(d.frp) : 5) / 50, 1) + 0.2]));

    firmsPointsLayer.clearLayers();
    const belowFirmsDetailZoom = map.getZoom() < FIRMS_DETAIL_MIN_ZOOM;
    zoomNotes.firms = belowFirmsDetailZoom;
    reportZoomNotes();
    if (!belowFirmsDetailZoom) {
      for (const d of visible) {
        const dt = fmtFirmsDateTime(d.acq_date, d.acq_time);
        const dayNight = d.daynight === "N" ? "Night" : d.daynight === "D" ? "Day" : "n/a";
        const tooltip = `<b>${esc(fmtFrp(d.frp))}</b><br/>${esc(dt)}`;
        const sourceLabel = d.source === "hms"
          ? `NOAA HMS${d.satellite ? ` (${d.satellite})` : ""}`
          : "NASA FIRMS (VIIRS)";
        const detail = `
          <h3>Thermal anomaly</h3>
          <div class="meta">${esc(dt)} &middot; ${esc(dayNight)}</div>
          <div>Brightness (TI4): ${Number.isFinite(d.brightness) ? `${d.brightness.toFixed(1)} K` : "n/a"}</div>
          <div>Confidence: ${esc(fmtConfidence(d.confidence))}</div>
          <div>Fire Radiative Power: ${esc(fmtFrp(d.frp))}</div>
          <div class="meta">Source: ${esc(sourceLabel)}</div>`;
        // Effectively invisible, but a truly-zero opacity is "unpainted" and
        // isn't reliably hit-tested for clicks/hovers in some renderers -- a
        // hair above zero keeps it invisible while staying clickable. Shared
        // canvas renderer batches every point into one <canvas> instead of
        // one DOM/SVG node each, which is what makes even the gated (zoomed
        // in) count affordable.
        const marker = L.circleMarker([d.lat, d.lon], {
          radius: 6,
          fillOpacity: 0.02,
          opacity: 0,
          renderer: firmsCanvasRenderer,
        });
        marker.bindTooltip(tooltip, { className: "map-tooltip", direction: "top" });
        marker.bindPopup(detail, { maxWidth: 280 });
        firmsPointsLayer.addLayer(marker);
      }
    }

    counts.firms = visible.length;
    totals.firms = raw.firms.length;
    reportCounts();
  }

  function satelliteIconSize(sat) {
    return satelliteStyle(sat.group).size;
  }

  function buildSatelliteMarker(sat) {
    const d = decorateSatellite(sat, { offset: offsetFor("satellites", sat.norad_id) });
    const marker = L.marker([sat.lat, sat.lon], { icon: d.icon });
    marker._item = sat;
    marker._iconHtml = d.icon.options.html;
    applyStacking(marker, satelliteIconSize(sat));
    marker.bindPopup(() => decorateSatellite(marker._item).detail, { maxWidth: 320 });
    marker.bindTooltip(() => decorateSatellite(marker._item).tooltip, {
      className: "map-tooltip",
      direction: "top",
    });
    return marker;
  }

  // Satellites re-poll every 10s and their glyph never varies -- only the
  // position and (since the declutter pass) the offset do, so the icon is only
  // rebuilt when the generated HTML actually differs, same test updateMarker
  // uses.
  function updateSatelliteMarker(marker, sat) {
    marker._item = sat;
    marker.setLatLng([sat.lat, sat.lon]);
    const d = decorateSatellite(sat, { offset: offsetFor("satellites", sat.norad_id) });
    if (marker._iconHtml !== d.icon.options.html) {
      marker.setIcon(d.icon);
      marker._iconHtml = d.icon.options.html;
    }
  }

  // Always on, any zoom -- only ~46 curated objects (stations + military),
  // same reasoning as militaryAdsbGroup/infra.
  function renderSatellites() {
    // Skip the work entirely while the layer is switched off -- not just
    // hidden. setLayerVisible clears satelliteTrailsLayer and re-runs this
    // once when switched back on, so nothing is missed, but a backgrounded
    // 10s-interval poll doesn't spend time building/updating markers and
    // trails nobody can see.
    if (!satellitesVisible) return;

    // The "Show military satellites" sub-ticker narrows the whole layer, not
    // just what's drawn -- counts, the "(total)" figure and the trails below
    // all work off this pool so the panel never advertises objects the map is
    // deliberately hiding.
    const pool = satellitesMilitaryVisible
      ? raw.satellites
      : raw.satellites.filter((s) => !isMilitarySatellite(s));

    const bounds = map.getBounds().pad(0.25);
    const visible = pool.filter(
      (s) => typeof s.lat === "number" && typeof s.lon === "number" && bounds.contains([s.lat, s.lon])
    );
    registerPlacement(
      "satellites",
      visible.map((s) => ({ id: s.norad_id, lat: s.lat, lon: s.lon, size: satelliteIconSize(s) }))
    );
    syncLayerMarkers(markersByKey.satellites, satelliteGroup, visible, (s) => s.norad_id, buildSatelliteMarker, updateSatelliteMarker);
    counts.satellites = visible.length;
    totals.satellites = pool.length;
    reportCounts();
    settlePlacement();

    // Satellites have no click-to-select model like ships/aircraft, so every
    // satellite's trail is tracked all the time (restrictTo === undefined,
    // per trails.js's documented semantics) rather than just the selected
    // one -- their orbital path is the point, not a detail you opt into.
    // Semi-transparent + dashed (vs. ship/aircraft trails' solid look) so it
    // reads as a background orbital track, not an active-selection cue.
    // Drawing is gated on its own sub-ticker (satellitesTrailsVisible),
    // independent of the Satellites layer itself being on -- see the
    // "satellitesTrails" key in setLayerVisible. Accumulation is not gated:
    // an orbital track can only be built one 10s poll at a time.
    updateTrails(satelliteTrails, pool, "norad_id", SATELLITE_TRAIL_MAX_POINTS, undefined);
    if (satellitesTrailsVisible) {
      // Military objects' tracks take the same red as their marker glyph, so a
      // reconnaissance satellite's orbit reads as one at a glance instead of
      // disappearing into a field of identical cyan arcs. The colour comes
      // straight from SATELLITE_STYLE rather than being restated here.
      const militaryIds = new Set(pool.filter(isMilitarySatellite).map((s) => s.norad_id));
      renderTrailLayer(
        satelliteTrailsLayer,
        satelliteTrails,
        (id) => (militaryIds.has(id) ? satelliteStyle("military").color : satelliteStyle("stations").color),
        new Set(satelliteTrails.keys()),
        { maxOpacity: 0.22, dashArray: "2 5" }
      );
    }
  }

  // Concentric-rings "sonar ping"/water-drop-ripple marker for an active
  // jamming cell -- distinct from the .infra-hot/.country-hot steady glow.
  // Loops continuously via CSS (animation-iteration-count: infinite, see
  // .jamming-ping-ring in style.css) for as long as the cell stays on the
  // map, rebuilt on every renderJamming() pass alongside jammingPointsLayer
  // rather than firing once and leaving only the heat layer's static purple
  // blur behind.
  function buildJammingPing(d) {
    const html =
      '<div class="jamming-ping-wrap">' +
      '<span class="jamming-ping-ring" style="animation-delay:0ms"></span>' +
      '<span class="jamming-ping-ring" style="animation-delay:1500ms"></span>' +
      '<span class="jamming-ping-ring" style="animation-delay:3000ms"></span>' +
      "</div>";
    const icon = L.divIcon({ html, className: "", iconSize: [1, 1], iconAnchor: [0, 0] });
    const marker = L.marker([d.lat, d.lon], { icon, interactive: false });
    jammingPingGroup.addLayer(marker);
  }

  function renderJamming() {
    const bounds = map.getBounds().pad(0.25);
    // Same zoom gate as civilian ADS-B (ADSB_MIN_ZOOM) -- world zoom stays
    // clean by construction rather than by showing a purple blur everywhere,
    // heat/pings/points all withheld together until the user zooms in.
    const belowJammingDetailZoom = map.getZoom() < ADSB_MIN_ZOOM;
    zoomNotes.jamming = belowJammingDetailZoom;
    reportZoomNotes();

    const visible = belowJammingDetailZoom
      ? []
      : raw.jamming.filter(
          (d) => typeof d.lat === "number" && typeof d.lon === "number" && bounds.contains([d.lat, d.lon])
        );

    safeHeatSetLatLngs(jammingHeat, visible.map((d) => [d.lat, d.lon, d.jam_ratio]));

    jammingPointsLayer.clearLayers();
    jammingPingGroup.clearLayers();
    for (const d of visible) {
      buildJammingPing(d);
      const tooltip = `<b>${Math.round(d.jam_ratio * 100)}% affected</b><br/>${d.bad}/${d.bad + d.good} reports`;
      const detail = `
        <h3>GPS/GNSS interference</h3>
        <div class="meta">${esc(d.date || "")}</div>
        <div>Affected aircraft reports: ${Math.round(d.jam_ratio * 100)}% (${d.bad} of ${d.bad + d.good})</div>
        <p class="meta">Derived from ADS-B aircraft GPS-quality reports, aggregated into a ~1,770km&sup2; hex cell -- a once-daily, regional signal, not a real-time or pinpoint one.</p>
        <div class="meta">Source: gpsjam.org (ADS-B Exchange)</div>`;
      // Hit radius sized to the *visible* ping ring (up to ~31px at peak
      // scale, see .jamming-ping-ring/@keyframes jamming-ping in style.css),
      // not the old 8px dot -- otherwise the pulsing ring people actually
      // see and click on covers far more area than the thing registering
      // the click, and most clicks miss.
      const marker = L.circleMarker([d.lat, d.lon], {
        radius: 18,
        fillOpacity: 0.02,
        opacity: 0,
        renderer: jammingCanvasRenderer,
      });
      marker.bindTooltip(tooltip, { className: "map-tooltip", direction: "top" });
      marker.bindPopup(detail, { maxWidth: 280 });
      jammingPointsLayer.addLayer(marker);
    }

    counts.jamming = visible.length;
    totals.jamming = raw.jamming.length;
    reportCounts();
  }

  // Country boundaries only actually change once/day server-side (see
  // countries.py), but the frontend re-polls every 5 minutes and a browser
  // HTTP cache hit still hands back a fresh-looking (but byte-identical)
  // payload -- rebuilding the whole GeoJSON layer (and killing any open
  // popup) on every one of those ticks is the same anti-pattern
  // syncLayerMarkers exists to avoid. Skip the rebuild when nothing changed.
  //
  // Fingerprinted on the feature count plus the ISO/name list rather than
  // JSON.stringify of the whole payload: the boundaries are several megabytes
  // and serialising them every five minutes to detect a change that happens
  // once a day is real main-thread time for nothing. A boundary edit that
  // touched only vertex coordinates would be missed until the next reload,
  // which is an acceptable trade for a dataset whose own updates are country
  // additions and renames.
  let lastCountriesSignature = null;

  function renderCountries() {
    const features = raw.countries.features || [];
    const signature = `${features.length}|${features
      .map((f) => f.properties?.iso_a2 || f.properties?.name || "?")
      .join(",")}`;
    if (signature !== lastCountriesSignature) {
      lastCountriesSignature = signature;
      countriesLayer.clearLayers();
      if (features.length) countriesLayer.addData(raw.countries);
      countryNameByIso2 = {};
      for (const f of features) {
        if (f.properties.iso_a2) countryNameByIso2[f.properties.iso_a2] = f.properties.name;
      }
      // Rebuilt together with the layer so the two can never disagree about
      // which shapes exist. Selection is keyed by ISO/name rather than by a
      // captured layer reference, so a boundary refresh can't strand the
      // selected country on a detached layer.
      countryIndex = buildCountryIndex(raw.countries);
      layerByCountryKey = new Map();
      countriesLayer.eachLayer((layer) => {
        const props = layer.feature?.properties || {};
        const key = props.iso_a2 && props.iso_a2 !== "-99" ? props.iso_a2 : props.name || null;
        if (key != null) layerByCountryKey.set(key, layer);
      });
      hoveredCountryKey = null;
      focusedCountryLayer = countryLayerFor(focusedCountryKey);
      counts.countries = features.length;
      totals.countries = features.length;
      reportCounts();
    }
    updateCountryWarFlare();
    updateCountryHighlights();
  }

  // Flags a country as an active war zone (a pulsing red flare, same visual
  // language as the infra hot-zone flare) when its current ACLED activity
  // crosses a threshold -- but only for countries currently in scope
  // (individually selected, or inside the active conflict zone's bounds,
  // same "inScope" test updateCountryHighlights uses). A country never
  // pulses just because it crossed the threshold; it has to be the thing
  // the user picked first. Only toggles a CSS class on the already-rendered
  // path -- cheap enough to re-run after every ACLED update, not just when
  // the country boundaries themselves change.
  function updateCountryWarFlare() {
    countriesLayer.eachLayer((layer) => {
      const props = layer.feature?.properties;
      const name = props?.name;
      if (!name) return;
      const key = countryKeyOfProps(props);
      let inScope = key != null && selectedCountryKeys.has(key);
      if (!inScope && activeConflictZoneBounds) {
        const center = layer.getBounds().getCenter();
        inScope = boundsContainsPoint(activeConflictZoneBounds, center.lat, center.lng);
      }
      let hot = false;
      if (inScope) {
        const wanted = normalizeCountryName(name);
        let fatalities = 0;
        let count = 0;
        for (const e of raw.events) {
          if (normalizeCountryName(e.country) !== wanted) continue;
          fatalities += e.fatalities || 0;
          count += 1;
        }
        hot = fatalities >= WAR_FATALITY_THRESHOLD || count >= WAR_EVENT_COUNT_THRESHOLD;
      }
      const el = layer.getElement?.();
      if (el) el.classList.toggle("country-hot", hot);
    });
  }

  function cityKey(city) {
    // GeoNames' own id when present. The composite fallback is kept so a
    // browser holding a cached /api/cities response from before the id was
    // served still renders instead of collapsing every city onto one key.
    return city.geonameid != null
      ? `geo:${city.geonameid}`
      : `${city.name}|${city.country_code}|${city.lat}|${city.lon}`;
  }

  // Glyph and size both come from the city's population tier (see
  // decorators.js's CITY_TIERS) -- what used to be one identical dot for
  // everything from a 100k town to Shanghai.
  function buildCityMarker(city) {
    const { icon, size, tier } = decorateCity(city, { offset: offsetFor("cities", cityKey(city)) });
    const marker = L.marker([city.lat, city.lon], { icon });
    marker._iconHtml = icon.options.html;
    applyStacking(marker, size);
    marker.bindPopup(() => cityPopupHtml(city, raw, countryNameByIso2), { maxWidth: 320 });
    // Capitals name both facts -- "Capital city" alone loses the size band a
    // reader is comparing against, and the population tier alone loses the
    // reason it is drawn with a star.
    const label = city.is_capital
      ? `${esc(tier.label)} &middot; ${esc(cityTier(city.population).label)}`
      : esc(tier.label);
    marker.bindTooltip(`${esc(city.name)} &middot; ${label}<br/>Population: ${fmtNumber(city.population)}`, {
      className: "map-tooltip",
      direction: "top",
    });
    return marker;
  }

  function updateCityMarker(marker, city) {
    const { icon } = decorateCity(city, { offset: offsetFor("cities", cityKey(city)) });
    if (marker._iconHtml !== icon.options.html) {
      marker.setIcon(icon);
      marker._iconHtml = icon.options.html;
    }
  }

  function renderCities() {
    const belowCitiesMinZoom = map.getZoom() < minZoomFor("cities", CITIES_MIN_ZOOM);
    // citiesScoped tells the UI *which* note to show (see PlacesSection.jsx)
    // -- "select a country/zone" takes priority over "zoom in", since
    // zooming in without a scope selected still shows nothing.
    zoomNotes.citiesScoped = citiesEnabled;
    zoomNotes.cities = !citiesEnabled || belowCitiesMinZoom;
    reportZoomNotes();
    const bounds = map.getBounds().pad(0.25);
    // Scoped to the in-scope countries/zone, not just whatever's in the
    // viewport -- selected countries only show *their own* cities (matched by
    // country_code, the same ISO2 the selection holds), and a conflict-zone
    // selection only shows cities inside that zone's own bounds, even in world
    // view where the map viewport itself spans the whole globe. Falls back to
    // `false` if citiesEnabled is somehow true without either scope set, which
    // shouldn't happen (see flyToRegion and selectCountryEntry, the only two
    // places that set it).
    const visible =
      !citiesEnabled || belowCitiesMinZoom
        ? []
        : raw.cities.filter((c) => {
            if (!bounds.contains([c.lat, c.lon])) return false;
            if (selectedCountryKeys.size) return selectedCountryKeys.has(c.country_code);
            if (activeConflictZoneBounds) return boundsContainsPoint(activeConflictZoneBounds, c.lat, c.lon);
            return false;
          });
    registerPlacement(
      "cities",
      visible.map((c) => {
        const tier = cityTier(c.population);
        // Bigger city wins the contested pixel: rank rides on top of the
        // layer's own priority, and stays well under the next layer up.
        return { id: cityKey(c), lat: c.lat, lon: c.lon, size: tier.size, priority: 10 + cityTierRank(tier) };
      })
    );
    // Diff-based sync (not clearLayers()+rebuild) -- a full teardown on
    // every moveend used to destroy the marker (and its just-opened popup)
    // that a click's own auto-pan had just triggered, making city dots feel
    // unclickable. See renderMarkerLayer/syncLayerMarkers for the same fix
    // applied to every other point layer.
    syncLayerMarkers(markersByKey.cities, citiesGroup, visible, cityKey, buildCityMarker, updateCityMarker);
    counts.cities = visible.length;
    totals.cities = raw.cities.length;
    reportCounts();
    settlePlacement();
  }

  // ---------- critical infrastructure + hot-zone flare ----------

  // Bumped whenever the data nearbyEventsFor() reads actually changes (see
  // applyData). Every other trigger for a re-render -- panning, zooming,
  // toggling a layer -- leaves that data untouched, so the cache below turns
  // what was a full O(sites x events) haversine sweep per moveend into one
  // sweep per ACLED/GDELT poll. Measured at ~22k distance calculations per
  // pan before this, on top of the popup HTML it fed.
  let eventsDataVersion = 0;
  const nearbyEventsCache = new Map(); // site key -> { version, events }

  function nearbyEventsFor(site) {
    const cacheKey = `${site.name}|${site.lat}|${site.lon}`;
    const cached = nearbyEventsCache.get(cacheKey);
    if (cached && cached.version === eventsDataVersion) return cached.events;
    const computed = computeNearbyEventsFor(site);
    nearbyEventsCache.set(cacheKey, { version: eventsDataVersion, events: computed });
    return computed;
  }

  function computeNearbyEventsFor(site) {
    const events = [];
    for (const e of raw.events) {
      if (typeof e.lat !== "number" || typeof e.lon !== "number") continue;
      if (haversineKm(site.lat, site.lon, e.lat, e.lon) > INFRA_HOT_RADIUS_KM) continue;
      events.push({ headline: e.event_type || "Conflict event", source: (e.corroborated_by || [e.source]).join("/").toUpperCase() });
    }
    for (const e of raw.gdelt) {
      if (typeof e.lat !== "number" || typeof e.lon !== "number") continue;
      if (haversineKm(site.lat, site.lon, e.lat, e.lon) > INFRA_HOT_RADIUS_KM) continue;
      const headline = (e.real_title || "").trim();
      if (!headline) continue; // defensive: /api/news should never serve a title-less item
      events.push({ headline, source: e.source_name || "GDELT" });
    }
    return events.slice(0, 5);
  }

  // Same lazy-content + icon-diff treatment as buildMarker/updateMarker
  // above, and for the same reason: the "recent activity within 75km" list
  // rendered into each popup is the most expensive markup in the app, and
  // it was being built for all 79 sites on every pan.
  function infraDecoration(site, offset) {
    const nearbyEvents = nearbyEventsFor(site);
    return decorateInfra(site, { hot: nearbyEvents.length > 0, nearbyEvents, offset });
  }

  function buildInfraMarker(site) {
    const d = infraDecoration(site, offsetFor("infra", site.id));
    const marker = L.marker([site.lat, site.lon], { icon: d.icon });
    marker._item = site;
    marker._iconHtml = d.icon.options.html;
    applyStacking(marker, infraIconSize());
    marker.bindPopup(() => infraDecoration(marker._item).detail, { maxWidth: 320 });
    marker.bindTooltip(() => infraDecoration(marker._item).tooltip, {
      className: "map-tooltip",
      direction: "top",
    });
    return marker;
  }

  function updateInfraMarker(marker, site) {
    const d = infraDecoration(site, offsetFor("infra", site.id));
    marker._item = site;
    if (marker._iconHtml !== d.icon.options.html) {
      marker.setIcon(d.icon);
      marker._iconHtml = d.icon.options.html;
    }
  }

  function renderInfra() {
    const bounds = map.getBounds().pad(0.25);
    const needle = infraNameFilter.trim().toLowerCase();
    const visible = raw.infra.filter(
      (s) => bounds.contains([s.lat, s.lon]) && (!needle || s.name.toLowerCase().includes(needle))
    );
    registerPlacement(
      "infra",
      visible.map((s) => ({ id: s.id, lat: s.lat, lon: s.lon, size: infraIconSize() }))
    );
    // Diff-sync like every other point layer -- re-runs on every ACLED/GDELT
    // update too (see renderAll) so a flare turns on/off promptly, without
    // destroying markers/open popups for sites whose hot status didn't change.
    syncLayerMarkers(markersByKey.infra, infraGroup, visible, (s) => s.id, buildInfraMarker, updateInfraMarker);
    counts.infra = visible.length;
    totals.infra = raw.infra.length;

    for (const key of Object.values(INFRA_TYPE_COUNT_KEY)) {
      counts[key] = 0;
      totals[key] = 0;
    }
    for (const s of visible) {
      const key = INFRA_TYPE_COUNT_KEY[s.type];
      if (key) counts[key] += 1;
    }
    for (const s of raw.infra) {
      const key = INFRA_TYPE_COUNT_KEY[s.type];
      if (key) totals[key] += 1;
    }
    reportCounts();
    settlePlacement();
  }

  // Pipeline routes (backend/infrastructure.py's PIPELINE_ROUTES) -- a small
  // static set fetched once (see useOsintData.js), so this just draws every
  // route once rather than diff-syncing per-viewport like the point layers.
  function renderPipelines() {
    pipelinesGroup.clearLayers();
    for (const route of raw.pipelines) {
      const line = L.polyline(route.coords, {
        color: pipelineRouteColor(),
        weight: 2,
        opacity: 0.65,
        dashArray: "6 6",
      });
      line.bindTooltip(esc(route.name), { className: "map-tooltip", direction: "top" });
      line.bindPopup(`<h3>${esc(route.name)}</h3><p>${esc(route.note || "")}</p>`, { maxWidth: 280 });
      pipelinesGroup.addLayer(line);
    }
    counts.pipelineRoutes = raw.pipelines.length;
    totals.pipelineRoutes = raw.pipelines.length;
    reportCounts();
  }

  // Cable routes are drawn once and never re-drawn on pan or zoom: unlike every
  // marker layer, a polyline is already clipped by Leaflet and a cable only
  // makes sense as a whole line, so bounds-filtering it would cut cables in
  // half at the edge of the viewport for no saving.
  function renderCables() {
    cablesGroup.clearLayers();
    const color = cableRouteColor();
    for (const cable of raw.cables) {
      for (const path of cable.paths || []) {
        const line = L.polyline(path, {
          // The publisher's own per-cable colour where there is one, so a cable
          // looks the same here as on the map most readers have already seen.
          color: cable.color || color,
          weight: 1.4,
          opacity: 0.5,
        });
        line.bindTooltip(esc(cable.name), { className: "map-tooltip", direction: "top", sticky: true });
        line.bindPopup(
          `<h3>${esc(cable.name)}</h3>` +
          '<p class="meta">Route drawn schematically, for legibility &mdash; roughly where the cable runs, ' +
          "not its surveyed position on the seabed.</p>" +
          '<div class="meta">Source: TeleGeography submarine cable map</div>',
          { maxWidth: 300 }
        );
        cablesGroup.addLayer(line);
      }
    }
    counts.cables = raw.cables.length;
    totals.cables = raw.cables.length;
    reportCounts();
  }

  // A country-scoped measure gets a country-scoped rendering: the shape is
  // tinted, and nothing is drawn at a point. IODA reports at national
  // resolution and a pin on a capital would claim a precision it does not have.
  function updateCountryOutageTint() {
    countriesLayer.eachLayer((layer) => {
      const key = countryKeyOfProps(layer.feature?.properties || {});
      const el = layer.getElement?.();
      if (el) el.classList.toggle("country-offline", !!(key && raw.outages[key]));
    });
  }

  function renderAll() {
    // One placement pass for the whole map, at the end. Without the
    // suspension each of the eight renderers below would settle on its own,
    // against input where the other seven layers still held the *previous*
    // viewport's positions -- eight passes per pan, most of them wrong.
    settleSuspended += 1;
    try {
      renderAllLayers();
    } finally {
      settleSuspended -= 1;
    }
    settlePlacement();
  }

  function renderAllLayers() {
    renderMarkerLayer("events");
    // Bounds-filtered like every other marker layer, so it has to re-render on
    // pan/zoom -- its own data only arrives every six hours, and without this
    // it would render once and then be empty everywhere the map moved to.
    renderMarkerLayer("conflictHistory");
    renderMarkerLayer("gdelt");
    renderMarkerLayer("officials");
    // Same reasoning as conflictHistory above: bounds-filtered, and its own
    // poll is five minutes apart (the volcano half of it, a whole week), so
    // without a pan/zoom re-render the layer sits empty everywhere the map
    // moved to since the last poll.
    renderMarkerLayer("hazards");
    renderMarkerLayer("airports");
    renderMarkerLayer("darkVessels");
    renderMarkerLayer("cableLandings");
    renderMarkerLayer("launches");
    renderMarkerLayer("osmInfra");
    renderMarkerLayer("ais");
    renderMarkerLayer("adsb");
    renderFirms();
    renderCities();
    renderInfra();
    // jamming/satellites used to only re-render when new data arrived (via
    // applyData), never on pan/zoom -- since both bounds-filter to the
    // current viewport, panning away from wherever the map happened to be
    // at the last poll left them empty until the next one (up to 30min for
    // jamming), which read as "not loading" even though the data was there.
    renderJamming();
    renderSatellites();
    updateCountryWarFlare();
  }

  // ---------- wind arrows: fetched for whatever's currently in view ----------

  let firstWindLoadDone = false;
  async function refreshWindArrows() {
    // Backgrounded tab: skip, visibilitychange below catches up on return --
    // except the very first call (map just mounted), so a map opened in a
    // background tab still gets its initial wind data instead of sitting
    // empty until the tab is focused.
    if (document.hidden && firstWindLoadDone) return;
    firstWindLoadDone = true;
    const b = map.getBounds();
    const url = `/api/wind?south=${b.getSouth()}&west=${b.getWest()}&north=${b.getNorth()}&east=${b.getEast()}`;
    try {
      const data = await fetchJson(url);
      windFlowLayer.setData(data);
      callbacks.onWindStatusChange?.({ ok: true });
    } catch (err) {
      console.warn("Failed to fetch windArrows:", err);
      // Surfaced in WeatherSection.jsx instead of only a console warning --
      // Open-Meteo's free tier has a hard *daily* cap, so a 502 here often
      // means "unavailable until tomorrow," not a transient blip; the user
      // should be able to tell that from the UI, not just silence.
      callbacks.onWindStatusChange?.({ ok: false, message: String(err.message || err) });
    }
  }

  // ---------- precipitation radar: RainViewer frame timestamp ----------
  // RainViewer has no fixed tile URL -- each radar pass gets a new frame
  // path, published via this small JSON endpoint, and a fresh pass lands
  // roughly every 10min. precipLayer is created in layers.js with an empty
  // URL; this is what fills it in, both on startup and periodically so the
  // radar doesn't go stale if the map just sits open.
  async function refreshPrecipRadar() {
    try {
      const data = await fetchJson("https://api.rainviewer.com/public/weather-maps.json");
      const frames = data?.radar?.past;
      const latest = frames?.[frames.length - 1];
      if (!latest?.path) return;
      weatherLayers.precip.setUrl(`https://tilecache.rainviewer.com${latest.path}/256/{z}/{x}/{y}/2/1_1.png`);
    } catch (err) {
      console.warn("Failed to fetch precip radar frame:", err);
    }
  }

  // ---------- region flyTo ----------

  function flyToRegion(key, entry) {
    currentRegionKey = key;
    regionFlightActive = true;
    clearTimeout(regionFlightTimer);
    if (entry && entry.bounds) {
      const [south, west, north, east] = entry.bounds;
      map.flyToBounds(L.latLngBounds([south, west], [north, east]), { padding: [40, 40], duration: REGION_FLY_DURATION });
    } else {
      map.flyTo([20, 15], 3, { duration: REGION_FLY_DURATION });
    }
    regionFlightTimer = setTimeout(() => {
      regionFlightActive = false;
    }, REGION_FLY_DURATION * 1000 + 250);

    // Cities stay off until the user opts into a scope -- picking any conflict
    // zone from the Region bar counts as one, and going back to "World" drops
    // the zone's own highlight.
    //
    // A hand-picked country selection survives all of this. It used to be
    // cleared here, which meant a comparison a reader had built up could be
    // wiped out by a stray region click; selections now go away only when the
    // reader says so (clicking the country again, or Clear -- see
    // clearCountrySelection).
    activeConflictZoneBounds = entry && entry.bounds
      ? { south: entry.bounds[0], west: entry.bounds[1], north: entry.bounds[2], east: entry.bounds[3] }
      : null;
    citiesEnabled = key !== "world" || selectedCountryKeys.size > 0;
    renderCities();
    updateCountryHighlights();
  }

  function flyTo(lat, lon, minZoom) {
    map.flyTo([lat, lon], Math.max(map.getZoom(), minZoom), { duration: 1.2 });
  }

  // ---------- event wiring ----------

  map.on("moveend", () => {
    // A region is still selected but this moveend wasn't from our own
    // flyTo/flyToBounds -- the user panned/zoomed away on their own, so the
    // region's payload-scoped data no longer matches what's on screen (that
    // causes stale markers and drifting-looking country shapes). Tell React
    // to snap back to unscoped global data, same as clicking "World".
    if (!regionFlightActive && currentRegionKey) {
      currentRegionKey = null;
      callbacks.onRegionAutoReset?.();
    }
    renderAll();
    callbacks.onBoundsChange?.(boundsToPlainObject(map.getBounds()));
    clearTimeout(moveEndWindTimer);
    moveEndWindTimer = setTimeout(refreshWindArrows, 500); // debounced: don't hammer Open-Meteo mid-drag
  });

  // Country info card is anchored to a screen pixel, not a DOM position
  // Leaflet manages itself (see CountryInfoCard.jsx) -- "move"/"zoom" fire
  // continuously during pan/zoom animation (unlike moveend), so this is what
  // keeps the card glued to its country instead of drifting off during a
  // drag or zoom gesture.
  map.on("move zoom", () => {
    if (focusedCountryLayer) callbacks.onCountryPointChange?.(countryAnchorPoint(focusedCountryLayer));
  });

  // No separate zoomend handler: Leaflet always fires moveend right after
  // zoomend for any zoom change (button, scroll, or pinch), so a dedicated
  // zoomend listener re-running renderAdsbLayer/renderCities/renderFirms
  // here just duplicated the exact same work moveend's renderAll() already
  // does a moment later -- every zoom action was rendering those three
  // layers twice.

  // Click empty map space to deselect the currently-selected aircraft/ship
  // trail. This only fires for clicks that didn't land on a marker/sprite --
  // ordinary Leaflet markers already stopPropagation() on their own click
  // (see buildMarker's bindPopup/tooltip usage above); Pixi sprite taps
  // don't share that DOM propagation chain (they run through Pixi's own
  // internal event queue on the same canvas), so entityWebglLayer sets a
  // one-shot flag on tap that's checked and cleared here instead.
  map.on("click", (e) => {
    if (entityWebglLayer.consumeSuppressedClick()) return;
    // A click that landed on a vector layer (the FIRMS/jamming canvas click
    // targets are L.Path, which bubbles to the map by default, unlike
    // L.Marker) belongs to that layer's own popup, not to the country under
    // it. Leaflet sets sourceTarget to whichever layer originated the event.
    if (e.sourceTarget && e.sourceTarget !== map) return;

    // Country selection is a *fallback* hit-test rather than a handler on the
    // shapes themselves -- see countryHitTest.js. Everything above this point
    // has already had its chance to claim the click.
    if (countriesVisible) {
      const entry = findCountryAt(countryIndex, e.latlng.lat, e.latlng.lng);
      if (entry) {
        // Ctrl (Windows/Linux), Cmd (macOS) or Shift adds to the selection
        // instead of replacing it -- the same modifier every file manager and
        // map editor uses for multi-select, so it needs no instruction. Read
        // from originalEvent because Leaflet's own event object carries no
        // modifier state.
        const native = e.originalEvent;
        const additive = !!(native && (native.ctrlKey || native.metaKey || native.shiftKey));
        selectCountryEntry(entry, additive);
        return;
      }
    }

    if (selectedIcao) {
      selectedIcao = null;
      aircraftTrails.clear();
      renderAdsbLayer();
    }
    if (selectedMmsi) {
      selectedMmsi = null;
      shipTrails.clear();
      renderMarkerLayer("ais");
    }
  });

  // Hover highlight, same fallback path as the click above. Throttled to one
  // hit-test per animation frame: mousemove fires far faster than the map can
  // repaint, and each test is a bbox scan plus one or two ray-casts.
  let hoverFrame = null;
  let pendingHoverLatLng = null;
  map.on("mousemove", (e) => {
    if (e.sourceTarget && e.sourceTarget !== map) return;
    pendingHoverLatLng = e.latlng;
    if (hoverFrame != null) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = null;
      const latlng = pendingHoverLatLng;
      if (!latlng || !countriesVisible) {
        setHoveredCountry(null);
        return;
      }
      setHoveredCountry(findCountryAt(countryIndex, latlng.lat, latlng.lng)?.key ?? null);
    });
  });
  // Leaving the map entirely never fires a mousemove that misses every
  // country, so the highlight would otherwise stay stuck on whatever was last
  // under the pointer.
  map.on("mouseout", () => setHoveredCountry(null));

  // Sync every layer's actual add/remove state to the caller's initial
  // defaults (see DEFAULT_LAYER_VISIBILITY in App.jsx) right after
  // construction -- most layers default to .addTo(map) individually in
  // layers.js, so a layer whose default is *false* needs removing once,
  // here, before the map ever paints (no flash-then-hide). Must run after
  // every render function/const it might call into (setLayerVisible("satellites",
  // true) calls renderSatellites(), which reads `counts`/`zoomNotes` --
  // running this any earlier hits their temporal-dead-zone before those
  // `const`s are initialized).
  if (initial.layerVisibility) {
    for (const [key, visible] of Object.entries(initial.layerVisibility)) {
      setLayerVisible(key, visible);
    }
  }

  refreshWindArrows();
  windRefreshTimer = setInterval(refreshWindArrows, 5 * 60 * 1000); // catches slow wind changes even if the view sits still
  refreshPrecipRadar();
  precipRefreshTimer = setInterval(refreshPrecipRadar, 10 * 60 * 1000); // matches RainViewer's own pass cadence
  function onVisibilityChange() {
    if (!document.hidden) refreshWindArrows(); // catch up immediately instead of waiting out the rest of the 5min interval
  }
  document.addEventListener("visibilitychange", onVisibilityChange);
  callbacks.onBoundsChange?.(boundsToPlainObject(map.getBounds()));

  // ---------- public API (consumed by useLeafletMap.js) ----------

  return {
    map,

    applyData(key, data) {
      raw[key] = data;
      // Invalidates nearbyEventsFor's cache -- these are the only two
      // sources it reads, so nothing else needs to bust it.
      if (key === "events" || key === "gdelt") eventsDataVersion += 1;
      // Both feeds name the news ids they have absorbed, so the set has to be
      // rebuilt whenever either lands -- and the news layer redrawn with it,
      // or a suppressed pin lingers until the next pan. See passesNewsFilter.
      if (key === "events" || key === "officials") {
        rebuildMergedNewsIds();
        renderMarkerLayer("gdelt");
      }
      if (key === "countries") renderCountries();
      else if (key === "firms") renderFirms();
      else if (key === "cities") renderCities();
      else if (key === "infra") renderInfra();
      else if (key === "pipelines") renderPipelines();
    else if (key === "cables") renderCables();
    // Country-keyed, like conflictStats: read straight out of `raw` by the
    // country card and by the outage tint, with no marker layer of its own.
    else if (key === "outages") updateCountryOutageTint();
      else if (key === "jamming") renderJamming();
      else if (key === "satellites") renderSatellites();
      // Neither of these is a point array with a layer of its own, so both
      // would otherwise fall through to renderMarkerLayer and blow up on a
      // missing group/marker map. conflictStats is a country->monthly-series
      // dict (hdx_conflict_stats.py) and escalation is a ranked region list
      // (escalation.py); both are read straight out of `raw` by popups.js
      // when a country card is built.
      else if (key === "conflictStats" || key === "escalation" || key === "conflictDistricts"
             || key === "humanitarian") {
        /* reference data read on demand by popups.js -- no marker layer */
      }
      else if (key === "conflictHistory") renderMarkerLayer("conflictHistory");
      else renderMarkerLayer(key);
      if (key === "events") updateCountryWarFlare();
      // An open country card is built from `raw` at the moment it opens, so
      // without this it would keep showing the counts that were true when it
      // was clicked -- indefinitely, since the card outlives pans and zooms
      // now. See refreshFocusedCountryCard for which feeds qualify.
      if (COUNTRY_CARD_FEEDS.has(key)) refreshFocusedCountryCard();
    },

    flyToRegion,
    flyTo,

    setLayerVisible,

    setInfraFilter(text) {
      infraNameFilter = text || "";
      renderInfra();
    },

    setEventFilter(next) {
      eventFilter = { ...eventFilter, ...(next || {}) };
      renderMarkerLayer("events");
    },

    // Closes the info card without touching the selection. The country stays
    // highlighted, which is the whole point of a selection that outlives a
    // glance: shutting a card is not the same gesture as deselecting.
    closeCountryCard() {
      focusCountry(null);
    },

    /** Open the card on an already-selected country (the selection chips). */
    focusCountry(key) {
      if (!selectedCountryKeys.has(key)) return;
      focusCountry(key);
    },

    /** Drop one country from the selection. */
    deselectCountry(key) {
      if (!selectedCountryKeys.delete(key)) return;
      citiesEnabled = selectedCountryKeys.size > 0 || !!activeConflictZoneBounds;
      renderCities();
      if (focusedCountryKey === key) focusCountry([...selectedCountryKeys].pop() ?? null);
      else updateCountryHighlights();
      reportCountrySelection();
    },

    /** Drop the whole selection -- the "Clear" the highlight waits for. */
    clearCountrySelection() {
      if (!selectedCountryKeys.size) return;
      selectedCountryKeys.clear();
      citiesEnabled = !!activeConflictZoneBounds;
      renderCities();
      focusCountry(null);
      reportCountrySelection();
    },

    setTheme(theme) {
      baseLayer.setUrl(basemapUrlFor(theme));
    },

    /**
     * Satellite imagery under the map, for a given day.
     *
     * @param {string|null} key   a GIBS_LAYERS key, or null to switch it off
     * @param {string} date       "YYYY-MM-DD" in UTC
     *
     * Called both when a reader picks a layer and whenever the replay scrubber
     * moves (see App.jsx), which is what makes scrubbing back three days change
     * the imagery along with everything else rather than leaving today's pass
     * sitting under a three-day-old conflict picture.
     */
    setImagery(key, date) {
      const wanted = key && GIBS_LAYERS[key] ? key : null;
      if (wanted === imageryKey && date === imageryDate) return;
      imageryKey = wanted;
      imageryDate = date || null;
      if (!imageryKey || !imageryDate) {
        map.removeLayer(imageryLayer);
        return;
      }
      const layer = GIBS_LAYERS[imageryKey];
      // Each GIBS product has its own deepest zoom, and asking past it returns
      // an error *image* rather than a 404 -- so the cap has to move with the
      // layer, not be set once at construction.
      imageryLayer.options.maxNativeZoom = layer.maxNativeZoom;
      imageryLayer.setUrl(gibsUrlFor(imageryKey, imageryDate));
      if (!map.hasLayer(imageryLayer)) map.addLayer(imageryLayer);
    },

    // Admin Mode's icon settings. The theme itself lives in a module (see
    // map/iconTheme.js) because decorators read it directly; this entry point
    // exists so the change is followed by the repaint that makes it visible --
    // nothing else in the pipeline watches for a palette change.
    setIconTheme(next) {
      setIconTheme(next);
      renderAll();
      renderCountries();
    },

    // Per-layer zoom gates from Admin Mode: { [layerKey]: minZoom|null }.
    // Applied as an override table rather than by mutating the shipped
    // constants, so "reset" is dropping the entry rather than remembering what
    // the original number was.
    setLayerZoomOverrides(next) {
      layerZoomOverrides = next || {};
      renderAll();
    },

    invalidateSize() {
      map.invalidateSize();
    },

    destroy() {
      clearInterval(windRefreshTimer);
      clearInterval(precipRefreshTimer);
      clearTimeout(moveEndWindTimer);
      clearTimeout(regionFlightTimer);
      if (hoverFrame != null) cancelAnimationFrame(hoverFrame);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      // Aborts any pan/zoom animation still in flight. Leaflet's own animation
      // frame keeps running after remove() otherwise, and then reads panes that
      // remove() has already deleted -- the "Cannot read properties of null
      // (reading 'containerPointToLayerPoint')" that shows up on teardown.
      map.stop();
      map.remove();
    },
  };
}
