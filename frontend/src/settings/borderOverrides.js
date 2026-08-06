// Redrawn country boundaries, applied to the countries feed on its way in.
//
// The sibling of applyOverrides.js, and for the same reason: every payload
// passes through here between the fetch and anything that reads it (see
// useOsintData.js's `transform`), so an edited border reaches the shapes, the
// hit-test index, the panel scoping and the outage pins at once rather than
// only the thing that happened to be redrawn.
//
// What is stored, and why it is stored that way:
//
//   { [countryKey]: { fp, rings: { "<polygon>:<ring>": [[lon, lat], ...] } } }
//
// Sparse -- only the rings someone actually dragged -- but each of those is
// stored whole. A per-vertex delta keyed on index would be smaller still and
// could not express the two gestures that matter most (inserting a vertex where
// the 1:110m generalisation has none, deleting one it should not have), because
// either shifts every index after it.
//
// `fp` is a fingerprint of the geometry the edit was made against: the polygon
// count and every ring's length. The ring key is positional inside the
// feature's MultiPolygon, and sources/countries.py refetches Natural Earth
// daily -- if an upstream release ever reorders Canada's thirty polygons, a
// stored 93-point ring would land on a different island and silently scramble
// the country. A fingerprint mismatch drops the edit instead, and the admin
// panel says so (see staleBorderKeys).
//
// Coordinates are quantized on the way in and on the way out. That is not a
// size optimisation, it is what keeps shared borders shared: neighbouring
// countries in Natural Earth hold byte-identical coordinates along a common
// boundary (every landlocked country's vertices are shared, all of them), and
// the editor moves both sides at once by looking a coordinate up in a map keyed
// on its own value. Store a rounded number while the neighbour keeps
// -141.00000000000003 and the two stop matching one edit later.

// 5 decimals is ~1.1 m. Measured over the 7,536 distinct coordinates in
// ne_110m_admin_0_countries: 3dp collides 39 pairs, 4dp 35, 5dp 17, 6dp none.
// Every one of those 17 is a sub-metre sliver artefact -- there are no distinct
// coordinate pairs at all between 1e-4 and 1e-3 degrees -- so 5dp buys a clean
// lattice for about one byte per number.
export const BORDER_PRECISION = 5;

// The largest ring on Earth at this resolution is 556 points (Antarctica's
// coastline); the largest country is Canada at 794 across 30 polygons.
export const MAX_RING_POINTS = 2000;

// ~5x every vertex on the planet (10,654). The ceiling exists because the whole
// settings object is PUT as one document: a borders block that pushed it past
// admin_config.py's MAX_BYTES would 413 the save of *every other setting* too,
// and the panel would just say "not saved" with no hint as to which of them did
// it. Refusing the ring that crosses the line is a failure someone can act on.
export const MAX_TOTAL_POINTS = 50000;

const RING_KEY_RE = /^\d{1,3}:\d{1,3}$/;
const MAX_COUNTRY_KEY_LENGTH = 64;

/** One coordinate, snapped to the shared lattice. */
export function q(value) {
  const factor = 10 ** BORDER_PRECISION;
  // +0 collapses -0, which would otherwise key differently from 0 as a string.
  return Math.round(value * factor) / factor + 0;
}

/** The key two countries agree on when they share a boundary vertex. */
export function coordKey(lon, lat) {
  return `${q(lon)},${q(lat)}`;
}

export function ringKey(polygonIndex, ringIndex) {
  return `${polygonIndex}:${ringIndex}`;
}

/** @returns {[number, number]|null} [polygonIndex, ringIndex] */
export function parseRingKey(key) {
  if (typeof key !== "string" || !RING_KEY_RE.test(key)) return null;
  const [p, r] = key.split(":");
  return [Number(p), Number(r)];
}

/**
 * The key a country is stored and looked up under.
 *
 * The same fallback buildCountryIndex and countryKeyOfProps use, restated a
 * third time because this side only ever has a GeoJSON feature. Territories
 * with no ISO code ("-99" in Natural Earth) key on their name.
 */
export function countryKeyOfFeature(feature) {
  const props = feature?.properties;
  if (!props) return null;
  if (props.iso_a2 && props.iso_a2 !== "-99") return props.iso_a2;
  return props.name || null;
}

function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

/**
 * A cheap description of a geometry's *shape of shapes* -- how many polygons,
 * and how long each of their rings is. Two geometries with the same fingerprint
 * address the same rings under the same keys; two with different ones do not.
 *
 * Ring lengths change as soon as a vertex is inserted or deleted, so this is
 * recorded from the geometry an edit *started* from, not from the edited one.
 */
export function geometryFingerprint(geometry) {
  const polygons = ringsOf(geometry);
  if (!polygons.length) return null;
  const lengths = [];
  for (const rings of polygons) {
    for (const ring of rings) lengths.push(Array.isArray(ring) ? ring.length : 0);
  }
  return `${polygons.length}:${lengths.join(",")}`;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A ring copied point by point, so nothing downstream shares an array with it. */
function cloneRing(ring) {
  const out = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) out[i] = [ring[i][0], ring[i][1]];
  return out;
}

