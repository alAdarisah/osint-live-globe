// Task 43: viewport export -- frontend/src/map/exportBuilder.js's own
// header note explains the split (that file is JSX/DOM-free, so it needs no
// stub here, same as sanctionsBoardLogic.js/countryCompareLogic.js). Four
// things this task's brief names explicitly: the GeoJSON shape, CSV escaping
// (commas and quotes in place names), the provenance header's completeness,
// and the empty-selection path.

import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPORT_LAYERS, LAYER_STATUS, MEASURED, REPORTED, DERIVED, INFERRED,
  classifyLayerStatus, buildExportAnalysis, buildExportRow, buildExportRows, computeProvenanceHeader,
  buildGeoJSON, buildCSV, csvField, estimateExportBytes, exceedsWarningThreshold, LARGE_EXPORT_ROW_THRESHOLD,
  layerCountLabel, exportSummaryLine, downloadButtonLabel,
} from "../src/map/exportBuilder.js";

// --- fixtures ---------------------------------------------------------

function portItem(overrides = {}) {
  return {
    port_id: "USNYC",
    // Deliberately carries a comma, a double quote and an apostrophe -- the
    // brief's own named CSV-escaping case, and real to this dataset: port
    // and place names in NGA's World Port Index do this routinely.
    name: 'Port of "Nieuw" Amsterdam, O\'Hare Annex',
    lat: 40.7, lon: -74.0,
    publisher: "NGA World Port Index (Pub 150)",
    license: "US Government work, public domain",
    ...overrides,
  };
}

function eventItem(overrides = {}) {
  return { id: "evt-1", lat: 48.5, lon: 37.9, source: "acled", fatalities: 3, ...overrides };
}

function damItem(overrides = {}) {
  // Non-ASCII, matching this task's own CSV-escaping requirement beyond
  // just commas/quotes.
  return { dam_id: "D1", name: "Barrage de Kaïra", lat: 12.1, lon: -8.4, ...overrides };
}

// ---------------------------------------------------------------------
// classifyLayerStatus / buildExportAnalysis -- the four-facts-not-one ruling
// ---------------------------------------------------------------------

test("classifyLayerStatus: OFF when not selected and not drawn on the map", () => {
  const status = classifyLayerStatus({ included: false, mapOn: false, total: 0, viewportCount: 0, healthEntry: null });
  assert.equal(status, LAYER_STATUS.OFF);
});

test("classifyLayerStatus: EXCLUDED when not selected but drawn on the map", () => {
  const status = classifyLayerStatus({ included: false, mapOn: true, total: 50, viewportCount: 12, healthEntry: null });
  assert.equal(status, LAYER_STATUS.EXCLUDED);
});

test("classifyLayerStatus: DOWN when included, nothing loaded, and health has never succeeded", () => {
  const status = classifyLayerStatus({
    included: true, mapOn: true, total: 0, viewportCount: 0, healthEntry: { last_success: null, last_error: "no database connection" },
  });
  assert.equal(status, LAYER_STATUS.DOWN);
});

test("classifyLayerStatus: DOWN when included and no health entry exists at all", () => {
  const status = classifyLayerStatus({ included: true, mapOn: true, total: 0, viewportCount: 0, healthEntry: null });
  assert.equal(status, LAYER_STATUS.DOWN);
});

test("classifyLayerStatus: EMPTY when the feed has succeeded before but currently holds nothing", () => {
  const status = classifyLayerStatus({
    included: true, mapOn: true, total: 0, viewportCount: 0, healthEntry: { last_success: 1786000000 },
  });
  assert.equal(status, LAYER_STATUS.EMPTY);
});

test("classifyLayerStatus: EMPTY when data exists globally but none is in the current viewport", () => {
  const status = classifyLayerStatus({ included: true, mapOn: true, total: 40000, viewportCount: 0, healthEntry: { last_success: 1786000000 } });
  assert.equal(status, LAYER_STATUS.EMPTY);
});

test("classifyLayerStatus: INCLUDED when at least one row is in view", () => {
  const status = classifyLayerStatus({ included: true, mapOn: true, total: 5, viewportCount: 5, healthEntry: { last_success: 1786000000 } });
  assert.equal(status, LAYER_STATUS.INCLUDED);
});

test("buildExportAnalysis: every EXPORT_LAYERS entry gets exactly one analysis row, in order", () => {
  const analysis = buildExportAnalysis({
    selectedKeys: new Set(["events"]),
    mapOn: { events: true },
    health: { events: { last_success: 1786000000 } },
    recordsFor: (key) => (key === "events" ? { rows: [eventItem()], total: 1 } : { rows: [], total: 0 }),
  });
  assert.equal(analysis.length, EXPORT_LAYERS.length);
  assert.deepEqual(analysis.map((l) => l.key), EXPORT_LAYERS.map((l) => l.key));
  const events = analysis.find((l) => l.key === "events");
  assert.equal(events.status, LAYER_STATUS.INCLUDED);
  assert.equal(events.count, 1);
});

