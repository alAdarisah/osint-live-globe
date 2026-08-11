// Pure logic behind CableOutagePanel.jsx -- reading GET /api/cable-outage-risk's
// own document (backend/refine/cable_outage.py's build_document) into rows a
// panel can render. Plain JS, no JSX and no window/Leaflet dependency, for
// the same reason infraRiskPanelLogic.js and chokepointPanelLogic.js are:
// this project's headless test suite (`node --test`, no build step) cannot
// import JSX at all -- see frontend/tests/cableOutagePanel.test.js.
//
// **This is a coincidence, not a cause.** CableOutagePanel.jsx renders the
// document's own `note` field verbatim for that caveat, the same
// "one home for the sentence" discipline InfraRiskPanel.jsx already follows
// for its own proximity-vs-causation note -- so the panel and the raw JSON
// can never say two different things.
//
// Task 38 review (Important 1): every other sentence the panel renders used
// to be inline JSX template literals, which this project's own test suite
// cannot import or assert against -- "today's strings are clean" is not a
// safety net. Every string the panel composes (as opposed to rendering
// verbatim from the backend, like `note`, or displaying source data
// verbatim, like a landing's own name or an event's own type) now lives here
// as a named function, so frontend/tests/cableOutagePanel.test.js can call
// each one directly and check it against the banned-phrase list the same way
// backend/tests/test_cable_outage.py checks NOTE.
import { fmtNumber } from "../utils/format";

/**
 * The document's own ranked `coincidences` array, or [] before a pass has
 * landed -- the same "never absent, just possibly empty" contract every
 * other refine-derived doc reader in this codebase follows.
 */
export function coincidenceRows(doc) {
  return Array.isArray(doc?.coincidences) ? doc.coincidences : [];
}

/**
 * Whether `doc` is a real cable-outage document -- i.e. the refine process
 * has written at least one pass -- rather than GET /api/cable-outage-risk's
 * own "not computed yet" `{}`. build_document (backend/refine/
 * cable_outage.py) always writes `countries_with_landings` (0 or more, never
 * absent), so its presence is what tells "not computed" apart from
 * "computed, and genuinely no landing-holding country was found" -- feeds
 * refinePanelStatus.js.
 */
export function hasCableOutageDocument(doc) {
  return !!doc && typeof doc === "object" && Number.isFinite(doc.countries_with_landings);
}

// Labels for backend/refine/cable_outage.py's five spike-status words --
// mirrored here as the frontend's own copy for the same reason
// infraRiskPanelLogic.js's CATEGORY_LABEL is its own copy (no shared import
// across the Python/JS boundary). Wording is deliberately only ever about
// the *outage score itself* -- elevated, quiet, too little history, never
// seen, or this map simply has no code to check at all -- never about why,
// so nothing here can drift into a claim about a cable or an event.
export const STATUS_LABEL = {
  spike: "score currently elevated against its own recent history",
  no_spike: "checked, not currently elevated",
  insufficient_history: "not enough recorded history yet to judge",
  never_observed: "never recorded above IODA's own reporting floor",
  not_checkable: "no country code this map can check an outage score against",
};

/**
 * A status summary line's worth of counts -- one key per STATUS_LABEL entry,
 * all defaulting to 0 so a panel can render a full summary even before any
 * country has been through every bucket at least once.
 */
export function statusCounts(doc) {
  const counts = doc?.status_counts || {};
  const out = {};
  for (const key of Object.keys(STATUS_LABEL)) out[key] = counts[key] || 0;
  return out;
}

/**
 * "Outage score 5,000,000 (5.0x its own recent peak of 1,000,000)" -- a
 * coincidence card's own score line. Purely a report of two numbers and
 * their ratio; no verb connects the score to anything else on the card.
 */
export function scoreLine(entry) {
  const base = `Outage score ${fmtNumber(entry?.current_score)}`;
  if (!Number.isFinite(entry?.ratio)) return base;
  return `${base} (${entry.ratio.toFixed(1)}x its own recent peak of ${fmtNumber(entry.baseline_score)})`;
}

/**
 * "N cable landing(s) in this country:" -- the header line above a
 * coincidence card's own list of landings. `count` is a plain landing
 * count, not a claim about any of them individually.
 */
export function landingsHeaderLine(count) {
  const n = count || 0;
  return `${fmtNumber(n)} cable landing${n === 1 ? "" : "s"} recorded in this country:`;
}

/**
 * "" for a landing genuinely inside its country's own drawn border, or
 * " -- attributed by nearest coastline, ~4.2km outside the border" for one
 * backend/refine/cable_outage.py's own nearest_country fallback pulled in
 * (see that module's CONTAINED/SNAPPED). Task 38 review (Important 1): a
 * snapped attribution is derived from a weaker premise than a contained
 * one -- a nearby coastline, not the country's own drawn border -- and has
 * to be visible next to the landing itself, not only in the aggregate
 * `landings_snapped` count the coverage paragraph already carries.
 */
