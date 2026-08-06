// The only chrome a boundary edit gets.
//
// Everything that changes a border is a gesture on the map itself (see
// map/borderEdit.js) -- this bar exists to say the mode is on, to name the
// gestures once so nobody has to guess at them, and to hold the two switches
// that have no natural place on the map: whether the neighbour moves too, and
// undo.
//
// It is a bar rather than a section of the country card because the card can be
// closed while a session is open, and a mode with no visible indicator is a
// mode people leave on by accident.
export default function BorderEditBar({ state, countryName, onEnd, onUndo, onToggleLink, notice, onDismissNotice }) {
  if (!state?.active) return null;

  return (
    <div id="borderEditBar" role="group" aria-label="Editing country border">
      <span className="border-edit-badge">EDITING</span>
      <span className="border-edit-name">{countryName || state.countryKey}</span>

      {state.tooFarOut ? (
        <span className="border-edit-warning">
          Zoom in to z{state.minZoom} to see the handles &mdash; the points are closer together than a
          mouse can pick apart out here.
        </span>
      ) : (
        <>
          <span className="border-edit-hint">
            <b>drag</b> a point to move it &middot; <b>drag</b> a hollow one to add &middot;{" "}
            <b>alt-click</b> to delete &middot; <b>Esc</b> when done
          </span>
          {state.capped && (
            <span className="border-edit-warning">
              Showing {state.shown?.toLocaleString()} of {state.total?.toLocaleString()} points &mdash;
              zoom in for the rest.
            </span>
          )}
        </>
      )}

      <label className="border-edit-link" title="Neighbouring countries share the same boundary points. With this on, moving one moves both sides at once instead of tearing a gap between them.">
        <input type="checkbox" checked={state.linkMode !== false} onChange={(e) => onToggleLink(e.target.checked)} />
        Move both sides
      </label>

      <button type="button" onClick={onUndo} disabled={!state.canUndo} title="Undo the last change (Ctrl+Z)">
        Undo
      </button>
      <button type="button" className="border-edit-done" onClick={onEnd}>
        Done
      </button>

      {notice && (
        <span className="border-edit-notice" role="status">
          {notice}
          <button type="button" onClick={onDismissNotice} aria-label="Dismiss">
            &times;
          </button>
        </span>
      )}
    </div>
  );
}
