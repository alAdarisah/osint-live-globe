// Shared shape for the small floating panels that poll one refine-derived
// document on their own timer (ChokepointPanel, InfraRiskPanel) -- both used
// to render the same three genuinely different situations as one thing:
// nothing showed up, whether the fetch itself failed, the refine process
// simply hasn't written a first pass yet, or a pass ran and genuinely found
// nothing to rank. Task 37 review (Minor, escalated): "did not look" reading
// as "found nothing" is exactly the defect this project keeps finding and
// fixing everywhere else -- these two panels were the one place it had not
// been fixed yet.
//
// Plain JS, no JSX, so it is importable from the headless test suite
// (`node --test`) the same as chokepointPanelLogic.js/infraRiskPanelLogic.js
// are -- see frontend/tests/refinePanelStatus.test.js.

export const REFINE_PANEL_STATUS = {
  LOADING: "loading", // no response yet, and no failure yet either -- the ordinary first instant after mount
  ERROR: "error", // the most recent fetch attempt failed (network/HTTP), and no earlier attempt ever succeeded
  MISSING: "missing", // fetched successfully, but the refine process has not written a document yet (the endpoint's own "{}" contract)
  READY: "ready", // fetched successfully and a real document exists -- rows may still be empty; that is each panel's own domain wording to state, not this module's
};

/**
 * Which of the four states a panel is in, from three facts only the panel
 * itself knows:
 *
 * - `hasFetchedOnce`: a request has completed with a response body at least
 *   once (success or a body that parsed, even if empty) -- distinct from
 *   `fetchFailed`, which is about the *most recent* attempt only, so a
 *   transient failure after a real document has already loaded does not
 *   revert a working panel back to an error screen.
 * - `fetchFailed`: the most recent fetch attempt threw (network error,
 *   non-OK status, bad JSON).
 * - `hasDocument`: the last successfully fetched body looks like a real
 *   computed document for this panel's own shape (not the endpoint's empty
 *   "not computed yet" `{}`) -- each caller supplies its own check, since
 *   ChokepointPanel's document always carries a `boxes` key and
 *   InfraRiskPanel's always carries `events_searched`, and neither module
 *   should have to know the other's schema to answer this.
 */
export function classifyRefinePanelStatus({ hasFetchedOnce, fetchFailed, hasDocument }) {
  if (!hasFetchedOnce) {
    return fetchFailed ? REFINE_PANEL_STATUS.ERROR : REFINE_PANEL_STATUS.LOADING;
  }
  return hasDocument ? REFINE_PANEL_STATUS.READY : REFINE_PANEL_STATUS.MISSING;
}

// The sentence each panel shows, in its own header-only shell, for the two
// states that mean "there is nothing to list" for a reason that has nothing
// to do with the world being quiet -- worded identically across both panels
// per the review's own instruction ("keep the two implementations worded
// consistently"), since the meaning is identical in both: this widget could
// not get an answer, versus this widget got an answer and the answer is
// "not yet". READY is deliberately not in this table -- a ready document
// (even with zero rows) is each panel's own body to render, in its own
// domain wording, not a generic line from here.
export const REFINE_PANEL_STATUS_TEXT = {
  [REFINE_PANEL_STATUS.ERROR]: "Could not load this panel's data. Retrying automatically.",
  [REFINE_PANEL_STATUS.MISSING]: "Not computed yet — waiting on the refine process's first pass.",
};

// Short header-badge word for the same two states, so a reader can tell
// error from missing from a real count without opening the panel -- the
// same "never silent about which of these it is" reasoning as the sentence
// above, compressed to fit next to the panel title.
export const REFINE_PANEL_STATUS_BADGE = {
  [REFINE_PANEL_STATUS.ERROR]: "error",
  [REFINE_PANEL_STATUS.MISSING]: "not computed",
};
