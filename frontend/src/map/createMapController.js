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
  createNavyAisGroup,
  createTankerAisGroup,
  createSatelliteGroup,
  createTrailLayers,
  createWindFlowLayer,
} from "./layers";
import {
  decorateAcled,
  decorateGdelt,
  decorateConflictWatch,
  decorateAis,
  decorateAdsb,
  decorateInfra,
  decorateSatellite,
  classifyAircraft,
  classifyShip,
  gdeltSentence,
  SHIP_STYLE,
  AIRCRAFT_STYLE,
} from "./decorators";
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
const ACLED_MIN_ZOOM = 3;
const GDELT_MIN_ZOOM = 3;
const CONFLICT_WATCH_MIN_ZOOM = 3;
const AIS_MIN_ZOOM = 3;
// AIS has its own dedicated renderAisLayer (civilian/Navy split, like ADS-B's
// civilian/military split) so it isn't part of this generic lookup.
const MARKER_LAYER_MIN_ZOOM = { acled: ACLED_MIN_ZOOM, gdelt: GDELT_MIN_ZOOM, conflictWatch: CONFLICT_WATCH_MIN_ZOOM };
// Gates only the interactive per-point FIRMS layer -- the heat layer itself
// always stays on regardless of zoom.
const FIRMS_DETAIL_MIN_ZOOM = 5;

const SHIP_TRAIL_MAX_POINTS = 60;
const AIRCRAFT_TRAIL_MAX_POINTS = 90;
// Satellites poll every 10s (see useOsintData.js's POLL_CONFIG) -- 36 points
// is a several-minute trailing arc, same "grows from app-open" cold start as
// ship/aircraft trails.
const SATELLITE_TRAIL_MAX_POINTS = 36;