// ---------------------------------------------------------------------
// buildExportRow / per-row provenance -- item fields win over the registry
// ---------------------------------------------------------------------

test("buildExportRow: per-item source/publisher/licence override the static registry", () => {
  const row = buildExportRow(portItem(), "ports", { generatedAt: "2026-08-14T00:00:00.000Z", healthEntry: null });
  assert.equal(row.export_publisher, "NGA World Port Index (Pub 150)");
  assert.equal(row.export_licence, "US Government work, public domain");
  assert.equal(row.export_provenance, REPORTED);
  assert.equal(row.lat, 40.7);
  assert.equal(row.lon, -74.0);
  // lat/lon are not duplicated into properties -- they become geometry/columns.
  assert.equal(row.properties.lat, undefined);
  assert.equal(row.properties.lon, undefined);
  assert.equal(row.properties.name, portItem().name);
});

test("buildExportRow: falls back to the static registry when the item carries no licence", () => {
  const row = buildExportRow(eventItem(), "events", { generatedAt: "2026-08-14T00:00:00.000Z", healthEntry: null });
  assert.equal(row.export_source, "acled"); // item's own field wins over the registry's "ACLED / UCDP"
  assert.equal(row.export_licence, "not stated in the source");
});

test("buildExportRow: a record carrying inferred:true overrides the layer's default provenance word", () => {
  const row = buildExportRow({ ...eventItem(), inferred: true }, "events", { generatedAt: "x" });
  assert.equal(row.export_provenance, INFERRED);
});

test("buildExportRow: jamming's layer default is DERIVED, not MEASURED or INFERRED", () => {
  const row = buildExportRow({ lat: 1, lon: 2, jam_ratio: 0.4, hex: "841f27fffffffff" }, "jamming", { generatedAt: "x" });
  assert.equal(row.export_provenance, DERIVED);
});

test("buildExportRow: firms/ais/adsb default to MEASURED", () => {
  for (const key of ["firms", "ais", "adsb"]) {
    const row = buildExportRow({ lat: 1, lon: 2 }, key, { generatedAt: "x" });
    assert.equal(row.export_provenance, MEASURED, key);
  }
});

test("buildExportRow: nested object/array values survive as JSON text rather than being dropped", () => {
  const row = buildExportRow({ lat: 1, lon: 2, tags: { foo: "bar" }, list: [1, 2] }, "dams", { generatedAt: "x" });
  assert.equal(row.properties.tags, JSON.stringify({ foo: "bar" }));
  assert.equal(row.properties.list, JSON.stringify([1, 2]));
});

// ---------------------------------------------------------------------
// GeoJSON shape
// ---------------------------------------------------------------------

test("buildGeoJSON: a valid FeatureCollection with Point geometry in [lon, lat] order", () => {
  const analysis = buildExportAnalysis({
    selectedKeys: new Set(["events"]),
    mapOn: { events: true },
    health: {},
    recordsFor: () => ({ rows: [eventItem()], total: 1 }),
  });
  const rows = buildExportRows(analysis, { generatedAt: "2026-08-14T00:00:00.000Z" });
  const geo = buildGeoJSON(rows, { generatedAt: "2026-08-14T00:00:00.000Z", viewport: { south: 1, west: 2, north: 3, east: 4 }, analysis });

  assert.equal(geo.type, "FeatureCollection");
  assert.equal(geo.features.length, 1);
  const feature = geo.features[0];
  assert.equal(feature.type, "Feature");
  assert.equal(feature.geometry.type, "Point");
  assert.deepEqual(feature.geometry.coordinates, [37.9, 48.5]); // [lon, lat]
  assert.equal(feature.properties.layer, "events");
  assert.equal(feature.properties.provenance, REPORTED);
  assert.equal(feature.properties.fatalities, 3);
  assert.deepEqual(geo.viewport, { south: 1, west: 2, north: 3, east: 4 });
});

test("buildGeoJSON: an empty row list still produces a well-formed, empty FeatureCollection", () => {
  const geo = buildGeoJSON([], { generatedAt: "x", analysis: [] });
  assert.equal(geo.type, "FeatureCollection");
  assert.deepEqual(geo.features, []);
  assert.deepEqual(geo.provenance, []);
});

