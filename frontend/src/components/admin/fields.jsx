// The three controls the admin panel is built from. Small on purpose: every
// row in that panel is "label, control, current value, way back to the
// default", and writing that markup out per setting is how the rows drift
// apart.

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

// The zoom levels a pin type can be held back to. Stops at 12 for the same
// reason the layer sliders do -- 12 is the SITE band floor, and a pin that only
// appears over one street is a pin nobody will find.
const PIN_ZOOM_CHOICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

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
  zoom, layerZoom, onZoomChange,
}) {
  const colorModified = color !== defaultColor;
  const sizeModified = size != null && size !== 1;
  const zoomModified = zoom != null;
  const inherited = layerZoom == null ? "any zoom" : `z${layerZoom}`;
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
          title={`Shows from this zoom. Its layer starts at ${inherited}, and that is the floor -- a kind of pin can be held back past its layer's gate but not brought forward through it.`}
        >
          <option value="">{inherited} &middot; layer</option>
          {PIN_ZOOM_CHOICES.map((z) => (
            <option key={z} value={z}>
              z{z}
            </option>
          ))}
        </select>
      )}
      {(colorModified || sizeModified || zoomModified) && (
        <button
          type="button"
          className="admin-reset-btn"
          title="Back to the shipped colour, size and zoom"
          onClick={() => {
            if (colorModified) onColorChange(defaultColor);
            if (sizeModified) onSizeChange(1);
            if (zoomModified) onZoomChange(null);
          }}
        >
          ↺
        </button>
      )}
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
