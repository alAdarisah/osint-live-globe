// Task 42: components/alertToastLogic.js -- which /api/health alerts belong
// to a reader-defined rule, and the "show once per firing episode" tracking
// AlertToast.jsx builds its ref state from. Mirrors squawkAlertsLogic.js's
// own dismissed/pruneDismissed test coverage in spirit: a rule that resolves
// and later fires again must produce a fresh toast, not stay silenced by the
// first one.

import test from "node:test";
import assert from "node:assert/strict";

import { isRuleAlert, foldHealthAlerts } from "../src/components/alertToastLogic.js";

function ruleAlert(id, extra) {
  return { subject: `rule:${id}`, condition: "entity:111", severity: "warning", detail: `"${id}" fired`, ...extra };
}

const HEALTH_ALERT = { subject: "cache", condition: "unreachable", severity: "critical", detail: "Redis is down" };

// --- isRuleAlert ------------------------------------------------------

test("isRuleAlert matches only the rule: subject prefix", () => {
  assert.equal(isRuleAlert(ruleAlert("r1")), true);
  assert.equal(isRuleAlert(HEALTH_ALERT), false);
  assert.equal(isRuleAlert(null), false);
  assert.equal(isRuleAlert({}), false);
});

// --- foldHealthAlerts ---------------------------------------------------

test("a rule alert not seen before is fresh", () => {
  const { fresh, shown } = foldHealthAlerts({}, [ruleAlert("r1")]);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].alert.subject, "rule:r1");
  assert.deepEqual(Object.keys(shown), ["rule:r1::entity:111"]);
});

test("source-health alerts are ignored entirely", () => {
  const { fresh, shown } = foldHealthAlerts({}, [HEALTH_ALERT]);
  assert.deepEqual(fresh, []);
  assert.deepEqual(shown, {});
});

test("a rule alert already shown does not toast again while it stays active", () => {
  const first = foldHealthAlerts({}, [ruleAlert("r1")]);
  const second = foldHealthAlerts(first.shown, [ruleAlert("r1")]);
  assert.deepEqual(second.fresh, []);
  assert.deepEqual(Object.keys(second.shown), ["rule:r1::entity:111"]);
});

test("a rule alert that drops out of the array is pruned from shown, so a later refire is fresh again", () => {
  const first = foldHealthAlerts({}, [ruleAlert("r1")]);
  assert.equal(first.fresh.length, 1);

  // The alert resolved -- /api/health no longer lists it.
  const second = foldHealthAlerts(first.shown, []);
  assert.deepEqual(second.fresh, []);
  assert.deepEqual(second.shown, {});

  // And it fires again: this must be fresh, not suppressed by the episode
  // before it.
  const third = foldHealthAlerts(second.shown, [ruleAlert("r1")]);
  assert.equal(third.fresh.length, 1);
});

test("two different rules toast independently", () => {
  const { fresh } = foldHealthAlerts({}, [ruleAlert("r1"), ruleAlert("r2")]);
  const keys = fresh.map((f) => f.key).sort();
  assert.deepEqual(keys, ["rule:r1::entity:111", "rule:r2::entity:111"]);
});

test("an empty or missing alerts array folds to nothing, not a crash", () => {
  assert.deepEqual(foldHealthAlerts({}, undefined), { shown: {}, fresh: [] });
  assert.deepEqual(foldHealthAlerts({}, null), { shown: {}, fresh: [] });
  assert.deepEqual(foldHealthAlerts({}, []), { shown: {}, fresh: [] });
});
