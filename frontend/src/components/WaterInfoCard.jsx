// The water-body configuration for PlaceInfoCard -- CountryInfoCard's sibling,
// same generalisation: everything about dragging, anchoring, the accordion and
// the delegated row-click handler already lives in PlaceInfoCard, so this only
// supplies what is genuinely water-only: which accordion storage key its folds
// persist under, and which section starts open. Section ids come from
// waterCardSections in map/popups.js.
//
// The border-edit button CountryInfoCard offers is a country concept
// (Admin Mode's boundary editor works on country polygons only), so water's
// own headerExtra carries nothing but Task 35's copy-link button.
import PlaceInfoCard from "./PlaceInfoCard";
import CopyLinkButton from "./CopyLinkButton";

const DEFAULT_OPEN = { profile: true };
const STORAGE_KEY = "osint-water-card-accordion";

export default function WaterInfoCard({ water, onClose, onOpenRecord, cardSettings, getShareUrl }) {
  // Recomputed every render rather than memoised, same reasoning
  // CountryInfoCard gives for its own `place`: a cheap object literal whose
  // only dependency is `water` itself.
  const place = water
    ? { id: water.id, title: water.name, subtitle: null, point: water.point, sections: water.sections }
    : null;

  return (
    <PlaceInfoCard
      place={place}
      onClose={onClose}
      onOpenRecord={onOpenRecord}
      accordionKey={STORAGE_KEY}
      defaultOpen={DEFAULT_OPEN}
      headerExtra={<CopyLinkButton getShareUrl={getShareUrl} />}
      panelId="waterInfoCard"
      cardType="water"
      cardSettings={cardSettings}
    />
  );
}
