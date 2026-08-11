// Pure logic behind InfraRiskPanel.jsx -- reading GET /api/infra-risk's own
// document (backend/refine/infra_risk.py's build_document) into rows a
// table/sort function can work with. Plain JS, no JSX and no window/Leaflet
// dependency, for the same reason chokepointPanelLogic.js is: this project's
// headless test suite (`node --test`, no build step) cannot import JSX at
// all -- see frontend/tests/infraRiskPanel.test.js.
//
// map/eventDetail.js's "Nearby infrastructure" block (Task 13) answers "what
// sits inside *this one event's* circle", searched client-side against
// whatever layers happen to be loaded in the session. This panel answers the
// other half of Task 37's brief: across every event in the map's active
// window, which infrastructure site has the most of them nearby -- a
// question that needs every event and every site the backend actually
// indexed, not just the ones a reader happened to have turned on, which is
// why it is computed server-side (backend/refine/infra_risk.py) rather than
// reusing nearbyInfrastructure() over the session's raw layers.
//
// **Proximity is not causation.** A site in this list sits inside one or
// more events' own radius of positional doubt -- not evidence it was
// targeted, struck, or involved. InfraRiskPanel.jsx renders the document's
// own `note` field verbatim for this, rather than a second copy of the
// sentence kept in sync by hand, so the panel and the raw JSON can never say
// two different things.

// The five Nearby categories (backend/refine/infra_risk.py's CATEGORY_LABEL,
// mirrored here as the frontend's own copy for the same reason
// map/eventDetail.js's NEARBY_LABEL is its own copy rather than a shared
// import across a Python/JS boundary that does not exist).
export const CATEGORY_LABEL = {
  dam: "Dam / reservoir",
  power_plant: "Power plant",
  cable_landing: "Submarine cable landing",
  airfield: "Airfield",
  port: "Port",
};

/**
 * The document's own ranked `top` array, or [] before a pass has landed --
 * the same "never absent, just possibly empty" contract every other
 * refine-derived doc reader in this codebase (chokepointRows, todayEntry)
 * follows.
 */
export function infraRiskRows(doc) {
  return Array.isArray(doc?.top) ? doc.top : [];
}

/**
 * Whether `doc` is a real infra-risk document -- i.e. the refine process has
 * written at least one pass -- rather than GET /api/infra-risk's own "not
 * computed yet" `{}`. build_document (backend/refine/infra_risk.py) always
 * writes `events_searched` (0 or more, never absent), so its presence is
 * what tells "not computed" apart from "computed, and genuinely zero sites
 * were ranked" -- infraRiskRows(doc).length alone cannot make that
 * distinction, since both give an empty array. Feeds refinePanelStatus.js.
 */
export function hasInfraRiskDocument(doc) {
  return !!doc && typeof doc === "object" && Number.isFinite(doc.events_searched);
}

// Sorts below every real event_count (always >= 1 for anything in `top` --
// build_document never carries a zero-count site) -- so an unknown sort key
// cannot silently drop rows, the same NO_TOTAL sentinel idiom
// chokepointPanelLogic.js's own SORT_VALUE.total uses.
const NO_COUNT = -1;

const SORT_VALUE = {
  event_count: (row) => (Number.isFinite(row?.event_count) ? row.event_count : NO_COUNT),
  name: (row) => (row?.name || "").toLowerCase(),
};

export const INFRA_RISK_SORT_KEYS = Object.keys(SORT_VALUE);

/**
 * `rows`, ordered by `sortKey` -- a new array, never mutating the input.
 * Ties break on `site_id` -- not `name`, which two different sites can
 * share (two unnamed dams both fall back to the same generated label) -- so
 * the frontend's own tie-break can never disagree with the backend's
 * (build_document sorts ties on site_id ascending for the identical
 * "must not reorder from one pass to the next for no real reason" reason).
 */
export function sortInfraRisk(rows, sortKey = "event_count", direction = "desc") {
  const valueOf = SORT_VALUE[sortKey] || SORT_VALUE.event_count;
  const factor = direction === "asc" ? 1 : -1;
  return [...(rows || [])].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av < bv) return -1 * factor;
    if (av > bv) return 1 * factor;
    return (a?.site_id || "").localeCompare(b?.site_id || "");
  });
}

/**
 * Which of the five Nearby categories the document's own `category_counts`
 * says had nothing indexed at all -- a category-wide "not collected here",
 * not "searched and found clear". A reader scanning a ranked list with no
 * dam in it cannot tell those two apart without this: the list on its own
 * is silent about a category with zero candidates the same way it is silent
 * about one that was searched and came up empty, and this project's rule is
 * that those must never render the same.
 */
export function emptyCategories(doc) {
  const counts = doc?.category_counts || {};
  return Object.keys(CATEGORY_LABEL).filter((category) => !counts[category]);
}
