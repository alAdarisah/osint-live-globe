// The two folds the control panel is built from.
//
// Both are native <details>/<summary>, which is deliberate: it gives keyboard
// operation, focus handling and the correct ARIA semantics for free, and a
// hand-rolled div-with-onClick would have to reimplement all three and would
// get at least one of them wrong.
//
// Controlled rather than uncontrolled. The panel re-renders on every poll (the
// counts are live), and an uncontrolled <details> relies on React never
// touching an attribute whose prop did not change -- true today, and far too
// subtle a thing to rest the whole panel's behaviour on.

/**
 * A named group of layers: "Conflict & Events", "Air & Sea Traffic", ...
 * Its heading is always visible, so a collapsed group still says what is
 * inside it and roughly how much.
 */
// `open`/`onToggle` default to a usable pair rather than being required.
// ControlPanel always supplies them, but a half-applied hot reload can render
// a child before its parent has the new props, and a whole-panel crash screen
// is a poor trade for a fold that could simply have defaulted to open.
export function PanelGroup({ id, title, count, open = true, onToggle = () => {}, children }) {
  return (
    <details
      className="panel-group"
      open={open}
      onToggle={(e) => onToggle(id, e.currentTarget.open)}
    >
      <summary className="layer-group-heading">
        <span className="panel-group-title">{title}</span>
        {count != null && <span className="panel-group-count">{count}</span>}
      </summary>
      <div className="panel-group-body">{children}</div>
    </details>
  );
}

/**
 * One layer's reference material -- what the glyphs mean, where the data comes
 * from, what it does not cover.
 *
 * Deliberately narrow in what it should wrap. Zoom notes ("Zoom in to show
 * news") and filter controls stay outside the fold: a zoom note is the
 * explanation for why a layer looks empty right now, so hiding it behind a
 * disclosure hides the answer at exactly the moment the question is being
 * asked.
 */
export function LayerDetails({ id, open = false, onToggle = () => {}, label = "About this layer", children }) {
  return (
    <details
      className="layer-details"
      open={open}
      onToggle={(e) => onToggle(id, e.currentTarget.open)}
    >
      <summary>{label}</summary>
      <div className="layer-details-body">{children}</div>
    </details>
  );
}
