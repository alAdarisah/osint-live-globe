// How much of the screen the fixed chrome is occupying, right now.
//
// The map and roughly twenty floating panels all need the same three numbers,
// and before this they each carried their own copy of them as literals -- a
// panel at `top: 80px` was a panel that silently stopped clearing the header
// the day the header changed height, and nothing said so except the panel
// looking slightly wrong. One function, three custom properties, and every
// anchor in style.css expressed against them.
//
// Pure and DOM-free on purpose: hooks/useChromeLayout.js is the thin writer
// that puts the result on <html>, and this is the part that can be reasoned
// about (and tested) without a browser.

/** Brand, category pills, stats, clock, theme. */
export const TOP_BAR_HEIGHT = 44;
/** Feed toggle, time window, replay, search, boards/copy/export/admin. */
export const SUB_BAR_HEIGHT = 34;
/** Escalation, jamming, counts, latency, sources, attribution, cursor. */
export const HUD_HEIGHT = 34;
/** The replay scrubber, which only exists while the map is not live. */
export const SCRUB_STRIP_HEIGHT = 34;
/** The same strip on a phone, where the timestamp and the track will not fit on
 *  one line and it wraps to two. A second constant rather than a guess: the
 *  strip is positioned against the HUD and grows upward, so an inset that
 *  under-reports its height is an inset that lets it cover the map. */
export const SCRUB_STRIP_HEIGHT_MOBILE = 64;

/** The intel feed rail. */
export const FEED_WIDTH = 332;
/** Admin Mode's layer drawer -- unchanged from what it has always been. */
export const ADMIN_DRAWER_WIDTH = 320;

// The same breakpoint hooks/useIsMobileViewport.js watches and style.css's
// phones block uses. Exported so the three cannot drift about what "a phone"
// means -- a layout the JS thinks is mobile and the CSS thinks is not is a
// layout nobody can reason about.
export const MOBILE_MAX_WIDTH = 700;

/**
 * @param {object} state
 * @param {boolean} [state.feedOpen]     the intel rail is showing
 * @param {boolean} [state.drawerOpen]   Admin Mode's layer drawer is showing
 * @param {boolean} [state.scrubVisible] the replay strip is showing
 * @param {boolean} [state.mobile]       viewport is at or under MOBILE_MAX_WIDTH
 * @returns {{top:number, left:number, bottom:number}} pixels
 */
export function chromeInsets({ feedOpen = false, drawerOpen = false, scrubVisible = false, mobile = false } = {}) {
  return {
    top: TOP_BAR_HEIGHT + SUB_BAR_HEIGHT,

    // Zero on a phone because neither the feed nor the drawer insets the map
    // there -- both become overlays. A 332px rail on a 375px screen leaves 43px
    // of map, which is not a smaller version of the desktop layout, it is a
    // different one.
    //
    // max() rather than a sum: the rail and the drawer occupy the same edge and
    // useChromeLayout closes the feed when the drawer opens, so they are never
    // both up. The max is what makes that a belt-and-braces fact rather than
    // something a future caller can get wrong by passing both.
    left: mobile ? 0 : Math.max(feedOpen ? FEED_WIDTH : 0, drawerOpen ? ADMIN_DRAWER_WIDTH : 0),

    bottom: HUD_HEIGHT + (scrubVisible ? (mobile ? SCRUB_STRIP_HEIGHT_MOBILE : SCRUB_STRIP_HEIGHT) : 0),
  };
}

/**
 * The insets as the CSS custom properties every anchor reads. Split out from
 * the writer so a test can assert the exact strings that reach the stylesheet,
 * rather than asserting numbers and hoping the units are appended.
 */
export function chromeInsetProperties(insets) {
  return {
    "--chrome-top": `${insets.top}px`,
    "--chrome-left": `${insets.left}px`,
    "--chrome-bottom": `${insets.bottom}px`,
  };
}
