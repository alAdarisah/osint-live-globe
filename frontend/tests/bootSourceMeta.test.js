// The boot log claims three things about each source: how many rows it
// returned, how long it took, and -- when it did not return -- why. These are
// the shapes those three claims have to survive, including the ones where the
// honest answer is "no number to show" rather than zero.

import test from "node:test";
import assert from "node:assert/strict";

import { countOf, failureDetail, formatBootMeta } from "../src/hooks/bootSourceMeta.js";

test("counts the rows of a payload that has rows", () => {
  assert.equal(countOf([1, 2, 3]), 3);
  assert.equal(countOf([]), 0);
  assert.equal(countOf({ type: "FeatureCollection", features: [{}, {}] }), 2);
  assert.equal(countOf({ type: "FeatureCollection", features: [] }), 0);
});

test("says nothing rather than zero when a payload has no rows to count", () => {
  // An absent count and a count of zero are different claims, and the log has
  // to be able to make the first one. A string in particular must not be
  // counted by its .length -- that would report a character total as a row
  // total.
  assert.equal(countOf(null), null);
  assert.equal(countOf(undefined), null);
  assert.equal(countOf("abcd"), null);
  assert.equal(countOf(7), null);
  assert.equal(countOf({ as_of: "2026-08-15" }), null);
  assert.equal(countOf({ features: "not-an-array" }), null);
});

test("reports an HTTP status when the response carried one", () => {
  const err = new Error("/api/fires: 503");
  err.status = 503;
  assert.equal(failureDetail(err), "HTTP 503");
});

test("does not call a transport failure an HTTP error", () => {
  // fetch() rejecting outright (DNS, offline, blocked) never produced a
  // response, so there is no status -- and printing "HTTP undefined" would be
  // inventing one.
  assert.equal(failureDetail(new TypeError("fetch failed")), "unreachable");
  assert.equal(failureDetail(undefined), "unreachable");
});

test("formats a loaded source as its count and its elapsed time", () => {
  assert.equal(
    formatBootMeta({ status: "ok", ms: 340, count: 12480, detail: null }),
    "12,480 rows · 340ms"
  );
  assert.equal(formatBootMeta({ status: "ok", ms: 12, count: 0, detail: null }), "0 rows · 12ms");
});

test("shows the time alone when the payload had nothing countable", () => {
  assert.equal(formatBootMeta({ status: "ok", ms: 90, count: null, detail: null }), "90ms");
});

test("switches to seconds once a source takes longer than a second", () => {
  assert.equal(formatBootMeta({ status: "ok", ms: 1500, count: null, detail: null }), "1.5s");
  assert.equal(formatBootMeta({ status: "ok", ms: 999, count: null, detail: null }), "999ms");
});

test("gives the reason instead of the numbers when a source did not load", () => {
  assert.equal(
    formatBootMeta({ status: "warn", ms: 40, count: null, detail: "HTTP 503" }),
    "HTTP 503"
  );
  assert.equal(
    formatBootMeta({ status: "timeout", ms: null, count: null, detail: "still waiting" }),
    "still waiting"
  );
  assert.equal(
    formatBootMeta({ status: "deferred", ms: null, count: null, detail: "below zoom gate" }),
    "below zoom gate"
  );
});

test("says nothing at all about a source still in flight", () => {
  // A pending line has no true statement available to it yet, and a blank is
  // the honest rendering of that.
  assert.equal(formatBootMeta({ status: "pending", ms: null, count: null, detail: null }), null);
  assert.equal(formatBootMeta({ status: "ok", ms: null, count: null, detail: null }), null);
  assert.equal(formatBootMeta(null), null);
});
