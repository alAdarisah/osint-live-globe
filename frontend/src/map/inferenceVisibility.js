// Task 31: whether an inferred product's own card section draws at all, for
// the two products with no map layer of their own to hide (see
// settings/inferenceProducts.js's own note on "effect: card" versus
// "effect: layer" -- the layer half reuses layerWish and needs nothing here).
//
// Module-level rather than threaded through props, the same reason
// map/cursor.js's setCursorOptions and map/tileTintMotion.js's
// setTileTintAtRest are: decorators.js's cargoSection/portCallsSection/
// routeSection are plain functions called from deep inside an imperative
// render pass building a popup's HTML string, not React components a prop
// could reach.
let mode = {};

/** Called from useAppSettings.js whenever settings.inference.mode changes. */
export function setInferenceMode(next) {
  mode = next || {};
}

/**
 * Whether `key` (an INFERENCE_PRODUCTS key) is switched to "hide".
 *
 * Only "hide" is checked here -- "labelled" and "show" render a section
 * identically, per this project's own rule that an inference is never
 * presented as an observation (see global-constraints.md and
 * inferenceProducts.js's own note), so there is nothing for those two
 * states to disagree about at this call site.
 */
export function inferenceHidden(key) {
  return mode[key] === "hide";
}
