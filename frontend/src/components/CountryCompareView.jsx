// Task 40: put two or three selected countries' numbers next to each other so
// they can actually be compared.
//
// This is deliberately not a third or fourth copy of PlaceInfoCard. That
// component is a single anchored, draggable 320px column built for one
// place's own folds -- three of them side by side would mean three
// independent floating cards a reader has to manually line up, each one too
// narrow to hold an aligned numeric column, and none of them able to show
// "these two numbers differ" without a reader mentally cross-referencing
// between windows. A comparison is one question ("how do these countries'
// own numbers stack up"), not three places' worth of folds, so it gets one
// wide, centred table instead: a shape nothing else in this app currently
// uses, chosen because nothing else in this app currently needs it.
//
// All the row-building, status vocabulary and on-screen wording live in
// countryCompareLogic.js, a plain-JS sibling module, for the same reason
// every other *PanelLogic.js module in this directory does: this file is
// JSX, and the project's headless test suite (`node --test`, no build step)
// cannot import it at all -- see frontend/tests/countryCompare.test.js.
import { useEffect, useState } from "react";
import {
  CELL_STATUS, COMPARE_COVERAGE_CAVEAT, MIN_COMPARE_COUNTRIES, labelFor, needMoreCountriesNote, truncationNote,
} from "./countryCompareLogic";

// Recomputed on an interval rather than pushed by the controller (see
// countryCompareRows in map/createMapController.js for why this view is a
// pull, not a subscription) -- long enough not to fight a reader mid-read,
// short enough that a poll landing while the view is open shows up without
// having to close and reopen it.
const REFRESH_INTERVAL_MS = 30000;

function CompareCell({ cell }) {
  if (cell.status === CELL_STATUS.VALUE) {
    return (
      <td className="compare-cell compare-cell-value">
        <span className="compare-cell-v">{cell.formatted}</span>
      </td>
    );
  }
  return (
    <td className={`compare-cell compare-cell-empty compare-cell-${cell.status}`} title={cell.reason}>
      <span className="compare-cell-dash">{labelFor(cell.status)}</span>
    </td>
  );
}

function CompareRow({ row }) {
  return (
    // A React fragment, not a single <tr>: a row that carries its own
    // sensorCoverageCaveat (countryCompareLogic.js -- militaryAircraft and
    // navyVessels, currently) gets a second, full-width <tr> right under it,
    // so the warning sits next to the numbers it is about rather than living
    // only in the table-wide banner above (Task 40 review, Important 2).
    <>
      <tr className={row.differs ? "compare-row-differs" : ""}>
        <th scope="row" className="compare-row-label">
          <div className="compare-row-name">
            {row.label}
            {/* A neutral marker, not a colour and not a rank: it says these
                cells are not the same number, nothing about which one is
                "worse" -- see countryCompareLogic.js's own note on why
                `differs` is a boolean and this view never sorts by it. */}
            {row.differs && <span className="compare-row-differs-mark" title="These countries' figures differ">≠</span>}
          </div>
          <div className="compare-row-meta">{row.provenance} &middot; {row.source}</div>
        </th>
        {row.cells.map((cell, i) => <CompareCell key={i} cell={cell} />)}
      </tr>
      {row.caveat && (
        <tr className="compare-row-caveat-row">
          <td className="compare-row-caveat" colSpan={row.cells.length + 1}>{row.caveat}</td>
        </tr>
      )}
    </>
  );
}

/**
 * @param {{key: string, name: string}[]} selection  mapApi.countrySelection,
 *   in click order -- may be longer than three; capping and saying so is
 *   countryCompareLogic's job (selectCompareCountries), not this component's.
 * @param {(keys: string[]) => object|null} getRows  mapApi.countryCompareRows
 * @param {() => void} onClose
 * @param {(key: string) => void} [onFocusCountry]  open a country's own card
 *   without leaving the comparison selection -- optional, same "no-op when
 *   absent" rule the rest of this app's optional props follow.
 */
export default function CountryCompareView({ selection, getRows, onClose, onFocusCountry }) {
  const keys = (selection || []).map((c) => c.key);
  const keysSignature = keys.join("|");
  const [payload, setPayload] = useState(null);

  useEffect(() => {
    if (keys.length < MIN_COMPARE_COUNTRIES) {
      setPayload(null);
      return undefined;
    }
    const load = () => setPayload(getRows(keys));
    load();
    const id = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
    // Keyed on the signature string rather than `selection`/`keys` themselves
    // (a new array every render, which would restart the interval every
    // render too) -- see the module note above for why a signature string is
    // the right dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSignature, getRows]);

  return (
    <div className="compare-backdrop" onClick={onClose}>
      <aside
        id="countryCompare"
        role="dialog"
        aria-label="Compare selected countries"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="compare-header">
          <span className="compare-title">COMPARE COUNTRIES</span>
          <button type="button" className="compare-close" onClick={onClose} aria-label="Close comparison">
            &times;
          </button>
        </div>

        <div className="compare-body">
          {keys.length < MIN_COMPARE_COUNTRIES ? (
            <p className="meta compare-need-more">{needMoreCountriesNote(keys.length)}</p>
          ) : !payload ? (
            <p className="meta">Loading comparison…</p>
          ) : (
            <>
              <p className="meta compare-caveat">{COMPARE_COVERAGE_CAVEAT}</p>
              {payload.omittedNames.length > 0 && (
                <p className="meta compare-truncation">{truncationNote(payload.omittedNames)}</p>
              )}
              <div className="compare-table-scroll">
                <table className="compare-table">
                  <thead>
                    <tr>
                      <th scope="col" className="compare-row-label">Metric</th>
                      {payload.countries.map((c) => (
                        <th scope="col" key={c.key} className="compare-col-country">
                          {onFocusCountry ? (
                            <button
                              type="button"
                              className="compare-country-link"
                              onClick={() => onFocusCountry(c.key)}
                              title={`Open ${c.name}'s own card`}
                            >
                              {c.name}
                            </button>
                          ) : (
                            c.name
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {payload.rows.map((row) => <CompareRow key={row.id} row={row} />)}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
