// Task 42: "tell me when X happens here, and tell me once" -- the admin UI
// for building a rule (backend/alert_rules.py evaluates it; AlertToast.jsx
// shows it firing).
//
// A rule needs a geofence, and the brief says "draw it on the map, or pick a
// country / region / water body". This section does not build a fourth,
// standalone drawing tool for that first option. Three interactions this map
// already has cover exactly the same ground:
//   - clicking a country (the same click Task 40's compare view already
//     reads as mapApi.countrySelection)
//   - clicking a water body (mapApi.selectedWater, Task 7's own card
//     selection)
//   - panning/zooming the map itself (mapApi.mapBounds, kept live by
//     createMapController's own onBoundsChange)
// borderEdit.js's own drag-a-vertex editor was read first and is not this --
// it edits an existing country's boundary vertex by vertex, and adapting it
// into a freehand shape tool would be a second, larger piece of map-drawing
// machinery for a plan whose brief already asks not to build more than the
// task needs. "Use current map view" is this task's honest stand-in for a
// drawn rectangle: an operator points the real map at the real place they
// mean, the same motion drawing one would take, and clicks one button
// instead of dragging a shape. See this task's own report for the full
// reasoning.
//
// Everything a rule needs to be saved lives in a local `draft` -- there is
// no live-as-you-type save the way a colour picker gets, because a
// half-built rule (a layer chosen, no condition yet) is not a rule worth
// persisting into the shared configuration every client reads.
import { useState } from "react";
import { PanelGroup } from "../../controlPanel/Collapsible";
import { CheckField } from "../fields";
import {
  RULE_LAYERS, CONDITION_TYPES, GEOFENCE_TYPES,
  blankAlertRule, validateAlertRule, describeGeofence, describeCondition,
  describeEngineStatus, describeAreaCaptureLabel,
} from "../../../settings/alertRules";
import { EMERGENCY_SQUAWK_CODES } from "../../../map/decorators";

export const SEARCH_TERMS = [
  "Alert rules",
  "Tell me when",
  "Geofence",
  "Entity enters",
  "Count exceeds",
  "Score above",
  "Squawk equals",
];

function geofenceType(geofence) {
  return geofence ? geofence.type : "world";
}

function AreaPicker({ draft, setDraft, regions, mapBounds, countrySelection, selectedWater }) {
  // Which area sub-form is showing, tracked separately from draft.geofence
  // itself. Country/water/rect are two-step choices -- pick the kind, then
  // press a capture button -- and writing a bare {type: "country"} (no
  // iso2 yet) into draft.geofence the moment the dropdown changes was a
  // real bug caught in this task's own live verification: the "Set to..."
  // /"Area captured..." notes below read draft.geofence's *type* to decide
  // whether to show themselves, so they rendered ("Set to undefined.")
  // before anything had actually been captured. "Region" and "world" stay
  // one-step (the dropdown choice alone is already a complete geofence, or
  // "no geofence" for world), so those two still write through setDraft
  // immediately -- see the branches below.
  const [pendingType, setPendingType] = useState(() => geofenceType(draft.geofence));
  const type = pendingType;

  function setType(nextType) {
    setPendingType(nextType);
    if (nextType === "world") setDraft((d) => ({ ...d, geofence: null }));
  }

  const selectedCountry = countrySelection?.[0] || null;
  const water = selectedWater?.entry || null;

  return (
    <>
      <label className="admin-select-row">
        <span>Area</span>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {GEOFENCE_TYPES.map((g) => (
            <option key={g.key} value={g.key}>{g.label}</option>
          ))}
        </select>
      </label>

      {type === "country" && (
        <div className="admin-row">
          <button
            type="button"
            className="admin-wide-btn"
            disabled={!selectedCountry}
            onClick={() =>
              setDraft((d) => ({
                ...d,
                geofence: { type: "country", iso2: selectedCountry.iso, name: selectedCountry.name },
              }))
            }
          >
            {describeAreaCaptureLabel("country", selectedCountry?.name)}
          </button>
          {draft.geofence?.type === "country" && (
            <span className="admin-note">Set to {draft.geofence.name || draft.geofence.iso2}.</span>
          )}
        </div>
      )}

      {type === "region" && (
        <label className="admin-select-row">
          <span>Region</span>
          <select
            value={draft.geofence?.key || ""}
            onChange={(e) => {
              const key = e.target.value;
              const entry = regions?.[key];
              setDraft((d) => ({ ...d, geofence: key ? { type: "region", key, name: entry?.label } : null }));
            }}
          >
            <option value="">Choose a region...</option>
            {Object.entries(regions || {})
              .filter(([key]) => key !== "world")
              .map(([key, entry]) => (
                <option key={key} value={key}>{entry.label}</option>
              ))}
          </select>
        </label>
      )}

      {type === "water" && (
        <div className="admin-row">
          <button
            type="button"
            className="admin-wide-btn"
            disabled={!water}
            onClick={() =>
              setDraft((d) => ({
                ...d,
                geofence: { type: "water", id: water.id, name: water.name || null, bbox: water.rawBbox },
              }))
            }
          >
            {describeAreaCaptureLabel("water", water ? water.name || "this water body" : null)}
          </button>
          {draft.geofence?.type === "water" && (
            <span className="admin-note">Set to {draft.geofence.name || draft.geofence.id}.</span>
          )}
        </div>
      )}

      {type === "rect" && (
        <div className="admin-row">
          <button
            type="button"
            className="admin-wide-btn"
            disabled={!mapBounds}
            onClick={() =>
              setDraft((d) => ({
                ...d,
                geofence: {
                  type: "rect",
                  bounds: [mapBounds.south, mapBounds.west, mapBounds.north, mapBounds.east],
                },
              }))
            }
          >
            Use the current map view
          </button>
          {draft.geofence?.type === "rect" && <span className="admin-note">Area captured from the current view.</span>}
        </div>
      )}
    </>
  );
}

