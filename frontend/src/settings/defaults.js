// The shape of everything Admin Mode can change, and what it is before anyone
// changes anything.
//
// One object, one storage key, one exported/imported file. The alternative --
// a key per setting -- spreads a single configuration across a dozen entries
// that nothing would ever clean up, which is the same reasoning useAccordion.js
// gives for its own single key.

import {
  DEFAULT_COLORS, DEFAULT_SIZES, DEFAULT_ZOOMS, SPLIT_TOKENS,
  PIN_STACK, WASH_STACK, DEFAULT_STACK_FADE_FLOOR,
} from "../map/iconTheme";
import { shippedDrawZoom, SCENE_APPLY_KEYS, TRAIL_PARENT } from "../map/scene";
import { CURSOR_STYLES } from "../map/cursor";
import { glyphChoicesFor } from "../map/iconTheme";
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
 * null means the layer has no zoom gate and the control is not offered. It is
 * read from map/scene.js rather than restated here -- this file used to hold a
 * third copy of every gate number (the map controller and useOsintData.js held
 * the other two), and three copies of a number is three chances for them to
 * disagree about what the slider is starting from.
 */
export const SETTINGS_LAYERS = [
  { key: "events", label: "Conflict & Violence" },
  { key: "conflictHistory", label: "Verified record (UCDP)" },
  { key: "gdelt", label: "News (GDELT)" },
  { key: "officials", label: "Officials & Diplomacy" },
  { key: "cities", label: "Cities" },
  { key: "infra", label: "Critical infrastructure" },
  { key: "satellites", label: "Satellites" },
  // Task 24: client-propagated satellite layers -- see map/scene.js's own
  // entries for which are on by default and why.
  { key: "satNavigation", label: "Satellites: navigation (GPS/Galileo/GLONASS/Beidou)" },
  { key: "satWeather", label: "Satellites: weather" },
  { key: "satImaging", label: "Satellites: Earth imaging" },
  { key: "satScience", label: "Satellites: science" },
  { key: "satGeo", label: "Satellites: geostationary" },
  { key: "satStarlink", label: "Satellites: Starlink" },
  { key: "satOneweb", label: "Satellites: OneWeb" },
  { key: "aisNavy", label: "Navy & MSC ships" },
  { key: "aisTanker", label: "Oil tankers" },
  { key: "aisCivilian", label: "Civilian ships" },
  { key: "adsbMilitary", label: "Military aircraft" },
  { key: "adsbCivilian", label: "Civilian aircraft" },
  { key: "adsbFlagged", label: "Emergency & hidden aircraft" },
  { key: "darkVessels", label: "Dark vessels & STS (inferred)" },
  { key: "hazards", label: "Natural hazards" },
  { key: "airports", label: "Airfields" },
  { key: "cables", label: "Submarine cables" },
  { key: "launches", label: "Orbital launches" },
  { key: "osmInfra", label: "Infrastructure (OpenStreetMap)" },
  // Task 28: its own row -- power plants have an independent toggle (unlike
  // railwayPoints, which mirrors "railways"), so they need their own
  // zoom-gate/colour dials the same as any other layer.
  { key: "powerPlants", label: "Power plants (OpenStreetMap)" },
  { key: "gfwGaps", label: "AIS disabling (GFW)" },
  { key: "gfwDetections", label: "Satellite vessel detections (GFW)" },
  { key: "czib", label: "Airspace warnings (EASA CZIB)" },
  { key: "floods", label: "Floods (GDACS)" },
  { key: "ports", label: "Ports (NGA WPI)" },
  { key: "dams", label: "Dams & reservoirs (GDW)" },
  { key: "deflock", label: "ALPR cameras (DeFlock)" },
  { key: "railways", label: "Railways (Natural Earth + OpenStreetMap)" },
  // Task 27: its own row -- railwayPoints has none (mirrors "railways", see
  // EXTRA_TOKENS_UNDER in components/admin/sections/shared.jsx) because it
  // has no independent toggle, but railLive does have one and needs its own
  // zoom-gate/colour dials the same as any other layer.
  { key: "railLive", label: "Live trains (Digitraffic, Finland)" },
  { key: "powerLines", label: "Transmission lines (OpenStreetMap)" },
  { key: "water", label: "Water bodies (Natural Earth)" },
  { key: "firms", label: "Fires / thermal anomalies (FIRMS)" },
  { key: "jamming", label: "GPS/radio jamming (GPSJam)" },
  { key: "shippingLanes", label: "Shipping corridors (schematic)" },
  { key: "laneDensity", label: "AIS traffic density (this map's own coverage)" },
].map((layer) => ({ ...layer, zoomGate: shippedDrawZoom(layer.key) }));

