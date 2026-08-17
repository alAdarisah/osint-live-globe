// The arithmetic that replaced `top: calc(100% + 8px)` when the bars' menus were
// portalled out of the bars. See menuPosition.js for why they had to be.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  anchorMenuStyle,
  MENU_GAP,
  MENU_MARGIN,
  MENU_MIN_HEIGHT,
  CAT_MENU_MIN_WIDTH,
  BOARDS_MENU_MIN_WIDTH,
} from "../src/components/chrome/menuPosition.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** A pill somewhere in the top bar. Bars are 44 + 34 tall, so a pill's bottom
 *  edge sits around y=36 and a sub-bar button's around y=72. */
const pill = (left, width = 64) => ({ left, right: left + width, top: 9, bottom: 36 });
const desktop = { width: 1280, height: 800 };

test("the menu opens just under its trigger", () => {
  const { top } = anchorMenuStyle(pill(120), desktop);
  assert.equal(top, 36 + MENU_GAP);
});

test("a left-aligned menu lines up with the trigger's left edge", () => {
  const { left } = anchorMenuStyle(pill(120), desktop, { minWidth: CAT_MENU_MIN_WIDTH });
  assert.equal(left, 120);
});

test("a menu near the right edge is pulled back until its whole width fits", () => {
  // The rightmost pill is the one this is for: left-aligning a 300px menu to a
  // pill at x=1150 puts 170px of it off screen, and there is no horizontal scroll
  // on the body to recover it.
  const { left } = anchorMenuStyle(pill(1150), desktop, { minWidth: CAT_MENU_MIN_WIDTH });
  assert.equal(left, desktop.width - CAT_MENU_MIN_WIDTH - MENU_MARGIN);
  assert.ok(left + CAT_MENU_MIN_WIDTH <= desktop.width - MENU_MARGIN);
});

test("a right-aligned menu opens inward from its trigger", () => {
  // The Boards button sits at the right end of the sub bar, so its menu hangs
  // leftward -- which is what `right: 0` used to express.
  const trigger = { left: 1100, right: 1160, top: 45, bottom: 72 };
  const { left } = anchorMenuStyle(trigger, desktop, {
    minWidth: BOARDS_MENU_MIN_WIDTH,
    align: "right",
  });
  assert.equal(left, 1160 - BOARDS_MENU_MIN_WIDTH);
});

test("a phone still fits the whole menu on screen", () => {
  // 375px wide, 300px menu: there is room, so the clamp slides it left rather
  // than letting the right-hand side hang off.
  const phone = { width: 375, height: 700 };
  const { left } = anchorMenuStyle(pill(300), phone, { minWidth: CAT_MENU_MIN_WIDTH });
  assert.equal(left, 375 - CAT_MENU_MIN_WIDTH - MENU_MARGIN);
  assert.ok(left >= MENU_MARGIN);
});

test("the left edge wins when the menu is wider than the screen allows", () => {
  // Narrower than min-width plus both margins, so the two clamps disagree. The
  // low-side one is applied last on purpose: overflowing to the right leaves the
  // menu's start visible and its own max-width (92vw in chrome.css) bounds it,
  // where a negative left would push the first column off the left edge, which
  // nothing can scroll back.
  const narrow = { width: 300, height: 700 };
  const { left } = anchorMenuStyle(pill(120), narrow, { minWidth: CAT_MENU_MIN_WIDTH });
  assert.equal(left, MENU_MARGIN);
});

test("the menu is bounded by the room under it, and clears the bottom chrome", () => {
  const plain = anchorMenuStyle(pill(120), desktop);
  assert.equal(plain.maxHeight, desktop.height - (36 + MENU_GAP) - MENU_MARGIN);

  // The HUD, plus the scrub strip while replaying. A menu that ran under the HUD
  // would put its last rows behind an opaque bar -- and the rows at the bottom of
  // a layer menu are layers like any other.
  const withChrome = anchorMenuStyle(pill(120), desktop, { bottomInset: 68 });
  assert.equal(withChrome.maxHeight, plain.maxHeight - 68);
});

test("a menu is never given a height it cannot show anything in", () => {
  // A short window, or a lot of bottom chrome, would otherwise compute a negative
  // max-height -- which collapses the menu to nothing and reads exactly like the
  // bug this module was written to fix: the button lights up and no menu appears.
  const squashed = anchorMenuStyle(pill(120), { width: 1280, height: 200 }, { bottomInset: 120 });
  assert.equal(squashed.maxHeight, MENU_MIN_HEIGHT);
  assert.ok(squashed.maxHeight > 0);
});

test("the min-widths match the stylesheet they are clamping against", () => {
  // The clamp needs each menu's real width to keep its right edge on screen. That
  // number lives in chrome.css and in menuPosition.js, and nothing but this test
  // stops the two drifting -- widen the CSS alone and the rightmost pill's menu
  // starts hanging off the edge again, silently, only on narrow screens.
  const css = read("../src/chrome.css");
  const minWidthOf = (selector) => {
    const block = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
    assert.ok(block, `${selector} has no rule in chrome.css`);
    const found = block[1].match(/min-width\s*:\s*(\d+)px/);
    assert.ok(found, `${selector} declares no min-width`);
    return Number(found[1]);
  };

  assert.equal(minWidthOf(".cat-menu"), CAT_MENU_MIN_WIDTH);
  assert.equal(minWidthOf(".boards-menu"), BOARDS_MENU_MIN_WIDTH);
});
