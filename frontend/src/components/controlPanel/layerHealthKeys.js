// Task 32 item 1: which source_health key (the /api/health dict's own keys --
// see backend/app.py's _SOURCE_MODULES and backend/ingest|refine/__init__.py's
// per-job `health_name`) answers "when did this layer's data last land" for a
// given control-panel layer key.
//
// Several layer keys share one health entry -- aisNavy/aisTanker/aisCivilian
// are all the one "ais" stream split client-side, the same way osmInfra/
// powerPlants/airDefense are all one Overpass sweep (see COVERAGE_FEEDS' own
// note on that split in map/popups.js, the identical reasoning applied here
// to a different table). A layer key absent from this table has no badge --
// deliberately: several curated/static feeds (infra, railways, cables'
// geometry, water) have no background poller and so no source_health entry
// at all, and a table that guessed one would be inventing a number no source
// supplied, which is exactly what this project's provenance rule forbids.
// Only keys verified against a real health_name/module name below are listed.
export const LAYER_HEALTH_KEY = {
  events: "events",
  conflictHistory: "conflict_history",
  gdelt: "gdelt",
  officials: "officials",
  aisNavy: "ais",
  aisTanker: "ais",
  aisCivilian: "ais",
  // Its own entry, not "ais": a different network with a different poller, and
  // the whole point of drawing it separately is that its health is a separate
  // question. During the aisstream outage the two answer opposite ways.
  aisDigitraffic: "ais_digitraffic",
  darkVessels: "dark_vessels",
  gfwGaps: "gfw_gaps",
  gfwDetections: "gfw_detections",
  adsbMilitary: "adsb",
  adsbCivilian: "adsb",
  adsbFlagged: "adsb",
  osmInfra: "osm_infra",
  powerPlants: "osm_infra",
  airDefense: "osm_infra",
  airports: "airports",
  ports: "ports",
  dams: "dams",
  deflock: "deflock",
  marinesia: "marinesia",
  railways: "railways",
  // These two were both "digitraffic_rail", which is the *module* name, not a
  // registered source name -- backend/sources/digitraffic_rail.py registers
  // "rail_live" and "rail_stations" separately. So both looked up a key that has
  // never existed in /api/health, and did it silently: a missing key is
  // indistinguishable from a source with no health entry, which this file's own
  // header says several layers legitimately are. Two freshness badges showed
  // nothing, and map/exportBuilder.js reads the same table, so an export
  // containing live Finnish trains carried a provenance block with no collection
  // time -- indistinguishable from an untracked curated feed.
  railLive: "rail_live",
  railStations: "rail_stations",
  powerLines: "power_lines",
  water: "water_bodies",
  cables: "cables",
  firms: "firms",
  jamming: "jamming",
  laneDensity: "lane_density",
  czib: "czib",
  launches: "launches",
  hazards: "hazards",
  floods: "floods",
  satellites: "satellites",
  satNavigation: "satellites",
  satWeather: "satellites",
  satImaging: "satellites",
  satScience: "satellites",
  satGeo: "satellites",
  satStarlink: "satellites",
  satOneweb: "satellites",
};
