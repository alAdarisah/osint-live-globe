// Where the pointer is, in degrees, for the status strip's last cell.
//
// Deliberately not React state. A mousemove handler that calls setState re-runs
// the whole tree on every pixel of pointer travel, which on a map carrying
// several thousand markers is the one interaction guaranteed to feel broken --
// and the value being rendered is a single text node that nothing else reads.
//
// So this is the same "imperative in, module-level state out" shape
// map/iconTheme.js already uses: the map layer reports, one subscriber writes
// the text into a node it holds a ref to, and React never learns the pointer
// moved. map/cursor.js is a separate mechanism (it draws the reticle, and a
// reader can switch it off) -- this has to keep working when that is off, so
// it does not ride on it.

/** @type {((lat:number|null, lon:number|null) => void)|null} */
let sink = null;

/**
 * The status strip claims this cell. One subscriber, not a list: two things
 * reading the pointer would mean two of these and no way to tell which is
 * stale.
 *
 * @param {((lat:number|null, lon:number|null) => void)|null} next
 */
export function setCursorReadoutSink(next) {
  sink = typeof next === "function" ? next : null;
}

/**
 * Called from the map layer on every pointer move, and with (null, null) when
 * the pointer leaves the map. Cheap enough to call at pointer rate: one
 * function-exists check when nothing is listening.
 */
export function reportCursor(lat, lon) {
  if (sink) sink(lat, lon);
}
