// Task 42: settings/alertRules.js -- the shape a reader-defined alert rule
// must have to reach the shared configuration, and the validators the
// builder form (AlertRulesSection.jsx) leans on before it lets a rule be
// saved. Mirrors backend/alert_rules.py's own parse_rules test coverage
// (backend/tests/test_alert_rules.py) field for field, since the two must
// agree on what a well-formed rule is.

import test from "node:test";
import assert from "node:assert/strict";

import {
  RULE_LAYERS, sanitizeAlertRules, sanitizeGeofence, sanitizeCondition,
  blankAlertRule, validateAlertRule, describeGeofence, describeCondition,
  describeEngineStatus, describeAreaCaptureLabel,
} from "../src/settings/alertRules.js";

const REGION_KEYS = new Set(["persian_gulf_hormuz", "red_sea_yemen"]);

function baseRule(overrides) {
  return {
    id: "r1",
    name: "Ships near Hormuz",
    layer: "ais",
    enabled: true,
    geofence: { type: "region", key: "persian_gulf_hormuz" },
    condition: { type: "enter" },
    ...overrides,
  };
}

// --- sanitizeGeofence -------------------------------------------------

test("sanitizeGeofence accepts a well-formed country geofence and uppercases the code", () => {
  assert.deepEqual(
    sanitizeGeofence({ type: "country", iso2: "ir", name: "Iran" }, REGION_KEYS),
    { type: "country", iso2: "IR", name: "Iran" }
  );
});

test("sanitizeGeofence rejects a region key not in the live regions table", () => {
  assert.equal(sanitizeGeofence({ type: "region", key: "nowhere" }, REGION_KEYS), null);
});

test("sanitizeGeofence accepts a region key when no live table was given to check against", () => {
  // mergeSettings' own call site (defaults.js) does not have the live
  // REGIONS table at merge time -- see that file's own note -- so this must
  // degrade to "accept on shape alone" rather than reject everything.
  assert.deepEqual(
    sanitizeGeofence({ type: "region", key: "anything" }, undefined),
    { type: "region", key: "anything", name: null }
  );
});

test("sanitizeGeofence rejects a water bbox that is not four numbers", () => {
  assert.equal(sanitizeGeofence({ type: "water", id: "marine:1", bbox: [1, 2, 3] }, REGION_KEYS), null);
});

test("sanitizeGeofence accepts a water geofence with a stored bbox", () => {
  assert.deepEqual(
    sanitizeGeofence({ type: "water", id: "marine:5:hormuz", name: "Strait of Hormuz", bbox: [24, 54, 27, 58] }, REGION_KEYS),
    { type: "water", id: "marine:5:hormuz", name: "Strait of Hormuz", bbox: [24, 54, 27, 58] }
  );
});

test("sanitizeGeofence accepts a rect geofence", () => {
  assert.deepEqual(
    sanitizeGeofence({ type: "rect", bounds: [10, 10, 20, 20] }, REGION_KEYS),
    { type: "rect", bounds: [10, 10, 20, 20] }
  );
});

test("sanitizeGeofence rejects an unknown type", () => {
  assert.equal(sanitizeGeofence({ type: "polygon" }, REGION_KEYS), null);
});

test("sanitizeGeofence of null is null (the whole world)", () => {
  assert.equal(sanitizeGeofence(null, REGION_KEYS), null);
});

// --- sanitizeCondition -------------------------------------------------

test("sanitizeCondition accepts each of the four condition types", () => {
  assert.deepEqual(sanitizeCondition({ type: "enter" }), { type: "enter" });
  assert.deepEqual(sanitizeCondition({ type: "count_exceeds", n: "5" }), { type: "count_exceeds", n: 5 });
  assert.deepEqual(
    sanitizeCondition({ type: "score_above", field: "severity", threshold: "70" }),
    { type: "score_above", field: "severity", threshold: 70 }
  );
  assert.deepEqual(sanitizeCondition({ type: "squawk_equals", code: "7700" }), { type: "squawk_equals", code: "7700" });
});

test("sanitizeCondition rejects a negative count threshold", () => {
  assert.equal(sanitizeCondition({ type: "count_exceeds", n: -1 }), null);
});

test("sanitizeCondition rejects a non-numeric squawk code", () => {
  assert.equal(sanitizeCondition({ type: "squawk_equals", code: "abcd" }), null);
});

test("sanitizeCondition rejects score_above with no field name", () => {
  assert.equal(sanitizeCondition({ type: "score_above", field: "", threshold: 1 }), null);
});

// --- sanitizeAlertRules --------------------------------------------------

test("sanitizeAlertRules keeps a well-formed rule", () => {
  const rules = sanitizeAlertRules([baseRule()], REGION_KEYS);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, "r1");
});

test("sanitizeAlertRules drops a rule with an unknown layer", () => {
  assert.deepEqual(sanitizeAlertRules([baseRule({ layer: "not_a_real_layer" })], REGION_KEYS), []);
});

