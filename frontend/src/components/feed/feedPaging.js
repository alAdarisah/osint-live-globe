// How much of a tab's list is actually in the DOM.
//
// The selectors in intelPanelLogic.js used to truncate -- 6 events, 8 news, 8
// officials -- and the tab counts reported the length of the array *after* that
// slice, so "News 8" meant "at least 8". They return everything now, which moves
// one question here: a rail that mounts 530 rows on a tab switch, and re-renders
// them every 60 seconds when the poll lands, is a rail that stutters.
//
// Three things answer it together, and only the first is in this file:
//
//   1. this: render a page at a time and grow when the reader reaches the end,
//      so the cost is paid for what is looked at rather than for what exists.
//   2. React.memo on the four row components, so a poll returning the same
//      records re-renders none of them (they are keyed on real record ids).
//   3. `content-visibility: auto` on the row class, so rows scrolled out of view
//      cost nothing to lay out or paint.
//
// Not virtualisation. The rows are variable height -- a two-line headline, a
// wrapped meta line, an optional chip row -- and a windowing implementation has
// to measure and cache heights or guess them, which goes wrong in exactly the
// case that matters (a long headline near the scroll anchor). Progressive reveal
// plus containment gets the same result with no measurement and no new
// dependency, in a project whose whole runtime dependency list is four packages.

/** Rows on first paint. About two screens of the rail at 1080p, so the reveal
 *  sentinel is comfortably below the fold and a reader who never scrolls never
 *  triggers a second page. */
export const FEED_PAGE_SIZE = 40;

/**
 * How many rows to render.
 *
 * @param {number} total  the tab's full, untruncated length
 * @param {number} pages  how many pages the reader has revealed (>= 1)
 * @returns {number} never more than `total`
 */
export function visibleCount(total, pages) {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const safePages = Number.isFinite(pages) && pages > 1 ? Math.floor(pages) : 1;
  return Math.min(safeTotal, safePages * FEED_PAGE_SIZE);
}

/** Is there anything left to reveal? Drives whether the sentinel is rendered at
 *  all -- an observer watching an element at the end of a fully revealed list
 *  would fire on every scroll to the bottom for no reason. */
export function hasMore(total, pages) {
  return visibleCount(total, pages) < (Number.isFinite(total) ? total : 0);
}

/**
 * The tab strip's count.
 *
 * `shown / total` while a tab is partly revealed, and the bare total once it is
 * all there -- because "530 / 530" is noise, and because the interesting fact is
 * always the total. The old badge showed the post-slice length, which is the one
 * number that is neither: it looked like a total and was a page size, so a tab
 * with 334 articles behind it read "8" and a reader had no way to know.
 *
 * @param {number} total
 * @param {number} pages
 * @returns {{text: string, title: string}}
 */
export function feedCountReadout(total, pages) {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  if (safeTotal === 0) {
    // A real zero. The tab bodies say *why* in their own words
    // (escalationEmptyMessage and its siblings), so this only has to not lie.
    return { text: "0", title: "Nothing in this tab matches the current scope and window." };
  }
  const shown = visibleCount(safeTotal, pages);
  if (shown >= safeTotal) {
    return { text: String(safeTotal), title: `${safeTotal} in the current scope and window, all shown.` };
  }
  return {
    text: `${shown} / ${safeTotal}`,
    title: `${safeTotal} in the current scope and window; ${shown} rendered so far. Scroll for more.`,
  };
}

/**
 * Should the reveal reset to the first page?
 *
 * Everything the reader chose that changes *what the list is about* resets it --
 * a different tab, a different scope, a different window, a different chip.
 * A poll landing does not, which is the whole point: the rail refetches every 60
 * seconds, and resetting on new data would snap a reader who had scrolled to row
 * 300 back to the top, repeatedly, for no reason they could see.
 *
 * Returned as a string rather than compared field by field so the caller can
 * hand it straight to a dependency array.
 */
export function pagingResetKey({ tab, scopeKind, windowHours, chip }) {
  return [tab ?? "", scopeKind ?? "", windowHours ?? "all", chip ?? ""].join("|");
}
