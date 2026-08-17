import { useCallback, useEffect, useState } from "react";

import {
  loadWatchlist, saveWatchlist, addWatch, removeWatch, isWatched, watchKey,
} from "../utils/watchlist";
import { WATCH_ADD, WATCH_REMOVE, WATCH_CHANGED } from "./watchlistEvents";

// The events the imperative half of the app uses to reach this state -- see
// hooks/watchlistEvents.js for why the names live in their own module. Re-
// exported here so a React caller has one import rather than two.
export { WATCH_ADD, WATCH_REMOVE, WATCH_CHANGED } from "./watchlistEvents";

/**
 * The reader's pinned records.
 *
 * Its own storage key, deliberately not the panel-positions record: "Reset
 * panel layout" wipes that one, and a reader who resets where their cards sit
 * has not asked to lose what they were tracking.
 */
export function useWatchlist(storage = typeof localStorage === "undefined" ? null : localStorage) {
  const [items, setItems] = useState(() => loadWatchlist(storage));

  const add = useCallback((entry) => {
    setItems((prev) => addWatch(prev, { addedAt: Date.now(), ...entry }));
  }, []);

  const remove = useCallback((key) => {
    setItems((prev) => removeWatch(prev, key));
  }, []);

  const has = useCallback((kind, id) => isWatched(items, kind, id), [items]);

  // Persist, and tell the imperative side. Both in one effect because they are
  // one fact -- "the list is now this" -- and splitting them would let a popup
  // repaint from a list that had not been written yet.
  useEffect(() => {
    saveWatchlist(items, storage);
    window.dispatchEvent(new CustomEvent(WATCH_CHANGED, { detail: { items } }));
  }, [items, storage]);

  useEffect(() => {
    const onAdd = (event) => add(event.detail);
    const onRemove = (event) => remove(watchKey(event.detail?.kind, event.detail?.id));
    window.addEventListener(WATCH_ADD, onAdd);
    window.addEventListener(WATCH_REMOVE, onRemove);
    return () => {
      window.removeEventListener(WATCH_ADD, onAdd);
      window.removeEventListener(WATCH_REMOVE, onRemove);
    };
  }, [add, remove]);

  return { items, add, remove, has };
}