/**
 * Colours a token used to ship with, so a saved config can be told apart from a
 * saved *choice*.
 *
 * defaultSettings writes every token into `icons.colors`, which means a stored
 * configuration holds a hex for all forty-odd of them whether or not anyone ever
 * opened the colour picker. Nothing in the file distinguishes "this deployment
 * chose #ff9500" from "this deployment has simply never touched moderate
 * severity" -- so when a shipped colour changes, every existing config silently
 * pins the old one for ever, and the change reaches nobody who has used the map
 * before.
 *
 * This is the only exact way out: a stored value that equals a colour this token
 * used to ship with was not a choice, it was a default being written back, and
 * it yields to the new default. A value equal to neither is a real override and
 * is kept. The cost is that re-picking a superseded colour by hand is not
 * remembered; that is a fair trade against a palette change nobody ever sees.
 *
 * Append rather than replace when a colour changes again -- the entries are a
 * history, and dropping one strands whoever last opened the map before it.
 */
const SUPERSEDED_COLORS = {
  // The severity ramp was red -> orange -> yellow before it became one hue (see
  // SEVERITY_BANDS in map/severity.js).
  "severity.high": ["#ff5c2a"],
  "severity.moderate": ["#ff9500"],
  "severity.low": ["#ffd11a"],
  // A pink-red, which put a regulator's standing warning inside the conflict
  // layer's colour language.
  "czib.active": ["#ff4d6d"],
};

/**
 * Pin orders that used to ship, for the same reason SUPERSEDED_COLORS exists.
 *
 * defaultSettings writes the whole stack into every configuration, so a stored
 * order is present whether or not anyone has ever pressed an arrow -- and an
 * order is only meaningful as a complete sequence, so there is no per-entry
 * "unset" to fall back on. Without this, changing the shipped order would reach
 * nobody who had opened the map before, exactly the failure the colour table
 * describes.
 *
 * Matched as an exact sequence: one arrow pressed anywhere makes it a real
 * arrangement, and a real arrangement is kept.
 */
const SUPERSEDED_PIN_STACKS = [
  // Cities at the foot of the list, under the reference layers they give
  // meaning to, and double-faded for it.
  [
    "events", "conflictHistory", "czib", "hazards", "floods", "gdelt", "officials",
    "darkVessels", "gfwGaps", "gfwDetections", "satellites", "launches",
    "infra", "osmInfra", "airports", "ports", "dams", "cables", "outagePoints", "cities",
  ],
];

const DEFAULT_LAYER_STYLE = { scale: 1, opacity: 1, minZoom: null, maxZoom: null };

/**
 * Every key a checkbox in the control drawer can address.
 *
 * The stored wish table (see `layerWish` below) is validated against this rather
 * than accepted as written: the file is hand-editable and importable, and a key
 * the map has never heard of would sit in the configuration for ever, pinning
 * nothing and explaining nothing.
 *
 * Three sources, because the drawer's rows are not all layers. The resolver
 * manages SCENE_APPLY_KEYS; the three trail toggles and the military-satellite
 * row are sub-tickers of a parent layer, which is exactly why map/scene.js keeps
 * them out of the manifest.
 *
 * waterLakes/waterRivers join the hand-added end of that list for the same
 * reason: neither has an independent existence a manifest entry could gate --
 * both ride the single `water` layer key, filtering what is currently synced
 * into it rather than adding or removing a Leaflet layer of their own (see
 * setLayerVisible in createMapController.js).
 */
