// Task 43: viewport export -- turning what is currently on screen into a
// GeoJSON or CSV file a reader can keep, without leaving the provenance
// behind. Plain JS, no window/Leaflet/JSX dependency, for the same reason
// every other *Logic.js module in this codebase is: this file is imported by
// frontend/tests/export.test.js under plain `node --test` (no build step, no
// DOM), and ExportDialog.jsx is the thin, untested-by-necessity presentation
// layer around it -- see e.g. sanctionsBoardLogic.js/SanctionsBoard.jsx for
// the identical split, and this project's own review discipline ("no
// user-visible string composed inline in JSX") for why.
//
// The brief's own sentence is the spec this file exists to satisfy: "The
// header is the point -- an export without provenance is the exact failure
// this project's caveats exist to prevent." Two consequences follow from
// that, and both are load-bearing design decisions here rather than
// afterthoughts:
//
// 1. The provenance header is *computed from the rows actually being
//    exported*, never from the static registry below or from which layers
//    the reader happened to tick. computeProvenanceHeader walks the rows and
//    asks each one what layer it came from -- so a future layer added to
//    EXPORT_LAYERS (or a bug that lets a row through with the wrong layer
//    key) cannot silently ship without a provenance line the way a
//    hand-written "these are the sources in this file" list could.
//
// 2. Per-row travel, not only a file-level banner. A CSV row copied out of
//    this file into another spreadsheet takes the file's header with it not
//    at all -- so every row carries its own export_layer/export_provenance/
//    export_source/export_publisher/export_licence columns, denormalised.
//    That is deliberate and stated, not an oversight: see buildCSV's own
//    note on why a leading comment block alone would not be enough.
//
// **Scope**: only layers whose records already carry the map's own uniform
// point shape -- a numeric `.lat`/`.lon` directly on the item, the same
// contract createMapController.js's renderMarkerLayer relies on (see its own
// `typeof item.lat !== "number"` guard). Line and polygon layers (shipping
// lanes, cables, railways, power lines, water bodies, country/admin
// boundaries) are out of scope for this task -- exporting them honestly would
// mean GeoJSON LineString/Polygon geometry and a CSV shape (WKT? one row per
// vertex?) this task's brief does not ask for, and inventing one under time
// pressure risks the exact silent-corruption failure this whole feature
// exists to prevent. Left out, not hidden: ExportDialog.jsx says so.

// ---------------------------------------------------------------------------
// The four-word vocabulary, exactly as this project's own rule states it
// (measured / reported / derived / inferred) -- see global-constraints.md.
// ---------------------------------------------------------------------------
export const MEASURED = "measured";
export const REPORTED = "reported";
export const DERIVED = "derived";
export const INFERRED = "inferred";

const NOT_STATED = "not stated in the source";

/**
 * One entry per exportable layer. Every `source` field below was read out of
 * the codebase, not typed from memory -- see the comment on each entry for
 * exactly where. `licence: null` means the licence genuinely is not stated
 * anywhere in this codebase for that source; per this task's own brief
 * ("if it is not there for some layer, say so in your report rather than
 * inventing one"), that shows up in the export as NOT_STATED rather than a
 * guess.
 *
 * `healthKey` is the /api/health key this layer's freshness is tracked
 * under -- reused from frontend/src/components/controlPanel/layerHealthKeys.js
 * rather than re-derived, so this module's idea of "is this feed down" can
 * never drift from the control panel's own freshness badge. null where that
 * table has no entry (a layer with no background poller of its own).
 */
