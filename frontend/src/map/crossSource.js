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

// A curated military base against OpenStreetMap's own record of the same
// installation is the third pair, and it is the one place in this module where
// distance is NOT the signal. It gets its own mechanism below
// (buildDeclaredTwinIndex) and this is the measurement that forced it.
//
// The case is real: the curated list is English by construction ("Palmachim
// Airbase"), OSM carries `name`, which in Israel is the Hebrew string, and the
// collector drops `name:en` -- so one base arrived as two pins in two scripts, on
// two layers, with nothing matching them. Exactly what the header's note about
// local-script names describes.
//
// What is different is the neighbourhood. Airfields are sparse, so "nearest within
// 2 km" is the same installation. `military_area` is not sparse: OSM has 5,382 of
// them, because the tag means "a fenced military parcel", not "a base". Measured
// against the live sweep, nearest-neighbour picks the wrong record about half the
// time, and every wrong pick is a distinct place losing its pin:
//
//   Air Base 201 (Agadez)   nearest is "2eme Bataillon Génie Travaux" at 2.1 km;
//                           the actual twin, "Base Aérienne 201", is at 3.4 km
//   Novorossiysk Naval Base nearest is "КПП" -- a gate -- at 2.1 km; the twin,
//                           "Новороссийская военно-морская база", is at 4.0 km
//   Camp Humphreys          nearest is the KATUSA Training Academy at 1.5 km; the
//                           twin, "캠프 험프리스", is at 1.5 km too
//   JSDF Base Djibouti      nearest is France's BA 188 at 0.8 km, and the Japanese
//                           base has no `military_area` record at all -- so any
//                           radius at all produces a pair of two *different*
//                           countries' bases
//   Al Udeid Air Base       nearest is a barracks block named "A7", then A8, A9,
//                           B7 -- fourteen candidates inside 5 km, none of them
//                           the base
//
// No radius separates those from the eight genuine pairs, because the genuine ones
// run from 0.4 km to 4.2 km and straddle the impostors. Tightening the radius
// loses Palmachim (1.16 km), which is the pin this was built for.
//
// So the pairing is declared, not inferred: a curated entry names the OSM id it is
// the same place as (`osm_twin`, see backend/infrastructure.py's MILITARY_BASES).
// The radius below is only a sanity bound on a declared id -- a way that gets
// redrawn keeps its id, but a mistyped one should not merge two continents.
export const MILITARY_TWIN_MAX_KM = 8;

// A curated base against the OurAirports record for the same field, and a curated
// port against the NGA World Port Index record for the same harbour. Declared, for
// the same reason the military pairing is -- and here the reason is sharper, because
// the near misses are the *majority* of what distance finds.
//
// Measured against the live feeds, 28 curated sites have a name-corroborated
// OurAirports record within 3km. Six of them are not the same place at all: an LNG
// plant beside the town's airstrip (Angola LNG and Soyo Airport, 230m), an oil
// terminal beside an international airport (Fujairah, 1.2km), a refinery beside the
// regional field (Zinder, 2.4km), and the Japanese base in Djibouti, whose nearest
// airfield is the civil airport it sits next to. Sharing a place-name at 200m is
// exactly what a plant and the airstrip built to serve it look like.
//
// The ports side is worse. Two different curated entries -- Novorossiysk Naval Base
// and Novorossiysk Oil Terminal -- corroborate the *same* NGA record, so an inferred
// merge picks whichever is iterated first and the naval base ends up claiming the
// commercial port. And a refinery beside a harbour (Tuapse, Mina Al Ahmadi) shares
// its town's name with the harbour while being a different facility.
//
// So both are declared: `airport_twin` carries an OurAirports ident, `port_twin` an
// NGA World Port Index id. See backend/infrastructure.py for the entries and for the
// line drawn between "this entry is that airfield" and "this entry is near it".
export const AIRPORT_TWIN_MAX_KM = 4;
export const PORT_TWIN_MAX_KM = 4;

// OurAirports records that say, in their own `name`, that they are a duplicate:
// "[Duplicate] Jauá Airport", "(Duplicate) Utai Airstrip", "Sayma (duplicate)".
// Twenty of them in the current feed, and they are the one class of duplicate that
// needs no curation and no distance guesswork about *whether* it is one -- the
// publisher has already said so.
//
// Distance is still needed for *which* record it duplicates, and it is what keeps
// this safe: six of the twenty have no unmarked neighbour nearby at all, and
// suppressing those would take a field off the map rather than deduplicate it.
const SELF_DECLARED_DUPLICATE = /[[(]\s*(?:misplaced\s+)?duplicate\s*\??\s*[)\]]|\(\s*duplicate\s*\)/i;

// 500m. These are the same field entered twice, not two fields: measured, 12 of the
// 14 pairs are under 300m and the widest is 390m.
export const SELF_DUPLICATE_MAX_KM = 0.5;