// ---------------------------------------------------------------------
// CSV escaping -- the brief's own named test: commas and quotes in place names
// ---------------------------------------------------------------------

test("csvField: quotes a field containing a comma", () => {
  assert.equal(csvField("Alpha, Beta"), '"Alpha, Beta"');
});

test("csvField: quotes and doubles an internal double quote", () => {
  assert.equal(csvField('Port of "Nieuw" Amsterdam'), '"Port of ""Nieuw"" Amsterdam"');
});

test("csvField: an apostrophe alone needs no quoting", () => {
  assert.equal(csvField("O'Hare Annex"), "O'Hare Annex");
});

test("csvField: quotes a field containing a line break", () => {
  assert.equal(csvField("line one\nline two"), '"line one\nline two"');
});

test("csvField: non-ASCII characters pass through unescaped (no quoting needed on their own)", () => {
  assert.equal(csvField("Barrage de Kaïra"), "Barrage de Kaïra");
});

test("buildCSV: a place name with a comma, a quote and an apostrophe round-trips as one field", () => {
  const analysis = buildExportAnalysis({
    selectedKeys: new Set(["ports"]),
    mapOn: { ports: true },
    health: { ports: { last_success: 1786000000 } },
    recordsFor: () => ({ rows: [portItem()], total: 1 }),
  });
  const rows = buildExportRows(analysis, { generatedAt: "2026-08-14T00:00:00.000Z" });
  const csv = buildCSV(rows, { generatedAt: "2026-08-14T00:00:00.000Z", analysis });

  const lines = csv.split("\r\n");
  const headerIdx = lines.findIndex((l) => l.startsWith("export_layer,"));
  assert.ok(headerIdx >= 0, "column header row not found");
  const columns = lines[headerIdx].split(",");
  const nameCol = columns.indexOf("name");
  assert.ok(nameCol >= 0, "name column not found");

  const dataLine = lines[headerIdx + 1];
  // A naive split(",") on the raw line would over-count fields because the
  // name itself contains commas -- proof the quoting actually protected the
  // column count. Parse it back with a tiny RFC4180 reader instead.
  const fields = parseCsvLine(dataLine);
  assert.equal(fields.length, columns.length);
  assert.equal(fields[nameCol], portItem().name);
});

test("buildCSV: a non-ASCII place name is present verbatim in the output", () => {
  const analysis = buildExportAnalysis({
    selectedKeys: new Set(["dams"]),
    mapOn: { dams: true },
    health: { dams: { last_success: 1786000000 } },
    recordsFor: () => ({ rows: [damItem()], total: 1 }),
  });
  const rows = buildExportRows(analysis, { generatedAt: "x" });
  const csv = buildCSV(rows, { generatedAt: "x", analysis });
  assert.ok(csv.includes("Barrage de Kaïra"));
});

// A minimal RFC4180 line parser, independent of the module under test, so
// the round-trip assertion above is not just re-checking csvField with
// itself.
function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// ---------------------------------------------------------------------
// Provenance header completeness -- derived from the rows, not a hand-
// written list, per this task's own brief.
// ---------------------------------------------------------------------

test("computeProvenanceHeader: names every distinct layer actually present in the rows", () => {
  const rows = [
    buildExportRow(eventItem(), "events", { generatedAt: "x" }),
    buildExportRow(portItem(), "ports", { generatedAt: "x" }),
    buildExportRow(portItem({ port_id: "USLA" }), "ports", { generatedAt: "x" }), // duplicate layer, one entry expected
  ];
  const header = computeProvenanceHeader(rows);
  const keys = header.map((h) => h.key).sort();
  assert.deepEqual(keys, ["events", "ports"]);
  const portsEntry = header.find((h) => h.key === "ports");
  assert.equal(portsEntry.licence, "US Government work, public domain");
  assert.equal(portsEntry.provenance, REPORTED);
});

test("computeProvenanceHeader: a row from a layer key with no registry entry still gets an honest fallback line, not silence", () => {
  // Simulates a future layer that reached the export path without a
  // matching EXPORT_LAYERS entry -- exactly the regression this task's
  // brief warns against ("so a future layer added to the export cannot
  // silently ship without provenance").
  const row = buildExportRow({ lat: 1, lon: 2 }, "someBrandNewLayer", { generatedAt: "x" });
  const header = computeProvenanceHeader([row]);
  assert.equal(header.length, 1);
  assert.equal(header[0].key, "someBrandNewLayer");
  assert.equal(header[0].licence, "not stated in the source");
});

