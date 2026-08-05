// Editing the OSINT records themselves.
//
// Scoped to the three feeds the app holds in React state (see EDITABLE_SOURCES)
// -- they are the ones every panel reads, so an edit here is an edit
// everywhere, not just on the map.
//
// Nothing is written back to the server, and nothing pretends otherwise: an
// edit is a local override stored with the rest of the configuration (see
// settings/applyOverrides.js), applied to each poll as it arrives, and every
// pin it touches says so in its popup. That is the only honest way to let a map
// whose whole argument is provenance be edited by hand.

import { useMemo, useState } from "react";
import { EDITABLE_SOURCES, EDITABLE_FIELDS } from "../../settings/defaults";
import { HIDDEN_FLAG } from "../../settings/applyOverrides";

const MAX_ROWS = 40;

function labelFor(record, source) {
  const raw = (record[source.titleField] || "").toString().trim();
  if (raw) return raw.length > 70 ? `${raw.slice(0, 70)}…` : raw;
  return `${source.label} ${record[source.idField]}`;
}

export default function DataEditor({ sources, settings, actions }) {
  const [sourceKey, setSourceKey] = useState(EDITABLE_SOURCES[0].key);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState(null);

  const source = EDITABLE_SOURCES.find((s) => s.key === sourceKey);
  const records = sources[sourceKey] || [];
  const edits = settings.data[sourceKey]?.edits || {};

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? records.filter((r) => labelFor(r, source).toLowerCase().includes(needle)
          || String(r[source.idField]).toLowerCase().includes(needle))
      : records;
    return matched.slice(0, MAX_ROWS);
  }, [records, query, source]);

  // Hidden records are gone from `records` by the time this component sees them
  // (applyOverrides drops them upstream), so the only way back is a list built
  // from the edits themselves.
  const hiddenIds = Object.entries(edits)
    .filter(([, patch]) => patch?.[HIDDEN_FLAG])
    .map(([id]) => id);

  const editedCount = Object.keys(edits).length;
  const addedCount = settings.data[sourceKey]?.added.length || 0;

  return (
    <div className="admin-data-editor">
      <div className="admin-row">
        <select value={sourceKey} onChange={(e) => { setSourceKey(e.target.value); setOpenId(null); }}>
          {EDITABLE_SOURCES.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Filter records..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="admin-note">
        {records.length} loaded · {editedCount} edited · {addedCount} added locally.
        Edits are stored in this browser and re-applied to every poll; the source feed is never changed.
      </div>

      {rows.length === 0 && <div className="admin-note">No records match.</div>}

      <div className="admin-record-list">
        {rows.map((record) => {
          const id = record[source.idField];
          const isOpen = openId === id;
          const patch = edits[id];
          return (
            <div className={`admin-record${patch ? " edited" : ""}`} key={id}>
              <button
                type="button"
                className="admin-record-head"
                onClick={() => setOpenId(isOpen ? null : id)}
                aria-expanded={isOpen}
              >
                <span className="admin-record-title">{labelFor(record, source)}</span>
                {record.__added && <span className="admin-tag">added</span>}
                {patch && !record.__added && <span className="admin-tag">edited</span>}
              </button>

              {isOpen && (
                <div className="admin-record-body">
                  {EDITABLE_FIELDS[sourceKey].map((field) => (
                    <label className="admin-field" key={field.name}>
                      <span className="admin-field-label">{field.label}</span>
                      <input
                        type={field.type}
                        step={field.step}
                        min={field.min}
                        max={field.max}
                        value={record[field.name] ?? ""}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const value = field.type === "number"
                            ? (raw === "" ? null : Number(raw))
                            : raw;
                          actions.editRecord(sourceKey, id, { [field.name]: value });
                        }}
                      />
                    </label>
                  ))}
                  <div className="admin-row">
                    <button
                      type="button"
                      onClick={() => actions.editRecord(sourceKey, id, { [HIDDEN_FLAG]: true })}
                    >
                      Hide from map
                    </button>
                    {record.__added ? (
                      <button type="button" onClick={() => actions.removeAddedRecord(sourceKey, id)}>
                        Delete record
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={!patch}
                        onClick={() => actions.revertRecord(sourceKey, id)}
                      >
                        Revert to source
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {hiddenIds.length > 0 && (
        <div className="admin-hidden-list">
          <div className="admin-note">{hiddenIds.length} hidden</div>
          {hiddenIds.map((id) => (
            <div className="admin-row" key={id}>
              <span className="admin-hidden-id">{id}</span>
              <button type="button" onClick={() => actions.revertRecord(sourceKey, id)}>Unhide</button>
            </div>
          ))}
        </div>
      )}

      <AddRecordForm sourceKey={sourceKey} actions={actions} />
    </div>
  );
}

// Adding a record is the same override mechanism from the other end: the new
// item is stored in the config, merged into the feed on arrival, and flagged
// `__added` so its popup states that it did not come from a source.
function AddRecordForm({ sourceKey, actions }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({});
  const source = EDITABLE_SOURCES.find((s) => s.key === sourceKey);
  const fields = EDITABLE_FIELDS[sourceKey];

  if (!open) {
    return (
      <button type="button" className="admin-add-btn" onClick={() => setOpen(true)}>
        + Add a record
      </button>
    );
  }

  const latOk = Number.isFinite(Number(draft.lat));
  const lonOk = Number.isFinite(Number(draft.lon));

  return (
    <div className="admin-add-form">
      {fields.map((field) => (
        <label className="admin-field" key={field.name}>
          <span className="admin-field-label">{field.label}</span>
          <input
            type={field.type}
            step={field.step}
            value={draft[field.name] ?? ""}
            onChange={(e) => setDraft((prev) => ({ ...prev, [field.name]: e.target.value }))}
          />
        </label>
      ))}
      <div className="admin-row">
        <button
          type="button"
          disabled={!latOk || !lonOk}
          title={!latOk || !lonOk ? "A record needs coordinates to be drawn" : undefined}
          onClick={() => {
            const record = { [source.idField]: `local-${Date.now()}` };
            for (const field of fields) {
              const value = draft[field.name];
              if (value === undefined || value === "") continue;
              record[field.name] = field.type === "number" ? Number(value) : value;
            }
            // Both feeds date their items, and an undated record is filtered out
            // by the map's own age gate -- so a hand-added one gets today.
            if (sourceKey === "events" && !record.date) {
              record.date = new Date().toISOString().slice(0, 10);
            }
            actions.addRecord(sourceKey, record);
            setDraft({});
            setOpen(false);
          }}
        >
          Add
        </button>
        <button type="button" onClick={() => { setDraft({}); setOpen(false); }}>Cancel</button>
      </div>
    </div>
  );
}
