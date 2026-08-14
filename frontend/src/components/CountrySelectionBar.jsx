// What is currently highlighted, and the only place it gets cleared.
//
// A selection that survives panning, zooming and region changes (see
// selectCountryEntry in createMapController.js) needs somewhere that says so --
// otherwise a country highlighted five minutes ago and now off-screen is
// invisible state that quietly scopes the cities layer and the war flare.
//
// Each chip is also the way back: clicking one reopens that country's card,
// its × drops that country alone, and Clear drops the lot.
//
// Task 40: `onCompare` is optional (undefined for any caller that predates
// the comparison view, same "no-op when absent" rule this app's other
// optional props follow) -- when supplied, a "Compare" button appears once a
// second country joins the selection, since a comparison of one country is
// not a comparison. It stays offered past three: the cap and the "which ones
// got left out" note both live in countryCompareLogic.js's own
// selectCompareCountries, not here, so the bar does not need to duplicate
// that decision to know when to show its own entry point.
const MIN_TO_COMPARE = 2;

export default function CountrySelectionBar({ selection, focusedKey, onFocus, onRemove, onClear, onCompare }) {
  if (!selection.length) return null;

  return (
    <div id="countrySelection" role="group" aria-label="Selected countries">
      <span className="country-selection-label">
        {selection.length} selected
      </span>
      <div className="country-selection-chips">
        {selection.map((country) => (
          <span
            key={country.key}
            className={`country-chip${country.key === focusedKey ? " focused" : ""}`}
          >
            <button
              type="button"
              className="country-chip-name"
              onClick={() => onFocus(country.key)}
              title={`Show ${country.name}`}
            >
              {country.name}
            </button>
            <button
              type="button"
              className="country-chip-remove"
              onClick={() => onRemove(country.key)}
              aria-label={`Deselect ${country.name}`}
              title="Deselect"
            >
              &times;
            </button>
          </span>
        ))}
      </div>
      {onCompare && selection.length >= MIN_TO_COMPARE && (
        <button type="button" className="country-selection-compare" onClick={onCompare}>
          Compare
        </button>
      )}
      <button type="button" className="country-selection-clear" onClick={onClear}>
        Clear
      </button>
      {/* Stated once, here, rather than in a tooltip nobody opens: the modifier
          is the only part of multi-select that is not discoverable by trying. */}
      <span className="country-selection-hint">Ctrl/⇧-click the map to add</span>
    </div>
  );
}
