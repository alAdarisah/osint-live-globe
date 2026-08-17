// What each layer and each group *looks like*, for the screens that draw them.
//
// settings/layerGroups.js is the taxonomy: which layer belongs to which subject,
// and what each subject is called. It deliberately imports nothing, so it can be
// tested under plain `node --test`. This is the other half -- the glyph, the
// colour and the row label -- which necessarily reaches into map/svgIcons.js and
// map/decorators.js and so could never live there.
//
// The split matters for the reason layerGroups.js's own header gives about
// copied tables: the pills, the reader's drawer and Admin Mode's dial list are
// three screens listing the same layers, and every fact any two of them share
// has to have exactly one home or they drift. Glyphs and colours are read from
// the same style tables the *map* draws with, so recolouring a layer in Admin
// Mode reaches all three screens and the markers at once.
//
// The one accepted duplication is the label strings. They are inline JSX text in
// LayersSection.jsx (1900 lines of hand-authored rows, several carrying their
// own explanatory comment mid-sentence) and extracting them would mean
// rewriting that file to be generated from data -- a much larger change than
// this, for a much smaller prize. tests/layerPresentation.test.js pins the
// coverage instead: every key the taxonomy counts has an entry here, with a
// non-empty label and a real glyph, so a layer added to one and forgotten in the
// other fails loudly rather than rendering as a blank row.

import { SVG } from "../map/svgIcons";
import {
  DARK_VESSEL_STYLE, GFW_GAP_STYLE, GFW_DETECTION_STYLE, OSM_INFRA_STYLE,
  POWER_PLANT_FUEL_STYLE, PORT_STYLE, DAM_STYLE, DEFLOCK_STYLE, RAILWAY_STYLE,
  CITY_COLOR,
  RAILWAY_LIVE_STYLE, SHIPPING_LANE_STYLE, WATER_STYLE, CABLE_LANDING_STYLE,
  LANE_DENSITY_STYLE, TERMINATOR_STYLE, CZIB_STYLE, FLOOD_STYLE, LAUNCH_STYLE,
  SAT_ELEMENT_LAYERS,
} from "../map/decorators";
import { countedKeysFor, LAYER_GROUPS } from "./layerGroups";

/**
 * The pill for each group: a short label and the dot colour that stands for the
 * subject.
 *
 * Short, because a pill strip has to fit a bar. "Infra" rather than
 * "Infrastructure & Environment" is the only real abbreviation, and the full
 * title is still what the dropdown's own header says (read from groupTitle), so
 * nothing is lost -- the pill is a handle, the header is the name.
 *
 * The dot colour is the subject's own, picked to match what that group's
 * markers actually look like on the map: conflict red, traffic blue, infra
 * amber, and so on.
 */
export const GROUP_PILL = {
  conflict: { label: "Conflict", dot: "#ff3b30" },
  traffic: { label: "Traffic", dot: "#35c2ff" },
  ground: { label: "Infra", dot: "#ff9500" },
  airspace: { label: "Airspace", dot: "#ff8c00" },
  hazards: { label: "Hazards", dot: "#ffb347" },
  // The raindrop blue the precipitation radar itself draws in, so the pill and
  // the overlay it switches on read as the same subject.
  weather: { label: "Weather", dot: "#3ba0ff" },
  space: { label: "Space", dot: "#6fe3ff" },
  // Deliberately the dimmest dot on the strip. Reference is the furniture the
  // rest of the map is read against, and a bright dot beside it would advertise
  // it as one more thing competing for attention.
  reference: { label: "Reference", dot: "#7f93a8" },
};

/** The order the pills are drawn in -- the taxonomy's own order, not a second
 *  one that could drift from it. */
export const PILL_ORDER = LAYER_GROUPS.map((group) => group.id);

const sat = (key) => ({
  svg: SAT_ELEMENT_LAYERS[key].svg,
  color: SAT_ELEMENT_LAYERS[key].color,
  token: SAT_ELEMENT_LAYERS[key].token,
});

/**
 * Per layer: the glyph, its shipped colour, the palette token that colour can be
 * overridden through, the row label, and which `counts` key reports it.
 *
 * `count: null` means the map draws this layer as geometry rather than as
 * counted points (water bodies, the terminator, the coverage overlay), so there
 * is no number to show. Deliberately explicit rather than absent: "this layer
 * has nothing to count" and "somebody forgot the count key" should not look the
 * same in a table this is read from.
 */
