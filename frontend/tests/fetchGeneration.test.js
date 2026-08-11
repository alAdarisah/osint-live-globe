// createGenerationGuard (frontend/src/utils/fetchGeneration.js), extracted
// from map/createMapController.js's loadVesselDetail/loadPortTraffic (Task
// 17) to close a review finding: both fetch functions live inside
// createMapController's closures, which need a full Leaflet/webgl
// environment to construct, so the out-of-order race itself is not
// reachable from a headless test -- this is the pure boundary the guard's
// logic can be asserted at instead. What matters is exactly the scenario
// the review described: open port popup (fetch A), close it, reopen before
// A resolves (fetch B), and A's response lands *after* B's -- ordinary on a
// flaky connection, since responses are not guaranteed to arrive in
// request order.

import test from "node:test";
import assert from "node:assert/strict";

import { createGenerationGuard } from "../src/utils/fetchGeneration.js";

test("the second start() for a key outranks the first, however they finish", () => {
  const guard = createGenerationGuard();
  const tokenA = guard.start("244660724");
  const tokenB = guard.start("244660724");
  assert.notEqual(tokenA, tokenB);
  // B is the current one regardless of what order the two callers actually
  // check in -- this is the property loadVesselDetail/loadPortTraffic lean
  // on when B's fetch resolves before A's.
  assert.equal(guard.isCurrent("244660724", tokenB), true);
  assert.equal(guard.isCurrent("244660724", tokenA), false);
});

test("an older fetch landing after a newer one is recognised as stale", () => {
  // The exact race from the review: fetch A starts, fetch B starts before A
  // resolves, and A's completion callback runs *after* B's (out-of-order
  // network delivery). A must not be allowed to act as though it were current.
  const guard = createGenerationGuard();
  const tokenA = guard.start("test-port");
  const tokenB = guard.start("test-port");

  // B "resolves" first.
  assert.equal(guard.isCurrent("test-port", tokenB), true);
  // A resolves second (late) -- must be rejected even though it is the one
  // finishing "now".
  assert.equal(guard.isCurrent("test-port", tokenA), false);
});

test("a single start() is always current until something newer begins", () => {
  const guard = createGenerationGuard();
  const token = guard.start("only-one");
  assert.equal(guard.isCurrent("only-one", token), true);
});

test("different keys never interfere with each other", () => {
  // The port card's guard is keyed per port_id specifically so a fetch for
  // one port landing late can never be mistaken for a stale fetch of a
  // *different* port -- this is what a single shared counter could not do.
  const guard = createGenerationGuard();
  const tokenPortA = guard.start("port-a");
  const tokenPortB = guard.start("port-b");
  assert.equal(guard.isCurrent("port-a", tokenPortA), true);
  assert.equal(guard.isCurrent("port-b", tokenPortB), true);
  // Starting a second fetch for port-a must not affect port-b's guard.
  guard.start("port-a");
  assert.equal(guard.isCurrent("port-b", tokenPortB), true);
});

test("a key nothing has started for is never current", () => {
  const guard = createGenerationGuard();
  assert.equal(guard.isCurrent("never-started", 1), false);
});
