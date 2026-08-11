// The arithmetic behind the counting numbers, kept pure so it can be tested
// without a DOM or a clock. The hook around it is four lines of
// requestAnimationFrame and is not what breaks.

import test from "node:test";
import assert from "node:assert/strict";

import { tweenValue } from "../src/hooks/useCountUp.js";

test("starts at the old value and ends at the new one", () => {
  assert.equal(tweenValue(10, 90, 0, 420), 10);
  assert.equal(tweenValue(10, 90, 420, 420), 90);
  // Past the end, not stuck near it: a dropped frame must not leave a counter
  // reading 89 forever.
  assert.equal(tweenValue(10, 90, 10000, 420), 90);
});

test("moves monotonically and stays an integer", () => {
  let previous = tweenValue(0, 500, 0, 420);
  for (let elapsed = 0; elapsed <= 420; elapsed += 7) {
    const value = tweenValue(0, 500, elapsed, 420);
    assert.ok(Number.isInteger(value), `${value} is not an integer`);
    assert.ok(value >= previous, `${value} went backwards from ${previous}`);
    previous = value;
  }
});

test("counts down as readily as up", () => {
  assert.equal(tweenValue(90, 10, 0, 420), 90);
  assert.equal(tweenValue(90, 10, 420, 420), 10);
  assert.ok(tweenValue(90, 10, 210, 420) < 90);
});

test("refuses to tween toward nonsense", () => {
  // A source that returns null for its count must not leave a ticker counting
  // toward NaN, which renders as the string "NaN" and looks like a crash.
  assert.equal(tweenValue(10, NaN, 210, 420), 10);
  assert.equal(tweenValue(10, Infinity, 210, 420), 10);
  assert.equal(tweenValue(NaN, 90, 210, 420), 90);
});

test("a zero duration lands immediately", () => {
  // Reduced motion sets the duration to zero rather than taking a second code
  // path, so this case has to be division-by-zero-safe.
  assert.equal(tweenValue(10, 90, 0, 0), 90);
});
