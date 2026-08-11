// Task 31: the vessel and aircraft filter bars (Task 18) and the conflict
// event filter, gathered into Admin Mode -- plus saved filter presets, which
// exist nowhere else.
//
// The three filters themselves are not settings -- they are App.jsx's own
// React state (eventFilter/vesselFilter/aircraftFilter), a session's working
// query rather than a standing configuration every reader of this
// deployment should open into (see settings/defaults.js's own note on
// `filters.presets`). So this section is threaded the live values and their
// setters from App.jsx, the same way ControlPanel/LayersSection already are,
// rather than reading or writing through `settings` for the live half of its
// job -- only the saved presets live in `settings.filters.presets`.
//
// Window, Minimum severity and the verification floor are deliberately
// absent here: Task 12 moved them into IntelPanel's own header specifically
// so a reader could reach them without finding Admin Mode first, and
// LayersSection.jsx's own note by the control drawer's event-filter block
// explains why a second copy of any of the three would drift from that one.
// Show approximate locations is the one eventFilter field still owned by the
// control drawer, and is repeated here for the same reason the vessel/
// aircraft bars are: collecting what already exists, not duplicating a
// derived value.
import { useState } from "react";
import { PanelGroup } from "../../controlPanel/Collapsible";
import { CheckField } from "../fields";

export const SEARCH_TERMS = [
  "Filters",
  "Vessel filter",
  "Aircraft filter",
  "Event filter",
  "Show approximate locations",
  "OFAC-designated only",
  "Watchlisted only",
  "Military only",
  "Saved filter presets",
];

export default function FiltersSection({
  settings, actions, isOpen, onToggle,
  eventFilter, onEventFilterChange,
  vesselFilter, onVesselFilterChange,
  aircraftFilter, onAircraftFilterChange,
}) {
  const [presetName, setPresetName] = useState("");
  const presets = settings.filters.presets;

  // Any of the three props this section needs from App.jsx being absent
  // means an older render tree mounted it (a half-applied hot reload, a
  // stray test render) -- rendering nothing rather than throwing reading a
  // field off undefined, the same defensive rule Collapsible.jsx's own
  // isOpen/setOpen defaults follow.
  if (!eventFilter || !vesselFilter || !aircraftFilter) return null;

  const canSave = presetName.trim().length > 0;

  return (
    <PanelGroup id="adm-filters" title="Filters" open={isOpen("adm-filters")} onToggle={onToggle}>
      <div className="admin-subhead">Vessels</div>
      <label className="admin-select-row">
        <span>Filter text</span>
        <input
          type="text"
          value={vesselFilter.text}
          placeholder="callsign, name, MMSI, IMO..."
          onChange={(e) => onVesselFilterChange({ text: e.target.value })}
        />
      </label>
      <CheckField
        label="OFAC-designated only"
        checked={vesselFilter.sanctionedOnly}
        onChange={(checked) => onVesselFilterChange({ sanctionedOnly: checked })}
      />
      <CheckField
        label="Watchlisted only"
        checked={vesselFilter.watchlistedOnly}
        onChange={(checked) => onVesselFilterChange({ watchlistedOnly: checked })}
      />

      <div className="admin-subhead">Aircraft</div>
      <label className="admin-select-row">
        <span>Filter text</span>
        <input
          type="text"
          value={aircraftFilter.text}
          placeholder="callsign, registration, ICAO, operator..."
          onChange={(e) => onAircraftFilterChange({ text: e.target.value })}
        />
      </label>
      <CheckField
        label="Military only"
        checked={aircraftFilter.militaryOnly}
        onChange={(checked) => onAircraftFilterChange({ militaryOnly: checked })}
      />

      <div className="admin-subhead">Conflict events</div>
      <CheckField
        label="Show approximate locations"
        checked={eventFilter.showImprecise}
        onChange={(checked) => onEventFilterChange({ showImprecise: checked })}
      />
      <div className="admin-note">
        Window, minimum severity and the verification floor live in the Intel panel's own header
        (bottom-right), reachable without Admin Mode -- see this section's own source for why they
        are not repeated here.
      </div>

      <div className="admin-subhead">Saved filter presets</div>
      <div className="admin-note">
        Captures the vessel filter, aircraft filter and conflict-event filter above as one named
        snapshot. Applying a preset replaces all three at once.
      </div>
      <div className="admin-row">
        <input
          type="text"
          placeholder="Preset name..."
          value={presetName}
          onChange={(e) => setPresetName(e.target.value)}
        />
        <button
          type="button"
          className="admin-wide-btn"
          disabled={!canSave}
          onClick={() => {
            actions.saveFilterPreset(presetName.trim(), { vesselFilter, aircraftFilter, eventFilter });
            setPresetName("");
          }}
        >
          Save current filters
        </button>
      </div>
      {presets.length === 0 ? (
        <div className="admin-note">No presets saved yet.</div>
      ) : (
        <ul className="admin-filter-preset-list">
          {presets.map((preset) => (
            <li key={preset.id} className="admin-filter-preset-row">
              <span className="admin-filter-preset-name">{preset.name}</span>
              <button
                type="button"
                className="admin-reset-btn"
                title="Apply this preset's vessel, aircraft and event filters"
                onClick={() => {
                  onVesselFilterChange(preset.vesselFilter);
                  onAircraftFilterChange(preset.aircraftFilter);
                  onEventFilterChange(preset.eventFilter);
                }}
              >
                Apply
              </button>
              <button
                type="button"
                className="admin-reset-btn"
                title="Delete this preset"
                onClick={() => actions.deleteFilterPreset(preset.id)}
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}
    </PanelGroup>
  );
}
