// The three controls the admin panel is built from. Small on purpose: every
// row in that panel is "label, control, current value, way back to the
// default", and writing that markup out per setting is how the rows drift
// apart.

import { SVG } from "../../map/svgIcons";

/** A labelled slider that shows its own value and can be reset to the default. */
export function SliderField({ label, value, min, max, step = 0.05, onChange, format, defaultValue, suffix }) {
  const shown = format ? format(value) : `${value}${suffix || ""}`;
  const modified = defaultValue != null && value !== defaultValue;
  return (
    <label className="admin-field">
      <span className="admin-field-label">
        {label}
        <span className={`admin-field-value${modified ? " modified" : ""}`}>{shown}</span>
      </span>
      <span className="admin-slider-row">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {modified && (
          <button
            type="button"
            className="admin-reset-btn"
            title={`Back to ${format ? format(defaultValue) : defaultValue}`}
            onClick={() => onChange(defaultValue)}
          >
            ↺
          </button>
        )}
      </span>
    </label>
  );
}

/** A colour swatch + native picker, with its shipped colour one click away. */
export function ColorField({ label, value, defaultValue, onChange }) {
  const modified = value !== defaultValue;
  return (
    <label className="admin-color-field">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="admin-color-label">{label}</span>
      {modified && (
        <button
          type="button"
          className="admin-reset-btn"
          title={`Back to ${defaultValue}`}
          onClick={() => onChange(defaultValue)}
        >
          ↺
        </button>
      )}
    </label>
  );
}

// The zoom levels a pin type can be held back to.
//
// Runs past the layer sliders' 12. Those stop at the SITE band floor because a
// whole layer that only appears over one street is a layer nobody will find; a
// single pin type inside a layer that is already drawing is a different
// question, and for the layers gated at SITE itself a list ending at 12 offered
// nothing at all (see pinZoomChoicesFor below -- every option at or under the
// layer's own gate does nothing).
const PIN_ZOOM_CHOICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/**
 * The zooms this pin type can actually be held back to, given its layer's gate.
 *
 * The floor composes as "the later of the two wins" (see pinZoomGate in
 * map/createMapController.js), so on a layer that draws from z9 every option
 * from z0 to z9 resolves to z9 -- the control was offering ten choices that
 * changed nothing, and picking one looked exactly like a broken control:
 * "shows from z6" written on a row whose pins carry on appearing at z9.
 *
 * Only the zooms past the gate are offered now. The "follow the layer" option
 * is what covers everything at or below it, and it says so.
 */
function pinZoomChoicesFor(layerZoom) {
  if (!Number.isFinite(layerZoom)) return PIN_ZOOM_CHOICES;
  return PIN_ZOOM_CHOICES.filter((z) => z > layerZoom);
}

/**
 * `choices`, with `current` folded in wherever it belongs if it is missing.
 *
 * A configuration written before these lists were filtered can hold a number
 * neither of them would offer now -- and a <select> whose value matches no
 * option renders blank, which reads as "unset" on a row that is very much set.
 *
 * Kept, not silently corrected, and labelled rather than left to look like a
 * working setting: `stranded` is what the row draws "no effect" next to. That
 * label is the whole diagnosis for the case this came from -- a railway node
 * held to z8 on a layer that draws from z9, which composes back to z9 and so
 * changed nothing on the map while the panel read "z8".
 */
function withCurrent(choices, current) {
  if (!Number.isFinite(current) || choices.includes(current)) {
    return { choices, stranded: null };
  }
  return { choices: [...choices, current].sort((a, b) => a - b), stranded: current };
}

/**
 * One kind of pin, on one line: its colour, its name, how big it is drawn, and
 * the zoom it starts drawing at.
 *
 * The controls share a row rather than stacking because there are forty of
 * these -- a separate row per property would make the section three times as
 * long to scroll and put one pin's properties a screen apart. `size` is null for
 * the few tokens that name a colour with no pin of their own (see
 * COLOUR_ONLY_TOKENS in map/iconTheme.js), and the slider is simply absent
 * there rather than present and inert; `zoom` is undefined for the same tokens.
 *
 * The zoom is a select rather than a third slider on purpose. Its value has a
 * state no slider position can express -- "follow the layer" -- and that is the
 * state it is in for every pin type until someone deliberately changes one, so
 * it has to be the readable default rather than an end stop.
 */
