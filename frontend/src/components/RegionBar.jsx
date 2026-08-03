// A single backend registry (/api/regions) drives this bar -- selecting a
// region both moves the camera and shrinks what gets fetched (see
// useOsintData.js's selectRegion and backend/regions.py's ?region= filter).
export default function RegionBar({ regions, currentRegionKey, onSelect }) {
  const entries = Object.entries(regions);
  if (!entries.length) return <nav id="regionBar" aria-label="Region quick-navigation" />;

  let sepInserted = false;

  return (
    <nav id="regionBar" aria-label="Region quick-navigation">
      {entries.map(([key, entry]) => {
        const needsSep = entry.group === "conflict" && !sepInserted;
        if (needsSep) sepInserted = true;
        const isActive = key === "world" ? currentRegionKey === null : currentRegionKey === key;
        return (
          <FragmentWithSep key={key} withSep={needsSep}>
            <button
              type="button"
              className={`region-btn${entry.group === "conflict" ? " conflict" : ""}${isActive ? " active" : ""}`}
              onClick={() => onSelect(key)}
            >
              {entry.label}
            </button>
          </FragmentWithSep>
        );
      })}
    </nav>
  );
}

function FragmentWithSep({ withSep, children }) {
  return (
    <>
      {withSep && <span className="region-sep" />}
      {children}
    </>
  );
}
