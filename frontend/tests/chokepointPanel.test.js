// Task 36: ChokepointPanel's own logic -- the row extraction, the sort, the
// trend-strip bar arithmetic that keeps a "missing" day from ever getting a
// bar the same shape as a real zero, and the box-centre helper "click to
// fly" needs. chokepointPanelLogic.js imports nothing but utils/format's
// fmtNumber (for hullCountLine's own thousands separators), so like
// infraRiskPanel.test.js this needs no window/Leaflet stub -- same footing as
// airfieldPanel.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Every src file in this project uses Vite-style extensionless relative
// imports (chokepointPanelLogic.js imports "../utils/format"), which Node's
// own resolver cannot follow -- the identical loader shim
// cableOutagePanel.test.js and 25 other test files in this suite already
// carry. registerHooks only affects resolutions that happen *after* it runs,
// so the module under test has to be a dynamic `await import()` below rather
// than a static top-of-file `import`.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
});

const {
  CHOKEPOINT_SORT_KEYS, STATUS_WORD, barHeight, boxCenter, chokepointRows, hasChokepointDocument, hullCountLine,
  sortChokepoints, todayEntry, trendBars,
} = await import("../src/components/chokepointPanelLogic.js");

function box(label, overrides = {}) {
  return {
    label, bounds: [10, 20, 15, 25],
    trend: [],
    today: { date: "2026-08-09", status: "counted", total: 0, by_class: {} },
    ...overrides,
  };
}

// --- chokepointRows ----------------------------------------------------

test("chokepointRows turns the {label: box} document into a plain array", () => {
  const doc = { boxes: { A: box("A"), B: box("B") } };
  const rows = chokepointRows(doc);
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.label)), new Set(["A", "B"]));
});

test("chokepointRows is empty, not an error, before anything has landed", () => {
  assert.deepEqual(chokepointRows(null), []);
  assert.deepEqual(chokepointRows(undefined), []);
  assert.deepEqual(chokepointRows({}), []);
});

// --- hasChokepointDocument (Task 37 review: fetch-failed vs not-computed vs empty) ---

test("hasChokepointDocument: a real document (a boxes key, even one with content) is true", () => {
  assert.equal(hasChokepointDocument({ boxes: { A: box("A") } }), true);
});

test("hasChokepointDocument: GET /api/chokepoints' own \"not computed yet\" {} is false", () => {
  assert.equal(hasChokepointDocument({}), false);
});

test("hasChokepointDocument: null, undefined or a non-object is false, not a throw", () => {
  assert.equal(hasChokepointDocument(null), false);
  assert.equal(hasChokepointDocument(undefined), false);
  assert.equal(hasChokepointDocument("not a document"), false);
});

// --- todayEntry ----------------------------------------------------------

test("todayEntry reads a box's own `today` field", () => {
  const b = box("A", { today: { date: "2026-08-09", status: "partial", total: 4, by_class: { tanker: 4 } } });
  assert.deepEqual(todayEntry(b), { date: "2026-08-09", status: "partial", total: 4, by_class: { tanker: 4 } });
});

test("todayEntry falls back to a missing placeholder for a box never touched at all", () => {
  assert.deepEqual(todayEntry({ label: "A" }), { date: null, status: "missing", total: null, by_class: null });
  assert.deepEqual(todayEntry(null), { date: null, status: "missing", total: null, by_class: null });
});

// --- sortChokepoints -------------------------------------------------------

test("sorts by today's total, busiest first by default", () => {
  const rows = [
    box("A", { today: { date: "d", status: "counted", total: 5, by_class: {} } }),
    box("B", { today: { date: "d", status: "counted", total: 60, by_class: {} } }),
    box("C", { today: { date: "d", status: "counted", total: 20, by_class: {} } }),
  ];
  const sorted = sortChokepoints(rows, "total");
  assert.deepEqual(sorted.map((r) => r.label), ["B", "C", "A"]);
});

test("sorts ascending when asked", () => {
  const rows = [
    box("A", { today: { date: "d", status: "counted", total: 5, by_class: {} } }),
    box("B", { today: { date: "d", status: "counted", total: 60, by_class: {} } }),
  ];
  const sorted = sortChokepoints(rows, "total", "asc");
  assert.deepEqual(sorted.map((r) => r.label), ["A", "B"]);
});

test("a box never observed today sorts below every box with a real total, including a real zero", () => {
  const rows = [
    box("MISSING", { today: { date: null, status: "missing", total: null, by_class: null } }),
    box("QUIET", { today: { date: "d", status: "counted", total: 0, by_class: {} } }),
  ];
  const sorted = sortChokepoints(rows, "total", "desc");
  assert.deepEqual(sorted.map((r) => r.label), ["QUIET", "MISSING"]);
});

test("sorts by label alphabetically", () => {
  const rows = [box("Suez Canal"), box("Black Sea"), box("Taiwan Strait")];
  const sorted = sortChokepoints(rows, "label", "asc");
  assert.deepEqual(sorted.map((r) => r.label), ["Black Sea", "Suez Canal", "Taiwan Strait"]);
});

test("ties on the sorted figure break on the label", () => {
  const rows = [
    box("Zed", { today: { date: "d", status: "counted", total: 10, by_class: {} } }),
    box("Alpha", { today: { date: "d", status: "counted", total: 10, by_class: {} } }),
  ];
  const sorted = sortChokepoints(rows, "total");
  assert.deepEqual(sorted.map((r) => r.label), ["Alpha", "Zed"]);
});