/**
 * A geometry copied all the way down to its coordinate pairs.
 *
 * Exported because the editor needs exactly this on session start: the working
 * geometry has to be the session's own, or a drag would mutate the pristine
 * payload useOsintData keeps in fetchedRef -- which is the copy every revert
 * re-derives from, so corrupting it makes "put this border back" put back the
 * edit.
 */
export function cloneGeometry(geometry) {
  if (!geometry) return geometry;
  if (geometry.type === "Polygon") {
    return { ...geometry, coordinates: geometry.coordinates.map(cloneRing) };
  }
  if (geometry.type === "MultiPolygon") {
    return { ...geometry, coordinates: geometry.coordinates.map((rings) => rings.map(cloneRing)) };
  }
  return geometry;
}

/** Is this a FeatureCollection we can work with at all? */
function isFeatureCollection(fc) {
  return isPlainObject(fc) && Array.isArray(fc.features);
}

/**
 * One country's stored rings written into a cloned geometry.
 * @returns the number of rings actually applied.
 */
function applyRingsTo(geometry, rings) {
  const polygons = ringsOf(geometry);
  let applied = 0;
  for (const [key, ring] of Object.entries(rings)) {
    const parsed = parseRingKey(key);
    if (!parsed) continue;
    const [p, r] = parsed;
    // A ring key that does not resolve is not an error worth failing the whole
    // country over -- the fingerprint check above has already established the
    // geometry is the one this edit was made against, so this only fires for a
    // hand-written key.
    if (!polygons[p] || !polygons[p][r]) continue;
    polygons[p][r] = cloneRing(ring);
    applied++;
  }
  return applied;
}

/**
 * The countries feed with every stored boundary edit written into it.
 *
 * @param {object} fc       the countries FeatureCollection, as served
 * @param {object} borders  the settings' `borders` block
 * @returns the payload the app should use -- the original collection by
 *   identity when there is nothing to apply, so the common case costs one
 *   lookup and no copying (same contract as applyOverrides).
 */
export function applyBorderOverrides(fc, borders) {
  if (!isFeatureCollection(fc)) return fc;
  if (!isPlainObject(borders) || !Object.keys(borders).length) return fc;

  let touched = false;
  const features = fc.features.map((feature) => {
    const key = countryKeyOfFeature(feature);
    const entry = key == null ? null : borders[key];
    if (!isPlainObject(entry) || !isPlainObject(entry.rings)) return feature;
    if (entry.fp && entry.fp !== geometryFingerprint(feature.geometry)) return feature;

    const sourceFingerprint = geometryFingerprint(feature.geometry);
    const geometry = cloneGeometry(feature.geometry);
    if (!applyRingsTo(geometry, entry.rings)) return feature;

    touched = true;
    return {
      ...feature,
      geometry,
      // The fingerprint of what this was drawn *over*, carried on the feature
      // because it is no longer recoverable from the geometry: inserting or
      // deleting a vertex changes a ring's length, which is what a fingerprint
      // is made of. Without it every edit that added or removed a point would
      // report itself as stale a moment after being made.
      __sourceFp: sourceFingerprint,
      // Marks the country everywhere it is rendered, for the same reason
      // applyOverrides sets __edited on a record: a national border that has
      // been redrawn and does not say so is a stronger version of the single
      // most misleading thing this map could show. popups.js reads it.
      properties: { ...feature.properties, __bordersEdited: true },
    };
  });

  return touched ? { ...fc, features } : fc;
}

/**
 * Every loaded country's fingerprint, keyed the way an edit is.
 *
 * Small enough (177 short strings) to hand to React on every boundary rebuild,
 * which is what lets the admin panel spot a stale edit without the whole
 * multi-megabyte FeatureCollection having to live in React state.
 */
export function countryFingerprints(fc) {
  const out = {};
  if (!isFeatureCollection(fc)) return out;
  for (const feature of fc.features) {
    const key = countryKeyOfFeature(feature);
    // An overridden feature reports what it was drawn over, not what it now
    // is -- staleness is a question about the source, and the geometry in hand
    // is the answer to a different one.
    if (key != null) out[key] = feature.__sourceFp ?? geometryFingerprint(feature.geometry);
  }
  return out;
}

/**
 * The countries whose stored edit no longer matches the geometry being served.
 *
 * Nothing is deleted on their behalf -- an upstream release that reordered
 * polygons could be reverted, and throwing the edit away would make that
 * unrecoverable. The admin panel lists them so the choice is a person's.
 *
 * @param {object} fingerprints from countryFingerprints
 */
export function staleBorderKeys(fingerprints, borders) {
  if (!isPlainObject(fingerprints) || !isPlainObject(borders)) return [];
  const stale = [];
  for (const [key, entry] of Object.entries(borders)) {
    if (!isPlainObject(entry) || !entry.fp) continue;
    // A country absent from the current payload is not stale, only out of
    // scope: the region filter serves a bbox subset (see regions.py).
    if (!(key in fingerprints)) continue;
    if (fingerprints[key] !== entry.fp) stale.push(key);
  }
  return stale;
}

