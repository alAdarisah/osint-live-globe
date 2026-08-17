// PlaceInfoCard's anchor placement math, asserted.
//
// PlaceInfoCard.jsx itself is not importable here -- it is JSX, and this
// suite runs under plain `node --test` with no build step (see cursor.test.js
// for the same constraint). Everything else the card does -- the accordion,
// the drag hook, the delegated row-click handler -- either needs a DOM
// (React, pointer events, localStorage-backed hooks) or is a two-line pass
// through to a hook already covered by its own module, so none of it is
// headlessly testable without faking a DOM. What *is* a pure function of
// plain numbers is where the card lands relative to its anchor point and
// where its tail sits underneath it -- computeAnchorLayout, pulled out into
// placeInfoCardLayout.js for exactly this reason.

import test from "node:test";
import assert from "node:assert/strict";

import {
  computeAnchorLayout, CARD_WIDTH, CARD_MARGIN, CARD_MAX_HEIGHT_FRACTION,
} from "../src/components/placeInfoCardLayout.js";

const VIEWPORT = { width: 1280, height: 800 };

test("no anchor point", async (t) => {
  await t.test("returns null so the caller falls back to CSS/stored position", () => {
    assert.equal(computeAnchorLayout(null, VIEWPORT), null);
    assert.equal(computeAnchorLayout(undefined, VIEWPORT), null);
  });
});

test("horizontal placement", async (t) => {
  await t.test("centres the card under the anchor when there is room on both sides", () => {
    const { anchorStyle, tailLeft } = computeAnchorLayout({ x: 640, y: 400 }, VIEWPORT);
    assert.equal(anchorStyle.left, 640 - CARD_WIDTH / 2);
    // The tail sits directly under the anchor pixel relative to the card's
    // own left edge, when clamping hasn't had to move that edge.
    assert.equal(tailLeft, 640 - anchorStyle.left);
  });

  await t.test("clamps the left edge to CARD_MARGIN near the left of the viewport", () => {
    const { anchorStyle, tailLeft } = computeAnchorLayout({ x: 5, y: 400 }, VIEWPORT);
    assert.equal(anchorStyle.left, CARD_MARGIN);
    // The tail still points at the real anchor (x=5) even though the card's
    // edge was pushed right of it -- clamped to the 16px floor, not negative.
    assert.equal(tailLeft, 16);
  });

  await t.test("clamps the right edge to CARD_MARGIN near the right of the viewport", () => {
    const { anchorStyle, tailLeft } = computeAnchorLayout({ x: 1275, y: 400 }, VIEWPORT);
    assert.equal(anchorStyle.left, VIEWPORT.width - CARD_WIDTH - CARD_MARGIN);
    // Same clamp, the other direction: the tail is pinned to the card's own
    // right edge (CARD_WIDTH - 16) rather than running off past it.
    assert.equal(tailLeft, CARD_WIDTH - 16);
  });

  await t.test("widening the viewport moves the right-edge clamp with it", () => {
    const narrow = computeAnchorLayout({ x: 1275, y: 400 }, VIEWPORT);
    const wide = computeAnchorLayout({ x: 1275, y: 400 }, { width: 1920, height: 800 });
    assert.ok(wide.anchorStyle.left > narrow.anchorStyle.left);
  });
});

test("vertical placement / flip", async (t) => {
  await t.test("opens upward (anchored by `bottom`) when there is room above", () => {
    const { anchorStyle, flip } = computeAnchorLayout({ x: 640, y: 400 }, VIEWPORT);
    assert.equal(flip, false);
    assert.equal(anchorStyle.top, undefined);
    assert.equal(anchorStyle.bottom, VIEWPORT.height - 400 + 18);
  });

  await t.test("flips to open downward (anchored by `top`) near the top edge", () => {
    const { anchorStyle, flip } = computeAnchorLayout({ x: 640, y: 100 }, VIEWPORT);
    assert.equal(flip, true);
    assert.equal(anchorStyle.bottom, undefined);
    assert.equal(anchorStyle.top, 100 + 18);
  });

  await t.test("the flip boundary is where the card stops fitting above the anchor", () => {
    // This used to assert 219/220, which was the literal `y < 220` in the code --
    // a number chosen when the chrome above the map was 46px tall, and never
    // revisited when it became 78. Asserting the rule instead: there is room above
    // the anchor when the card's full height clears the top of the map.
    const room = VIEWPORT.height * CARD_MAX_HEIGHT_FRACTION + CARD_MARGIN;
    assert.equal(computeAnchorLayout({ x: 640, y: Math.ceil(room) - 1 }, VIEWPORT).flip, true);
    assert.equal(computeAnchorLayout({ x: 640, y: Math.ceil(room) + 1 }, VIEWPORT).flip, false);
  });
});

// ---------- the chrome the card has to stay out of ----------
//
// The four place cards are drawn at --z-cards, below #subBar and #topBar, and both
// of those are opaque with a backdrop-filter. So a card whose top edge goes above
// the map does not merely overlap the bars -- it is *behind* them, and because the
// card is `overflow: hidden` it does not scroll to compensate. What is up there is
// the header: the place's name, Copy link, and the × that closes it.
//
// This function knew only about the viewport. On a 900px window a click at y=300
// put that header at y=-114.

const CHROME = { top: 78, bottom: 34 };

test("the card's top edge never goes above the map", async (t) => {
  await t.test("at every anchor row, from the top of the map to the bottom", () => {
    for (let y = 0; y <= VIEWPORT.height; y += 10) {
      const { anchorStyle, flip } = computeAnchorLayout({ x: 640, y }, VIEWPORT, CHROME);
      const maxHeight = VIEWPORT.height * CARD_MAX_HEIGHT_FRACTION;
      // Whichever edge it is anchored by, work out where its top lands.
      const top = flip ? anchorStyle.top : VIEWPORT.height - anchorStyle.bottom - maxHeight;
      assert.ok(
        top >= CHROME.top,
        `anchored at y=${y}: card top ${Math.round(top)} is above the map's ${CHROME.top}`,
      );
    }
  });

  await t.test("the case that shipped: a mid-screen click on a short window", () => {
    // 900px tall, 44vh card = 396px, anchor at y=300. Growing upward from the
    // anchor put the top at -114.
    const short = { width: 1280, height: 900 };
    const { anchorStyle, flip } = computeAnchorLayout({ x: 640, y: 300 }, short, CHROME);
    const top = flip ? anchorStyle.top : short.height - anchorStyle.bottom - short.height * CARD_MAX_HEIGHT_FRACTION;
    assert.ok(top >= CHROME.top, `card top ${Math.round(top)} is behind the bars`);
  });
});

test("with no chrome it behaves exactly as it did before the insets existed", () => {
  // The default has to be a no-op, so a caller that does not pass insets is not
  // silently given a different layout.
  const point = { x: 640, y: 400 };
  assert.deepEqual(
    computeAnchorLayout(point, VIEWPORT),
    computeAnchorLayout(point, VIEWPORT, { top: 0, bottom: 0 }),
  );
});

test("is a pure function of its two arguments", () => {
  const point = { x: 300, y: 150 };
  assert.deepEqual(computeAnchorLayout(point, VIEWPORT), computeAnchorLayout(point, VIEWPORT));
});
