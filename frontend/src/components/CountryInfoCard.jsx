// The country-specific configuration for PlaceInfoCard: which accordion
// storage key this surface persists its folds under, which sections start
// open, and the one piece of header UI that is genuinely country-only (the
// border-edit button, offered only in Admin Mode -- see AdminPanel.jsx).
//
// Everything else -- the drag/anchor behaviour, the accordion mechanics, the
// delegated row-click handler, the close button -- lives in PlaceInfoCard
// now, shared with the water-body, admin-1 state and admin-2 district cards
// still to come. See createMapController.js's countriesLayer
// click handler for why this replaced the old Leaflet popup in the first
// place: the map keeps panning/zooming freely while it's open, instead of
// the popup auto-closing/panning on every interaction.
import PlaceInfoCard, { GROUP_ACCORDION_PREFIX } from "./PlaceInfoCard";

// Identity and the live conflict tally open by default; everything else starts
// shut. Section ids come from countryCardSections in map/popups.js.
//
// The "situation"/"country" super-folds (COUNTRY_CARD_GROUPS, same module)
// also start open, because each one wraps a section already listed above --
// leaving a super-fold's own default closed would hide profile/conflict
// behind a second click nobody asked for, the moment Task 10 wrapped them.
// "meta" wraps none of the sections defaulted open here, so it starts closed
// like every plain section does.
const DEFAULT_OPEN = {
  profile: true,
  conflict: true,
  [`${GROUP_ACCORDION_PREFIX}situation`]: true,
  [`${GROUP_ACCORDION_PREFIX}country`]: true,
};
const STORAGE_KEY = "osint-country-card-accordion";

export default function CountryInfoCard({ country, onClose, borderEdit, onOpenRecord, cardSettings }) {
  // `place` is recomputed every render rather than memoised: it is a cheap
  // object literal, and memoising it would need a dependency list that is
  // just `country` anyway, since that's the only thing it's built from.
  const place = country
    ? { id: country.key, title: country.name, subtitle: null, point: country.point, sections: country.sections }
    : null;

  const headerExtra = borderEdit?.offered && (
    <button
      type="button"
      className={`country-info-edit${borderEdit.active ? " active" : ""}`}
      onClick={borderEdit.active ? borderEdit.onEnd : borderEdit.onBegin}
      disabled={!borderEdit.active && !!borderEdit.blockedReason}
      title={borderEdit.blockedReason || "Drag this country's boundary"}
    >
      {borderEdit.active ? "Done" : "Edit border"}
    </button>
  );

  return (
    <PlaceInfoCard
      place={place}
      onClose={onClose}
      onOpenRecord={onOpenRecord}
      accordionKey={STORAGE_KEY}
      defaultOpen={DEFAULT_OPEN}
      headerExtra={headerExtra}
      summary={country?.summary}
      groups={country?.groups}
      cardType="country"
      cardSettings={cardSettings}
    />
  );
}
