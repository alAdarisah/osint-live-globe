// The shape of everything Admin Mode can change, and what it is before anyone
// changes anything.
//
// One object, one storage key, one exported/imported file. The alternative --
// a key per setting -- spreads a single configuration across a dozen entries
// that nothing would ever clean up, which is the same reasoning useAccordion.js
// gives for its own single key.

import { DEFAULT_COLORS, DEFAULT_SIZES } from "../map/iconTheme";
import { sanitizeBorders } from "./borderOverrides";

// Bumped only when a saved config could no longer be merged onto the defaults
// safely. Every load runs through mergeSettings below, which takes the shipped
// default for anything missing or malformed, so an older file is normally just
// a subset rather than a migration problem.
export const SETTINGS_VERSION = 1;

/**
 * The layers whose appearance can be configured, in the order the admin panel
 * lists them. `key` matches the layer keys the map controller already uses (see
 * DEFAULT_LAYER_VISIBILITY in App.jsx and layerForKey in createMapController.js)
 * so a row here drives the real layer rather than a parallel notion of one.
 *
 * `zoomGate` is the shipped minimum zoom, shown as the slider's starting point;
 * null means the layer has no zoom gate and the control is not offered.
 */
export const SETTINGS_LAYERS = [
  { key: "events", label: "Conflict & Violence", zoomGate: 3 },
  { key: "conflictHistory", label: "Verified record (UCDP)", zoomGate: 4 },
  { key: "gdelt", label: "News (GDELT)", zoomGate: 3 },
  { key: "officials", label: "Officials & Diplomacy", zoomGate: 3 },
  { key: "cities", label: "Cities", zoomGate: 5 },
  { key: "infra", label: "Critical infrastructure", zoomGate: null },
  { key: "satellites", label: "Satellites", zoomGate: null },
  { key: "aisNavy", label: "Navy & MSC ships", zoomGate: null },
  { key: "aisTanker", label: "Oil tankers", zoomGate: 3 },
  { key: "aisCivilian", label: "Civilian ships", zoomGate: 3 },
  { key: "adsbMilitary", label: "Military aircraft", zoomGate: null },
  { key: "adsbCivilian", label: "Civilian aircraft", zoomGate: 5 },
  { key: "adsbFlagged", label: "Emergency & hidden aircraft", zoomGate: null },
  { key: "darkVessels", label: "Dark vessels & STS (inferred)", zoomGate: null },
  { key: "hazards", label: "Natural hazards", zoomGate: 3 },
  { key: "airports", label: "Airfields", zoomGate: 7 },
  { key: "cables", label: "Submarine cables", zoomGate: null },
  { key: "launches", label: "Orbital launches", zoomGate: null },
  { key: "osmInfra", label: "Infrastructure (OpenStreetMap)", zoomGate: 9 },
  { key: "gfwGaps", label: "AIS disabling (GFW)", zoomGate: 5 },
  // The one layer here whose zoom gate also moves the *fetch* -- see
  // GFW_DETECTIONS_MIN_ZOOM in createMapController.js and the minZoom entry in
  // useOsintData.js's POLL_CONFIG, which read the same constant.
  { key: "gfwDetections", label: "Satellite vessel detections (GFW)", zoomGate: 6 },
  { key: "czib", label: "Airspace warnings (EASA CZIB)", zoomGate: null },
  { key: "floods", label: "Floods (GDACS)", zoomGate: 3 },
  { key: "ports", label: "Ports (NGA WPI)", zoomGate: 5 },
  { key: "dams", label: "Dams & reservoirs (GDW)", zoomGate: 7 },
];

const DEFAULT_LAYER_STYLE = { scale: 1, opacity: 1, minZoom: null };

/**
 * The layers whose records can be edited in the data editor.
 *
 * Only feeds the app already holds in React state qualify: those are the three
 * the panels read too (see useOsintData.js), so an edit shows up in the map,
 * the news ticker and the notable-events list at once. Every other source is
 * handed straight to the map controller and never kept in a form the editor
 * could list -- FIRMS alone is 100k+ points, which is exactly why.
 */
export const EDITABLE_SOURCES = [
  { key: "events", label: "Conflict events", idField: "id", titleField: "notes" },
  { key: "gdelt", label: "News", idField: "event_id", titleField: "real_title" },
  { key: "officials", label: "Officials & Diplomacy", idField: "id", titleField: "headline" },
];

// Which fields the editor offers per source, and how to render each one. Kept
// deliberately short: these are the fields that change what the map draws or
// what the pin says, not every column the backend happens to serve.
export const EDITABLE_FIELDS = {
  events: [
    { name: "notes", label: "Headline / notes", type: "text" },
    { name: "event_type", label: "Event type", type: "text" },
    { name: "country", label: "Country", type: "text" },
    { name: "severity", label: "Severity (0-100)", type: "number", min: 0, max: 100 },
    { name: "fatalities", label: "Fatalities", type: "number", min: 0 },
    { name: "lat", label: "Latitude", type: "number", step: 0.0001 },
    { name: "lon", label: "Longitude", type: "number", step: 0.0001 },
    { name: "date", label: "Date (YYYY-MM-DD)", type: "text" },
  ],
  gdelt: [
    { name: "real_title", label: "Headline", type: "text" },
    { name: "source_name", label: "Outlet", type: "text" },
    { name: "lat", label: "Latitude", type: "number", step: 0.0001 },
    { name: "lon", label: "Longitude", type: "number", step: 0.0001 },
  ],
  officials: [
    { name: "headline", label: "Headline", type: "text" },
    { name: "kind", label: "Kind", type: "text" },
    { name: "country", label: "Country", type: "text" },
    { name: "lat", label: "Latitude", type: "number", step: 0.0001 },
    { name: "lon", label: "Longitude", type: "number", step: 0.0001 },
  ],
};

