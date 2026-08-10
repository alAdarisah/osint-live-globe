// Pure logic behind SquawkAlertStrip.jsx (Task 33) -- split into a plain
// module for the same reason airfieldPanelLogic.js/intelPanelLogic.js are:
// the strip itself is JSX, and this project's headless test suite
// (`node --test`, no build step) cannot import JSX at all -- see
// frontend/tests/squawkAlerts.test.js.
//
// Unlike those two siblings, this one does import something: the emergency
// wording lives in map/decorators.js (aircraftFlag, squawkEmergencyMeaning,
// aircraftEmergencyLine, AIRCRAFT_FLAG_NOTE), and the task brief is explicit
// that this strip must reuse those exact strings rather than compose new
// ones that say the same thing slightly differently -- 7500 is far more
// often a mis-set transponder than a hijacking, and every place this map
// says so has to say it identically. decorators.js only needs `window.L` for
// the parts this file never calls (divIcon/geoJSON), so the test stubs it
// the same way frontend/tests/adsbCard.test.js already does.
import { aircraftFlag } from "../map/decorators.js";

/**
 * A stable identity for "the thing currently being squawked", combining the
 * transponder code and readsb's own independent `emergency` field
 * (backend/sources/adsb.py's two signals -- see decorators.js's
 * aircraftEmergencyLine). Keyed by icao24 rather than by squawk value in
 * trackEmergencySquawks below, because "this airframe went quiet then
 * squawked again" and "this airframe kept broadcasting the whole time" are
 * different events -- the first is worth flagging as new, the second is not.
 * A change in *either* half of the signature counts as a fresh event: an
 * airframe that stops squawking 7700 but keeps reporting "general emergency"
 * on the transponder has not actually recovered.
 */
function squawkSignature(item) {
  return `${item?.squawk ?? ""}::${item?.emergency ?? ""}`;
}

/**
 * Folds a fresh ADS-B snapshot into the running "who is currently squawking
 * an emergency code, and since when" record.
 *
 * `prevTracked` and the return value are both {icao24: {icao24, signature,
 * firstSeenMs, aircraft}}. `aircraft` is the latest full snapshot (raw
 * records, not pre-filtered -- this filters for itself via aircraftFlag, so
 * a caller that hands it the whole ADS-B feed by mistake still gets the
 * right answer rather than an alert for every airliner in the sky).
 *
 * An entry's `firstSeenMs` only carries forward when its signature is
 * unchanged from the previous snapshot; a new icao24 or a changed signature
 * (7500 clears, then the same airframe squawks 7700 -- or vice versa) starts
 * the clock over at `nowMs`. An icao24 that has stopped squawking entirely
 * (dropped from `aircraft`, or no longer flagged) is dropped from the
 * result -- there is nothing left to time.
 */
export function trackEmergencySquawks(prevTracked, aircraft, nowMs) {
  const prev = prevTracked || {};
  const next = {};
  for (const item of Array.isArray(aircraft) ? aircraft : []) {
    if (!item || !item.icao24 || aircraftFlag(item) !== "emergency") continue;
    const signature = squawkSignature(item);
    const prior = prev[item.icao24];
    const firstSeenMs = prior && prior.signature === signature ? prior.firstSeenMs : nowMs;
    next[item.icao24] = { icao24: item.icao24, signature, firstSeenMs, aircraft: item };
  }
  return next;
}

/** Dismissing an entry hides it only for the squawk it was dismissed at --
 *  the brief's own requirement that a squawk change re-alerts. Recorded as
 *  {icao24: signature} rather than a plain set of icao24s for exactly that
 *  reason: `isDismissed`/`visibleAlerts` below compare the *current*
 *  signature against this stored one, so a later change stops matching on
 *  its own with no separate "clear the dismissal" step. */
export function dismissAlert(dismissed, icao24, signature) {
  return { ...(dismissed || {}), [icao24]: signature };
}

function isDismissed(dismissed, entry) {
  return !!dismissed && dismissed[entry.icao24] === entry.signature;
}

/**
 * The entries the strip should actually render: every tracked alert not
 * currently dismissed, newest-first (a reader watching a live strip wants to
 * see what just started, not have it appear wherever alphabetical or
 * distance order happened to put it).
 */
export function visibleAlerts(tracked, dismissed) {
  return Object.values(tracked || {})
    .filter((entry) => !isDismissed(dismissed, entry))
    .sort((a, b) => b.firstSeenMs - a.firstSeenMs);
}

/**
 * "How long it has been squawking", from a duration in seconds -- deliberately
 * coarse (whole minutes once past the first minute, whole hours once past the
 * first day) because the point is "this has been going on a while", not a
 * live stopwatch reading a reader would expect to tick every second.
 */
export function formatSquawkDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "just now";
  if (seconds < 60) return "<1m";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}
