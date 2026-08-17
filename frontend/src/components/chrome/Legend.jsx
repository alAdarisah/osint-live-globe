import { useAccordion } from "../../hooks/useAccordion";
import { paletteColor } from "../../map/iconTheme";
import { glyphLegend, severityLegend, QUALIFIER_ROWS } from "./legendRows";
import { ATTRIBUTION_DISCLAIMER } from "../Attribution";
import { shipSupplierReadout } from "../../map/shipSupplier";
import { ESCALATION_EXPLAINER, JAMMING_EXPLAINER } from "./hudLogic";

const FOLD_KEY = "osint-chrome-folds";

/**
 * What the marks on the map mean.
 *
 * Collapsed by default, and that is the point: it is reference, read once and
 * then not again, and the alternative to folding it away is 250px of the map's
 * top-right corner permanently spent on something a returning reader already
 * knows. Its fold is remembered, so "once" really is once.
 */
export default function Legend({ health }) {
  const { isOpen, setOpen } = useAccordion({ legend: false }, FOLD_KEY);
  const open = isOpen("legend");
  const supplier = shipSupplierReadout(health);

  return (
    <div id="legend" className={open ? "" : "collapsed"}>
      <button
        type="button"
        className="lg-head"
        aria-expanded={open}
        onClick={() => setOpen("legend", !open)}
      >
        <span className="lg-title">Legend</span>
        <span className="lg-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="lg-body">
          <div className="lg-section">Severity</div>
          <div className="lg-grid">
            {/* Through paletteColor, exactly as the glyph rows below already were:
                the map draws every event through the palette (decorators.js), so a
                swatch painted from the shipped constant stopped matching the pins
                the moment anyone recoloured a band in Admin Mode -- and a legend
                that disagrees with the map is worse than no legend. */}
            {severityLegend().map((row) => (
              <span key={row.key} className="lg-row">
                <span
                  className="lg-swatch"
                  style={{ background: row.token ? paletteColor(row.token, row.color) : row.color }}
                />
                <span className="lg-label">{row.label}</span>
              </span>
            ))}
          </div>

          <div className="lg-section">Marks</div>
          <div className="lg-grid">
            {glyphLegend().map((row) => (
              <span key={row.key} className="lg-row">
                <svg
                  className="lg-glyph" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"
                  style={{ color: row.token ? paletteColor(row.token, row.color) : row.color }}
                  dangerouslySetInnerHTML={{ __html: row.svg }}
                />
                <span className="lg-label">{row.label}</span>
              </span>
            ))}
          </div>

          {/* The two ways this map says it is unsure. Kept in their own group
              rather than mixed in above, because they qualify every mark rather
              than being marks of their own. */}
          <div className="lg-section">Qualifiers</div>
          <div className="lg-grid">
            {QUALIFIER_ROWS.map((row) => (
              <span key={row.key} className="lg-row">
                <span className={`lg-qualifier lg-qualifier-${row.kind}`} aria-hidden="true" />
                <span className="lg-label">{row.label}</span>
              </span>
            ))}
          </div>

          {/* The two figures in the bottom strip that are a *measurement* rather than
              a count, and so are the two nobody can read off the label. "Escalation
              3.1×" and "GPS jam 100%" both look self-explanatory and are not: one is
              a ratio against a zone's own history and not a badness score, and the
              other is one hex cell on yesterday's data, sometimes over three
              aircraft.
              
              Repeated here from the cells' own tooltips for the reason the disclaimer
              below is repeated: a native title never fires on a touch screen, and
              this panel is the reference surface a reader can always open. The text
              is imported rather than retyped, so the two surfaces cannot drift. The
              other cells are counts and their tooltips say all there is to say. */}
          <div className="lg-section">Status strip</div>
          <p className="lg-note lg-explainer"><b>Escalation.</b> {ESCALATION_EXPLAINER}</p>
          <p className="lg-note lg-explainer"><b>GPS jam.</b> {JAMMING_EXPLAINER}</p>

          {/* The disclaimer, in full, where it cannot be truncated.
              Its home is the HUD's attribution cell, which is the one cell there
              allowed to ellipsis away -- and the disclaimer sits at the end of it,
              so it is the first thing lost on any window narrower than about
              1400px. That cell now carries the full text as a tooltip, but a
              tooltip never fires on a touch screen, and this panel is the reference
              surface a reader can always open. Repeated rather than moved: the
              credits belong beside the data they credit. */}
          <div className="lg-section">This map</div>
          {/* Which AIS supplier the hulls on screen came from. A thinner feed that
              does not say it is thinner is the dishonest case: a reader looking at
              an empty sea has to be able to tell "there are no ships here" from
              "we are on the backup feed today". Only shown when there is something
              to say -- see shipSupplierReadout. */}
          {supplier.note && <p className="lg-note">{supplier.note}</p>}
          <p className="lg-note">{ATTRIBUTION_DISCLAIMER}</p>
        </div>
      )}
    </div>
  );
}
