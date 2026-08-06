// Persistent country details panel -- replaces the old Leaflet popup on
// country click (see createMapController.js's countriesLayer click
// handler) so the map keeps panning/zooming freely while it's open, instead
// of the popup auto-closing/panning on every interaction.
//
// Two things about how it is positioned:
//
//  * Until it is dragged it is a widget popping out of the clicked country --
//    `country.point` is that country's current on-screen pixel (kept live
//    across pan/zoom by onCountryPointChange, see useLeafletMap.js), and the
//    card centres itself above that point with a CSS arrow pointing back down
//    at it, clamped so a country near an edge doesn't push it off-screen.
//  * Once dragged it detaches: the reader has said where they want it, and a
//    card that crawled back over the map on the next pan would be fighting
//    them. The tail goes away with the anchoring, because it would then be
//    pointing at nothing.
//
// The body is a set of folds rather than one column of HTML (see
// countryCardSections in map/popups.js). Six subjects in a 320px card is more
// than fits on screen at once, and which of them matters is the reader's
// question, not ours -- so each one collapses on its own and the choice is
// remembered across countries and reloads.
import { useAccordion } from "../hooks/useAccordion";
import { useDraggablePanel } from "../hooks/useDraggablePanel";

const CARD_WIDTH = 320;
const CARD_MARGIN = 14;

// Identity and the live conflict tally open by default; everything else starts
// shut. Section ids come from countryCardSections.
const DEFAULT_OPEN = { profile: true, conflict: true };
const STORAGE_KEY = "osint-country-card-accordion";

export default function CountryInfoCard({ country, onClose, borderEdit }) {
  const { isOpen, setOpen } = useAccordion(DEFAULT_OPEN, STORAGE_KEY);
  const { panelRef, style: dragStyle, moved, handleProps } = useDraggablePanel("countryInfoCard");

  if (!country) return null;

  // Anchored positioning is only computed while the card still belongs to its
  // country. `point` can also be briefly absent (a country whose shape has not
  // been re-added after a boundary refresh), in which case the card falls back
  // to sitting where CSS puts it rather than vanishing.
  let anchorStyle;
  let flip = false;
  let tailLeft = null;
  if (!moved && country.point) {
    const { x, y } = country.point;
    const left = Math.min(
      Math.max(x - CARD_WIDTH / 2, CARD_MARGIN),
      window.innerWidth - CARD_WIDTH - CARD_MARGIN
    );
    tailLeft = Math.min(Math.max(x - left, 16), CARD_WIDTH - 16); // stays under the real anchor even after clamping
    flip = y < 220; // not enough room above the anchor near the top edge -- open downward instead
    anchorStyle = flip ? { left, top: y + 18 } : { left, bottom: window.innerHeight - y + 18 };
  }

  return (
    <aside
      id="countryInfoCard"
      ref={panelRef}
      className={`${flip ? "flip" : ""}${moved ? " detached" : ""}`}
      style={dragStyle || anchorStyle}
    >
      {/* handleProps carries its own className, so it is spread first and the
          two are merged by hand -- spreading it after `className` silently
          replaces the header's own class. */}
      <div {...handleProps} className={`country-info-header ${handleProps.className || ""}`}>
        <span className="country-info-name">{country.name}</span>
        {/* Deliberately inside the drag handle but with its own pointerdown
            guard: useDraggablePanel already ignores a press that starts on a
            button (its escape hatch lists button/a/input/select/textarea), so
            this stays clickable while the rest of the header still drags. */}
        {borderEdit?.offered && (
          <button
            type="button"
            className={`country-info-edit${borderEdit.active ? " active" : ""}`}
            onClick={borderEdit.active ? borderEdit.onEnd : borderEdit.onBegin}
            disabled={!borderEdit.active && !!borderEdit.blockedReason}
            title={borderEdit.blockedReason || "Drag this country's boundary"}
          >
            {borderEdit.active ? "Done" : "Edit border"}
          </button>
        )}
        <button type="button" className="country-info-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>

      <div className="country-info-body">
        {country.sections.map((section) => (
          <details
            key={section.id}
            className="country-section"
            open={isOpen(section.id)}
            onToggle={(e) => setOpen(section.id, e.currentTarget.open)}
          >
            <summary>{section.title}</summary>
            <div className="country-section-body" dangerouslySetInnerHTML={{ __html: section.html }} />
          </details>
        ))}
      </div>

      {tailLeft != null && <div className="country-info-tail" style={{ left: tailLeft }} />}
    </aside>
  );
}
