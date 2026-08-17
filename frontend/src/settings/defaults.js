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
import { DEFAULT_TILE_DIAL, mergeTileDial } from "../map/tileTint";
import { MARINE_CLASSES } from "../map/water";
import { DEFAULT_VESSEL_FILTER, DEFAULT_AIRCRAFT_FILTER } from "../utils/entityFilter";
import { DEFAULT_EVENT_FILTER } from "../map/severity";
import { mergeInferenceMode } from "./inferenceProducts";
import { CARD_TYPES, CARD_SECTIONS } from "./cardSections";
import { sanitizeAlertRules } from "./alertRules";
import { DEFAULT_FRAME_MS, DEFAULT_STEP_MINUTES, FRAME_MS_BOUNDS, STEP_MINUTES_BOUNDS } from "../replay/playback";

// Bumped only when a saved config could no longer be merged onto the defaults
// safely. Every load runs through mergeSettings below, which takes the shipped
// default for anything missing or malformed, so an older file is normally just
// a subset rather than a migration problem.
//
// 2 (Task 30): added ui.tiles (basemap/imagery/weather filter dials, see
// map/tileTint.js). No destructive change to migrate -- a config saved before
// this key existed simply has no `stored.ui.tiles`, and mergeSettings' own
// `isPlainObject(stored.ui.tiles)` guard below leaves defaultSettings()'
// shipped dials in place for it, the same "additive key, absence means
// unset" rule every other field in this file already follows. The bump is a
// record of the shape changing, not a sign a converter had to be written.
//
// 3 (Task 31): added `water`, `filters`, `inference` and `cards`, plus
// `performance` -- five wholly new top-level keys, every one additive for
// the identical reason ui.tiles was: a config saved before this task has no
// `stored.water` etc. at all, so mergeSettings' own isPlainObject guards
// leave defaultSettings()' shipped values in place rather than needing a
// converter. The bump is the same kind of record 2's own note describes.
//
// 4 (Task 32): added `units` -- the metric/imperial/nautical and UTC/local/
// browser preference (see utils/format.js's formatDistanceKm/formatSpeedKmh/
// formatAltitudeM/formatClockAt). Additive for the same reason as every bump
// above it: a config saved before this task has no `stored.units` at all, so
// mergeSettings leaves defaultSettings()' shipped `{ system: "metric",
// timezone: "utc" }` in place for it.
//
// 5 (Task 42): added `alertRules` -- "tell me when X happens here", stored
// as a plain array and evaluated by the cache worker (see
// backend/alert_rules.py). Additive again: a config saved before this task
// has no `stored.alertRules` at all, and mergeSettings' own
// Array.isArray(stored.alertRules) guard below leaves the shipped empty
// list in place for it, same as every bump above.
//
// 6 (Task 44): added `replay` -- the timeline scrubber's play-button cadence
// (how long a frame is held on screen) and step size (how far each frame
// advances), see hooks/useReplay.js and replay/playback.js. Additive for the
// same reason as every bump above: a config saved before this task has no
// `stored.replay` at all, and mergeSettings' own isPlainObject(stored.replay)
// guard below leaves defaultSettings()' shipped `{ frameMs: 800,
// stepMinutes: 60 }` in place for it -- the exact cadence useReplay.js
// already ran at before this became a dial.
//
// 7: added `publicPanels` -- which of the intel panel's four tabs, and the
// conflict briefing card, a deployment carries -- and `countryOnly` on each
// entry in `layers`. Numbered 7 rather than the 5 it was written as: this
// landed on a branch alongside 5 and 6 above, and two configurations claiming
// the same version number while describing different shapes is the one thing
// this counter exists to prevent. Additive for the same reason as every bump
// above it, and both are default-permissive besides: an absent publicPanels
// leaves all five showing, and an absent countryOnly leaves the layer ungated,
// so a config saved before this task describes exactly the behaviour it had.
export const SETTINGS_VERSION = 7;

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
  { key: "aisDigitraffic", label: "Ships — Baltic (Fintraffic)" },
  { key: "marinesia", label: "Ships (Marinesia)" },
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
  // Task 29: radar/bunker/checkpoint, off by default with its own
  // completeness caveat (see decorateOsmInfra's "airDefense" branch) --
  // same independent-toggle treatment as powerPlants above.
  { key: "airDefense", label: "Air defence & radar (OpenStreetMap, off by default)" },
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
  // Task 46: computed from the clock, not fetched -- see its own note in
  // map/scene.js's LAYER_MANIFEST for why it still has a MANUAL entry there.
  { key: "terminator", label: "Day/night terminator" },
  // Task 50: derived from raw.fetchCoverage, not fetched either -- same
  // "no endpoint of its own" reasoning as terminator just above, see its
  // own note in map/scene.js's LAYER_MANIFEST.
  { key: "coverage", label: "Coverage -- where this map has looked (diagnostic)" },
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

