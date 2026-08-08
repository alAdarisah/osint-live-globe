// A city as an area rather than a point.
//
// Every city this map carries is one coordinate -- GeoNames' populated-place
// centroid -- and almost every conflict report that happens in a city is filed
// against the city rather than against a street. The result is a pile of pins on
// one point that the reader has to take apart by hand, and a map that implies
// forty separate incidents each happened at the exact same coordinate.
//
// This module gives each city a nominal radius so those reports can be grouped
// by *the place they are about* instead of by how close their pins happen to
// land on screen. That distinction is the whole reason this exists next to
// collapse.js rather than inside it:
//
//   collapseByProximity  groups what would overlap. A pixel question, and the
//                        answer changes with the zoom.
//   a city zone          groups what is about one place. A geographic question,
//                        and the answer is the same at every zoom.
//
// WHAT THE RADIUS IS NOT. It is not a boundary, not a municipal limit, and not
// surveyed. It is a population band turned into a round number of kilometres --
// a statement about how far from the centroid a report can plausibly still be
// "in" the city, chosen so that a megacity's suburbs group with it and two
// genuinely different towns twenty kilometres apart do not. Nothing is moved:
// the group's head keeps its own coordinate, every member keeps its own record,
// and the popup names the city the grouping was made on so a reader can disagree
// with it.

/**
 * Nominal urban radius by population tier, in metres.
 *
 * Keyed by CITY_TIERS' own keys (see decorators.js) so the bands a reader sees
 * in the legend and the bands the grouping uses are the same bands. Ordinary
 * round numbers, and deliberately conservative at the small end: over-merging is
 * the failure that loses information here, and a 5km town zone will miss a
 * distant suburb long before it swallows the next town.
 */
export const CITY_ZONE_RADIUS_M = {
  mega: 25_000,
  large: 15_000,
  medium: 8_000,
  town: 5_000,
};

// Grid cell for the lookup index, in degrees. Comfortably wider than the largest
// zone at any latitude (25km is ~0.22 degrees of latitude, and less of longitude
// only away from the equator), which is what makes the 3x3 neighbour scan
// exhaustive rather than approximate -- the same guarantee collapse.js and
// declutter.js get from their own cell sizing.
const CELL_DEG = 0.5;

const EARTH_RADIUS_M = 6_371_000;
const DEG = Math.PI / 180;

/**
 * Metres between two coordinates, equirectangular.
 *
 * Not haversine, on purpose. This is called once per event per render against a
 * handful of candidate cities, and over the tens of kilometres a zone spans the
 * two agree to well within the precision the inputs have -- a city centroid is
 * itself a choice about where a city "is". Haversine's trigonometry would be
 * paid on every call to refine a number whose error budget is dominated by the
 * centroid, not by the projection.
 */
function metresBetween(lat1, lon1, lat2, lon2) {
  const x = (lon2 - lon1) * DEG * Math.cos(((lat1 + lat2) / 2) * DEG);
  const y = (lat2 - lat1) * DEG;
  return Math.sqrt(x * x + y * y) * EARTH_RADIUS_M;
}

/**
 * A lookup index over the current city list.
 *
 * @param {Array<object>} cities      as served by /api/cities
 * @param {(city:object) => object} tierOf  population tier, from decorators.js
 * @param {(city:object) => string} keyOf   the city's stable id
 * @param {number} radiusScale        Admin Mode's multiplier on every radius
 * @returns {{zoneAt: (lat:number, lon:number) => object|null, zones: Array}}
 *   `zoneAt` answers with the *largest* zone containing the point, or null. See
 *   the note at the comparison itself for why largest rather than smallest.
 */
export function buildCityZoneIndex(cities, { tierOf, keyOf, radiusScale = 1 } = {}) {
  const grid = new Map();
  const zones = [];

  for (const city of cities || []) {
    if (typeof city.lat !== "number" || typeof city.lon !== "number") continue;
    const tier = tierOf(city);
    const radiusM = (CITY_ZONE_RADIUS_M[tier?.key] ?? CITY_ZONE_RADIUS_M.town) * radiusScale;
    if (!(radiusM > 0)) continue;
    const zone = { key: keyOf(city), city, lat: city.lat, lon: city.lon, radiusM, tier };
    zones.push(zone);

    // Registered into every cell the zone can reach rather than only the one its
    // centre falls in, so the scan below never has to widen for a large zone
    // whose centre sits just over a cell boundary.
    const spanLat = radiusM / (EARTH_RADIUS_M * DEG);
    const cosLat = Math.max(0.05, Math.cos(city.lat * DEG));
    const spanLon = spanLat / cosLat;
    const minX = Math.floor((city.lon - spanLon) / CELL_DEG);
    const maxX = Math.floor((city.lon + spanLon) / CELL_DEG);
    const minY = Math.floor((city.lat - spanLat) / CELL_DEG);
    const maxY = Math.floor((city.lat + spanLat) / CELL_DEG);
    for (let gx = minX; gx <= maxX; gx++) {
      for (let gy = minY; gy <= maxY; gy++) {
        const cell = `${gx}:${gy}`;
        const bucket = grid.get(cell);
        if (bucket) bucket.push(zone);
        else grid.set(cell, [zone]);
      }
    }
  }

  function zoneAt(lat, lon) {
    if (typeof lat !== "number" || typeof lon !== "number") return null;
    const bucket = grid.get(`${Math.floor(lon / CELL_DEG)}:${Math.floor(lat / CELL_DEG)}`);
    if (!bucket) return null;
    let best = null;
    for (const zone of bucket) {
      if (metresBetween(lat, lon, zone.lat, zone.lon) > zone.radiusM) continue;
      // The LARGEST containing zone wins, and this is the opposite of what it
      // first looks like it should be.
      //
      // The reasoning that argues for "smallest" is that the smaller zone is the
      // more specific claim. That is true when two zones nest because two
      // genuinely different places happen to be near each other -- but they
      // almost never nest for that reason, because the radii are calibrated so
      // that a separate town falls *outside* the big city's zone. Brovary is a
      // real town near Kyiv, 109k people, and it sits 19.5km out: past Kyiv's
      // 15km radius, so it keeps its own zone with no nesting at all.
      //
      // What actually nests is administrative subdivision. GeoNames' populated
      // -place list carries Kyiv's raions and neighbourhoods as their own
      // entries -- Shevchenkivskyi, Obolon, Darnytsya, Pechersk, Pozniaky, six
      // more -- every one of them inside Kyiv's radius. Under "smallest wins" a
      // night of strikes on Kyiv splits into eight neighbourhood groups labelled
      // with names most readers have never seen, which is worse than not
      // grouping at all: it is the pile-up this module exists to fix, plus a
      // misleading caption on each fragment.
      //
      // A neighbourhood is part of its city. "Kyiv" is both the true answer and
      // the one a reader can use, so containment decides membership and size
      // decides the name.
      if (!best || zone.radiusM > best.radiusM) best = zone;
    }
    return best;
  }

  return { zoneAt, zones };
}
