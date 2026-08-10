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
import {
  passesEventFilter, DEFAULT_EVENT_FILTER, ageHoursFromDateAdded, NEWS_WINDOW_HOURS,
  confidenceDimmed, positionUncertain, uncertaintyRadiusMetres, verdictBucket,
  severityBand, severityColor,
} from "./severity";
import {
  filterVessels, filterAircraft, DEFAULT_VESSEL_FILTER, DEFAULT_AIRCRAFT_FILTER,
} from "../utils/entityFilter";
import {
  createBaseLayer,
  basemapUrlFor,
  createWeatherLayers,
  createFirmsLayers,
  createJammingLayers,
  FIRMS_HEAT_OPACITY,
  JAMMING_HEAT_OPACITY,
  createJammingPingGroup,
  createCablesGroup,
  createRailwaysGroup,
  createLaneDensityLayers,
  LANE_DENSITY_HEAT_OPACITY,
  createShippingLanesGroup,
  createImageryLayer,
  gibsUrlFor,
  GIBS_LAYERS,
  createEntityClusterGroups,
  createCountriesLayer,
  createUncertaintyLayer,
  createCityZoneLayer,
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
  decorateSatElement,
  satElementStyle,
  SAT_ELEMENT_LAYERS,
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
  withAircraftFlag,
  isSanctioned,
  withSanctionRing,
  AIRCRAFT_FLAG_STYLE,
  decorateAirport,
  airportIconSize,
  decorateDarkVessel,
  darkVesselIconSize,
  reachContourColor,
  decorateCableLanding,
  cableLandingIconSize,
  cableRouteColor,
  railwayLineColor,
  railwayLineBaseWeight,
  railwayLineDash,
  railwayOsmClass,
  railwayIsElectrified,
  decorateRailwayPoint,
  railwayPointIconSize,
  decorateRailLive,
  railLiveIconSize,
  decorateRailStation,
  railStationIconSize,
  shippingLaneColor,
  laneDensityColor,
  laneDensityIntensity,
  decorateLaunch,
  launchIconSize,
  decorateOsmInfra,
  osmInfraIconSize,
  decorateOutage,
  outageIconSize,
  decorateOutageRegion,
  outageRegionIconSize,
  decorateGfwGap,
  gfwGapIconSize,
  decorateGfwDetection,
  gfwDetectionIconSize,
  decorateCzib,
  czibIconSize,
  decorateFlood,
  floodIconSize,
  decoratePort,
  portIconSize,
  decorateDam,
  damIconSize,
  decorateDeflock,
  deflockIconSize,
  setIconDetail,
  detailSize,
  applyCollapsedFallback,
  TOKEN_FOR,
  satellitePassesPopupHtml,
} from "./decorators";
import {
  setIconTheme, themedStyle, tokenZoom, tokenZoomMax, layerHasTokenZoom, layerHasTokenZoomMax, layerOpacity, stackZIndex, scaledSize, scaledWeight, layerScale,
} from "./iconTheme";
import { placeAll } from "./declutter";
import { attachCursor } from "./cursor";
import {
  collapseByProximity, collapseByKey, collapseHeadsByProximity, officialsKey, COLLAPSE_MAX_ZOOM,
} from "./collapse";
import { buildCityZoneIndex } from "./cityZones";
import {
  AIRFIELD_MATCH_KM, DAM_MATCH_KM, buildTwinIndex, buildAbsorbedArticles,
  normalizeArticleUrl,
} from "./crossSource";
import { resolveScene, drawZoomFor, shippedDrawZoom, SCENE_APPLY_KEYS, LAYER_MANIFEST } from "./scene";
import { reachLineEnds, reachContourRings, reachOnScreen } from "./reachGeometry";
import { profileViewport } from "./viewportProfile";
import { buildCountryIndex, findCountryAt, representativePointOf } from "./countryHitTest";
import { createBorderEditor } from "./borderEdit";
import { countryFingerprints } from "../settings/borderOverrides";
import {
  countryCardSections, waterCardSections, subdivisionCardSections, districtCardSections,
  cityPopupHtml, normalizeCountryName,
} from "./popups";
import { buildEventDetailHtml } from "./eventDetail";
import { buildChoropleth } from "./choropleth";
import {
  createDistrictOutlineLayer, indexDistrictCounts,
  buildDistrictIndex, findDistrictAt,
} from "./districts";
import {
  createSubdivisionsLayer, buildSubdivisionIndex, findSubdivisionAt,
  subdivisionKeyOf,
} from "./subdivisions";
import { createWaterLayer, syncWater, buildWaterIndex, findWaterAt } from "./water";
import { updateTrails, renderTrailLayer, seedTrailFromTrack } from "./trails";
import { syncLayerMarkers } from "./syncLayerMarkers";
import { createEntityWebglLayer } from "./webglLayer";
import { createPropagationTracker, satrecFromElements, propagateEci } from "./satPropagate";
import { footprintRadiusKm, groundTrackSegments } from "./groundTrack";
import { esc, fmtNumber, fmtFrp, fmtConfidence, fmtFirmsDateTime, haversineKm } from "../utils/format";
import {
  nearestLon, unwrapPath, boundsContainsPoint,
  worldCopyOffsets, worldCopyDraws, worldCopyKey, worldCopyPlacer, shiftPathLon,
} from "../utils/geo";
import { createGenerationGuard } from "../utils/fetchGeneration";
import { fetchJson, vesselDetailUrl, portCallsUrl, aircraftDetailUrl } from "../api";

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
// below its own gate and shows its ...ZoomNote, so world zoom stays clean by
// construction rather than by grouping markers into bubbles.
//
// The gates themselves used to live here, as a block of named constants plus a
// MARKER_LAYER_MIN_ZOOM lookup. They now live in map/scene.js, together with
// the arguments that produced each one and with the *fetch* gate that has to
// agree with them -- one entry per layer instead of a draw number here, a fetch
// number in useOsintData.js and a third copy in settings/defaults.js. Read
// through minZoomFor below, which is the only thing in this file that knows a
// gate is a number at all.
//
// Two constants used to be exported from here for useOsintData.js to import,
// because osmInfra and gfwDetections were the only layers whose gate moved the
// fetch as well as the drawing. Every layer's does now, and both sides read
// scene.js directly, so there is nothing left to keep in step across a module
// boundary.

// Raised from 60/90 when trails started being seeded from recorded history
// (see seedTrailFromTrack). These are one budget shared by two producers: the
// server track seeds the array and the live poll appends to it, and
// updateTrails trims from the front once over the cap. A larger seed than the
// cap would therefore be eaten one point per poll -- the recorded half would
// visibly erode as the tab stayed open. So the cap is also what /api/track is
// asked for, and the two can never disagree.
//
// Only ever one selected ship and one selected aircraft, so this is a few
// hundred short polylines at most -- far below what the FIRMS canvas layer
// already draws.
const SHIP_TRAIL_MAX_POINTS = 300;
const AIRCRAFT_TRAIL_MAX_POINTS = 400;
// Satellites poll every 10s (see useOsintData.js's POLL_CONFIG) -- 36 points
// is a several-minute trailing arc, same "grows from app-open" cold start as
// ship/aircraft trails.
const SATELLITE_TRAIL_MAX_POINTS = 36;
// Tankers poll on the same cadence as the rest of AIS -- same "several
// polls back" length as ship trails, not satellites' longer arc.
const TANKER_TRAIL_MAX_POINTS = 60;

// Task 24: client-propagated satellite layers -- see map/satPropagate.js and
// backend/sources/satellites.py's ELEMENT_LAYER_GROUPS/cadence_seconds. This
// is the frontend's own copy of that backend cadence classification: there
// is no shared module between a Python process and a browser bundle, the
// same reason backend/app.py's _matches_callsign_query keeps its own copy of
// the client's matchQuery in step by hand rather than importing it.
//
// The cadence gates only tick() (a real SGP4 pass, see satPropagate.js) --
// SAT_ELEMENT_REDRAW_MS below is how often the *drawn* position is
// recomputed by interpolating between the last two fixes, which is cheap
// enough to do far more often than SGP4 itself.
const SAT_ELEMENT_SMALL_CADENCE_MS = 10_000;
const SAT_ELEMENT_LARGE_CADENCE_MS = 60_000;
const SAT_ELEMENT_LARGE_LAYERS = new Set(["satImaging", "satGeo", "satStarlink", "satOneweb"]);
function satElementCadenceMs(layerKey) {
  return SAT_ELEMENT_LARGE_LAYERS.has(layerKey) ? SAT_ELEMENT_LARGE_CADENCE_MS : SAT_ELEMENT_SMALL_CADENCE_MS;
}
// Redrawn (interpolated + repositioned/re-styled) this often, regardless of
// cadence -- frequent enough to read as smooth motion, coarse enough that
// even the several-thousand-object Starlink/OneWeb layers cost only a
// handful of milliseconds per tick rather than a per-frame cost.
const SAT_ELEMENT_REDRAW_MS = 2000;

// Which CelesTrak groups (see backend/sources/satellites.py's
// ELEMENT_LAYER_GROUPS) sit behind each control-panel toggle -- the same
// string /api/satellites/elements?groups= expects.
const SAT_ELEMENT_CELESTRAK_GROUP = {
  satNavigation: "navigation", satWeather: "weather", satImaging: "imaging",
  satScience: "science", satGeo: "geo", satStarlink: "starlink", satOneweb: "oneweb",
};

// satNavigation/satWeather/satImaging are on by default, so their element
// sets are fetched by useOsintData.js's own POLL_CONFIG (see that file) --
// the recipe's touch point 2, the same machinery every other default-on
// source gets (fetch-coverage bookkeeping, the boot screen, a tab-refocus
// catch-up). The other four are off by default, and nothing has been
// fetched for one until a reader actually reaches for it -- that fetch
// happens here in the controller instead, on the layer's own first
// toggle-on, the same precedent waterLakes' fetch-on-first-toggle already
// sets (see setLayerVisible's "waterLakes" branch below).
const SAT_ELEMENT_ON_DEMAND_LAYERS = new Set(["satScience", "satGeo", "satStarlink", "satOneweb"]);

// The three on-by-default groups are zoom-gated at THEATRE (see
// map/scene.js) -- these are the only satX keys that ever need a
// zoomNotes entry (the panel's "Zoom in to show X" hint). The four
// off-by-default groups stay ungated, so their zoomNotes would always read
// false; not worth reporting.
const SAT_ELEMENT_ZOOM_NOTE_KEYS = new Set(["satNavigation", "satWeather", "satImaging"]);

// The whole world, once: the full Web Mercator extent. The latitude limit is
// Mercator's own -- the projection runs to infinity at the poles and 85.051129 is
// where it closes on a square world, which is what makes the pixel world as tall as
// it is wide at every zoom.
const WORLD_SOUTH = -85.051129;
const WORLD_NORTH = 85.051129;

// The shipped floor. The *effective* floor is this or the zoom at which the world
// fills the viewport, whichever is higher -- see applyWorldFence.
const BASE_MIN_ZOOM = 2;

// How far past the viewport's edges a repeated point layer still draws, in degrees
// of longitude. A ceiling on the proportional margin rather than a replacement for
// it -- see worldCopyPlacements, which explains why a percentage alone stops making
// sense once the viewport is wider than the world.
const WORLD_COPY_LON_PAD_MAX_DEG = 15;

const ID_FIELD = {
  events: "id", gdelt: "event_id", ais: "mmsi", adsb: "icao24", conflictHistory: "id",
  officials: "id", hazards: "id", airports: "id", darkVessels: "id", cableLandings: "id",
  launches: "id", osmInfra: "id",
  gfwGaps: "id", gfwDetections: "id", czib: "id", floods: "id", ports: "id", dams: "id",
  deflock: "id",
  // Task 27: railwayPoints reuses osm_infra's own prefixed "osm:type/id" ids
  // (it reads the same raw items, just split into their own array -- see
  // applyData's own note on where that split happens). railLive's id is
  // digitraffic_rail's synthetic "departureDate:trainNumber" composite (see
  // backend/sources/digitraffic_rail.py's own note on why trainNumber alone
  // is not a stable identity). railStations' id is the station's own short
  // code (see digitraffic_rail.parse_station).
  railwayPoints: "id", railLive: "id", railStations: "id",
  // One pin per country, so the country code *is* the identity -- a country
  // whose score changes between polls has to update its existing marker rather
  // than be torn down and rebuilt under a new key.
  outagePoints: "country_code",
  // "country:key" (see rebuildOutageRegionPoints), because a bare region_code
  // is not unique across the whole feed the way a country code is -- IODA's
  // own entity code, the fallback for an unmatched region, isn't either.
  outageRegionPoints: "id",
};
const DECORATORS = {
  events: decorateEvent, ais: decorateAis, gdelt: decorateGdelt, adsb: decorateAdsb,
  conflictHistory: decorateHistoricalEvent, officials: decorateOfficials,
  hazards: decorateHazard, airports: decorateAirport, darkVessels: decorateDarkVessel,
  cableLandings: decorateCableLanding, launches: decorateLaunch,
  osmInfra: decorateOsmInfra, outagePoints: decorateOutage, outageRegionPoints: decorateOutageRegion,
  gfwGaps: decorateGfwGap, gfwDetections: decorateGfwDetection,
  czib: decorateCzib, floods: decorateFlood, ports: decoratePort, dams: decorateDam,
  deflock: decorateDeflock,
  railwayPoints: decorateRailwayPoint, railLive: decorateRailLive, railStations: decorateRailStation,
};
// The placement pass has to know how much room each icon needs before any of
// them are drawn, so the size formulas live in decorators.js and are read from
// both places rather than restated here.
const ICON_SIZE_FOR_GLYPH = {
  events: eventIconSize, gdelt: gdeltIconSize, conflictHistory: historicalIconSize,
  officials: officialsIconSize, hazards: hazardIconSize, airports: airportIconSize,
  darkVessels: darkVesselIconSize, cableLandings: cableLandingIconSize,
  launches: launchIconSize, osmInfra: osmInfraIconSize, outagePoints: outageIconSize,
  outageRegionPoints: outageRegionIconSize,
  gfwGaps: gfwGapIconSize, gfwDetections: gfwDetectionIconSize,
  czib: czibIconSize, floods: floodIconSize, ports: portIconSize, dams: damIconSize,
  deflock: deflockIconSize,
  railwayPoints: railwayPointIconSize, railLive: railLiveIconSize, railStations: railStationIconSize,
};
// The same sizes with the current level of detail applied, which is what the
// placement pass has to reserve: a dot needs a dot's worth of room, and routing
// every size through detailSize is what stops the two systems disagreeing if
// the detail boundary is ever moved off DECLUTTER_MIN_ZOOM.
const ICON_SIZE_FOR = Object.fromEntries(
  Object.entries(ICON_SIZE_FOR_GLYPH).map(([key, sizeOf]) => [
    key,
    (item, ...rest) => detailSize(sizeOf(item, ...rest)),
  ])
);
// The keys renderMarkerLayer draws directly, i.e. everything with a decorator
// except the two vehicle feeds, whose own renderers split one payload across
// three toggles each (see renderAisLayer/renderAdsbLayer). Read by
// setLayerVisible to know which renderer to catch up with when a layer is
// switched back on -- the renderers return immediately while their layer is
// off, so without the catch-up a re-shown layer would stay empty until the
// reader happened to pan.
const MARKER_LAYER_KEYS = new Set(
  Object.keys(DECORATORS).filter((key) => key !== "ais" && key !== "adsb")
);

// Every popup on the map is built through this.
//
// `maxHeight` is the load-bearing part and it was missing everywhere: without it
// a popup grows to whatever its content needs, so the long ones -- a fused
// conflict pin listing its coverage, a country-scale bulletin, a city -- ran off
// the top of the viewport with no way to reach what had overflowed. With it,
// Leaflet adds .leaflet-popup-scrolled to the content element, which is also
// what the stylesheet hangs the pinned title off (see .leaflet-popup-scrolled in
// style.css).
//
// A share of the viewport rather than a pixel number: a popup is anchored to a
// pin and opens upward from it, so a little under half the window is about as
// much as it can use before it is taller than the room above its own anchor.
//
// A function rather than two constants because Leaflet copies an options object
// once, when the popup is bound -- so a value captured at module load would be
// the height the tab happened to start at, for the rest of the session. Called
// per bind, and markers are rebuilt often enough that a resized window catches
// up on the next pan.
function popupOptions(maxWidth) {
  return { maxWidth, maxHeight: Math.round(window.innerHeight * 0.46) };
}

const REGION_FLY_DURATION = 1.2;

// Which incoming feeds are worth rebuilding an open country card for. See
// refreshFocusedCountryCard for why the fast-moving vehicle feeds are not here.
const COUNTRY_CARD_FEEDS = new Set([
  "events", "gdelt", "officials", "escalation", "conflictStats", "conflictDistricts",
  "outages", "humanitarian",
  // Three country-keyed feeds that draw no pin of their own: a cross-border
  // electricity flow is an edge between two countries rather than a place, and
  // a marketing-year balance sheet is a forecast about a whole state. Both are
  // read only by the country card and the choropleth.
  "energyFlows", "foodTrade", "foodPriceIndex",
  // Task 9's energy/military/transport sections read these four -- none of
  // them polls faster than 30 minutes (osmInfra) to 6 hours (dams, ports), so
  // none of the ais/adsb/firms throttle reasoning above applies. Without this,
  // a card opened before a gated feed's first fetch for this country landed
  // would keep showing its own "not loaded" coverage line indefinitely, since
  // nothing would tell it to look again.
  "osmInfra", "dams", "airports", "ports",
]);

// The water-card counterpart to COUNTRY_CARD_FEEDS above, same reasoning and
// same exclusion: an open water card is built from `raw` at the moment it was
// clicked, so without this it would keep showing the counts that were true
// then, indefinitely, since the card outlives pans and zooms. `ais` is left
// out on purpose, for the exact reason refreshFocusedCountryCard gives for
// excluding it from the country set -- it polls every 10-20 seconds, and
// re-rendering the traffic tally that often would fight anyone reading or
// selecting text in the card. The curated infrastructure gazetteers (cables,
// cableLandings, ports) are left out too: none of them refreshes more than
// about once a day, so there is nothing here for a mid-session poll to move.
const WATER_CARD_FEEDS = new Set(["events", "gdelt", "darkVessels", "gfwGaps"]);

// The admin-1/admin-2 card counterpart to COUNTRY_CARD_FEEDS/WATER_CARD_FEEDS
// above -- same reasoning: an open card is built from `raw` at the moment it
// was clicked, and without this it would keep showing what was true then. The
// district card's own conflict fold is excluded here on purpose: its record
// and trend come from `districtCounts`/`districtSeries`, which are refreshed
// by their own dedicated fetches (loadDistrictMonth, loadDistrictSeries) and
// call refreshFocusedDistrictCard directly rather than riding through
// applyData's per-key dispatch. "cities" is here for both -- GeoNames rarely
// moves mid-session, but a card opened before that boot fetch lands should
// not keep saying zero once it does.
// "outagesRegions" (Task 26) is on both: the district card reads it too, via
// its parent state (see popups.js's regionOutageFor and the districtStateByPcode
// join), so a card opened before that feed's first delivery lands should stop
// saying "no disruption" the moment it does, same as every other feed here.
const SUBDIVISION_CARD_FEEDS = new Set(["events", "cities", "osmInfra", "dams", "airports", "ports", "outagesRegions"]);
const DISTRICT_CARD_FEEDS = new Set(["cities", "osmInfra", "dams", "airports", "ports", "outagesRegions"]);

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
 * @param {object} callbacks - { onCountsChange, onZoomNotesChange, onBoundsChange, onZoomChange, onRegionAutoReset }
 */
