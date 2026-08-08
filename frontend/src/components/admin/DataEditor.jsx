// Editing the OSINT records themselves.
//
// Every feed that is a list of records with a stable identity (see
// EDITABLE_SOURCES), which is most of them. An edit reaches every reader of that
// feed at once -- the map, the news ticker, the notable-activity board, the
// country cards -- because they all read the same arrays and applyOverrides sits
// between the fetch and all of them.
//
// Nothing is written back to the server, and nothing pretends otherwise: an
// edit is a local override stored with the rest of the configuration (see
// settings/applyOverrides.js), applied to each poll as it arrives, and every
// pin it touches says so in its popup. That is the only honest way to let a map
// whose whole argument is provenance be edited by hand.
//
// The records come from the map controller rather than from React state, which
// is what let this grow past the original three feeds -- see recordsFor in
// createMapController.js. Some of these lists are very long (48,000 airfields,
// 24,000 AIS gaps), so the list is search-first: MAX_ROWS at a time, and the
// count below says how much is not being shown.

import { useMemo, useState } from "react";
import { EDITABLE_SOURCES, EDITABLE_FIELDS, UNEDITABLE_SOURCES } from "../../settings/defaults";
import { HIDDEN_FLAG } from "../../settings/applyOverrides";

const MAX_ROWS = 40;

function labelFor(record, source) {
  const raw = (record[source.titleField] || "").toString().trim();
  if (raw) return raw.length > 70 ? `${raw.slice(0, 70)}…` : raw;
  return `${source.label} ${record[source.idField]}`;
}

export default function DataEditor({ recordsFor, settings, actions }) {
  const [sourceKey, setSourceKey] = useState(EDITABLE_SOURCES[0].key);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState(null);

  const source = EDITABLE_SOURCES.find((s) => s.key === sourceKey);
  const records = recordsFor(sourceKey);
  const edits = settings.data[sourceKey]?.edits || {};

  // `matched` before `rows` because the note below needs to say how many were
  // left out, and "40 of 48,000" reads very differently from "40" -- without it
  // a search that found nothing useful is indistinguishable from a feed that
  // has nothing in it.
  const { rows, matched } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const hits = needle
      ? records.filter((r) => labelFor(r, source).toLowerCase().includes(needle)
          || String(r[source.idField]).toLowerCase().includes(needle))
      : records;
    return { rows: hits.slice(0, MAX_ROWS), matched: hits.length };
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
        {records.length.toLocaleString()} loaded · {editedCount} edited · {addedCount} added locally.
        {matched > rows.length && ` Showing the first ${rows.length} of ${matched.toLocaleString()} matches — narrow the filter to reach the rest.`}
        {" "}Edits are stored in this browser and re-applied to every poll; the source feed is never changed.
      </div>

      {rows.length === 0 && (
        <div className="admin-note">
          {records.length === 0
            ? "Nothing loaded for this feed yet. Several of these are only fetched once the map is"
              + " zoomed in far enough to draw them — see the zoom gate in Layer appearance."
            : "No records match."}
        </div>
      )}

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
      <UneditableNote />
    </div>
  );
}

/**
 * The feeds that are not in the dropdown, and why.
 *
 * "Why can I not edit the ships" is a reasonable question with a real answer,
 * and the answer belongs where it is asked rather than in a source file. Folded
 * shut because it is read once.
 */
function UneditableNote() {
  const [open, setOpen] = useState(false);
  return (
    <details className="admin-uneditable" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Why some layers are not listed</summary>
      {UNEDITABLE_SOURCES.map((entry) => (
        <div className="admin-note" key={entry.label}>
          <b>{entry.label}.</b> {entry.reason}
        </div>
      ))}
    </details>
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
            // A record with no date is filtered out by the map's own age gate,
            // so a hand-added one on a dated feed gets today rather than
            // vanishing the moment it is added. Driven off the field table
            // rather than off a list of feed names, so a feed that gains a date
            // field is covered without anyone remembering to come back here.
            if (fields.some((f) => f.name === "date") && !record.date) {
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
