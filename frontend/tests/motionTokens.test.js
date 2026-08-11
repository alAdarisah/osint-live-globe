// The vocabulary erodes silently. A twelfth arbitrary duration does not break
// anything, it just makes the screen feel slightly more arbitrary than it did
// yesterday, and nobody notices until the whole thing feels wrong. This test is
// the thing that notices.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { COUNT_DURATION_MS } from "../src/hooks/useCountUp.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const resolvePath = (rel) => fileURLToPath(new URL(rel, import.meta.url));

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

// Blanks out comment bodies (keeping newlines, so every later index still
// lands on the right line) rather than deleting them outright. Both scans
// below key off brace/colon/semicolon punctuation, and this codebase's
// comments are prose, not code -- but prose is free to mention a brace in
// passing, and a comment that happens to do so would otherwise be misread as
// a declaration.
function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

// A declaration can wrap its value onto the next line ("transition:\n    opacity
// 3.7s ease;"), and a per-line scan never catches it: the colon is on one line,
// the duration on the next, and neither line alone matches both TIMING_PROPERTY
// and DURATION. This scans the whole file for "property : ... ;" spans instead
// of individual lines, so a wrapped value is caught the same as an unwrapped
// one. `s` (dotAll) lets `.` cross the newline inside the span; the span still
// stops at the first `;`, which is what a CSS value wrapping onto extra lines
// never itself contains.
function timingDeclarations(rawCss) {
  const css = blankComments(rawCss);
  const re = /\b(?:animation|transition)(?:-duration|-delay)?\s*:[^;]*;/gs;
  const out = [];
  let m;
  while ((m = re.exec(css))) {
    // The declaration alone doesn't carry its selector -- ":nth-child(1)" is
    // in the text *before* the property colon -- so the accepted zero-delay
    // exception below needs the whole rule (selector back to the previous
    // `}`), not just the matched span.
    const ruleStart = css.lastIndexOf("}", m.index) + 1;
    const rule = css.slice(ruleStart, m.index + m[0].length);
    const line = css.slice(0, m.index).split("\n").length;
    out.push([line, m[0], rule]);
  }
  return out
    .filter(([, text]) => !EXEMPT.some((name) => text.includes(name)))
    // .stagger-children > :nth-child(1) (and its .news-list / .notable-list /
    // .loading-log twins) is the one accepted raw value: zero is not a magic
    // number, and inventing a --t-none token to spell "no delay" would be
    // sillier than the thing it replaces.
    .filter(([, text, rule]) => !(rule.includes(":nth-child(1)") && /animation-delay\s*:\s*0ms/.test(text)));
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

// Every leaf declaration block in the file: [selector, body]. A generic
// "no-brace-run, {, no-brace-run, }" scan finds every innermost block
// regardless of what encloses it (a bare rule, one inside @media, one inside
// @keyframes), because an outer block always has a brace somewhere inside it
// and so never itself matches "no braces inside".
function leafBlocks(rawCss) {
  const css = blankComments(rawCss);
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selector = m[1].trim();
    if (selector && !selector.startsWith("@")) blocks.push([selector, m[2]]);
  }
  return blocks;
}

// Selectors of every rule that loops forever, shorthand or longhand. The
// regex-on-shorthand-only version (`/animation:\s*([\w-]+)[^;]*infinite/`)
// missed a rule written as animation-name / animation-duration /
// animation-iteration-count on separate lines -- which is exactly the form a
// reader reaches for when one of the three needs its own comment.
function loopingSelectors(css) {
  return leafBlocks(css)
    .filter(([, body]) => !EXEMPT.some((name) => body.includes(name)))
    .filter(([, body]) => (
      /animation:\s*[\w-]+[^;]*infinite/.test(body) ||
      (/animation-name\s*:/.test(body) && /animation-iteration-count\s*:\s*infinite/.test(body))
    ))
    .map(([selector]) => selector);
}

