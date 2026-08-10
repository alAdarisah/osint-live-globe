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
  railways: "railways",
  railLive: "digitraffic_rail",
  railStations: "digitraffic_rail",
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