export const EXPORT_LAYERS = [
  {
    key: "events",
    label: "Conflict events (ACLED/UCDP fusion)",
    // backend/refine or backend/sources/event_fusion.py stamps each fused
    // record's own "source" field ("acled" or "ucdp") -- read per-row in
    // buildExportRow rather than fixed here, since it varies row to row.
    // Both are incident reports compiled by a monitoring organisation, not an
    // instrument reading and not arithmetic -- REPORTED.
    provenance: REPORTED,
    // Attribution.jsx lists "ACLED" among this app's cited sources; UCDP is
    // the fused record's other named input (see backend/sources/acled.py's
    // own "ucdp" source tag). Neither module states a licence.
    source: { name: "ACLED / UCDP", publisher: null, licence: null, url: null },
    healthKey: "events",
  },
  {
    key: "gdelt",
    label: "News coverage (GDELT)",
    provenance: REPORTED,
    // Attribution.jsx: "GDELT Project". No licence stated in backend/sources/gdelt.py.
    source: { name: "GDELT Project", publisher: null, licence: null, url: null },
    healthKey: "gdelt",
  },
  {
    key: "officials",
    label: "Government and official statements",
    provenance: REPORTED,
    // backend/sources/officials.py's own header: every record carries its own
    // `outlet` (source_name/source_url) and `origin` (gdelt vs official_feed)
    // -- read per-row where present, same as events above. No single
    // publisher or licence applies to the whole layer.
    source: { name: null, publisher: null, licence: null, url: null },
    healthKey: "officials",
  },
  {
    key: "firms",
    label: "Active fire detections (FIRMS)",
    // backend/sources/firms.py: VIIRS/HMS satellite hotspot detections -- an
    // instrument reading, not a claim someone made. MEASURED.
    provenance: MEASURED,
    // Attribution.jsx: "NASA FIRMS". No licence stated in backend/sources/firms.py.
    source: { name: "NASA FIRMS", publisher: "NASA", licence: null, url: null },
    healthKey: "firms",
  },
  {
    key: "ais",
    label: "Ship positions (AIS)",
    // A transponder report picked up by a receiver -- MEASURED.
    provenance: MEASURED,
    // Attribution.jsx: "aisstream.io". No licence stated in backend/ingest's ais module.
    source: { name: "aisstream.io", publisher: null, licence: null, url: null },
    healthKey: "ais",
  },
  {
    key: "adsb",
    label: "Aircraft positions (ADS-B)",
    provenance: MEASURED,
    // Attribution.jsx: "OpenSky Network". No licence stated in the ingest module.
    source: { name: "OpenSky Network", publisher: null, licence: null, url: null },
    healthKey: "adsb",
  },
  {
    key: "jamming",
    label: "GPS jamming cells (gpsjam.org)",
    // backend/sources/jamming.py's own comment on the hex/lat/lon fields: the
    // H3 cell id is "reported verbatim", and this layer's position is that
    // cell's centroid, computed via h3.cell_to_latlng -- arithmetic over a
    // reported value, which this project's own vocabulary defines as DERIVED.
    // jam_ratio is likewise bad/total arithmetic over reported counts.
    provenance: DERIVED,
    source: {
      name: "gpsjam.org (derived from ADS-B Exchange GPS-quality reports)",
      publisher: null, licence: null, url: "https://gpsjam.org",
    },
    healthKey: "jamming",
  },
  {
    key: "airports",
    label: "Airfields (OurAirports)",
    provenance: REPORTED,
    // backend/sources/airports.py's own module docstring: "the OurAirports
    // open dataset, which is public domain, keyless". Note: this layer's
    // `military_name` field is itself an inference from the airfield's name
    // (that module's own words) -- a finer-grained distinction than this
    // export's per-row `inferred` check can currently see; see this task's
    // report for that stated limitation.
    source: {
      name: "OurAirports", publisher: "OurAirports", licence: "Public domain",
      url: "https://davidmegginson.github.io/ourairports-data/airports.csv",
    },
    healthKey: "airports",
  },
  {
    key: "ports",
    label: "Ports (NGA World Port Index)",
    provenance: REPORTED,
    // backend/sources/ports.py's own PUBLISHER/LICENSE constants, already
    // embedded per record -- read per-row in buildExportRow when present,
    // this is the static fallback.
    source: { name: "NGA World Port Index (Pub 150)", publisher: "NGA World Port Index (Pub 150)", licence: "US Government work, public domain", url: null },
    healthKey: "ports",
  },
  {
    key: "dams",
    label: "Dams (Global Dam Watch)",
    provenance: REPORTED,
    // backend/sources/dams.py's own PUBLISHER/LICENSE constants, embedded per record.
    source: {
      name: "Global Dam Watch (GDW v1.0)", publisher: "Global Dam Watch (GDW v1.0)",
      licence: "CC BY 4.0 (creativecommons.org/licenses/by/4.0)", url: null,
    },
    healthKey: "dams",
  },
  {
    key: "deflock",
    label: "ALPR cameras (DeFlock / OpenStreetMap)",
    provenance: REPORTED,
    // backend/sources/deflock.py sets "source"/"licence"/"source_url" on
    // every single record itself (its own module docstring: "Every record
    // carries that attribution ... so it reaches the reader"), so this is
    // read per-row almost every time; this is only the fallback.
    source: { name: "OpenStreetMap contributors (via DeFlock)", publisher: null, licence: "ODbL", url: null },
    healthKey: "deflock",
  },
  {
    key: "czib",
    label: "Airspace closures (CZIB)",
    provenance: REPORTED,
    // backend/sources/czib.py's own PUBLISHER constant, embedded per record. No licence stated.
    source: { name: "EASA Conflict Zone Information Bulletins", publisher: "EASA", licence: null, url: null },
    healthKey: "czib",
  },
];

