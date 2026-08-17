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
//
// It now takes the chrome insets too, and that is the fix rather than a
// refinement. This function knew only about the viewport, from a time when the
// map started at y=0 and the title bar above it was pointer-events: none. There
// are 78px of opaque, blurred bars there now, and a card is drawn at --z-cards,
// below both of them. So the card grew upward from the anchor, its own top edge
// went under the bars, and what went with it was the header: the place's name,
// Copy link, and the × that closes it. Clicking a country at y=300 on a 900px
// window put that header at y=-114.

// Matches the card's actual rendered width in style.css (`#countryInfoCard`)
// and the gap it keeps from the viewport edge.
export const CARD_WIDTH = 320;
export const CARD_MARGIN = 14;

// Matches `max-height: 44vh` on the four place cards in style.css. Needed here
// because the flip decision is really "is there room above the anchor for the
// card", and answering that without knowing how tall the card can be is what the
// bare `y < 220` literal below used to do -- a number chosen when the chrome was
// 46px tall and never revisited when it became 78.
export const CARD_MAX_HEIGHT_FRACTION = 0.44;

/**
 * @param {{x: number, y: number}|null|undefined} point  the anchor's live
 *   screen pixel, or absent (see PlaceInfoCard's own comment on why that can
 *   happen)
 * @param {{width: number, height: number}} viewport
 * @param {{top: number, bottom: number}} [insets]  the fixed chrome the card must
 *   clear. Defaults to none, so a caller with no chrome behaves exactly as this
 *   did before it existed.
 * @returns {{anchorStyle: object, flip: boolean, tailLeft: number}|null}
 *   `null` when there is no point to anchor to -- callers fall back to
 *   whatever position CSS (or a stored drag position) already supplies.
 */
export function computeAnchorLayout(point, viewport, insets = { top: 0, bottom: 0 }) {
  if (!point) return null;
  const { x, y } = point;
  const left = Math.min(
    Math.max(x - CARD_WIDTH / 2, CARD_MARGIN),
    viewport.width - CARD_WIDTH - CARD_MARGIN
  );
  const tailLeft = Math.min(Math.max(x - left, 16), CARD_WIDTH - 16); // stays under the real anchor even after clamping

  const topLimit = (insets.top || 0) + CARD_MARGIN;
  const maxHeight = viewport.height * CARD_MAX_HEIGHT_FRACTION;

  // Open downward when there is not enough room above the anchor for the card --
  // measured against the top of the *map*, not the top of the window. This
  // replaces `y < 220`: room is a function of how tall the card can get and where
  // the chrome ends, and neither of those was in that literal.
  const flip = y - maxHeight < topLimit;

  if (flip) {
    // Growing downward. The only thing to keep off is the bottom chrome, and the
    // card's own max-height plus overflow handles the rest.
    return { anchorStyle: { left, top: Math.max(y + 18, topLimit) }, flip, tailLeft };
  }

  // Growing upward from `bottom`. Clamped so the card's top edge cannot pass
  // above the map: without this the header slides under the bars, and because the
  // card is `overflow: hidden` it does not scroll to compensate -- the name and
  // the close button are simply not reachable.
  const maxBottomOffset = viewport.height - topLimit - maxHeight;
  const bottom = Math.min(viewport.height - y + 18, Math.max(maxBottomOffset, CARD_MARGIN));
  return { anchorStyle: { left, bottom }, flip, tailLeft };
}
