// The ✓ Watch button on every map popup.
//
// Popups on this map are HTML strings: forty-odd `decorate*` functions in
// map/decorators.js build them, several run to a hundred lines, and between
// them they carry every provenance caveat this project exists to state. There
// is no React inside one, and threading a button through all of them would mean
// editing forty string builders to add the same markup -- forty chances to
// disturb a caveat, in the files whose exact wording tests/emptyState.test.js
// pins.
//
// So nothing here touches a popup's HTML. The button is appended to the popup's
// DOM after Leaflet has opened it, from one `popupopen` listener, and the click
// is handled by one delegated listener on the document. Adding a new popup kind
// needs no work here, and a popup that this cannot identify simply does not get
// a button rather than getting a broken one.

import { ID_FIELD } from "./recordIds.js";
import { WATCH_ADD, WATCH_REMOVE, WATCH_CHANGED } from "../hooks/watchlistEvents.js";

const BUTTON_CLASS = "pp-watch";
const ROW_CLASS = "pp-actions";

/**
 * Which feed a marker belongs to, from the `layer-<key>` class the controller
 * already stamps on every icon (see tagIconLayer). Read off the DOM rather than
 * tracked separately because that class is stamped for the emphasis mechanism
 * and is therefore already guaranteed correct for every marker that has one.
 */
function layerKeyOf(marker) {
  const className = marker?._icon?.className || marker?.options?.icon?.options?.className || "";
  const match = /(?:^|\s)layer-([A-Za-z]\w*)/.exec(className);
  return match ? match[1] : null;
}

/**
 * The stored entry for whatever this popup is about, or null if it cannot be
 * named. Null is a real answer: a country shape, a cable route, a coverage
 * rectangle and a cluster are all legitimately un-pinnable, and offering a
 * button that cannot resolve later is worse than offering none.
 */
export function watchEntryForMarker(marker) {
  const item = marker?._item;
  if (!item) return null;
  const kind = layerKeyOf(marker);
  const idField = kind ? ID_FIELD[kind] : null;
  if (!kind || !idField) return null;
  const id = item[idField];
  if (id == null || id === "") return null;

  // Whatever the popup's own heading says, so a watchlist row reads the same as
  // the thing it was pinned from. Falls back through the fields these feeds
  // actually carry rather than to a generic label.
  const label = item.title || item.name || item.real_title || item.callsign || item.shipname
    || item.headline || `${kind} ${id}`;

  return {
    kind,
    id: String(id),
    label: String(label).slice(0, 120),
    lat: Number.isFinite(item.lat) ? item.lat : null,
    lon: Number.isFinite(item.lon) ? item.lon : null,
  };
}

function renderButton(button, watched) {
  button.textContent = watched ? "✓ Watching" : "✓ Watch";
  button.classList.toggle("on", watched);
  button.title = watched
    ? "Remove this record from your watchlist"
    : "Keep this record in your watchlist, in the feed rail";
  // Deliberately not disabled once watched. The prototype this was built from
  // disables its pin button, which means the only way to undo a misclick is to
  // find the row in the rail -- and it also loses the button's state entirely
  // the moment the popup is reopened, because Leaflet rebuilds popup content
  // from scratch each time. A toggle has neither problem.
  button.setAttribute("aria-pressed", watched ? "true" : "false");
}

/**
 * @param {L.Map} map
 * @param {() => Array} readList  the current watchlist, for the button's state
 * @returns {() => void} detach
 */
export function attachWatchlistActions(map, readList) {
  if (!map) return () => {};

  const isWatched = (kind, id) => (readList() || [])
    .some((item) => item.kind === kind && String(item.id) === String(id));

  /**
   * Put the button into a popup that is already on screen.
   *
   * Idempotent, and it has to be: several popup kinds fill themselves in
   * asynchronously (a port's traffic, a point's satellite passes, the overpass
   * prediction) and each of those calls setContent when it resolves, which
   * replaces the whole content element and takes anything appended to it with
   * it. That is why this is bound to `contentupdate` as well as to the open --
   * appending once looked correct for about half a second.
   */
  const addButton = (popup) => {
    const entry = watchEntryForMarker(popup?._source);
    if (!entry) return;
    const content = popup.getElement()?.querySelector(".leaflet-popup-content");
    if (!content || content.querySelector(`.${BUTTON_CLASS}`)) return;

    const row = document.createElement("div");
    row.className = ROW_CLASS;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `pp-btn ${BUTTON_CLASS}`;
    for (const [key, value] of Object.entries(entry)) {
      if (value != null) button.dataset[`watch${key[0].toUpperCase()}${key.slice(1)}`] = String(value);
    }
    renderButton(button, isWatched(entry.kind, entry.id));
    row.appendChild(button);
    content.appendChild(row);
  };

  const onPopupOpen = (event) => {
    const popup = event.popup;
    addButton(popup);
    // Rebound per open rather than once: `popup` here is whichever popup just
    // opened, and Leaflet reuses one object per marker rather than one for the
    // map. `off` first so reopening the same popup does not stack listeners.
    popup.off("contentupdate", onContentUpdate);
    popup.on("contentupdate", onContentUpdate);
  };

  function onContentUpdate(event) {
    addButton(event.target || event.sourceTarget);
  }

  const onPopupClose = (event) => {
    event.popup?.off("contentupdate", onContentUpdate);
  };

  // One listener on the document rather than one per popup: Leaflet rebuilds a
  // popup's content every time it opens, so a per-popup binding is a binding
  // that has to be re-made continuously and leaks if it is not torn down.
  const onClick = (event) => {
    const button = event.target.closest?.(`.${BUTTON_CLASS}`);
    if (!button) return;
    const { watchKind, watchId, watchLabel, watchLat, watchLon } = button.dataset;
    if (!watchKind || !watchId) return;
    const watched = button.classList.contains("on");
    window.dispatchEvent(new CustomEvent(watched ? WATCH_REMOVE : WATCH_ADD, {
      detail: {
        kind: watchKind,
        id: watchId,
        label: watchLabel,
        lat: watchLat == null ? null : Number(watchLat),
        lon: watchLon == null ? null : Number(watchLon),
      },
    }));
  };

  // The list can change while a popup is open -- from the rail's own ✕, or from
  // a second popup -- so the button repaints from the list rather than from its
  // own click. That also makes it correct on reopen, which is the bug the
  // prototype's disabled-once-pinned button has.
  const onChanged = () => {
    for (const button of document.querySelectorAll(`.${BUTTON_CLASS}`)) {
      renderButton(button, isWatched(button.dataset.watchKind, button.dataset.watchId));
    }
  };

  map.on("popupopen", onPopupOpen);
  map.on("popupclose", onPopupClose);
  document.addEventListener("click", onClick);
  window.addEventListener(WATCH_CHANGED, onChanged);

  return () => {
    map.off("popupopen", onPopupOpen);
    map.off("popupclose", onPopupClose);
    document.removeEventListener("click", onClick);
    window.removeEventListener(WATCH_CHANGED, onChanged);
  };
}