export function IconField({
  label, color, defaultColor, onColorChange, size, onSizeChange,
  zoom, layerZoom, onZoomChange, zoomMax, onZoomMaxChange,
  glyph, glyphChoices, onGlyphChange,
}) {
  const colorModified = color !== defaultColor;
  const sizeModified = size != null && size !== 1;
  const zoomModified = zoom != null;
  const zoomMaxModified = zoomMax != null;
  const glyphModified = glyph != null;
  const inherited = layerZoom == null ? "any zoom" : `z${layerZoom}`;
  // The floor in force: this pin type's own if it has one, its layer's
  // otherwise. A ceiling under it would draw the pin nowhere at all, so those
  // options are left off rather than offered as a way to hide a layer.
  const floor = Math.max(zoom ?? -Infinity, layerZoom ?? -Infinity);
  const { choices: zoomChoices, stranded: strandedZoom } = withCurrent(
    pinZoomChoicesFor(layerZoom),
    zoom
  );
  const { choices: zoomMaxChoices, stranded: strandedZoomMax } = withCurrent(
    Number.isFinite(floor) ? PIN_ZOOM_CHOICES.filter((z) => z >= floor) : PIN_ZOOM_CHOICES,
    zoomMax
  );
  return (
    <div className="admin-icon-field">
      <input
        type="color"
        value={color}
        onChange={(e) => onColorChange(e.target.value)}
        aria-label={`${label} colour`}
      />
      <span className="admin-icon-label">{label}</span>
      {size != null && (
        <>
          <input
            className="admin-icon-size"
            type="range"
            min={0.3}
            max={3}
            step={0.05}
            value={size}
            onChange={(e) => onSizeChange(Number(e.target.value))}
            aria-label={`${label} size`}
            title="Size, on top of the global and per-layer multipliers"
          />
          <span className={`admin-icon-size-value${sizeModified ? " modified" : ""}`}>
            {Math.round(size * 100)}%
          </span>
        </>
      )}
      {zoom !== undefined && (
        <select
          className={`admin-icon-zoom${zoomModified ? " modified" : ""}`}
          value={zoom == null ? "" : String(zoom)}
          onChange={(e) => onZoomChange(e.target.value === "" ? null : Number(e.target.value))}
          aria-label={`${label} shows from zoom`}
          title={`Shows from this zoom. Its layer starts at ${inherited}, and that is the floor -- a kind of pin can be held back past its layer's gate but not brought forward through it, so only the zooms past it are offered.`}
        >
          <option value="">{inherited} &middot; layer</option>
          {zoomChoices.map((z) => (
            <option key={z} value={z}>
              z{z}
              {z === strandedZoom ? " · no effect" : ""}
            </option>
          ))}
        </select>
      )}
      {glyphChoices?.length > 1 && (
        <GlyphPicker label={label} choices={glyphChoices} glyph={glyph} color={color} onChange={onGlyphChange} />
      )}
      {zoomMax !== undefined && (
        <select
          className={`admin-icon-zoom${zoomMaxModified ? " modified" : ""}`}
          value={zoomMax == null ? "" : String(zoomMax)}
          onChange={(e) => onZoomMaxChange(e.target.value === "" ? null : Number(e.target.value))}
          aria-label={`${label} hides past zoom`}
          title="Hides past this zoom, inclusive -- z6 means still drawn at z6 and gone at z7. Nothing ships a ceiling, so this only ever adds a limit. Zooms below this pin type's own floor are not offered: the range would be empty."
        >
          <option value="">no limit</option>
          {zoomMaxChoices.map((z) => (
            <option key={z} value={z}>
              &le;z{z}
              {z === strandedZoomMax ? " · draws nowhere" : ""}
            </option>
          ))}
        </select>
      )}
      {(colorModified || sizeModified || zoomModified || zoomMaxModified || glyphModified) && (
        <button
          type="button"
          className="admin-reset-btn"
          title="Back to the shipped colour, size, zoom range and shape"
          onClick={() => {
            if (colorModified) onColorChange(defaultColor);
            if (sizeModified) onSizeChange(1);
            if (zoomModified) onZoomChange(null);
            if (zoomMaxModified) onZoomMaxChange(null);
            if (glyphModified) onGlyphChange(null);
          }}
        >
          ↺
        </button>
      )}
    </div>
  );
}

/**
 * The shapes a pin type may be drawn as, drawn.
 *
 * This was a <select> of names, and a name is not a shape: "hullDetection" or
 * "stsTransfer" tells an operator nothing about what will appear on the map,
 * so choosing between them meant picking one, closing the panel, finding a pin
 * and looking. Native <option> cannot carry markup, so the picker is a strip of
 * buttons instead -- each one the real glyph, drawn in the colour this pin type
 * is currently set to, so what is on offer and what is chosen are both visible
 * without leaving the row.
 *
 * The first choice is the shipped one and selecting it stores null rather than
 * its name -- the same "not overridden" state the reset button returns to, so a
 * pin put back to its shipped shape by hand does not read as modified.
 */
function GlyphPicker({ label, choices, glyph, color, onChange }) {
  const drawable = choices.filter((name) => SVG[name]);
  if (drawable.length < 2) return null;
  const current = glyph ?? drawable[0];
  return (
    <div className="admin-glyph-picker" role="radiogroup" aria-label={`${label} icon`}>
      {drawable.map((name, i) => (
        <button
          key={name}
          type="button"
          role="radio"
          aria-checked={name === current}
          aria-label={i === 0 ? `${name} (shipped)` : name}
          className={`admin-glyph-swatch${name === current ? " selected" : ""}`}
          title={i === 0 ? `${name} — shipped` : name}
          style={{ color }}
          onClick={() => onChange(i === 0 ? null : name)}
        >
          {/* Static markup from the SVG table in map/svgIcons.js -- the same
              strings the map itself draws from, never user input. */}
          <svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: SVG[name] }} />
        </button>
      ))}
    </div>
  );
}

export function CheckField({ label, checked, onChange, note }) {
  return (
    <label className="admin-check-field">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {note && <span className="admin-field-note">{note}</span>}
      </span>
    </label>
  );
}
