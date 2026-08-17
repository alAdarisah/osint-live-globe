import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  chromeInsets,
  chromeInsetProperties,
  feedRailOpen,
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

test("the breakpoint matches the one the stylesheets and the hook use", () => {
  // A layout the JS thinks is mobile and the CSS thinks is not is a layout nobody
  // can reason about, so the number has exactly one home -- and this is what makes
  // that true rather than merely stated.
  //
  // useIsMobileViewport.js imports MOBILE_MAX_WIDTH now; it used to hard-code 700
  // and import nothing, so the "cannot drift" this constant claims to guarantee was
  // a comment. A media query cannot read a JS constant, so the stylesheets are held
  // here instead: every `max-width` phone query in src must be this number.
  assert.equal(MOBILE_MAX_WIDTH, 700);

  const root = fileURLToPath(new URL("../src", import.meta.url));
  const queries = [];
  for (const entry of readdirSync(root, { recursive: true })) {
    const rel = entry.toString().replace(/\\/g, "/");
    if (!rel.endsWith(".css")) continue;
    const css = readFileSync(path.join(root, rel), "utf8");
    for (const m of css.matchAll(/@media[^{]*\(\s*max-width\s*:\s*(\d+)px\s*\)/g)) {
      queries.push({ file: rel, width: Number(m[1]) });
    }
  }
  assert.ok(queries.length, "no max-width media queries found; the scan is broken");

  // Every other tier is declared, so adding one is a decision rather than a
  // coincidence. The design thins the chrome in stages before it becomes a phone
  // layout (pill badges at 1330, two stats at 1150, pill labels at 1080, the board
  // stack at 900), and the two full-screen modal tiers are about how much room a
  // dialog needs rather than about what a phone is -- so they are their own number
  // and say so.
  const DECLARED_TIERS = new Set([MOBILE_MAX_WIDTH, 720, 900, 1080, 1150, 1330]);
  const undeclared = queries.filter((q) => !DECLARED_TIERS.has(q.width));
  assert.deepEqual(
    undeclared,
    [],
    "these media queries use a breakpoint nothing declares. If it is the phone tier "
    + `it must be MOBILE_MAX_WIDTH (${MOBILE_MAX_WIDTH}); if it is a new tier, add it `
    + "to DECLARED_TIERS here: "
    + undeclared.map((q) => `${q.file} @ ${q.width}px`).join(", "),
  );

  // And the phone tier itself really is in use, in both stylesheets that have a
  // phone layout -- otherwise this whole test could pass with the phone block
  // silently renamed to some other width.
  assert.ok(
    queries.some((q) => q.width === MOBILE_MAX_WIDTH),
    `no stylesheet has a ${MOBILE_MAX_WIDTH}px block; the phone layout has drifted`,
  );
});

test("a defaulted rail follows the viewport, and a chosen one does not", () => {
  // The bug this pins, found on the deployed build: the default was resolved
  // inside a useState initializer, so whichever viewport the *first* render saw
  // was frozen for the session. A window that started narrow and was then
  // widened kept a rail that could never reopen on its own, because the default
  // had already been spent -- and the symptom is a missing panel, which reads as
  // a layout that was never built rather than as a default gone stale.
  assert.equal(feedRailOpen(null, false, false), true, "desktop default is open");
  assert.equal(feedRailOpen(null, true, false), false, "phone default is closed");

  // Still a default, so widening re-derives rather than staying shut.
  assert.equal(feedRailOpen(null, false, false), true);

  // A stored choice outranks the viewport in both directions. `??` and not `||`:
  // a stored `false` is a decision, and `||` would throw it away every render.
  assert.equal(feedRailOpen(false, false, false), false, "closed on a desktop by choice");
  assert.equal(feedRailOpen(true, true, false), true, "opened on a phone by choice");
});

test("the drawer takes the rail from the feed without erasing the choice", () => {
  // Both want the left edge and only one can have it. The feed yields while the
  // drawer is up and must come back when it closes -- so the drawer is applied
  // on top of the preference rather than written into it.
  assert.equal(feedRailOpen(true, false, true), false, "drawer wins while open");
  assert.equal(feedRailOpen(true, false, false), true, "and the feed returns after");
  assert.equal(feedRailOpen(null, false, true), false);
  assert.equal(feedRailOpen(null, false, false), true);
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
