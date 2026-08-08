// One record, in full, opened from a row in the country card.
//
// The country card lists a country's recent events three lines at a time --
// enough to say something happened, not enough to say what or who reported it.
// That was the whole of the answer available without hunting for the matching
// pin on the map, which for a country-scoped row is a search the reader has no
// way to narrow.
//
// The body is the record's own pin detail, resolved through the map controller's
// recordDetail() and therefore identical to what clicking the pin would show:
// the outlet and its reliability band, how the coordinate was arrived at, who
// corroborated it, and the caveats the feed carries. Writing a second renderer
// for "the details and the source" would be a second opinion about one record,
// and the two would drift the first time either changed.
import { useEffect } from "react";
import { useDraggablePanel } from "../hooks/useDraggablePanel";

export default function EventDetailCard({ detail, onClose }) {
  // Escape closes it. Registered here rather than on the card so it works
  // without the card having taken focus -- this opens from a click on a row in
  // another panel, and focus is still over there.
  useEffect(() => {
    if (!detail) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, onClose]);

  const { panelRef, style, handleProps } = useDraggablePanel("eventDetailCard");

  if (!detail) return null;

  return (
    <aside id="eventDetailCard" ref={panelRef} style={style} role="dialog" aria-label="Event detail">
      <div {...handleProps} className={`event-detail-header ${handleProps.className || ""}`}>
        <span className="event-detail-title">{detail.title || "Event detail"}</span>
        {/* Only offered when the record has a coordinate. A country-scoped feed
            can carry rows that never earned one, and a button that flies the map
            to `undefined` is worse than no button. */}
        {detail.onLocate && (
          <button type="button" className="event-detail-locate" onClick={detail.onLocate}>
            Show on map
          </button>
        )}
        <button type="button" className="event-detail-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>
      {/* Same `dangerouslySetInnerHTML` contract the country card already works
          under: this is the map's own popup HTML, built by the decorators from
          escaped values (see esc() in utils/format.js). */}
      <div className="event-detail-body" dangerouslySetInnerHTML={{ __html: detail.html }} />
    </aside>
  );
}
