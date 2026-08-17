// Things a reader has pinned to come back to.
//
// NAMING, because there are now two unrelated "watchlists" in this codebase and
// conflating them would be a real bug:
//
//   vesselFilter.watchlistedOnly (utils/entityFilter.js) filters ships by the
//   `watchlist` field backend/sources/ais.py attaches to a hull -- somebody
//   else's published list of vessels of interest, a fact about the world.
//
//   This is the reader's own scratchpad: whatever they clicked ✓ on, stored in
//   their browser, meaning nothing to anyone else.
//
// Neither is renamed. They are different things that happen to share an English
// word, and the fix for that is to say so here rather than to invent a worse
// name for one of them.
//
// Pure, with storage injected, so the corrupt-JSON and quota-exceeded paths can
// be tested headlessly -- both are real (a hand-edited localStorage, a full
// quota on a long session) and neither should ever cost a reader their map.

export const WATCHLIST_KEY = "osint-watchlist";
const VERSION = 1;

// A ceiling rather than unbounded: a stuck click or a script should not be able
// to fill a reader's storage quota, and a list nobody can read the end of is not
// a watchlist. Oldest out first -- the newest pin is the one being worked on.
export const MAX_ITEMS = 200;

/** `kind:id` -- the map controller's own record vocabulary, so a row can ask
 *  for the same detail card a pin opens. */
export function watchKey(kind, id) {
  return `${kind}:${id}`;
}

/**
 * A stored entry, or null if it is not usable.
 *
 * `kind` and `id` are required because without both there is nothing to open
 * and nothing to deduplicate against. Coordinates are optional and explicitly
 * nullable: a country or an aggregate is a legitimate thing to pin and has no
 * single point, and storing 0,0 for "no position" would put it in the Gulf of
 * Guinea.
 */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = typeof raw.kind === "string" ? raw.kind.trim() : "";
  const id = raw.id == null ? "" : String(raw.id).trim();
  if (!kind || !id) return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  return {
    kind,
    id,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : `${kind} ${id}`,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    addedAt: Number.isFinite(Number(raw.addedAt)) ? Number(raw.addedAt) : 0,
  };
}

export function loadWatchlist(storage) {
  try {
    const raw = storage?.getItem(WATCHLIST_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || parsed.v !== VERSION || !Array.isArray(parsed.items)) return [];
    // Each entry re-validated on the way in, not just the envelope: this is
    // browser storage, which anyone can edit and a half-finished write can
    // truncate.
    return parsed.items.map(normalizeEntry).filter(Boolean).slice(0, MAX_ITEMS);
  } catch {
    return []; // unreadable, disabled or corrupt storage is not a reason to fail to render
  }
}

export function saveWatchlist(list, storage) {
  try {
    storage?.setItem(WATCHLIST_KEY, JSON.stringify({ v: VERSION, items: list }));
    return true;
  } catch {
    // A full quota or private mode. The list still works for this session; it
    // just will not be remembered, which is the same bargain useAccordion and
    // useDraggablePanel already strike.
    return false;
  }
}

export function isWatched(list, kind, id) {
  const key = watchKey(kind, id);
  return (list || []).some((item) => watchKey(item.kind, item.id) === key);
}

/**
 * Adds an entry, or returns the list unchanged if it is already there.
 *
 * Unchanged by identity, not just by content: the caller uses that to decide
 * whether anything needs persisting or repainting, and a new array every time
 * would make every duplicate click a write.
 */
export function addWatch(list, raw) {
  const entry = normalizeEntry(raw);
  if (!entry) return list;
  const current = list || [];
  if (isWatched(current, entry.kind, entry.id)) return list;
  // Newest first, and trimmed from the tail so the ceiling drops the oldest.
  return [entry, ...current].slice(0, MAX_ITEMS);
}

export function removeWatch(list, key) {
  const current = list || [];
  const next = current.filter((item) => watchKey(item.kind, item.id) !== key);
  return next.length === current.length ? list : next;
}
