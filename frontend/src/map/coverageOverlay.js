// Where has this map actually looked -- the honesty section popups.js already
// gives one country at a time (coverageStateFor/coverageReason/buildCoverage
// in map/popups.js), turned into a map layer instead of a card fold.
//
// raw.fetchCoverage is the ledger both read: per source, what the client last
// recorded about its own fetch of it (see useOsintData.js's recordCoverageRef
// and publishFetchOutcome). Nothing in this module fetches anything -- it only
// reads what has already been recorded, and turns that into something a
// reader can look at on the map itself rather than one country card at a time.
//
// Five states, and they stay five -- collapsing any two of them is the exact
// failure popups.js's own coverage section was written to prevent (see its
// module note on "not_loaded" vs "scoped_elsewhere" vs "checked"), just one
// level up: a map-wide instrument, not a per-country one.
//
//   global   fetched, no bbox restriction on the last attempt -- covers the
//            whole world for this source.
//   scoped   fetched, clipped to the bbox recorded alongside it -- covers
//            only that area; everywhere else is unknown for this source, not
//            confirmed empty.
//   gated    this source's own zoom gate (map/scene.js) has not lifted at the
//            camera's current position -- never requested here at all. The
//            single most common reason a reader sees nothing, and the one
//            they are least likely to guess.
//   failed   the last fetch attempt for this source errored.
//   unknown  raw.fetchCoverage has no entry for this key at all. Most often
//            transient (a poller's very first tick has not resolved yet), but
//            permanent for a handful of sources that never call
//            recordCoverage in the first place -- see UNRECORDED_SOURCE_KEYS
//            below.
//
// Coverage is a **derived** fact in this app's four-word provenance
// vocabulary (measured/reported/derived/inferred): it is arithmetic over what
// this client recorded about its own fetches, never something a source itself
// reported. Every string this module builds says so.

import { esc, timeAgoFromUnix } from "../utils/format";
import { fetchZoomFor, bandFor } from "./scene";

/**
 * Every source `raw.fetchCoverage` can carry a record for, with a short
 * human label. Hand-maintained rather than derived from useOsintData.js's
 * POLL_CONFIG at import time: that module pulls in React at module scope
 * (see referenceOnlyFeeds.test.js's own note on why it is not imported into
 * scene.test.js), and this module has to stay importable from a plain
 * `node --test` run the same way scene.js does. The list below is read
 * straight off POLL_CONFIG and off useOsintData.js's two one-shot
 * recordCoverage calls (cableLandings, infra) as of this task -- if a future
 * source is added there, it belongs here too, the same "hand-copied but
 * checked" trade COVERAGE_FEEDS in map/popups.js already makes for its own,
 * smaller subset of this same list.
 */