test("motion.css defines every token the stylesheet is allowed to use", () => {
  const motion = read("../src/motion.css");

  // Duration tokens get the value checked, not just the name. A test that only
  // asserts `--tempo-urgent:` exists lets `--tempo-urgent: 0.09s` or
  // `--t-panel: 4000ms` pass green -- it guards the vocabulary's names while
  // saying nothing about what any word in it means.
  const DURATION_TOKENS = {
    "--t-tap": "90ms",
    "--t-ui": "160ms",
    "--t-panel": "240ms",
    "--t-settle": "420ms",
    "--t-boot": "700ms",
    "--tempo-urgent": "1.1s",
    "--tempo-live": "2.4s",
    "--tempo-ambient": "6s",
  };
  for (const [token, expected] of Object.entries(DURATION_TOKENS)) {
    const match = motion.match(new RegExp(`${token}\\s*:\\s*([^;]+);`));
    assert.ok(match, `motion.css is missing ${token}`);
    assert.equal(match[1].trim(), expected, `${token} should be ${expected}, found ${match[1].trim()}`);
  }

  // Easings and the stagger step stay existence-only: there's no single
  // "correct" cubic-bezier to pin without the test becoming a change-detector
  // for legitimate curve tuning, and the stagger step is a taste call rather
  // than a boundary condition the way the tempo scale is.
  for (const token of ["--e-out", "--e-inout", "--e-spring", "--stagger-step"]) {
    assert.ok(motion.includes(`${token}:`), `motion.css is missing ${token}`);
  }
});

test("style.css states no duration of its own", () => {
  const offenders = timingDeclarations(read("../src/style.css"))
    .filter(([, text]) => DURATION.test(stripTokenVars(text)))
    .map(([number, text]) => `style.css:${number}: ${text.trim()}`);
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

  const reduceMotionSelectors = normalizeSelectorList(selectors);

  // Every rule that loops. A looping animation nobody can switch off is the one
  // accessibility failure this feature can actually cause, and it is invisible
  // to whoever adds the loop. EXEMPT is excluded here too -- loading-radar-spin
  // and loading-ellipsis-pulse are mechanism, not status, and the earlier test
  // already guards that their exemption stays documented; this test is only
  // about loops that are supposed to be reachable through reduce-motion.
  //
  // Compared as whole normalised selectors, not leaf class names: a raw
  // substring/leaf check passes ".threat-halo .entity-icon-wrap" as covered
  // because ".infra-hot .entity-icon-wrap" is already on the list and both
  // reduce to the same leaf, ".entity-icon-wrap" -- the same collision ".dot"
  // and ".dot.breathing" have. Two different rules are not the same rule just
  // because they share their rightmost compound.
  const uncovered = loopingSelectors(css).filter(
    (selector) => !reduceMotionSelectors.includes(selector),
  );
  assert.deepEqual(uncovered, [], `looping rules missing from :root.reduce-motion:\n${uncovered.join("\n")}`);
});

// This feature's one ethical constraint: casualty, fatality and injury figures
// must never tween. A death toll climbing like an odometer is the one thing on
// this map that must not be performed (see CountUp.jsx's own warning comment).
// Until now that rule was enforced by the comment plus a manual grep run once
// during review -- nothing stopped the next PR from wrapping
// `event.fatalities` in `<CountUp>` and shipping it green.
test("casualty figures never go through CountUp", () => {
  const CASUALTY_KEYWORD = /fatalit|casualt|killed|injur/i;
  const dirs = ["../src/components", "../src/map"];
  const offenders = [];

  for (const dir of dirs) {
    const root = resolvePath(dir);
    for (const entry of readdirSync(root, { recursive: true })) {
      const rel = entry.toString();
      if (!/\.(jsx?|tsx?)$/.test(rel)) continue;
      const abs = path.join(root, rel);
      // CountUp.jsx's own path and its required warning comment both contain
      // a casualty keyword ("Never put this around a casualty figure...") --
      // the trap that bit an earlier pass at this test. Excluded by path, not
      // by content, so the component can go on documenting its own rule.
      if (path.basename(abs) === "CountUp.jsx") continue;
      const text = readFileSync(abs, "utf8");
      text.split("\n").forEach((line, i) => {
        if (CASUALTY_KEYWORD.test(line) && line.includes("CountUp")) {
          offenders.push(`${path.relative(root, abs).replace(/\\/g, "/")}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "a casualty/fatality/injury figure appears on the same line as CountUp -- " +
    "this map renders death tolls directly and lets them snap on purpose; a " +
    "counter that rolls up to a number of dead people is not a rendering choice, " +
    `it is the thing this feature is not allowed to do:\n${offenders.join("\n")}`,
  );
});
