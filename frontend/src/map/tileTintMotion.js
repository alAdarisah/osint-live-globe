// Task 30: whether the tinted tile panes' filter and colour overlay switch
// off while the map is actually moving, restoring the instant it settles.
//
// Why this exists at all: `filter` (blur especially) forces the browser to
// give the pane its own GPU compositing layer and re-rasterize that layer on
// every frame it changes -- and during a pan or a zoom animation, the pane's
// own transform changes on every frame, which is exactly the case that costs
// the most. Measured against this map's own tile panes (see
// task-30-report.md for the numbers and what they do and do not cover): a
// plain filter with no blur showed no measurable frame cost, but blur turned
// up is the known-expensive case CSS filters have, and none of it can be
// proven safe on every reader's GPU from here -- so the escape hatch ships
// alongside the dial that can trigger it, off by default.
//
// A module-level flag rather than a prop, for the same reason map/cursor.js's
// setCursorOptions is one (see its own note, and useAppSettings.js's on why
// setIconTheme is too): the map is imperative, movestart/moveend are wired up
// once at construction deep inside createMapController.js, and threading a
// live setting through props all the way down there would make every
// intermediate layer a courier for something it never reads.
let atRest = false;

/** Called from useAppSettings.js whenever settings.ui.tiles.applyAtRest changes. */
export function setTileTintAtRest(enabled) {
  atRest = enabled === true;
}

/**
 * Wires movestart/zoomstart/moveend/zoomend on `map` to a class on its own
 * container. style.css gates the tinted panes' filter and ::after tint off
 * while `.tile-tint-panning` is present -- see the rules next to
 * `.leaflet-tile-pane`'s filter there.
 *
 * Called once, from createMapController.js's setup. Returns a teardown for
 * destroy() to call, the same shape attachCursor already uses there.
 */
export function attachTileTintMotionGate(map) {
  const container = map.getContainer();
  // Only added while the setting is on -- when it is off this still runs on
  // every movestart, but a no-op classList add/remove pair costs nothing
  // worth branching around, and it means flipping the setting mid-flight (see
  // setTileTintAtRest above) takes effect on the very next gesture rather
  // than needing the listeners re-attached.
  const start = () => {
    if (atRest) container.classList.add("tile-tint-panning");
  };
  const end = () => container.classList.remove("tile-tint-panning");
  map.on("movestart zoomstart", start);
  map.on("moveend zoomend", end);
  return () => {
    map.off("movestart zoomstart", start);
    map.off("moveend zoomend", end);
    container.classList.remove("tile-tint-panning");
  };
}
