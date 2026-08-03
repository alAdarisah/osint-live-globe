export default function PanelToggle({ open, onToggle }) {
  return (
    <button id="panelToggle" className={open ? "open" : ""} aria-label="Toggle panel" onClick={onToggle}>
      {open ? "◀" : "▶"}
    </button>
  );
}
