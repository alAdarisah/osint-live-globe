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
//
// Panels that opt in with `resizable` also get a corner grip, and their size is
// stored in the same record as their position. A panel wide enough to read is
// not a preference the shipped width can guess: the admin panel puts a colour
// well, a name, a size slider and three selects on one row, and how much room
// that needs depends on the reader's text scale as much as on their screen.

import { useCallback, useEffect, useRef, useState } from "react";

import { currentChromeInsets } from "./useChromeLayout";

const STORAGE_KEY = "osint-panel-positions";
// Keeps a panel's own edge from landing exactly on the viewport's, and leaves
// enough of it on screen to grab again after a window resize.
const EDGE_MARGIN = 4;
// Below this the pointer is treated as a click, not a drag. Without it, the
// pixel of travel between pressing and releasing a mouse button turns every
// click on a header into a one-pixel move and suppresses the click.
const DRAG_THRESHOLD_PX = 4;
const PANELS_RESET_EVENT = "osint-panels-reset";
// Small enough to tuck a panel out of the way, large enough that the grip and
// the header's close button are both still reachable at the floor.
const MIN_PANEL_WIDTH = 260;
const MIN_PANEL_HEIGHT = 140;

function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// `patch` merges into whatever that panel already has, because position and
// size are written by two different gestures into one record -- a resize that
// replaced the record would forget where the panel was dropped.
function saveOne(id, patch) {
  try {
    const all = loadAll();
    if (patch) all[id] = { ...all[id], ...patch };
    else delete all[id];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage full or disabled: the panel still moves, it just will not be
    // where it was left next time.
  }
}

function storedPos(rec) {
  return rec && typeof rec.x === "number" && typeof rec.y === "number" ? { x: rec.x, y: rec.y } : null;
}

function storedSize(rec) {
  return rec && typeof rec.w === "number" && typeof rec.h === "number" ? { w: rec.w, h: rec.h } : null;
}

// Inside the map, not inside the window.
//
// This used to clamp against the viewport alone, which was right when the map
// filled it. There are now 78px of opaque bars at the top, a status strip at the
// bottom, and a rail down one side, and a panel clamped to EDGE_MARGIN sits
// underneath the bars -- in the DOM, rendered, and unreachable, because every
// surface up there is drawn above --z-cards. The only escape was Admin Mode's
// "Reset panel layout" or clearing localStorage.
//
// The insets are read live rather than passed in: they change when the feed rail
// opens, and a panel dragged while it was open must not become unreachable when it
// closes.
function clampToViewport(x, y, width, height) {
  const insets = currentChromeInsets();
  const minX = insets.left + EDGE_MARGIN;
  const minY = insets.top + EDGE_MARGIN;
  const maxX = Math.max(window.innerWidth - width - EDGE_MARGIN, minX);
  const maxY = Math.max(window.innerHeight - insets.bottom - height - EDGE_MARGIN, minY);
  return {
    x: Math.min(Math.max(x, minX), maxX),
    y: Math.min(Math.max(y, minY), maxY),
  };
}

function clampSize(w, h) {
  return {
    w: Math.min(Math.max(Math.round(w), MIN_PANEL_WIDTH), window.innerWidth - 2 * EDGE_MARGIN),
    h: Math.min(Math.max(Math.round(h), MIN_PANEL_HEIGHT), window.innerHeight - 2 * EDGE_MARGIN),
  };
}

/**
 * @param {string} id        stable per panel -- it is the storage key
 * @param {object} [options]
 * @param {() => void} [options.onClick]  called when the handle was pressed and
 *   released without moving, so a header can stay a toggle as well as a handle
 * @param {boolean} [options.enabled]     false renders the panel undraggable and
 *   ignores any stored position (mobile, where panels are full-width overlays)
 * @param {boolean} [options.resizable]   true also returns `resizeProps` for a
 *   corner grip, and remembers the size it is dragged to
 *
 * @returns {{
 *   panelRef: object, style: object|undefined, handleProps: object,
 *   resizeProps: object, moved: boolean, resetPosition: () => void
 * }}
 */
