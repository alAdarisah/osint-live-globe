// The vocabulary erodes silently. A twelfth arbitrary duration does not break
// anything, it just makes the screen feel slightly more arbitrary than it did
// yesterday, and nobody notices until the whole thing feels wrong. This test is
// the thing that notices.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// A duration literal: 0.15s, .2s, 90ms, 1.1s. Not a percentage, not a colour.
// Deliberately not /g: a global regex carries lastIndex between .test() calls
// and would report every other line as clean.
const DURATION = /(?<![\w-])\d*\.?\d+m?s(?![\w-])/;

// Mechanism, not status -- a spinner reporting that work is in progress cannot
// be asked "how urgent is this condition", which is the only question the tempo
// scale answers. Both carry the same explanation in the stylesheet.
const EXEMPT = ["loading-radar-spin", "loading-ellipsis-pulse"];

function timingLines(css) {
  return css
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\b(animation|transition)\b\s*:/.test(line))
    .filter(([, line]) => !EXEMPT.some((name) => line.includes(name)));
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
    .filter(([, line]) => DURATION.test(line.replace(/var\([^)]*\)/g, "")))
    .map(([number, line]) => `style.css:${number}: ${line.trim()}`);
  assert.deepEqual(offenders, [], `raw durations outside motion.css:\n${offenders.join("\n")}`);
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