export const TOGGLEABLE_LAYER_KEYS = new Set([
  ...SCENE_APPLY_KEYS,
  ...Object.keys(TRAIL_PARENT),
  "satellitesMilitary",
  "waterLakes", "waterRivers",
]);

/**
 * The layers whose records can be edited in the data editor.
 *
 * This was three feeds for a long time, and the stated reason was that only
 * those three were held in React state where the editor could list them. That
 * was true of where the arrays lived and false as a limit: every payload already
 * passes through applyOverrides on its way in (see the `transform` in App.jsx),
 * so the override machinery has always covered every source -- the editor simply
 * had no way to browse the ones the map controller keeps. It reads them from the
 * controller now (recordsFor), and the list is what it should always have been:
 * every feed that is a list of records with a stable identity.
 *
 * `idField` has to be a value that survives a re-fetch. That is the whole
 * contract an edit is stored against -- see the note at the top of
 * applyOverrides.js -- and it is why `cities` is keyed on GeoNames' own id
 * rather than on the composite the renderer falls back to.
 *
 * What is deliberately absent, and why, is UNEDITABLE_SOURCES below.
 */
export const EDITABLE_SOURCES = [
  { key: "events", label: "Conflict events", idField: "id", titleField: "notes" },
  { key: "gdelt", label: "News", idField: "event_id", titleField: "real_title" },
  { key: "officials", label: "Officials & Diplomacy", idField: "id", titleField: "headline" },
  { key: "conflictHistory", label: "Verified record (UCDP)", idField: "id", titleField: "notes" },
  { key: "hazards", label: "Earthquakes & volcanoes", idField: "id", titleField: "place" },
  { key: "floods", label: "Floods (GDACS)", idField: "id", titleField: "description" },
  { key: "czib", label: "Airspace warnings (EASA)", idField: "id", titleField: "name" },
  { key: "infra", label: "Critical infrastructure", idField: "id", titleField: "name" },
  { key: "osmInfra", label: "Infrastructure (OpenStreetMap)", idField: "id", titleField: "name" },
  { key: "cities", label: "Cities", idField: "geonameid", titleField: "name" },
  { key: "airports", label: "Airfields", idField: "id", titleField: "name" },
  { key: "ports", label: "Ports (NGA WPI)", idField: "id", titleField: "name" },
  { key: "dams", label: "Dams & reservoirs", idField: "id", titleField: "dam_name" },
  { key: "launches", label: "Orbital launches", idField: "id", titleField: "mission" },
  { key: "cableLandings", label: "Cable landings", idField: "id", titleField: "name" },
  { key: "darkVessels", label: "Dark vessels & STS", idField: "id", titleField: "name" },
  { key: "gfwGaps", label: "AIS disabling (GFW)", idField: "id", titleField: "flag" },
  { key: "gfwDetections", label: "Vessel detections (GFW)", idField: "id", titleField: "dataset" },
];

/**
 * The feeds deliberately left out of the editor, and why each one is out.
 *
 * Kept as data rather than as a paragraph because "why can I not edit this
 * layer" is a question that will be asked again, and the honest answers are all
 * different. Rendered in the panel so a reader gets the answer where they are
 * looking for it rather than in a source file.
 */
export const UNEDITABLE_SOURCES = [
  {
    label: "Ships & aircraft (AIS, ADS-B)",
    reason: "Live positions. An override is keyed by MMSI or ICAO24 and re-applied to every"
      + " poll, so editing a coordinate would not correct a vessel -- it would pin a moving"
      + " one to the same spot for ever, and the pin would go on claiming to be live.",
  },
  {
    label: "Satellites",
    reason: "Positions are propagated from orbital elements every ten seconds, so the same"
      + " objection applies: there is no coordinate here to correct, only one to freeze.",
  },
  {
    label: "Fires (FIRMS) & jamming (GPSJam)",
    reason: "Drawn as density canvases rather than as pins, and the payloads run to a quarter"
      + " of a million rows. Neither carries a per-record identity an edit could be stored"
      + " against, and there is no individual mark on screen to point at.",
  },
  {
    label: "Country shapes & the choropleth",
    reason: "Geometry, not records. Boundaries have their own editor -- select a country and"
      + " use Edit border -- and the choropleth is computed from the country-keyed feeds.",
  },
  {
    label: "Water bodies",
    reason: "Geometry, not records, for the same reason as the country shapes above -- a sea,"
      + " lake or river is a shape from Natural Earth, not a row with fields to correct.",
  },
  {
    label: "Internet disruption (IODA)",
    reason: "Served as one object keyed by country rather than as a list of records, and the"
      + " pins are derived from it. There is no row here to edit.",
  },
];

