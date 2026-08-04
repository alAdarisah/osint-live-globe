// Constructs every Leaflet layer object the app uses, given a live map
// instance. Pure "what layers exist and how are they configured" -- no data
// goes into them here (see renderers.js for that) and no app state is read.
// Called once by useLeafletMap when the map is created.

import { L } from "./leafletGlobal";

export function createBaseLayer(map, theme) {
  const layer = L.tileLayer(basemapUrlFor(theme), {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
    subdomains: "abcd",
  }).addTo(map);
  return layer;
}

export function basemapUrlFor(theme) {
  const style = theme === "light" ? "light_all" : "dark_all";
  return `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`;
}

export function createWeatherLayers(map) {
  // URL starts empty -- RainViewer has no fixed tile path, it's a frame
  // timestamp that changes every ~10min, so the real URL is filled in by
  // refreshPrecipRadar() in createMapController.js right after this layer is
  // created (and re-filled on a timer). Until that first fetch resolves,
  // Leaflet has nothing to request, which is expected, not a bug.
  const precipLayer = L.tileLayer("", {
    opacity: 0.55,
    zIndex: 5,
    maxNativeZoom: 7, // RainViewer's radar tiles don't exist past z7 -- beyond that
                       // their server returns a "Zoom Level Not Supported" image
                       // instead of a 404, so Leaflet must be told not to ask.
    attribution: 'Weather data by <a href="https://www.rainviewer.com" target="_blank" rel="noopener noreferrer">RainViewer</a>',
  }).addTo(map);

  const cloudsLayer = L.tileLayer("/api/weather/tile/clouds_new/{z}/{x}/{y}.png", {
    opacity: 0.45,
    zIndex: 5,
    // OWM's clouds_new tiles are only meaningfully distinct up to about z9 --
    // past that it's the same low-res data upscaled. Without this cap, every
    // zoom-in past z9 requested a brand new set of unique {z}/{x}/{y} tiles
    // the backend cache had never seen, which (a) hammered OWM with fetches
    // for pixels that carried no new information and (b) blew past the
    // backend's 8000-entry cache cap fast enough to trigger repeated
    // full-cache clears -- the combination is what showed up as "laggy" pan
    // and zoom.
    maxNativeZoom: 9,
    attribution: "Weather: OpenWeatherMap",
  });

  return { precip: precipLayer, clouds: cloudsLayer };
}

// leaflet.heat paints by reading back its own canvas (getImageData), which
// throws IndexSizeError the moment that canvas is 0 wide -- exactly what
// happens if the layer is added while the map container has no laid-out
// size yet. That throw propagates out of L.Map.addLayer, so it doesn't just
// skip one paint: it takes the whole controller down and the app renders
// its error boundary instead of a map. createMapController.js already
// carries safeHeatSetLatLngs for the same library's redraw-without-a-map
// crash; this is the add-path half of that same defence. A heatmap that
// can't paint yet is a non-event -- the next moveend/setLatLngs repaints it
// correctly -- so swallowing it is strictly better than losing the map.
function makeHeatResilient(heatLayer) {
  const originalRedraw = heatLayer._redraw?.bind(heatLayer);
  if (!originalRedraw) return heatLayer;
  heatLayer._redraw = function guardedRedraw(...args) {
    try {
      return originalRedraw(...args);
    } catch (err) {
      console.warn("Skipped a heat-layer redraw:", err?.message || err);
      return undefined;
    }
  };
  return heatLayer;
}

