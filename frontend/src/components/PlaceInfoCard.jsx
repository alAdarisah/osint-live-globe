// The persistent, draggable floating card for "the reader clicked a place" --
// generalised out of what was CountryInfoCard so the water-body, admin-1
// state and admin-2 district cards (all coming later) can each supply their
// own data and skip re-deriving the drag/anchor dance, the accordion and the
// record-row delegation a fourth, fifth and sixth time. CountryInfoCard is
// now the thin country-specific wrapper around this.
//
// Two things about how it is positioned:
//
//  * Until it is dragged it is a widget popping out of the clicked place --
//    `place.point` is that place's current on-screen pixel (kept live across
//    pan/zoom by the caller, e.g. onCountryPointChange in useLeafletMap.js),
//    and the card centres itself above that point with a CSS arrow pointing
//    back down at it, clamped so a place near an edge doesn't push it
//    off-screen. See placeInfoCardLayout.js for the arithmetic.
//  * Once dragged it detaches: the reader has said where they want it, and a
//    card that crawled back over the map on the next pan would be fighting
//    them. The tail goes away with the anchoring, because it would then be
//    pointing at nothing.
//
// The body is a set of folds rather than one column of HTML -- six subjects
// in a 320px card is more than fits on screen at once, and which of them
// matters is the reader's question, not ours -- so each one collapses on its
// own and the choice is remembered across places and reloads, under whatever
// `accordionKey` the caller passes (each surface -- country, water body,
// state, district -- gets its own key, so their folds cannot collide).
import { useAccordion } from "../hooks/useAccordion";
import { useDraggablePanel } from "../hooks/useDraggablePanel";
import { computeAnchorLayout } from "./placeInfoCardLayout";

/**
 * Turn a click anywhere in the card body into "open this record", or nothing.
 *
 * Delegated rather than bound per row because the sections are raw HTML
 * strings (built server-side of the accordion, e.g. countryCardSections in
 * map/popups.js) and cannot carry React handlers. The two data attributes
 * are put there by whichever section builder produced the row.
 */
function recordClickHandler(onOpenRecord) {
  return (event) => {
    // A headline in a news row is a real link to the article -- that is the
    // citation, and it has to keep working as a link, including middle-click
    // and open-in-new-tab. Only a click that missed it opens the card.
    if (event.target.closest("a")) return;
    const row = event.target.closest("[data-event-id]");
    if (!row) return;
    onOpenRecord(row.dataset.eventKind, row.dataset.eventId);
  };
}

/**
 * @param {object} props
 * @param {{id: string, title: string, subtitle?: string, point: {x:number,y:number}|null,
 *   sections: {id: string, title: string, html: string}[]}|null} props.place
 * @param {() => void} props.onClose
 * @param {(kind: string, id: string) => void} props.onOpenRecord
 * @param {string} props.accordionKey     which surface's folds these are (see useAccordion)
 * @param {Record<string, boolean>} props.defaultOpen  section id -> open when nothing is stored
 * @param {import("react").ReactNode} [props.footer]       rendered below the sections, above the tail
 * @param {import("react").ReactNode} [props.headerExtra]  rendered in the header, before the close button
 */
export default function PlaceInfoCard({
  place,
  onClose,
  onOpenRecord,
  accordionKey,
  defaultOpen,
  footer,
  headerExtra,
}) {
  const { isOpen, setOpen } = useAccordion(defaultOpen, accordionKey);
  // "countryInfoCard" is the DOM id and drag-position storage key this panel
  // has always used, kept literally rather than derived from `place` so this
  // extraction is a pure move with no visible or stored-state change for the
  // one caller that exists today (CountryInfoCard). It is also the id every
  // `#countryInfoCard`/`.country-info-*`/`.country-section*` rule in
  // style.css targets -- renaming it here without a matching CSS pass would
  // silently break the card's whole layout. When a second real place kind
  // (water body, state, district) needs its own look, that task should
  // decide the naming scheme for all of them together, CSS included, rather
  // than this one guessing at it now.
  const { panelRef, style: dragStyle, moved, handleProps } = useDraggablePanel("countryInfoCard");

  if (!place) return null;

  // Anchored positioning is only computed while the card still belongs to its
  // place. `point` can also be briefly absent (e.g. a country whose shape has
  // not been re-added after a boundary refresh), in which case the card falls
  // back to sitting where CSS puts it rather than vanishing.
  const layout = !moved ? computeAnchorLayout(place.point, { width: window.innerWidth, height: window.innerHeight }) : null;
  const anchorStyle = layout?.anchorStyle;
  const flip = !!layout?.flip;
  const tailLeft = layout ? layout.tailLeft : null;

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
        <span className="country-info-name">{place.title}</span>
        {place.subtitle && <span className="country-info-subtitle">{place.subtitle}</span>}
        {/* Deliberately inside the drag handle but with its own pointerdown
            guard: useDraggablePanel already ignores a press that starts on a
            button (its escape hatch lists button/a/input/select/textarea), so
            this stays clickable while the rest of the header still drags. */}
        {headerExtra}
        <button type="button" className="country-info-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>

      {/* Keyboard reaches the rows through their own role="button"/tabindex, so
          the same delegation answers Enter and Space. */}
      <div
        className="country-info-body"
        onClick={recordClickHandler(onOpenRecord)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          if (!event.target.closest?.("[data-event-id]")) return;
          event.preventDefault();
          recordClickHandler(onOpenRecord)(event);
        }}
      >
        {place.sections.map((section) => (
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

      {footer}

      {tailLeft != null && <div className="country-info-tail" style={{ left: tailLeft }} />}
    </aside>
  );
}
