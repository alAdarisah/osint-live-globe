// The admin-1 (state/province) configuration for PlaceInfoCard -- WaterInfoCard's
// sibling and just as thin: everything about dragging, anchoring, the
// accordion and the delegated row-click handler already lives in
// PlaceInfoCard, so this only supplies which accordion storage key its folds
// persist under, which section starts open, and its own `panelId` so it can
// stand next to a country or water card rather than fight either for the same
// DOM id and drag-position storage key. Section ids come from
// subdivisionCardSections in map/popups.js.
import PlaceInfoCard from "./PlaceInfoCard";

const DEFAULT_OPEN = { profile: true, conflict: true };
const STORAGE_KEY = "osint-subdivision-card-accordion";

export default function SubdivisionInfoCard({ subdivision, onClose, onOpenRecord }) {
  // Recomputed every render rather than memoised, same reasoning
  // CountryInfoCard/WaterInfoCard give for their own `place`: a cheap object
  // literal whose only dependency is `subdivision` itself.
  const place = subdivision
    ? { id: subdivision.key, title: subdivision.name, subtitle: null, point: subdivision.point, sections: subdivision.sections }
    : null;

  return (
    <PlaceInfoCard
      place={place}
      onClose={onClose}
      onOpenRecord={onOpenRecord}
      accordionKey={STORAGE_KEY}
      defaultOpen={DEFAULT_OPEN}
      panelId="subdivisionInfoCard"
    />
  );
}
