import { useCallback, useState } from "react";

// Which control-panel sections are expanded, remembered across reloads.
//
// The panel is 22 layer toggles wrapped in 34 legend blocks and 18 paragraphs
// of explanation -- 5.3 screens of scrolling, in which the controls a reader
// actually operates are outnumbered roughly two to one by reference material
// they read once. Folding the reference away is what makes the toggles
// findable; persisting the folds is what stops that being a chore every visit.
//
// One key holds every section's state. The alternative -- a key per section --
// spreads a single UI preference across a dozen entries that nothing would ever
// clean up.
//
// One key per *surface*, though: the control panel and the country card are
// different sets of folds that happen to share a mechanism, and sharing storage
// would let a section id collide across them.
const DEFAULT_STORAGE_KEY = "osint-panel-accordion";

function load(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    // Guard the shape as well as the parse: a hand-edited or half-written value
    // must not be able to make every section vanish.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // unreadable or disabled storage is not a reason to fail to render
  }
}

/**
 * @param {Record<string, boolean>} defaults  id -> open when nothing is stored
 * @param {string} storageKey  which surface's folds these are
 */
export function useAccordion(defaults = {}, storageKey = DEFAULT_STORAGE_KEY) {
  const [openById, setOpenById] = useState(() => ({ ...defaults, ...load(storageKey) }));

  const isOpen = useCallback((id) => !!openById[id], [openById]);

  const setOpen = useCallback((id, open) => {
    setOpenById((prev) => {
      if (!!prev[id] === open) return prev; // no-op keeps <details> from re-rendering on its own event
      const next = { ...prev, [id]: open };
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Private mode or a full quota: the fold still works for this session,
        // it just will not be remembered. Not worth failing a render over.
      }
      return next;
    });
  }, [storageKey]);

  return { isOpen, setOpen };
}
