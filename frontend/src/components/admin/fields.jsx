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
