// Task 31: which sections a country/water/state/district card shows, in
// what order, and whether each starts open -- see settings/cardSections.js
// for the section tables this renders and components/placeInfoCardGrouping.js's
// applyCardSettings for where a stored choice actually reaches the card.
//
// Reordering only ever moves a section within its card's own flat list. On
// the country card, "situation"/"country" are super-folds whose internal
// order comes from a fixed sectionIds list, not from this array's position
// (see placeInfoCardGrouping.js's groupSections) -- so the arrows here
// reorder the country card's own "meta" leftovers and every section on the
// water/subdivision/district cards (none of which use groups at all), but
// cannot reorder what a group already claims. Said once here rather than
// promising a control that would not move what it looks like it moves.
import { PanelGroup } from "../../controlPanel/Collapsible";
import { CheckField } from "../fields";
import { CARD_TYPES, CARD_SECTIONS, orderedCardSections } from "../../../settings/cardSections";

export const SEARCH_TERMS = [
  "Cards",
  "Section order",
  "Default fold state",
  ...CARD_TYPES.map((c) => c.label),
  ...Object.values(CARD_SECTIONS).flat().map((s) => s.title),
];

export default function CardsSection({ settings, actions, isOpen, onToggle }) {
  return (
    <PanelGroup id="adm-cards" title="Cards" open={isOpen("adm-cards")} onToggle={onToggle}>
      <div className="admin-note">
        Which folds appear on each card, in what order, and whether a fold starts open the first
        time a reader sees it -- a reader's own later clicks on an already-open card are still
        remembered separately (see hooks/useAccordion.js) and are not reset by anything here.
      </div>
      {CARD_TYPES.map((cardType) => (
        <CardTypeBlock
          key={cardType.key}
          cardType={cardType}
          settings={settings}
          actions={actions}
          open={isOpen(`adm-card-${cardType.key}`)}
          onToggle={onToggle}
        />
      ))}
    </PanelGroup>
  );
}

function CardTypeBlock({ cardType, settings, actions, open, onToggle }) {
  const titleFor = Object.fromEntries((CARD_SECTIONS[cardType.key] || []).map((s) => [s.id, s.title]));
  const hidden = new Set(settings.cards.hidden[cardType.key] || []);
  const order = orderedCardSections(cardType.key, settings.cards.order[cardType.key]);
  const defaultOpen = settings.cards.defaultOpen[cardType.key] || {};

  return (
    <details
      className="admin-layer-block"
      open={open}
      onToggle={(e) => onToggle(`adm-card-${cardType.key}`, e.currentTarget.open)}
    >
      <summary className="admin-layer-summary">
        <span className="admin-layer-name">{cardType.label}</span>
      </summary>
      <div className="admin-layer-body">
        <button type="button" className="admin-wide-btn" onClick={() => actions.resetCardSettings(cardType.key)}>
          Reset to shipped order
        </button>
        <table className="admin-cards-table">
          <thead>
            <tr>
              <th>Section</th>
              <th>Shown</th>
              <th>Order</th>
              <th>Starts open</th>
            </tr>
          </thead>
          <tbody>
            {order.map((id, i) => (
              <tr key={id}>
                <td>{titleFor[id] || id}</td>
                <td>
                  <CheckField
                    label=""
                    checked={!hidden.has(id)}
                    onChange={(checked) => actions.setCardSectionHidden(cardType.key, id, !checked)}
                  />
                </td>
                <td className="admin-cards-order-cell">
                  <button
                    type="button"
                    disabled={i === 0}
                    aria-label={`Move ${titleFor[id] || id} up`}
                    onClick={() => actions.moveCardSection(cardType.key, order, id, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={i === order.length - 1}
                    aria-label={`Move ${titleFor[id] || id} down`}
                    onClick={() => actions.moveCardSection(cardType.key, order, id, 1)}
                  >
                    ↓
                  </button>
                </td>
                <td>
                  <CheckField
                    label=""
                    checked={defaultOpen[id] === true}
                    onChange={(checked) =>
                      actions.setCardSectionDefaultOpen(cardType.key, id, checked ? true : null)
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
