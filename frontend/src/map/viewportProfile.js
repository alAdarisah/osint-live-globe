// What the camera is looking at.
//
// One question, answered as data: is this view mostly ocean or mostly land,
// which countries fill it, and is any of them at war. map/scene.js turns those
// answers into promotions and demotions -- an ocean view brings the maritime
// layers a band earlier and pushes the ground layers a band later; a view over
// an active war brings the conflict layers earlier. This module decides
// nothing about layers itself, and should not: keeping the observation separate
// from the policy is what makes either one readable.
//
// Two things it must never influence, both enforced in scene.js rather than
// here but worth knowing while reading this file:
//
//   * icon detail. The profile changes on every pan; an icon's appearance is
//     compiled into the string updateMarker diffs, so a profile-dependent icon
//     would rebuild every marker's DOM continuously.
//   * a corroborating layer's disposition. Promotion moves a band, never a
//     disposition -- otherwise a camera position becomes the reader's act of
//     choosing to look at an inference, which is exactly what that mechanism
//     exists to prevent.

import { findCountryAt } from "./countryHitTest";
import { bandFor } from "./scene";

// 7 across, 5 down, on the viewport the reader can actually see rather than the
// padded bounds the renderers filter against. 35 samples is the smallest grid
// that reliably tells "a coastline is in view" from "this is open ocean" at
// theatre zoom, and small enough that the whole pass is a fraction of a
// millisecond even before the memo below takes it to zero.
const COLS = 7;
const ROWS = 5;

// A dead band, not a threshold, and this is the difference between a stable map
// and a twitching one. A camera parked on a coastline sits near whatever single
// number you pick, so land fraction wobbles across it on alternate pans -- and
// each crossing promotes or demotes seven layers, which means adding and
// removing seven Leaflet layer groups every time the reader nudges the map.
// Entering maritime takes a clearly empty view; leaving it takes a clearly
// occupied one; in between, whatever was true stays true.
const MARITIME_ENTER_BELOW = 0.20;
const MARITIME_LEAVE_ABOVE = 0.30;

// How coarsely the memo key rounds the viewport centre, per band. Deliberately
// the same idea as the wind endpoint's snapped bbox cache key on the backend:
// ordinary panning stays inside one cell and re-profiles zero times, and the
// cell shrinks as the reader goes deeper and the question gets more local.
const SNAP_DEGREES = { WORLD: 8, THEATRE: 8, COUNTRY: 4, LOCAL: 2, SITE: 2 };

const NULL_PROFILE = {
  landFraction: null,
  isMaritime: false,
  dominantCountries: [],
  hotCountries: [],
};

/**
 * @param {object} options
 * @param {Array} options.countryIndex  buildCountryIndex's output, smallest
 *   country first. Empty until /api/countries lands.
 * @param {object} options.bounds       {south, west, north, east} of the visible
 *   viewport, unpadded.
 * @param {number} options.zoom
 * @param {Set<string>} options.hotCountryKeys  countries currently flagged as an
 *   active war, by the same thresholds updateCountryWarFlare uses -- passed in
 *   rather than recomputed, so there is exactly one definition of "at war".
 * @param {object|null} options.previous  the last profile this function
 *   returned, for the hysteresis and the memo.
 * @returns {{landFraction:number|null, isMaritime:boolean,
 *            dominantCountries:string[], hotCountries:string[], key:string}}
 */
export function profileViewport({ countryIndex, bounds, zoom, hotCountryKeys, previous }) {
  // Before the boundaries land there is nothing to hit-test against, and a
  // profile of "no land anywhere" would be a lie that reads as open ocean. Null
  // means "apply no promotion and no demotion" -- a beat of the shipped
  // arrangement is better than layers appearing seconds after boot for a reason
  // the reader cannot see.
  if (!countryIndex?.length || !bounds) return { ...NULL_PROFILE, key: "none" };

  const band = bandFor(zoom);
  const key = memoKey(bounds, band);
  if (previous && previous.key === key) return previous;

  let land = 0;
  const counts = new Map();
  const latSpan = bounds.north - bounds.south;
  const lonSpan = normalizedLonSpan(bounds);

  for (let row = 0; row < ROWS; row++) {
    // Sampled at cell centres rather than at the edges, so a viewport whose
    // border runs exactly along a coastline does not have half its samples
    // land on the line itself.
    const lat = bounds.south + (latSpan * (row + 0.5)) / ROWS;
    for (let col = 0; col < COLS; col++) {
      const lon = bounds.west + (lonSpan * (col + 0.5)) / COLS;
      const entry = findCountryAt(countryIndex, lat, lon);
      if (!entry) continue;
      land += 1;
      counts.set(entry.key, (counts.get(entry.key) || 0) + 1);
    }
  }

  const landFraction = land / (COLS * ROWS);
  const dominantCountries = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([countryKey]) => countryKey);

  return {
    key,
    landFraction,
    isMaritime: stickyMaritime(landFraction, previous?.isMaritime),
    dominantCountries,
    hotCountries: hotCountryKeys
      ? dominantCountries.filter((countryKey) => hotCountryKeys.has(countryKey))
      : [],
  };
}

/** See MARITIME_ENTER_BELOW / MARITIME_LEAVE_ABOVE. */
function stickyMaritime(landFraction, wasMaritime) {
  if (landFraction < MARITIME_ENTER_BELOW) return true;
  if (landFraction > MARITIME_LEAVE_ABOVE) return false;
  return !!wasMaritime;
}

function memoKey(bounds, band) {
  const snap = SNAP_DEGREES[band] ?? 8;
  const lat = (bounds.south + bounds.north) / 2;
  const lon = (bounds.west + bounds.east) / 2;
  return `${band}:${Math.round(lat / snap)}:${Math.round(lon / snap)}`;
}

/**
 * The viewport's longitude span, in degrees, without the antimeridian wrap.
 *
 * Leaflet's `worldCopyJump` means west can legitimately exceed east, and it
 * also means an unwrapped bounds can span more than 360 degrees when the reader
 * is zoomed all the way out. Clamping matters because the span is divided into
 * sample columns: an un-normalised value would space the samples across several
 * copies of the world and count the same landmass repeatedly.
 */
function normalizedLonSpan(bounds) {
  const raw = bounds.east - bounds.west;
  if (raw <= 0) return raw + 360;
  return Math.min(raw, 360);
}