test("sanitizeAlertRules drops a rule with no name", () => {
  assert.deepEqual(sanitizeAlertRules([baseRule({ name: "" })], REGION_KEYS), []);
});

test("sanitizeAlertRules drops squawk_equals against a non-adsb layer", () => {
  const rule = baseRule({ layer: "ais", condition: { type: "squawk_equals", code: "7700" } });
  assert.deepEqual(sanitizeAlertRules([rule], REGION_KEYS), []);
});

test("sanitizeAlertRules keeps squawk_equals against adsb", () => {
  const rule = baseRule({ layer: "adsb", condition: { type: "squawk_equals", code: "7700" }, geofence: null });
  const rules = sanitizeAlertRules([rule], REGION_KEYS);
  assert.equal(rules.length, 1);
});

test("sanitizeAlertRules drops the whole rule when its geofence does not parse", () => {
  const rule = baseRule({ geofence: { type: "region", key: "nowhere" } });
  assert.deepEqual(sanitizeAlertRules([rule], REGION_KEYS), []);
});

test("sanitizeAlertRules drops a duplicate id, keeping the first", () => {
  const rules = sanitizeAlertRules(
    [baseRule({ name: "first" }), baseRule({ name: "second" })],
    REGION_KEYS
  );
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, "first");
});

test("sanitizeAlertRules ignores a non-array input", () => {
  assert.deepEqual(sanitizeAlertRules(null, REGION_KEYS), []);
  assert.deepEqual(sanitizeAlertRules(undefined, REGION_KEYS), []);
});

// --- blankAlertRule / validateAlertRule -----------------------------------

test("blankAlertRule is a valid layer and condition, but not yet nameable", () => {
  const rule = blankAlertRule();
  assert.ok(RULE_LAYERS.some((l) => l.key === rule.layer));
  assert.equal(rule.condition.type, "enter");
  assert.match(validateAlertRule(rule), /name/i);
});

test("validateAlertRule accepts a complete rule", () => {
  assert.equal(validateAlertRule(baseRule()), null);
});

test("validateAlertRule complains about an incomplete score_above condition", () => {
  const rule = baseRule({ condition: { type: "score_above", field: "", threshold: 0 } });
  assert.match(validateAlertRule(rule), /field/i);
});

test("validateAlertRule refuses squawk_equals on a non-adsb layer even if the condition itself is well-formed", () => {
  const rule = baseRule({ layer: "ais", condition: { type: "squawk_equals", code: "7700" } });
  assert.match(validateAlertRule(rule), /aircraft/i);
});

// --- descriptions ----------------------------------------------------------

test("describeGeofence and describeCondition produce the same wording the toast's server-built detail implies", () => {
  assert.equal(describeGeofence(null), "anywhere");
  assert.equal(describeGeofence({ type: "country", iso2: "IR", name: "Iran" }), "Iran");
  assert.equal(describeGeofence({ type: "region", key: "persian_gulf_hormuz", name: null }), "persian_gulf_hormuz");
  assert.equal(describeCondition({ type: "enter" }), "is present");
  assert.equal(describeCondition({ type: "count_exceeds", n: 5 }), "count exceeds 5");
  assert.equal(describeCondition({ type: "squawk_equals", code: "7700" }), "squawking 7700");
});

// --- describeEngineStatus / describeAreaCaptureLabel -----------------------
//
// Pulled out of AlertRulesSection.jsx (JSX, unreachable by node --test) for
// the same reason describeGeofence/describeCondition were: this project's
// house rule against composing a user-visible string inline in JSX.

test("describeEngineStatus reports never-evaluated when there is no heartbeat row at all", () => {
  const status = describeEngineStatus({});
  assert.equal(status.severity, "err");
  assert.match(status.text, /never evaluated/);
});

test("describeEngineStatus reports never-evaluated when last_success is null", () => {
  const status = describeEngineStatus({ alert_rules: { last_success: null } });
  assert.match(status.text, /never evaluated/);
});

test("describeEngineStatus surfaces the heartbeat's own error text", () => {
  const status = describeEngineStatus({ alert_rules: { last_success: 100, last_error: "frozen" } });
  assert.equal(status.severity, "err");
  assert.equal(status.text, "frozen");
});

test("describeEngineStatus reports healthy with an age when the heartbeat is fresh", () => {
  const status = describeEngineStatus({ alert_rules: { last_success: 100, seconds_since_success: 12, last_error: null } });
  assert.equal(status.severity, "ok");
  assert.equal(status.text, "evaluated 12s ago");
});

test("describeAreaCaptureLabel prompts to click the map when nothing is selected", () => {
  assert.match(describeAreaCaptureLabel("country", null), /click a country/i);
  assert.match(describeAreaCaptureLabel("water", null), /click a sea, lake or river/i);
});

test("describeAreaCaptureLabel names the selection once one exists", () => {
  assert.equal(describeAreaCaptureLabel("country", "Iran"), "Use Iran");
  assert.equal(describeAreaCaptureLabel("water", "Strait of Hormuz"), "Use Strait of Hormuz");
});
