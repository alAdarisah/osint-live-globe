// Task 42: "tell me when X happens here" -- the shape of a reader-defined
// alert rule, shared between the admin builder (AlertRulesSection.jsx), the
// toast (alertToastLogic.js) and mergeSettings (defaults.js). Mirrors
// backend/alert_rules.py's own Rule/geofence/condition shapes field for
// field -- the two are validated independently (this file guards what an
// operator's own browser writes into the shared config; alert_rules.py
// guards what the cache worker reads back out of it, since the file on disk
// is hand-editable), but they must agree on what a well-formed rule looks
// like or a rule built here would simply never fire there.
//
// RULE_LAYERS is a curated subset of entity_latest's own kind names
// (backend/storage.py), not every kind that table holds -- only the ones
// confirmed (by reading the actual record_snapshot() call in each source
// module, not from memory -- see this task's own report) to carry a stable
// per-row identity and a lat/lon a geofence can test. Ships and aircraft are
// the two seen most often, so they lead the list.

export const RULE_LAYERS = [
  { key: "ais", label: "Ships (AIS)" },
  { key: "adsb", label: "Aircraft (ADS-B)" },
  { key: "gdelt_conflict", label: "Conflict events (GDELT)" },
  { key: "acled", label: "Conflict events (ACLED)" },
  { key: "jamming", label: "GPS/radio jamming (GPSJam)" },
  { key: "gfw_detections", label: "Satellite vessel detections (GFW)" },
  { key: "firms", label: "Fires / thermal anomalies (FIRMS)" },
];
const RULE_LAYER_KEYS = new Set(RULE_LAYERS.map((l) => l.key));

export const CONDITION_TYPES = [
  { key: "enter", label: "An entity is inside the area" },
  { key: "count_exceeds", label: "The count inside the area exceeds N" },
  { key: "score_above", label: "A field on an entity is above X" },
  { key: "squawk_equals", label: "An aircraft is squawking a given code" },
];

export const GEOFENCE_TYPES = [
  { key: "world", label: "Anywhere (no area)" },
  { key: "country", label: "A country" },
  { key: "region", label: "A named region" },
  { key: "water", label: "A sea, lake or river" },
  { key: "rect", label: "The current map view" },
];

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanStr(value, maxLen = 200) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : null;
}

function cleanBbox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const nums = value.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [south, west, north, east] = nums;
  if (south < -90 || south > 90 || north < -90 || north > 90) return null;
  if (west < -180 || west > 180 || east < -180 || east > 180) return null;
  if (south > north) return null;
  return nums;
}

/** A stored geofence -> a clean one, or null (meaning "the whole world",
 *  which is also what a rule with no geofence at all means). Region keys
 *  are checked against `regionKeys` -- the live REGIONS table from
 *  /api/regions -- rather than a list restated here, for the same "one
 *  definition of what a region is" reason regions.py's own REGIONS dict is
 *  shared between the region bar and the backend's query filter. */
export function sanitizeGeofence(raw, regionKeys) {
  if (raw == null) return null;
  if (!isPlainObject(raw)) return null;
  if (raw.type === "country") {
    const iso2 = cleanStr(raw.iso2, 2);
    return iso2 ? { type: "country", iso2: iso2.toUpperCase(), name: cleanStr(raw.name, 120) } : null;
  }
  if (raw.type === "region") {
    const key = cleanStr(raw.key, 60);
    if (!key || (regionKeys && !regionKeys.has(key))) return null;
    return { type: "region", key, name: cleanStr(raw.name, 120) };
  }
  if (raw.type === "water") {
    const id = cleanStr(raw.id, 120);
    const bbox = cleanBbox(raw.bbox);
    return id && bbox ? { type: "water", id, name: cleanStr(raw.name, 120), bbox } : null;
  }
  if (raw.type === "rect") {
    const bounds = cleanBbox(raw.bounds);
    return bounds ? { type: "rect", bounds } : null;
  }
  return null;
}

/** A stored condition -> a clean one, or null. */
export function sanitizeCondition(raw) {
  if (!isPlainObject(raw)) return null;
  if (raw.type === "enter") return { type: "enter" };
  if (raw.type === "count_exceeds") {
    const n = Math.round(Number(raw.n));
    return Number.isFinite(n) && n >= 0 ? { type: "count_exceeds", n } : null;
  }
  if (raw.type === "score_above") {
    const fieldName = cleanStr(raw.field, 60);
    const threshold = Number(raw.threshold);
    return fieldName && Number.isFinite(threshold) ? { type: "score_above", field: fieldName, threshold } : null;
  }
  if (raw.type === "squawk_equals") {
    const code = cleanStr(raw.code, 4);
    return code && /^\d+$/.test(code) ? { type: "squawk_equals", code } : null;
  }
  return null;
}

/**
 * A stored `alertRules` array -> the rules worth keeping in local state,
 * every malformed or unrecognised entry dropped rather than repaired --
 * same call sanitizeFilterPresets (defaults.js) makes for the same reason:
 * a rule missing a name or a condition is not a recognisable thing to
 * repair into, it is just not a rule. Mirrors backend/alert_rules.py's own
 * parse_rules() field for field (including the "squawk_equals only means
 * anything on the adsb layer" and "a geofence that fails to parse drops the
 * whole rule rather than silently widening it to the whole world" rules),
 * so a rule this function accepts is a rule the cache worker will actually
 * evaluate.
 */