export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    icons: {
      scale: 1,
      colors: { ...DEFAULT_COLORS },
      // Per-kind size multipliers, the narrowest of the three size dials (the
      // other two are `scale` just above and layers[key].scale below). Keyed by
      // the same tokens as `colors`, minus the three that name a colour with no
      // pin of its own -- see DEFAULT_SIZES in map/iconTheme.js.
      sizes: { ...DEFAULT_SIZES },
    },
    layers: Object.fromEntries(SETTINGS_LAYERS.map((l) => [l.key, { ...DEFAULT_LAYER_STYLE }])),
    ui: {
      textScale: 1,
      panelOpacity: 0.94,
      accent: null, // null == the theme's own accent, which differs light/dark
      showLeaderLines: true,
      reduceMotion: false,
    },
    // { [sourceKey]: { edits: { [id]: {field: value, __hidden?: true} }, added: [record] } }
    data: Object.fromEntries(EDITABLE_SOURCES.map((s) => [s.key, { edits: {}, added: [] }])),
    // Redrawn national boundaries, sparse -- only the rings someone dragged.
    // { [countryKey]: { fp, rings: { "<polygon>:<ring>": [[lon, lat], ...] } } }
    // See settings/borderOverrides.js for the schema and why it is that shape.
    borders: {},
  };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pickNumber(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * A stored (or imported, or hand-edited) config merged onto the shipped
 * defaults, field by field.
 *
 * Every value is range-checked rather than trusted. This is the load path for a
 * file a user can edit in a text editor and re-import, and a single bad number
 * in it must not be able to make the map draw nothing -- an icon scale of 0, a
 * layer opacity of -3, a colour of "red;background:url(...)".
 */
export function mergeSettings(stored) {
  const base = defaultSettings();
  if (!isPlainObject(stored)) return base;

  if (isPlainObject(stored.icons)) {
    base.icons.scale = pickNumber(stored.icons.scale, 1, 0.4, 3);
    if (isPlainObject(stored.icons.colors)) {
      for (const [token, value] of Object.entries(stored.icons.colors)) {
        // Unknown tokens are dropped rather than kept: they are either a typo
        // or a colour from a build that had a layer this one does not.
        if (token in base.icons.colors && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)) {
          base.icons.colors[token] = value;
        }
      }
    }
    if (isPlainObject(stored.icons.sizes)) {
      for (const [token, value] of Object.entries(stored.icons.sizes)) {
        // Same rule as the colours: an unknown token is a typo or a leftover
        // from a build with a layer this one does not have, and either way the
        // shipped multiplier is the right answer.
        if (token in base.icons.sizes) base.icons.sizes[token] = pickNumber(value, 1, 0.3, 3);
      }
    }
  }

  if (isPlainObject(stored.layers)) {
    for (const [key, value] of Object.entries(stored.layers)) {
      if (!(key in base.layers) || !isPlainObject(value)) continue;
      base.layers[key] = {
        scale: pickNumber(value.scale, 1, 0.3, 3),
        opacity: pickNumber(value.opacity, 1, 0.1, 1),
        minZoom: Number.isFinite(value.minZoom) ? pickNumber(value.minZoom, null, 0, 18) : null,
      };
    }
  }

  if (isPlainObject(stored.ui)) {
    base.ui.textScale = pickNumber(stored.ui.textScale, 1, 0.75, 1.6);
    base.ui.panelOpacity = pickNumber(stored.ui.panelOpacity, 0.94, 0.35, 1);
    base.ui.accent = typeof stored.ui.accent === "string" && /^#[0-9a-f]{6}$/i.test(stored.ui.accent)
      ? stored.ui.accent
      : null;
    base.ui.showLeaderLines = stored.ui.showLeaderLines !== false;
    base.ui.reduceMotion = stored.ui.reduceMotion === true;
  }

  if (isPlainObject(stored.data)) {
    for (const source of EDITABLE_SOURCES) {
      const entry = stored.data[source.key];
      if (!isPlainObject(entry)) continue;
      if (isPlainObject(entry.edits)) base.data[source.key].edits = entry.edits;
      if (Array.isArray(entry.added)) base.data[source.key].added = entry.added.filter(isPlainObject);
    }
  }

  // Geometry, so validated somewhere it can be reasoned about as geometry --
  // ring closure, the length floor the hit-test depends on, and the total-point
  // ceiling that keeps the whole configuration inside what the backend will
  // accept. See settings/borderOverrides.js.
  if (isPlainObject(stored.borders)) base.borders = sanitizeBorders(stored.borders).borders;

  return base;
}
