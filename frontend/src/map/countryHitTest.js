// Point-in-country lookup, done in geometry rather than by letting the browser
// hit-test the country SVG paths.
//
// Why not just use the paths' own click handlers, which is what this replaces:
// Leaflet's L.Canvas renderer (used by the FIRMS and jamming click-target
// layers) creates a bare <canvas> that is sized to the full padded viewport,
// carries its own click/mousemove listeners, and gets NO pointer-events:none.
// It lives in overlayPane (z-index 400) while the country shapes live in a
// pane below it, so from the first moment a FIRMS or jamming point renders --
// zoom 5, and jamming is on by default -- that canvas covered every country on
// screen and swallowed the clicks. It is never removed again, so countries
// stayed dead for the rest of the session, and their hover highlight stuck
// because mouseout never fired either.
//
// Pane stacking cannot fix this without breaking the other direction (country
// shapes are painted over the whole land surface, so raising them above the
// overlay pane is what made them swallow *marker* clicks in the first place).
// Testing the geometry ourselves from the map's own click/mousemove sidesteps
// the stacking question entirely: the country layer becomes pure paint
// (pointer-events: none), and no overlay added later can re-break either side.
//
// Cost: bounding boxes are checked first, so a click typically ray-casts one
// to three polygons out of ~180.

/** Longitude wrapped into [-180, 180) -- `worldCopyJump` lets a click come
 *  back as e.g. 190 after panning past the antimeridian, while GeoJSON rings
 *  are always written in the canonical range. */
function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

// Standard even-odd crossing count. `ring` is GeoJSON order: [[lon, lat], ...].
function pointInRing(ring, lat, lon) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Shoelace, in raw degrees. Only ever compared against other countries' values
// to break "the click is inside both" ties, so the lack of a projection (which
// would make it an actual area) does not matter -- it only has to order
// Lesotho below South Africa, and it does.
function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(sum) / 2;
}

// Area centroid of one ring, in raw degrees, as [lon, lat]. Null for a
// degenerate ring (zero signed area), which the caller falls back out of.
function ringCentroid(ring) {
  let twiceArea = 0, x = 0, y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    twiceArea += cross;
    x += (ring[j][0] + ring[i][0]) * cross;
    y += (ring[j][1] + ring[i][1]) * cross;
  }
  if (!twiceArea) return null;
  return [x / (3 * twiceArea), y / (3 * twiceArea)];
}

/** Midpoint of the widest interior span of the horizontal line at `lat`, or
 *  null if the line misses the polygon. Every ring is swept, holes included, so
 *  the even-odd pairs it walks are genuinely inside. */
function widestSpanAt(rings, lat) {
  const xs = [];
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat)) xs.push(((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    }
  }
  xs.sort((a, b) => a - b);
  let best = null, bestWidth = 0;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const width = xs[i + 1] - xs[i];
    if (width > bestWidth) {
      bestWidth = width;
      best = (xs[i] + xs[i + 1]) / 2;
    }
  }
  return best;
}

/**
 * A point to hang a country-scoped marker on -- inside the country, and on its
 * largest landmass rather than wherever the bounding box happens to centre.
 *
 * Neither of the two obvious answers works alone. A bbox centre sits in the sea
 * for Norway, Croatia and every archipelago; a ring centroid sits outside any
 * sufficiently concave shape. So: centroid of the biggest polygon when it lands
 * inside, otherwise the middle of the widest stretch of country along the line
 * through it, and the bbox centre only if the geometry is degenerate.
 *
 * This is a place to *draw* a national measurement, not a claim about where in
 * the country anything happened -- see decorateOutage, which says so in the
 * popup rather than leaving the pin to imply otherwise.
 *
 * @param {object} entry an entry from buildCountryIndex
 * @returns {{lat: number, lon: number}|null}
 */
export function representativePointOf(entry) {
  let largest = null;
  let largestArea = -1;
  for (const rings of entry?.polygons || []) {
    const outer = rings[0];
    if (!outer || outer.length < 4) continue;
    const area = ringArea(outer);
    if (area > largestArea) {
      largestArea = area;
      largest = rings;
    }
  }
  if (!largest) return null;

  const centroid = ringCentroid(largest[0]);
  if (centroid) {
    const [lon, lat] = centroid;
    let inside = pointInRing(largest[0], lat, lon);
    for (let h = 1; inside && h < largest.length; h++) {
      if (pointInRing(largest[h], lat, lon)) inside = false;
    }
    if (inside) return { lat, lon };
    const swept = widestSpanAt(largest, lat);
    if (swept != null) return { lat, lon: swept };
  }

  const b = entry.bbox;
  if (!b) return null;
  return { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 };
}

function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

/**
 * @param {object} geojson  the countries FeatureCollection
 * @returns {Array} entries of {key, iso, name, props, polygons, bbox, area},
 *   sorted smallest-area-first so findCountryAt can return the first match
 *   and have that be the most specific one.
 */
export function buildCountryIndex(geojson) {
  const entries = [];
  for (const feature of geojson?.features || []) {
    const polygons = polygonsOf(feature.geometry);
    if (!polygons.length) continue;

    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    let area = 0;
    for (const rings of polygons) {
      const outer = rings[0];
      if (!outer || outer.length < 4) continue;
      area += ringArea(outer);
      for (const [lon, lat] of outer) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }
    }
    if (!Number.isFinite(minLat)) continue;

    const props = feature.properties || {};
    entries.push({
      // Features without an ISO code (disputed/unrecognised territories carry
      // "-99" or nothing in Natural Earth) fall back to their name, so their
      // shapes still select and toggle. Only the city filter, which matches on
      // real ISO2 country codes, gets nothing out of that fallback.
      key: props.iso_a2 && props.iso_a2 !== "-99" ? props.iso_a2 : props.name || null,
      iso: props.iso_a2 && props.iso_a2 !== "-99" ? props.iso_a2 : null,
      name: props.name || "",
      props,
      polygons,
      bbox: { minLat, maxLat, minLon, maxLon },
      area,
    });
  }
  entries.sort((a, b) => a.area - b.area);
  return entries;
}

/**
 * Is this point inside one country's borders?
 *
 * Exported on its own (rather than only being reachable through findCountryAt)
 * because scoping a feed to a *known* country is the other half of the same
 * question: the panels have the country already and want a yes/no per record,
 * not a search over all ~180. See map/countryScope.js.
 *
 * @param {object} entry  a buildCountryIndex entry, or anything carrying the
 *                        same `{bbox, polygons}` pair
 */
export function countryContainsPoint(entry, lat, lon) {
  const b = entry?.bbox;
  if (!b) return false;
  const x = wrapLon(lon);
  if (lat < b.minLat || lat > b.maxLat || x < b.minLon || x > b.maxLon) return false;
  for (const rings of entry.polygons || []) {
    const outer = rings[0];
    if (!outer || !pointInRing(outer, lat, x)) continue;
    // Holes: a point inside a hole is outside the country (e.g. the enclave
    // cut out of the surrounding state).
    let inHole = false;
    for (let h = 1; h < rings.length; h++) {
      if (pointInRing(rings[h], lat, x)) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

/**
 * The smallest country containing this point, or null.
 * Smallest-first ordering is what makes enclaves (Lesotho, San Marino, the
 * Vatican) selectable at all -- they are wholly inside another country, so a
 * first-match-wins scan over an arbitrarily ordered list would return whichever
 * of the two happened to come first in the file.
 */
export function findCountryAt(index, lat, lon) {
  for (const entry of index) {
    if (countryContainsPoint(entry, lat, lon)) return entry;
  }
  return null;
}
