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
// can never say two different things, and nothing in this module composes
// any prose of its own about why a coincidence appears in the list.

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

// Labels for backend/refine/cable_outage.py's four spike-status words --
// mirrored here as the frontend's own copy for the same reason
// infraRiskPanelLogic.js's CATEGORY_LABEL is its own copy (no shared import
// across the Python/JS boundary). Wording is deliberately only ever about
// the *outage score itself* -- elevated, quiet, too little history, never
// seen -- never about why, so nothing here can drift into a claim about a
// cable or an event.
export const STATUS_LABEL = {
  spike: "score currently elevated against its own recent history",
  no_spike: "checked, not currently elevated",
  insufficient_history: "not enough recorded history yet to judge",
  never_observed: "never recorded above IODA's own reporting floor",
};

/**
 * A status summary line's worth of counts -- {spike, no_spike,
 * insufficient_history, never_observed}, all defaulting to 0 so a panel can
 * render a full summary even before any country has been through every
 * bucket at least once.
 */
export function statusCounts(doc) {
  const counts = doc?.status_counts || {};
  return {
    spike: counts.spike || 0,
    no_spike: counts.no_spike || 0,
    insufficient_history: counts.insufficient_history || 0,
    never_observed: counts.never_observed || 0,
  };
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
    return `${checked} landing-holding countr${checked === 1 ? "y" : "ies"} checked this pass; none currently elevated.`;
  }
  return `${counts.spike} landing-holding countr${counts.spike === 1 ? "y is" : "ies are"} currently elevated, ` +
    "but no fused event landed near their cable landings in this window.";
}
