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
// **Scope**: every layer whose records already carry the map's own uniform
// point shape -- a numeric `.lat`/`.lon` directly on the item, the same
// contract createMapController.js's renderMarkerLayer relies on (see its own
// `typeof item.lat !== "number"` guard) and the same contract ID_FIELD/
// DECORATORS (createMapController.js:377-419) already use to decide which
// layers that generic renderer draws. That table -- plus ais/adsb, which have
// their own renderers but the identical item shape -- is the actual boundary
// of this file's EXPORT_LAYERS below, checked one by one against those two
// tables rather than asserted. `satellites` is the one candidate deliberately
// left out, and it is left out *visibly*: see EXCLUDED_LAYERS and its own
// comment for why, and layers()/computeProvenanceHeader for how that reason
// reaches the dialog and the exported file rather than staying only in this
// comment.
//
// Line and polygon layers (shipping lanes, cables' own routes, railways,
// power lines, water bodies, country/admin boundaries) are out of scope for
// this task for a different reason -- exporting them honestly would mean
// GeoJSON LineString/Polygon geometry and a CSV shape (WKT? one row per
// vertex?) this task's brief does not ask for, and inventing one under time
// pressure risks the exact silent-corruption failure this whole feature
// exists to prevent. `cableLandings` (the point half of the same module) is
// included below; the line geometry it comes paired with is not, and
// ExportDialog.jsx's own scope note says so.

// ---------------------------------------------------------------------------
// The four-word vocabulary, exactly as this project's own rule states it
// (measured / reported / derived / inferred) -- see global-constraints.md.
// ---------------------------------------------------------------------------
export const MEASURED = "measured";
export const REPORTED = "reported";
export const DERIVED = "derived";
export const INFERRED = "inferred";

const NOT_STATED = "not stated in the source";

// The control panel's own idea of which /api/health key answers "when did
// this layer's data last land" for a given layer key -- imported, not
// re-typed, so this module's notion of "is this feed down" cannot silently
// drift from LayerCheck.jsx's freshness badge the way a hand-copied string
// could after either file renamed a key. See that file's own header note for
// which layers it deliberately omits (curated/static feeds with no poller).
import { LAYER_HEALTH_KEY } from "../components/controlPanel/layerHealthKeys.js";

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
 * under. Pulled from LAYER_HEALTH_KEY above wherever that table has an entry
 * for this exact key or an equivalent one (aisNavy/aisTanker/aisCivilian all
 * name the same "ais" health entry, so any one of them is as good as another
 * as the import site -- see the `ais`/`adsb` entries below for which). A
 * five-entry gap in LAYER_HEALTH_KEY -- `cableLandings`, `railwayPoints`,
 * `outagePoints`, `outageRegionPoints` have no row there at all, and that
 * table's own header note says a missing key means "no background poller",
 * which is not true for these four -- so those five (four keys, five
 * comments) are verified directly against the backend module's own
 * `registry.register("<name>", ...)` call instead, cited per entry, rather
 * than imported from a table that does not cover them.
 */