const LAYER_META_BY_KEY = Object.fromEntries(EXPORT_LAYERS.map((l) => [l.key, l]));

/** Fallback for a row whose layer key is not (or is no longer) in
 * EXPORT_LAYERS above -- see this module's header note on why
 * computeProvenanceHeader must still be able to say *something* honest about
 * it rather than silently dropping it. */
function unknownLayerMeta(key) {
  return {
    key, label: key || "unknown layer", provenance: null,
    source: { name: null, publisher: null, licence: null, url: null }, healthKey: null,
  };
}

export function metaForLayer(key) {
  return LAYER_META_BY_KEY[key] || unknownLayerMeta(key);
}

// ---------------------------------------------------------------------------
// Per-layer status -- the four-facts-not-one ruling this task's brief states
// explicitly: a layer that is switched off, a layer that is on but has
// nothing in view, a layer whose feed is down, and a layer the reader
// excluded from the export are four different fields, not one blank.
// ---------------------------------------------------------------------------
export const LAYER_STATUS = {
  OFF: "off",           // not drawn on the map right now, and the reader has not overridden that for this export
  EXCLUDED: "excluded", // drawn on the map, but the reader unchecked it in the export dialog
  DOWN: "down",         // included, but nothing has ever loaded for this layer's feed
  EMPTY: "empty",       // included, has data, but none of it falls inside the current viewport
  INCLUDED: "included", // included, and at least one row is inside the current viewport
};

/**
 * @param {boolean} included    the reader ticked this layer's checkbox
 * @param {boolean} mapOn       the layer is currently drawn on the map (layerState.on[key])
 * @param {number} total        raw[key]'s full length, before any viewport filtering
 * @param {number} viewportCount  how many of those fall inside the current viewport
 * @param {object|null} healthEntry  health[layer.healthKey], or null if untracked/not yet loaded
 */
export function classifyLayerStatus({ included, mapOn, total, viewportCount, healthEntry }) {
  if (!included) return mapOn ? LAYER_STATUS.EXCLUDED : LAYER_STATUS.OFF;
  if (viewportCount > 0) return LAYER_STATUS.INCLUDED;
  if (total > 0) return LAYER_STATUS.EMPTY;
  // total === 0: nothing at all is currently held for this layer. That is
  // "down" unless health explicitly says the feed has succeeded before (in
  // which case the last successful poll itself returned zero rows, which is
  // a real "checked, found nothing" rather than "never checked").
  if (!healthEntry || healthEntry.last_success == null) return LAYER_STATUS.DOWN;
  return LAYER_STATUS.EMPTY;
}

export function layerStatusReason(status) {
  switch (status) {
    case LAYER_STATUS.OFF:
      return "Switched off on the map right now, so it was left unchecked here -- tick it above to include it anyway.";
    case LAYER_STATUS.EXCLUDED:
      return "On the map, but left out of this export.";
    case LAYER_STATUS.DOWN:
      return "No data has loaded for this layer -- its feed has never reported in, so there is nothing to export.";
    case LAYER_STATUS.EMPTY:
      return "Included, but nothing from this layer falls inside the current viewport.";
    case LAYER_STATUS.INCLUDED:
      return "Included.";
    default:
      return "";
  }
}

/**
 * Every candidate layer's status, given what the reader selected and what
 * the controller/health currently know. `recordsFor(key)` is
 * createMapController's exportLayerRecords -- see that method's own note for
 * why { rows, total } rather than just an array.
 *
 * @param {Set<string>} selectedKeys
 * @param {Record<string, boolean>} mapOn   layerState.on
 * @param {object} health                   the whole /api/health body
 * @param {(key: string) => {rows: object[], total: number}} recordsFor
 */