export function createFirmsLayers(map) {
  // FIRMS runs to 100k+ points globally, which as individual icons is just
  // clutter even when clustered -- a density heatmap is the standard way
  // fire-tracking dashboards show this, and it reads far cleaner at world
  // zoom. It trades away per-point click popups for that clarity.
  const firmsHeat = makeHeatResilient(L.heatLayer([], {
    radius: 16,
    blur: 22,
    maxZoom: 9,
    minOpacity: 0.35,
    gradient: { 0.2: "#5c1a00", 0.4: "#b34700", 0.6: "#ff6a00", 0.8: "#ff9500", 1: "#ffe066" },
  }));
  // Near-invisible click/hover targets layered on top of the heat --
  // leaflet.heat itself has no interactivity, so this is what lets a hot
  // spot be inspected. Building one of these (plus a bound tooltip/popup)
  // for every visible point regardless of zoom was the single biggest
  // source of lag; a dedicated canvas renderer (batches into one <canvas>
  // instead of one DOM/SVG node per marker) plus a zoom gate (see
  // FIRMS_DETAIL_MIN_ZOOM in renderers.js) fixes it -- the heat layer
  // itself stays on at every zoom since leaflet.heat is built to handle
  // this volume cheaply on its own.
  const firmsCanvasRenderer = L.canvas({ padding: 0.25 });
  const firmsPointsLayer = L.layerGroup();
  const firmsLayer = L.layerGroup([firmsHeat, firmsPointsLayer]).addTo(map);
  return { firmsHeat, firmsPointsLayer, firmsLayer, firmsCanvasRenderer };
}

// No clustering anywhere: every point layer either hides below its own
// MIN_ZOOM gate (see createMapController.js) or, for small always-on sets
// (military aircraft, Navy ships, infra), just stays a plain layerGroup at
// every zoom. Clean at world zoom comes from the gate, not from grouping
// markers into numbered bubbles.
// GPS/radio jamming (gpsjam.org, via backend/sources/jamming.py): same
// heat-plus-thin-click-layer shape as createFirmsLayers, since this is the
// same kind of "too many cells to be individual icons, show density instead"
// data, just with a distinct color so it doesn't read as fire.
export function createJammingLayers(map) {
  const jammingHeat = makeHeatResilient(L.heatLayer([], {
    radius: 22,
    blur: 28,
    maxZoom: 7,
    minOpacity: 0.3,
    gradient: { 0.2: "#2a0845", 0.4: "#6a0dad", 0.6: "#b833e0", 0.8: "#e066ff", 1: "#ff6fd8" },
  }));
  const jammingCanvasRenderer = L.canvas({ padding: 0.25 });
  const jammingPointsLayer = L.layerGroup();
  // Not added to the map directly -- wrapped together with the new-cell
  // ripple/ping group into one combined "jamming" layer in
  // createMapController.js, same pattern as infraGroup+pipelinesGroup.
  const jammingLayer = L.layerGroup([jammingHeat, jammingPointsLayer]);
  return { jammingHeat, jammingPointsLayer, jammingLayer, jammingCanvasRenderer };
}

// Civilian/military (and, in createNavyAisGroup below, civilian/Navy) each
// get their own independently toggleable layerGroup rather than one combined
// "adsb"/"ais" layer -- military aircraft and Navy ships default to visible
// while their civilian counterparts default to hidden (see
// DEFAULT_LAYER_VISIBILITY in App.jsx), which only works if the map can
// add/remove each half separately.
// Only the two remaining DOM-marker point layers. AIS and ADS-B used to
// have layerGroups here too, but their markers are Pixi sprites on a shared
// WebGL canvas now (see webglLayer.js) -- the leftover groups sat on the map
// holding nothing, so they're gone rather than kept as decoration.
export function createEntityClusterGroups(map) {
  const groups = {
    events: L.layerGroup().addTo(map), // fused ACLED+UCDP+GDELT conflict layer, see event_fusion.py
    gdelt: L.layerGroup().addTo(map),
  };
  return { groups };
}

export function createCountriesLayer(map, onEachFeature) {
  // Stroke starts fully transparent -- boundaries only appear on hover (see
  // mouseover/mouseout in createMapController.js) or via the .country-hot/
  // .country-selected CSS classes, which set their own stroke color and win
  // over this base regardless. Without that, every untouched country's
  // outline sat faintly visible at world zoom, which read as visual noise.
  function countryStyle() {
    return { className: "country-shape", color: "rgba(111, 227, 255, 0)", weight: 1, fillColor: "#6fe3ff", fillOpacity: 0 };
  }
  // Own pane, z-indexed below the default overlayPane (400) that every
  // point layer's canvas/SVG renders into -- an SVG path's interior still
  // hit-tests pointer events even at fillOpacity 0 (SVG "visiblePainted"
  // ignores fill-opacity, only fill:none), so without this the country
  // shapes -- created after jamming/FIRMS/etc, so stacked on top of them --
  // swallowed every click landing over land before it reached those layers'
  // markers. Below overlayPane still receives clicks fine wherever nothing
  // else covers that pixel, which is nearly everywhere on land.
  if (!map.getPane("countriesPane")) {
    map.createPane("countriesPane").style.zIndex = 350;
  }
  return L.geoJSON(null, { style: countryStyle, onEachFeature, pane: "countriesPane" }).addTo(map);
}

