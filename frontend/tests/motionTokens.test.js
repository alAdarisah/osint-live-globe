// The vocabulary erodes silently. A twelfth arbitrary duration does not break
// anything, it just makes the screen feel slightly more arbitrary than it did
// yesterday, and nobody notices until the whole thing feels wrong. This test is
// the thing that notices.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { COUNT_DURATION_MS } from "../src/hooks/useCountUp.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// A duration literal: 0.15s, .2s, 90ms, 1.1s. Not a percentage, not a colour.
// Deliberately not /g: a global regex carries lastIndex between .test() calls
// and would report every other line as clean.
const DURATION = /(?<![\w-])\d*\.?\d+m?s(?![\w-])/;

// Mechanism, not status -- a spinner reporting that work is in progress cannot
// be asked "how urgent is this condition", which is the only question the tempo
// scale answers. Both carry the same explanation in the stylesheet.
const EXEMPT = ["loading-radar-spin", "loading-ellipsis-pulse"];

// Matches the shorthand (animation:, transition:) and the four longhands
// (animation-duration:, animation-delay:, transition-duration:,
// transition-delay:) -- \b after "animation"/"transition" does not clear the
// hyphen in "animation-delay", so the shorthand-only pattern let every
// longhand property smuggle a raw duration past this file.
const TIMING_PROPERTY = /\b(?:animation|transition)(?:-duration|-delay)?\s*:/;

function timingLines(css) {
  return css
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => TIMING_PROPERTY.test(line))
    .filter(([, line]) => !EXEMPT.some((name) => line.includes(name)))
    // .stagger-children > :nth-child(1) (and its .news-list / .notable-list /
    // .loading-log twins, all one rule) is the one accepted raw value: zero is
    // not a magic number, and inventing a --t-none token to spell "no delay"
    // would be sillier than the thing it replaces.
    .filter(([, line]) => !(line.includes(":nth-child(1)") && /animation-delay\s*:\s*0ms/.test(line)));
}

// A duration hiding inside a var() fallback is still a duration. This
// collapses var(...) calls from the inside out: a pure token reference
// (var(--e-out), or var(--tempo-live) once it is the innermost survivor of
// var(--period, var(--tempo-live))) contributes nothing and disappears,
// while a literal fallback (var(--not-a-token, 0.33s)) is left behind as
// plain text so the duration check downstream still sees it. Nesting depth
// is arbitrary because this runs to a fixed point, not a single pass.
function stripTokenVars(line) {
  let prev;
  do {
    prev = line;
    line = line.replace(/var\(([^()]*)\)/g, (_, inner) => {
      const comma = inner.indexOf(",");
      return comma === -1 ? "" : inner.slice(comma + 1).trim();
    });
  } while (line !== prev);
  return line;
}

test("motion.css defines every token the stylesheet is allowed to use", () => {
  const motion = read("../src/motion.css");
  for (const token of [
    "--t-tap", "--t-ui", "--t-panel", "--t-settle", "--t-boot",
    "--e-out", "--e-inout", "--e-spring",
    "--tempo-urgent", "--tempo-live", "--tempo-ambient",
    "--stagger-step",
  ]) {
    assert.ok(motion.includes(`${token}:`), `motion.css is missing ${token}`);
  }
});

test("style.css states no duration of its own", () => {
  const offenders = timingLines(read("../src/style.css"))
    .filter(([, line]) => DURATION.test(stripTokenVars(line)))
    .map(([number, line]) => `style.css:${number}: ${line.trim()}`);
  assert.deepEqual(offenders, [], `raw durations outside motion.css:\n${offenders.join("\n")}`);
});

test("the counting hook's duration matches --t-settle", () => {
  // useCountUp cannot read the token at runtime -- that would mean a
  // getComputedStyle call inside a requestAnimationFrame loop, which is the
  // layout read the whole feature is forbidden from doing. So the two are kept
  // in step here instead of by hope.
  const settle = read("../src/motion.css").match(/--t-settle:\s*(\d+)ms/);
  assert.ok(settle, "--t-settle is missing from motion.css");
  assert.equal(Number(settle[1]), COUNT_DURATION_MS);
});

