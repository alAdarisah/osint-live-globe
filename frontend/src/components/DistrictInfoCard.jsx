// The admin-2 (district) configuration for PlaceInfoCard. Everything about
// dragging, anchoring, the accordion and the delegated row-click handler
// lives in PlaceInfoCard, same as CountryInfoCard/WaterInfoCard/
// SubdivisionInfoCard; the one thing genuinely district-only is the month
// `<select>` that drives the conflict fold's record and its 24-month trend
// (map/popups.js's districtCardSections/buildDistrictConflict) -- the whole
// archive control now that the old Leaflet popup's month picker is gone.
//
// It rides in `headerExtra`, the same slot CountryInfoCard uses for its
// border-edit button: a real React element in the card's header, before the
// close button, rather than a string of HTML wired up after the fact the way
// the old popup's monthPickerHtml + bindDistrictMonthSelect had to be. That
// indirection existed only because a Leaflet popup's content is a DOM string
// with no React underneath it; a card has no such excuse.
import PlaceInfoCard from "./PlaceInfoCard";

const DEFAULT_OPEN = { profile: true, conflict: true };
const STORAGE_KEY = "osint-district-card-accordion";

export default function DistrictInfoCard({ district, onClose, onOpenRecord, onMonthChange }) {
  const place = district
    ? { id: district.pcode, title: district.name, subtitle: null, point: district.point, sections: district.sections }
    : null;

  // Omitted entirely when the months list has not arrived yet -- a selector
  // with one option nobody chose is furniture, same reasoning the old
  // monthPickerHtml gave for the same case.
  const months = district?.months || [];
  const headerExtra = months.length > 0 && (
    <label className="district-month">
      Month
      <select
        className="district-month-select"
        value={district.month || ""}
        onChange={(e) => onMonthChange(e.target.value)}
      >
        {months.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
    </label>
  );

  return (
    <PlaceInfoCard
      place={place}
      onClose={onClose}
      onOpenRecord={onOpenRecord}
      accordionKey={STORAGE_KEY}
      defaultOpen={DEFAULT_OPEN}
      headerExtra={headerExtra}
      panelId="districtInfoCard"
    />
  );
}
