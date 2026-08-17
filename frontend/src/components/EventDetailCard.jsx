// One record, in full, opened from a row in the country card.
//
// The country card lists a country's recent events three lines at a time --
// enough to say something happened, not enough to say what or who reported it.
// That was the whole of the answer available without hunting for the matching
// pin on the map, which for a country-scoped row is a search the reader has no
// way to narrow.
//
// The body is resolved through the map controller's recordDetail(). For every
// kind except fused conflict/violence ("events") that is identical to what
// clicking the pin would show -- the outlet and its reliability band, how the
// coordinate was arrived at, who corroborated it, the caveats the feed
// carries -- and writing a second renderer for "the details and the source"
// would be a second opinion about one record, so this stays a single
// dangerouslySetInnerHTML render for those.
//
// "events" gets a real card instead (see map/eventDetail.js): six blocks --
// header, corroboration, reliability, geolocation, nearby infrastructure,
// actions -- built straight off the fused record's own fields rather than the
// summary decorateEvent writes for the map's hover popup. Still one HTML
// string from recordDetail(), so this component only needs a modifier class
// to give the blocks room; the render path itself does not fork.
import { useEffect } from "react";
import { useDraggablePanel } from "../hooks/useDraggablePanel";
import CopyLinkButton from "./CopyLinkButton";

export default function EventDetailCard({ detail, onClose, getShareUrl }) {
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
        {/* "Record detail", not "Event detail": this card opens for a ship, an
            aircraft, a fire or an official statement as readily as for a fused
            event, and it spent its whole life showing the event wording for all
            of them because detail.title was always null (see recordCardTitle).
            Reached only by a record that carries nothing naming it. */}
        <span className="event-detail-title">{detail.title || "Record detail"}</span>
        {/* Only offered when the record has a coordinate. A country-scoped feed
            can carry rows that never earned one, and a button that flies the map
            to `undefined` is worse than no button. */}
        {detail.onLocate && (
          <button type="button" className="event-detail-locate" onClick={detail.onLocate}>
            Show on map
          </button>
        )}
        {/* Task 35: this record's own kind/id (a ship, an aircraft, a fused
            event...) is not one urlState.js carries -- see its own note on
            why -- so this copies the view underneath the card, not a link
            back to this exact record. CopyLinkButton's title text says so. */}
        <CopyLinkButton getShareUrl={getShareUrl} />
        <button type="button" className="event-detail-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>
      {/* Same `dangerouslySetInnerHTML` contract the country card already works
          under: escaped values assembled server-side of React (see esc() in
          utils/format.js) -- the map's own popup HTML for every kind but
          "events", map/eventDetail.js's six-block card for that one. The
          modifier class only changes spacing/borders for the block markup;
          it does not change how this is rendered. */}
      <div
        className={`event-detail-body${detail.kind === "events" ? " event-detail-body-rich" : ""}`}
        dangerouslySetInnerHTML={{ __html: detail.html }}
      />
    </aside>
  );
}