test("computeProvenanceHeader: every source present in a full-layer GeoJSON export is named in its own provenance array", () => {
  const selectedKeys = new Set(["events", "firms", "deflock"]);
  const mapOn = { events: true, firms: true, deflock: true };
  const health = {
    events: { last_success: 1786000000 }, firms: { last_success: 1786000000 }, deflock: { last_success: 1786000000 },
  };
  const recordsFor = (key) => {
    if (key === "events") return { rows: [eventItem()], total: 1 };
    if (key === "firms") return { rows: [{ lat: 3, lon: 4, source: "viirs" }], total: 1 };
    if (key === "deflock") {
      return { rows: [{ lat: 5, lon: 6, source: "OpenStreetMap contributors (via DeFlock)", licence: "ODbL" }], total: 1 };
    }
    return { rows: [], total: 0 };
  };
  const analysis = buildExportAnalysis({ selectedKeys, mapOn, health, recordsFor });
  const rows = buildExportRows(analysis, { generatedAt: "x" });
  const geo = buildGeoJSON(rows, { generatedAt: "x", analysis });

  const layersInFeatures = new Set(geo.features.map((f) => f.properties.layer));
  const layersInProvenance = new Set(geo.provenance.map((p) => p.key));
  assert.deepEqual(layersInFeatures, layersInProvenance);
  assert.equal(layersInProvenance.size, 3);
  const deflock = geo.provenance.find((p) => p.key === "deflock");
  assert.equal(deflock.licence, "ODbL"); // read off the row itself, not the static fallback
});

// ---------------------------------------------------------------------
// The empty-selection path -- named explicitly in this task's brief.
// ---------------------------------------------------------------------

test("empty selection: no layers selected produces a zero-row, well-formed GeoJSON, not a crash or garbage", () => {
  const analysis = buildExportAnalysis({
    selectedKeys: new Set(), mapOn: { events: true }, health: {}, recordsFor: () => ({ rows: [], total: 0 }),
  });
  assert.ok(analysis.every((l) => l.status === LAYER_STATUS.OFF || l.status === LAYER_STATUS.EXCLUDED));
  const rows = buildExportRows(analysis, { generatedAt: "x" });
  assert.deepEqual(rows, []);
  const geo = buildGeoJSON(rows, { generatedAt: "x", analysis });
  assert.deepEqual(geo.features, []);
  assert.deepEqual(geo.provenance, []);
  // The layer list still reports every candidate's status, even though none
  // of them contributed rows -- "found nothing" from an empty selection must
  // say why, not render as an indistinguishable blank file.
  assert.equal(geo.layers.length, EXPORT_LAYERS.length);
});

test("empty selection: the CSV still carries a header explaining nothing was selected, with no data rows", () => {
  const analysis = buildExportAnalysis({
    selectedKeys: new Set(), mapOn: {}, health: {}, recordsFor: () => ({ rows: [], total: 0 }),
  });
  const rows = buildExportRows(analysis, { generatedAt: "2026-08-14T00:00:00.000Z" });
  const csv = buildCSV(rows, { generatedAt: "2026-08-14T00:00:00.000Z", analysis });
  assert.ok(csv.includes("No rows in this export"));
  // No column-header row and no data row: only the comment block.
  assert.ok(!csv.includes("export_layer,export_provenance"));
  // But every candidate layer's own reason is still listed, so a reader can
  // tell "you excluded everything" apart from "every feed is down".
  for (const layer of EXPORT_LAYERS) {
    assert.ok(csv.includes(layer.label), `missing ${layer.label} in empty-selection CSV header`);
  }
});

test("empty selection is distinct from an included-but-viewport-empty selection", () => {
  // Same layer, included both times -- only whether anything is in view differs.
  const emptySelection = buildExportAnalysis({
    selectedKeys: new Set(), mapOn: { events: true }, health: { events: { last_success: 1786000000 } },
    recordsFor: () => ({ rows: [], total: 500 }),
  });
  const includedButEmptyViewport = buildExportAnalysis({
    selectedKeys: new Set(["events"]), mapOn: { events: true }, health: { events: { last_success: 1786000000 } },
    recordsFor: () => ({ rows: [], total: 500 }),
  });
  assert.equal(emptySelection.find((l) => l.key === "events").status, LAYER_STATUS.EXCLUDED);
  assert.equal(includedButEmptyViewport.find((l) => l.key === "events").status, LAYER_STATUS.EMPTY);
});

// ---------------------------------------------------------------------
// Size warning threshold
// ---------------------------------------------------------------------

test("exceedsWarningThreshold: fires past the row-count threshold", () => {
  assert.equal(exceedsWarningThreshold(LARGE_EXPORT_ROW_THRESHOLD + 1, 0), true);
  assert.equal(exceedsWarningThreshold(10, 0), false);
});

