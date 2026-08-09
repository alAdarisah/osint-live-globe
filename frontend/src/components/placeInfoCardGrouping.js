// Turns a flat list of PlaceInfoCard sections into the super-folds the card
// renders when its caller supplies a `groups` prop -- pulled out into its own
// pure module for the same reason placeInfoCardLayout.js is: it is a pure
// function of plain data, and PlaceInfoCard.jsx itself is JSX, which the
// plain `node --test` harness this project's frontend suite runs under
// cannot import at all (see placeInfoCardLayout.js's own note, and
// placeInfoCard.test.js).
//
// The one invariant this exists to guarantee: a section id that shows up in
// no group is never dropped. Sixteen sections is already too many for a
// grouping table to enumerate perfectly by hand, and a later task that adds
// a seventeenth and forgets to add its id here would otherwise lose that
// section off the card entirely, silently -- the same class of bug
// buildCoverage's own "never returns empty" rule (map/popups.js) exists to
// prevent one layer up, generalised from one section to all of them. So an
// unclaimed section still renders, standalone, after every real group, in
// its original relative order.

/**
 * @param {{id: string, title: string, html: string}[]} sections
 * @param {{id: string, title: string, sectionIds: string[]}[]|undefined} groups
 * @returns {Array<
 *   {kind: "group", id: string, title: string, sections: object[]}
 *   | {kind: "section", section: object}
 * >}
 */
export function groupSections(sections, groups) {
  if (!groups || !groups.length) {
    return sections.map((section) => ({ kind: "section", section }));
  }

  const byId = new Map(sections.map((section) => [section.id, section]));
  // Tracks which ids have already been placed, so (a) a section claimed by an
  // earlier group is not rendered a second time by a later one that also
  // names its id, and (b) the final ungrouped pass knows what is left.
  const claimed = new Set();
  const items = [];

  for (const group of groups) {
    const groupSections = (group.sectionIds || [])
      .map((id) => byId.get(id))
      .filter((section) => section && !claimed.has(section.id));
    if (!groupSections.length) continue; // every id in this group is either missing or already placed
    groupSections.forEach((section) => claimed.add(section.id));
    items.push({ kind: "group", id: group.id, title: group.title, sections: groupSections });
  }

  for (const section of sections) {
    if (!claimed.has(section.id)) items.push({ kind: "section", section });
  }

  return items;
}