// Every editable record is a point, and every one of them is placed by the same
// two numbers -- so they are written once and spread into each table rather than
// restated eighteen times with eighteen chances to give one of them the wrong
// step.
const COORDS = [
  { name: "lat", label: "Latitude", type: "number", step: 0.0001 },
  { name: "lon", label: "Longitude", type: "number", step: 0.0001 },
];

// Which fields the editor offers per source, and how to render each one. Kept
// deliberately short: these are the fields that change what the map draws or
// what the pin says, not every column the backend happens to serve. Several
// feeds carry thirty-odd columns of provenance and licensing that nothing on
// screen reads and nobody should be retyping by hand.
export const EDITABLE_FIELDS = {
  events: [
    { name: "notes", label: "Headline / notes", type: "text" },
    { name: "event_type", label: "Event type", type: "text" },
    { name: "country", label: "Country", type: "text" },
    { name: "severity", label: "Severity (0-100)", type: "number", min: 0, max: 100 },
    { name: "fatalities", label: "Fatalities", type: "number", min: 0 },
    { name: "date", label: "Date (YYYY-MM-DD)", type: "text" },
    ...COORDS,
  ],
  gdelt: [
    { name: "real_title", label: "Headline", type: "text" },
    { name: "source_name", label: "Outlet", type: "text" },
    ...COORDS,
  ],
  officials: [
    { name: "headline", label: "Headline", type: "text" },
    { name: "kind", label: "Kind", type: "text" },
    { name: "country", label: "Country", type: "text" },
    ...COORDS,
  ],
  conflictHistory: [
    { name: "notes", label: "Notes", type: "text" },
    { name: "event_type", label: "Event type", type: "text" },
    { name: "country", label: "Country", type: "text" },
    { name: "fatalities", label: "Fatalities", type: "number", min: 0 },
    { name: "date", label: "Date (YYYY-MM-DD)", type: "text" },
    ...COORDS,
  ],
  hazards: [
    { name: "place", label: "Place", type: "text" },
    // Both, because they are not the same claim: `severity` is what colours and
    // sizes the pin (the shared 0-100 scale), `magnitude` is what the instrument
    // reported. Correcting one and not the other is how a pin ends up drawn at
    // odds with its own popup.
    { name: "severity", label: "Severity (0-100)", type: "number", min: 0, max: 100 },
    { name: "magnitude", label: "Magnitude", type: "number", step: 0.1 },
    ...COORDS,
  ],
  floods: [
    { name: "description", label: "Description", type: "text" },
    { name: "country", label: "Country", type: "text" },
    { name: "severity", label: "Severity (0-100)", type: "number", min: 0, max: 100 },
    ...COORDS,
  ],
  czib: [
    { name: "name", label: "Name", type: "text" },
    { name: "country", label: "Airspace", type: "text" },
    { name: "reference", label: "Reference", type: "text" },
    ...COORDS,
  ],
  infra: [
    { name: "name", label: "Name", type: "text" },
    // The glyph comes straight off this, so a typo here changes which icon is
    // drawn -- see INFRA_STYLE in decorators.js for the values it knows.
    { name: "type", label: "Type (refinery, nuclear, port…)", type: "text" },
    { name: "note", label: "Note", type: "text" },
    ...COORDS,
  ],
  osmInfra: [
    { name: "name", label: "Name", type: "text" },
    { name: "kind", label: "Kind (military_airfield, power_plant…)", type: "text" },
    { name: "operator", label: "Operator", type: "text" },
    { name: "output_mw", label: "Output (MW)", type: "number", step: 0.1 },
    ...COORDS,
  ],
  cities: [
    { name: "name", label: "Name", type: "text" },
    // Drives the tier, which drives the glyph, the size, the fade and the zone
    // radius -- the single most consequential number a city carries.
    { name: "population", label: "Population", type: "number", min: 0 },
    { name: "country_code", label: "Country (ISO2)", type: "text" },
    ...COORDS,
  ],
  airports: [
    { name: "name", label: "Name", type: "text" },
    { name: "type", label: "Type (large_airport, small_airport…)", type: "text" },
    { name: "military_name", label: "Military name (blank = civil)", type: "text" },
    { name: "icao", label: "ICAO", type: "text" },
    ...COORDS,
  ],
  ports: [
    { name: "name", label: "Name", type: "text" },
    { name: "country", label: "Country", type: "text" },
    { name: "harbor_size_label", label: "Harbour size", type: "text" },
    ...COORDS,
  ],
  dams: [
    { name: "dam_name", label: "Name", type: "text" },
    { name: "country", label: "Country", type: "text" },
    { name: "capacity_mcm", label: "Capacity (Mm³)", type: "number", step: 0.1 },
    { name: "height_m", label: "Height (m)", type: "number", step: 0.1 },
    ...COORDS,
  ],
  launches: [
    { name: "mission", label: "Mission", type: "text" },
    { name: "provider", label: "Provider", type: "text" },
    { name: "rocket", label: "Rocket", type: "text" },
    { name: "site", label: "Site", type: "text" },
    ...COORDS,
  ],
  cableLandings: [
    { name: "name", label: "Name", type: "text" },
    ...COORDS,
  ],
  darkVessels: [
    { name: "name", label: "Vessel", type: "text" },
    { name: "mmsi", label: "MMSI", type: "text" },
    { name: "kind", label: "Kind (ais_gap, sts_pair)", type: "text" },
    ...COORDS,
  ],
  gfwGaps: [
    { name: "flag", label: "Flag", type: "text" },
    { name: "gap_hours", label: "Gap (hours)", type: "number", step: 0.1 },
    ...COORDS,
  ],
  gfwDetections: [
    { name: "dataset", label: "Dataset", type: "text" },
    ...COORDS,
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
      // Per-kind minimum zoom, null meaning "whenever the layer draws". The
      // narrow end of the same pair of dials the gates use: layers[key].minZoom
      // moves a whole layer, this moves one kind of pin inside it. Only ever
      // later than the layer's own gate -- see tokenZoom in map/iconTheme.js
      // for why a pin type may not undercut it.
      zooms: { ...DEFAULT_ZOOMS },
      // The ceiling to `zooms`, null meaning "no ceiling". Nothing in
      // LAYER_MANIFEST ships one, so unlike the floor this dial has no shipped
      // value to move -- it only ever adds a limit that did not exist. That is
      // what makes "satellites, but not once I am looking at a street" sayable:
      // the satellites layer is deliberately ungated, and ungated has only ever
      // meant "no floor".
      zoomMaxes: { ...DEFAULT_ZOOMS },
      // Per-kind glyph, null meaning "the shipped shape". Stored as a glyph
      // *name* (see GLYPH_CHOICES in map/svgIcons.js), never as markup: a name
      // survives a build that redraws the shape, markup would freeze the pin at
      // whatever it looked like the day it was picked.
      glyphs: {},
    },
    layers: Object.fromEntries(SETTINGS_LAYERS.map((l) => [l.key, { ...DEFAULT_LAYER_STYLE }])),
    // Which layers Admin Mode has pinned on or off, as { [key]: boolean }.
    // Sparse and empty by default, and the emptiness is the point: an absent key
    // means "the scene resolver decides", which is the state every layer is in
    // until an operator touches its checkbox. A table of forty booleans written
    // out in full would freeze the resolver's whole job at whatever it happened
    // to answer the first time somebody opened the drawer.
    layerWish: {},
    // Which layer draws over which, top first, in the two groups the map's two
    // drawing mechanisms make (see PIN_STACK in map/iconTheme.js). Stored in
    // full rather than as a diff: an order is only meaningful as a whole
    // sequence, and mergeSettings repairs a stale one by appending whatever
    // layers the stored copy has never heard of.
    layerStack: { pins: [...PIN_STACK], washes: [...WASH_STACK] },
    // Grouping conflict reports by the city they are about (see map/cityZones.js).
    // On by default: the pile-up it addresses is the ordinary case in every city
    // this map is used to look at, and the grouping is reversible per pin.
    cityZones: { group: true, show: true, radiusScale: 1 },
    ui: {
      textScale: 1,
      panelOpacity: 0.94,
      accent: null, // null == the theme's own accent, which differs light/dark
      showLeaderLines: true,
      reduceMotion: false,
      // How faint the bottom of a stack group is drawn. 1 switches the depth
      // fade off entirely and leaves every layer at its own opacity, which is
      // the setting for anyone who wants the order to change only what covers
      // what.
      stackFadeFloor: DEFAULT_STACK_FADE_FLOOR,
      // The map's own pointer (see map/cursor.js). Off means the system cursor,
      // which is the escape hatch: a drawn cursor is the one piece of chrome
      // that can make the map unusable if it misbehaves, so switching it off
      // must never depend on it working.
      cursorEnabled: true,
      cursorStyle: "reticle", // see CURSOR_STYLES
      cursorScale: 1,
      cursorColor: null, // null == follow the UI accent
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

function sameOrder(a, b) {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

function pickNumber(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * A stored token map with the retired shared tokens fanned out.
 *
 * Four tokens each used to stand for a whole family of pins -- every city band,
 * every civil airfield tier, both OSM military kinds, all four railway node
 * kinds (see SPLIT_TOKENS in map/iconTheme.js). Every configuration written
 * before the split holds those keys, and the validators below drop any key the
 * current build does not know, so without this an operator's colours, sizes and
 * zooms on those families would silently revert to shipped.
 *
 * The old value is copied to each replacement, which is what the single dial
 * used to do -- one colour on all of them, one zoom on all of them. A key the
 * stored file already carries under its new name wins: that file was written by
 * a build that had the split, and its per-type value is the more specific
 * statement.
 */
function expandSplitTokens(stored) {
  if (!isPlainObject(stored)) return {};
  const out = {};
  for (const [legacy, replacements] of Object.entries(SPLIT_TOKENS)) {
    if (!(legacy in stored)) continue;
    for (const token of replacements) out[token] = stored[legacy];
  }
  return { ...out, ...stored };
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
      for (const [token, value] of Object.entries(expandSplitTokens(stored.icons.colors))) {
        // Unknown tokens are dropped rather than kept: they are either a typo
        // or a colour from a build that had a layer this one does not.
        if (!(token in base.icons.colors) || !/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)) continue;
        // A colour this token used to ship with is a default written back, not a
        // choice -- see SUPERSEDED_COLORS. Leaving base.icons.colors alone here
        // is what lets the new shipped colour through.
        const superseded = SUPERSEDED_COLORS[token] || [];
        if (superseded.some((old) => old.toLowerCase() === value.toLowerCase())) continue;
        base.icons.colors[token] = value;
      }
    }
    if (isPlainObject(stored.icons.sizes)) {
      for (const [token, value] of Object.entries(expandSplitTokens(stored.icons.sizes))) {
        // Same rule as the colours: an unknown token is a typo or a leftover
        // from a build with a layer this one does not have, and either way the
        // shipped multiplier is the right answer.
        if (token in base.icons.sizes) base.icons.sizes[token] = pickNumber(value, 1, 0.3, 3);
      }
    }
    if (isPlainObject(stored.icons.zooms)) {
      for (const [token, value] of Object.entries(expandSplitTokens(stored.icons.zooms))) {
        // A null here is the shipped state written back out, not a malformed
        // entry -- pickNumber's own fallback is null for exactly that reason.
        if (token in base.icons.zooms) base.icons.zooms[token] = pickNumber(value, null, 0, 18);
      }
    }
    if (isPlainObject(stored.icons.glyphs)) {
      for (const [token, name] of Object.entries(stored.icons.glyphs)) {
        // Validated against the curated list rather than against the glyph dict:
        // a name that exists but was never offered for this token is a
        // hand-edited file asking for a refinery drawn as a raindrop, and the
        // list is the whole reason that is not on the menu.
        if (glyphChoicesFor(token).includes(name)) base.icons.glyphs[token] = name;
      }
    }
    if (isPlainObject(stored.icons.zoomMaxes)) {
      for (const [token, value] of Object.entries(expandSplitTokens(stored.icons.zoomMaxes))) {
        if (token in base.icons.zoomMaxes) base.icons.zoomMaxes[token] = pickNumber(value, null, 0, 18);
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
        maxZoom: Number.isFinite(value.maxZoom) ? pickNumber(value.maxZoom, null, 0, 18) : null,
      };
    }
  }

  if (isPlainObject(stored.cityZones)) {
    base.cityZones.group = stored.cityZones.group !== false;
    base.cityZones.show = stored.cityZones.show !== false;
    base.cityZones.radiusScale = pickNumber(stored.cityZones.radiusScale, 1, 0.25, 4);
  }

  if (isPlainObject(stored.layerWish)) {
    for (const [key, value] of Object.entries(stored.layerWish)) {
      // Anything but a real boolean is dropped rather than coerced. A truthy
      // string is how a hand-edited file says "on" and means "the resolver is
      // now overridden for ever" -- too large a consequence for a guess.
      if (TOGGLEABLE_LAYER_KEYS.has(key) && typeof value === "boolean") {
        base.layerWish[key] = value;
      }
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
    base.ui.stackFadeFloor = pickNumber(stored.ui.stackFadeFloor, DEFAULT_STACK_FADE_FLOOR, 0.1, 1);
    // Default-on, so anything but an explicit `false` leaves it on -- the same
    // rule showLeaderLines above uses, and for the same reason: a missing key in
    // an older configuration must not switch a feature off.
    base.ui.cursorEnabled = stored.ui.cursorEnabled !== false;
    // An unknown style falls back rather than being stored, so a hand-edited
    // file naming a treatment this build does not have gets a cursor instead of
    // no cursor at all.
    base.ui.cursorStyle = CURSOR_STYLES.includes(stored.ui.cursorStyle)
      ? stored.ui.cursorStyle
      : "reticle";
    base.ui.cursorScale = pickNumber(stored.ui.cursorScale, 1, 0.5, 2.5);
    base.ui.cursorColor = typeof stored.ui.cursorColor === "string" && /^#[0-9a-f]{6}$/i.test(stored.ui.cursorColor)
      ? stored.ui.cursorColor
      : null;
  }

  // Repaired rather than validated: an order that has lost a layer is worse than
  // no order at all, because a layer with no rank draws unfaded on top of
  // everything. setStack in map/iconTheme.js applies the same rule to whatever
  // reaches it, so this is the second of two doors into the same repair -- both
  // are needed, since a configuration can be hand-edited between them.
  if (isPlainObject(stored.layerStack)) {
    for (const [group, shipped] of [["pins", PIN_STACK], ["washes", WASH_STACK]]) {
      const stored_ = stored.layerStack[group];
      if (!Array.isArray(stored_)) continue;
      // An order this group used to ship with is a default written back, not an
      // arrangement -- see SUPERSEDED_PIN_STACKS. Skipping leaves the shipped
      // order in place.
      if (group === "pins" && SUPERSEDED_PIN_STACKS.some((old) => sameOrder(old, stored_))) continue;
      const known = new Set(shipped);
      const seen = new Set();
      const order = [];
      for (const key of stored_) {
        if (typeof key === "string" && known.has(key) && !seen.has(key)) {
          seen.add(key);
          order.push(key);
        }
      }
      for (const key of shipped) if (!seen.has(key)) order.push(key);
      base.layerStack[group] = order;
    }
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
