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
  SATELLITE_STYLE,
  decorateOfficials,
  eventIconSize,
  gdeltIconSize,
  officialsIconSize,
  historicalIconSize,
  INFRA_ICON_SIZE,
  decorateCity,
  cityTier,
  cityTierRank,
  PIPELINE_ROUTE_COLOR,
} from "./decorators";
import { placeAll } from "./declutter";
import { collapseByProximity, COLLAPSE_MAX_ZOOM } from "./collapse";
import { buildCountryIndex, findCountryAt } from "./countryHitTest";
import { countryPopupHtml, cityPopupHtml, normalizeCountryName } from "./popups";
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
const MARKER_LAYER_MIN_ZOOM = {
  events: EVENTS_MIN_ZOOM, gdelt: GDELT_MIN_ZOOM, conflictHistory: 4,
  officials: OFFICIALS_MIN_ZOOM,
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
  officials: "id",
};
const DECORATORS = {
  events: decorateEvent, ais: decorateAis, gdelt: decorateGdelt, adsb: decorateAdsb,
  conflictHistory: decorateHistoricalEvent, officials: decorateOfficials,
};
// The placement pass has to know how much room each icon needs before any of
// them are drawn, so the size formulas live in decorators.js and are read from
// both places rather than restated here.
const ICON_SIZE_FOR = {
  events: eventIconSize, gdelt: gdeltIconSize, conflictHistory: historicalIconSize,
  officials: officialsIconSize,
};