test("estimateExportBytes: matches the UTF-8 byte length, not the JS string length, for non-ASCII text", () => {
  const bytes = estimateExportBytes("Kaïra");
  // "K", "a", "ï" (2 bytes in UTF-8), "r", "a" = 6 bytes, not 5 characters.
  assert.equal(bytes, 6);
});

// ---------------------------------------------------------------------
// Dialog strings -- pulled out of ExportDialog.jsx per this project's rule
// against a user-visible string composed inline in JSX.
// ---------------------------------------------------------------------

test("layerCountLabel: singular vs plural row counts", () => {
  assert.equal(layerCountLabel({ status: LAYER_STATUS.INCLUDED, count: 1 }), "1 row");
  assert.equal(layerCountLabel({ status: LAYER_STATUS.INCLUDED, count: 2 }), "2 rows");
  assert.equal(layerCountLabel({ status: LAYER_STATUS.OFF }), "off");
  assert.equal(layerCountLabel({ status: LAYER_STATUS.EXCLUDED }), "excluded");
  assert.equal(layerCountLabel({ status: LAYER_STATUS.DOWN }), "feed down");
  assert.equal(layerCountLabel({ status: LAYER_STATUS.EMPTY }), "0 in view");
});

test("exportSummaryLine: switches from KB to MB past one megabyte", () => {
  assert.equal(exportSummaryLine(3, 2048), "3 rows · 2 KB");
  assert.equal(exportSummaryLine(1, 2 * 1024 * 1024), "1 row · 2.0 MB");
});

test("downloadButtonLabel: asks for a second confirm only on a large, non-empty selection", () => {
  assert.equal(downloadButtonLabel({ isLarge: true, confirmedLarge: false, nothingSelected: false }), "Review size warning");
  assert.equal(downloadButtonLabel({ isLarge: true, confirmedLarge: true, nothingSelected: false }), "Download");
  assert.equal(downloadButtonLabel({ isLarge: false, confirmedLarge: false, nothingSelected: false }), "Download");
  assert.equal(downloadButtonLabel({ isLarge: true, confirmedLarge: false, nothingSelected: true }), "Download");
});

test("size measurement: 5,000 representative rows land within the bytes/row range LARGE_EXPORT_*_THRESHOLD's own comment cites", () => {
  // Re-measures on every run rather than trusting exportBuilder.js's comment
  // to stay accurate as the row shape changes -- this is the actual
  // "measuring an actual payload" the threshold constants are justified by.
  function syntheticPortRow(i) {
    return {
      id: `row-${i}`,
      name: `Port of Example No. ${i}, "Nieuw" Annex`,
      lat: 10 + (i % 100) * 0.01, lon: 20 + (i % 100) * 0.01,
      publisher: "NGA World Port Index (Pub 150)",
      license: "US Government work, public domain",
      harbor_size: "Large", country: "XX", updated: 1786000000 + i,
    };
  }
  const analysis = buildExportAnalysis({
    selectedKeys: new Set(["ports"]),
    mapOn: { ports: true },
    health: { ports: { last_success: 1786000000 } },
    recordsFor: () => ({ rows: Array.from({ length: 5000 }, (_, i) => syntheticPortRow(i)), total: 5000 }),
  });
  const rows = buildExportRows(analysis, { generatedAt: "2026-08-14T00:00:00.000Z" });
  assert.equal(rows.length, 5000);

  const csv = buildCSV(rows, { generatedAt: "2026-08-14T00:00:00.000Z", viewport: { south: 1, west: 2, north: 3, east: 4 }, analysis });
  const geo = JSON.stringify(buildGeoJSON(rows, { generatedAt: "2026-08-14T00:00:00.000Z", analysis }));
  const csvBytesPerRow = estimateExportBytes(csv) / rows.length;
  const geoBytesPerRow = estimateExportBytes(geo) / rows.length;

  // Loose bounds (±40%), not exact-match: this asserts the comment's cited
  // figures (~315 CSV, ~536 GeoJSON) stay in the right ballpark rather than
  // pinning the byte count to the last decimal, which would make an
  // unrelated field-name change fail this test for no real reason.
  assert.ok(csvBytesPerRow > 180 && csvBytesPerRow < 450, `CSV bytes/row out of expected range: ${csvBytesPerRow}`);
  assert.ok(geoBytesPerRow > 320 && geoBytesPerRow < 750, `GeoJSON bytes/row out of expected range: ${geoBytesPerRow}`);
  // GeoJSON is the heavier format, which is what the threshold comment relies on.
  assert.ok(geoBytesPerRow > csvBytesPerRow);
});