const ID_FIELD = { acled: "id", gdelt: "event_id", conflictWatch: "id", ais: "mmsi", adsb: "icao24" };
const DECORATORS = {
  acled: decorateAcled, ais: decorateAis, gdelt: decorateGdelt, adsb: decorateAdsb,
  conflictWatch: decorateConflictWatch,
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
  const { groups, militaryAdsbGroup } = createEntityClusterGroups(map);
  const citiesGroup = createCitiesGroup(map);
  const infraGroup = createInfraGroup();
  const pipelinesGroup = createPipelinesGroup();
  const infraLayer = L.layerGroup([infraGroup, pipelinesGroup]).addTo(map);
  const navyAisGroup = createNavyAisGroup(map);
  const tankerAisGroup = createTankerAisGroup();
  const satelliteGroup = createSatelliteGroup();
  const { shipTrailsLayer, aircraftTrailsLayer, satelliteTrailsLayer } = createTrailLayers(map);
  const satelliteLayerWithTrails = L.layerGroup([satelliteGroup, satelliteTrailsLayer]).addTo(map);
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
    acled: [], firms: [], ais: [], gdelt: [], adsb: [], conflictWatch: [],
    countries: { features: [] }, cities: [], infra: [], pipelines: [], jamming: [], satellites: [],
    conflictStats: {},
  };
  // ais/aisNavy/aisTanker/adsb/adsbMilitary are no longer here -- their
  // markers live inside entityWebglLayer's own per-bucket entry maps now
  // (see webglLayer.js's updateEntities), not as L.marker instances.
  const markersByKey = {
    acled: new Map(), gdelt: new Map(), conflictWatch: new Map(), cities: new Map(), infra: new Map(), satellites: new Map(),
  };
  const shipTrails = new Map();
  const aircraftTrails = new Map();
  const satelliteTrails = new Map();
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

  // Mirrors the map's actual add/remove state for these two toggles so the
  // render functions themselves can skip work (not just hide the result)
  // while switched off -- satellitesVisible additionally gates trail
  // rendering entirely (see renderSatellites).
  let satellitesVisible = true;

  // Free-text name filter for critical infrastructure/military bases (see
  // setInfraFilter in the public API and the search input in
  // LayersSection.jsx) -- scoped to just this one layer, not a global
  // cross-layer search.
  let infraNameFilter = "";

  // ---------- country/city popups ----------

  // Country click no longer opens a Leaflet popup (which auto-panned the
  // map and closed the moment you clicked elsewhere) -- instead it drives a
  // persistent React info card (see CountryInfoCard.jsx/onCountrySelect)
  // that stays open across pan/zoom, and toggles closed on a second click of
  // the same country. Every country gets these handlers, not just the
  // auto-flagged war-hot ones -- hover/click work on any country shape.
  // fillOpacity alone (0.03 -> 0.18) was too subtle against the near-
  // transparent base fill to read as a highlight, so hover also brightens
  // the stroke -- same technique .country-selected already uses, just
  // lighter so the two states stay visually distinct.
  const countriesLayer = createCountriesLayer(map, (feature, layer) => {
    layer.on("mouseover", () => layer.setStyle({ fillOpacity: 0.25, color: "#aef0ff", weight: 2 }));
    layer.on("mouseout", () => layer.setStyle({ fillOpacity: 0, color: "rgba(111, 227, 255, 0)", weight: 1 }));
    layer.on("click", (e) => {
      if (e.originalEvent) e.originalEvent.stopPropagation(); // don't let the map's own click handler immediately deselect
      const iso = feature.properties?.iso_a2 || null;
      if (selectedCountryIso && selectedCountryIso === iso) {
        selectedCountryIso = null;
        selectedCountryLayer = null;
        if (!activeConflictZoneBounds) citiesEnabled = false; // no other active scope -- fully closing means fully closing
        callbacks.onCountrySelect?.(null);
      } else {
        citiesEnabled = true;
        selectedCountryIso = iso;
        selectedCountryLayer = layer;
        callbacks.onCountrySelect?.({
          iso, name: feature.properties?.name, html: countryPopupHtml(feature.properties, raw),
          point: countryAnchorPoint(layer),
        });
      }
      renderCities();
      updateCountryHighlights();
    });
  });

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

  function layerForKey(key) {
    if (key === "firms") return firmsLayer;
    if (key === "countries") return countriesLayer;
    if (key === "cities") return citiesGroup;
    if (key === "infra") return infraLayer; // wraps infraGroup + pipelinesGroup together
    if (key === "windArrows") return windFlowLayer;
    if (key === "precip") return weatherLayers.precip;
    if (key === "clouds") return weatherLayers.clouds;
    if (key === "jamming") return jammingLayerWithPing;
    if (key === "satellites") return satelliteLayerWithTrails;
    return groups[key];
  }

  // The five AIS/ADS-B bucket keys route through entityWebglLayer's own
  // per-bucket visibility instead of a Leaflet layerForKey lookup -- see the
  // comment where entityWebglLayer is created above.
  const WEBGL_BUCKET_KEYS = new Set(["adsbCivilian", "adsbMilitary", "aisCivilian", "aisNavy", "aisTanker"]);

  function setLayerVisible(key, visible) {
    if (WEBGL_BUCKET_KEYS.has(key)) {
      entityWebglLayer.setVisible(key, visible);
      return;
    }

    const layer = layerForKey(key);
    if (!layer) return;
    if (visible) map.addLayer(layer);
    else map.removeLayer(layer);

    if (key === "satellites") {
      satellitesVisible = visible;
      if (visible) renderSatellites(); // was skipped entirely while off -- catch up now
      else satelliteTrailsLayer.clearLayers(); // don't leave a stale trail sitting under the (now-empty) group
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

  function buildMarker(key, item, decorate) {
    const d = decorate(item, {});
    const marker = L.marker([item.lat, item.lon], { icon: d.icon });
    marker.bindPopup(d.detail, { maxWidth: 320 });
    marker.bindTooltip(d.tooltip, { className: "map-tooltip", direction: "top" });
    return marker;
  }

  function updateMarker(marker, item, decorate) {
    const d = decorate(item, { selectedIcao, selectedMmsi });
    marker.setLatLng([item.lat, item.lon]);
    marker.setIcon(d.icon);
    marker.setTooltipContent(d.tooltip);
    marker.setPopupContent(d.detail);
  }

  // ---------- per-source renderers ----------
  // Every renderer filters to the current viewport (with a margin so panning
  // feels smooth) rather than drawing globally-cached data that isn't on
  // screen -- both a real perf win given FIRMS/ADS-B/cities volumes, and
  // literally "only show what you're looking at."

  const counts = {
    acled: 0, firms: 0, gdelt: 0, conflictWatch: 0, countries: 0, cities: 0, infra: 0, jamming: 0, satellites: 0,
    aisCivilian: 0, aisNavy: 0, aisTanker: 0, adsbCivilian: 0, adsbMilitary: 0,
  };
  // Total number loaded from the backend for each layer, independent of the
  // current viewport/zoom filtering that `counts` reflects -- shown in the
  // UI as the "(total)" figure next to the live on-screen tick.
  const totals = {
    acled: 0, firms: 0, gdelt: 0, conflictWatch: 0, countries: 0, cities: 0, infra: 0, jamming: 0, satellites: 0,
    aisCivilian: 0, aisNavy: 0, aisTanker: 0, adsbCivilian: 0, adsbMilitary: 0,
  };
  const zoomNotes = {
    adsb: false, cities: false, firms: false, acled: false, gdelt: false, conflictWatch: false, ais: false, jamming: false,
  };
  function reportCounts() {
    const totalsSuffixed = {};
    for (const key of Object.keys(totals)) totalsSuffixed[`${key}Total`] = totals[key];
    callbacks.onCountsChange?.({ ...counts, ...totalsSuffixed });
  }
  function reportZoomNotes() { callbacks.onZoomNotesChange?.({ ...zoomNotes }); }

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
    const bounds = map.getBounds().pad(0.25);
    const idField = ID_FIELD[key];
    const minZoom = MARKER_LAYER_MIN_ZOOM[key];
    const belowMinZoom = minZoom != null && map.getZoom() < minZoom;
    if (minZoom != null) {
      zoomNotes[key] = belowMinZoom;
      reportZoomNotes();
    }
    const visible = [];
    if (!belowMinZoom) {
      for (const item of raw[key]) {
        if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;
        if (!bounds.contains([item.lat, item.lon])) continue;
        visible.push(item);
      }
    }
    syncLayerMarkers(
      markersByKey[key],
      group,
      visible,
      (item) => item[idField],
      (item) => buildMarker(key, item, decorate),
      (marker, item) => updateMarker(marker, item, decorate)
    );
    counts[key] = visible.length;
    totals[key] = raw[key].length;
    reportCounts();
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
    entityWebglLayer.updateEntities("aisCivilian", civilianVisible, {
      idField: idFn, heading: headingFn, style: () => SHIP_STYLE.other,
      isSelected: isSelectedFn, onSelect: selectShip, getTooltip: tooltipFn,
    });
    entityWebglLayer.updateEntities("aisTanker", tankerVisible, {
      idField: idFn, heading: headingFn, style: () => SHIP_STYLE.tanker,
      isSelected: isSelectedFn, onSelect: selectShip, getTooltip: tooltipFn,
    });
    entityWebglLayer.updateEntities("aisNavy", navyVisible, {
      idField: idFn, heading: headingFn, style: () => SHIP_STYLE.navy,
      isSelected: isSelectedFn, onSelect: selectShip, getTooltip: tooltipFn,
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
    renderTrailLayer(shipTrailsLayer, shipTrails, "#35c2ff", selectedMmsi ? new Set([selectedMmsi]) : new Set());
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
    entityWebglLayer.updateEntities("adsbCivilian", civilianVisible, {
      idField: idFn, heading: (item) => item.heading,
      style: (item) => AIRCRAFT_STYLE[classifyAircraft(item)],
      isSelected: isSelectedFn, onSelect: selectAircraft, getTooltip: tooltipFn,
    });
    entityWebglLayer.updateEntities("adsbMilitary", militaryVisible, {
      idField: idFn, heading: (item) => item.heading, style: () => AIRCRAFT_STYLE.military,
      isSelected: isSelectedFn, onSelect: selectAircraft, getTooltip: tooltipFn,
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
    renderTrailLayer(aircraftTrailsLayer, aircraftTrails, "#d8b9ff", selectedIcao ? new Set([selectedIcao]) : new Set());
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

  function buildSatelliteMarker(sat) {
    const d = decorateSatellite(sat);
    const marker = L.marker([sat.lat, sat.lon], { icon: d.icon });
    marker.bindPopup(d.detail, { maxWidth: 320 });
    marker.bindTooltip(d.tooltip, { className: "map-tooltip", direction: "top" });
    return marker;
  }

  function updateSatelliteMarker(marker, sat) {
    const d = decorateSatellite(sat);
    marker.setLatLng([sat.lat, sat.lon]);
    marker.setIcon(d.icon);
    marker.setTooltipContent(d.tooltip);
    marker.setPopupContent(d.detail);
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

    const bounds = map.getBounds().pad(0.25);
    const visible = raw.satellites.filter(
      (s) => typeof s.lat === "number" && typeof s.lon === "number" && bounds.contains([s.lat, s.lon])
    );
    syncLayerMarkers(markersByKey.satellites, satelliteGroup, visible, (s) => s.norad_id, buildSatelliteMarker, updateSatelliteMarker);
    counts.satellites = visible.length;
    totals.satellites = raw.satellites.length;
    reportCounts();

    // Satellites have no click-to-select model like ships/aircraft, so every
    // satellite's trail is tracked all the time (restrictTo === undefined,
    // per trails.js's documented semantics) rather than just the selected
    // one -- their orbital path is the point, not a detail you opt into.
    // Semi-transparent + dashed (vs. ship/aircraft trails' solid look) so it
    // reads as a background orbital track, not an active-selection cue.
    updateTrails(satelliteTrails, raw.satellites, "norad_id", SATELLITE_TRAIL_MAX_POINTS, undefined);
    renderTrailLayer(satelliteTrailsLayer, satelliteTrails, "#6fe3ff", new Set(satelliteTrails.keys()), {
      maxOpacity: 0.22,
      dashArray: "2 5",
    });
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
      const marker = L.circleMarker([d.lat, d.lon], {
        radius: 8,
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
  let lastCountriesSignature = null;

  function renderCountries() {
    const signature = JSON.stringify(raw.countries);
    if (signature !== lastCountriesSignature) {
      lastCountriesSignature = signature;
      countriesLayer.clearLayers();
      const features = raw.countries.features || [];
      if (features.length) countriesLayer.addData(raw.countries);
      countryNameByIso2 = {};
      for (const f of features) {
        if (f.properties.iso_a2) countryNameByIso2[f.properties.iso_a2] = f.properties.name;
      }
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
        for (const e of raw.acled) {
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

  function buildCityMarker(city) {
    const marker = L.marker([city.lat, city.lon], {
      icon: L.divIcon({ html: '<div class="city-dot"></div>', className: "", iconSize: [8, 8], iconAnchor: [4, 4] }),
    });
    marker.bindPopup(() => cityPopupHtml(city, raw, countryNameByIso2), { maxWidth: 320 });
    marker.bindTooltip(`${esc(city.name)} (${fmtNumber(city.population)})`, { className: "map-tooltip", direction: "top" });
    return marker;
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
    // Diff-based sync (not clearLayers()+rebuild) -- a full teardown on
    // every moveend used to destroy the marker (and its just-opened popup)
    // that a click's own auto-pan had just triggered, making city dots feel
    // unclickable. See renderMarkerLayer/syncLayerMarkers for the same fix
    // applied to every other point layer.
    syncLayerMarkers(markersByKey.cities, citiesGroup, visible, cityKey, buildCityMarker, () => {});
    counts.cities = visible.length;
    totals.cities = raw.cities.length;
    reportCounts();
  }

  // ---------- critical infrastructure + hot-zone flare ----------

  function nearbyEventsFor(site) {
    const events = [];
    for (const e of raw.acled) {
      if (typeof e.lat !== "number" || typeof e.lon !== "number") continue;
      if (haversineKm(site.lat, site.lon, e.lat, e.lon) > INFRA_HOT_RADIUS_KM) continue;
      events.push({ headline: e.event_type || "Conflict event", source: "ACLED" });
    }
    for (const e of raw.gdelt) {
      if (typeof e.lat !== "number" || typeof e.lon !== "number") continue;
      if (haversineKm(site.lat, site.lon, e.lat, e.lon) > INFRA_HOT_RADIUS_KM) continue;
      const headline = (e.real_title && e.real_title.trim()) || gdeltSentence(e);
      events.push({ headline, source: e.source_name || "GDELT" });
    }
    return events.slice(0, 5);
  }

  function buildInfraMarker(site) {
    const nearbyEvents = nearbyEventsFor(site);
    const d = decorateInfra(site, { hot: nearbyEvents.length > 0, nearbyEvents });
    const marker = L.marker([site.lat, site.lon], { icon: d.icon });
    marker.bindPopup(d.detail, { maxWidth: 320 });
    marker.bindTooltip(d.tooltip, { className: "map-tooltip", direction: "top" });
    return marker;
  }

  function updateInfraMarker(marker, site) {
    const nearbyEvents = nearbyEventsFor(site);
    const d = decorateInfra(site, { hot: nearbyEvents.length > 0, nearbyEvents });
    marker.setIcon(d.icon);
    marker.setTooltipContent(d.tooltip);
    marker.setPopupContent(d.detail);
  }

  function renderInfra() {
    const bounds = map.getBounds().pad(0.25);
    const needle = infraNameFilter.trim().toLowerCase();
    const visible = raw.infra.filter(
      (s) => bounds.contains([s.lat, s.lon]) && (!needle || s.name.toLowerCase().includes(needle))
    );
    // Diff-sync like every other point layer -- re-runs on every ACLED/GDELT
    // update too (see renderAll) so a flare turns on/off promptly, without
    // destroying markers/open popups for sites whose hot status didn't change.
    syncLayerMarkers(markersByKey.infra, infraGroup, visible, (s) => s.id, buildInfraMarker, updateInfraMarker);
    counts.infra = visible.length;
    totals.infra = raw.infra.length;
    reportCounts();
  }

  // Pipeline routes (backend/infrastructure.py's PIPELINE_ROUTES) -- a small
  // static set fetched once (see useOsintData.js), so this just draws every
  // route once rather than diff-syncing per-viewport like the point layers.
  function renderPipelines() {
    pipelinesGroup.clearLayers();
    for (const route of raw.pipelines) {
      const line = L.polyline(route.coords, {
        color: "#ffb347",
        weight: 2,
        opacity: 0.65,
        dashArray: "6 6",
      });
      line.bindTooltip(esc(route.name), { className: "map-tooltip", direction: "top" });
      line.bindPopup(`<h3>${esc(route.name)}</h3><p>${esc(route.note || "")}</p>`, { maxWidth: 280 });
      pipelinesGroup.addLayer(line);
    }
  }

  function renderAll() {
    renderMarkerLayer("acled");
    renderMarkerLayer("gdelt");
    renderMarkerLayer("conflictWatch");
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
  map.on("click", () => {
    if (entityWebglLayer.consumeSuppressedClick()) return;
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
      if (key === "countries") renderCountries();
      else if (key === "firms") renderFirms();
      else if (key === "cities") renderCities();
      else if (key === "infra") renderInfra();
      else if (key === "pipelines") renderPipelines();
      else if (key === "jamming") renderJamming();
      else if (key === "satellites") renderSatellites();
      // conflictStats is a country->monthly-series dict (see
      // hdx_conflict_stats.py), not a point array -- it's read directly out
      // of raw.conflictStats by popups.js's buildTrendSection, and has no
      // marker layer of its own to render.
      else if (key === "conflictStats") { /* no-op */ }
      else renderMarkerLayer(key);
      if (key === "acled") updateCountryWarFlare();
    },

    flyToRegion,
    flyTo,

    setLayerVisible,

    setInfraFilter(text) {
      infraNameFilter = text || "";
      renderInfra();
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
      document.removeEventListener("visibilitychange", onVisibilityChange);
      map.remove();
    },
  };
}