export function useDraggablePanel(id, { onClick, enabled = true, resizable = false } = {}) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState(() => (enabled ? storedPos(loadAll()[id]) : null));
  const [size, setSize] = useState(() => (enabled && resizable ? storedSize(loadAll()[id]) : null));
  const dragRef = useRef(null);
  const resizeRef = useRef(null);

  // A stored position from a wider window can leave a panel entirely off-screen.
  // Re-clamping on resize is what stops a panel becoming unreachable -- it can
  // otherwise only be recovered by clearing storage.
  // A stored size from a wider window is the same problem one step earlier: a
  // panel held at 900px on a 700px screen would be clipped by the viewport
  // rather than by its own max-width, so both are re-clamped together.
  useEffect(() => {
    if (!pos && !size) return undefined;
    function onResize() {
      const el = panelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setSize((prev) => (prev ? clampSize(prev.w, prev.h) : prev));
      setPos((prev) => (prev ? clampToViewport(prev.x, prev.y, rect.width, rect.height) : prev));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [pos, size]);

  // "Reset panel layout" in the admin panel clears the stored positions, but
  // every mounted panel is still holding its own `pos` in state -- a window
  // event is what tells them to drop it, without App having to thread a
  // layout-version counter through five unrelated components.
  useEffect(() => {
    function onReset() {
      setPos(null);
      setSize(null);
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

  // The grip sits inside the panel, so its pointer events would otherwise reach
  // the panel's own handlers as well -- stopPropagation is what keeps a resize
  // from also being read as the start of a drag.
  const onResizeDown = useCallback(
    (e) => {
      if (!enabled || !resizable) return;
      const el = panelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      resizeRef.current = { startX: e.clientX, startY: e.clientY, width: rect.width, height: rect.height };
      e.stopPropagation();
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* resize still works, it just stops at the edge of the grip */
      }
    },
    [enabled, resizable]
  );

  const onResizeMove = useCallback((e) => {
    const rs = resizeRef.current;
    if (!rs) return;
    const next = clampSize(rs.width + (e.clientX - rs.startX), rs.height + (e.clientY - rs.startY));
    rs.lastSize = next;
    setSize(next);
  }, []);

  const onResizeUp = useCallback(
    (e) => {
      const rs = resizeRef.current;
      resizeRef.current = null;
      if (!rs) return;
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      if (rs.lastSize) saveOne(id, { w: rs.lastSize.w, h: rs.lastSize.h });
    },
    [id]
  );

  const resetPosition = useCallback(() => {
    setPos(null);
    setSize(null);
    saveOne(id, null);
  }, [id]);

  // `right`/`bottom` are cleared explicitly because most of these panels are
  // anchored to a corner in CSS -- leaving those set would fight the left/top
  // this hook applies and stretch the panel instead of moving it.
  //
  // `maxWidth`/`maxHeight` are dropped for the same reason: those caps are what
  // the panel is sized by until someone sizes it themselves, and leaving them
  // set would silently ignore the last part of a drag past them.
  const style =
    pos || size
      ? {
          ...(pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : null),
          ...(size ? { width: size.w, height: size.h, maxWidth: "none", maxHeight: "none" } : null),
        }
      : undefined;

  return {
    panelRef,
    style,
    moved: !!pos,
    resetPosition,
    handleProps: enabled
      ? { onPointerDown, onPointerMove, onPointerUp, title: "Drag to move", className: "panel-drag-handle" }
      : {},
    resizeProps:
      enabled && resizable
        ? {
            onPointerDown: onResizeDown,
            onPointerMove: onResizeMove,
            onPointerUp: onResizeUp,
            title: "Drag to resize",
            className: "panel-resize-grip",
          }
        : null,
  };
}

/**
 * Give a panel id the first stored position/size found among a list of
 * predecessor ids, if the new id does not already have one of its own.
 *
 * For Task 12's IntelPanel, replacing NotableEventsPanel and NewsBroadcastPanel
 * with one merged panel: a reader who had dragged either of the two old panels
 * somewhere should not find the new one back at its shipped default. There is
 * no honest way to merge *two* positions into one, so this takes the first
 * predecessor (in the order the caller lists them) that actually has a saved
 * position -- NotableEventsPanel's, since it was the one expanded by default
 * and the more often-consulted of the pair. Call once, at module scope in
 * IntelPanel.jsx (not inside the component), so it runs before that
 * component's own `useDraggablePanel("intelPanel", ...)` call reads storage on
 * its first render -- an effect would run one render too late to matter.
 *
 * A no-op once `newId` has its own entry, whether from a previous run of this
 * migration or from the reader having since dragged the new panel themselves
 * -- it must never overwrite a real choice with a stale one.
 */
export function migratePanelPosition(newId, oldIds) {
  try {
    const all = loadAll();
    if (all[newId]) return;
    for (const oldId of oldIds) {
      if (all[oldId]) {
        all[newId] = { ...all[oldId] };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
        return;
      }
    }
  } catch {
    // Storage full or disabled -- the panel opens at its shipped default,
    // same fallback saveOne already takes.
  }
}

// Set once the stored positions have been re-clamped for the chrome. Its own key
// rather than a field in the positions record, so it survives "Reset panel layout"
// clearing that record -- a reset produces no stored positions at all, which needs
// no migration, and re-running this on the next drag would be wasted work.
const CHROME_MIGRATION_KEY = "osint-panel-positions-chrome-v2";

/**
 * Move every stored panel position back inside the map, once.
 *
 * No panel id changed, so migratePanelPosition above is not the tool. The problem
 * is geometry: these positions were saved against a layout with no top chrome, and
 * a panel stored at y=20 now sits behind 78px of opaque bar. It renders, it is in
 * the DOM, and it cannot be seen or grabbed, because everything up there is drawn
 * above --z-cards. Nothing recovers it except Admin Mode's layout reset -- and a
 * reader whose card has vanished has no reason to look for a control called "reset
 * panel layout".
 *
 * The positions are re-clamped rather than discarded. A reader who arranged their
 * HUD around the region they watch should keep that arrangement, moved as little as
 * it takes to be reachable; throwing the record away would be the easier fix and a
 * worse one.
 *
 * Called once at module scope from App.jsx, before any panel's own
 * useDraggablePanel reads storage -- the same timing migratePanelPosition needs and
 * for the same reason. Sizes are left alone: a too-large panel is clipped by its
 * own max-width, which is visible and recoverable.
 */
export function migratePanelPositionsIntoChrome() {
  try {
    if (localStorage.getItem(CHROME_MIGRATION_KEY)) return;
    const all = loadAll();
    const ids = Object.keys(all);
    // Flag it either way. With nothing stored there is nothing to migrate, and
    // this must not re-run on every load for the rest of the session.
    localStorage.setItem(CHROME_MIGRATION_KEY, "1");
    if (!ids.length) return;

    const insets = currentChromeInsets();
    let changed = false;
    for (const id of ids) {
      const rec = all[id];
      const pos = storedPos(rec);
      if (!pos) continue;
      // The panel is not mounted yet, so its real size is unknown. A stored size
      // if there is one, else a conservative box: too small an estimate only
      // under-corrects, and the resize clamp will finish the job the first time
      // the window changes.
      const size = storedSize(rec) || { w: MIN_PANEL_WIDTH, h: MIN_PANEL_HEIGHT };
      const next = clampToViewport(pos.x, pos.y, size.w, size.h);
      if (next.x !== pos.x || next.y !== pos.y) {
        all[id] = { ...rec, ...next };
        changed = true;
      }
    }
    if (changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage disabled or full. Every panel opens where CSS puts it, which is the
    // same fallback saveOne already takes.
  }
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