export const LAYER_ROW = {
  // --- conflict ---
  events: { svg: SVG.clash, color: "#ff3b30", token: "severity.critical", label: "Conflict & Violence (ACLED + UCDP + GDELT)", count: "events" },
  conflictHistory: { svg: SVG.recordMark, color: "#8f9bb3", token: "event.history", label: "Verified record (UCDP)", count: "conflictHistory" },
  officials: { svg: SVG.handshake, color: "#7ee0c9", token: "officials.cooperative", label: "Officials & Diplomacy", count: "officials" },

  // --- traffic ---
  aisNavy: { svg: SVG.warship, color: "#ffd60a", token: "ship.navy", label: "Navy & MSC Ships", count: "aisNavy" },
  aisTanker: { svg: SVG.tanker, color: "#ffb347", token: "ship.tanker", label: "Oil Tankers", count: "aisTanker" },
  aisCivilian: { svg: SVG.ship, color: "#35c2ff", token: "ship.other", label: "Civilian Ships (AIS)", count: "aisCivilian" },
  aisDigitraffic: { svg: SVG.ship, color: "#35c2ff", token: "ship.other", label: "Ships — Baltic (Fintraffic)", count: "aisDigitraffic" },
  // Named by supplier, like the Fintraffic row above, because that is the fact a
  // reader needs: it is a thinner picture of the same water, and which supplier
  // drew a hull is what says how much to read into its absence.
  marinesia: { svg: SVG.ship, color: "#35c2ff", token: "ship.other", label: "Ships (Marinesia)", count: "marinesia" },
  darkVessels: { svg: SVG.darkShip, color: DARK_VESSEL_STYLE.ais_gap.color, token: DARK_VESSEL_STYLE.ais_gap.token, label: "Dark Vessels & Transfers", count: "darkVessels", inferred: true },
  gfwGaps: { svg: GFW_GAP_STYLE.svg, color: GFW_GAP_STYLE.color, token: GFW_GAP_STYLE.token, label: "AIS Disabling (Global Fishing Watch)", count: "gfwGaps" },
  gfwDetections: { svg: SVG.hullDetection, color: GFW_DETECTION_STYLE.unmatched.color, token: GFW_DETECTION_STYLE.unmatched.token, label: "Satellite Vessel Detections (GFW)", count: "gfwDetections" },
  adsbMilitary: { svg: SVG.planeMilitary, color: "#ff4d4d", token: "aircraft.military", label: "Military Aircraft", count: "adsbMilitary" },
  adsbCivilian: { svg: SVG.planeCommercial, color: "#d8b9ff", token: "aircraft.commercial", label: "Civilian Aircraft (ADS-B)", count: "adsbCivilian" },
  adsbFlagged: { svg: SVG.planeMilitary + SVG.alertRing, color: "#ff1a1a", label: "Emergency & Hidden Aircraft", count: "adsbFlagged" },

  // --- ground ---
  infra: { svg: SVG.refinery, color: "#ff9500", token: "infra.refinery", label: "Critical Infrastructure", count: "infra" },
  osmInfra: { svg: OSM_INFRA_STYLE.military_area.svg, color: OSM_INFRA_STYLE.military_area.color, token: OSM_INFRA_STYLE.military_area.token, label: "Infrastructure (OpenStreetMap)", count: "osmInfra" },
  powerPlants: { svg: SVG.powerPlant, color: POWER_PLANT_FUEL_STYLE.other.color, token: POWER_PLANT_FUEL_STYLE.other.token, label: "Power plants (OpenStreetMap)", count: null },
  airDefense: { svg: SVG.radarBase, color: "#ff4d4d", token: "osm.radar_station", label: "Air defence & radar (OpenStreetMap)", count: null },
  airports: { svg: SVG.airfield, color: "#7f93a8", token: "airfield.medium", label: "Airfields (OurAirports)", count: "airports" },
  ports: { svg: PORT_STYLE.svg, color: PORT_STYLE.color, token: PORT_STYLE.token, label: "Ports (NGA World Port Index)", count: "ports" },
  dams: { svg: DAM_STYLE.svg, color: DAM_STYLE.color, token: DAM_STYLE.token, label: "Dams & Reservoirs (Global Dam Watch)", count: "dams" },
  deflock: { svg: DEFLOCK_STYLE.svg, color: DEFLOCK_STYLE.color, token: DEFLOCK_STYLE.token, label: "ALPR Cameras (DeFlock)", count: "deflock" },
  railways: { svg: RAILWAY_STYLE.svg, color: RAILWAY_STYLE.color, token: RAILWAY_STYLE.token, label: "Railways (Natural Earth + OpenStreetMap)", count: "railways" },
  railLive: { svg: RAILWAY_LIVE_STYLE.svg, color: RAILWAY_LIVE_STYLE.color, token: RAILWAY_LIVE_STYLE.token, label: "Live trains (Digitraffic, Finland only)", count: null, sub: true },
  powerLines: { svg: SVG.railway, color: "#e8b64f", token: "grid.line", label: "Transmission lines (OpenStreetMap)", count: null },
  shippingLanes: { svg: SHIPPING_LANE_STYLE.svg, color: SHIPPING_LANE_STYLE.color, token: SHIPPING_LANE_STYLE.token, label: "Shipping Corridors (schematic)", count: null },
  water: { svg: WATER_STYLE.svg, color: WATER_STYLE.color, token: WATER_STYLE.token, label: "Water Bodies (Natural Earth)", count: null },
  cables: { svg: SVG.cableLanding, color: CABLE_LANDING_STYLE.color, token: CABLE_LANDING_STYLE.token, label: "Submarine Cables", count: "cables" },
  firms: { svg: SVG.fire, color: "#ff9500", label: "Fires / Thermal Anomalies (FIRMS)", count: "firms" },
  jamming: { svg: SVG.jammingSignal, color: "#b833e0", label: "GPS/Radio Jamming (GPSJam)", count: "jamming" },
  laneDensity: { svg: LANE_DENSITY_STYLE.svg, color: LANE_DENSITY_STYLE.color, token: LANE_DENSITY_STYLE.token, label: "AIS Traffic Density (this map's own coverage)", count: null, inferred: true },
  terminator: { svg: TERMINATOR_STYLE.svg, color: TERMINATOR_STYLE.color, label: "Day/Night Terminator", count: null },
  coverage: { svg: SVG.recordMark, color: "#7f96a6", label: "Coverage — where this map has looked", count: null },

  // --- airspace ---
  czib: { svg: CZIB_STYLE.active.svg, color: CZIB_STYLE.active.color, token: CZIB_STYLE.active.token, label: "Airspace Warnings (EASA)", count: "czib" },

  // --- hazards ---
  hazards: { svg: SVG.earthquake, color: "#ffb347", label: "Earthquakes & Volcanoes", count: "hazards" },
  floods: { svg: FLOOD_STYLE.svg, color: "#35c2ff", label: "Floods (GDACS)", count: "floods" },

  // --- weather ---
  // `count: null` throughout, and for a stronger reason than the geometry layers
  // above: six of these seven are raster tile overlays, so there is not merely
  // nothing counted, there is nothing countable. windArrows is a particle field
  // computed from a wind grid, same story.
  //
  // Five of the seven need an OpenWeatherMap key to serve anything at all, and the
  // pill dropdown greys those five out exactly as the drawer does -- both ask
  // map/weatherLayers.js's isOwmLayerDisabled rather than either carrying a list,
  // which is that module's own stated reason for existing. Without it a reader
  // would tick Cloud Cover on an unkeyed deployment and get a silent nothing.
  precip: { svg: SVG.raindrop, color: "#3ba0ff", label: "Precipitation Radar (RainViewer)", count: null },
  clouds: { svg: SVG.cloud, color: "#c9d6dd", label: "Cloud Cover (OpenWeatherMap)", count: null },
  wind: { svg: SVG.wind, color: "#b39ddb", label: "Wind Speed (OpenWeatherMap)", count: null },
  precipitation: { svg: SVG.raindrop, color: "#6a89ff", label: "Precipitation Intensity (OpenWeatherMap)", count: null },
  temp: { svg: SVG.thermometer, color: "#ff8a65", label: "Temperature (OpenWeatherMap)", count: null },
  pressure: { svg: SVG.pressureGauge, color: "#ffd54f", label: "Pressure (OpenWeatherMap)", count: null },
  windArrows: { svg: SVG.wind, color: "#7ee0c9", label: "Wind particles (Open-Meteo)", count: null },

  // --- space ---
  satellites: { svg: SVG.satellite, color: "#6fe3ff", token: "satellite.stations", label: "Satellites (stations + military)", count: "satellites" },
  satNavigation: { ...sat("satNavigation"), label: "Navigation (GPS, Galileo, GLONASS, Beidou)", count: "satNavigation", sub: true },
  satWeather: { ...sat("satWeather"), label: "Weather", count: "satWeather", sub: true },
  satImaging: { ...sat("satImaging"), label: "Earth imaging", count: "satImaging", sub: true },
  satScience: { ...sat("satScience"), label: "Science", count: "satScience", sub: true },
  satGeo: { ...sat("satGeo"), label: "Geostationary", count: "satGeo", sub: true },
  satStarlink: { ...sat("satStarlink"), label: "Starlink", count: "satStarlink", sub: true },
  satOneweb: { ...sat("satOneweb"), label: "OneWeb", count: "satOneweb", sub: true },
  launches: { svg: SVG.launchPad, color: LAUNCH_STYLE.upcoming.color, token: LAUNCH_STYLE.upcoming.token, label: "Orbital Launches", count: "launches" },

  // --- reference ---
  // Both count, and both report a `visible (total)` pair -- which for these two is
  // the whole point: a map showing 40 of 6,319 cities is scoped, not broken, and
  // the second number is what says so.
  countries: { svg: SVG.globe, color: "#6fe3ff", label: "Country outlines & names", count: "countries" },
  cities: { svg: SVG.city, color: CITY_COLOR, token: "city.mega", label: "Cities (100k+)", count: "cities" },
};

/**
 * The rows a group's pill dropdown should draw, in taxonomy order.
 *
 * Reads countedKeysFor, so the pills list exactly the layers the reader's drawer
 * draws a top-level checkbox for -- no more (gdelt is a sub-ticker of events;
 * cities lives in the Places section) and no fewer.
 */
export function layerRowsFor(groupId) {
  return countedKeysFor(groupId)
    .map((key) => (LAYER_ROW[key] ? { key, ...LAYER_ROW[key] } : null))
    .filter(Boolean);
}
