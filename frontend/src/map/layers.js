// Constructs every Leaflet layer object the app uses, given a live map
// instance. Pure "what layers exist and how are they configured" -- no data
// goes into them here (see renderers.js for that) and no app state is read.
// Called once by useLeafletMap when the map is created.

import { L } from "./leafletGlobal";

function cleanClusterIcon(cluster) {
  const count = cluster.getChildCount();
  const size = count < 10 ? 26 : count < 100 ? 32 : 40;
  return L.divIcon({
    html: `<div>${count}</div>`,
    className: "clean-cluster",
    iconSize: [size, size],
  });
}

const clusterOpts = {
  maxClusterRadius: 70,
  showCoverageOnHover: false,
  spiderfyOnMaxZoom: true,
  disableClusteringAtZoom: 8,
  chunkedLoading: true,
  iconCreateFunction: cleanClusterIcon,
};

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
    attribution: "Weather: OpenWeatherMap",
  });
  const windLayer = L.tileLayer("/api/weather/tile/wind_new/{z}/{x}/{y}.png", {
    opacity: 0.5,
    attribution: "Weather: OpenWeatherMap",
  });

  return { precip: precipLayer, clouds: cloudsLayer, wind: windLayer };
}

export function createFirmsLayers(map) {
  // FIRMS runs to 100k+ points globally, which as individual icons is just
  // clutter even when clustered -- a density heatmap is the standard way
  // fire-tracking dashboards show this, and it reads far cleaner at world
  // zoom. It trades away per-point click popups for that clarity.
  const firmsHeat = L.heatLayer([], {
    radius: 16,
    blur: 22,
    maxZoom: 9,
    minOpacity: 0.35,
    gradient: { 0.2: "#5c1a00", 0.4: "#b34700", 0.6: "#ff6a00", 0.8: "#ff9500", 1: "#ffe066" },
  });
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

export function createEntityClusterGroups(map) {
  const groups = {
    acled: L.markerClusterGroup(clusterOpts).addTo(map),
    ais: L.markerClusterGroup(clusterOpts).addTo(map),
    gdelt: L.markerClusterGroup(clusterOpts).addTo(map),
    adsb: L.markerClusterGroup(clusterOpts), // wrapped below, alongside the always-visible military layer
  };
  // Military aircraft never cluster and are never hidden by the ADS-B zoom
  // gate (see renderAdsbLayer) -- a plain layerGroup keeps every one an
  // individually visible icon no matter how far out the view is zoomed.
  const militaryAdsbGroup = L.layerGroup();
  const adsbLayer = L.layerGroup([groups.adsb, militaryAdsbGroup]).addTo(map);
  return { groups, militaryAdsbGroup, adsbLayer };
}

export function createCountriesLayer(map, onEachFeature) {
  function countryStyle() {
    return { className: "country-shape", color: "rgba(111, 227, 255, 0.45)", weight: 1, fillColor: "#6fe3ff", fillOpacity: 0.03 };
  }
  return L.geoJSON(null, { style: countryStyle, onEachFeature }).addTo(map);
}

export function createCitiesGroup(map) {
  return L.markerClusterGroup({ ...clusterOpts, maxClusterRadius: 50 }).addTo(map);
}

export function createTrailLayers(map) {
  // Plain (non-clustered) layers for fading position-history lines behind
  // ships/aircraft. Kept separate from the marker cluster groups since
  // lines shouldn't be clustered.
  return {
    shipTrailsLayer: L.layerGroup().addTo(map),
    aircraftTrailsLayer: L.layerGroup().addTo(map),
  };
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