// OSM's own licence, stated once here rather than repeated on every one of
// the five Overpass-derived entries below (osmInfra, railwayPoints,
// powerPlants, airDefense all read the identical parse_overpass() output --
// see createMapController.js's applyData, which redraws all three of the
// split-out layers together whenever "a fresh OSM sweep lands"). Not
// asserted from memory: backend/sources/deflock.py's own module docstring
// states it in full for OpenStreetMap data ("Underlying data is
// OpenStreetMap under ODbL 1.0"), and osm_infra.py's own docstring names
// OpenStreetMap as this module's source too -- same upstream database,
// fetched by the same kind of Overpass query, so the licence that already
// applies to one applies to the other. None of these four modules restate it
// themselves (osm_infra.py has no "licence"/"ODbL" text of its own), which
// is exactly why this comment exists instead of four copies each claiming to
// have found it locally.
const OSM_OVERPASS_SOURCE = {
  name: "OpenStreetMap contributors (via Overpass)", publisher: "OpenStreetMap contributors", licence: "ODbL", url: null,
};

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
    healthKey: LAYER_HEALTH_KEY.events,
  },
  {
    key: "gdelt",
    label: "News coverage (GDELT)",
    provenance: REPORTED,
    // Attribution.jsx: "GDELT Project". No licence stated in backend/sources/gdelt.py.
    source: { name: "GDELT Project", publisher: null, licence: null, url: null },
    healthKey: LAYER_HEALTH_KEY.gdelt,
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
    healthKey: LAYER_HEALTH_KEY.officials,
  },
  {
    key: "firms",
    label: "Active fire detections (FIRMS)",
    // backend/sources/firms.py: VIIRS/HMS satellite hotspot detections -- an
    // instrument reading, not a claim someone made. MEASURED.
    provenance: MEASURED,
    // Attribution.jsx: "NASA FIRMS". No licence stated in backend/sources/firms.py.
    source: { name: "NASA FIRMS", publisher: "NASA", licence: null, url: null },
    healthKey: LAYER_HEALTH_KEY.firms,
  },
  {
    key: "ais",
    label: "Ship positions (AIS)",
    // A transponder report picked up by a receiver -- MEASURED.
    provenance: MEASURED,
    // Attribution.jsx: "aisstream.io". No licence stated in backend/ingest's ais module.
    source: { name: "aisstream.io", publisher: null, licence: null, url: null },
    // LAYER_HEALTH_KEY has no bare "ais" row -- only the three drawn splits
    // (aisNavy/aisTanker/aisCivilian), which all name the same "ais" health
    // entry. aisNavy is picked arbitrarily among equals as the import site.
    healthKey: LAYER_HEALTH_KEY.aisNavy,
  },
  {
    key: "adsb",
    label: "Aircraft positions (ADS-B)",
    provenance: MEASURED,
    // Attribution.jsx: "OpenSky Network". No licence stated in the ingest module.
    source: { name: "OpenSky Network", publisher: null, licence: null, url: null },
    // Same "no bare key" situation as ais above -- adsbMilitary is one of
    // three equally-valid splits (adsbMilitary/adsbCivilian/adsbFlagged),
    // all naming the same "adsb" health entry.
    healthKey: LAYER_HEALTH_KEY.adsbMilitary,
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
    healthKey: LAYER_HEALTH_KEY.jamming,
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
    healthKey: LAYER_HEALTH_KEY.airports,
  },
  {
    key: "ports",
    label: "Ports (NGA World Port Index)",
    provenance: REPORTED,
    // backend/sources/ports.py's own PUBLISHER/LICENSE constants, already
    // embedded per record -- read per-row in buildExportRow when present,
    // this is the static fallback.
    source: { name: "NGA World Port Index (Pub 150)", publisher: "NGA World Port Index (Pub 150)", licence: "US Government work, public domain", url: null },
    healthKey: LAYER_HEALTH_KEY.ports,
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
    healthKey: LAYER_HEALTH_KEY.dams,
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
    healthKey: LAYER_HEALTH_KEY.deflock,
  },
  {
    key: "czib",
    label: "Airspace closures (CZIB)",
    provenance: REPORTED,
    // backend/sources/czib.py's own PUBLISHER constant, embedded per record. No licence stated.
    source: { name: "EASA Conflict Zone Information Bulletins", publisher: "EASA", licence: null, url: null },
    healthKey: LAYER_HEALTH_KEY.czib,
  },
  // ---- added on review: the rest of createMapController.js's ID_FIELD/
  // DECORATORS point-layer contract (lines 377-419), plus ais/adsb above --
  // every layer that table lists and this file had not yet covered. ------
  {
    key: "conflictHistory",
    label: "Verified conflict record (UCDP GED Candidate)",
    // Same UCDP candidate file as events' "ucdp" rows, parsed a second time
    // as the full reviewed record rather than a live window -- see
    // backend/sources/acled.py's _fetch_ucdp_history and _parse_ucdp_csv,
    // which stamps "source": "ucdp" per record just as the live half does.
    // A compiled incident report, not an instrument reading -- REPORTED.
    provenance: REPORTED,
    source: { name: "UCDP GED Candidate dataset", publisher: null, licence: null, url: null },
    healthKey: LAYER_HEALTH_KEY.conflictHistory,
  },
  {
    key: "hazards",
    label: "Earthquakes & volcanic activity (USGS / Smithsonian GVP)",
    // Two publishers under one layer, split by `kind` -- see
    // backend/sources/hazards.py's own module docstring. An earthquake is a
    // seismometer-network reading (MEASURED); a volcano entry is Smithsonian
    // GVP's weekly written report, explicitly "a report about a week, not a
    // live sensor reading" in that module's own words (REPORTED). Handled
    // per-row in buildExportRow via PROVENANCE_OVERRIDE below, not by a
    // single default here.
    provenance: MEASURED,
    // Each record carries its own "publisher" ("USGS" or "Smithsonian GVP /
    // USGS") -- hazards.py:148/264 -- read per-row; this is only the
    // fallback for the unlikely case a record arrives without one.
    source: { name: null, publisher: null, licence: null, url: null },
    healthKey: LAYER_HEALTH_KEY.hazards,
  },
  {
    key: "darkVessels",
    label: "Dark vessels & ship-to-ship transfers (this map's own inference)",
    // backend/sources/dark_vessels.py's own docstring, in full: "So every
    // record carries `inferred: True`". Every row therefore takes the
    // INFERRED override in buildExportRow regardless of this default -- kept
    // as INFERRED here too so the two can never read differently.
    provenance: INFERRED,
    // Not a third-party publisher: this layer is built entirely from AIS
    // history this backend already recorded (that module's own words: "This
    // module fetches nothing"), so there is no external source/licence to
    // cite -- the source *is* this map.
    source: { name: "This map's own recorded AIS history (backend/sources/dark_vessels.py)", publisher: null, licence: null, url: null },
    healthKey: LAYER_HEALTH_KEY.darkVessels,
  },
  {
    key: "cableLandings",
    label: "Submarine cable landing points (TeleGeography)",
    provenance: REPORTED,
    // backend/sources/cables.py's own module docstring: "TeleGeography
    // publish the map behind submarinecablemap.com as plain GeoJSON with no
    // key". No licence stated in that module.
    source: {
      name: "TeleGeography (submarinecablemap.com)", publisher: "TeleGeography", licence: null,
      url: "https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json",
    },
    // Not in LAYER_HEALTH_KEY -- see this file's own header note. Verified
    // directly: backend/sources/cables.py:124 registers one health entry,
    // `registry.register("cables", ...)`, shared by both the cable routes
    // (out of this export's scope, see the file-level scope note) and these
    // landing points, since both come from the same poller.
    healthKey: "cables",
  },
  {
    key: "launches",
    label: "Orbital launches (Launch Library 2)",
    provenance: REPORTED,
    // backend/sources/launches.py's own module docstring: "The Launch
    // Library 2 API is public and keyless". No licence stated.
    source: {
      name: "Launch Library 2 (The Space Devs)", publisher: null, licence: null,
      url: "https://ll.thespacedevs.com/2.3.0/launches",
    },
    healthKey: LAYER_HEALTH_KEY.launches,
  },
  {
    key: "osmInfra",
    label: "Infrastructure (OpenStreetMap)",
    provenance: REPORTED,
    source: OSM_OVERPASS_SOURCE,
    healthKey: LAYER_HEALTH_KEY.osmInfra,
  },
  {
    key: "railwayPoints",
    label: "Railway stations, halts, yards & border crossings (OpenStreetMap)",
    provenance: REPORTED,
    source: OSM_OVERPASS_SOURCE,
    // Not in LAYER_HEALTH_KEY under this key (that table lists osmInfra/
    // powerPlants/airDefense as sharing "osm_infra" but omits railwayPoints,
    // which comes from the identical Overpass sweep -- see
    // createMapController.js's applyData: "railwayPoints/powerPlants/
    // airDefense have just been rebuilt above; redraw all three whenever a
    // fresh OSM sweep lands"). Verified directly against that comment rather
    // than imported.
    healthKey: "osm_infra",
  },
  {
    key: "powerPlants",
    label: "Power plants (OpenStreetMap)",
    provenance: REPORTED,
    source: OSM_OVERPASS_SOURCE,
    healthKey: LAYER_HEALTH_KEY.powerPlants,
  },
  {
    key: "airDefense",
    label: "Air defence & radar sites (OpenStreetMap)",
    provenance: REPORTED,
    source: OSM_OVERPASS_SOURCE,
    healthKey: LAYER_HEALTH_KEY.airDefense,
  },
  {
    key: "gfwGaps",
    label: "AIS disabling events (Global Fishing Watch)",
    // backend/sources/gfw_gaps.py's own docstring: "every record carries
    // `inferred: True`" (line 275: "inferred": True) -- same convention as
    // darkVessels above, and every row takes the override regardless.
    provenance: INFERRED,
    // gfw_gaps.py embeds "publisher"/"license" per record already
    // ("Global Fishing Watch" / "CC BY-NC 4.0", lines 270-271) -- this is
    // the fallback.
    source: { name: "Global Fishing Watch", publisher: "Global Fishing Watch", licence: "CC BY-NC 4.0", url: null },
    healthKey: LAYER_HEALTH_KEY.gfwGaps,
  },
  {
    key: "gfwDetections",
    label: "Satellite vessel detections (Global Fishing Watch)",
    // A satellite detection -- "the first thing in this map's maritime stack
    // entitled to say 'detected'" (this layer's own on-screen "About this
    // layer" text). No `inferred` flag set (unlike the two GFW/dark-vessel
    // layers above), so MEASURED is this layer's real default, not merely a
    // fallback.
    provenance: MEASURED,
    // gfw_detections.py's own PUBLISHER/LICENSE constants (lines 123-124),
    // embedded per record -- this is the fallback.
    source: {
      name: "Global Fishing Watch", publisher: "Global Fishing Watch",
      licence: "CC BY-NC 4.0 (creativecommons.org/licenses/by-nc/4.0)", url: null,
    },
    healthKey: LAYER_HEALTH_KEY.gfwDetections,
  },
  {
    key: "floods",
    label: "Flood alerts (GDACS)",
    // backend/sources/floods.py's own docstring: "A GDACS flood point is a
    // modelled centroid over an affected basin -- GDACS labels it Centroid
    // itself". A model output over the underlying hydrological signal, not a
    // direct reading -- DERIVED, the same word this file already uses for
    // jamming's own model-computed centroid.
    provenance: DERIVED,
    // floods.py embeds "publisher": "GDACS (European Commission JRC / UN)"
    // per record (line 283) -- this is the fallback. No licence stated.
    source: { name: "GDACS (European Commission JRC / UN)", publisher: "GDACS (European Commission JRC / UN)", licence: null, url: null },
    healthKey: LAYER_HEALTH_KEY.floods,
  },
  {
    key: "railLive",
    label: "Live trains (Digitraffic, Finland only)",
    // A GPS position report from a live train, the same kind of claim as
    // AIS/ADS-B above -- MEASURED.
    provenance: MEASURED,
    // digitraffic_rail.py's own PUBLISHER/LICENSE constants, embedded per record.
    source: { name: "Fintraffic / digitraffic.fi", publisher: "Fintraffic / digitraffic.fi", licence: "CC 4.0 BY (Source: Fintraffic / digitraffic.fi)", url: null },
    healthKey: LAYER_HEALTH_KEY.railLive,
  },
  {
    key: "railStations",
    label: "Train stations (Digitraffic, Finland only)",
    // A station registry entry -- REPORTED, not a live reading.
    provenance: REPORTED,
    source: { name: "Fintraffic / digitraffic.fi", publisher: "Fintraffic / digitraffic.fi", licence: "CC 4.0 BY (Source: Fintraffic / digitraffic.fi)", url: null },
    healthKey: LAYER_HEALTH_KEY.railStations,
  },
  {
    key: "outagePoints",
    label: "Internet outages by country (IODA) -- plotted at a country-representative point, not a location IODA reports",
    // backend/sources/outages.py's own docstring: IODA's score is "a
    // composite" across three independent detectors (BGP withdrawals, active
    // probing, darknet traffic) -- arithmetic combining several measured/
    // reported signals into one figure, which this project's vocabulary
    // defines as DERIVED. The plotted position is this map's own choice
    // (createMapController.js's rebuildOutagePoints uses each country's
    // representative point, not a coordinate IODA supplies), which is why
    // the label itself carries that caveat rather than leaving it implicit.
    provenance: DERIVED,
    // outages.py embeds "publisher": "IODA (Georgia Tech)" per record
    // (lines 283/326) -- this is the fallback. No licence stated.
    source: { name: "IODA (Georgia Tech)", publisher: "IODA (Georgia Tech)", licence: null, url: null },
    // Not in LAYER_HEALTH_KEY. Verified directly:
    // backend/sources/outages.py:342 registers `registry.register("outages", ...)`
    // for the country pass raw.outagePoints is built from.
    healthKey: "outages",
  },
  {
    key: "outageRegionPoints",
    label: "Internet outages by region (IODA) -- plotted at a region-representative point, not a location IODA reports",
    provenance: DERIVED,
    source: { name: "IODA (Georgia Tech)", publisher: "IODA (Georgia Tech)", licence: null, url: null },
    // Verified directly: backend/sources/outages.py:348 registers
    // `registry.register("outages_regions", ...)` for the region pass
    // raw.outageRegionPoints is built from.
    healthKey: "outages_regions",
  },
];

