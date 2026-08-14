// Task 37 review (Minor, escalated): the shared status logic behind
// ChokepointPanel and InfraRiskPanel -- a fetch that failed, a document that
// has not been computed yet, and a document that exists (whether or not its
// own rows are empty) must render as three distinguishable things, not one.
// refinePanelStatus.js imports nothing, so this needs no window/Leaflet
// stub -- same footing as chokepointPanel.test.js.

import test from "node:test";
import assert from "node:assert/strict";

import {
  REFINE_PANEL_STATUS, REFINE_PANEL_STATUS_BADGE, REFINE_PANEL_STATUS_TEXT, classifyRefinePanelStatus,
} from "../src/components/refinePanelStatus.js";

test("classifyRefinePanelStatus: no response yet and no failure yet is LOADING", () => {
  const status = classifyRefinePanelStatus({ hasFetchedOnce: false, fetchFailed: false, hasDocument: false });
  assert.equal(status, REFINE_PANEL_STATUS.LOADING);
});

test("classifyRefinePanelStatus: the first attempt failing, before any success, is ERROR", () => {
  const status = classifyRefinePanelStatus({ hasFetchedOnce: false, fetchFailed: true, hasDocument: false });
  assert.equal(status, REFINE_PANEL_STATUS.ERROR);
});

test("classifyRefinePanelStatus: fetched successfully but the refine process has not written a document is MISSING", () => {
  const status = classifyRefinePanelStatus({ hasFetchedOnce: true, fetchFailed: false, hasDocument: false });
  assert.equal(status, REFINE_PANEL_STATUS.MISSING);
});

test("classifyRefinePanelStatus: fetched successfully and a real document exists is READY", () => {
  const status = classifyRefinePanelStatus({ hasFetchedOnce: true, fetchFailed: false, hasDocument: true });
  assert.equal(status, REFINE_PANEL_STATUS.READY);
});

test("classifyRefinePanelStatus: a later poll failing after an earlier success stays READY, not ERROR", () => {
  // A transient hiccup on poll #2 must not blank out a panel that is
  // already showing real, previously-fetched data -- fetchFailed only
  // matters before the first success ever lands (hasFetchedOnce false).
  const status = classifyRefinePanelStatus({ hasFetchedOnce: true, fetchFailed: true, hasDocument: true });
  assert.equal(status, REFINE_PANEL_STATUS.READY);
});

test("classifyRefinePanelStatus: a later poll failing after an earlier success that found no document stays MISSING, not ERROR", () => {
  const status = classifyRefinePanelStatus({ hasFetchedOnce: true, fetchFailed: true, hasDocument: false });
  assert.equal(status, REFINE_PANEL_STATUS.MISSING);
});

test("REFINE_PANEL_STATUS_TEXT and REFINE_PANEL_STATUS_BADGE cover ERROR and MISSING, and only those", () => {
  // READY is deliberately absent from both tables -- see the module's own
  // comment on why a ready document (even an empty one) is each panel's own
  // body to render, not a generic line from here.
  assert.deepEqual(Object.keys(REFINE_PANEL_STATUS_TEXT).sort(), ["error", "missing"]);
  assert.deepEqual(Object.keys(REFINE_PANEL_STATUS_BADGE).sort(), ["error", "missing"]);
});

test("REFINE_PANEL_STATUS_TEXT: error and missing read as genuinely different situations", () => {
  assert.match(REFINE_PANEL_STATUS_TEXT[REFINE_PANEL_STATUS.ERROR], /not load/i);
  assert.match(REFINE_PANEL_STATUS_TEXT[REFINE_PANEL_STATUS.MISSING], /not computed yet/i);
});
