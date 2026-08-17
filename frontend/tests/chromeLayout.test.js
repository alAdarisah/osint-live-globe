import test from "node:test";
import assert from "node:assert/strict";

import {
  chromeInsets,
  chromeInsetProperties,
  TOP_BAR_HEIGHT,
  SUB_BAR_HEIGHT,
  HUD_HEIGHT,
  SCRUB_STRIP_HEIGHT,
  SCRUB_STRIP_HEIGHT_MOBILE,
  FEED_WIDTH,
  ADMIN_DRAWER_WIDTH,
  MOBILE_MAX_WIDTH,
} from "../src/hooks/chromeLayout.js";

test("the top inset is both bars, always", () => {
  // The bars are not conditional -- there is no state in which the map should
  // start at y=0 -- so this is the one inset nothing can argue with.
  for (const state of [{}, { feedOpen: true }, { mobile: true }, { scrubVisible: true, drawerOpen: true }]) {
    assert.equal(chromeInsets(state).top, TOP_BAR_HEIGHT + SUB_BAR_HEIGHT, JSON.stringify(state));
  }
  assert.equal(chromeInsets().top, 78);
});

test("the bottom inset grows by exactly the scrub strip", () => {
  assert.equal(chromeInsets({}).bottom, HUD_HEIGHT);
  assert.equal(chromeInsets({ scrubVisible: true }).bottom, HUD_HEIGHT + SCRUB_STRIP_HEIGHT);
  // Not affected by anything on the left edge.
  assert.equal(chromeInsets({ scrubVisible: true, feedOpen: true }).bottom, HUD_HEIGHT + SCRUB_STRIP_HEIGHT);
});

test("the left inset is the rail that is actually open", () => {
  assert.equal(chromeInsets({}).left, 0);
  assert.equal(chromeInsets({ feedOpen: true }).left, FEED_WIDTH);
  assert.equal(chromeInsets({ drawerOpen: true }).left, ADMIN_DRAWER_WIDTH);
});

test("the two left-edge surfaces never sum", () => {
  // useChromeLayout closes the feed when the drawer opens, so this state should
  // not arise -- but a caller that gets it wrong must produce one rail's worth
  // of inset, not 652px of it. A map shoved 652px right on a 1280px screen is
  // not a degraded layout, it is no layout.
  const both = chromeInsets({ feedOpen: true, drawerOpen: true }).left;
  assert.equal(both, Math.max(FEED_WIDTH, ADMIN_DRAWER_WIDTH));
  assert.ok(both < FEED_WIDTH + ADMIN_DRAWER_WIDTH);
});

test("a phone insets nothing on the left", () => {
  // Both rails become overlays there: 332px of a 375px screen is not a smaller
  // version of the desktop layout.
  assert.equal(chromeInsets({ mobile: true, feedOpen: true }).left, 0);
  assert.equal(chromeInsets({ mobile: true, drawerOpen: true }).left, 0);
  // ...but the bars and the HUD still take their space.
  assert.equal(chromeInsets({ mobile: true }).top, TOP_BAR_HEIGHT + SUB_BAR_HEIGHT);
  assert.equal(chromeInsets({ mobile: true }).bottom, HUD_HEIGHT);
});

test("the scrub strip is taller on a phone, and the inset knows it", () => {
  // The timestamp and the track do not fit on one line there, so the strip
  // wraps. It is positioned against the HUD and grows upward, so an inset that
  // under-reported its height would be an inset that let it cover the map --
  // which is exactly what a single shared constant would have done.
  assert.ok(SCRUB_STRIP_HEIGHT_MOBILE > SCRUB_STRIP_HEIGHT);
  assert.equal(chromeInsets({ scrubVisible: true, mobile: true }).bottom, HUD_HEIGHT + SCRUB_STRIP_HEIGHT_MOBILE);
  assert.equal(chromeInsets({ scrubVisible: true }).bottom, HUD_HEIGHT + SCRUB_STRIP_HEIGHT);
});

test("the breakpoint matches the one the stylesheet and the hook use", () => {
  // useIsMobileViewport.js and style.css's phones block both key off 700px. A
  // layout the JS thinks is mobile and the CSS thinks is not is a layout nobody
  // can reason about, so the number has exactly one home.
  assert.equal(MOBILE_MAX_WIDTH, 700);
});

test("the properties carry their units", () => {
  // Asserting the strings, not the numbers: `--chrome-top: 78` is silently
  // invalid in calc() and would fail as a layout, not as an error.
  assert.deepEqual(chromeInsetProperties(chromeInsets({ feedOpen: true, scrubVisible: true })), {
    "--chrome-top": "78px",
    "--chrome-left": "332px",
    "--chrome-bottom": "68px",
  });
  assert.deepEqual(chromeInsetProperties(chromeInsets({})), {
    "--chrome-top": "78px",
    "--chrome-left": "0px",
    "--chrome-bottom": "34px",
  });
});
