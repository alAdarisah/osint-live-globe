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
  // names its id, (b) the same id repeated within one group's own
  // sectionIds is only placed once, and (c) the final ungrouped pass knows
  // what is left. (b) is why this has to be a single pass that claims each
  // id the moment it is accepted, rather than a map+filter over the whole
  // group followed by one claim pass at the end -- the latter checks every
  // id in a group against the *same* stale `claimed` snapshot, so two
  // occurrences of "a" in one group's own sectionIds would both pass the
  // filter and render the same section twice with a duplicate React key.
  const claimed = new Set();
  const items = [];

  for (const group of groups) {
    const groupSections = [];
    for (const id of group.sectionIds || []) {
      const section = byId.get(id);
      if (!section || claimed.has(section.id)) continue; // missing, or already placed -- by this group or an earlier one
      claimed.add(section.id);
      groupSections.push(section);
    }
    if (!groupSections.length) continue; // every id in this group was either missing or already placed
    items.push({ kind: "group", id: group.id, title: group.title, sections: groupSections });
  }

  for (const section of sections) {
    if (!claimed.has(section.id)) items.push({ kind: "section", section });
  }

  return items;
}