export function buildExportAnalysis({ selectedKeys, mapOn, health, recordsFor }) {
  return EXPORT_LAYERS.map((meta) => {
    const included = selectedKeys.has(meta.key);
    const { rows, total } = included ? (recordsFor(meta.key) || { rows: [], total: 0 }) : { rows: [], total: 0 };
    const healthEntry = meta.healthKey ? health?.[meta.healthKey] : null;
    const status = classifyLayerStatus({
      included, mapOn: !!mapOn?.[meta.key], total, viewportCount: rows.length, healthEntry,
    });
    return { key: meta.key, label: meta.label, status, count: rows.length, total, rows, healthEntry };
  });
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

/** Object/array values survive as JSON text rather than being dropped or
 * silently coerced to "[object Object]" -- a reader who did not ask for this
 * field still gets to see it, in a CSV cell or a GeoJSON property value. */
function flattenValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

function collectedAtFor(healthEntry, generatedAt) {
  if (healthEntry && Number.isFinite(healthEntry.last_success)) {
    return new Date(healthEntry.last_success * 1000).toISOString();
  }
  return `not tracked by this deployment's health monitor (export generated ${generatedAt})`;
}

/**
 * One raw item -> one export row: its own properties (minus lat/lon, which
 * become geometry/dedicated columns), plus the export_* provenance fields
 * every row carries denormalised -- see this module's header note on why.
 * Per-item fields win over the static registry wherever the source already
 * embeds them (source/publisher/license|licence/source_url), per this task's
 * brief: "take it from where it already lives".
 */
export function buildExportRow(item, layerKey, { generatedAt, healthEntry } = {}) {
  const meta = metaForLayer(layerKey);
  const properties = {};
  for (const [k, v] of Object.entries(item || {})) {
    if (k === "lat" || k === "lon") continue;
    properties[k] = flattenValue(v);
  }
  // Global-constraints' own rule: a record carrying an inferred value sets
  // `inferred: true`. When it does, that outranks this layer's default word
  // -- an inferred position exported next to a measured one from the same
  // layer must not read identically, which is this task's own named failure
  // case.
  const provenance = item?.inferred === true ? INFERRED : (meta.provenance || null);
  return {
    lat: item?.lat,
    lon: item?.lon,
    properties,
    export_layer_key: layerKey,
    export_layer: meta.label,
    export_provenance: provenance || NOT_STATED,
    export_source: (typeof item?.source === "string" && item.source) || meta.source.name || NOT_STATED,
    export_publisher: item?.publisher || meta.source.publisher || NOT_STATED,
    export_licence: item?.licence || item?.license || meta.source.licence || NOT_STATED,
    export_source_url: item?.source_url || meta.source.url || null,
    export_collected: collectedAtFor(healthEntry, generatedAt),
  };
}

/** `analysis` (buildExportAnalysis's output) -> the flat row list every
 * builder below consumes. Only LAYER_STATUS.INCLUDED layers contribute rows
 * -- OFF/EXCLUDED/DOWN/EMPTY layers exist in `analysis` for the header's
 * "not represented, and why" section, never as data rows. */
export function buildExportRows(analysis, { generatedAt } = {}) {
  const at = generatedAt || new Date().toISOString();
  const rows = [];
  for (const layer of analysis || []) {
    if (layer.status !== LAYER_STATUS.INCLUDED) continue;
    for (const item of layer.rows) {
      if (typeof item?.lat !== "number" || typeof item?.lon !== "number") continue;
      rows.push(buildExportRow(item, layer.key, { generatedAt: at, healthEntry: layer.healthEntry }));
    }
  }
  return rows;
}

/**
 * The provenance header's own completeness rule: walk the rows that are
 * actually in the export and name every distinct source among them, in
 * first-seen order. Never reads EXPORT_LAYERS' own key list or the reader's
 * selection -- only what is in `rows` -- so a row that somehow carries a
 * layer key this module does not recognise still gets a (fallback) entry
 * rather than disappearing from the header. See this module's header note.
 */
export function computeProvenanceHeader(rows) {
  const seen = new Map();
  for (const row of rows || []) {
    const key = row.export_layer_key;
    if (!key || seen.has(key)) continue;
    seen.set(key, {
      key,
      label: row.export_layer || key,
      provenance: row.export_provenance || NOT_STATED,
      source: row.export_source || NOT_STATED,
      publisher: row.export_publisher || NOT_STATED,
      licence: row.export_licence || NOT_STATED,
      sourceUrl: row.export_source_url || null,
      collected: row.export_collected || NOT_STATED,
    });
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// GeoJSON
// ---------------------------------------------------------------------------

export function buildGeoJSON(rows, { generatedAt, viewport, analysis } = {}) {
  const at = generatedAt || new Date().toISOString();
  const features = (rows || []).map((row) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [row.lon, row.lat] },
    properties: {
      ...row.properties,
      layer: row.export_layer_key,
      layer_label: row.export_layer,
      provenance: row.export_provenance,
      source: row.export_source,
      publisher: row.export_publisher,
      licence: row.export_licence,
      source_url: row.export_source_url,
      collected: row.export_collected,
    },
  }));
  return {
    type: "FeatureCollection",
    generated_at: at,
    viewport: viewport || null,
    // Foreign members (RFC 7946 §6.1 permits them on a FeatureCollection) --
    // the provenance header for a GeoJSON reader, computed the same way the
    // CSV's leading comment block is, from the same rows.
    provenance: computeProvenanceHeader(rows),
    layers: (analysis || []).map((l) => ({ key: l.key, label: l.label, status: l.status, count: l.count })),
    features,
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 field escaping: quote whenever the field contains a comma, a
 * double quote, or a line break, doubling any internal quote. Everything
 * else passes through unquoted -- this dataset's place names routinely carry
 * commas ("Ra's al Khaymah, UAE"-style joins), apostrophes and quotes
 * ("O'Hare", a facility nicknamed in quotes) and non-ASCII characters, and
 * this is the one function in this file standing between that and a
 * corrupted column count in whatever opens the file.
 */
export function csvField(value) {
  if (value === null || value === undefined || value === "") return "";
  const s = typeof value === "string" ? value : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvHeaderLines({ generatedAt, viewport, provenance, analysis }) {
  const lines = [];
  lines.push("# OSINT Live Globe -- viewport export");
  lines.push(`# Generated: ${generatedAt}`);
  if (viewport) {
    lines.push(
      `# Viewport at export time: south=${viewport.south}, west=${viewport.west}, `
      + `north=${viewport.north}, east=${viewport.east}`
    );
  }
  if (provenance.length === 0) {
    lines.push("# No rows in this export -- see the per-layer status lines below for why.");
  } else {
    lines.push("# Sources present in this export (also repeated on every data row below):");
    for (const p of provenance) {
      lines.push(
        `#   ${p.label} -- ${p.provenance}. Source: ${p.source}. Publisher: ${p.publisher}. `
        + `Licence: ${p.licence}. Collected: ${p.collected}.`
      );
    }
  }
  const notIncluded = (analysis || []).filter((l) => l.status !== LAYER_STATUS.INCLUDED);
  if (notIncluded.length) {
    lines.push("# Layers with no rows in this file, and why:");
    for (const l of notIncluded) {
      lines.push(`#   ${l.label} -- ${layerStatusReason(l.status)}`);
    }
  }
  lines.push(
    "# This block is a summary. Every data row below repeats its own export_layer/export_provenance/"
    + "export_source/export_publisher/export_licence columns, so the provenance survives a sort, a filter, "
    + "or a single row copied elsewhere -- see this task's own report for why a header-only banner was not enough."
  );
  return lines;
}

/**
 * `rows` (buildExportRows' output) -> a full CSV document as one string,
 * CRLF line endings per RFC 4180. No UTF-8 BOM is added here -- see
 * ExportDialog.jsx's own note on why the BOM is applied at Blob-creation
 * time instead, and this task's report for the reasoning.
 */
export function buildCSV(rows, { generatedAt, viewport, analysis } = {}) {
  const at = generatedAt || new Date().toISOString();
  const provenance = computeProvenanceHeader(rows);
  const headerLines = csvHeaderLines({ generatedAt: at, viewport, provenance, analysis });

  if (!rows || rows.length === 0) {
    return headerLines.join("\r\n") + "\r\n";
  }

  // Column set: every property key that appears on any row, first-seen
  // order -- a multi-layer export has different fields per layer, and this
  // is the union rather than the intersection, so nothing a source supplied
  // is ever silently dropped for not being on every row.
  const propertyColumns = [];
  const seenProps = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row.properties || {})) {
      if (!seenProps.has(key)) {
        seenProps.add(key);
        propertyColumns.push(key);
      }
    }
  }

  const columns = ["export_layer", "export_provenance", "lat", "lon", ...propertyColumns,
    "export_source", "export_publisher", "export_licence", "export_source_url", "export_collected"];
  const headerRow = columns.join(",");
  const dataLines = rows.map((row) => {
    const record = {
      ...row.properties,
      export_layer: row.export_layer, export_provenance: row.export_provenance,
      lat: row.lat, lon: row.lon,
      export_source: row.export_source, export_publisher: row.export_publisher,
      export_licence: row.export_licence, export_source_url: row.export_source_url,
      export_collected: row.export_collected,
    };
    return columns.map((c) => csvField(record[c])).join(",");
  });

  return [...headerLines, "", headerRow, ...dataLines].join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Size warning -- "large exports warn before running" (this task's brief)
// ---------------------------------------------------------------------------

/**
 * Row/byte thresholds for the "this export is large" warning.
 *
 * Measured, not guessed: with Postgres unreachable in this dev environment
 * (see global-constraints.md's own note on that), no live payload could be
 * pulled to measure. Instead this module's own buildCSV/buildGeoJSON were run
 * against 5,000 synthetic rows shaped like a real layer's fields (name,
 * publisher, licence, a handful of other columns -- see
 * frontend/tests/export.test.js's own "size measurement" test, which
 * re-measures this on every test run rather than trusting this comment to
 * stay true): CSV came out to ~315 bytes/row, GeoJSON (heavier -- full key
 * names repeated per feature, no columnar reuse the way a CSV header row
 * gives) ~536 bytes/row.
 *
 * Two numbers already in this codebase's own comments bound how large a
 * single layer can get in practice: airports.py's "80k+ airfields" and
 * recordsFor's own "tens of thousands of rows" note about the airfield list.
 * 20,000 combined rows is comfortably inside "one busy layer at COUNTRY
 * zoom" without being so low that an ordinary multi-layer export trips it.
 * At the measured ~536 bytes/row (GeoJSON, the heavier format), 20,000 rows
 * is ~10.2 MB -- past the byte threshold below, which is deliberate: for a
 * GeoJSON export the byte ceiling is the one that actually fires first
 * (8 MB / 536 bytes ≈ 15,650 rows), while for CSV's lighter ~315 bytes/row
 * the row ceiling fires first (20,000 rows ≈ 6.0 MB, under 8 MB). Either
 * dimension crossing its own line is enough to warn -- the two together
 * mean neither format needs its own separate threshold.
 */
export const LARGE_EXPORT_ROW_THRESHOLD = 20000;
export const LARGE_EXPORT_BYTE_THRESHOLD = 8 * 1024 * 1024; // 8 MB

export function estimateExportBytes(text) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return text.length;
}

export function exceedsWarningThreshold(rowCount, byteSize) {
  return rowCount > LARGE_EXPORT_ROW_THRESHOLD || byteSize > LARGE_EXPORT_BYTE_THRESHOLD;
}

export function sizeWarningMessage(rowCount, byteSize) {
  const mb = (byteSize / (1024 * 1024)).toFixed(1);
  return `This export is large: ${rowCount.toLocaleString()} rows, about ${mb} MB. Building and downloading it `
    + "may take a moment and use a noticeable amount of memory. Export anyway?";
}

// ---------------------------------------------------------------------------
// Dialog strings -- pulled out of ExportDialog.jsx per this project's own
// review discipline ("no user-visible string composed inline in JSX where
// `node --test` cannot reach it"). Each of these composes a dynamic value
// (a count, a byte size, a status) into text, which is exactly the case that
// rule targets -- a static label needs no function of its own and stays in
// the JSX directly.
// ---------------------------------------------------------------------------

/** The row-count/status text on one layer's own checkbox row. */
export function layerCountLabel(layer) {
  if (layer?.status === LAYER_STATUS.INCLUDED) {
    const n = layer.count || 0;
    return `${n.toLocaleString()} row${n === 1 ? "" : "s"}`;
  }
  switch (layer?.status) {
    case LAYER_STATUS.OFF: return "off";
    case LAYER_STATUS.EXCLUDED: return "excluded";
    case LAYER_STATUS.DOWN: return "feed down";
    case LAYER_STATUS.EMPTY: return "0 in view";
    default: return "";
  }
}

/** The row-count/size line above the Download button. */
export function exportSummaryLine(rowCount, byteSize) {
  const n = rowCount || 0;
  const kb = byteSize / 1024;
  const sizeText = kb > 1024 ? `${(byteSize / (1024 * 1024)).toFixed(1)} MB` : `${kb.toFixed(0)} KB`;
  return `${n.toLocaleString()} row${n === 1 ? "" : "s"} · ${sizeText}`;
}

/** The Download button's own label -- "Review size warning" on the first
 * press of a large export (see ExportDialog.jsx's confirmedLarge state),
 * "Download" otherwise. */
export function downloadButtonLabel({ isLarge, confirmedLarge, nothingSelected }) {
  return isLarge && !confirmedLarge && !nothingSelected ? "Review size warning" : "Download";
}