const DEFAULT_LAYER_STYLE = { scale: 1, opacity: 1, minZoom: null, maxZoom: null, countryOnly: false };

/**
 * The layers that can be told to draw only for a selected country.
 *
 * Every layer that draws individual pins, minus four kinds of thing that have
 * no pin to clip:
 *
 *   cities    already country-scoped by its own renderer, on country_code. A
 *             second gate saying the same thing in a different vocabulary is
 *             how the two end up disagreeing.
 *   firms,    density canvases rather than pins, and a quarter of a million
 *   jamming,  rows apiece. There is no individual mark to keep or drop.
 *   laneDensity
 *   water     a lake or a sea is a shape, not a mark on one.
 *   cables,   lines that live in the ocean. The line layers below are gated by
 *   shippingLanes  keeping whole lines that touch the selection, and a submarine
 *             cable or a shipping corridor almost never has a vertex inside a
 *             country -- the test would hide them permanently rather than scope
 *             them, which is a checkbox that does not do what it says.
 *
 * Two kinds of layer are deliberately in.
 *
 * The satellite layers, bulk WebGL groups included: a satellite is a pin with a
 * real position, and "only the passes over the country I am reading about" is
 * exactly the question the gate exists for.
 *
 * The overland line layers -- railways and powerLines -- which were out while
 * the gate could only clip geometry, because a line cut at a border draws a
 * fragment claiming the line ends there. They are in now because the renderers
 * do not clip them: a line is kept or dropped whole, by whether any part of it
 * lies inside the selection (see lineInCountryScope in createMapController.js).
 * That answers the objection rather than accepting it, and these are the two
 * layers where it matters most -- an OSM sweep of eleven theatres is tens of
 * thousands of ways, drawn as real geometry at every zoom.
 *
 * A layer outside this set gets no checkbox at all, rather than a checkbox that
 * half works.
 */
const NO_COUNTRY_GATE = new Set([
  "cities", "firms", "jamming", "laneDensity",
  "water", "cables", "shippingLanes",
]);

export const COUNTRY_ONLY_LAYERS = new Set(
  SETTINGS_LAYERS.map((l) => l.key).filter((key) => !NO_COUNTRY_GATE.has(key))
);

/**
 * The intel panel's tabs, in the order it draws them, as `publicPanels` keys.
 *
 * Named here rather than imported from IntelPanel.jsx because this is the
 * settings shape: the panel owns what a tab looks like and what it lists, and
 * this file owns which of them a deployment carries. They have to agree on the
 * key, and the panel takes the list it is given (see its `tabs` prop) rather
 * than reading a settings object, so there is one direction to the dependency.
 */
export const INTEL_TAB_KEYS = ["escalation", "activity", "events", "news", "officials", "sanctions"];

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
 *
 * terminatorTwilight joins them for the identical reason (Task 46): it rides
 * "terminator"'s own on/off state -- see syncTerminatorTwilight in
 * createMapController.js -- rather than having a manifest entry of its own.
 */
