// How the imperative half of the app reaches the watchlist.
//
// Map popups are HTML handed to Leaflet -- there is no React inside one -- so a
// ✓ Watch button cannot call a setter. It dispatches one of these on `window`
// instead, and hooks/useWatchlist.js is the single listener that turns it into
// state. WATCH_CHANGED runs the other way, so a popup that is already open
// repaints its button when the list changes underneath it.
//
// Their own module rather than exports of the hook: map/watchlistActions.js
// needs the names and must not import React to get them -- it is loaded by
// plain `node --test`, and by the map layer, neither of which has any business
// pulling a hook in.

export const WATCH_ADD = "osint-watchlist-add";
export const WATCH_REMOVE = "osint-watchlist-remove";
export const WATCH_CHANGED = "osint-watchlist-change";