test("sorting never mutates the array it was given", () => {
  const rows = [box("A"), box("B")];
  const original = [...rows];
  sortChokepoints(rows, "total");
  assert.deepEqual(rows, original);
});

test("an unknown sort key falls back to today's total rather than throwing", () => {
  const rows = [
    box("A", { today: { date: "d", status: "counted", total: 5, by_class: {} } }),
    box("B", { today: { date: "d", status: "counted", total: 60, by_class: {} } }),
  ];
  const sorted = sortChokepoints(rows, "not_a_real_key");
  assert.deepEqual(sorted.map((r) => r.label), ["B", "A"]);
});

test("CHOKEPOINT_SORT_KEYS lists every axis the panel can sort by", () => {
  assert.ok(CHOKEPOINT_SORT_KEYS.includes("total"));
  assert.ok(CHOKEPOINT_SORT_KEYS.includes("label"));
});

// --- barHeight -------------------------------------------------------------

test("barHeight scales to the strip's own max, never zero-height", () => {
  assert.equal(barHeight(0, 10, 24), 1); // a real zero is still a visible sliver
  assert.equal(barHeight(10, 10, 24), 24); // the max itself fills the track
  assert.equal(barHeight(5, 10, 24), 12); // half the max, half the track
});

test("barHeight falls back to a small fixed sliver when every value in the window is zero", () => {
  assert.equal(barHeight(0, 0, 24), Math.max(1, Math.round(24 * 0.08)));
});

// --- trendBars ---------------------------------------------------------

test("trendBars gives a missing day no height at all -- never a height of zero", () => {
  const trend = [
    { date: "2026-08-01", status: "missing", total: null, by_class: null },
    { date: "2026-08-02", status: "counted", total: 0, by_class: {} },
    { date: "2026-08-03", status: "partial", total: 4, by_class: { tanker: 4 } },
  ];
  const bars = trendBars(trend, 24);
  assert.equal(bars[0].height, null, "a missing day carries no height, not 0");
  assert.equal(bars[1].total, 0);
  assert.ok(bars[1].height > 0, "a real, counted zero still draws a visible sliver");
  assert.equal(bars[2].height, 24, "the busiest day in the window fills the track");
});

test("trendBars is empty, not an error, for an empty or missing trend", () => {
  assert.deepEqual(trendBars(null), []);
  assert.deepEqual(trendBars([]), []);
});

test("trendBars scales against the real max, ignoring missing days entirely", () => {
  const trend = [
    { date: "2026-08-01", status: "missing", total: null, by_class: null },
    { date: "2026-08-02", status: "counted", total: 2, by_class: {} },
    { date: "2026-08-03", status: "counted", total: 4, by_class: {} },
  ];
  const bars = trendBars(trend, 24);
  assert.equal(bars[2].height, 24); // the max (4) fills the track
  assert.equal(bars[1].height, 12); // half the max
});

// --- hullCountLine -------------------------------------------------------

test("hullCountLine: a box never observed today reads as not observed, not zero hulls", () => {
  assert.equal(hullCountLine({ date: null, status: "missing", total: null, by_class: null }), "Not observed yet today");
});

test("hullCountLine: pluralises a single hull correctly", () => {
  assert.equal(hullCountLine({ date: "d", status: "counted", total: 1, by_class: {} }), "1 distinct hull today (counted)");
});

test("hullCountLine: pluralises more than one hull, including a real counted zero", () => {
  assert.equal(hullCountLine({ date: "d", status: "counted", total: 0, by_class: {} }), "0 distinct hulls today (counted)");
  assert.equal(hullCountLine({ date: "d", status: "counted", total: 5, by_class: {} }), "5 distinct hulls today (counted)");
});

test("hullCountLine: prints STATUS_WORD's own word for each status", () => {
  assert.equal(hullCountLine({ date: "d", status: "counted", total: 3, by_class: {} }), "3 distinct hulls today (counted)");
  assert.equal(hullCountLine({ date: "d", status: "partial", total: 3, by_class: {} }), "3 distinct hulls today (still counting)");
});

test("hullCountLine: an unknown status word falls back to the raw status string rather than throwing", () => {
  assert.equal(hullCountLine({ date: "d", status: "weird", total: 3, by_class: {} }), "3 distinct hulls today (weird)");
});

test("hullCountLine: large totals go through fmtNumber's own thousands separators", () => {
  assert.equal(hullCountLine({ date: "d", status: "counted", total: 1234, by_class: {} }), "1,234 distinct hulls today (counted)");
});

test("STATUS_WORD covers every status build_chokepoint_document can write", () => {
  assert.equal(STATUS_WORD.counted, "counted");
  assert.equal(STATUS_WORD.partial, "still counting");
  assert.equal(STATUS_WORD.missing, "not observed");
});

// --- boxCenter ---------------------------------------------------------

test("boxCenter is the midpoint of [south, west, north, east]", () => {
  assert.deepEqual(boxCenter([24, 48, 30, 57]), { lat: 27, lon: 52.5 });
});

test("boxCenter is null for anything that is not a well-formed four-number box", () => {
  assert.equal(boxCenter(null), null);
  assert.equal(boxCenter([1, 2, 3]), null);
  assert.equal(boxCenter([1, 2, 3, "x"]), null);
  assert.equal(boxCenter(undefined), null);
});
