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

// NASA GIBS satellite imagery, as a basemap that sits *above* the vector
// basemap and below everything else. Keyless WMTS-REST tiles, no backend of our
// own involved.
//
// Four things about the URL are easy to get wrong and every one of them fails
// silently as a 404 rather than as anything a reader would recognise:
//
//   * GIBS orders its REST path {z}/{y}/{x}, not the {z}/{x}/{y} every other
//     tile server uses;
//   * each layer has its own maximum native zoom, and asking past it returns an
//     error tile rather than a 404, so Leaflet has to be told;
//   * the file extension is per layer -- the true-colour products serve JPEG,
//     the day/night band only PNG;
//   * and each product has its own lag. True colour is available same day; the
//     day/night band runs about three days behind, so asking it for "today"
//     404s every tile. `lagDays` is what stops that, by clamping the request
//     back to the newest date the product actually has.
export const GIBS_LAYERS = {
  modis: {
    id: "MODIS_Terra_CorrectedReflectance_TrueColor",
    matrix: "GoogleMapsCompatible_Level9",
    maxNativeZoom: 9,
    format: "jpg",
    lagDays: 0,
    label: "True colour (MODIS Terra)",
    note: "Daily daylight pass, ~250 m. Cloud tops included -- most of the world is under cloud most days.",
  },
  viirs: {
    id: "VIIRS_SNPP_CorrectedReflectance_TrueColor",
    matrix: "GoogleMapsCompatible_Level9",
    maxNativeZoom: 9,
    format: "jpg",
    lagDays: 0,
    label: "True colour (VIIRS)",
    note: "Same idea as MODIS, sharper and a few hours later in the day.",
  },
  night: {
    id: "VIIRS_SNPP_DayNightBand_At_Sensor_Radiance",
    matrix: "GoogleMapsCompatible_Level8",
    maxNativeZoom: 8,
    format: "png",
    // Measured against the live service: three days back is the newest date
    // that returns tiles.
    lagDays: 3,
    label: "Night lights (VIIRS day/night band)",
    note: "What is lit after dark. A city that was bright last week and dark tonight is the point of this layer.",
  },
};

/**
 * The date a layer will actually be shown for: the requested day, or the
 * newest one that product has if the request is inside its lag.
 *
 * Exported because the imagery panel prints this rather than what was asked
 * for -- telling a reader they are looking at today's night lights when the
 * newest available is three days old would be the wrong kind of tidy.
 */
export function gibsDateFor(layerKey, date) {
  const layer = GIBS_LAYERS[layerKey];
  if (!layer || !date) return date || "";
  if (!layer.lagDays) return date;
  const asked = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(asked)) return date;
  const newest = Date.now() - layer.lagDays * 86400000;
  return new Date(Math.min(asked, newest)).toISOString().slice(0, 10);
}

