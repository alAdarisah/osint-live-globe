// The records themselves -- see DataEditor.jsx for the per-source editor this
// wraps.
import { PanelGroup } from "../../controlPanel/Collapsible";
import DataEditor from "../DataEditor";

export const SEARCH_TERMS = ["OSINT data", "Discard every data edit"];

export default function DataSection({ settings, actions, recordsFor, isOpen, onToggle }) {
  return (
    <PanelGroup id="adm-data" title="OSINT data" open={isOpen("adm-data")} onToggle={onToggle}>
      <DataEditor recordsFor={recordsFor} settings={settings} actions={actions} />
      <button type="button" className="admin-wide-btn" onClick={actions.clearDataEdits}>
        Discard every data edit
      </button>
    </PanelGroup>
  );
}
