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
  createEntityClusterGroups,
  createCountriesLayer,
  createCitiesGroup,
  createTrailLayers,
  createWindFlowLayer,
} from "./layers";
import { decorateAcled, decorateGdelt, decorateAis, decorateAdsb, classifyAircraft } from "./decorators";
import { countryPopupHtml, cityPopupHtml } from "./popups";
import { updateTrails, renderTrailLayer } from "./trails";
import { syncLayerMarkers } from "./syncLayerMarkers";
import { esc, fmtNumber, fmtFrp, fmtConfidence, fmtFirmsDateTime } from "../utils/format";
import { fetchJson } from "../api";

// World-view clusters everything into a handful of giant count bubbles --
// pure clutter. Below these zooms the whole layer hides and its ...ZoomNote
// shows instead; individual clustering still kicks in separately via
// clusterOpts.disableClusteringAtZoom once zoomed in.
const ADSB_MIN_ZOOM = 5;
const CITIES_MIN_ZOOM = 5;
// Gates only the interactive per-point FIRMS layer -- the heat layer itself
// always stays on regardless of zoom.
const FIRMS_DETAIL_MIN_ZOOM = 5;

const SHIP_TRAIL_MAX_POINTS = 60;
const AIRCRAFT_TRAIL_MAX_POINTS = 90;

const ID_FIELD = { acled: "id", gdelt: "event_id", ais: "mmsi", adsb: "icao24" };
const DECORATORS = { acled: decorateAcled, ais: decorateAis, gdelt: decorateGdelt, adsb: decorateAdsb };

