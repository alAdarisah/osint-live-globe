// Panel opacity, accent, text size, motion, leader lines, cursor.
import { PanelGroup } from "../../controlPanel/Collapsible";
import { SliderField, ColorField, CheckField } from "../fields";
import { defaultSettings } from "../../../settings/defaults";

const DEFAULTS = defaultSettings();

export const SEARCH_TERMS = [
  "Interface",
  "Text size",
  "Panel opacity",
  "Accent colour",
  "Use the theme's own accent",
  "Leader lines",
  "Reduce motion",
  "Map cursor",
  "Cursor style",
  "Cursor size",
  "Cursor colour",
  "Follow the accent colour",
];

export default function InterfaceSection({ settings, actions, isOpen, onToggle }) {
  return (
    <PanelGroup id="adm-ui" title="Interface" open={isOpen("adm-ui")} onToggle={onToggle}>
      <SliderField
        label="Text size"
        value={settings.ui.textScale}
        defaultValue={1}
        min={0.75}
        max={1.6}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(value) => actions.setUi({ textScale: value })}
      />
      <SliderField
        label="Panel opacity"
        value={settings.ui.panelOpacity}
        defaultValue={DEFAULTS.ui.panelOpacity}
        min={0.35}
        max={1}
        step={0.02}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(value) => actions.setUi({ panelOpacity: value })}
      />
      <ColorField
        label="Accent colour"
        value={settings.ui.accent || "#6fe3ff"}
        defaultValue="#6fe3ff"
        onChange={(value) => actions.setUi({ accent: value })}
      />
      {settings.ui.accent && (
        <button type="button" className="admin-wide-btn" onClick={() => actions.setUi({ accent: null })}>
          Use the theme's own accent
        </button>
      )}
      <CheckField
        label="Leader lines"
        note="The thin line from a nudged pin back to its true position."
        checked={settings.ui.showLeaderLines}
        onChange={(value) => actions.setUi({ showLeaderLines: value })}
      />
      <CheckField
        label="Reduce motion"
        note="Stops the pulsing flares, pings and live dots."
        checked={settings.ui.reduceMotion}
        onChange={(value) => actions.setUi({ reduceMotion: value })}
      />
      <CheckField
        label="Map cursor"
        note="Draws the map's own pointer. Off gives you the system cursor back."
        checked={settings.ui.cursorEnabled}
        onChange={(value) => actions.setUi({ cursorEnabled: value })}
      />
      {/* Only shown when there is a cursor to configure -- three controls
          that do nothing are worse than three controls that are absent. */}
      {settings.ui.cursorEnabled && (
        <>
          <label className="admin-select-row">
            <span>Cursor style</span>
            <select
              value={settings.ui.cursorStyle}
              onChange={(event) => actions.setUi({ cursorStyle: event.target.value })}
            >
              <option value="reticle">Reticle</option>
              <option value="dot">Dot and ring</option>
              <option value="halo">Halo on the system cursor</option>
            </select>
          </label>
          <SliderField
            label="Cursor size"
            value={settings.ui.cursorScale}
            defaultValue={1}
            min={0.5}
            max={2.5}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(value) => actions.setUi({ cursorScale: value })}
          />
          <ColorField
            label="Cursor colour"
            value={settings.ui.cursorColor || settings.ui.accent || "#6fe3ff"}
            defaultValue="#6fe3ff"
            onChange={(value) => actions.setUi({ cursorColor: value })}
          />
          {settings.ui.cursorColor && (
            <button
              type="button"
              className="admin-wide-btn"
              onClick={() => actions.setUi({ cursorColor: null })}
            >
              Follow the accent colour
            </button>
          )}
        </>
      )}
    </PanelGroup>
  );
}
