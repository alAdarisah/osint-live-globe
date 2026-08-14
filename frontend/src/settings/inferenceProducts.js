// Task 31: the tri-state switch (hide / labelled / show) per inferred
// product, and which of the two things it can actually mean lands on --
// see InferenceSection.jsx for the full explanation shown next to the
// control, and map/inferenceVisibility.js for the module-level store
// decorators.js's card-section builders read.
//
// Five entries, not the brief's six: cargo class and laden/ballast state are
// two separate threshold groups (see backend/inference_config.py -- AIS
// ship-type code lookup versus a draught-history verdict, genuinely
// different things) but they render as one inseparable HTML block on the
// ship card (decorators.js's cargoSection), so there is exactly one on/off
// switch for both rather than a second control that could disagree with the
// first about whether the section is even there.
//
// `effect: "layer"` products already have a real map layer with its own
// checkbox in the control drawer (see LAYER_MANIFEST/SETTINGS_LAYERS) -- for
// those, this switch writes straight into the same `layerWish` a drawer tick
// would (see LayerCheck.jsx, whose three states this reuses rather than
// inventing a second idiom): hide -> pinned off, show -> pinned on, labelled
// -> unset, handed back to the scene resolver, which already draws the
// layer with its inferred treatment whenever it draws it at all -- hence
// "labelled" rather than "auto" as the label for that middle state.
//
// `effect: "card"` products have no layer of their own -- they are fields
// folded into an existing card (the ship card's cargo/port-calls sections,
// the aircraft card's route section) -- so the switch instead gates whether
// that section renders at all. "labelled" and "show" render it identically:
// this project's own rule (see global-constraints.md) is that an inference
// is never presented as an observation, so there is no state here that
// drops a section's own honesty caveat -- only "hide" changes anything.
export const INFERENCE_STATES = ["hide", "labelled", "show"];
export const DEFAULT_INFERENCE_STATE = "labelled";

export const INFERENCE_PRODUCTS = [
  {
    key: "cargoProfile",
    label: "Cargo class & laden/ballast draught",
    effect: "card",
    backendKeys: ["cargo_class", "laden_ballast"],
  },
  {
    key: "darkShip",
    label: "Dark-ship gaps, transfers & reachability",
    effect: "layer",
    layerKey: "darkVessels",
    backendKeys: ["dark_ship"],
  },
  {
    key: "portCalls",
    label: "Port calls",
    effect: "card",
    backendKeys: ["port_calls"],
  },
  {
    key: "laneDensity",
    label: "AIS traffic density",
    effect: "layer",
    layerKey: "laneDensity",
    backendKeys: ["lane_density"],
  },
  {
    key: "flightLegs",
    label: "Flight legs",
    effect: "card",
    backendKeys: ["flight_legs"],
  },
  {
    key: "jamCrosscheck",
    label: "GPS jamming cross-check",
    effect: "card",
    backendKeys: ["jam_crosscheck"],
  },
];

/**
 * A stored inference-mode map, with every unknown or malformed entry dropped
 * and every product given the shipped default.
 *
 * Same shape of repair mergeSettings applies everywhere else in this file's
 * sibling defaults.js: an old config that predates a product still merges
 * cleanly (that product simply was not there to record), and a value this
 * build does not recognise (a state removed, a product renamed) falls back
 * rather than sticking around as a string nothing reads.
 */
export function mergeInferenceMode(stored) {
  const base = Object.fromEntries(INFERENCE_PRODUCTS.map((p) => [p.key, DEFAULT_INFERENCE_STATE]));
  if (!stored || typeof stored !== "object") return base;
  for (const product of INFERENCE_PRODUCTS) {
    const value = stored[product.key];
    if (INFERENCE_STATES.includes(value)) base[product.key] = value;
  }
  return base;
}
