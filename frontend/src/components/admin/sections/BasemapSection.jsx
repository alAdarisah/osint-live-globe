// Task 30: tile tint. The basemap, GIBS imagery and the weather rasters are
// all raster PNG/JPEG from someone else's server (CARTO, NASA GIBS,
// RainViewer/OWM -- see map/layers.js) -- there is no vector style underneath
// any of them for Admin Mode to recolour the way it recolours a pin, so this
// section works the two CSS mechanisms that do apply to a tile image instead:
// a filter (saturation/brightness/contrast/invert/blur) and a full-pane
// colour tint composited with a blend mode. See map/tileTint.js for the pure
// dial shape and preset table this renders, and style.css for where the two
// mechanisms actually land on the map.
//
// Three independent blocks, not one shared set of dials -- tinting a road map
// and tinting a satellite mosaic are different jobs, and a reader who wants
// GIBS imagery left alone while the basemap goes dark for night ops needs
// that to be two separate choices, not one.
import { PanelGroup } from "../../controlPanel/Collapsible";
import { SliderField, ColorField, CheckField } from "../fields";
import { BLEND_MODES, TILE_TINT_PRESETS, TILE_TINT_PRESET_ORDER } from "../../../map/tileTint";

const TARGETS = [
  {
    key: "basemap",
    label: "Basemap",
    note: "The CARTO road map underneath everything else.",
  },
  {
    key: "imagery",
    label: "Satellite imagery",
    note: "NASA GIBS true-colour and night-lights, when one is picked from the Imagery panel.",
  },
  {
    key: "weather",
    label: "Weather",
    note: "RainViewer precipitation radar and the OpenWeatherMap cloud layer, tinted together.",
  },
];

export const SEARCH_TERMS = [
  "Tile tint",
  "Basemap tint",
  "Imagery tint",
  "Weather tint",
  "Tint colour",
  "Tint strength",
  "Blend mode",
  "Saturation",
  "Brightness",
  "Contrast",
  "Invert",
  "Blur",
  "Apply tint only when the map is at rest",
  ...TARGETS.map((t) => t.label),
  ...TILE_TINT_PRESET_ORDER.map((key) => TILE_TINT_PRESETS[key].label),
];

export default function BasemapSection({ settings, actions, isOpen, onToggle }) {
  return (
    <PanelGroup id="adm-tiles" title="Tile tint" open={isOpen("adm-tiles")} onToggle={onToggle}>
      <div className="admin-note">
        The basemap and its two overlays are raster images from CARTO, NASA and RainViewer/OWM --
        there is no map style underneath them to recolour, so these two dials (a filter, and a
        colour tinted on top) are what "recolouring the map" can mean here. Basemap, imagery and
        weather are tinted independently.
      </div>
      {TARGETS.map((target) => (
        <TileDialBlock
          key={target.key}
          target={target}
          dial={settings.ui.tiles[target.key]}
          onPreset={(presetKey) => actions.setTilePreset(target.key, presetKey)}
          onChange={(patch) => actions.setTileDial(target.key, patch)}
        />
      ))}
      <CheckField
        label="Apply tint only when the map is at rest"
        note="Switches the filter and tint off the instant a pan or zoom starts, and back on the instant it settles. Only worth turning on if a strong blur is making panning feel sluggish -- every shipped preset ships with no blur, so this costs nothing for most configurations."
        checked={settings.ui.tiles.applyAtRest}
        onChange={(value) => actions.setTilesApplyAtRest(value)}
      />
    </PanelGroup>
  );
}

function TileDialBlock({ target, dial, onPreset, onChange }) {
  return (
    <div className="admin-layer-block">
      <div className="admin-subhead">{target.label}</div>
      <div className="admin-note">{target.note}</div>
      <div className="admin-row admin-preset-row">
        {TILE_TINT_PRESET_ORDER.map((presetKey) => (
          <button key={presetKey} type="button" onClick={() => onPreset(presetKey)}>
            {TILE_TINT_PRESETS[presetKey].label}
          </button>
        ))}
      </div>
      <ColorField
        label="Tint colour"
        value={dial.tintColor}
        defaultValue="#000000"
        onChange={(value) => onChange({ tintColor: value })}
      />
      <SliderField
        label="Tint strength"
        value={dial.tintStrength}
        defaultValue={0}
        min={0}
        max={1}
        step={0.02}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(value) => onChange({ tintStrength: value })}
      />
      <label className="admin-select-row">
        <span>Blend mode</span>
        <select value={dial.blendMode} onChange={(e) => onChange({ blendMode: e.target.value })}>
          {BLEND_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode === "soft-light" ? "Soft light" : mode[0].toUpperCase() + mode.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <SliderField
        label="Saturation"
        value={dial.saturate}
        defaultValue={1}
        min={0}
        max={2}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(value) => onChange({ saturate: value })}
      />
      <SliderField
        label="Brightness"
        value={dial.brightness}
        defaultValue={1}
        min={0.3}
        max={1.7}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(value) => onChange({ brightness: value })}
      />
      <SliderField
        label="Contrast"
        value={dial.contrast}
        defaultValue={1}
        min={0.5}
        max={1.5}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(value) => onChange({ contrast: value })}
      />
      <SliderField
        label="Blur"
        value={dial.blur}
        defaultValue={0}
        min={0}
        max={3}
        step={0.1}
        format={(v) => `${v.toFixed(1)}px`}
        onChange={(value) => onChange({ blur: value })}
      />
      <CheckField
        label="Invert"
        checked={dial.invert}
        onChange={(value) => onChange({ invert: value })}
      />
    </div>
  );
}
