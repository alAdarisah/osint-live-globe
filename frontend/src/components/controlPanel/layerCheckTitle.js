// What a layer checkbox says about itself, in each of the states it can be in.
//
// These strings used to be inline in LayerCheck.jsx, and two of the four said
// "Overrides the scene for every reader of this deployment." That was true in
// the one place the control existed: Admin Mode's drawer, whose ticks are saved
// to the shared data/admin_config.json and do reach every reader.
//
// It stopped being true the moment the same control appeared in the top bar's
// category pills, where a tick is session-only -- it never leaves the tab (see
// App.jsx's onToggleLayer). A control that tells a reader they have just changed
// what everyone else sees, when they have not, is worse than one that says
// nothing: it is the difference between "adjusting my own view" and "editing a
// deployment", and only one of those is a thing to be careful about.
//
// So the wording takes the scope as an argument. Extracted from the component so
// the eight strings can be tested without a DOM -- and so the promise the
// deployment-wide wording makes can be pinned to the one scope that can keep it.

/** Which store a tick from this control lands in. */
export const SCOPE_SESSION = "session";
export const SCOPE_DEPLOYMENT = "deployment";

/**
 * @param {object} state
 * @param {boolean} state.pinned    a wish exists (the resolver is overridden)
 * @param {boolean} state.withheld  pinned on, but the zoom gate is holding it back
 * @param {boolean|undefined} state.wish  the standing decision itself
 * @param {"session"|"deployment"} state.scope
 */
export function layerCheckTitle({ pinned, withheld, wish, scope = SCOPE_SESSION }) {
  if (!pinned) {
    return "Chosen by the scene: zoom, what the camera is over, and what you have clicked. Tick to override.";
  }
  if (withheld) {
    return "Pinned on, but held back by this layer's zoom gate — zoom in, or lower the gate in Admin Mode.";
  }
  // Both halves are load-bearing. The first says what the tick did; the second
  // says how far it reaches and how to undo it. A session tick has to say it is
  // not saved, because the drawer's version is, and a reader who has seen one
  // will assume the other.
  const reach = scope === SCOPE_DEPLOYMENT
    ? "Overrides the scene for every reader of this deployment."
    : "Overrides the scene for this session only — not saved, and not shared. Hand it back with ↺.";
  return `${wish ? "Pinned on" : "Pinned off"}. ${reach}`;
}