/** What the admin panel reports about the size of the borders block. */
export function borderStats(borders) {
  let countries = 0;
  let rings = 0;
  let points = 0;
  if (isPlainObject(borders)) {
    for (const entry of Object.values(borders)) {
      if (!isPlainObject(entry) || !isPlainObject(entry.rings)) continue;
      countries++;
      for (const ring of Object.values(entry.rings)) {
        if (!Array.isArray(ring)) continue;
        rings++;
        points += ring.length;
      }
    }
  }
  return { countries, rings, points, limit: MAX_TOTAL_POINTS };
}

/**
 * Every coordinate in the world, mapped to every place it appears.
 *
 * This is what lets a shared border move as one line. Natural Earth's 1:110m
 * admin-0 set is generated from a topology and preserves it: 2,658 coordinates
 * are owned by more than one country, the owner histogram is 1 -> 4878,
 * 2 -> 2493, 3 -> 164, 4 -> 1, and those 164 triple-owned points are, to within
 * noise, the world's land tripoints. Matching on the exact (quantized) value is
 * therefore a correct model of this data rather than a heuristic -- every
 * landlocked country is 100% shared, and the shortfall for a coastal one is
 * exactly its coastline, which has no neighbour to disagree with.
 *
 * Ring-closure duplicates are skipped: index len-1 is index 0 and is written
 * alongside it, so listing it as its own site would move the vertex twice.
 *
 * @param {object} fc the FeatureCollection as currently loaded (post-override,
 *   so its coordinates already sit on the same lattice as anything stored)
 * @returns {Map<string, Array<{countryKey: string, p: number, r: number, i: number}>>}
 */
export function buildColocationIndex(fc) {
  const index = new Map();
  if (!isFeatureCollection(fc)) return index;

  for (const feature of fc.features) {
    const countryKey = countryKeyOfFeature(feature);
    if (countryKey == null) continue;
    const polygons = ringsOf(feature.geometry);
    for (let p = 0; p < polygons.length; p++) {
      const rings = polygons[p];
      for (let r = 0; r < rings.length; r++) {
        const ring = rings[r];
        if (!Array.isArray(ring) || ring.length < 4) continue;
        for (let i = 0; i < ring.length - 1; i++) {
          const key = coordKey(ring[i][0], ring[i][1]);
          const sites = index.get(key);
          if (sites) sites.push({ countryKey, p, r, i });
          else index.set(key, [{ countryKey, p, r, i }]);
        }
      }
    }
  }
  return index;
}

/**
 * A stored borders block, validated field by field.
 *
 * Lives here rather than in defaults.js only because everything it needs to
 * know about the shape is here; mergeSettings calls it as one of its branches
 * and it obeys the same rule the rest of that file does -- this is the load
 * path for a file someone can hand-edit and re-import, so nothing in it is
 * trusted, and one bad ring must not be able to blank a country.
 *
 * @returns {{borders: object, dropped: number}}
 */
export function sanitizeBorders(stored) {
  const borders = {};
  let dropped = 0;
  let total = 0;
  if (!isPlainObject(stored)) return { borders, dropped };

  for (const [countryKey, entry] of Object.entries(stored)) {
    if (typeof countryKey !== "string" || !countryKey || countryKey.length > MAX_COUNTRY_KEY_LENGTH) {
      dropped++;
      continue;
    }
    if (!isPlainObject(entry) || !isPlainObject(entry.rings)) {
      dropped++;
      continue;
    }

    const rings = {};
    for (const [key, ring] of Object.entries(entry.rings)) {
      if (!parseRingKey(key)) {
        dropped++;
        continue;
      }
      const clean = sanitizeRing(ring);
      // The total is checked before admitting rather than after, so a file that
      // is over the ceiling loses whichever rings come last rather than being
      // rejected whole -- the ones already applied still draw, and the panel's
      // size read-out shows why the rest did not.
      if (!clean || total + clean.length > MAX_TOTAL_POINTS) {
        dropped++;
        continue;
      }
      rings[key] = clean;
      total += clean.length;
    }

    if (!Object.keys(rings).length) continue;
    borders[countryKey] = {
      fp: typeof entry.fp === "string" ? entry.fp : null,
      rings,
    };
  }

  return { borders, dropped };
}

/**
 * One ring, quantized and closed, or null if it is not a usable ring.
 *
 * The length floor is 4 and it is load-bearing: buildCountryIndex and
 * representativePointOf both skip a ring shorter than that, so a degenerate one
 * would silently drop the country out of hit-testing *and* out of the geometry
 * the outage pins are placed from -- an unclickable country with no visible
 * cause.
 */
export function sanitizeRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > MAX_RING_POINTS) return null;

  const out = [];
  for (const point of ring) {
    if (!Array.isArray(point) || point.length < 2) return null;
    const lon = Number(point[0]);
    const lat = Number(point[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
    out.push([q(lon), q(lat)]);
  }

  // GeoJSON rings repeat their first coordinate as their last. A hand-written
  // one might not, and Leaflet would close it visually while the hit-test
  // ray-cast walked a different shape.
  const first = out[0];
  const last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out.length >= 4 ? out : null;
}
