// Pure logic behind SquawkAlertStrip.jsx (Task 33) -- split into a plain
// module for the same reason airfieldPanelLogic.js/intelPanelLogic.js are:
// the strip itself is JSX, and this project's headless test suite
// (`node --test`, no build step) cannot import JSX at all -- see
// frontend/tests/squawkAlerts.test.js.
//
// Unlike those two siblings, this one does import something: the emergency
// wording lives in map/decorators.js (aircraftFlag, aircraftEmergencyLine,
// AIRCRAFT_FLAG_NOTE), and the task brief is explicit that this strip must
// reuse those exact strings rather than compose new ones that say the same
// thing slightly differently -- 7500 is far more often a mis-set transponder
// than a hijacking, and every place this map says so has to say it
// identically. decorators.js only needs `window.L` for the parts this file
// never calls (divIcon/geoJSON), so the test stubs it the same way
// frontend/tests/adsbCard.test.js already does.
import { aircraftFlag, aircraftEmergencyLine, AIRCRAFT_FLAG_NOTE } from "../map/decorators.js";

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

/** The strip's own label for an entry: callsign, falling back to
 *  registration, falling back to the one thing every record always has. */
export function alertLabel(entry) {
  const d = entry.aircraft;
  return d.callsign || d.registration || d.icao24;
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
 * result -- there is nothing left to time. Dropping it here is also half of
 * the fix for the "dismissed, cleared, then squawked again" case: see
 * pruneDismissed below for the other half.
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
 *  signature against this stored one, so a change to a *different* signature
 *  while still tracked stops matching on its own, no separate "clear the
 *  dismissal" step needed.
 *
 *  That comparison is not enough on its own, though: it only ever sees one
 *  signature at a time, so it cannot tell "this airframe has been squawking
 *  7500 continuously" from "this airframe squawked 7500, cleared, and is now
 *  squawking 7500 again" -- and the second case is exactly what an
 *  accidentally-set 7500 looks like, which the brief requires to re-alert.
 *  See pruneDismissed below for the fix: the dismissal record itself is
 *  dropped the moment the airframe leaves `tracked`, so a later return can
 *  never match a dismissal from the episode before it, identical signature
 *  or not. */
export function dismissAlert(dismissed, icao24, signature) {
  return { ...(dismissed || {}), [icao24]: signature };
}

/**
 * Drops any dismissal whose airframe is no longer in `tracked` -- the
 * tracking episode it was recorded against has ended. Call this every time
 * `tracked` is recomputed (see SquawkAlertStrip.jsx), with the *new*
 * `tracked`, so a dismissal never outlives the episode it belongs to.
 *
 * This is the fix for the case dismissAlert's own comment describes: without
 * it, an airframe that clears its squawk and later squawks the identical
 * code again would still match `dismissed[icao24] === signature` and stay
 * silently suppressed, even though a new, unrelated event just happened.
 */
export function pruneDismissed(dismissed, tracked) {
  if (!dismissed) return {};
  const next = {};
  for (const icao24 of Object.keys(dismissed)) {
    if (tracked && tracked[icao24]) next[icao24] = dismissed[icao24];
  }
  return next;
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

// ---------- screen-reader announcement ----------
//
// The visible strip states the caveat once, in its header (see
// SquawkAlertStrip.jsx's own module note) -- correct for a sighted reader,
// who sees the header and every row together. A live region does not offer
// that: several screen readers announce only the node that was actually
// inserted, so a row that prints just its own squawk-meaning text can be
// heard as "unlawful interference (hijack)" with the caveat, sitting in a
// sibling the reader never visits, never spoken at all. squawkAnnouncement
// builds one self-contained sentence per fresh alert instead -- caveat
// included, every time -- for a dedicated, always-mounted aria-live region
// that is entirely separate from the visible strip's own markup.

/** Reverses esc() (utils/format.js) plus the one HTML entity
 *  aircraftEmergencyLine/AIRCRAFT_FLAG_NOTE add themselves (&mdash;) -- both
 *  strings are built for innerHTML, and a speech announcement wants the
 *  plain text those entities stand for, not the markup. */
function unescapeHtml(s) {
  return String(s ?? "")
    .replace(/&mdash;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** One self-contained sentence for a single fresh alert: who, what it is
 *  squawking (aircraftEmergencyLine's own text -- decorators.js is the one
 *  place that sentence is composed), and AIRCRAFT_FLAG_NOTE.emergency's
 *  caveat, unabridged. */
export function squawkAnnouncement(entry) {
  const meaning = unescapeHtml(aircraftEmergencyLine(entry.aircraft));
  const caveat = unescapeHtml(AIRCRAFT_FLAG_NOTE.emergency);
  return `Emergency squawk alert for ${alertLabel(entry)}: ${meaning}. ${caveat}`;
}

/** The dismiss button's own accessible name -- a full explanatory sentence,
 *  not just "Dismiss", because the caveat this whole module exists to keep
 *  attached (squawks are often mis-set, not confirmed incidents) belongs in
 *  the accessible name itself: a screen-reader user tabbing straight to the
 *  dismiss button may never visit the header it would otherwise only live
 *  in. See the review note in SquawkAlertStrip.jsx's own module comment. */
export function dismissAlertLabel(label) {
  return `Dismiss the emergency squawk alert for ${label} — squawks are occasionally set by mistake, not a confirmed incident`;
}