const REGION_FLY_DURATION = 1.2;

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
  const { groups, militaryAdsbGroup, adsbLayer } = createEntityClusterGroups(map);
  const citiesGroup = createCitiesGroup(map);
  const { shipTrailsLayer, aircraftTrailsLayer } = createTrailLayers(map);
  const windFlowLayer = createWindFlowLayer(map);

  // ---------- state that used to be top-level `let`s in app.js ----------
  // All internal to the controller: nothing outside the map needs to know
  // which aircraft is selected, so it never needs to be React state.
  const raw = { acled: [], firms: [], ais: [], gdelt: [], adsb: [], countries: { features: [] }, cities: [] };
  const markersByKey = { acled: new Map(), gdelt: new Map(), ais: new Map(), adsb: new Map(), adsbMilitary: new Map() };
  const shipTrails = new Map();
  const aircraftTrails = new Map();
  let selectedIcao = null;
  let selectedMmsi = null;
  let countryNameByIso2 = {};
  let currentRegionKey = null; // for flyToRegion's "world" special-case only
  let regionFlightActive = false;
  let regionFlightTimer = null;
  let windRefreshTimer = null;
  let moveEndWindTimer = null;

  // ---------- country/city popups ----------

  const countriesLayer = createCountriesLayer(map, (feature, layer) => {
    layer.bindPopup(() => countryPopupHtml(feature.properties, raw), { maxWidth: 320 });
    layer.on("mouseover", () => layer.setStyle({ fillOpacity: 0.18 }));
    layer.on("mouseout", () => layer.setStyle({ fillOpacity: 0.03 }));
  });

  function layerForKey(key) {
    if (key === "firms") return firmsLayer;
    if (key === "countries") return countriesLayer;
    if (key === "cities") return citiesGroup;
    if (key === "windArrows") return windFlowLayer;
    if (key === "adsb") return adsbLayer;
    return groups[key];
  }

  // ---------- selection + trails ----------

  function attachAircraftSelectHandler(marker, item) {
    marker.on("click", (e) => {
      if (e.originalEvent) e.originalEvent.stopPropagation(); // don't let this reach the map's own click (would immediately deselect)
      selectedIcao = selectedIcao === item.icao24 ? null : item.icao24;
      if (selectedIcao) {
        // Seed the trail right away instead of waiting for the next
        // scheduled poll -- otherwise the trail stayed empty until then,
        // which just looked like flight history didn't work.
        updateTrails(aircraftTrails, raw.adsb, "icao24", AIRCRAFT_TRAIL_MAX_POINTS, selectedIcao);
      } else {
        aircraftTrails.clear();
      }
      renderAdsbLayer(); // re-decorate every visible aircraft so the highlight moves
    });
  }

  function attachShipSelectHandler(marker, item) {
    marker.on("click", (e) => {
      if (e.originalEvent) e.originalEvent.stopPropagation();
      selectedMmsi = selectedMmsi === item.mmsi ? null : item.mmsi;
      if (selectedMmsi) {
        updateTrails(shipTrails, raw.ais, "mmsi", SHIP_TRAIL_MAX_POINTS, selectedMmsi);
      } else {
        shipTrails.clear();
      }
      renderMarkerLayer("ais");
    });
  }

  function buildMarker(key, item, decorate) {
    const d = decorate(item, { selectedIcao, selectedMmsi });
    const marker = L.marker([item.lat, item.lon], { icon: d.icon });
    marker.bindPopup(d.detail, { maxWidth: 320 });
    marker.bindTooltip(d.tooltip, { className: "map-tooltip", direction: "top" });
    if (key === "adsb") attachAircraftSelectHandler(marker, item);
    if (key === "ais") attachShipSelectHandler(marker, item);
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

  const counts = { acled: 0, firms: 0, ais: 0, gdelt: 0, adsb: 0, countries: 0, cities: 0 };
  const zoomNotes = { adsb: false, cities: false, firms: false };
  function reportCounts() { callbacks.onCountsChange?.({ ...counts }); }
  function reportZoomNotes() { callbacks.onZoomNotesChange?.({ ...zoomNotes }); }

  function renderMarkerLayer(key) {
    if (key === "adsb") {
      renderAdsbLayer();
      return;
    }
    const group = groups[key];
    const decorate = DECORATORS[key];
    const bounds = map.getBounds().pad(0.25);
    const idField = ID_FIELD[key];
    const visible = [];
    for (const item of raw[key]) {
      if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;
      if (!bounds.contains([item.lat, item.lon])) continue;
      visible.push(item);
    }
    // If the selected ship is no longer in the feed at all (out of AIS
    // range / stopped reporting), drop the selection so the highlight/trail
    // don't linger on a marker that no longer exists -- same as ADS-B.
    if (key === "ais" && selectedMmsi && !raw.ais.some((s) => s.mmsi === selectedMmsi)) {
      selectedMmsi = null;
      shipTrails.clear();
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
    reportCounts();
    if (key === "ais") {
      renderTrailLayer(shipTrailsLayer, shipTrails, "#35c2ff", selectedMmsi ? new Set([selectedMmsi]) : new Set());
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
    const buildFn = (item) => buildMarker("adsb", item, decorate);
    const updateFn = (marker, item) => updateMarker(marker, item, decorate);
    syncLayerMarkers(markersByKey.adsb, groups.adsb, civilianVisible, idFn, buildFn, updateFn);
    syncLayerMarkers(markersByKey.adsbMilitary, militaryAdsbGroup, militaryVisible, idFn, buildFn, updateFn);

    counts.adsb = civilianVisible.length + militaryVisible.length;
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
    firmsHeat.setLatLngs(visible.map((d) => [d.lat, d.lon, Math.min((d.frp ? Number(d.frp) : 5) / 50, 1) + 0.2]));

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
    reportCounts();
  }

  function renderCountries() {
    countriesLayer.clearLayers();
    const features = raw.countries.features || [];
    if (features.length) countriesLayer.addData(raw.countries);
    countryNameByIso2 = {};
    for (const f of features) {
      if (f.properties.iso_a2) countryNameByIso2[f.properties.iso_a2] = f.properties.name;
    }
    counts.countries = features.length;
    reportCounts();
  }

  function renderCities() {
    citiesGroup.clearLayers();
    const belowCitiesMinZoom = map.getZoom() < CITIES_MIN_ZOOM;
    zoomNotes.cities = belowCitiesMinZoom;
    reportZoomNotes();
    if (belowCitiesMinZoom) {
      counts.cities = 0;
      reportCounts();
      return;
    }
    const bounds = map.getBounds().pad(0.25);
    const visible = raw.cities.filter((c) => bounds.contains([c.lat, c.lon]));
    const markers = visible.map((city) => {
      const marker = L.marker([city.lat, city.lon], {
        icon: L.divIcon({ html: '<div class="city-dot"></div>', className: "", iconSize: [8, 8], iconAnchor: [4, 4] }),
      });
      marker.bindPopup(() => cityPopupHtml(city, raw, countryNameByIso2), { maxWidth: 320 });
      marker.bindTooltip(`${esc(city.name)} (${fmtNumber(city.population)})`, { className: "map-tooltip", direction: "top" });
      return marker;
    });
    citiesGroup.addLayers(markers);
    counts.cities = visible.length;
    reportCounts();
  }

  function renderAll() {
    renderMarkerLayer("acled");
    renderMarkerLayer("gdelt");
    renderMarkerLayer("ais");
    renderMarkerLayer("adsb");
    renderFirms();
    renderCities();
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
    } catch (err) {
      console.warn("Failed to fetch windArrows:", err);
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

  // No separate zoomend handler: Leaflet always fires moveend right after
  // zoomend for any zoom change (button, scroll, or pinch), so a dedicated
  // zoomend listener re-running renderAdsbLayer/renderCities/renderFirms
  // here just duplicated the exact same work moveend's renderAll() already
  // does a moment later -- every zoom action was rendering those three
  // layers twice.

  // Click empty map space to deselect the currently-selected aircraft/ship
  // trail. attachAircraftSelectHandler/attachShipSelectHandler stop
  // propagation on the marker's own click, so this only fires for clicks
  // that didn't land on a marker.
  map.on("click", () => {
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

  refreshWindArrows();
  windRefreshTimer = setInterval(refreshWindArrows, 5 * 60 * 1000); // catches slow wind changes even if the view sits still
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
      else renderMarkerLayer(key);
    },

    flyToRegion,
    flyTo,

    setLayerVisible(key, visible) {
      const layer = layerForKey(key);
      if (!layer) return;
      if (visible) map.addLayer(layer);
      else map.removeLayer(layer);
    },

    setTheme(theme) {
      baseLayer.setUrl(basemapUrlFor(theme));
    },

    invalidateSize() {
      map.invalidateSize();
    },

    destroy() {
      clearInterval(windRefreshTimer);
      clearTimeout(moveEndWindTimer);
      clearTimeout(regionFlightTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      map.remove();
    },
  };
}
