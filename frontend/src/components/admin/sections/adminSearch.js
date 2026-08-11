// The admin panel's search box, as one pure function.
//
// Plain .js rather than .jsx -- it imports nothing and needs no DOM, which is
// what lets it run under plain `node --test` with no build step (see
// placeInfoCardLayout.js for the same constraint). Every section file exports
// a SEARCH_TERMS array alongside its component -- its own title first, then
// its control labels -- and AdminPanel.jsx decides whether to render a
// section by checking each of its terms against the query with this.

/**
 * Whether `label` is a match for `query`.
 *
 * Case-insensitive substring, not fuzzy -- the panel has maybe sixty labels
 * total, so a plain `includes` finds anything worth finding without the false
 * positives a fuzzy match invites. An empty or whitespace-only query matches
 * everything, which is what makes "nothing typed yet" the same case as
 * "cleared the box": both show the whole panel.
 */
export function matchesQuery(label, query) {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return true;
  return String(label ?? "").toLowerCase().includes(q);
}
