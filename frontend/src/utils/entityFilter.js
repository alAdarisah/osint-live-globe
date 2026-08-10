// The vessel and aircraft filter bars (Task 18).
//
// Both layers already render through the WebGL layer, not DOM markers --
// webglLayer.js's updateEntities(bucketKey, items, opts) just takes an item
// list, so "filtering" here means handing it a shorter list. Nothing in this
// module touches the map; createMapController.js calls filterVessels/
// filterAircraft on the arrays it was already about to draw, before they
// reach updateEntities.
//
// Authority note -- read alongside backend/app.py's /api/ships `callsign`
// parameter, which is the other half of this. That parameter exists for a
// caller fetching the whole global feed and wanting the server to do the
// narrowing before it hits the wire; it is a *different*, coarser match
// (callsign only) than the one this module applies (callsign, name, mmsi,
// imo). This module is what decides what a reader sees and what the
// "N / total" count next to each filter bar reads -- this map's own fetch
// (useOsintData.js's POLL_CONFIG entry for "ais") never sends `callsign=`,
// specifically so there is never a second, narrower filter already applied
// to the feed by the time this one runs. Task 12 spent two review rounds on
// exactly that failure mode for the conflict-event filters (a control that
// could silently disagree with another copy of its own state); this module
// stays the only place the choice is made rather than repeating the bug.
//
// Every function here is a pure read of its arguments -- filterVessels and
// filterAircraft return a new array via Array.prototype.filter, which never
// mutates the array it is called on, and neither function writes to the
// items themselves.

/** The filter bar's shape when nothing has been typed or toggled. */
export const DEFAULT_VESSEL_FILTER = {
  text: "",
  sanctionedOnly: false,
  watchlistedOnly: false,
};

export const DEFAULT_AIRCRAFT_FILTER = {
  text: "",
  militaryOnly: false,
};

// The brief's own field lists, in the order it gives them.
const VESSEL_TEXT_FIELDS = ["callsign", "name", "mmsi", "imo"];
const AIRCRAFT_TEXT_FIELDS = ["callsign", "registration", "icao24", "operator", "type_code", "squawk"];

/**
 * One field's value against a query: case-insensitive, `*` as a wildcard,
 * and implicit prefix matching when the query carries no wildcard at all.
 *
 * "Implicit prefix" rather than "implicit substring" is deliberate. A ship or
 * aircraft feed runs to tens of thousands of rows, and scanning every field
 * of every row for a substring on each keystroke is the kind of thing that is
 * free in a unit test and a stutter in the browser. A reader who wants a
 * substring search can ask for one explicitly with a leading `*`.
 *
 * An empty (or all-whitespace) query matches everything, including a row
 * whose field is null -- "no query" is not a query about that field at all.
 * A non-empty query against a null/undefined field never matches: there is
 * nothing there to have a prefix.
 */
export function matchQuery(value, query) {
  const needle = (query ?? "").trim().toUpperCase();
  if (!needle) return true;
  if (value === null || value === undefined) return false;
  const haystack = String(value).toUpperCase();
  if (!needle.includes("*")) return haystack.startsWith(needle);
  // Escape every regex metacharacter except the `*` this function itself
  // treats specially, so a query like "5B.01" is matched literally and not
  // read as "5B, any character, 01".
  const escaped = needle.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(haystack);
}

function matchesAnyField(item, fields, query) {
  const needle = (query ?? "").trim();
  if (!needle) return true;
  return fields.some((field) => matchQuery(item?.[field], needle));
}

/**
 * True if `item` (a ship from /api/ships) passes `filter`. sanctionedOnly and
 * watchlistedOnly read the same two fields the map already draws a ring/tag
 * from (see isSanctioned in map/decorators.js and the `watchlist` field
 * backend/sources/ais.py attaches) -- present/absent, not re-derived.
 */
export function matchesVesselFilter(item, filter = DEFAULT_VESSEL_FILTER) {
  if (filter.sanctionedOnly && !item?.sanctions) return false;
  if (filter.watchlistedOnly && !item?.watchlist) return false;
  return matchesAnyField(item, VESSEL_TEXT_FIELDS, filter.text);
}

/**
 * True if `item` (an aircraft from /api/aircraft) passes `filter`.
 * militaryOnly checks the same two fields map/decorators.js's
 * classifyAircraft does (`military` and `callsign_military`) -- not a call
 * to that function itself, since decorators.js pulls in leafletGlobal.js at
 * import time (it reads window.L), which would stop this module loading
 * under node --test the way mmsi.js and this file otherwise both can.
 */
export function matchesAircraftFilter(item, filter = DEFAULT_AIRCRAFT_FILTER) {
  if (filter.militaryOnly && !(item?.military || item?.callsign_military)) return false;
  return matchesAnyField(item, AIRCRAFT_TEXT_FIELDS, filter.text);
}

/** A new array of the ships that pass `filter`. `items` is never modified. */
export function filterVessels(items, filter = DEFAULT_VESSEL_FILTER) {
  return items.filter((item) => matchesVesselFilter(item, filter));
}

/** A new array of the aircraft that pass `filter`. `items` is never modified. */
export function filterAircraft(items, filter = DEFAULT_AIRCRAFT_FILTER) {
  return items.filter((item) => matchesAircraftFilter(item, filter));
}
