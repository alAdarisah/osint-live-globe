// One real thing, reported by two publishers, drawn as two pins.
//
// This is a different problem from the two that already have modules, and
// confusing it with either is how it stayed on the map:
//
//   declutter   two *different* things whose icons overlap -> move them apart
//   collapse    many *different* items in one place -> one head, all listed
//   crossSource one *same* thing in two feeds -> one pin, both provenances
//
// Nothing here deletes a record. The absorbed record is named on the surviving
// pin -- its publisher, its own name for the place, and whatever it knows that
// the survivor does not -- and it stays in its feed for the panels, the country
// card and the admin data editor, all of which read unfiltered. The map draws
// one marker; the reader still gets told two sources agree.
//
// Which of the two survives is a judgement about the sources, made once here
// rather than per layer:
//
//   airfields   OurAirports wins over OpenStreetMap's military=airfield. It
//               carries the ICAO/IATA/ident that the ADS-B proximity index and
//               the recorded-traffic layer both join on, so the OSM pin is the
//               one with nothing hanging off it.
//   dams        Global Dam Watch wins over OSM's hydro power_plant. GDW is a
//               reviewed register with capacity, height and river; the OSM node
//               is the powerhouse at the same barrier, and its one unique field
//               (output_mw) moves to the surviving popup.
//
// Matching is by distance alone, deliberately. Names were tried first and are
// useless here: only 81 of the 320 airfield pairs share a name at all, because
// OSM records the local-script name (پایگاه هوایی درراهی, 목포공항, 白山水电站)
// while OurAirports and GDW record the romanised one. Distance is the honest
// signal -- and two *distinct* military airfields within two kilometres of each
// other do not exist, while one airfield recorded twice, half a kilometre
// apart, is the norm (159 of 320 pairs are under 250 m).

// Radii, in kilometres.
//
// An airbase is a kilometres-wide site and neither publisher claims to place it
// precisely: OurAirports records a runway reference point, OSM the computed
// centre of a drawn area, and the gap between them runs to 1.8 km in the
// current data. Two is above the whole observed tail. It is safe to be this
// generous because of what a false match costs here -- one pin instead of two,
// with both names on it -- and because only 5 of 418 OSM airfields have more
// than one OurAirports candidate within it at all.
export const AIRFIELD_MATCH_KM = 2;

// Tighter, because the thing being matched is smaller and the feeds are denser.
// The powerhouse sits at the dam; measured, 54 of the 159 pairs are under 200 m
// and the tail stops at a kilometre.
export const DAM_MATCH_KM = 1;

const EARTH_KM_PER_DEGREE = 111.32;

/** Equirectangular, which is exact enough under a few kilometres. */
export function distanceKm(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * EARTH_KM_PER_DEGREE;
  const meanLat = ((aLat + bLat) / 2) * (Math.PI / 180);
  const dLon = (bLon - aLon) * EARTH_KM_PER_DEGREE * Math.cos(meanLat);
  return Math.hypot(dLat, dLon);
}