test("the exempt animations say why they are exempt", () => {
  const css = read("../src/style.css");
  for (const name of EXEMPT) {
    const at = css.indexOf(`animation: ${name}`);
    assert.notEqual(at, -1, `${name} no longer exists; drop it from EXEMPT`);
    // The 400 characters before it must explain the exemption, so that deleting
    // the explanation fails the test rather than quietly orphaning the rule.
    assert.match(css.slice(Math.max(0, at - 400), at), /mechanism/i,
      `${name} is exempt from the tempo scale and must say why`);
  }
});

// Pulls the selector list out of a "selector, selector, ... { animation: none"
// block and returns it as a normalised, sorted array -- comma-split, the
// ":root.reduce-motion" ancestor stripped off, and the opening brace (and
// whatever follows it, since callers slice up to but not including
// "animation: none") trimmed away. Two lists that mean the same thing produce
// the same array regardless of which one carries the :root prefix or how the
// two are indented.
function normalizeSelectorList(text) {
  return text
    .replace(/:root\.reduce-motion\s*/g, "")
    .split(",")
    .map((selector) => selector.split("{")[0].trim())
    .filter(Boolean)
    .sort();
}

test("every looping animation can be switched off", () => {
  const css = read("../src/style.css");
  // Anchored on the block's comment, not on ":root.reduce-motion" -- that
  // selector also opens the unrelated map-reticle rule further up the file
  // (transition: none, no loop involved), and indexOf would land there first.
  const commentAt = css.indexOf('"Reduce motion":');
  assert.notEqual(commentAt, -1, "the reduce-motion block's comment has gone missing");
  // The selector list itself starts after the comment, not at the comment --
  // the comment's own prose is full of commas ("pulsing dots, jamming pings,
  // hot-zone flares") that would otherwise get parsed as selectors.
  const blockStart = css.indexOf(":root.reduce-motion", commentAt);
  assert.notEqual(blockStart, -1, "the reduce-motion selector list has gone missing");
  const reduceBlock = css.slice(blockStart);
  const stop = reduceBlock.indexOf("animation: none");
  assert.notEqual(stop, -1, "the reduce-motion block has gone missing");
  const selectors = reduceBlock.slice(0, stop);

  // The app's own setting and the operating system's are two independently
  // hand-maintained lists that are supposed to say the same thing (see the
  // media query's own comment in style.css). Nothing enforces that but this --
  // a selector added to one and forgotten in the other would leave a reader
  // who relies on the other signal moving when they asked not to be, and nothing
  // above would notice.
  const mediaMarker = "@media (prefers-reduced-motion: reduce) {";
  const mediaAt = css.indexOf(mediaMarker);
  assert.notEqual(mediaAt, -1, "the prefers-reduced-motion mirror has gone missing");
  const mediaBlock = css.slice(mediaAt + mediaMarker.length);
  const mediaStop = mediaBlock.indexOf("animation: none");
  assert.notEqual(mediaStop, -1, "the prefers-reduced-motion block has gone missing");
  const mediaSelectors = mediaBlock.slice(0, mediaStop);

  assert.deepEqual(
    normalizeSelectorList(mediaSelectors),
    normalizeSelectorList(selectors),
    "the :root.reduce-motion list and the prefers-reduced-motion media query have drifted apart",
  );

  // Every rule that loops. A looping animation nobody can switch off is the one
  // accessibility failure this feature can actually cause, and it is invisible
  // to whoever adds the loop. EXEMPT is excluded here too -- loading-radar-spin
  // and loading-ellipsis-pulse are mechanism, not status, and the earlier test
  // already guards that their exemption stays documented; this test is only
  // about loops that are supposed to be reachable through reduce-motion.
  const looping = [...css.matchAll(/animation:\s*([\w-]+)[^;]*infinite/g)]
    .filter((match) => !EXEMPT.includes(match[1]))
    .map((match) => {
      // Walk back to the selector that owns this declaration.
      const before = css.slice(0, match.index);
      const brace = before.lastIndexOf("{");
      return before.slice(before.lastIndexOf("}", brace) + 1, brace).trim();
    })
    .filter((selector) => selector && !selector.startsWith("@"));

  const uncovered = looping.filter((selector) => {
    const leaf = selector.split(/[\s>,]+/).filter(Boolean).pop();
    return !selectors.includes(leaf);
  });
  assert.deepEqual(uncovered, [], `looping rules missing from :root.reduce-motion:\n${uncovered.join("\n")}`);
});