export const TOGGLEABLE_LAYER_KEYS = new Set([
  ...SCENE_APPLY_KEYS,
  ...Object.keys(TRAIL_PARENT),
  "satellitesMilitary",
  "waterLakes", "waterRivers",
  "terminatorTwilight",
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
    // What the reader's own panels carry. Written in full rather than sparsely,
    // unlike layerWish: there is no resolver to hand a panel back to, so an
    // absent key has no third state to mean.
    //
    // The first four are the intel panel's tabs (see IntelPanel.jsx). They are
    // named per tab rather than per panel because the panel is four readings of
    // four different feeds behind one header -- "carry the news ticker but not
    // the officials wire" is a real editorial decision about a deployment, and
    // a single on/off for the whole panel could not say it. Switch all four off
    // and the panel does not render at all; there is nothing left in it.
    //
    // Switching one off hides it from everyone, an operator included: Admin
    // Mode is the reader's map plus instruments, not a different app, and the
    // checkbox that hid it is the way back.
    publicPanels: {
      escalation: true, activity: true, events: true, news: true, officials: true, sanctions: true,
      briefingCard: true,
    },
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
      // Task 30: filter + colour-overlay dials for the raster tile panes --
      // basemap, GIBS imagery and the weather rasters, kept independent
      // because tinting a road map and tinting a satellite mosaic are
      // different jobs (see map/tileTint.js and BasemapSection.jsx). Every
      // dial ships at DEFAULT_TILE_DIAL, i.e. inert -- Admin Mode's own
      // "Default" preset button and this shipped state are the same object.
      tiles: {
        // Off by default -- see map/tileTintMotion.js's own note on what
        // this trades away and why it does not need to be on for a map that
        // ships with blur at 0 everywhere.
        applyAtRest: false,
        basemap: { ...DEFAULT_TILE_DIAL },
        imagery: { ...DEFAULT_TILE_DIAL },
        weather: { ...DEFAULT_TILE_DIAL },
      },
    },
    // Task 32 item 4: the units/timezone preference every card's numbers and
    // clocks read through (see utils/format.js's formatDistanceKm/
    // formatSpeedKmh/formatAltitudeM/formatClockAt). `system` is the reader's
    // choice of unit family; `timezone` is "utc" (fixed), "browser" (follow
    // this device's own zone) or an IANA zone name an operator names
    // directly -- validated against Intl at merge time below rather than
    // against a fixed list, since the set of valid zone names is Intl's own
    // and not this app's to maintain a second copy of.
    units: {
      system: "metric",
      timezone: "utc",
    },
    // Task 31's Water section -- fill/outline weight and which marine
    // classes draw. Colours are not repeated here: water.fill/water.outline/
    // water.selected already live in icons.colors like every other palette
    // token (see map/iconTheme.js's "water" PALETTE_GROUPS entry), and the
    // Water section reuses that same action rather than opening a second
    // place to store the same three hexes. hiddenClasses covers only the
    // marine sub-kinds in map/water.js's MARINE_CLASSES -- lake/river
    // already have their own independent control-drawer toggles
    // (waterLakes/waterRivers) and are not repeated here for the same reason
    // the colours are not.
    //
    // No `showLabels`: water carries no hover tooltip and no persistent
    // label layer for a switch to gate (see WaterSection.jsx's own note on
    // why "label visibility" was declined rather than shipped as a dial that
    // moves nothing) -- an earlier revision of this task shipped one anyway,
    // caught in review as dead schema, and removed.
    water: {
      hoverFillOpacity: 0.22,
      selectedFillOpacity: 0.32,
      outlineWeight: 1,
      hiddenClasses: [],
    },
    // Task 31's Filters section: saved combinations of the vessel/aircraft
    // filter bars (Task 18) and the conflict event filter, captured and
    // restored as one snapshot each -- see FiltersSection.jsx. Empty by
    // default; the live filters themselves stay App.jsx's own React state,
    // exactly as they always have (see DEFAULT_VESSEL_FILTER/
    // DEFAULT_AIRCRAFT_FILTER/DEFAULT_EVENT_FILTER, the shape a saved
    // preset's three sub-objects are validated against below), because a
    // filter typed in is a session's own working state, not a standing
    // configuration every reader of this deployment should open into.
    filters: {
      presets: [],
    },
    // Task 31's Inference section: the three-state switch (hide/labelled/
    // show) per inferred product -- see settings/inferenceProducts.js for
    // the full product table and what each state does.
    inference: {
      mode: mergeInferenceMode(null),
    },
    // Task 31's Cards section: which PlaceInfoCard-based sections show, in
    // what order, and whether each starts open -- see settings/
    // cardSections.js for the per-card-type section tables this indexes and
    // components/placeInfoCardGrouping.js's applyCardSettings for how a
    // stored choice reaches the card. Every sub-object is keyed by
    // CARD_TYPES' own keys and sparse by default -- an empty `hidden` array,
    // an empty `order` array (meaning "the shipped order") and an empty
    // `defaultOpen` map (meaning "whatever that card's own wrapper already
    // says") are all the same "nothing chosen yet" state layerWish uses
    // elsewhere in this file.
    cards: {
      hidden: Object.fromEntries(CARD_TYPES.map((c) => [c.key, []])),
      order: Object.fromEntries(CARD_TYPES.map((c) => [c.key, []])),
      defaultOpen: Object.fromEntries(CARD_TYPES.map((c) => [c.key, {}])),
    },
    // Task 31's Performance section. Every value here shipped as a bare
    // constant inside map/createMapController.js until this task -- see that
    // file's own note by SHIP_TRAIL_MAX_POINTS and setPerformanceOptions for
    // which five of these six move a `let` binding live, and which one
    // (satRedrawMs is deliberately absent) is baked into a setInterval and
    // cannot be. `pollIntervalMultiplier`/`pausePollingWhenHidden` reach
    // useOsintData.js instead -- see App.jsx's own useOsintData call.
    // `webglSpriteCap: null` is the one dial with no prior constant to carry
    // forward (there was no cap at all before this task); null means exactly
    // that -- no cap -- so a deployment that never opens this section draws
    // precisely as it always has.
    performance: {
      shipTrailPoints: 300,
      aircraftTrailPoints: 400,
      satelliteTrailPoints: 36,
      tankerTrailPoints: 60,
      satSmallCadenceMs: 10_000,
      satLargeCadenceMs: 60_000,
      webglSpriteCap: null,
      pollIntervalMultiplier: 1,
      pausePollingWhenHidden: true,
    },
    // { [sourceKey]: { edits: { [id]: {field: value, __hidden?: true} }, added: [record] } }
    data: Object.fromEntries(EDITABLE_SOURCES.map((s) => [s.key, { edits: {}, added: [] }])),
    // Redrawn national boundaries, sparse -- only the rings someone dragged.
    // { [countryKey]: { fp, rings: { "<polygon>:<ring>": [[lon, lat], ...] } } }
    // See settings/borderOverrides.js for the schema and why it is that shape.
    borders: {},
    // Task 42: "tell me when X happens here" -- see settings/alertRules.js
    // for the full shape and backend/alert_rules.py for how it is evaluated.
    // Empty by default, the same "nothing chosen yet" state every other
    // reader-authored list in this file (filters.presets, data.*.added)
    // ships with.
    alertRules: [],
    // Task 44: the timeline scrubber's play button. `frameMs` is the floor
    // on how long one frame is held on screen (hooks/useReplay.js awaits
    // each frame's fetch and then waits out whatever's left of this before
    // stepping again, so a fast response doesn't flash by); `stepMinutes` is
    // how far each step advances the replayed moment. Both ship at exactly
    // what useReplay.js ran at as bare constants before this task turned
    // them into dials -- see replay/playback.js for the shared defaults and
    // the bounds mergeSettings clamps a stored value to below.
    replay: {
      frameMs: DEFAULT_FRAME_MS,
      stepMinutes: DEFAULT_STEP_MINUTES,
    },
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

// --- Task 31's Filters section: saved presets --------------------------
//
// A preset is a snapshot of the three filter shapes App.jsx already owns as
// React state (vesselFilter/aircraftFilter/eventFilter -- see entityFilter.js
// and map/severity.js for where each one's own shape and shipped default
// come from). Sanitized field by field against those same defaults rather
// than accepted as written, for the same reason every other stored value in
// this file is: a hand-edited or imported file can carry anything.

function sanitizeVesselFilterPatch(value) {
  if (!isPlainObject(value)) return { ...DEFAULT_VESSEL_FILTER };
  return {
    text: typeof value.text === "string" ? value.text.slice(0, 200) : "",
    sanctionedOnly: value.sanctionedOnly === true,
    watchlistedOnly: value.watchlistedOnly === true,
  };
}

function sanitizeAircraftFilterPatch(value) {
  if (!isPlainObject(value)) return { ...DEFAULT_AIRCRAFT_FILTER };
  return {
    text: typeof value.text === "string" ? value.text.slice(0, 200) : "",
    militaryOnly: value.militaryOnly === true,
  };
}

function sanitizeEventFilterPatch(value) {
  if (!isPlainObject(value)) return { ...DEFAULT_EVENT_FILTER };
  return {
    maxAgeDays: Number.isFinite(value.maxAgeDays) ? Math.min(Math.max(value.maxAgeDays, 0), 3650) : null,
    minSeverity: pickNumber(value.minSeverity, 0, 0, 100),
    // Falls back to the shipped default rather than to `false`, which is what
    // `=== true` did. That was invisible while the shipped default *was* false
    // and became a contradiction the moment it changed: a stored preset with no
    // opinion on this field would have come back with the opposite of what the
    // app ships, and the only symptom would have been a third of the conflict
    // layer missing whenever that preset was applied. Only a real boolean
    // overrides the default now.
    showImprecise: typeof value.showImprecise === "boolean"
      ? value.showImprecise
      : DEFAULT_EVENT_FILTER.showImprecise,
    minConfidence: pickNumber(value.minConfidence, DEFAULT_EVENT_FILTER.minConfidence, 0, 1),
  };
}

/**
 * A stored `filters.presets` array, with every malformed entry dropped
 * rather than repaired -- unlike layerStack or a card order, a preset with
 * no name or no id is not a recognisable thing to repair into, it is just
 * not a preset.
 */
function sanitizeFilterPresets(stored) {
  if (!Array.isArray(stored)) return [];
  const out = [];
  const seenIds = new Set();
  for (const entry of stored) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.id !== "string" || !entry.id || seenIds.has(entry.id)) continue;
    if (typeof entry.name !== "string" || !entry.name.trim()) continue;
    seenIds.add(entry.id);
    out.push({
      id: entry.id,
      name: entry.name.trim().slice(0, 80),
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
      vesselFilter: sanitizeVesselFilterPatch(entry.vesselFilter),
      aircraftFilter: sanitizeAircraftFilterPatch(entry.aircraftFilter),
      eventFilter: sanitizeEventFilterPatch(entry.eventFilter),
    });
  }
  return out;
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
        // A strict boolean, and only for a layer that has the gate on offer.
        // The same rule layerWish uses below, for the same reason: a truthy
        // string in a hand-edited file would blank a layer until somebody found
        // the checkbox, and that is too large a consequence for a guess.
        countryOnly: value.countryOnly === true && COUNTRY_ONLY_LAYERS.has(key),
      };
    }
  }

  if (isPlainObject(stored.publicPanels)) {
    // Default-on, so anything but an explicit `false` leaves the panel showing
    // -- the rule ui.showLeaderLines uses, and for the same reason: a
    // configuration written before this setting existed must not switch a
    // reader's panel off by not mentioning it.
    for (const key of Object.keys(base.publicPanels)) {
      base.publicPanels[key] = stored.publicPanels[key] !== false;
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
    // Task 30 (see SETTINGS_VERSION's own note above). A config saved before
    // this key existed has no `stored.ui.tiles` at all, isPlainObject fails
    // the guard, and base.ui.tiles is left exactly as defaultSettings() set
    // it -- every dial shipped and inert. mergeTileDial applies the same
    // per-field range-checking every other stored value in this function
    // gets, so a hand-edited file with e.g. `"blur": 99` clamps to 3 rather
    // than reaching the pane at all.
    if (isPlainObject(stored.ui.tiles)) {
      base.ui.tiles.applyAtRest = stored.ui.tiles.applyAtRest === true;
      base.ui.tiles.basemap = mergeTileDial(stored.ui.tiles.basemap);
      base.ui.tiles.imagery = mergeTileDial(stored.ui.tiles.imagery);
      base.ui.tiles.weather = mergeTileDial(stored.ui.tiles.weather);
    }
  }

  // Task 32 item 4: the units/timezone preference. `system` is checked
  // against UNIT_SIZES' own three values; `timezone` against Intl directly
  // (constructing a DateTimeFormat with an unrecognised zone name throws),
  // which is also what formatClockAt itself falls back on for a zone that
  // slips through -- this is the earlier, preferred point to catch it, but
  // that fallback stays as the second line of defence for a value that
  // reaches formatClockAt some other way.
  if (isPlainObject(stored.units)) {
    base.units.system = ["metric", "imperial", "nautical"].includes(stored.units.system)
      ? stored.units.system
      : "metric";
    if (stored.units.timezone === "utc" || stored.units.timezone === "browser") {
      base.units.timezone = stored.units.timezone;
    } else if (typeof stored.units.timezone === "string" && stored.units.timezone) {
      try {
        // eslint-disable-next-line no-new -- constructed only to validate; Intl throws on an unknown zone
        new Intl.DateTimeFormat("en-US", { timeZone: stored.units.timezone });
        base.units.timezone = stored.units.timezone;
      } catch {
        base.units.timezone = "utc";
      }
    }
  }

  // Task 31's Water section. A config saved before this key existed has no
  // `stored.water` at all, so every field below is left exactly as
  // defaultSettings() shipped it -- the same additive contract ui.tiles
  // above follows.
  if (isPlainObject(stored.water)) {
    base.water.hoverFillOpacity = pickNumber(stored.water.hoverFillOpacity, 0.22, 0, 1);
    base.water.selectedFillOpacity = pickNumber(stored.water.selectedFillOpacity, 0.32, 0, 1);
    base.water.outlineWeight = pickNumber(stored.water.outlineWeight, 1, 0.2, 6);
    if (Array.isArray(stored.water.hiddenClasses)) {
      const known = new Set(MARINE_CLASSES);
      base.water.hiddenClasses = [
        ...new Set(stored.water.hiddenClasses.filter((c) => typeof c === "string" && known.has(c))),
      ];
    }
  }

  // Task 31's Filters section: saved vessel/aircraft/event filter presets.
  if (isPlainObject(stored.filters)) {
    base.filters.presets = sanitizeFilterPresets(stored.filters.presets);
  }

  // Task 31's Inference section. mergeInferenceMode already returns the
  // full shipped default for anything missing or unrecognised, so there is
  // nothing else to guard here -- see that function's own docstring.
  base.inference.mode = mergeInferenceMode(isPlainObject(stored.inference) ? stored.inference.mode : null);

  // Task 31's Cards section.
  if (isPlainObject(stored.cards)) {
    for (const { key } of CARD_TYPES) {
      const known = new Set((CARD_SECTIONS[key] || []).map((s) => s.id));
      const hidden = stored.cards.hidden?.[key];
      if (Array.isArray(hidden)) {
        base.cards.hidden[key] = [...new Set(hidden.filter((id) => typeof id === "string" && known.has(id)))];
      }
      // Not filtered against `known` here the way hidden/defaultOpen are --
      // orderedCardSections (settings/cardSections.js) already drops an
      // unknown id and appends whatever it left out, the identical repair
      // layerStack's own merge block above performs at read time rather
      // than at store time. Non-string entries are dropped either way, since
      // nothing downstream could match one to a section id.
      const order = stored.cards.order?.[key];
      if (Array.isArray(order)) {
        base.cards.order[key] = order.filter((id) => typeof id === "string");
      }
      const defaultOpen = stored.cards.defaultOpen?.[key];
      if (isPlainObject(defaultOpen)) {
        const cleaned = {};
        for (const [id, value] of Object.entries(defaultOpen)) {
          if (known.has(id) && typeof value === "boolean") cleaned[id] = value;
        }
        base.cards.defaultOpen[key] = cleaned;
      }
    }
  }

  // Task 31's Performance section. Ranges are generous rather than tight --
  // these are performance dials for a reader tuning their own machine, not
  // safety rails against a value that could break rendering, so the guard
  // here is "a real, sane number", not "the exact range the UI slider
  // offers".
  if (isPlainObject(stored.performance)) {
    const p = stored.performance;
    base.performance.shipTrailPoints = Math.round(pickNumber(p.shipTrailPoints, 300, 20, 2000));
    base.performance.aircraftTrailPoints = Math.round(pickNumber(p.aircraftTrailPoints, 400, 20, 2000));
    base.performance.satelliteTrailPoints = Math.round(pickNumber(p.satelliteTrailPoints, 36, 5, 500));
    base.performance.tankerTrailPoints = Math.round(pickNumber(p.tankerTrailPoints, 60, 10, 1000));
    base.performance.satSmallCadenceMs = Math.round(pickNumber(p.satSmallCadenceMs, 10_000, 1000, 300_000));
    base.performance.satLargeCadenceMs = Math.round(pickNumber(p.satLargeCadenceMs, 60_000, 1000, 600_000));
    // null (no cap, the shipped default) is a real, meaningful value here,
    // not a malformed one -- so unlike every pickNumber field above, this
    // has to distinguish "absent/invalid" from "explicitly no cap".
    base.performance.webglSpriteCap = Number.isFinite(p.webglSpriteCap)
      ? Math.round(pickNumber(p.webglSpriteCap, null, 50, 20_000))
      : null;
    base.performance.pollIntervalMultiplier = pickNumber(p.pollIntervalMultiplier, 1, 0.25, 10);
    // Default-on, so anything but an explicit `false` leaves it on -- the
    // same rule ui.showLeaderLines uses above, and for the same reason: this
    // is the behaviour every deployment already has, so a missing key in an
    // older configuration (there is no older configuration with this key at
    // all yet, but the same rule holds for a hand-edited file that simply
    // omits it) must not switch it off.
    base.performance.pausePollingWhenHidden = p.pausePollingWhenHidden !== false;
  }

  // Task 44's replay cadence/step. Additive (see SETTINGS_VERSION's own
  // note above) -- a config saved before this task has no `stored.replay`
  // at all, and the isPlainObject guard leaves defaultSettings()' shipped
  // { frameMs: 800, stepMinutes: 60 } in place for it.
  if (isPlainObject(stored.replay)) {
    base.replay.frameMs = Math.round(pickNumber(stored.replay.frameMs, DEFAULT_FRAME_MS, ...FRAME_MS_BOUNDS));
    base.replay.stepMinutes = Math.round(
      pickNumber(stored.replay.stepMinutes, DEFAULT_STEP_MINUTES, ...STEP_MINUTES_BOUNDS)
    );
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

  // Task 42's alert rules. No live REGIONS set is available at merge time
  // (this runs synchronously from localStorage before /api/regions has ever
  // been fetched -- see useAppSettings.js's own load order), so a stored
  // region-keyed geofence is accepted here on shape alone; a key this build
  // no longer recognises is caught downstream instead, the same "repair at
  // read time" deferral base.cards.order takes above for a section id --
  // and backend/alert_rules.py's own parse_rules refuses it outright before
  // it could ever fire, so an unrecognised key never does anything worse
  // than sit inert in the rule list.
  if (Array.isArray(stored.alertRules)) base.alertRules = sanitizeAlertRules(stored.alertRules);

  return base;
}