export const COVERAGE_OVERLAY_SOURCES = [
  { key: "events", label: "ACLED conflict events" },
  { key: "firms", label: "Fire / thermal detections (NASA FIRMS)" },
  { key: "gdelt", label: "GDELT news" },
  { key: "officials", label: "Officials & diplomacy" },
  { key: "countries", label: "Country boundaries" },
  { key: "cities", label: "City index" },
  { key: "ais", label: "AIS vessel tracking" },
  // The second AIS network, added on OSINT-Main while this branch was in
  // flight. It is a separate feed and a separate layer, never merged into
  // "ais" -- and its receivers are coastal, so its coverage is genuinely a
  // different shape from the global stream's. Listing it separately is the
  // whole point: a reader seeing no vessels in the Baltic should be able to
  // tell which of the two networks was looking there.
  //
  // Found by frontend/tests/coverageOverlay.test.js's own pairing check on the
  // first merge after that test was written, which is exactly what it is for.
  { key: "aisDigitraffic", label: "AIS vessel tracking, Finnish/Baltic coastal (Fintraffic Digitraffic)" },
  { key: "marinesia", label: "AIS vessel tracking, worldwide sample (Marinesia)" },
  { key: "adsb", label: "ADS-B aircraft tracking" },
  { key: "jamming", label: "GPS jamming cells (GPSJam)" },
  { key: "laneDensity", label: "AIS traffic density (this map's own coverage)" },
  { key: "hazards", label: "Earthquakes & volcanoes (USGS/Smithsonian)" },
  { key: "airports", label: "Airfield gazetteer (OurAirports)" },
  { key: "darkVessels", label: "Dark vessels & ship-to-ship (inferred)" },
  { key: "outages", label: "Internet outage scores, country (IODA)" },
  { key: "outagesRegions", label: "Internet outage scores, region (IODA)" },
  { key: "launches", label: "Orbital launches" },
  { key: "humanitarian", label: "Displacement & food security (UNHCR/HDX)" },
  { key: "osmInfra", label: "OpenStreetMap infrastructure sweep" },
  { key: "satellites", label: "Satellite tracking (positions)" },
  { key: "satNavigation", label: "Satellite elements: navigation" },
  { key: "satWeather", label: "Satellite elements: weather" },
  { key: "satImaging", label: "Satellite elements: imaging" },
  { key: "conflictStats", label: "Conflict stats (HDX/ACLED aggregate)" },
  { key: "escalation", label: "Escalation ranking" },
  { key: "conflictHistory", label: "Verified conflict record (UCDP)" },
  { key: "conflictDistricts", label: "Conflict districts (ACLED via HDX)" },
  { key: "airfieldActivity", label: "Airfield activity (derived from this map's ADS-B)" },
  { key: "navalPresence", label: "Naval presence (derived from this map's AIS)" },
  { key: "chokepoints", label: "Chokepoint transit counts (derived)" },
  { key: "jamCrosscheck", label: "Jamming/aircraft cross-check (derived)" },
  { key: "gfwGaps", label: "AIS disabling events (Global Fishing Watch)" },
  { key: "gfwDetections", label: "Satellite vessel detections (Global Fishing Watch)" },
  { key: "czib", label: "Airspace warnings (EASA CZIB)" },
  { key: "floods", label: "Flood alerts (GDACS)" },
  { key: "ports", label: "Port gazetteer (NGA WPI)" },
  { key: "dams", label: "Dam gazetteer (Global Dam Watch)" },
  { key: "deflock", label: "ALPR camera locations (DeFlock)" },
  { key: "energyFlows", label: "Cross-border electricity (Energy-Charts/ENTSO-E)" },
  { key: "foodTrade", label: "Food balance sheets (FAO/USDA/IGC)" },
  { key: "foodPriceIndex", label: "Food price index (FAO)" },
  { key: "railLive", label: "Live trains (Digitraffic, Finland)" },
  { key: "railStations", label: "Rail station gazetteer (Digitraffic, Finland)" },
  // The two one-shot fetches that do call recordCoverage (see
  // useOsintData.js's publishFetchOutcome calls for "cableLandings"/"infra").
  { key: "cableLandings", label: "Submarine cable routes & landings" },
  { key: "infra", label: "Curated critical infrastructure" },
  // The three boot-fetched documents that never call recordCoverage at all
  // (railways/powerLines/water in useOsintData.js's own one-shot effect --
  // each publishes straight through onDataRef.current with no
  // publishFetchOutcome/recordCoverage call around it). Their state here is
  // "unknown" forever, by construction rather than by chance, and that is the
  // honest answer for them today -- leaving them off this list would hide a
  // real gap in this map's own instrumentation rather than surface it, which
  // is exactly what this layer exists not to do. A future task that wires
  // recordCoverage into their fetches moves them out of "unknown" without
  // needing to touch this list.
  { key: "railways", label: "Railway linework (Natural Earth + OpenStreetMap)" },
  { key: "powerLines", label: "Transmission lines (OpenStreetMap)" },
  { key: "water", label: "Water bodies (Natural Earth, marine)" },
];

/**
 * "south,west,north,east" (bboxCell's own format, see useOsintData.js) parsed
 * back into a plain object, or null for anything that is not exactly that.
 * Never throws -- an unparseable string is treated the same as "no bbox
 * recorded", the same defensive stance bboxCellCoversCountry in map/popups.js
 * takes for the identical string.
 */
export function parseBboxCell(cell) {
  if (typeof cell !== "string") return null;
  const parts = cell.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [south, west, north, east] = parts;
  return { south, west, north, east };
}

/**
 * One of the five states above, from a single `raw.fetchCoverage[key]`
 * record (or its absence). Exported for the test -- this is the one piece of
 * classification logic every other function in this module builds on.
 */
