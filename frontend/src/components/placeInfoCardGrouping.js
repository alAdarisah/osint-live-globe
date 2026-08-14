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

/**
 * Task 31's Cards admin section, applied to one card's real (already
 * data-filtered) section list.
 *
 * Returns the sections to actually render, in the stored order, plus a
 * defaultOpen patch to merge over the card's own shipped DEFAULT_OPEN.
 * Pulled out here rather than inlined in PlaceInfoCard.jsx for the same
 * reason groupSections above is: a pure function of plain data that
 * placeInfoCard.test.js can exercise under `node --test`, which cannot
 * import JSX at all.
 *
 * `cardSettings` is `settings.cards` (see settings/defaults.js) or
 * undefined -- PlaceInfoCard.jsx's callers that predate this task pass
 * neither `cardType` nor `cardSettings`, and this returns `sections`
 * untouched in that case, the same "optional prop, no-op when absent" rule
 * `groups`/`summary` already follow on that component.
 *
 * Reordering the flat list here is only half the picture for a card that
 * uses `groups` (Task 10's super-folds, e.g. COUNTRY_CARD_GROUPS): see
 * reorderGroups below, which PlaceInfoCard.jsx calls on `groups` itself so a
 * group's own internal order follows the same stored choice this function
 * applies to the ungrouped remainder.
 */
export function applyCardSettings(sections, cardType, cardSettings) {
  if (!cardType || !cardSettings) return { sections, defaultOpen: {} };
  const hidden = new Set(cardSettings.hidden?.[cardType] || []);
  const visible = sections.filter((s) => !hidden.has(s.id));

  const order = cardSettings.order?.[cardType];
  const ordered = Array.isArray(order) && order.length ? sortByOrder(visible, order, (s) => s.id) : visible;

  return { sections: ordered, defaultOpen: cardSettings.defaultOpen?.[cardType] || {} };
}

/**
 * `items`, sorted by each one's position in `order` (via `keyFn`). An item
 * `order` never mentions -- added since the order was saved, or (for
 * reorderGroups below) an id a group does not claim -- sorts after
 * everything `order` does name, the same "unknown id appended at the end"
 * repair settings/cardSections.js's own orderedCardSections applies to the
 * id list this acts on. Shared by applyCardSettings above and reorderGroups
 * below so the two have exactly one comparator between them to agree on.
 */
function sortByOrder(items, order, keyFn = (x) => x) {
  return [...items].sort((a, b) => {
    const ia = order.indexOf(keyFn(a));
    const ib = order.indexOf(keyFn(b));
    return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
  });
}

/**
 * `groups`, with each group's own `sectionIds` re-sorted by `order`.
 *
 * The Task 31 review's Critical: groupSections above places a group's
 * contents in that group's own fixed `sectionIds` sequence, never in
 * `sections`' array position -- so a stored Cards-section order changed
 * nothing for a card whose groups between them claim every section id. The
 * country card is exactly that case (COUNTRY_CARD_GROUPS' situation/
 * country/meta cover all seventeen of countryCardSections' own ids, see
 * map/popups.js), which made every Order arrow on the one card type most
 * likely to want reordering silently do nothing.
 *
 * This is what makes the arrows real for that card: PlaceInfoCard.jsx calls
 * it on `groups` before handing them to groupSections, so a group's
 * internal order follows the reader's own stored choice once one exists.
 *
 * Returns `groups` unchanged (the same reference, not a copy) when there is
 * no stored order to apply -- an additive capability, not a behaviour
 * change for a card nobody has touched a Cards admin control for. Ids a
 * group does not claim are irrelevant to it and sort to the end of that
 * group's own list, harmlessly, since groupSections only ever reads the ids
 * it already knows to look for.
 */
export function reorderGroups(groups, order) {
  if (!groups || !Array.isArray(order) || !order.length) return groups;
  return groups.map((group) => ({ ...group, sectionIds: sortByOrder(group.sectionIds || [], order) }));
}
