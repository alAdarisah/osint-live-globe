// Export/import, for moving a configuration between deployments. Everyday
// saving is automatic and goes to data/admin_config.json (see
// hooks/useAppSettings.js) -- these two buttons are the manual copy, not the
// primary path.
import { useRef, useState } from "react";
import { PanelGroup } from "../../controlPanel/Collapsible";
import { clearAllPanelPositions } from "../../../hooks/useDraggablePanel";

export const SEARCH_TERMS = [
  "Configuration file",
  "Export a copy",
  "Import a file",
  "Reset panel layout",
  "Reset all settings",
];

export default function ConfigSection({ actions, sync, isOpen, onToggle }) {
  const fileRef = useRef(null);
  // Local, not lifted to AdminPanel -- which does mean it is lost if the
  // search box filters this section out and back (AdminPanel unmounts a
  // non-matching section rather than CSS-hiding it, so this state does not
  // survive that round trip). Left that way on purpose: it is a toast
  // ("Saved to your downloads.", "Loaded config.json.") confirming an action
  // just taken in *this* fold, not a setting -- nothing reads it back, and
  // the search box is not where anyone leaves a config file half-imported
  // and comes back later. Lifting it to survive a filter round trip would
  // cost every other section a prop for a message only this one shows.
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
    <PanelGroup id="adm-config" title="Configuration file" open={isOpen("adm-config")} onToggle={onToggle}>
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
        A configuration holds icon colours and sizes, layer appearance, interface settings, every data
        edit and every redrawn boundary. It does not hold whether Admin Mode is on, so loading someone
        else's cannot put a reader into an editing mode.
      </div>
    </PanelGroup>
  );
}
