// Drag-to-move for the floating HUD panels, and remembering where each one was
// dropped.
//
// The news ticker and the briefing card each carried their own copy of this
// pointer-capture dance, byte-for-byte identical except for the id of the
// element they measured; the country card and the notable-activity board had no
// dragging at all. One hook instead, so a panel becomes movable by using it
// rather than by pasting forty lines.
//
// Positions persist per panel id: a reader who has arranged their HUD around
// the region they watch should not have to arrange it again after a reload.
// Nothing else about a panel (open/collapsed, which section is expanded) is
// stored here -- see useAccordion.js for that.

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "osint-panel-positions";
// Keeps a panel's own edge from landing exactly on the viewport's, and leaves
// enough of it on screen to grab again after a window resize.
const EDGE_MARGIN = 4;
// Below this the pointer is treated as a click, not a drag. Without it, the
// pixel of travel between pressing and releasing a mouse button turns every
// click on a header into a one-pixel move and suppresses the click.
const DRAG_THRESHOLD_PX = 4;
const PANELS_RESET_EVENT = "osint-panels-reset";

function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveOne(id, pos) {
  try {
    const all = loadAll();
    if (pos) all[id] = pos;
    else delete all[id];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage full or disabled: the panel still moves, it just will not be
    // where it was left next time.
  }
}

function clampToViewport(x, y, width, height) {
  const maxX = Math.max(window.innerWidth - width - EDGE_MARGIN, EDGE_MARGIN);
  const maxY = Math.max(window.innerHeight - height - EDGE_MARGIN, EDGE_MARGIN);
  return {
    x: Math.min(Math.max(x, EDGE_MARGIN), maxX),
    y: Math.min(Math.max(y, EDGE_MARGIN), maxY),
  };
}

/**
 * @param {string} id        stable per panel -- it is the storage key
 * @param {object} [options]
 * @param {() => void} [options.onClick]  called when the handle was pressed and
 *   released without moving, so a header can stay a toggle as well as a handle
 * @param {boolean} [options.enabled]     false renders the panel undraggable and
 *   ignores any stored position (mobile, where panels are full-width overlays)
 *
 * @returns {{
 *   panelRef: object, style: object|undefined, handleProps: object,
 *   moved: boolean, resetPosition: () => void
 * }}
 */
export function useDraggablePanel(id, { onClick, enabled = true } = {}) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState(() => (enabled ? loadAll()[id] || null : null));
  const dragRef = useRef(null);

  // A stored position from a wider window can leave a panel entirely off-screen.
  // Re-clamping on resize is what stops a panel becoming unreachable -- it can
  // otherwise only be recovered by clearing storage.
  useEffect(() => {
    if (!pos) return undefined;
    function onResize() {
      const el = panelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPos((prev) => (prev ? clampToViewport(prev.x, prev.y, rect.width, rect.height) : prev));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [pos]);

  // "Reset panel layout" in the admin panel clears the stored positions, but
  // every mounted panel is still holding its own `pos` in state -- a window
  // event is what tells them to drop it, without App having to thread a
  // layout-version counter through five unrelated components.
  useEffect(() => {
    function onReset() {
      setPos(null);
    }
    window.addEventListener(PANELS_RESET_EVENT, onReset);
    return () => window.removeEventListener(PANELS_RESET_EVENT, onReset);
  }, []);

  const onPointerDown = useCallback(
    (e) => {
      if (!enabled) return;
      // Controls inside the handle keep their own behaviour: a close button on a
      // draggable header must still close rather than start a drag.
      if (e.target.closest("button, a, input, select, textarea")) return;
      const el = panelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: rect.left,
        originY: rect.top,
        width: rect.width,
        height: rect.height,
        moved: false,
      };
      // Capture is what keeps the drag alive when the pointer outruns the
      // header, but it throws NotFoundError if the pointer is already gone by
      // the time we ask (a released button, a synthesised event). Losing
      // capture costs a drag that stops at the edge of the handle; letting the
      // throw out of a React event handler costs the panel.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* drag still works, just without capture */
      }
    },
    [enabled]
  );

  const onPointerMove = useCallback((e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) drag.moved = true;
    if (!drag.moved) return;
    const next = clampToViewport(drag.originX + dx, drag.originY + dy, drag.width, drag.height);
    // Kept on the drag record as well as in state, because pointerup persists
    // it: React batches, so the last move of a fast drag can still be unpainted
    // when the release arrives, and reading the element's rect there would
    // store the position it had one frame ago.
    drag.lastPos = next;
    setPos(next);
  }, []);

  const onPointerUp = useCallback(
    (e) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      if (drag.moved) {
        // Written once, on release, rather than on every move: a drag fires
        // dozens of pointermove events and each one would be a JSON serialise
        // plus a synchronous storage write.
        if (drag.lastPos) saveOne(id, drag.lastPos);
      } else {
        onClick?.();
      }
    },
    [id, onClick]
  );

  const resetPosition = useCallback(() => {
    setPos(null);
    saveOne(id, null);
  }, [id]);

  // `right`/`bottom` are cleared explicitly because most of these panels are
  // anchored to a corner in CSS -- leaving those set would fight the left/top
  // this hook applies and stretch the panel instead of moving it.
  const style = pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : undefined;

  return {
    panelRef,
    style,
    moved: !!pos,
    resetPosition,
    handleProps: enabled
      ? { onPointerDown, onPointerMove, onPointerUp, title: "Drag to move", className: "panel-drag-handle" }
      : {},
  };
}

/** Forget every stored panel position and snap every open panel back (the
 *  admin panel's "reset panel layout"). */
export function clearAllPanelPositions() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear if storage is unavailable */
  }
  window.dispatchEvent(new CustomEvent(PANELS_RESET_EVENT));
}
