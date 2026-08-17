import { useAccordion } from "../../hooks/useAccordion";
import { paletteColor } from "../../map/iconTheme";
import { glyphLegend, severityLegend, QUALIFIER_ROWS } from "./legendRows";

const FOLD_KEY = "osint-chrome-folds";

/**
 * What the marks on the map mean.
 *
 * Collapsed by default, and that is the point: it is reference, read once and
 * then not again, and the alternative to folding it away is 250px of the map's
 * top-right corner permanently spent on something a returning reader already
 * knows. Its fold is remembered, so "once" really is once.
 */
export default function Legend() {
  const { isOpen, setOpen } = useAccordion({ legend: false }, FOLD_KEY);
  const open = isOpen("legend");

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
        </div>
      )}
    </div>
  );
}
