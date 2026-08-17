// What a conflict event's one line says it is.
//
// Three surfaces show a fused event: the map's hover tooltip and popup
// (decorators.js), the full detail card (eventDetail.js), and the intel feed's
// row (IntelPanel.jsx). All three were deriving that line themselves, and the
// feed's derivation was subtly different -- it fell back to `actor1 vs actor2`
// where the other two fall back to `summary`.
//
// That is not a cosmetic difference, because of how the backend fills the two
// fields. event_fusion.py sets `summary` to None when `notes` is present and
// builds it from the coded fields otherwise -- so `summary` exists *precisely
// when there is no headline*, which is exactly when the fallback is reached. The
// two never agreed in the only case where it mattered, and the feed always drew
// the vaguer of the two: "Russian armed forces vs Civilians" for a record whose
// card read "Russian armed forces carried out an air strike on civilians in
// Kharkiv."
//
// One function, three callers.

/** The taxonomy label, used when a record has neither a headline nor a summary. */
export const EVENT_FAMILY_FALLBACK = "Conflict event";

/**
 * The line that says what happened.
 *
 * Order matters and is the whole point:
 *   notes       the scraped headline, as published. Only present for an
 *               allowlisted domain that was actually fetched (gdelt.py budgets
 *               400 scrapes a poll), so it is the best answer and often absent.
 *   summary     a sentence assembled from the coded actor/action/place fields.
 *               Not quoted from anyone, and labelled "derived" wherever it is
 *               shown -- but it names an act, a place and two parties.
 *   event_type  the CAMEO family alone. "Unconventional violence" tells a reader
 *               nothing about what happened, which is why it is last.
 *
 * @param {object|null|undefined} record  a fused event
 * @returns {string} never empty
 */
export function eventLeadLine(record) {
  const headline = (record?.notes || "").trim();
  if (headline) return headline;
  const derived = (record?.summary || "").trim();
  if (derived) return derived;
  return record?.event_type || EVENT_FAMILY_FALLBACK;
}

/**
 * What the detail card's header bar should say for one record of any kind.
 *
 * The card was showing the literal string "Event detail" for every record ever
 * opened, for every layer -- because it renders `detail.title || "Event detail"`
 * and no decorator has ever returned a `title`. The header of a card a reader
 * deliberately opened is the one place that has to name the thing they opened.
 *
 * Fused events get the shared lead line. Everything else gets whichever
 * identifying field the record actually carries, in the order the popups already
 * prefer them; `null` when a record carries none, so the caller keeps its own
 * fallback rather than this inventing a name.
 *
 * @param {string} kind
 * @param {object} item
 * @returns {string|null}
 */
export function recordCardTitle(kind, item) {
  if (kind === "events") return eventLeadLine(item);
  const named = [item?.name, item?.label, item?.headline, item?.title, item?.callsign, item?.location]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find(Boolean);
  return named || null;
}

/**
 * Which of the three the lead line came from, for the provenance wording the
 * detail card already established: a reader must be able to tell a quoted
 * headline from a sentence this pipeline wrote.
 *
 * @returns {"reported"|"derived"|"inferred"}
 */
export function eventLeadKind(record) {
  if ((record?.notes || "").trim()) return "reported";
  if ((record?.summary || "").trim()) return "derived";
  return "inferred";
}