/**
 * Layers with the identical `.lat`/`.lon` point contract every EXPORT_LAYERS
 * entry above shares, but left out of the export anyway -- for a stated
 * reason, shown to the reader in both ExportDialog.jsx (a disabled row) and
 * the exported file's own header (see layers() below and csvHeaderLines'
 * "not represented, and why" section), not only in this comment. Review
 * finding on this task: a stated-but-invisible exclusion is the same failure
 * this task's own brief names -- "found nothing" indistinguishable from "did
 * not look" -- applied to a whole layer rather than a row.
 */
export const EXCLUDED_LAYERS = [
  {
    key: "satellites",
    label: "Satellites (stations + military)",
    reason:
      "Its position is computed client-side via SGP4 from CelesTrak's orbital elements at render time "
      + "(decorateSatellite/tickSatElementLayer in map/decorators.js and createMapController.js), not fetched as "
      + "a record with a stored coordinate the way every other layer here is. raw.satellites holds catalogue "
      + "metadata, not a lat/lon this export's row model can read -- exporting a position would mean freezing a "
      + "propagated moment this map does not otherwise persist, which is a different feature from \"what's on "
      + "screen\" and out of scope for this task.",
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

/**
 * Per-layer provenance rules finer than "every row gets the same default
 * word" -- currently only `hazards`, whose two kinds are two different
 * claims (see that entry's own comment above). Checked in buildExportRow
 * *after* the `item.inferred === true` override (which always wins -- an
 * explicit inference flag outranks a kind-based guess) and *before* falling
 * back to the layer's own `provenance` default.
 */
const PROVENANCE_OVERRIDE = {
  hazards: (item) => (item?.kind === "volcano" ? REPORTED : MEASURED),
};

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
  // EXCLUDED_LAYERS only -- not selectable at all, for a stated architectural
  // reason (see that table's own `reason` field), not a viewport/feed fact
  // any of the five states above describes.
  NOT_EXPORTABLE: "not_exportable",
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
    case LAYER_STATUS.NOT_EXPORTABLE:
      return "Not available for export.";
    default:
      return "";
  }
}

