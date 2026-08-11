// Shared shell for the vessel and aircraft filter bars (Task 18). Both need
// exactly the same three things -- a text box, a match/total count, and a
// one-click clear -- and differ only in which extra boolean toggles they
// offer (sanctioned/watchlisted for ships, military-only for aircraft), which
// the caller supplies as children rather than this component knowing about
// either domain.
//
// Deliberately not the same element as the existing infra-filter-input
// (LayersSection.jsx's Critical Infrastructure search): that one has no
// match/total readout and nothing to clear-in-one-click, and bolting both
// onto it would have meant a conditional prop for every layer that doesn't
// want them.
export default function FilterBar({ text, onTextChange, matched, total, placeholder, children }) {
  return (
    <div className="entity-filter-bar">
      <div className="entity-filter-row">
        <input
          type="text"
          className="entity-filter-input"
          placeholder={placeholder}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
        />
        {/* One click: an empty string is the filter's own "match everything"
            state (see entityFilter.js's matchQuery), so clearing needs no
            separate branch from typing an empty query by hand. */}
        {text && (
          <button
            type="button"
            className="entity-filter-clear"
            onClick={() => onTextChange("")}
            aria-label="Clear filter"
          >
            &times;
          </button>
        )}
      </div>
      {children}
      <div className="sublegend entity-filter-count">
        {matched} / {total} match
      </div>
    </div>
  );
}