export function createMapController(container, initial, callbacks) {
  // doubleClickZoom off: a double-click is two real `click` events before it is
  // a zoom, and every one of them runs the full selection path -- the sprite
  // hit-test in webglLayer.js, the district popup, the country hit-test below.
  // So zooming that way silently reselected whatever happened to be under the
  // cursor, twice, and read as the map clicking things on its own. The wheel,
  // the +/- control and the keyboard all zoom without carrying a click, so
  // nothing is lost by dropping the one gesture that cannot.
  const map = L.map(container, {
    // Deliberately off, and it used to be on.
    //
    // worldCopyJump waits for the centre to drift past +-180 and then setViews the
    // map back to the equivalent longitude in the primary copy, teleporting every
    // layer into view at once. That is a jump -- the map lurches sideways mid-pan.
    // It is also moot now: maxBounds below means the centre can never drift past
    // +-180 in the first place.
    worldCopyJump: false,
    // There is one world and the camera stays inside it.
    //
    // Leaflet's default is an endless east-west ribbon of identical basemaps, and
    // every attempt to make the *data* keep up with that ribbon costs more than the
    // ribbon is worth: each extra copy is another full set of markers, sprites,
    // polylines and heat points to build, place and tear down, for a view of the
    // same facts the reader has already got. Fencing the camera instead makes the
    // question disappear rather than answering it repeatedly.
    //
    // Paired with `noWrap` on every tile layer (see layers.js). The two must agree:
    // a fenced camera over repeating tiles wastes tile requests, and a free camera
    // over unrepeated tiles pans into blank space.
    //
    // maxBounds is deliberately NOT set here -- see applyWorldFence below. Setting it
    // at construction, while the initial zoom still shows a world narrower than the
    // pane, asks Leaflet to satisfy a bound it cannot: it then refuses *every* view
    // update, so the map freezes at its initial zoom and even an explicit setZoom is
    // a no-op. The fence has to go on after the floor guarantees the world covers
    // the pane, not before.
    maxBoundsViscosity: 1.0,
    minZoom: BASE_MIN_ZOOM,
    zoomControl: true,
    doubleClickZoom: false,
  }).setView([20, 15], 3);
  /**
   * Raise the zoom floor until the world fills the pane.
   *
   * maxBounds stops the camera leaving the world, but it cannot help when the world
   * is smaller than the window: at zoom 2 the whole earth is 1024px wide, so on a
   * 2240px pane there is no camera position that fills the view and the reader gets
   * the map letterboxed in void. Leaflet's answer to that is to centre it, which
   * means "restricted to the map" would still have shown a third of a screen of
   * nothing on each side.
   *
   * So the floor is whichever is higher: the shipped one, or the first zoom whose
   * world is at least as large as the pane. Measured on both axes because the pixel
   * world is square -- a tall narrow window is bounded by its height.
   *
   * The cost is real and worth naming: on a wide window the reader can no longer
   * zoom out to the whole world at once (a 2240px pane floors at zoom 4). That is
   * the direct trade for never seeing past the edge.
   */
  const WORLD_FENCE = L.latLngBounds([WORLD_SOUTH, -180], [WORLD_NORTH, 180]);

  /**
   * Raise the zoom floor until the world fills the pane, then fence the camera to it.
   *
   * The order is the whole point, and getting it wrong is what made an apparently
   * correct fence do nothing at all. maxBounds cannot be satisfied while the world is
   * narrower than the viewport -- at zoom 3 the earth is 2048px across and a 2240px
   * pane has no camera position that fills it -- and Leaflet's response to an
   * unsatisfiable bound is not to approximate it but to reject view updates outright.
   * With the fence installed first, minZoom read 4, the zoom control sat enabled, the
   * map stayed frozen at zoom 3, and `setZoom(5)` returned without doing anything.
   *
   * So: drop the fence, move the floor, pull the view up to it, put the fence back.
   * Each step is then always satisfiable.
   *
   * The floor is measured off the container rather than map.getSize(), which is a
   * cached value that a resize has not necessarily refreshed yet, and on both axes
   * because the pixel world is square -- a tall narrow window is bounded by height.
   *
   * One cost, worth naming plainly: on a wide window the whole world no longer fits
   * on screen at once (a 2240px pane floors at zoom 4). That is the direct price of
   * never being able to see past the edge.
   */
  function applyWorldFence() {
    const rect = map.getContainer().getBoundingClientRect();
    const longestSide = Math.max(rect.width, rect.height);
    if (!longestSide) return; // pane not laid out yet; the resize handler comes back
    // World width in pixels is 256 * 2^zoom, so this is the zoom that first covers
    // the pane. Rounded up, because the zoom below it leaves a gap by definition.
    const floor = Math.max(BASE_MIN_ZOOM, Math.ceil(Math.log2(longestSide / 256)));
    map.setMaxBounds(null);
    if (map.getMinZoom() !== floor) map.setMinZoom(floor);
    // Leaflet never re-clamps a zoom it has already accepted -- it limits new zoom
    // operations only -- so raising the floor does not move a view already below it.
    // `animate: false` is load-bearing, not a preference. An animated setZoom
    // returns immediately and finishes over the next ~250ms, so re-fencing on the
    // line below would put the unsatisfiable bound back while the zoom was still in
    // flight -- and Leaflet would then reject the rest of it, leaving the map exactly
    // as stuck as it was before this function existed. Synchronous, so the zoom is
    // already done by the time the fence returns.
    if (map.getZoom() < floor) map.setZoom(floor, { animate: false });
    map.setMaxBounds(WORLD_FENCE);
  }

  /**
   * A zoom that respects the floor, for the flight helpers below.
   *
   * Leaflet's flyTo does NOT clamp its target to minZoom -- unlike setView and
   * setZoom, it interpolates straight to whatever it was handed. So the World
   * region's flyTo(..., 3) parked the map at zoom 3 underneath a minZoom of 4 and
   * held it there: the floor was set, the zoom control was not even disabled, and
   * every measurement of "how many copies of the world are on screen" answered
   * three. Clamping here rather than trusting the flight is the fix.
   */
  function allowedZoom(zoom) {
    return Math.max(zoom, map.getMinZoom());
  }

  // Attached to the container rather than the map, because what it replaces is a
  // DOM cursor and what it reads is the DOM under the pointer. Returns its own
  // teardown, called from destroy() below.
  const detachCursor = attachCursor(container);
  const baseLayer = createBaseLayer(map, initial.theme);
  const weatherLayers = createWeatherLayers(map);
  const { firmsHeat, firmsPointsLayer, firmsLayer, firmsCanvasRenderer } = createFirmsLayers(map);
  const { jammingHeat, jammingPointsLayer, jammingLayer, jammingCanvasRenderer } = createJammingLayers(map);
  const jammingPingGroup = createJammingPingGroup();
  const jammingLayerWithPing = L.layerGroup([jammingLayer, jammingPingGroup]).addTo(map);
  // Task 20a: the AIS density wash. Added at construction like firms/jamming
  // above (AUTO disposition, see map/scene.js) -- applyLayerWishes below
  // corrects visibility to whatever the resolver's initial answer is before
  // the first paint, the same way it does for every other AUTO layer.
  const { laneDensityHeat, laneDensityPointsLayer, laneDensityLayer, laneDensityCanvasRenderer } =
    createLaneDensityLayers(map);
  laneDensityLayer.addTo(map);
  const { groups } = createEntityClusterGroups(map);
  // The area a conflict event could actually be in, drawn under its pin. Tied
  // to the events layer rather than toggled separately -- it is the same claim
  // as the pin, drawn honestly, not a layer a reader should have to find.
  const uncertaintyLayer = createUncertaintyLayer(map);
  const citiesGroup = createCitiesGroup(map);
  const cityZoneLayer = createCityZoneLayer(map);
  const infraGroup = createInfraGroup();
  const pipelinesGroup = createPipelinesGroup();
  const infraLayer = L.layerGroup([infraGroup, pipelinesGroup]).addTo(map);
  // Routes and landing points share one toggle, same as infra wraps its sites
  // and its pipelines: a cable and the place it comes ashore are one fact, and
  // being able to hide half of it helps nobody. NOT added to the map here --
  // the layer is off by default (see DEFAULT_LAYER_VISIBILITY in App.jsx).
  const cablesGroup = createCablesGroup();
  const cablesLayer = L.layerGroup([cablesGroup, groups.cableLandings]);
  // Coarse Natural Earth railway linework, now merged with an attributed OSM
  // overlay (Task 27) -- still one document, one polyline group. NOT added to
  // the map here -- off by default (MANUAL disposition, see map/scene.js),
  // toggled on from the panel.
  const railwaysGroup = createRailwaysGroup();
  // The station/halt/yard/border points ride the same toggle as the lines
  // above, same "one fact, one checkbox" treatment cablesGroup+cableLandings
  // just above already gets -- see LAYER_MANIFEST's own note on railwayPoints.
  const railwaysLayer = L.layerGroup([railwaysGroup, groups.railwayPoints]);
  // Task 27 fix: the Finnish station gazetteer rides railLive's own toggle,
  // same "one fact, one checkbox" wrapping railwaysLayer just above uses --
  // see LAYER_MANIFEST's own note on why the stations have no toggle of
  // their own.
  const railLiveLayer = L.layerGroup([groups.railLive, groups.railStations]);
  // Task 20b: the ten named corridors. Same treatment as railwaysGroup above
  // -- off by default (MANUAL, see map/scene.js), toggled on from the panel.
  const shippingLanesGroup = createShippingLanesGroup();
  // Seas, lakes and rivers. Also NOT added to the map here, for the same
  // reason -- MANUAL and off by default, see map/scene.js's `water` entry.
  const waterLayer = createWaterLayer(map);
  // NASA GIBS imagery. Not added to the map until a reader picks a layer.
  const imageryLayer = createImageryLayer(map);
  let imageryKey = null;   // null == off; otherwise a key of GIBS_LAYERS
  let imageryDate = null;  // "YYYY-MM-DD", UTC
  const satelliteGroup = createSatelliteGroup();
  // Task 24: the three client-propagated groups small enough to draw as DOM
  // markers (navigation/weather/science -- see decorators.js's
  // SAT_ELEMENT_LAYERS and createMapController's own DOM-vs-WebGL note
  // below). createSatelliteGroup is generic enough to reuse as-is: it
  // returns a bare L.layerGroup(), which is exactly what these need too.
  // satImaging/satGeo/satStarlink/satOneweb have no Leaflet layer of their
  // own -- they draw on entityWebglLayer's shared canvas instead.
  const satNavigationGroup = createSatelliteGroup();
  const satWeatherGroup = createSatelliteGroup();
  const satScienceGroup = createSatelliteGroup();
  const { shipTrailsLayer, aircraftTrailsLayer, satelliteTrailsLayer, tankerTrailsLayer, militaryTrailsLayer } =
    createTrailLayers(map);
  // Task 25: the ground track (one or more polylines, split at the
  // antimeridian -- see map/groundTrack.js's splitAtAntimeridian) and
  // visibility footprint (one L.circle) for whichever single satellite card
  // is currently open. Always on the map (an empty layer group costs
  // nothing) rather than added/removed per popup, so opening and closing a
  // card repeatedly does not churn map.addLayer/removeLayer calls -- only
  // its *contents* change, in drawSatelliteOverlay/clearSatelliteOverlay
  // below. At most one satellite's worth of geometry is ever in it: Leaflet
  // closes a previously-open popup when a new one opens (autoClose, the
  // default), and every popupclose handler below clears this layer, so a
  // second selection can never leave the first one's track behind.
  const satelliteOverlayLayer = L.layerGroup().addTo(map);
  satelliteGroup.addTo(map);
  // navigation/weather are on by default (see map/scene.js); science is
  // MANUAL/off by default, so it is not added here -- setLayerVisible adds
  // it the first time a reader switches it on, same as railwaysGroup/
  // waterLayer below.
  satNavigationGroup.addTo(map);
  satWeatherGroup.addTo(map);
  const windFlowLayer = createWindFlowLayer(map);
  // GPU-batched sprite rendering for AIS/ADS-B markers (see webglLayer.js) --
  // replaces the L.marker+L.divIcon path buildMarker/updateMarker below still
  // use for every other point layer. One shared Pixi canvas covers all five
  // ais/aisNavy/aisTanker/adsb/adsbMilitary buckets (added to the map once,
  // always on) since toggling five separate WebGL contexts on/off would cost
  // more than it saves -- setLayerVisible below calls entityWebglLayer's own
  // per-bucket setVisible instead of map.addLayer/removeLayer for these keys.
  const entityWebglLayer = createEntityWebglLayer(map);

  // Task 24: one shared SGP4 propagation tracker across all seven client-
  // propagated groups. CelesTrak's own groups never overlap (see
  // backend/sources/satellites.py's ELEMENT_LAYER_GROUPS), so a NORAD id is
  // never claimed by two of these layers at once, and one Map keyed on it
  // (see map/satPropagate.js's createPropagationTracker) is simpler than
  // seven separate ones with no risk of an id landing in the wrong one.
  const satElementTracker = createPropagationTracker();
  // Raw OMM element sets per layer, from /api/satellites/elements -- null
  // means "never fetched", [] means "fetched, empty". Held here rather than
  // in `raw` because these never arrive through applyData's generic
  // raw[key]=data assignment (see fetchSatElements below), the same reason
  // waterLakesFeatures/waterRiversFeatures are not in `raw` either.
  const satElements = {
    satNavigation: null, satWeather: null, satImaging: null,
    satScience: null, satGeo: null, satStarlink: null, satOneweb: null,
  };
  // Task 25: the same seven arrays as satElements above, indexed by NORAD id
  // for O(1) lookup rather than a .find() scan -- built once per fetch (see
  // fetchSatElements) and read every time a marker's popup opens, to merge
  // the static orbital fields (intl_designator/inclination/period/apogee/
  // perigee/epoch) satElementPositions' slim {norad_id,name,lat,lon,alt_km}
  // does not carry, and to hand the raw OMM to satrecFromElements for a
  // fresh ground-track/velocity propagation. A plain object of Maps, same
  // shape as satElements, rather than folding this into that array: the
  // array is what gets replaced wholesale on each (one-shot) fetch, and
  // rebuilding a Map alongside it in the same place keeps the two from ever
  // drifting out of step.
  const satElementIndex = {
    satNavigation: null, satWeather: null, satImaging: null,
    satScience: null, satGeo: null, satStarlink: null, satOneweb: null,
  };
  // Mirrors each layer's actual add/remove (or WebGL bucket) state, same
  // reason satellitesVisible does for the server-propagated pair below --
  // lets the tick/redraw loop skip work for a layer nobody can see rather
  // than just hiding the result. navigation/weather/imaging default on,
  // science/geo/starlink/oneweb off -- see map/scene.js's own entries; the
  // first real applyScene pass (moments after construction) confirms these.
  const satElementVisible = {
    satNavigation: true, satWeather: true, satImaging: true,
    satScience: false, satGeo: false, satStarlink: false, satOneweb: false,
  };
  // ms epoch of each layer's last real SGP4 pass (satElementTracker.tick) --
  // compared against satElementCadenceMs so a busy layer is not re-SGP4'd
  // more often than its cadence allows, while positionAt's cheap
  // interpolation still redraws on the faster SAT_ELEMENT_REDRAW_MS below.
  const satElementLastTick = {};

  // ---------- state that used to be top-level `let`s in app.js ----------
  // All internal to the controller: nothing outside the map needs to know
  // which aircraft is selected, so it never needs to be React state.
  const raw = {
    events: [], firms: [], ais: [], gdelt: [], adsb: [], officials: [],
    countries: { features: [] }, cities: [], infra: [], pipelines: [], jamming: [], satellites: [],
    // buildCountryIndex's own output, cached here (not just in the `countryIndex`
    // local below) so the water body card's bordering-country match
    // (map/popups.js's waterBorderingCountries) can reach it through the same
    // `raw` bag every other section builder reads, without a fourth parameter
    // threaded through waterCardSections just for this one lookup. Kept in step
    // wherever `countryIndex` itself is rebuilt.
    countryIndex: [],
    conflictStats: {},
    // Not live: UCDP's reviewed record (a month or more behind) and ACLED's
    // district-level monthly counts. Held here so country cards can show the
    // verified numbers next to the live picture, each labelled for what it is.
    conflictHistory: [], conflictDistricts: [], escalation: [],
    // The admin-2 drill-down's own archive state, mirrored here so
    // districtCardSections (map/popups.js) can read it the same way every
    // other section builder reads `raw` -- reassigned in step wherever the
    // controller's own districtCounts/districtCountsLoading/districtSeries
    // locals change (see loadDistrictMonth, ensureDistrictArchive,
    // loadDistrictSeries). `districtCounts` is a Map (pcode -> one month's
    // record); `districtSeries` is {ISO3: record[]}, this app's own slice of
    // the archive for whichever countries have been drilled into so far.
    districtCounts: new Map(), districtMonthLoading: false, districtSeries: {},
    // Task 25's overpass prediction, keyed "country:<key>"/"water:<id>" --
    // {status: "gated"|"loading"|"error"|"ready", data}, one entry per place
    // a reader has actually selected (see loadSatellitePasses below).
    // Country/water cards read their own key straight out of this bag the
    // same way districtSeries above is read, through popups.js's
    // countryCardSections/waterCardSections.
    satellitePasses: {},
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
    // IODA's country-keyed internet-outage scores. `outages` is the dict as
    // served, keyed by ISO2 and read straight out of here by the country card;
    // `outagePoints` is the marker array derived from it once the country
    // boundaries are in (see rebuildOutagePoints). Same two-keys-one-source
    // split as cables/cableLandings above.
    cables: [], cableLandings: [], outages: {}, outagePoints: [],
    // Task 26's sub-national counterpart: `outagesRegions` is the
    // {ISO2: {code: record}} dict as served, read straight out of here by the
    // state/district cards and the state-target choropleth;
    // `outageRegionPoints` is the badge array derived from it once the
    // relevant admin-1 boundaries are in (see rebuildOutageRegionPoints).
    outagesRegions: {}, outageRegionPoints: [],
    // Country-keyed humanitarian aggregates (ISO3), read by the country card
    // only -- see backend/sources/humanitarian.py for why none of it is drawn.
    humanitarian: {},
    // Recorded traffic per airfield, keyed by the OurAirports ident the
    // airports layer already carries. Derived from this app's own ADS-B history
    // (see backend/sources/airfield_activity.py) rather than fetched, and
    // attached to existing pins rather than drawn as a layer.
    airfieldActivity: {},
    // Global Fishing Watch's two published maritime layers. Kept apart from
    // darkVessels above on purpose: that array is this app's inference from its
    // own three-day AIS history, these are another organisation's findings
    // arriving five or more days late, and the two can never describe the same
    // event. Merging them would manufacture a corroboration that does not exist.
    gfwGaps: [], gfwDetections: [],
    // EASA airspace bulletins and GDACS flood alerts. Both country- or
    // region-precision, both drawn ringed.
    czib: [], floods: [],
    // Two published gazetteers: harbours (NGA) and barriers (Global Dam Watch).
    // Neither is a feed and nothing in either is current.
    ports: [], dams: [],
    // DeFlock ALPR camera locations (deflock.py) and the railway linework
    // (railways.py, now Natural Earth + an OpenStreetMap overlay -- Task 27).
    // Neither is a feed; the first is a worldwide point layer gated deep by
    // zoom, the second a whole-document set of lines.
    deflock: [], railways: { lines: [] },
    // Task 27: the station/halt/yard/border points, split out of osmInfra at
    // render time (see applyData's own note) -- and Digitraffic's live
    // Finnish train positions, a genuine feed with its own POLL_CONFIG row.
    // railStations (fix, post-review) is the Finnish gazetteer railLive
    // needs to mean anything -- Finland sits outside every conflict
    // theatre, so railwayPoints above can never cover it.
    railwayPoints: [], railLive: [], railStations: [],
    // Task 20b's corridors (a plain array, like pipelines) and Task 20a's
    // AIS density grid (a whole document -- {note, cells} -- like railways
    // above, so the popup/legend can state the endpoint's own `note` rather
    // than a copy of it kept in step by hand).
    shippingLanes: [], laneDensity: { note: "", cells: [] },
    // Marine polygons only (water_bodies.py) -- lakes and rivers are fetched on
    // demand, the first time their own sub-toggle is switched on, and held in
    // waterLakesFeatures/waterRiversFeatures below rather than here, since they
    // never arrive through applyData's generic raw[key]=data assignment.
    water: { type: "FeatureCollection", features: [] },
    // Country-keyed and drawn nowhere, same footing as `humanitarian` above.
    // energyFlows is keyed by ISO2 (Energy-Charts' own key), foodTrade by ISO3,
    // and foodPriceIndex is a single global document rather than a country map.
    energyFlows: {}, foodTrade: {}, foodPriceIndex: {},
    // Per-feed fetch coverage (useOsintData.js's recordCoverageRef), keyed by
    // the same raw[key] names above: whether each feed's poller last landed a
    // real fetch, was skipped because its zoom gate hasn't lifted, or errored
    // -- and, for a bbox-scoped feed, which bbox that fetch actually covered.
    // Read only by the country card's coverage section (buildCoverage,
    // map/popups.js), which is the reason it exists: `raw[key]` starting life
    // as `[]` cannot on its own tell "swept this country's bbox and found
    // nothing" apart from "never swept at all", and that is exactly the
    // conflation the coverage section exists to resolve.
    fetchCoverage: {},
  };
  // ais/aisNavy/aisTanker/adsb/adsbMilitary are no longer here -- their
  // markers live inside entityWebglLayer's own per-bucket entry maps now
  // (see webglLayer.js's updateEntities), not as L.marker instances.
  const markersByKey = {
    events: new Map(), gdelt: new Map(), cities: new Map(), infra: new Map(), satellites: new Map(),
    // Task 24: the three DOM-marker client-propagated groups. The four
    // WebGL ones (satImaging/satGeo/satStarlink/satOneweb) have no marker
    // Map of their own -- entityWebglLayer keeps their entries internally,
    // same as the AIS/ADS-B buckets.
    satNavigation: new Map(), satWeather: new Map(), satScience: new Map(),
    conflictHistory: new Map(), officials: new Map(), hazards: new Map(), airports: new Map(), darkVessels: new Map(),
    cableLandings: new Map(), launches: new Map(), osmInfra: new Map(),
    outagePoints: new Map(), outageRegionPoints: new Map(),
    gfwGaps: new Map(), gfwDetections: new Map(),
    czib: new Map(), floods: new Map(), ports: new Map(), dams: new Map(),
    deflock: new Map(),
    railwayPoints: new Map(), railLive: new Map(), railStations: new Map(),
  };
  // Keyed by event id, same as markersByKey.events, so a circle and its pin
  // are added and dropped by the same diff against the same visible set.
  const uncertaintyCircles = new Map();
  // Same layer, separate diff: a refined event has both a circle and a line,
  // and one Map keyed by event id cannot hold two shapes for one key.
  const refinementLines = new Map();
  // Dark-ship reachability geometry (Task 21): a group of shapes per record
  // (the went-dark -> resumed line, plus up to three contour polygons for an
  // ais_gap record), one Map per layer key for the same reason
  // markersByKey has one entry per key -- darkVessels and gfwGaps ids are not
  // guaranteed unique against each other, and even where they are, mixing two
  // layers' diffs into one Map would let toggling one layer off remove
  // shapes that belong to the other's still-visible records.
  const darkVesselReachShapes = new Map();
  const gfwGapReachShapes = new Map();
  const shipTrails = new Map();
  const aircraftTrails = new Map();
  const satelliteTrails = new Map();
  const tankerTrails = new Map();
  const militaryTrails = new Map();
  let selectedIcao = null;
  let selectedMmsi = null;
  // The ship popup selectShip opens, kept so loadVesselDetail can refresh its
  // content in place once /api/vessel/{mmsi} answers -- that fetch cannot
  // finish before the popup itself opens (see selectShip), so the popup is
  // first drawn without the Cargo/Port calls sections and then updated.
  let shipPopup = null;
  // Same reason, same shape, for the aircraft popup: decorateAdsb's vertical
  // trend (Task 22) needs the recorded track, which arrives after the popup
  // itself is already open -- see selectAircraft's onPoints callback below,
  // which reuses loadRecordedTrack's existing /api/track/adsb fetch.
  let aircraftPopup = null;
  // Task 25's overpass prediction has two homes, per review's Important 2/3:
  // country and water selections show it as a `satellitePasses` section
  // inside their own PlaceInfoCard (raw.satellitePasses + loadSatellitePasses
  // below feed popups.js's countryCardSections/waterCardSections, the same
  // fetch-then-store-in-raw-then-refresh-the-open-card shape
  // loadDistrictSeries already uses for the district trend). A marker click
  // -- the brief's third case, "a point" -- has no sidebar card to fold
  // into, so it is appended to the marker's own popup content instead (see
  // buildMarker's pointOverpassHtml/loadPointSatellitePasses/
  // pointSatellitePasses further down), not a second, competing popup.
  //
  // satellitePassesGuard guards the same out-of-order race loadVesselDetail/
  // loadPortTraffic do below, for all three triggers at once: a later
  // request for a *different* place/point landing before an earlier one
  // resolves must not let that earlier response overwrite fresher data --
  // see loadSatellitePasses and loadPointSatellitePasses, its two callers.
  const satellitePassesGuard = createGenerationGuard();
  // Keyed by mmsi/port_id, so a fetch that lands out of order (an ordinary
  // flaky-connection case, not a hypothetical one) never overwrites a
  // popup with data older than what it already shows -- see
  // utils/fetchGeneration.js for why stillSelected() alone can't cover
  // this: reselecting the *same* hull, or reopening the *same* port's
  // popup, before an earlier fetch for it resolves passes that check for
  // both requests. loadVesselDetail and loadPortTraffic below are the two
  // users.
  const vesselDetailGuard = createGenerationGuard();
  const portTrafficGuard = createGenerationGuard();
  // Same race, same fix, for the aircraft track fetch: reselecting the same
  // icao24 before an earlier /api/track/adsb request for it resolves must not
  // let that earlier response overwrite the popup with an older track.
  const aircraftTrackGuard = createGenerationGuard();
  // Same race again, for /api/aircraft/{icao24} (Task 23's Route section).
  // This is a *third* independent fetch racing to update the same aircraft
  // popup (alongside the live poll and the recorded-track fetch above), so
  // selectAircraft keeps its own last-known answer for each and rebuilds the
  // popup from both together -- see selectAircraft's `refresh` closure.
  const aircraftDetailGuard = createGenerationGuard();
  // port_id -> {status: "loading"|"ready"|"error", data} for the port card's
  // "recent arrivals and departures" fetch -- not a request cache (see
  // loadPortTraffic, which refetches on every open), just the hand-off
  // between it and decorateOptionsFor below: popups for the "ports" layer
  // are lazy (see buildMarker) and rebuilt from scratch on every open, so
  // this is where the in-flight/last-landed answer for whichever port is
  // currently open lives for that rebuild to read.
  const portDetailCache = new Map();
  let countryNameByIso2 = {};
  // The conflict zone currently flown to, or null for World -- read only by the
  // moveend handler, to tell a pan away from a zone from a pan within one.
  let currentRegionKey = null;
  let regionFlightActive = false;
  let regionFlightTimer = null;
  let windRefreshTimer = null;
  let moveEndWindTimer = null;
  let precipRefreshTimer = null;
  // Task 24: the tick/redraw loop for the seven client-propagated satellite
  // layers -- see tickAndRedrawSatElements and SAT_ELEMENT_REDRAW_MS.
  let satElementTickTimer = null;
  // Debounced re-check of the rivers sub-toggle's loaded extent -- see
  // maybeRefetchRivers below, wired to moveend next to moveEndWindTimer above.
  let moveEndRiversTimer = null;

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
  // Same mirror for "water": MANUAL and off by default (see its LAYER_MANIFEST
  // entry in scene.js), so unlike countriesVisible this starts false. Read by
  // the click/hover chain below so a hidden water layer never answers for a
  // click that landed on a sea nobody asked to see.
  let waterVisible = false;
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
  // The ceiling to the table above: { [layerKey]: maxZoom }, sparse. Not part of
  // the resolver's overrides, because the resolver has no ceiling to override --
  // this is applied in applyScene after it, as an additional limit.
  let layerZoomMaxOverrides = {};

  // Admin Mode's "ignore the scene resolver" switch. Session-scoped and
  // deliberately not persisted: an admin who forgot to switch it off would be
  // permanently looking at a different app from every reader, which is exactly
  // the failure the Admin Mode gate exists to avoid.
  let sceneBypass = false;

  // What the camera is looking at, and what the reader has clicked. Both feed
  // the resolver.
  let viewportProfile = null;
  let focus = null;

  // Collapsed groups the reader has opened in place. Cleared whenever the
  // subject changes -- see setFocus. Keyed by the group head's id, which
  // collapse.js guarantees is deterministic across pans (byRankThenId), and
  // that determinism is the whole reason expanding in place is stable rather
  // than a group that re-forms under a different head the moment the map moves.
  const expandedClusters = new Set();

  /**
   * Dim every layer except the one the reader clicked.
   *
   * Done entirely in CSS, which costs nothing: buildDivIcon puts the layer
   * class on the divIcon's `className`, while updateMarker's repaint test
   * compares `icon.options.html` -- so the class sits *outside* the string that
   * decides whether a marker's DOM is rebuilt. Emphasising a layer therefore
   * repaints no markers at all; it sets one attribute on the map container and
   * lets the stylesheet do the rest.
   *
   * Pixi sprites cannot take a CSS class, so the six WebGL buckets are dimmed
   * through their own per-bucket alpha instead. One property write per bucket,
   * no texture churn.
   */
  function applyEmphasis() {
    const key = focus?.kind === "layer" ? focus.key : null;
    const el = map.getContainer();
    if (key) el.setAttribute("data-emphasis", key);
    else el.removeAttribute("data-emphasis");
    for (const bucket of WEBGL_BUCKET_KEYS) {
      entityWebglLayer.setBucketAlpha?.(bucket, !key || bucket === key ? 1 : 0.28);
    }
  }

  // The resolved scene. Recomputed by applyScene() whenever any of its inputs
  // move -- zoom, profile, focus, the admin overrides, the bypass -- and read
  // by minZoomFor below and by every renderer through it. Seeded here so the
  // renderers that run during construction have an answer.
  let scene = resolveScene({ zoom: 3, overrides: layerZoomOverrides });

  /**
   * The zoom `key` starts drawing at, or null when it has no gate.
   *
   * Two things resolve here rather than in the caller. Admin Mode's per-layer
   * override still wins outright, which is what makes it a diagnostic rather
   * than a suggestion. Everything else -- the shipped gate, and any promotion
   * the camera or a focus has earned -- comes from the scene, so the four
   * renderers that used to compare against a bare constant (FIRMS, jamming,
   * cities, ADS-B) are now overridable like every other layer, which they
   * silently were not.
   */
  function minZoomFor(key) {
    return drawZoomFor(scene, key);
  }

  /**
   * The zoom one individual pin starts drawing at.
   *
   * Two gates, and the later of them wins: its layer's (`layerZ`, from
   * minZoomFor above) and its own kind's, if Admin Mode has given that kind of
   * pin one. So "nuclear plants from z8" thins the infrastructure layer without
   * touching the six other kinds in it, and the layer's gate stays the floor
   * every pin in it answers to -- see tokenZoom in iconTheme.js for why a pin
   * type is not allowed to undercut its layer.
   *
   * Null means no gate at all, which is what an ungated layer with no configured
   * pin types returns.
   */
  function pinZoomGate(key, item, layerZ) {
    const tokenOf = TOKEN_FOR[key];
    const own = tokenOf ? tokenZoom(tokenOf(item)) : null;
    if (own == null) return layerZ;
    return layerZ == null ? own : Math.max(layerZ, own);
  }

  /**
   * Whether this pin is past both of its gates.
   *
   * Callers guard with layerHasTokenZoom first: on a map where nobody has
   * configured a pin type -- which is every map until someone does -- resolving
   * a token for every hull, aircraft and fire on screen would be pure cost, so
   * the layer-level test stays the only one that runs.
   */
  function pinDrawsAt(key, item, zoom, layerZ) {
    const gate = pinZoomGate(key, item, layerZ);
    if (gate != null && zoom < gate) return false;
    // The ceiling, asked separately because a pin type very often has one and
    // not the other -- and because there is no layer-level number to compose
    // with here. The layer's own ceiling is applied in applyScene above, which
    // switches the whole layer off; this one thins a layer that is still on.
    const tokenOf = TOKEN_FOR[key];
    const ceiling = tokenOf ? tokenZoomMax(tokenOf(item)) : null;
    return ceiling == null || zoom <= ceiling;
  }

  /**
   * Push opacity and stack order onto the three canvas layers.
   *
   * The panel has had an Opacity slider for FIRMS and for jamming since Admin
   * Mode existed, and until now it moved nothing a reader could see: opacity
   * reaches a marker through themedStyle, and neither of these layers draws
   * markers -- they draw one canvas each, plus the near-invisible click targets
   * on top. So the slider appeared to work on the layer while only ever acting
   * on hit-test circles at 0.02 opacity.
   *
   * CSS on the element rather than a leaflet.heat option, because leaflet.heat
   * has none that means this (see FIRMS_HEAT_OPACITY in layers.js). Re-applied
   * on every settings change and after every render: leaflet.heat rebuilds its
   * canvas on redraw, which drops any style written onto the old one.
   */
  function applyWashStack() {
    const canvases = [
      [firmsHeat?._canvas, FIRMS_HEAT_OPACITY, "firms"],
      [jammingHeat?._canvas, JAMMING_HEAT_OPACITY, "jamming"],
      [laneDensityHeat?._canvas, LANE_DENSITY_HEAT_OPACITY, "laneDensity"],
      [entityWebglLayer.canvas?.(), 1, "vehicles"],
    ];
    for (const [canvas, shipped, key] of canvases) {
      // Absent until the layer has been added to the map at least once, which
      // for jamming is "not until somebody switches it on".
      if (!canvas) continue;
      canvas.style.opacity = String(shipped * layerOpacity(key));
      // The three washes share one pane, so their order among themselves is
      // plain CSS stacking on sibling elements. They cannot be ordered against
      // the pins from here and are not meant to be -- see the note above
      // PIN_STACK in iconTheme.js.
      canvas.style.zIndex = String(stackZIndex(key));
    }
  }

  /**
   * The Size dial, for the two layers that draw no icons.
   *
   * Every other layer's size reaches the map through scaledSize inside a
   * decorator. FIRMS and jamming have no decorator and no glyph -- they are a
   * density canvas plus an invisible click target each -- so the slider in the
   * panel moved nothing at all for them, which is indistinguishable from a
   * broken control.
   *
   * What "size" means for a heat layer is its kernel: `radius` is how far one
   * reading spreads and `blur` how softly it falls off, and scaling both
   * together is the honest reading of "draw this bigger". The click radius is
   * scaled with it so the target keeps matching what a reader sees.
   *
   * setOptions alone does not repaint -- leaflet.heat reads these at draw time
   * -- so this runs before the redraw its caller is about to trigger.
   */
  const HEAT_KERNEL = {
    firms: { radius: 16, blur: 22 },
    jamming: { radius: 22, blur: 28 },
    laneDensity: { radius: 18, blur: 24 },
  };

  function applyHeatKernel(heat, key) {
    if (!heat?.setOptions) return;
    const shipped = HEAT_KERNEL[key];
    heat.setOptions({
      radius: Math.max(2, Math.round(shipped.radius * layerScale(key))),
      blur: Math.max(2, Math.round(shipped.blur * layerScale(key))),
    });
  }

  /**
   * What the reader has said about a layer, overriding the scene.
   *
   * Three states, and the third is the point:
   *   true      show it, whatever the scene thinks
   *   false     hide it, whatever the scene thinks
   *   absent    the scene decides
   *
   * Without the absent state a checkbox and a resolver cannot coexist -- the
   * checkbox's own value would be indistinguishable from the scene's answer,
   * so every scene change would look like a user preference and stick. This is
   * what lets the admin panel act as a debugger for the resolver rather than a
   * competitor to it.
   */
  const userLayerWish = {};

  /**
   * Recompute the scene and make the map match it.
   *
   * Runs before renderAll on every moveend, so a renderer never sees a scene
   * from the previous viewport. Layer state is applied through setLayerVisible
   * rather than by touching layerOnMap directly, because that function is where
   * a dozen special cases live -- the news layer's AND with its parent, the
   * WebGL buckets' own visibility, the trail sub-tickers, the uncertainty
   * teardown, the districts' lazy geometry load -- and duplicating any of them
   * here would mean two places to keep in step.
   */
  function applyScene() {
    viewportProfile = profileViewport({
      countryIndex,
      bounds: boundsToPlainObject(map.getBounds()),
      zoom: map.getZoom(),
      hotCountryKeys: refreshHotCountries(),
      previous: viewportProfile,
    });

    scene = resolveScene({
      zoom: map.getZoom(),
      profile: viewportProfile,
      focus,
      overrides: layerZoomOverrides,
      bypass: sceneBypass,
    });

    // Pushed into decorators.js before any renderer runs, so every marker built
    // or updated in this pass agrees about what it should look like. Reading it
    // back rather than tracking it here keeps one source of truth; a change is
    // the one moment every visible marker legitimately repaints, and applyScene
    // is always followed by a render.
    setIconDetail(scene.detail);

    for (const key of SCENE_APPLY_KEYS) {
      const wish = userLayerWish[key];
      let want = wish === undefined ? scene.active.has(key) : wish;
      // A tick makes a layer eligible; a gate typed into Admin Mode still says
      // from what zoom it draws.
      //
      // Without this the two controls cancelled each other, and for the
      // corroborating layers they cancelled each other *always*: cables, ports,
      // dams, airfields and the GFW layers are only reachable by ticking them,
      // and a wish beat the gate outright -- so "Shows from zoom" was a slider
      // that could never do anything for the layers most likely to need it. Set
      // Submarine cables to z6, watch 718 routes stay on the world board.
      //
      // The gate that applies is the one the panel is *showing*, which is the
      // override when there is one and the shipped number otherwise.
      //
      // This was narrower for one revision -- explicit overrides only -- and
      // that left the control lying at exactly the value most likely to be
      // chosen. FIRMS ships drawing from z4, so its slider reads "z4"; dragging
      // it to 4 stores "no override" (that is how the reset-to-default works),
      // the gate was then skipped, and a layer whose control said z4 drew at z3.
      // Every layer had the same dead spot at its own shipped number.
      //
      // The cost is that ticking a layer below its gate now shows nothing where
      // it used to force the layer on. That is the honest reading of a control
      // that states a zoom, and it is no longer mysterious: the checkbox goes
      // amber and says "pinned on, held back by its zoom gate" (see
      // LayerCheck.jsx), with the count beside it reading 0 of N.
      //
      // Skipped under the bypass, whose whole job is to be the state with
      // nothing applied.
      if (want && wish === true && !sceneBypass) {
        const override = layerZoomOverrides[key];
        const gate = Number.isFinite(override) ? override : shippedDrawZoom(key);
        if (Number.isFinite(gate) && map.getZoom() < gate) want = false;
      }
      // The ceiling, and it applies to a ticked layer as much as to a resolved
      // one -- unlike the floor above, which only narrows an explicit wish.
      //
      // That asymmetry is deliberate. A floor competes with the resolver, which
      // already has an argued-for opinion about when a layer starts drawing, so
      // it only arbitrates a wish. Nothing in LAYER_MANIFEST expresses a ceiling
      // at all, so there is no opinion to compete with: an operator who typed
      // one is the only source of it, and a tick cannot have been meant to
      // override a limit typed on the same panel.
      //
      // Skipped under the bypass for the same reason the floor is.
      if (want && !sceneBypass) {
        const ceiling = layerZoomMaxOverrides[key];
        if (Number.isFinite(ceiling) && map.getZoom() > ceiling) want = false;
      }
      // Only on a real change: setLayerVisible re-renders the layer it switches
      // on, and calling it for every key on every pan would undo the whole
      // point of the early returns in the renderers.
      if (layerOnMap[key] !== want) setLayerVisible(key, want);
    }

    reportLayerState();
  }

  // The panel's checkboxes read this rather than a React copy of their own,
  // because the resolver moves layers on and off as the camera moves and a copy
  // that only changed on a click would be wrong within one pan. Diffed before
  // reporting for the same reason the counts are coalesced: this runs on every
  // moveend, and handing React a fresh object each time would re-render the
  // whole panel for an answer that had not changed.
  let lastLayerStateSignature = null;
  function reportLayerState() {
    if (!callbacks.onLayerStateChange) return;
    const on = {};
    for (const key of SCENE_APPLY_KEYS) on[key] = layerOnMap[key] === true;
    for (const trailKey of Object.keys(TRAIL_TOGGLES)) on[trailKey] = layerOnMap[trailKey] === true;
    on.satellitesMilitary = satellitesMilitaryVisible;
    on.waterLakes = waterLakesVisible;
    on.waterRivers = waterRiversVisible;
    const signature = `${JSON.stringify(on)}|${JSON.stringify(userLayerWish)}|${sceneBypass}`;
    if (signature === lastLayerStateSignature) return;
    lastLayerStateSignature = signature;
    callbacks.onLayerStateChange({ on, wish: { ...userLayerWish }, bypass: sceneBypass });
  }

  /**
   * A reader (or an admin) asking for a layer directly, which outranks the
   * scene until they hand it back. `visible === null` hands it back.
   */
  function setLayerWish(key, visible) {
    if (visible === null || visible === undefined) delete userLayerWish[key];
    else userLayerWish[key] = visible;
    // The trail sub-tickers, satellitesMilitary and the weather tiles are not
    // the resolver's business, so applyScene's loop does not walk them -- they
    // have to be pushed through by hand or a click on one would do nothing.
    if (!SCENE_APPLY_KEYS.includes(key)) {
      if (typeof visible === "boolean" && layerOnMap[key] !== visible) setLayerVisible(key, visible);
      reportLayerState();
      return;
    }
    applyScene();
  }

  // Which keys the last applyLayerWishes call is answerable for. Needed because
  // that table is replaceable -- a saved configuration is loaded, imported or
  // reset -- and a key that has dropped out of it has to go back to the resolver
  // rather than keep the answer the previous table gave it.
  let appliedWishKeys = new Set();

  /**
   * Apply a whole table of wishes at once -- Admin Mode's saved layer states.
   *
   * One applyScene for the table rather than one per key: this runs at
   * construction, and again whenever the configuration is replaced (the backend
   * copy landing after the local cache, an imported file, a reset), and
   * applyScene reprofiles the viewport every time it is called.
   *
   * Keys the resolver does not manage -- the weather tiles, the trail
   * sub-tickers, the military-satellite row -- are not walked by applyScene's
   * loop, so they are pushed by hand afterwards. Those same keys have no
   * resolver answer to hand back to either, so dropping one out of the table
   * leaves it where it was until the page is reloaded; there is nothing else it
   * could mean.
   */
  function applyLayerWishes(table) {
    const next = table || {};
    for (const key of appliedWishKeys) {
      if (!(key in next)) delete userLayerWish[key];
    }
    for (const [key, visible] of Object.entries(next)) {
      if (typeof visible === "boolean") userLayerWish[key] = visible;
    }
    appliedWishKeys = new Set(Object.keys(next));
    applyScene();
    for (const [key, visible] of Object.entries(next)) {
      if (typeof visible !== "boolean" || SCENE_APPLY_KEYS.includes(key)) continue;
      if (layerOnMap[key] !== visible) setLayerVisible(key, visible);
    }
    reportLayerState();
  }

  // ---------- conflict-event filters ----------
  //
  // What the user asked to see. The predicate itself lives in severity.js so
  // the notable-events panel and the zone briefing can apply the identical
  // test to the identical array; this holds only the current settings. Applied
  // per item in renderMarkerLayer through LAYER_ITEM_FILTER rather than by
  // special-casing "events" inside the generic loop, so adding a filter to
  // another layer later is a table entry.
  let eventFilter = { ...DEFAULT_EVENT_FILTER };

  // ---------- vessel/aircraft filter bars (Task 18) ----------
  //
  // Same "one copy, held here, applied per item" shape as eventFilter above.
  // The predicate lives in utils/entityFilter.js (not here and not in
  // decorators.js) so it can be asserted headlessly under `node --test` --
  // see that module's own note on why it does not import classifyAircraft.
  // Applied inline inside renderAisLayer/renderAdsbLayer's own per-item loop,
  // rather than as a LAYER_ITEM_FILTER table entry the way events does it:
  // those two renderers already split one raw feed into several buckets by
  // hand (civilian/tanker/navy, civilian/military/flagged), so the filter
  // has to run before that split, not per rendered bucket.
  let vesselFilter = { ...DEFAULT_VESSEL_FILTER };
  let aircraftFilter = { ...DEFAULT_AIRCRAFT_FILTER };

  // The moment every age is measured against. Null means "live", i.e. now.
  // Replay sets it to the scrubbed timestamp: without that, a snapshot from
  // two days ago is measured against the wall clock and the whole conflict
  // layer filters itself out of a view the backend just served.
  let ageReference = null;
  function ageNow() {
    return ageReference ?? Date.now();
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
  //
  // Matched on the article URL as well as the id, which is what makes this work
  // at all. GDELT emits one event row per actor pair, so one article arrives as
  // several event ids: the absorbing record names the id it was built from, the
  // News layer draws a sibling id from the same URL, and the reader gets two
  // pins with the identical headline. See buildAbsorbedArticles.
  let mergedNews = { ids: new Set(), urls: new Set() };

  function rebuildMergedNewsIds() {
    mergedNews = buildAbsorbedArticles([raw.events, raw.officials]);
  }

  function passesNewsFilter(item) {
    if (mergedNews.ids.has(item.event_id)) return false;
    const url = normalizeArticleUrl(item.source_url);
    if (url && mergedNews.urls.has(url)) return false;
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

  // ---------- one place, two publishers ----------
  //
  // OpenStreetMap maps military airfields that OurAirports already lists, and
  // hydro power plants that sit on dams Global Dam Watch already lists. Both
  // pairs draw two pins for one thing, from z9 up, with different names on them
  // (OSM records the local-script name). See map/crossSource.js for the
  // matching and for which of the two survives.
  //
  // Rebuilt when either feed lands rather than per render: it is 25k OSM
  // features against 48k airfields, which is cheap once and absurd sixty times
  // a minute. Keyed by id, so the render loop's lookup is a Map hit.
  let osmTwins = { absorbed: new Map(), airfieldTwinOf: new Map(), damTwinOf: new Map() };

  function rebuildOsmTwins() {
    const osm = raw.osmInfra || [];
    const airfields = buildTwinIndex(
      raw.airports || [],
      osm.filter((d) => d.kind === "military_airfield"),
      { radiusKm: AIRFIELD_MATCH_KM, primaryId: (d) => d.id, secondaryId: (d) => d.id },
    );
    const dams = buildTwinIndex(
      raw.dams || [],
      // Only the hydro ones. A gas plant that happens to be near a dam is a
      // different structure, and absorbing it would be a factual claim the data
      // does not make.
      osm.filter((d) => d.kind === "power_plant" && d.source_tag === "hydro"),
      { radiusKm: DAM_MATCH_KM, primaryId: (d) => d.id, secondaryId: (d) => d.id },
    );
    const absorbed = new Map();
    for (const [id, entry] of airfields.absorbed) absorbed.set(id, { ...entry, by: "airports" });
    for (const [id, entry] of dams.absorbed) absorbed.set(id, { ...entry, by: "dams" });
    osmTwins = { absorbed, airfieldTwinOf: airfields.twinOf, damTwinOf: dams.twinOf };
  }

  /**
   * Is this OSM feature already drawn by the layer that absorbed it?
   *
   * The question is not "was it matched" but "is its match on screen right
   * now". A reader who switches the airfields layer off, or who has given it a
   * zoom of its own in the admin panel, must get the OSM pin back rather than a
   * hole where two sources agreed there was an airbase -- suppressing a pin in
   * favour of one that is not being drawn removes the place from the map
   * entirely, which is the one outcome worse than drawing it twice.
   */
  function passesOsmInfraFilter(item) {
    const entry = osmTwins.absorbed.get(String(item.id));
    if (!entry) return true;
    if (layerOnMap[entry.by] === false) return true;
    const gate = minZoomFor(entry.by);
    if (gate != null && map.getZoom() < gate) return true;
    return false;
  }

  // Task 27: the one osm_infra sweep still returns all five kinds in one
  // list -- moving the four railway kinds to their own layer (see
  // LAYER_MANIFEST's note) is a rendering split, not a fetch split. applyData
  // does the actual splitting (see its own note), into raw.osmInfra and
  // raw.railwayPoints; this predicate is what it splits by, and is exported
  // to that closure by being a plain function declaration in this scope.
  function isRailwayPointItem(item) {
    return typeof item.kind === "string" && item.kind.startsWith("railway_");
  }

  const LAYER_ITEM_FILTER = {
    events: (item) => passesEventFilter(item, eventFilter, ageNow()),
    gdelt: passesNewsFilter,
    officials: passesOfficialsFilter,
    osmInfra: passesOsmInfraFilter,
  };

  /**
   * Thin a layer to the most significant N, per band.
   *
   * At world zoom the map should read as "where is the significant activity",
   * not as an undifferentiated smear. A rank-based cap rather than an absolute
   * floor, deliberately: severity is calibrated against real data where a
   * single-outlet report scores in the 20s, so a fixed threshold like "hide
   * anything under 55" would empty the map entirely on a quiet day. A cap
   * adapts -- it only ever removes the least significant, and only once there
   * are more than can be read at once.
   *
   * Reported rather than applied silently, and that is the whole reason this
   * writes to zoomNotes. The boot view is zoom 3, where the events cap keeps
   * 150 of what can be 2500, and a layer showing 6% of its own count with no
   * explanation reads as a broken layer rather than a deliberately thinned one.
   *
   * The cap and the rank both come from map/scene.js now, so a layer opts in by
   * gaining a `cap` in the manifest rather than by being special-cased here.
   *
   * `rankOverride` is the one exception to that, and it exists because two
   * layers have no rank a table could hold -- see nearestToCentreRank below.
   * Anything expressible as a property of one item belongs in the manifest.
   */
  function capByRank(key, items, rankOverride) {
    const cap = scene.caps.get(key);
    if (!Number.isFinite(cap) || items.length <= cap) {
      if (cappedCounts[key]) {
        delete cappedCounts[key];
        publishCapped();
      }
      return items;
    }
    if (cappedCounts[key] !== cap) {
      cappedCounts[key] = cap;
      publishCapped();
    }
    const rank = rankOverride || LAYER_MANIFEST[key]?.rank || ((d) => d.severity || 0);
    return [...items].sort((a, b) => rank(b) - rank(a)).slice(0, cap);
  }

  // Enough to outrank any distance: the squared-degree term below cannot exceed
  // ~65,000 even between opposite corners of the world.
  const RANK_ALWAYS_KEEP = 1e6;

  /**
   * Rank by distance from the middle of the view, nearest first.
   *
   * The two vehicle layers that need capping -- ordinary aircraft and merchant
   * hulls -- have no severity, no magnitude and no editorial rank of any kind.
   * Left to the default rank every item would score zero, and the sort would
   * keep whatever order the feed happened to arrive in. That order changes on
   * every poll, so a 20-second tick would swap out most of the fleet and the
   * sprites would flicker.
   *
   * Distance from the camera centre is stable across a poll (a hull moves
   * metres, an airliner a few km), deterministic, and states something a reader
   * can check: these are the four hundred nearest the middle of what you are
   * looking at. It cannot live in map/scene.js -- that table is a pure function
   * of the zoom band and knows nothing about where the camera is pointed -- so
   * it is built here, per render, from map.getCenter().
   *
   * `keepFirst` lifts a class above distance entirely. A designated hull is the
   * rarest thing in a bucket of thousands and must not be dropped for being far
   * from the middle of the screen; aircraft need no equivalent because the
   * flagged bucket has already taken those out of this layer.
   */
  function nearestToCentreRank(keepFirst) {
    const centre = map.getCenter();
    const cosLat = Math.cos((centre.lat * Math.PI) / 180);
    return (d) => {
      // Wrapped, because Leaflet reports longitudes outside +-180 on a wrapped
      // world: without this a hull just west of the antimeridian would read as
      // 358 degrees from a camera just east of it.
      let dLon = d.lon - centre.lng;
      if (dLon > 180) dLon -= 360;
      else if (dLon < -180) dLon += 360;
      // Longitude degrees shrink toward the poles. Unscaled, a Baltic view
      // would rank a ship far to the east above one much closer due north.
      dLon *= cosLat;
      const dLat = d.lat - centre.lat;
      const near = -(dLat * dLat + dLon * dLon);
      return keepFirst?.(d) ? near + RANK_ALWAYS_KEEP : near;
    };
  }

  // How many each capped layer is currently showing. Kept as its own object so
  // zoomNotes.capped is a fresh reference only when something really changed --
  // it is handed to React and read on every panel render.
  const cappedCounts = {};
  function publishCapped() {
    zoomNotes.capped = { ...cappedCounts };
    // eventsCapped predates this and is what LayersSection and
    // useLeafletMap's EMPTY_ZOOM_NOTES still read. Kept as an alias rather than
    // migrated, so generalising the cap changes no UI in the same commit.
    zoomNotes.eventsCapped = cappedCounts.events || 0;
    scheduleReports({ notes: true });
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

  /**
   * Group a layer's pile-ups, per its manifest entry.
   *
   * Two layers had this hand-wired; the rest could not have it at all without
   * another branch here. It is now a property a layer declares, which is what
   * lets `hazards`, `airports`, `ports`, `dams`, `osmInfra` and the two GFW
   * layers stop drawing forty coincident pins at their shallowest band.
   *
   * `events` deliberately declares no collapse, and that is a claim about the
   * data rather than a tuning choice: merging two incident reports into one pin
   * asserts they were one event, which nothing in the feed supports. Capping
   * removes the least significant and says so in the panel -- a stated
   * editorial act. Collapsing would be an unstated factual one.
   *
   * The two bespoke groupings keep their own functions: news ranks by decayed
   * reach, and diplomacy groups on an exact anchor rather than on pixels (see
   * collapseByKey's own note for why proximity is the wrong question there).
   */
  // ---------- city zones ----------
  //
  // See map/cityZones.js for what a zone is and, more importantly, what it is
  // not. Rebuilt when the city list or the configured radius changes rather than
  // per render: it is ~6,200 cities into a grid, which is cheap once and
  // needless sixty times a minute.
  let cityZoneIndex = null;
  let cityZoneSettings = { group: true, show: true, radiusScale: 1 };

  function rebuildCityZoneIndex() {
    cityZoneIndex = buildCityZoneIndex(raw.cities, {
      // Population, not capital status. CAPITAL_TIER answers "how should this be
      // drawn"; a zone is asking how far the built-up area reaches, and a small
      // capital is still a small city on the ground.
      tierOf: (city) => cityTier(city.population),
      keyOf: cityKey,
      radiusScale: cityZoneSettings.radiusScale,
    });
  }

  /**
   * Which city zone an item belongs to, or null for "do not group".
   *
   * Null is the important half. An event outside every city zone is an event in
   * open country, and it keeps its own pin -- grouping is a claim that several
   * reports are about one place, and there is no place to make that claim about
   * out there.
   */
  function cityZoneKeyOf(item) {
    if (!cityZoneSettings.group || !cityZoneIndex) return null;
    return cityZoneIndex.zoneAt(item.lat, item.lon)?.key ?? null;
  }

  function collapseFor(key, items, zoom) {
    // Before the manifest's own rules, and it applies at every zoom: a city zone
    // is a fact about a place rather than about the projection, so unlike the
    // proximity collapses below there is no zoom at which it stops being true.
    // The reader's way out is per group and explicit -- "Separate these pins",
    // through expandOpened, exactly as it is for news.
    if (key === "events" && cityZoneSettings.group && cityZoneIndex) {
      const grouped = expandOpened(collapseByKey(items, cityZoneKeyOf, (d) => d.severity || 0));
      // Named here rather than in the decorator, which has no way to know which
      // city was asked about. Without it a collapsed head would say "12 at this
      // location" and leave the reader to guess what location was meant.
      for (const head of grouped) {
        if (!head.collapsedCount) continue;
        const zone = cityZoneIndex.zoneAt(head.lat, head.lon);
        if (zone) head.collapsedLabel = `${zone.city.name} &mdash; within ${Math.round(zone.radiusM / 1000)} km`;
      }
      items = grouped;
    }
    if (key === "gdelt") return collapseNews(items, zoom);
    if (key === "officials") return collapseOfficials(items, zoom);
    const rule = scene.collapse.get(key);
    if (!rule || rule.mode !== "proximity") return items;
    if (zoom > (rule.maxZoom ?? COLLAPSE_MAX_ZOOM)) return items;
    if (items.length < 2) return items;
    return expandOpened(collapseByProximity(
      items,
      (item) => map.latLngToLayerPoint([item.lat, item.lon]),
      // No rank of its own: these layers have no reach or recency to decay, so
      // the head is whichever the deterministic id tiebreak picks. That is
      // arbitrary but stable, which is the property that matters -- a head that
      // changed as the map panned would make groups re-form under a different
      // pin on every move (see byRankThenId in collapse.js).
      rule.rank || (() => 0),
      rule.radiusPx
    ));
  }

  function collapseNews(items, zoom) {
    if (zoom > COLLAPSE_MAX_ZOOM) return items;
    return expandOpened(collapseByProximity(
      items,
      // The same projection registerPlacement uses, so what collapse considers
      // "on top of each other" is what the reader actually sees.
      (item) => map.latLngToLayerPoint([item.lat, item.lon]),
      newsRank
    ));
  }

  /**
   * Put back the members of any group the reader has opened.
   *
   * Applied after collapsing rather than instead of it, so a group the reader
   * has not touched still forms normally and the one they have opened is the
   * only thing that changes. The head's id is what identifies an opened group,
   * and collapse.js's byRankThenId is what makes that safe: the head is chosen
   * deterministically from rank then id, so it does not change as the map pans
   * and a group cannot silently re-form under a different head while open.
   *
   * The popup used to say "zoom in to separate them", which asked the reader to
   * change what they were looking at in order to read what was already under
   * the pointer. Now they can just ask.
   */
  function expandOpened(heads) {
    if (!expandedClusters.size) return heads;
    const out = [];
    for (const head of heads) {
      const id = head.event_id ?? head.id;
      if (head.collapsed?.length && expandedClusters.has(String(id))) out.push(...head.collapsed);
      else out.push(head);
    }
    return out;
  }

  /** Open or close one collapsed group, by its head's id. */
  function toggleCluster(id) {
    const key = String(id);
    if (expandedClusters.has(key)) expandedClusters.delete(key);
    else expandedClusters.add(key);
    renderAll();
  }

  // Diplomacy groups too, but on an exact position rather than on pixels -- see
  // officialsKey and collapseByKey. Every record the backend snapped to a given
  // capital, every press release from a given institution, and every mention
  // GDELT geocoded to a given city centroid shares one coordinate by
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

  // Sized against the officials glyph, which draws at 10-11px (see
  // officialsIconSize). A radius near the icon's own width means "these were
  // going to overlap anyway" rather than grouping two pins a reader can already
  // tell apart -- the same reasoning behind COLLAPSE_RADIUS_PX, which is 26
  // because the news glyph is 14-21px and would over-merge these.
  const OFFICIALS_COLLAPSE_RADIUS_PX = 14;

  function collapseOfficials(items, zoom) {
    const collapsed = collapseByKey(items, officialsKey, officialsRank);
    if (zoom < OFFICIALS_EXPAND_MIN_ZOOM) {
      // Not yet deep enough to hand every member back on its own. A group the
      // reader has explicitly opened still opens -- but only above the zoom the
      // declutter spiral runs at, because these members share an exact
      // coordinate and without the spiral they would land in a stack nobody can
      // click. Below that the group stays whole, which is honest: one pin
      // standing for nine is better than nine pins standing on each other.
      if (zoom >= DECLUTTER_MIN_ZOOM) return expandOpened(collapsed);
      // Below the spiral, exact keys are not enough. Two different anchors can
      // still land on one pixel down here -- the UN spokesperson's office and
      // the UN news service share a building, and at this zoom a whole city is a
      // pixel or two -- and nothing separates them. So the same instrument is
      // applied a second time, spatially. Not expandOpened for the same reason
      // the branch above is not: without the spiral, opening a group produces a
      // stack nobody can click.
      return collapseHeadsByProximity(
        collapsed,
        // The same projection registerPlacement uses, so what this considers
        // "on top of each other" is what the reader actually sees.
        (item) => map.latLngToLayerPoint([item.lat, item.lon]),
        officialsRank,
        OFFICIALS_COLLAPSE_RADIUS_PX
      );
    }
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
  // Which number, if any, the shapes are painted by, and which shapes --
  // countries or states -- that number is painted onto (Task 26 generalised
  // this from countries-only). Null metric is the shipped default in either
  // target: the fill is opt-in, because a permanently-tinted world would
  // compete with every pin drawn on top of it. `choropleth.styleFor` is one
  // function shared by both layers below; which of them actually calls it on
  // any given feature is decided by `choroplethTarget` in each layer's own
  // getFill closure, so switching target never paints two layers at once.
  let choroplethTarget = "country";
  let choroplethMetricId = null;
  let choropleth = { metric: null, styleFor: () => null, covered: 0, total: 0 };
  const countriesLayer = createCountriesLayer(
    map, (props) => (choroplethTarget === "country" ? choropleth.styleFor(props) : null)
  );

  // ---------- admin-2 district record ----------
  // A historical monthly archive over six countries, and it draws nothing of its
  // own: it exists to answer for the one district a reader has drilled into and
  // clicked. Everything it needs -- the months list, one month of counts, and
  // per-country geometry -- is fetched on demand rather than polled, because
  // none of it changes on any timescale a session would notice, and none of it
  // is asked for until a reader is looking at districts at all.
  let districtMonths = [];               // newest first, from the archive's own endpoint
  let districtMonth = null;              // "YYYY-MM"; null until the months load
  let districtCounts = new Map();        // p-code -> one month's record
  let districtCountsLoading = false;     // a month picked whose counts are still in flight
  // Flat {pcode, bbox, polygons} list for click resolution -- see districts.js
  // on why the country index's smallest-area-first ordering is not needed here.
  let districtIndex = [];
  // ISO3 -> FeatureCollection, or null while a request is in flight, so a
  // country drilled into twice is fetched once.
  const districtGeometry = new Map();
  // ISO3 -> that country's own slice of the hapi_conflict archive (up to its
  // 24-month retention), or null while a request is in flight -- the district
  // card's 24-month trend sparkline reads this. Fetched once per country,
  // scoped by the existing /api/conflict-districts endpoint's own `country`
  // parameter rather than the unscoped `months=24` the endpoint's own
  // docstring warns off (see loadDistrictSeries): a single country's slice is
  // a few hundred KB at most, not the ~23 MB whole-world archive.
  const districtSeriesByCountry = new Map();

  // ---------- country, then state, then district ----------
  // The last step of the selection: the districts of the one state singled out,
  // drawn on their own layer and clickable for the conflict record HAPI holds
  // against them. Only the six countries with COD-AB geometry have any, and only
  // the state actually selected is drawn.
  const districtOutlineLayer = createDistrictOutlineLayer(map);
  // p-code -> the key of the admin-1 subdivision it sits in, worked out once per
  // country from the geometry rather than by matching COD-AB's `admin1` name
  // against Natural Earth's. The two spell the same province differently often
  // enough that a name join would lose a fifth of them: against the geometric
  // answer, Afghanistan's district names agree with their province's Natural
  // Earth name 325 times out of 401. A district in neither layer's hands is
  // drawn exactly like sea.
  const districtStateByPcode = new Map();
  // Published by reference -- a Map's own .set mutates in place, so this needs
  // assigning only once, here, rather than every time assignDistrictStates adds
  // to it. Read by popups.js's admin-2 Connectivity fold (Task 26): IODA has no
  // district-level reading, so a district card shows its parent state's, found
  // through this same geometric join rather than a second, name-based one.
  raw.districtStateByPcode = districtStateByPcode;
  const districtStatesAssigned = new Set();  // ISO3s already worked out
  let selectedDistrictPcode = null;
  let hoveredDistrictPcode = null;
  let drawnDistrictState = "";               // which state's districts are drawn
  // The Leaflet layer backing the district whose card is open, held so its
  // on-screen anchor point can be recomputed on every pan/zoom (see
  // districtAnchorPoint and the "move zoom" handler) -- the district
  // counterpart to focusedWaterLayer below.
  let focusedDistrictLayer = null;
  // ---------- admin-1 subdivisions ----------
  // Drawn for whichever countries are selected right now, and for no others --
  // see subdivisions.js on why this rides on the selection instead of being a
  // layer with a checkbox. Everything here is per-session: geometry fetched
  // once per country and kept (administrative borders do not move while a tab
  // is open), selection dropped the moment its country stops being selected.
  const subdivisionsLayer = createSubdivisionsLayer(
    map, (props) => (choroplethTarget === "state" ? choropleth.styleFor(props) : null)
  );
  // ISO3 -> FeatureCollection, or null while a request is in flight. A country
  // the source has no subdivisions for is stored as an empty collection rather
  // than left absent, so it is asked for once per session and not once a click.
  const subdivisionGeometry = new Map();
  let subdivisionIndex = [];        // every country loaded so far, flat
  // Published by reference on every reassignment below (see the state-target
  // choropleth and popups.js's regionOutageFor/buildAdminConnectivity, Task
  // 26) -- read the same way raw.countryIndex is for the country layer.
  raw.subdivisionIndex = subdivisionIndex;
  let selectedSubdivisionKey = null;
  let hoveredSubdivisionKey = null;
  let drawnSubdivisionCountries = "";  // signature of what is currently drawn
  // The subdivision counterpart to focusedDistrictLayer above.
  let focusedSubdivisionLayer = null;

  let countryIndex = [];          // see buildCountryIndex -- smallest-area-first
  let layerByCountryKey = new Map();
  let hoveredCountryKey = null;

  // Admin Mode's boundary editor. Null unless someone is dragging a border
  // right now (see beginBorderEdit); while it is live it owns raw.countries'
  // geometry, which is what the two guards below are protecting.
  let borderSession = null;
  // A /api/countries payload that landed mid-session, held until the session
  // ends rather than dropped -- the poll is five minutes apart and throwing one
  // away could leave the map a rename behind for that long.
  let pendingCountries = null;

  function countryLayerFor(key) {
    return key == null ? null : layerByCountryKey.get(key) || null;
  }

  const borderEditor = createBorderEditor({
    map,
    getFeatureCollection: () => raw.countries,
    // The editor works on its own copy of whatever it touches and swaps the
    // collection out rather than writing into the one it was handed -- see
    // adopt() there for why that distinction is the whole of it.
    replaceFeatureCollection: (fc) => { raw.countries = fc; },
    getLayerFor: countryLayerFor,
    onCommit: (commits) => callbacks.onBorderRingCommit?.(commits),
    onStateChange: (state) => callbacks.onBorderEditChange?.(state),
    // A dragged vertex invalidates three things derived from the geometry, and
    // all three are cheap enough to redo per gesture rather than per frame:
    // the hit-test index (a country whose shape moved but whose index did not
    // is selectable in the wrong place), the polygons React holds for panel
    // scoping (published by reference -- see reportCountrySelection), and the
    // outage pins, which are positioned from the country's own geometry.
    onGeometryChanged: () => {
      countryIndex = buildCountryIndex(raw.countries);
      raw.countryIndex = countryIndex;
      focusedCountryLayer = countryLayerFor(focusedCountryKey);
      reportCountrySelection();
      rebuildOutagePoints();
      renderMarkerLayer("outagePoints");
    },
  });

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
    const { sections, summary, groups } = countryCardSections(
      entry.props,
      raw,
      layer ? boundsToPlainObject(layer.getBounds()) : null
    );
    return {
      key: entry.key,
      iso: entry.iso,
      name: entry.name,
      sections,
      // Task 10: the summary strip's seven tiles and the table PlaceInfoCard
      // groups `sections` by -- both optional on the card payload the same
      // way they are optional on PlaceInfoCard itself, so nothing downstream
      // that only ever reads `.sections` (e.g. the search index) needs to
      // change for either to exist.
      summary,
      groups,
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

  /** Fallback for sources that name a country rather than code it. */
  function countryEntryForName(name) {
    const wanted = normalizeCountryName(name);
    if (!wanted) return null;
    return countryIndex.find((e) => normalizeCountryName(e.name) === wanted) || null;
  }

  /**
   * Tell React which countries are selected, in click order.
   *
   * The borders ride along (by reference -- nothing is copied) because the
   * selection is not only a label any more: the notable-activity board and the
   * news ticker scope themselves to these shapes. See map/countryScope.js for
   * why that is done in geometry rather than by country name.
   */
  function reportCountrySelection() {
    callbacks.onCountrySelectionChange?.(
      [...selectedCountryKeys].map((key) => {
        const entry = countryEntryFor(key);
        return {
          key,
          iso: entry?.iso ?? null,
          name: entry?.name || key,
          bbox: entry?.bbox ?? null,
          polygons: entry?.polygons ?? null,
        };
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

    // Clicking a country is the reader saying "this one". That is what the
    // control panel's checkboxes used to be for, and it is a better version of
    // the same act: the layers that corroborate a country's picture become
    // eligible, the ones that are only legible up close come a band earlier,
    // and the feeds behind them start fetching regardless of how far out the
    // camera is (see FOCUS_PROMOTE in scene.js). Dropping the selection puts
    // all of that back.
    // The country's own bounds travel with the focus, because the fetch layer
    // clips to them rather than to the camera: focusing a country is a request
    // for its whole picture, and a viewport clip would leave the parts the
    // reader has not scrolled to missing from a card that claims to describe
    // the country.
    setFocus(nextFocus ? { kind: "country", key: nextFocus, bounds: boundsOfCountry(nextFocus) } : null);

    renderCities();
    focusCountry(nextFocus);
    reportCountrySelection();
    // The internal borders follow the selection: selecting a country is what
    // asks for its states, and dropping it is what puts them away. Not awaited
    // -- see syncSubdivisions.
    syncSubdivisions();
    return true;
  }

  /**
   * Drop the whole selection at once, however many countries are in it.
   *
   * The counterpart to selectCountryEntry above, and it repeats that function's
   * tail rather than calling it with a null entry: that path returns early,
   * because "select nothing" is not something a click *on a country* can mean.
   * This is the one gesture that can mean it -- a click on empty map.
   *
   * Note what is deliberately not touched. activeConflictZoneBounds survives, so
   * citiesEnabled stays true for a conflict zone picked from the Region bar; that
   * scope came from a different control and is not this click's to revoke. The
   * standing rule above -- panning away, picking a region and closing the card
   * all leave a selection standing -- is otherwise unchanged. A highlight that
   * vanishes on the next pan is still not a selection; this one vanishes only
   * when the reader points at nothing and says so.
   */
  function clearCountrySelection() {
    if (!selectedCountryKeys.size) return false;
    selectedCountryKeys.clear();
    citiesEnabled = !!activeConflictZoneBounds;
    setFocus(null);
    renderCities();
    focusCountry(null); // closes the card and drops the anchor the "move zoom" handler tracks
    reportCountrySelection();
    syncSubdivisions();
    return true;
  }

  /**
   * What the reader has singled out: a country, a layer, or nothing.
   *
   * Re-resolves the scene and redraws, because a focus change can make whole
   * layers eligible that were not a moment ago -- and tells React, so the fetch
   * layer can lift its gates on the same feeds (see the `focus` prop in
   * useOsintData.js). Cheap to call with an unchanged value: it returns before
   * doing any of that.
   */
  /**
   * A country's bounding box as (south, west, north, east), or null.
   *
   * Read from the hit-test index rather than the Leaflet layer, because the
   * index already holds a bbox per country (buildCountryIndex computes one to
   * reject points cheaply) and asking the layer would mean walking its geometry
   * again for a number that is sitting right there.
   */
  function boundsOfCountry(key) {
    const entry = countryIndex.find((c) => c.key === key);
    const b = entry?.bbox;
    return b ? [b.minLat, b.minLon, b.maxLat, b.maxLon] : null;
  }

  /**
   * Task 25's overpass prediction, for the country or water body `key`
   * names -- GET /api/satellites/passes?lat=&lon=&hours=24&groups=imaging
   * (see backend/sources/sat_passes.py for the two work caps this applies
   * and why), written into raw.satellitePasses[key] and then re-rendered
   * through whichever of the country/water cards is open, the same fetch-
   * then-store-in-raw-then-refresh-the-open-card shape loadDistrictSeries
   * already uses for the district trend fold (see that function's own
   * comment). Both refresh calls below are unconditional and each guards
   * itself (refreshFocusedCountryCard/refreshFocusedWaterCard are no-ops
   * when nothing of that kind is open) -- simpler than this function
   * having to know which of the two `key` belongs to.
   *
   * Refetched every call rather than cached forever: unlike a 24-month
   * conflict archive, a pass prediction is time-sensitive -- the same
   * place queried a minute later can have a different next pass -- so a
   * cached "ready" answer served on reselection would go stale exactly
   * the way Task 17's port-traffic fold already ruled out for its own
   * fetch (see loadPortTraffic's own note).
   *
   * Scoped to the "imaging" layer specifically -- the brief's own words are
   * "enabled imaging satellites" -- and only fetched when that layer is
   * actually switched on (satElementVisible.satImaging); otherwise the
   * section says so ("gated", not silently blank or stuck loading) rather
   * than hiding that there is a reason.
   *
   * `key` ("country:FRA", "water:482") is both the raw.satellitePasses key
   * and what satellitePassesGuard tracks, so a later request for a
   * *different* place landing before an earlier one resolves can never
   * overwrite that place's fresher data with the earlier place's stale
   * answer -- the same out-of-order protection loadVesselDetail/
   * loadPortTraffic give their own fetches above.
   */
  function loadSatellitePasses(key, lat, lon) {
    const publish = (entry) => {
      raw.satellitePasses = { ...raw.satellitePasses, [key]: entry };
      refreshFocusedCountryCard();
      refreshFocusedWaterCard();
    };
    if (!satElementVisible.satImaging || typeof lat !== "number" || typeof lon !== "number") {
      publish({ status: "gated" });
      return;
    }
    const token = satellitePassesGuard.start(key);
    publish({ status: "loading" });
    fetchJson(`/api/satellites/passes?lat=${lat}&lon=${lon}&hours=24&groups=imaging`)
      .then((data) => {
        if (!satellitePassesGuard.isCurrent(key, token)) return;
        publish({ status: "ready", data });
      })
      .catch(() => {
        if (!satellitePassesGuard.isCurrent(key, token)) return;
        publish({ status: "error" });
      });
  }

  /** Re-runs loadSatellitePasses for whichever country and/or water body is
   *  currently open -- called when the imaging layer's own visibility
   *  changes (see setLayerVisible's satImaging branch), so a card already
   *  showing "gated" (or a stale "ready" from before the layer was turned
   *  off) picks up the new state instead of sitting stale until the reader
   *  reselects the same place. A no-op for whichever of the two is not
   *  currently open, same as the publish() calls inside loadSatellitePasses
   *  itself. */
  function refreshSatellitePassesForOpenPlace() {
    if (focus?.kind === "country") {
      const bounds = boundsOfCountry(focus.key);
      const [lat, lon] = bounds ? boundsCentroid(bounds) : [null, null];
      loadSatellitePasses(`country:${focus.key}`, lat, lon);
    }
    if (selectedWaterId != null) {
      const entry = waterEntryFor(selectedWaterId);
      if (entry?.bbox) {
        const [lat, lon] = boundsCentroid([entry.bbox.minLat, entry.bbox.minLon, entry.bbox.maxLat, entry.bbox.maxLon]);
        loadSatellitePasses(`water:${selectedWaterId}`, lat, lon);
      }
    }
  }

  /** The centroid of a [south, west, north, east] bounds array -- an
   *  approximation of "over this place" a country or water body's own
   *  extent is generously bigger than, but the brief asks for a point to
   *  query passes for and a bounding box has no single better answer than
   *  its own middle.
   *
   *  A wrapped bbox (west > east) names two ranges, not an inverted box --
   *  west..180 and -180..east -- the same convention Task 4's water bodies
   *  established (`antimeridian`/`west > east` in their own stored bbox).
   *  Averaging west and east directly would land the centroid on the far
   *  side of the planet from the sliver either range actually covers (west
   *  170, east -170 averages to 0 -- the opposite side of the globe from
   *  the 20-degree strip straddling the seam that bbox actually names).
   *  Unwrapping east onto the same continuous line as west before
   *  averaging, then wrapping the sum back into [-180, 180], gives the
   *  true midpoint of the short arc through the seam instead. */
  function boundsCentroid([south, west, north, east]) {
    const lat = (south + north) / 2;
    const unwrappedEast = east < west ? east + 360 : east;
    let lon = (west + unwrappedEast) / 2;
    if (lon > 180) lon -= 360;
    return [lat, lon];
  }

  function setFocus(next) {
    const before = focus ? `${focus.kind}:${focus.key}` : "";
    const after = next ? `${next.kind}:${next.key}` : "";
    if (before === after) return;
    focus = next;
    // A collapsed cluster the reader had opened belongs to the view they opened
    // it in; carrying it across a change of subject would leave pins expanded
    // for a reason nobody could see.
    expandedClusters.clear();
    applyEmphasis();
    applyScene();
    renderAll();
    callbacks.onFocusChange?.(next);
    // Task 25: a country focus loads its card's overpass section here --
    // water selection does not go through setFocus at all (see selectWater's
    // own call to loadSatellitePasses) and a "layer" focus (a marker click,
    // the brief's third case, "a point") has no sidebar card to load a
    // section into at all -- see buildMarker's pointOverpassHtml/
    // loadPointSatellitePasses, wired from its own popupopen handler
    // instead, appended to the marker's own popup rather than a card.
    if (next?.kind === "country") {
      const bounds = boundsOfCountry(next.key);
      const [lat, lon] = bounds ? boundsCentroid(bounds) : [null, null];
      loadSatellitePasses(`country:${next.key}`, lat, lon);
    }
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
    if (key === "railways") return railwaysLayer; // wraps railwaysGroup (lines) + railwayPoints (stations)
    if (key === "railLive") return railLiveLayer; // wraps groups.railLive (trains) + groups.railStations
    if (key === "shippingLanes") return shippingLanesGroup;
    if (key === "water") return waterLayer;
    if (key === "windArrows") return windFlowLayer;
    if (key === "precip") return weatherLayers.precip;
    if (key === "clouds") return weatherLayers.clouds;
    if (key === "jamming") return jammingLayerWithPing;
    if (key === "laneDensity") return laneDensityLayer;
    if (key === "satellites") return satelliteGroup;
    if (key === "satNavigation") return satNavigationGroup;
    if (key === "satWeather") return satWeatherGroup;
    if (key === "satScience") return satScienceGroup;
    return groups[key];
  }

  // The five AIS/ADS-B bucket keys, plus Task 24's four bulk satellite
  // layers, route through entityWebglLayer's own per-bucket visibility
  // instead of a Leaflet layerForKey lookup -- see the comment where
  // entityWebglLayer is created above.
  const WEBGL_BUCKET_KEYS = new Set([
    "adsbCivilian", "adsbMilitary", "adsbFlagged", "aisCivilian", "aisNavy", "aisTanker",
    "satImaging", "satGeo", "satStarlink", "satOneweb",
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
    // Same arrangement, one layer over: the station/halt/yard/border points
    // live inside the combined "railways" layer and have no toggle of their
    // own -- see railwaysLayer's construction and LAYER_MANIFEST's own note.
    if (key === "railways") layerOnMap.railwayPoints = visible;
    // Same arrangement again, one layer over from railLive: the Finnish
    // station gazetteer has no toggle of its own either.
    if (key === "railLive") layerOnMap.railStations = visible;

    // Task 24: the seven client-propagated satellite layers. Deliberately
    // does not `return` -- satNavigation/satWeather/satScience still need
    // the generic layerForKey add/remove below (they are ordinary Leaflet
    // layerGroups), and satImaging/satGeo/satStarlink/satOneweb still need
    // the WEBGL_BUCKET_KEYS branch below to flip their bucket's own
    // visibility. This block only owns what those two paths don't know
    // about: satElementVisible (read by the tick/redraw loop, see
    // tickAndRedrawSatElements), the on-demand fetch for the four
    // default-off groups (see SAT_ELEMENT_ON_DEMAND_LAYERS above), and an
    // immediate catch-up render so switching a layer on shows something
    // before the next redraw tick rather than up to two seconds later.
    if (key in SAT_ELEMENT_CELESTRAK_GROUP) {
      satElementVisible[key] = visible;
      if (visible) {
        // navigation/weather/imaging are fetched by useOsintData.js's own
        // poller from boot regardless of this toggle (see POLL_CONFIG and
        // this controller's applyData dispatch) -- calling fetchSatElements
        // for them here as well would race that poller's own first fetch
        // with a second, redundant one.
        if (SAT_ELEMENT_ON_DEMAND_LAYERS.has(key)) fetchSatElements(key);
        renderSatElement(key); // catch up now rather than waiting for the next tick
      }
      // Task 25: imaging is what the overpass section is scoped to (see
      // loadSatellitePasses) -- flipping it on or off while a country/water
      // card is already open has to update that section immediately
      // ("gated" the moment it's switched off, a real fetch the moment it's
      // switched back on) rather than leaving it stale until the reader
      // reselects the same place.
      if (key === "satImaging") refreshSatellitePassesForOpenPlace();
    }

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

    // Water's own sub-toggles. Neither lakes nor rivers has a Leaflet layer of
    // its own to add or remove -- both ride the single `waterLayer` -- so, like
    // satellitesMilitary above, this re-renders in place instead of going
    // through layerForKey. The first time either is switched on, its geometry
    // has not been fetched at all (marine is the only kind the boot fetch
    // loads, see useOsintData.js), so this is also where that fetch happens --
    // once per session, not once per toggle; flipping the checkbox back on
    // after switching it off re-uses whatever already landed.
    if (key === "waterLakes") {
      waterLakesVisible = visible;
      if (visible && waterLakesFeatures == null) {
        waterLakesFeatures = []; // in flight -- guards against a double fetch from a fast double-click
        fetchJson("/api/water?kind=lakes")
          .then((data) => {
            waterLakesFeatures = data?.features || [];
            renderWater();
          })
          .catch((err) => {
            waterLakesFeatures = null; // let the next toggle retry rather than pin an empty layer
            console.warn("Failed to load lakes:", err);
          });
      }
      renderWater();
      return;
    }
    if (key === "waterRivers") {
      waterRiversVisible = visible;
      if (visible) maybeRefetchRivers();
      renderWater();
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
      // The uncertainty circles are the same claim as the pins, so they follow
      // the same toggle. Cleared rather than merely detached, on the same
      // reasoning as the trail toggles above: the circles are rebuilt from the
      // next render regardless, and keeping a few hundred detached paths alive
      // to re-attach is more state than they are worth.
      if (visible) {
        map.addLayer(uncertaintyLayer);
      } else {
        map.removeLayer(uncertaintyLayer);
        uncertaintyLayer.clearLayers();
        uncertaintyCircles.clear();
        refinementLines.clear();
      }
    }

    if (key === "countries") {
      countriesVisible = visible;
      if (!visible) setHoveredCountry(null);
      // addLayer above re-creates every path element from scratch, and the
      // selection/flare/editing classes were on the elements it just threw
      // away -- the state itself (selectedCountryKeys, the open card, a live
      // border session) is untouched, so without this the highlight stayed
      // gone until the next selection change wrote it again.
      else repaintCountryClasses();
    }

    if (key === "water") {
      waterVisible = visible;
      if (!visible) setHoveredWater(null);
      // Same reason as countries above: addLayer re-creates every path element
      // from scratch, throwing away whatever selection/hover class it carried,
      // so a water body already selected before the layer was switched off
      // needs its highlight repainted rather than left to the next click.
      else updateWaterHighlights();
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

    // Everything below is the same catch-up the satellites branch above has
    // always done, generalised: these renderers now return immediately while
    // their layer is off (see the guard at the top of each), so switching one
    // back on has to draw it rather than leave it empty until the reader
    // happens to pan. `visible` only -- switching off is what the early return
    // already handles.
    if (visible) {
      // The wind fetch is gated on this layer now, so a reader who switches it
      // on has no data at all until the next five-minute tick without this.
      if (key === "windArrows") refreshWindArrows();
      else if (key === "firms") renderFirms();
      else if (key === "jamming") renderJamming();
      else if (key === "laneDensity") renderLaneDensity();
      else if (key === "cities") renderCities();
      else if (key === "infra") renderInfra();
      else if (MARKER_LAYER_KEYS.has(key)) renderMarkerLayer(key);
    }

    // Both directions, unlike everything above. These two layers suppress OSM
    // features that duplicate them (see passesOsmInfraFilter), so switching one
    // off has to give those pins back and switching it on has to take them
    // again -- otherwise the airbase both feeds know about is missing from the
    // map until the reader happens to pan.
    if (key === "airports" || key === "dams") renderMarkerLayer("osmInfra");
  }

  // ---------- selection + trails ----------
  // AIS/ADS-B markers are Pixi sprites now (see entityWebglLayer), which
  // have no Leaflet bindPopup/marker.on("click") of their own -- these two
  // functions are what webglLayer.js's onSelect callback (wired below, in
  // renderAisLayer/renderAdsbLayer) calls instead, reproducing the same
  // toggle-select/seed-trail/open-popup/re-decorate behavior the old
  // marker-based handlers gave for free.

  // Fetch and draw an entity's recorded path, then let the live poll carry on
  // appending to the same array (see seedTrailFromTrack).
  //
  // Fire-and-forget rather than awaited: selection has to feel immediate, and
  // the live seed below has already drawn whatever this tab watched happen. The
  // recorded history arrives a moment later and extends it backwards.
  //
  // Guarded on the selection still being the same entity when the response
  // lands. A reader clicking through three aircraft in quick succession would
  // otherwise get the first one's track painted under the third one's pin.
  //
  // `onPoints`, when given, is handed the raw points array once the fetch has
  // settled -- an empty array on failure or on a genuinely empty response,
  // never skipped, so a caller using it for more than the trail (see
  // selectAircraft's onPoints callback below) can tell "checked, nothing
  // there" from "still loading" rather than waiting forever on a silent
  // failure. Ships don't pass it and see no change: the trail-only behaviour
  // below is exactly what ran before this parameter existed.
  async function loadRecordedTrack(kind, id, trailMap, maxPoints, stillSelected, redraw, onPoints) {
    let points = [];
    try {
      const data = await fetchJson(`/api/track/${kind}/${encodeURIComponent(id)}?points=${maxPoints}`);
      points = Array.isArray(data?.points) ? data.points : [];
    } catch {
      // A track is an enhancement to a trail that already draws. Failing loudly
      // here would put an error in front of a reader who just clicked a plane
      // and can already see where it has been since they did -- points stays
      // empty and onPoints below still gets called with that fact.
    }
    if (!stillSelected()) return;
    if (points.length) {
      seedTrailFromTrack(trailMap, id, points, maxPoints);
      redraw();
    }
    if (onPoints) onPoints(points);
  }

  // Fetches /api/vessel/{mmsi} (Task 17) and refreshes the open ship popup
  // once it lands. Never on the critical path of opening the popup: selectShip
  // has already drawn Identity/Voyage/Flags synchronously from the live AIS
  // record by the time this is called, so the Cargo and Port calls sections
  // arrive a moment later rather than delaying the popup itself.
  //
  // Unlike loadRecordedTrack's silent failure (a trail is an enhancement with
  // an existing line to fall back on), a failure here is recorded as a real
  // "error" state -- the brief requires the two new sections to say
  // "unavailable" rather than just not appear, since there is no earlier
  // render of them to fall back to.
  //
  // vesselDetailGuard (see above) guards against a second, narrower race
  // than stillSelected() covers: reselecting the *same* hull before an
  // earlier request for it has resolved. Both requests would pass
  // stillSelected() (selectedMmsi never stopped naming this mmsi), so
  // without the guard an out-of-order response could still overwrite the
  // popup with data older than what is already showing.
  async function loadVesselDetail(mmsi, item, stillSelected) {
    const token = vesselDetailGuard.start(mmsi);
    let entry;
    try {
      const data = await fetchJson(vesselDetailUrl(mmsi));
      entry = { status: "ready", data };
    } catch {
      entry = { status: "error" };
    }
    if (!vesselDetailGuard.isCurrent(mmsi, token) || !stillSelected() || !shipPopup) return;
    const d = decorateAis(item, { selectedMmsi, vesselDetail: entry });
    shipPopup.setContent(d.detail);
  }

  // Fetches /api/aircraft/{icao24} (Task 23) and hands the settled entry to
  // `onDetail` -- the same shape loadRecordedTrack hands its points to
  // onPoints, rather than writing the popup itself the way loadVesselDetail
  // does. It has to be a hand-off, not a direct write: selectAircraft below
  // already has a second fetch (the recorded track) racing to update the
  // very same popup, and each has to merge its own answer with whatever the
  // other last produced rather than one overwriting the other's section.
  //
  // Same "error" state on failure as loadVesselDetail, for the same reason:
  // the Route section has no earlier render to fall back to, so a failure
  // has to say "unavailable" rather than silently stay blank.
  async function loadAircraftDetail(icao24, stillSelected, onDetail) {
    let entry;
    try {
      const data = await fetchJson(aircraftDetailUrl(icao24));
      entry = { status: "ready", data };
    } catch {
      entry = { status: "error" };
    }
    if (!stillSelected()) return;
    onDetail(entry);
  }

  // Refreshes the open aircraft popup once /api/track/adsb/{icao} and/or
  // /api/aircraft/{icao24} answer, the same follow-up loadVesselDetail does
  // for the ship card (Task 17) -- except here there are two independent
  // fetches racing to update the same popup (the recorded track, for
  // decorateAdsb's vertical trend, and the flight-leg detail for its Route
  // section), so `latestTrack`/`latestFlightDetail` and the shared `refresh`
  // closure exist to merge whichever has landed so far into one re-render,
  // rather than the second fetch's callback clobbering the first's.
  //
  // aircraftTrackGuard/aircraftDetailGuard guard the same race
  // vesselDetailGuard does: reselecting the *same* icao24 before an earlier
  // request for it resolves must not let that earlier response land after
  // the later one and overwrite the popup with older data.
  function selectAircraft(item) {
    selectedIcao = selectedIcao === item.icao24 ? null : item.icao24;
    if (selectedIcao) {
      // Seed the trail right away instead of waiting for the next scheduled
      // poll -- otherwise the trail stayed empty until then, which just
      // looked like flight history didn't work.
      updateTrails(aircraftTrails, raw.adsb, "icao24", AIRCRAFT_TRAIL_MAX_POINTS, selectedIcao);
      const chosen = selectedIcao;
      // undefined until each fetch's own callback below sets it -- decorateAdsb
      // reads "still undefined" as "still fetching" for both.
      let latestTrack;
      let latestFlightDetail;
      const refresh = () => {
        if (selectedIcao !== chosen || !aircraftPopup) return;
        const d = decorateAdsb(item, { selectedIcao, track: latestTrack, flightDetail: latestFlightDetail });
        aircraftPopup.setContent(d.detail);
      };
      const trackToken = aircraftTrackGuard.start(chosen);
      loadRecordedTrack(
        "adsb", chosen, aircraftTrails, AIRCRAFT_TRAIL_MAX_POINTS,
        () => selectedIcao === chosen, renderAdsbLayer,
        (points) => {
          if (!aircraftTrackGuard.isCurrent(chosen, trackToken)) return;
          latestTrack = points;
          refresh();
        }
      );
      const detailToken = aircraftDetailGuard.start(chosen);
      loadAircraftDetail(chosen, () => selectedIcao === chosen, (entry) => {
        if (!aircraftDetailGuard.isCurrent(chosen, detailToken)) return;
        latestFlightDetail = entry;
        refresh();
      });
      // track/flightDetail are omitted (undefined) on this first, synchronous
      // render -- decorateAdsb reads that as "still fetching" and says so, the
      // same way vesselDetail starts undefined in selectShip below.
      const d = decorateAdsb(item, { selectedIcao });
      aircraftPopup = L.popup(popupOptions(320)).setLatLng([item.lat, item.lon]).setContent(d.detail).openOn(map);
    } else {
      aircraftTrails.clear();
      aircraftPopup = null;
      map.closePopup();
    }
    renderAdsbLayer(); // re-decorate every visible aircraft so the highlight moves
  }

  function selectShip(item) {
    selectedMmsi = selectedMmsi === item.mmsi ? null : item.mmsi;
    if (selectedMmsi) {
      updateTrails(shipTrails, raw.ais, "mmsi", SHIP_TRAIL_MAX_POINTS, selectedMmsi);
      const chosen = selectedMmsi;
      loadRecordedTrack(
        "ais", chosen, shipTrails, SHIP_TRAIL_MAX_POINTS,
        () => selectedMmsi === chosen, () => renderMarkerLayer("ais")
      );
      // vesselDetail is always undefined on this first render, whether or not
      // this hull's card has been opened before this tab: the brief requires
      // a real "loading" state on the way in, not a stale answer old enough
      // to read as current when it may not be (a laden verdict from an hour
      // ago on a hull that has since discharged, say) -- so this never reuses
      // a previous fetch, unlike the port card's cache below.
      const d = decorateAis(item, { selectedMmsi, vesselDetail: undefined });
      shipPopup = L.popup(popupOptions(320)).setLatLng([item.lat, item.lon]).setContent(d.detail).openOn(map);
      loadVesselDetail(chosen, item, () => selectedMmsi === chosen);
    } else {
      shipTrails.clear();
      shipPopup = null;
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
  // `key` places the marker's whole layer in the stack; the size term keeps the
  // existing behaviour inside that layer, where a small icon sits above a large
  // one so it stays clickable rather than being swallowed by its neighbour.
  // ---------- the seam ----------
  //
  // A web map repeats east-west for ever, so a stored longitude names infinitely
  // many points and only one of them is the one being looked at. See nearestLon
  // in utils/geo.js for the arithmetic; these three are every place the map has
  // to apply it.

  /**
   * A viewport test that knows the world repeats.
   *
   * Built once per render pass rather than per item: getBounds and getCenter are
   * both live reads off the map, and asking them ten thousand times a pan is
   * exactly the sort of thing that made pans jank before the placement pass was
   * batched. Also does the finite-coordinate check every caller used to do for
   * itself, so a record with no position is rejected in one place.
   */
  function viewportFilter() {
    const bounds = map.getBounds().pad(0.25);
    const refLon = map.getCenter().lng;
    return (lat, lon) => {
      if (typeof lat !== "number" || typeof lon !== "number") return false;
      return bounds.contains([lat, nearestLon(lon, refLon)]);
    };
  }

  /**
   * Where a record should actually be drawn, given where the camera is.
   *
   * `copy` is a multiple of 360 from worldCopies below -- 0, meaning the copy the
   * camera is on, for every caller that only draws one.
   */
  function drawLatLng(item, copy = 0) {
    return [item.lat, nearestLon(item.lon, map.getCenter().lng) + copy];
  }

  /**
   * drawLatLng for a short path: placed on the camera's copy, then shifted onto
   * `copy`. unwrapPath rather than a plain per-point nearestLon so a path that
   * happens to straddle the antimeridian is not drawn the long way round.
   */
  function drawPath(points, copy = 0) {
    return shiftPathLon(unwrapPath(points, map.getCenter().lng), copy);
  }

  /**
   * Which copies of the world the reader can see right now.
   *
   * The third seam question, alongside viewportFilter and drawLatLng. Those two
   * place a *point* on the copy being looked at, which is the right answer for a
   * marker: there is one ship and it belongs in one place. It is the wrong answer
   * for geometry that spans the whole globe. A submarine cable is not somewhere,
   * it is everywhere along its route, so when the basemap repeats and the cable
   * does not, the cable visibly stops at the edge of the primary copy while the
   * ocean under it carries on.
   *
   * See worldCopyOffsets in utils/geo.js. Returns `[0]` at every zoom where only
   * one copy is on screen, which is most of them -- so the layers below pay
   * nothing for this until the reader zooms out far enough to see the repeat.
   */
  function worldCopies() {
    const bounds = map.getBounds();
    return worldCopyOffsets(bounds.getWest(), bounds.getEast(), map.getCenter().lng);
  }

  /**
   * syncLayerMarkers, run across every copy of the world in view.
   *
   * The one place the marker layers learn that the world repeats. It expands the
   * per-record list the caller computed into one draw per (record, copy) and hands
   * the copy offset to the caller's build/update callbacks, which pass it on to
   * drawLatLng.
   *
   * Deliberately does NOT touch counts or the placement pass. Both work off the
   * caller's own per-record list, which is the honest unit: three pins on three
   * copies are one ship, so the panel says one, and the declutter pass reserves
   * room for it once. That is also why offsetFor is still keyed on the bare id --
   * every copy of a record shares its nudge, so the copies stay identical to each
   * other instead of drifting apart under a per-copy declutter.
   *
   * @param {Function} buildFn (item, copy) => Layer
   * @param {Function} updateFn (layer, item, copy) => void
   */
  function syncAcrossWorldCopies(markerMap, group, items, idFn, buildFn, updateFn) {
    syncLayerMarkers(
      markerMap,
      group,
      worldCopyDraws(items, worldCopies()),
      (d) => worldCopyKey(idFn(d.item), d.copy),
      (d) => buildFn(d.item, d.copy),
      (layer, d) => updateFn(layer, d.item, d.copy)
    );
  }

  /**
   * Visit each copy of the world a record actually lands on.
   *
   * The marker layers can afford to draw a record on every copy in view and let
   * Leaflet clip whatever falls outside; the heat layers cannot. FIRMS runs to
   * 100k+ points, and handing leaflet.heat three times that on every pan would
   * turn a layer that is currently cheap at world zoom into the most expensive
   * thing on the map -- for pixels that are off screen anyway.
   *
   * So this culls per copy: a record contributes to the copy under the camera and
   * to a neighbouring copy only where that neighbour's slice of it is really in
   * view. At the zoom where three copies are on screen the bounds span barely more
   * than one world, so the outer two copies each take a sliver rather than a whole
   * duplicate, and the total stays close to the single-copy cost.
   *
   * Built once per render pass, like viewportFilter, and deliberately
   * allocation-free per record: the bounds are read out as four numbers rather than
   * tested through LatLngBounds.contains, which would mint a LatLng per placement,
   * and the visitor is called rather than an array of copies returned.
   *
   * @returns {(lat: number, lon: number, visit: (drawLon: number, copy: number) => void) => void}
   */
  function worldCopyPlacements() {
    const raw = map.getBounds();
    // Latitude takes viewportFilter's usual proportional margin, so a point is
    // already drawn by the time it is panned to.
    const latPad = (raw.getNorth() - raw.getSouth()) * 0.25;
    // Longitude does not, and this is the whole economy of the heat layers.
    //
    // A proportional margin is fine while the viewport is a slice of the world and
    // absurd once it is wider than the world: at the zoom where three copies show,
    // the span is ~394 degrees and 25% of it is a ~98-degree margin on each side.
    // Measured against the real FIRMS feed that fed 362k placements for 225k points
    // -- a 1.6x bill, almost all of it margin nobody can see, on the heaviest layer
    // on the map. Capped, the same measurement lands near the 1.09x the geometry
    // actually requires (394 degrees of window over 360 of data; the points in the
    // overlap genuinely do appear twice, which is the entire feature).
    const lonSpan = raw.getEast() - raw.getWest();
    const lonPad = Math.min(lonSpan * 0.25, WORLD_COPY_LON_PAD_MAX_DEG);
    // The unpadded copy list, the same one the marker layers use, so the two can
    // never disagree about how many copies exist.
    return worldCopyPlacer(
      {
        south: raw.getSouth() - latPad,
        north: raw.getNorth() + latPad,
        west: raw.getWest() - lonPad,
        east: raw.getEast() + lonPad,
      },
      map.getCenter().lng,
      worldCopies()
    );
  }

  // What each whole-world layer was last drawn for, so a pan that does not change
  // which copies are on screen does not rebuild thousands of polylines. Cables
  // alone are 718 routes; at three copies that is over 2000, and rebuilding them
  // on every moveend is exactly the cost these layers were written to avoid by
  // drawing once. Keyed per layer rather than shared, because each is also
  // redrawn on its own when its data arrives (see applyData).
  const worldCopyKeys = { cables: null, pipelines: null, railways: null, shippingLanes: null };

  /**
   * Redraw the whole-world layers when, and only when, the visible copies change.
   *
   * Runs from renderAll on every moveend. Crossing from one copy to two is a
   * zoom-out or a pan that reveals the seam; everything else short-circuits on
   * the key comparison and costs a string compare per layer.
   */
  function renderWorldCopyLayers() {
    const key = worldCopies().join(",");
    if (worldCopyKeys.cables !== key) renderCables();
    if (worldCopyKeys.pipelines !== key) renderPipelines();
    if (worldCopyKeys.railways !== key) renderRailways();
    if (worldCopyKeys.shippingLanes !== key) renderShippingLanes();
  }

  function applyStacking(marker, size, key) {
    marker.setZIndexOffset(stackZIndex(key) - Math.round(size));
  }

  // Only the conflict layer carries a placement confidence, so only it can be
  // dimmed by one. Threaded through decorate rather than applied as a CSS class
  // because the icon's HTML string is the change test updateMarker uses -- a
  // dim applied outside that string would be undone by the next repaint.
  function dimmedFor(key, item) {
    return key === "events" && confidenceDimmed(item, eventFilter);
  }

  // The recorded-traffic record for an airfield pin, or null.
  //
  // Keyed on the OurAirports ident first: that is what adsb.py's proximity
  // index reports as `nearest_airfield.code`, and it is the only one of the
  // three that every field has (a grass strip has an ident but no ICAO or
  // IATA). The other two are tried after so a field whose ident happens to be
  // absent still matches.
  function airfieldActivityFor(item) {
    const table = raw.airfieldActivity || {};
    return table[item.id] || table[item.icao] || table[item.iata] || null;
  }

  // Everything a decorator may need beyond the item itself. Built in one place
  // because buildMarker and updateMarker must pass identical options -- the
  // icon's HTML string is the change test updateMarker compares against, so an
  // option supplied by one and not the other rebuilds every marker on the first
  // update after it is created.
  function decorateOptionsFor(key, item, id) {
    return {
      offset: offsetFor(key, id),
      dimmed: dimmedFor(key, item),
      activity: key === "airports" ? airfieldActivityFor(item) : undefined,
      // The OSM record this pin absorbed, so the popup can say so. Only ever
      // set for the two layers that absorb one, and undefined -- not null --
      // everywhere else: buildMarker and updateMarker compare the icon HTML
      // this produces, so the two must build the same object for the same pin.
      twin: key === "airports" ? osmTwins.airfieldTwinOf.get(String(item.id))
        : key === "dams" ? osmTwins.damTwinOf.get(String(item.id))
        : undefined,
      // Task 17's "recent arrivals and departures": whatever this port's
      // GET /api/vessel/port/{port_id} fetch currently knows, or undefined
      // before that fetch has ever run (see loadPortTraffic, wired to this
      // layer's popupopen below) -- decoratePort reads undefined as "loading".
      portDetail: key === "ports" ? portDetailCache.get(String(item.id)) : undefined,
    };
  }

  // Fetches /api/vessel/port/{port_id} (Task 17) every time a port's popup
  // opens, and calls `onUpdate` once it lands so the caller can re-render
  // whatever is currently showing. Matches loadVesselDetail's ship-side
  // sibling on purpose, not "cache for the session" as an earlier version of
  // this did: vessel_port_calls rows accrue continuously (a vessel can call
  // between one open and the next), so a cached "ready" answer served on
  // reopen would silently omit a new arrival -- the same silent-omission
  // failure the brief already rules out for the fetch-*failure* case,
  // recurring here on the success path if this were allowed to go stale. A
  // port's popup opens far less often than a track fetch already firing on
  // every ship selection, so refetching every time costs little.
  //
  // portTrafficGuard (see above) is what refetching-on-every-open needs
  // that the old cache-and-skip version got for free: close a port's popup
  // and reopen it before the first fetch resolves and two requests for the
  // same port_id are in flight together. Responses are not guaranteed to
  // arrive in request order, so without the guard an earlier request
  // landing after the later one would overwrite the fresher render with
  // staler data.
  async function loadPortTraffic(portId, onUpdate) {
    const token = portTrafficGuard.start(portId);
    portDetailCache.set(portId, { status: "loading" });
    let entry;
    try {
      const data = await fetchJson(portCallsUrl(portId));
      entry = { status: "ready", data };
    } catch {
      entry = { status: "error" };
    }
    if (!portTrafficGuard.isCurrent(portId, token)) return;
    portDetailCache.set(portId, entry);
    onUpdate();
  }

  /**
   * Stamp a divIcon with the layer it belongs to, so a stylesheet can dim every
   * other layer when the reader clicks one.
   *
   * Done here rather than by threading an extraClass through all nineteen
   * decorators, and it is free: buildDivIcon puts extraClass on the divIcon's
   * `className`, while updateMarker decides whether to rebuild a marker's DOM
   * by comparing `icon.options.html`. The class is not part of that string, so
   * adding it costs no repaints and changing the emphasis costs none either --
   * one attribute on the map container is the whole gesture.
   */
  function tagIconLayer(icon, key) {
    if (!icon?.options) return icon;
    const existing = icon.options.className || "";
    if (!existing.includes(`layer-${key}`)) icon.options.className = `${existing} layer-${key}`.trim();
    return icon;
  }

  // Task 25's overpass prediction for "a point" -- the brief's third
  // trigger, alongside country and water above. A marker click is this
  // app's only notion of a reader picking one specific point outside those
  // two (see buildMarker's own click handler below, the sole caller) --
  // review's Important 3 named this after an earlier draft dismissed it on
  // the grounds that a "layer" focus was not one of the three named cases,
  // which read the brief's "point" too narrowly: whatever the *reason* the
  // click set focus to "this layer", the click itself picked a specific
  // lat/lon, and that is the point the brief means.
  //
  // Appended to the marker's own popup content (via lazyDecorate below)
  // rather than opened as a second, independent L.popup: a marker already
  // owns the one popup slot a click opens (bindPopup's native open-on-
  // click), and a competing popup on the same click would immediately
  // supersede -- Leaflet's autoClose default -- the item detail the reader
  // actually clicked for, hiding it behind the overpass content instead of
  // adding to it. Keyed by rounded lat/lon (0.01 degrees, ~1km) rather than
  // per-marker, so two markers close enough to share a meaningful pass
  // search share one fetch instead of issuing a near-duplicate for each.
  const pointSatellitePasses = new Map();

  function pointOverpassKey(lat, lon) {
    return `${lat.toFixed(2)},${lon.toFixed(2)}`;
  }

  /** The overpass fold's HTML for one point, or "" when there is nothing to
   *  say -- no coordinate, or the imaging layer is switched off (appending
   *  a permanent "layer is off" notice to every point layer's popup on the
   *  map, the common case since imaging defaults on but plenty of readers
   *  will still have it off, would be clutter with nothing to act on; the
   *  country/water card's own section says so instead, where a reader has
   *  already opened a bigger card and a named reason is worth a line).
   *  Uses the popup variant (its own header) rather than the section
   *  variant this file also imports for country/water cards -- this is
   *  being appended to an existing marker popup, not slotted into a
   *  {title, html} section entry, so it needs a header of its own. `label`
   *  is the item's own name when it has one, so the header reads "over
   *  Rotterdam" rather than the less useful "over this location". */
  function pointOverpassHtml(lat, lon, label) {
    if (!satElementVisible.satImaging || typeof lat !== "number" || typeof lon !== "number") return "";
    const entry = pointSatellitePasses.get(pointOverpassKey(lat, lon));
    if (!entry) return ""; // not fetched yet -- the popupopen handler below starts it
    return satellitePassesPopupHtml(entry, label);
  }

  /** Starts (once per rounded point, for the session) the same
   *  GET /api/satellites/passes fetch loadSatellitePasses uses for
   *  country/water, storing the answer in pointSatellitePasses instead of
   *  raw.satellitePasses -- this is not card state React reads, only a
   *  Leaflet popup's own content function, so it does not need `raw`'s
   *  reactivity. `onUpdate` is always lazyDecorate's own popup.setContent
   *  call (see buildMarker) -- passed in rather than assumed, so this stays
   *  reusable regardless of which marker's popup happens to be open for
   *  this point right now.
   *
   *  Unlike loadSatellitePasses (refetched on every country/water
   *  selection, deliberately, since a prediction is time-sensitive), a
   *  point's answer is cached for the rest of the session rather than
   *  refetched on every popup reopen: a click layer can hold thousands of
   *  markers, several of which can legitimately round to the same point,
   *  and this is a secondary fold on an existing popup, not the primary
   *  reason the reader opened it -- the same "session-lifetime, never
   *  evicted" tradeoff this file already makes for portDetailCache and the
   *  generation guards' own key maps (see Task 17's interface note on
   *  that). A reader who wants a fresher answer for the same point can
   *  reselect the country or water body it sits inside instead. */
  function loadPointSatellitePasses(lat, lon, onUpdate) {
    const roundedKey = pointOverpassKey(lat, lon);
    if (pointSatellitePasses.has(roundedKey)) return; // already fetched this session, or in flight
    pointSatellitePasses.set(roundedKey, { status: "loading" });
    onUpdate();
    const guardKey = `point:${roundedKey}`;
    const token = satellitePassesGuard.start(guardKey);
    fetchJson(`/api/satellites/passes?lat=${lat}&lon=${lon}&hours=24&groups=imaging`)
      .then((data) => {
        if (!satellitePassesGuard.isCurrent(guardKey, token)) return;
        pointSatellitePasses.set(roundedKey, { status: "ready", data });
        onUpdate();
      })
      .catch(() => {
        if (!satellitePassesGuard.isCurrent(guardKey, token)) return;
        pointSatellitePasses.set(roundedKey, { status: "error" });
        onUpdate();
      });
  }

  function buildMarker(key, item, decorate, sizeOf, copy = 0) {
    const id = item[ID_FIELD[key]];
    const d = applyCollapsedFallback(decorate(item, decorateOptionsFor(key, item, id)), item);
    tagIconLayer(d.icon, key);
    const marker = L.marker(drawLatLng(item, copy), { icon: d.icon });
    // Clicking a pin says "this kind of thing". Everything else on the map
    // recedes, and the layers that corroborate this one become eligible -- so
    // clicking a tanker is how a reader reaches the dark-vessel record that is
    // a claim about tankers, without ever being handed that inference
    // unasked. See CORROBORATES in scene.js.
    marker.on("click", () => setFocus({ kind: "layer", key }));
    marker._item = item;
    marker._iconHtml = d.icon.options.html;
    applyStacking(marker, sizeOf(item), key);
    // Same options the icon was built from, so a popup opened on an airfield
    // shows the traffic its glyph was already sized by. Rebuilt per open rather
    // than captured, because the table behind it is refreshed on its own timer.
    const lazyOptions = () => ({ selectedIcao, selectedMmsi, ...decorateOptionsFor(key, marker._item, id) });
    // Through the same fallback as the icon above, or a collapsed head would
    // draw a count badge and then open a popup describing only itself. The
    // overpass fold is appended here, at the one place every caller of
    // lazyDecorate().detail already goes through (the popup binder below,
    // and the ports popupopen handler further down) -- appending it at
    // either call site alone would race the other's own re-render and
    // sometimes lose the suffix, the same clobbering hazard selectAircraft's
    // `refresh` closure guards against for its own two racing fetches.
    const lazyDecorate = () => {
      const base = applyCollapsedFallback(decorate(marker._item, lazyOptions()), marker._item);
      const label = typeof marker._item.name === "string" ? marker._item.name : undefined;
      return { ...base, detail: base.detail + pointOverpassHtml(marker._item.lat, marker._item.lon, label) };
    };
    marker.bindPopup(() => lazyDecorate().detail, popupOptions(320));
    marker.bindTooltip(() => lazyDecorate().tooltip, {
      className: "map-tooltip",
      direction: "top",
    });
    // Task 17's port-card traffic fold: kicked off on open rather than
    // fetched for every port up front, since there can be thousands of World
    // Port Index entries in view and a reader only ever looks at the one
    // they clicked. lazyOptions() re-reads portDetailCache on the way back
    // in, so once loadPortTraffic resolves, re-running the same popup
    // content function it is already bound to (lazyDecorate) picks up the
    // answer with no separate render path to keep in sync.
    if (key === "ports") {
      marker.on("popupopen", () => {
        loadPortTraffic(String(marker._item.id), () => {
          const popup = marker.getPopup();
          if (popup?.isOpen()) popup.setContent(lazyDecorate().detail);
        });
      });
    }
    // Task 25: every point layer's popup, not just ports -- the marker's
    // own lat/lon is "the point" the overpass search runs against.
    marker.on("popupopen", () => {
      if (typeof marker._item.lat !== "number" || typeof marker._item.lon !== "number") return;
      loadPointSatellitePasses(marker._item.lat, marker._item.lon, () => {
        const popup = marker.getPopup();
        if (popup?.isOpen()) popup.setContent(lazyDecorate().detail);
      });
    });
    return marker;
  }

  function updateMarker(marker, item, decorate, key, sizeOf, copy = 0) {
    const id = item[ID_FIELD[key]];
    const d = applyCollapsedFallback(decorate(item, {
      selectedIcao, selectedMmsi, ...decorateOptionsFor(key, item, id),
    }), item);
    tagIconLayer(d.icon, key);
    marker._item = item;
    marker.setLatLng(drawLatLng(item, copy));
    applyStacking(marker, sizeOf(item), key);
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
    satellites: 0,
    // Task 24: the seven client-propagated satellite layers.
    satNavigation: 0, satWeather: 0, satImaging: 0, satScience: 0, satGeo: 0, satStarlink: 0, satOneweb: 0,
    aisCivilian: 0, aisNavy: 0, aisTanker: 0, adsbCivilian: 0, adsbMilitary: 0,
    infraMilitary: 0, infraRefinery: 0, infraLng: 0, infraPort: 0, infraDesalination: 0,
    infraNuclear: 0, infraFab: 0, infraPipelineNode: 0, pipelineRoutes: 0,
    hazards: 0, hazardsQuake: 0, hazardsVolcano: 0,
    adsbFlagged: 0, adsbEmergency: 0, adsbHidden: 0, airports: 0,
    aisSanctioned: 0, adsbSanctioned: 0,
    darkVessels: 0, darkGaps: 0, darkSts: 0,
    cables: 0, cableLandings: 0, launches: 0, launchesUpcoming: 0,
    osmInfra: 0, osmMilitary: 0, osmPower: 0, osmBorder: 0,
    // Task 27: osmRailway's old lumped count is now this layer's own natural
    // count/total (railwayPoints is a real render key, not a sub-ticker of
    // osmInfra any more -- see LAYER_ITEM_FILTER's isRailwayPointItem).
    // railStations (fix, post-review) is the Finnish station gazetteer.
    railwayPoints: 0, railLive: 0, railStations: 0,
    outagePoints: 0, outageRegionPoints: 0,
    eventsVerified: 0, eventsDoubted: 0, eventsUnverified: 0,
    gfwGaps: 0, gfwDetections: 0, gfwDetMatched: 0, gfwDetUnmatched: 0,
    czib: 0, czibActive: 0, czibWithdrawn: 0,
    floods: 0, floodsCurrent: 0,
    ports: 0, portsOil: 0, dams: 0, damsLarge: 0,
    deflock: 0, railways: 0, shippingLanes: 0, laneDensity: 0,
    // How many ships/aircraft in the currently-loaded feed match the filter
    // bar's query -- read together with the matching *Total key (see totals
    // below) for the "N / total" figure next to each filter bar. Deliberately
    // not the same thing as e.g. aisCivilian/aisCivilianTotal above: those
    // are "on screen right now" vs. "in the whole feed", both already
    // viewport/zoom-scoped in the first case; this is "matches the typed
    // query" vs. "in the whole feed", neither scoped to the viewport, because
    // a reader typing a callsign wants to know how much of the fleet matches,
    // not how much of it happens to be on screen this instant.
    vesselFilterMatch: 0, aircraftFilterMatch: 0,
  };
  // Total number loaded from the backend for each layer, independent of the
  // current viewport/zoom filtering that `counts` reflects -- shown in the
  // UI as the "(total)" figure next to the live on-screen tick.
  const totals = {
    events: 0, firms: 0, gdelt: 0, officials: 0, countries: 0, cities: 0, infra: 0, jamming: 0,
    satellites: 0,
    satNavigation: 0, satWeather: 0, satImaging: 0, satScience: 0, satGeo: 0, satStarlink: 0, satOneweb: 0,
    aisCivilian: 0, aisNavy: 0, aisTanker: 0, adsbCivilian: 0, adsbMilitary: 0,
    infraMilitary: 0, infraRefinery: 0, infraLng: 0, infraPort: 0, infraDesalination: 0,
    infraNuclear: 0, infraFab: 0, infraPipelineNode: 0, pipelineRoutes: 0,
    hazards: 0, hazardsQuake: 0, hazardsVolcano: 0,
    adsbFlagged: 0, adsbEmergency: 0, adsbHidden: 0, airports: 0,
    aisSanctioned: 0, adsbSanctioned: 0,
    darkVessels: 0, darkGaps: 0, darkSts: 0,
    cables: 0, cableLandings: 0, launches: 0, launchesUpcoming: 0,
    osmInfra: 0, osmMilitary: 0, osmPower: 0, osmBorder: 0,
    // Task 27: osmRailway's old lumped count is now this layer's own natural
    // count/total (railwayPoints is a real render key, not a sub-ticker of
    // osmInfra any more -- see LAYER_ITEM_FILTER's isRailwayPointItem).
    // railStations (fix, post-review) is the Finnish station gazetteer.
    railwayPoints: 0, railLive: 0, railStations: 0,
    outagePoints: 0, outageRegionPoints: 0,
    eventsVerified: 0, eventsDoubted: 0, eventsUnverified: 0,
    gfwGaps: 0, gfwDetections: 0, gfwDetMatched: 0, gfwDetUnmatched: 0,
    czib: 0, czibActive: 0, czibWithdrawn: 0,
    floods: 0, floodsCurrent: 0,
    ports: 0, portsOil: 0, dams: 0, damsLarge: 0,
    deflock: 0, railways: 0, shippingLanes: 0, laneDensity: 0,
    // Reported as vesselFilterMatchTotal/aircraftFilterMatchTotal (see
    // reportCounts' *Total suffixing below) -- the denominator for the "N /
    // total" figure next to each filter bar. This is the whole loaded feed
    // (raw.ais.length / raw.adsb.length), the same scope counts.*Match above
    // is measured against.
    vesselFilterMatch: 0, aircraftFilterMatch: 0,
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
    gfwGaps: false, gfwDetections: false, floods: false, ports: false, dams: false,
    deflock: false, laneDensity: false, railwayPoints: false,
    // Task 24's three on-by-default, THEATRE-gated groups -- see
    // SAT_ELEMENT_ZOOM_NOTE_KEYS. The four off-by-default groups are
    // ungated and never report a note.
    satNavigation: false, satWeather: false, satImaging: false,
    // czib is deliberately absent: it has no gate, so it can never have a note.
    // Not a zoom gate but a band-dependent thinning, so it travels with the
    // rest: { [layerKey]: howManyKept } for every layer capByRank is currently
    // thinning, absent for every layer it is not.
    capped: {},
    // The same number for events alone. Kept because LayersSection and
    // useLeafletMap's EMPTY_ZOOM_NOTES read it, and generalising the cap should
    // not drag a UI change into the same commit.
    eventsCapped: 0,
    // Task 27 fix (post-review): which conflict-theatre keys osm_infra.py's
    // rail-line sweep hit MAX_RAIL_LINE_WAYS in, per the backend's own
    // "railways_osm" document (see osm_infra.serialize_rail_lines) -- a
    // truncated theatre must not read as a complete one, the same principle
    // `capped` above already carries for a band-thinned point layer.
    railwaysTruncated: [],
  };

  // Layers that report a breakdown as well as a total, so the control panel can
  // show a sub-ticker per category without a bespoke render function (the way
  // INFRA_TYPE_COUNT_KEY does for infrastructure). Each entry maps an item to
  // the counts key it rolls up into, or null to roll up into nothing.
  const LAYER_SUBCOUNT_KEY = {
    // What the pipeline concluded about each pin's *position*, as three
    // numbers. Not a filter and not a legend of colours -- a plain count, of
    // the kind that is otherwise only discoverable by opening pins one at a
    // time. It is worth stating up front because the answer is lopsided: almost
    // nothing on this layer has had its coordinate checked, and a reader has no
    // way to learn that from a map full of confident-looking dots.
    events: {
      keys: ["eventsVerified", "eventsDoubted", "eventsUnverified"],
      of: verdictBucket,
    },
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
        // Task 27: the four railway kinds moved to their own layer
        // (railwayPoints, with its own natural count) rather than a
        // sub-ticker here -- LAYER_ITEM_FILTER.osmInfra already excludes
        // them from this layer's *visible* set, and rolling them into
        // nothing here (rather than into osmMilitary) keeps this layer's
        // own *total* honest too: the totals loop below reads raw items
        // unfiltered, and a railway station is not a military site.
        if (typeof item.kind === "string" && item.kind.startsWith("railway_")) return null;
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
    gfwDetections: {
      keys: ["gfwDetMatched", "gfwDetUnmatched"],
      // The split that is the whole point of the layer: a matched detection is
      // a ship the AIS layer is already drawing, an unmatched one is a hull an
      // instrument saw with nothing in the transponder picture to pair it with.
      of: (item) => (item.matched ? "gfwDetMatched" : "gfwDetUnmatched"),
    },
    czib: {
      // Withdrawn bulletins are drawn, not filtered out -- so the honest way to
      // stop them reading as live warnings is to count them separately rather
      // than to hide them and leave the row saying 4 (33) with no explanation.
      keys: ["czibActive", "czibWithdrawn"],
      of: (item) => (item.active ? "czibActive" : "czibWithdrawn"),
    },
    floods: {
      // Most of what GDACS publishes at any moment is over. Closed events roll
      // up into nothing, the same way a flown launch does, so this ticker
      // answers "how many are actually happening".
      keys: ["floodsCurrent"],
      of: (item) => (item.is_current ? "floodsCurrent" : null),
    },
    ports: {
      keys: ["portsOil"],
      of: (item) => (item.oil_terminal ? "portsOil" : null),
    },
    dams: {
      keys: ["damsLarge"],
      // 100 million m3 is Global Dam Watch's own threshold, the one its release
      // notes count by -- not a cutoff this app invented.
      of: (item) => (Number(item.capacity_mcm) >= 100 ? "damsLarge" : null),
    },
    // gfwGaps deliberately has none. intentional_disabling is true on every row
    // in the feed, so a ticker reading "19,976 of 19,976 judged deliberate"
    // would describe GFW's inclusion criterion rather than distinguish anything.
    // It is said once, in the layer's fold.
  };
  function reportCounts() {
    const totalsSuffixed = {};
    for (const key of Object.keys(totals)) totalsSuffixed[`${key}Total`] = totals[key];
    callbacks.onCountsChange?.({ ...counts, ...totalsSuffixed });
  }
  function reportZoomNotes() { callbacks.onZoomNotesChange?.({ ...zoomNotes }); }

  // Every layer renderer used to call the two functions above directly, and
  // renderAll runs about twenty-five of them -- so a single pan pushed
  // twenty-five fresh objects into React state, each one re-rendering the whole
  // control panel (LayersSection alone is ~34 checkbox rows) for numbers that
  // were about to be superseded a microsecond later. Only the last one of each
  // was ever worth anything.
  //
  // Renderers now mark what changed and the flush happens once. A microtask
  // rather than a rAF on purpose: the boot sweep runs synchronously before the
  // first paint and has to deliver its counts in the same turn, and useReplay
  // pushes whole snapshots through applyData in bursts that must not straddle a
  // frame. renderAll flushes explicitly at its end (see below) so a full render
  // pass lands in one React commit; the microtask is the safety net for the
  // renderers that are called on their own.
  let reportsDirtyCounts = false;
  let reportsDirtyNotes = false;
  let reportsFlushQueued = false;
  function scheduleReports({ counts: wantCounts, notes: wantNotes } = {}) {
    if (wantCounts) reportsDirtyCounts = true;
    if (wantNotes) reportsDirtyNotes = true;
    if (reportsFlushQueued) return;
    reportsFlushQueued = true;
    queueMicrotask(() => {
      reportsFlushQueued = false;
      flushReports();
    });
  }
  function flushReports() {
    if (reportsDirtyCounts) {
      reportsDirtyCounts = false;
      reportCounts();
    }
    if (reportsDirtyNotes) {
      reportsDirtyNotes = false;
      reportZoomNotes();
    }
  }

  /**
   * True when this layer is off the map, in which case its renderer should stop
   * here.
   *
   * Every renderer used to run in full whether or not its layer was on the map:
   * filtering the whole feed to the viewport, decorating each survivor, diffing
   * it against the marker map and building real DOM elements inside a
   * layerGroup nobody could see. On a default session that is most of the
   * layers, on every pan. renderSatellites was the one renderer that already
   * returned early; this is that idea, given a name and applied to the rest.
   *
   * The counts still have to be honest, which is the whole reason this is a
   * helper rather than a bare `return`. `counts[key] = 0` says nothing is
   * drawn, and `totals[key]` keeps saying how many the feed holds -- that pair
   * is what lets an operator tell "the layer is off" from "the feed is dead",
   * and collapsing them into one number would take that away. The sub-tickers
   * have to be zeroed with the parent for the same reason: a row reading
   * "0 sites (3 military, 2 refinery)" is worse than either number alone. The
   * empty placement registration matters for the reason settlePlacement gives:
   * a hidden layer must not reserve screen space that shoves visible icons
   * around.
   */
  function skipHiddenLayer(key) {
    if (layerOnMap[key] !== false) return false;
    counts[key] = 0;
    for (const subKey of LAYER_SUBCOUNT_KEY[key]?.keys || []) counts[subKey] = 0;
    // Infrastructure predates LAYER_SUBCOUNT_KEY and keeps its own table.
    // counts.pipelineRoutes is deliberately left alone: it is how many routes
    // are loaded rather than how many are on screen (renderPipelines is not
    // viewport-filtered), so zeroing it here would answer a different question
    // from the one it is asked.
    if (key === "infra") {
      for (const subKey of Object.values(INFRA_TYPE_COUNT_KEY)) counts[subKey] = 0;
    }
    const items = raw[key];
    if (Array.isArray(items)) totals[key] = items.length;
    registerPlacement(key, []);
    scheduleReports({ counts: true });
    return true;
  }

  // The current zoom, handed to React so the fetch layer can hold off on
  // sources that are pointless above a certain height (see POLL_CONFIG's
  // minZoom in useOsintData.js). Reported only on an actual change: this runs
  // on every moveend, and a pan is not a zoom.
  let lastReportedZoom = null;
  function reportZoom() {
    const zoom = map.getZoom();
    if (zoom === lastReportedZoom) return;
    lastReportedZoom = zoom;
    callbacks.onZoomChange?.(zoom);
  }

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
    events: 100, infra: 80, satellites: 70,
    // Task 24's three DOM-marker groups sit just under the server-propagated
    // pair above -- same class of object, same reasoning, one step lower so
    // stations/military (this map's own SGP4) never lose their pixel to an
    // element-set-only object if the two ever land on the same spot.
    satNavigation: 69, satWeather: 69, satScience: 69,
    aisNavy: 65, adsbMilitary: 65,
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
    // The strongest maritime coordinate on this map, and the only one that is a
    // measurement rather than a broadcast or an inference: it outranks every
    // guess drawn near it. Below conflict events, which is the layer this map
    // is primarily for.
    gfwDetections: 97,
    // Directly under darkVessels: the same class of claim -- a real last-known
    // position that an inference is drawn from -- but arriving five or more days
    // late, so where the two want the same pixel the live one holds it.
    gfwGaps: 93,
    // Below the curated infrastructure list it sits beside, because 85% of these
    // coordinates are snapped to a river network rather than published for the
    // structure. Far above osmInfra all the same: this is a peer-reviewed
    // dataset that grades its own rows, not crowd-sourced geometry.
    dams: 75,
    // Below hazards, above news. A quake epicentre is an instrument solution
    // worth defending; a GLOFAS basin centroid is a modelled point with no true
    // position to defend. Above machine-coded reporting because it is still a
    // structured publisher record.
    floods: 41,
    // Below outage pins, above airfields. Both are country-precision drawing
    // decisions, but an outage pin is at least placed by the country's own
    // geometry -- this one sits at the population-weighted mean of the country's
    // towns, which is even less about the airspace the bulletin covers.
    czib: 7,
    // Just above airfields. Not tied with them because the Dark Vessels layer's
    // ship-to-ship popup says the pair is away from any port on the curated
    // list, and a port pin nudged off its own harbour would visually contradict
    // the pin making the claim.
    ports: 6,
    // Below every layer whose coordinate means something. An outage pin's
    // position is a drawing decision, not a measurement (see decorateOutage),
    // so where two pins want the same pixel this is the one that should move.
    outagePoints: 8,
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

  // Only the layers with a renderer of their own are named. Everything else in
  // placementInput is a plain marker layer and goes to the generic renderer --
  // as a fallback rather than a list, because the list silently rotted: it was
  // written when this map had six point layers, and officials, hazards,
  // airports, cableLandings, darkVessels, czib, dams, floods, gfwGaps,
  // gfwDetections, launches, osmInfra, outagePoints and ports were all added
  // afterwards. Each of those registered placement input, was duly marked dirty
  // by settlePlacement, and then fell off the end of this function without being
  // repainted -- so their declutter offsets only landed if some later renderAll
  // happened to run. That made "do these pins separate or sit on top of each
  // other" depend on render ordering, which is why it looked intermittent.
  function redrawLayerGroup(group) {
    if (group === "infra") renderInfra();
    else if (group === "satellites") renderSatellites();
    else if (group === "satNavigation" || group === "satWeather" || group === "satScience") {
      renderSatElementLayer(group);
    }
    else if (group === "cities") renderCities();
    else if (group === "ais") renderAisLayer();
    else if (group === "adsb") renderAdsbLayer();
    else renderMarkerLayer(group);
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

  // ---------- placement uncertainty ----------
  //
  // The circle is only worth drawing inside a legibility window, and the window
  // has to be measured in screen pixels rather than zoom levels because the
  // radii in the data differ by a factor of 27 (locality 15 km, region 120,
  // country 400). A single zoom gate tuned for the 400 km discs would hide
  // every 15 km one at the zoom where it finally means something.
  //
  // Under the floor the circle is a smudge beneath its own pin and says
  // nothing. Over the ceiling it is a wash across the viewport with no readable
  // edge -- at that point the popup's "could be up to 400 km away" is the
  // honest way to say it, and the circle is just paint over other layers.
  const UNCERTAINTY_MIN_PX = 10;
  const UNCERTAINTY_MAX_VIEWPORT_FRACTION = 0.45;

  // Metres to screen pixels along the parallel at `lat`, at the current zoom.
  // Guarded near the poles, where the cosine goes to zero and a finite distance
  // stops having a finite longitude span -- Infinity there puts the circle over
  // the ceiling, which hides it, which is the right answer.
  function metresToPixels(lat, metres) {
    const cos = Math.cos((lat * Math.PI) / 180);
    if (!(cos > 0.01)) return Infinity;
    const zoom = map.getZoom();
    const a = map.project([lat, 0], zoom);
    const b = map.project([lat, metres / (111320 * cos)], zoom);
    return Math.abs(b.x - a.x);
  }

  function uncertaintyOnScreen(item) {
    if (!positionUncertain(item)) return false;
    const metres = uncertaintyRadiusMetres(item);
    if (metres === null) return false;
    const px = metresToPixels(item.lat, metres);
    if (px < UNCERTAINTY_MIN_PX) return false;
    const size = map.getSize();
    return px <= Math.min(size.x, size.y) * UNCERTAINTY_MAX_VIEWPORT_FRACTION;
  }

  // Severity's own colour, so a reader can tell which circle belongs to which
  // pin when two overlap. Deliberately not given a palette token of its own: an
  // override would let a circle and its pin disagree about the same event.
  function uncertaintyStyle(item) {
    const color = severityColor(severityBand(Number.isFinite(item.severity) ? item.severity : 0));
    return {
      pane: "uncertaintyPane",
      interactive: false,
      color,
      weight: 1,
      opacity: 0.45,
      dashArray: "5 5",
      fillColor: color,
      fillOpacity: 0.05,
    };
  }

  // Straight-line distance between two positions in screen pixels at the
  // current zoom -- the honest measure for "is this worth drawing", since both
  // ends are real coordinates rather than a radius along one bearing.
  function pixelSpan(a, b) {
    const zoom = map.getZoom();
    return map.project(a, zoom).distanceTo(map.project(b, zoom));
  }

  // The one visual that shows the pipeline correcting itself: where geoverify
  // moved a pin, a line back to where the source originally put it.
  //
  // Only for "refined". A "contested" pin has deliberately *not* been moved
  // (see geoverify.py and VERDICT_NOTE) -- there is no second position, and
  // drawing a line to one would assert the opposite of what the verdict says.
  function refinementOnScreen(item) {
    if (item.geo_verdict !== "refined") return false;
    if (!Number.isFinite(item.original_lat) || !Number.isFinite(item.original_lon)) return false;
    // Under the floor the line is a dot under its own pin.
    return pixelSpan([item.lat, item.lon], [item.original_lat, item.original_lon]) >= UNCERTAINTY_MIN_PX;
  }

  function refinementPath(item) {
    return [[item.original_lat, item.original_lon], [item.lat, item.lon]];
  }

  const REFINEMENT_STYLE = {
    pane: "uncertaintyPane",
    interactive: false,
    color: "#6fe3ff",
    weight: 1,
    opacity: 0.55,
    dashArray: "2 4",
  };

  function renderEventUncertainty(visible) {
    const live = layerOnMap.events ? visible : [];
    // Both ride on the events pins, so they repeat with them -- a pin drawn on a
    // copy of the world with its uncertainty disc left behind on another would
    // assert a precision the pin itself disclaims.
    syncAcrossWorldCopies(
      uncertaintyCircles,
      uncertaintyLayer,
      live.filter(uncertaintyOnScreen),
      (item) => item[ID_FIELD.events],
      // Built through drawLatLng rather than the raw coordinate: the raw lon put
      // the disc in the primary copy on its first frame and only the update below
      // ever moved it onto the camera's.
      (item, copy) => L.circle(drawLatLng(item, copy), {
        ...uncertaintyStyle(item),
        radius: uncertaintyRadiusMetres(item),
      }),
      (circle, item, copy) => {
        circle.setLatLng(drawLatLng(item, copy));
        circle.setRadius(uncertaintyRadiusMetres(item));
        circle.setStyle(uncertaintyStyle(item));
      }
    );
    syncAcrossWorldCopies(
      refinementLines,
      uncertaintyLayer,
      live.filter(refinementOnScreen),
      (item) => item[ID_FIELD.events],
      (item, copy) => L.polyline(drawPath(refinementPath(item), copy), REFINEMENT_STYLE),
      (line, item, copy) => line.setLatLngs(drawPath(refinementPath(item), copy))
    );
  }

  // Dark-ship reachability geometry (Task 21): the went-dark -> resumed line
  // (ais_gap and gfw_gaps records both carry resumed_lat/resumed_lon once
  // their gap has closed) and, for ais_gap records only, the 50/80/95%
  // contour bands backend/sources/dark_vessels.py builds around the
  // dead-reckoned point -- see that module's docstring for the model.
  //
  // Drawn as children of `groups[key]` itself (with `pane: "uncertaintyPane"`
  // set per-shape, not on a wrapping group of its own) rather than in a
  // separate layer -- Leaflet resolves each child's pane independently of
  // which LayerGroup manages its add/remove, so this rides the same
  // map.addLayer/removeLayer toggle darkVessels/gfwGaps already have for
  // free, and the last-known pin -- a plain marker in the default pane --
  // keeps drawing on top of both without anything here having to order that.
  function reachLineStyle() {
    return {
      pane: "uncertaintyPane", interactive: false,
      color: reachContourColor(), weight: 1, opacity: 0.5, dashArray: "2 4",
    };
  }
  // Faintest for the widest band, so the three overlapping polygons read as
  // one gradient rather than three flat washes stacked on each other.
  const REACH_CONTOUR_OPACITY = { 50: [0.6, 0.16], 80: [0.4, 0.09], 95: [0.25, 0.04] };
  function reachContourStyle(percentile) {
    const color = reachContourColor();
    const [stroke, fill] = REACH_CONTOUR_OPACITY[percentile] || REACH_CONTOUR_OPACITY[95];
    return {
      pane: "uncertaintyPane", interactive: false,
      color, weight: 1, opacity: stroke, dashArray: "4 4", fillColor: color, fillOpacity: fill,
    };
  }
  function paintReachShape(group, item, copy) {
    const ends = reachLineEnds(item);
    if (ends) L.polyline(drawPath(ends, copy), reachLineStyle()).addTo(group);
    for (const { percentile, points } of reachContourRings(item)) {
      L.polygon(drawPath(points, copy), reachContourStyle(percentile)).addTo(group);
    }
  }
  function buildReachShape(item, copy) {
    const group = L.layerGroup();
    paintReachShape(group, item, copy);
    return group;
  }
  function updateReachShape(group, item, copy) {
    group.clearLayers();
    paintReachShape(group, item, copy);
  }
  function renderReachGeometry(key, shapeMap, visible) {
    syncAcrossWorldCopies(
      shapeMap,
      groups[key],
      visible.filter(reachOnScreen),
      (item) => item[ID_FIELD[key]],
      buildReachShape,
      updateReachShape
    );
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
    if (skipHiddenLayer(key)) return;
    const group = groups[key];
    const decorate = DECORATORS[key];
    // Airfields are the one layer whose size depends on data outside the item.
    // The placement pass reserves whatever sizeOf returns, so it has to be given
    // the same activity record the glyph is drawn from -- otherwise a field
    // enlarged to 1.7x would be routed around a base-size hole, which is the
    // exact mismatch the note at the top of decorators.js warns about.
    const sizeOf = key === "airports"
      ? (item) => airportIconSize(item, airfieldActivityFor(item))
      : ICON_SIZE_FOR[key];
    const inView = viewportFilter();
    const idField = ID_FIELD[key];
    const zoom = map.getZoom();
    const minZoom = minZoomFor(key);
    const belowMinZoom = minZoom != null && zoom < minZoom;
    if (minZoom != null) {
      zoomNotes[key] = belowMinZoom;
      scheduleReports({ notes: true });
    }
    const itemFilter = LAYER_ITEM_FILTER[key];
    // Only asked when some pin type in this layer has been given a zoom of its
    // own, which is the uncommon case -- see pinDrawsAt.
    const perPinZoom = layerHasTokenZoom(key) || layerHasTokenZoomMax(key);
    // `|| []` because a source can hand us nothing: /api/replay omits a key
    // entirely when it has no history for it, and an undefined here used to
    // take the whole render down rather than drawing an empty layer.
    const items = raw[key] || [];
    let visible = [];
    if (!belowMinZoom) {
      for (const item of items) {
        if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;
        if (!inView(item.lat, item.lon)) continue;
        if (itemFilter && !itemFilter(item)) continue;
        if (perPinZoom && !pinDrawsAt(key, item, zoom, minZoom)) continue;
        visible.push(item);
      }
    }
    // Cap first, then group: capping decides what is worth drawing at all, and
    // grouping decides how to draw what survived. The other order would let a
    // group form around a head that the cap then removed.
    visible = capByRank(key, visible);
    // After the cap, so a circle can never outlive the pin it belongs to.
    if (key === "events") renderEventUncertainty(visible);
    if (key === "darkVessels") renderReachGeometry(key, darkVesselReachShapes, visible);
    if (key === "gfwGaps") renderReachGeometry(key, gfwGapReachShapes, visible);
    visible = collapseFor(key, visible, map.getZoom());
    registerPlacement(
      key,
      visible.map((item) => ({ id: item[idField], lat: item.lat, lon: item.lon, size: sizeOf(item) }))
    );
    syncAcrossWorldCopies(
      markersByKey[key],
      group,
      visible,
      (item) => item[idField],
      (item, copy) => buildMarker(key, item, decorate, sizeOf, copy),
      (marker, item, copy) => updateMarker(marker, item, decorate, key, sizeOf, copy)
    );
    // `visible` is per record, not per drawn marker, so a reader zooming out until
    // the world repeats does not watch every ticker triple.
    counts[key] = visible.length;
    totals[key] = items.length;
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
      for (const item of items) {
        const bucket = subcount.of(item);
        if (bucket) totals[bucket] += 1;
      }
    }
    scheduleReports({ counts: true });
    settlePlacement();
  }

  // Navy/MSC ships (USS/USNS) always render, ignoring the AIS zoom gate,
  // same exemption renderAdsbLayer already gives military aircraft.
  function renderAisLayer() {
    const decorate = DECORATORS.ais;
    const inView = viewportFilter();
    // Civilian and tanker share a shipped gate but read it separately, so an
    // Admin Mode override on one does not silently move the other.
    const zoom = map.getZoom();
    const belowAisMinZoom = zoom < (minZoomFor("aisCivilian") ?? -Infinity);
    const belowTankerMinZoom = zoom < (minZoomFor("aisTanker") ?? -Infinity);
    zoomNotes.ais = belowAisMinZoom;
    scheduleReports({ notes: true });

    // Tankers get their own ticker/layer (see createTankerAisGroup) instead
    // of being mixed into "Civilian Ships" -- three-way split on the same
    // classifyShip() decorators.js already uses to pick the marker icon/color.
    // Exactly one pin type per bucket, so the per-pin gate is read once here
    // rather than per hull: the split below has already done the classifying
    // that pinZoomGate would otherwise repeat ten thousand times.
    const belowNavyPinZoom = zoom < (tokenZoom("ship.navy") ?? -Infinity);
    const belowTankerPinZoom = zoom < (tokenZoom("ship.tanker") ?? -Infinity);
    const belowCivilianPinZoom = zoom < (tokenZoom("ship.other") ?? -Infinity);

    // The filter bar's free text/prefix and sanctions/watchlist flags (Task
    // 18), applied before the class split below rather than after: a ship
    // the filter rejects must never reach any of the three buckets, which is
    // what "combines with the existing class filters" means -- the class
    // toggles and the sanction ring still apply to whatever the filter left,
    // exactly as if the rejected ships were never in the feed. filterVessels
    // returns a new array (raw.ais itself is never touched), which is the
    // "shortening the list before it reaches updateEntities" webglLayer.js
    // needs -- the loop below narrows that list further, by viewport/zoom/
    // class, but every ship it starts from has already passed the filter.
    const filteredAis = filterVessels(raw.ais, vesselFilter);
    // Deliberately not scoped to the viewport or zoom gates below -- see the
    // note on counts.vesselFilterMatch in its initial-value block: a reader
    // typing a callsign wants to know how much of the whole feed matches,
    // not how much of it happens to be on screen this instant.
    counts.vesselFilterMatch = filteredAis.length;
    totals.vesselFilterMatch = raw.ais.length;

    let civilianVisible = [];
    const tankerVisible = [];
    const navyVisible = [];
    for (const item of filteredAis) {
      if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;
      if (!inView(item.lat, item.lon)) continue;
      const type = classifyShip(item);
      if (type === "navy") {
        if (!belowNavyPinZoom) navyVisible.push(item);
      } else if (type === "tanker") {
        if (!belowTankerMinZoom && !belowTankerPinZoom) tankerVisible.push(item);
      } else if (!belowAisMinZoom && !belowCivilianPinZoom) {
        civilianVisible.push(item);
      }
    }
    // Only the anonymous bucket is thinned. Navy hulls and designated tankers
    // are what this layer is for and neither is dense enough to need it; a
    // sanctioned merchant hull is lifted clear of the cap for the same reason.
    civilianVisible = capByRank("aisCivilian", civilianVisible, nearestToCentreRank(isSanctioned));

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
    scheduleReports({ counts: true });
    settlePlacement();
    // Extend the selected ship's trail on every render, not just at the
    // moment it was clicked. updateTrails appends at most one point per
    // call, so seeding it once in selectShip() left the trail permanently
    // one point long -- and renderTrailLayer skips anything under two
    // points, so a selected ship's trail could never draw at all.
    if (selectedMmsi) updateTrails(shipTrails, raw.ais, "mmsi", SHIP_TRAIL_MAX_POINTS, selectedMmsi);
    renderTrailLayer(shipTrailsLayer, shipTrails, "#35c2ff", selectedMmsi ? new Set([selectedMmsi]) : new Set(), { refLon: map.getCenter().lng, copies: worldCopies(), layerKey: "aisCivilian" });

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
        refLon: map.getCenter().lng,
        copies: worldCopies(),
        layerKey: "aisTanker",
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
    const inView = viewportFilter();
    const belowAdsbMinZoom = map.getZoom() < (minZoomFor("adsbCivilian") ?? -Infinity);
    zoomNotes.adsb = belowAdsbMinZoom;
    scheduleReports({ notes: true });

    /**
     * Which always-on status an aircraft carries right now, or null.
     *
     * Not simply aircraftFlagBucket: two of the three statuses earn the
     * ungated bucket at every zoom and the third does not. An emergency squawk
     * and an OFAC designation are facts about a flight and an operator; a LADD
     * or PIA listing is a fact about a registry entry, and it was riding the
     * other two's argument to a world-zoom pin. Below its own gate the aircraft
     * reads as unflagged and falls through to the class it actually belongs to
     * -- so a display-limited military airframe keeps drawing at every zoom.
     */
    const belowHiddenMinZoom = map.getZoom() < (minZoomFor("adsbDisplayLimited") ?? -Infinity);
    const flagOf = (item) => {
      const flag = aircraftFlagBucket(item);
      return flag === "displayLimited" && belowHiddenMinZoom ? null : flag;
    };

    // Per-pin gates, asked per aircraft because a single bucket holds several
    // pin types -- an airliner, a helicopter and a light aircraft all land in
    // "adsbCivilian". The layer key each one answers to is the bucket it was
    // sorted into, so the classification below decides both.
    const zoom = map.getZoom();
    const civilianPerPin = (layerHasTokenZoom("adsbCivilian") || layerHasTokenZoomMax("adsbCivilian"));
    const militaryPerPin = (layerHasTokenZoom("adsbMilitary") || layerHasTokenZoomMax("adsbMilitary"));
    const flaggedPerPin = (layerHasTokenZoom("adsbFlagged") || layerHasTokenZoomMax("adsbFlagged"));

    // Same shape as renderAisLayer's filteredAis above: a real array-level
    // filter, applied before the flagged/military/civilian split, so every
    // aircraft the loop below sees has already passed it. Counted over the
    // whole raw feed regardless of viewport or zoom -- see
    // counts.aircraftFilterMatch's own note in its initial-value block.
    const filteredAdsb = filterAircraft(raw.adsb, aircraftFilter);
    counts.aircraftFilterMatch = filteredAdsb.length;
    totals.aircraftFilterMatch = raw.adsb.length;

    let civilianVisible = [];
    const militaryVisible = [];
    // Aircraft squawking an emergency code, or listed under LADD/PIA, get their
    // own bucket rather than staying in whichever class they belong to. Two
    // reasons, and both are about not losing the signal: civilian aircraft are
    // off by default, so a 7700 on an airliner would be invisible; and the
    // bucket has no zoom gate, because "somewhere in the world an aircraft is
    // squawking 7500" is worth seeing at world zoom.
    const flaggedVisible = [];
    for (const item of filteredAdsb) {
      if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;
      if (!inView(item.lat, item.lon)) continue;
      if (flagOf(item)) {
        if (!flaggedPerPin || pinDrawsAt("adsbFlagged", item, zoom, minZoomFor("adsbFlagged"))) {
          flaggedVisible.push(item);
        }
      } else if (classifyAircraft(item) === "military") {
        if (!militaryPerPin || pinDrawsAt("adsbMilitary", item, zoom, minZoomFor("adsbMilitary"))) {
          militaryVisible.push(item);
        }
      } else if (!belowAdsbMinZoom) {
        if (!civilianPerPin || pinDrawsAt("adsbCivilian", item, zoom, minZoomFor("adsbCivilian"))) {
          civilianVisible.push(item);
        }
      }
    }
    // Only the anonymous bucket. Military and flagged aircraft are uncapped --
    // they are why this layer exists -- and the flagged split above has already
    // lifted every emergency, display-limited and designated airframe out of
    // here, so nothing that needs keeping is left to a distance rank.
    civilianVisible = capByRank("adsbCivilian", civilianVisible, nearestToCentreRank());

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
    for (const item of flaggedVisible) counts[AIRCRAFT_FLAG_COUNT_KEY[flagOf(item)]] += 1;
    totals.adsbCivilian = 0;
    totals.adsbMilitary = 0;
    totals.adsbFlagged = 0;
    totals.adsbEmergency = 0;
    totals.adsbHidden = 0;
    totals.adsbSanctioned = 0;
    for (const item of raw.adsb) {
      // flagOf, not aircraftFlagBucket: the totals have to split the feed the
      // same way the render does, or below the display-limited gate the panel
      // would show a bucket holding more aircraft on screen than exist in the
      // feed -- counts.adsbMilitary above totals.adsbMilitary.
      const bucket = flagOf(item);
      if (bucket) {
        totals.adsbFlagged += 1;
        totals[AIRCRAFT_FLAG_COUNT_KEY[bucket]] += 1;
      } else if (classifyAircraft(item) === "military") totals.adsbMilitary += 1;
      else totals.adsbCivilian += 1;
    }
    scheduleReports({ counts: true });
    settlePlacement();
    // Same per-render accumulation the selected ship needs -- see the note
    // in renderAisLayer.
    if (selectedIcao) updateTrails(aircraftTrails, raw.adsb, "icao24", AIRCRAFT_TRAIL_MAX_POINTS, selectedIcao);
    renderTrailLayer(aircraftTrailsLayer, aircraftTrails, "#d8b9ff", selectedIcao ? new Set([selectedIcao]) : new Set(), { refLon: map.getCenter().lng, copies: worldCopies(), layerKey: "adsbCivilian" });

    // Every on-screen military aircraft gets a trail, not just a selected
    // one -- same "the path itself is the point" reasoning as tanker/
    // satellite trails above. Accumulates regardless of the sub-ticker; only
    // the drawing is gated (see renderAisLayer's note).
    updateTrails(militaryTrails, militaryVisible, "icao24", AIRCRAFT_TRAIL_MAX_POINTS, undefined);
    if (militaryTrailsVisible) {
      renderTrailLayer(militaryTrailsLayer, militaryTrails, "#ff4d4d", new Set(militaryTrails.keys()), {
        refLon: map.getCenter().lng,
        copies: worldCopies(),
        layerKey: "adsbMilitary",
        maxOpacity: 0.35,
        dashArray: "2 5",
      });
    }
  }

  function renderFirms() {
    if (skipHiddenLayer("firms")) return;
    const inView = viewportFilter();
    const visible = raw.firms.filter(
      (d) => inView(d.lat, d.lon)
    );
    // Always on, any zoom -- leaflet.heat draws this as one canvas
    // regardless of point count, so it stays cheap even with tens of
    // thousands visible.
    applyHeatKernel(firmsHeat, "firms");
    // Repeated across the world copies in view, culled per copy -- see
    // worldCopyPlacements for why this layer of all of them cannot just draw three
    // times. Fed as one flat array because that is leaflet.heat's whole interface:
    // it has no concept of a copy, so a copy is just more points.
    const placeFirms = worldCopyPlacements();
    const firmsHeatPoints = [];
    for (const d of visible) {
      const weight = Math.min((d.frp ? Number(d.frp) : 5) / 50, 1) + 0.2;
      placeFirms(d.lat, d.lon, (drawLon) => firmsHeatPoints.push([d.lat, drawLon, weight]));
    }
    safeHeatSetLatLngs(firmsHeat, firmsHeatPoints);
    // After the redraw, not before: leaflet.heat replaces its canvas element on
    // every setLatLngs, taking the style written onto the previous one with it.
    applyWashStack();

    firmsPointsLayer.clearLayers();
    // The heat above is drawn whatever the zoom; only the clickable per-point
    // circles are gated, which is why this reads firmsPoints rather than firms.
    const belowFirmsDetailZoom = map.getZoom() < (minZoomFor("firmsPoints") ?? -Infinity);
    zoomNotes.firms = belowFirmsDetailZoom;
    scheduleReports({ notes: true });
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
        // One click target per copy the point lands on, so a hot spot the reader
        // can see is a hot spot the reader can inspect. Culled by the same placer
        // that fed the heat, so the targets and the blur they explain agree.
        placeFirms(d.lat, d.lon, (drawLon) => {
          const marker = L.circleMarker([d.lat, drawLon], {
            radius: Math.max(3, Math.round(6 * layerScale("firms"))),
            fillOpacity: 0.02,
            opacity: 0,
            renderer: firmsCanvasRenderer,
          });
          marker.bindTooltip(tooltip, { className: "map-tooltip", direction: "top" });
          marker.bindPopup(detail, popupOptions(280));
          firmsPointsLayer.addLayer(marker);
        });
      }
    }

    counts.firms = visible.length;
    totals.firms = raw.firms.length;
    scheduleReports({ counts: true });
  }

  function satelliteIconSize(sat) {
    return satelliteStyle(sat.group).size;
  }

  // ---------- Task 25: ground track / footprint overlay for the open card ----------
  //
  // Shared by stations/military (buildSatelliteMarker below, footprint
  // only -- see decorateSatellite's own note on why there is no ground
  // track for these two: their orbital elements are never sent to the
  // browser, only their live position) and the three small client-
  // propagated marker layers (buildSatElementMarker further down, footprint
  // and ground track both). The four bulk WebGL layers (satImaging/satGeo/
  // satStarlink/satOneweb) keep their pre-existing "no click-to-select
  // model" (see their own entityWebglLayer.updateEntities call's isSelected/
  // onSelect below) -- footprint and ground track are only ever drawn for a
  // satellite that already has an actual Leaflet marker and popup to hang
  // them on, and building a second, WebGL-specific selection path for
  // several thousand Starlink/OneWeb objects is outside this task's brief.

  function clearSatelliteOverlay() {
    satelliteOverlayLayer.clearLayers();
  }

  /** The footprint circle: radius from footprintRadiusKm(altKm) -- see that
   *  function's own comment for the standard horizon-geometry formula.
   *  L.circle's radius is metres; footprintRadiusKm answers km. */
  function drawSatelliteFootprint(lat, lon, altKm) {
    const radiusKm = footprintRadiusKm(altKm);
    if (radiusKm <= 0) return;
    L.circle([lat, lon], {
      radius: radiusKm * 1000,
      color: "#6fe3ff",
      weight: 1,
      fillOpacity: 0.04,
      opacity: 0.35,
      interactive: false,
    }).addTo(satelliteOverlayLayer);
  }

  /** The ground track: one L.polyline per antimeridian-split segment (see
   *  map/groundTrack.js's groundTrackSegments/splitAtAntimeridian), drawn
   *  on the map's one primary copy of the world -- a short, selection-only
   *  line has no need for drawLatLng/worldCopies' per-visible-copy
   *  repetition the way an always-drawn marker layer does. */
  function drawSatelliteGroundTrack(satrec, centerDate) {
    for (const segment of groundTrackSegments(satrec, centerDate, { beforeMin: 90, afterMin: 90, stepMin: 1 })) {
      if (segment.length < 2) continue;
      L.polyline(segment, { color: "#6fe3ff", weight: 2, opacity: 0.7, dashArray: "4 4", interactive: false })
        .addTo(satelliteOverlayLayer);
    }
  }

  function buildSatelliteMarker(sat, copy = 0) {
    const d = decorateSatellite(sat, { offset: offsetFor("satellites", sat.norad_id) });
    const marker = L.marker(drawLatLng(sat, copy), { icon: d.icon });
    marker._item = sat;
    marker._iconHtml = d.icon.options.html;
    applyStacking(marker, detailSize(satelliteIconSize(sat)), "satellites");
    marker.bindPopup(() => decorateSatellite(marker._item).detail, popupOptions(320));
    marker.bindTooltip(() => decorateSatellite(marker._item).tooltip, {
      className: "map-tooltip",
      direction: "top",
    });
    // No orbital elements for stations/military on the client (see
    // decorateSatellite's own note), so only the footprint -- pure
    // arithmetic over the live alt_km this marker already has -- is drawn.
    marker.on("popupopen", () => {
      clearSatelliteOverlay();
      drawSatelliteFootprint(marker._item.lat, marker._item.lon, marker._item.alt_km);
    });
    marker.on("popupclose", clearSatelliteOverlay);
    return marker;
  }

  // Satellites re-poll every 10s and their glyph never varies -- only the
  // position and (since the declutter pass) the offset do, so the icon is only
  // rebuilt when the generated HTML actually differs, same test updateMarker
  // uses.
  function updateSatelliteMarker(marker, sat, copy = 0) {
    marker._item = sat;
    marker.setLatLng(drawLatLng(sat, copy));
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

    const inView = viewportFilter();
    // The layer itself is ungated (see LAYER_MANIFEST), so a per-pin gate is
    // the only zoom question this layer has -- "military satellites from z4,
    // stations at every zoom" and the reverse are both configurable here.
    const zoom = map.getZoom();
    const satellitesPerPin = (layerHasTokenZoom("satellites") || layerHasTokenZoomMax("satellites"));
    const visible = pool.filter(
      (s) =>
        typeof s.lat === "number" &&
        typeof s.lon === "number" &&
        inView(s.lat, s.lon) &&
        (!satellitesPerPin || pinDrawsAt("satellites", s, zoom, minZoomFor("satellites")))
    );
    registerPlacement(
      "satellites",
      visible.map((s) => ({ id: s.norad_id, lat: s.lat, lon: s.lon, size: detailSize(satelliteIconSize(s)) }))
    );
    syncAcrossWorldCopies(markersByKey.satellites, satelliteGroup, visible, (s) => s.norad_id, buildSatelliteMarker, updateSatelliteMarker);
    counts.satellites = visible.length;
    totals.satellites = pool.length;
    scheduleReports({ counts: true });
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
        { refLon: map.getCenter().lng, copies: worldCopies(), layerKey: "satellites", maxOpacity: 0.22, dashArray: "2 5" }
      );
    }
  }

  // ---------- Task 24: client-propagated satellite layers ----------
  //
  // stations/military above are this map's own server-side SGP4, unchanged.
  // Everything here is propagated in the browser instead, from stored
  // CelesTrak element sets (see map/satPropagate.js and
  // backend/sources/satellites.py's ELEMENT_LAYER_GROUPS/cadence_seconds).
  //
  // DOM vs WebGL: satNavigation/satWeather/satScience (a few dozen to ~150
  // objects apiece) draw as ordinary Leaflet markers, the same mechanism
  // stations/military already use -- individually poppable, individually
  // tooltippable, and cheap at that count. satImaging/satGeo/satStarlink/
  // satOneweb (several hundred to several thousand objects, and imaging is
  // on by default) draw on entityWebglLayer's shared GPU-batched canvas
  // instead, the same one AIS/ADS-B already use -- that is the one renderer
  // on this map already proven to carry thousands of moving points without
  // per-marker DOM cost, and hundreds-to-thousands of markers was never a
  // reasonable DOM-path number to begin with (see webglLayer.js's own
  // opening comment on why it exists at all). Declutter offsets and per-pin
  // zoom gating are deliberately not wired up for either path here -- Task
  // 24's brief is the propagation and the toggles, not a second pass over
  // the placement system for seven more layers; a future task can add it
  // the way it was added for stations/military if it turns out to matter at
  // these object counts.

  /** GET /api/satellites/elements?groups=<celestrak group>, storing the raw
   *  OMM element sets for one layer. Never re-fetched automatically after
   *  the first success -- elements barely change (six hours server-side; see
   *  ELEMENTS_REFRESH_INTERVAL in backend/sources/satellites.py) -- so, like
   *  railways/cables/water elsewhere in this file, this is a one-shot fetch
   *  rather than a poller. */
  function fetchSatElements(layerKey) {
    if (satElements[layerKey] != null) return; // already fetched (or in flight)
    satElements[layerKey] = []; // in flight -- guards a fast double-toggle from double-fetching
    fetchJson(`/api/satellites/elements?groups=${SAT_ELEMENT_CELESTRAK_GROUP[layerKey]}`)
      .then((data) => {
        const elements = Array.isArray(data) ? data : [];
        satElements[layerKey] = elements;
        // Task 25: indexed by NORAD id so a marker's popupopen handler (see
        // buildSatElementMarker below) can find its own OMM record in O(1)
        // instead of scanning the whole layer -- this can run to several
        // thousand entries for starlink/oneweb.
        satElementIndex[layerKey] = new Map(elements.map((omm) => [omm.NORAD_CAT_ID, omm]));
        tickSatElementLayer(layerKey, true); // first fix immediately, not up to two minutes late
      })
      .catch((err) => {
        satElements[layerKey] = null; // let the next attempt retry rather than pin an empty layer
        satElementIndex[layerKey] = null;
        console.warn(`Failed to load satellite elements for ${layerKey}:`, err);
      });
  }

  /** A real SGP4 pass (satElementTracker.tick) for one layer's currently-held
   *  element sets, gated by its own cadence unless `force`. Registers every
   *  element set with the shared tracker first, tagged with `layerKey` --
   *  setElements is a no-op for an object whose epoch and group have not
   *  changed, so this is cheap to call on every redraw tick and only
   *  actually rebuilds a satrec when the elements themselves refresh.
   *
   *  `layerKey` is passed to tick() as its `group` -- not optional. Without
   *  it tick() would re-propagate every satellite ever registered with the
   *  shared tracker, on whichever layer's cadence happened to call it first,
   *  which is exactly the bug that let a 10s-cadence layer's timer
   *  re-SGP4-propagate a 60s-cadence layer's several thousand objects six
   *  times more often than intended -- see satPropagate.js's own doc on
   *  tick() for the full reasoning. */
  function tickSatElementLayer(layerKey, force = false) {
    const elements = satElements[layerKey];
    if (!elements || !elements.length) return;
    for (const omm of elements) satElementTracker.setElements(omm.NORAD_CAT_ID, omm, layerKey);
    const now = Date.now();
    const last = satElementLastTick[layerKey] || 0;
    if (!force && now - last < satElementCadenceMs(layerKey)) return;
    satElementLastTick[layerKey] = now;
    satElementTracker.tick(new Date(now), layerKey);
  }

  function satElementPositions(layerKey) {
    const elements = satElements[layerKey];
    if (!elements || !elements.length) return [];
    const now = new Date();
    const out = [];
    for (const omm of elements) {
      // `layerKey` as the group: a NORAD id shared between two toggles (e.g.
      // a GOES satellite under both satWeather and satGeo -- see
      // satPropagate.js's own note on why) has one tracker entry per group,
      // so this has to say which one it means.
      const pos = satElementTracker.positionAt(omm.NORAD_CAT_ID, now, layerKey);
      if (!pos) continue; // no fix yet (still loading), or the element set doesn't propagate at all
      out.push({
        norad_id: omm.NORAD_CAT_ID, name: omm.OBJECT_NAME, lat: pos.lat, lon: pos.lon, alt_km: pos.alt_km,
        // Task 25: the static orbital fields backend/sources/satellites.py's
        // _decorate_element already computed once, server-side, at the
        // six-hourly element refresh (see that module's own
        // _summary_fields) -- a plain spread, not a second derivation, so
        // the card can never disagree with the values the collector itself
        // reported. Cheap to carry on every rendered item (they are static
        // strings/numbers already sitting on `omm`, not a propagation),
        // unlike velocity/ground-track/footprint below, which are only
        // computed for the one card a reader has open.
        // `omm.epoch` (lowercase) is _summary_fields' own copy of CelesTrak's
        // EPOCH, not the raw uppercase OMM field of the same name under a
        // different case -- both exist on the same record (see
        // backend/sources/satellites.py's _decorate_element, which spreads
        // the raw OMM and then _summary_fields over it), and this reads the
        // one decorateSatElement/satelliteOrbitSections actually expects.
        intl_designator: omm.intl_designator, launch_year: omm.launch_year,
        inclination_deg: omm.inclination_deg, period_min: omm.period_min,
        apogee_km: omm.apogee_km, perigee_km: omm.perigee_km, epoch: omm.epoch,
      });
    }
    return out;
  }

  /**
   * The fresh, on-demand propagation Task 25's card needs and the
   * always-running redraw loop deliberately does not compute for every
   * marker: a real SGP4 velocity (from the same satrec the shared tracker
   * would otherwise interpolate) and the ground track over the
   * surrounding +-90 minutes. Built once per popup open, not per redraw
   * tick -- see buildSatElementMarker's own popupopen handler, the only
   * caller.
   *
   * Uses a satrec built fresh from the stored OMM record rather than
   * reaching into satElementTracker's own (module-private) entries: the
   * tracker exists to answer "where to draw this, right now, cheaply,
   * every two seconds" via interpolation between two fixes, and never
   * kept the velocity either fix carried past positionAt's return value
   * (see satPropagate.js's interpolateFixes/positionAt) -- there is
   * nothing in it to reach into. One extra satrec build plus one real
   * SGP4 propagation is trivial next to how rarely a reader opens a
   * satellite's card, so this pays that cost fresh rather than growing
   * the tracker a second, wider return shape only this call site wants.
   */
  function liveSatelliteDetail(noradId, layerKey) {
    const omm = satElementIndex[layerKey]?.get(noradId);
    const now = new Date();
    if (!omm) return { velocityKmS: undefined, groundTrackAvailable: false, satrec: null, now };
    try {
      const satrec = satrecFromElements(omm);
      const fix = propagateEci(satrec, now);
      const v = fix?.velocity;
      const velocityKmS = v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : undefined;
      return { velocityKmS, groundTrackAvailable: true, satrec, now };
    } catch {
      // A malformed element set -- decorateSatElement's default (already
      // rendered before this handler runs) still shows position/altitude;
      // this only means no live velocity or ground track for this one.
      return { velocityKmS: undefined, groundTrackAvailable: false, satrec: null, now };
    }
  }

  function buildSatElementMarker(item, layerKey, copy = 0) {
    const d = decorateSatElement(item, layerKey, { offset: offsetFor(layerKey, item.norad_id) });
    const marker = L.marker(drawLatLng(item, copy), { icon: d.icon });
    marker._item = item;
    marker._iconHtml = d.icon.options.html;
    applyStacking(marker, detailSize(satElementStyle(layerKey).size), layerKey);
    marker.bindPopup(() => decorateSatElement(marker._item, layerKey).detail, popupOptions(320));
    marker.bindTooltip(() => decorateSatElement(marker._item, layerKey).tooltip, {
      className: "map-tooltip",
      direction: "top",
    });
    // Task 25: ground track + footprint + real velocity, computed once on
    // open (see liveSatelliteDetail above) rather than kept live while the
    // card stays open -- over the few seconds to minutes a reader actually
    // looks at one card, a LEO object's true position drifts by a few
    // kilometres at most, well inside the footprint circle's own radius,
    // so a snapshot read on open is a reasonable trade against recomputing
    // a 181-point propagation on every 2s redraw tick for a card that is,
    // most of the time, not open at all. Closing and reopening the same
    // popup refreshes it.
    marker.on("popupopen", () => {
      clearSatelliteOverlay();
      const { velocityKmS, groundTrackAvailable, satrec, now } = liveSatelliteDetail(marker._item.norad_id, layerKey);
      drawSatelliteFootprint(marker._item.lat, marker._item.lon, marker._item.alt_km);
      if (satrec) drawSatelliteGroundTrack(satrec, now);
      const popup = marker.getPopup();
      if (popup?.isOpen()) {
        popup.setContent(decorateSatElement(marker._item, layerKey, { velocityKmS, groundTrackAvailable }).detail);
      }
    });
    marker.on("popupclose", clearSatelliteOverlay);
    return marker;
  }

  function updateSatElementMarker(marker, item, layerKey, copy = 0) {
    marker._item = item;
    marker.setLatLng(drawLatLng(item, copy));
    const d = decorateSatElement(item, layerKey, { offset: offsetFor(layerKey, item.norad_id) });
    if (marker._iconHtml !== d.icon.options.html) {
      marker.setIcon(d.icon);
      marker._iconHtml = d.icon.options.html;
    }
  }

  const SAT_ELEMENT_DOM_GROUP = {
    satNavigation: satNavigationGroup, satWeather: satWeatherGroup, satScience: satScienceGroup,
  };

  /** DOM-marker render for one of the three small groups. `minZoomFor`
   *  answers both cases the same way: satNavigation/satWeather are gated at
   *  THEATRE (see map/scene.js), satScience is ungated (returns null, so
   *  `belowMinZoom` is always false) -- one code path, no per-layer branch.
   *  Below the gate this mirrors every other gated marker layer
   *  (renderCities, renderInfra, ...): zoomNotes[layerKey] is set so the
   *  panel can say *why* the count reads zero, and nothing is drawn. */
  function renderSatElementLayer(layerKey) {
    if (!satElementVisible[layerKey]) return;
    const zoom = map.getZoom();
    const belowMinZoom = zoom < (minZoomFor(layerKey) ?? -Infinity);
    if (SAT_ELEMENT_ZOOM_NOTE_KEYS.has(layerKey)) {
      zoomNotes[layerKey] = belowMinZoom;
      scheduleReports({ notes: true });
    }
    const inView = viewportFilter();
    const visible = belowMinZoom
      ? []
      : satElementPositions(layerKey).filter((s) => inView(s.lat, s.lon));
    registerPlacement(
      layerKey,
      visible.map((s) => ({ id: s.norad_id, lat: s.lat, lon: s.lon, size: detailSize(satElementStyle(layerKey).size) }))
    );
    syncAcrossWorldCopies(
      markersByKey[layerKey], SAT_ELEMENT_DOM_GROUP[layerKey], visible, (s) => s.norad_id,
      (item, copy) => buildSatElementMarker(item, layerKey, copy),
      (marker, item, copy) => updateSatElementMarker(marker, item, layerKey, copy)
    );
    counts[layerKey] = visible.length;
    totals[layerKey] = (satElements[layerKey] || []).length;
    scheduleReports({ counts: true });
    settlePlacement();
  }

  /** WebGL-bucket render for one of the four bulk groups. Same `minZoomFor`
   *  treatment as renderSatElementLayer above: satImaging is gated at
   *  THEATRE, satGeo/satStarlink/satOneweb are ungated (null, so the gate
   *  never trips). No viewport filter and no declutter offsets when at or
   *  above the gate -- entityWebglLayer already reprojects and culls
   *  off-screen sprites on its own (see webglLayer.js's _reset/
   *  _repositionAll), the same unfiltered-feed approach renderAisLayer/
   *  renderAdsbLayer already take for their own, larger buckets. */
  function renderSatElementWebgl(layerKey) {
    if (!satElementVisible[layerKey]) return;
    const zoom = map.getZoom();
    const belowMinZoom = zoom < (minZoomFor(layerKey) ?? -Infinity);
    if (SAT_ELEMENT_ZOOM_NOTE_KEYS.has(layerKey)) {
      zoomNotes[layerKey] = belowMinZoom;
      scheduleReports({ notes: true });
    }
    const visible = belowMinZoom ? [] : satElementPositions(layerKey);
    const style = satElementStyle(layerKey);
    entityWebglLayer.updateEntities(layerKey, visible, {
      idField: (s) => s.norad_id,
      heading: () => NaN, // orbital motion has no meaningful "nose" to point a sprite at
      style: () => style,
      // Still no click-to-select model for these four bulk WebGL layers --
      // see the "Task 25: ground track / footprint overlay" comment above
      // buildSatelliteMarker for why that stayed out of this task's scope
      // (several thousand Starlink/OneWeb objects is not a WebGL selection
      // path worth building just for a card popup).
      isSelected: () => false,
      onSelect: () => {},
      getTooltip: (s) => decorateSatElement(s, layerKey).tooltip,
      offsets: undefined,
    });
    counts[layerKey] = visible.length;
    totals[layerKey] = (satElements[layerKey] || []).length;
    scheduleReports({ counts: true });
  }

  function renderSatElement(layerKey) {
    if (SAT_ELEMENT_LAYERS[layerKey].dom) renderSatElementLayer(layerKey);
    else renderSatElementWebgl(layerKey);
  }

  /** The redraw tick: ticks whichever layers are visible and due for a real
   *  SGP4 pass (see satElementCadenceMs), then redraws every visible layer's
   *  interpolated positions regardless -- called on its own timer
   *  (SAT_ELEMENT_REDRAW_MS) rather than from renderAllLayers, since these
   *  seven have to keep moving even while the camera sits still. */
  function tickAndRedrawSatElements() {
    for (const layerKey of Object.keys(SAT_ELEMENT_CELESTRAK_GROUP)) {
      if (!satElementVisible[layerKey]) continue;
      tickSatElementLayer(layerKey);
      renderSatElement(layerKey);
    }
  }

  // Concentric-rings "sonar ping"/water-drop-ripple marker for an active
  // jamming cell -- distinct from the .infra-hot/.country-hot steady glow.
  // Loops continuously via CSS (animation-iteration-count: infinite, see
  // .jamming-ping-ring in style.css) for as long as the cell stays on the
  // map, rebuilt on every renderJamming() pass alongside jammingPointsLayer
  // rather than firing once and leaving only the heat layer's static purple
  // blur behind.
  function buildJammingPing(d, drawLon) {
    const html =
      '<div class="jamming-ping-wrap">' +
      '<span class="jamming-ping-ring" style="animation-delay:0ms"></span>' +
      '<span class="jamming-ping-ring" style="animation-delay:1500ms"></span>' +
      '<span class="jamming-ping-ring" style="animation-delay:3000ms"></span>' +
      "</div>";
    const icon = L.divIcon({ html, className: "", iconSize: [1, 1], iconAnchor: [0, 0] });
    // `drawLon` is already placed on the copy being drawn (see the placer in
    // renderJamming), so it is used as given rather than re-resolved here.
    const marker = L.marker([d.lat, drawLon], { icon, interactive: false });
    jammingPingGroup.addLayer(marker);
  }

  function renderJamming() {
    if (skipHiddenLayer("jamming")) return;
    const inView = viewportFilter();
    // World zoom stays clean by construction rather than by showing a purple
    // blur everywhere: heat, pings and click points are all withheld together
    // until the reader zooms in. The gate used to be a bare constant here,
    // which meant Admin Mode's per-layer zoom slider silently did nothing to
    // this layer; it now reads the same scene entry as everything else.
    const belowJammingDetailZoom = map.getZoom() < (minZoomFor("jamming") ?? -Infinity);
    zoomNotes.jamming = belowJammingDetailZoom;
    scheduleReports({ notes: true });

    const visible = belowJammingDetailZoom
      ? []
      : raw.jamming.filter(
          (d) => inView(d.lat, d.lon)
        );

    applyHeatKernel(jammingHeat, "jamming");
    // Same treatment as the FIRMS heat above, same reasons.
    const placeJamming = worldCopyPlacements();
    const jammingHeatPoints = [];
    for (const d of visible) {
      placeJamming(d.lat, d.lon, (drawLon) => jammingHeatPoints.push([d.lat, drawLon, d.jam_ratio]));
    }
    safeHeatSetLatLngs(jammingHeat, jammingHeatPoints);
    applyWashStack(); // see the note beside the FIRMS call



    jammingPointsLayer.clearLayers();
    jammingPingGroup.clearLayers();
    for (const d of visible) {
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
      // Ping and click target both follow the heat onto each copy: the pulsing ring
      // is what a reader aims at, so a copy that pulses without answering a click,
      // or answers a click without pulsing, is worse than either alone.
      placeJamming(d.lat, d.lon, (drawLon) => {
        buildJammingPing(d, drawLon);
        const marker = L.circleMarker([d.lat, drawLon], {
          radius: Math.max(6, Math.round(18 * layerScale("jamming"))),
          fillOpacity: 0.02,
          opacity: 0,
          renderer: jammingCanvasRenderer,
        });
        marker.bindTooltip(tooltip, { className: "map-tooltip", direction: "top" });
        marker.bindPopup(detail, popupOptions(280));
        jammingPointsLayer.addLayer(marker);
      });
    }

    counts.jamming = visible.length;
    totals.jamming = raw.jamming.length;
    scheduleReports({ counts: true });
  }

  // Task 20a: the AIS traffic grid (GET /api/lanes, backend/refine/
  // lane_density.py) -- a near-copy of renderJamming just above, same
  // "heat canvas plus near-invisible click targets" shape. No ping group:
  // see the comment on createLaneDensityLayers in layers.js for why a
  // continuously-decaying cell has no "just appeared" moment worth one.
  //
  // The honesty framing is the whole point of this layer (Task 20's brief):
  // this is where *we* have seen ships, over the window the grid actually
  // covers, and an empty cell means no observation, never no traffic. That
  // sentence is the backend's own `note` (lane_density.NOTE, served verbatim
  // as raw.laneDensity.note), repeated on every single popup rather than
  // summarised, so the wording on the map can never quietly drift from the
  // one the endpoint promises.
  function renderLaneDensity() {
    if (skipHiddenLayer("laneDensity")) return;
    const inView = viewportFilter();
    const doc = raw.laneDensity || {};
    const cells = Array.isArray(doc.cells) ? doc.cells : [];
    const note = doc.note || "";
    // Same "heat draws at every zoom, click targets wait for detail" split
    // jamming uses -- a 0.05deg/0.02deg cell is a smear at world zoom and a
    // real reading once a reader is looking at one stretch of water.
    const belowLaneDensityDetailZoom = map.getZoom() < (minZoomFor("laneDensity") ?? -Infinity);
    zoomNotes.laneDensity = belowLaneDensityDetailZoom;
    scheduleReports({ notes: true });

    const visible = cells.filter((d) => inView(d.lat, d.lon));

    applyHeatKernel(laneDensityHeat, "laneDensity");
    const placeLane = worldCopyPlacements();
    const laneDensityHeatPoints = [];
    for (const d of visible) {
      const weight = laneDensityIntensity(d.sightings);
      placeLane(d.lat, d.lon, (drawLon) => laneDensityHeatPoints.push([d.lat, drawLon, weight]));
    }
    safeHeatSetLatLngs(laneDensityHeat, laneDensityHeatPoints);
    applyWashStack(); // see the note beside the FIRMS call

    laneDensityPointsLayer.clearLayers();
    if (!belowLaneDensityDetailZoom) {
      for (const d of visible) {
        const classEntries = Object.entries(d.by_class || {});
        const classLine = classEntries.length
          ? `<div>By class: ${classEntries.map(([cls, n]) => `${esc(cls)} ${fmtNumber(n)}`).join(", ")}</div>`
          : "";
        const courseLine = Number.isFinite(d.course_deg)
          ? `<div>Net course: ${Math.round(d.course_deg)}&deg;</div>`
          : '<div class="meta">No net directional evidence in this cell.</div>';
        const tooltip = `<b>${fmtNumber(d.sightings)} sightings</b><br/>not a distinct-vessel count`;
        const detail = `
          <h3>AIS traffic density</h3>
          <div>${fmtNumber(d.sightings)} sightings recorded in this cell</div>
          ${classLine}
          ${courseLine}
          <p class="meta"><b>Not a count of distinct vessels.</b> A hull that sits still keeps adding to this
          number, so a loitering ship and a busy strait can show the same figure -- see below.</p>
          <p class="meta">${esc(note)}</p>`;
        placeLane(d.lat, d.lon, (drawLon) => {
          const marker = L.circleMarker([d.lat, drawLon], {
            radius: Math.max(4, Math.round(10 * layerScale("laneDensity"))),
            fillOpacity: 0.02,
            opacity: 0,
            color: laneDensityColor(),
            renderer: laneDensityCanvasRenderer,
          });
          marker.bindTooltip(tooltip, { className: "map-tooltip", direction: "top" });
          marker.bindPopup(detail, popupOptions(280));
          laneDensityPointsLayer.addLayer(marker);
        });
      }
    }

    counts.laneDensity = visible.length;
    totals.laneDensity = cells.length;
    scheduleReports({ counts: true });
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

  // The feeds a country fill can be computed from. `countries` is absent on
  // purpose: renderCountries repaints itself after rebuilding the shapes, and
  // adding it here would run the pass twice on every boundary refresh.
  const CHOROPLETH_FEEDS = new Set([
    "conflictStats", "humanitarian", "outages", "energyFlows", "foodTrade",
    // The state-target metric's own feed (Task 26). `subdivisions` is absent
    // for the same reason `countries` is: drawSubdivisions repaints itself
    // after rebuilding the state shapes.
    "outagesRegions",
  ]);

  /**
   * Recompute the selected metric over the current features and repaint.
   *
   * One pass over 177 features and a `resetStyle` -- cheap enough to re-run on
   * every poll that could move a value, which is what keeps the fill honest
   * without a second cache to invalidate. resetStyle re-applies the style
   * function in place rather than rebuilding the layer, so the hover and
   * selection classes and the border editor's handles all survive it.
   */
  // ---------- district archive ----------

  /**
   * One country's districts, fetched at most once per session.
   *
   * Per country rather than as one file: each is roughly half a megabyte of
   * polygons and there is no reason a reader drilling into Ukraine should wait
   * for Venezuela. A country with no stored boundary file is remembered as an
   * empty collection rather than left absent, so it is asked for once and not
   * once per click -- exactly as the subdivisions are. Loaded geometry is kept:
   * administrative boundaries do not move while a tab is open.
   */
  async function loadDistrictCountry(iso3) {
    if (!iso3 || districtGeometry.has(iso3)) return;
    districtGeometry.set(iso3, null);  // claimed, so a second ask does not refetch
    // A reader asking for district geometry is a reader who may click one, which
    // is the only thing the counts are for. Not awaited: the outlines must not
    // wait on the archive to be drawn.
    ensureDistrictArchive();
    let collection = { type: "FeatureCollection", features: [] };
    try {
      const gj = await fetchJson(`/api/district-boundaries?country=${iso3}`);
      if (gj?.features?.length) collection = gj;
    } catch {
      // No boundary file, or a backend that could not answer: this country
      // simply has no districts, which is the truthful outcome.
    }
    districtGeometry.set(iso3, collection);
    if (!collection.features.length) return;
    // Extended rather than rebuilt: each country arrives on its own request and
    // the ones already in are still valid.
    districtIndex = districtIndex.concat(buildDistrictIndex(collection.features));
  }

  /**
   * Which months the archive holds, and the newest month's counts, once.
   *
   * The months endpoint exists so that finding out what is in the archive does
   * not mean downloading it (see /api/conflict-district-months). Asked for on
   * the first drill-down rather than at boot: a session that never opens a
   * district never needs either request.
   */
  let districtArchiveAsked = false;
  async function ensureDistrictArchive() {
    if (districtArchiveAsked) return;
    districtArchiveAsked = true;
    // Loading from the first request, not from the second: a card opened while
    // the months are still in flight would otherwise say "no record for this
    // month" -- the archive's one claim that has to mean something.
    districtCountsLoading = true;
    raw.districtMonthLoading = true;
    let months = [];
    try {
      months = await fetchJson("/api/conflict-district-months");
    } catch {
      // No archive reachable. The card says it has no record rather than the
      // drill-down failing -- the outlines are worth having either way.
    }
    if (!Array.isArray(months) || !months.length) {
      districtCountsLoading = false;
      raw.districtMonthLoading = false;
      refreshFocusedDistrictCard();
      return;
    }
    districtMonths = months;
    districtMonth = months[0];
    loadDistrictMonth(months[0]);
  }

  /** Fetch one month of counts and rewrite whatever card is open on them. */
  async function loadDistrictMonth(month) {
    if (!month) return;
    districtCountsLoading = true;
    raw.districtMonthLoading = true;
    refreshFocusedDistrictCard();
    let counts = new Map();
    try {
      counts = indexDistrictCounts(await fetchJson(
        `/api/conflict-districts?month=${encodeURIComponent(month)}`
      ));
    } catch {
      // An unanswerable month reads as an empty one, which the card states as
      // "no record" -- the same words it uses for a district genuinely absent.
    }
    // Guarded on the month still being the one selected: stepping through the
    // list fires a request per step and they do not necessarily land in order,
    // so an early response could otherwise overwrite a later one.
    if (districtMonth !== month) return;
    districtCounts = counts;
    raw.districtCounts = districtCounts;
    districtCountsLoading = false;
    raw.districtMonthLoading = false;
    refreshFocusedDistrictCard();
  }

  /**
   * One country's own slice of the hapi_conflict archive, up to its 24-month
   * retention -- what the district card's trend sparkline reads. Fetched at
   * most once per country, the same claim-then-fetch pattern loadDistrictCountry
   * uses for boundaries just above, and the same existing /api/conflict-districts
   * endpoint loadDistrictMonth already calls for one month at a time, just
   * scoped by country instead of by month -- no new endpoint. `months=24`
   * rather than the endpoint's own `months=1` default: hapi_conflict.py keeps
   * at most 24 months per district in the first place (MONTHS_KEPT), so this
   * asks for everything the archive could possibly hold for this one country,
   * not the ~23 MB whole-world archive its own docstring warns off.
   */
  async function loadDistrictSeries(iso3) {
    if (!iso3 || districtSeriesByCountry.has(iso3)) return;
    districtSeriesByCountry.set(iso3, null); // claimed, so a second drill-down does not refetch
    let records = [];
    try {
      records = await fetchJson(`/api/conflict-districts?country=${encodeURIComponent(iso3)}&months=24`);
    } catch {
      // No archive reachable for this country -- the trend section is simply
      // absent, same as every other optional fold with nothing to show.
    }
    districtSeriesByCountry.set(iso3, records);
    raw.districtSeries = { ...raw.districtSeries, [iso3]: records };
    // A district card in this country may already be open (the boundaries and
    // the archive load in parallel -- see syncDistrictDrilldown), and its
    // trend fold has been waiting on exactly this.
    refreshFocusedDistrictCard();
  }

  /** Which month the card reads. Fetches that month's counts. */
  function setDistrictMonth(month) {
    if (!month || month === districtMonth) return;
    districtMonth = month;
    loadDistrictMonth(month);
  }

  // ---------- admin-1 subdivisions ----------

  /** The ISO3 codes of the countries selected right now. */
  function subdivisionCountryCodes() {
    const codes = new Set();
    for (const key of selectedCountryKeys) {
      const iso3 = countryEntryFor(key)?.props?.iso_a3;
      if (iso3 && iso3 !== "-99") codes.add(iso3);
    }
    return codes;
  }

  function subdivisionEntryFor(key) {
    return key == null ? null : subdivisionIndex.find((e) => e.key === key) || null;
  }

  /**
   * Fetch geometry for any newly selected country, then redraw.
   *
   * Fire-and-forget from the selection handler: the borders appear a moment
   * after the country is highlighted rather than the highlight waiting on a
   * request, and a reader who clicks three countries in a second gets three
   * requests in flight rather than a queue. Every path re-reads the selection
   * at draw time, so a response landing after the reader has moved on paints
   * nothing.
   */
  async function syncSubdivisions() {
    const wanted = subdivisionCountryCodes();
    // A state whose country has just been dropped is no longer a thing the
    // reader can see selected, so holding the selection would be invisible
    // state that reappears if they select that country again.
    const selected = subdivisionEntryFor(selectedSubdivisionKey);
    if (selected && !wanted.has(selected.country_code)) {
      selectedSubdivisionKey = null;
      // Its card goes too. It describes a shape that is about to stop being
      // drawn, and a card still standing over a state nobody can see any more is
      // worse than no card -- it reads as the answer to the click that just
      // removed it.
      focusedSubdivisionLayer = null;
      reportSubdivisionSelection();
      // The districts drawn inside that state go with it -- assigned directly
      // rather than through selectSubdivision, so the drill-down is put away
      // here rather than by that function.
      syncDistrictDrilldown();
    }

    drawSubdivisions();
    await Promise.all([...wanted].map(async (iso3) => {
      if (subdivisionGeometry.has(iso3)) return;
      subdivisionGeometry.set(iso3, null);  // claimed, so a second click does not refetch
      let collection = { type: "FeatureCollection", features: [] };
      try {
        const gj = await fetchJson(`/api/admin1-boundaries?country=${iso3}`);
        if (gj?.features?.length) collection = gj;
      } catch {
        // A country with no stored subdivisions, or a backend that could not
        // answer: either way this country simply has no internal borders drawn,
        // which is the truthful outcome rather than a broken layer.
      }
      subdivisionGeometry.set(iso3, collection);
      if (collection.features.length) {
        // Extended rather than rebuilt -- each country arrives on its own
        // request and the ones already indexed are still valid.
        subdivisionIndex = subdivisionIndex.concat(buildSubdivisionIndex(collection.features));
        raw.subdivisionIndex = subdivisionIndex;
      }
    }));
    drawSubdivisions();
  }

  /** Put the selected countries' subdivisions on the map, and nothing else. */
  function drawSubdivisions() {
    // The signature is over the countries actually *drawable* right now, not
    // the ones selected: this runs once before a country's geometry has been
    // fetched and again after it lands, and a signature over the selection
    // alone would call those two the same state and skip the redraw that is
    // the whole point of the second call.
    const ready = [...subdivisionCountryCodes()]
      .filter((iso3) => subdivisionGeometry.get(iso3)?.features?.length)
      .sort();
    const signature = ready.join(",");
    if (signature !== drawnSubdivisionCountries) {
      drawnSubdivisionCountries = signature;
      subdivisionsLayer.clearLayers();
      for (const iso3 of ready) subdivisionsLayer.addData(subdivisionGeometry.get(iso3));
      // The badges are positioned against these shapes and the state fill
      // paints them, so both are stale the instant the shapes themselves are
      // rebuilt -- same reasoning renderCountries applies to outagePoints and
      // the country choropleth after a boundary rebuild.
      rebuildOutageRegionPoints();
      renderMarkerLayer("outageRegionPoints");
      refreshChoropleth();
    }
    const any = subdivisionsLayer.getLayers().length > 0;
    // Added and removed rather than left empty on the map: an empty GeoJSON
    // layer still owns a pane the border editor's handles have to sit above,
    // and there is no reason for it to be there at all when no country with
    // subdivisions is selected.
    if (any && !map.hasLayer(subdivisionsLayer)) subdivisionsLayer.addTo(map);
    if (!any && map.hasLayer(subdivisionsLayer)) map.removeLayer(subdivisionsLayer);
    updateSubdivisionHighlights();
  }

  // Same technique as updateCountryHighlights, and for the same reason: Leaflet
  // applies a path's `className` once, at creation, so anything that changes
  // afterwards has to be toggled on the element.
  function updateSubdivisionHighlights() {
    subdivisionsLayer.eachLayer((layer) => {
      const key = subdivisionKeyOf(layer.feature?.properties || {});
      const el = layer.getElement?.();
      if (!el) return;
      el.classList.toggle("subdivision-selected", key === selectedSubdivisionKey);
      el.classList.toggle("hovered", key === hoveredSubdivisionKey);
    });
  }

  function selectSubdivision(key) {
    if (key === selectedSubdivisionKey) return;
    selectedSubdivisionKey = key;
    focusedSubdivisionLayer = subdivisionLayerForKey(key);
    updateSubdivisionHighlights();
    reportSubdivisionSelection();
    // The districts follow the state exactly as the states follow the country.
    // Not awaited: a country being drilled into for the first time has its
    // district geometry fetched here, and the state highlights immediately
    // rather than waiting on it.
    syncDistrictDrilldown();
  }

  /** The Leaflet layer for one subdivision, or null -- same "scan the layer
   *  group" approach waterLayerFor uses, since subdivisionsLayer only ever
   *  holds a few dozen paths at once (the selected countries' own states). */
  function subdivisionLayerForKey(key) {
    if (key == null) return null;
    let found = null;
    subdivisionsLayer.eachLayer((layer) => {
      if (!found && subdivisionKeyOf(layer.feature?.properties || {}) === key) found = layer;
    });
    return found;
  }

  /** Viewport-pixel anchor for the subdivision info card -- same arithmetic as
   *  countryAnchorPoint/waterAnchorPoint. */
  function subdivisionAnchorPoint(layer) {
    const center = layer.getBounds().getCenter();
    const pt = map.latLngToContainerPoint(center);
    const rect = container.getBoundingClientRect();
    return { x: rect.left + pt.x, y: rect.top + pt.y };
  }

  /** The card payload for one subdivision index entry, built from current
   *  data -- the state counterpart to countryCardFor/waterCardFor. */
  function subdivisionCardFor(entry) {
    const bounds = entry.bbox
      ? { south: entry.bbox.minLat, west: entry.bbox.minLon, north: entry.bbox.maxLat, east: entry.bbox.maxLon }
      : null;
    const { title, sections } = subdivisionCardSections(entry, raw, bounds);
    const layer = subdivisionLayerForKey(entry.key);
    return {
      key: entry.key,
      name: title,
      sections,
      point: layer ? subdivisionAnchorPoint(layer) : null,
    };
  }

  /** Tell React which state's card is open, or that none is -- the
   *  subdivision counterpart to reportWaterSelection. No selection array
   *  alongside it, same reasoning as water: no chips, no highlight that
   *  outlives the card. */
  function reportSubdivisionSelection() {
    const entry = subdivisionEntryFor(selectedSubdivisionKey);
    callbacks.onSubdivisionSelect?.(entry ? subdivisionCardFor(entry) : null);
  }

  /** Rebuild the open state card against data that has just landed -- the
   *  subdivision counterpart to refreshFocusedCountryCard/refreshFocusedWaterCard. */
  function refreshFocusedSubdivisionCard() {
    if (!selectedSubdivisionKey) return;
    reportSubdivisionSelection();
  }

  function setHoveredSubdivision(key) {
    if (key === hoveredSubdivisionKey) return;
    hoveredSubdivisionKey = key;
    updateSubdivisionHighlights();
  }

  // ---------- the districts inside the selected state ----------

  /**
   * Which admin-1 subdivision each of a country's districts sits in.
   *
   * Done in geometry, from a point known to be inside the district (the same
   * representative point the country-scoped markers hang on, which is why it is
   * not simply the bounding-box centre: a district shaped round a river bend has
   * a centre in the neighbouring one). Districts nest inside states rather than
   * straddling them, so one interior point settles it.
   *
   * Runs once per country, and only once both halves are in hand: it is called
   * again after either arrives, and does nothing until the other has.
   */
  function assignDistrictStates(iso3) {
    if (!iso3 || districtStatesAssigned.has(iso3)) return;
    const districts = districtIndex.filter((d) => d.country_code === iso3);
    const states = subdivisionIndex.filter((s) => s.country_code === iso3);
    if (!districts.length || !states.length) return;
    districtStatesAssigned.add(iso3);
    const scope = new Set([iso3]);
    for (const district of districts) {
      const point = representativePointOf(district);
      const state = point && findSubdivisionAt(subdivisionIndex, point.lat, point.lon, scope);
      // A district whose interior point lands in no state is left unassigned
      // rather than guessed at: it is then reachable through the archive layer
      // but not through the drill-down, which is a gap a reader can see, unlike
      // a district filed under the wrong province. Ukraine's eleven Crimean
      // raions are the real case -- OCHA files them under Ukraine and Natural
      // Earth files Crimea under Russia, so there is no Ukrainian state for them
      // to sit in (see backend/sources/admin1_boundaries.py on why that is left
      // as the source has it). Afghanistan, by contrast, assigns 401 of 401.
      if (state) districtStateByPcode.set(district.pcode, state.key);
    }
  }

  /** The districts of the currently selected state. Empty for a state in a
   *  country with no district geometry, which is most of them. */
  function districtsOfSelectedState() {
    if (!selectedSubdivisionKey) return [];
    return districtIndex.filter(
      (d) => districtStateByPcode.get(d.pcode) === selectedSubdivisionKey
    );
  }

  /**
   * Fetch and draw the districts of whichever state is selected.
   *
   * Fire-and-forget from the selection handlers, like syncSubdivisions: it draws
   * what is already in hand first, then fetches what is not and draws again. A
   * response landing after the reader has moved on paints nothing, because the
   * draw re-reads the selection rather than closing over it.
   */
  async function syncDistrictDrilldown() {
    const state = subdivisionEntryFor(selectedSubdivisionKey);
    if (!state) {
      drawStateDistricts();
      return;
    }
    assignDistrictStates(state.country_code);
    drawStateDistricts();
    // Boundaries and this country's own slice of the conflict archive load in
    // parallel -- the outlines must not wait on the archive to be drawn, and
    // the archive request is exactly as fire-and-forget as loadDistrictCountry
    // already was on its own. loadDistrictSeries refreshes any open district
    // card itself once it lands (see its own docstring), so nothing further is
    // needed here for that half.
    await Promise.all([loadDistrictCountry(state.country_code), loadDistrictSeries(state.country_code)]);
    assignDistrictStates(state.country_code);
    drawStateDistricts();
  }

  function drawStateDistricts() {
    const signature = selectedSubdivisionKey || "";
    if (signature !== drawnDistrictState || (signature && !districtOutlineLayer.getLayers().length)) {
      drawnDistrictState = signature;
      // The district singled out belonged to the state being left; carrying it
      // across would leave a selection nobody can see. Its card goes with it,
      // the same reasoning syncSubdivisions gives for dropping a state's own
      // card when its country is deselected.
      selectedDistrictPcode = null;
      hoveredDistrictPcode = null;
      focusedDistrictLayer = null;
      reportDistrictSelection();
      districtOutlineLayer.clearLayers();
      const pcodes = new Set(districtsOfSelectedState().map((d) => d.pcode));
      const iso3 = subdivisionEntryFor(selectedSubdivisionKey)?.country_code;
      const features = (districtGeometry.get(iso3)?.features || []).filter(
        (f) => pcodes.has(f.properties?.pcode)
      );
      if (features.length) {
        districtOutlineLayer.addData({ type: "FeatureCollection", features });
      }
    }
    const any = districtOutlineLayer.getLayers().length > 0;
    // Added and removed rather than left empty, for the same reason the
    // subdivisions layer is: an empty layer still owns a pane.
    if (any && !map.hasLayer(districtOutlineLayer)) districtOutlineLayer.addTo(map);
    if (!any && map.hasLayer(districtOutlineLayer)) map.removeLayer(districtOutlineLayer);
    updateDistrictHighlights();
  }

  function updateDistrictHighlights() {
    districtOutlineLayer.eachLayer((layer) => {
      const pcode = layer.feature?.properties?.pcode;
      const el = layer.getElement?.();
      if (!el) return;
      el.classList.toggle("district-selected", !!pcode && pcode === selectedDistrictPcode);
      el.classList.toggle("hovered", !!pcode && pcode === hoveredDistrictPcode);
    });
  }

  function districtEntryFor(pcode) {
    return pcode == null ? null : districtIndex.find((d) => d.pcode === pcode) || null;
  }

  function selectDistrict(pcode) {
    if (pcode === selectedDistrictPcode) return;
    selectedDistrictPcode = pcode;
    focusedDistrictLayer = districtLayerForPcode(pcode);
    updateDistrictHighlights();
    reportDistrictSelection();
  }

  function setHoveredDistrict(pcode) {
    if (pcode === hoveredDistrictPcode) return;
    hoveredDistrictPcode = pcode;
    updateDistrictHighlights();
  }

  /** The Leaflet layer for one district, or null -- same "scan the layer
   *  group" approach subdivisionLayerForKey/waterLayerFor use, since
   *  districtOutlineLayer only ever holds one state's worth of districts. */
  function districtLayerForPcode(pcode) {
    if (pcode == null) return null;
    let found = null;
    districtOutlineLayer.eachLayer((layer) => {
      if (!found && layer.feature?.properties?.pcode === pcode) found = layer;
    });
    return found;
  }

  /** Viewport-pixel anchor for the district info card -- same arithmetic as
   *  countryAnchorPoint/waterAnchorPoint/subdivisionAnchorPoint. */
  function districtAnchorPoint(layer) {
    const center = layer.getBounds().getCenter();
    const pt = map.latLngToContainerPoint(center);
    const rect = container.getBoundingClientRect();
    return { x: rect.left + pt.x, y: rect.top + pt.y };
  }

  /**
   * The card payload for one district index entry, built from current data --
   * the district counterpart to subdivisionCardFor/countryCardFor/
   * waterCardFor. `month`/`months` ride along on the payload itself (rather
   * than being read back out of `raw` by the component) so DistrictInfoCard's
   * own month `<select>` has something to render without a second prop.
   */
  function districtCardFor(entry) {
    const bounds = entry.bbox
      ? { south: entry.bbox.minLat, west: entry.bbox.minLon, north: entry.bbox.maxLat, east: entry.bbox.maxLon }
      : null;
    const { title, sections } = districtCardSections(entry, raw, bounds, districtMonth);
    const layer = districtLayerForPcode(entry.pcode);
    return {
      pcode: entry.pcode,
      name: title,
      sections,
      point: layer ? districtAnchorPoint(layer) : null,
      month: districtMonth,
      months: districtMonths,
    };
  }

  /** Tell React which district's card is open, or that none is -- the
   *  district counterpart to reportSubdivisionSelection/reportWaterSelection. */
  function reportDistrictSelection() {
    const entry = districtEntryFor(selectedDistrictPcode);
    callbacks.onDistrictSelect?.(entry ? districtCardFor(entry) : null);
  }

  /** Rebuild the open district card against data that has just landed --
   *  called both by applyData's per-feed dispatch (DISTRICT_CARD_FEEDS) and
   *  directly by loadDistrictMonth/ensureDistrictArchive/loadDistrictSeries,
   *  whose archive state does not flow through applyData at all. */
  function refreshFocusedDistrictCard() {
    if (!selectedDistrictPcode) return;
    reportDistrictSelection();
  }

  /**
   * What a plain click inside a selected country is aimed at: a district of the
   * state already selected, or a state, or nothing.
   *
   * Returns null for a click outside every country whose states are drawn, which
   * is what leaves that click to the layers and the country selection below it.
   * The district test only runs inside the selected state, because that is the
   * only place districts are drawn -- a district under an unselected state is
   * not on screen, and claiming a click for something invisible is the same
   * thing as swallowing it.
   */
  function drillTargetAt(latlng) {
    if (!subdivisionIndex.length) return null;
    const codes = subdivisionCountryCodes();
    if (!codes.size) return null;
    const iso3 = findCountryAt(countryIndex, latlng.lat, latlng.lng)?.props?.iso_a3;
    if (!iso3 || !drawnSubdivisionCountries.split(",").includes(iso3)) return null;
    const state = findSubdivisionAt(subdivisionIndex, latlng.lat, latlng.lng, codes);
    const district = state && state.key === selectedSubdivisionKey
      ? findDistrictAt(districtsOfSelectedState(), latlng.lat, latlng.lng)
      : null;
    return { iso3, state, district };
  }

  /** Every currently-*drawn* state's own GeoJSON feature, flattened across
   *  however many countries are selected right now -- not the whole of
   *  subdivisionGeometry, which keeps every country ever selected this
   *  session (see drawSubdivisions) and would paint states no longer on
   *  screen. */
  function drawnSubdivisionFeatures() {
    const ready = drawnSubdivisionCountries ? drawnSubdivisionCountries.split(",") : [];
    return ready.flatMap((iso3) => subdivisionGeometry.get(iso3)?.features || []);
  }

  function refreshChoropleth() {
    const features = choroplethTarget === "state" ? drawnSubdivisionFeatures() : (raw.countries?.features || []);
    choropleth = buildChoropleth(choroplethMetricId, features, raw);
    // Both layers are reset, not only the active target's: switching target
    // has to clear whichever one just lost the fill, and a resetStyle on an
    // empty/off layer is a no-op rather than an error.
    if (raw.countries?.features?.length) countriesLayer.resetStyle();
    if (subdivisionsLayer.getLayers().length) subdivisionsLayer.resetStyle();
    callbacks.onChoroplethChange?.({
      metricId: choropleth.metric ? choropleth.metric.id : null,
      target: choroplethTarget,
      covered: choropleth.covered,
      total: choropleth.total,
    });
  }

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
      raw.countryIndex = countryIndex;
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
      scheduleReports({ counts: true });
      // The boundaries are what the viewport profile hit-tests against, so
      // until they land the profile is null and the scene applies no promotion
      // at all. This is the moment it can start -- without it, an ocean view
      // would stay unpromoted until the reader happened to pan.
      applyScene();
      // The shapes were just rebuilt from scratch, so whatever fill they were
      // carrying went with them. Repainting here rather than leaving it to the
      // next poll is what stops a boundary refresh blanking an active metric.
      refreshChoropleth();
      // The outage pins are positioned from these boundaries, so a rebuilt
      // country index invalidates them -- and on first load this is what turns
      // an already-fetched outage dict into pins at all.
      rebuildOutagePoints();
      renderMarkerLayer("outagePoints");
      // The selection publishes each country's polygons to React by reference
      // (see reportCountrySelection), and those arrays have just been replaced.
      // Without this the notable-activity board and the news ticker keep
      // scoping themselves to shapes that no longer exist -- which stayed
      // invisible while a rebuild only ever happened on a rename, and does not
      // once a boundary can be redrawn.
      reportCountrySelection();
      // 177 short strings, so React can hold these and the admin panel can spot
      // an edit made against geometry the source no longer serves -- without
      // the multi-megabyte collection itself ever entering React state.
      callbacks.onCountryFingerprints?.(countryFingerprints(raw.countries));
    }
    repaintCountryClasses();
  }

  /**
   * Close a boundary-editing session and put the map back in charge.
   *
   * The rebuild at the end is not housekeeping, it is the check: everything the
   * session drew was written straight into the working geometry, and this
   * repaints from whatever React actually persisted. If the two disagree --
   * a ring refused for being over the size ceiling, say -- this is where that
   * becomes visible rather than on the next reload.
   */
  function endBorderEdit() {
    if (!borderSession) return;
    borderEditor.end();
    borderSession = null;
    countriesLayer.eachLayer((layer) => layer.getElement?.()?.classList.remove("country-editing"));
    if (pendingCountries) {
      raw.countries = pendingCountries;
      pendingCountries = null;
    }
    lastCountriesSignature = null;
    renderCountries();
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
  /**
   * Every country currently over one of the war thresholds, by country key.
   *
   * Split out of updateCountryWarFlare so the flare and the viewport profile
   * cannot end up with two definitions of "at war". The flare below still only
   * *draws* on countries in scope -- that is a presentation choice about not
   * lighting up the whole world -- but the underlying judgement is made once,
   * here, from the same thresholds.
   *
   * Recomputed only when the events feed or the boundaries change: it is one
   * pass over the events plus one over ~180 countries, which is nothing on a
   * poll and would be waste on every pan.
   */
  let hotCountryKeys = new Set();
  let hotCountryStamp = null;
  function refreshHotCountries() {
    const stamp = `${raw.events?.length ?? 0}:${countryIndex.length}`;
    if (stamp === hotCountryStamp) return hotCountryKeys;
    hotCountryStamp = stamp;
    const tally = new Map();
    for (const e of raw.events) {
      const name = normalizeCountryName(e.country);
      if (!name) continue;
      const row = tally.get(name) || { fatalities: 0, count: 0 };
      row.fatalities += e.fatalities || 0;
      row.count += 1;
      tally.set(name, row);
    }
    const next = new Set();
    for (const entry of countryIndex) {
      const row = tally.get(normalizeCountryName(entry.name));
      if (!row) continue;
      if (row.fatalities >= WAR_FATALITY_THRESHOLD || row.count >= WAR_EVENT_COUNT_THRESHOLD) {
        next.add(entry.key);
      }
    }
    hotCountryKeys = next;
    return hotCountryKeys;
  }

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

  /**
   * Re-apply every per-shape CSS class after the country paths were rebuilt.
   *
   * Selection, war flare and the editing outline all live as classes on the
   * SVG path elements, and each is normally written only by the event that
   * changes it -- a click, an ACLED poll, opening an editing session. Anything
   * that recreates the paths (Leaflet's remove/add in setLayerVisible, or a
   * boundary rebuild) drops all three while the state that produced them is
   * still current, so they have to be written back rather than waited for.
   */
  function repaintCountryClasses() {
    updateCountryWarFlare();
    updateCountryHighlights();
    if (borderSession) {
      countriesLayer.eachLayer((layer) => {
        const key = countryKeyOfProps(layer.feature?.properties || {});
        layer.getElement?.()?.classList.toggle("country-editing", key === borderSession.countryKey);
      });
    }
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
  function buildCityMarker(city, copy = 0) {
    const { icon, size, tier } = decorateCity(city, { offset: offsetFor("cities", cityKey(city)) });
    const marker = L.marker(drawLatLng(city, copy), { icon });
    marker._iconHtml = icon.options.html;
    applyStacking(marker, size, "cities");
    marker.bindPopup(() => cityPopupHtml(city, raw, countryNameByIso2), popupOptions(320));
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

  function updateCityMarker(marker, city, copy = 0) {
    // This used not to reposition at all, which was already wrong before the
    // copies existed: a city built while the camera was on one copy of the world
    // stayed there when the reader panned to the next, because a city's position
    // never changes and nothing else here needed touching. What changes is which
    // copy of it is being looked at, and that is exactly what drawLatLng answers.
    marker.setLatLng(drawLatLng(city, copy));
    const { icon } = decorateCity(city, { offset: offsetFor("cities", cityKey(city)) });
    if (marker._iconHtml !== icon.options.html) {
      marker.setIcon(icon);
      marker._iconHtml = icon.options.html;
    }
  }

  // The ring a city groups reports inside. Drawn only for the cities actually on
  // screen, and only while the cities layer is on: the ring is the explanation
  // for a grouped pin, and an explanation nobody can see is not one. The
  // grouping itself runs regardless -- a collapsed head says which city it was
  // grouped on in its own popup, which is the explanation that always travels
  // with it.
  const CITY_ZONE_STYLE = {
    color: "#ff6fb5",
    weight: 1,
    opacity: 0.35,
    fillColor: "#ff6fb5",
    fillOpacity: 0.05,
    dashArray: "3 5",
    interactive: false,
  };

  function renderCityZones(visible) {
    cityZoneLayer.clearLayers();
    if (!cityZoneSettings.show || !cityZoneIndex) return;
    for (const city of visible) {
      const zone = cityZoneIndex.zoneAt(city.lat, city.lon);
      // zoneAt answers with the *smallest* containing zone, which for a town
      // inside a megacity's radius is the town rather than the city being drawn.
      // Matching on the key keeps a ring attached to the city it belongs to.
      if (!zone || zone.key !== cityKey(city)) continue;
      cityZoneLayer.addLayer(
        L.circle([zone.lat, zone.lon], { ...CITY_ZONE_STYLE, radius: zone.radiusM, pane: "uncertaintyPane" })
      );
    }
  }

  function renderCities() {
    if (skipHiddenLayer("cities")) {
      cityZoneLayer.clearLayers();
      return;
    }
    // Five pin types now, one per population band plus the capital (see
    // CITY_TIERS), so the per-pin question is asked per city like every other
    // multi-type layer -- "towns from z8, capitals from the world board" is the
    // whole reason the bands are separate tokens.
    //
    // The layer-level note still answers the layer-level gate: a band held back
    // by its own zoom is a thinned layer, not an absent one, and saying "zoom in
    // to show cities" while the capitals are on screen would be wrong.
    const zoom = map.getZoom();
    const citiesMinZoom = minZoomFor("cities");
    const belowCitiesMinZoom = zoom < (citiesMinZoom ?? -Infinity);
    const citiesPerPin = layerHasTokenZoom("cities") || layerHasTokenZoomMax("cities");
    // citiesScoped tells the UI *which* note to show (see PlacesSection.jsx)
    // -- "select a country/zone" takes priority over "zoom in", since
    // zooming in without a scope selected still shows nothing.
    zoomNotes.citiesScoped = citiesEnabled;
    zoomNotes.cities = !citiesEnabled || belowCitiesMinZoom;
    scheduleReports({ notes: true });
    const inView = viewportFilter();
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
            if (!inView(c.lat, c.lon)) return false;
            if (citiesPerPin && !pinDrawsAt("cities", c, zoom, citiesMinZoom)) return false;
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
    syncAcrossWorldCopies(markersByKey.cities, citiesGroup, visible, cityKey, buildCityMarker, updateCityMarker);
    renderCityZones(visible);
    counts.cities = visible.length;
    totals.cities = raw.cities.length;
    scheduleReports({ counts: true });
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

  function buildInfraMarker(site, copy = 0) {
    const d = infraDecoration(site, offsetFor("infra", site.id));
    const marker = L.marker(drawLatLng(site, copy), { icon: d.icon });
    marker._item = site;
    marker._iconHtml = d.icon.options.html;
    applyStacking(marker, detailSize(infraIconSize(site)), "infra");
    marker.bindPopup(() => infraDecoration(marker._item).detail, popupOptions(320));
    marker.bindTooltip(() => infraDecoration(marker._item).tooltip, {
      className: "map-tooltip",
      direction: "top",
    });
    return marker;
  }

  function updateInfraMarker(marker, site, copy = 0) {
    const d = infraDecoration(site, offsetFor("infra", site.id));
    marker._item = site;
    // Same fixed omission as updateCityMarker above: a fixed site still has to
    // follow the camera onto whichever copy of the world is being looked at.
    marker.setLatLng(drawLatLng(site, copy));
    if (marker._iconHtml !== d.icon.options.html) {
      marker.setIcon(d.icon);
      marker._iconHtml = d.icon.options.html;
    }
  }

  function renderInfra() {
    if (skipHiddenLayer("infra")) return;
    const inView = viewportFilter();
    const needle = infraNameFilter.trim().toLowerCase();
    // Seven pin types in one layer, which is where a per-pin gate earns its
    // keep: refineries and pipeline nodes can be held back to the zoom where
    // they are worth reading while nuclear sites and fabs keep the layer's own.
    const zoom = map.getZoom();
    const infraPerPin = (layerHasTokenZoom("infra") || layerHasTokenZoomMax("infra"));
    const visible = raw.infra.filter(
      (s) =>
        inView(s.lat, s.lon) &&
        (!needle || s.name.toLowerCase().includes(needle)) &&
        (!infraPerPin || pinDrawsAt("infra", s, zoom, minZoomFor("infra")))
    );
    registerPlacement(
      "infra",
      visible.map((s) => ({ id: s.id, lat: s.lat, lon: s.lon, size: detailSize(infraIconSize(s)) }))
    );
    // Diff-sync like every other point layer -- re-runs on every ACLED/GDELT
    // update too (see renderAll) so a flare turns on/off promptly, without
    // destroying markers/open popups for sites whose hot status didn't change.
    syncAcrossWorldCopies(markersByKey.infra, infraGroup, visible, (s) => s.id, buildInfraMarker, updateInfraMarker);
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
    scheduleReports({ counts: true });
    settlePlacement();
  }

  // Pipeline routes (backend/infrastructure.py's PIPELINE_ROUTES) -- a small
  // static set fetched once (see useOsintData.js), so this just draws every
  // route once rather than diff-syncing per-viewport like the point layers.
  //
  // Drawn on every copy of the world in view, same as the cables below: a route
  // is a line across the globe, not a point, so it has to repeat where the
  // basemap repeats or it stops dead at the seam. See worldCopies above.
  function renderPipelines() {
    pipelinesGroup.clearLayers();
    const offsets = worldCopies();
    worldCopyKeys.pipelines = offsets.join(",");
    for (const route of raw.pipelines) {
      for (const offset of offsets) {
        const line = L.polyline(shiftPathLon(route.coords, offset), {
          color: pipelineRouteColor(),
          // Pipelines are drawn as part of the infrastructure layer and share its
          // dials, the same way the pipeline node's colour token is shared -- a
          // node and the line it sits on must not drift apart.
          weight: scaledWeight(2, "infra"),
          opacity: 0.65 * layerOpacity("infra"),
          dashArray: "6 6",
        });
        // Bound on every copy, not just the primary one. A reader who can see a
        // line can click it; a copy that looks identical but does nothing on
        // click reads as a broken map rather than as a decoration.
        line.bindTooltip(esc(route.name), { className: "map-tooltip", direction: "top" });
        line.bindPopup(`<h3>${esc(route.name)}</h3><p>${esc(route.note || "")}</p>`, popupOptions(280));
        pipelinesGroup.addLayer(line);
      }
    }
    // Per route, not per drawn line. A copy of a pipeline is the same pipeline,
    // and a count that triples when the reader zooms out would be a lie.
    counts.pipelineRoutes = raw.pipelines.length;
    totals.pipelineRoutes = raw.pipelines.length;
    scheduleReports({ counts: true });
  }

  // Cable routes are never bounds-filtered: unlike every marker layer, a polyline
  // is already clipped by Leaflet and a cable only makes sense as a whole line,
  // so cropping it to the viewport would cut cables in half at the edge of the
  // screen for no saving.
  //
  // It is re-drawn only when the number of visible world copies changes (see
  // renderWorldCopyLayers), not on every pan. This layer is the reason the whole
  // copy mechanism exists: a cable mesh is the most visible thing on the map that
  // spans the globe, so with the basemap repeating east-west for ever and the
  // cables drawn on one copy only, panning sideways showed ocean tiles with the
  // cables simply stopping. Now every copy in view carries the full mesh.
  function renderCables() {
    cablesGroup.clearLayers();
    const color = cableRouteColor();
    const offsets = worldCopies();
    worldCopyKeys.cables = offsets.join(",");
    for (const cable of raw.cables) {
      for (const path of cable.paths || []) {
        for (const offset of offsets) {
          const line = L.polyline(shiftPathLon(path, offset), {
            // The publisher's own per-cable colour where there is one, so a cable
            // looks the same here as on the map most readers have already seen.
            color: cable.color || color,
            // Both dials, on a line rather than an icon: weight is what "size"
            // means for a polyline, and the shipped 0.5 is the layer's own
            // judgement that a mesh of 718 routes should sit back -- Admin Mode's
            // opacity multiplies that judgement rather than replacing it, exactly
            // as it does for a marker through layerOpacity.
            weight: scaledWeight(1.4, "cables"),
            opacity: 0.5 * layerOpacity("cables"),
          });
          line.bindTooltip(esc(cable.name), { className: "map-tooltip", direction: "top", sticky: true });
          line.bindPopup(
            `<h3>${esc(cable.name)}</h3>` +
            '<p class="meta">Route drawn schematically, for legibility &mdash; roughly where the cable runs, ' +
            "not its surveyed position on the seabed.</p>" +
            '<div class="meta">Source: TeleGeography submarine cable map</div>',
            popupOptions(280)
          );
          cablesGroup.addLayer(line);
        }
      }
    }
    // Per cable, not per drawn line -- the copies are the same 718 cables seen
    // more than once, and the panel must not claim otherwise.
    counts.cables = raw.cables.length;
    totals.cables = raw.cables.length;
    scheduleReports({ counts: true });
  }

  // Task 27: an OSM line's popup -- name, operator, gauge, electrification,
  // usage and service where OSM has them, plus the same "swept daily, theatre
  // only" honesty the Railways layer's own detail fold states. Kept apart
  // from the Natural Earth popup below because the two are different claims
  // about different data, not two renderings of one fact.
  function osmRailwayPopupHtml(line) {
    const label = line.name ? esc(line.name) : "Unnamed railway";
    const cls = railwayOsmClass(line);
    const classLabel = cls === "narrowGauge" ? "Narrow gauge" : cls === "branch" ? "Branch line" : "Main line";
    const electrified = railwayIsElectrified(line);
    return (
      `<h3>${label}</h3>` +
      `<div class="meta">${esc(classLabel)}${line.railway ? ` &middot; railway=${esc(line.railway)}` : ""}</div>` +
      (line.operator ? `<div>Operator: ${esc(line.operator)}</div>` : "") +
      (line.gauge ? `<div>Gauge: ${esc(line.gauge)} mm</div>` : "") +
      `<div>${electrified ? "Electrified" : "Not electrified (or not stated)"}` +
      `${line.electrified ? ` &middot; <span class="meta">electrified=${esc(line.electrified)}</span>` : ""}</div>` +
      (line.usage ? `<div class="meta">Usage: ${esc(line.usage)}</div>` : "") +
      (line.service ? `<div class="meta">Service: ${esc(line.service)}</div>` : "") +
      `<p class="meta">From <b>OpenStreetMap</b>, swept daily across this map's conflict theatres only -- ` +
      "outside them, the muted Natural Earth linework is the only coverage this layer has.</p>" +
      `<div class="meta">Source: OpenStreetMap contributors (ODbL), via Overpass</div>`
    );
  }

  // Railway linework, drawn once from the whole merged document exactly as
  // renderCables draws the cable routes: a polyline is already clipped by Leaflet
  // and a rail line only makes sense whole, so it is never bounds-filtered.
  //
  // Task 27 layered an attributed OpenStreetMap overlay onto the Natural Earth
  // fallback (see railways.py's own merge), and the honesty this layer carries
  // now has two halves instead of one: a Natural Earth line still states that
  // it is 1:10m basemap linework, static since 2021, unnamed, and that it will
  // not sit exactly on the station points; an OSM line states its own name,
  // operator, gauge and electrification, and that it only exists across the
  // conflict theatres. `line.source` (stamped at collection -- see
  // railways.ne_line_records and osm_infra.parse_rail_lines) is what every
  // per-line decision below reads to tell the two apart; nothing here guesses.
  //
  // Repeated across the visible world copies like the cables and pipelines above,
  // and re-drawn on the same trigger (see renderWorldCopyLayers).
  function renderRailways() {
    railwaysGroup.clearLayers();
    const offsets = worldCopies();
    worldCopyKeys.railways = offsets.join(",");
    const doc = raw.railways || {};
    const lines = Array.isArray(doc.lines) ? doc.lines : [];
    // Read from the stored document rather than hard-coded, so the note tracks
    // whatever the backend actually served (see railways.py's `provenance`).
    const provenance = doc.provenance || "Natural Earth 1:10m, 2021, coarse basemap linework, unnamed";
    const nePopupHtml =
      "<h3>Railway (basemap linework)</h3>" +
      `<p class="meta"><b>Coarse basemap linework, 2021.</b> ${esc(provenance)}. It is context, not ` +
      "survey data, and will <b>not</b> line up exactly with the railway station points on the " +
      "OpenStreetMap infrastructure layer.</p>" +
      '<div class="meta">Source: Natural Earth</div>';
    for (const line of lines) {
      const path = line?.path;
      if (!Array.isArray(path) || path.length < 2) continue;
      const isOsm = line.source === "osm";
      const style = {
        color: railwayLineColor(line),
        // A hairline for Natural Earth and both dials on it like the cables
        // layer: weight is what "size" means for a polyline, and the shipped
        // judgement is that the coarse fallback sits well back behind
        // everything real. The OSM overlay is heavier and mostly solid (see
        // railwayLineBaseWeight/railwayLineDash) precisely because it is real
        // survey data and is meant to read as more assertive than the basemap
        // it sits over.
        weight: scaledWeight(railwayLineBaseWeight(line), "railways"),
        opacity: (isOsm ? 0.85 : 0.55) * layerOpacity("railways"),
        dashArray: railwayLineDash(line),
      };
      const tooltipText = isOsm
        ? `${line.name ? esc(line.name) : "Railway"} (OpenStreetMap)`
        : "Railway (coarse basemap linework, 2021)";
      const popupHtml = isOsm ? osmRailwayPopupHtml(line) : nePopupHtml;
      for (const offset of offsets) {
        const poly = L.polyline(shiftPathLon(path, offset), style);
        poly.bindTooltip(tooltipText, { className: "map-tooltip", direction: "top", sticky: true });
        poly.bindPopup(popupHtml, popupOptions(280));
        railwaysGroup.addLayer(poly);
      }
    }
    // Per line in the document, not per drawn line, for the same reason the cable
    // and pipeline counts are.
    counts.railways = lines.length;
    totals.railways = lines.length;
    // Task 27 fix (post-review): which theatres' OSM rail-line coverage hit
    // osm_infra.py's own MAX_RAIL_LINE_WAYS cap this sweep -- read straight
    // from the document rather than inferred, since only the backend knows
    // the raw (pre-parse) Overpass element count. A capped theatre's lines
    // are real, just partial, and this is what stops that partial view
    // reading as a complete one.
    zoomNotes.railwaysTruncated = Array.isArray(doc.truncated_regions) ? doc.truncated_regions : [];
    scheduleReports({ counts: true, notes: true });
  }

  // Task 20b: the ten named corridors (backend/infrastructure.py's
  // SHIPPING_LANES), a near-copy of renderRailways/renderPipelines just
  // above -- a small curated set of whole polylines, fetched once and
  // repeated across every visible world copy rather than viewport-filtered.
  //
  // The one thing this popup has to say, on every single corridor and in so
  // many words, is the brief's own sentence: this is a hand-drawn schematic,
  // not a surveyed route and not derived from anything this map has
  // observed -- that claim belongs to the density wash (renderLaneDensity)
  // instead, and the two are never allowed to blur into each other.
  function renderShippingLanes() {
    shippingLanesGroup.clearLayers();
    const offsets = worldCopies();
    worldCopyKeys.shippingLanes = offsets.join(",");
    const color = shippingLaneColor();
    for (const lane of raw.shippingLanes) {
      if (!Array.isArray(lane.coords) || lane.coords.length < 2) continue;
      // A transit figure only ever appears with its citation (see
      // backend/tests/test_shipping_corridors.py) -- built once per lane
      // rather than per copy, since it does not depend on the world offset.
      const transitLine = lane.transits
        ? `<div class="meta">${fmtNumber(lane.transits)} ${esc(lane.transits_unit || "")} ` +
          `&mdash; ${esc(lane.transits_publisher || "")}, ${esc(String(lane.transits_year || ""))}</div>`
        : "";
      const popupHtml =
        `<h3>${esc(lane.name)}</h3>` +
        `<p class="meta"><b>Schematic corridor, not a surveyed route.</b> ${esc(lane.note || "")}</p>` +
        transitLine +
        '<div class="meta">Source: backend/infrastructure.py, hand-drawn reference waypoints</div>';
      for (const offset of offsets) {
        const line = L.polyline(shiftPathLon(lane.coords, offset), {
          color,
          // Same hairline-dashed treatment as railways/pipelines: a dial for
          // "size" and one for opacity, dashed so it never reads as a
          // surveyed route even before a reader opens the popup.
          weight: scaledWeight(1.4, "shippingLanes"),
          opacity: 0.6 * layerOpacity("shippingLanes"),
          dashArray: "5 5",
        });
        line.bindTooltip(`${esc(lane.name)} (schematic corridor)`, {
          className: "map-tooltip", direction: "top", sticky: true,
        });
        line.bindPopup(popupHtml, popupOptions(280));
        shippingLanesGroup.addLayer(line);
      }
    }
    // Per corridor in the document, not per drawn line -- the copies are the
    // same ten corridors seen more than once, same reasoning as cables/
    // railways/pipelines above.
    counts.shippingLanes = raw.shippingLanes.length;
    totals.shippingLanes = raw.shippingLanes.length;
    scheduleReports({ counts: true });
  }

  // ---------- water: seas, lakes, rivers ----------
  //
  // Marine arrives once at boot through applyData (see useOsintData.js's
  // one-shot fetch). Lakes and rivers are not part of `raw.water` at all --
  // neither is fetched until a reader switches on its own sub-toggle, so they
  // are held here instead, where "not yet fetched" (null) and "fetched, but
  // empty" ([]) can stay two different things without applyData's generic
  // raw[key]=data assignment ever seeing them.
  let waterLakesFeatures = null;
  let waterRiversFeatures = null;
  let waterLakesVisible = false;
  let waterRiversVisible = false;
  let waterIndex = [];
  let selectedWaterId = null;
  let hoveredWaterId = null;
  // The Leaflet layer backing the currently-open water card, tracked the same
  // way focusedCountryLayer is: renderWater rebuilds the whole layer wholesale
  // (clearLayers + addData, see its own docstring), which invalidates any
  // reference to a previous instance, so this is re-resolved by feature id
  // after every rebuild rather than trusted to survive one.
  let focusedWaterLayer = null;

  /**
   * Rebuild the water layer and its hit-test index from whatever is currently
   * switched on: marine always (once it has arrived), lakes and rivers only
   * while their own sub-toggle is on. Called whenever any of the three
   * changes -- a fresh marine poll, a lakes/rivers fetch landing, or either
   * sub-toggle flipping -- the same "small enough to redraw whole" reasoning
   * renderCountries and syncWater's own note give: a few thousand features at
   * most, not the tens of thousands the point layers cap and collapse for.
   */
  function renderWater() {
    const features = [
      ...(raw.water?.features || []),
      ...(waterLakesVisible ? waterLakesFeatures || [] : []),
      ...(waterRiversVisible ? waterRiversFeatures || [] : []),
    ];
    syncWater(waterLayer, features);
    waterIndex = buildWaterIndex(features);
    // A feature dropped out from under an open selection (its sub-toggle was
    // switched back off) should not go on claiming to be selected.
    if (selectedWaterId != null && !waterIndex.some((e) => e.id === selectedWaterId)) {
      selectedWaterId = null;
      focusedWaterLayer = null;
      reportWaterSelection();
      // Task 25: this path bypasses selectWater entirely (a sub-toggle
      // dropped the feature out from under an open card), but needs no
      // overpass cleanup of its own -- the card itself just closed via
      // reportWaterSelection() above, so its satellitePasses section closed
      // with it. The stale raw.satellitePasses entry for this id is
      // harmless and left in place, the same "never evicted" tradeoff the
      // per-entity fetch caches elsewhere in this file already make.
    } else if (selectedWaterId != null) {
      // The card is still open on a feature that is still in the synced
      // document, but syncWater just tore down and rebuilt every Leaflet layer
      // instance (clearLayers + addData) -- the old focusedWaterLayer reference
      // points at a layer no longer on the map, so the on-screen anchor has to
      // be re-resolved against the new one or the card would drift to wherever
      // the stale instance's last position was.
      focusedWaterLayer = waterLayerFor(selectedWaterId);
      if (focusedWaterLayer) callbacks.onWaterPointChange?.(waterAnchorPoint(focusedWaterLayer));
    }
    updateWaterHighlights();
    // Per feature in the synced document, the same "counts equal totals" rule
    // countries and railways use -- there is no band cap or collapse for a
    // polygon layer like this one.
    counts.water = features.length;
    totals.water = features.length;
    scheduleReports({ counts: true });
  }

  // Same technique updateCountryHighlights/updateSubdivisionHighlights use:
  // Leaflet applies a path's `className` once, at creation, so hover and
  // selection are toggled on the already-rendered element rather than by
  // rebuilding anything -- see water.js's own note on why that also means the
  // colours these two classes show live in CSS custom properties, not here.
  function updateWaterHighlights() {
    waterLayer.eachLayer((layer) => {
      const id = layer.feature?.properties?.id;
      const el = layer.getElement?.();
      if (!el || id == null) return;
      el.classList.toggle("water-selected", id === selectedWaterId);
      el.classList.toggle("water-hovered", id === hoveredWaterId);
    });
  }

  // Rivers, unlike marine and lakes, are never loaded whole -- kind=rivers
  // requires a bbox (the unfiltered document is ~5.12 MB, see backend/app.py's
  // water_endpoint), so what is drawn is only ever whatever extent was last
  // fetched. That has to be tracked and re-fetched as the reader pans, or a
  // pan away from the loaded extent reads as "no rivers here" -- indistinguishable
  // from "we looked and found none", which is exactly the distinction this
  // project's provenance rules exist to preserve (see the memory note on
  // trusted sources: every pin says what kind of evidence it is; an empty
  // layer is itself a claim, and it must be an honest one).
  //
  // waterRiversLoadedBounds is the padded box actually asked for last time, an
  // L.LatLngBounds -- not the viewport at that moment, which is why it is
  // padded 100% before being stored: an ordinary few-hundred-metre pan inside
  // an already-loaded city must not immediately re-trigger a fetch for
  // essentially the same rivers.
  let waterRiversLoadedBounds = null;
  let waterRiversFetchInFlight = false;

  /**
   * Fetch rivers for a padded box around the current viewport and merge the
   * result in. A failed fetch is logged and otherwise ignored -- deliberately
   * NOT setting waterRiversFeatures to null or [] here, because a network
   * hiccup blanking a layer that was showing real rivers a moment ago would
   * be a worse lie than simply not having refreshed yet.
   */
  function fetchRivers() {
    if (waterRiversFetchInFlight) return;
    waterRiversFetchInFlight = true;
    const bounds = map.getBounds().pad(1.0);
    const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
    fetchJson(`/api/water?kind=rivers&bbox=${encodeURIComponent(bbox)}`)
      .then((data) => {
        waterRiversFeatures = data?.features || [];
        waterRiversLoadedBounds = bounds;
        renderWater();
      })
      .catch((err) => console.warn("Failed to load rivers:", err))
      .finally(() => { waterRiversFetchInFlight = false; });
  }

  /**
   * Fetch rivers if the sub-toggle is on and either nothing has loaded yet or
   * the viewport has panned outside what was last fetched. Called on toggle-on
   * and, debounced, from moveend below -- both funnel through the same
   * "has the viewport actually left the loaded extent" check, so a reader
   * cannot end up re-fetching the same rivers on every pan inside a city.
   */
  function maybeRefetchRivers() {
    if (!waterRiversVisible) return;
    if (waterRiversLoadedBounds && waterRiversLoadedBounds.contains(map.getBounds())) return;
    fetchRivers();
  }

  /** The Leaflet layer instance currently backing one water feature id, found
   *  by scanning the live layer group -- there is no persistent per-feature
   *  map the way layerByCountryKey is, since water has no border editor or
   *  any other reason to keep one. */
  function waterLayerFor(id) {
    if (id == null) return null;
    let found = null;
    waterLayer.eachLayer((layer) => {
      if (!found && layer.feature?.properties?.id === id) found = layer;
    });
    return found;
  }

  /** Viewport-pixel anchor for the water info card -- same arithmetic as
   *  countryAnchorPoint, over whichever Leaflet layer is currently backing
   *  the selected feature. */
  function waterAnchorPoint(layer) {
    const center = layer.getBounds().getCenter();
    const pt = map.latLngToContainerPoint(center);
    const rect = container.getBoundingClientRect();
    return { x: rect.left + pt.x, y: rect.top + pt.y };
  }

  function waterEntryFor(id) {
    return id == null ? null : waterIndex.find((e) => e.id === id) || null;
  }

  /** The card payload for one water index entry, built from current data --
   *  the water-body counterpart to countryCardFor above. `bounds` is the
   *  feature's own client bbox (not the Leaflet layer's), converted to the
   *  {south,west,north,east} shape waterCardSections' section builders share
   *  with countryCardSections -- see that function's own docstring on what
   *  it is for (a cheap pre-filter, not the containment test itself). */
  function waterCardFor(entry) {
    const bounds = entry.bbox
      ? { south: entry.bbox.minLat, west: entry.bbox.minLon, north: entry.bbox.maxLat, east: entry.bbox.maxLon }
      : null;
    // `title`, not `entry.name` -- an unnamed bay or sound (routine in 1:10m
    // Natural Earth marine data) has no `entry.name` at all, and
    // waterCardSections already computed the right fallback (its own class
    // label) into `title`. Building the header from `entry.name` directly
    // here would silently throw that fallback away and open with a blank
    // header on exactly the features Task 7's own tests construct.
    const { title, sections } = waterCardSections(entry, raw, bounds);
    const layer = waterLayerFor(entry.id);
    return {
      id: entry.id,
      name: title,
      sections,
      point: layer ? waterAnchorPoint(layer) : null,
      // The raw hit-test geometry and its bbox, alongside the presentational
      // fields above -- WaterInfoCard.jsx ignores both, but IntelPanel's water
      // scope (intelPanelLogic.js) needs them to run the same
      // insideWaterFeature/bboxesOverlap tests this card's own sections do
      // (map/popups.js), rather than filtering records by a second, possibly-
      // drifting approximation of "inside this water body".
      entry,
      bounds,
    };
  }

  /** Tell React which water body's card is open, or that none is -- the
   *  water-body counterpart to reportCountrySelection above. There is no
   *  multi-selection to report alongside it: unlike countries, a water body
   *  has no chips, no highlight that outlives its card, so one id is the
   *  whole of this layer's selection state. */
  function reportWaterSelection() {
    const entry = waterEntryFor(selectedWaterId);
    callbacks.onWaterSelect?.(entry ? waterCardFor(entry) : null);
  }

  /** Rebuild the open water card against data that has just landed -- the
   *  water-body counterpart to refreshFocusedCountryCard, wired from
   *  applyData the same way through WATER_CARD_FEEDS. Just reportWaterSelection
   *  again: that already rebuilds the card from whatever `raw` holds right
   *  now and is a no-op (reports null to a caller that already has null) when
   *  nothing is selected, but the guard here skips that pointless call on
   *  every qualifying poll while no water card is open at all. */
  function refreshFocusedWaterCard() {
    if (selectedWaterId == null) return;
    reportWaterSelection();
  }

  /** Clicking the already-selected water body deselects it -- same gesture
   *  the district/subdivision drill-down and country selection both use. */
  function selectWater(id) {
    if (id === selectedWaterId) return;
    selectedWaterId = id;
    focusedWaterLayer = waterLayerFor(id);
    updateWaterHighlights();
    reportWaterSelection();
    // Task 25: water selection does not go through setFocus (see that
    // function's own note), so its card's overpass section is loaded here
    // instead, on the same "a water body was picked" event. Deselecting
    // (id === null) needs no action of its own: waterEntryFor(null) is
    // null, entry?.bbox is falsy, and the card itself already closed via
    // reportWaterSelection() above -- there is nothing left to refresh.
    const entry = waterEntryFor(id);
    if (entry?.bbox) {
      const [lat, lon] = boundsCentroid([entry.bbox.minLat, entry.bbox.minLon, entry.bbox.maxLat, entry.bbox.maxLon]);
      loadSatellitePasses(`water:${id}`, lat, lon);
    }
  }

  function setHoveredWater(id) {
    if (id === hoveredWaterId) return;
    hoveredWaterId = id;
    updateWaterHighlights();
  }

  // IODA's country-keyed scores -> one marker item per affected country.
  //
  // This layer used to tint the whole country shape instead. Two things were
  // wrong with that: a filled country is the gesture the *selection* highlight
  // already owns, so three countries looked selected that nobody had clicked;
  // and a tint states a fact about the territory, while what IODA has is a
  // measurement. A pin is a thing on the map that can be clicked and explained,
  // and decorateOutage's popup does the explaining the tint could not.
  //
  // Depends on the country boundaries, which arrive on their own schedule --
  // renderCountries calls this too, so whichever of the two lands second is the
  // one that produces the pins.
  function rebuildOutagePoints() {
    const points = [];
    for (const [key, record] of Object.entries(raw.outages || {})) {
      // Natural Earth carries "-99" as the ISO2 of a handful of countries
      // (France and Norway among them), so those shapes are keyed by name
      // instead and an ISO2 lookup alone would silently draw nothing for them.
      // The name IODA reports is the second way in, through the same alias
      // table the country card matches events with.
      const entry = countryEntryFor(key) || countryEntryForName(record?.country);
      if (!entry) continue; // no boundary for this country at all -- nothing to hang a pin on
      const point = representativePointOf(entry);
      if (!point) continue;
      points.push({ ...record, country: record.country || entry.name, lat: point.lat, lon: point.lon });
    }
    raw.outagePoints = points;
  }

  // IODA's sub-national scores (backend/sources/outages.py's region pass) ->
  // one small badge per matched region, at that state's own representative
  // point -- same technique as rebuildOutagePoints above, one admin level
  // finer. Restricted to the states actually drawn right now: unlike the
  // country boundaries, admin-1 geometry is fetched per selection (see
  // drawSubdivisions), so a badge over a shape that is not on screen would
  // have nothing to anchor to and no state highlight to sit beside.
  //
  // Matched purely on `region_code` against a state's own `code` -- no
  // ISO2/ISO3 translation needed here, unlike popups.js's regionOutageFor,
  // because an ISO 3166-2 code already names its country and two different
  // countries can never collide on one. An unmatched record (region_code is
  // null) never reaches this loop at all: see outages.py's own docstring on
  // why it stays in the payload anyway, just not drawn.
  function rebuildOutageRegionPoints() {
    const drawnIso3 = drawnSubdivisionCountries ? new Set(drawnSubdivisionCountries.split(",")) : null;
    const points = [];
    if (drawnIso3 && drawnIso3.size) {
      for (const [countryCode, regions] of Object.entries(raw.outagesRegions || {})) {
        for (const [key, record] of Object.entries(regions || {})) {
          if (record.matched === "unmatched") continue;
          const entry = subdivisionIndex.find(
            (e) => e.code === record.region_code && drawnIso3.has(e.country_code)
          );
          if (!entry) continue;
          const point = representativePointOf(entry);
          if (!point) continue;
          points.push({ ...record, id: `${countryCode}:${key}`, name: entry.name, lat: point.lat, lon: point.lon });
        }
      }
    }
    raw.outageRegionPoints = points;
  }

  function renderAll() {
    // One placement pass for the whole map, at the end. Without the
    // suspension each of the eight renderers below would settle on its own,
    // against input where the other seven layers still held the *previous*
    // viewport's positions -- eight passes per pan, most of them wrong.
    // Before the marker layers, and outside the placement suspension: these three
    // are polylines, so they take no part in the declutter pass at all. Almost
    // always a no-op -- it only does work on the pan or zoom that changes how many
    // copies of the world are on screen.
    renderWorldCopyLayers();
    settleSuspended += 1;
    try {
      renderAllLayers();
    } finally {
      settleSuspended -= 1;
    }
    settlePlacement();
    // Here as well as inside the two heat renderers: the sprite canvas is a
    // dynamic import that can land after a render has already run, and a layer
    // that is switched off is never re-rendered at all, so neither would
    // otherwise pick up an order change.
    applyWashStack();
    // Synchronously, after the placement pass: every renderer above marked its
    // numbers dirty, and a whole render pass should reach React as one commit
    // rather than as whatever the microtask queue happens to interleave.
    flushReports();
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
    renderMarkerLayer("outagePoints");
    // Zoom-gated (unlike outagePoints above), so it needs the same pan/zoom
    // re-render every bounds-filtered layer here gets -- see its own draw
    // band in scene.js.
    renderMarkerLayer("outageRegionPoints");
    renderMarkerLayer("launches");
    renderMarkerLayer("osmInfra");
    // Task 27: bounds-filtered like osmInfra above (it reads the same raw
    // sweep, just split -- see applyData's own note), so it needs the same
    // pan/zoom catch-up.
    renderMarkerLayer("railwayPoints");
    // Live and ungated, but still bounds-filtered like every other marker
    // layer here -- without this it would render once and sit empty
    // wherever the map panned to since the last poll, the same reasoning
    // conflictHistory's own note gives above.
    renderMarkerLayer("railLive");
    // Static, but still bounds-filtered the same way -- the gazetteer arrives
    // once and stays put, but "once" can be before the reader has panned
    // anywhere near Finland.
    renderMarkerLayer("railStations");
    // Same reasoning as hazards above -- all six bounds-filter to the viewport
    // and none polls faster than every ten minutes, so without a pan/zoom
    // re-render each would sit empty everywhere the map moved to since its last
    // poll. The slowest here refreshes every six hours.
    renderMarkerLayer("gfwGaps");
    renderMarkerLayer("gfwDetections");
    renderMarkerLayer("czib");
    renderMarkerLayer("floods");
    renderMarkerLayer("ports");
    renderMarkerLayer("dams");
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
    // Same reasoning as jamming just above: bounds-filtered, and the grid
    // itself only moves once an hour server-side, so without a pan/zoom
    // re-render this would sit empty everywhere the map moved to since the
    // last poll.
    renderLaneDensity();
    renderSatellites();
    // Task 24's three DOM-marker groups bounds-filter to the viewport too
    // (see renderSatElementLayer), so they need the same pan/zoom catch-up
    // renderSatellites gets just above. Three of the four WebGL ones do not:
    // they are unfiltered feeds on a canvas that reprojects itself (see
    // renderSatElementWebgl's own note), kept moving by their own timer
    // instead (tickAndRedrawSatElements). satImaging is the exception --
    // it is THEATRE-gated (see map/scene.js), and without a call here
    // crossing that gate would wait up to SAT_ELEMENT_REDRAW_MS (2s) for the
    // next tick to notice, instead of responding to the zoom the way every
    // other gated layer (floods, hazards, ...) does immediately.
    renderSatElementLayer("satNavigation");
    renderSatElementLayer("satWeather");
    renderSatElementLayer("satScience");
    renderSatElementWebgl("satImaging");
    updateCountryWarFlare();
  }

  // ---------- wind arrows: fetched for whatever's currently in view ----------

  let firstWindLoadDone = false;
  async function refreshWindArrows() {
    // The layer is off by default (see DEFAULT_LAYER_VISIBILITY in App.jsx), and
    // this used to run regardless: a debounced round trip on every moveend, plus
    // a five-minute interval, plus a visibilitychange catch-up, all to hand data
    // to a layer that is not on the map. Open-Meteo's free tier has a hard daily
    // cap, so this was not merely wasted -- it was spending the day's budget on
    // nothing. setLayerVisible catches up when the layer is switched on.
    if (layerOnMap.windArrows === false) return;
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
    // Only a zone counts as a selection to snap back from. "world" arrives here
    // as a key like any other, and storing it made the truthiness check in the
    // moveend handler below read a deliberate *deselection* as a live
    // selection: the first pan after clicking World would announce an
    // auto-reset back to World, costing a full refetch of every source to
    // arrive at the state already in effect. Tested for the same way as
    // activeConflictZoneBounds just below, so an unrecognised key -- which
    // flies to the world view -- is treated as the World it actually shows
    // rather than as a zone that cannot be left.
    currentRegionKey = entry && entry.bounds ? key : null;
    regionFlightActive = true;
    clearTimeout(regionFlightTimer);
    if (entry && entry.bounds) {
      const [south, west, north, east] = entry.bounds;
      map.flyToBounds(L.latLngBounds([south, west], [north, east]), { padding: [40, 40], duration: REGION_FLY_DURATION });
    } else {
      map.flyTo([20, 15], allowedZoom(3), { duration: REGION_FLY_DURATION });
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
    map.flyTo([lat, lon], allowedZoom(Math.max(map.getZoom(), minZoom)), { duration: 1.2 });
  }

  // ---------- event wiring ----------

  map.on("moveend", () => {
    // The floor, enforced where nothing can undo it.
    //
    // Every other place that could hold the view below the floor has already had its
    // turn by now: construction, a flyTo (which ignores minZoom entirely), a
    // container that had no size when the floor was first computed. Correcting here
    // costs one extra zoom cycle in the rare case it fires, and the early return
    // means the pass below never renders a view that is about to change anyway.
    // Through applyWorldFence rather than a bare setZoom: the fence is on by now, so
    // a direct zoom would be the one Leaflet refuses. That function drops the fence,
    // clamps, and puts it back.
    if (map.getZoom() < map.getMinZoom()) {
      applyWorldFence();
      return;
    }
    // A region is still selected but this moveend wasn't from our own
    // flyTo/flyToBounds -- the user panned/zoomed away on their own, so the
    // region's payload-scoped data no longer matches what's on screen (that
    // causes stale markers and drifting-looking country shapes). Tell React
    // to snap back to unscoped global data, same as clicking "World".
    if (!regionFlightActive && currentRegionKey) {
      currentRegionKey = null;
      callbacks.onRegionAutoReset?.();
    }
    // Before renderAll, so no renderer ever sees a scene resolved for the
    // previous viewport.
    applyScene();
    renderAll();
    callbacks.onBoundsChange?.(boundsToPlainObject(map.getBounds()));
    reportZoom();
    clearTimeout(moveEndWindTimer);
    moveEndWindTimer = setTimeout(refreshWindArrows, 500); // debounced: don't hammer Open-Meteo mid-drag
    // Same debounce idea, for the rivers sub-toggle's loaded extent -- a no-op
    // call when the toggle is off or the viewport is still inside what was
    // last fetched (see maybeRefetchRivers), so this costs nothing on every
    // other pan.
    clearTimeout(moveEndRiversTimer);
    moveEndRiversTimer = setTimeout(maybeRefetchRivers, 500);
  });

  // Country info card is anchored to a screen pixel, not a DOM position
  // Leaflet manages itself (see CountryInfoCard.jsx) -- "move"/"zoom" fire
  // continuously during pan/zoom animation (unlike moveend), so this is what
  // keeps the card glued to its country instead of drifting off during a
  // drag or zoom gesture.
  map.on("move zoom", () => {
    if (focusedCountryLayer) callbacks.onCountryPointChange?.(countryAnchorPoint(focusedCountryLayer));
    // Water info card, same reasoning: glued to its feature's on-screen
    // position through a pan or zoom gesture rather than left to drift.
    if (focusedWaterLayer) callbacks.onWaterPointChange?.(waterAnchorPoint(focusedWaterLayer));
    // State and district info cards, same reasoning again.
    if (focusedSubdivisionLayer) callbacks.onSubdivisionPointChange?.(subdivisionAnchorPoint(focusedSubdivisionLayer));
    if (focusedDistrictLayer) callbacks.onDistrictPointChange?.(districtAnchorPoint(focusedDistrictLayer));
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

    const modified = !!(e.originalEvent
      && (e.originalEvent.ctrlKey || e.originalEvent.metaKey || e.originalEvent.shiftKey));

    // Inside a country whose states are drawn, a plain click is about what is
    // inside that country, and it is claimed here before country selection sees
    // it. That is the whole gesture, one level per click: click a country and
    // its states appear, click a state and that state is singled out along with
    // its districts where there are any, click one of those districts and its
    // conflict record opens. Each click back out again is the same click on the
    // thing already selected.
    //
    // Claimed on the *country*, not on hitting a state, so that a click landing
    // in one of the slivers a generalised coastline leaves between a state and
    // the country outline does nothing rather than silently dropping the country
    // the reader is reading.
    //
    // It does mean a plain click can no longer deselect the country it lands
    // in, so the two ways out both stay reachable: the selection chip's x, and
    // a modifier-click, which is why this is skipped when one is held. A click
    // on any *other* country falls through untouched, so switching subject is
    // still one click and ctrl-click still adds.
    const drill = (!borderSession && !modified) ? drillTargetAt(e.latlng) : null;
    if (drill) {
      const { state, district } = drill;
      if (district) {
        const wasSelected = district.pcode === selectedDistrictPcode;
        // selectDistrict reports the open/closed card to React itself (see
        // reportDistrictSelection) -- the same "select decides, no separate
        // popup branch" shape selectWater already uses below.
        selectDistrict(wasSelected ? null : district.pcode);
        return;
      }
      const wasSelected = state && state.key === selectedSubdivisionKey;
      selectSubdivision(state && !wasSelected ? state.key : null);
      return;
    }

    // Country selection is a *fallback* hit-test rather than a handler on the
    // shapes themselves -- see countryHitTest.js. Everything above this point
    // has already had its chance to claim the click.
    if (countriesVisible) {
      const entry = findCountryAt(countryIndex, e.latlng.lat, e.latlng.lng);
      // While a boundary is being edited, a click inside the country being
      // worked on does nothing: the alternative is that a missed grab at a
      // handle deselects the very thing under the pointer and closes the
      // editor. Clicking a *different* country still moves on, so switching
      // subject stays one gesture rather than two.
      if (borderSession) {
        if (entry && entry.key !== borderSession.countryKey) {
          endBorderEdit();
          selectCountryEntry(entry, false);
        }
        return;
      }
      if (entry) {
        // Ctrl (Windows/Linux), Cmd (macOS) or Shift adds to the selection
        // instead of replacing it -- the same modifier every file manager and
        // map editor uses for multi-select, so it needs no instruction. It is
        // `modified`, read above from originalEvent because Leaflet's own event
        // object carries no modifier state.
        selectCountryEntry(entry, modified);
        return;
      }
    }

    // Water is the next fallback, tried only once the country hit-test above
    // has already said no -- so a lake sitting entirely inside a country never
    // steals a click from the country around it, and a click at sea (where
    // findCountryAt can only ever answer null) reaches here instead.
    if (waterVisible && waterIndex.length) {
      const waterEntry = findWaterAt(waterIndex, e.latlng.lat, e.latlng.lng);
      if (waterEntry) {
        // Clicking the already-selected water body deselects it, same gesture
        // as the subdivision drill-down above and country selection below.
        // selectWater reports the open/closed card to React itself (see
        // reportWaterSelection) -- this used to also open a plain Leaflet
        // popup here, superseded by the full card Task 7 adds.
        const wasSelected = waterEntry.id === selectedWaterId;
        selectWater(wasSelected ? null : waterEntry.id);
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

    // Nothing was under the click and nothing above claimed it, so the reader
    // is looking at the whole picture again: drop the selection, drop the
    // emphasis, put the corroborating layers away, and close any group they had
    // opened. Last, because every branch above returns before reaching here.
    //
    // clearCountrySelection calls setFocus(null) itself when there was a
    // selection to drop; the call below is for the case where there was not --
    // an emphasis set by clicking a pin rather than a country. setFocus is a
    // no-op when the focus already matches, so running both costs nothing.
    //
    // Water selection is dropped here too, on the same reasoning: it has no
    // parent selection to fall out of step with (unlike a subdivision, which
    // is only ever drawn under a selected country and so is cleared when that
    // country is), so a genuinely empty click is the only gesture that can
    // mean "and put the sea away as well". selectWater is a no-op when
    // nothing is selected, so this costs nothing on the common empty click.
    selectWater(null);
    clearCountrySelection();
    setFocus(null);
  });

  // Hover highlight, same fallback path as the click above. Throttled to one
  // hit-test per animation frame: mousemove fires far faster than the map can
  // repaint, and each test is a bbox scan plus one or two ray-casts.
  let hoverFrame = null;
  let pendingHoverLatLng = null;
  map.on("mousemove", (e) => {
    // mousemove is not one of the events L.Marker stops (that list is
    // click/dblclick/mouseover/mouseout/contextmenu), so moving over a vertex
    // handle arrives here with sourceTarget set to the marker -- the bail
    // below would then leave the last country highlighted for as long as the
    // pointer stayed on the handle. Editing has its own highlight anyway.
    if (borderSession) {
      setHoveredCountry(null);
      setHoveredSubdivision(null);
      setHoveredDistrict(null);
      setHoveredWater(null);
      return;
    }
    if (e.sourceTarget && e.sourceTarget !== map) return;
    pendingHoverLatLng = e.latlng;
    if (hoverFrame != null) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = null;
      const latlng = pendingHoverLatLng;
      if (!latlng) {
        setHoveredCountry(null);
        setHoveredSubdivision(null);
        setHoveredDistrict(null);
        setHoveredWater(null);
        return;
      }
      if (!countriesVisible) {
        setHoveredCountry(null);
        setHoveredSubdivision(null);
        setHoveredDistrict(null);
      } else {
        setHoveredCountry(findCountryAt(countryIndex, latlng.lat, latlng.lng)?.key ?? null);
        // Only over a selected country's states, which is the only place any
        // are drawn -- and only then is the extra scan paid for. It is the
        // same cost as the country test above (bbox rejects, then one or two
        // ray-casts), over at most a few hundred shapes.
        const codes = subdivisionIndex.length ? subdivisionCountryCodes() : null;
        const state = codes?.size
          ? findSubdivisionAt(subdivisionIndex, latlng.lat, latlng.lng, codes)
          : null;
        setHoveredSubdivision(state?.key ?? null);
        // And one level in again, over the selected state only -- the few
        // dozen districts drawn there, rejected on their bounding boxes first.
        setHoveredDistrict(
          state && state.key === selectedSubdivisionKey
            ? findDistrictAt(districtsOfSelectedState(), latlng.lat, latlng.lng)?.pcode ?? null
            : null
        );
      }
      // Independent of countriesVisible -- water is its own layer with its own
      // checkbox, so a reader can have it on with countries off (or the other
      // way round) and hover has to answer for whichever is actually showing.
      setHoveredWater(
        waterVisible && waterIndex.length
          ? findWaterAt(waterIndex, latlng.lat, latlng.lng)?.id ?? null
          : null
      );
    });
  });
  // Leaving the map entirely never fires a mousemove that misses every
  // country, so the highlight would otherwise stay stuck on whatever was last
  // under the pointer.
  map.on("mouseout", () => {
    setHoveredCountry(null);
    setHoveredSubdivision(null);
    setHoveredDistrict(null);
    setHoveredWater(null);
  });

  // "Separate these pins", inside a collapsed group's popup. Delegated from the
  // popup pane rather than bound per popup, because popups are built lazily on
  // open (see buildMarker's bindPopup) and rebuilt on every open, so anything
  // bound to a specific popup's DOM would have to be re-bound each time.
  map.on("popupopen", (e) => {
    const button = e.popup?.getElement()?.querySelector(".cluster-expand");
    if (!button) return;
    button.addEventListener("click", () => {
      map.closePopup();
      toggleCluster(button.dataset.clusterId);
    }, { once: true });
  });

  // Sync every layer's actual add/remove state right after construction --
  // most layers default to .addTo(map) individually in layers.js, so a layer
  // that should start hidden needs removing once, here, before the map ever
  // paints (no flash-then-hide). Must run after every render function/const it
  // might call into (setLayerVisible("satellites", true) calls
  // renderSatellites(), which reads `counts`/`zoomNotes` -- running this any
  // earlier hits their temporal-dead-zone before those `const`s are
  // initialized).
  //
  // The caller's own defaults, when it passes any, are applied as *wishes*
  // rather than as state: an explicit default outranks the resolver for as long
  // as it stands, which is what keeps Admin Mode's checkboxes authoritative.
  // Anything the caller does not name is left to the scene.
  applyLayerWishes(initial.layerVisibility);

  refreshWindArrows();
  windRefreshTimer = setInterval(refreshWindArrows, 5 * 60 * 1000); // catches slow wind changes even if the view sits still
  refreshPrecipRadar();
  precipRefreshTimer = setInterval(refreshPrecipRadar, 10 * 60 * 1000); // matches RainViewer's own pass cadence
  // Task 24: navigation/weather/imaging (on by default -- see map/scene.js)
  // are fetched by useOsintData.js's own POLL_CONFIG, which lands here
  // through applyData's "key in SAT_ELEMENT_CELESTRAK_GROUP" branch below,
  // the same as every other default-on source -- not fetched by this
  // controller directly. The other four (science/geo/starlink/oneweb) are
  // off by default and fetch on their own first toggle instead -- see
  // setLayerVisible and SAT_ELEMENT_ON_DEMAND_LAYERS above.
  satElementTickTimer = setInterval(tickAndRedrawSatElements, SAT_ELEMENT_REDRAW_MS);
  function onVisibilityChange() {
    if (!document.hidden) refreshWindArrows(); // catch up immediately instead of waiting out the rest of the 5min interval
  }
  document.addEventListener("visibilitychange", onVisibilityChange);
  // Before the first bounds/zoom report, so React is never told about a view that
  // the floor is about to correct.
  applyWorldFence();
  // And again once Leaflet considers the map loaded. The call above runs during
  // construction, and setZoom on a map that is not `_loaded` yet only assigns
  // `_zoom` -- no zoomlevelschange, no disabled zoom-out control, and nothing to
  // stop a later flight from undoing it. whenReady is the first moment the clamp can
  // actually stick.
  map.whenReady(() => applyWorldFence());
  callbacks.onBoundsChange?.(boundsToPlainObject(map.getBounds()));
  reportZoom();

  // ---------- public API (consumed by useLeafletMap.js) ----------

  return {
    map,

    applyData(key, data) {
      // A poll landing mid-edit must not replace the geometry under the
      // handles. The guard is on the assignment rather than on the render,
      // because the assignment is the destructive half -- skipping only the
      // redraw would leave the editor dragging vertices of an object the map
      // had already thrown away.
      if (key === "countries" && borderSession) {
        pendingCountries = data;
        return;
      }
      // Task 27: one fetch (backend/sources/osm_infra.py) still returns all
      // five kinds together, but the four railway ones now belong to a
      // different layer -- so the split happens here, once per landing,
      // rather than at render time. Splitting `raw` itself rather than
      // filtering inside renderMarkerLayer is what keeps every generic
      // consumer honest with no further changes: each layer's own `total`
      // (items.length in renderMarkerLayer, and skipHiddenLayer's
      // totals-when-hidden path) now counts only what actually belongs to
      // it, and rebuildOsmTwins/COUNTRY_CARD_FEEDS/the data editor all read
      // raw.osmInfra expecting infrastructure, not stations.
      if (key === "osmInfra") {
        const items = Array.isArray(data) ? data : [];
        raw.osmInfra = items.filter((item) => !isRailwayPointItem(item));
        raw.railwayPoints = items.filter(isRailwayPointItem);
      } else {
        raw[key] = data;
      }
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
      // Same shape, same reason: the pairing is between three feeds that arrive
      // on three different schedules (airfields hourly, dams every six hours,
      // OSM every thirty minutes), so whichever lands has to re-pair against
      // the two already held. osmInfra is redrawn because its suppressions have
      // just changed; the other two because their popups name what they
      // absorbed. See passesOsmInfraFilter.
      if (key === "osmInfra" || key === "airports" || key === "dams") {
        rebuildOsmTwins();
        for (const layer of ["osmInfra", "airports", "dams"]) {
          if (layer !== key) renderMarkerLayer(layer);
        }
      }
      // railwayPoints has just been rebuilt above; redraw it whenever a fresh
      // OSM sweep lands, the same "whichever lands gets redrawn" rule the
      // twin-rebuild block just above already follows.
      if (key === "osmInfra") renderMarkerLayer("railwayPoints");
      if (key === "countries") renderCountries();
      else if (key === "firms") renderFirms();
      else if (key === "cities") {
        // The zones are derived from this feed, so they are rebuilt with it --
        // and the conflict layer redrawn, because whether two reports group
        // depends on an index that has just changed underneath it.
        rebuildCityZoneIndex();
        renderCities();
        renderMarkerLayer("events");
      }
      else if (key === "infra") renderInfra();
      else if (key === "pipelines") renderPipelines();
    else if (key === "cables") renderCables();
    else if (key === "railways") renderRailways();
    else if (key === "shippingLanes") renderShippingLanes();
    else if (key === "water") renderWater();
    // Served as a country-keyed dict (read as-is by the country card), drawn
    // from the derived point array -- same split as cables/cableLandings.
    else if (key === "outages") {
      rebuildOutagePoints();
      renderMarkerLayer("outagePoints");
    }
    // Same split, one admin level finer: {ISO2: {code: record}} read as-is by
    // the state/district cards and the state-target choropleth, drawn from the
    // derived badge array.
    else if (key === "outagesRegions") {
      rebuildOutageRegionPoints();
      renderMarkerLayer("outageRegionPoints");
    }
      else if (key === "jamming") renderJamming();
      else if (key === "laneDensity") renderLaneDensity();
      else if (key === "satellites") renderSatellites();
      // Task 24: navigation/weather/imaging land here from useOsintData.js's
      // own POLL_CONFIG (see that file) -- raw[key] was just set above like
      // every other source, but the element sets themselves are kept in
      // satElements[key] (see fetchSatElements' own note on why), so this
      // branch copies the payload across, runs an immediate SGP4 pass
      // (force=true -- a reader should not wait out however much of the
      // cadence window is left after a fresh poll), and redraws. The other
      // four groups (science/geo/starlink/oneweb) never reach this branch --
      // they are fetched on demand, straight into satElements, by
      // fetchSatElements itself; see SAT_ELEMENT_ON_DEMAND_LAYERS.
      else if (key in SAT_ELEMENT_CELESTRAK_GROUP) {
        satElements[key] = Array.isArray(data) ? data : [];
        tickSatElementLayer(key, true);
        renderSatElement(key);
      }
      // Neither of these is a point array with a layer of its own, so both
      // would otherwise fall through to renderMarkerLayer and blow up on a
      // missing group/marker map. conflictStats is a country->monthly-series
      // dict (hdx_conflict_stats.py) and escalation is a ranked region list
      // (escalation.py); both are read straight out of `raw` by popups.js
      // when a country card is built.
      // energyFlows (ISO2), foodTrade (ISO3) and foodPriceIndex (one global
      // document) join the same branch for the same reason: a cross-border
      // electricity flow is an edge between two countries and a marketing-year
      // balance sheet is a forecast about a whole state, so neither has a point
      // to draw. Both surface as a country-card section and a country fill.
      else if (key === "conflictStats" || key === "escalation" || key === "conflictDistricts"
             || key === "humanitarian" || key === "energyFlows" || key === "foodTrade"
             || key === "foodPriceIndex" || key === "fetchCoverage") {
        /* reference data read on demand by popups.js -- no marker layer */
      }
      // Keyed by airfield ident, not a point layer of its own: it re-sizes and
      // re-describes pins the airports layer already draws, so a fresh document
      // means re-rendering that layer rather than adding anything.
      else if (key === "airfieldActivity") renderMarkerLayer("airports");
      else if (key === "conflictHistory") renderMarkerLayer("conflictHistory");
      else renderMarkerLayer(key);
      if (key === "events") updateCountryWarFlare();
      // Three of the six country-fill metrics read these dicts, and the fill is
      // computed once per poll rather than per paint. Repainting only on the
      // feed that can actually move a value keeps a metric current without
      // re-running the pass on every unrelated poll (renderCountries does its
      // own after a boundary rebuild).
      if (CHOROPLETH_FEEDS.has(key)) refreshChoropleth();
      // An open country card is built from `raw` at the moment it opens, so
      // without this it would keep showing the counts that were true when it
      // was clicked -- indefinitely, since the card outlives pans and zooms
      // now. See refreshFocusedCountryCard for which feeds qualify.
      if (COUNTRY_CARD_FEEDS.has(key)) refreshFocusedCountryCard();
      // Same property, same fix, for the water card -- see WATER_CARD_FEEDS
      // and refreshFocusedWaterCard.
      if (WATER_CARD_FEEDS.has(key)) refreshFocusedWaterCard();
      // And again for the state/district cards -- see SUBDIVISION_CARD_FEEDS/
      // DISTRICT_CARD_FEEDS above for which feeds qualify, and why the
      // district card's own conflict fold is not among them.
      if (SUBDIVISION_CARD_FEEDS.has(key)) refreshFocusedSubdivisionCard();
      if (DISTRICT_CARD_FEEDS.has(key)) refreshFocusedDistrictCard();
    },

    flyToRegion,
    flyTo,

    // The checkbox path. Writes a wish rather than touching the map directly,
    // so the resolver knows it has been overruled for this key and stops
    // deciding it. Pass null to hand the key back to the scene.
    setLayerVisible: setLayerWish,

    setInfraFilter(text) {
      infraNameFilter = text || "";
      renderInfra();
    },

    setEventFilter(next) {
      eventFilter = { ...eventFilter, ...(next || {}) };
      renderMarkerLayer("events");
    },

    // Merge-patch, same as setEventFilter above -- App.jsx's onVesselFilter/
    // AircraftFilterChange send only the fields that changed (see
    // onEventFilterChange for why: React state updaters run during render,
    // and this method's own redraw has to happen from an effect afterward,
    // not from inside the updater).
    setVesselFilter(next) {
      vesselFilter = { ...vesselFilter, ...(next || {}) };
      renderAisLayer();
    },

    setAircraftFilter(next) {
      aircraftFilter = { ...aircraftFilter, ...(next || {}) };
      renderAdsbLayer();
    },

    /** Which number the shapes are painted by (null clears it), and which
     *  shapes -- "country" or "state" -- that number paints (Task 26). */
    setChoroplethMetric(metricId, target = "country") {
      const nextTarget = target === "state" ? "state" : "country";
      const next = metricId || null;
      if (next === choroplethMetricId && nextTarget === choroplethTarget) return;
      choroplethMetricId = next;
      choroplethTarget = nextTarget;
      refreshChoropleth();
    },


    // The moment ages are measured against. Replay passes its scrubbed
    // timestamp; null restores the wall clock. Redraws immediately, since
    // moving the reference is exactly as consequential as moving the window.
    setAgeReference(ts) {
      const next = Number.isFinite(ts) ? ts : null;
      if (next === ageReference) return;
      ageReference = next;
      renderMarkerLayer("events");
    },

    // Closes the info card without touching the selection. The country stays
    // highlighted, which is the whole point of a selection that outlives a
    // glance: shutting a card is not the same gesture as deselecting.
    closeCountryCard() {
      focusCountry(null);
    },

    // Water has no separate "selected but not focused" state the way a
    // country does (no chips, no highlight that outlives its card -- see
    // reportWaterSelection), so closing its card and deselecting it are the
    // same gesture, unlike closeCountryCard above.
    closeWaterCard() {
      selectWater(null);
    },

    // Neither a state nor a district has a chip-backed selection that outlives
    // its card either -- same shape as closeWaterCard, one gesture apiece.
    closeSubdivisionCard() {
      selectSubdivision(null);
    },

    closeDistrictCard() {
      selectDistrict(null);
    },

    // The month `<select>` a district card's own header renders (see
    // DistrictInfoCard.jsx) calls this directly rather than going through a
    // popup-content rebind, now that the picker is a real React element
    // instead of a string of HTML.
    setDistrictMonth(month) {
      setDistrictMonth(month);
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
      syncSubdivisions();
    },

    /**
     * Repaint the boundaries from whatever is now in `raw.countries`.
     *
     * renderCountries fingerprints on the feature count and the ISO list, so a
     * change that only moved vertices does not look like a change to it (the
     * reasoning is written out above renderCountries, and it is the right
     * trade for a five-minute poll of a dataset that changes once a day).
     * Applying a stored border edit is exactly that kind of change, so it needs
     * a way to say "this one really did".
     */
    refreshCountriesNow() {
      // The session is the authority on its own country's geometry while it is
      // live, and its own commits are what trigger this -- repainting here
      // would rebuild the layer out from under the open handles.
      if (borderSession) return;
      lastCountriesSignature = null;
      renderCountries();
    },

    /**
     * Start dragging one country's boundary.
     * @returns {boolean} whether a session actually opened
     */
    beginBorderEdit(countryKey, options) {
      if (borderSession) return false;
      if (!countryLayerFor(countryKey)) return false;
      if (!borderEditor.begin(countryKey, options)) return false;
      borderSession = { countryKey };
      countriesLayer.eachLayer((layer) => {
        const key = countryKeyOfProps(layer.feature?.properties || {});
        layer.getElement?.()?.classList.toggle("country-editing", key === countryKey);
      });
      return true;
    },

    endBorderEdit() {
      endBorderEdit();
    },

    setBorderLinkMode(on) {
      borderEditor.setLinkMode(on);
    },

    undoBorderEdit() {
      return borderEditor.undo();
    },

    /** Drop the whole selection -- the "Clear" the highlight waits for. */
    clearCountrySelection() {
      if (!selectedCountryKeys.size) return;
      selectedCountryKeys.clear();
      citiesEnabled = !!activeConflictZoneBounds;
      renderCities();
      focusCountry(null);
      reportCountrySelection();
      syncSubdivisions();
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
      // After renderAll rather than instead of the calls inside it: a layer that
      // is switched off is not re-rendered, so its canvas would keep the
      // previous opacity until the next time it was drawn.
      applyWashStack();
    },

    // Per-layer zoom gates from Admin Mode: { [layerKey]: minZoom|null }.
    // Applied as an override table rather than by mutating the shipped
    // constants, so "reset" is dropping the entry rather than remembering what
    // the original number was.
    setLayerZoomOverrides(next) {
      layerZoomOverrides = next || {};
      applyScene();
      renderAll();
    },

    /**
     * The ceilings: { [layerKey]: maxZoom|null }, sparse.
     *
     * Separate from setLayerZoomOverrides rather than one call taking both,
     * because the floor is threaded into the resolver (a fetch gate has to agree
     * with it -- see useOsintData's POLL_CONFIG) and the ceiling is not. A layer
     * held back by a ceiling is still fetched: it is on screen a moment earlier
     * and a moment later, and re-polling on every crossing would be a lot of
     * traffic to save nothing anyone can see.
     */
    setLayerZoomMaxOverrides(next) {
      layerZoomMaxOverrides = next || {};
      applyScene();
      renderAll();
    },

    /**
     * Admin Mode's saved layer states: { [key]: boolean }, sparse.
     *
     * A checkbox in the control drawer is an operator's standing decision about
     * a layer, not a decision about this session, so it is stored with the rest
     * of the configuration and replayed here. Sparse for the reason the setting
     * itself documents: an absent key is "the resolver decides", and that is a
     * state a boolean cannot express.
     */
    setLayerWishes(next) {
      applyLayerWishes(next);
    },

    /**
     * City zones: whether reports are grouped by city, whether the rings are
     * drawn, and how wide a zone is (see map/cityZones.js).
     *
     * The index is rebuilt rather than re-filtered, because the radius is baked
     * into the grid registration -- a zone is indexed into every cell it can
     * reach, and changing how far it reaches changes which cells those are.
     */
    /**
     * One record's full detail, by layer and id -- what its pin would say.
     *
     * Deliberately the decorator's own `detail` rather than a second renderer
     * written for the card. That string is where a record's sourcing lives: the
     * outlet and its reliability band, how the position was arrived at and
     * whether anyone corroborated it, the caveats each feed carries. A card that
     * rebuilt "the details and the source" by hand would be a second opinion
     * about the same record, and the two would drift.
     *
     * Resolved against the live feed at click time, so a row rendered from a
     * poll three minutes ago cannot show a record that has since been edited in
     * Admin Mode or dropped by the backend -- it returns null instead, and the
     * caller says so.
     */
    recordDetail(kind, id) {
      const decorate = DECORATORS[kind];
      const idField = ID_FIELD[kind];
      if (!decorate || !idField) return null;
      const item = (raw[kind] || []).find((record) => String(record[idField]) === String(id));
      if (!item) return null;
      const d = decorate(item, decorateOptionsFor(kind, item, id));
      // Fused conflict/violence records get the real card (see map/eventDetail.js):
      // six blocks built straight off the record's own fields, each with its own
      // provenance line, instead of the summary decorateEvent wrote for a hover
      // popup. Every other kind is untouched -- same decorator output as always,
      // so nothing that already opened through this card regresses.
      const html = kind === "events" ? buildEventDetailHtml(item, raw) : d.detail;
      return { title: d.title || null, html, kind, lat: item.lat, lon: item.lon };
    },

    /**
     * One feed's records, for the data editor to browse.
     *
     * The controller is where every payload lands (see applyData), so this is
     * the only place that has all of them. Handed back by reference rather than
     * copied: several of these run to tens of thousands of rows, the editor
     * filters and caps before it renders anything, and duplicating a 48,000-row
     * airfield list into React state on every poll to populate a panel that is
     * usually closed would be a real cost for no gain.
     *
     * That does mean the editor's list is whatever was in hand when it rendered
     * rather than a live view, which is the better behaviour anyway -- a list
     * that reshuffled under the cursor mid-edit would be worse than one a beat
     * out of date.
     */
    recordsFor(key) {
      const value = raw[key];
      return Array.isArray(value) ? value : [];
    },

    setCityZones(next) {
      const previousScale = cityZoneSettings.radiusScale;
      cityZoneSettings = { ...cityZoneSettings, ...(next || {}) };
      if (cityZoneSettings.radiusScale !== previousScale || !cityZoneIndex) rebuildCityZoneIndex();
      renderAll();
    },

    /**
     * Admin Mode's "ignore the scene resolver" switch.
     *
     * The panel's job is diagnosis, and an empty layer has four possible
     * causes: the feed is dead, the viewport filter caught everything, it is
     * below its gate, or the resolver decided. Without a way to defeat the
     * resolver an admin can only tell the first three apart. Under bypass every
     * auto and corroborating layer is eligible, gates fall back to their
     * shipped numbers rather than any promoted ones, and caps are lifted -- so
     * an admin comparing against the shipped table reaches it exactly.
     */
    setSceneBypass(on) {
      const next = Boolean(on);
      if (next === sceneBypass) return;
      sceneBypass = next;
      applyScene();
      renderAll();
    },

    invalidateSize() {
      map.invalidateSize();
      // After the resize, not before: the floor is derived from the new pane size.
      applyWorldFence();
    },

    destroy() {
      clearInterval(windRefreshTimer);
      clearInterval(precipRefreshTimer);
      clearInterval(satElementTickTimer);
      clearTimeout(moveEndWindTimer);
      clearTimeout(moveEndRiversTimer);
      clearTimeout(regionFlightTimer);
      if (hoverFrame != null) cancelAnimationFrame(hoverFrame);
      // A live editing session holds its own animation frame and a map listener,
      // and its handles' Draggables have listeners on `document` -- all of which
      // would outlive the map otherwise.
      borderEditor.destroy();
      borderSession = null;
      // Holds a container listener and possibly a queued frame, and appends an
      // element to the container -- none of which map.remove() knows about.
      detachCursor();
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
