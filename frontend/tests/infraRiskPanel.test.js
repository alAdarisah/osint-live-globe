// Task 37: InfraRiskPanel's own logic -- reading GET /api/infra-risk's
// ranked `top` array into rows, the sort, and which of the five Nearby
// categories the document says had nothing indexed at all.
// infraRiskPanelLogic.js imports nothing, so unlike intelPanel.test.js this
// needs no window/Leaflet stub -- same footing as chokepointPanel.test.js.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORY_LABEL, INFRA_RISK_SORT_KEYS, emptyCategories, infraRiskRows, sortInfraRisk,
} from "../src/components/infraRiskPanelLogic.js";

function site(site_id, overrides = {}) {
  return {
    site_id, category: "dam", name: site_id, lat: 10, lon: 10, event_count: 1,
    ...overrides,
  };
}

// --- infraRiskRows ----------------------------------------------------

test("infraRiskRows reads the document's own `top` array", () => {
  const doc = { top: [site("dam:1"), site("dam:2")] };
  assert.equal(infraRiskRows(doc).length, 2);
});

test("infraRiskRows is empty, not an error, before anything has landed", () => {
  assert.deepEqual(infraRiskRows(null), []);
  assert.deepEqual(infraRiskRows(undefined), []);
  assert.deepEqual(infraRiskRows({}), []);
  assert.deepEqual(infraRiskRows({ top: null }), []);
});

// --- sortInfraRisk -------------------------------------------------------

test("sorts by event_count, busiest first by default", () => {
  const rows = [
    site("A", { event_count: 5 }),
    site("B", { event_count: 60 }),
    site("C", { event_count: 20 }),
  ];
  const sorted = sortInfraRisk(rows, "event_count");
  assert.deepEqual(sorted.map((r) => r.site_id), ["B", "C", "A"]);
});

test("sorts ascending when asked", () => {
  const rows = [site("A", { event_count: 5 }), site("B", { event_count: 60 })];
  const sorted = sortInfraRisk(rows, "event_count", "asc");
  assert.deepEqual(sorted.map((r) => r.site_id), ["A", "B"]);
});

test("sorts by name alphabetically", () => {
  const rows = [
    site("z", { name: "Zed Dam" }),
    site("b", { name: "Black Sea Port" }),
    site("t", { name: "Taiwan Fab" }),
  ];
  const sorted = sortInfraRisk(rows, "name", "asc");
  assert.deepEqual(sorted.map((r) => r.name), ["Black Sea Port", "Taiwan Fab", "Zed Dam"]);
});

test("ties on event_count break on site_id, not name -- two sites can share a generated name", () => {
  const rows = [
    site("dam:zzz", { name: "Unnamed dam", event_count: 3 }),
    site("dam:aaa", { name: "Unnamed dam", event_count: 3 }),
  ];
  const sorted = sortInfraRisk(rows, "event_count");
  assert.deepEqual(sorted.map((r) => r.site_id), ["dam:aaa", "dam:zzz"]);
});

test("sorting never mutates the array it was given", () => {
  const rows = [site("A"), site("B")];
  const original = [...rows];
  sortInfraRisk(rows, "event_count");
  assert.deepEqual(rows, original);
});

test("an unknown sort key falls back to event_count rather than throwing", () => {
  const rows = [site("A", { event_count: 5 }), site("B", { event_count: 60 })];
  const sorted = sortInfraRisk(rows, "not_a_real_key");
  assert.deepEqual(sorted.map((r) => r.site_id), ["B", "A"]);
});

test("a missing event_count sorts below every real count, including a real low one", () => {
  const rows = [
    site("NO_COUNT", { event_count: undefined }),
    site("LOW", { event_count: 1 }),
  ];
  const sorted = sortInfraRisk(rows, "event_count", "desc");
  assert.deepEqual(sorted.map((r) => r.site_id), ["LOW", "NO_COUNT"]);
});

test("INFRA_RISK_SORT_KEYS lists every axis the panel can sort by", () => {
  assert.ok(INFRA_RISK_SORT_KEYS.includes("event_count"));
  assert.ok(INFRA_RISK_SORT_KEYS.includes("name"));
});

// --- emptyCategories -------------------------------------------------------

test("emptyCategories lists a category with zero indexed sites", () => {
  const doc = { category_counts: { dam: 3, power_plant: 0, cable_landing: 5, airfield: 12, port: 0 } };
  assert.deepEqual(emptyCategories(doc).sort(), ["port", "power_plant"]);
});

test("emptyCategories is empty when every category has at least one indexed site", () => {
  const doc = { category_counts: { dam: 1, power_plant: 1, cable_landing: 1, airfield: 1, port: 1 } };
  assert.deepEqual(emptyCategories(doc), []);
});

test("emptyCategories treats a missing category_counts document as every category empty", () => {
  assert.deepEqual(emptyCategories({}).sort(), Object.keys(CATEGORY_LABEL).sort());
  assert.deepEqual(emptyCategories(null).sort(), Object.keys(CATEGORY_LABEL).sort());
});

// --- CATEGORY_LABEL ---------------------------------------------------------

test("CATEGORY_LABEL covers exactly the five Nearby categories the brief names", () => {
  assert.deepEqual(Object.keys(CATEGORY_LABEL).sort(), [
    "airfield", "cable_landing", "dam", "port", "power_plant",
  ]);
});
