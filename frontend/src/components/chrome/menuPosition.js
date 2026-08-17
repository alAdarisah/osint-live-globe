// Where a bar's dropdown goes, once it has stopped being a child of the bar.
//
// Both menus in the new chrome hang off a button inside a bar, and both bars
// carry `backdrop-filter: blur(8px)`, which makes each one a stacking context --
// so a menu rendered as a child of its bar has its z-index resolved *inside*
// that bar and can never rise above anything painted over it. zindex.css says so
// in as many words, and names --z-menu as the band a portalled menu lands in.
// There was a second, worse problem: #topBar .cat-strip scrolls horizontally,
// and a scroll container clips both axes, so the category menu was being cut off
// entirely by an ancestor 26px tall.
//
// Portalling to the body fixes both, and costs one thing: an absolutely
// positioned menu inside its own wrapper knew where it was for free, and a
// portalled one has to be told. This is the arithmetic that tells it, kept pure
// and DOM-free so the clamping can be asserted under `node --test` -- the
// component that consumes it reads getBoundingClientRect(), which does not exist
// there, but none of the maths below cares where the numbers came from.

/** Gap between the anchor's bottom edge and the menu's top edge. */
export const MENU_GAP = 8;
/** Smallest gap the menu keeps from any viewport edge. */
export const MENU_MARGIN = 8;
/** Below this much room, a menu is a scrollbar with a hint of content. */
export const MENU_MIN_HEIGHT = 120;

// The two menus' own min-widths, which the horizontal clamp needs in order to
// keep the whole menu on screen rather than just its left edge. Declared here
// and asserted against chrome.css by tests/menuPosition.test.js, because a
// number that lives in a stylesheet and in a clamp is a number that drifts:
// widen the CSS alone and the rightmost pill's menu starts hanging off the edge
// again, silently, on exactly the narrow screens the clamp is for.
export const CAT_MENU_MIN_WIDTH = 300;
export const BOARDS_MENU_MIN_WIDTH = 280;

/**
 * @param {{left: number, right: number, top: number, bottom: number}} anchor
 *   the trigger's viewport rect (a DOMRect satisfies this)
 * @param {{width: number, height: number}} viewport
 * @param {object} [options]
 * @param {number} [options.minWidth]     the menu's own min-width, so the
 *   horizontal clamp can keep the whole menu on screen rather than just its
 *   left edge
 * @param {number} [options.bottomInset]  chrome at the bottom of the screen the
 *   menu must clear (the HUD, and the scrub strip while replaying)
 * @param {"left"|"right"} [options.align]  which of the menu's edges lines up
 *   with the trigger. "right" for a trigger near the right of its bar, so the
 *   menu opens inward rather than immediately hitting the clamp.
 * @param {number} [options.gap]
 * @param {number} [options.margin]
 * @returns {{left: number, top: number, maxHeight: number}} viewport pixels, for
 *   a `position: fixed` element
 */
export function anchorMenuStyle(anchor, viewport, options = {}) {
  const {
    minWidth = 0,
    bottomInset = 0,
    align = "left",
    gap = MENU_GAP,
    margin = MENU_MARGIN,
  } = options;

  const top = anchor.bottom + gap;

  // Aligned to the trigger, then pulled back so the menu's *far* edge clears the
  // viewport too. Clamped low-side last, so on a screen narrower than the menu
  // the left edge wins and the overflow goes off the right -- where the menu's
  // own max-width (92vw in chrome.css) has already bounded it -- rather than off
  // the left, where there is no scroll to recover it.
  const wanted = align === "right" ? anchor.right - minWidth : anchor.left;
  const rightLimit = viewport.width - minWidth - margin;
  const left = Math.max(margin, Math.min(wanted, rightLimit));

  // What is left of the screen under the menu's top edge. Floored rather than
  // allowed to go negative: a negative max-height collapses the menu to nothing,
  // which reads as "the button does not work" -- the exact failure this module
  // exists to end. At the floor the menu scrolls instead.
  const room = viewport.height - top - margin - bottomInset;
  const maxHeight = Math.max(MENU_MIN_HEIGHT, room);

  return { left, top, maxHeight };
}
