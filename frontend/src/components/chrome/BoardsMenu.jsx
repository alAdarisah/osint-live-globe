import { useEffect, useRef, useState } from "react";

import { BOARDS, isBoardOpen } from "./boardRegistry";

/**
 * Which instrument boards are showing.
 *
 * Their own menu rather than four buttons in the bar: they are occasional
 * instruments, not controls a reader operates while reading, and four permanent
 * buttons would spend the sub bar's width on the least-used thing in it. The
 * count on the trigger is what keeps them from being forgotten entirely.
 */
export default function BoardsMenu({ open, onToggleBoard }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDocClick = (event) => {
      if (!wrapRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const count = (open || []).length;

  return (
    <span className="boards-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`ghost-btn${menuOpen ? " active" : ""}`}
        aria-expanded={menuOpen}
        title="Which instrument boards to show"
        onClick={() => setMenuOpen((prev) => !prev)}
      >
        Boards{count ? ` ${count}` : ""} ▾
      </button>

      {menuOpen && (
        <div className="boards-menu" role="group" aria-label="Instrument boards">
          {BOARDS.map((board) => {
            const on = isBoardOpen(open, board.id);
            return (
              <button
                key={board.id}
                type="button"
                className={`boards-item${on ? " on" : ""}`}
                aria-pressed={on}
                onClick={() => onToggleBoard(board.id)}
              >
                <span className="boards-tick" aria-hidden="true">{on ? "✓" : ""}</span>
                <span className="boards-text">
                  <span className="boards-label">{board.label}</span>
                  {/* What the board is actually for. These are the least
                      self-explanatory surfaces in the app -- "Cable outages"
                      does not say that it is a coincidence between two
                      independent feeds -- and the menu is the one place there
                      is room to say so before a reader opens one. */}
                  <span className="boards-note">{board.note}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