function coordsOf(record) {
  const lat = Number(record?.lat);
  const lon = Number(record?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
}

/**
 * Latitude-band index over the larger feed.
 *
 * Bands rather than square cells on purpose. A lon/lat grid has to widen its
 * search near the poles -- a degree of longitude is 111 km at the equator and
 * 38 km at 70N, so a fixed-degree cell that spans 2 km of longitude in Kenya
 * spans 700 m in Norway and quietly stops finding matches there. A band is
 * indexed on latitude only, where a degree is a degree everywhere, and the
 * longitude question is settled by the exact distance check instead. The cost
 * is scanning a whole band: with 48,000 airfields over 180 degrees of latitude
 * that is single digits per band.
 */
function bandIndex(records, bandDegrees) {
  const bands = new Map();
  for (const record of records) {
    const coords = coordsOf(record);
    if (!coords) continue;
    const band = Math.floor(coords[0] / bandDegrees);
    const bucket = bands.get(band);
    if (bucket) bucket.push([coords, record]);
    else bands.set(band, [[coords, record]]);
  }
  return bands;
}

/**
 * Pair up two feeds that describe some of the same places.
 *
 * @param {Array<object>} primary    the feed whose pin survives
 * @param {Array<object>} secondary  the feed whose pin is absorbed
 * @param {object} options
 * @param {number} options.radiusKm
 * @param {(record: object) => string|number|undefined} options.primaryId
 * @param {(record: object) => string|number|undefined} options.secondaryId
 * @returns {{ twinOf: Map<string, {record: object, distanceKm: number}>,
 *             absorbed: Map<string, {primaryKey: string, distanceKm: number}> }}
 *   `twinOf` maps a surviving pin's id to what it absorbed, for its popup --
 *   with the distance, because two sources placing one airbase 400 m apart is
 *   a fact about the sources that the reader is entitled to. `absorbed` maps a
 *   suppressed pin's id back to the pin that took it.
 */
export function buildTwinIndex(primary, secondary, { radiusKm, primaryId, secondaryId }) {
  const bandDegrees = radiusKm / EARTH_KM_PER_DEGREE;
  const bands = bandIndex(primary || [], bandDegrees);
  // Nearest primary per secondary, then nearest secondary per primary. Both
  // directions are needed, and only the second is obvious: without the first,
  // an OSM airfield sitting between two OurAirports entries would be absorbed
  // by whichever happened to be iterated first.
  const best = new Map(); // primary id -> { distance, primary, secondary, secondaryId }
  for (const record of secondary || []) {
    const coords = coordsOf(record);
    const id = secondaryId(record);
    if (!coords || id == null) continue;
    const band = Math.floor(coords[0] / bandDegrees);
    let nearest = null;
    for (let b = band - 1; b <= band + 1; b++) {
      for (const [otherCoords, other] of bands.get(b) || []) {
        const distance = distanceKm(coords[0], coords[1], otherCoords[0], otherCoords[1]);
        if (distance > radiusKm) continue;
        if (!nearest || distance < nearest.distance) nearest = { distance, primary: other };
      }
    }
    if (!nearest) continue;
    const key = primaryId(nearest.primary);
    if (key == null) continue;
    const held = best.get(key);
    if (!held || nearest.distance < held.distance) {
      best.set(key, { distance: nearest.distance, secondary: record, secondaryId: id });
    }
  }
  // A primary keeps one twin, and only that twin is suppressed. Two OSM
  // airfields matching one OurAirports entry is the case this protects: the
  // runner-up keeps its own pin, because absorbing it would leave a record
  // named on no pin at all -- which is the thing this module exists not to do.
  const twinOf = new Map();
  const absorbed = new Map();
  for (const [key, entry] of best) {
    twinOf.set(String(key), { record: entry.secondary, distanceKm: entry.distance });
    absorbed.set(String(entry.secondaryId), { primaryKey: String(key), distanceKm: entry.distance });
  }
  return { twinOf, absorbed };
}

// Query parameters that identify a referrer rather than an article. Stripped
// so the same story shared through two feeds compares equal; everything else is
// kept, because a CMS serving articles as ?id=1234 is still common enough that
// dropping the whole query string would merge unrelated pages.
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_[ce]id$|igshid$|ref$|ref_src$|s?ref$|cmpid$|smid$)/i;

/**
 * An article URL reduced to what identifies the article.
 *
 * Returns "" for anything unparseable, and a caller must treat "" as "no
 * match" rather than as a key -- otherwise every URL-less record collides with
 * every other one.
 */
export function normalizeArticleUrl(url) {
  if (typeof url !== "string" || !url.trim()) return "";
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return "";
  }
  if (!/^https?:$/.test(parsed.protocol)) return "";
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.replace(/\/+$/, "");
  const params = [...parsed.searchParams.entries()]
    .filter(([name]) => !TRACKING_PARAMS.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  return `${host}${path}${params ? `?${params}` : ""}`;
}

/**
 * Every article already drawn by some other layer.
 *
 * The id half of this predates it and is not enough on its own: GDELT emits one
 * event row per actor pair, so a single article arrives as several event ids.
 * The Officials record absorbs the id it was built from and names that one --
 * and the News layer then draws a sibling id, from the same URL, as a second
 * pin with the identical headline. Measured against the live feeds: 24 news
 * pins suppressed by id, 21 more duplicates left behind that only the URL
 * catches.
 *
 * @param {Array<Array<object>>} sources  raw arrays that may absorb an article
 * @returns {{ ids: Set<string>, urls: Set<string> }}
 */
export function buildAbsorbedArticles(sources) {
  const ids = new Set();
  const urls = new Set();
  for (const source of sources || []) {
    for (const record of source || []) {
      for (const id of record.coverage_event_ids || []) ids.add(id);
      // `url` on an Officials record, `source_url` on a fused conflict event.
      const normalized = normalizeArticleUrl(record.url || record.source_url);
      if (normalized) urls.add(normalized);
    }
  }
  return { ids, urls };
}
