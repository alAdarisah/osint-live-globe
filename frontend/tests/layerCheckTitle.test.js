// The same checkbox now appears on two surfaces whose ticks go to different
// places. These tests are about the sentence that tells them apart.

import test from "node:test";
import assert from "node:assert/strict";

import {
  layerCheckTitle,
  SCOPE_SESSION,
  SCOPE_DEPLOYMENT,
} from "../src/components/controlPanel/layerCheckTitle.js";

const DEPLOYMENT_PROMISE = /every reader of this deployment/;

test("the deployment promise is made only where it can be kept", () => {
  // The whole reason this module exists. The drawer's ticks are written to the
  // shared admin_config.json and do reach every reader; the top bar's pills
  // never leave the tab. Telling a reader they have just changed what everyone
  // else sees, when they have not, is worse than saying nothing.
  for (const wish of [true, false]) {
    assert.match(layerCheckTitle({ pinned: true, wish, scope: SCOPE_DEPLOYMENT }), DEPLOYMENT_PROMISE);
    assert.doesNotMatch(layerCheckTitle({ pinned: true, wish, scope: SCOPE_SESSION }), DEPLOYMENT_PROMISE);
  }
});

test("an undeclared scope understates its reach rather than overstating it", () => {
  // A surface that forgets to declare itself must fail safe. Promising a
  // deployment-wide edit by default would be the one direction that misleads.
  assert.doesNotMatch(layerCheckTitle({ pinned: true, wish: true }), DEPLOYMENT_PROMISE);
  assert.equal(
    layerCheckTitle({ pinned: true, wish: true }),
    layerCheckTitle({ pinned: true, wish: true, scope: SCOPE_SESSION }),
  );
});

test("a session tick says it is not saved, and how to undo it", () => {
  // A reader who has seen the drawer's version will assume this one persists
  // too, so the difference has to be stated rather than merely not-claimed.
  const title = layerCheckTitle({ pinned: true, wish: true, scope: SCOPE_SESSION });
  assert.match(title, /not saved/);
  assert.match(title, /↺/);
});

test("all four states are distinct, on both scopes", () => {
  // Eight strings, no two alike: a state that shares its wording with another
  // is a state a reader cannot tell they are in.
  const states = [
    { pinned: false },
    { pinned: true, withheld: true, wish: true },
    { pinned: true, wish: true },
    { pinned: true, wish: false },
  ];
  const titles = [SCOPE_SESSION, SCOPE_DEPLOYMENT].flatMap((scope) =>
    states.map((state) => layerCheckTitle({ ...state, scope })),
  );
  // The unpinned and withheld states are scope-independent -- neither has been
  // saved anywhere yet -- so six distinct strings across the eight slots.
  assert.equal(new Set(titles).size, 6);
});

test("the resolver state invites the override rather than describing a value", () => {
  const title = layerCheckTitle({ pinned: false, scope: SCOPE_DEPLOYMENT });
  assert.match(title, /Chosen by the scene/);
  assert.match(title, /Tick to override/);
  // Not "off" or "on": the point of the indeterminate state is that neither is
  // the reader's call yet.
  assert.doesNotMatch(title, /^Pinned/);
});

test("withheld explains the disagreement instead of denying it", () => {
  // Pinned on and drawing nothing is a real arrangement, not a broken tick --
  // and it is the one case where intent and reality legitimately differ.
  const title = layerCheckTitle({ pinned: true, withheld: true, wish: true, scope: SCOPE_SESSION });
  assert.match(title, /zoom gate/);
  assert.match(title, /zoom in/i);
  // Scope is irrelevant here: nothing has taken effect to have a reach.
  assert.equal(title, layerCheckTitle({ pinned: true, withheld: true, wish: true, scope: SCOPE_DEPLOYMENT }));
});