export function createCitiesGroup(map) {
  return L.layerGroup().addTo(map);
}

// Critical infrastructure is a small curated set (see backend/infrastructure.py)
// -- every site should stay individually visible at any zoom, same reasoning
// as militaryAdsbGroup, so this is a plain never-clustered layerGroup. Not
// added to the map directly -- wrapped together with createPipelinesGroup
// into one combined "infra" layer in createMapController.js.
export function createInfraGroup() {
  return L.layerGroup();
}

// Major oil/gas pipeline routes (backend/infrastructure.py's
// PIPELINE_ROUTES) -- lines, not points, but the same "small curated set,
// always visible" treatment. Toggled together with createInfraGroup under
// the single "infra" layer key (see layerForKey in createMapController.js).
export function createPipelinesGroup() {
  return L.layerGroup();
}

// Navy and tanker AIS used to get their own layerGroups here. Both are Pixi
// sprite buckets on the shared WebGL canvas now (see webglLayer.js's
// aisNavy/aisTanker buckets), so the factories were removed rather than left
// returning groups nothing ever added a marker to.

// Satellites: a small curated set (~46 objects), always visible at any zoom,
// same reasoning as createInfraGroup. Not added to the map directly --
// createMapController.js adds it alongside satelliteTrailsLayer, which has
// its own "Show satellite trails" sub-ticker.
export function createSatelliteGroup() {
  return L.layerGroup();
}

export function createTrailLayers(map) {
  // Plain (non-clustered) layers for fading position-history lines behind
  // ships/aircraft/satellites/tankers. Kept separate from the marker cluster
  // groups since lines shouldn't be clustered. shipTrailsLayer/
  // aircraftTrailsLayer only ever show the one *selected* vehicle and are
  // always-on layers (no toggle of their own); satelliteTrailsLayer/
  // tankerTrailsLayer/militaryTrailsLayer track every visible vehicle in
  // their category and are deliberately NOT added here -- each has its own
  // dedicated sub-ticker (see the "*Trails" keys in createMapController.js's
  // setLayerVisible, and the "Show ... trails" rows in LayersSection.jsx).
  return {
    shipTrailsLayer: L.layerGroup().addTo(map),
    aircraftTrailsLayer: L.layerGroup().addTo(map),
    satelliteTrailsLayer: L.layerGroup(),
    militaryTrailsLayer: L.layerGroup(),
    tankerTrailsLayer: L.layerGroup(),
  };
}

// Short-lived ripple markers for newly-appeared jamming cells (see
// renderJamming in createMapController.js) -- kept as its own layerGroup,
// separate from jammingPointsLayer's persistent click targets, since these
// markers self-remove a few seconds after being added. Not added to the map
// directly -- combined with jammingLayer in createMapController.js so
// toggling the "jamming" layer off also hides pings.
export function createJammingPingGroup() {
  return L.layerGroup();
}

export function createWindFlowLayer(map) {
  // leaflet-velocity draws a canvas of small particles that drift along the
  // interpolated wind field -- the same technique Windy.com uses -- which is
  // what "flowing" actually looks like, versus a grid of rotated arrow icons.
  return L.velocityLayer({
    displayValues: false,
    data: [],
    velocityScale: 0.012,
    particleAge: 110, // longer-lived trails read as continuous flow instead of short rigid ticks
    particleMultiplier: 1 / 420, // dense enough that the flow field reads clearly, not sparse/static
    lineWidth: 0.9, // thin streamlines, not big rigid arrows
    frameRate: 20,
    opacity: 0.85,
    // speed-colored gradient (calm -> strong), Windfinder-style rather than one flat hue
    colorScale: ["#3ba0ff", "#7ee0c9", "#ffd166", "#ff6b6b"],
    maxVelocity: 20,
  }).addTo(map);
}
