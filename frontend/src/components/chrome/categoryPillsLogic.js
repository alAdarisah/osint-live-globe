// The decisions the category pills make, with no DOM in them.
//
// Small, but each one is a place the pills could quietly disagree with the
// reader's drawer about the same layers -- which is the failure
// settings/layerGroups.js was created to stop one tier down.

import { countedKeysFor } from "../../settings/layerGroups.js";

/**
 * How many of a group's layers the map is currently drawing.
 *
 * Counted off what the map reports it is doing, not off the wish table, and
 * over countedKeysFor -- so the badge on a pill and the "n/m" on the same
 * group's heading in the drawer are computed the same way from the same keys
 * and cannot drift.
 */
export function pillCount(groupId, layerVisibility) {
  const keys = countedKeysFor(groupId);
  const on = keys.filter((key) => layerVisibility?.[key]).length;
  return { on, total: keys.length };
}

/**
 * One dropdown open at a time.
 *
 * Clicking the open pill closes it; clicking any other switches. An accordion
 * rather than several open menus: the pills sit in a 44px bar and two 270px
 * dropdowns side by side would cover most of the map with controls, which is
 * the arrangement the drawer already existed to avoid.
 */
export function nextOpenCategory(current, clicked) {
  return current === clicked ? null : clicked;
}

/**
 * What Reset actually does: hand every layer back to the scene resolver.
 *
 * Not "tick everything", which is what the design prototype's Reset does. On a
 * tri-state control the neutral state is not "all on" -- it is "nobody has
 * decided", which is what an untouched map is and what the ↺ button already
 * means one layer at a time (see LayerCheck.jsx). Ticking all forty layers is
 * not a reset; it is the single most opinionated thing a reader could do to
 * this map, and it would bury the ones that matter under the ones that do not.
 *
 * Returns the keys to hand back, so the caller decides which stores to clear --
 * the session's override table always, and the shared deployment config only in
 * Admin Mode.
 */
export function resetTargets(layerWish) {
  if (!layerWish || typeof layerWish !== "object") return [];
  return Object.keys(layerWish);
}

/**
 * Whether a group has anything a reader has overridden -- used to mark a pill
 * as carrying decisions of its own, so "I changed something in here" is visible
 * without opening the dropdown.
 */
export function groupHasWishes(groupId, layerWish) {
  return countedKeysFor(groupId).some((key) => layerWish?.[key] !== undefined);
}