export function landingAttributionNote(landing) {
  if (!landing || landing.attribution !== "snapped") return "";
  const km = landing.snap_distance_km;
  return Number.isFinite(km)
    ? ` -- attributed by nearest coastline, ~${km}km outside the border`
    : " -- attributed by nearest coastline, outside the border";
}

/**
 * "N event(s) recorded inside a cable landing's own radius in this window:"
 * -- worded like infra_risk.py's own "inside its uncertainty radius" (see
 * InfraRiskPanel.jsx), not "landed near" or any construction that could
 * read as the event acting on the landing. A count of events found inside a
 * search radius, nothing about what any of them did.
 */
export function eventsHeaderLine(count) {
  const n = count || 0;
  return `${fmtNumber(n)} event${n === 1 ? "" : "s"} recorded inside a cable landing's own search radius `
    + "in this window:";
}

/**
 * "violence recorded in Egypt" -- one matched event's own type and place,
 * with no bridge word to the outage or the landing at all; the panel
 * appends a locale-formatted timestamp next to this separately (not
 * deterministic enough to assert on here).
 */
export function eventLine(event) {
  const type = event?.event_type || "event";
  const place = event?.country || "an unspecified location";
  return `${type} recorded in ${place}`;
}

/**
 * The status-count summary paragraph: how many landing-holding countries
 * were checked this pass, and how many fell into each of the five states.
 */
export function statusSummaryLine(doc) {
  const checked = doc?.countries_with_landings || 0;
  const counts = statusCounts(doc);
  const parts = Object.keys(STATUS_LABEL).map((key) => `${fmtNumber(counts[key])} ${STATUS_LABEL[key]}`);
  return `${fmtNumber(checked)} countr${checked === 1 ? "y" : "ies"} with a recorded cable landing checked `
    + `this pass -- ${parts.join(", ")}.`;
}

/**
 * The event-search paragraph: how many fused events in the window had a
 * usable uncertainty radius and were actually searched, and how many did
 * not and could not be.
 */
export function eventSearchLine(doc) {
  const windowHours = doc?.event_window_hours ?? 24;
  const searched = doc?.events_searched ?? 0;
  const withoutRadius = doc?.events_without_radius ?? 0;
  return `Last ${windowHours}h: ${fmtNumber(searched)} fused event${searched === 1 ? "" : "s"} had a stated `
    + `uncertainty radius and were searched against every cable landing; ${fmtNumber(withoutRadius)} had none `
    + "and could not be.";
}

/**
 * The landing-coverage paragraph. Task 38 review (Important 2): attribution
 * is geometric now (a landing's own coordinate tested against the country
 * polygon this map already draws -- see backend/regions.py's CountryIndex
 * and backend/refine/cable_outage.py's own docstring), not a name join, so
 * this line no longer says "matched ... by name". `landings_snapped` is a
 * landing that missed every polygon outright but sat close enough to one to
 * snap to it (real landings are drawn at the coast, not surveyed onto it);
 * `landings_unattributed` is a country that *was* found but carries no code
 * this map can check (also visible per-country as the `not_checkable`
 * status); `landings_unmatched` is a landing that could not be placed in
 * any country at all, snap included.
 */
export function landingCoverageLine(doc) {
  const stats = doc?.landing_stats || {};
  const matched = stats.landings_matched ?? 0;
  const total = stats.landings_total ?? 0;
  const snapped = stats.landings_snapped ?? 0;
  const unmatched = stats.landings_unmatched ?? 0;
  const unattributed = stats.landings_unattributed ?? 0;
  const plannedExcluded = stats.landings_planned_excluded ?? 0;
  return `${fmtNumber(matched)} of ${fmtNumber(total)} cable landings this map has collected sit inside, or close `
    + `enough to snap to, a country this map can locate (${fmtNumber(snapped)} needed the snap); `
    + `${fmtNumber(unmatched)} could not be placed in any country at all and are not checked against any `
    + `country's score; ${fmtNumber(unattributed)} of the matched landings sit in a country this map cannot check `
    + "(see \"no country code\" above); "
    + `${fmtNumber(plannedExcluded)} are planned landings excluded because their site is not yet settled.`;
}

/**
 * classifyRefinePanelStatus's REFINE_PANEL_STATUS.READY with a real,
 * genuinely empty `coincidences` array is a real "checked, none found" -- a
 * reader-facing sentence for that specific case, kept apart from the
 * ERROR/MISSING wording refinePanelStatus.js itself owns (those are about
 * whether a document exists at all, not about what a real one contains).
 */
export function emptyStateText(doc) {
  const counts = statusCounts(doc);
  const checked = doc?.countries_with_landings || 0;
  if (checked === 0) return "No country with a recorded submarine-cable landing has been checked yet.";
  if (counts.spike === 0) {
    return `${checked} landing-holding countr${checked === 1 ? "y" : "ies"} checked this pass; none currently `
      + "elevated.";
  }
  return `${counts.spike} landing-holding countr${counts.spike === 1 ? "y is" : "ies are"} currently elevated, `
    + "but no fused event was recorded inside their cable landings' own search radius in this window.";
}
