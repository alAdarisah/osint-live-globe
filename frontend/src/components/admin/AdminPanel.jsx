// Admin Mode: everything that used to require editing source.
//
// One draggable panel, folded into the same accordion sections the control
// panel uses, and rendered *only* while Admin Mode is on -- which is the whole
// safety model. There is no editable control anywhere else in the app, so a
// reader who has not deliberately turned Admin Mode on cannot change an icon
// size or a record by any sequence of clicks.
//
// What each section owns:
//   Icons    the global size multiplier and every marker colour
//   Layers   per-layer size, opacity and zoom gate
//   Data     the records themselves (see DataEditor.jsx)
//   Display  panel opacity, accent, text size, motion, leader lines
//   Config   export / import / reset, and the panel layout
//
// Every change is live and saved as it is made -- there is no Apply button,
// because a settings panel with unsaved state is a settings panel that loses
// work when it is closed.

import { useRef, useState } from "react";
import { PALETTE_GROUPS, DEFAULT_COLORS } from "../../map/iconTheme";
import { SETTINGS_LAYERS, defaultSettings } from "../../settings/defaults";
import { useAccordion } from "../../hooks/useAccordion";
import { useDraggablePanel, clearAllPanelPositions } from "../../hooks/useDraggablePanel";
import { PanelGroup } from "../controlPanel/Collapsible";
import { SliderField, ColorField, CheckField } from "./fields";
import DataEditor from "./DataEditor";

const DEFAULT_OPEN = { "adm-icons": true };
const STORAGE_KEY = "osint-admin-accordion";
const DEFAULTS = defaultSettings();

export default function AdminPanel({ settings, actions, sources, sync, onClose }) {
  const { isOpen, setOpen } = useAccordion(DEFAULT_OPEN, STORAGE_KEY);
  const { panelRef, style, handleProps } = useDraggablePanel("adminPanel");

  return (
    <aside id="adminPanel" ref={panelRef} style={style}>
      <div {...handleProps} className={`admin-header ${handleProps.className || ""}`}>
        <span className="admin-badge">ADMIN</span>
        <span className="admin-title">Configuration</span>
        <SyncBadge sync={sync} />
        <button type="button" className="admin-close" onClick={onClose} aria-label="Leave Admin Mode">
          &times;
        </button>
      </div>

      <div className="admin-body">
        <PanelGroup id="adm-icons" title="Map icons" open={isOpen("adm-icons")} onToggle={setOpen}>
          <SliderField
            label="Icon size"
            value={settings.icons.scale}
            defaultValue={1}
            min={0.4}
            max={3}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={actions.setIconScale}
          />
          <div className="admin-note">
            Scales every marker, and the spacing the declutter pass reserves for it, so pins stay
            separated at any size.
          </div>

          {PALETTE_GROUPS.map((group) => (
            <div className="admin-color-group" key={group.id}>
              <div className="admin-subhead">{group.label}</div>
              {group.note && <div className="admin-note">{group.note}</div>}
              {group.tokens.map((token) => (
                <ColorField
                  key={token.id}
                  label={token.label}
                  value={settings.icons.colors[token.id] || DEFAULT_COLORS[token.id]}
                  defaultValue={DEFAULT_COLORS[token.id]}
                  onChange={(value) => actions.setColor(token.id, value)}
                />
              ))}
            </div>
          ))}
          <button type="button" className="admin-wide-btn" onClick={actions.resetColors}>
            Reset all colours
          </button>
        </PanelGroup>

        <PanelGroup id="adm-layers" title="Layer appearance" open={isOpen("adm-layers")} onToggle={setOpen}>
          <div className="admin-note">
            Per layer, on top of the global icon size. The zoom gate is the zoom level a layer starts
            drawing at -- lowering it puts more on screen at world view, which is what the gates exist
            to prevent, so it is worth checking the map after moving one.
          </div>
          {SETTINGS_LAYERS.map((layer) => {
            const layerStyle = settings.layers[layer.key];
            return (
              <div className="admin-layer-block" key={layer.key}>
                <div className="admin-subhead">{layer.label}</div>
                <SliderField
                  label="Size"
                  value={layerStyle.scale}
                  defaultValue={1}
                  min={0.3}
                  max={3}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(value) => actions.setLayerStyle(layer.key, { scale: value })}
                />
                <SliderField
                  label="Opacity"
                  value={layerStyle.opacity}
                  defaultValue={1}
                  min={0.1}
                  max={1}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(value) => actions.setLayerStyle(layer.key, { opacity: value })}
                />
                {layer.zoomGate != null && (
                  <SliderField
                    label="Shows from zoom"
                    value={layerStyle.minZoom ?? layer.zoomGate}
                    defaultValue={layer.zoomGate}
                    min={0}
                    max={12}
                    step={1}
                    format={(v) => `z${v}`}
                    onChange={(value) =>
                      actions.setLayerStyle(layer.key, { minZoom: value === layer.zoomGate ? null : value })
                    }
                  />
                )}
              </div>
            );
          })}
        </PanelGroup>

        <PanelGroup id="adm-data" title="OSINT data" open={isOpen("adm-data")} onToggle={setOpen}>
          <DataEditor sources={sources} settings={settings} actions={actions} />
          <button type="button" className="admin-wide-btn" onClick={actions.clearDataEdits}>
            Discard every data edit
          </button>
        </PanelGroup>

        <PanelGroup id="adm-ui" title="Interface" open={isOpen("adm-ui")} onToggle={setOpen}>
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
        </PanelGroup>

        <PanelGroup id="adm-config" title="Configuration file" open={isOpen("adm-config")} onToggle={setOpen}>
          <ConfigSection actions={actions} sync={sync} />
        </PanelGroup>
      </div>
    </aside>
  );
}

