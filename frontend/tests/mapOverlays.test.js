// The third erosion test, after motionTokens.test.js (durations) and
// zIndexBands.test.js (stacking): what happens to a click.
//
// Both of the faults this file pins shipped, passed 1633 tests, and presented as
// the same symptom -- "I click and nothing happens" -- which nobody attributes to
// a stylesheet:
//
//   * #legend and #boardStack were added as fixed columns standing on the map
//     with no `pointer-events: none`, while every overlay that predated them had
//     it. A 250px strip down the right-hand side of the map silently ate every
//     country click inside it.
//   * #topBar .cat-strip declared overflow-x and left overflow-y alone. Per CSS
//     Overflow 3, `visible` beside a non-visible value computes to `auto`, so the
//     strip became a scroll container in both axes and clipped the category menu
//     -- which opens 34px below a scrollport one pill tall -- out of existence.
//
// Neither is catchable by a component test: the markup and the handlers were
// right in both cases.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const resolvePath = (rel) => fileURLToPath(new URL(rel, import.meta.url));

// Same treatment the sibling tests give comments, and for the same reason: the
// prose here discusses `pointer-events: none` by name constantly, and a comment
// that mentions a declaration is not a declaration.
function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** Every .css file under src/, as [relative name, text]. */
function stylesheets() {
  const root = resolvePath("../src");
  const out = [];
  for (const entry of readdirSync(root, { recursive: true })) {
    const rel = entry.toString().replace(/\\/g, "/");
    if (!rel.endsWith(".css")) continue;
    out.push([rel, readFileSync(path.join(root, rel), "utf8")]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

/** Every rule, as {file, line, selector, body}. Flat rules only -- nothing here
 *  nests, and a media query's contents read as ordinary rules to this. */
function rules(files) {
  const out = [];
  for (const [name, raw] of files) {
    const css = blankComments(raw);
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim().replace(/\s+/g, " ");
      if (!selector || selector.startsWith("@")) continue;
      out.push({
        file: name,
        line: css.slice(0, m.index).split("\n").length,
        selector,
        body: m[2],
      });
    }
  }
  return out;
}

/** The element a selector is about: its leading id or class, before any state,
 *  descendant or pseudo. `#intelPanel.feed-rail .intel-list` -> `#intelPanel`. */
function elementOf(selector) {
  const first = selector.split(",")[0].trim();
  const m = first.match(/^[#.][\w-]+/);
  return m ? m[0] : first;
}

// Every surface positioned against the chrome insets -- which is to say, every
// surface that stands inside the map's own box -- has to make one of two choices,
// and this is where the choice is recorded.
//
// CLICK_THROUGH: the container passes clicks to the map and opts its own controls
// back in. Correct for anything large, mostly-empty, or standing over ground a
// reader is trying to click. The map is the primary interface; a panel that
// merely *occupies* space must not also *consume* it.
//
// OPAQUE: the surface legitimately takes every click in its own rectangle.
// Correct for something compact, solid, and summoned -- a card the reader just
// asked for, a drawer, a modal. Small enough that "the panel is in the way" is
// obviously true rather than mysterious.
const CLICK_THROUGH = new Set([
  "#regionBar",         // full map width, and mostly transparent gradient
  "#squawkAlertStrip",  // full map width, a row of chips
  "#alertToastStack",   // a column of toasts with gaps between them
  "#intelPanel",        // the feed rail, and the four instrument boards below
  "#airfieldPanel",
  "#chokepointPanel",
  "#infraRiskPanel",
  "#cableOutagePanel",
  "#sanctionsBoard",
  "#boardStack",        // the column the boards sit in, plus its 8px gaps
  "#legend",            // 250px down the map's right edge when expanded
]);

const OPAQUE = new Set([
  "#map",               // the thing the rest of this list is about
  "#controlPanel",      // Admin Mode's drawer
  "#panelToggle",       // its handle
  "#adminPanel",        // Admin Mode's settings surface
  "#borderEditBar",     // a modal-ish editing mode
  "#timelineBar",       // Admin Mode's replay control
  ".timeline-kinds-row",
  "#urlStateNotice",    // a dismissable notice, reader-summoned by a bad link
  "#conflictBriefing",  // a card
  "#eventDetailCard",   // a card
  "#countrySelection",  // a compact bar carrying the only way to clear a selection
]);

test("every surface standing in the map's box has decided what a click does", () => {
  // Detected by construction rather than by name: a rule that positions itself
  // against --chrome-top/--chrome-left/--chrome-bottom is, by definition, a rule
  // placing itself inside the map's own rectangle. That is exactly the population
  // that has to answer this question, and it grows on its own as chrome is added.
  const all = rules(stylesheets());
  const anchored = all.filter(
    (rule) =>
      /position\s*:\s*(fixed|absolute)/.test(rule.body) &&
      /(?:top|bottom|left|right|height|max-height)\s*:[^;]*--chrome-/.test(rule.body),
  );
  assert.ok(anchored.length >= 20, `only ${anchored.length} chrome-anchored surfaces found; the scan is broken`);

  // A click-through container may declare the rule on any of its own selectors --
  // #intelPanel carries it on the base rule and chrome.css restyles the same
  // element as #intelPanel.feed-rail -- so the question is asked per element, not
  // per rule.
  const declaredNone = new Set();
  for (const rule of all) {
    if (/pointer-events\s*:\s*none/.test(rule.body)) declaredNone.add(elementOf(rule.selector));
  }

  const undecided = [];
  const wrong = [];
  for (const rule of anchored) {
    const element = elementOf(rule.selector);
    if (CLICK_THROUGH.has(element)) {
      if (!declaredNone.has(element)) {
        wrong.push(`${rule.file}:${rule.line}: ${element} is listed click-through but never declares pointer-events: none`);
      }
      continue;
    }
    if (OPAQUE.has(element)) continue;
    undecided.push(`${rule.file}:${rule.line}: ${element} (${rule.selector})`);
  }

  assert.deepEqual(
    wrong,
    [],
    "a click-through surface lost its pointer-events rule and is now eating map clicks:\n" + wrong.join("\n"),
  );
  assert.deepEqual(
    undecided,
    [],
    "a new surface was positioned inside the map's box without deciding what a click on it does. " +
    "Add it to CLICK_THROUGH (and give the container pointer-events: none, opting its controls " +
    `back in) or to OPAQUE, in tests/mapOverlays.test.js:\n${undecided.join("\n")}`,
  );
});

test("a bar's dropdown escapes the bar instead of trusting it", () => {
  // Two independent reasons a menu nested in one of these bars cannot work, and
  // neither is fixable in the bar:
  //
  //   Clipping. The category strip scrolls horizontally, because the pills cannot
  //   wrap -- the bar's height is what --chrome-top promises the map. Per CSS
  //   Overflow 3 §3 a `visible` axis beside a non-visible/clip one computes to
  //   `auto`, so the strip is a scroll container in *both* axes and clips
  //   vertically. Declaring `overflow-y: visible` does not help: that is exactly
  //   the value being promoted. Scroll-one-axis-and-overflow-the-other is not a
  //   thing CSS offers. Its scrollport is one pill tall, so a menu opening 34px
  //   below it was cut off whole -- and `scrollbar-width: none` removed the only
  //   affordance that would have shown anything was there.
  //
  //   Stacking. Both bars carry backdrop-filter, which makes each a stacking
  //   context, so a nested menu's z-index resolves *inside* its bar and the band
  //   is a number with no effect. zindex.css says so, and names --z-menu as the
  //   band a portalled menu lands in.
  //
  // `position: fixed` is the observable half of being portalled -- an absolutely
  // positioned menu is one still trusting an ancestor for its origin.
  const all = rules(stylesheets());
  for (const menu of [".cat-menu", ".boards-menu"]) {
    const rule = all.find((r) => r.selector === menu);
    assert.ok(rule, `${menu} has no rule of its own`);
    assert.match(
      rule.body,
      /position\s*:\s*fixed/,
      `${menu} is positioned against an ancestor again; it must be portalled to the body`,
    );
    assert.match(
      rule.body,
      /z-index\s*:\s*var\(--z-menu\)/,
      `${menu} must sit in the --z-menu band`,
    );
    assert.doesNotMatch(
      rule.body,
      /(?:^|[\s;])(?:top|left|right|bottom)\s*:/,
      `${menu} must take its position from menuPosition.js, not from a static offset`,
    );
  }
});
