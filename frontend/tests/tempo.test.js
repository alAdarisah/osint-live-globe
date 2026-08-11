// Tempo derived from live data, which means tempo derived from data that can be
// wrong. A source reporting a negative age must not produce a 4ms strobe, so
// the clamp is the first property tested rather than an afterthought.

import test from "node:test";
import assert from "node:assert/strict";

import { dotPeriod, STALE_AFTER_SECONDS } from "../src/utils/tempo.js";
import { ratePeriod } from "../src/utils/tempo.js";

test("a fast source breathes fast and a slow one slow", () => {
  const fast = Number.parseFloat(dotPeriod(2));
  const slow = Number.parseFloat(dotPeriod(600));
  assert.ok(fast < slow, `expected ${fast}s to be quicker than ${slow}s`);
});

test("never faster than urgent, never slower than ambient", () => {
  for (const age of [0, 1, 5, 60, 600, 1799]) {
    const period = Number.parseFloat(dotPeriod(age));
    assert.ok(period >= 1.1, `${age}s gave ${period}s, faster than --tempo-urgent`);
    assert.ok(period <= 6, `${age}s gave ${period}s, slower than --tempo-ambient`);
  }
});

test("a stale source stops moving", () => {
  // The dot going still IS the status. This is the whole point of the feature,
  // so it is not allowed to degrade into "animates a bit slower".
  assert.equal(dotPeriod(STALE_AFTER_SECONDS), null);
  assert.equal(dotPeriod(STALE_AFTER_SECONDS + 1), null);
  assert.equal(dotPeriod(99999), null);
});

test("stale matches the threshold the panel already used", () => {
  // SourceStatusSection has drawn `ok` at under 1800s since long before this.
  // Two thresholds for one idea is how a dot ends up green and still.
  assert.equal(STALE_AFTER_SECONDS, 1800);
});

test("nonsense is treated as stale, not as urgent", () => {
  for (const bad of [null, undefined, -1, NaN, Infinity, "soon"]) {
    assert.equal(dotPeriod(bad), null, `${String(bad)} should read as stale`);
  }
});

test("a busy board beats faster than a quiet one", () => {
  const quiet = Number.parseFloat(ratePeriod(0));
  const busy = Number.parseFloat(ratePeriod(200));
  assert.ok(busy < quiet, `expected ${busy}s to be quicker than ${quiet}s`);
});

test("the header always breathes", () => {
  // Unlike a source dot, this one never goes still: a stopped header would read
  // as a broken panel rather than as a quiet world.
  for (const count of [0, 1, 50, 5000, -3, NaN, null]) {
    const period = ratePeriod(count);
    assert.match(period, /^\d+(\.\d+)?s$/, `${String(count)} gave ${period}`);
    const seconds = Number.parseFloat(period);
    assert.ok(seconds >= 1.1 && seconds <= 6, `${String(count)} gave ${period}`);
  }
});