/** Does a record's own name say it is a duplicate of another record? */
export function saysItIsADuplicate(name) {
  return SELF_DECLARED_DUPLICATE.test(String(name || ""));
}

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

/**
 * Pair up two feeds where one of them names its counterpart outright.
 *
 * Same contract as buildTwinIndex -- `{ twinOf, absorbed }`, same shapes, so a
 * caller can swap one for the other -- and the same promise that nothing is
 * deleted. The difference is only how a pair is established: here the primary
 * record carries the secondary's id, so there is no radius to tune and no
 * nearest-neighbour to be wrong about.
 *
 * Used for curated military bases against OpenStreetMap's military areas, where
 * inference does not work; see MILITARY_TWIN_MAX_KM above for the measurement.
 *
 * A declared id that matches no record in `secondary` is not an error and not
 * logged: the OSM sweep is per-theatre and viewport-filtered, so most of the time
 * the named record simply is not in this payload. The pin then draws as it always
 * did, unmerged, which is the honest fallback.
 *
 * @param {Array<object>} primary    the feed whose pin survives, and which declares
 * @param {Array<object>} secondary  the feed whose pin is absorbed
 * @param {object} options
 * @param {(record: object) => string|undefined} options.declaredId  the secondary id
 *   this primary record claims to be the same place as
 * @param {number} options.maxKm  sanity bound: a declared pair further apart than
 *   this is treated as a typo and refused, because merging two places that are not
 *   near each other is worse than drawing one twice
 */
export function buildDeclaredTwinIndex(primary, secondary, {
  declaredId, primaryId, secondaryId, maxKm,
}) {
  const bySecondaryId = new Map();
  for (const record of secondary || []) {
    const id = secondaryId(record);
    if (id != null) bySecondaryId.set(String(id), record);
  }
  const twinOf = new Map();
  const absorbed = new Map();
  for (const record of primary || []) {
    const key = primaryId(record);
    const wanted = declaredId(record);
    if (key == null || !wanted) continue;
    const match = bySecondaryId.get(String(wanted));
    if (!match) continue;
    const here = coordsOf(record);
    const there = coordsOf(match);
    if (!here || !there) continue;
    const distance = distanceKm(here[0], here[1], there[0], there[1]);
    if (distance > maxKm) continue;
    // First declaration wins if two curated entries name one OSM record. That is
    // a curation mistake rather than a data condition, and the alternative --
    // absorbing it twice -- would let the second claim overwrite the first
    // silently.
    if (absorbed.has(String(wanted))) continue;
    twinOf.set(String(key), { record: match, distanceKm: distance });
    absorbed.set(String(wanted), { primaryKey: String(key), distanceKm: distance });
  }
  return { twinOf, absorbed };
}

/**
 * Records a feed has itself labelled as duplicates of another record in the feed.
 *
 * Returns the same `absorbed` shape as the two index builders, so a caller folds it
 * into the same map and the same "is the absorbing layer actually drawing" check --
 * except that here the absorbing layer is the same layer, so `primaryKey` is the
 * sibling record's id and the entry is unconditional.
 *
 * A marked record with no unmarked neighbour inside `radiusKm` is left alone. That
 * is not defensiveness: six of the twenty marked records in the current OurAirports
 * feed are in that state, and suppressing them would remove a field from the map on
 * the strength of a label whose counterpart is not there.
 *
 * @param {Array<object>} records
 * @param {object} options
 * @param {number} options.radiusKm
 * @param {(record: object) => string|number|undefined} options.id
 * @param {(record: object) => string|undefined} options.name
 */
export function selfDeclaredDuplicates(records, { radiusKm, id, name }) {
  const absorbed = new Map();
  const marked = [];
  const clean = [];
  for (const record of records || []) {
    if (!coordsOf(record)) continue;
    (saysItIsADuplicate(name(record)) ? marked : clean).push(record);
  }
  if (!marked.length) return { absorbed };
  const bandDegrees = radiusKm / EARTH_KM_PER_DEGREE;
  const bands = bandIndex(clean, bandDegrees);
  for (const record of marked) {
    const key = id(record);
    if (key == null) continue;
    const [lat, lon] = coordsOf(record);
    const band = Math.floor(lat / bandDegrees);
    let nearest = null;
    for (let b = band - 1; b <= band + 1; b++) {
      for (const [otherCoords, other] of bands.get(b) || []) {
        const distance = distanceKm(lat, lon, otherCoords[0], otherCoords[1]);
        if (distance > radiusKm) continue;
        if (!nearest || distance < nearest.distance) nearest = { distance, other };
      }
    }
    if (!nearest) continue;
    const primaryKey = id(nearest.other);
    if (primaryKey == null) continue;
    absorbed.set(String(key), {
      primaryKey: String(primaryKey), distanceKm: nearest.distance, selfDeclared: true,
    });
  }
  return { absorbed };
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