/** The free-text reason a reader sees for a non-included layer -- an
 * EXCLUDED_LAYERS entry's own stated `reason` when it has one (always, for
 * NOT_EXPORTABLE), otherwise the generic per-status sentence above. One
 * function so every caller (the dialog's row title, the CSV/GeoJSON "not
 * represented, and why" section) reads the same words. */
export function layerReasonText(layer) {
  return layer?.reason || layerStatusReason(layer?.status);
}

/**
 * Every candidate layer's status, given what the reader selected and what
 * the controller/health currently know. `recordsFor(key)` is
 * createMapController's exportLayerRecords -- see that method's own note for
 * why { rows, total } rather than just an array.
 *
 * Includes EXCLUDED_LAYERS too, always LAYER_STATUS.NOT_EXPORTABLE and never
 * selectable -- see this module's header note on why an excluded layer has
 * to be visible in the analysis rather than simply absent from it.
 *
 * @param {Set<string>} selectedKeys
 * @param {Record<string, boolean>} mapOn   layerState.on
 * @param {object} health                   the whole /api/health body
 * @param {(key: string) => {rows: object[], total: number}} recordsFor
 */
export function buildExportAnalysis({ selectedKeys, mapOn, health, recordsFor }) {
  const exportable = EXPORT_LAYERS.map((meta) => {
    const included = selectedKeys.has(meta.key);
    const { rows, total } = included ? (recordsFor(meta.key) || { rows: [], total: 0 }) : { rows: [], total: 0 };
    const healthEntry = meta.healthKey ? health?.[meta.healthKey] : null;
    const status = classifyLayerStatus({
      included, mapOn: !!mapOn?.[meta.key], total, viewportCount: rows.length, healthEntry,
    });
    return { key: meta.key, label: meta.label, status, count: rows.length, total, rows, healthEntry, reason: null };
  });
  const excluded = EXCLUDED_LAYERS.map((l) => ({
    key: l.key, label: l.label, status: LAYER_STATUS.NOT_EXPORTABLE,
    count: 0, total: 0, rows: [], healthEntry: null, reason: l.reason,
  }));
  return [...exportable, ...excluded];
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
  // `inferred: true`. When it does, that outranks everything else -- an
  // inferred position exported next to a measured one from the same layer
  // must not read identically, which is this task's own named failure case.
  // Next, a layer-specific override (currently only hazards' earthquake-vs-
  // volcano split -- see PROVENANCE_OVERRIDE's own comment); only then the
  // layer's flat default.
  const override = PROVENANCE_OVERRIDE[layerKey];
  const provenance = item?.inferred === true
    ? INFERRED
    : (override ? override(item) : null) || meta.provenance || null;
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
      lines.push(`#   ${l.label} -- ${layerReasonText(l)}`);
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
    case LAYER_STATUS.NOT_EXPORTABLE: return "not exportable";
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