export function sanitizeAlertRules(stored, regionKeys) {
  if (!Array.isArray(stored)) return [];
  const out = [];
  const seenIds = new Set();
  for (const entry of stored) {
    if (!isPlainObject(entry)) continue;
    const id = cleanStr(entry.id, 80);
    const name = cleanStr(entry.name, 120);
    const layer = RULE_LAYER_KEYS.has(entry.layer) ? entry.layer : null;
    const condition = sanitizeCondition(entry.condition);
    if (!id || seenIds.has(id) || !name || !layer || !condition) continue;
    if (condition.type === "squawk_equals" && layer !== "adsb") continue;
    let geofence = null;
    if (entry.geofence != null) {
      geofence = sanitizeGeofence(entry.geofence, regionKeys);
      if (!geofence) continue; // a broken geofence drops the whole rule -- see module note
    }
    seenIds.add(id);
    out.push({
      id,
      name,
      layer,
      enabled: entry.enabled !== false,
      geofence,
      condition,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
    });
  }
  return out;
}

/** A fresh, empty rule for the builder form to start from. Not itself valid
 *  (no condition has been chosen) until validateAlertRule below says so. */
export function blankAlertRule() {
  return {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    layer: RULE_LAYERS[0].key,
    enabled: true,
    geofence: null,
    condition: { type: "enter" },
    createdAt: Date.now(),
  };
}

/** Whether a rule (as the builder form currently has it) is complete enough
 *  to save, and if not, the one thing to fix -- a single message rather
 *  than a field-by-field map, because the form has one save button and one
 *  place to show why it is disabled. */
export function validateAlertRule(rule) {
  if (!rule || !cleanStr(rule.name, 120)) return "Give the rule a name.";
  if (!RULE_LAYER_KEYS.has(rule.layer)) return "Choose a layer.";
  const condition = sanitizeCondition(rule.condition);
  if (!condition) {
    if (rule.condition?.type === "score_above") return "Give the field a name and a threshold.";
    if (rule.condition?.type === "squawk_equals") return "Choose a squawk code.";
    if (rule.condition?.type === "count_exceeds") return "Give the count a threshold.";
    return "Choose a condition.";
  }
  if (condition.type === "squawk_equals" && rule.layer !== "adsb") {
    return "Squawk codes only apply to the Aircraft (ADS-B) layer.";
  }
  if (rule.geofence != null && !sanitizeGeofence(rule.geofence, null)) return "That area is not set up yet.";
  return null;
}

/** Plain-language description of where a rule watches, for the rule list
 *  row and the toast -- the identical text backend/alert_rules.py's own
 *  _geofence_label builds server-side for the alert `detail`, so a reader
 *  never sees the admin panel and the toast describe the same rule two
 *  different ways. */
export function describeGeofence(geofence) {
  if (!geofence) return "anywhere";
  if (geofence.type === "country") return geofence.name || geofence.iso2;
  if (geofence.type === "region") return geofence.name || geofence.key;
  if (geofence.type === "water") return geofence.name || geofence.id;
  if (geofence.type === "rect") return "the marked area";
  return "the marked area";
}

/** Plain-language description of what a rule is watching for, for the same
 *  two call sites describeGeofence serves. */
export function describeCondition(condition) {
  if (!condition) return "";
  if (condition.type === "enter") return "is present";
  if (condition.type === "count_exceeds") return `count exceeds ${condition.n}`;
  if (condition.type === "score_above") return `${condition.field} above ${condition.threshold}`;
  if (condition.type === "squawk_equals") return `squawking ${condition.code}`;
  return "";
}

/**
 * The rule engine's own heartbeat (backend/app.py's `alert_rules` health
 * block) reduced to one label + severity class, for AlertRulesSection.jsx's
 * status line. Pulled out of that file (which is JSX and unreachable by
 * this project's `node --test` suite -- see frontend/tests/*.test.js) for
 * the same reason describeGeofence/describeCondition are: this composes a
 * user-visible sentence out of live data, and every task in this plan that
 * did that inline in JSX was sent back for it.
 *
 * Three of the four states this task's brief requires (never evaluated /
 * evaluated-and-quiet / currently firing / this rule's own layer unhealthy)
 * are told apart here or by the caller cross-referencing `health`'s other
 * entries; the fourth (firing) is a per-rule question the rule list row
 * answers on its own, not this section-wide summary.
 */
export function describeEngineStatus(health) {
  const row = health?.alert_rules;
  if (!row || row.last_success == null) {
    return { severity: "err", text: "never evaluated -- the cache worker has not run yet" };
  }
  if (row.last_error) return { severity: "err", text: row.last_error };
  return { severity: "ok", text: `evaluated ${row.seconds_since_success ?? 0}s ago` };
}

/** The "Use <name>" capture button's own label for the country/water area
 *  pickers, or the prompt to click the map first when nothing is selected
 *  yet -- shared by both (the two buttons differ only in what "click ... on
 *  the map" names) so the wording is written once and stays in step. */
export function describeAreaCaptureLabel(kind, selectedName) {
  if (selectedName) return `Use ${selectedName}`;
  return kind === "water" ? "Click a sea, lake or river on the map first" : "Click a country on the map first";
}