export function gibsUrlFor(layerKey, date) {
  const layer = GIBS_LAYERS[layerKey];
  if (!layer || !date) return "";
  const day = gibsDateFor(layerKey, date);
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer.id}/default/${day}/${layer.matrix}/{z}/{y}/{x}.${layer.format}`;
}

export function createImageryLayer(map) {
  // Starts with no URL and unattached: the layer only exists once a reader
  // picks one, same "the real URL arrives later" shape the precip layer has.
  return L.tileLayer("", {
    opacity: 0.85,
    // Above the vector basemap (which has no explicit zIndex, so 1) and below
    // the weather rasters at 5, so imagery never covers precipitation or cloud.
    zIndex: 3,
    maxNativeZoom: 9,
    attribution:
      'Imagery: <a href="https://worldview.earthdata.nasa.gov" target="_blank" rel="noopener noreferrer">NASA EOSDIS GIBS</a>',
  });
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

/**
 * How solid a heat canvas is drawn before Admin Mode's own layer opacity.
 *
 * leaflet.heat has no opacity of its own worth the name -- `minOpacity` sets the
 * floor of the density ramp, not the strength of the whole layer, so turning it
 * down thins the cold end and leaves every hot cell fully opaque. The lever that
 * does what a reader means by "opacity" is CSS on the canvas element, applied in
 * applyWashStack in createMapController.js -- which also sets the kernel radius
 * from the layer's Size dial, since a heat layer has no glyph to scale.
 *
 * FIRMS is deliberately faint. A global thermal feed is mostly agricultural
 * burning (see the firms entry in map/scene.js), and at full strength that smear
 * sits on top of the conflict pins this map exists for. Jamming stays at full
 * strength: it is a few hundred cells rather than a quarter of a million points,
 * and it is a finding rather than a background.
 */
export const FIRMS_HEAT_OPACITY = 0.3;
export const JAMMING_HEAT_OPACITY = 1;

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
    // Statements, meetings and state visits by heads of state and foreign
    // ministries -- CAMEO-coded from trusted newsrooms plus the governments'
    // own press feeds. See backend/sources/officials.py.
    officials: L.layerGroup().addTo(map),
    // UCDP's reviewed record. NOT added to the map here: it is off by default
    // precisely because it is a month or more out of date, and a verified
    // historical dataset sitting unlabelled among live pins would be the most
    // misleading thing on the map.
    conflictHistory: L.layerGroup(),
    // Earthquakes and volcanic activity (backend/sources/hazards.py). Also not
    // added here: off by default, since most days it has nothing to say about
    // the conflict picture this map is primarily for.
    hazards: L.layerGroup(),
    // Airfields (backend/sources/airports.py) -- reference context for the
    // aircraft layers, off by default and gated hard by zoom.
    airports: L.layerGroup(),
    // AIS gaps and possible ship-to-ship transfers, derived from our own
    // recorded history (backend/sources/dark_vessels.py). Off by default: it is
    // the one layer here whose every pin is an inference, and it should be
    // something a reader chooses to look at.
    darkVessels: L.layerGroup(),
    // Submarine cable landing points. Not added to the map directly -- wrapped
    // together with the cable routes into one combined "cables" layer in
    // createMapController.js, same pattern as infraGroup + pipelinesGroup.
    cableLandings: L.layerGroup(),
    // Orbital launches at their pads (backend/sources/launches.py). Off by
    // default -- there are only a few dozen and they are not what this map is
    // primarily for.
    launches: L.layerGroup(),
    // OpenStreetMap-derived infrastructure, off by default and kept strictly
    // apart from the curated infra layer (see backend/sources/osm_infra.py).
    osmInfra: L.layerGroup(),
    // One pin per country IODA currently reports offline, at that country's
    // representative interior point. Added here, i.e. on by default, because
    // the country tint it replaced was unconditional too -- a national blackout
    // is not something a reader should have to switch on to find out about.
    outagePoints: L.layerGroup().addTo(map),
    // Global Fishing Watch's own record of AIS disabling (gfw_gaps.py). Off by
    // default for the same reason darkVessels is: every record is an inference
    // about intent. That the inference is somebody else's does not change what
    // kind of claim it is.
    gfwGaps: L.layerGroup(),
    // Radar and optical vessel detections (gfw_detections.py). Off by default
    // for a different reason -- these are measurements, but a scene weeks old
    // drawn beside live AIS is exactly the confusion the layer risks, so it
    // should appear because a reader asked for it.
    gfwDetections: L.layerGroup(),
    // EASA conflict-zone bulletins (czib.py). Off by default: a standing
    // regulatory advisory is reference for a specific question rather than
    // something to watch, the same footing the cables layer sits on.
    czib: L.layerGroup(),
    // GDACS flood alerts (floods.py). Its own key rather than a third kind
    // inside hazards -- see the decision record in that module's docstring.
    floods: L.layerGroup(),
    // NGA World Port Index (ports.py). Reference furniture for the vessels
    // drawn above it, off by default and gated by zoom.
    ports: L.layerGroup(),
    // Global Dam Watch (dams.py). Reference material a reader goes looking for.
    dams: L.layerGroup(),
  };
  return { groups };
}

/**
 * @param getFill  (properties) => {fillColor, fillOpacity} | null. Null leaves
 *   the shape unpainted, which is what an unmeasured country must look like --
 *   see choropleth.js on why that has to stay distinct from a value of zero.
 *   Defaulted, so a caller that wants no fill can omit it entirely.
 */
export function createCountriesLayer(map, getFill = () => null) {
  // Stroke starts fully transparent -- boundaries only appear via the
  // .hovered/.country-hot/.country-selected CSS classes, which set their own
  // stroke color and win over this base regardless. Without that, every
  // untouched country's outline sat faintly visible at world zoom, which read
  // as visual noise.
  function countryStyle(feature) {
    // The fill is the only thing a metric may move. Everything else here is
    // structural -- the transparent stroke, the class the highlight CSS hangs
    // off, and interactive:false -- and a metric that could reach any of it
    // would be able to break hover, selection or hit-testing from a dropdown.
    const fill = feature && feature.properties ? getFill(feature.properties) : null;
    return {
      className: "country-shape",
      color: "rgba(111, 227, 255, 0)",
      weight: 1,
      fillColor: (fill && fill.fillColor) || "#6fe3ff",
      fillOpacity: fill ? fill.fillOpacity : 0,
      // The shapes are paint only. Hover and selection are hit-tested from the
      // map's own mousemove/click against the geometry (see
      // countryHitTest.js), which is the only arrangement that survives an
      // interactive full-viewport L.Canvas renderer being added above this
      // pane -- and it also means a country's fill can never swallow a click
      // meant for a marker sitting on top of it.
      interactive: false,
    };
  }
  // Own pane, z-indexed below the default overlayPane (400) so the shapes
  // paint under every point layer rather than over them.
  if (!map.getPane("countriesPane")) {
    map.createPane("countriesPane").style.zIndex = 350;
  }
  return L.geoJSON(null, { style: countryStyle, pane: "countriesPane" }).addTo(map);
}

// Where a conflict event could actually be, as opposed to where its pin is.
//
// Every fused event carries geo_radius_km -- the backend's own statement of how
// far out the coordinate may be -- and until now none of it was drawn. A row
// geocoded to a national centroid claims 400 km of slack and was rendered as a
// dot, which asserts a precision the pipeline had already disclaimed. The pin
// stays (it is the click target, and it keeps its dashed .imprecise ring); this
// is the area drawn underneath it.
//
// Its own pane at 380: above the country shapes at 350 so a circle is not
// buried by a fill, below the default overlayPane at 400 so it never paints
// over the pins it belongs to. pointerEvents is off on the whole pane rather
// than per-circle -- a 400 km disc that could take a click would swallow every
// marker inside it, which is the same failure countryHitTest.js exists to
// avoid.
export function createUncertaintyLayer(map) {
  if (!map.getPane("uncertaintyPane")) {
    const pane = map.createPane("uncertaintyPane");
    pane.style.zIndex = 380;
    pane.style.pointerEvents = "none";
  }
  return L.layerGroup().addTo(map);
}

export function createCitiesGroup(map) {
  return L.layerGroup().addTo(map);
}

// The rings that show what a city zone covers (see cityZones.js). Shares the
// uncertainty pane rather than taking one of its own, and for the same two
// reasons that pane was created: both are areas drawn around a point to say
// something about a point, and both must be unclickable -- a 25km disc that
// could take a click would swallow every pin inside the city it is drawn around,
// which is exactly the pile-up the zones exist to make readable.
export function createCityZoneLayer(map) {
  createUncertaintyLayer(map); // for the pane; the group it returns is not ours
  return L.layerGroup([], { pane: "uncertaintyPane" }).addTo(map);
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

// Submarine cable routes (backend/sources/cables.py) -- 718 polylines, same
// "lines, not points, small curated set" treatment createPipelinesGroup gets.
// Not added to the map directly: combined with the landing-point markers under
// the single "cables" layer key in createMapController.js.
export function createCablesGroup() {
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