function ConditionPicker({ draft, setDraft }) {
  const type = draft.condition?.type || "enter";
  const isAdsb = draft.layer === "adsb";

  function setType(nextType) {
    setDraft((d) => {
      if (nextType === "count_exceeds") return { ...d, condition: { type: nextType, n: 10 } };
      if (nextType === "score_above") return { ...d, condition: { type: nextType, field: "", threshold: 0 } };
      if (nextType === "squawk_equals") return { ...d, condition: { type: nextType, code: EMERGENCY_SQUAWK_CODES[0] } };
      return { ...d, condition: { type: "enter" } };
    });
  }

  return (
    <>
      <label className="admin-select-row">
        <span>Condition</span>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {CONDITION_TYPES.map((c) => (
            <option key={c.key} value={c.key} disabled={c.key === "squawk_equals" && !isAdsb}>
              {c.label}{c.key === "squawk_equals" && !isAdsb ? " (Aircraft/ADS-B only)" : ""}
            </option>
          ))}
        </select>
      </label>

      {type === "count_exceeds" && (
        <label className="admin-select-row">
          <span>More than</span>
          <input
            type="number"
            min={0}
            value={draft.condition.n}
            onChange={(e) => setDraft((d) => ({ ...d, condition: { ...d.condition, n: Number(e.target.value) } }))}
          />
        </label>
      )}

      {type === "score_above" && (
        <>
          <label className="admin-select-row">
            <span>Field</span>
            <input
              type="text"
              placeholder="e.g. severity, fatalities, confidence"
              value={draft.condition.field}
              onChange={(e) => setDraft((d) => ({ ...d, condition: { ...d.condition, field: e.target.value } }))}
            />
          </label>
          <label className="admin-select-row">
            <span>Above</span>
            <input
              type="number"
              value={draft.condition.threshold}
              onChange={(e) =>
                setDraft((d) => ({ ...d, condition: { ...d.condition, threshold: Number(e.target.value) } }))
              }
            />
          </label>
          <div className="admin-note">
            The exact field name on the record this layer reports, e.g. "severity" for conflict events. Not
            validated against the feed -- a name it does not carry simply never matches.
          </div>
        </>
      )}

      {type === "squawk_equals" && (
        <label className="admin-select-row">
          <span>Squawk code</span>
          <select
            value={draft.condition.code}
            onChange={(e) => setDraft((d) => ({ ...d, condition: { ...d.condition, code: e.target.value } }))}
          >
            {EMERGENCY_SQUAWK_CODES.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

function RuleRow({ rule, health, onEdit, onToggle, onDelete }) {
  const firing = (health?.alerts || []).some((a) => a.subject === `rule:${rule.id}`);
  return (
    <li className="admin-filter-preset-row">
      <span className={`dot ${firing ? "err breathing" : rule.enabled ? "ok" : "warn"}`} title={firing ? "Currently firing" : rule.enabled ? "Watching" : "Paused"} />
      <span className="admin-filter-preset-name">
        {rule.name}
        <span className="admin-field-note">
          {" "}{RULE_LAYERS.find((l) => l.key === rule.layer)?.label || rule.layer} &middot; {describeCondition(rule.condition)} &middot; {describeGeofence(rule.geofence)}
        </span>
      </span>
      <button type="button" className="admin-reset-btn" title={rule.enabled ? "Pause this rule" : "Resume this rule"} onClick={() => onToggle(rule.id, !rule.enabled)}>
        {rule.enabled ? "Pause" : "Resume"}
      </button>
      <button type="button" className="admin-reset-btn" title="Edit this rule" onClick={() => onEdit(rule)}>
        Edit
      </button>
      <button type="button" className="admin-reset-btn" title="Delete this rule" onClick={() => onDelete(rule.id)}>
        &times;
      </button>
    </li>
  );
}

export default function AlertRulesSection({
  settings, actions, isOpen, onToggle, health, regions, mapBounds, countrySelection, selectedWater,
}) {
  const [draft, setDraft] = useState(null);
  const rules = settings.alertRules;
  const status = describeEngineStatus(health);

  const error = draft ? validateAlertRule(draft) : null;

  function startNew() {
    setDraft(blankAlertRule());
  }

  function startEdit(rule) {
    setDraft({ ...rule });
  }

  function save() {
    if (!draft || error) return;
    actions.saveAlertRule(draft);
    setDraft(null);
  }

  return (
    <PanelGroup id="adm-alert-rules" title="Alert rules" open={isOpen("adm-alert-rules")} onToggle={onToggle}>
      <div className="admin-note">
        "Tell me when X happens here" -- a rule watches one layer inside one area (or the whole map) for a
        condition, and fires a toast plus, if a webhook is configured, a message there. A rule that stays true
        fires once; it fires again only if it resolves and later becomes true again.
      </div>
      <div className="admin-row">
        <span className={`dot ${status.severity}`} />
        <span className="admin-note">Rule engine: {status.text}.</span>
      </div>

      {rules.length === 0 ? (
        <div className="admin-note">No rules yet.</div>
      ) : (
        <ul className="admin-filter-preset-list">
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              health={health}
              onEdit={startEdit}
              onToggle={actions.setAlertRuleEnabled}
              onDelete={actions.deleteAlertRule}
            />
          ))}
        </ul>
      )}

      {draft ? (
        <>
          <div className="admin-subhead">{rules.some((r) => r.id === draft.id) ? "Edit rule" : "New rule"}</div>
          <label className="admin-select-row">
            <span>Name</span>
            <input
              type="text"
              placeholder="e.g. Tankers in the Strait of Hormuz"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </label>
          <label className="admin-select-row">
            <span>Layer</span>
            <select
              value={draft.layer}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  layer: e.target.value,
                  // squawk_equals only means anything on adsb -- switching
                  // layer away from it drops back to the always-valid "enter"
                  // condition rather than leaving an unsatisfiable one saved.
                  condition: d.condition.type === "squawk_equals" && e.target.value !== "adsb"
                    ? { type: "enter" }
                    : d.condition,
                }))
              }
            >
              {RULE_LAYERS.map((l) => (
                <option key={l.key} value={l.key}>{l.label}</option>
              ))}
            </select>
          </label>
          <AreaPicker
            // Remounted per rule (new draft, or a different existing rule
            // opened via Edit) so its own local pendingType state (see that
            // component's own note) never leaks from one rule's area choice
            // into another's.
            key={draft.id}
            draft={draft}
            setDraft={setDraft}
            regions={regions}
            mapBounds={mapBounds}
            countrySelection={countrySelection}
            selectedWater={selectedWater}
          />
          <ConditionPicker draft={draft} setDraft={setDraft} />
          <CheckField label="Enabled" checked={draft.enabled} onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))} />
          <div className="admin-row">
            <button type="button" className="admin-wide-btn" disabled={!!error} onClick={save}>
              Save rule
            </button>
            <button type="button" className="admin-reset-btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
          {error && <div className="admin-note">{error}</div>}
        </>
      ) : (
        <button type="button" className="admin-wide-btn" onClick={startNew}>
          + New rule
        </button>
      )}
    </PanelGroup>
  );
}
