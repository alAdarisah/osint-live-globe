// Pure logic behind ChokepointPanel.jsx -- reading GET /api/chokepoints' own
// {boxes: {label: {label, bounds, trend, today}}} document into rows a
// table/sort function can work with, plus the small arithmetic a trend strip
// needs. Plain JS, no JSX and no window/Leaflet dependency, for the same
// reason airfieldPanelLogic.js is: this project's headless test suite
// (`node --test`, no build step) cannot import JSX at all -- see
// frontend/tests/chokepointPanel.test.js.
//
// The one document this reads is backend/refine/lane_density.py's own
// build_chokepoint_document -- see that function's docstring for what each
// trend entry's `status` (counted/partial/missing) means, and why a missing
// day carries `total: null` rather than `0`. Nothing here is allowed to
// collapse that distinction back into a number; see trendBars below.

/**
 * {boxes: {label: entry}} -> a plain array, in the order the backend built
 * the document (config.WATCHED_WATERS' own order -- see
 * lane_density.build_chokepoint_document, which iterates _LABELED_WATERS).
 */
export function chokepointRows(doc) {
  return Object.values(doc?.boxes || {});
}

/**
 * Whether `doc` is a real chokepoint document -- i.e. the refine process has
 * written at least one pass -- rather than GET /api/chokepoints' own "not
 * computed yet" `{}`. build_chokepoint_document (backend/refine/
 * lane_density.py) always writes a `boxes` key, with an entry for every one
 * of the eight configured watched-water boxes even when none of them have
 * ever seen a hull -- so a real document can never have an empty `boxes`,
 * and this check (not chokepointRows(doc).length) is what tells "not
 * computed" apart from a (today impossible, but not this function's job to
 * assume) "computed, zero boxes configured" -- see refinePanelStatus.js,
 * which this feeds.
 */
export function hasChokepointDocument(doc) {
  return !!doc && typeof doc === "object" && "boxes" in doc;
}

/**
 * A box's own `today` entry, or a synthetic "nothing recorded" placeholder
 * for a box the refine job has never written a pass for yet -- so every row
 * this panel draws has something to read off, the same "never silently
 * absent" discipline GET /api/chokepoints itself follows (an empty document
 * before the first pass, not an error).
 */
export function todayEntry(box) {
  return box?.today || { date: null, status: "missing", total: null, by_class: null };
}

// Sorts below every real total (which is always >= 0, including a genuine
// counted zero) -- the same NO_SHARE sentinel idiom airfieldPanelLogic.js
// uses for militaryShare, so a box this job has never observed floats to the
// bottom of a "busiest chokepoint" sort rather than tying with a quiet one.
const NO_TOTAL = -1;

const SORT_VALUE = {
  total: (box) => todayEntry(box).total ?? NO_TOTAL,
  label: (box) => (box.label || "").toLowerCase(),
};

export const CHOKEPOINT_SORT_KEYS = Object.keys(SORT_VALUE);

/**
 * `rows`, ordered by `sortKey` -- a new array, never mutating the input.
 * Ties break on `label` so two boxes tied on the sorted figure always render
 * in the same relative order rather than swapping places on every poll.
 */
export function sortChokepoints(rows, sortKey = "total", direction = "desc") {
  const valueOf = SORT_VALUE[sortKey] || SORT_VALUE.total;
  const factor = direction === "asc" ? 1 : -1;
  return [...(rows || [])].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av < bv) return -1 * factor;
    if (av > bv) return 1 * factor;
    return (a.label || "").localeCompare(b.label || "");
  });
}

/**
 * One bar's height in px within a `trackHeight`-tall strip, floored at 1 so
 * a genuine zero is still a visible sliver rather than indistinguishable
 * from a gap -- the same floor map/popups.js's buildSparkline uses, and for
 * the identical reason: an invisible-because-zero bar and an
 * absent-because-missing one must never look the same. `max` of 0 (every
 * counted/partial day in the window is a real zero) falls back to a small
 * fixed sliver rather than dividing by zero.
 */
export function barHeight(total, max, trackHeight) {
  if (!max) return Math.max(1, Math.round(trackHeight * 0.08));
  return Math.max(1, Math.round((total / max) * trackHeight));
}

/**
 * `trend` (a box's own N-entry array, oldest first) -> the numbers a
 * bar-strip component needs per day: {date, status, total, height}.
 *
 * `height` is present only for counted/partial entries. A missing entry
 * (`total: null`) carries `height: null` on purpose -- that is the
 * component's cue to draw a gap or hatch mark instead of a bar of height 0,
 * which is exactly the "a day with no data must never render as zero
 * traffic" rule this whole feature exists to hold to, one layer down into
 * the chart itself rather than only in the text next to it.
 */
export function trendBars(trend, trackHeight = 24) {
  const entries = Array.isArray(trend) ? trend : [];
  const max = Math.max(0, ...entries.map((e) => e.total ?? 0));
  return entries.map((e) => ({
    date: e.date,
    status: e.status,
    total: e.total,
    height: e.total == null ? null : barHeight(e.total, max, trackHeight),
  }));
}

/** The centre of a box's own [south, west, north, east] bounds -- "click to
 * fly" needs a point, not a rectangle, and a chokepoint box is small enough
 * (the widest, South China Sea, is ~23deg across) that its centre is a
 * reasonable place to land, the same trade-off navalPresenceRegion's own
 * theatre-box matching in map/popups.js already accepts at a larger scale. */
export function boxCenter(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return null;
  const [south, west, north, east] = bounds;
  if (![south, west, north, east].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return { lat: (south + north) / 2, lon: (west + east) / 2 };
}
