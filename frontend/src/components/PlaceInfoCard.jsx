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
import { currentChromeInsets } from "../hooks/useChromeLayout";
import { groupSections, applyCardSettings, reorderGroups } from "./placeInfoCardGrouping";

// The accordion-id namespace a super-fold's own open/closed state is stored
// under (see useAccordion.js) -- exported so a caller supplying `groups` can
// mark a super-fold open by default (defaultOpen) using the same key this
// component reads back. Section ids are always plain words (see
// countryCardSections/waterCardSections in map/popups.js), so this prefix can
// never collide with one.
export const GROUP_ACCORDION_PREFIX = "group:";

// One <details> fold for one section, however it got here -- flat, or nested
// inside a super-fold's own <details>. Pulled out to a module-scope function
// (rather than inlined at each of the three call sites this component ends
// up needing it from) so the no-groups branch below produces the exact same
// JSX tree it always has: `groups` and `summary` are both optional, and
// without them this component renders exactly as it did before either prop
// existed -- see this file's own note on `panelId` for the precedent.
function renderSectionFold(section, isOpen, setOpen) {
  return (
    <details
      key={section.id}
      className="country-section"
      open={isOpen(section.id)}
      onToggle={(e) => setOpen(section.id, e.currentTarget.open)}
    >
      <summary>{section.title}</summary>
      <div className="country-section-body" dangerouslySetInnerHTML={{ __html: section.html }} />
    </details>
  );
}

// One stat chip in the summary strip. `tile.unavailable` tiles show a dash
// rather than a fabricated zero, with the reason in the same `title`
// attribute a native tooltip already reads on hover -- see summaryTiles in
// map/popups.js for how each tile decides which it is.
function renderSummaryTile(tileData) {
  return (
    <span
      key={tileData.key}
      className={`csummary-tile${tileData.unavailable ? " unavailable" : ""}`}
      title={tileData.unavailable ? tileData.tooltip : undefined}
    >
      <span className="csummary-v">{tileData.unavailable ? "—" : tileData.value}</span>
      <span className="csummary-l">{tileData.label}</span>
    </span>
  );
}

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
 * @param {string} [props.panelId]  the DOM id and drag-position storage key
 *   (useDraggablePanel) this instance uses. Defaults to "countryInfoCard",
 *   the id this panel has always used, so CountryInfoCard -- the one caller
 *   that predates this prop -- is unaffected by its addition. Task 7 (the
 *   water body card) is the second real place kind this component grew to
 *   serve, and two of them can genuinely be open at once (a country selected
 *   and a nearby sea also clicked), so each surface needs its own id: one DOM
 *   element cannot legally carry the same id twice, and sharing a drag-storage
 *   key would make dragging one card silently move the other's stored
 *   position too. The visual rules stay shared rather than forked -- see
 *   style.css's own note where `#countryInfoCard, #waterInfoCard` appears.
 * @param {Array<{key, label, value, unavailable, tooltip}>} [props.summary]
 *   compact stat tiles rendered above the folds (Task 10's summaryTiles,
 *   map/popups.js). Optional, following the same rule panelId set: omitted
 *   entirely, nothing renders where the strip would go, so WaterInfoCard
 *   (which supplies no summary) is unaffected by its addition.
 * @param {Array<{id, title, sectionIds: string[]}>} [props.groups]  folds
 *   `sections` into super-folds instead of one flat list (Task 10). Optional,
 *   same rule again: without it this component renders every section flat,
 *   exactly as it always has -- see groupSections in placeInfoCardGrouping.js
 *   for what happens to a section id no group claims.
 * @param {string} [props.cardType]  which entry of settings/cardSections.js's
 *   CARD_SECTIONS this is ("country"/"water"/"subdivision"/"district") --
 *   paired with `cardSettings` below, see applyCardSettings in
 *   placeInfoCardGrouping.js. Optional, same "no-op when absent" rule: a
 *   caller supplying neither renders exactly as it always has.
 * @param {object} [props.cardSettings]  settings.cards (Task 31's Cards
 *   admin section) -- which sections this card type hides, their order, and
 *   a per-section defaultOpen override.
 */
