// Task 35 review, Critical 2: frontend/src/hooks/useReplay.js's
// shouldExitReplayOnAdminModeChange.
//
// The bug: a restored deep link seeds useReplay's initial replayAt, making
// isReplaying true on the very first render, while adminMode defaults to
// false for the large majority of visitors this share button exists for.
// App.jsx's own "leaving Admin Mode mid-replay goes live" effect could not
// tell that apart from an admin who had genuinely just switched Admin Mode
// off mid-replay, and fired goLive() on mount either way -- silently
// discarding a freshly-restored replay link before the reader ever saw it.
//
// The fix lives in App.jsx (a ref tracking the previous render's adminMode,
// which cannot be exercised under this project's plain node --test harness
// -- no React renderer here), but the actual decision is this one pure
// predicate, pulled out specifically so it has headless coverage. useReplay.js
// itself imports "react" (a real resolvable package, fine) and "../api"
// through a Vite-style extensionless specifier (not fine under Node's own
// loader) -- same resolve hook urlState.test.js/intelPanel.test.js already
// use for the same reason.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
});

const { shouldExitReplayOnAdminModeChange } = await import("../src/hooks/useReplay.js");

test("no transition (admin mode unchanged) never exits replay, whichever way it reads", () => {
  // The mount-time case this bug actually was: adminMode is false on the
  // very first render, prevAdminMode (seeded from that same first render) is
  // also false -- not a transition, so a restored replay link must survive.
  assert.equal(shouldExitReplayOnAdminModeChange(false, false, true), false);
  // And the admin-mode-already-on case behaves the same way: still no
  // transition, so an admin who opened a replay link while already in Admin
  // Mode is not immediately kicked back to live either.
  assert.equal(shouldExitReplayOnAdminModeChange(true, true, true), false);
});

test("a genuine true-to-false transition exits replay, only while actually replaying", () => {
  assert.equal(shouldExitReplayOnAdminModeChange(true, false, true), true);
  assert.equal(shouldExitReplayOnAdminModeChange(true, false, false), false);
});

test("a false-to-true transition (entering Admin Mode) never exits replay", () => {
  assert.equal(shouldExitReplayOnAdminModeChange(false, true, true), false);
});