export function sourceCoverageState(record) {
  if (!record || record.status == null) return "unknown";
  if (record.status === "gated") return "gated";
  if (record.status === "error") return "failed";
  if (record.status === "fetched") {
    // `bbox` is null for an unscoped source and for a scoped one whose
    // computed cell was "essentially the whole world" (bboxCell's own guard
    // in useOsintData.js) -- both mean nothing was clipped, so both read as
    // "global" here exactly the way bboxCellCoversCountry treats a null cell
    // as covering everything in map/popups.js.
    return record.scoped && record.bbox ? "scoped" : "global";
  }
  return "unknown";
}

/** Fixed per-state visual language, read by both the map rectangles and the
 *  legend swatches so the two can never draw one state two different ways.
 *  Colours are hand-picked rather than pulled from iconTheme.js's
 *  PALETTE_GROUPS: this is a diagnostic instrument, off by default and never
 *  part of the default reading (see its LAYER_MANIFEST entry), and giving it
 *  admin-recolourable tokens would imply it belongs in the same "what does
 *  this map mean by red" system as the pins a reader is meant to trust by
 *  colour. global and scoped share a colour on purpose -- both are the same
 *  claim, "genuinely checked, derived from what was recorded" -- and differ
 *  only in whether there is a *where* to draw.
 */
export const COVERAGE_STATE_STYLE = {
  global: { color: "#3ac1ff", swatch: "#3ac1ff", label: "Checked worldwide" },
  scoped: { color: "#3ac1ff", swatch: "#3ac1ff", label: "Checked in the areas outlined" },
  gated: { color: "#ffb347", swatch: "#ffb347", label: "Not requested at this zoom" },
  failed: { color: "#ff4d4d", swatch: "#ff4d4d", label: "Last attempt failed" },
  unknown: { color: "#8aa0ad", swatch: "#8aa0ad", label: "No coverage record" },
};

/** Leaflet path options for a "scoped" source's last-fetched bbox -- the only
 *  state this layer draws a shape for (see the module-level rationale in
 *  createCoverageLayer's own caller, createMapController.js's renderCoverage).
 */
export const COVERAGE_RECTANGLE_STYLE = {
  color: COVERAGE_STATE_STYLE.scoped.color,
  weight: 2,
  fillColor: COVERAGE_STATE_STYLE.scoped.color,
  fillOpacity: 0.08,
  dashArray: null,
};

/** "zoom 9+ (LOCAL)", or null when the source has no zoom gate at all (an
 *  ALWAYS-fetched or MANUAL source can never actually be in the "gated"
 *  state, but this stays defensive rather than assuming that holds forever).
 *  Reads the *current* scene rather than anything stored in the coverage
 *  record itself, so the number is always the live answer -- the record's
 *  own "gated" status can be up to one poll interval stale, but the zoom a
 *  source needs right now is not a fact that goes stale between polls.
 */
function gateTextFor(key, scene) {
  if (!scene) return null;
  const zoom = fetchZoomFor(scene, key);
  if (zoom == null || zoom === Infinity) return null;
  return `zoom ${zoom}+ (${bandFor(zoom)})`;
}

/** The one-line, plain-words sentence for a single source's current state --
 *  built here, tested here, and never composed inline at a render site (the
 *  rule this whole plan enforces on every user-visible sentence). Used both
 *  as a rectangle's tooltip text (for "scoped") and inside the legend.
 */
export function coverageSourceSentence(label, state, ctx = {}) {
  switch (state) {
    case "global":
      return `${label}: checked worldwide on its last fetch${ctx.whenText ? ` (${ctx.whenText})` : ""} -- no area was excluded.`;
    case "scoped":
      return `${label}: checked only within the area outlined here on its last fetch${ctx.whenText ? ` (${ctx.whenText})` : ""}. Everywhere else is unknown for this source, not confirmed empty.`;
    case "gated":
      return `${label}: not requested at this zoom${ctx.gateText ? ` -- needs ${ctx.gateText}` : ""}. Zoom in to lift the gate.`;
    case "failed":
      return ctx.hadPriorData
        ? `${label}: the last fetch attempt failed -- still showing data from its last success.`
        : `${label}: the last fetch attempt failed, and nothing has ever been recorded for it.`;
    case "unknown":
    default:
      return `${label}: no coverage record -- this map has not reported even trying this source yet.`;
  }
}