export default function PlaceInfoCard({
  place,
  onClose,
  onOpenRecord,
  accordionKey,
  defaultOpen,
  footer,
  headerExtra,
  panelId = "countryInfoCard",
  summary,
  groups,
  cardType,
  cardSettings,
}) {
  // Task 31: a stored hide/reorder/default-fold choice, applied to this
  // card's real (already data-filtered) sections before anything else below
  // reads `place.sections` -- groupSections, the fold list, and the
  // accordion's own defaultOpen all have to agree on the same, already-
  // adjusted list, which is why this runs once here rather than being
  // threaded into each of those three separately.
  const { sections: adjustedSections, defaultOpen: cardDefaultOpen } = place
    ? applyCardSettings(place.sections, cardType, cardSettings)
    : { sections: [], defaultOpen: {} };
  const effectiveDefaultOpen = { ...defaultOpen, ...cardDefaultOpen };
  // The review fix for the Critical: a group's own internal order (Task 10's
  // `groups`, e.g. COUNTRY_CARD_GROUPS) follows the same stored order the
  // flat list above was just sorted by, not just its own fixed sectionIds --
  // see reorderGroups' own docstring in placeInfoCardGrouping.js for why
  // that was needed at all.
  const adjustedGroups = reorderGroups(groups, cardType ? cardSettings?.order?.[cardType] : null);
  const { isOpen, setOpen } = useAccordion(effectiveDefaultOpen, accordionKey);
  const { panelRef, style: dragStyle, moved, handleProps } = useDraggablePanel(panelId);

  if (!place) return null;

  // Anchored positioning is only computed while the card still belongs to its
  // place. `point` can also be briefly absent (e.g. a country whose shape has
  // not been re-added after a boundary refresh), in which case the card falls
  // back to sitting where CSS puts it rather than vanishing.
  // The chrome insets go in as well as the viewport: the card is drawn below the
  // top bars in the stacking order, so a position computed from the window alone
  // put its header -- the name, Copy link, and the × -- behind them. See
  // placeInfoCardLayout.js.
  const layout = !moved
    ? computeAnchorLayout(
      place.point,
      { width: window.innerWidth, height: window.innerHeight },
      currentChromeInsets(),
    )
    : null;
  const anchorStyle = layout?.anchorStyle;
  const flip = !!layout?.flip;
  const tailLeft = layout ? layout.tailLeft : null;

  return (
    <aside
      id={panelId}
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
        {summary && summary.length > 0 && (
          <div className="country-info-summary">{summary.map(renderSummaryTile)}</div>
        )}

        {adjustedGroups && adjustedGroups.length > 0
          ? groupSections(adjustedSections, adjustedGroups).map((item) => (
              item.kind === "group" ? (
                // Namespaced under GROUP_ACCORDION_PREFIX so this can never
                // collide with a section id in the same accordionKey's stored
                // state -- see that constant's own note above.
                <details
                  key={item.id}
                  className="country-super-fold"
                  open={isOpen(`${GROUP_ACCORDION_PREFIX}${item.id}`)}
                  onToggle={(e) => setOpen(`${GROUP_ACCORDION_PREFIX}${item.id}`, e.currentTarget.open)}
                >
                  <summary>{item.title}</summary>
                  <div className="country-super-fold-body">
                    {item.sections.map((section) => renderSectionFold(section, isOpen, setOpen))}
                  </div>
                </details>
              ) : (
                renderSectionFold(item.section, isOpen, setOpen)
              )
            ))
          : adjustedSections.map((section) => renderSectionFold(section, isOpen, setOpen))}
      </div>

      {footer}

      {tailLeft != null && <div className="country-info-tail" style={{ left: tailLeft }} />}
    </aside>
  );
}
