// Task 31: which sections a PlaceInfoCard-based card can show, in the order
// it ships them -- the table CardsSection.jsx offers hide/reorder/default-
// fold controls against, and applyCardSettings (in
// components/placeInfoCardGrouping.js) applies a stored choice to.
//
// Restated by hand from map/popups.js's own countryCardSections/
// waterCardSections/subdivisionCardSections/districtCardSections rather than
// generated from them, the same relationship LayersSection.jsx's GROUP_LAYERS
// has with SETTINGS_LAYERS (frontend/src/components/admin/sections/shared.jsx
// says so explicitly for that table): each of those four functions builds its
// section list inline, keyed off live data, with a section carrying no html
// dropped before it ever reaches a card -- there is no static list on that
// side for an admin table to import instead of restating. A section id this
// table does not know is never hidden and never moved (see
// placeInfoCardGrouping.js's own groupSections, which applies the identical
// "unclaimed id survives" rule to a card's super-fold groups).
//
// Country's own super-folds (COUNTRY_CARD_GROUPS, same module) are not
// represented here: reordering only ever moves a section within its group's
// own fixed sectionIds order, or among the sections no group claims (see
// groupSections), so an admin-set order changes what a reader sees for the
// water/subdivision/district cards (which use no groups) and for country's
// own "meta" leftovers, but not the situation/country groups' internal
// order -- CardsSection.jsx says so in its own note rather than promising a
// control that would not move what it looks like it moves.
export const CARD_TYPES = [
  { key: "country", label: "Country" },
  { key: "water", label: "Water body" },
  { key: "subdivision", label: "State / province" },
  { key: "district", label: "District" },
];

export const CARD_SECTIONS = {
  country: [
    { id: "profile", title: "Country profile" },
    { id: "conflict", title: "Conflict · last 72h" },
    { id: "live", title: "Live picture · in/near country" },
    { id: "satellitePasses", title: "Satellite overpasses" },
    { id: "connectivity", title: "Internet connectivity" },
    { id: "humanitarian", title: "Displacement & food security" },
    { id: "power", title: "Cross-border electricity" },
    { id: "energy", title: "Energy infrastructure" },
    { id: "gridStress", title: "Grid stress" },
    { id: "military", title: "Military & security" },
    { id: "transport", title: "Transport" },
    { id: "food", title: "Food balance & prices" },
    { id: "verified", title: "Verified record" },
    { id: "trend", title: "Fatality trend" },
    { id: "events", title: "Recent events" },
    { id: "sources", title: "Sources & caveats" },
    { id: "coverage", title: "Data coverage" },
  ],
  water: [
    { id: "profile", title: "Water body" },
    { id: "satellitePasses", title: "Satellite overpasses" },
    { id: "traffic", title: "Traffic now" },
    { id: "dark", title: "Dark activity" },
    { id: "chokepoint", title: "Chokepoint watch" },
    { id: "infrastructure", title: "Infrastructure" },
    { id: "incidents", title: "Incidents" },
    { id: "sources", title: "Sources & caveats" },
  ],
  subdivision: [
    { id: "profile", title: "State profile" },
    { id: "conflict", title: "Conflict · last 72h" },
    { id: "cities", title: "Cities" },
    { id: "live", title: "Live picture" },
    { id: "infrastructure", title: "Infrastructure" },
    { id: "connectivity", title: "Connectivity" },
    { id: "coverage", title: "Data coverage" },
  ],
  district: [
    { id: "profile", title: "District profile" },
    { id: "conflict", title: "Conflict record" },
    { id: "cities", title: "Cities" },
    { id: "live", title: "Live picture" },
    { id: "infrastructure", title: "Infrastructure" },
    { id: "connectivity", title: "Connectivity" },
    { id: "coverage", title: "Data coverage" },
  ],
};

/**
 * A card type's shipped section ids, with a stored order applied.
 *
 * A full sequence, the same contract layerStack keeps in settings/defaults.js:
 * a stored order missing an id that has since shipped just means that id was
 * not there to record when it was saved, so it is appended at the end rather
 * than dropped.
 */
export function orderedCardSections(cardType, order) {
  const shipped = (CARD_SECTIONS[cardType] || []).map((s) => s.id);
  if (!Array.isArray(order) || !order.length) return shipped;
  const known = new Set(shipped);
  const seen = new Set();
  const result = [];
  for (const id of order) {
    if (typeof id === "string" && known.has(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  for (const id of shipped) if (!seen.has(id)) result.push(id);
  return result;
}
