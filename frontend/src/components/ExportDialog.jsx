// Task 43: viewport export. Reads its data from mapApi.exportLayerRecords
// (createMapController.js -- extends the existing controller API rather than
// this component reaching into the controller's internals, the same
// contract every other mapApi.* accessor already follows) and mapApi.
// layerState.on for which layers are currently drawn. Everything that
// composes a string a reader sees lives in ../map/exportBuilder.js, a plain
// JS sibling module this project's headless test suite can import under
// `node --test` -- see that file's own header note and
// frontend/tests/export.test.js for why, matching the split
// sanctionsBoardLogic.js/SanctionsBoard.jsx already establishes.
import { useEffect, useMemo, useState } from "react";
import {
  EXPORT_LAYERS, buildExportAnalysis, buildExportRows, buildGeoJSON, buildCSV,
  estimateExportBytes, exceedsWarningThreshold, sizeWarningMessage, layerStatusReason,
  layerCountLabel, exportSummaryLine, downloadButtonLabel,
} from "../map/exportBuilder";

// Recomputed while the dialog is open, on the same cadence
// CountryCompareView.jsx uses for its own live re-pull -- short enough that a
// poll landing while the dialog is open shows up without a close/reopen,
// long enough not to be visible busywork on what is, underneath, a handful
// of array filters over data already in memory.
const REFRESH_INTERVAL_MS = 5000;

function LayerRow({ layer, checked, onToggle }) {
  return (
    <label className="export-layer-row" title={layerStatusReason(layer.status)}>
      <input type="checkbox" checked={checked} onChange={(e) => onToggle(layer.key, e.target.checked)} />
      <span className="export-layer-label">{layer.label}</span>
      <span className={`export-layer-count export-layer-status-${layer.status}`}>{layerCountLabel(layer)}</span>
    </label>
  );
}

/**
 * @param {object} mapApi        useLeafletMap's returned handle -- reads
 *   mapApi.exportLayerRecords, mapApi.layerState.on, mapApi.mapBounds.
 * @param {object} health        the whole /api/health body (useHealth), for
 *   the DOWN/EMPTY distinction -- see exportBuilder.js's classifyLayerStatus.
 * @param {() => void} onClose
 */
export default function ExportDialog({ mapApi, health, onClose }) {
  const [format, setFormat] = useState("geojson");
  const [selected, setSelected] = useState(() => new Set(
    EXPORT_LAYERS.filter((l) => mapApi.layerState.on?.[l.key]).map((l) => l.key)
  ));
  const [confirmedLarge, setConfirmedLarge] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const id = setInterval(() => setRefreshTick((n) => n + 1), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const analysis = useMemo(
    () => buildExportAnalysis({
      selectedKeys: selected,
      mapOn: mapApi.layerState.on,
      health,
      recordsFor: mapApi.exportLayerRecords,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, mapApi.layerState.on, health, mapApi.exportLayerRecords, refreshTick]
  );

  const rows = useMemo(() => buildExportRows(analysis), [analysis]);

  const generatedAt = useMemo(() => new Date().toISOString(), [refreshTick]);
  const viewport = mapApi.mapBounds;

  const built = useMemo(() => {
    if (format === "csv") {
      return buildCSV(rows, { generatedAt, viewport, analysis });
    }
    return JSON.stringify(buildGeoJSON(rows, { generatedAt, viewport, analysis }), null, 2);
  }, [format, rows, generatedAt, viewport, analysis]);

  const byteSize = useMemo(() => estimateExportBytes(built), [built]);
  const isLarge = exceedsWarningThreshold(rows.length, byteSize);
  const nothingSelected = selected.size === 0;

  function toggleLayer(key, checked) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
    setConfirmedLarge(false);
  }

  function download() {
    if (nothingSelected) return;
    if (isLarge && !confirmedLarge) {
      setConfirmedLarge(true);
      return;
    }
    const isCsv = format === "csv";
    // A UTF-8 BOM is added here, at Blob-creation time, only for CSV -- not
    // inside buildCSV itself (which stays a plain, easily-asserted string for
    // export.test.js) and never for GeoJSON (a strict JSON parser is not
    // guaranteed to tolerate a leading BOM, and GeoJSON's own consumers here
    // are JS/GIS tools that are already UTF-8-native). The tradeoff: Excel
    // silently mis-decodes this dataset's non-ASCII place names without a
    // BOM, which is exactly the kind of silent corruption this task exists
    // to prevent, whereas the cost of including one is a handful of stricter
    // non-Excel tools needing `utf-8-sig`/an explicit BOM-aware read -- a far
    // smaller failure than a reader's spreadsheet quietly mangling place
    // names it can no longer tell were ever wrong.
    const UTF8_BOM = String.fromCharCode(0xfeff);
    const text = isCsv ? UTF8_BOM + built : built;
    const blob = new Blob([text], { type: isCsv ? "text/csv;charset=utf-8" : "application/geo+json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `osint-export-${generatedAt.replace(/[:.]/g, "-")}.${isCsv ? "csv" : "geojson"}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="export-backdrop" onClick={onClose}>
      <aside id="exportDialog" role="dialog" aria-label="Export what is on screen" onClick={(e) => e.stopPropagation()}>
        <div className="export-header">
          <span className="export-title">EXPORT VIEWPORT</span>
          <button type="button" className="export-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="export-body">
          <p className="export-note">
            Every row in this file carries its own source, publisher, licence and evidence type (measured / reported
            / derived / inferred) -- see the file's own leading lines (CSV) or its <code>provenance</code> field
            (GeoJSON). A layer left out below is either switched off on the map, its feed has not loaded, or you have
            unchecked it -- each row here says which.
          </p>
          <div className="export-format-row">
            <label>
              <input type="radio" name="export-format" checked={format === "geojson"}
                onChange={() => { setFormat("geojson"); setConfirmedLarge(false); }} />
              GeoJSON
            </label>
            <label>
              <input type="radio" name="export-format" checked={format === "csv"}
                onChange={() => { setFormat("csv"); setConfirmedLarge(false); }} />
              CSV
            </label>
          </div>
          <div className="export-layer-list">
            {analysis.map((layer) => (
              <LayerRow key={layer.key} layer={layer} checked={selected.has(layer.key)} onToggle={toggleLayer} />
            ))}
          </div>
          <p className="export-scope-note">
            Point layers only -- shipping lanes, cables, railways, power lines, water bodies and administrative
            boundaries are line/polygon geometry this export does not yet cover.
          </p>
          {nothingSelected && (
            <p className="export-warning">Select at least one layer to export.</p>
          )}
          {!nothingSelected && isLarge && (
            <p className="export-warning">{sizeWarningMessage(rows.length, byteSize)}</p>
          )}
          <div className="export-actions">
            <span className="export-summary">{exportSummaryLine(rows.length, byteSize)}</span>
            <button type="button" className="export-download" disabled={nothingSelected} onClick={download}>
              {downloadButtonLabel({ isLarge, confirmedLarge, nothingSelected })}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