// Where the configuration currently stands, in the header so it is visible from
// every section rather than only from the one that talks about files.
function SyncBadge({ sync }) {
  if (!sync) return null;
  const label = {
    loading: "reading config…",
    saving: "saving…",
    saved: "saved",
    "local-only": "this browser only",
    error: "not saved",
  }[sync.state] || sync.state;
  const title = {
    "local-only": `The backend did not answer, so this configuration is stored in this browser only${
      sync.detail ? ` (${sync.detail})` : ""
    }.`,
    error: sync.detail || "The last save failed.",
    saved: sync.savedAt
      ? `data/admin_config.json, last written ${new Date(sync.savedAt * 1000).toLocaleString()}`
      : "Stored in data/admin_config.json",
  }[sync.state];
  return (
    <span className={`admin-sync admin-sync-${sync.state}`} title={title}>
      {label}
    </span>
  );
}

// Export/import, for moving a configuration between deployments. Everyday
// saving is automatic and goes to data/admin_config.json (see
// hooks/useAppSettings.js) -- these two buttons are the manual copy, not the
// primary path.
function ConfigSection({ actions, sync }) {
  const fileRef = useRef(null);
  const [message, setMessage] = useState(null);

  function download() {
    const blob = new Blob([actions.exportSettings()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `osint-config-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage("Saved to your downloads.");
  }

  async function onFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const error = actions.importSettings(await file.text());
    setMessage(error || `Loaded ${file.name}.`);
    // Clearing the input is what lets the same file be re-imported after an
    // edit -- an unchanged value fires no change event.
    event.target.value = "";
  }

  return (
    <>
      <div className="admin-note">
        {sync?.state === "local-only" ? (
          <>
            The backend is not answering, so changes are being kept in this browser only. They will be
            written to <code>data/admin_config.json</code> as soon as it is back and something changes.
          </>
        ) : (
          <>
            Changes save themselves to <code>data/admin_config.json</code> in the project folder, and
            every client reads that file at startup &mdash; so what you set here is what the map shows
            from now on, in every browser this backend serves.
            {sync?.savedAt && ` Last written ${new Date(sync.savedAt * 1000).toLocaleString()}.`}
          </>
        )}
      </div>
      <div className="admin-row">
        <button type="button" onClick={download}>Export a copy</button>
        <button type="button" onClick={() => fileRef.current?.click()}>Import a file</button>
        <input type="file" accept="application/json,.json" ref={fileRef} onChange={onFile} hidden />
      </div>
      <button
        type="button"
        className="admin-wide-btn"
        onClick={() => {
          clearAllPanelPositions();
          setMessage("Panels moved back to their default corners.");
        }}
      >
        Reset panel layout
      </button>
      <button
        type="button"
        className="admin-wide-btn danger"
        onClick={() => {
          actions.resetAll();
          setMessage("Everything is back to the shipped defaults.");
        }}
      >
        Reset all settings
      </button>
      {message && <div className="admin-note">{message}</div>}
      <div className="admin-note">
        A configuration holds icon colours and sizes, layer appearance, interface settings and every
        data edit. It does not hold whether Admin Mode is on, so loading someone else's cannot put a
        reader into an editing mode.
      </div>
    </>
  );
}