/**
 * The full descriptor for one tracked source: its current state, the bbox to
 * draw for it (only ever set for "scoped"), and the sentence a reader sees.
 *
 * `raw` is the map controller's live data buckets (reads `raw.fetchCoverage`
 * only); `scene` is a `resolveScene(...)` result, used only to enrich the
 * "gated" sentence with the zoom that would lift it -- every other state
 * ignores it, so a caller that only wants global/scoped/failed/unknown may
 * pass `null`.
 */
export function describeSourceCoverage(key, label, raw, scene) {
  const record = (raw?.fetchCoverage || {})[key];
  const state = sourceCoverageState(record);
  const bbox = state === "scoped" ? parseBboxCell(record.bbox) : null;
  const whenText = record?.fetchedAt != null ? timeAgoFromUnix(record.fetchedAt / 1000) : null;
  const gateText = state === "gated" ? gateTextFor(key, scene) : null;
  const hadPriorData = state === "failed" ? record?.fetchedAt != null : false;
  const sentence = coverageSourceSentence(label, state, { whenText, gateText, hadPriorData });
  return { key, label, state, bbox, sentence };
}

/**
 * Every tracked source, classified and bucketed by state, plus the subset
 * with a real rectangle to draw (state "scoped" and a bbox that actually
 * parsed).
 */
export function summarizeCoverage(raw, scene) {
  const entries = COVERAGE_OVERLAY_SOURCES.map(({ key, label }) => describeSourceCoverage(key, label, raw, scene));
  const buckets = { global: [], scoped: [], gated: [], failed: [], unknown: [] };
  for (const entry of entries) buckets[entry.state].push(entry);
  const rectangles = buckets.scoped.filter((e) => e.bbox);
  return { entries, buckets, rectangles };
}

// The order the legend lists states in -- honesty-first, not alphabetical:
// the two genuinely-checked states lead, then the reason a reader is most
// likely to be confused by (gated), then the two that mean this map itself
// has a problem (failed, unknown).
const STATE_ORDER = ["global", "scoped", "gated", "failed", "unknown"];

const BUCKET_BLURB = {
  global: "checked worldwide on their last fetch",
  scoped: "checked only within the areas outlined on the map",
  gated: "not yet requested at this zoom -- zoom in to lift them",
  failed: "last fetch attempt failed",
  unknown: "no coverage record on file at all",
};

// How many source names a bucket spells out before folding the rest into a
// count -- the same cap-with-a-stated-remainder shape buildEnergy's own
// ENERGY_COUNTERPART_CAP uses in map/popups.js, so a reader who has learned
// to trust that pattern elsewhere on this map sees it again here.
const NAME_CAP = 6;

function namesFor(entries) {
  const names = entries.map((e) => e.label);
  if (names.length <= NAME_CAP) return names.join(", ");
  return `${names.slice(0, NAME_CAP).join(", ")}, +${names.length - NAME_CAP} more`;
}

/**
 * The legend's full HTML, built here rather than at the Leaflet control's
 * render site so the sentence logic stays reachable by `node --test` -- the
 * same discipline every card section in map/popups.js already follows.
 * Escaped throughout: every label and blurb is plain text set into HTML.
 */
export function coverageLegendHtml(raw, scene) {
  const { buckets } = summarizeCoverage(raw, scene);
  const total = COVERAGE_OVERLAY_SOURCES.length;
  const rows = STATE_ORDER.map((state) => {
    const list = buckets[state];
    if (!list.length) return "";
    const style = COVERAGE_STATE_STYLE[state];
    return `<div class="coverage-legend-row coverage-legend-${esc(state)}">
      <span class="coverage-legend-swatch" style="background:${esc(style.swatch)}"></span>
      <b>${list.length}</b> ${esc(style.label)} &mdash; ${esc(BUCKET_BLURB[state])}
      <div class="coverage-legend-names">${esc(namesFor(list))}</div>
    </div>`;
  }).join("");
  return `<div class="coverage-legend-head">Coverage <span class="inferred-tag">derived</span></div>
    <div class="coverage-legend-body">${rows}</div>
    <div class="coverage-legend-foot">${total} sources tracked. A shaded rectangle on the map is the last
      area a source's fetch actually covered &mdash; everywhere else is unknown for it, not confirmed
      empty.</div>`;
}
