// The one piece of PlaceInfoCard's anchor math that does not need React,
// Leaflet or the DOM to be right or wrong: given the on-screen pixel a place
// is anchored to and the viewport it sits in, where does a CARD_WIDTH-wide
// card go, does it open above or below the anchor, and where does the tail
// (the little CSS arrow pointing back at the anchor) land under it.
//
// Pulled out of the component so it can be asserted directly under
// `node --test` -- the component itself reads `window.innerWidth`/
// `window.innerHeight`, which do not exist there, but the arithmetic that
// consumes those two numbers does not care where they came from.

// Matches the card's actual rendered width in style.css (`#countryInfoCard`)
// and the gap it keeps from the viewport edge.
export const CARD_WIDTH = 320;
export const CARD_MARGIN = 14;

/**
 * @param {{x: number, y: number}|null|undefined} point  the anchor's live
 *   screen pixel, or absent (see PlaceInfoCard's own comment on why that can
 *   happen)
 * @param {{width: number, height: number}} viewport
 * @returns {{anchorStyle: object, flip: boolean, tailLeft: number}|null}
 *   `null` when there is no point to anchor to -- callers fall back to
 *   whatever position CSS (or a stored drag position) already supplies.
 */
export function computeAnchorLayout(point, viewport) {
  if (!point) return null;
  const { x, y } = point;
  const left = Math.min(
    Math.max(x - CARD_WIDTH / 2, CARD_MARGIN),
    viewport.width - CARD_WIDTH - CARD_MARGIN
  );
  const tailLeft = Math.min(Math.max(x - left, 16), CARD_WIDTH - 16); // stays under the real anchor even after clamping
  const flip = y < 220; // not enough room above the anchor near the top edge -- open downward instead
  const anchorStyle = flip ? { left, top: y + 18 } : { left, bottom: viewport.height - y + 18 };
  return { anchorStyle, flip, tailLeft };
}
