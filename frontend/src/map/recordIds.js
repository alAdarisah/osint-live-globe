// Which field carries a record's identity, per feed.
//
// One table, three readers: createMapController's recordDetail resolves a
// record by it, map/watchlistActions.js names a pinned record by it, and the
// data editor browses by it. A second copy anywhere would be a second thing to
// keep in step with the backend's own id fields.
//
// Imports nothing, deliberately -- the same rule settings/layerGroups.js
// follows. It is read by a module that plain `node --test` has to be able to
// load, and reaching for anything Leaflet-shaped would drag the whole map layer
// in behind it.

export const ID_FIELD = {
  events: "id", gdelt: "event_id", ais: "mmsi", aisDigitraffic: "mmsi", adsb: "icao24", conflictHistory: "id",
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
  // Task 28: powerPlants reuses osm_infra's own prefixed "osm:type/id" ids,
  // the same reason railwayPoints does just above -- it reads the same raw
  // items, split into their own array (see applyData's own note).
  powerPlants: "id",
  // Task 29: same reasoning again -- airDefense reads the same osm_infra
  // sweep, split into its own array.
  airDefense: "id",
  // One pin per country, so the country code *is* the identity -- a country
  // whose score changes between polls has to update its existing marker rather
  // than be torn down and rebuilt under a new key.
  outagePoints: "country_code",
  // "country:key" (see rebuildOutageRegionPoints), because a bare region_code
  // is not unique across the whole feed the way a country code is -- IODA's
  // own entity code, the fallback for an unmatched region, isn't either.
  outageRegionPoints: "id",
};