const REGION_FLY_DURATION = 1.2;

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
  };
  // ais/aisNavy/aisTanker/adsb/adsbMilitary are no longer here -- their
  // markers live inside entityWebglLayer's own per-bucket entry maps now
  // (see webglLayer.js's updateEntities), not as L.marker instances.
  const markersByKey = {
    events: new Map(), gdelt: new Map(), cities: new Map(), infra: new Map(), satellites: new Map(),
    conflictHistory: new Map(), officials: new Map(),
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
  // selectedCountryIso/activeConflictZoneBounds double as *which* countries
  // get the `.country-selected` highlight, so both features share one state.
  let citiesEnabled = false;
  let selectedCountryIso = null;
  let selectedCountryLayer = null; // the L.Path currently selected -- lets the card's screen anchor track it across pan/zoom
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

  // Free-text name filter for critical infrastructure/military bases (see
  // setInfraFilter in the public API and the search input in
  // LayersSection.jsx) -- scoped to just this one layer, not a global
  // cross-layer search.
  let infraNameFilter = "";

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

  const LAYER_ITEM_FILTER = { events: passesEventFilter, gdelt: passesNewsFilter };

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
  function updateCountryHighlights() {
    countriesLayer.eachLayer((layer) => {
      const props = layer.feature?.properties;
      if (!props) return;
      let selected = props.iso_a2 && props.iso_a2 === selectedCountryIso;
      if (!selected && activeConflictZoneBounds) {
        const center = layer.getBounds().getCenter();
        selected = boundsContainsPoint(activeConflictZoneBounds, center.lat, center.lng);
      }
      const el = layer.getElement?.();
      if (el) el.classList.toggle("country-selected", !!selected);
    });
  }

  function selectCountryEntry(entry) {
    const key = entry?.key ?? null;
    if (key != null && key === selectedCountryIso) {
      selectedCountryIso = null;
      selectedCountryLayer = null;
      if (!activeConflictZoneBounds) citiesEnabled = false; // no other active scope -- fully closing means fully closing
      callbacks.onCountrySelect?.(null);
    } else if (entry) {
      const layer = countryLayerFor(key);
      citiesEnabled = true;
      selectedCountryIso = key;
      selectedCountryLayer = layer;
      callbacks.onCountrySelect?.({
        iso: entry.iso,
        name: entry.name,
        // The country's own bbox drives every "inside this country" count in
        // the card (see popups.js).
        html: countryPopupHtml(entry.props, raw, layer ? boundsToPlainObject(layer.getBounds()) : null),
        point: layer ? countryAnchorPoint(layer) : null,
      });
    } else {
      return false;
    }
    renderCities();
    updateCountryHighlights();
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
  const WEBGL_BUCKET_KEYS = new Set(["adsbCivilian", "adsbMilitary", "aisCivilian", "aisNavy", "aisTanker"]);

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

  function setLayerVisible(key, visible) {
    layerOnMap[key] = visible;
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
  };
  // Total number loaded from the backend for each layer, independent of the
  // current viewport/zoom filtering that `counts` reflects -- shown in the
  // UI as the "(total)" figure next to the live on-screen tick.
  const totals = {
    events: 0, firms: 0, gdelt: 0, officials: 0, countries: 0, cities: 0, infra: 0, jamming: 0,
    satellites: 0, aisCivilian: 0, aisNavy: 0, aisTanker: 0, adsbCivilian: 0, adsbMilitary: 0,
    infraMilitary: 0, infraRefinery: 0, infraLng: 0, infraPort: 0, infraDesalination: 0,
    infraNuclear: 0, infraFab: 0, infraPipelineNode: 0, pipelineRoutes: 0,
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
    officials: false,
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
    events: 100, infra: 80, satellites: 70, aisNavy: 65, adsbMilitary: 65,
    // Above news: several officials pins sit on a capital's coordinate by
    // construction (a press release has no location of its own), so they are
    // the ones that most need to keep their true point rather than being
    // pushed off it by whatever news happens to share the pixel.
    aisTanker: 50, officials: 45, gdelt: 40, conflictHistory: 30, aisCivilian: 20,
    adsbCivilian: 20, cities: 10,
  };

  // Buckets that share one render function, so a settle pass triggered by any
  // of them redraws the group once rather than once per bucket.
  const REDRAW_GROUP = {
    aisCivilian: "ais", aisTanker: "ais", aisNavy: "ais",
    adsbCivilian: "adsb", adsbMilitary: "adsb",
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
    const minZoom = MARKER_LAYER_MIN_ZOOM[key];
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
    reportCounts();
    settlePlacement();
  }

  // Navy/MSC ships (USS/USNS) always render, ignoring the AIS zoom gate,
  // same exemption renderAdsbLayer already gives military aircraft.
  function renderAisLayer() {
    const decorate = DECORATORS.ais;
    const bounds = map.getBounds().pad(0.25);
    const belowAisMinZoom = map.getZoom() < AIS_MIN_ZOOM;
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
      } else if (!belowAisMinZoom && type === "tanker") {
        tankerVisible.push(item);
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
    registerVehiclePlacement("aisCivilian", civilianVisible, idFn, () => SHIP_STYLE.other.size);
    registerVehiclePlacement("aisTanker", tankerVisible, idFn, () => SHIP_STYLE.tanker.size);
    registerVehiclePlacement("aisNavy", navyVisible, idFn, () => SHIP_STYLE.navy.size);
    entityWebglLayer.updateEntities("aisCivilian", civilianVisible, {
      idField: idFn, heading: headingFn, style: () => SHIP_STYLE.other,
      isSelected: isSelectedFn, onSelect: selectShip, getTooltip: tooltipFn,
      offsets: offsetsForBucket("aisCivilian"),
    });
    entityWebglLayer.updateEntities("aisTanker", tankerVisible, {
      idField: idFn, heading: headingFn, style: () => SHIP_STYLE.tanker,
      isSelected: isSelectedFn, onSelect: selectShip, getTooltip: tooltipFn,
      offsets: offsetsForBucket("aisTanker"),
    });
    entityWebglLayer.updateEntities("aisNavy", navyVisible, {
      idField: idFn, heading: headingFn, style: () => SHIP_STYLE.navy,
      isSelected: isSelectedFn, onSelect: selectShip, getTooltip: tooltipFn,
      offsets: offsetsForBucket("aisNavy"),
    });

    counts.aisCivilian = civilianVisible.length;
    counts.aisTanker = tankerVisible.length;
    counts.aisNavy = navyVisible.length;
    totals.aisCivilian = 0;
    totals.aisTanker = 0;
    totals.aisNavy = 0;
    for (const item of raw.ais) {
      const type = classifyShip(item);
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
    const belowAdsbMinZoom = map.getZoom() < ADSB_MIN_ZOOM;
    zoomNotes.adsb = belowAdsbMinZoom;
    reportZoomNotes();

    const civilianVisible = [];
    const militaryVisible = [];
    for (const item of raw.adsb) {
      if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;
      if (!bounds.contains([item.lat, item.lon])) continue;
      if (classifyAircraft(item) === "military") {
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
    const civilianStyle = (item) => AIRCRAFT_STYLE[classifyAircraft(item)];
    const militaryStyle = (item) =>
      (item.military_role && MILITARY_ROLE_STYLE[item.military_role]) || AIRCRAFT_STYLE.military;
    registerVehiclePlacement("adsbCivilian", civilianVisible, idFn, (item) => civilianStyle(item).size);
    registerVehiclePlacement("adsbMilitary", militaryVisible, idFn, (item) => militaryStyle(item).size);
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

    counts.adsbCivilian = civilianVisible.length;
    counts.adsbMilitary = militaryVisible.length;
    totals.adsbCivilian = 0;
    totals.adsbMilitary = 0;
    for (const item of raw.adsb) {
      if (classifyAircraft(item) === "military") totals.adsbMilitary += 1;
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
    return (SATELLITE_STYLE[sat.group] || SATELLITE_STYLE.stations).size;
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
        (id) => (militaryIds.has(id) ? SATELLITE_STYLE.military.color : SATELLITE_STYLE.stations.color),
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
      selectedCountryLayer = countryLayerFor(selectedCountryIso);
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
      let inScope = props.iso_a2 && props.iso_a2 === selectedCountryIso;
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
    return `${city.name}|${city.country_code}|${city.lat}|${city.lon}`;
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
    marker.bindTooltip(`${esc(city.name)} &middot; ${esc(tier.label)}<br/>Population: ${fmtNumber(city.population)}`, {
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
    const belowCitiesMinZoom = map.getZoom() < CITIES_MIN_ZOOM;
    // citiesScoped tells the UI *which* note to show (see PlacesSection.jsx)
    // -- "select a country/zone" takes priority over "zoom in", since
    // zooming in without a scope selected still shows nothing.
    zoomNotes.citiesScoped = citiesEnabled;
    zoomNotes.cities = !citiesEnabled || belowCitiesMinZoom;
    reportZoomNotes();
    const bounds = map.getBounds().pad(0.25);
    // Scoped to the in-scope country/zone, not just whatever's in the
    // viewport -- a single selected country only shows *its own* cities
    // (matched by country_code, same ISO2 selectedCountryIso holds), and a
    // conflict-zone selection only shows cities inside that zone's own
    // bounds, even in world view where the map viewport itself spans the
    // whole globe. Falls back to `false` if citiesEnabled is somehow true
    // without either scope set, which shouldn't happen (see flyToRegion and
    // the country click handler, the only two places that set it).
    const visible =
      !citiesEnabled || belowCitiesMinZoom
        ? []
        : raw.cities.filter((c) => {
            if (!bounds.contains([c.lat, c.lon])) return false;
            if (selectedCountryIso) return c.country_code === selectedCountryIso;
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
    applyStacking(marker, INFRA_ICON_SIZE);
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
      visible.map((s) => ({ id: s.id, lat: s.lat, lon: s.lon, size: INFRA_ICON_SIZE }))
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
        color: PIPELINE_ROUTE_COLOR,
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

    // Cities (and the country-selected highlight) stay off until the user
    // opts into a scope -- picking any conflict zone from the Region bar
    // counts as one; explicitly going back to "World" clears both the
    // individually-clicked country and the zone highlight, same as never
    // having selected anything.
    citiesEnabled = key !== "world";
    activeConflictZoneBounds = entry && entry.bounds
      ? { south: entry.bounds[0], west: entry.bounds[1], north: entry.bounds[2], east: entry.bounds[3] }
      : null;
    if (key === "world" && selectedCountryIso) {
      selectedCountryIso = null;
      selectedCountryLayer = null;
      callbacks.onCountrySelect?.(null);
    }
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
    if (selectedCountryLayer) callbacks.onCountryPointChange?.(countryAnchorPoint(selectedCountryLayer));
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
        selectCountryEntry(entry);
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
      else if (key === "jamming") renderJamming();
      else if (key === "satellites") renderSatellites();
      // Neither of these is a point array with a layer of its own, so both
      // would otherwise fall through to renderMarkerLayer and blow up on a
      // missing group/marker map. conflictStats is a country->monthly-series
      // dict (hdx_conflict_stats.py) and escalation is a ranked region list
      // (escalation.py); both are read straight out of `raw` by popups.js
      // when a country card is built.
      else if (key === "conflictStats" || key === "escalation" || key === "conflictDistricts") {
        /* reference data read on demand by popups.js -- no marker layer */
      }
      else if (key === "conflictHistory") renderMarkerLayer("conflictHistory");
      else renderMarkerLayer(key);
      if (key === "events") updateCountryWarFlare();
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

    // Mirrors the country layer's own toggle-off branch -- called from the
    // info card's own close button, so the controller's selection state
    // stays in sync with what React is actually showing.
    deselectCountry() {
      if (!selectedCountryIso) return;
      selectedCountryIso = null;
      selectedCountryLayer = null;
      if (!activeConflictZoneBounds) citiesEnabled = false;
      renderCities();
      updateCountryHighlights();
    },

    setTheme(theme) {
      baseLayer.setUrl(basemapUrlFor(theme));
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
