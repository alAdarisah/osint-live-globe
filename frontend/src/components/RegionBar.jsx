// A single backend registry (/api/regions) drives this bar -- selecting a
// region both moves the camera and shrinks what gets fetched (see
// useOsintData.js's selectRegion and backend/regions.py's ?region= filter).
// Conflict zones are listed behind a single trigger button rather than as
// an always-expanded row, ranked hottest-first by regionActivity (computed
// in App.jsx from the current ACLED/GDELT data) so the busiest zone is
// always at the top instead of a fixed/alphabetical order.
import { useEffect, useRef, useState } from "react";

export default function RegionBar({ regions, currentRegionKey, onSelect, regionActivity }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const entries = Object.entries(regions);
  if (!entries.length) return <nav id="regionBar" aria-label="Region quick-navigation" />;

  const worldEntry = entries.find(([key]) => key === "world");
  const conflictEntries = entries
    .filter(([key]) => key !== "world")
    .sort(([keyA], [keyB]) => (regionActivity?.[keyB] || 0) - (regionActivity?.[keyA] || 0));

  const activeConflictEntry = conflictEntries.find(([key]) => key === currentRegionKey);

  function handleSelect(key) {
    onSelect(key);
    setOpen(false);
  }

  return (
    <nav id="regionBar" aria-label="Region quick-navigation" ref={rootRef}>
      {worldEntry && (
        <button
          type="button"
          className={`region-btn${currentRegionKey === null ? " active" : ""}`}
          onClick={() => handleSelect("world")}
        >
          {worldEntry[1].label}
        </button>
      )}
      <span className="region-sep" />
      <div className="region-zone-picker">
        <button
          type="button"
          className={`region-btn conflict${activeConflictEntry ? " active" : ""}`}
          onClick={() => setOpen((o) => !o)}
        >
          {activeConflictEntry ? activeConflictEntry[1].label : "Choose Conflict Zone"} &#9662;
        </button>
        {open && (
          <div className="region-zone-menu">
            {conflictEntries.map(([key, entry]) => (
              <button
                key={key}
                type="button"
                className={`region-zone-menu-item${key === currentRegionKey ? " active" : ""}`}
                onClick={() => handleSelect(key)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}
