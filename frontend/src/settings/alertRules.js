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
// the two seen most often, so they lead the list. Every key here is also a
// top-level key in /api/health's own response (health.ais, health.adsb, ...)
// -- describeRuleStatus below reads that entry to tell "watching, quiet"
// apart from "cannot be evaluated, its feed is down", so a layer added here
// without a matching /api/health entry would silently read as unhealthy
// for ever (fail closed, not fail open -- the honest direction to be wrong
// in, and exactly what backend/alert_rules.py's evaluate_rules does too:
// a layer with no fetched rows contributes nothing, never a false match).

import { STALE_AFTER_SECONDS } from "../utils/tempo";

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

// "rect" is named for what it is -- a rectangle from the current viewport --
// rather than "draw a shape" or anything implying a hand-drawn polygon. See
// AlertRulesSection.jsx's own module note for why a real freehand-drawing
// tool was not built for this task, and its rect branch for the UI's own
// caveat alongside this label.
export const GEOFENCE_TYPES = [
  { key: "world", label: "Anywhere (no area)" },
  { key: "country", label: "A country" },
  { key: "region", label: "A named region" },
  { key: "water", label: "A sea, lake or river" },
  { key: "rect", label: "A rectangle (current map view)" },
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

/**
 * Whether `info` (one /api/health entry, e.g. health.ais) is currently
 * landing data -- the identical rule SourceStatusSection.jsx's own dot
 * colouring has always used (`info.last_success && info.seconds_since_success
 * < STALE_AFTER_SECONDS`), read here rather than restated so a layer this
 * map already calls unhealthy on the Source status fold cannot read as
 * healthy on a rule that watches it. No second staleness threshold invented
 * for this -- see STALE_AFTER_SECONDS's own module note in utils/tempo.js.
 */
export function layerIsHealthy(info) {
  return !!(info && info.last_success && info.seconds_since_success < STALE_AFTER_SECONDS);
}

/**
 * A rule row's own status -- {severity, text} -- distinguishing the four
 * states a reader actually needs to tell apart, in priority order:
 *
 *   1. currently firing (this rule's own subject is in health.alerts)
 *   2. paused (the reader's own on/off switch, `rule.enabled === false`)
 *   3. its layer cannot be evaluated right now (health[rule.layer] is not
 *      landing data -- see layerIsHealthy above)
 *   4. watching, and quiet
 *
 * This is the fix for the review's own critical finding on this task: the
 * rule list previously decided a row's dot from firing + enabled alone, so
 * a rule whose layer's feed had broken -- entity_latest_with_ids returning
 * nothing not because the geofence is empty but because the data behind it
 * is gone -- rendered identically to a healthy rule that is correctly
 * quiet. Both said "green, watching". A reader has no way to tell "nothing
 * is happening" from "we stopped being able to see", which is exactly the
 * inversion this whole plan exists to prevent -- worse here than anywhere
 * else on this map, because the entire point of a rule is that its silence
 * is supposed to mean something.
 *
 * State 3 is checked before state 4 but after 1/2 deliberately: a rule that
 * is firing or paused has already answered the question a reader is asking
 * ("is this happening" / "did I turn this off"), and layering a second,
 * lower-priority caveat on top of either would be noise, not honesty --
 * backend/app.py's own `_alert_rules_health` docstring frames this the same
 * way, as something a reader cross-references, not a state that overrides
 * an already-informative one.
 */
export function describeRuleStatus(rule, health) {
  const firing = (health?.alerts || []).some((a) => a.subject === `rule:${rule.id}`);
  if (firing) return { severity: "err", text: "Currently firing", pulse: true };
  if (!rule.enabled) return { severity: "warn", text: "Paused" };
  if (!layerIsHealthy(health?.[rule.layer])) {
    const label = RULE_LAYERS.find((l) => l.key === rule.layer)?.label || rule.layer;
    return { severity: "warn", text: `Cannot be evaluated -- ${label}'s feed is down` };
  }
  return { severity: "ok", text: "Watching" };
}

/** The "Use <name>" capture button's own label for the country/water area
 *  pickers, or the prompt to click the map first when nothing is selected
 *  yet -- shared by both (the two buttons differ only in what "click ... on
 *  the map" names) so the wording is written once and stays in step. */
export function describeAreaCaptureLabel(kind, selectedName) {
  if (selectedName) return `Use ${selectedName}`;
  return kind === "water" ? "Click a sea, lake or river on the map first" : "Click a country on the map first";
}

/**
 * The confirmation note shown once an area has actually been captured
 * ("Set to Iran.", "Area captured from the current view."), or "" before
 * anything has been captured yet (AreaPicker's own callers only render this
 * when draft.geofence is already set, but the empty-string fallback keeps
 * this safe to call unconditionally too).
 *
 * Reuses describeGeofence for the name rather than reading
 * geofence.name/iso2/id directly -- one definition of "what to call this
 * geofence", not two that could say something different once a rule has
 * both a builder-time confirmation and a list-row/toast description.
 */
export function describeAreaCaptureConfirmation(geofence) {
  if (!geofence) return "";
  if (geofence.type === "rect") return "Area captured from the current view.";
  return `Set to ${describeGeofence(geofence)}.`;
}
